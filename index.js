// index.js
const express = require('express');
const cors = require('cors');
const P = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const sessions = new Map();    // userId -> sock
const lastQr = new Map();      // userId -> { qr_base64, expires_in_seconds, timestamp }
const connections = new Map(); // userId -> boolean

async function startBot(userId) {
  if (sessions.get(userId)) return sessions.get(userId);

  const authDir = `./auth_info/${userId}`;
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`ℹ️ Baileys WA version: ${version.join('.')} (latest=${isLatest}) para ${userId}`);

  const sock = makeWASocket({
    version,
    logger: P({ level: 'info' }),
    printQRInTerminal: false,
    auth: state,
    // 🔹 Simula um Android com Chrome
    browser: ['Chrome', 'Android', '14.0'],
    // 🔹 Mais tolerância no login
    connectTimeoutMs: 120_000,
    keepAliveIntervalMs: 15_000,
    // 🔹 Deixa mais parecido com login oficial
    syncFullHistory: true,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      QRCode.toDataURL(qr, { errorCorrectionLevel: 'M' })
        .then((dataUrl) => {
          lastQr.set(userId, {
            qr_base64: dataUrl,
            expires_in_seconds: 60,
            timestamp: new Date().toISOString(),
          });
          connections.set(userId, false);
          console.log(`🆗 QR gerado para ${userId} (válido ~60s)`);
        })
        .catch((err) => console.error('Erro ao gerar PNG do QR:', err));
    }

    if (connection === 'open') {
      connections.set(userId, true);
      lastQr.delete(userId);
      console.log(`✅ ${userId} CONECTADO!`);
    }

    if (connection === 'close') {
      const boom = lastDisconnect?.error;
      const statusCode = boom?.output?.statusCode || boom?.data?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      connections.set(userId, false);
      console.log(`🔌 Conexão encerrada ${userId} — statusCode: ${statusCode} — reconectar? ${shouldReconnect}`);
      if (shouldReconnect) setTimeout(() => startBot(userId).catch(console.error), 2000);
    }
  });

  // Logs úteis pra ver progresso do login
  sock.ev.on('auth-state.update', (s) =>
    console.log(`🔐 auth-state ${userId}:`, s?.credsRegistered ? 'credsRegistered' : 'carregando')
  );
  sock.ev.on('messaging-history.set', () =>
    console.log(`🗂️ history set ${userId}`)
  );

  sessions.set(userId, sock);
  return sock;
}

const app = express();
app.use(express.json());

// CORS
const allowedFromEnv = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const defaultOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://localhost:3000',
  'https://usegenda.com',
  'https://www.usegenda.com',
  /\.lovable\.dev$/,
  /\.lovable\.app$/,
];
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // Origin:null (apps/preview)
    if (allowedFromEnv.includes(origin)) return cb(null, true);
    const ok = defaultOrigins.some(o => (o instanceof RegExp ? o.test(origin) : o === origin));
    return ok ? cb(null, true) : cb(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
};
app.use(cors(corsOptions));

app.get('/', (_req, res) => res.send('Genda WhatsApp Bot ✅ Online'));
app.get('/healthz', (_req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

app.get('/api/connect', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });
  try {
    await startBot(userId);
    return res.json({ ok: true, started: true, userId });
  } catch (e) {
    console.error('Erro /api/connect:', e);
    return res.status(500).json({ ok: false, error: 'CONNECT_FAILED' });
  }
});

app.get('/api/qr', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });

  const connected = !!connections.get(userId);
  const qrInfo = lastQr.get(userId);

  if (connected) return res.json({ ok: true, status: 'connected', connected: true });
  if (qrInfo) {
    return res.json({
      ok: true,
      status: 'qr',
      connected: false,
      qr: qrInfo.qr_base64,
      qr_base64: qrInfo.qr_base64,
      expires_in_seconds: qrInfo.expires_in_seconds,
      timestamp: qrInfo.timestamp,
    });
  }
  return res.json({ ok: false, status: 'offline', connected: false });
});

app.get('/api/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });
  const connected = !!connections.get(userId);
  const status = connected ? 'connected' : (lastQr.has(userId) ? 'qr' : 'offline');
  res.json({ ok: true, status, connected, timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`));
