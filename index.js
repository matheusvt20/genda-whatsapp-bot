// index.js
// -------------------------------
// Genda WhatsApp Bot - HTTP API
// -------------------------------

const express = require('express');
const cors = require('cors');
const P = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion, // ok manter mesmo se não atualizar pacote
} = require('@whiskeysockets/baileys');

/**
 * Memória de runtime (MVP)
 */
const sessions = new Map();    // userId -> sock
const lastQr = new Map();      // userId -> { qr_base64, expires_in_seconds, timestamp }
const connections = new Map(); // userId -> boolean

/**
 * Inicia (ou recupera) sessão para userId
 */
async function startBot(userId) {
  if (sessions.get(userId)) return sessions.get(userId);

  const authDir = `./auth_info/${userId}`;
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  // Tenta pegar a versão mais nova; se falhar, usa fallback estável
  let version = [2, 3000, 0];
  try {
    const v = await fetchLatestBaileysVersion();
    if (v?.version) version = v.version;
  } catch {}

  const sock = makeWASocket({
    version,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['Genda', 'Chrome', '1.0.0'],
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
      console.log(`✅ ${userId} conectado com sucesso!`);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      connections.set(userId, false);
      console.log(
        `🔌 Conexão encerrada ${userId} — reconectar?`,
        shouldReconnect,
        'statusCode:',
        statusCode
      );
      if (shouldReconnect) {
        setTimeout(() => startBot(userId).catch(console.error), 1500);
      }
    }
  });

  sessions.set(userId, sock);
  return sock;
}

/**
 * Servidor HTTP
 */
const app = express();
app.use(express.json());

// ----------- CORS (ajustado) -----------
const allowedOrigins = [
  'https://usegenda.com',
  'http://localhost:3000',
  'http://localhost:5173',
  'https://localhost:3000',
  // adicione seu preview Lovable aqui se quiser fixo:
  // 'https://SEU-PROJETO.lovable.dev',
];
const lovableRegex = /^https:\/\/[a-z0-9-]+\.lovable\.dev$/i;

app.use(cors({
  origin: function (origin, callback) {
    // 1) Permitir requisições sem Origin (navegador abrindo direto, health checks, curl)
    if (!origin) return callback(null, true);

    // 2) Permitir lista fixa e *.lovable.dev
    if (allowedOrigins.includes(origin) || lovableRegex.test(origin)) {
      return callback(null, true);
    }

    // 3) Bloquear outras origens
    return callback(new Error('Not allowed by CORS: ' + origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'apikey', 'Prefer'],
  credentials: false,
}));

// Preflight para qualquer rota
app.options('*', cors());

// ----------- HEALTH -----------
app.get('/', (_req, res) => res.send('Genda WhatsApp Bot ✅ Online'));
app.get('/healthz', (_req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

/**
 * GET /api/connect?userId=XYZ
 * Inicia (ou confirma) a sessão
 */
app.get('/api/connect', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });

  try {
    await startBot(userId);
    return res.json({ ok: true, started: true, userId });
  } catch (err) {
    console.error('Erro /api/connect:', err);
    return res.status(500).json({ ok: false, error: 'CONNECT_FAILED' });
  }
});

/**
 * GET /api/qr?userId=XYZ
 * - Se QR disponível: { ok:true, status:"qr", qr:"data:image/png;base64,..." }
 * - Se conectado:     { ok:true, status:"connected" }
 * - Se offline:       { ok:false, status:"offline" }
 */
app.get('/api/qr', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });

  const isConnected = !!connections.get(userId);
  const qrInfo = lastQr.get(userId);

  if (isConnected) return res.json({ ok: true, status: 'connected' });
  if (qrInfo?.qr_base64) return res.json({ ok: true, status: 'qr', qr: qrInfo.qr_base64 });

  return res.status(404).json({ ok: false, status: 'offline' });
});

/**
 * GET /api/status?userId=XYZ
 * { ok:true, service:"whatsapp-bot", status:"connected|qr|offline", timestamp:"..." }
 */
app.get('/api/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });

  const isConnected = !!connections.get(userId);
  const qrInfo = lastQr.get(userId);

  let status = 'offline';
  if (isConnected) status = 'connected';
  else if (qrInfo?.qr_base64) status = 'qr';

  return res.json({
    ok: true,
    service: 'whatsapp-bot',
    status,
    timestamp: new Date().toISOString(),
  });
});

// Porta (Render define via env)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`));
