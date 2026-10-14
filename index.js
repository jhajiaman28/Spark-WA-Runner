const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GITA_SHEET_ID = process.env.GITA_SHEET_ID || "1rgF4V1wIZF_kJvbbmjgiDTOXPQckFvDmMzLN80dILuw";
const VSC_SHEET_ID = process.env.VSC_ACADEMICS_SHEET_ID || "1b2zj-Fx8LPgtyGjM1vlw6Vf8BZ-aFUf4uwUAIGFf4VY";

let currentQR = null;
let connectionStatus = 'Connecting...';
let syncLogs = [];
let botActive = true; // Emergency Stop Toggle

function logActivity(text) {
    const time = new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata' });
    syncLogs.unshift(`[${time}] ${text}`);
    if (syncLogs.length > 25) syncLogs.pop();
    console.log(`[${time}] ${text}`);
}

// Web Dashboard
app.get('/', async (req, res) => {
    if (connectionStatus === 'Connected') {
        const logHtml = syncLogs.map(l => `<li style="margin-bottom: 5px;">${l}</li>`).join('') || '<li>Waiting for commands or polls...</li>';
        return res.send(`
            <body style="font-family: sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px;">
                <h1 style="color: ${botActive ? '#166534' : '#991B1B'};">
                    ${botActive ? '✅ Spark WhatsApp Runner is Active' : '🛑 Spark Runner is PAUSED (Emergency Stop)'}
                </h1>
                <p><b>Status:</b> ${botActive ? 'Running normally (Listening to polls & commands)' : 'All automated broadcasts and sheet syncs are halted.'}</p>
                <p><b>Admin Commands:</b> <code>!stop</code> to pause | <code>!resume</code> to reactivate | <code>!poll gita</code> | <code>!poll vsc</code></p>
                <h3>Live Execution Logs:</h3>
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

app.listen(PORT, () => logActivity(`Web dashboard listening on port ${PORT}`));

// Google Sheets Token Refresher
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

const GITA_MEMBERS = [
    'Alok', 'Aman', 'Amit', 'Anchal', 'Anisha', 'Anjali', 'Anju', 'Ankit', 'Anshu', 'Anurag',
    'Archana', 'Ayush', 'Bhuwan', 'Chhavi', 'Deva', 'Estuti', 'Garima', 'Harsh', 'Himanshu', 'Jyoti',
    'Kanchan', 'Kartikey', 'Lawkesh', 'Luxmi', 'Mamta', 'Meenu', 'Muskan', 'Nagendra', 'Pooja', 'Priti',
    'Raghuvansh', 'Rajnish', 'Rohan', 'Ruhit', 'Sahiba', 'Saksham', 'Saloni', 'Sarika', 'Sarita', 'Satwik',
    'Shiv', 'Shivam', 'Shubham', 'Shweta', 'Swapnil', 'Utkarsh', 'Vikas'
];

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
            logActivity('🎉 WhatsApp connected & live!');
        } else if (connection === 'close') {
            connectionStatus = 'Disconnected';
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const chatJid = msg.key.remoteJid;

        // 1. Emergency Stop Controls
        if (text === '!stop' || text === '!pause') {
            botActive = false;
            logActivity('🛑 EMERGENCY STOP ACTIVATED: Bot operations paused.');
            await sock.sendMessage(chatJid, { text: '🛑 *EMERGENCY STOP ACTIVATED*\nAll automated polling, message relays, and sheet syncing are paused.\nSend `!resume` to reactivate.' }, { quoted: msg });
            return;
        }

        if (text === '!resume' || text === '!start') {
            botActive = true;
            logActivity('✅ Bot operations resumed.');
            await sock.sendMessage(chatJid, { text: '✅ *Bot Resumed*: All automated polling, message relays, and sheet syncing are active.' }, { quoted: msg });
            return;
        }

        if (!botActive) return; // If stopped, ignore remaining triggers

        // 2. Poll Dispatch Commands
        if (text === '!poll gita') {
            const dateStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'Asia/Kolkata' });
            const pollMsg = await sock.sendMessage(chatJid, {
                poll: {
                    name: `${dateStr} - Gita Community Attendance`,
                    values: ['Joined ✅', 'Absent ❌'],
                    selectableCount: 1
                }
            });
            logActivity(`Dispatched Gita Attendance Poll for ${dateStr}`);
            // Pin the poll for 24 hours
            try {
                await sock.sendMessage(chatJid, { pin: pollMsg.key, type: 1, time: 86400 });
                logActivity('Pinned attendance poll to chat header (24h).');
            } catch (e) { console.log('Pinning notice:', e.message); }
            return;
        }

        if (text === '!poll vsc') {
            const dateStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
            const template = `*${dateStr} ➖ Study Tracker* 📚\n\n1. Rohan -\n2. Swapnil -\n3. Anurag -\n4. Pooja -\n5. Saksham -\n6. Himanshu -\n7. Raghuvansh -\n8. Amit -\n9. Aman -\n10. Anisha -\n11. Sahiba -\n12. Sarita -\n13. Muskan -`;
            await sock.sendMessage(chatJid, { text: template });
            logActivity(`Dispatched VSC Study Tracker Template for ${dateStr}`);
            return;
        }

        // 3. Status Report
        if (text === '!status' || text === '!report') {
            const rowData = (await sheetsApi(GITA_SHEET_ID, '/values/Attendance!E45:AZ45')).values?.[0] || [];
            const summary = rowData[0] || 'No attendance logged yet for today.';
            await sock.sendMessage(chatJid, { text: `📊 *Current Attendance Status:*\n${summary}\n\n*Bot Engine Status:* ${botActive ? 'Active ✅' : 'Paused 🛑'}` }, { quoted: msg });
            return;
        }

        // 4. Natural Attendance Claims (e.g., "Ankit present, Anurag absent")
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
                logActivity(`Attendance update detected: ${JSON.stringify(updates)}`);
                const currentVals = (await sheetsApi(GITA_SHEET_ID, '/values/Attendance!F45:AZ45')).values?.[0] || GITA_MEMBERS.map(() => '➖');
                GITA_MEMBERS.forEach((m, i) => {
                    if (updates[m]) currentVals[i] = updates[m];
                });
                await sheetsApi(GITA_SHEET_ID, '/values/Attendance!F45:AZ45?valueInputOption=USER_ENTERED', 'PUT', { values: [currentVals] });
                await sock.sendMessage(chatJid, { react: { text: '✅', key: msg.key } });
                logActivity(`Marked ${Object.keys(updates).join(', ')} in live sheet.`);
            }
        }
    });
}

startBot();
