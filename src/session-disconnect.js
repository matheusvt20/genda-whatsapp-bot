function safeLabel(value) {
  return typeof value === "string" && /^[a-z0-9_-]{1,64}$/i.test(value) ? value : null;
}

export function disconnectDiagnostics(error, statusCode) {
  const data = error?.data;
  const reasonNode = data?.tag === "stream:error"
    ? (Array.isArray(data.content) ? data.content.find((child) => child?.tag) : null)
    : data;
  const streamReason = safeLabel(reasonNode?.tag)
    || (/^Stream Errored \(([a-z0-9_-]+)\)$/.exec(error?.message || "")?.[1] ?? null);
  return {
    status_code: Number.isInteger(statusCode) ? statusCode : null,
    stream_reason: streamReason,
    conflict_type: streamReason === "conflict" ? safeLabel(reasonNode?.attrs?.type) : null,
  };
}

export function decideSessionDisconnect({ error, statusCode, hasOpened = false, hadStoredAuth = false, wasWaitingForQr = false, markedUnhealthy = false, recoveringFromDecryptError = false, conflictAttempts = 0 }) {
  const diagnostics = disconnectDiagnostics(error, statusCode);
  const conflict = diagnostics.stream_reason === "conflict" || statusCode === 440;
  const removed = diagnostics.conflict_type === "device_removed";
  // WhatsApp can override the normal 440 conflict code with 401. Attempt one
  // recovery of an ambiguous conflict before requiring a QR, retaining auth.
  const ambiguousConflict = conflict && !removed && [401, 440].includes(statusCode);
  const loggedOut = removed || (statusCode === 401 && !ambiguousConflict);
  const restartRequired = statusCode === 515;
  const conflictExhausted = ambiguousConflict && conflictAttempts >= 1;
  const shouldReconnect = !markedUnhealthy && !loggedOut && statusCode !== 403 && !conflictExhausted
    && (restartRequired || (!wasWaitingForQr && (hasOpened || hadStoredAuth || recoveringFromDecryptError)));
  return {
    diagnostics,
    loggedOut,
    restartRequired,
    ambiguousConflict,
    shouldReconnect,
    clearAuth: loggedOut,
    status: markedUnhealthy || conflictExhausted ? "needs_reconnect" : shouldReconnect ? "reconnecting" : "disconnected",
  };
}
