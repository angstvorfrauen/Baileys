//===================================//
import { DEFAULT_ORIGIN, MEDIA_HKDF_KEY_MAPPING, MEDIA_PATH_MAP } from '../Defaults/index.js';
import { getBinaryNodeChild, getBinaryNodeChildBuffer, jidNormalizedUser } from '../WABinary/index.js';
import { createReadStream, createWriteStream, promises as fs, WriteStream } from 'fs';
import { aesDecryptGCM, aesEncryptGCM, hkdf } from './crypto.js';
import { generateMessageIDV2 } from './generics.js';
import { join } from 'path';
import { Readable, Transform } from 'stream';
import { URL } from 'url';
import { proto } from '../../WAProto/index.js';
import { Boom } from '@hapi/boom';
import { exec } from 'child_process';
import * as Crypto from 'crypto';
import { once } from 'events';
import axios, {} from 'axios';
import { tmpdir } from 'os';
//===================================//
const getTmpFilesDirectory = () => tmpdir();
const getImageProcessingLibrary = async () => {
  const [jimp, sharp] = await Promise.all([import('jimp').catch(() => { }), import('sharp').catch(() => { })]);
  if (sharp) {
    return { sharp };
  }
  if (jimp) {
    return { jimp };
  }
  throw new Boom('No image processing library available');
};
//===================================//
export const hkdfInfoKey = (type) => {
  const hkdfInfo = MEDIA_HKDF_KEY_MAPPING[type];
  return `WhatsApp ${hkdfInfo} Keys`;
};
//===================================//
export const getRawMediaUploadData = async (media, mediaType, logger) => {
  const { stream } = await getStream(media);
  logger?.debug('got stream for raw upload');
  const hasher = Crypto.createHash('sha256');
  const filePath = join(tmpdir(), mediaType + generateMessageIDV2());
  const fileWriteStream = createWriteStream(filePath);
  let fileLength = 0;
  try {
    for await (const data of stream) {
      fileLength += data.length;
      hasher.update(data);
      if (!fileWriteStream.write(data)) {
        await once(fileWriteStream, 'drain');
      }
    }
    fileWriteStream.end();
    await once(fileWriteStream, 'finish');
    stream.destroy();
    const fileSha256 = hasher.digest();
    logger?.debug('hashed data for raw upload');
    return {
      filePath: filePath,
      fileSha256,
      fileLength
    };
  }
  catch (error) {
    fileWriteStream.destroy();
    stream.destroy();
    try {
      await fs.unlink(filePath);
    }
    catch {
    }
    throw error;
  }
};
//===================================//
export async function getMediaKeys(buffer, mediaType) {
  if (!buffer) {
    throw new Boom('Cannot derive from empty media key');
  }
  if (typeof buffer === 'string') {
    buffer = Buffer.from(buffer.replace('data:;base64,', ''), 'base64');
  }
  const expandedMediaKey = await hkdf(buffer, 112, { info: hkdfInfoKey(mediaType) });
  return {
    iv: expandedMediaKey.slice(0, 16),
    cipherKey: expandedMediaKey.slice(16, 48),
    macKey: expandedMediaKey.slice(48, 80)
  };
}
//===================================//
const extractVideoThumb = async (path, destPath, time, size) => new Promise((resolve, reject) => {
  const cmd = `ffmpeg -ss ${time} -i ${path} -y -vf scale=${size.width}:-1 -vframes 1 -f image2 ${destPath}`;
  exec(cmd, err => {
    if (err) {
      reject(err);
    }
    else {
      resolve();
    }
  });
});
//===================================//
export const extractImageThumb = async (bufferOrFilePath, width = 32) => {
  if (bufferOrFilePath instanceof Readable) {
    bufferOrFilePath = await toBuffer(bufferOrFilePath);
  }
  const lib = await getImageProcessingLibrary();
  if ('sharp' in lib && typeof lib.sharp?.default === 'function') {
    const img = lib.sharp.default(bufferOrFilePath);
    const dimensions = await img.metadata();
    const buffer = await img.resize(width).jpeg({ quality: 50 }).toBuffer();
    return {
      buffer,
      original: {
        width: dimensions.width,
        height: dimensions.height
      }
    };
  }
  else if ('jimp' in lib && typeof lib.jimp?.Jimp === 'object') {
    const jimp = await lib.jimp.Jimp.read(bufferOrFilePath);
    const dimensions = {
      width: jimp.width,
      height: jimp.height
    };
    const buffer = await jimp
      .resize({ w: width, mode: lib.jimp.ResizeStrategy.BILINEAR })
      .getBuffer('image/jpeg', { quality: 50 });
    return {
      buffer,
      original: dimensions
    };
  }
  else {
    throw new Boom('No image processing library available');
  }
};
//===================================//
export const encodeBase64EncodedStringForUpload = (b64) => encodeURIComponent(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/\=+$/, ''));
//===================================//
export const generateProfilePicture = async (mediaUpload, dimensions) => {
  let buffer;
  const { width: w = 640, height: h = 640 } = dimensions || {};
  if (Buffer.isBuffer(mediaUpload)) {
    buffer = mediaUpload;
  }
  else {
    const { stream } = await getStream(mediaUpload);
    buffer = await toBuffer(stream);
  }
  const lib = await getImageProcessingLibrary();
  let img;
  if ('sharp' in lib && typeof lib.sharp?.default === 'function') {
    img = lib.sharp
      .default(buffer)
      .resize(w, h)
      .jpeg({
      quality: 50
    })
      .toBuffer();
  }
  else if ('jimp' in lib && typeof lib.jimp?.Jimp === 'object') {
    const jimp = await lib.jimp.Jimp.read(buffer);
    const min = Math.min(jimp.width, jimp.height);
    const cropped = jimp.crop({ x: 0, y: 0, w: min, h: min });
    img = cropped.resize({ w, h, mode: lib.jimp.ResizeStrategy.BILINEAR }).getBuffer('image/jpeg', { quality: 50 });
  }
  else {
    throw new Boom('No image processing library available');
  }
  return {
    img: await img
  };
};
//===================================//
export const mediaMessageSHA256B64 = (message) => {
  const media = Object.values(message)[0];
  return media?.fileSha256 && Buffer.from(media.fileSha256).toString('base64');
};
//===================================//
export async function getAudioDuration(buffer) {
  const musicMetadata = await import('music-metadata');
  let metadata;
  const options = {
    duration: true
  };
  if (Buffer.isBuffer(buffer)) {
    metadata = await musicMetadata.parseBuffer(buffer, undefined, options);
  }
  else if (typeof buffer === 'string') {
    metadata = await musicMetadata.parseFile(buffer, options);
  }
  else {
    metadata = await musicMetadata.parseStream(buffer, undefined, options);
  }
  return metadata.format.duration;
}
//===================================//
export async function getAudioWaveform(buffer, logger) {
  try {
    const { default: decoder } = await import('audio-decode');
    let audioData;
    if (Buffer.isBuffer(buffer)) {
      audioData = buffer;
    }
    else if (typeof buffer === 'string') {
      const rStream = createReadStream(buffer);
      audioData = await toBuffer(rStream);
    }
    else {
      audioData = await toBuffer(buffer);
    }
    const audioBuffer = await decoder(audioData);
    const rawData = audioBuffer.getChannelData(0);
    const samples = 64;
    const blockSize = Math.floor(rawData.length / samples);
    const filteredData = [];
    for (let i = 0; i < samples; i++) {
      const blockStart = blockSize * i;
      let sum = 0;
      for (let j = 0; j < blockSize; j++) {
        sum = sum + Math.abs(rawData[blockStart + j]);
      }
      filteredData.push(sum / blockSize);
    }
    const multiplier = Math.pow(Math.max(...filteredData), -1);
    const normalizedData = filteredData.map(n => n * multiplier);
    const waveform = new Uint8Array(normalizedData.map(n => Math.floor(100 * n)));
    return waveform;
  }
  catch (e) {
    logger?.debug('Failed to generate waveform: ' + e);
  }
}
//===================================//
export const toReadable = (buffer) => {
  const readable = new Readable({ read: () => { } });
  readable.push(buffer);
  readable.push(null);
  return readable;
};
//===================================//
export const toBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  stream.destroy();
  return Buffer.concat(chunks);
};
//===================================//
export const getStream = async (item, opts) => {
  if (Buffer.isBuffer(item)) {
    return { stream: toReadable(item), type: 'buffer' };
  }
  if ('stream' in item) {
    return { stream: item.stream, type: 'readable' };
  }
  const urlStr = item.url.toString();
  if (urlStr.startsWith('data:')) {
    const buffer = Buffer.from(urlStr.split(',')[1], 'base64');
    return { stream: toReadable(buffer), type: 'buffer' };
  }
  if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) {
    return { stream: await getHttpStream(item.url, opts), type: 'remote' };
  }
  return { stream: createReadStream(item.url), type: 'file' };
};
//===================================//
export async function generateThumbnail(file, mediaType, options) {
  let thumbnail;
  let originalImageDimensions;
  if (mediaType === 'image') {
    const { buffer, original } = await extractImageThumb(file);
    thumbnail = buffer.toString('base64');
    if (original.width && original.height) {
      originalImageDimensions = {
        width: original.width,
        height: original.height
      };
    }
  }
  else if (mediaType === 'video') {
    const imgFilename = join(getTmpFilesDirectory(), generateMessageIDV2() + '.jpg');
    try {
      await extractVideoThumb(file, imgFilename, '00:00:00', { width: 32, height: 32 });
      const buff = await fs.readFile(imgFilename);
      thumbnail = buff.toString('base64');
      await fs.unlink(imgFilename);
    }
    catch (err) {
      options.logger?.debug('could not generate video thumb: ' + err);
    }
  }
  return {
    thumbnail,
    originalImageDimensions
  };
}
//===================================//
export const getHttpStream = async (url, options = {}) => {
  const fetched = await axios.get(url.toString(), { ...options, responseType: 'stream' });
  return fetched.data;
};
//===================================//
export const encryptedStream = async (media, mediaType, { logger, saveOriginalFileIfRequired, opts } = {}) => {
  const { stream, type } = await getStream(media, opts);
  logger?.debug('fetched media stream');
  const mediaKey = Crypto.randomBytes(32);
  const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, mediaType);
  const encFilePath = join(getTmpFilesDirectory(), mediaType + generateMessageIDV2() + '-enc');
  const encFileWriteStream = createWriteStream(encFilePath);
  let originalFileStream;
  let originalFilePath;
  if (saveOriginalFileIfRequired) {
    originalFilePath = join(getTmpFilesDirectory(), mediaType + generateMessageIDV2() + '-original');
    originalFileStream = createWriteStream(originalFilePath);
  }
  let fileLength = 0;
  const aes = Crypto.createCipheriv('aes-256-cbc', cipherKey, iv);
  const hmac = Crypto.createHmac('sha256', macKey).update(iv);
  const sha256Plain = Crypto.createHash('sha256');
  const sha256Enc = Crypto.createHash('sha256');
  const onChunk = (buff) => {
    sha256Enc.update(buff);
    hmac.update(buff);
    encFileWriteStream.write(buff);
  };
  try {
    for await (const data of stream) {
      fileLength += data.length;
      if (type === 'remote' && opts?.maxContentLength && fileLength + data.length > opts.maxContentLength) {
        throw new Boom(`content length exceeded when encrypting "${type}"`, {
          data: { media, type }
        });
      }
      if (originalFileStream) {
        if (!originalFileStream.write(data)) {
          await once(originalFileStream, 'drain');
        }
      }
      sha256Plain.update(data);
      onChunk(aes.update(data));
    }
    onChunk(aes.final());
    const mac = hmac.digest().slice(0, 10);
    sha256Enc.update(mac);
    const fileSha256 = sha256Plain.digest();
    const fileEncSha256 = sha256Enc.digest();
    encFileWriteStream.write(mac);
    encFileWriteStream.end();
    originalFileStream?.end?.();
    stream.destroy();
    logger?.debug('encrypted data successfully');
    return {
      mediaKey,
      originalFilePath,
      encFilePath,
      mac,
      fileEncSha256,
      fileSha256,
      fileLength
    };
  }
  catch (error) {
    encFileWriteStream.destroy();
    originalFileStream?.destroy?.();
    aes.destroy();
    hmac.destroy();
    sha256Plain.destroy();
    sha256Enc.destroy();
    stream.destroy();
    try {
      await fs.unlink(encFilePath);
      if (originalFilePath) {
        await fs.unlink(originalFilePath);
      }
    }
    catch (err) {
      logger?.error({ err }, 'failed deleting tmp files');
    }
    throw error;
  }
};
//===================================//
const DEF_HOST = 'mmg.whatsapp.net';
const AES_CHUNK_SIZE = 16;
//===================================//
const toSmallestChunkSize = (num) => {
  return Math.floor(num / AES_CHUNK_SIZE) * AES_CHUNK_SIZE;
};
//===================================//
export const getUrlFromDirectPath = (directPath) => `https://${DEF_HOST}${directPath}`;
export const downloadContentFromMessage = async ({ mediaKey, directPath, url }, type, opts = {}) => {
  const isValidMediaUrl = url?.startsWith('https://mmg.whatsapp.net/');
  const downloadUrl = isValidMediaUrl ? url : getUrlFromDirectPath(directPath);
  if (!downloadUrl) {
    throw new Boom('No valid media URL or directPath present in message', { statusCode: 400 });
  }
  const keys = await getMediaKeys(mediaKey, type);
  return downloadEncryptedContent(downloadUrl, keys, opts);
};
//===================================//
export const downloadEncryptedContent = async (downloadUrl, { cipherKey, iv }, { startByte, endByte, options } = {}) => {
  let bytesFetched = 0;
  let startChunk = 0;
  let firstBlockIsIV = false;
  if (startByte) {
    const chunk = toSmallestChunkSize(startByte || 0);
    if (chunk) {
      startChunk = chunk - AES_CHUNK_SIZE;
      bytesFetched = chunk;
      firstBlockIsIV = true;
    }
  }
  const endChunk = endByte ? toSmallestChunkSize(endByte || 0) + AES_CHUNK_SIZE : undefined;
  const headers = {
    ...(options?.headers || {}),
    Origin: DEFAULT_ORIGIN
  };
  if (startChunk || endChunk) {
    headers.Range = `bytes=${startChunk}-`;
    if (endChunk) {
      headers.Range += endChunk;
    }
  }
  const fetched = await getHttpStream(downloadUrl, {
    ...(options || {}),
    headers,
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });
  let remainingBytes = Buffer.from([]);
  let aes;
  const pushBytes = (bytes, push) => {
    if (startByte || endByte) {
      const start = bytesFetched >= startByte ? undefined : Math.max(startByte - bytesFetched, 0);
      const end = bytesFetched + bytes.length < endByte ? undefined : Math.max(endByte - bytesFetched, 0);
      push(bytes.slice(start, end));
      bytesFetched += bytes.length;
    }
    else {
      push(bytes);
    }
  };
  const output = new Transform({
    transform(chunk, _, callback) {
      let data = Buffer.concat([remainingBytes, chunk]);
      const decryptLength = toSmallestChunkSize(data.length);
      remainingBytes = data.slice(decryptLength);
      data = data.slice(0, decryptLength);
      if (!aes) {
        let ivValue = iv;
        if (firstBlockIsIV) {
          ivValue = data.slice(0, AES_CHUNK_SIZE);
          data = data.slice(AES_CHUNK_SIZE);
        }
        aes = Crypto.createDecipheriv('aes-256-cbc', cipherKey, ivValue);
        if (endByte) {
          aes.setAutoPadding(false);
        }
      }
      try {
        pushBytes(aes.update(data), b => this.push(b));
        callback();
      }
      catch (error) {
        callback(error);
      }
    },
    final(callback) {
      try {
        pushBytes(aes.final(), b => this.push(b));
        callback();
      }
      catch (error) {
        callback(error);
      }
    }
  });
  return fetched.pipe(output, { end: true });
};
//===================================//
export function extensionForMediaMessage(message) {
  const getExtension = (mimetype) => mimetype.split(';')[0]?.split('/')[1];
  const type = Object.keys(message)[0];
  let extension;
  if (type === 'locationMessage' || type === 'liveLocationMessage' || type === 'productMessage') {
    extension = '.jpeg';
  }
  else {
    const messageContent = message[type];
    extension = getExtension(messageContent.mimetype);
  }
  return extension;
}
//===================================//
export const getWAUploadToServer = ({ customUploadHosts, fetchAgent, logger, options }, refreshMediaConn) => {
  return async (filePath, { mediaType, fileEncSha256B64, timeoutMs }) => {
    let uploadInfo = await refreshMediaConn(false);
    let urls;
    const hosts = [...customUploadHosts, ...uploadInfo.hosts];
    fileEncSha256B64 = encodeBase64EncodedStringForUpload(fileEncSha256B64);
    for (const { hostname } of hosts) {
      logger.debug(`uploading to "${hostname}"`);
      const auth = encodeURIComponent(uploadInfo.auth);
      const url = `https://${hostname}${MEDIA_PATH_MAP[mediaType]}/${fileEncSha256B64}?auth=${auth}&token=${fileEncSha256B64}`;
      let result;
      try {
        const body = await axios.post(url, createReadStream(filePath), {
          ...options,
          maxRedirects: 0,
          headers: {
            ...(options.headers || {}),
            'Content-Type': 'application/octet-stream',
            Origin: DEFAULT_ORIGIN
          },
          httpsAgent: fetchAgent,
          timeout: timeoutMs,
          responseType: 'json',
          maxBodyLength: Infinity,
          maxContentLength: Infinity
        });
        result = body.data;
        if (result?.url || result?.directPath) {
          urls = {
            mediaUrl: result.url,
            directPath: result.direct_path
          };
          break;
        }
        else {
          uploadInfo = await refreshMediaConn(true);
          throw new Error(`upload failed, reason: ${JSON.stringify(result)}`);
        }
      }
      catch (error) {
        if (axios.isAxiosError(error)) {
          result = error.response?.data;
        }
        const isLast = hostname === hosts[uploadInfo.hosts.length - 1]?.hostname;
        logger.warn({ trace: error.stack, uploadResult: result }, `Error in uploading to ${hostname} ${isLast ? '' : ', retrying...'}`);
      }
    }
    if (!urls) {
      throw new Boom('Media upload failed on all hosts', { statusCode: 500 });
    }
    return urls;
  };
};
//===================================//
const getMediaRetryKey = (mediaKey) => {
  return hkdf(mediaKey, 32, { info: 'WhatsApp Media Retry Notification' });
};
//===================================//
export const encryptMediaRetryRequest = async (key, mediaKey, meId) => {
  const recp = { stanzaId: key.id };
  const recpBuffer = proto.ServerErrorReceipt.encode(recp).finish();
  const iv = Crypto.randomBytes(12);
  const retryKey = await getMediaRetryKey(mediaKey);
  const ciphertext = aesEncryptGCM(recpBuffer, retryKey, iv, Buffer.from(key.id));
  const req = {
    tag: 'receipt',
    attrs: {
      id: key.id,
      to: jidNormalizedUser(meId),
      type: 'server-error'
    },
    content: [
      {
        tag: 'encrypt',
        attrs: {},
        content: [
          { tag: 'enc_p', attrs: {}, content: ciphertext },
          { tag: 'enc_iv', attrs: {}, content: iv }
        ]
      },
      {
        tag: 'rmr',
        attrs: {
          jid: key.remoteJid,
          from_me: (!!key.fromMe).toString(),
          participant: key.participant || undefined
        }
      }
    ]
  };
  return req;
};
//===================================//
export const decodeMediaRetryNode = (node) => {
  const rmrNode = getBinaryNodeChild(node, 'rmr');
  const event = {
    key: {
      id: node.attrs.id,
      remoteJid: rmrNode.attrs.jid,
      fromMe: rmrNode.attrs.from_me === 'true',
      participant: rmrNode.attrs.participant
    }
  };
  const errorNode = getBinaryNodeChild(node, 'error');
  if (errorNode) {
    const errorCode = +errorNode.attrs.code;
    event.error = new Boom(`Failed to re-upload media (${errorCode})`, {
      data: errorNode.attrs,
      statusCode: getStatusCodeForMediaRetry(errorCode)
    });
  }
  else {
    const encryptedInfoNode = getBinaryNodeChild(node, 'encrypt');
    const ciphertext = getBinaryNodeChildBuffer(encryptedInfoNode, 'enc_p');
    const iv = getBinaryNodeChildBuffer(encryptedInfoNode, 'enc_iv');
    if (ciphertext && iv) {
      event.media = { ciphertext, iv };
    }
    else {
      event.error = new Boom('Failed to re-upload media (missing ciphertext)', { statusCode: 404 });
    }
  }
  return event;
};
//===================================//
export const decryptMediaRetryData = async ({ ciphertext, iv }, mediaKey, msgId) => {
  const retryKey = await getMediaRetryKey(mediaKey);
  const plaintext = aesDecryptGCM(ciphertext, retryKey, iv, Buffer.from(msgId));
  return proto.MediaRetryNotification.decode(plaintext);
};
//===================================//
export const getStatusCodeForMediaRetry = (code) => MEDIA_RETRY_STATUS_MAP[code];
//===================================//
const MEDIA_RETRY_STATUS_MAP = {
  [proto.MediaRetryNotification.ResultType.SUCCESS]: 200,
  [proto.MediaRetryNotification.ResultType.DECRYPTION_ERROR]: 412,
  [proto.MediaRetryNotification.ResultType.NOT_FOUND]: 404,
  [proto.MediaRetryNotification.ResultType.GENERAL_ERROR]: 418
};
//===================================//