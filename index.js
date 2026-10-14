import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import express from 'express';
import qrcode from 'qrcode';

const app = express();
const PORT = process.env.PORT || 10000;

// Verified WhatsApp Group IDs
const SPARK_JID = '120363431984658364@g.us';          // Private Console
const GITA_JID = '120363406391193280@g.us';           // Acharya Prashant Ji Gita Community strictly

let qrDataUrl = '';
let isConnected = false;
let isStopped = false;
let logs = [];

function addLog(msg) {
  const time = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  logs.unshift(`[${time}] ${msg}`);
  if (logs.length > 30) logs.pop();
  console.log(`[${time}] ${msg}`);
}

async function sendToSpark(sock, text) {
  try {
    await sock.sendMessage(SPARK_JID, { text });
  } catch (err) {
    addLog(`Error sending to Spark: ${err.message}`);
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) qrDataUrl = await qrcode.toDataURL(qr);
    if (connection === 'open') {
      isConnected = true;
      qrDataUrl = '';
      addLog('WhatsApp connected.');
      await sendToSpark(sock, '⚡ *Spark Control Console Active (24/7)*\nTarget: Acharya Prashant Ji Gita Community\nAll other groups and personal chats are ignored.');
    }
    if (connection === 'close') {
      isConnected = false;
      const reconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      addLog(`Connection closed. Reconnecting: ${reconnect}`);
      if (reconnect) startBot();
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
      const fromJid = msg.key.remoteJid;

      if (!text) continue;

      // STRICT PRIVACY: Ignore everything outside the Spark console group
      // (Automatically ignores "CHAT", "YOU" / Message Yourself, DMs, and other groups)
      if (fromJid !== SPARK_JID) continue;

      // 1. Emergency Controls
      if (text === '!stop') {
        isStopped = true;
        await sendToSpark(sock, '🛑 *Bot Stopped.* Automation paused until `!resume` is sent.');
        addLog('Emergency stop triggered.');
        continue;
      }
      if (text === '!resume') {
        isStopped = false;
        await sendToSpark(sock, '▶️ *Bot Resumed.* Automation is now active.');
        addLog('Bot resumed.');
        continue;
      }
      if (isStopped) continue;

      // 2. Status Check
      if (text === '!status') {
        await sendToSpark(sock, '✅ *Status: Active 24/7*\n• Console: Spark Group\n• Target: Acharya Prashant Ji Gita Community');
        continue;
      }

      // 3. List Gita Members to Spark
      if (text === '!list gita') {
        try {
          const meta = await sock.groupMetadata(GITA_JID);
          const members = meta.participants.map((p, i) => `${i + 1}. +${p.id.split('@')[0]}`).join('\n');
          await sendToSpark(sock, `📋 *${meta.subject} Members (${meta.participants.length}):*\n\n${members}`);
          addLog(`Sent member list (${meta.participants.length}) to Spark group.`);
        } catch (err) {
          await sendToSpark(sock, `❌ Error reading Gita members: ${err.message}`);
        }
      }
    }
  });
}

startBot();

// Dashboard UI
app.get('/', (req, res) => {
  res.send(`
    <html><head><title>Spark Runner</title><meta http-equiv="refresh" content="10"></head>
    <body style="font-family:sans-serif;padding:24px;background:#f4f6f8;">
      <div style="background:white;padding:20px;border-radius:10px;max-width:600px;margin:auto;">
        <h2>Spark Control Runner 24/7</h2>
        <p>Status: <b>${isConnected ? '✅ Connected' : '⏳ Awaiting Scan'}</b></p>
        <p>Spark Console: <b>✅ Bound</b></p>
        <p>Target: <b>Acharya Prashant Ji Gita Community</b></p>
        ${qrDataUrl ? `<img src="${qrDataUrl}" width="200"/>` : ''}
        <h3>Recent Logs:</h3>
        <ul>${logs.map(l => `<li>${l}</li>`).join('')}</ul>
      </div>
    </body></html>
  `);
});

app.listen(PORT, () => addLog(`Web dashboard on port ${PORT}`));
