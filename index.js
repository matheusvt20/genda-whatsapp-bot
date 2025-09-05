// index.js — Genda WhatsApp Bot (QR UI incluído)

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

  sock.ev.on('auth-state.update', (s) =>
    console.log(`🔐 auth-state ${userId}:`, s?.credsRegistered ? 'credsRegistered' : 'carregando')
  );
  sock.ev.on('messaging-history.set', () => console.log(`🗂️ history set ${userId}`));

  sessions.set(userId, sock);
  return sock;
}

const app = express();
app.use(express.json());

// CORS usando helper testável
const corsOptions = {
  origin(origin, cb) {
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
      qr_base64: qrInfo.qr_base64,  // importante para exibir a imagem
      expires_in_seconds: qrInfo.expires_in_seconds,
      timestamp: qrInfo.timestamp,
    };
  }

  return { ok: false, status: 'offline', connected: false };
}

// 🔗 /api/qr — inicia sessão (se preciso) e aguarda até 10s por um QR
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

// ▶️ Envio de mensagem: POST /api/send
// Body JSON: { "userId": "ID_DONO_SESSAO", "to": "55DDDNUMERO", "text": "sua mensagem" }
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

// 🔁 Reiniciar sessão (sem perder credenciais) — força reemissão de QR
app.post('/api/restart', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });

    const sock = sessions.get(userId);
    try { sock?.ws?.close(); } catch {}
    sessions.delete(userId);
    connections.delete(userId);
    lastQr.delete(userId);

    await startBot(userId);
    return res.json({ ok: true, restarted: true, userId });
  } catch (e) {
    console.error('restart error', e);
    return res.status(500).json({ ok: false, error: 'RESTART_FAILED' });
  }
});

// 🧹 Wipe de credenciais (apaga pasta auth_info/<userId>) — use se der 401 device_removed
app.get('/api/wipe', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });

  const dir = path.join(AUTH_BASE_DIR, userId);

  // encerra sessão em memória
  const sock = sessions.get(userId);
  try { sock?.ws?.close(); } catch {}
  sessions.delete(userId);
  connections.delete(userId);
  lastQr.delete(userId);

  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
    return res.json({ ok: true, wiped: true, userId, dir });
  } catch (e) {
    console.error('wipe error', e);
    return res.status(500).json({ ok: false, error: 'WIPE_FAILED' });
  }
});

// 🩺 Diagnóstico simples
app.get('/api/diag', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });

  const hasSession = sessions.has(userId);
  const connected = !!connections.get(userId);
  const qrInfo = lastQr.get(userId);
  const now = Date.now();
  const ageSec = qrInfo?.timestamp ? Math.floor((now - Date.parse(qrInfo.timestamp)) / 1000) : null;

  res.json({
    ok: true,
    userId,
    hasSession,
    connected,
    hasQr: !!qrInfo,
    qrAgeSec: ageSec,
    qrExpiresInSec: qrInfo?.expires_in_seconds ?? null,
    authBaseDir: AUTH_BASE_DIR,
  });
});

// 🌐 Página simples que exibe o QR automaticamente: GET /qr-ui?userId=<id>
app.get('/qr-ui', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  const uiUserId = String(req.query.userId || '').trim();

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>QR WhatsApp - Genda</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;display:flex;flex-direction:column;align-items:center;gap:16px;padding:24px}
  header{display:flex;gap:8px;align-items:center}
  input,button{font-size:16px;padding:8px 12px}
  img{width:300px;height:300px;image-rendering:pixelated;border:1px solid #ddd;border-radius:8px;background:#fff}
  code{background:#f6f8fa;padding:2px 6px;border-radius:6px}
  .muted{color:#666}
</style>
</head>
<body>
  <h1>QR Code do WhatsApp</h1>

  <header>
    <label>userId:</label>
    <input id="uid" value="${uiUserId || 'matheus'}" placeholder="seu userId" />
    <button id="go">Abrir</button>
    <button id="restart">Reiniciar sessão</button>
    <button id="wipe">Wipe credenciais</button>
  </header>

  <div id="status" class="muted">Carregando...</div>
  <img id="qr" alt="QR Code" />

<script>
const $ = (id) => document.getElementById(id);
const uidInput = $("uid");
const statusEl = $("status");
const img = $("qr");

$("go").onclick = () => {
  const v = uidInput.value.trim();
  if (!v) return alert("Informe um userId");
  location.search = "?userId=" + encodeURIComponent(v);
};

$("restart").onclick = async () => {
  const v = uidInput.value.trim();
  if (!v) return alert("Informe um userId");
  statusEl.textContent = "Reiniciando sessão...";
  try {
    await fetch("/api/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: v })
    });
    setTimeout(loadLoop, 400);
  } catch {}
};

$("wipe").onclick = async () => {
  const v = uidInput.value.trim();
  if (!v) return alert("Informe um userId");
  statusEl.textContent = "Limpando credenciais...";
  try {
    await fetch("/api/wipe?userId=" + encodeURIComponent(v));
    setTimeout(loadLoop, 400);
  } catch {}
};

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  try { return await res.json(); } catch { return {}; }
}

async function loadOnce() {
  const userId = uidInput.value.trim();
  if (!userId) {
    statusEl.textContent = "Informe um userId e clique em Abrir.";
    return;
  }
  const qrData = await fetchJson("/api/qr?userId=" + encodeURIComponent(userId));
  if (qrData.status === "qr" && qrData.qr_base64) {
    img.src = qrData.qr_base64;
    img.style.display = "";
    statusEl.textContent = "Escaneie: WhatsApp → Aparelhos conectados → Conectar aparelho.";
    return;
  }
  if (qrData.status === "connected") {
    img.style.display = "none";
    statusEl.textContent = "Conectado ✅";
    return;
  }
  statusEl.textContent = "Aguardando QR...";
}

async function loadLoop() {
  await loadOnce();
  const userId = uidInput.value.trim();
  if (!userId) return;
  const st = await fetchJson("/api/status?userId=" + encodeURIComponent(userId));
  if (st.connected) {
    img.style.display = "none";
    statusEl.textContent = "Conectado ✅";
  } else {
    setTimeout(loadLoop, 1200);
  }
}

loadLoop();
</script>
</body>
</html>`;

  res.send(html);
});

// Desconectar/resetar sessão (apaga só em memória; faz logout se possível)
app.get('/api/disconnect', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });

  const sock = sessions.get(userId);
  if (sock) {
    try {
      await Promise.resolve(sock.logout?.()).catch(() => {});
    } catch (_) {}
    try { sock?.ws?.close(); } catch {}
    sessions.delete(userId);
    connections.delete(userId);
    lastQr.delete(userId);
    return res.json({ ok: true, disconnected: true, userId });
  }
  return res.json({ ok: false, error: 'NO_ACTIVE_SESSION' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`));
