import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { useMultiFileAuthState } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import * as auth from "../src/session-auth.js";
import * as lifecycle from "../src/session-lifecycle.js";
import * as disconnect from "../src/session-disconnect.js";
import * as reconnect from "../src/reconnect-policy.js";
import * as phone from "../src/phone.js";

// Exercise the real index.js handlers with a fake provider and HTTP transport.
// No production auth, WhatsApp traffic, database writes or server startup.
async function runtime(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "genda-runtime-"));
  const requests = [];
  const sockets = [];
  const local = path.join(directory, "baileys-sessions", "customer");
  const initial = await useMultiFileAuthState(local);
  initial.state.creds.registered = true;
  initial.state.creds.nextPreKeyId = 99;
  await initial.saveCreds();
  const app = { use() {}, get() {}, post() {} };
  const express = Object.assign(() => app, { json: () => () => {} });
  let source = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8");
  source = source.slice(source.indexOf("const originalConsoleInfo"));
  const startup = source.indexOf("void startServer().catch");
  source = source.slice(0, startup) + source.slice(source.indexOf("async function shutdown", startup));
  source += "\nglobalThis.runtime = { createSession, clearStoredSessionAuth, sessions, resetSessionReconnectState, restoreAllSessions };";
  const context = vm.createContext({
    ...auth, ...lifecycle, ...disconnect, ...reconnect, ...phone,
    fs, path, randomUUID, Boom, express,
    createMediaStorage: () => ({}), DEFAULT_MEDIA_RETENTION_MS: 15 * 24 * 60 * 60 * 1000,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore: (keys) => keys,
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1043857760] }),
    makeWASocket: (socketOptions) => {
      const sock = { ev: new EventEmitter(), user: { id: "5511999999999@s.whatsapp.net" }, auth: socketOptions.auth };
      sockets.push(sock);
      return sock;
    },
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), method: init.method || "GET", body: init.body });
      if (String(url).includes("/storage/") && init.method === "GET") return new Response(null, { status: 404 });
      if (String(url).includes("/storage/") && init.method === "POST") await options.onUpload?.();
      return new Response(JSON.stringify(init.method === "POST" || init.method === "DELETE" ? {} : []), { headers: { "content-type": "application/json" } });
    },
    process: { env: { SUPABASE_URL: "https://fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "fixture", BOT_INTERNAL_TOKEN: "fixture", SESSION_DIR: directory, WHATSAPP_RECONNECT_BASE_DELAY_MS: "60000", WHATSAPP_RECONNECT_JITTER_MS: "0" }, once() {} },
    console: { info() {}, log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Buffer, URL, AbortSignal,
  });
  vm.runInContext(source, context, { filename: "src/index.js" });
  const api = context.runtime;
  t.after(async () => { await api.clearStoredSessionAuth("customer"); await fs.rm(directory, { recursive: true, force: true }); });
  const session = await api.createSession("customer");
  return { api, session, sockets, requests, local };
}

test("real reconnect handler retains local auth for the historical 401 conflict", async (t) => {
  const { session, sockets, requests, local } = await runtime(t);
  assert.equal(sockets[0].auth.creds.nextPreKeyId, 99);
  sockets[0].ev.emit("connection.update", { connection: "close", lastDisconnect: { error: new Boom("Stream Errored (conflict)", { statusCode: 401, data: { tag: "conflict", attrs: {} } }) } });
  await session.runLifecycle(() => {});
  assert.equal(session.status, "reconnecting");
  assert.equal(JSON.parse(await fs.readFile(path.join(local, "creds.json"))).nextPreKeyId, 99);
  assert.equal(requests.some((request) => request.method === "DELETE"), false);
  const status = requests.find((request) => request.method === "POST" && request.url.includes("/whatsapp_connections"));
  assert.equal(JSON.parse(status.body).device_info.disconnect.stream_reason, "conflict");
});

test("real device_removed handler clears revoked auth and ignores subsequent credentials events", async (t) => {
  const { session, sockets, requests, local } = await runtime(t);
  sockets[0].ev.emit("connection.update", { connection: "close", lastDisconnect: { error: new Boom("Stream Errored (conflict)", { statusCode: 401, data: { tag: "conflict", attrs: { type: "device_removed" } } }) } });
  sockets[0].ev.emit("creds.update", {});
  await session.runLifecycle(() => {});
  assert.equal(session.status, "disconnected");
  assert.equal(session.authCleared, true);
  await assert.rejects(fs.access(path.join(local, "creds.json")));
  assert.equal(requests.some((request) => request.method === "POST" && request.url.includes("/storage/")), false);
  assert.equal(requests.some((request) => request.method === "DELETE"), true);
});

test("real open and close handlers remain ordered while a backup upload is slow", async (t) => {
  let release;
  let entered;
  const uploading = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const { session, sockets, requests } = await runtime(t, { onUpload: async () => { entered(); await blocked; } });
  sockets[0].ev.emit("connection.update", { connection: "open" });
  await uploading;
  sockets[0].ev.emit("connection.update", { connection: "close", lastDisconnect: { error: new Boom("Connection Terminated", { statusCode: 428 }) } });
  release();
  await session.runLifecycle(() => {});
  assert.equal(session.status, "reconnecting");
  const updates = requests.filter((request) => request.method === "POST" && request.url.includes("/whatsapp_connections")).map((request) => JSON.parse(request.body).status);
  assert.deepEqual(updates, ["connected", "waiting"]);
});

test("real auto-restore includes sessions interrupted during reconnection", async (t) => {
  const { api, requests } = await runtime(t);
  await api.restoreAllSessions();
  assert.ok(requests.some((request) => request.url.includes("status=in.(connected,waiting)")));
});
