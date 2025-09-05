// cors-allow.js — helper de CORS

function getAllowedFromEnv() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Domínios padrão permitidos
const defaultOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://localhost:3000',
  'https://usegenda.com',
  'https://www.usegenda.com',
  // Lovable
  /\.lovable\.dev$/,
  /\.lovable\.app$/,
  // Render (seu domínio *.onrender.com)
  /\.onrender\.com$/,
];

function isOriginAllowed(origin) {
  // Sem Origin (ex.: curl/healthz) -> permite
  if (!origin) return true;

  // Lista vinda do ambiente
  const allowedFromEnv = getAllowedFromEnv();
  if (allowedFromEnv.includes(origin)) return true;

  // Lista padrão (strings exatas ou regex)
  return defaultOrigins.some((o) =>
    o instanceof RegExp ? o.test(origin) : o === origin
  );
}

module.exports = { isOriginAllowed, defaultOrigins, getAllowedFromEnv };
