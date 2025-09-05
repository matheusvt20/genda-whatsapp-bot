# Genda WhatsApp Bot

Bot de integração do WhatsApp com o sistema **Genda**, usando Baileys (https://github.com/WhiskeySockets/Baileys).

---

## Variáveis de ambiente

- **ALLOWED_ORIGINS** (opcional): lista separada por vírgula com domínios que podem acessar a API via CORS.
  Exemplo:
      ALLOWED_ORIGINS=https://usegenda.com,https://www.usegenda.com,https://meuapp.lovable.app
  Dica: se o domínio da Lovable mudar (ex.: ".lovable.dev" para staging), adicione aqui ou use as regex já previstas no código (/\.lovable\.dev$/, /\.lovable\.app$/).

- **AUTH_BASE_DIR** (opcional): diretório raiz onde as credenciais do WhatsApp (Baileys) são salvas.
  - No Render, configure para: /data/auth_info (ao usar disco persistente).

- **PORT**: porta em que o servidor roda (o Render define automaticamente).

---

## Endpoints principais

- GET /api/qr?userId=<id>  → Retorna QR Code (base64) ou status da sessão.
- GET /api/status?userId=<id>  → Mostra se o WhatsApp está connected, qr ou offline.
- GET /api/disconnect?userId=<id>  → Desconecta e limpa a sessão do usuário.
- GET /healthz  → Verificação de saúde.

---

## Persistência

- Sem disco persistente no Render, as sessões são perdidas a cada deploy/restart.
- Recomenda-se ativar um Persistent Disk no Render e usar: AUTH_BASE_DIR=/data/auth_info

---

## Segurança

- Avalie proteger os endpoints com autenticação (ex.: token JWT do Supabase).
- Evite expor o serviço publicamente sem controle.

---

## Desenvolvimento local

    npm install
    npm start
    # API em http://localhost:3000
