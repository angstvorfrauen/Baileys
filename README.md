# @angstvorfrauen/baileys

<div align="center">

![WhatsApp](https://img.shields.io/badge/-%F0%9F%92%AC%20WhatsApp-25D366?style=for-the-badge&logo=whatsapp&logoColor=white&labelColor=0D1117)
![JavaScript](https://img.shields.io/badge/-%F0%9F%94%B8%20JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=F7DF1E&labelColor=0D1117)
![npm](https://img.shields.io/badge/-%F0%9F%93%A6%20npm-CB3837?style=for-the-badge&logo=npm&logoColor=white&labelColor=0D1117)

</div>

A Baileys fork for connecting a Node.js app to WhatsApp as a linked device. This README documents the patched build used by RocketClient.

## Version

- **Patched package** · `3.0.4`
- **Default WhatsApp Web version** · `2.3000.1054536880`
- **Protocol definitions** · bundled in `WAProto`
- **Linked device** · Safari on iOS `18.2`
- **Runtime for the examples and RocketClient** · Node.js `22.12.0` or newer

## Changelog

- **Safari and pairing** · Uses the iOS/Safari device profile by default and accepts custom eight-character pairing codes.
- **Buttons and interactive messages** · Adds the WhatsApp message metadata for buttons, lists, and Native Flow messages. RocketClient's `.menu` sends a Ping quick reply and a Telegram URL button.
- **Community management** · Adds `unlinkCommunityGroup(communityJid, groupJid)` and exposes linked-group lookup.
- **Call offers** · Adds `offerCall(jid, isVideo)` for audio and video call signaling.
- **Jimp** · Uses Jimp `0.16.1` for image thumbnails and profile pictures, including group pictures.
- **Store and KeyDB** · Exports the in-memory store, cache-backed auth helper, and `KeyedDB`. RocketClient keeps up to 100 messages per chat for retry lookup.
- **Connection handling** · RocketClient backs off between reconnect attempts. The socket cleans up pending query listeners after completion, timeout, or disconnect.
- **Formatting** · Uses double-quoted JavaScript strings and removes line comments from the patched package.

## Installation

### Patched build

Install the local archive to use the features documented below. From the bot folder, you can build the archive from the patched package already installed in `node_modules`.

```powershell
New-Item -ItemType Directory -Path .\vendor -Force | Out-Null
npm pack ./node_modules/@angstvorfrauen/baileys --ignore-scripts --pack-destination ./vendor
```

```bash
npm install ./vendor/angstvorfrauen-baileys-3.0.4.tgz
```

```bash
yarn add file:./vendor/angstvorfrauen-baileys-3.0.4.tgz
```

To pin the patched build in `package.json`, keep the archive in the project's `vendor` folder.

```json
{
  "dependencies": {
    "@angstvorfrauen/baileys": "file:vendor/angstvorfrauen-baileys-3.0.4.tgz"
  }
}
```

### Published npm package

The registry commands install the published package. Check its version and release notes for the APIs included in that release. [npm package](https://www.npmjs.com/package/@angstvorfrauen/baileys?activeTab=versions)

```bash
npm install @angstvorfrauen/baileys
```

```bash
yarn add @angstvorfrauen/baileys
```

## Import

### ESM

```js
import makeWASocket from "@angstvorfrauen/baileys";
```

### CommonJS

```js
const { makeWASocket } = require("@angstvorfrauen/baileys");
```

## Quick start

For the included RocketClient bot, run `npm start` from the bot folder. On first launch, enter your phone number with its country code and use the printed code in WhatsApp under **Linked devices**.

For your own app, use this example in an `.mjs` file. Set `WA_PHONE_NUMBER` to your phone number in international format using digits only. Keep the `session/` directory private because it contains your linked-device credentials.

```js
import makeWASocket, {
  makeInMemoryStore,
  useMultiFileAuthState
} from "@angstvorfrauen/baileys";

const { state, saveCreds } = await useMultiFileAuthState("./session");
const phone = process.env.WA_PHONE_NUMBER;
if (!state.creds.registered && !/^[1-9]\d{5,14}$/.test(phone ?? "")) {
  throw new Error("Set WA_PHONE_NUMBER to your phone number with its country code.");
}

const store = makeInMemoryStore({ maxMessagesPerChat: 100 });
const sock = makeWASocket({
  auth: state,
  getMessage: async ({ remoteJid, id }) => (await store.loadMessage(remoteJid, id))?.message
});

store.bind(sock.ev);
sock.ev.on("creds.update", () => void saveCreds().catch(console.error));

let pairing;
sock.ev.on("connection.update", ({ connection, qr }) => {
  if (connection === "open") console.log("Connected to WhatsApp");
  if (!qr || state.creds.registered || pairing) return;

  pairing = sock.requestPairingCode(phone)
    .then(code => console.log(code.match(/.{1,4}/g).join("-")))
    .catch(error => {
      pairing = undefined;
      console.error(error.message);
    });
});
```

## Functions