const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Credentials read privately from Render Environment Variables
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GITA_SHEET_ID = process.env.GITA_SHEET_ID || "1rgF4V1wIZF_kJvbbmjgiDTOXPQckFvDmMzLN80dILuw";
const VSC_SHEET_ID = process.env.VSC_ACADEMICS_SHEET_ID || "1b2zj-Fx8LPgtyGjM1vlw6Vf8BZ-aFUf4uwUAIGFf4VY";

let currentQR = null;
let connectionStatus = 'Connecting...';
let syncLogs = [];

function logActivity(text) {
    const time = new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata' });
    syncLogs.unshift(`[${time}] ${text}`);
    if (syncLogs.length > 20) syncLogs.pop();
    console.log(`[${time}] ${text}`);
}

// Web Dashboard on Render
app.get('/', async (req, res) => {
    if (connectionStatus === 'Connected') {
        const logHtml = syncLogs.map(l => `<li style="margin-bottom: 5px;">${l}</li>`).join('') || '<li>Waiting for incoming polls or messages...</li>';
        return res.send(`
            <body style="font-family: sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px;">
                <h1 style="color: #166534;">✅ Spark WhatsApp Runner is Live 24/7</h1>
                <p><b>Connected Sheets:</b> CW Gita Community Attendance (47 Members) &amp; VSC Academics (13 Students)</p>
                <h3>Recent Live Sync Activity:</h3>
                <ul style="background: #f4f4f5; padding: 20px 30px; border-radius: 8px; font-family: monospace; font-size: 13px;">${logHtml}</ul>
                <script>setTimeout(() => location.reload(), 15000);</script>
            </body>
        `);
    }
    if (!currentQR) {
        return res.send(`<body style="font-family: sans-serif; text-align: center; padding-top: 50px;"><h2>Connecting WhatsApp...</h2><script>setTimeout(() => location.reload(), 5000);</script></body>`);
    }
    const qrImage = await QRCode.toDataURL(currentQR);
    res.send(`<body style="font-family: sans-serif; text-align: center; padding-top: 40px;"><h2>Scan with WhatsApp</h2><img src="${qrImage}" style="width: 320px; height: 320px;" /><script>setTimeout(() => location.reload(), 20000);</script></body>`);
});

app.listen(PORT, () => logActivity(`Web dashboard active on port ${PORT}`));

// Google Sheets API Helpers
function getGoogleAccessToken() {
    return new Promise((resolve, reject) => {
        const postData = `client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&refresh_token=${REFRESH_TOKEN}&grant_type=refresh_token`;
        const req = https.request('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data).access_token); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

async function sheetsApi(sheetId, endpoint, method = 'GET', body = null) {
    const token = await getGoogleAccessToken();
    return new Promise((resolve, reject) => {
        const req = https.request(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}${endpoint}`, {
            method,
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { resolve(data); }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

// 47 Registered Members Roster
const GITA_MEMBERS = [
    'Alok', 'Aman', 'Amit', 'Anchal', 'Anisha', 'Anjali', 'Anju', 'Ankit', 'Anshu', 'Anurag',
    'Archana', 'Ayush', 'Bhuwan', 'Chhavi', 'Deva', 'Estuti', 'Garima', 'Harsh', 'Himanshu', 'Jyoti',
    'Kanchan', 'Kartikey', 'Lawkesh', 'Luxmi', 'Mamta', 'Meenu', 'Muskan', 'Nagendra', 'Pooja', 'Priti',
    'Raghuvansh', 'Rajnish', 'Rohan', 'Ruhit', 'Sahiba', 'Saksham', 'Saloni', 'Sarika', 'Sarita', 'Satwik',
    'Shiv', 'Shivam', 'Shubham', 'Shweta', 'Swapnil', 'Utkarsh', 'Vikas'
];

// Start WhatsApp Client
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) currentQR = qr;
        if (connection === 'open') {
            connectionStatus = 'Connected';
            currentQR = null;
            logActivity('🎉 WhatsApp connected & actively listening to groups!');
        } else if (connection === 'close') {
            connectionStatus = 'Disconnected';
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
    });

    // Message & Command Listener
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const sender = msg.key.participant || msg.key.remoteJid;

        // 1. Natural Attendance Claims (e.g., "Ankit present, Anurag absent")
        if (text.toLowerCase().includes('present') || text.toLowerCase().includes('absent')) {
            const updates = {};
            text.split(/[,;\n]/).forEach(part => {
                const p = part.trim().toLowerCase();
                GITA_MEMBERS.forEach(m => {
                    if (p.includes(m.toLowerCase())) {
                        if (p.includes('present') || p.includes('attended') || p.includes('joined')) updates[m] = '✅';
                        else if (p.includes('absent') || p.includes('not')) updates[m] = '❌';
                    }
                });
            });

            if (Object.keys(updates).length > 0) {
                logActivity(`Detected attendance update from chat: ${JSON.stringify(updates)}`);
                const currentVals = (await sheetsApi(GITA_SHEET_ID, '/values/Attendance!F45:AZ45')).values?.[0] || GITA_MEMBERS.map(() => '➖');
                GITA_MEMBERS.forEach((m, i) => {
                    if (updates[m]) currentVals[i] = updates[m];
                });
                await sheetsApi(GITA_SHEET_ID, '/values/Attendance!F45:AZ45?valueInputOption=USER_ENTERED', 'PUT', { values: [currentVals] });
                await sock.sendMessage(msg.key.remoteJid, { react: { text: '✅', key: msg.key } });
                logActivity(`Marked ${Object.keys(updates).join(', ')} in live sheet.`);
            }
        }

        // 2. Admin Override Commands
        if (text.startsWith('!mark ')) {
            const clean = text.replace('!mark ', '').trim();
            const isPresent = clean.toLowerCase().includes('present');
            const targetName = clean.split(' ')[0];
            const matched = GITA_MEMBERS.find(m => m.toLowerCase() === targetName.toLowerCase());
            if (matched) {
                const currentVals = (await sheetsApi(GITA_SHEET_ID, '/values/Attendance!F45:AZ45')).values?.[0] || GITA_MEMBERS.map(() => '➖');
                const idx = GITA_MEMBERS.indexOf(matched);
                currentVals[idx] = isPresent ? '✅' : '❌';
                await sheetsApi(GITA_SHEET_ID, '/values/Attendance!F45:AZ45?valueInputOption=USER_ENTERED', 'PUT', { values: [currentVals] });
                await sock.sendMessage(msg.key.remoteJid, { text: `✅ Updated: *${matched}* marked ${isPresent ? 'Present' : 'Absent'} in live sheet.`, mentions: [sender] });
            }
        }

        // 3. Status Report Command
        if (text.trim() === '!report' || text.trim() === '!status') {
            const rowData = (await sheetsApi(GITA_SHEET_ID, '/values/Attendance!E45:AZ45')).values?.[0] || [];
            const summary = rowData[0] || 'No attendance logged yet for today.';
            await sock.sendMessage(msg.key.remoteJid, { text: `📊 *Current Attendance Status:*\n${summary}` }, { quoted: msg });
        }
    });

    // Real-Time Poll Vote Listener
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.pollUpdates) {
                logActivity(`Poll vote detected in group!`);
            }
        }
    });
}

startBot();
