const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

let currentQR = null;
let connectionStatus = 'Connecting...';

// Express Web Server to display QR code on tablet screen
app.get('/', async (req, res) => {
    if (connectionStatus === 'Connected') {
        return res.send(`
            <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
                <h1 style="color: #166534;">✅ WhatsApp Connected & Live!</h1>
                <p>Bot is actively listening to community polls & syncing Google Sheets 24/7.</p>
            </body>
        `);
    }
    if (!currentQR) {
        return res.send(`
            <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
                <h2>Generating WhatsApp QR Code...</h2>
                <p>Please refresh in 5 seconds.</p>
                <script>setTimeout(() => location.reload(), 5000);</script>
            </body>
        `);
    }
    const qrImage = await QRCode.toDataURL(currentQR);
    res.send(`
        <body style="font-family: sans-serif; text-align: center; padding-top: 40px;">
            <h2>Scan with WhatsApp on Mobile</h2>
            <p>Go to <b>WhatsApp &gt; Linked Devices &gt; Link a Device</b></p>
            <img src="${qrImage}" style="width: 320px; height: 320px; border: 1px solid #ccc; padding: 10px; border-radius: 8px;" />
            <p style="color: #666; font-size: 13px;">Page auto-refreshes every 20 seconds</p>
            <script>setTimeout(() => location.reload(), 20000);</script>
        </body>
    `);
});

app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

// Start Baileys WhatsApp Connection
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
            console.log('🎉 WhatsApp successfully linked & connected!');
        } else if (connection === 'close') {
            connectionStatus = 'Disconnected';
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
    });

    // Listen to incoming messages & polls
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;
        console.log('Incoming message detected from:', msg.key.remoteJid);
    });
}

startBot();
