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

// WhatsApp Group JIDs
const SPARK_CONSOLE_JID = '120363431984658364@g.us';
const GITA_COMMUNITY_JID = '120363406391193280@g.us';
const VSC_ACADEMICS_JID = '120363425711044492@g.us';
const VIDYA_AVIDYA_JID = '120363427315951484@g.us';

// Embedded Google OAuth Credentials for Drive Backup
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
let workingModelName = null;

// --- Express Web Dashboard & Health Pings ---
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
        <p>Active AI Model: ${workingModelName || 'Auto-Discovering Flash'}</p>
        <p>Permanent Commands: <code>!find groups</code>, <code>!top</code>, <code>do your work</code></p>
        <p style="margin-top:30px;"><a href="/reset" style="color:#f85149;text-decoration:none;font-size:12px;border:1px solid #f85149;padding:6px 12px;border-radius:6px;">⚠️ Reset Session & Generate Fresh QR</a></p>
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
        <p style="margin-top:20px;"><a href="/reset" style="color:#f85149;text-decoration:none;font-size:12px;">Reset Keys</a></p>
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
        <p>Synchronizing authentication state...</p>
      </body>
      </html>
    `);
  }
});

// 1-Click Clean Session Reset
app.get('/reset', async (req, res) => {
  try {
    console.log('[Reset] Purging desynchronized session keys...');
    const token = await getGoogleAccessToken();
    const searchRes = await fetch(
      "https://www.googleapis.com/drive/v3/files?q=name='spark_baileys_bundle.json'+and+trashed=false&fields=files(id)",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const searchData = await searchRes.json();
    if (searchData.files) {
      for (const file of searchData.files) {
        await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` }
        });
      }
    }
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    isConnected = false;
    currentQR = null;
    if (sock) {
      try { sock.end(new Error('Manual session reset')); } catch (_) {}
    }
    setTimeout(startWhatsAppBot, 2000);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#0d1117;color:#c9d1d9;">
        <h2>🔄 Session Purged Successfully</h2>
        <p>Loading fresh QR code in 3 seconds...</p>
        <script>setTimeout(() => window.location.href = '/', 3000);</script>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send('Reset failed: ' + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`[Dashboard] Running on port ${PORT}`);
});

