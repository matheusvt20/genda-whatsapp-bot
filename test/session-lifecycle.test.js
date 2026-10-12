import test from "node:test";
import assert from "node:assert/strict";
import { createSessionLifecycle } from "../src/session-lifecycle.js";

test("close cannot be overwritten by a delayed open credentials save", async () => {
  let release;
  const saving = new Promise((resolve) => { release = resolve; });
  let status = "initializing";
  const run = createSessionLifecycle(() => true);
  const open = run(async () => { await saving; status = "connected"; });
  const close = run(async () => { status = "disconnected"; });
  await Promise.resolve();
  release();
  await Promise.all([open, close]);
  assert.equal(status, "disconnected");
});

test("late credential callbacks from a deleted session are skipped", async () => {
  let current = true;
  const run = createSessionLifecycle(() => current);
  const close = run(async () => { current = false; });
  let writes = 0;
  const lateSave = run(async () => { writes++; });
  await Promise.all([close, lateSave]);
  assert.equal(writes, 0);
});

test("a failed event does not block recovery or affect another session", async () => {
  const run = createSessionLifecycle(() => true);
  const first = run(() => { throw new Error("backup unavailable"); });
  let recovered = false;
  const next = run(() => { recovered = true; });
  await assert.rejects(first, /backup unavailable/);
  await next;
  assert.equal(recovered, true);
});
