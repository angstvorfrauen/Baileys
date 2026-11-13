import { readFile, writeFile } from "node:fs/promises"
import { BufferJSON, md5, toNumber, updateMessageWithReceipt, updateMessageWithReaction } from "../Utils/index.js"
import { DEFAULT_CONNECTION_CONFIG } from "../Defaults/index.js"
import { makeOrderedDictionary } from "./make-ordered-dictionary.js"
import { LabelAssociationType } from "../Types/LabelAssociation.js"
import { jidDecode, jidNormalizedUser } from "../WABinary/index.js"
import { proto } from "../../WAProto/index.js";
import { ObjectRepository } from "./object-repository.js"
import KeyedDB from "../KeyDB/KeyedDB.js"
export const waChatKey = (pin) => ({
  key: (c) => (pin ? (c.pinned ? "1" : "0") : "") + (c.archived ? "0" : "1") + (c.conversationTimestamp ? c.conversationTimestamp.toString(16).padStart(8, "0") : "") + c.id,
  compare: (k1, k2) => k2.localeCompare(k1)
})
export const waMessageID = (m) => m.key.id || ""
export const waLabelAssociationKey = {
  key: (la) => (la.type === LabelAssociationType.Chat ? la.chatId + la.labelId : la.chatId + la.messageId + la.labelId),
  compare: (k1, k2) => k2.localeCompare(k1)
}
const makeMessagesDictionary = () => makeOrderedDictionary(waMessageID)
export const makeInMemoryStore = (config = {}) => {
  const socket = config.socket
  const maxMessagesPerChat = config.maxMessagesPerChat ?? Infinity
  const chatKey = config.chatKey || waChatKey(true)
  const labelAssociationKey = config.labelAssociationKey || waLabelAssociationKey
  const logger = config.logger || DEFAULT_CONNECTION_CONFIG.logger.child({ stream: "in-mem-store" })
  const chats = new KeyedDB(chatKey, c => c.id)
  const messages = Object.create(null)
  const contacts = Object.create(null)
  const groupMetadata = Object.create(null)
  const presences = Object.create(null)
  const state = { connection: "close" }
  const labels = new ObjectRepository()
  const labelAssociations = new KeyedDB(labelAssociationKey, labelAssociationKey.key)
  const assertMessageList = (jid) => {
    if (!messages[jid]) messages[jid] = makeMessagesDictionary()
    return messages[jid]
  }
  const upsertMessage = (msg, mode, jid = jidNormalizedUser(msg?.key?.remoteJid)) => {
    if (!jid || !msg?.key?.id || maxMessagesPerChat <= 0) return
    const list = assertMessageList(jid)
    if (mode === "prepend" && list.array.length >= maxMessagesPerChat && !list.get(msg.key.id)) return
    list.upsert(msg, mode)
    if (list.array.length > maxMessagesPerChat) list.remove(list.array[0])
  }
  const contactsUpsert = (newContacts) => {
    const oldContacts = new Set(Object.keys(contacts))
    for (const contact of newContacts) {
      if (!contact?.id) continue
      oldContacts.delete(contact.id)
      contacts[contact.id] = Object.assign(contacts[contact.id] || {}, contact)
    }
    return oldContacts
  }
  const labelsUpsert = (newLabels) => {
    for (const label of newLabels) labels.upsertById(label.id, label)
  }
  const bind = (ev) => {
    ev.on("connection.update", update => Object.assign(state, update))
    ev.on("messaging-history.set", ({ chats: newChats = [], contacts: newContacts = [], messages: newMessages = [], isLatest, syncType }) => {
      if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) return
      if (isLatest) {
        chats.clear()
        for (const id in messages) delete messages[id]
      }
      const chatsAdded = chats.insertIfAbsent(...newChats).length
      logger.debug({ chatsAdded }, "synced chats")
      const oldContacts = contactsUpsert(newContacts)
      if (isLatest) for (const jid of oldContacts) delete contacts[jid]
      logger.debug({ deletedContacts: isLatest ? oldContacts.size : 0, newContacts }, "synced contacts")
      for (const msg of newMessages) upsertMessage(msg, "prepend")
      logger.debug({ messages: newMessages.length }, "synced messages")
    })
    ev.on("contacts.upsert", contacts => contactsUpsert(contacts))
    ev.on("contacts.update", (updates) => {
      void updateContacts(updates).catch(err => logger.warn({ err }, "contact update failed"))
    })
    const updateContacts = async (updates) => {
      for (const update of updates) {
        let contact = contacts[update.id]
        if (!contact) {
          const contactHashes = await Promise.all(
            Object.keys(contacts).map(async (contactId) => {
              const user = jidDecode(contactId)?.user
              if (!user) return [contactId, null]
              const hash = await md5(Buffer.from(user + "WA_ADD_NOTIF", "utf8"))
              return [contactId, Buffer.from(hash).toString("base64").slice(0, 3)]
            })
          )
          const match = contactHashes.find(([, hash]) => hash && hash === update.id?.slice(0, 3))
          if (match) contact = contacts[match[0]]
        }
        if (!contact) continue
        const { id, imgUrl, ...details } = update
        Object.assign(contact, details)
        if (imgUrl === "changed") {
          delete contact.imgUrl
          if (socket) contact.imgUrl = await socket.profilePictureUrl(contact.id).catch(() => undefined)
        } else if (imgUrl === "removed") {
          delete contact.imgUrl
        } else if (imgUrl !== undefined) {
          contact.imgUrl = imgUrl
        }
      }
    }
    ev.on("chats.upsert", newChats => chats.upsert(...newChats))
    ev.on("chats.update", updates => {
      for (let update of updates) {
        const result = chats.update(update.id, chat => {
          if (update.unreadCount > 0) {
            update = { ...update }
            update.unreadCount = (chat.unreadCount || 0) + update.unreadCount
          }
          Object.assign(chat, update)
        })
        if (!result) logger.debug({ update }, "got update for non-existant chat")
      }
    })
    ev.on("labels.edit", (label) => {
      if (label.deleted) return labels.deleteById(label.id)
      if (labels.findById(label.id) || labels.count() < 20) return labels.upsertById(label.id, label)
      logger.error("Labels count exceed")
    })
    ev.on("labels.association", ({ type, association }) => {
      switch (type) {
        case "add": labelAssociations.upsert(association); break
        case "remove": labelAssociations.delete(association); break
        default: console.error(`unknown operation type [${type}]`)
      }
    })
    ev.on("presence.update", ({ id, presences: update }) => {
      presences[id] = presences[id] || {}
      Object.assign(presences[id], update)
    })
    ev.on("chats.delete", deletions => {
      for (const item of deletions) if (chats.get(item)) chats.deleteById(item)
    })
    ev.on("messages.upsert", ({ messages: newMessages, type }) => {
      switch (type) {
        case "append":
        case "notify":
          for (const msg of newMessages) {
            const jid = jidNormalizedUser(msg?.key?.remoteJid)
            if (!jid || !msg?.key?.id) continue
            upsertMessage(msg, "append", jid)
            if (type === "notify" && !chats.get(jid)) {
              ev.emit("chats.upsert", [{
                id: jid,
                conversationTimestamp: toNumber(msg.messageTimestamp),
                unreadCount: 1
              }])
            }
          }
          break
      }
    })
    ev.on("messages.update", updates => {
      for (const { update, key } of updates) {
        const list = messages[jidNormalizedUser(key.remoteJid)]
        if (!list || !update) continue
        const changes = { ...update }
        if (changes.status) {
          const listStatus = list.get(key.id)?.status
          if (listStatus && update.status <= listStatus) {
            logger.debug({ update, storedStatus: listStatus }, "status stored newer then update")
            delete changes.status
            logger.debug({ update }, "new update object")
          }
        }
        const result = list.updateAssign(key.id, changes)
        if (!result) logger.debug({ update }, "got update for non-existent message")
      }
    })
    ev.on("messages.delete", item => {
      if ("all" in item) {
        delete messages[jidNormalizedUser(item.jid)]
        return
      }
      for (const key of item.keys || []) {
        const jid = jidNormalizedUser(key.remoteJid)
        const list = messages[jid]
        const message = list?.get(key.id)
        if (message) list.remove(message)
        if (list?.array.length === 0) delete messages[jid]
      }
    })
    ev.on("groups.update", updates => {
      for (const update of updates) {
        const id = update.id
        if (groupMetadata[id]) Object.assign(groupMetadata[id], update)
        else logger.debug({ update }, "got update for non-existant group metadata")
      }
    })
    ev.on("group-participants.update", ({ id, participants, action }) => {
      const metadata = groupMetadata[id]
      if (!metadata) return
      const ids = new Set(participants.map(participant => typeof participant === "string" ? participant : participant.id))
      switch (action) {
        case "add": {
          const existing = new Set(metadata.participants.map(participant => participant.id))
          for (const id of ids) {
            if (id && !existing.has(id)) metadata.participants.push({ id, isAdmin: false, isSuperAdmin: false })
          }
          break
        }
        case "promote":
        case "demote":
          for (const participant of metadata.participants) {
            if (ids.has(participant.id) && participant.admin !== "superadmin") {
              participant.isAdmin = action === "promote"
              participant.admin = participant.isAdmin ? "admin" : null
            }
          }
          break
        case "remove":
          metadata.participants = metadata.participants.filter(p => !ids.has(p.id))
          break
      }
    })
    ev.on("message-receipt.update", updates => {
      for (const { key, receipt } of updates) {
        const obj = messages[jidNormalizedUser(key.remoteJid)]
        const msg = obj?.get(key.id)
        if (msg) updateMessageWithReceipt(msg, receipt)
      }
    })
    ev.on("messages.reaction", reactions => {
      for (const { key, reaction } of reactions) {
        const obj = messages[jidNormalizedUser(key.remoteJid)]
        const msg = obj?.get(key.id)
        if (msg) updateMessageWithReaction(msg, reaction)
      }
    })
  }
  const toJSON = () => ({ chats, contacts, messages, labels, labelAssociations })
  const fromJSON = (json) => {
    for (const chat of json.chats || []) chats.upsert(chat)
    for (const association of json.labelAssociations || []) labelAssociations.upsert(association)
    contactsUpsert(Object.values(json.contacts || {}))
    labelsUpsert(Object.values(json.labels || {}))
    for (const [jid, entries] of Object.entries(json.messages || {})) {
      for (const msg of entries) upsertMessage(proto.WebMessageInfo.fromObject(msg), "append", jidNormalizedUser(jid))
    }
  }
  return {
    chats,
    contacts,
    messages,
    groupMetadata,
    state,
    presences,
    labels,
    labelAssociations,
    bind,
    loadMessages: async (jid, count, cursor) => {
      const entries = messages[jidNormalizedUser(jid)]?.array
      if (!entries || count <= 0) return []
      if (!cursor) return entries.slice(-count)
      const cursorKey = cursor.before ?? cursor.after
      const index = entries.findIndex(msg => msg.key.id === cursorKey?.id)
      if (index < 0) return []
      return cursor.before
        ? entries.slice(Math.max(0, index - count), index)
        : entries.slice(index + 1, index + 1 + count)
    },
    getLabels: () => labels,
    getChatLabels: (chatId) => labelAssociations.filter(la => la.chatId === chatId).all(),
    getMessageLabels: (messageId) => labelAssociations.filter(la => la.messageId === messageId).all().map(l => l.labelId),
    loadMessage: async (jid, id) => messages[jidNormalizedUser(jid)]?.get(id),
    mostRecentMessage: async (jid) => messages[jidNormalizedUser(jid)]?.array.at(-1),
    fetchImageUrl: async (jid, baron) => {
      const contact = contacts[jid]
      if (!contact) return baron?.profilePictureUrl?.(jid)
      if (typeof contact.imgUrl === "undefined") {
        contact.imgUrl = await baron?.profilePictureUrl?.(jid)
      }
      return contact.imgUrl
    },

    fetchGroupMetadata: async (jid, baron) => {
      if (!groupMetadata[jid]) {
        const metadata = await baron?.groupMetadata(jid)
        if (metadata) groupMetadata[jid] = metadata
      }
      return groupMetadata[jid]
    },
    fetchMessageReceipts: async ({ remoteJid, id }) => {
      const list = messages[jidNormalizedUser(remoteJid)]
      const msg = list?.get(id)
      return msg?.userReceipt
    },
    toJSON,
    fromJSON,
    writeToFile: (path) => writeFile(path, JSON.stringify(toJSON(), BufferJSON.replacer)),
    readFromFile: async (path) => {
      let contents
      try {
        contents = await readFile(path, "utf8")
      } catch (error) {
        if (error.code === "ENOENT") return
        throw error
      }
      fromJSON(JSON.parse(contents, BufferJSON.reviver))
    }
  }
}
