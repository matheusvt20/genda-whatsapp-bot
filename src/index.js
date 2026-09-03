import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import {
  extractMediaInfo,
  extractMessageText,
  extractMessageType,
  unwrapMessageContent,
} from "./message-content.js";
import {
  normalizeBrazilianPhone,
  phoneFromJid,
  pickCanonicalWhatsAppJid,
  whatsappPhoneCandidates,
} from "./phone.js";
import { computeReconnectDelayMs, shouldResetReconnectAttempts } from "./reconnect-policy.js";
import { createMediaStorage, DEFAULT_MEDIA_RETENTION_MS } from "./media-storage.js";

const originalConsoleInfo = console.info.bind(console);
console.info = (...args) => {
  if (args[0] === "Closing session:") return;
  originalConsoleInfo(...args);
};

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_FUNCTIONS_URL = String(process.env.SUPABASE_FUNCTIONS_URL || `${SUPABASE_URL}/functions/v1`).replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BOT_INTERNAL_TOKEN = process.env.BOT_INTERNAL_TOKEN || process.env.BOT_SIGNATURE || "";
const SESSION_DIR = process.env.SESSION_DIR || process.env.SESSION_ROOT || "/data";
const MEDIA_TTL_MS = Number(process.env.WHATSAPP_MEDIA_TTL_MS || 24 * 60 * 60 * 1000);
const MEDIA_RETENTION_MS = Number(process.env.WHATSAPP_MEDIA_RETENTION_MS || DEFAULT_MEDIA_RETENTION_MS);
const MEDIA_CLEANUP_INTERVAL_MS = Number(process.env.WHATSAPP_MEDIA_CLEANUP_INTERVAL_MS || 60 * 60 * 1000);
const MESSAGE_REPLAY_GRACE_MS = Number(process.env.WHATSAPP_MESSAGE_REPLAY_GRACE_MS || 60 * 1000);
const DECRYPT_ERROR_WINDOW_MS = Number(process.env.WHATSAPP_DECRYPT_ERROR_WINDOW_MS || 2 * 60 * 1000);
const DECRYPT_ERROR_THRESHOLD = Number(process.env.WHATSAPP_DECRYPT_ERROR_THRESHOLD || 8);
const DECRYPT_RECOVERY_CONNECTION_GRACE_MS = Number(
  process.env.WHATSAPP_DECRYPT_RECOVERY_CONNECTION_GRACE_MS || 2 * 60 * 1000,
);
const DECRYPT_SOFT_RECONNECT_MAX_ATTEMPTS = Number(process.env.WHATSAPP_DECRYPT_SOFT_RECONNECT_MAX_ATTEMPTS || 1);
const DECRYPT_SOFT_RECONNECT_COOLDOWN_MS = Number(process.env.WHATSAPP_DECRYPT_SOFT_RECONNECT_COOLDOWN_MS || 5 * 60 * 1000);
const DECRYPT_RECOVERY_RESET_MS = Number(process.env.WHATSAPP_DECRYPT_RECOVERY_RESET_MS || 30 * 60 * 1000);
const WHATSAPP_MAX_MESSAGE_RETRY_COUNT = Number(process.env.WHATSAPP_MAX_MESSAGE_RETRY_COUNT || 5);
const WHATSAPP_RETRY_REQUEST_DELAY_MS = Number(process.env.WHATSAPP_RETRY_REQUEST_DELAY_MS || 500);
const MESSAGE_LISTENER_STALE_MS = Number(process.env.WHATSAPP_MESSAGE_LISTENER_STALE_MS || 45 * 1000);
const MESSAGE_LISTENER_SOFT_RECONNECT_MAX_ATTEMPTS = Number(process.env.WHATSAPP_MESSAGE_LISTENER_SOFT_RECONNECT_MAX_ATTEMPTS || 1);
const MESSAGE_LISTENER_SOFT_RECONNECT_COOLDOWN_MS = Number(process.env.WHATSAPP_MESSAGE_LISTENER_SOFT_RECONNECT_COOLDOWN_MS || 5 * 60 * 1000);
const MESSAGE_LISTENER_RECOVERY_RESET_MS = Number(process.env.WHATSAPP_MESSAGE_LISTENER_RECOVERY_RESET_MS || 30 * 60 * 1000);
const SESSION_HEALTH_CHECK_INTERVAL_MS = Number(process.env.WHATSAPP_SESSION_HEALTH_CHECK_INTERVAL_MS || 30 * 1000);
const SESSION_PROCESS_LOCK_TTL_MS = Number(process.env.WHATSAPP_SESSION_PROCESS_LOCK_TTL_MS || 45 * 1000);
const SESSION_PROCESS_LOCK_REFRESH_MS = Number(process.env.WHATSAPP_SESSION_PROCESS_LOCK_REFRESH_MS || 15 * 1000);
const AUTO_RESTORE_RETRY_ATTEMPTS = Number(process.env.WHATSAPP_AUTO_RESTORE_RETRY_ATTEMPTS || 12);
const AUTO_RESTORE_RETRY_DELAY_MS = Number(process.env.WHATSAPP_AUTO_RESTORE_RETRY_DELAY_MS || 10 * 1000);
const RECONNECT_BASE_DELAY_MS = Number(process.env.WHATSAPP_RECONNECT_BASE_DELAY_MS || 2 * 1000);
const RECONNECT_MAX_DELAY_MS = Number(process.env.WHATSAPP_RECONNECT_MAX_DELAY_MS || 60 * 1000);
const RECONNECT_JITTER_MS = Number(process.env.WHATSAPP_RECONNECT_JITTER_MS || 1000);
const RECONNECT_STABLE_RESET_MS = Number(process.env.WHATSAPP_RECONNECT_STABLE_RESET_MS || 2 * 60 * 1000);
const HISTORY_SYNC_ENABLED = String(process.env.WHATSAPP_HISTORY_SYNC_ENABLED || "true").toLowerCase() !== "false";
const HISTORY_SYNC_LOOKBACK_MS = Number(process.env.WHATSAPP_HISTORY_SYNC_LOOKBACK_MS || 48 * 60 * 60 * 1000);
const HISTORY_SYNC_MAX_MESSAGES = Number(process.env.WHATSAPP_HISTORY_SYNC_MAX_MESSAGES || 250);
const PIPELINE_CONTACT_CACHE_MS = Number(process.env.WHATSAPP_PIPELINE_CONTACT_CACHE_MS || 60 * 1000);
const BAILEYS_LOG_LEVEL = String(process.env.WHATSAPP_BAILEYS_LOG_LEVEL || "warn").toLowerCase();
const STATUS_OUTBOX_RETRY_BASE_MS = Number(process.env.WHATSAPP_STATUS_OUTBOX_RETRY_BASE_MS || 2 * 1000);
const STATUS_OUTBOX_RETRY_MAX_MS = Number(process.env.WHATSAPP_STATUS_OUTBOX_RETRY_MAX_MS || 5 * 60 * 1000);
const OPPORTUNITY_APPOINTMENT_SYNC_ENABLED =
  String(process.env.WHATSAPP_OPPORTUNITY_APPOINTMENT_SYNC_ENABLED || "true").toLowerCase() !== "false";
const persistentMediaStorage = createMediaStorage({
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
  retentionMs: MEDIA_RETENTION_MS,
});

function parseWhatsAppWebVersion(value) {
  const parsed = String(value || "")
    .split(".")
    .map((part) => Number(part));
  return parsed.length === 3 && parsed.every((part) => Number.isInteger(part) && part > 0)
    ? parsed
    : [2, 3000, 1035194821];
}

const CONFIGURED_WHATSAPP_WEB_VERSION = String(process.env.WHATSAPP_WEB_VERSION || "").trim();
const WHATSAPP_WEB_VERSION_FALLBACK = parseWhatsAppWebVersion(
  CONFIGURED_WHATSAPP_WEB_VERSION || "2.3000.1043857760",
);
let whatsappWebVersionPromise;

async function resolveWhatsAppWebVersion() {
  if (CONFIGURED_WHATSAPP_WEB_VERSION) {
    return WHATSAPP_WEB_VERSION_FALLBACK;
  }

  if (!whatsappWebVersionPromise) {
    whatsappWebVersionPromise = (async () => {
      try {
        const latest = await Promise.race([
          fetchLatestBaileysVersion(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("version lookup timeout")), 5000)),
        ]);
        const version = Array.isArray(latest?.version) && latest.version.length === 3
          ? latest.version.map((part) => Number(part))
          : null;

        if (!version || version.some((part) => !Number.isInteger(part) || part <= 0)) {
          throw new Error("invalid version returned by Baileys");
        }

        console.log("[bot] WhatsApp Web version resolved", { version: version.join("."), source: "baileys" });
        return version;
      } catch (error) {
        console.warn("[bot] failed to resolve current WhatsApp Web version; using fallback", {
          version: WHATSAPP_WEB_VERSION_FALLBACK.join("."),
          error: error instanceof Error ? error.message : "unknown error",
        });
        return WHATSAPP_WEB_VERSION_FALLBACK;
      }
    })();
  }

  return whatsappWebVersionPromise;
}

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, x-bot-signature, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
});
app.use(express.json({ limit: "16mb" }));

const sessions = new Map();
const sessionStartPromises = new Map();
const sessionProcessLocks = new Map();
const processedMessageIds = new Set();
const processedStatusUpdates = new Set();
const mediaMessages = new Map();
const pipelineContactCache = new Map();
const decryptRecoveryState = new Map();
const messageListenerRecoveryState = new Map();
const sessionSendQueues = new Map();
const outboundMessageCache = new Map();
const sessionReconnectTimers = new Map();
const sessionReconnectAttempts = new Map();
const statusOutbox = new Map();
let sessionHealthCheckRunning = false;
let mediaCleanupRunning = false;
let statusOutboxFlushRunning = false;
let statusOutboxFlushTimer = null;
let statusOutboxPersistChain = Promise.resolve();
const INSTANCE_ID = randomUUID();
const OUTBOUND_MESSAGE_CACHE_MAX = 1000;
const STATUS_OUTBOX_PATH = path.join(SESSION_DIR, "whatsapp-status-outbox.json");
const MESSAGE_STATUS_RANK = Object.freeze({ failed: 0, sent: 1, delivered: 2, read: 3, played: 4 });

function requireInternalToken(req, res, next) {
  const token = req.get("authorization")?.replace(/^Bearer\s+/i, "") || req.get("x-bot-signature");
  if (!BOT_INTERNAL_TOKEN || token !== BOT_INTERNAL_TOKEN) {
    return res.status(401).json({ success: false, error: "unauthorized" });
  }
  return next();
}

