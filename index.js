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

let qrDataUrl = '';
let isConnected = false;
let isStopped = false;
let logs = [];

function addLog(msg) {
  const time = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  logs.unshift(`[${time}] ${msg}`);
  if (logs.length > 50) logs.pop();
  console.log(`[${time}] ${msg}`);
}

// 1. Google OAuth Token Fetcher
function getAccessToken() {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token'
    }).toString();

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          const json = JSON.parse(data);
          resolve(json.access_token);
        } else {
          addLog(`OAuth error (${res.statusCode}): ${data}`);
          reject(new Error(`OAuth Error: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// 2. Google Sheets API Call with Status Verification
function updateSheetCell(range, value) {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getAccessToken();
      const body = JSON.stringify({ values: [[value]] });
      const encodedRange = encodeURIComponent(range);

      const req = https.request({
        hostname: 'sheets.googleapis.com',
        path: `/v4/spreadsheets/${GITA_SHEET_ID}/values/${encodedRange}?valueInputOption=USER_ENTERED`,
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        let respData = '';
        res.on('data', chunk => respData += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(JSON.parse(respData));
          } else {
            addLog(`Sheets API Error (${res.statusCode}): ${respData}`);
            reject(new Error(`Sheets Error: ${respData}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Member column mapping (Columns F to AZ)
const MEMBER_COLUMNS = {
  'alok': 'F', 'aman': 'G', 'amit': 'H', 'anchal': 'I', 'anisha': 'J',
  'anjali': 'K', 'anju': 'L', 'ankit': 'M', 'anshu': 'N', 'anurag': 'O',
  'archana': 'P', 'ayush': 'Q', 'bhuwan': 'R', 'chhavi': 'S', 'deva': 'T',
  'estuti': 'U', 'garima': 'V', 'harsh': 'W', 'himanshu': 'X', 'jyoti': 'Y',
  'kanchan': 'Z', 'kartikey': 'AA', 'lawkesh': 'AB', 'luxmi': 'AC', 'mamta': 'AD',
  'meenu': 'AE', 'muskan': 'AF', 'nagendra': 'AG', 'pooja': 'AH', 'priti': 'AI',
  'raghuvansh': 'AJ', 'rajnish': 'AK', 'rohan': 'AL', 'ruhit': 'AM', 'sahiba': 'AN',
  'saksham': 'AO', 'saloni': 'AP', 'sarika': 'AQ', 'sarita': 'AR', 'satwik': 'AS',
  'shiv': 'AT', 'shivam': 'AU', 'shubham': 'AV', 'shweta': 'AW', 'swapnil': 'AX',
  'utkarsh': 'AY', 'vikas': 'AZ'
};

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrDataUrl = await qrcode.toDataURL(qr);
      addLog('New QR code generated.');
    }
    if (connection === 'open') {
      isConnected = true;
      qrDataUrl = '';
      addLog('WhatsApp connected & actively listening to groups!');
    }
    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      addLog(`Connection closed. Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) startBot();
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
      const remoteJid = msg.key.remoteJid;

      if (!text) continue;

      // Emergency Controls
      if (text.toLowerCase() === '!stop') {
        isStopped = true;
        await sock.sendMessage(remoteJid, { text: '🛑 *Bot Stopped.* Automation paused until `!resume` is sent.' });
        addLog('Emergency stop triggered.');
        continue;
      }
      if (text.toLowerCase() === '!resume') {
        isStopped = false;
        await sock.sendMessage(remoteJid, { text: '▶️ *Bot Resumed.* Listening and responding to commands.' });
        addLog('Bot resumed.');
        continue;
      }
      if (isStopped) continue;

      // Status Check
      if (text.toLowerCase() === '!status') {
        await sock.sendMessage(remoteJid, { text: '✅ *Spark Runner Active (24/7)*\nConnected Sheets: CW Gita Community & VSC Academics' });
        continue;
      }

      // Gita Attendance Poll Dispatch & Auto-Pin
      if (text.toLowerCase() === '!poll gita' || text.toLowerCase() === 'poll gita') {
        const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' });
        const pollMsg = await sock.sendMessage(remoteJid, {
          poll: {
            name: `Gita Community Attendance — ${today}`,
            values: ['Present ✅', 'Absent ❌'],
            selectableCount: 1
          }
        });

        // Automatically pin the poll for 24 hours (86400 seconds)
        try {
          await sock.sendMessage(remoteJid, {
            pin: {
              type: 1,        // 1 to pin, 0 to unpin
              time: 86400,    // 24 hours duration
              key: pollMsg.key
            }
          });
          addLog(`Sent & pinned Gita attendance poll in ${remoteJid}`);
        } catch (pinErr) {
          addLog(`Poll sent, but pinning failed: ${pinErr.message}`);
        }
        continue;
      }

      // Manual / Text Attendance Marking (e.g., "!mark Ankit present" or "!mark Anurag absent")
      const markMatch = text.match(/!mark\s+([a-zA-Z]+)\s+(present|absent|p|a)/i);
      if (markMatch) {
        const name = markMatch[1].toLowerCase();
        const status = markMatch[2].toLowerCase();
        const symbol = (status === 'present' || status === 'p') ? '✅' : '❌';
        const col = MEMBER_COLUMNS[name];

        if (!col) {
          await sock.sendMessage(remoteJid, { text: `⚠️ Member *${markMatch[1]}* not found in registered 47 roster.` });
          continue;
        }

        // Target active row: Row 45 (13/10/26) in the "Attendance" tab
        const targetRow = 45;
        const cell = `Attendance!${col}${targetRow}`;

        try {
          await updateSheetCell(cell, symbol);
          addLog(`Successfully marked ${markMatch[1]} as ${symbol} at ${cell} in live sheet.`);
          await sock.sendMessage(remoteJid, { text: `✅ Recorded *${markMatch[1]}* as ${symbol} in live sheet at cell \`${cell}\`.` });
        } catch (err) {
          addLog(`Failed to update ${markMatch[1]}: ${err.message}`);
          await sock.sendMessage(remoteJid, { text: `❌ Failed to update sheet: ${err.message}` });
        }
      }
    }
  });
}

