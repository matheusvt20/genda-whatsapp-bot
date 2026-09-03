# Genda WhatsApp Bot

Servico Node/Baileys para Railway. Ele deve ser chamado por backend/Edge Functions
ou ferramentas internas com token. O frontend nao deve receber `BOT_INTERNAL_TOKEN`.

## Railway

Root Directory:

```txt
railway/whatsapp-bot
```

Deploy local recomendado:

```bash
railway up railway/whatsapp-bot --path-as-root -s genda-whatsapp-bot --detach
```

O diretorio do bot tem `Dockerfile` proprio. Use `--path-as-root` para que o
Railway leia `railway/whatsapp-bot/railway.json` e nao tente empacotar o
monorepo inteiro.

Start Command:

```bash
npm start
```

Volume:

```txt
Mount path: /data
```

## Variaveis de ambiente

```txt
SUPABASE_URL=https://spbjyryzvzrqfpyiqsuy.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
BOT_INTERNAL_TOKEN=...
PORT=3000
SESSION_DIR=/data
```

Opcional:

```txt
SUPABASE_FUNCTIONS_URL=https://spbjyryzvzrqfpyiqsuy.supabase.co/functions/v1
WHATSAPP_HISTORY_SYNC_ENABLED=true
WHATSAPP_HISTORY_SYNC_LOOKBACK_MS=172800000
WHATSAPP_HISTORY_SYNC_MAX_MESSAGES=250
WHATSAPP_MEDIA_RETENTION_MS=1296000000
WHATSAPP_MEDIA_CLEANUP_INTERVAL_MS=3600000
WHATSAPP_PIPELINE_CONTACT_CACHE_MS=60000
WHATSAPP_OPPORTUNITY_APPOINTMENT_SYNC_ENABLED=true
WHATSAPP_DECRYPT_SOFT_RECONNECT_MAX_ATTEMPTS=1
WHATSAPP_DECRYPT_SOFT_RECONNECT_COOLDOWN_MS=300000
WHATSAPP_DECRYPT_RECOVERY_RESET_MS=1800000
WHATSAPP_MESSAGE_LISTENER_STALE_MS=45000
WHATSAPP_MESSAGE_LISTENER_SOFT_RECONNECT_MAX_ATTEMPTS=1
WHATSAPP_MESSAGE_LISTENER_SOFT_RECONNECT_COOLDOWN_MS=300000
WHATSAPP_MESSAGE_LISTENER_RECOVERY_RESET_MS=1800000
WHATSAPP_BAILEYS_LOG_LEVEL=warn
WHATSAPP_RECONNECT_BASE_DELAY_MS=2000
WHATSAPP_RECONNECT_MAX_DELAY_MS=60000
WHATSAPP_RECONNECT_JITTER_MS=1000
WHATSAPP_RECONNECT_STABLE_RESET_MS=120000
```

As midias das conversas sao salvas no bucket privado `whatsapp-media`, recebem
URL assinada e sao excluidas fisicamente apos 15 dias. A limpeza roda ao iniciar
o bot e depois a cada hora. Se o Storage estiver indisponivel, o envio continua
usando o cache temporario como fallback.

As reconexoes usam backoff exponencial com jitter. Isso impede que uma queda
transitoria do WhatsApp crie varios sockets em sequencia, consuma CPU ou leve o
Railway a encerrar o servico depois de repetidas falhas.

## Endpoints

Rotas sensiveis exigem:

```txt
Authorization: Bearer BOT_INTERNAL_TOKEN
```

Tambem e aceito:

```txt
x-bot-signature: BOT_INTERNAL_TOKEN
```

### GET /health

Nao exige token.

Resposta:

```json
{ "ok": true }
```

### POST /api/session/start

Body:

```json
{ "sessionKey": "USER_ID" }
```

Resposta:

```json
{
  "ok": true,
  "success": true,
  "connected": false,
  "status": "qr_pending",
  "qr": "string-do-qr",
  "phone": null
}
```

### GET /api/session/status?sessionKey=USER_ID

Retorna `connected`, `qr_pending`, `disconnected`, `reconnecting` ou `error`.