function ensureConfig() {
  if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
  if (!BOT_INTERNAL_TOKEN) throw new Error("BOT_INTERNAL_TOKEN is required");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearSessionReconnectTimer(sessionKey) {
  const timer = sessionReconnectTimers.get(sessionKey);
  if (timer) clearTimeout(timer);
  sessionReconnectTimers.delete(sessionKey);
}

function resetSessionReconnectState(sessionKey) {
  clearSessionReconnectTimer(sessionKey);
  sessionReconnectAttempts.delete(sessionKey);
}

function scheduleSessionReconnect(session, reason) {
  const { sessionKey } = session;
  clearSessionReconnectTimer(sessionKey);

  const now = Date.now();
  if (shouldResetReconnectAttempts(session.connectedAt, now, RECONNECT_STABLE_RESET_MS)) {
    sessionReconnectAttempts.delete(sessionKey);
  }

  const attempt = (sessionReconnectAttempts.get(sessionKey) || 0) + 1;
  sessionReconnectAttempts.set(sessionKey, attempt);
  const delayMs = computeReconnectDelayMs(attempt, {
    baseDelayMs: RECONNECT_BASE_DELAY_MS,
    maxDelayMs: RECONNECT_MAX_DELAY_MS,
    jitterMs: RECONNECT_JITTER_MS,
  });

  console.warn("[bot] session reconnect scheduled", {
    sessionKey,
    attempt,
    delayMs,
    reason,
  });

  const timer = setTimeout(() => {
    sessionReconnectTimers.delete(sessionKey);
    void createSession(sessionKey).catch((error) => {
      session.status = "error";
      session.lastError = error instanceof Error ? error.message : "reconnect failed";
      console.error("[bot] reconnect failed", { sessionKey, attempt, error });
      scheduleSessionReconnect(session, "reconnect_start_failed");
    });
  }, delayMs);

  timer.unref?.();
  sessionReconnectTimers.set(sessionKey, timer);
}

function runSessionEvent(session, eventName, task) {
  if (sessions.get(session.sessionKey) !== session) {
    console.warn("[bot] ignored stale baileys event", {
      sessionKey: session.sessionKey,
      eventName,
    });
    return;
  }

  void Promise.resolve()
    .then(() => {
      if (sessions.get(session.sessionKey) !== session) return undefined;
      return task();
    })
    .catch((error) => {
      session.lastError = error instanceof Error ? error.message : String(error);
      console.error("[bot] baileys event handler failed", {
        sessionKey: session.sessionKey,
        eventName,
        status: session.status,
        error,
      });

      if (
        session.status === "reconnecting"
        && !session.sock
        && !sessionReconnectTimers.has(session.sessionKey)
      ) {
        scheduleSessionReconnect(session, `${eventName}_handler_failed`);
      }
    });
}

function sessionPath(sessionKey) {
  return path.join(SESSION_DIR, "baileys-sessions", sessionKey);
}

function sessionLockPath(sessionKey) {
  return path.join(SESSION_DIR, "baileys-session-locks", sessionKey);
}

function outboundMessageCacheKey(key) {
  if (!key?.id) return null;
  return `${key.remoteJid || ""}:${key.id}`;
}

function outboundMessageIdCacheKey(key) {
  return key?.id ? `id:${key.id}` : null;
}

function rememberOutboundMessage(key, message) {
  const cacheKey = outboundMessageCacheKey(key);
  const idCacheKey = outboundMessageIdCacheKey(key);
  if (!cacheKey || !idCacheKey || !message) return;

  outboundMessageCache.set(cacheKey, message);
  outboundMessageCache.set(idCacheKey, message);
  if (outboundMessageCache.size > OUTBOUND_MESSAGE_CACHE_MAX) {
    const oldestKey = outboundMessageCache.keys().next().value;
    outboundMessageCache.delete(oldestKey);
  }
}

async function getCachedOutboundMessage(key) {
  const cacheKey = outboundMessageCacheKey(key);
  const idCacheKey = outboundMessageIdCacheKey(key);
  return (cacheKey ? outboundMessageCache.get(cacheKey) : undefined)
    || (idCacheKey ? outboundMessageCache.get(idCacheKey) : undefined);
}

async function enqueueSessionSend(sessionKey, task) {
  const previous = sessionSendQueues.get(sessionKey) || Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  const tracked = next.finally(() => {
    if (sessionSendQueues.get(sessionKey) === tracked) {
      sessionSendQueues.delete(sessionKey);
    }
  });
  sessionSendQueues.set(sessionKey, tracked);
  return next;
}

async function hasStoredSessionAuth(sessionKey) {
  // Checa cache local primeiro
  try {
    await fs.access(path.join(sessionPath(sessionKey), "creds.json"));
    return true;
  } catch {
    // Fallback: checa Supabase Storage
    const res = await supabaseStorageFetch(
      `/object/info/whatsapp-sessions/sessions/${sessionKey}/creds.json`,
      { method: "GET" },
    );
    return res !== null;
  }
}

async function writeSessionProcessLock(lockDir) {
  await fs.writeFile(
    path.join(lockDir, "owner.json"),
    JSON.stringify({
      instanceId: INSTANCE_ID,
      updatedAt: new Date().toISOString(),
    }),
  );
}

async function getSessionProcessLockAgeMs(lockDir) {
  try {
    const stat = await fs.stat(path.join(lockDir, "owner.json"));
    return Date.now() - stat.mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

async function getSessionProcessLockOwner(lockDir) {
  try {
    const content = await fs.readFile(path.join(lockDir, "owner.json"), "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function acquireSessionProcessLock(sessionKey) {
  const existing = sessionProcessLocks.get(sessionKey);
  if (existing) return existing;

  const lockDir = sessionLockPath(sessionKey);
  await fs.mkdir(path.dirname(lockDir), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(lockDir);
      await writeSessionProcessLock(lockDir);

      const refreshTimer = setInterval(() => {
        void writeSessionProcessLock(lockDir)
          .catch((error) => console.warn("[bot] failed to refresh session process lock", { sessionKey, error }));
      }, SESSION_PROCESS_LOCK_REFRESH_MS);
      refreshTimer.unref?.();

      const lock = { lockDir, refreshTimer };
      sessionProcessLocks.set(sessionKey, lock);
      return lock;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;

      const owner = await getSessionProcessLockOwner(lockDir);
      const ageMs = await getSessionProcessLockAgeMs(lockDir);
      const sameInstance = owner?.instanceId === INSTANCE_ID;
      if (sameInstance || ageMs > SESSION_PROCESS_LOCK_TTL_MS) {
        console.warn("[bot] removing stale session process lock", {
          sessionKey,
          ageMs,
          sameInstance,
        });
        await fs.rm(lockDir, { recursive: true, force: true });
        continue;
      }

      throw new Error(`session ${sessionKey} already active in another bot process`);
    }
  }

  throw new Error(`failed to acquire process lock for session ${sessionKey}`);
}

async function releaseSessionProcessLock(sessionKey) {
  const lock = sessionProcessLocks.get(sessionKey);
  if (!lock) return;

  clearInterval(lock.refreshTimer);
  sessionProcessLocks.delete(sessionKey);
  await fs.rm(lock.lockDir, { recursive: true, force: true });
}

async function releaseAllSessionProcessLocks() {
  await Promise.all([...sessionProcessLocks.keys()].map((sessionKey) => releaseSessionProcessLock(sessionKey)));
}

async function clearStoredSessionAuth(sessionKey) {
  resetSessionReconnectState(sessionKey);
  sessions.delete(sessionKey);
  decryptRecoveryState.delete(sessionKey);
  messageListenerRecoveryState.delete(sessionKey);
  await releaseSessionProcessLock(sessionKey);
  await fs.rm(sessionPath(sessionKey), { recursive: true, force: true });
  await supabaseStorageFetch(
    `/object/whatsapp-sessions/sessions/${sessionKey}/creds.json`,
    { method: "DELETE" },
  );
}

function toApiStatus(status) {
  if (status === "qr_pending") return "qr_pending";
  if (status === "connected") return "connected";
  if (status === "reconnecting") return "reconnecting";
  if (status === "needs_reconnect") return "needs_reconnect";
  if (status === "error") return "error";
  return "disconnected";
}

function toDatabaseStatus(status) {
  if (status === "connected") return "connected";
  if (status === "qr_pending" || status === "reconnecting") return "waiting";
  return "disconnected";
}

function getSessionResponse(session) {
  const status = toApiStatus(effectiveSessionStatus(session));
  const qr = session?.qr || null;
  const phone = session?.phone || null;

  return {
    ok: true,
    success: true,
    connected: status === "connected",
    status,
    qr,
    qrCode: qr,
    qr_base64: qr,
    phone,
    phone_number: phone,
    diagnostics: {
      last_low_level_message_at: session?.lastLowLevelPeerMessageAt
        ? new Date(session.lastLowLevelPeerMessageAt).toISOString()
        : null,
      last_notify_upsert_at: session?.lastNotifyUpsertAt
        ? new Date(session.lastNotifyUpsertAt).toISOString()
        : null,
      low_level_signals_since_notify: session?.lowLevelPeerSignalsSinceNotify || 0,
      last_listener_reconnect_at: session?.lastMessageListenerReconnectAt
        ? new Date(session.lastMessageListenerReconnectAt).toISOString()
        : null,
    },
  };
}

function getDisconnectedSessionResponse(sessionKey) {
  return getSessionResponse({
    sessionKey,
    status: "disconnected",
    qr: null,
    phone: null,
  });
}

function effectiveSessionStatus(session, now = Date.now()) {
  if (!session) return "disconnected";
  if (session.status !== "connected") return session.status;
  if (hasStaleMessageListener(session, now)) return "needs_reconnect";
  return session.status;
}

function hasStaleMessageListener(session, now = Date.now()) {
  if (!session || session.status !== "connected") return false;
  if (!session.lastLowLevelPeerMessageAt) return false;
  if (now - session.lastLowLevelPeerMessageAt < MESSAGE_LISTENER_STALE_MS) return false;

  const lastNotifyUpsertAt = session.lastNotifyUpsertAt || 0;
  return session.lastLowLevelPeerMessageAt > lastNotifyUpsertAt;
}

function getMessageListenerRecovery(sessionKey, now = Date.now()) {
  const current = messageListenerRecoveryState.get(sessionKey);
  if (!current || now - current.lastSoftReconnectAt > MESSAGE_LISTENER_RECOVERY_RESET_MS) {
    const fresh = { softReconnects: 0, lastSoftReconnectAt: 0 };
    messageListenerRecoveryState.set(sessionKey, fresh);
    return fresh;
  }

  return current;
}

function recordLowLevelPeerSignal(session) {
  if (!session) return;
  session.lastLowLevelPeerMessageAt = Date.now();
  session.lowLevelPeerSignalsSinceNotify = (session.lowLevelPeerSignalsSinceNotify || 0) + 1;
}

async function recoverStaleMessageListener(session) {
  if (!hasStaleMessageListener(session) || session.messageListenerRecoveryInProgress) return false;

  const now = Date.now();
  const recovery = getMessageListenerRecovery(session.sessionKey, now);
  const canSoftReconnect =
    recovery.softReconnects < MESSAGE_LISTENER_SOFT_RECONNECT_MAX_ATTEMPTS &&
    now - recovery.lastSoftReconnectAt >= MESSAGE_LISTENER_SOFT_RECONNECT_COOLDOWN_MS;

  if (canSoftReconnect) {
    recovery.softReconnects += 1;
    recovery.lastSoftReconnectAt = now;
    session.status = "reconnecting";
    session.lastError = "Listener de mensagens sem eventos recentes. Tentando reconectar a sessão.";
    session.messageListenerRecoveryInProgress = true;
    session.lastMessageListenerReconnectAt = now;
    session.lowLevelPeerSignalsSinceNotify = 0;

    console.warn("[bot] session soft reconnect by message listener health check", {
      sessionKey: session.sessionKey,
      softReconnects: recovery.softReconnects,
      staleMs: now - session.lastLowLevelPeerMessageAt,
      lastLowLevelPeerMessageAt: new Date(session.lastLowLevelPeerMessageAt).toISOString(),
      lastNotifyUpsertAt: session.lastNotifyUpsertAt ? new Date(session.lastNotifyUpsertAt).toISOString() : null,
    });

    try {
      session.sock?.end?.(new Error(session.lastError));
    } catch (error) {
      console.warn("[bot] failed to end socket for message listener reconnect", error);
    }

    await syncConnectionStatus(session.sessionKey, "reconnecting", {
      phone: session.phone,
      lastError: session.lastError,
      healthReason: "message_listener_stale",
    });
    return true;
  }

  session.status = "needs_reconnect";
  session.lastError = "Sessão conectada, mas sem entregar eventos de mensagem. Reconecte pelo QR.";
  session.healthMarkedDisconnected = true;
  console.error("[bot] session marked needs_reconnect by message listener health check", {
    sessionKey: session.sessionKey,
    staleMs: now - session.lastLowLevelPeerMessageAt,
    lastLowLevelPeerMessageAt: new Date(session.lastLowLevelPeerMessageAt).toISOString(),
    lastNotifyUpsertAt: session.lastNotifyUpsertAt ? new Date(session.lastNotifyUpsertAt).toISOString() : null,
  });

  try {
    session.sock?.end?.(new Error(session.lastError));
  } catch (error) {
    console.warn("[bot] failed to end unhealthy message listener socket", error);
  }

  await syncConnectionStatus(session.sessionKey, "disconnected", {
    phone: session.phone,
    lastError: session.lastError,
    healthReason: "message_listener_stale",
  });
  return true;
}

async function getRestoredSession(sessionKey) {
  const existing = getExistingSession(sessionKey);
  if (existing) return existing;

  if (!(await hasStoredSessionAuth(sessionKey))) {
    return null;
  }

  console.log("[bot] restoring stored session", { sessionKey });
  return createSession(sessionKey);
}

function rememberMessage(id) {
  if (!id) return false;
  if (processedMessageIds.has(id)) return true;

  processedMessageIds.add(id);
  if (processedMessageIds.size > 5000) {
    const first = processedMessageIds.values().next().value;
    processedMessageIds.delete(first);
  }

  return false;
}

function rememberStatusUpdate(id) {
  if (!id) return false;
  if (processedStatusUpdates.has(id)) return true;

  processedStatusUpdates.add(id);
  if (processedStatusUpdates.size > 5000) {
    const first = processedStatusUpdates.values().next().value;
    processedStatusUpdates.delete(first);
  }

  return false;
}

function statusNameFromBaileys(status) {
  if (status === 2 || status === "SERVER_ACK") return "sent";
  if (status === 3 || status === "DELIVERY_ACK") return "delivered";
  if (status === 4 || status === "READ") return "read";
  if (status === 5 || status === "PLAYED") return "played";
  if (status === 0 || status === "ERROR") return "failed";
  return null;
}

function statusOutboxKey(payload) {
  const sessionKey = String(payload?.session_key || "").trim();
  const messageId = String(payload?.whatsapp_message_id || payload?.message_id || "").trim();
  return sessionKey && messageId ? `${sessionKey}:${messageId}` : null;
}

function statusRank(status) {
  return MESSAGE_STATUS_RANK[status] ?? -1;
}

function statusOutboxRetryDelay(attempt) {
  const exponent = Math.max(0, Math.min(attempt - 1, 10));
  return Math.min(STATUS_OUTBOX_RETRY_BASE_MS * (2 ** exponent), STATUS_OUTBOX_RETRY_MAX_MS);
}

async function persistStatusOutbox() {
  const serialized = JSON.stringify([...statusOutbox.values()]);
  const temporaryPath = `${STATUS_OUTBOX_PATH}.${process.pid}.tmp`;

  statusOutboxPersistChain = statusOutboxPersistChain.then(async () => {
    await fs.writeFile(temporaryPath, serialized, "utf8");
    await fs.rename(temporaryPath, STATUS_OUTBOX_PATH);
  });

  return statusOutboxPersistChain;
}

async function loadStatusOutbox() {
  try {
    const raw = await fs.readFile(STATUS_OUTBOX_PATH, "utf8");
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) throw new Error("outbox must be an array");

    for (const entry of entries) {
      const key = statusOutboxKey(entry?.payload);
      if (!key || statusRank(entry?.payload?.status) < 0) continue;

      const current = statusOutbox.get(key);
      if (!current || statusRank(entry.payload.status) > statusRank(current.payload.status)) {
        statusOutbox.set(key, {
          payload: entry.payload,
          attempts: Math.max(0, Number(entry.attempts) || 0),
          nextAttemptAt: Math.max(0, Number(entry.nextAttemptAt) || Date.now()),
        });
      }
    }

    console.log("[bot] restored WhatsApp status outbox", { pending: statusOutbox.size });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    console.warn("[bot] could not restore WhatsApp status outbox; starting empty", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function scheduleStatusOutboxFlush() {
  if (statusOutboxFlushTimer) clearTimeout(statusOutboxFlushTimer);
  statusOutboxFlushTimer = null;

  const nextAttemptAt = [...statusOutbox.values()]
    .reduce((earliest, entry) => Math.min(earliest, entry.nextAttemptAt), Infinity);
  if (!Number.isFinite(nextAttemptAt)) return;

  const delayMs = Math.max(0, nextAttemptAt - Date.now());
  statusOutboxFlushTimer = setTimeout(() => {
    statusOutboxFlushTimer = null;
    void flushStatusOutbox();
  }, delayMs);
  statusOutboxFlushTimer.unref?.();
}

async function enqueueMessageStatusUpdate(payload) {
  const key = statusOutboxKey(payload);
  if (!key || statusRank(payload?.status) < 0) return;

  const existing = statusOutbox.get(key);
  if (existing && statusRank(existing.payload.status) > statusRank(payload.status)) return;

  statusOutbox.set(key, {
    payload,
    attempts: existing?.attempts ?? 0,
    nextAttemptAt: Date.now(),
  });
  await persistStatusOutbox();
  scheduleStatusOutboxFlush();
  void flushStatusOutbox();
}

async function flushStatusOutbox() {
  if (statusOutboxFlushRunning) return;
  statusOutboxFlushRunning = true;

  try {
    const now = Date.now();
    const dueEntries = [...statusOutbox.entries()]
      .filter(([, entry]) => entry.nextAttemptAt <= now)
      .sort(([, left], [, right]) => left.nextAttemptAt - right.nextAttemptAt);

    for (const [key, entry] of dueEntries) {
      // The entry may have been replaced by a newer (higher) status while this
      // flush was waiting. In that case, send only the newest state.
      if (statusOutbox.get(key) !== entry) continue;

      try {
        await postMessageStatusUpdate(entry.payload);
        if (statusOutbox.get(key) === entry) {
          statusOutbox.delete(key);
          await persistStatusOutbox();
        }
      } catch (error) {
        if (statusOutbox.get(key) !== entry) continue;
        entry.attempts += 1;
        entry.nextAttemptAt = Date.now() + statusOutboxRetryDelay(entry.attempts);
        statusOutbox.set(key, entry);
        await persistStatusOutbox();
        console.warn("[bot] status update queued for retry", {
          messageId: entry.payload.whatsapp_message_id,
          status: entry.payload.status,
          attempt: entry.attempts,
          retryInMs: entry.nextAttemptAt - Date.now(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    statusOutboxFlushRunning = false;
    scheduleStatusOutboxFlush();
  }
}

function isIgnorableJid(jid) {
  return !jid || jid === "status@broadcast" || jid.endsWith("@g.us") || jid.endsWith("@newsletter");
}

function normalizeDirectJid(rawJid) {
  const jid = String(rawJid || "").trim();
  if (!jid || isIgnorableJid(jid)) return null;
  if (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid")) return jid;
  return null;
}

function contactPhoneFromJid(jid) {
  const value = String(jid || "");
  if (value.endsWith("@lid")) return null;
  return phoneFromJid(value);
}

function contactPhoneFromMessage(message) {
  const key = message?.key || {};
  const candidates = [
    key.remoteJid,
    key.remoteJidAlt,
    key.senderPn,
    key.participantPn,
    key.participantAlt,
    key.participant,
  ];

  for (const candidate of candidates) {
    const phone = contactPhoneFromJid(candidate);
    if (phone) return phone;
  }

  return null;
}

function senderPhoneFromMessage(message) {
  const key = message?.key || {};
  const candidates = [
    key.senderPn,
    key.participantPn,
    key.participantAlt,
    key.participant,
    key.remoteJidAlt,
  ];

  for (const candidate of candidates) {
    const phone = contactPhoneFromJid(candidate);
    if (phone) return phone;
  }

  return null;
}

function isMessageFromConnectedAccount(session, message) {
  if (message?.key?.fromMe) return true;

  const sessionPhone = normalizeBrazilianPhone(session?.phone);
  const senderPhone = normalizeBrazilianPhone(senderPhoneFromMessage(message));
  return Boolean(sessionPhone && senderPhone && sessionPhone === senderPhone);
}

function publicBaseUrl() {
  const configured = String(process.env.BOT_PUBLIC_URL || process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (configured) return configured.startsWith("http") ? configured : `https://${configured}`;

  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_SERVICE_GENDA_WHATSAPP_BOT_URL;
  if (railwayDomain) return `https://${String(railwayDomain).replace(/\/+$/, "")}`;

  return null;
}

function rememberMediaMessage(message) {
  const baseUrl = publicBaseUrl();
  const mediaInfo = extractMediaInfo(message);
  if (!baseUrl || !mediaInfo) return null;

  const token = randomUUID();
  mediaMessages.set(token, {
    message,
    expiresAt: Date.now() + MEDIA_TTL_MS,
    ...mediaInfo,
  });

  return `${baseUrl}/api/media/${token}`;
}

function rememberOutboundMediaBuffer(buffer, { mimetype, fileName }) {
  const baseUrl = publicBaseUrl();
  if (!baseUrl || !Buffer.isBuffer(buffer) || !buffer.length) return null;

  const token = randomUUID();
  mediaMessages.set(token, {
    buffer,
    mimetype: mimetype || "application/octet-stream",
    fileName: fileName || null,
    expiresAt: Date.now() + MEDIA_TTL_MS,
  });

  return `${baseUrl}/api/media/${token}`;
}

async function persistMediaBuffer(buffer, { sessionKey, messageId, mimetype, fileName }) {
  try {
    const persistentUrl = await persistentMediaStorage.persistBuffer({
      buffer,
      userId: sessionKey,
      messageId,
      mimeType: mimetype,
      fileName,
    });
    if (persistentUrl) return persistentUrl;
  } catch (error) {
    console.warn("[bot] persistent media upload failed; using temporary fallback", {
      error: error instanceof Error ? error.message : "unknown error",
    });
  }

  return rememberOutboundMediaBuffer(buffer, { mimetype, fileName });
}

async function persistMediaMessage(message, sessionKey) {
  const mediaInfo = extractMediaInfo(message);
  if (!mediaInfo) return null;

  try {
    const buffer = await downloadMediaMessage(message, "buffer", {});
    return persistMediaBuffer(buffer, {
      sessionKey,
      messageId: message?.key?.id,
      ...mediaInfo,
    });
  } catch (error) {
    console.warn("[bot] media download for persistence failed; using temporary fallback", {
      error: error instanceof Error ? error.message : "unknown error",
    });
    return rememberMediaMessage(message);
  }
}

async function runExpiredMediaCleanup() {
  if (mediaCleanupRunning) return;
  mediaCleanupRunning = true;
  try {
    const result = await persistentMediaStorage.cleanupExpired();
    if (result.checked > 0) console.log("[bot] expired media cleanup completed", result);
  } catch (error) {
    console.warn("[bot] expired media cleanup failed", {
      error: error instanceof Error ? error.message : "unknown error",
    });
  } finally {
    mediaCleanupRunning = false;
  }
}

setInterval(pruneExpiredMedia, Math.min(MEDIA_TTL_MS, 60 * 60 * 1000)).unref();

function pruneExpiredMedia() {
  const now = Date.now();
  for (const [token, entry] of mediaMessages.entries()) {
    if (entry.expiresAt <= now) mediaMessages.delete(token);
  }
}

function parseMessageTimestamp(value) {
  const raw = typeof value?.toNumber === "function" ? value.toNumber() : Number(value || Date.now());
  return new Date(raw > 10_000_000_000 ? raw : raw * 1000).toISOString();
}

function messageTimestampMs(value) {
  const raw = typeof value?.toNumber === "function" ? value.toNumber() : Number(value || Date.now());
  return raw > 10_000_000_000 ? raw : raw * 1000;
}

function isReplayMessage(session, message) {
  const timestamp = messageTimestampMs(message?.messageTimestamp);
  return Number.isFinite(timestamp) && timestamp < session.acceptMessagesAfterMs;
}

function shouldProcessHistorySyncMessage(historyMessage) {
  if (!HISTORY_SYNC_ENABLED) return false;

  const syncType = historyMessage?.syncType;
  const types = proto.HistorySync.HistorySyncType;
  return syncType === types.RECENT || syncType === types.ON_DEMAND;
}

function isWithinHistorySyncWindow(message, now = Date.now()) {
  const timestamp = messageTimestampMs(message?.messageTimestamp);
  if (!Number.isFinite(timestamp)) return false;
  return timestamp >= now - HISTORY_SYNC_LOOKBACK_MS && timestamp <= now + 5 * 60 * 1000;
}

function messageContactKeys(message) {
  const jid = normalizeDirectJid(message?.key?.remoteJid);
  const phone = normalizeBrazilianPhone(contactPhoneFromMessage(message));

  return { jid, phone };
}

function emptyPipelineContactKeys() {
  return { phones: new Set(), jids: new Set() };
}

function isHiddenPipelinePhone(phone, hiddenPhones) {
  const normalized = normalizeBrazilianPhone(phone);
  return Boolean(normalized && hiddenPhones.has(normalized));
}

function isSchedulableOpportunityStage(stage) {
  return [
    "Nova interessada",
    "Em atendimento",
    "Em contato",
    "Quase agendou",
    "Lead",
    "Contato Feito",
    "Conversa",
    "Proposta",
  ].includes(String(stage || "").trim());
}

async function fetchJsonOrEmpty(pathname, label) {
  const response = await supabaseFetch(pathname);
  if (!response?.ok) {
    console.warn("[bot] failed to fetch pipeline contacts", {
      label,
      status: response?.status ?? null,
      error: response ? await response.text().catch(() => "") : "missing service role",
    });
    return [];
  }

  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

async function getPipelineContactKeys(sessionKey) {
  const cached = pipelineContactCache.get(sessionKey);
  if (cached && Date.now() - cached.loadedAt < PIPELINE_CONTACT_CACHE_MS) {
    return cached.keys;
  }

  const encodedUserId = encodeURIComponent(sessionKey);
  const [hiddenRows, leadRows, conversationRows] = await Promise.all([
    fetchJsonOrEmpty(
      `/opportunity_hidden_contacts?user_id=eq.${encodedUserId}&select=contact_phone_normalized,source_conversation_id`,
      "hidden_contacts",
    ),
    fetchJsonOrEmpty(
      `/crm_leads?user_id=eq.${encodedUserId}&select=id,phone,phone_normalized,stage`,
      "crm_leads",
    ),
    fetchJsonOrEmpty(
      `/whatsapp_conversations?user_id=eq.${encodedUserId}&select=id,contact_phone,contact_phone_normalized,whatsapp_jid,crm_lead_id,hidden_from_opportunities`,
      "whatsapp_conversations",
    ),
  ]);

  const hiddenPhones = new Set(
    hiddenRows
      .map((row) => normalizeBrazilianPhone(row.contact_phone_normalized))
      .filter(Boolean),
  );
  const hiddenConversationIds = new Set(
    hiddenRows
      .map((row) => String(row.source_conversation_id || "").trim())
      .filter(Boolean),
  );
  const leadIds = new Set(
    leadRows
      .map((row) => String(row.id || "").trim())
      .filter(Boolean),
  );

  const keys = emptyPipelineContactKeys();

  for (const lead of leadRows) {
    const phone = normalizeBrazilianPhone(lead.phone_normalized || lead.phone);
    if (phone && !hiddenPhones.has(phone)) keys.phones.add(phone);
  }

  for (const conversation of conversationRows) {
    const conversationId = String(conversation.id || "").trim();
    const leadId = String(conversation.crm_lead_id || "").trim();
    const phone = normalizeBrazilianPhone(conversation.contact_phone_normalized || conversation.contact_phone);

    if (!leadId || !leadIds.has(leadId)) continue;
    if (conversation.hidden_from_opportunities || hiddenConversationIds.has(conversationId)) continue;
    if (phone && hiddenPhones.has(phone)) continue;

    if (phone) keys.phones.add(phone);

    const jid = normalizeDirectJid(conversation.whatsapp_jid);
    if (jid) keys.jids.add(jid);
  }

  pipelineContactCache.set(sessionKey, { loadedAt: Date.now(), keys });
  console.log("[bot] pipeline contact keys loaded", {
    sessionKey,
    phones: keys.phones.size,
    jids: keys.jids.size,
  });

  return keys;
}

function isPipelineHistoryMessage(message, keys) {
  const { phone, jid } = messageContactKeys(message);
  return Boolean((phone && keys.phones.has(phone)) || (jid && keys.jids.has(jid)));
}

async function forwardWhatsAppMessage(session, message, source = "notify") {
  const jid = message?.key?.remoteJid;
  const fromMe = isMessageFromConnectedAccount(session, message);
  const messageId = message?.key?.id;
  const dedupeKey = `${session.sessionKey}:${jid}:${messageId}`;

  if (isIgnorableJid(jid)) {
    if (source === "notify") {
      console.log("[bot] live message ignored", { reason: "ignorable_jid", jidType: String(jid || "").split("@")[1] || null });
    }
    return false;
  }
  if (source === "history_sync" && !isWithinHistorySyncWindow(message)) return false;

  const body = extractMessageText(message);
  const messageType = extractMessageType(message);
  const mediaUrl = await persistMediaMessage(message, session.sessionKey);
  const contactPhone = contactPhoneFromMessage(message);
  if (!body?.trim() && !mediaUrl) {
    if (source === "notify") {
      console.log("[bot] live message ignored", {
        reason: "unsupported_content",
        messageType,
        hasMessageId: Boolean(messageId),
        jidType: String(jid || "").split("@")[1] || null,
      });
    }
    return false;
  }
  if (rememberMessage(dedupeKey)) {
    if (source === "notify") console.log("[bot] live message ignored", { reason: "duplicate", hasMessageId: Boolean(messageId) });
    return false;
  }

  await postInboundEvent({
    session_key: session.sessionKey,
    message_id: messageId,
    whatsapp_message_id: messageId,
    whatsapp_jid: jid,
    contact_phone: contactPhone,
    contact_name: fromMe ? null : message.pushName || null,
    body: body?.trim() || null,
    media_url: mediaUrl,
    message_type: messageType,
    timestamp: parseMessageTimestamp(message.messageTimestamp),
    direction: fromMe ? "outbound" : "inbound",
  });

  return true;
}

function isRecentSessionMessage(session, message) {
  return !isReplayMessage(session, message);
}

async function processRecentHistoryMessages(session, messages = []) {
  if (!session?.allowHistorySync || !Array.isArray(messages) || messages.length === 0) {
    return { considered: 0, forwarded: 0 };
  }

  const now = Date.now();
  // A central de Conversas espelha todo chat recente recebido do WhatsApp;
  // a entrada no funil e decidida depois por crm_leads.is_pipeline_lead.
  const recentMessages = messages
    .filter((message) => !isIgnorableJid(message?.key?.remoteJid))
    .filter((message) => isWithinHistorySyncWindow(message, now))
    .sort((a, b) => messageTimestampMs(a?.messageTimestamp) - messageTimestampMs(b?.messageTimestamp))
    .slice(-Math.max(1, HISTORY_SYNC_MAX_MESSAGES));

  let forwarded = 0;
  for (const message of recentMessages) {
    try {
      if (await forwardWhatsAppMessage(session, message, "history_sync")) forwarded += 1;
    } catch (error) {
      console.error("[bot] history sync webhook error", error);
    }
  }

  return { considered: recentMessages.length, forwarded };
}

async function processRecentAppendMessages(session, messages = []) {
  if (!session?.allowHistorySync || !Array.isArray(messages) || messages.length === 0) {
    return { considered: 0, forwarded: 0 };
  }

  const now = Date.now();
  // Append tambem pode conter mensagens de contatos que ainda nao estao no
  // pipeline. Elas continuam pertencendo a Conversas e devem ser persistidas.
  const recentMessages = messages
    .filter((message) => !isIgnorableJid(message?.key?.remoteJid))
    .filter((message) => isWithinHistorySyncWindow(message, now))
    .sort((a, b) => messageTimestampMs(a?.messageTimestamp) - messageTimestampMs(b?.messageTimestamp))
    .slice(-Math.max(1, HISTORY_SYNC_MAX_MESSAGES));

  let forwarded = 0;
  for (const message of recentMessages) {
    try {
      if (await forwardWhatsAppMessage(session, message, "append")) forwarded += 1;
    } catch (error) {
      console.error("[bot] append sync webhook error", error);
    }
  }

  return { considered: recentMessages.length, forwarded };
}

async function syncPipelineLeadsWithActiveAppointments(sessionKey) {
  if (!OPPORTUNITY_APPOINTMENT_SYNC_ENABLED) {
    return { checked: 0, updated: 0 };
  }

  const encodedUserId = encodeURIComponent(sessionKey);
  const [hiddenRows, leadRows, conversationRows, appointmentRows, clientRows] = await Promise.all([
    fetchJsonOrEmpty(
      `/opportunity_hidden_contacts?user_id=eq.${encodedUserId}&select=contact_phone_normalized,source_conversation_id`,
      "hidden_contacts_for_appointment_sync",
    ),
    fetchJsonOrEmpty(
      `/crm_leads?user_id=eq.${encodedUserId}&select=id,client_id,phone,phone_normalized,stage,updated_at&limit=1000`,
      "crm_leads_for_appointment_sync",
    ),
    fetchJsonOrEmpty(
      `/whatsapp_conversations?user_id=eq.${encodedUserId}&select=id,crm_lead_id,client_id,contact_phone,contact_phone_normalized,hidden_from_opportunities&limit=1000`,
      "whatsapp_conversations_for_appointment_sync",
    ),
    fetchJsonOrEmpty(
      `/compromissos?user_id=eq.${encodedUserId}&deleted_at=is.null&status=in.(agendado,confirmado,pendente)&select=id,client_id,data,horario_inicio,updated_at&order=data.asc&order=horario_inicio.asc&limit=1000`,
      "appointments_for_appointment_sync",
    ),
    fetchJsonOrEmpty(
      `/clients?user_id=eq.${encodedUserId}&deleted_at=is.null&select=id,phone,whatsapp,phone_normalized,whatsapp_normalized&limit=1000`,
      "clients_for_appointment_sync",
    ),
  ]);

  const hiddenPhones = new Set(
    hiddenRows
      .map((row) => normalizeBrazilianPhone(row.contact_phone_normalized))
      .filter(Boolean),
  );
  const hiddenConversationIds = new Set(
    hiddenRows
      .map((row) => String(row.source_conversation_id || "").trim())
      .filter(Boolean),
  );
  const visibleLeadIdsByConversation = new Set();
  const conversationClientByLeadId = new Map();
  const conversationPhoneByLeadId = new Map();

  for (const conversation of conversationRows) {
    const conversationId = String(conversation.id || "").trim();
    const leadId = String(conversation.crm_lead_id || "").trim();
    const phone = normalizeBrazilianPhone(conversation.contact_phone_normalized || conversation.contact_phone);

    if (!leadId) continue;
    if (conversation.hidden_from_opportunities || hiddenConversationIds.has(conversationId)) continue;
    if (phone && hiddenPhones.has(phone)) continue;

    visibleLeadIdsByConversation.add(leadId);
    if (conversation.client_id) conversationClientByLeadId.set(leadId, conversation.client_id);
    if (phone) conversationPhoneByLeadId.set(leadId, phone);
  }

  const activeAppointmentClientIds = new Set(
    appointmentRows
      .map((appointment) => String(appointment.client_id || "").trim())
      .filter(Boolean),
  );

  if (activeAppointmentClientIds.size === 0) {
    return { checked: leadRows.length, updated: 0 };
  }

  const activeClientByPhone = new Map();
  for (const client of clientRows) {
    const clientId = String(client.id || "").trim();
    if (!clientId || !activeAppointmentClientIds.has(clientId)) continue;

    for (const value of [client.phone_normalized, client.whatsapp_normalized, client.phone, client.whatsapp]) {
      const phone = normalizeBrazilianPhone(value);
      if (phone && !hiddenPhones.has(phone)) activeClientByPhone.set(phone, clientId);
    }
  }

  let updated = 0;
  for (const lead of leadRows) {
    const leadId = String(lead.id || "").trim();
    if (!leadId || !visibleLeadIdsByConversation.has(leadId)) continue;
    if (!isSchedulableOpportunityStage(lead.stage)) continue;

    const leadPhone = normalizeBrazilianPhone(lead.phone_normalized || lead.phone);
    const conversationPhone = conversationPhoneByLeadId.get(leadId);
    if (isHiddenPipelinePhone(leadPhone, hiddenPhones) || isHiddenPipelinePhone(conversationPhone, hiddenPhones)) continue;

    const knownClientId = String(lead.client_id || conversationClientByLeadId.get(leadId) || "").trim();
    const matchedClientId =
      (knownClientId && activeAppointmentClientIds.has(knownClientId) ? knownClientId : null) ||
      (leadPhone ? activeClientByPhone.get(leadPhone) : null) ||
      (conversationPhone ? activeClientByPhone.get(conversationPhone) : null);

    if (!matchedClientId) continue;

    const payload = {
      stage: "Agendada",
      updated_at: new Date().toISOString(),
    };
    if (!lead.client_id) payload.client_id = matchedClientId;

    const response = await supabaseFetch(`/crm_leads?id=eq.${encodeURIComponent(leadId)}&user_id=eq.${encodedUserId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(payload),
    });

    if (!response?.ok) {
      console.warn("[bot] failed to sync opportunity lead stage with appointment", {
        sessionKey,
        leadId,
        status: response?.status ?? null,
        error: response ? await response.text().catch(() => "") : "missing service role",
      });
      continue;
    }

    updated += 1;
  }

  return { checked: leadRows.length, updated };
}

async function supabaseFetch(pathname, options = {}) {
  if (!SUPABASE_SERVICE_ROLE_KEY) return null;

  return fetch(`${SUPABASE_URL}/rest/v1${pathname}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
}

async function supabaseStorageFetch(pathname, options = {}) {
  if (!SUPABASE_SERVICE_ROLE_KEY) return null;

  const res = await fetch(`${SUPABASE_URL}/storage/v1${pathname}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...(options.headers || {}),
    },
  });

  if (!res.ok) return null;

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json();
  }

  return res.text();
}

async function syncConnectionStatus(sessionKey, status, extra = {}) {
  if (!SUPABASE_SERVICE_ROLE_KEY) return;

  const payload = {
    user_id: sessionKey,
    session_key: sessionKey,
    status: toDatabaseStatus(status),
    phone_number: extra.phone || null,
    device_info: {
      source: "genda-whatsapp-bot",
      api_status: toApiStatus(status),
      last_error: extra.lastError || null,
      health_reason: extra.healthReason || null,
    },
    updated_at: new Date().toISOString(),
  };

  const response = await supabaseFetch("/whatsapp_connections?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(payload),
  });

  if (response && !response.ok) {
    const text = await response.text();
    console.error("[bot] failed to sync whatsapp_connections", response.status, text);
  }
}

function isSessionDecryptError(obj, msg) {
  const message = [
    msg,
    obj?.err?.message,
    obj?.error?.message,
    obj?.message,
  ].filter(Boolean).join(" ");

  return /failed to decrypt message|no session record|no session found to decrypt message|invalid prekey id|bad mac|messagecountererror|key used already|never filled/i.test(message);
}

function getDecryptRecovery(sessionKey, now = Date.now()) {
  const current = decryptRecoveryState.get(sessionKey);
  if (!current || now - current.lastSoftReconnectAt > DECRYPT_RECOVERY_RESET_MS) {
    const fresh = { softReconnects: 0, lastSoftReconnectAt: 0 };
    decryptRecoveryState.set(sessionKey, fresh);
    return fresh;
  }

  return current;
}

function recordDecryptError(session, obj, msg) {
  if (!session || session.healthMarkedDisconnected || session.decryptRecoveryInProgress) return;

  const now = Date.now();
  if (session.connectedAt && now - session.connectedAt < DECRYPT_RECOVERY_CONNECTION_GRACE_MS) {
    return;
  }

  session.decryptErrorTimestamps = (session.decryptErrorTimestamps || [])
    .filter((timestamp) => now - timestamp < DECRYPT_ERROR_WINDOW_MS);
  session.decryptErrorTimestamps.push(now);

  if (session.status !== "connected" || session.decryptErrorTimestamps.length < DECRYPT_ERROR_THRESHOLD) return;

  recoverUnhealthyDecryptSession(session, obj, msg, now);
}

function recoverUnhealthyDecryptSession(session, obj, msg, now = Date.now()) {
  if (!session || session.healthMarkedDisconnected || session.decryptRecoveryInProgress) return;

  session.decryptErrorTimestamps = (session.decryptErrorTimestamps || [])
    .filter((timestamp) => now - timestamp < DECRYPT_ERROR_WINDOW_MS);

  if (session.status !== "connected" || session.decryptErrorTimestamps.length < DECRYPT_ERROR_THRESHOLD) return;

  const recovery = getDecryptRecovery(session.sessionKey, now);
  const canSoftReconnect =
    recovery.softReconnects < DECRYPT_SOFT_RECONNECT_MAX_ATTEMPTS &&
    now - recovery.lastSoftReconnectAt >= DECRYPT_SOFT_RECONNECT_COOLDOWN_MS;

  if (canSoftReconnect) {
    recovery.softReconnects += 1;
    recovery.lastSoftReconnectAt = now;
    session.status = "reconnecting";
    session.lastError = "Falha temporária ao descriptografar mensagens. Tentando reconectar a sessão.";
    session.decryptErrorTimestamps = [];
    session.decryptRecoveryInProgress = true;

    console.warn("[bot] session soft reconnect by decrypt health check", {
      sessionKey: session.sessionKey,
      softReconnects: recovery.softReconnects,
      errorsInWindow: DECRYPT_ERROR_THRESHOLD,
      reason: msg || obj?.err?.message || obj?.error?.message || "decrypt_error",
    });

    try {
      session.sock?.end?.(new Error(session.lastError));
    } catch (error) {
      console.warn("[bot] failed to end socket for soft reconnect", error);
    }

    void syncConnectionStatus(session.sessionKey, "reconnecting", {
      phone: session.phone,
      lastError: session.lastError,
      healthReason: "decrypt_error",
    })
      .catch((error) => console.error("[bot] failed to sync soft reconnect status", error));
    return;
  }

  session.status = "needs_reconnect";
  session.lastError = "Sessão do WhatsApp sem chave para descriptografar mensagens. Reconecte pelo QR.";
  session.healthMarkedDisconnected = true;
  console.error("[bot] session marked disconnected by decrypt health check", {
    sessionKey: session.sessionKey,
    errorsInWindow: session.decryptErrorTimestamps.length,
    reason: msg || obj?.err?.message || obj?.error?.message || "decrypt_error",
  });

  try {
    session.sock?.end?.(new Error(session.lastError));
  } catch (error) {
    console.warn("[bot] failed to end unhealthy socket", error);
  }

  void syncConnectionStatus(session.sessionKey, "disconnected", {
    phone: session.phone,
    lastError: session.lastError,
    healthReason: "decrypt_error",
  })
    .catch((error) => console.error("[bot] failed to sync unhealthy session status", error));
}

function makeSessionLogger(session) {
  const levels = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
  const configuredLevel = levels[BAILEYS_LOG_LEVEL] || levels.warn;

  const log = (level, obj, msg) => {
    const decryptError = isSessionDecryptError(obj, msg);
    if (decryptError) recordDecryptError(session, obj, msg);
    if (msg === "sending receipt for messages" && obj?.attrs?.type === "peer_msg") {
      recordLowLevelPeerSignal(session);
    }

    if (decryptError && configuredLevel > levels.debug) return;
    if ((levels[level] || levels.info) < configuredLevel) return;

    const output = [`[baileys:${level}]`];
    if (msg) output.push(msg);

    if (level === "error" || level === "fatal") console.error(...output);
    else if (level === "warn") console.warn(...output);
    else console.log(...output);
  };

  return {
    level: BAILEYS_LOG_LEVEL,
    trace: (obj, msg) => log("trace", obj, msg),
    debug: (obj, msg) => log("debug", obj, msg),
    info: (obj, msg) => log("info", obj, msg),
    warn: (obj, msg) => log("warn", obj, msg),
    error: (obj, msg) => log("error", obj, msg),
    fatal: (obj, msg) => log("fatal", obj, msg),
    child: () => makeSessionLogger(session),
  };
}

async function postInboundEvent(payload) {
  const response = await fetch(`${SUPABASE_FUNCTIONS_URL}/whatsapp-inbound-webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BOT_INTERNAL_TOKEN}`,
      "x-bot-signature": BOT_INTERNAL_TOKEN,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Supabase webhook failed ${response.status}: ${errorText}`);
  }
}

async function postMessageStatusUpdate(payload) {
  const response = await fetch(`${SUPABASE_FUNCTIONS_URL}/whatsapp-inbound-webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BOT_INTERNAL_TOKEN}`,
      "x-bot-signature": BOT_INTERNAL_TOKEN,
    },
    body: JSON.stringify({
      event: "message_status",
      ...payload,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Supabase status webhook failed ${response.status}: ${errorText}`);
  }
}

async function createSession(sessionKey) {
  ensureConfig();

  const existing = sessions.get(sessionKey);
  if (existing?.status === "needs_reconnect") {
    console.warn("[bot] clearing unhealthy stored auth before fresh QR", { sessionKey });
    await clearStoredSessionAuth(sessionKey);
  }

  if (existing?.sock && !["error", "needs_reconnect"].includes(existing.status)) {
    console.log("[bot] reusing active session", {
      sessionKey,
      status: existing.status,
      qrPresent: Boolean(existing.qr),
    });
    return existing;
  }

  if (existing?.status === "qr_pending" && existing.qr) {
    console.log("[bot] reusing pending QR session", {
      sessionKey,
      qrPresent: true,
    });
    return existing;
  }

  if (existing?.status === "reconnecting" && sessionReconnectTimers.has(sessionKey)) {
    return existing;
  }

  const pendingStart = sessionStartPromises.get(sessionKey);
  if (pendingStart) {
    console.log("[bot] waiting pending session start", { sessionKey });
    return pendingStart;
  }

  const startPromise = startSession(sessionKey);
  sessionStartPromises.set(sessionKey, startPromise);

  try {
    return await startPromise;
  } finally {
    sessionStartPromises.delete(sessionKey);
  }
}

async function useSupabaseAuthState(sessionKey) {
  const BUCKET = "whatsapp-sessions";
  const remotePrefix = `sessions/${sessionKey}`;
  const localPath = sessionPath(sessionKey);

  async function uploadCreds(data) {
    await supabaseStorageFetch(`/object/${BUCKET}/${remotePrefix}/creds.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-upsert": "true",
      },
      body: JSON.stringify(data),
    });
  }

  async function downloadCreds() {
    return supabaseStorageFetch(`/object/${BUCKET}/${remotePrefix}/creds.json`, {
      method: "GET",
    });
  }

  // Tenta restaurar creds do Storage para o cache local
  await fs.mkdir(localPath, { recursive: true });

  const remoteCreds = await downloadCreds();
  if (remoteCreds) {
    await fs.writeFile(
      path.join(localPath, "creds.json"),
      typeof remoteCreds === "string" ? remoteCreds : JSON.stringify(remoteCreds),
    );
    console.log("[auth] creds restaurados do Supabase Storage", { sessionKey });
  }

  // Inicializa com filesystem local normalmente
  const { state, saveCreds: saveCredsLocal } = await useMultiFileAuthState(localPath);

  // saveCreds salva local + Storage
  async function saveCreds() {
    await saveCredsLocal();

    // Retry com delay para garantir que o arquivo foi escrito completamente
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        await new Promise(resolve => setTimeout(resolve, 300));
        const credsRaw = await fs.readFile(path.join(localPath, "creds.json"), "utf-8");

        // Valida JSON antes de enviar
        const parsed = JSON.parse(credsRaw);
        if (!parsed || !parsed.noiseKey) {
          throw new Error("creds.json incompleto ou inválido");
        }

        await uploadCreds(parsed);
        console.log("[auth] creds salvos no Storage com sucesso", { sessionKey });
        return;
      } catch (e) {
        attempts++;
        console.warn("[auth] tentativa falhou ao salvar creds no Storage", {
          sessionKey,
          attempt: attempts,
          error: e.message,
        });
        if (attempts >= maxAttempts) {
          console.error("[auth] desistindo após 3 tentativas", { sessionKey });
        }
      }
    }
  }

  return { state, saveCreds };
}

async function startSession(sessionKey) {
  ensureConfig();

  const processLock = await acquireSessionProcessLock(sessionKey);

  try {
    await fs.mkdir(sessionPath(sessionKey), { recursive: true });

    const hadStoredAuth = await hasStoredSessionAuth(sessionKey);
    const { state, saveCreds } = await useSupabaseAuthState(sessionKey);
    const session = {
      sessionKey,
      status: "initializing",
      qr: null,
      phone: null,
      sock: null,
      hasOpened: false,
      connectedAt: null,
      authCleared: false,
      processLock,
      decryptErrorTimestamps: [],
      healthMarkedDisconnected: false,
      decryptRecoveryInProgress: false,
      messageListenerRecoveryInProgress: false,
      lastLowLevelPeerMessageAt: null,
      lastNotifyUpsertAt: null,
      lowLevelPeerSignalsSinceNotify: 0,
      lastMessageListenerReconnectAt: null,
      lastQrAt: null,
      lastError: null,
      acceptMessagesAfterMs: Date.now() - MESSAGE_REPLAY_GRACE_MS,
      allowHistorySync: HISTORY_SYNC_ENABLED,
      appointmentSyncStarted: false,
    };
    sessions.set(sessionKey, session);

    const logger = makeSessionLogger(session);
    state.keys = makeCacheableSignalKeyStore(state.keys, logger);
    const whatsappWebVersion = await resolveWhatsAppWebVersion();

    const sock = makeWASocket({
      version: whatsappWebVersion,
      auth: state,
      logger,
      printQRInTerminal: false,
      fireInitQueries: false,
      shouldSyncHistoryMessage: (historyMessage) => session.allowHistorySync && shouldProcessHistorySyncMessage(historyMessage),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      maxMsgRetryCount: WHATSAPP_MAX_MESSAGE_RETRY_COUNT,
      retryRequestDelayMs: WHATSAPP_RETRY_REQUEST_DELAY_MS,
      defaultQueryTimeoutMs: 30000,
      browser: ["Ubuntu", "Chrome", "22.04.4"],
      getMessage: getCachedOutboundMessage,
    });

    session.sock = sock;
    sock.ev.on("creds.update", () => {
      runSessionEvent(session, "creds.update", saveCreds);
    });

  sock.ev.on("connection.update", (update) => {
    runSessionEvent(session, "connection.update", async () => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        session.status = "qr_pending";
        session.qr = qr;
        session.lastQrAt = new Date().toISOString();
        session.lastError = null;
        console.log("[bot] qr generated", { sessionKey, qrPresent: true });
        await syncConnectionStatus(sessionKey, "qr_pending");
      }

      if (connection === "connecting") {
        session.status = session.qr ? "qr_pending" : "reconnecting";
        await syncConnectionStatus(sessionKey, session.status, { phone: session.phone, lastError: session.lastError });
      }

      if (connection === "open") {
      session.status = "connected";
      session.connectedAt = Date.now();
      await saveCreds();
      session.qr = null;
      session.hasOpened = true;
      session.healthMarkedDisconnected = false;
      session.decryptRecoveryInProgress = false;
      session.decryptErrorTimestamps = [];
      session.messageListenerRecoveryInProgress = false;
      session.lastLowLevelPeerMessageAt = null;
      session.lastNotifyUpsertAt = null;
      session.lowLevelPeerSignalsSinceNotify = 0;
      session.phone = phoneFromJid(sock.user?.id) || session.phone;
      session.lastError = null;
      session.acceptMessagesAfterMs = Date.now() - MESSAGE_REPLAY_GRACE_MS;
      console.log("[bot] session connected", { sessionKey, phonePresent: Boolean(session.phone) });
      recoverUnhealthyDecryptSession(session, { message: "decrypt errors during reconnect" }, "decrypt_errors_during_connect");
      if (session.status !== "connected") return;
      await syncConnectionStatus(sessionKey, "connected", { phone: session.phone, lastError: session.lastError });

      if (session.allowHistorySync && !session.appointmentSyncStarted) {
        session.appointmentSyncStarted = true;
        void syncPipelineLeadsWithActiveAppointments(sessionKey)
          .then((result) => {
            console.log("[bot] opportunity appointment sync completed", {
              sessionKey,
              checked: result.checked,
              updated: result.updated,
            });
          })
          .catch((error) => {
            console.error("[bot] opportunity appointment sync failed", error);
            session.appointmentSyncStarted = false;
          });
      }
      }

      if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const restartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
      const wasWaitingForQr = session.status === "qr_pending" || (!session.hasOpened && Boolean(session.qr));
      const markedUnhealthy = session.healthMarkedDisconnected || session.status === "needs_reconnect";
      const recoveringFromDecryptError = session.decryptRecoveryInProgress && !loggedOut && !markedUnhealthy;
      const shouldReconnect = recoveringFromDecryptError || (!markedUnhealthy && !loggedOut && (restartRequired || (!wasWaitingForQr && session.hasOpened)));

      session.status = markedUnhealthy ? "needs_reconnect" : (shouldReconnect ? "reconnecting" : "disconnected");
      session.sock = null;
      session.lastError = lastDisconnect?.error?.message || null;
      if (!shouldReconnect) {
        session.qr = null;
      }
      if (loggedOut) {
        session.authCleared = true;
        await clearStoredSessionAuth(sessionKey);
      } else if (markedUnhealthy) {
        session.authCleared = true;
        await clearStoredSessionAuth(sessionKey);
      }
      console.log("[bot] session closed", {
        sessionKey,
        status: session.status,
        statusCode,
        loggedOut,
        restartRequired,
        markedUnhealthy,
        wasWaitingForQr,
        shouldReconnect,
        error: session.lastError,
      });
      await syncConnectionStatus(sessionKey, session.status, { phone: session.phone, lastError: session.lastError });

      if (!shouldReconnect) {
        resetSessionReconnectState(sessionKey);
        await releaseSessionProcessLock(sessionKey);
      }

      if (shouldReconnect) {
        scheduleSessionReconnect(session, `connection_close_${statusCode || "unknown"}`);
      }
      }
    });
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    runSessionEvent(session, "messages.upsert", async () => {
    console.log("[bot] messages.upsert received", {
      sessionKey,
      type,
      count: Array.isArray(messages) ? messages.length : 0,
      items: (messages || []).slice(0, 10).map((message) => ({
        fromMe: message?.key?.fromMe === true,
        hasMessageId: Boolean(message?.key?.id),
        jidType: String(message?.key?.remoteJid || "").split("@")[1] || null,
        rawContentKeys: Object.keys(message?.message || {}).slice(0, 10),
        normalizedContentKeys: Object.keys(unwrapMessageContent(message) || {}).slice(0, 10),
        messageStubType: message?.messageStubType ?? null,
        messageType: extractMessageType(message),
        hasText: Boolean(extractMessageText(message)?.trim()),
        hasMedia: Boolean(extractMediaInfo(message)),
      })),
    });

    if (type === "notify") {
      session.lastNotifyUpsertAt = Date.now();
      session.lowLevelPeerSignalsSinceNotify = 0;
    }

    if (type === "notify") {
      for (const message of messages || []) {
        if (message?.key?.fromMe) {
          rememberOutboundMessage(message.key, message.message);
        }
        await forwardWhatsAppMessage(session, message, "notify")
          .catch((error) => console.error("[bot] inbound webhook error", error));
      }
      return;
    }

    if (type === "append") {
      const result = await processRecentAppendMessages(session, messages);
      if (result.considered > 0 || result.forwarded > 0) {
        console.log("[bot] recent append sync processed", {
          sessionKey,
          type,
          received: messages?.length || 0,
          considered: result.considered,
          forwarded: result.forwarded,
          lookbackHours: Math.round(HISTORY_SYNC_LOOKBACK_MS / (60 * 60 * 1000)),
        });
      }
    }
    });
  });

  sock.ev.on("messaging-history.set", ({ messages = [], syncType, progress, isLatest }) => {
    runSessionEvent(session, "messaging-history.set", async () => {
      const result = await processRecentHistoryMessages(session, messages);
      console.log("[bot] recent history sync processed", {
        sessionKey,
        syncType,
        progress,
        isLatest,
        received: messages.length,
        considered: result.considered,
        forwarded: result.forwarded,
        lookbackHours: Math.round(HISTORY_SYNC_LOOKBACK_MS / (60 * 60 * 1000)),
      });
    });
  });

  sock.ev.on("messages.update", (updates) => {
    runSessionEvent(session, "messages.update", async () => {
      for (const item of updates || []) {
        const jid = item.key?.remoteJid;
        const messageId = item.key?.id;
        const status = statusNameFromBaileys(item.update?.status);

        if (!messageId || !status || isIgnorableJid(jid)) continue;

        const dedupeKey = `${sessionKey}:${messageId}:${status}`;
        if (rememberStatusUpdate(dedupeKey)) continue;

        await enqueueMessageStatusUpdate({
          session_key: sessionKey,
          message_id: messageId,
          whatsapp_message_id: messageId,
          whatsapp_jid: jid,
          status,
          timestamp: Date.now(),
        });
      }
    });
  });

    return session;
  } catch (error) {
    sessions.delete(sessionKey);
    await releaseSessionProcessLock(sessionKey);
    throw error;
  }
}

function getExistingSession(sessionKey) {
  return sessions.get(sessionKey) || null;
}

async function waitForSessionStartResult(session, timeoutMs = 15000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (
      session.status === "qr_pending" ||
      session.status === "connected" ||
      session.status === "disconnected" ||
      session.status === "error" ||
      session.qr
    ) {
      return session;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return session;
}

async function waitForConnectedSession(session, timeoutMs = 15000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const status = effectiveSessionStatus(session);
    if (status === "connected") return session;
    if (status === "qr_pending" || status === "disconnected" || status === "error" || status === "needs_reconnect") return session;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return session;
}

async function resolveWhatsAppDestination(sock, rawPhone, rawJid) {
  const providedJid = normalizeDirectJid(rawJid);
  if (providedJid?.endsWith("@lid")) {
    return { jid: providedJid, resolvedBy: "provided_jid" };
  }

  const phoneCandidates = whatsappPhoneCandidates(rawPhone || phoneFromJid(providedJid));
  if (phoneCandidates.length === 0) {
    return providedJid ? { jid: providedJid, resolvedBy: "provided_jid" } : null;
  }

  const lookupJids = phoneCandidates.map((phone) => `${phone}@s.whatsapp.net`);
  const lookupResults = await sock.onWhatsApp(...lookupJids);
  if (!Array.isArray(lookupResults)) {
    const error = new Error("WhatsApp number lookup did not return a result");
    error.code = "WHATSAPP_LOOKUP_FAILED";
    error.httpStatus = 503;
    throw error;
  }

  const canonicalJid = pickCanonicalWhatsAppJid(lookupResults, phoneCandidates);
  if (!canonicalJid) {
    const error = new Error("Phone number is not registered on WhatsApp");
    error.code = "WHATSAPP_NUMBER_NOT_REGISTERED";
    error.httpStatus = 422;
    throw error;
  }

  return { jid: canonicalJid, resolvedBy: "on_whatsapp" };
}

async function sendManualMessage(req, res) {
  const sessionKey = String(req.body?.sessionKey || req.body?.session_key || req.body?.userId || "").trim();
  const to = normalizeBrazilianPhone(req.body?.to);
  const requestedJid = req.body?.jid || req.body?.whatsapp_jid;
  const text = String(req.body?.text || "").trim();
  const mediaBase64 = String(req.body?.mediaBase64 || req.body?.media_base64 || "").replace(/^data:[^;]+;base64,/i, "").trim();
  const mediaType = String(req.body?.mediaType || req.body?.media_type || "").trim();
  const mimeType = String(req.body?.mimeType || req.body?.mime_type || "application/octet-stream").trim();
  const fileName = String(req.body?.fileName || req.body?.file_name || "arquivo").trim().replace(/[^\w.\-\s()[\]]+/g, "_").slice(0, 120) || "arquivo";
  const hasMedia = Boolean(mediaBase64);

  if (!sessionKey || (!requestedJid && !to) || (!text && !hasMedia)) {
    return res.status(400).json({ success: false, error: "sessionKey, destination and text or media are required" });
  }

  if (hasMedia && !["image", "audio", "video", "document"].includes(mediaType)) {
    return res.status(400).json({ success: false, error: "unsupported media type" });
  }

  try {
    const session = await getRestoredSession(sessionKey);
    if (!session) {
      return res.status(409).json({ success: false, error: "session not connected", status: "disconnected" });
    }

    const readySession = await waitForConnectedSession(session);
    if (!readySession.sock || readySession.status !== "connected") {
      return res.status(409).json({ success: false, error: "session not connected", status: readySession.status });
    }

    const destination = await resolveWhatsAppDestination(readySession.sock, to, requestedJid);
    if (!destination?.jid) {
      return res.status(400).json({ success: false, error: "invalid WhatsApp destination" });
    }
    const destinationJid = destination.jid;

    let payload;
    let mediaBuffer = null;
    let mediaUrl = null;
    if (hasMedia) {
      const buffer = Buffer.from(mediaBase64, "base64");
      if (!buffer.length || buffer.length > 9 * 1024 * 1024) {
        return res.status(400).json({ success: false, error: "invalid or oversized media" });
      }
      mediaBuffer = buffer;

      if (mediaType === "image") {
        payload = { image: buffer, caption: text || undefined, mimetype: mimeType };
      } else if (mediaType === "audio") {
        payload = { audio: buffer, mimetype: mimeType, ptt: false };
      } else if (mediaType === "video") {
        payload = { video: buffer, caption: text || undefined, mimetype: mimeType };
      } else {
        payload = { document: buffer, caption: text || undefined, mimetype: mimeType, fileName };
      }
    } else {
      payload = { text };
    }

    const result = await enqueueSessionSend(sessionKey, async () => readySession.sock.sendMessage(destinationJid, payload));
    if (mediaBuffer) {
      mediaUrl = await persistMediaBuffer(mediaBuffer, {
        sessionKey,
        messageId: result?.key?.id,
        mimetype: mimeType,
        fileName,
      });
    }
    rememberOutboundMessage(result?.key, result?.message);
    res.json({
      success: true,
      status: "sent",
      messageId: result?.key?.id || null,
      jid: result?.key?.remoteJid || destinationJid,
      destinationResolvedBy: destination.resolvedBy,
      key: result?.key || null,
      mediaUrl,
      media_url: mediaUrl,
    });
  } catch (error) {
    const httpStatus = Number.isInteger(error?.httpStatus) ? error.httpStatus : 500;
    res.status(httpStatus).json({
      success: false,
      error: error?.code || (error instanceof Error ? error.message : "send failed"),
    });
  }
}

app.get("/health", async (_req, res) => {
  const checks = {};
  let healthy = true;

  // 1. Checa variáveis de ambiente obrigatórias
  const requiredEnvs = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "BOT_INTERNAL_TOKEN", "SESSION_DIR"];
  const missingEnvs = requiredEnvs.filter(e => !process.env[e]);
  checks.envs = missingEnvs.length === 0 ? "ok" : `missing: ${missingEnvs.join(", ")}`;
  if (missingEnvs.length > 0) healthy = false;

  // 2. Checa se o diretório de sessão existe e tem permissão de escrita
  try {
    const testFile = `${SESSION_DIR}/.healthcheck`;
    await fs.writeFile(testFile, Date.now().toString());
    await fs.unlink(testFile);
    checks.volume = "ok";
  } catch (e) {
    checks.volume = `error: ${e.message}`;
    healthy = false;
  }

  // 3. Conta sessões ativas usando o Map `sessions` existente no worker
  const sessionSummary = [];
  for (const [key, session] of sessions.entries()) {
    sessionSummary.push({
      id: key,
      status: session.status ?? "unknown",
      connected: !!(session.sock && session.status === "connected"),
    });
  }
  const connectedCount = sessionSummary.filter(s => s.connected).length;
  checks.sessions = {
    total: sessions.size,
    connected: connectedCount,
    detail: sessionSummary,
  };

  // 4. Timestamp e uptime
  checks.timestamp = new Date().toISOString();
  checks.uptime = Math.floor(process.uptime());

  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    checks,
  });
});

app.get("/api/media/:token", async (req, res) => {
  pruneExpiredMedia();

  const entry = mediaMessages.get(req.params.token);
  if (!entry) {
    return res.status(404).json({ success: false, error: "media_expired_or_not_found" });
  }

  try {
    const buffer = entry.buffer || await downloadMediaMessage(entry.message, "buffer", {});
    const extension = entry.mimetype.split("/")[1]?.split(";")[0] || "bin";
    const safeFileName = String(entry.fileName || `whatsapp-media.${extension}`).replace(/[^\w.\-]+/g, "_");
    const disposition = req.query.download === "1" ? "attachment" : "inline";

    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("Content-Type", entry.mimetype);
    res.setHeader("Content-Disposition", `${disposition}; filename="${safeFileName}"`);
    return res.send(buffer);
  } catch (error) {
    console.error("[bot] media download error", error);
    return res.status(410).json({ success: false, error: "media_unavailable" });
  }
});

app.post("/api/session/start", requireInternalToken, async (req, res) => {
  const sessionKey = String(req.body?.sessionKey || req.body?.session_key || req.body?.userId || "").trim();
  if (!sessionKey) return res.status(400).json({ success: false, error: "sessionKey required" });

  try {
    let session = await waitForSessionStartResult(await createSession(sessionKey));
    if (session.status === "disconnected" && session.authCleared) {
      console.log("[bot] retrying start after clearing logged-out auth", { sessionKey });
      session = await waitForSessionStartResult(await createSession(sessionKey));
    }
    console.log("[bot] start response", {
      sessionKey,
      status: session.status,
      qrPresent: Boolean(session.qr),
      connected: session.status === "connected",
    });
    res.json(getSessionResponse(session));
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : "internal error" });
  }
});

app.get("/api/session/status", requireInternalToken, async (req, res) => {
  const sessionKey = String(req.query.sessionKey || req.query.session_key || req.query.userId || "").trim();
  if (!sessionKey) return res.status(400).json({ success: false, error: "sessionKey required" });

  try {
    const session = await getRestoredSession(sessionKey);
    if (session) await waitForConnectedSession(session, 5000);
    if (session) await recoverStaleMessageListener(session);
    const response = session ? getSessionResponse(session) : getDisconnectedSessionResponse(sessionKey);
    console.log("[bot] status response", {
      sessionKey,
      status: response.status,
      qrPresent: Boolean(response.qr),
      connected: response.connected,
    });
    res.json(response);
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : "internal error" });
  }
});

app.get("/api/session/:sessionKey/status", requireInternalToken, async (req, res) => {
  try {
    const sessionKey = String(req.params.sessionKey || "").trim();
    const session = await getRestoredSession(sessionKey);
    if (session) await waitForConnectedSession(session, 5000);
    if (session) await recoverStaleMessageListener(session);
    res.json(session ? getSessionResponse(session) : getDisconnectedSessionResponse(sessionKey));
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : "internal error" });
  }
});

