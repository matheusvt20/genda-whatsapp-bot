// index.js — Genda WhatsApp Bot (multiusuário, CORS ajustado, manutenção, QR PNG e reconexão limpa)

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

// ✅ Diretório base de autenticação: /data (disco persistente do Render)
const AUTH_BASE_DIR = process.env.AUTH_BASE_DIR || '/data';
try { fs.mkdirSync(AUTH_BASE_DIR, { recursive: true }); } catch (e) {
  console.warn('WARN: não foi possível criar AUTH_BASE_DIR:', e?.message);
}

// ==============================
// Funções utilitárias
// ==============================
function isSocketAlive(sock) {
  try {
    return !!(sock?.ws && sock?.ws.readyState === 1);
  } catch {
    return false;
  }
}

// ==============================
// Função principal do bot
// ==============================
async function startBot(userId) {
  // --- proteção contra sessão travada ---
  if (sessions.get(userId)) {
    const sock = sessions.get(userId);
    const isConnected = connections.get(userId);
    if (!isConnected || !isSocketAlive(sock)) {
      console.log(`♻️ Sessão anterior de ${userId} estava desconectada ou socket morto. Reiniciando...`);
      try {
        sessions.delete(userId);
        lastQr.delete(userId);
        connections.set(userId, false);
      } catch {}
    } else {
      return sock; // mantém sessão ativa
    }
  }

  const authDir = path.join(AUTH_BASE_DIR, userId);
  try { fs.mkdirSync(authDir, { recursive: true }); } catch (e) {
    console.warn('WARN: não foi possível criar authDir:', authDir, e?.message);
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`ℹ️ Baileys WA version: ${version.join('.')} (latest=${isLatest}) para ${userId} | authDir=${authDir}`);

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
        console.log(`🔁 Forçando restart automático da sessão de ${userId}`);
        setTimeout(() => startBot(userId).catch(console.error), 2000);
      } else {
        sessions.delete(userId);
      }
    }
  });

  sessions.set(userId, sock);
  return sock;
}

// ==============================
// Express App + CORS
// ==============================
const app = express();
app.use(express.json());

// CORS — aceita file:// (Origin null) e regex de onrender.com
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

// ==============================
// Rotas principais
// ==============================
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

// ==============================
// /api/qr (JSON com base64)
// ==============================
app.get('/api/qr', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');

  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });

  // --- limpeza de sessão travada antes de iniciar ---
  if (sessions.get(userId) && !connections.get(userId)) {
    console.log(`🧹 Limpando sessão travada antes de reiniciar ${userId}`);
    sessions.delete(userId);
    lastQr.delete(userId);
  }

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

// ==============================
// /api/qr.png (imagem PNG direta)
// ==============================
app.get('/api/qr.png', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');

  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });

  if (!sessions.get(userId)) {
    try {
      await startBot(userId);
    } catch (e) {
      console.error('Erro ao iniciar sessão em /api/qr.png:', e);
      return res.status(500).json({ ok: false, error: 'START_FAILED' });
    }
  }

  function get() {
    const connected = !!connections.get(userId);
    const qrInfo = lastQr.get(userId);
    if (connected) return { status: 'connected' };
    if (qrInfo) {
      const ttl = Number(qrInfo.expires_in_seconds ?? 60);
      const ageSec = Math.floor((Date.now() - Date.parse(qrInfo.timestamp)) / 1000);
      if (Number.isFinite(ttl) && ageSec >= ttl) {
        lastQr.delete(userId);
        return { status: 'expired' };
      }
      return { status: 'qr', dataUrl: qrInfo.qr_base64 };
    }
    return { status: 'offline' };
  }

  let r = get();
  if (r.status === 'qr' && r.dataUrl) {
    const b64 = r.dataUrl.replace(/^data:image\/png;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    res.set('Content-Type', 'image/png');
    return res.send(buf);
  }

  const waitUntil = Date.now() + 10_000;
  while (Date.now() < waitUntil) {
    await new Promise(s => setTimeout(s, 300));
    r = get();
    if (r.status === 'qr' && r.dataUrl) {
      const b64 = r.dataUrl.replace(/^data:image\/png;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      res.set('Content-Type', 'image/png');
      return res.send(buf);
    }
  }

  return res.status(425).json({ ok: false, status: get().status || 'offline' });
});

// ==============================
// /api/status (corrigido com socket check)
// ==============================
app.get('/api/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });

  const sock = sessions.get(userId);
  const sockAlive = isSocketAlive(sock);
  const isConnected = connections.get(userId) === true && sockAlive;
  const hasQr = lastQr.has(userId);
  let status = 'offline';

  if (isConnected) {
    status = 'connected';
  } else if (hasQr) {
    status = 'qr';
  } else if (sock) {
    status = 'reconnecting';
  }

  res.json({
    ok: true,
    status,
    connected: isConnected,
    alive: sockAlive,
    timestamp: new Date().toISOString(),
  });
});

// ==============================
// /api/send
// ==============================
app.post('/api/send', async (req, res) => {
  try {
    const { userId, to, text } = req.body || {};
    if (!userId || !to || !text) {
      return res.status(400).json({ ok: false, error: 'MISSING_FIELDS', hint: 'Informe userId, to e text' });
    }

    const sock = sessions.get(userId);
    const isConnected = connections.get(userId);
    if (!sock || !isConnected || !isSocketAlive(sock)) {
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

// ==============================
// Rotas de manutenção
// ==============================
function getAuthDirFor(userId) {
  return path.join(AUTH_BASE_DIR, userId);
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

// 🔌 Desconectar (mantém credenciais no disco)
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

// 🧹 Wipe total: apaga credenciais e força novo QR
app.post('/api/wipe', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });

    await closeSession(userId, 'wipe');
    const dir = getAuthDirFor(userId);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log('🗑️ Auth dir removido:', dir);
    } catch (e) {
      console.warn('Falha ao remover auth dir (pode não existir):', e?.message);
    }

    startBot(userId).catch(console.error);
    return res.json({ ok: true, wiped: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'WIPE_FAILED' });
  }
});

// ♻️ Restart: fecha e reabre a sessão (mantém credenciais)
app.post('/api/restart', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });

    await closeSession(userId, 'restart');
    await startBot(userId);
    return res.json({ ok: true, restarted: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'RESTART_FAILED' });
  }
});

// ==============================
// Start do servidor
// ==============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`));
