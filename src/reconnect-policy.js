export function computeReconnectDelayMs(attempt, options = {}) {
  const normalizedAttempt = Math.max(1, Number(attempt) || 1);
  const baseDelayMs = Math.max(1, Number(options.baseDelayMs) || 2_000);
  const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs) || 60_000);
  const jitterMs = Math.max(0, Number(options.jitterMs) || 0);
  const random = typeof options.random === "function" ? options.random : Math.random;
  const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * (2 ** (normalizedAttempt - 1)));
  const jitter = jitterMs > 0 ? Math.floor(random() * (jitterMs + 1)) : 0;

  return Math.min(maxDelayMs, exponentialDelay + jitter);
}

export function shouldResetReconnectAttempts(connectedAt, now, stableResetMs) {
  if (!Number.isFinite(connectedAt) || connectedAt <= 0) return false;
  return now - connectedAt >= stableResetMs;
}