app.post("/api/message/send", requireInternalToken, sendManualMessage);

// Aliases seguros para compatibilidade com Edge Functions/rotinas antigas.
app.post("/api/send", requireInternalToken, sendManualMessage);
app.get("/api/status", requireInternalToken, async (req, res) => {
  const sessionKey = String(req.query.sessionKey || req.query.session_key || req.query.userId || "").trim();
  if (!sessionKey) return res.status(400).json({ success: false, error: "sessionKey required" });

  try {
    const session = await getRestoredSession(sessionKey);
    if (session) await waitForConnectedSession(session, 5000);
    if (session) await recoverStaleMessageListener(session);
    const response = session ? getSessionResponse(session) : getDisconnectedSessionResponse(sessionKey);
    res.json({
      ...response,
      status: response.status === "qr_pending" ? "qr" : response.status,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : "internal error" });
  }
});
app.get("/api/qr", requireInternalToken, async (req, res) => {
  const sessionKey = String(req.query.sessionKey || req.query.session_key || req.query.userId || "").trim();
  if (!sessionKey) return res.status(400).json({ success: false, error: "sessionKey required" });

  try {
    const session = await createSession(sessionKey);
    res.json(getSessionResponse(session));
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : "internal error" });
  }
});
app.post("/api/wipe", requireInternalToken, async (req, res) => {
  const sessionKey = String(req.body?.sessionKey || req.body?.session_key || req.body?.userId || "").trim();
  if (!sessionKey) return res.status(400).json({ success: false, error: "sessionKey required" });

  const session = sessions.get(sessionKey);
  try {
    await session?.sock?.logout();
  } catch (error) {
    console.warn("[bot] logout failed; removing local session anyway", error);
  }

  await clearStoredSessionAuth(sessionKey);
  await syncConnectionStatus(sessionKey, "disconnected");
  res.json({ success: true, status: "disconnected" });
});

