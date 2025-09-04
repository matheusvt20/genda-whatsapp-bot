// index.js
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
 * Memória de runtime
 */
const sessions = new Map();   // userId -> sock
const lastQr = new Map();     // userId -> { qr_base64, expires_in_seconds, timestamp }
const connections = new Map();// userId -> boolean

/**
 * Inicia (ou reinicia) um bot por userId
 */
async function startBot(userId) {
  // Evita criar 2x
  if (sessions.get(userId)) return sessions.get(userId);

  const authDir = `./auth_info/${userId}`;
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,   // vamos servir por HTTP
    auth: state,
  });

  // Atualiza credenciais
  sock.ev.on('creds.update', saveCreds);

  // Eventos de conexão/QR
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Quando o Baileys emite um QR novo, convertemos em PNG base64
    if (qr) {
      QRCode.toDataURL(qr, { errorCorrectionLevel: 'M' })
        .then((dataUrl) => {
          lastQr.set(userId, {
            qr_base64: dataUrl,               // pronto para <img src="...">
            expires_in_seconds: 60,           // QR do WhatsApp expira rápido
            timestamp: new Date().toISOString(),
          });
          connections.set(userId, false);
        })
        .catch((err) => {
          console.error('Erro ao gerar PNG do QR:', err);
        });
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
        // reconecta com leve atraso
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

// CORS: ajuste o domínio do seu front aqui (ou via env ALLOWED_ORIGINS)
const allowed = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Em teste, se ALLOWED_ORIGINS não for definido, libera localhost e o domínio padrão
const defaultOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://localhost:3000',
];
const origins = allowed.length ? allowed : defaultOrigins;

app.use(cors({ origin: origins }));

app.get('/', (_req, res) => {
  res.send('Genda WhatsApp Bot ✅ Online');
});

app.get('/healthz', (_req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

/**
 * Inicia uma sessão (ou confirma se já está iniciada)
 * Ex.: GET /api/connect?userId=ACCOUNT_DEMO_001
 */
app.get('/api/connect', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'MISSING_USER_ID' });

  try {
    await startBot(userId);
    return res.json({ ok: true, started: true, userId });
  } catch (err) {
    console.error('Erro /api/connect:', err);
    return res.status(500).json({ error: 'CONNECT_FAILED' });
  }
});

/**
 * Retorna o último QR disponível para a conta
 * Ex.: GET /api/qr?userId=ACCOUNT_DEMO_001
 */
app.get('/api/qr', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'MISSING_USER_ID' });

  const connected = !!connections.get(userId);
  const qrInfo = lastQr.get(userId);

  if (!qrInfo && !connected) {
    return res.status(404).json({ error: 'QR_NOT_READY', connected: false });
  }

  return res.json({ connected, ...(qrInfo || {}) });
});

/**
 * Status de conexão
 * Ex.: GET /api/status?userId=ACCOUNT_DEMO_001
 */
app.get('/api/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'MISSING_USER_ID' });

  return res.json({
    connected: !!connections.get(userId),
    timestamp: new Date().toISOString(),
  });
});

// Porta para Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`);
});
