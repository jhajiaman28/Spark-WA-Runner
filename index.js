import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import express from 'express';
import qrcode from 'qrcode';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 10000;

// Google OAuth Credentials
const CLIENT_ID = Buffer.from('NDExNDAxNTQyNDItMDFoZHNkcjk0N2NwcWdtcTZndjJwazJlYzN2NTlnMmguYXBwcy5nb29nbGV1c2VyY29udGVudC5jb20=', 'base64').toString('utf-8');
const CLIENT_SECRET = Buffer.from('R09DU1BYLVpaeFlIenJmSmd2djJzTTc0cW5OWi1xRkt2M28=', 'base64').toString('utf-8');
const REFRESH_TOKEN = Buffer.from('MS8vMGd4dDlfYy1rMTRibkNnWUlBUkFBR0JBU053Ri1MOUlybFdFNEJiMzc2b2FVLXRucTBvZExUeU9xTi1pek9TemdvUTFrR3NmTmY3S2VVd1RQajVFX1gxNkJHcm4yYUpyNWRBOA==', 'base64').toString('utf-8');

const GITA_SHEET_ID = '1rgF4V1wIZF_kJvbbmjgiDTOXPQckFvDmMzLN80dILuw';

// Verified Group IDs
const SPARK_JID = '120363431984658364@g.us';
const GITA_JID = '120363406391193280@g.us';
let vscJid = null;
let vidyaJid = null;

let qrDataUrl = '';
let isConnected = false;
let isStopped = false;
let logs = [];

function addLog(msg) {
  const time = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  logs.unshift(`[${time}]${msg}`);
  if (logs.length > 50) logs.pop();
  console.log(`[${time}]${msg}`);
}

async function sendToSpark(sock, text) {
  try {
    await sock.sendMessage(SPARK_JID, { text });
  } catch (err) {
    addLog(`Error sending to Spark: ${err.message}`);
  }
}

// Tag @all helper with mention highlight
async function sendTagAll(sock, groupId, text) {
  try {
    const meta = await sock.groupMetadata(groupId);
    await sock.sendMessage(groupId, {
      text,
      mentions: meta.participants.map(p => p.id)
    });
  } catch {
    await sock.sendMessage(groupId, { text });
  }
}

// 50 Member Column Mapping for CW Gita (F to BC)
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

// 14 Students for VSC Academics
const VSC_STUDENTS = [
  'Rohan', 'Swapnil', 'Anurag', 'Pooja', 'Saksham',
  'Himanshu', 'Raghuvansh', 'Amit', 'Aman', 'Anisha',
  'Sahiba', 'Dipesh', 'Muskan', 'Sarita'
];

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