async function runSessionHealthCheck() {
  if (sessionHealthCheckRunning) return;
  sessionHealthCheckRunning = true;

  try {
    for (const session of sessions.values()) {
      if (!session || session.status !== "connected") continue;
      await recoverStaleMessageListener(session);
    }
  } catch (error) {
    console.error("[bot] session health check failed", error);
  } finally {
    sessionHealthCheckRunning = false;
  }
}

async function startServer() {
  ensureConfig();
  await fs.mkdir(SESSION_DIR, { recursive: true });
  await loadStatusOutbox();
  void flushStatusOutbox();

  const server = app.listen(PORT, () => {
    console.log(`[bot] listening on ${PORT}`);
    console.log(`[bot] session dir: ${SESSION_DIR}`);
    setInterval(() => {
      void runSessionHealthCheck();
    }, SESSION_HEALTH_CHECK_INTERVAL_MS).unref?.();
    setInterval(() => {
      void runExpiredMediaCleanup();
    }, MEDIA_CLEANUP_INTERVAL_MS).unref?.();
    void runExpiredMediaCleanup();
    void restoreAllSessions();
  });

  server.on("error", (error) => {
    console.error("[bot] http server error", error);
    process.exitCode = 1;
  });
}

void startServer().catch((error) => {
  console.error("[bot] startup failed", error);
  process.exit(1);
});

