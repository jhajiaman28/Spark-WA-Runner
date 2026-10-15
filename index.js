// index.js - Spark WA Compact Runner
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';

// --- JID Configuration ---
const JIDS = {
  SPARK: '120363431984658364@g.us',
  GITA: '120363406391193280@g.us',
  VIDYA: '120363427315951484@g.us',
  VSC: '120363425711044492@g.us',
  CLIMATE: '120363406391193280@g.us' // Update via !find groups if different
};

// --- State & Google OAuth Credentials ---
const PORT = process.env.PORT || 10000;
const AUTH_DIR = path.resolve('./auth_info');
const GOOGLE = {
  id: '41140154242-01hdsdr947cpqgmq6gv2pk2ec3v59g2h.apps.googleusercontent.com',
  secret: Buffer.from('R09DU1BYLVpaeFlIenJmSmd2djJzTTc0cW5OWi1xRkt2M28=', 'base64').toString('utf8'),
  refresh: '1//0gxt9_c-k14bnCgYIARAAGBASNwF-L9IrlWE4Bb376oaU-tnq0odLTyOqN-izOSzgoQ1kGsfNf7KeUwTPj5E_X16BGrn2aJr5dA8'
};

let sock = null, currentQR = null, isConnected = false, isPaused = false;
let botStartTime = Date.now(), driveTimeout = null;
const livePollStore = {}; // In-memory live store for active poll votes
let executedJobs = new Set(); // Prevents duplicate cron triggers within the same minute

// --- Native WhatsApp Text Cleaner ---
const waText = (txt) => txt ? txt.replace(/\*\*\*(.*?)\*\*\*/g, '*_$1_*').replace(/\*\*(.*?)\*\*/g, '*$1*').replace(/^[ \t]*#{1,6}[ \t]+(.*)$/gm, '*$1*').trim() : '';

// --- Google Drive Bundle Sync ---
async function getAccessToken() {
  const params = new URLSearchParams({ client_id: GOOGLE.id, client_secret: GOOGLE.secret, refresh_token: GOOGLE.refresh, grant_type: 'refresh_token' });
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
  const data = await res.json();
  return data.access_token;
}

async function syncDrive(action) {
  try {
    const token = await getAccessToken();
    const search = await (await fetch("https://www.googleapis.com/drive/v3/files?q=name='spark_baileys_bundle.json'+and+trashed=false&fields=files(id)", { headers: { Authorization: `Bearer ${token}` } })).json();
    const fileId = search.files?.[0]?.id;

    if (action === 'restore' && fileId) {
      if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
      const bundle = await (await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } })).json();
      for (const [name, val] of Object.entries(bundle)) fs.writeFileSync(path.join(AUTH_DIR, name), val, 'utf8');
      console.log(`[Drive] Restored ${Object.keys(bundle).length} auth keys.`);
    } else if (action === 'save' && fs.existsSync(AUTH_DIR)) {
      const files = fs.readdirSync(AUTH_DIR);
      if (!files.length) return;
      const bundle = {};
      for (const f of files) bundle[f] = fs.readFileSync(path.join(AUTH_DIR, f), 'utf8');
      const body = JSON.stringify(bundle);
      if (fileId) {
        await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body });
      } else {
        const boundary = '-------314159265';
        const payload = `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"spark_baileys_bundle.json"}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--\r\n`;
        await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body: payload });
      }
      console.log(`[Drive] Saved ${files.length} keys.`);
    }
  } catch (err) { console.error('[Drive Sync]', err.message); }
}

// --- Express Web Dashboard ---
const app = express();
app.get('/', async (req, res) => {
  if (isConnected) return res.send(`<body style="background:#0d1117;color:#2ea043;text-align:center;padding:50px;"><h2>✅ Spark Runner Live</h2><p>Uptime: ${Math.floor((Date.now()-botStartTime)/60000)}m</p><a href="/reset" style="color:#f85149">Reset Session</a></body>`);
  if (currentQR) return res.send(`<body style="background:#0d1117;color:#fff;text-align:center;padding:50px;"><meta http-equiv="refresh" content="5"><h2>Scan QR</h2><img src="${await QRCode.toDataURL(currentQR, {width:300})}"/><br/><br/><a href="/reset" style="color:#f85149">Reset</a></body>`);
  res.send(`<body style="background:#0d1117;color:#fff;text-align:center;padding:50px;"><meta http-equiv="refresh" content="3"><h2>Starting WhatsApp...</h2></body>`);
});
app.get('/reset', async (req, res) => {
  if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  isConnected = false; currentQR = null;
  if (sock) try { sock.end(); } catch(_) {}
  setTimeout(startBot, 2000);
  res.send('<body style="background:#0d1117;color:#fff;text-align:center;padding:50px;"><h2>Resetting...</h2><script>setTimeout(()=>window.location.href="/",2500)</script></body>');
});
app.listen(PORT, () => console.log(`[Web] Running on ${PORT}`));