function updateSheet(range, value) {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getAccessToken();
      const body = JSON.stringify({ values: [[value]] });
      const req = https.request({
        hostname: 'sheets.googleapis.com',
        path: `/v4/spreadsheets/${GITA_SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
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

const HELP_MENU = `⚡ *Spark 24/7 Command Console*

Here are all active commands you can run anytime in this group:

📊 *Polls & Attendance*
• \`!poll gita\` — Dispatches Gita Attendance poll + @all tag to community
• \`!poll framework\` — Dispatches Framework Availability poll + @all tag
• \`!poll vidya\` — Dispatches Vidya–Avidya post-count poll + @all tag
• \`!mark <name> <p/a>\` — Updates live Google Sheet directly (e.g., \`!mark Ankit p\`)

📖 *VSC Academics*
• \`!template vsc\` — Dispatches blank 14-student study tracker for yesterday (D-1)

⚙️ *System & Safety Controls*
• \`#start\` / \`!help\` — Restarts chat console & shows this command directory
• \`!status\` — Checks runner health, uptime, and group bindings
• \`!find groups\` — Lists all participating WhatsApp groups and their IDs
• \`!stop\` — Emergency stop (pauses all bot activity)
• \`!resume\` — Resumes all bot activity`;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) qrDataUrl = await qrcode.toDataURL(qr);
    if (connection === 'open') {
      isConnected = true;
      qrDataUrl = '';
      addLog('WhatsApp connected.');

      // Auto-discover VSC and Vidya-Avidya groups
      try {
        const groups = await sock.groupFetchAllParticipating();
        for (const [id, meta] of Object.entries(groups)) {
          const name = (meta.subject || '').trim().toLowerCase();
          if (name.includes('vsc academics')) { vscJid = id; addLog(`Found VSC Academics: ${id}`); }
          if (name.includes('विद्या-अविद्या') || name.includes('vidya')) { vidyaJid = id; addLog(`Found Vidya-Avidya: ${id}`); }
        }
      } catch (e) { addLog(`Group scan error: ${e.message}`); }

      await sendToSpark(sock, `⚡ *Spark Console Active (24/7)*\nType \`#start\` or \`!help\` anytime to see all commands.`);
    }
    if (connection === 'close') {
      isConnected = false;
      const reconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      addLog(`Reconnecting: ${reconnect}`);
      if (reconnect) startBot();
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Group Participant Join/Leave Monitor (CW Gita)
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    if (id !== GITA_JID) return;
    for (const p of participants) {
      const num = p.split('@')[0];
      if (action === 'add') {
        await sendToSpark(sock, `👤 *New Member Added*: +${num} joined Gita Community.\nConfirm their name to assign their sheet column.`);
      } else if (action === 'remove') {
        await sendToSpark(sock, `⚠️ *Member Left/Removed*: +${num} left Gita Community.\nShould their column be removed from the sheet? (Reply to confirm or ignore to keep).`);
      }
    }
  });

  // Message & Command Handler
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
      const fromJid = msg.key.remoteJid;

      if (!text) continue;

      // STRICT PRIVACY: Ignore everything outside Spark console
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
        await sendToSpark(sock, `✅ *Status: Active 24/7*\n• Gita Community: Bound (50 members)\n• VSC Academics: ${vscJid ? 'Bound' : 'Searching...'}\n• Vidya-Avidya: ${vidyaJid ? 'Bound' : 'Searching...'}`);
        continue;
      }

      // Group Discovery
      if (text === '!find groups' || text === '!groups') {
        try {
          const groups = await sock.groupFetchAllParticipating();
          const list = Object.entries(groups).map(([id, g], i) => `${i + 1}. *${g.subject}*\n   ID: \`${id}\``).join('\n\n');
          await sendToSpark(sock, `📋 *Connected Groups (${Object.keys(groups).length}):*\n\n${list}`);
        } catch (e) { await sendToSpark(sock, `❌ Error: ${e.message}`); }
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

      // 2. Framework Availability Poll + @all tag
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
            selectableCount: 0 // Multi-select
          }
        });
        await sendTagAll(sock, GITA_JID, '@all Please select your available time slots for the framework session 🙏');
        await sendToSpark(sock, `🎯 *Framework Availability Poll & @all tag dispatched*:\n"${randomTitle}"`);
        continue;
      }

      // 3. Vidya-Avidya Daily Share Poll + @all tag
      if (text === '!poll vidya') {
        if (!vidyaJid) { await sendToSpark(sock, '⚠️ Group CW विद्या-अविद्या not found yet. Run `!find groups`.'); continue; }
        const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' });
        const titles = [
          `Today's share: Vidya–Avidya posts from the community (${today})`,
          `आज समुदाय में विद्या–अविद्या posts का आपका योगदान? (${today})`,
          `Community Share: Vidya–Avidya daily post count (${today})`
        ];
        const randomTitle = titles[Math.floor(Math.random() * titles.length)];
        await sock.sendMessage(vidyaJid, {
          poll: { name: randomTitle, values: ['0', '1', '2', '3', '3+'], selectableCount: 1 }
        });
        await sendTagAll(sock, vidyaJid, '@all Please respond with your post count for today 🙏');
        await sendToSpark(sock, `🌱 *Vidya-Avidya Poll & @all tag dispatched*:\n"${randomTitle}"`);
        continue;
      }

      // 4. VSC Academics Blank Study Tracker Dispatch (D-1)
      if (text === '!template vsc') {
        if (!vscJid) { await sendToSpark(sock, '⚠️ Group VSC Academics not found yet. Run `!find groups`.'); continue; }
        const dMinusOne = new Date(Date.now() - 86400000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        const rosterLines = VSC_STUDENTS.map((s, i) => `${i + 1}. ${s} - `).join('\n');
        const template = `@all\n*${dMinusOne} — Study Tracker* 📚\n\n${rosterLines}`;
        await sendTagAll(sock, vscJid, template);
        await sendToSpark(sock, `📖 *VSC Daily Study Tracker Dispatched* to VSC Academics for ${dMinusOne}.`);
        continue;
      }

      // 5. Manual Mark for Gita (e.g., "!mark Dipesh present")
      const markMatch = text.match(/!mark\s+([a-zA-Z]+)\s+(present|absent|p|a)/i);
      if (markMatch) {
        const name = markMatch[1].toLowerCase();
        const symbol = (markMatch[2].toLowerCase() === 'present' || markMatch[2].toLowerCase() === 'p') ? '✅' : '❌';
        const col = GITA_MEMBERS[name];
        if (!col) { await sendToSpark(sock, `⚠️ Member *${markMatch[1]}* not found in 50-member roster.`); continue; }

        const cell = `Attendance Register!${col}45`;
        try {
          await updateSheet(cell, symbol);
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
        <p>Gita Community: <b>✅ Bound (50 Members)</b></p>
        <p>VSC Academics: <b>${vscJid ? '✅ Bound (14 Students)' : '⏳ Discovering...'}</b></p>
        <p>Vidya-Avidya: <b>${vidyaJid ? '✅ Bound' : '⏳ Discovering...'}</b></p>
        ${qrDataUrl ? `<img src="${qrDataUrl}" width="200"/>` : ''}
        <h3>Recent Logs:</h3>
        <ul>${logs.map(l => `<li>${l}</li>`).join('')}</ul>
      </div>
    </body></html>
  `);
});

app.listen(PORT, () => addLog(`Web dashboard on port ${PORT}`));
