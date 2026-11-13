import { BufferJSON, initAuthCreds } from "../Utils/index.js";
import { proto } from "../../WAProto/index.js";

export async function makeCacheManagerAuthState(store = new Map(), sessionKey) {
  if (typeof sessionKey !== "string" || !sessionKey || sessionKey.includes(":")) {
    throw new TypeError("A session key without colons is required");
  }
  const database = await store;
  const remove = database.del?.bind(database) ?? database.delete?.bind(database);
  if (typeof database.get !== "function" || typeof database.set !== "function" || !remove) {
    throw new TypeError("The cache must implement get, set, and del or delete");
  }

  const prefix = sessionKey + ":";
  const writeData = (file, data) => database.set(prefix + file, JSON.stringify(data, BufferJSON.replacer));
  const readData = async (file) => {
    const value = await database.get(prefix + file);
    return value == null ? null : JSON.parse(value, BufferJSON.reviver);
  };
  const creds = (await readData("creds")) || initAuthCreds();

  return {
    clearState: async () => {
      const storage = typeof database.keys === "function" ? database : database.store;
      if (typeof storage?.keys !== "function") {
        throw new TypeError("The cache must implement keys to clear a session");
      }
      for await (const key of await storage.keys(prefix + "*")) {
        if (typeof key === "string" && key.startsWith(prefix)) await remove(key);
      }
    },
    saveCreds: () => writeData("creds", creds),
    state: {
      creds,
      keys: {
        get: async (type, ids) => Object.fromEntries(await Promise.all(ids.map(async id => {
          const value = await readData(type + "-" + id);
          return [id, type === "app-state-sync-key" && value ? proto.Message.AppStateSyncKeyData.fromObject(value) : value];
        }))),
        set: async (data) => {
          const tasks = [];
          for (const [category, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries)) {
              const key = category + "-" + id;
              tasks.push(value == null ? remove(prefix + key) : writeData(key, value));
            }
          }
          await Promise.all(tasks);
        }
      }
    }
  };
}
