// index.js - Spark Group Roster & Sheet Sync Engine
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';

// --- Configuration ---
const PORT = process.env.PORT || 10000;
const AUTH_DIR = path.resolve('./auth_info');
const MAPPINGS_FILE = path.resolve('./group_mappings.json');
const SPARK_CONSOLE_JID = '120363431984658364@g.us';
const DEFAULT_SHEET_ID = '1rgF4V1wIZF_kJvbbmjgiDTOXPQckFvDmMzLN80dILuw';

// Embedded Google OAuth Credentials
const GOOGLE = {
  id: '41140154242-01hdsdr947cpqgmq6gv2pk2ec3v59g2h.apps.googleusercontent.com',
  secret: Buffer.from('R09DU1BYLVpaeFlIenJmSmd2djJzTTc0cW5OWi1xRkt2M28=', 'base64').toString('utf8'),
  refresh: '1//0gxt9_c-k14bnCgYIARAAGBASNwF-L9IrlWE4Bb376oaU-tnq0odLTyOqN-izOSzgoQ1kGsfNf7KeUwTPj5E_X16BGrn2aJr5dA8'
};

let sock = null, currentQR = null, isConnected = false, isPaused = false;
let botStartTime = Date.now(), driveTimeout = null;

// Persistent Group-to-Sheet Mappings: { "groupJid": { "sheetId": "...", "tab": "...", "notify": false } }
let groupMappings = fs.existsSync(MAPPINGS_FILE) ? JSON.parse(fs.readFileSync(MAPPINGS_FILE, 'utf8')) : {};
const saveMappings = () => fs.writeFileSync(MAPPINGS_FILE, JSON.stringify(groupMappings, null, 2));