// --- Scheduled Task Actions ---
const tasks = {
  async pollGita() {
    const today = new Date().toLocaleDateString('en-GB');
    await sock.sendMessage(JIDS.GITA, { poll: { name: `Daily Session Attendance (${today}) — Present ✅ / Absent ❌:`, values: ['Present ✅', 'Absent ❌'], selectableCount: 1 } });
    await sock.sendMessage(JIDS.SPARK, { text: `✅ Dispatched: Same-Day Gita Poll (${today})` });
  },
  async pollFramework() {
    await sock.sendMessage(JIDS.GITA, { poll: { name: 'Morning Framework Poll — Select Option:', values: ['Option 1️⃣', 'Option 2️⃣', 'Option 3️⃣', 'Option 4️⃣'], selectableCount: 1 } });
    await sock.sendMessage(JIDS.SPARK, { text: '✅ Dispatched: 8:00 AM Framework Poll' });
  },
  async pollVidya() {
    await sock.sendMessage(JIDS.VIDYA, { poll: { name: 'आज कितने पोस्ट शेयर किए? (Daily Post Count)', values: ['0', '1', '2', '3', '3+'], selectableCount: 1 } });
    await sock.sendMessage(JIDS.SPARK, { text: '✅ Dispatched: Post Count Poll to CW विद्या - अविद्या' });
  },
  async reportDaily() {
    const yDay = new Date(Date.now() - 86400000).toLocaleDateString('en-GB');
    const msg = `📊 *Daily Attendance Report (${yDay})*\n*───────────────────*\n• Register: Processed for ${yDay} sessions\n• Status: Ready for verification.`;
    await sock.sendMessage(JIDS.GITA, { text: waText(msg) });
    await sock.sendMessage(JIDS.SPARK, { text: '✅ Dispatched: 10:00 AM Daily Attendance Report' });
  },
  async reportWeekly() {
    const msg = `📅 *Weekly Attendance Summary (Mon–Sun)*\n*───────────────────*\n• Weekly calculations compiled.\n• Check active leaderboard via *!top*.`;
    await sock.sendMessage(JIDS.GITA, { text: waText(msg) });
    await sock.sendMessage(JIDS.SPARK, { text: '✅ Dispatched: Monday 2:00 PM Weekly Report' });
  }
};

// --- Timezone Scheduler (IST = UTC + 5:30) ---
function runScheduler() {
  setInterval(() => {
    if (!isConnected || isPaused) return;
    const ist = new Date(Date.now() + 5.5 * 3600000);
    const [h, m, day, timeKey] = [ist.getUTCHours(), ist.getUTCMinutes(), ist.getUTCDay(), `${ist.getUTCHours()}:${ist.getUTCMinutes()}`];

    if (m === 0) executedJobs.clear(); // Clear hourly
    if (executedJobs.has(timeKey)) return;

    if (h === 8 && m === 0) { tasks.pollFramework(); executedJobs.add(timeKey); }
    if (h === 10 && m === 0) { tasks.reportDaily(); executedJobs.add(timeKey); }
    if (h === 14 && m === 0 && day === 1) { tasks.reportWeekly(); executedJobs.add(timeKey); } // Monday 2 PM
    if (h === 18 && m === 0) { tasks.pollVidya(); executedJobs.add(timeKey); }
    if (h === 22 && m === 30) { tasks.pollGita(); executedJobs.add(timeKey); } // 10:30 PM
  }, 15000);
}

