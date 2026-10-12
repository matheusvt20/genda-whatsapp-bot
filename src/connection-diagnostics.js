import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const DIAGNOSTICS_VERSION = "2026-10-12.1";
const DAY_MS = 86400000;
const EVENTS = new Set(["process_started", "process_shutdown", "runtime_sample", "session_start", "session_connected", "session_closed", "transport_closed", "transport_error", "transport_http_error", "provider_stream_error", "reconnect_scheduled", "reconnect_failed", "internal_recovery", "auth_loaded", "auth_backup_failed", "auth_cleared", "event_handler_failed", "manual_wipe", "health_warning"]);
const LABELS = {
  cause: new Set(["internal_action", "device_removed", "authorization_rejected", "session_conflict", "provider_stream_error", "transport_failure", "transport_closed_unknown", "unknown"]),
  reason: new Set(["SIGTERM", "SIGINT", "api_wipe", "fresh_qr", "decrypt_recovery", "decrypt_unhealthy", "listener_recovery", "listener_unhealthy", "revoked_auth", "startup", "reconnect", "process_shutdown", "resource_pressure", "unknown"]),
  source: new Set(["local", "remote", "new"]),
  stream_reason: new Set(["conflict", "ack", "failure", "restart_required", "unknown"]),
  conflict_type: new Set(["device_removed", "replaced", "unknown"]),
  network_code: new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "unknown"]),
  state: new Set(["initializing", "connected", "disconnected", "qr_pending", "reconnecting", "needs_reconnect", "error"]),
};
const NUMBERS = new Set(["status_code", "close_code", "http_status", "attempt", "delay_ms", "connected_ms", "downtime_ms", "decrypt_errors", "decrypt_errors_total", "last_message_age_ms", "last_transport_age_ms", "recent_closes", "rss_mb", "heap_mb", "event_loop_max_ms", "cpu_percent", "uptime_ms", "sessions_connected", "sessions_reconnecting", "sessions_needing_qr", "sessions_flapping"]);
const BOOLS = new Set(["auth_cleared", "should_reconnect", "previous_shutdown_observed", "close_reason_present"]);
const uuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;

export function sanitizeDiagnosticDetails(details = {}) {
  const result = {};
  for (const [key, value] of Object.entries(details)) {
    if (NUMBERS.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) result[key] = Math.round(value * 100) / 100;
    else if (BOOLS.has(key) && typeof value === "boolean") result[key] = value;
    else if (LABELS[key] && value != null) result[key] = LABELS[key].has(value) ? value : "unknown";
  }
  return result;
}

export function classifyConnectionClose({ internalReason, diagnostics = {}, transport = {} } = {}) {
  if (internalReason) return "internal_action";
  if (diagnostics.conflict_type === "device_removed") return "device_removed";
  if (diagnostics.stream_reason === "conflict" || diagnostics.status_code === 440) return "session_conflict";
  if (diagnostics.status_code === 401) return "authorization_rejected";
  if (diagnostics.stream_reason) return "provider_stream_error";
  if (transport.network_code) return "transport_failure";
  // A close code alone cannot identify who closed the socket or why.
  if (diagnostics.status_code === 428 || transport.close_code) return "transport_closed_unknown";
  return "unknown";
}

export function attachTransportDiagnostics(sock, session, record, now = Date.now) {
  const ws = sock?.ws;
  if (!ws?.on) return;
  ws.on("close", (code, reason) => {
    session.lastTransportClose = { close_code: typeof code === "number" ? code : null, close_reason_present: Boolean(reason?.length), ...session.lastTransportError };
    record("transport_closed", session.sessionKey, session.lastTransportClose);
  });
  ws.on("error", (error) => {
    const network_code = LABELS.network_code.has(error?.code) ? error.code : "unknown";
    session.lastTransportError = { network_code };
    record("transport_error", session.sessionKey, { network_code });
  });
  ws.on("unexpected-response", (_request, response) => record("transport_http_error", session.sessionKey, { http_status: response?.statusCode }));
  ws.on("message", () => { session.lastTransportMessageAt = now(); });
}

