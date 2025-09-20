//===================================//
import { areJidsSameUser, isJidBroadcast, isJidStatusBroadcast, jidNormalizedUser } from '../WABinary/index.js';
import { getContentType, normalizeMessageContent } from '../Utils/messages.js';
import { downloadAndProcessHistorySyncNotification } from './history.js';
import { WAMessageStubType } from '../Types/index.js';
import { aesDecryptGCM, hmacSign } from './crypto.js';
import { proto } from '../../WAProto/index.js';
import { toNumber } from './generics.js';
//===================================//
const REAL_MSG_STUB_TYPES = new Set([
  WAMessageStubType.CALL_MISSED_GROUP_VIDEO,
  WAMessageStubType.CALL_MISSED_GROUP_VOICE,
  WAMessageStubType.CALL_MISSED_VIDEO,
  WAMessageStubType.CALL_MISSED_VOICE
]);
//===================================//
const REAL_MSG_REQ_ME_STUB_TYPES = new Set([WAMessageStubType.GROUP_PARTICIPANT_ADD]);
//===================================//
export const cleanMessage = (message, meId) => {
  message.key.remoteJid = jidNormalizedUser(message.key.remoteJid);
  message.key.participant = message.key.participant ? jidNormalizedUser(message.key.participant) : undefined;
  const content = normalizeMessageContent(message.message);
  if (content?.reactionMessage) {
    normaliseKey(content.reactionMessage.key);
  }
  if (content?.pollUpdateMessage) {
    normaliseKey(content.pollUpdateMessage.pollCreationMessageKey);
  }
  function normaliseKey(msgKey) {
    if (!message.key.fromMe) {
      msgKey.fromMe = !msgKey.fromMe
        ? areJidsSameUser(msgKey.participant || msgKey.remoteJid, meId)
        :
          false;
      msgKey.remoteJid = message.key.remoteJid;
      msgKey.participant = msgKey.participant || message.key.participant;
    }
  }
};
//===================================//
export const isRealMessage = (message, meId) => {
  const normalizedContent = normalizeMessageContent(message.message);
  const hasSomeContent = !!getContentType(normalizedContent);
  return ((!!normalizedContent ||
    REAL_MSG_STUB_TYPES.has(message.messageStubType) ||
    (REAL_MSG_REQ_ME_STUB_TYPES.has(message.messageStubType) &&
      message.messageStubParameters?.some(p => areJidsSameUser(meId, p)))) &&
    hasSomeContent &&
    !normalizedContent?.protocolMessage &&
    !normalizedContent?.reactionMessage &&
    !normalizedContent?.pollUpdateMessage);
};
//===================================//
export const shouldIncrementChatUnread = (message) => !message.key.fromMe && !message.messageStubType;
//===================================//
export const getChatId = ({ remoteJid, participant, fromMe }) => {
  if (isJidBroadcast(remoteJid) && !isJidStatusBroadcast(remoteJid) && !fromMe) {
    return participant;
  }
  return remoteJid;
};
//===================================//
export function decryptPollVote({ encPayload, encIv }, { pollCreatorJid, pollMsgId, pollEncKey, voterJid }) {
  const sign = Buffer.concat([
    toBinary(pollMsgId),
    toBinary(pollCreatorJid),
    toBinary(voterJid),
    toBinary('Poll Vote'),
    new Uint8Array([1])
  ]);
  const key0 = hmacSign(pollEncKey, new Uint8Array(32), 'sha256');
  const decKey = hmacSign(sign, key0, 'sha256');
  const aad = toBinary(`${pollMsgId}\u0000${voterJid}`);
  const decrypted = aesDecryptGCM(encPayload, decKey, encIv, aad);
  return proto.Message.PollVoteMessage.decode(decrypted);
  function toBinary(txt) {
    return Buffer.from(txt);
  }
}
//===================================//
const processMessage = async (message, { shouldProcessHistoryMsg, placeholderResendCache, ev, creds, keyStore, logger, options }) => {
  const meId = creds.me.id;
  const { accountSettings } = creds;
  const chat = { id: jidNormalizedUser(getChatId(message.key)) };
  const isRealMsg = isRealMessage(message, meId);
  if (isRealMsg) {
    chat.messages = [{ message }];
    chat.conversationTimestamp = toNumber(message.messageTimestamp);
    if (shouldIncrementChatUnread(message)) {
      chat.unreadCount = (chat.unreadCount || 0) + 1;
    }
  }
  const content = normalizeMessageContent(message.message);
  if ((isRealMsg || content?.reactionMessage?.key?.fromMe) && accountSettings?.unarchiveChats) {
    chat.archived = false;
    chat.readOnly = false;
  }
  const protocolMsg = content?.protocolMessage;
  if (protocolMsg) {
    switch (protocolMsg.type) {
      case proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION:
        const histNotification = protocolMsg.historySyncNotification;
        const process = shouldProcessHistoryMsg;
        const isLatest = !creds.processedHistoryMessages?.length;
        logger?.info({
          histNotification,
          process,
          id: message.key.id,
          isLatest
        }, 'got history notification');
        if (process) {
          if (histNotification.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND) {
            ev.emit('creds.update', {
              processedHistoryMessages: [
                ...(creds.processedHistoryMessages || []),
                { key: message.key, messageTimestamp: message.messageTimestamp }
              ]
            });
          }
          const data = await downloadAndProcessHistorySyncNotification(histNotification, options);
          ev.emit('messaging-history.set', {
            ...data,
            isLatest: histNotification.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND ? isLatest : undefined,
            peerDataRequestSessionId: histNotification.peerDataRequestSessionId
          });
        }
        break;
      case proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE:
        const keys = protocolMsg.appStateSyncKeyShare.keys;
        if (keys?.length) {
          let newAppStateSyncKeyId = '';
          await keyStore.transaction(async () => {
            const newKeys = [];
            for (const { keyData, keyId } of keys) {
              const strKeyId = Buffer.from(keyId.keyId).toString('base64');
              newKeys.push(strKeyId);
              await keyStore.set({ 'app-state-sync-key': { [strKeyId]: keyData } });
              newAppStateSyncKeyId = strKeyId;
            }
            logger?.info({ newAppStateSyncKeyId, newKeys }, 'injecting new app state sync keys');
          });
          ev.emit('creds.update', { myAppStateKeyId: newAppStateSyncKeyId });
        }
        else {
          logger?.info({ protocolMsg }, 'recv app state sync with 0 keys');
        }
        break;
      case proto.Message.ProtocolMessage.Type.REVOKE:
        ev.emit('messages.update', [
          {
            key: {
              ...message.key,
              id: protocolMsg.key.id
            },
            update: { message: null, messageStubType: WAMessageStubType.REVOKE, key: message.key }
          }
        ]);
        break;
      case proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING:
        Object.assign(chat, {
          ephemeralSettingTimestamp: toNumber(message.messageTimestamp),
          ephemeralExpiration: protocolMsg.ephemeralExpiration || null
        });
        break;
      case proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE:
        const response = protocolMsg.peerDataOperationRequestResponseMessage;
        if (response) {
          placeholderResendCache?.del(response.stanzaId);
          const { peerDataOperationResult } = response;
          for (const result of peerDataOperationResult) {
            const { placeholderMessageResendResponse: retryResponse } = result;
            if (retryResponse) {
              const webMessageInfo = proto.WebMessageInfo.decode(retryResponse.webMessageInfoBytes);
              setTimeout(() => {
                ev.emit('messages.upsert', {
                  messages: [webMessageInfo],
                  type: 'notify',
                  requestId: response.stanzaId
                });
              }, 500);
            }
          }
        }
        break;
      case proto.Message.ProtocolMessage.Type.MESSAGE_EDIT:
        ev.emit('messages.update', [
          {
            key: { ...message.key, id: protocolMsg.key?.id },
            update: {
              message: {
                editedMessage: {
                  message: protocolMsg.editedMessage
                }
              },
              messageTimestamp: protocolMsg.timestampMs
                ? Math.floor(toNumber(protocolMsg.timestampMs) / 1000)
                : message.messageTimestamp
            }
          }
        ]);
        break;
    }
  }
  else if (content?.reactionMessage) {
    const reaction = {
      ...content.reactionMessage,
      key: message.key
    };
    ev.emit('messages.reaction', [
      {
        reaction,
        key: content.reactionMessage?.key
      }
    ]);
  }
  else if (message.messageStubType) {
    const jid = message.key?.remoteJid;
    let participants;
    const emitParticipantsUpdate = (action) => ev.emit('group-participants.update', { id: jid, author: message.participant, participants, action });
    const emitGroupUpdate = (update) => {
      ev.emit('groups.update', [{ id: jid, ...update, author: message.participant ?? undefined }]);
    };
    const emitGroupRequestJoin = (participant, action, method) => {
      ev.emit('group.join-request', { id: jid, author: message.participant, participant, action, method: method });
    };
    const participantsIncludesMe = () => participants.find(jid => areJidsSameUser(meId, jid));
    switch (message.messageStubType) {
      case WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER:
        participants = message.messageStubParameters || [];
        emitParticipantsUpdate('modify');
        break;
      case WAMessageStubType.GROUP_PARTICIPANT_LEAVE:
      case WAMessageStubType.GROUP_PARTICIPANT_REMOVE:
        participants = message.messageStubParameters || [];
        emitParticipantsUpdate('remove');
        if (participantsIncludesMe()) {
          chat.readOnly = true;
        }
        break;
      case WAMessageStubType.GROUP_PARTICIPANT_ADD:
      case WAMessageStubType.GROUP_PARTICIPANT_INVITE:
      case WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN:
        participants = message.messageStubParameters || [];
        if (participantsIncludesMe()) {
          chat.readOnly = false;
        }
        emitParticipantsUpdate('add');
        break;
      case WAMessageStubType.GROUP_PARTICIPANT_DEMOTE:
        participants = message.messageStubParameters || [];
        emitParticipantsUpdate('demote');
        break;
      case WAMessageStubType.GROUP_PARTICIPANT_PROMOTE:
        participants = message.messageStubParameters || [];
        emitParticipantsUpdate('promote');
        break;
      case WAMessageStubType.GROUP_CHANGE_ANNOUNCE:
        const announceValue = message.messageStubParameters?.[0];
        emitGroupUpdate({ announce: announceValue === 'true' || announceValue === 'on' });
        break;
      case WAMessageStubType.GROUP_CHANGE_RESTRICT:
        const restrictValue = message.messageStubParameters?.[0];
        emitGroupUpdate({ restrict: restrictValue === 'true' || restrictValue === 'on' });
        break;
      case WAMessageStubType.GROUP_CHANGE_SUBJECT:
        const name = message.messageStubParameters?.[0];
        chat.name = name;
        emitGroupUpdate({ subject: name });
        break;
      case WAMessageStubType.GROUP_CHANGE_DESCRIPTION:
        const description = message.messageStubParameters?.[0];
        chat.description = description;
        emitGroupUpdate({ desc: description });
        break;
      case WAMessageStubType.GROUP_CHANGE_INVITE_LINK:
        const code = message.messageStubParameters?.[0];
        emitGroupUpdate({ inviteCode: code });
        break;
      case WAMessageStubType.GROUP_MEMBER_ADD_MODE:
        const memberAddValue = message.messageStubParameters?.[0];
        emitGroupUpdate({ memberAddMode: memberAddValue === 'all_member_add' });
        break;
      case WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE:
        const approvalMode = message.messageStubParameters?.[0];
        emitGroupUpdate({ joinApprovalMode: approvalMode === 'on' });
        break;
      case WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD:
        const participant = message.messageStubParameters?.[0];
        const action = message.messageStubParameters?.[1];
        const method = message.messageStubParameters?.[2];
        emitGroupRequestJoin(participant, action, method);
        break;
    }
  }
  if (Object.keys(chat).length > 1) {
    ev.emit('chats.update', [chat]);
  }
};
//===================================//
export default processMessage;
//===================================//