const AD_FIELDS = ["title", "body", "source_type", "source_id", "source_url", "media_type", "media_url", "thumbnail_url", "thumbnail_data", "ctwa_clid"];
const adMask = ad => AD_FIELDS.reduce((mask, key, index) => mask | (ad?.[key] != null && ad[key] !== "" ? 1 << index : 0), 0);

// Deduplica a mensagem, mas permite que o mesmo ID complete a origem do anúncio.
// Guarda só uma máscara de campos, nunca o Click ID nem o criativo no cache.
export function createMessageDeliveryTracker(limit = 5000) {
  const delivered = new Map();
  const pending = new Map();
  return {
    async forward(key, ad, send) {
      while (pending.has(key)) await pending.get(key).catch(() => {});
      const mask = adMask(ad);
      if (delivered.has(key) && (mask & ~delivered.get(key)) === 0) return false;
      const task = Promise.resolve().then(send);
      pending.set(key, task);
      try {
        await task;
        delivered.set(key, (delivered.get(key) ?? 0) | mask);
        if (delivered.size > limit) delivered.delete(delivered.keys().next().value);
        return true;
      } finally {
        if (pending.get(key) === task) pending.delete(key);
      }
    },
  };
}
