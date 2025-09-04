const { default: makeWASocket, useSingleFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const P = require('pino');
const Boom = require('@hapi/boom');
const express = require('express');

const { state, saveState } = useSingleFileAuthState('./auth_info.json');

let sock;

async function startBot() {
  sock = makeWASocket({
    logger: P({ level: 'silent' }),
    printQRInTerminal: true, // por enquanto; depois vamos expor via API para o Lovable
    auth: state,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const shouldReconnect =
        (lastDisconnect?.error && Boom.isBoom(lastDisconnect.error) &&
         lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut);

      console.log('🔌 Conexão encerrada. Reconectar?', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot conectado com sucesso!');
    }
  });

  sock.ev.on('creds.update', saveState);
}

/**
 * Servidor HTTP (obrigatório no Render)
 */
const app = express();
app.use(express.json());

// rota básica para o Render checar que está no ar
app.get('/', (_req, res) => {
  res.send('Genda WhatsApp Bot ✅ Online');
});

// healthcheck simples
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`);
  // inicia o bot quando o servidor subir
  startBot().catch((err) => {
    console.error('Erro ao iniciar o bot:', err);
    process.exit(1);
  });
});

// só para evitar que o processo morra silenciosamente
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));