// --- Google Drive Session Ratchet Sync ---
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
      console.log('[Drive] No previous session bundle found. Ready for fresh pairing.');
      return false;
    }

    console.log('[Drive] Restoring bundle:', bundleFile.id);
    const downloadRes = await fetch(`https://www.googleapis.com/drive/v3/files/${bundleFile.id}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const bundle = await downloadRes.json();

    let count = 0;
    for (const [filename, fileContent] of Object.entries(bundle)) {
      fs.writeFileSync(path.join(AUTH_DIR, filename), fileContent, 'utf8');
      count++;
    }
    console.log(`[Drive] Restored ${count} session keys.`);
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
      console.log(`[Drive] Synced ${files.length} keys.`);
    } else {
      const metadata = JSON.stringify({ name: 'spark_baileys_bundle.json', mimeType: 'application/json' });
      const boundary = '-------314159265358979323846';
      const multipartBody =
        `\r\n--${boundary}\r\n` +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        metadata +
        `\r\n--${boundary}\r\n` +
        'Content-Type: application/json\r\n\r\n' +
        bundleJson +
        `\r\n--${boundary}--\r\n`;

      await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body: multipartBody
      });
      console.log(`[Drive] Created bundle with ${files.length} keys.`);
    }
  } catch (err) {
    console.error('[Drive] Save error:', err.message);
  }
}

function queueSaveBundle() {
  if (driveSaveTimeout) clearTimeout(driveSaveTimeout);
  driveSaveTimeout = setTimeout(() => {
    saveAuthBundleToDrive();
  }, 3000);
}

// --- WhatsApp Native Formatting Sanitizer ---
function formatForWhatsApp(text) {
  if (!text) return '';
  let s = text;
  s = s.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '*───────────────────*');
  s = s.replace(/^[ \t]*#{1,6}[ \t]+(.*)$/gm, '*$1*');
  s = s.replace(/\*\*\*(.*?)\*\*\*/g, '*_$1_*');
  s = s.replace(/\*\*(.*?)\*\*/g, '*$1*');
  s = s.replace(/\*\*/g, '*');
  return s.trim();
}

// --- Gemini AI Engine ---
const SPARK_PERSONA_PROMPT = `
You are Gemini Spark, a personal research assistant supporting Aman Jha (MBBS student at GSVM Medical College, Kanpur / ABVMU).
Guidelines:
- Tone: Grounded, warm, direct, respectful peer collaborator.
- Style: Clear, concise English, active voice, selective bolding, scannable structure.
- Context: Deep appreciation for Bhagavad Gita and Vedanta, rigorous medical academic progress, and community service.
- FORMATTING RULE: Strictly use WhatsApp formatting! Use *text* for bold (never ** or ***). Use _text_ for italics.
`;

const POLL_GENERATOR_PROMPT = `
You are the Quiz Poll Creator for the CW Gita Community, strictly following Rohan's Editorial Principles and the AP Framework.
Your task is to take the provided source post and generate EXACTLY 3 SEPARATE WHATSAPP MESSAGES.

MANDATORY LANGUAGE RULE:
- All body text, questions, dilemma, options, and explanation MUST be written in natural, conversational HINDI (देवनागरी लिपि).
- Do NOT write full sentences or paragraphs in English.
- Use clean English in Latin script ONLY for technical/conceptual keywords (e.g., Symptom, Consumption, Ecosystem, Lifestyle, Care & Maintenance).
- STRICTLY FORBIDDEN: Dual-bracketed translations like 'Symptom (लक्षण)' ❌ or transliterations like 'कांसेप्ट' ❌.
- NEVER transliterate Hindi words in English (never write 'Bhog' ❌). Write 'Consumption' (strongly preferred) or 'भोग'.

STRICT WHATSAPP FORMATTING RULES:
- BOLD: Use strictly SINGLE asterisk: *text* (NEVER ** or ***).
- ITALICS: Use single underscore: _text_.
- NEVER use markdown headers like ### or ##. Use *Heading* instead.
- NEVER use markdown dividers like --- or ***. Use *───────────────────* instead.

EDITORIAL & OPTION RULES:
1. Never declare the conclusion or preach upfront in the question premise.
2. Break biases with counter-intuitive, eye-opening facts from the post.
3. Option differentiation: Structure 1 true root cause against 3 common, persuasive surface misconceptions.
4. The correct option must represent the deepest root reality (human lifestyle, desire, and Consumption / भोग).
5. Emojis: Exactly 1 emoji at start of regular paragraphs; option thematic emojis placed at END of line; no doubles.
6. Dashes: Always leave space: '— *' (never '—*').

You MUST output the 3 messages separated EXACTLY by the tags ===MSG1===, ===MSG2===, and ===MSG3===.

===MSG1===
*Good Morning Everyone!* 🙏
Let's begin the day with [short reflective Hindi phrase] ☀️

A fresh morning, a fresh opportunity to [short reflective Hindi phrase] 🌱

[ *QUIZ — Day [X] | [Date]* ]

*───────────────────*

[1-2 short dilemma paragraphs in simple conversational Hindi, starting each with 1 emoji, key concepts in *bold Latin English*]

===MSG2===
❓ *Question:*
[Counter-intuitive dilemma question in simple Hindi without revealing the answer]

____________________

🎯 *Options:*

1️⃣ [*Option 1 in Hindi with bold concept*] [thematic emoji]
2️⃣ [*Option 2 in Hindi with bold concept*] [thematic emoji]
3️⃣ [*Option 3 in Hindi with bold concept*] [thematic emoji]
4️⃣ [*Option 4 in Hindi with bold concept*] [thematic emoji]

===MSG3===
*[Answer - QUIZ - Day [X] - [Date]]*
*───────────────────*
✅ *Correct Answer:* *Option [X]* — _[Verbatim option in italics]_
*───────────────────*

[Story hook connecting Options 1 & 2 in conversational Hindi]

[Root deconstruction of Option 3 in conversational Hindi]

[Deep conclusion pointing to human lifestyle and Consumption / भोग]

📚 *स्त्रोत:*
1️⃣ [Source Article / Reference from post]
2️⃣ AP GITA COMMUNITY
`;

async function callGemini(fullPrompt) {
  const rawKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.API_KEY || '';
  const apiKey = rawKey.replace(/["']/g, '').trim();

  if (!apiKey) return '⚠️ Gemini API key is missing. Set GEMINI_API_KEY in Render Environment Variables.';

  let modelsToTry = [];
  if (workingModelName) modelsToTry.push(workingModelName);

  try {
    const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const listData = await listRes.json();
    if (listData.models && Array.isArray(listData.models)) {
      const valid = listData.models
        .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
        .map(m => m.name.replace('models/', ''));

      const flashModels = valid.filter(m => m.toLowerCase().includes('flash'));
      const otherModels = valid.filter(m => !m.toLowerCase().includes('flash') && !m.toLowerCase().includes('pro'));
      modelsToTry = Array.from(new Set([...modelsToTry, ...flashModels, ...otherModels, ...valid]));
    }
  } catch (_) {}

  if (modelsToTry.length === 0) {
    modelsToTry = ['gemini-2.0-flash', 'gemini-1.5-flash-001', 'gemini-1.5-flash-002', 'gemini-1.5-flash'];
  }

  const errors = [];
  for (const model of modelsToTry) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: fullPrompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 1500 }
        })
      });

      const data = await res.json();
      if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
        workingModelName = model;
        return data.candidates[0].content.parts[0].text.trim();
      }
      if (data.error) errors.push(`${model}: ${data.error.message.slice(0, 100)}`);
    } catch (netErr) {
      errors.push(`${model}: ${netErr.message}`);
    }
  }

  return `⚠️ AI Error: Could not generate response with available models.\n${errors.slice(0, 2).join('\n')}`;
}

async function queryGemini(prompt, isSparkPersona = false) {
  const systemInstruction = isSparkPersona ? SPARK_PERSONA_PROMPT : '';
  const userText = isSparkPersona ? `${systemInstruction}\n\nUser Question: ${prompt}` : prompt;
  return await callGemini(userText);
}

async function generatePollFromPost(postText) {
  const todayDate = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
  const fullPrompt = `${POLL_GENERATOR_PROMPT}\n\nToday's Date: ${todayDate}\n\nSource Post:\n"""\n${postText}\n"""\n\nGenerate the 3 messages with the delimiters ===MSG1===, ===MSG2===, and ===MSG3===:`;
  return await callGemini(fullPrompt);
}

