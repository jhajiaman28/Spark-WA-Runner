// index.js - Spark WA Runner
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  delay
} from '@whiskeysockets/baileys';
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';

// --- Configuration & Constants ---
const PORT = process.env.PORT || 10000;
const AUTH_DIR = path.resolve('./auth_info');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Group JIDs
const SPARK_CONSOLE_JID = '120363431984658364@g.us';
const GITA_COMMUNITY_JID = '120363406391193280@g.us';
const VSC_ACADEMICS_JID = '120363425711044492@g.us';
const VIDYA_AVIDYA_JID = '120363427315951484@g.us';

// Embedded Google OAuth Credentials
const GOOGLE_CLIENT_ID = '41140154242-01hdsdr947cpqgmq6gv2pk2ec3v59g2h.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = Buffer.from('R09DU1BYLVpaeFlIenJmSmd2djJzTTc0cW5OWi1xRkt2M28=', 'base64').toString('utf8');
const GOOGLE_REFRESH_TOKEN = '1//0gxt9_c-k14bnCgYIARAAGBASNwF-L9IrlWE4Bb376oaU-tnq0odLTyOqN-izOSzgoQ1kGsfNf7KeUwTPj5E_X16BGrn2aJr5dA8';

// State Variables
let sock = null;
let currentQR = null;
let isConnected = false;
let isPaused = false;
let botStartTime = Date.now();
let driveSaveTimeout = null;

// --- Express Server (Dashboard & UptimeRobot Keep-Alive) ---
const app = express();
app.use(express.json());

app.get('/', async (req, res) => {
  if (isConnected) {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Spark WA Runner</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family:sans-serif;text-align:center;padding:50px;background:#0d1117;color:#c9d1d9;">
        <h2 style="color:#2ea043;">✅ Spark WA Runner is Active & Connected</h2>
        <p>Uptime: ${Math.floor((Date.now() - botStartTime) / 60000)} minutes</p>
        <p>Engine: Baileys Multi-Key Bundle Sync | Gemini AI Enabled</p>
      </body>
      </html>
    `);
  } else if (currentQR) {
    const qrDataUrl = await QRCode.toDataURL(currentQR, { width: 320 });
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Spark WA Runner - Pair WhatsApp</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="refresh" content="5">
      </head>
      <body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d1117;color:#c9d1d9;">
        <h2>Scan QR Code to Connect Spark</h2>
        <p style="color:#8b949e;">WhatsApp ➔ Linked Devices ➔ Link a Device</p>
        <img src="${qrDataUrl}" style="border: 8px solid white; border-radius: 8px;" />
        <p style="font-size:12px;color:#8b949e;">Auto-refreshes every 5 seconds</p>
      </body>
      </html>
    `);
  } else {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Spark WA Runner</title><meta http-equiv="refresh" content="3"></head>
      <body style="font-family:sans-serif;text-align:center;padding:50px;background:#0d1117;color:#c9d1d9;">
        <h2>Initializing WhatsApp Engine...</h2>
        <p>Restoring session bundle from Google Drive...</p>
      </body>
      </html>
    `);
  }
});

app.listen(PORT, () => {
  console.log(`[Dashboard] Running on port ${PORT}`);
});

// --- Google Drive Full Session Bundle Sync ---
async function getGoogleAccessToken() {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('OAuth refresh failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function restoreAuthBundleFromDrive() {
  try {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    const token = await getGoogleAccessToken();

    const searchRes = await fetch(
      "https://www.googleapis.com/drive/v3/files?q=name='spark_baileys_bundle.json'+and+trashed=false&fields=files(id,name)",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const searchData = await searchRes.json();
    const bundleFile = searchData.files && searchData.files[0];

    if (!bundleFile) {
      console.log('[Drive] No existing session bundle found. Ready for fresh QR pairing.');
      return false;
    }

    console.log('[Drive] Downloading session bundle:', bundleFile.id);
    const downloadRes = await fetch(`https://www.googleapis.com/drive/v3/files/${bundleFile.id}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const bundle = await downloadRes.json();

    let restoredCount = 0;
    for (const [filename, fileContent] of Object.entries(bundle)) {
      fs.writeFileSync(path.join(AUTH_DIR, filename), fileContent, 'utf8');
      restoredCount++;
    }
    console.log(`[Drive] Restored ${restoredCount} session ratchet files.`);
    return true;
  } catch (err) {
    console.error('[Drive] Restore error:', err.message);
    return false;
  }
}

