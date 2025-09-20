//===================================//
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto';
import { KEY_BUNDLE_TYPE } from '../Defaults/index.js';
import * as libsignal from 'libsignal-xeuka';
//===================================//
const { subtle } = globalThis.crypto;
//===================================//
export const generateSignalPubKey = (pubKey) => pubKey.length === 33 ? pubKey : Buffer.concat([KEY_BUNDLE_TYPE, pubKey]);
//===================================//
export const Curve = {
  generateKeyPair: () => {
    const { pubKey, privKey } = libsignal.curve.generateKeyPair();
    return {
      private: Buffer.from(privKey),
      public: Buffer.from(pubKey.slice(1))
    };
  },
  sharedKey: (privateKey, publicKey) => {
    const shared = libsignal.curve.calculateAgreement(generateSignalPubKey(publicKey), privateKey);
    return Buffer.from(shared);
  },
  sign: (privateKey, buf) => libsignal.curve.calculateSignature(privateKey, buf),
  verify: (pubKey, message, signature) => {
    try {
      libsignal.curve.verifySignature(generateSignalPubKey(pubKey), message, signature);
      return true;
    }
    catch (error) {
      return false;
    }
  }
};
//===================================//
export const signedKeyPair = (identityKeyPair, keyId) => {
  const preKey = Curve.generateKeyPair();
  const pubKey = generateSignalPubKey(preKey.public);
  const signature = Curve.sign(identityKeyPair.private, pubKey);
  return { keyPair: preKey, signature, keyId };
};
//===================================//
const GCM_TAG_LENGTH = 128 >> 3;
//===================================//
export function aesEncryptGCM(plaintext, key, iv, additionalData) {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(additionalData);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
};
//===================================//
export function aesDecryptGCM(ciphertext, key, iv, additionalData) {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  const enc = ciphertext.slice(0, ciphertext.length - GCM_TAG_LENGTH);
  const tag = ciphertext.slice(ciphertext.length - GCM_TAG_LENGTH);
  decipher.setAAD(additionalData);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}
//===================================//
export function aesEncryptCTR(plaintext, key, iv) {
  const cipher = createCipheriv('aes-256-ctr', key, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
//===================================//
export function aesDecryptCTR(ciphertext, key, iv) {
  const decipher = createDecipheriv('aes-256-ctr', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
//===================================//
export function aesDecrypt(buffer, key) {
  return aesDecryptWithIV(buffer.slice(16, buffer.length), key, buffer.slice(0, 16));
}
//===================================//
export function aesDecryptWithIV(buffer, key, IV) {
  const aes = createDecipheriv('aes-256-cbc', key, IV);
  return Buffer.concat([aes.update(buffer), aes.final()]);
}
//===================================//
export function aesEncrypt(buffer, key) {
  const IV = randomBytes(16);
  const aes = createCipheriv('aes-256-cbc', key, IV);
  return Buffer.concat([IV, aes.update(buffer), aes.final()]);
}
//===================================//
export function aesEncrypWithIV(buffer, key, IV) {
  const aes = createCipheriv('aes-256-cbc', key, IV);
  return Buffer.concat([aes.update(buffer), aes.final()]);
}
//===================================//
export function hmacSign(buffer, key, variant = 'sha256') {
  return createHmac(variant, key).update(buffer).digest();
}
//===================================//
export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest();
}
//===================================//
export function md5(buffer) {
  return createHash('md5').update(buffer).digest();
}
//===================================//
export async function hkdf(buffer, expandedLength, info) {
  const inputKeyMaterial = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const salt = info.salt ? new Uint8Array(info.salt) : new Uint8Array(0);
  const infoBytes = info.info ? new TextEncoder().encode(info.info) : new Uint8Array(0);
  const importedKey = await subtle.importKey('raw', inputKeyMaterial, { name: 'HKDF' }, false, ['deriveBits']);
  const derivedBits = await subtle.deriveBits({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: salt,
    info: infoBytes
  }, importedKey, expandedLength * 8
  );
  return Buffer.from(derivedBits);
}
//===================================//
export async function derivePairingCodeKey(pairingCode, salt) {
  const encoder = new TextEncoder();
  const pairingCodeBuffer = encoder.encode(pairingCode);
  const saltBuffer = salt instanceof Uint8Array ? salt : new Uint8Array(salt);
  const keyMaterial = await subtle.importKey('raw', pairingCodeBuffer, { name: 'PBKDF2' }, false, ['deriveBits']);
  const derivedBits = await subtle.deriveBits({
    name: 'PBKDF2',
    salt: saltBuffer,
    iterations: 2 << 16,
    hash: 'SHA-256'
  }, keyMaterial, 32 * 8
  );
  return Buffer.from(derivedBits);
}
//===================================//