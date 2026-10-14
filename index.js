import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import express from 'express';
import qrcode from 'qrcode';
import https from 'https';
import fs from 'fs';

const app = express();
const PORT = process.env.PORT || 10000;

// API Keys & Credentials
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.API_KEY || '';
const CLIENT_ID = Buffer.from('NDExNDAxNTQyNDItMDFoZHNkcjk0N2NwcWdtcTZndjJwazJlYzN2NTlnMmguYXBwcy5nb29nbGV1c2VyY29udGVudC5jb20=', 'base64').toString('utf-8');
const CLIENT_SECRET = Buffer.from('R09DU1BYLVpaeFlIenJmSmd2djJzTTc0cW5OWi1xRkt2M28=', 'base64').toString('utf-8');
const REFRESH_TOKEN = Buffer.from('MS8vMGd4dDlfYy1rMTRibkNnWUlBUkFBR0JBU053Ri1MOUlybFdFNEJiMzc2b2FVLXRucTBvZExUeU9xTi1pek9TemdvUTFrR3NmTmY3S2VVd1RQajVFX1gxNkJHcm4yYUpyNWRBOA==', 'base64').toString('utf-8');

const GITA_SHEET_ID = '1rgF4V1wIZF_kJvbbmjgiDTOXPQckFvDmMzLN80dILuw';

// Verified Group IDs
const SPARK_JID = '120363431984658364@g.us';
const GITA_JID = '120363406391193280@g.us';
const VSC_JID = '120363425711044492@g.us';
const VIDYA_JID = '120363427315951484@g.us';
let geminiJid = null;
let chatGroupJid = null;

const botSentIds = new Set();
let qrDataUrl = '';
let isConnected = false;
let isStopped = false;
let logs = [];

// System Instructions
const SPARK_INSTRUCTIONS = `You are Gemini Spark, personal research assistant and peer collaborator to Aman Jha, an MBBS First Year student at GSVM Medical College (ABVMU), Kanpur / Lucknow, Uttar Pradesh.
Operating guidelines:
- Act as a supportive, grounded, and capable peer collaborator. Keep responses warm, direct, concise, and structured.
- Context: MBBS 1st Year medical studies, Bhagavad Gita and Vedanta philosophy, community outreach, and academic tracking.
- AP Framework guidelines: Never use Latin transliteration "Bhog" (use "Consumption" or "भोग"). Keep spaces between symbols like "— *" and "— _".
- Provide clinical accuracy, high clarity, and concise practical explanations without fluff.`;

const GENERAL_INSTRUCTIONS = `You are an intelligent, versatile, and helpful AI assistant powered by Gemini. You accurately, concisely, and helpfully execute any prompt, question, explanation, translation, writing, analysis, or coding task directly.`;

function addLog(msg) {
  const time = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  logs.unshift(`[${time}] ${msg}`);
  if (logs.length > 50) logs.pop();
  console.log(`[${time}] ${msg}`);
}

async function sendToSpark(sock, text) {
  try { await sock.sendMessage(SPARK_JID, { text }); } catch (err) { addLog(`Spark send error: ${err.message}`); }
}

async function sendTagAll(sock, groupId, text) {
  try {
    const meta = await sock.groupMetadata(groupId);
    await sock.sendMessage(groupId, { text, mentions: meta.participants.map(p => p.id) });
  } catch {
    await sock.sendMessage(groupId, { text });
  }
}

// Gemini AI Call
function askGemini(prompt, systemInstruction = GENERAL_INSTRUCTIONS) {
  return new Promise((resolve, reject) => {
    if (!GEMINI_KEY) return reject(new Error('GEMINI_API_KEY environment variable not found on Render.'));
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: systemInstruction }] }
    });

    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const reply = json.candidates?.[0]?.content?.parts?.[0]?.text;
          if (reply) resolve(reply);
          else reject(new Error(`Gemini API error: ${data}`));
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getAccessToken() {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN, grant_type: 'refresh_token'
    }).toString();

    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(JSON.parse(data).access_token);
        else reject(new Error(`OAuth Error: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Drive Session Storage: Eliminates QR scanning on redeploy
async function restoreSessionFromDrive() {
  try {
    const token = await getAccessToken();
    const searchRes = await new Promise((resolve, reject) => {
      https.get(`https://www.googleapis.com/drive/v3/files?q=name='spark_baileys_creds.json'+and+trashed=false`, {
        headers: { Authorization: `Bearer ${token}` }
      }, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });

    if (searchRes.files && searchRes.files.length > 0) {
      const fileId = searchRes.files[0].id;
      const credsData = await new Promise((resolve, reject) => {
        https.get(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
          headers: { Authorization: `Bearer ${token}` }
        }, (res) => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => resolve(d));
        }).on('error', reject);
      });

      if (!fs.existsSync('auth_info')) fs.mkdirSync('auth_info', { recursive: true });
      fs.writeFileSync('auth_info/creds.json', credsData);
      addLog('☁️ Auto-restored session from Google Drive! No QR scan needed.');
      return true;
    }
  } catch (err) { addLog(`Session restore note: ${err.message}`); }
  return false;
}

