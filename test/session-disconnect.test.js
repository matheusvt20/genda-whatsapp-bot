import test from "node:test";
import assert from "node:assert/strict";
import { decideSessionDisconnect, disconnectDiagnostics } from "../src/session-disconnect.js";

const conflict = (type) => ({ message: "Stream Errored (conflict)", data: { tag: "conflict", attrs: type ? { type } : {} } });

test("Lisiane's historical 401 conflict attempts recovery without deleting auth", () => {
  const decision = decideSessionDisconnect({ error: conflict(), statusCode: 401, hasOpened: true });
  assert.equal(decision.loggedOut, false);
  assert.equal(decision.shouldReconnect, true);
  assert.equal(decision.clearAuth, false);
  assert.equal(decision.status, "reconnecting");
});

test("a repeated ambiguous conflict stops after one attempt but retains credentials", () => {
  const decision = decideSessionDisconnect({ error: conflict(), statusCode: 401, hadStoredAuth: true, conflictAttempts: 1 });
  assert.equal(decision.shouldReconnect, false);
  assert.equal(decision.clearAuth, false);
  assert.equal(decision.status, "needs_reconnect");
});

test("actual device removal is terminal even if its message says conflict", () => {
  for (const statusCode of [401, 440]) {
    const decision = decideSessionDisconnect({ error: conflict("device_removed"), statusCode, hasOpened: true });
    assert.equal(decision.loggedOut, true);
    assert.equal(decision.clearAuth, true);
    assert.equal(decision.shouldReconnect, false);
  }
});

test("plain unauthorized failure remains terminal", () => {
  const decision = decideSessionDisconnect({ error: { message: "Connection Failure", data: { reason: "401" } }, statusCode: 401, hasOpened: true });
  assert.equal(decision.clearAuth, true);
  assert.equal(decision.shouldReconnect, false);
});

test("a known replaced conflict preserves auth even with an explicit 401 override", () => {
  const decision = decideSessionDisconnect({ error: conflict("replaced"), statusCode: 401, hadStoredAuth: true });
  assert.equal(decision.shouldReconnect, true);
  assert.equal(decision.clearAuth, false);
  assert.equal(decision.diagnostics.conflict_type, "replaced");
});

test("transient errors during restoration retry with stored auth before the first open", () => {
  for (const statusCode of [428, 500, 515]) {
    const decision = decideSessionDisconnect({ error: { message: "Connection Terminated" }, statusCode, hadStoredAuth: true });
    assert.equal(decision.shouldReconnect, true);
    assert.equal(decision.clearAuth, false);
  }
});

test("expired QR and restricted accounts do not enter automatic retry loops", () => {
  assert.equal(decideSessionDisconnect({ statusCode: 408, wasWaitingForQr: true }).shouldReconnect, false);
  assert.equal(decideSessionDisconnect({ statusCode: 403, hasOpened: true }).shouldReconnect, false);
});

test("health checks retain auth until the user explicitly requests a fresh QR", () => {
  const decision = decideSessionDisconnect({ statusCode: 500, hasOpened: true, markedUnhealthy: true });
  assert.equal(decision.status, "needs_reconnect");
  assert.equal(decision.clearAuth, false);
  assert.equal(decision.shouldReconnect, false);
});

test("diagnostics extract only safe reason metadata from either Baileys error shape", () => {
  assert.deepEqual(disconnectDiagnostics({ data: { tag: "stream:error", attrs: { secret: "do-not-expose" }, content: [{ tag: "conflict", attrs: { type: "device_removed", jid: "private" } }] } }, 401), {
    status_code: 401, stream_reason: "conflict", conflict_type: "device_removed",
  });
  assert.equal(disconnectDiagnostics(conflict("secret=value?token=x"), 401).conflict_type, null);
});