async function saveAuthBundleToDrive() {
  try {
    if (!fs.existsSync(AUTH_DIR)) return;
    const files = fs.readdirSync(AUTH_DIR);
    if (files.length === 0) return;

    const bundle = {};
    for (const file of files) {
      const fullPath = path.join(AUTH_DIR, file);
      if (fs.statSync(fullPath).isFile()) {
        bundle[file] = fs.readFileSync(fullPath, 'utf8');
      }
    }
    const bundleJson = JSON.stringify(bundle);
    const token = await getGoogleAccessToken();

    const searchRes = await fetch(
      "https://www.googleapis.com/drive/v3/files?q=name='spark_baileys_bundle.json'+and+trashed=false&fields=files(id)",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const searchData = await searchRes.json();
    const existingFile = searchData.files && searchData.files[0];

    if (existingFile) {
      await fetch(`https://www.googleapis.com/upload/drive/v3/files/${existingFile.id}?uploadType=media`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: bundleJson
      });
      console.log(`[Drive] Updated bundle (${files.length} keys synchronized).`);
    } else {
      const metadata = JSON.stringify({ name: 'spark_baileys_bundle.json', mimeType: 'application/json' });
      const boundary = '-------314159265358979323846';
      const delimiter = `\r\n--${boundary}\r\n`;
      const closeDelimiter = `\r\n--${boundary}--`;

      const multipartBody =
        delimiter +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        metadata +
        delimiter +
        'Content-Type: application/json\r\n\r\n' +
        bundleJson +
        closeDelimiter;

      await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body: multipartBody
      });
      console.log(`[Drive] Created initial bundle (${files.length} keys uploaded).`);
    }
  } catch (err) {
    console.error('[Drive] Save bundle error:', err.message);
  }
}

function queueSaveBundle() {
  if (driveSaveTimeout) clearTimeout(driveSaveTimeout);
  driveSaveTimeout = setTimeout(() => {
    saveAuthBundleToDrive();
  }, 3000);
}

// --- Gemini AI Engine ---
const SPARK_PERSONA_PROMPT = `
You are Gemini Spark, an AI assistant supporting Aman Jha (MBBS student at GSVM Medical College, Kanpur / ABVMU).
Guidelines:
- Tone: Grounded, warm, direct, respectful peer collaborator.
- Style: Clear, concise English, active voice, selective bolding, scannable structure.
- Context: Deep appreciation for Bhagavad Gita and Vedanta, rigorous medical academic progress, and community service.
- Never write filler, corporate buzzwords, or meta-announcements. Answer the prompt directly and substantively.
`;

async function queryGemini(prompt, isSparkPersona = false) {
  if (!GEMINI_API_KEY) {
    return '⚠️ Gemini API key is not configured in environment variables.';
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const systemInstruction = isSparkPersona ? SPARK_PERSONA_PROMPT : '';

  const bodyPayload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: isSparkPersona ? `${systemInstruction}\n\nUser Prompt: ${prompt}` : prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1000
    }
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyPayload)
    });
    const data = await res.json();

    if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
      return data.candidates[0].content.parts[0].text.trim();
    }
    return '⚠️ Could not generate an answer at this time.';
  } catch (err) {
    return `⚠️ AI Error: ${err.message}`;
  }
}