// --- Google Drive Session Sync & Sheets API ---
async function getAccessToken() {
  const params = new URLSearchParams({ client_id: GOOGLE.id, client_secret: GOOGLE.secret, refresh_token: GOOGLE.refresh, grant_type: 'refresh_token' });
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
  return (await res.json()).access_token;
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
      console.log(`[Drive] Restored ${Object.keys(bundle).length} session keys.`);
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

async function sheetsAppendRow(sheetId, tabName, values) {
  const token = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/'${encodeURIComponent(tabName)}'!A:E:append?valueInputOption=USER_ENTERED`;
  await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [values] })
  });
}

async function sheetsUpdateMemberStatus(sheetId, tabName, phone, statusText) {
  const token = await getAccessToken();
  const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/'${encodeURIComponent(tabName)}'!A:E`;
  const res = await (await fetch(getUrl, { headers: { Authorization: `Bearer ${token}` } })).json();
  const rows = res.values || [];

  for (let i = 1; i < rows.length; i++) {
    if (rows[i] && rows[i][1] && String(rows[i][1]).includes(phone)) {
      const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/'${encodeURIComponent(tabName)}'!D${i + 1}?valueInputOption=USER_ENTERED`;
      await fetch(updateUrl, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[statusText]] })
      });
      break;
    }
  }
}

// --- Express Dashboard ---
const app = express();
app.get('/', async (req, res) => {
  if (isConnected) return res.send(`<body style="background:#0d1117;color:#2ea043;text-align:center;padding:50px;"><h2>✅ Spark Roster Tracker Live</h2><p>Tracked Groups: ${Object.keys(groupMappings).length} (Default: Silent)</p><a href="/reset" style="color:#f85149">Reset Auth</a></body>`);
  if (currentQR) return res.send(`<body style="background:#0d1117;color:#fff;text-align:center;padding:50px;"><meta http-equiv="refresh" content="5"><h2>Scan QR</h2><img src="${await QRCode.toDataURL(currentQR, {width:300})}"/><br/><br/><a href="/reset" style="color:#f85149">Reset</a></body>`);
  res.send('<body style="background:#0d1117;color:#fff;text-align:center;padding:50px;"><meta http-equiv="refresh" content="3"><h2>Starting WhatsApp...</h2></body>');
});
app.get('/reset', async (req, res) => {
  if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  isConnected = false; currentQR = null;
  if (sock) try { sock.end(); } catch(_) {}
  setTimeout(startBot, 2000);
  res.send('<body style="background:#0d1117;color:#fff;text-align:center;padding:50px;"><h2>Resetting...</h2><script>setTimeout(()=>window.location.href="/",2500)</script></body>');
});
app.listen(PORT, () => console.log(`[Web] Running on ${PORT}`));

// --- Baileys Runner ---
async function startBot() {
  await syncDrive('restore');
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), browser: ['Spark Roster', 'Chrome', '1.0'] });

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

  // --- 1. Real-Time Join/Leave Listener (Default: 100% Silent) ---
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    if (isPaused || !groupMappings[id]) return;
    const { sheetId, tab, notify } = groupMappings[id];
    const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' });

    for (const jid of participants) {
      const phone = jid.split('@')[0];
      if (action === 'add') {
        const name = (await sock.onWhatsApp(jid))?.[0]?.pushName || 'New Member';
        await sheetsAppendRow(sheetId, tab, [name, phone, now, 'Active']);
        // Only sends alert if explicitly set to ON for this group
        if (notify === true) {
          await sock.sendMessage(SPARK_CONSOLE_JID, { text: `➕ *Member Added*\n• Group: \`${id}\`\n• Tab: *${tab}*\n• Name: *${name}* (${phone})` });
        }
      } else if (action === 'remove') {
        await sheetsUpdateMemberStatus(sheetId, tab, phone, `Left (${now})`);
        // Only sends alert if explicitly set to ON for this group
        if (notify === true) {
          await sock.sendMessage(SPARK_CONSOLE_JID, { text: `➖ *Member Left/Removed*\n• Group: \`${id}\`\n• Tab: *${tab}*\n• Phone: *${phone}*` });
        }
      }
    }
  });

  // --- 2. Interactive Command Controller ---
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      const remoteJid = msg.key.remoteJid;
      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
      if (!text.startsWith('!')) continue;

      const args = text.split(/\s+/);
      const cmd = args[0].toLowerCase();

      // !find groups — Lists all groups with JIDs
      if (cmd === '!find' && args[1]?.toLowerCase() === 'groups' || cmd === '!groups') {
        const groups = await sock.groupFetchAllParticipating();
        let reply = `📋 *All WhatsApp Groups (${Object.keys(groups).length})*\n*───────────────────*\n\n`;
        Object.values(groups).forEach((g, i) => {
          reply += `${i + 1}. *${g.subject}*\n   • *JID:* \`${g.id}\`\n   • *Members:* ${g.participants?.length || 0}\n\n`;
        });
        await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
        continue;
      }

      // !map <group_jid> <tab_name> [sheet_id] (Default: notify=false)
      if (cmd === '!map') {
        const groupJid = args[1];
        const tab = args[2];
        const sheetId = args[3] || DEFAULT_SHEET_ID;

        if (!groupJid || !tab) {
          await sock.sendMessage(remoteJid, { text: '⚠️ *Usage:* `!map <group_jid> <tab_name> [sheet_id]`' }, { quoted: msg });
          continue;
        }

        groupMappings[groupJid] = { sheetId, tab, notify: false };
        saveMappings();
        await sock.sendMessage(remoteJid, { text: `✅ *Mapped Successfully!*\n• Group: \`${groupJid}\`\n• Tab: *${tab}*\n• Sheet ID: \`${sheetId}\`\n• Alerts: *OFF (Silent)*` }, { quoted: msg });
        continue;
      }

      // !notify <group_jid> on/off — Toggles alert for any specific group
      if (cmd === '!notify') {
        const groupJid = args[1];
        const state = args[2]?.toLowerCase();

        if (!groupJid || !groupMappings[groupJid] || !['on', 'off'].includes(state)) {
          await sock.sendMessage(remoteJid, { text: '⚠️ *Usage:* `!notify <group_jid> on` or `!notify <group_jid> off`' }, { quoted: msg });
          continue;
        }

        groupMappings[groupJid].notify = (state === 'on');
        saveMappings();
        await sock.sendMessage(remoteJid, { text: `🔔 *Notification Updated!*\n• Group: \`${groupJid}\`\n• Alerts: *${state === 'on' ? 'ON' : 'OFF (Silent)'}*` }, { quoted: msg });
        continue;
      }

      // !sync <group_jid> — Dumps current members into mapped sheet
      if (cmd === '!sync') {
        const groupJid = args[1];
        if (!groupJid || !groupMappings[groupJid]) {
          await sock.sendMessage(remoteJid, { text: `⚠️ Group not mapped. Use \`!map ${groupJid || '<group_jid>'} <tab_name>\` first.` }, { quoted: msg });
          continue;
        }

        const { sheetId, tab } = groupMappings[groupJid];
        const groupMeta = await sock.groupMetadata(groupJid);
        const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' });

        await sock.sendMessage(remoteJid, { text: `⏳ Syncing ${groupMeta.participants.length} members to tab *${tab}*...` }, { quoted: msg });
        for (const p of groupMeta.participants) {
          const phone = p.id.split('@')[0];
          const role = p.admin ? (p.admin === 'superadmin' ? 'Creator' : 'Admin') : 'Member';
          await sheetsAppendRow(sheetId, tab, [phone, phone, now, 'Active', role]);
        }
        await sock.sendMessage(remoteJid, { text: `✅ *Sync Complete!* ${groupMeta.participants.length} members saved to tab *${tab}*.` }, { quoted: msg });
        continue;
      }

      // !tracked — View active mappings and notification states
      if (cmd === '!tracked' || cmd === '!mappings') {
        let reply = `📌 *Active Group Trackers*\n*───────────────────*\n\n`;
        for (const [jid, data] of Object.entries(groupMappings)) {
          reply += `• *Group:* \`${jid}\`\n  ➔ *Tab:* *${data.tab}*\n  ➔ *Alerts:* *${data.notify ? '🔔 ON' : '🔕 OFF (Silent)'}*\n\n`;
        }
        await sock.sendMessage(remoteJid, { text: Object.keys(groupMappings).length ? reply : 'No groups currently mapped.' }, { quoted: msg });
        continue;
      }

      // Controls
      if (cmd === '!status') {
        await sock.sendMessage(remoteJid, { text: `⚡ *Spark Roster Engine*\n• Status: ${isPaused ? '⏸️ Paused' : '✅ Active'}\n• Tracked Groups: ${Object.keys(groupMappings).length}\n• Alerts: Silent by default` }, { quoted: msg });
        continue;
      }
      if (cmd === '!stop') { isPaused = true; await sock.sendMessage(remoteJid, { text: '⏸️ Tracking paused.' }, { quoted: msg }); continue; }
      if (cmd === '!resume') { isPaused = false; await sock.sendMessage(remoteJid, { text: '▶️ Tracking resumed.' }, { quoted: msg }); continue; }
    }
  });
}

// Start Engine
startBot().catch(console.error);
