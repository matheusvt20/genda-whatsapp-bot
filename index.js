const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const P = require('pino');
const express = require('express');
const cors = require('cors');

let sock;

async function startBot() {
  // usa pasta "auth_info" para salvar a sessão
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

  sock = makeWASocket({
    logger: P({ level: 'silent' }),
    auth: state,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('🔌 Conexão encerrada. Reconectar?', shouldReconnect, 'statusCode:', statusCode);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot conectado com sucesso!');
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// servidor HTTP (Render precisa de uma porta aberta)
const app = express();
app.use(express.json());

// 🔹 Configuração de CORS
app.use(cors({
  origin: [
    'https://usegenda.com',   // domínio do seu front Lovable
    'http://localhost:3000'   // para testes locais
  ],
  methods: ['GET', 'POST'],
  credentials: true
}));

// rotas simples
app.get('/', (_req, res) => res.send('Genda WhatsApp Bot ✅ Online'));
app.get('/healthz', (_req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

// rota exemplo para Lovable testar conexão
app.get('/api/status', (req, res) => {
  res.json({
    connected: !!sock,
    timestamp: new Date().toISOString()
  });
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