startBot();

// Dashboard UI
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Spark WhatsApp Runner</title>
        <meta http-equiv="refresh" content="10">
        <style>
          body { font-family: -apple-system, sans-serif; background: #f4f6f8; padding: 24px; }
          .card { background: white; border-radius: 12px; padding: 24px; max-width: 720px; margin: 0 auto; box-shadow: 0 4px 12px rgba(0,0,0,0.06); }
          .badge { padding: 6px 12px; border-radius: 6px; font-weight: bold; display: inline-block; }
          .live { background: #e6f4ea; color: #137333; }
          .waiting { background: #fef7e0; color: #b06000; }
          ul { list-style: none; padding-left: 0; }
          li { font-family: monospace; font-size: 13px; padding: 6px 0; border-bottom: 1px solid #eee; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>Spark WhatsApp Runner 24/7</h2>
          <p>Status: <span class="badge ${isConnected ? 'live' : 'waiting'}">${isConnected ? '✅ Live & Connected' : '⏳ Awaiting Scan'}</span></p>
          ${isStopped ? '<p style="color:red;font-weight:bold;">🛑 EMERGENCY STOP ACTIVE</p>' : ''}
          ${qrDataUrl ? `<div style="text-align:center;"><img src="${qrDataUrl}" width="250"/><p>Scan to link WhatsApp</p></div>` : ''}
          <h3>Recent Live Sync Activity:</h3>
          <ul>${logs.map(l => `<li>${l}</li>`).join('')}</ul>
        </div>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  addLog(`Web dashboard active on port ${PORT}`);
});