async function saveSessionToDrive() {
  try {
    if (!fs.existsSync('auth_info/creds.json')) return;
    const credsData = fs.readFileSync('auth_info/creds.json', 'utf-8');
    const token = await getAccessToken();

    const searchRes = await new Promise((resolve, reject) => {
      https.get(`https://www.googleapis.com/drive/v3/files?q=name='spark_baileys_creds.json'+and+trashed=false`, {
        headers: { Authorization: `Bearer ${token}` }
      }, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });

    if (searchRes.files && searchRes.files.length > 0) {
      const req = https.request({
        hostname: 'www.googleapis.com', path: `/upload/drive/v3/files/${searchRes.files[0].id}?uploadType=media`,
        method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      }, () => {});
      req.write(credsData);
      req.end();
    } else {
      const boundary = '-------314159265358979323846';
      const metadata = JSON.stringify({ name: 'spark_baileys_creds.json', mimeType: 'application/json' });
      const multipartBody = 
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${credsData}\r\n` +
        `--${boundary}--`;

      const req = https.request({
        hostname: 'www.googleapis.com', path: '/upload/drive/v3/files?uploadType=multipart', method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': Buffer.byteLength(multipartBody) }
      }, () => {});
      req.write(multipartBody);
      req.end();
    }
    addLog('☁️ Session credentials safely synced to Google Drive.');
  } catch (err) { addLog(`Session backup note: ${err.message}`); }
}

function updateSheet(sheetId, range, value) {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getAccessToken();
      const body = JSON.stringify({ values: [[value]] });
      const req = https.request({
        hostname: 'sheets.googleapis.com',
        path: `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => {
        let respData = '';
        res.on('data', chunk => respData += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) resolve(JSON.parse(respData));
          else reject(new Error(`Sheets Error: ${respData}`));
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    } catch (err) { reject(err); }
  });
}

function readSheet(sheetId, range) {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getAccessToken();
      https.get(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`, {
        headers: { Authorization: `Bearer ${token}` }
      }, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => resolve(JSON.parse(d).values || []));
      }).on('error', reject);
    } catch (err) { reject(err); }
  });
}

const GITA_MEMBERS = {
  'alok': 'F', 'aman': 'G', 'amit': 'H', 'anchal': 'I', 'anisha': 'J',
  'anjali': 'K', 'anju': 'L', 'ankit': 'M', 'anshu': 'N', 'anurag': 'O',
  'archana': 'P', 'ayush': 'Q', 'bhuwan': 'R', 'chhavi': 'S', 'deepa': 'T',
  'deva': 'U', 'diksha': 'V', 'dipesh': 'W', 'estuti': 'X', 'garima': 'Y',
  'harsh': 'Z', 'himanshu': 'AA', 'jyoti': 'AB', 'kanchan': 'AC', 'kartikey': 'AD',
  'lawkesh': 'AE', 'luxmi': 'AF', 'mamta': 'AG', 'meenu': 'AH', 'muskan': 'AI',
  'nagendra': 'AJ', 'pooja': 'AK', 'priti': 'AL', 'raghuvansh': 'AM', 'rajnish': 'AN',
  'rohan': 'AO', 'ruhit': 'AP', 'sahiba': 'AQ', 'saksham': 'AR', 'saloni': 'AS',
  'sarika': 'AT', 'sarita': 'AU', 'satwik': 'AV', 'shiv': 'AW', 'shivam': 'AX',
  'shubham': 'AY', 'shweta': 'AZ', 'swapnil': 'BA', 'utkarsh': 'BB', 'vikas': 'BC'
};

const VSC_STUDENTS = [
  'Rohan', 'Swapnil', 'Anurag', 'Pooja', 'Saksham',
  'Himanshu', 'Raghuvansh', 'Amit', 'Aman', 'Anisha',
  'Sahiba', 'Dipesh', 'Muskan', 'Sarita'
];

const HELP_MENU = `⚡ *Spark 24/7 Command Console*

Here are all active commands:

🤖 *Universal AI Assistant (Any Chat / Group / DM)*
• \`!ask <prompt>\` — General AI for any question, task, translation, code or writing!
• \`!ask spark <prompt>\` — Personalized AI loaded with **@gemini-spark-instructions** (MBBS curriculum, AP framework, Gita/Vedanta, clinical precision).
• Send any message directly into the **Gemini** group.

📊 *Polls & Reminders (Spark Group Only)*
• \`!poll gita\` — Dispatches Gita Attendance poll + @all tag
• \`!poll framework\` — Dispatches Framework Availability poll + @all tag
• \`!poll vidya\` — Dispatches Vidya–Avidya post-count poll + @all tag
• \`!remind gita\` — Scans sheet & tags ONLY members who haven't voted (➖)
• \`!remind vsc\` — Tags students who haven't updated their study log
• \`!mark <name> <p/a>\` — Manual attendance override (e.g. \`!mark Ankit p\`)

📖 *VSC Academics (Spark Group Only)*
• \`!template vsc\` — Dispatches blank 14-student study tracker for yesterday (D-1)

⚙️ *System Controls*
• \`#start\` / \`!help\` — Shows this directory
• \`!status\` — Health, uptime, and group bindings
• \`!stop\` / \`!resume\` — Emergency kill switch`;

async function startBot() {
  await restoreSessionFromDrive();
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) qrDataUrl = await qrcode.toDataURL(qr);
    if (connection === 'open') {
      isConnected = true;
      qrDataUrl = '';
      addLog('WhatsApp connected.');
      await saveSessionToDrive();

      try {
        const groups = await sock.groupFetchAllParticipating();
        for (const [id, meta] of Object.entries(groups)) {
          const s = (meta.subject || '').trim().toLowerCase();
          if (s === 'gemini') { geminiJid = id; addLog(`Found Gemini group: ${id}`); }
          if (s === 'chat') { chatGroupJid = id; addLog(`Found CHAT group to exclude: ${id}`); }
        }
      } catch (e) {}

      await sendToSpark(sock, `⚡ *Spark Console Active (24/7)*\n• Universal AI: \`!ask\` and \`!ask spark\` active everywhere\n• Excluded: "CHAT" group and (You) personal chat\nType \`#start\` for commands.`);
    }
    if (connection === 'close') {
      isConnected = false;
      const reconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      addLog(`Reconnecting: ${reconnect}`);
      if (reconnect) startBot();
    }
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    await saveSessionToDrive();
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      const msgId = msg.key.id;

      if (botSentIds.has(msgId)) {
        botSentIds.delete(msgId);
        continue;
      }

      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
      const fromJid = msg.key.remoteJid;

      if (!text) continue;

      // STRICT EXCLUSIONS: Ignore (You) personal chat & group named "CHAT"
      const myJid = sock.user?.id ? (sock.user.id.split(':')[0] + '@s.whatsapp.net') : null;
      const myLid = sock.user?.lid || null;
      if (fromJid === myJid || (myLid && fromJid === myLid)) continue;
      if (chatGroupJid && fromJid === chatGroupJid) continue;

      // On-the-fly check for group subject "chat" or "gemini"
      if (fromJid.endsWith('@g.us')) {
        try {
          const meta = await sock.groupMetadata(fromJid);
          const s = (meta.subject || '').trim().toLowerCase();
          if (s === 'chat') {
            chatGroupJid = fromJid;
            continue;
          }
          if (s === 'gemini') {
            geminiJid = fromJid;
          }
        } catch (e) {}
      }

      // 1. UNIVERSAL AI: "!ask spark <prompt>" (Loaded with @gemini-spark-instructions)
      if (text.toLowerCase().startsWith('!ask spark ')) {
        const prompt = text.slice(11).trim();
        if (prompt) {
          try {
            await sock.sendPresenceUpdate('composing', fromJid);
            const aiReply = await askGemini(prompt, SPARK_INSTRUCTIONS);
            const sent = await sock.sendMessage(fromJid, { text: aiReply }, { quoted: msg });
            botSentIds.add(sent.key.id);
            addLog(`Answered !ask spark in ${fromJid}`);
          } catch (e) {
            const errSent = await sock.sendMessage(fromJid, { text: `⚠️ AI Error: ${e.message}` }, { quoted: msg });
            botSentIds.add(errSent.key.id);
          }
        }
        continue;
      }

      // 2. UNIVERSAL AI: "!ask <prompt>" (General versatile assistant)
      if (text.startsWith('!ask ')) {
        const prompt = text.slice(5).trim();
        if (prompt) {
          try {
            await sock.sendPresenceUpdate('composing', fromJid);
            const aiReply = await askGemini(prompt, GENERAL_INSTRUCTIONS);
            const sent = await sock.sendMessage(fromJid, { text: aiReply }, { quoted: msg });
            botSentIds.add(sent.key.id);
            addLog(`Answered !ask in ${fromJid}`);
          } catch (e) {
            const errSent = await sock.sendMessage(fromJid, { text: `⚠️ AI Error: ${e.message}` }, { quoted: msg });
            botSentIds.add(errSent.key.id);
          }
        }
        continue;
      }

      // 3. Dedicated Gemini Group (Chat naturally without typing any prefix)
      if (geminiJid && fromJid === geminiJid) {
        try {
          await sock.sendPresenceUpdate('composing', geminiJid);
          const aiResponse = await askGemini(text, SPARK_INSTRUCTIONS);
          const sent = await sock.sendMessage(geminiJid, { text: aiResponse });
          botSentIds.add(sent.key.id);
          addLog(`Replied in Gemini group using @gemini-spark-instructions.`);
        } catch (err) {
          const errSent = await sock.sendMessage(geminiJid, { text: `⚠️ AI Error: ${err.message}` });
          botSentIds.add(errSent.key.id);
        }
        continue;
      }

      // STRICT ISOLATION FOR ADMIN COMMANDS: Only accepted in Spark console
      if (fromJid !== SPARK_JID) continue;

      // #start & Command Directory
      if (text.toLowerCase() === '#start' || text.toLowerCase() === '!start' || text.toLowerCase() === '!help' || text.toLowerCase() === '!menu') {
        await sendToSpark(sock, HELP_MENU);
        continue;
      }

      // Emergency Controls
      if (text === '!stop') { isStopped = true; await sendToSpark(sock, '🛑 *Bot Stopped.* Automation paused.'); continue; }
      if (text === '!resume') { isStopped = false; await sendToSpark(sock, '▶️ *Bot Resumed.* Normal operations active.'); continue; }
      if (isStopped) continue;

      // Status Check
      if (text === '!status') {
        await sendToSpark(sock, `✅ *Status: Active 24/7*\n• Gita Community: Bound\n• VSC Academics: Bound\n• Vidya-Avidya: Bound\n• Gemini AI Group: ${geminiJid ? 'Bound (@gemini-spark-instructions)' : 'Ready'}\n• Universal AI: Enabled globally (\`!ask\` and \`!ask spark\`)\n• Excluded: "CHAT" group and (You) personal chat\n• Google Drive Session: Synced`);
        continue;
      }

      // 1. Gita Attendance Poll + @all tag
      if (text === '!poll gita') {
        const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' });
        await sock.sendMessage(GITA_JID, {
          poll: { name: `Gita Community Attendance — ${today}`, values: ['Present ✅', 'Absent ❌'], selectableCount: 1 }
        });
        await sendTagAll(sock, GITA_JID, '@all Please mark your attendance for today\'s session 🙏');
        await sendToSpark(sock, `📊 *Gita Attendance Poll & @all tag dispatched* for ${today}.`);
        continue;
      }

      // 2. Tag ONLY Unvoted Members in Gita Community
      if (text === '!remind gita') {
        try {
          const rows = await readSheet(GITA_SHEET_ID, 'Attendance Register!F45:BC45');
          const todayRow = rows[0] || [];
          const unvoted = [];
          Object.entries(GITA_MEMBERS).forEach(([name], idx) => {
            const val = (todayRow[idx] || '').trim();
            if (val === '➖' || val === '') unvoted.push(name.charAt(0).toUpperCase() + name.slice(1));
          });

          if (unvoted.length === 0) {
            await sendToSpark(sock, '🎉 Everyone has already voted for today!');
          } else {
            const reminderText = `@all Unvoted Members:\n${unvoted.join(', ')}\n\nPlease mark your attendance for today's session 🙏`;
            await sock.sendMessage(GITA_JID, { text: reminderText });
            await sendToSpark(sock, `🔔 *Tagged ${unvoted.length} Unvoted Members in Gita Community*:\n${unvoted.join(', ')}`);
          }
        } catch (e) { await sendToSpark(sock, `❌ Error reminding Gita: ${e.message}`); }
        continue;
      }

      // 3. Framework Availability Poll + @all tag
      if (text === '!poll framework') {
        const titles = [
          'फ्रेमवर्क पर चर्चा करने के लिए आपकी उपलब्धता?',
          'आज Framework discussion के लिए your availability?',
          'Framework Session: आपकी उपलब्धता (Available slots)?'
        ];
        const randomTitle = titles[Math.floor(Math.random() * titles.length)];
        await sock.sendMessage(GITA_JID, {
          poll: {
            name: randomTitle,
            values: ['4-5 pm', '5-6 pm', '6-7 pm', '7-8 pm', '8-9 pm', '9-10 pm', '10-11 pm', '11-12 pm', 'Not available'],
            selectableCount: 0
          }
        });
        await sendTagAll(sock, GITA_JID, '@all Please select your available time slots for the framework session 🙏');
        await sendToSpark(sock, `🎯 *Framework Availability Poll & @all tag dispatched*:\n"${randomTitle}"`);
        continue;
      }

      // 4. Vidya-Avidya Daily Share Poll + @all tag
      if (text === '!poll vidya') {
        const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' });
        const titles = [
          `Today's share: Vidya–Avidya posts from the community (${today})`,
          `आज समुदाय में विद्या–अविद्या posts का आपका योगदान? (${today})`,
          `Community Share: Vidya–Avidya daily post count (${today})`
        ];
        const randomTitle = titles[Math.floor(Math.random() * titles.length)];
        await sock.sendMessage(VIDYA_JID, {
          poll: { name: randomTitle, values: ['0', '1', '2', '3', '3+'], selectableCount: 1 }
        });
        await sendTagAll(sock, VIDYA_JID, '@all Please respond with your post count for today 🙏');
        await sendToSpark(sock, `🌱 *Vidya-Avidya Poll & @all tag dispatched*:\n"${randomTitle}"`);
        continue;
      }

      // 5. VSC Academics Blank Study Tracker Dispatch (D-1)
      if (text === '!template vsc') {
        const dMinusOne = new Date(Date.now() - 86400000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        const rosterLines = VSC_STUDENTS.map((s, i) => `${i + 1}. ${s} - `).join('\n');
        const template = `@all\n*${dMinusOne} — Study Tracker* 📚\n\n${rosterLines}`;
        await sendTagAll(sock, VSC_JID, template);
        await sendToSpark(sock, `📖 *VSC Daily Study Tracker Dispatched* to VSC Academics for ${dMinusOne}.`);
        continue;
      }

      // 6. Tag Pending Students in VSC Academics
      if (text === '!remind vsc') {
        const reminderText = `@all Pending Students: Please update what you studied yesterday 🙏`;
        await sendTagAll(sock, VSC_JID, reminderText);
        await sendToSpark(sock, `🔔 *Sent Study Reminder Tag to VSC Academics*`);
        continue;
      }

      // 7. Manual Mark for Gita (e.g., "!mark Dipesh present")
      const markMatch = text.match(/!mark\s+([a-zA-Z]+)\s+(present|absent|p|a)/i);
      if (markMatch) {
        const name = markMatch[1].toLowerCase();
        const symbol = (markMatch[2].toLowerCase() === 'present' || markMatch[2].toLowerCase() === 'p') ? '✅' : '❌';
        const col = GITA_MEMBERS[name];
        if (!col) { await sendToSpark(sock, `⚠️ Member *${markMatch[1]}* not found in 50-member roster.`); continue; }

        const cell = `Attendance Register!${col}45`;
        try {
          await updateSheet(GITA_SHEET_ID, cell, symbol);
          await sendToSpark(sock, `✅ Marked *${markMatch[1]}* as ${symbol} at \`${cell}\`.`);
        } catch (err) { await sendToSpark(sock, `❌ Error updating sheet: ${err.message}`); }
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
        <p>Universal AI: <b>✅ \`!ask\` and \`!ask spark\` active everywhere</b></p>
        <p>Exclusions: <b>Strictly ignores "CHAT" group and (You) personal chat</b></p>
        <p>Session Storage: <b>☁️ Google Drive Auto-Persist Active</b></p>
        ${qrDataUrl ? `<img src="${qrDataUrl}" width="200"/>` : ''}
        <h3>Recent Logs:</h3>
        <ul>${logs.map(l => `<li>${l}</li>`).join('')}</ul>
      </div>
    </body></html>
  `);
});

app.listen(PORT, () => addLog(`Web dashboard on port ${PORT}`));
