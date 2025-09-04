const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const P = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const cors = require('cors');

let sock;
let isConnected = false;
let latestQR = null;
let latestQRAt = 0;
const qrWaiters = [];

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

  sock = makeWASocket({
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      latestQRAt = Date.now();
      while (qrWaiters.length) {
        const resolve = qrWaiters.shift();
        try { resolve(qr); } catch {}
      }
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('🔌 Conexão encerrada. Reconectar?', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      isConnected = true;
      console.log('✅ Bot conectado com sucesso!');
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

/** ---------------- Servidor HTTP ---------------- */
const app = express();
app.use(express.json());
app.use(cors());

app.get('/', (_req, res) => res.send('Genda WhatsApp Bot ✅ Online'));
app.get('/healthz', (_req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

// Ver status da sessão
app.get('/session/status', (_req, res) => {
  res.json({
    connected: isConnected,
    hasRecentQR: !!latestQR && (Date.now() - latestQRAt < 60_000),
  });
});

// Criar QR Code em Base64
app.get('/session/create', async (_req, res) => {
  try {
    if (!sock) startBot().catch((e) => console.error('Erro ao iniciar:', e));

    const hasRecentQR = latestQR && (Date.now() - latestQRAt < 60_000);

    const qrString = hasRecentQR
      ? latestQR
      : await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('timeout')), 20_000);
          qrWaiters.push((qr) => {
            clearTimeout(timeout);
            resolve(qr);
          });
        });

    const dataUrl = await QRCode.toDataURL(qrString, { width: 320, errorCorrectionLevel: 'M' });
    res.json({ connected: isConnected, qr_base64: dataUrl, expires_in_seconds: 60 });
  } catch (e) {
    res.status(504).json({ error: 'QR ainda não disponível', details: String(e?.message || e) });
  }
});

// Enviar mensagem de teste
app.post('/sendMessage', async (req, res) => {
  try {
    if (!isConnected || !sock) return res.status(503).json({ error: 'Sessão não conectada' });

    const { to, message } = req.body || {};
    if (!to || !message) return res.status(400).json({ error: 'Informe "to" e "message"' });

    const digits = String(to).replace(/\D/g, '');
    const jid = `${digits}@s.whatsapp.net`;

    await sock.sendMessage(jid, { text: message });
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro /sendMessage:', e);
    res.status(500).json({ error: 'Falha ao enviar mensagem', details: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`);
  startBot().catch((err) => {
    console.error('Erro ao iniciar o bot:', err);
    process.exit(1);
  });
});

process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));
