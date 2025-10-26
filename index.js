// index.js — Genda WhatsApp Bot (multiusuário, reconexão automática e auto-wipe)
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

const AUTH_BASE_DIR = process.env.AUTH_BASE_DIR || '/data';
try { fs.mkdirSync(AUTH_BASE_DIR, { recursive: true }); } catch (e) {
  console.warn('WARN: não foi possível criar AUTH_BASE_DIR:', e?.message);
}

// 🔍 helper para detectar socket vivo
function isSocketAlive(sock) {
  try {
    return !!(sock?.ws && sock?.ws.readyState === 1);
  } catch {
    return false;
  }
}

async function startBot(userId) {
  if (sessions.get(userId)) {
    const sock = sessions.get(userId);
    const isConnected = connections.get(userId);
    if (!isConnected || !isSocketAlive(sock)) {
      console.log(`♻️ Sessão anterior de ${userId} estava desconectada. Reiniciando...`);
      try { sessions.delete(userId); lastQr.delete(userId); } catch {}
    } else {
      return sock;
    }
  }

  const authDir = path.join(AUTH_BASE_DIR, userId);
  try { fs.mkdirSync(authDir, { recursive: true }); } catch (e) {
    console.warn('WARN: não foi possível criar authDir:', authDir, e?.message);
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`ℹ️ Baileys WA version: ${version.join('.')} (latest=${isLatest}) para ${userId}`);

  const sock = makeWASocket({
    version,
    logger: P({ level: 'info' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['Genda', 'Chrome', '10.0'],
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
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      connections.set(userId, false);
      console.log(`🔌 Conexão encerrada ${userId} — statusCode: ${statusCode} — loggedOut? ${loggedOut}`);

      if (statusCode === 401) {
        console.log(`⚠️ Sessão de ${userId} inválida (device removed). Limpando...`);
        sessions.delete(userId);
        lastQr.delete(userId);
        return;
      }

      if (!loggedOut) {
        try { sessions.delete(userId); } catch {}
        console.log(`🔁 Reiniciando sessão de ${userId}...`);
        setTimeout(() => startBot(userId).catch(console.error), 2000);
      } else {
        sessions.delete(userId);
      }
    }
  });

  sessions.set(userId, sock);
  return sock;
}

const app = express();
app.use(express.json());

// ✅ CORS configurado para Lovable + localhost
const corsOptions = {
  origin(origin, cb) {
    if (!origin || origin.startsWith('file://')) return cb(null, true);
    return isOriginAllowed(origin)
      ? cb(null, true)
      : cb(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
};
app.use(cors(corsOptions));

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

async function closeSession(userId, reason = 'manual') {
  const sock = sessions.get(userId);
  try {
    if (sock) {
      console.log(`↘️ Fechando sessão de ${userId} (${reason})`);
      try { await sock.logout?.(); } catch {}
      try { await sock.ws?.close?.(); } catch {}
      try { await sock.end?.(); } catch {}
    }
  } catch (e) {
    console.warn('Erro ao fechar sessão:', e?.message || e);
  } finally {
    sessions.delete(userId);
    connections.set(userId, false);
    lastQr.delete(userId);
  }
}

app.get('/api/qr', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');

  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });

  const sock = sessions.get(userId);
  const isConn = connections.get(userId);
  if (sock && !isConn) {
    console.log(`⚠️ Sessão antiga de ${userId} estava desconectada, limpando auth...`);
    try {
      await closeSession(userId, 'auto-wipe');
      const dir = path.join(AUTH_BASE_DIR, userId);
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`🗑️ Auth dir removido automaticamente: ${dir}`);
    } catch (e) {
      console.warn('Falha ao limpar sessão antiga:', e?.message);
    }
  }

  console.log(`⚡ Iniciando sessão limpa para ${userId}...`);
  try {
    await startBot(userId);
  } catch (e) {
    console.error('Erro ao iniciar sessão em /api/qr:', e);
    return res.status(500).json({ ok: false, error: 'START_FAILED' });
  }

  let resp = buildQrResponse(userId);
  if (resp.status !== 'offline') return res.json(resp);

  const waitUntil = Date.now() + 10_000;
  while (Date.now() < waitUntil) {
    await new Promise(r => setTimeout(r, 300));
    resp = buildQrResponse(userId);
    if (resp.status !== 'offline') break;
  }

  if (resp.status === 'offline') {
    console.log(`❌ QR não gerado para ${userId}, forçando WIPE final...`);
    await closeSession(userId, 'final-wipe');
    const dir = path.join(AUTH_BASE_DIR, userId);
    fs.rmSync(dir, { recursive: true, force: true });
    await startBot(userId).catch(console.error);
    resp = buildQrResponse(userId);
  }

  return res.json(resp);
});

app.get('/api/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });

  const sock = sessions.get(userId);
  const sockAlive = isSocketAlive(sock);
  const isConnected = connections.get(userId) === true && sockAlive;
  const hasQr = lastQr.has(userId);
  let status = 'offline';

  if (isConnected) status = 'connected';
  else if (hasQr) status = 'qr';
  else if (sock) status = 'reconnecting';

  res.json({
    ok: true,
    status,
    connected: isConnected,
    alive: sockAlive,
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/send', async (req, res) => {
  try {
    const { userId, to, text } = req.body || {};
    if (!userId || !to || !text)
      return res.status(400).json({ ok: false, error: 'MISSING_FIELDS' });

    const sock = sessions.get(userId);
    const isConnected = connections.get(userId);
    if (!sock || !isConnected)
      return res.status(400).json({ ok: false, error: 'NOT_CONNECTED' });

    const digits = String(to).replace(/\D/g, '');
    if (digits.length < 10)
      return res.status(400).json({ ok: false, error: 'INVALID_NUMBER' });

    const jid = `${digits}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text });
    return res.json({ ok: true, sent: true, to: jid });
  } catch (e) {
    console.error('send error', e);
    return res.status(500).json({ ok: false, error: 'SEND_FAILED' });
  }
});

app.post('/api/disconnect', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });
    await closeSession(userId, 'disconnect');
    return res.json({ ok: true, disconnected: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'DISCONNECT_FAILED' });
  }
});

app.post('/api/wipe', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });
    await closeSession(userId, 'wipe');
    const dir = path.join(AUTH_BASE_DIR, userId);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('🗑️ Auth dir removido:', dir);
    startBot(userId).catch(console.error);
    return res.json({ ok: true, wiped: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'WIPE_FAILED' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`));
