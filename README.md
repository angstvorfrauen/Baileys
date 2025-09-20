# @angstvorfrauen/baileys

---

## ✨ Features

- ✅ **libsignal-xeuka** – Improved cryptography library  
- ✅ **Buttons Support** – Send Buttons Fixed `lid` issue
- ✅ **Device Pairing iOS** – Pair with iOS devices easily  
- ✅ **Custom Pairing Code** – Generate and use your own pairing code  
- ✅ **Removed Timeout** – No unwanted session timeouts  
- ✅ **Updated Proto** – The Proto has been Updated to the newest Version
- ✅ **isBot Fixed in Groups** – `isBot` detection now works correctly in group chats  
- ✅ **Added offerCall** – Now you can call a Person by using `xxxx.offerCall(49156780000@s.whatsapp.net);`

---

## 📦 Installation

Yarn
```
yarn add @angstvorfrauen/baileys
```

Npm
```
npm install @angstvorfrauen/baileys
```

---

## 🔧 Usage

Call Example

```js
case "call": {
  const [mobileNumber, spamCountStr] = args.join(" ").split(",").map(arg => arg.trim());
  const target1 = mobileNumber.replace(/[+\s()-]/g, "") + "@s.whatsapp.net";
  const spam1 = parseInt(spamCountStr);
  sock.sendMessage(from, { react: { text: "⏱️", key: m.key } });
  for (let i = 0; i < spam1; i++) {
    sock.offerCall(target1);
  }
  await delay(3000);
  sock.sendMessage(from, { react: { text: "✔️", key: m.key } });
}
break;
```

Info Example

```js
case "info": {
  sock.sendMessage(from, { react: { text: "🍀", key: info.key } });
  const infogetclone1 = isQuotedMsg ? 
    info.message.extendedTextMessage.contextInfo.quotedMessage.extendedTextMessage : 
    info.message.extendedTextMessage.contextInfo.quotedMessage;
  const formattedJson = JSON.stringify(infogetclone1, null, 2);
  const finalCode = `case "sock": {\n  sock.sendjson(from,${formattedJson.replace(/^/gm, " ")});\n}\nbreak;`;
  sock.sendjson(from, {
    "extendedTextMessage": {
      "text": finalCode,
      "contextInfo": {
        "forwardingScore": 127,
        "isForwarded": true,
        "forwardedNewsletterMessageInfo": {
          "newsletterJid": "999999999@newsletter",
          "severMessageId": "1",
          "newsletterName": `𝐡𝐭𝐭𝐩𝐬://𝐭.𝐦𝐞/𝐑𝐨𝐜𝐤𝐞𝐭𝐂𝐥𝐢𝐞𝐧𝐭🕺`,
          "contentType": "LINK_CARD"
        }
      }
    }
  });
}
break;
```

---

# Made by Xeuka 🍀