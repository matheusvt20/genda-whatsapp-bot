// cors-allow.js
// Lógica de "origin permitido" extraída para facilitar testes

function getAllowedFromEnv() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const defaultOrigins = [
  // testes locais
  'http://localhost:3000',
  'http://localhost:5173',
  'https://localhost:3000',

  // domínio da aplicação
  'https://usegenda.com',
  'https://www.usegenda.com',

  // Lovable
  /\.lovable\.dev$/,
  /\.lovable\.app$/,
  /\.lovableproject\.com$/,   // ✅ permite qualquer subdomínio .lovableproject.com

  // Render
  /\.onrender\.com$/,
];

function isOriginAllowed(origin) {
  if (!origin) return true;           // ex.: curl/healthz
  if (origin === 'null') return true; // file:// (HTML local)
  if (origin.startsWith('file://')) return true;

  const allowedFromEnv = getAllowedFromEnv();
  if (allowedFromEnv.includes(origin)) return true;

  return defaultOrigins.some((o) =>
    o instanceof RegExp ? o.test(origin) : o === origin
  );
}

module.exports = { isOriginAllowed, defaultOrigins, getAllowedFromEnv };
