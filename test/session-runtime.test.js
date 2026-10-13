import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { useMultiFileAuthState } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import * as auth from "../src/session-auth.js";
import * as lifecycle from "../src/session-lifecycle.js";
import * as disconnect from "../src/session-disconnect.js";
import * as reconnect from "../src/reconnect-policy.js";
import * as phone from "../src/phone.js";
import { supabaseHeaders } from "../src/supabase-headers.js";
import * as diagnostics from "../src/connection-diagnostics.js";

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
  const routes = new Map();
  const middlewares=[];
  const app = { disable() {}, use(...args) { middlewares.push(args); }, get(route, ...handlers) { routes.set(route, handlers); }, post() {} };
  const express = Object.assign(() => app, { json: () => () => {} });
  let source = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8");
  source = source.slice(source.indexOf("const originalConsoleInfo"));
  const startup = source.indexOf("void startServer().catch");
  source = source.slice(0, startup) + source.slice(source.indexOf("async function shutdown", startup));
  source += "\nglobalThis.runtime = { createSession, clearStoredSessionAuth, sessions, resetSessionReconnectState, restoreAllSessions, connectionJournal, reconnectTracker, shutdown, endSessionInternally };";
  const context = vm.createContext({
    ...auth, ...lifecycle, ...disconnect, ...reconnect, ...phone, ...diagnostics,
    monitorEventLoopDelay, supabaseHeaders,
    fs, path, randomUUID, Boom, express,
    createMediaStorage: () => ({}), DEFAULT_MEDIA_RETENTION_MS: 15 * 24 * 60 * 60 * 1000,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore: (keys) => keys,
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1043857760] }),
    makeWASocket: (socketOptions) => {
      const sock = { ev: new EventEmitter(), ws: new EventEmitter(), user: { id: "5511999999999@s.whatsapp.net" }, auth: socketOptions.auth };
      sock.end = () => sock.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: new Boom("fixture socket ended", { statusCode: 428 }) } });
      sockets.push(sock);
      return sock;
    },
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), method: init.method || "GET", body: init.body });
      if (String(url).includes("/storage/") && init.method === "GET") return new Response(null, { status: 404 });
      if (String(url).includes("/storage/") && init.method === "POST") await options.onUpload?.();
      return new Response(JSON.stringify(init.method === "POST" || init.method === "DELETE" ? {} : []), { headers: { "content-type": "application/json" } });
    },
    process: { env: { SUPABASE_URL: "https://fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "fixture", BOT_INTERNAL_TOKEN: "fixture", SESSION_DIR: directory, WHATSAPP_RECONNECT_BASE_DELAY_MS: "60000", WHATSAPP_RECONNECT_JITTER_MS: "0" }, once() {}, exit() {}, cpuUsage: process.cpuUsage, memoryUsage: process.memoryUsage, uptime: process.uptime },
    console: { info() {}, log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Buffer, URL, AbortSignal,
  });
  vm.runInContext(source, context, { filename: "src/index.js" });
  const api = context.runtime;
  t.after(async () => { await api.clearStoredSessionAuth("customer"); await api.connectionJournal.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  const session = await api.createSession("customer");
  return { api, session, sockets, requests, local, routes, middlewares };
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

test("real close handler correlates native transport evidence and retains auth", async (t) => {
  const { api, session, sockets, local } = await runtime(t);
  sockets[0].ws.emit("error", { code: "ECONNRESET", message: "private" });
  sockets[0].ws.emit("close", 1006, Buffer.from("private"));
  sockets[0].ev.emit("connection.update", { connection: "close", lastDisconnect: { error: new Boom("Connection Terminated", { statusCode: 428 }) } });
  await session.runLifecycle(() => {});
  await api.connectionJournal.flush();
  const records = await api.connectionJournal.read();
  const closed = records.find((event) => event.type === "session_closed");
  assert.equal(closed.details.cause, "transport_failure");
  assert.equal(closed.details.close_code, 1006);
  assert.equal(closed.details.network_code, "ECONNRESET");
  assert.equal(closed.details.auth_cleared, false);
  assert.equal(closed.details.should_reconnect, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(local, "creds.json"))).registered, true);
  assert.equal(JSON.stringify(records).includes("private"), false);
});

test("real internal recovery records its own cause instead of attributing 428 to WhatsApp", async (t) => {
  const { api, session } = await runtime(t);
  api.endSessionInternally(session, "decrypt_recovery");
  await session.runLifecycle(() => {});
  await api.connectionJournal.flush();
  const closed = (await api.connectionJournal.read()).find((event) => event.type === "session_closed");
  assert.equal(closed.details.cause, "internal_action");
  assert.equal(closed.details.reason, "decrypt_recovery");
});

test("real repeated-drop policy delays reconnection without requesting a QR", async (t) => {
  const { api, session, sockets, local } = await runtime(t);
  for (let i = 0; i < 4; i++) api.reconnectTracker.closed("customer");
  sockets[0].ev.emit("connection.update", { connection: "close", lastDisconnect: { error: new Boom("Connection Terminated", { statusCode: 428 }) } });
  await session.runLifecycle(() => {});
  await api.connectionJournal.flush();
  const retry = (await api.connectionJournal.read()).find((event) => event.type === "reconnect_scheduled");
  assert.equal(retry.details.delay_ms, 120000);
  assert.equal(session.status, "reconnecting");
  assert.equal(JSON.parse(await fs.readFile(path.join(local, "creds.json"))).registered, true);
});

test("pairing restart does not count as instability and downtime survives socket replacement", async (t) => {
  const { api, session, sockets } = await runtime(t);
  sockets[0].ev.emit("connection.update", { connection: "close", lastDisconnect: { error: new Boom("Restart Required", { statusCode: 515 }) } });
  await session.runLifecycle(() => {});
  assert.equal(api.reconnectTracker.stats("customer").recent_closes, 0);
  api.resetSessionReconnectState("customer");
  const restored = await api.createSession("customer");
  sockets[1].ev.emit("connection.update", { connection: "open" });
  await restored.runLifecycle(() => {});
  await api.connectionJournal.flush();
  const reopened = (await api.connectionJournal.read()).find((event) => event.type === "session_connected");
  assert.ok(reopened.details.downtime_ms >= 0);
  assert.equal(reopened.details.state, "connected");
});

test("real deployment shutdown preserves restored auth and avoids a disconnected DB update", async (t) => {
  const { api, session, requests, local } = await runtime(t);
  await api.shutdown("SIGTERM");
  assert.equal(session.sock, null);
  assert.equal(requests.some((request) => request.method === "POST" && request.url.includes("/whatsapp_connections")), false);
  assert.equal(JSON.parse(await fs.readFile(path.join(local, "creds.json"))).registered, true);
  const records = await api.connectionJournal.read();
  assert.equal(records.at(-1).type, "process_shutdown");
  assert.equal(records.some((event) => event.type === "reconnect_scheduled"), false);
  assert.equal(records.find((event) => event.type === "session_closed").details.reason, "process_shutdown");
});

test("diagnostics route requires the internal token and rejects invalid filters", async (t) => {
  const { routes } = await runtime(t);
  const [authorize, handler] = routes.get("/api/diagnostics");
  let status = 200;
  let body;
  const res = { status(value) { status = value; return this; }, json(value) { body = value; } };
  authorize({ get() {} }, res, () => assert.fail("anonymous request authorized"));
  assert.equal(status, 401);
  let authorized = false;
  authorize({ get: (name) => name === "authorization" ? "Bearer fixture" : undefined }, res, () => { authorized = true; });
  assert.equal(authorized, true);
  for (const query of [{ sessionKey: "------------------------------------" }, { since: "invalid" }, { limit: "1001" }]) {
    await handler({ query }, res);
    assert.equal(status, 400);
  }
  status = 200;
  await handler({ query: {} }, res);
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.events));
});

test("private API rejects credentials before processing its JSON body while a valid backend remains allowed",async(t)=>{
 const { middlewares }=await runtime(t);const gate=middlewares.find(([route])=>route==="/api")[1];
 let status=0,next=false;const response={status(value){status=value;return this;},json(){return this;}};
 gate({method:"POST",path:"/message/send",get:()=>undefined},response,()=>{next=true;});
 assert.equal(status,401);assert.equal(next,false);
 gate({method:"POST",path:"/message/send",get:()=>"Bearer fixture"},response,()=>{next=true;});assert.equal(next,true);
});
