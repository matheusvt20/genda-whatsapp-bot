const { default: makeWASocket, useSingleFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const P = require('pino');
const express = require('express');

const { state, saveState } = useSingleFileAuthState('./auth_info.json');

let sock;

async function startBot() {
  sock = makeWASocket({
    logger: P({ level: 'silent' }),
    printQRInTerminal: true, // depois vamos expor via API
    auth: state,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      // se NÃO foi logout explícito, tenta reconectar
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('🔌 Conexão encerrada. Reconectar?', shouldReconnect, 'statusCode:', statusCode);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot conectado com sucesso!');
    }
  });

  sock.ev.on('creds.update', saveState);
}

/** Servidor HTTP (Render precisa de uma porta aberta) */
const app = express();
app.use(express.json());

app.get('/', (_req, res) => res.send('Genda WhatsApp Bot ✅ Online'));
app.get('/healthz', (_req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

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