### POST /api/message/send

Body:

```json
{
  "sessionKey": "USER_ID",
  "to": "5521999999999",
  "text": "mensagem"
}
```

Alias compativel para Edge Function antiga:

```txt
POST /api/send
```

## Persistencia

As credenciais Baileys ficam em:

```txt
SESSION_DIR/baileys-sessions/USER_ID
```

Com `SESSION_DIR=/data`, a sessao fica no volume persistente do Railway.

## Recebimento de mensagens

O listener `messages.upsert`:

- ignora grupos, status/broadcast e newsletters;
- grava mensagens recebidas e mensagens `fromMe` com texto ou midia;
- deduplica por `sessionKey + jid + messageId` em memoria;
- envia inbound para `whatsapp-inbound-webhook`.

Ao reconectar, o bot tambem aceita o `RECENT` history sync do Baileys. Esse catch-up:

- processa apenas historico recente, por padrao as ultimas 48h;
- importa apenas mensagens de contatos que ja estao no pipeline da usuaria (`crm_leads` ou `whatsapp_conversations` vinculadas a lead);
- respeita contatos ocultados em Oportunidades;
- limita o lote por sessao, por padrao 250 mensagens;
- reaproveita o mesmo webhook e a deduplicacao por `whatsapp_message_id`, evitando duplicatas no Supabase;
- nao habilita `syncFullHistory`, para evitar importar todo o historico da conta.

Quando uma sessao abre apos QR novo, o bot tambem reconcilia as oportunidades
visiveis do pipeline com agendamentos ativos (`agendado`, `confirmado` ou
`pendente`). Se uma lead/conversa ja estava no pipeline e o contato tem
agendamento ativo, a lead e movida para `Agendada`. Contatos ocultados e
clientes que nao estao no pipeline nao sao importados.

## Recuperacao de descriptografia

Quando o Baileys recebe uma rajada de erros de chave (`No matching sessions`,
`Invalid PreKey ID`, etc.), o bot primeiro tenta um soft reconnect da sessao.
Somente se o erro continuar apos a tentativa configurada ele marca a conexao
como desconectada e exige novo QR.

## Recuperacao do listener de mensagens

O status `connected` tambem depende do pipeline de recebimento. Quando o
Baileys mostra sinal baixo nivel de mensagem (`peer_msg`), mas o listener
`messages.upsert` nao entrega evento recente, o endpoint de status dispara um
soft reconnect da sessao. Se a sessao continuar sem entregar eventos apos a
tentativa configurada, o status passa a `needs_reconnect`, evitando que o app
mostre WhatsApp conectado enquanto mensagens novas nao chegam ao Genda.

Payload enviado:

```json
{
  "session_key": "USER_ID",
  "message_id": "ID_WHATSAPP",
  "whatsapp_message_id": "ID_WHATSAPP",
  "whatsapp_jid": "5521999999999@s.whatsapp.net",
  "contact_phone": "5521999999999",
  "contact_name": "Nome do WhatsApp",
  "body": "texto",
  "message_type": "text",
  "timestamp": "2026-05-22T12:00:00.000Z",
  "direction": "inbound"
}
```

Headers para a Edge Function:

```txt
Authorization: Bearer BOT_INTERNAL_TOKEN
x-bot-signature: BOT_INTERNAL_TOKEN
```

## Teste local

```bash
cd railway/whatsapp-bot
npm install
SUPABASE_URL=https://spbjyryzvzrqfpyiqsuy.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=... \
BOT_INTERNAL_TOKEN=... \
SESSION_DIR=/tmp/genda-whatsapp-sessions \
npm start
```

Health:

```bash
curl -s http://localhost:3000/health
```

Iniciar sessao:

```bash
curl -s -X POST http://localhost:3000/api/session/start \
  -H "Authorization: Bearer $BOT_INTERNAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sessionKey":"USER_ID_DE_TESTE"}'
```

Status/QR:

```bash
curl -s "http://localhost:3000/api/session/status?sessionKey=USER_ID_DE_TESTE" \
  -H "Authorization: Bearer $BOT_INTERNAL_TOKEN"
```
