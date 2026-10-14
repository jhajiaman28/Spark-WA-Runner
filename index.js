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

// Group IDs
const SPARK_JID = '120363431984658364@g.us';
const GITA_JID = '120363406391193280@g.us';

let qrDataUrl = '';
let isConnected = false;
let isStopped = false;
let logs = [];

function addLog(msg) {
  const time = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  logs.unshift(`[${time}] ${msg}`);
  if (logs.length > 40) logs.pop();
  console.log(`[${time}] ${msg}`);
}

async function sendToSpark(sock, text) {
  try {
    await sock.sendMessage(SPARK_JID, { text });
  } catch (err) {
    addLog(`Error sending to Spark: ${err.message}`);
  }
}

// 50 Member Column Mapping (F to BC)
const MEMBER_COLUMNS = {
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

function updateSheetCell(range, value) {
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

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) qrDataUrl = await qrcode.toDataURL(qr);
    if (connection === 'open') {
      isConnected = true;
      qrDataUrl = '';
      addLog('WhatsApp connected.');
      await sendToSpark(sock, '⚡ *Spark Control Console Active (24/7)*\nRoster: 50 Members mapped (Col F to BC).');
    }
    if (connection === 'close') {
      isConnected = false;
      const reconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      addLog(`Reconnecting: ${reconnect}`);
      if (reconnect) startBot();
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Group Participant Join/Leave Monitor
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    if (id !== GITA_JID) return;
    for (const p of participants) {
      const num = p.split('@')[0];
      if (action === 'add') {
        await sendToSpark(sock, `👤 *New Member Added*: +${num} joined Gita Community.\nRemember to confirm their name to assign their sheet column.`);
        addLog(`Member added: +${num}`);
      } else if (action === 'remove') {
        await sendToSpark(sock, `⚠️ *Member Left/Removed*: +${num} left Gita Community.\nShould their column be removed from the sheet? (Reply to confirm or ignore to keep).`);
        addLog(`Member left: +${num}`);
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
      if (fromJid !== SPARK_JID) continue; // Strictly isolated to Spark group

      if (text === '!stop') {
        isStopped = true;
        await sendToSpark(sock, '🛑 *Bot Stopped.* Paused until `!resume` is sent.');
        continue;
      }
      if (text === '!resume') {
        isStopped = false;
        await sendToSpark(sock, '▶️ *Bot Resumed.* Normal operations active.');
        continue;
      }
      if (isStopped) continue;

      if (text === '!status') {
        await sendToSpark(sock, `✅ *Status: Active 24/7*\n• Roster: 50 members mapped\n• Target: Acharya Prashant Ji Gita Community`);
        continue;
      }

      // Gita Poll Dispatch
      if (text === '!poll gita') {
        const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' });
        await sock.sendMessage(GITA_JID, {
          poll: {
            name: `Gita Community Attendance — ${today}`,
            values: ['Present ✅', 'Absent ❌'],
            selectableCount: 1
          }
        });
        await sendToSpark(sock, `📊 *Gita Attendance Poll Dispatched* to community for ${today}.`);
        continue;
      }

      // Manual Mark (e.g., "!mark Dipesh present")
      const markMatch = text.match(/!mark\s+([a-zA-Z]+)\s+(present|absent|p|a)/i);
      if (markMatch) {
        const name = markMatch[1].toLowerCase();
        const symbol = (markMatch[2].toLowerCase() === 'present' || markMatch[2].toLowerCase() === 'p') ? '✅' : '❌';
        const col = MEMBER_COLUMNS[name];

        if (!col) {
          await sendToSpark(sock, `⚠️ Member *${markMatch[1]}* not found in 50-member roster.`);
          continue;
        }

        const targetRow = 45; // Active row
        const cell = `Attendance Register!${col}${targetRow}`;
        try {
          await updateSheetCell(cell, symbol);
          await sendToSpark(sock, `✅ Marked *${markMatch[1]}* as ${symbol} at \`${cell}\`.`);
        } catch (err) {
          await sendToSpark(sock, `❌ Error updating sheet: ${err.message}`);
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
        <p>Roster: <b>50 Members (F to BC)</b></p>
        <p>Target: <b>Acharya Prashant Ji Gita Community</b></p>
        ${qrDataUrl ? `<img src="${qrDataUrl}" width="200"/>` : ''}
        <h3>Recent Logs:</h3>
        <ul>${logs.map(l => `<li>${l}</li>`).join('')}</ul>
      </div>
    </body></html>
  `);
});

app.listen(PORT, () => addLog(`Web dashboard on port ${PORT}`));