async function shutdown(signal) {
  console.log(`[bot] received ${signal}, releasing session locks`);
  await releaseAllSessionProcessLocks().catch((error) => {
    console.error("[bot] failed to release session locks during shutdown", error);
  });
  process.exit(0);
}

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

async function restoreAllSessions() {
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.log("[bot] SUPABASE_SERVICE_ROLE_KEY not set — skipping auto-restore");
    return;
  }

  try {
    const response = await supabaseFetch(
      "/whatsapp_connections?status=eq.connected&select=user_id,session_key",
    );
    if (!response?.ok) {
      console.warn("[bot] auto-restore: failed to fetch connections", response?.status);
      return;
    }

    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      console.log("[bot] auto-restore: no connected sessions to restore");
      return;
    }

    console.log(`[bot] auto-restore: restoring ${rows.length} session(s)`);
    for (const row of rows) {
      const key = (row.user_id || row.session_key || "").trim();
      if (!key) continue;

      for (let attempt = 1; attempt <= AUTO_RESTORE_RETRY_ATTEMPTS; attempt += 1) {
        try {
          const hasAuth = await hasStoredSessionAuth(key);
          if (!hasAuth) {
            console.log(`[bot] auto-restore: no stored auth for ${key} — marking disconnected`);
            await syncConnectionStatus(key, "disconnected");
            break;
          }

          console.log(`[bot] auto-restore: starting session ${key}`, { attempt });
          await createSession(key);
          break;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const lockBusy = message.includes("already active in another bot process");
          if (lockBusy && attempt < AUTO_RESTORE_RETRY_ATTEMPTS) {
            console.warn(`[bot] auto-restore: session lock busy for ${key}, retrying`, {
              attempt,
              nextAttemptInMs: AUTO_RESTORE_RETRY_DELAY_MS,
            });
            await sleep(AUTO_RESTORE_RETRY_DELAY_MS);
            continue;
          }

          console.error(`[bot] auto-restore: error restoring session ${key}`, err);
          break;
        }
      }
    }
  } catch (err) {
    console.error("[bot] auto-restore: unexpected error", err);
  }
}