export function createReconnectTracker({ now = Date.now, windowMs = 10 * 60000, threshold = 3 } = {}) {
  const closes = new Map();
  const recent = (key) => {
    const values = (closes.get(key) || []).filter((at) => now() - at < windowMs);
    if (values.length) closes.set(key, values); else closes.delete(key);
    return values;
  };
  return {
    closed(key, at = now()) {
      const values = recent(key);
      values.push(at);
      closes.set(key, values.slice(-20));
    },
    stats(key) {
      const count = recent(key).length;
      return { recent_closes: count, delay_ms: count >= threshold ? Math.min(300000, 30000 * 2 ** (count - threshold)) : 0 };
    },
    flappingCount() { return [...closes.keys()].filter((key) => recent(key).length >= threshold).length; },
  };
}

// Append-only daily journal on the Railway volume; never store provider objects,
// messages, QR values, tokens, reasons as free text, headers or auth material.
export function createConnectionJournal({ directory, instanceId, deploymentId, now = Date.now, retentionDays = 30, maxDailyBytes = 2 * 1024 * 1024, maxPending = 1000, onEvent = () => {}, onError = () => {}, storage = fs } = {}) {
  let tail = Promise.resolve();
  let pending = 0;
  let dropped = 0;
  let failures = 0;
  let writeOk = true;
  let lastWriteAt = null;
  let knownDay = null;
  let dailyBytes = 0;
  const filename = (day) => path.join(directory, `${day}.ndjson`);
  const cleanup = async () => {
    const oldest = new Date(now() - (retentionDays - 1) * DAY_MS).toISOString().slice(0, 10);
    for (const name of await storage.readdir(directory)) {
      if (/^\d{4}-\d{2}-\d{2}\.ndjson$/.test(name) && name.slice(0, 10) < oldest) await storage.unlink(path.join(directory, name));
    }
  };
  const failure = () => { failures++; writeOk = false; try { onError(); } catch {} };
  return {
    async initialize() {
      try { await storage.mkdir(directory, { recursive: true }); await cleanup(); } catch { failure(); }
    },
    record(type, sessionKey = null, details = {}) {
      if (!EVENTS.has(type)) return null;
      const event = { id: randomUUID(), at: new Date(now()).toISOString(), type, session_key: uuid(sessionKey), instance_id: uuid(instanceId), deployment_id: uuid(deploymentId), details: sanitizeDiagnosticDetails(details) };
      try { onEvent(event); } catch {}
      if (pending >= maxPending) { dropped++; return event; }
      pending++;
      tail = tail.catch(() => undefined).then(async () => {
        try {
          const day = event.at.slice(0, 10);
          await storage.mkdir(directory, { recursive: true });
          if (day !== knownDay) {
            dailyBytes = await storage.stat(filename(day)).then((stat) => stat.size).catch((error) => { if (error.code === "ENOENT") return 0; throw error; });
            knownDay = day;
            await cleanup();
          }
          const line = `${JSON.stringify(event)}\n`;
          const bytes = Buffer.byteLength(line);
          if (dailyBytes + bytes > maxDailyBytes) { dropped++; return; }
          await storage.appendFile(filename(day), line, { mode: 0o600 });
          dailyBytes += bytes;
          lastWriteAt = event.at;
          writeOk = true;
        } catch { failure(); }
        finally { pending--; }
      });
      return event;
    },
    async flush() { await tail; },
    health() { return { version: DIAGNOSTICS_VERSION, persistence_ok: writeOk, pending, dropped, failures, last_write_at: lastWriteAt, retention_days: retentionDays }; },
    async read({ sessionKey = null, since = now() - DAY_MS, limit = 200 } = {}) {
      const minimum = Math.max(Number(since), now() - retentionDays * DAY_MS);
      const count = Math.min(1000, Math.max(1, Number(limit) || 200));
      const events = [];
      const days = (await storage.readdir(directory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(name) && name.slice(0, 10) >= new Date(minimum).toISOString().slice(0, 10)).sort();
      for (const day of days) {
        const lines = createInterface({ input: createReadStream(path.join(directory, day)), crlfDelay: Infinity });
        for await (const line of lines) {
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (!event || !EVENTS.has(event.type) || !Number.isFinite(Date.parse(event.at)) || Date.parse(event.at) < minimum || (sessionKey && event.session_key !== sessionKey)) continue;
          events.push({ id: uuid(event.id), at: new Date(event.at).toISOString(), type: event.type, session_key: uuid(event.session_key), instance_id: uuid(event.instance_id), deployment_id: uuid(event.deployment_id), details: sanitizeDiagnosticDetails(event.details || {}) });
          if (events.length > count) events.shift();
        }
      }
      return events;
    },
  };
}
