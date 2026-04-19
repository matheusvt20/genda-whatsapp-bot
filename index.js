// index.js — Genda WhatsApp Bot (multiusuário, QR PNG, multi-session, reconexão limpa)
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

const { isOriginAllowed } = require('./cors-allow'); // sua whitelist CORS

function extractPhoneNumber(sock) {
  const rawJid = sock?.user?.id || '';
  const phoneNumber = rawJid.split('@')[0]?.split(':')[0] || null;
  return phoneNumber || null;
}

async function notifyConnectionStatus(userId, status, phoneNumber = null) {
  const webhookUrl = process.env.SUPABASE_CONNECTION_WEBHOOK;
  const botSignature = process.env.BOT_SIGNATURE;

  if (!webhookUrl || !botSignature) return;

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bot-signature': botSignature,
      },
      body: JSON.stringify({
        user_id: userId,
        status,
        phone_number: phoneNumber,
        timestamp: new Date().toISOString(),
      }),
    });

    console.log(`📡 Status ${status} notificado para ${userId}: ${res.status}`);
  } catch (err) {
    console.error(`❌ Erro ao notificar status ${status} para ${userId}:`, err.message);
  }
}

// In-memory maps (process-lifetime). Persistência real está nas credenciais em disco.
const sessions = new Map();          // userId -> sock
const lastQr = new Map();            // userId -> { qr_base64, expires_in_seconds, timestamp }
const connections = new Map();       // userId -> boolean
const reconnectAttempts = new Map(); // userId -> number (backoff exponencial)

// Diretório base para credenciais (persistente no Render)
const AUTH_BASE_DIR = process.env.AUTH_BASE_DIR || '/data';
try { fs.mkdirSync(AUTH_BASE_DIR, { recursive: true }); } catch (e) { console.warn('WARN: não criou AUTH_BASE_DIR:', e?.message); }

// startBot(userId) -> inicia sessão Baileys para userId
async function startBot(userId) {
  if (sessions.get(userId)) return sessions.get(userId);

  const authDir = path.join(AUTH_BASE_DIR, userId);
  try { fs.mkdirSync(authDir, { recursive: true }); } catch (e) { console.warn('WARN: não criou authDir:', authDir, e?.message); }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  console.log(`ℹ️ Baileys version: ${version.join('.')} (latest=${isLatest}) para ${userId} | authDir=${authDir}`);

  // Colocamos userId dentro do browser fingerprint p/ evitar conflitos
  const sock = makeWASocket({
    version,
    logger: P({ level: 'silent' }), // suprimir logs internos do Baileys (decrypt, keep-alive, etc)
    printQRInTerminal: false,
    auth: state,
    browser: ['GendaBot', String(userId).slice(0, 20), '1.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 30_000, // 30s — menos agressivo, evita timeouts de keep-alive
    retryRequestDelayMs: 2_000,
  });

  // salva credenciais quando atualizam
  sock.ev.on('creds.update', saveCreds);

  // Tratar falhas de descriptografia silenciosamente (SessionError)
  // Baileys envia retry receipt automaticamente — não precisa logar como erro
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      if (msg.messageStubType === 2) continue; // ignorar stubs
    }
  });

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
      reconnectAttempts.delete(userId); // reset backoff ao conectar com sucesso
      const phoneNumber = extractPhoneNumber(sock);
      console.log(`✅ ${userId} CONECTADO!`);
      void notifyConnectionStatus(userId, 'connected', phoneNumber);
    }

    if (connection === 'close') {
      const boom = lastDisconnect?.error;
      const statusCode = boom?.output?.statusCode || boom?.data?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      connections.set(userId, false);
      console.log(`🔌 Conexão encerrada ${userId} — statusCode: ${statusCode} — loggedOut? ${loggedOut}`);

      // Se foi logout intencional pelo WhatsApp -> remover credenciais
      if (statusCode === 401 || loggedOut) {
        void notifyConnectionStatus(userId, 'disconnected');
        try {
          const dir = path.join(AUTH_BASE_DIR, userId);
          fs.rmSync(dir, { recursive: true, force: true });
          console.log(`🗑️ Credenciais removidas para ${userId} (logout) - ${dir}`);
        } catch (e) {
          console.warn('Falha ao remover auth dir:', e?.message || e);
        }
        sessions.delete(userId);
        reconnectAttempts.delete(userId);
        lastQr.delete(userId);
        return;
      }

      // QR expirou sem ninguém escanear — não reconectar automaticamente.
      // O usuário precisa solicitar via app. Reconectar aqui só gera loop infinito de QR.
      const qrExpired = boom?.message?.includes('QR refs attempts ended') ||
        lastDisconnect?.error?.message?.includes('QR refs attempts ended');
      if (qrExpired) {
        console.log(`⏸️ ${userId} — QR não escaneado, aguardando ação do usuário`);
        void notifyConnectionStatus(userId, 'disconnected');
        sessions.delete(userId);
        reconnectAttempts.delete(userId);
        return;
      }

      // Reconexão com backoff exponencial: 2s, 4s, 8s, 16s, 32s, máx 60s
      // Evita rate limiting do WhatsApp que causa novos QR codes
      void notifyConnectionStatus(userId, 'disconnected');
      try { sessions.delete(userId); } catch (e) {}
      const attempts = (reconnectAttempts.get(userId) || 0) + 1;
      reconnectAttempts.set(userId, attempts);
      const delay = Math.min(2000 * Math.pow(2, attempts - 1), 60000);
      console.log(`🔄 Reconectando ${userId} em ${delay}ms (tentativa ${attempts})`);
      setTimeout(() => startBot(userId).catch(err => console.error('Erro restart startBot:', err)), delay);
    }
  });

  // store session
  sessions.set(userId, sock);
  return sock;
}

