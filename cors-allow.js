// cors-allow.js
// Lógica de "origin permitido" extraída para facilitar testes

function getAllowedFromEnv() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const defaultOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://localhost:3000',
  'https://usegenda.com',
  'https://www.usegenda.com',
  /\.lovable\.dev$/,
  /\.lovable\.app$/,
];

function isOriginAllowed(origin) {
  if (!origin) return true; // ex.: curl/healthz
  const allowedFromEnv = getAllowedFromEnv();
  if (allowedFromEnv.includes(origin)) return true;
  return defaultOrigins.some((o) =>
    o instanceof RegExp ? o.test(origin) : o === origin
  );
}

module.exports = { isOriginAllowed, defaultOrigins, getAllowedFromEnv };