function extractTextFromMessage(message) {
  if (!message) return '';
  const m =
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message;

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  );
}

function extractQuotedText(msg) {
  const contextInfo =
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo ||
    msg.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo;

  if (!contextInfo?.quotedMessage) return '';
  return extractTextFromMessage(contextInfo.quotedMessage).trim();
}

// --- Baileys WhatsApp Runner ---
async function startWhatsAppBot() {
  await restoreAuthBundleFromDrive();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
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
      const isReplaced = statusCode === 440;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(`[Connection] Closed. Status: ${statusCode}`);

      if (isReplaced) {
        console.log('[Connection] Replaced by newer container. Standing down.');
        return;
      }

      if (isLoggedOut) {
        console.log('[Connection] Session revoked on phone. Purging Drive bundle and regenerating QR...');
        if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });

        getGoogleAccessToken().then(token => {
          fetch("https://www.googleapis.com/drive/v3/files?q=name='spark_baileys_bundle.json'+and+trashed=false&fields=files(id)", {
            headers: { Authorization: `Bearer ${token}` }
          }).then(r => r.json()).then(data => {
            if (data.files) {
              data.files.forEach(f => {
                fetch(`https://www.googleapis.com/drive/v3/files/${f.id}`, {
                  method: 'DELETE',
                  headers: { Authorization: `Bearer ${token}` }
                });
              });
            }
          });
        }).catch(() => {});

        setTimeout(startWhatsAppBot, 3000);
        return;
      }

      setTimeout(startWhatsAppBot, 5000);
    } else if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      console.log('[Connection] WhatsApp connected successfully.');
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

      const text = extractTextFromMessage(msg.message).trim();
      if (!text) continue;

      // Ignore personal chat "(You)" / 1-on-1 messages sent to oneself
      if (!isGroup && isMe) continue;

      let groupSubject = '';
      if (isGroup) {
        try {
          const groupMeta = await sock.groupMetadata(remoteJid).catch(() => null);
          groupSubject = (groupMeta?.subject || '').trim().toLowerCase();
        } catch (_) {}
      }

      //