const app = express();
app.use(express.json());

// CORS config: aceita file:// (origin null) e origins permitidas via isOriginAllowed
const corsOptions = {
  origin(origin, cb) {
    if (!origin || origin.startsWith('file://')) return cb(null, true);
    return isOriginAllowed(origin) ? cb(null, true) : cb(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
};
app.use(cors(corsOptions));

// ---------- Helpers ----------
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

function getAuthDirFor(userId) {
  return path.join(AUTH_BASE_DIR, String(userId));
}

// ---------- Public endpoints ----------
app.get('/', (_req, res) => res.send('Genda WhatsApp Bot ✅ Online'));
app.get('/healthz', (_req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

// /api/qr -> retorna JSON com qr_base64
app.get('/api/qr', async (req, res) => {
  console.log(JSON.stringify({
    event: '📡 REQUEST',
    endpoint: '/api/qr',
    timestamp: new Date().toISOString(),
    userId: req.query.userId || req.body?.userId || 'não informado',
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
    origin: req.headers['origin'] || 'não informado',
    referer: req.headers['referer'] || 'não informado',
    userAgent: req.headers['user-agent'] || 'não informado'
  }));
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');

  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });

  if (!sessions.get(userId)) {
    try { await startBot(userId); } catch (e) {
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

// /api/qr.png -> retorna o PNG do QR
app.get('/api/qr.png', async (req, res) => {
  console.log(JSON.stringify({
    event: '📡 REQUEST',
    endpoint: '/api/qr.png',
    timestamp: new Date().toISOString(),
    userId: req.query.userId || req.body?.userId || 'não informado',
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
    origin: req.headers['origin'] || 'não informado',
    referer: req.headers['referer'] || 'não informado',
    userAgent: req.headers['user-agent'] || 'não informado'
  }));
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');

  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });

  if (!sessions.get(userId)) {
    try { await startBot(userId); } catch (e) {
      console.error('Erro ao iniciar sessão em /api/qr.png:', e);
      return res.status(500).json({ ok: false, error: 'START_FAILED' });
    }
  }

  function getStatus() {
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

  let r = getStatus();
  if (r.status === 'qr' && r.dataUrl) {
    const b64 = r.dataUrl.replace(/^data:image\/png;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    res.set('Content-Type', 'image/png');
    return res.send(buf);
  }

  const waitUntil = Date.now() + 10_000;
  while (Date.now() < waitUntil) {
    await new Promise(s => setTimeout(s, 300));
    r = getStatus();
    if (r.status === 'qr' && r.dataUrl) {
      const b64 = r.dataUrl.replace(/^data:image\/png;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      res.set('Content-Type', 'image/png');
      return res.send(buf);
    }
  }

  return res.status(425).json({ ok: false, status: getStatus().status || 'offline' });
});

// /api/status -> status simples
app.get('/api/status', (req, res) => {
  console.log(JSON.stringify({
    event: '📡 REQUEST',
    endpoint: '/api/status',
    timestamp: new Date().toISOString(),
    userId: req.query.userId || req.body?.userId || 'não informado',
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
    origin: req.headers['origin'] || 'não informado',
    referer: req.headers['referer'] || 'não informado',
    userAgent: req.headers['user-agent'] || 'não informado'
  }));
  res.set('Cache-Control', 'no-store');
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });

  const isConnected = connections.get(userId) === true;
  const qrInfo = lastQr.get(userId);
  const hasQr = !!qrInfo;
  const session = sessions.get(userId);
  const phoneNumber = extractPhoneNumber(session);
  let status = 'offline';
  if (isConnected) status = 'connected';
  else if (hasQr) status = 'qr';
  else if (sessions.get(userId)) status = 'reconnecting';

  res.json({
    ok: true,
    status,
    connected: isConnected,
    phone_number: phoneNumber,
    timestamp: new Date().toISOString(),
    ...(qrInfo && !isConnected ? {
      qr_base64: qrInfo.qr_base64,
      expires_in_seconds: qrInfo.expires_in_seconds,
      qr_timestamp: qrInfo.timestamp,
    } : {}),
  });
});

// /api/send -> envia mensagem (usa sessão do userId)
app.post('/api/send', async (req, res) => {
  try {
    const { userId, to, text } = req.body || {};
    if (!userId || !to || !text) {
      return res.status(400).json({ ok: false, error: 'MISSING_FIELDS', hint: 'Informe userId, to e text' });
    }

    const sock = sessions.get(userId);
    const isConnected = connections.get(userId) === true;
    if (!sock || !isConnected) {
      return res.status(400).json({ ok: false, error: 'NOT_CONNECTED', hint: 'Conecte via /api/qr primeiro' });
    }

    const digits = String(to).replace(/\D/g, '');
    if (digits.length < 10) {
      return res.status(400).json({ ok: false, error: 'INVALID_NUMBER', hint: 'Use 55DDDNUMERO (só dígitos)' });
    }
    const jid = `${digits}@s.whatsapp.net`;
    const result = await sock.sendMessage(jid, { text });

    return res.json({
      ok: true,
      sent: true,
      to: jid,
      messageId: result?.key?.id || null,
      remoteJid: result?.key?.remoteJid || jid,
      status: result?.status || null,
      messageTimestamp: result?.messageTimestamp || null,
      key: result?.key || null,
      result,
    });
  } catch (e) {
    console.error('send error', e);
    return res.status(500).json({ ok: false, error: 'SEND_FAILED' });
  }
});

// manutenção: disconnect (mantém creds)
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

// wipe: remove credenciais e força novo QR
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
      console.warn('Falha ao remover auth dir:', e?.message);
    }

    return res.json({ ok: true, wiped: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'WIPE_FAILED' });
  }
});

// restart: fecha e reabre (mantém credenciais)
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

// server listen
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`));

// Diretórios do sistema de arquivos que nunca são sessões válidas
const SYSTEM_DIRS = new Set(['lost+found', 'tmp', 'proc', 'sys', 'dev']);

// Auto-boot: reconecta todas as sessões salvas em disco
(async () => {
  try {
    const entries = fs.readdirSync(AUTH_BASE_DIR, { withFileTypes: true });
    const userIds = entries
      .filter(e => e.isDirectory() && !SYSTEM_DIRS.has(e.name) && !e.name.startsWith('.'))
      .map(e => e.name);
    if (userIds.length === 0) {
      console.log('ℹ️ Auto-boot: nenhuma sessão salva encontrada');
      return;
    }
    console.log(`🔄 Auto-boot: encontradas ${userIds.length} sessão(ões): ${userIds.join(', ')}`);
    await Promise.allSettled(
      userIds.map(userId =>
        startBot(userId)
          .then(() => console.log(`✅ Auto-boot: ${userId} iniciado`))
          .catch(err => console.error(`❌ Auto-boot: falha ao iniciar ${userId}:`, err?.message))
      )
    );
  } catch (err) {
    console.error('❌ Auto-boot: erro ao ler AUTH_BASE_DIR:', err?.message);
  }
})();
