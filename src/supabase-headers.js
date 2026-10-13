// Modern secret keys belong in apikey; they are not JWTs.
export function supabaseHeaders(key, extra = {}) {
  return { apikey: key, ...(!String(key).startsWith("sb_") ? { authorization: `Bearer ${key}` } : {}), ...extra };
}