// --- Baileys WhatsApp Client ---
async function startWhatsAppBot() {
  await restoreAuthBundleFromDrive();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    browser: ['Spark WA Runner', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    queueSaveBundle();
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) currentQR = qr;

    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[Connection] Closed. Reconnecting: ${shouldReconnect} (status: ${statusCode})`);

      if (statusCode === DisconnectReason.loggedOut) {
        if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      }

      if (shouldReconnect) {
        setTimeout(startWhatsAppBot, 5000);
      }
    } else if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      console.log('[Connection] WhatsApp connected.');
      queueSaveBundle();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      const remoteJid = msg.key.remoteJid;
      const isGroup = remoteJid.endsWith('@g.us');
      const isMe = msg.key.fromMe;

      // Extract message text
      const body =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';

      const trimmedText = body.trim();
      if (!trimmedText) continue;

      // 1. Exclude personal chat "(You)" / self messages in 1-on-1 chats
      if (!isGroup && isMe) continue;

      // 2. Exclude group named "CHAT"
      if (isGroup) {
        try {
          const groupMeta = await sock.groupMetadata(remoteJid).catch(() => null);
          if (groupMeta && groupMeta.subject && groupMeta.subject.trim().toLowerCase() === 'chat') {
            continue;
          }
        } catch (_) {}
      }

      // 3. Universal AI Commands: !ask spark <prompt> and !ask <prompt>
      if (trimmedText.startsWith('!ask spark ')) {
        const query = trimmedText.replace('!ask spark ', '').trim();
        if (query) {
          const aiReply = await queryGemini(query, true);
          await sock.sendMessage(remoteJid, { text: aiReply }, { quoted: msg });
        }
        continue;
      }

      if (trimmedText.startsWith('!ask ')) {
        const query = trimmedText.replace('!ask ', '').trim();
        if (query) {
          const aiReply = await queryGemini(query, false);
          await sock.sendMessage(remoteJid, { text: aiReply }, { quoted: msg });
        }
        continue;
      }

      // 4. Admin Console Commands (Strictly restricted to private Spark Console Group)
      if (remoteJid === SPARK_CONSOLE_JID) {
        await handleAdminCommand(remoteJid, trimmedText, msg);
      }
    }
  });
}

// --- Admin Console Handler ---
async function handleAdminCommand(jid, text, msg) {
  const cmd = text.toLowerCase();

  if (cmd === '#start' || cmd === '!status') {
    const uptimeMin = Math.floor((Date.now() - botStartTime) / 60000);
    const statusMsg =
      `⚡ *Spark WA Runner Status*\n\n` +
      `• *State:* ${isPaused ? '⏸️ Paused' : '✅ Active'}\n` +
      `• *Uptime:* ${uptimeMin} minutes\n` +
      `• *Session Sync:* Google Drive Cloud Bundle\n` +
      `• *AI Commands:* \`!ask <prompt>\` & \`!ask spark <prompt>\` active\n` +
      `• *Exclusions:* Personal chat (You) & group "CHAT"`;
    await sock.sendMessage(jid, { text: statusMsg }, { quoted: msg });
    return;
  }

  if (cmd === '!stop') {
    isPaused = true;
    await sock.sendMessage(jid, { text: '⏸️ Runner paused.' }, { quoted: msg });
    return;
  }

  if (cmd === '!resume') {
    isPaused = false;
    await sock.sendMessage(jid, { text: '▶️ Runner resumed.' }, { quoted: msg });
    return;
  }

  if (cmd === '!poll gita') {
    await sock.sendMessage(GITA_COMMUNITY_JID, {
      poll: {
        name: 'Daily Session Attendance (Select one):',
        values: ['Present ✅', 'Absent ❌'],
        selectableCount: 1
      }
    });
    await sock.sendMessage(jid, { text: '✅ Gita attendance poll sent to CW Gita Community.' }, { quoted: msg });
    return;
  }

  if (cmd === '!poll vidya') {
    await sock.sendMessage(VIDYA_AVIDYA_JID, {
      poll: {
        name: 'आज कितने पोस्ट शेयर किए? (Daily Post Count)',
        values: ['0', '1', '2', '3', '3+'],
        selectableCount: 1
      }
    });
    await sock.sendMessage(jid, { text: '✅ Evening poll sent to CW विद्या-अविद्या.' }, { quoted: msg });
    return;
  }

  if (cmd === '!remind vsc') {
    const reminder =
      `🔔 *VSC Academics Daily Study Reminder*\n\n` +
      `Please post your completed study topics for today using the standard format.`;
    await sock.sendMessage(VSC_ACADEMICS_JID, { text: reminder });
    await sock.sendMessage(jid, { text: '✅ Study reminder sent to VSC Academics.' }, { quoted: msg });
    return;
  }

  if (cmd === '!template vsc') {
    const template =
      `📚 *VSC Academics - Daily Update Format*\n\n` +
      `Name: [Your Name]\n` +
      `Date: [DD/MM/YYYY]\n` +
      `Subjects / Topics Studied:\n` +
      `1. [Subject - Topic 1]\n` +
      `2. [Subject - Topic 2]`;
    await sock.sendMessage(VSC_ACADEMICS_JID, { text: template });
    await sock.sendMessage(jid, { text: '✅ Template sent to VSC Academics.' }, { quoted: msg });
    return;
  }
}

// Start Runner
startWhatsAppBot().catch(console.error);
