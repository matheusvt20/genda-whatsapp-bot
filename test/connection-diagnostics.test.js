import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { attachTransportDiagnostics, classifyConnectionClose, createConnectionJournal, createReconnectTracker, sanitizeDiagnosticDetails } from "../src/connection-diagnostics.js";

const CUSTOMER = "0a2cd401-980f-4cee-98fd-aa6b1951b5b3";
const OTHER = "8efd6a74-6728-4384-b36f-fdec8491f98a";
async function journal(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "genda-diagnostics-"));
  const api = createConnectionJournal({ directory, ...options });
  await api.initialize();
  t.after(async () => { await api.flush(); await fs.rm(directory, { force: true, recursive: true }); });
  return { api, directory };
}

test("diagnostics never serialize provider payloads, reasons, phones or credentials", () => {
  const result = sanitizeDiagnosticDetails({ close_code: 1006, status_code: 428, network_code: "ECONNRESET", reason: "private content", stream_reason: "5511999999999", qr: "secret", creds: { privateKey: "secret" }, headers: { authorization: "secret" }, message: "private", rss_mb: Infinity, delay_ms: -1 });
  assert.deepEqual(result, { close_code: 1006, status_code: 428, network_code: "ECONNRESET", reason: "unknown", stream_reason: "unknown" });
});

test("cause classification retains uncertainty for 428 and distinguishes internal actions", () => {
  assert.equal(classifyConnectionClose({ diagnostics: { status_code: 428 }, transport: { close_code: 1006 } }), "transport_closed_unknown");
  assert.equal(classifyConnectionClose({ internalReason: "decrypt_recovery", diagnostics: { status_code: 428 } }), "internal_action");
  assert.equal(classifyConnectionClose({ diagnostics: { status_code: 401, stream_reason: "conflict", conflict_type: "device_removed" } }), "device_removed");
  assert.equal(classifyConnectionClose({ diagnostics: { status_code: 401, stream_reason: "conflict" } }), "session_conflict");
  assert.equal(classifyConnectionClose({ diagnostics: { status_code: 428 }, transport: { network_code: "ECONNRESET" } }), "transport_failure");
});

test("native WebSocket closure is captured even when Baileys removes listeners during close", () => {
  const ws = new EventEmitter();
  const events = [];
  const session = { sessionKey: CUSTOMER };
  ws.on("close", () => ws.removeAllListeners("close"));
  attachTransportDiagnostics({ ws }, session, (type, key, details) => events.push({ type, key, details }), () => 1234);
  ws.emit("message", Buffer.from("private message"));
  ws.emit("error", { code: "ECONNRESET", message: "private", request: { authorization: "secret" } });
  ws.emit("unexpected-response", { secret: "token" }, { statusCode: 503, headers: { secret: "token" } });
  ws.emit("close", 1006, Buffer.from("private provider reason"));
  assert.equal(session.lastTransportMessageAt, 1234);
  assert.deepEqual(events.map((event) => event.type), ["transport_error", "transport_http_error", "transport_closed"]);
  assert.deepEqual(session.lastTransportClose, { close_code: 1006, close_reason_present: true, network_code: "ECONNRESET" });
  assert.equal(JSON.stringify(events).includes("private"), false);
  assert.equal(JSON.stringify(events).includes("token"), false);
});

test("repeated closures slow only the affected account and recover after the window", () => {
  let now = 1000000;
  const tracker = createReconnectTracker({ now: () => now });
  tracker.closed(OTHER);
  tracker.closed(CUSTOMER); tracker.closed(CUSTOMER);
  assert.equal(tracker.stats(CUSTOMER).delay_ms, 0);
  tracker.closed(CUSTOMER);
  assert.equal(tracker.stats(CUSTOMER).delay_ms, 30000);
  assert.equal(tracker.stats(OTHER).delay_ms, 0);
  assert.equal(tracker.flappingCount(), 1);
  for (let i = 0; i < 15; i++) tracker.closed(CUSTOMER);
  assert.equal(tracker.stats(CUSTOMER).delay_ms, 300000);
  now += 600001;
  assert.equal(tracker.stats(CUSTOMER).delay_ms, 0);
  assert.equal(tracker.flappingCount(), 0);
});

test("persistent history survives a new process, filters accounts and bounds results", async (t) => {
  const now = Date.parse("2026-10-12T15:00:00Z");
  const { api, directory } = await journal(t, { now: () => now });
  api.record("session_closed", CUSTOMER, { status_code: 428, creds: "secret" });
  api.record("session_connected", OTHER, {});
  api.record("session_connected", CUSTOMER, { downtime_ms: 5000 });
  await api.flush();
  const restarted = createConnectionJournal({ directory, now: () => now });
  const records = await restarted.read({ sessionKey: CUSTOMER, limit: 1 });
  assert.equal(records.length, 1);
  assert.equal(records[0].type, "session_connected");
  assert.equal(records[0].details.downtime_ms, 5000);
  assert.equal((await restarted.read()).length, 3);
  assert.equal((await fs.stat(path.join(directory, "2026-10-12.ndjson"))).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(await restarted.read()).includes("secret"), false);
});

test("retention removes only expired journal files, leaving auth files untouched", async (t) => {
  const now = Date.parse("2026-10-12T15:00:00Z");
  const { api, directory } = await journal(t, { now: () => now });
  await fs.writeFile(path.join(directory, "2026-09-12.ndjson"), "old");
  await fs.writeFile(path.join(directory, "2026-09-13.ndjson"), "kept");
  await fs.writeFile(path.join(directory, "creds.json"), "unrelated");
  await api.initialize();
  await assert.rejects(fs.access(path.join(directory, "2026-09-12.ndjson")));
  assert.equal(await fs.readFile(path.join(directory, "creds.json"), "utf8"), "unrelated");
  assert.equal(await fs.readFile(path.join(directory, "2026-09-13.ndjson"), "utf8"), "kept");
});

test("disk failures do not reject event recording or flush and health exposes the failure", async (t) => {
  const { api } = await journal(t, { storage: { mkdir: async () => { throw new Error("secret disk path"); } } });
  const event = api.record("session_closed", CUSTOMER, { status_code: 428 });
  assert.equal(event.type, "session_closed");
  await api.flush();
  assert.equal(api.health().persistence_ok, false);
  assert.equal(api.health().failures, 2);
  assert.equal(api.health().pending, 0);
  assert.equal(JSON.stringify(api.health()).includes("secret"), false);
});

test("queue and daily file limits bound diagnostic growth", async (t) => {
  const { api, directory } = await journal(t, { maxPending: 2, maxDailyBytes: 1 });
  for (let i = 0; i < 10; i++) api.record("session_closed", CUSTOMER);
  assert.equal(api.health().pending, 2);
  await api.flush();
  assert.equal(api.health().dropped, 10);
  assert.equal((await fs.readdir(directory)).length, 0);
});

test("corrupt lines cannot expose payloads or break subsequent history", async (t) => {
  const now = Date.parse("2026-10-12T15:00:00Z");
  const { api, directory } = await journal(t, { now: () => now });
  await fs.writeFile(path.join(directory, "2026-10-12.ndjson"), 'broken\nnull\n' + JSON.stringify({ at: new Date(now).toISOString(), type: "session_closed", session_key: CUSTOMER, details: { status_code: 428, token: "secret" } }) + '\n');
  const records = await api.read();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].details, { status_code: 428 });
});