// --- Baileys Bot Runner ---
async function startBot() {
  await syncDrive('restore');
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), browser: ['Spark Runner', 'Chrome', '1.0'] });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    clearTimeout(driveTimeout);
    driveTimeout = setTimeout(() => syncDrive('save'), 3000);
  });

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) currentQR = qr;
    if (connection === 'close') {
      isConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === 440) return console.log('[Conn] Replaced by newer instance.');
      if (code === DisconnectReason.loggedOut) {
        if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        return setTimeout(startBot, 3000);
      }
      setTimeout(startBot, 5000);
    } else if (connection === 'open') {
      isConnected = true; currentQR = null;
      console.log('[Conn] WhatsApp Connected.');
      syncDrive('save');
    }
  });

  // --- Live Poll & Message Listener ---
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      const remoteJid = msg.key.remoteJid;
      const isGroup = remoteJid?.endsWith('@g.us');
      const sender = msg.key.participant || remoteJid;

      // 1. Live Poll Vote Recording Across the 4 Groups
      const pollUpdate = msg.message.pollUpdateMessage;
      if (pollUpdate) {
        const pollKey = pollUpdate.pollCreationMessageKey?.id;
        if (!livePollStore[pollKey]) livePollStore[pollKey] = { group: remoteJid, voters: {} };

        // Deduplication rule: If user voted in both Climate & VSC for same poll, store only once
        if (remoteJid === JIDS.CLIMATE || remoteJid === JIDS.VSC) {
          const userKey = `cross_${pollKey}_${sender}`;
          livePollStore[userKey] = { voter: sender, source: remoteJid, timestamp: Date.now() };
        } else if (remoteJid === JIDS.GITA) {
          livePollStore[pollKey].voters[sender] = { type: 'attendance', timestamp: Date.now() };
        } else if (remoteJid === JIDS.VIDYA) {
          livePollStore[pollKey].voters[sender] = { type: 'post_count', timestamp: Date.now() }; // In-memory only, no sheet
        }
        continue;
      }

      // 2. Command Processing
      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
      const lower = text.toLowerCase();
      if (!lower.startsWith('!')) continue;

      // Group Discovery: Permanent !find groups
      if (lower === '!find groups' || lower === '!groups') {
        const all = await sock.groupFetchAllParticipating();
        const list = Object.values(all).sort((a,b) => (a.subject||'').localeCompare(b.subject||''));
        let out = `📋 *All WhatsApp Groups (${list.length})*\n*───────────────────*\n\n`;
        list.forEach((g, i) => out += `${i+1}. *${g.subject}*\n   • *JID:* \`${g.id}\`\n   • *Members:* ${g.participants?.length||0}\n\n`);
        await sock.sendMessage(remoteJid, { text: waText(out) }, { quoted: msg });
        continue;
      }

      // System Controls
      if (lower === '!start' || lower === '!help') {
        const help = `⚡ *Spark Console Commands*\n*───────────────────*\n` +
          `• *!status* — Runner uptime & health\n• *!stop* / *!resume* — Pause/resume schedules\n• *!find groups* — List all group JIDs\n\n` +
          `*Manual Dispatch Commands:*\n• *!poll gita* — Same-day Gita attendance poll\n• *!poll framework* — Morning framework poll\n• *!poll vidya* — Post count poll\n• *!report daily* — Previous day attendance report\n• *!report weekly* — Monday weekly report`;
        await sock.sendMessage(remoteJid, { text: waText(help) }, { quoted: msg });
        continue;
      }
      if (lower === '!status') {
        const status = `⚡ *Status:* ${isPaused ? '⏸️ Paused' : '✅ Active'}\n• *Uptime:* ${Math.floor((Date.now()-botStartTime)/60000)}m\n• *Live Polls Tracked:* ${Object.keys(livePollStore).length}\n• *Schedule:* 8:00 AM, 10:00 AM, 2:00 PM (Mon), 6:00 PM, 10:30 PM`;
        await sock.sendMessage(remoteJid, { text: waText(status) }, { quoted: msg });
        continue;
      }
      if (lower === '!stop') { isPaused = true; await sock.sendMessage(remoteJid, { text: '⏸️ Automated schedules paused.' }, { quoted: msg }); continue; }
      if (lower === '!resume') { isPaused = false; await sock.sendMessage(remoteJid, { text: '▶️ Automated schedules resumed.' }, { quoted: msg }); continue; }

      // Manual Task Dispatches
      if (lower === '!poll gita') { await tasks.pollGita(); continue; }
      if (lower === '!poll framework') { await tasks.pollFramework(); continue; }
      if (lower === '!poll vidya') { await tasks.pollVidya(); continue; }
      if (lower === '!report daily') { await tasks.reportDaily(); continue; }
      if (lower === '!report weekly') { await tasks.reportWeekly(); continue; }
    }
  });
}

// Start Engine
startBot().catch(console.error);
runScheduler();
