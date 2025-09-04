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
} = require('@whiskeysockets/baileys');

/**
 * Memória de runtime (simples para MVP)
 * Dica: em produção grande, considere Redis/DB para cluster/escala.
 */
const sessions = new Map();    // userId -> sock
const lastQr = new Map();      // userId -> { qr_base64, expires_in_seconds, timestamp }
const connections = new Map(); // userId -> boolean (true=conectado)

/**
 * Inicia (ou recupera) uma sessão de bot para um userId
 */
async function startBot(userId) {
  // Evita recriar se já existir
  if (sessions.get(userId)) return sessions.get(userId);

  const authDir = `./auth_info/${userId}`; // Render tem disco efêmero; ok para testes.
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    logger: P({ level: 'silent' }),
    printQRInTerminal: false, // vamos servir o QR via HTTP (base64)
    auth: state,
  });

  // Atualiza credenciais quando mudarem
  sock.ev.on('creds.update', saveCreds);

  // Eventos de conexão e QR
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // QR novo — converte para PNG base64
      QRCode.toDataURL(qr, { errorCorrectionLevel: 'M' })
        .then((dataUrl) => {
          lastQr.set(userId, {
            qr_base64: dataUrl,             // pronto para <img src="...">
            expires_in_seconds: 60,         // QR expira rápido
            timestamp: new Date().toISOString(),
          });
          connections.set(userId, false);
        })
        .catch((err) => console.error('Erro ao gerar PNG do QR:', err));
    }

    if (connection === 'open') {
      connections.set(userId, true);
      lastQr.delete(userId); // conectado => não precisamos mais do QR
      console.log(`✅ ${userId} conectado com sucesso!`);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      connections.set(userId, false);
      console.log(
        '🔌 Conexão encerrada',
        userId,
        'reconectar?',
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
 * -----------------------
 * Servidor HTTP (Express)
 * -----------------------
 */
const app = express();
app.use(express.json());

// ----------- CORS COMPLETO -----------
const allowedOrigins = [
  'https://usegenda.com',
  'http://localhost:3000',
  'http://localhost:5173',
  'https://localhost:3000',
  // adicione abaixo o seu domínio de preview do Lovable (se tiver):
  // 'https://seu-projeto.lovable.dev',
];
const lovableRegex = /^https:\/\/[a-z0-9-]+\.lovable\.dev$/i;

app.use(cors({
  origin: function (origin, callback) {
    // permitir requests sem Origin (abrir a URL direto no navegador)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || lovableRegex.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS: ' + origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'apikey', 'Prefer'],
  credentials: false,
}));

// Preflight para qualquer rota
app.options('*', cors());

// ----------- HEALTH/ROOT -----------
app.get('/', (_req, res) => {
  res.send('Genda WhatsApp Bot ✅ Online');
});

app.get('/healthz', (_req, res) =>
  res.json({ ok: true, timestamp: new Date().toISOString() })
);

/**
 * Inicia uma sessão (ou confirma se já está iniciada)
 * GET /api/connect?userId=XYZ
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
 * Retorna o último QR disponível
 * GET /api/qr?userId=XYZ
 *
 * CONTRATO (para o front do Genda/Lovable):
 * - Se houver QR: { ok:true, status:"qr", qr:"data:image/png;base64,..." }
 * - Se já estiver conectado: { ok:true, status:"connected" }
 * - Se ainda não gerou QR e não conectado: { ok:false, status:"offline" }
 */
app.get('/api/qr', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });

  const isConnected = !!connections.get(userId);
  const qrInfo = lastQr.get(userId);

  if (isConnected) {
    return res.json({ ok: true, status: 'connected' });
  }

  if (qrInfo && qrInfo.qr_base64) {
    return res.json({ ok: true, status: 'qr', qr: qrInfo.qr_base64 });
  }

  return res.status(404).json({ ok: false, status: 'offline' });
});

/**
 * Status de conexão
 * GET /api/status?userId=XYZ
 *
 * CONTRATO (para o front):
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
  else if (qrInfo && qrInfo.qr_base64) status = 'qr';

  return res.json({
    ok: true,
    service: 'whatsapp-bot',
    status,
    timestamp: new Date().toISOString(),
  });
});

// Porta para Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`);
});
