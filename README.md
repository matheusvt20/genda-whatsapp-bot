# Genda WhatsApp Bot

Servico Node/Baileys para Railway. Ele deve ser chamado por backend/Edge Functions
ou ferramentas internas com token. O frontend nao deve receber `BOT_INTERNAL_TOKEN`.

## Railway

Fonte de producao: `matheusvt20/genda-whatsapp-bot`, branch `main`, conectado
ao servico Railway `genda-whatsapp-bot`. O push no `main` dispara o deploy.
O Root Directory e a raiz deste repositorio, com seu `Dockerfile` e `railway.json`.
A copia `railway/whatsapp-bot` no monorepo do frontend nao e a fonte publicada.

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
SUPABASE_SERVICE_ROLE_KEY=... # accepts modern sb_secret keys (recommended) or legacy JWT
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
WHATSAPP_STATUS_OUTBOX_FAST_RETRY_MS=250
WHATSAPP_STATUS_OUTBOX_FAST_RETRY_ATTEMPTS=3
WHATSAPP_STATUS_OUTBOX_MAX_ATTEMPTS=8
WHATSAPP_STATUS_OUTBOX_FLUSH_BATCH_SIZE=10
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

As credenciais validas do volume sao a fonte principal para reconexao. O backup
no Storage so e restaurado se o arquivo local estiver ausente ou invalido, para
nao retroceder contadores de chaves enquanto os arquivos Signal permanecem mais
recentes. Gravacoes de credenciais e eventos de conexao sao ordenados por sessao.
Falhas no backup remoto preservam o estado local.

Um `401` com `conflict` sem indicacao de `device_removed` recebe uma tentativa
automatica de recuperacao, preservando a autorizacao. Conflito repetido exige
acao do usuario e nao entra em loop. `device_removed` ou uma falha `401` sem
conflito continuam encerrando uma autorizacao revogada. O campo
`device_info.disconnect` registra apenas codigo, motivo e tipo de conflito,
sem credenciais. O health identifica esta revisao por
`checks.session_recovery_version = "2026-10-12"`.

## Diagnostico e prevencao de desconexoes

O diario `SESSION_DIR/connection-diagnostics/YYYY-MM-DD.ndjson` registra eventos
por conta, instancia e deployment. Com `/data`, os registros sobrevivem ao
reinicio do servico. A retencao e de 30 dias, com limite de 2 MiB por dia e 1000
gravacoes pendentes. Arquivos tem permissao `0600`; falhas de gravacao e descartes
aparecem no health. A falha do diario nao interrompe a conexao ou envio.

Eventos incluem abertura/queda, codigo nativo de fechamento do WebSocket, codigo
de erro de rede, resposta HTTP do transporte, motivo de stream do WhatsApp,
reconexoes, restauracao/limpeza da autorizacao e recuperacoes iniciadas pelo
Genda. Memoria e uptime sao capturados no evento; CPU e atraso do event loop
sao amostrados a cada 30 segundos. O diario nao recebe mensagens, numeros de
telefone, QR, tokens, chaves, headers ou motivos como texto livre.

`cause=internal_action` identifica uma acao do bot; `device_removed` indica
revogacao informada pelo WhatsApp, sem identificar quem a fez. `session_conflict`
e `provider_stream_error` conservam o sinal fornecido pelo provedor. Um `428`
sem outra evidencia recebe `transport_closed_unknown`: nao prova problema no
celular, notebook, rede ou Railway. `transport_failure` indica erro observado
no transporte, sem atribuir a origem da falha. O historico comeca nesta versao;
ele nao recupera detalhes que o codigo anterior deixou de registrar.

Tres quedas na mesma conta em 10 minutos aplicam uma pausa de pelo menos 30
segundos, aumentando ate 5 minutos. O backoff existente continua valendo se
for maior. A protecao e independente por conta, preserva credenciais e retoma
automaticamente. O restart `515` do pareamento e os encerramentos de deploy
nao entram nessa contagem. As quedas recentes sao recuperadas do diario apos
reinicio. Revogacoes reais continuam exigindo novo QR.

SIGTERM/SIGINT registram encerramento, drenam eventos pendentes e encerram os
sockets sem gravar uma desconexao no banco ou apagar autorizacao. Isso permite
que o deployment seguinte restaure as contas conectadas. Encerramentos forcados
podem nao produzir o marcador final; o inicio seguinte registra se o marcador
anterior foi observado.

No `/health`, `checks.connection_diagnostics.version = "2026-10-12.1"` identifica
a versao e informa persistencia, falhas e descartes. `checks.session_alerts`
informa contagens de contas com quedas repetidas, em reconexao e precisando QR.
Pressao de memoria (>768 MiB) ou atraso do processo (>1 segundo) gera evento
`health_warning`, sem reiniciar sessoes saudaveis. Esses sinais ficam no diario
e nos logs do Railway; esta versao nao envia notificacoes externas.

### GET /api/diagnostics

Exige o token interno, como as outras rotas sensiveis. Filtros opcionais:
`sessionKey` (UUID da conta), `since` (data ISO) e `limit` (1 a 1000, padrao 200).
Por padrao consulta o ultimo dia. Retorna `{ ok, journal, events }`; datas e
arquivos usam UTC. Para diagnosticar uma conta, leia `session_closed`, os eventos
de transporte e recuperacao proximos, depois `reconnect_scheduled` e
`session_connected`. `downtime_ms` mede a interrupcao ate reabrir, inclusive
entre tentativas consecutivas dentro do mesmo processo.

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
npm ci
npm test
SUPABASE_URL=https://spbjyryzvzrqfpyiqsuy.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=... # accepts modern sb_secret keys (recommended) or legacy JWT \
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
