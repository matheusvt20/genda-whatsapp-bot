const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const P = require('pino');
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());
app.use(cors());

const sessions = new Map(); // userId -> { sock, ready, lastQrDataUrl, startedAt }

async function ensureSession(userId) {
  if (sessions.has(userId)) return sessions.get(userId);

  const authDir = `./sessions/${userId}`;
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
  });

  const session = { sock, ready: false, lastQrDataUrl: null, startedAt: Date.now() };
  sessions.set(userId, session);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) session.lastQrDataUrl = await QRCode.toDataURL(qr);
    if (connection === 'open') session.ready = true;
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      session.ready = false;
      if (shouldReconnect) setTimeout(() => ensureSession(userId).catch(console.error), 2000);
      else sessions.delete(userId);
    }
  });

  sock.ev.on('creds.update', saveCreds);
  return session;
}

app.get('/', (_req, res) => res.send('Genda WhatsApp Bot ✅ Online'));

/** QR por cliente */
app.get('/api/qr', async (req, res) => {
  try {
    const userId = String(req.query.userId || '').trim();
    if (!userId) return res.status(400).json({ error: 'Informe userId' });

    const session = await ensureSession(userId);

    if (session.ready) {
      return res.json({ connected: true, qr_base64: null, expires_in_seconds: 0 });
    }

    const t0 = Date.now();
    while (!session.lastQrDataUrl && Date.now() - t0 < 8000) {
      await new Promise(r => setTimeout(r, 250));
    }

    if (!session.lastQrDataUrl) {
      return res.status(503).json({ connected: false, qr_base64: null, message: 'QR ainda não gerado, tente novamente.' });
    }

    res.json({ connected: false, qr_base64: session.lastQrDataUrl, expires_in_seconds: 60 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`));
