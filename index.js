// index.js — Genda WhatsApp Bot (com UI e CORS ajustado para testes locais)

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const P = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const { isOriginAllowed } = require('./cors-allow');

const sessions = new Map();    // userId -> sock
const lastQr = new Map();      // userId -> { qr_base64, expires_in_seconds, timestamp }
const connections = new Map(); // userId -> boolean

const AUTH_BASE_DIR = process.env.AUTH_BASE_DIR || path.join('.', 'auth_info');

async function startBot(userId) {
  if (sessions.get(userId)) return sessions.get(userId);

  const authDir = path.join(AUTH_BASE_DIR, userId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`ℹ️ Baileys WA version: ${version.join('.')} (latest=${isLatest}) para ${userId}`);

  const sock = makeWASocket({
    version,
    logger: P({ level: 'info' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['Chrome', 'Windows', '10.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 15_000,
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

  sessions.set(userId, sock);
  return sock;
}

const app = express();
app.use(express.json());

// CORS — agora aceita file:// (Origin null) e regex de onrender.com
const corsOptions = {
  origin(origin, cb) {
    if (!origin || origin.startsWith('file://')) {
      return cb(null, true);
    }
    return isOriginAllowed(origin)
      ? cb(null, true)
      : cb(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
};
app.use(cors(corsOptions));

// Rota inicial
app.get('/', (_req, res) => res.send('Genda WhatsApp Bot ✅ Online'));
app.get('/healthz', (_req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

function buildQrResponse(userId) {
  const connected = !!connections.get(userId);
  const qrInfo = lastQr.get(userId);

  if (connected) return { ok: true, status: 'connected', connected: true };

  if (qrInfo) {
    const ttl = Number(qrInfo.expires_in_seconds ?? 60);
    const ageSec = Math.floor((Date.now() - Date.parse(qrInfo.timestamp)) / 1000);
    if (Number.isFinite(ttl) && ageSec >= ttl) {
      lastQr.delete(userId);
      return { ok: false, status: 'offline', connected: false, expired: true };
    }
    return {
      ok: true,
      status: 'qr',
      connected: false,
      qr: qrInfo.qr_base64,
      qr_base64: qrInfo.qr_base64,
      expires_in_seconds: qrInfo.expires_in_seconds,
      timestamp: qrInfo.timestamp,
    };
  }

  return { ok: false, status: 'offline', connected: false };
}

// 🔗 /api/qr
app.get('/api/qr', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');

  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });

  if (!sessions.get(userId)) {
    console.log(`⚡ Nenhuma sessão ativa para ${userId}, iniciando...`);
    try {
      await startBot(userId);
    } catch (e) {
      console.error('Erro ao iniciar sessão em /api/qr:', e);
      return res.status(500).json({ ok: false, error: 'START_FAILED' });
    }
  }

  let resp = buildQrResponse(userId);
  if (resp.status !== 'offline') return res.json(resp);

  const waitUntil = Date.now() + 10_000;
  while (Date.now() < waitUntil) {
    await new Promise(r => setTimeout(r, 300));
    resp = buildQrResponse(userId);
    if (resp.status !== 'offline') break;
  }

  return res.json(resp);
});

// Status da sessão
app.get('/api/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });
  const connected = !!connections.get(userId);
  const status = connected ? 'connected' : (lastQr.has(userId) ? 'qr' : 'offline');
  res.json({ ok: true, status, connected, timestamp: new Date().toISOString() });
});

// ▶️ Envio de mensagem
app.post('/api/send', async (req, res) => {
  try {
    const { userId, to, text } = req.body || {};
    if (!userId || !to || !text) {
      return res.status(400).json({ ok: false, error: 'MISSING_FIELDS', hint: 'Informe userId, to e text' });
    }

    const sock = sessions.get(userId);
    const isConnected = connections.get(userId);
    if (!sock || !isConnected) {
      return res.status(400).json({ ok: false, error: 'NOT_CONNECTED', hint: 'Conecte via /api/qr primeiro' });
    }

    const digits = String(to).replace(/\D/g, '');
    if (digits.length < 10) {
      return res.status(400).json({ ok: false, error: 'INVALID_NUMBER', hint: 'Use 55DDDNUMERO (só dígitos)' });
    }
    const jid = `${digits}@s.whatsapp.net`;

    await sock.sendMessage(jid, { text });
    return res.json({ ok: true, sent: true, to: jid });
  } catch (e) {
    console.error('send error', e);
    return res.status(500).json({ ok: false, error: 'SEND_FAILED' });
  }
});

// outras rotas (restart, wipe, diag, disconnect) — permanecem iguais ao seu index atual
// ...

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`));
