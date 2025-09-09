# Genda WhatsApp Bot

Bot de integração do WhatsApp com o sistema **Genda**, baseado em [Baileys](https://github.com/WhiskeySockets/Baileys).  
Permite conectar números pessoais via QR Code, armazenar credenciais em disco persistente e enviar mensagens automáticas.

---

## ⚙️ Variáveis de ambiente

- **ALLOWED_ORIGINS** (opcional): lista separada por vírgula com domínios que podem acessar a API via CORS.  

  Exemplo:  
  ALLOWED_ORIGINS=https://usegenda.com,https://www.usegenda.com,https://meuapp.lovable.app  

  Dica: se o domínio da Lovable mudar (ex.: `.lovable.dev` para staging), adicione aqui ou use as regex já previstas no código (`/\.lovable\.dev$/`, `/\.lovable\.app$/`).

- **AUTH_BASE_DIR**: diretório raiz onde as credenciais do WhatsApp (Baileys) são salvas.  
  - No Render, configure para:  
    AUTH_BASE_DIR=/data

- **PORT**: porta em que o servidor roda (o Render define automaticamente).

---

## 🔑 Endpoints principais

### Gerar QR Code
Abrir no navegador e escanear:  
https://genda-whatsapp-bot.onrender.com/api/qr.png?userId=matheus

### Status da sessão
Exemplo de requisição:  
curl "https://genda-whatsapp-bot.onrender.com/api/status?userId=matheus"  
Retorna: `connected`, `qr` ou `offline`.

### Enviar mensagem
curl -X POST https://genda-whatsapp-bot.onrender.com/api/send \
  -H "Content-Type: application/json" \
  -d '{"userId":"matheus","to":"5521983405061","text":"Genda Bot ✅ mensagem de teste"}'

### Wipe (apagar credenciais e pedir novo QR)
curl -X POST https://genda-whatsapp-bot.onrender.com/api/wipe \
  -H "Content-Type: application/json" \
  -d '{"userId":"matheus"}'

---

## 💾 Persistência

- Sem disco persistente no Render, as sessões são perdidas a cada deploy/restart.  
- É obrigatório ativar um **Persistent Disk** no Render e usar:  
  AUTH_BASE_DIR=/data  
- As credenciais ficam salvas em `/data/<userId>` e são reaproveitadas automaticamente após restart/deploy.

---

## 🔒 Segurança

- Avalie proteger os endpoints com autenticação (ex.: token JWT do Supabase).  
- Evite expor o serviço publicamente sem controle.  
- Cada `userId` deve ser único (ex.: `matheus`, `carol`, etc.).

---

## 🛠️ Desenvolvimento local

npm install  
npm start  
# API disponível em http://localhost:3000

---

## 📌 Operação rápida (dia a dia)

1. **Primeira conexão**  
   - Chame `/api/wipe` → gera novo QR.  
   - Abra `/api/qr.png?userId=<id>` no navegador.  
   - Escaneie com o celular → aparece `✅ <userId> CONECTADO!` nos logs.

2. **Verificar status**  
   curl "https://genda-whatsapp-bot.onrender.com/api/status?userId=<id>"

3. **Enviar mensagem**  
   curl -X POST https://genda-whatsapp-bot.onrender.com/api/send \
     -H "Content-Type: application/json" \
     -d '{"userId":"<id>","to":"55DDDNUMERO","text":"Mensagem de teste"}'

---

## 🛠️ Rotas de manutenção

- **/api/disconnect** → Desconecta mas mantém credenciais.  
- **/api/wipe** → Apaga credenciais e gera novo QR.  
- **/api/restart** → Reinicia a sessão mantendo as credenciais.  

---

## 📖 Notas finais

- Após deploy/restart, se as credenciais já existirem em `/data`, o bot reconecta automaticamente sem pedir QR.  
- Se o celular ficar offline, o bot tenta reconectar sozinho.  
- Para “começar do zero”, use `wipe`.  
