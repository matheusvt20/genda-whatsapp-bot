export function computeStatusOutboxRetryDelay(
  attempt,
  {
    fastRetryMs,
    fastRetryAttempts,
    retryBaseMs,
    retryMaxMs,
  },
) {
  if (attempt <= fastRetryAttempts) return fastRetryMs;

  const exponent = Math.max(0, Math.min(attempt - fastRetryAttempts - 1, 10));
  return Math.min(retryBaseMs * (2 ** exponent), retryMaxMs);
}
