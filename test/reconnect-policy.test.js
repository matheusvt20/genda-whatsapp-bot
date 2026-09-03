import test from "node:test";
import assert from "node:assert/strict";
import {
  computeReconnectDelayMs,
  shouldResetReconnectAttempts,
} from "../src/reconnect-policy.js";

test("reconnect uses capped exponential backoff", () => {
  const options = { baseDelayMs: 2_000, maxDelayMs: 60_000, jitterMs: 0 };

  assert.equal(computeReconnectDelayMs(1, options), 2_000);
  assert.equal(computeReconnectDelayMs(2, options), 4_000);
  assert.equal(computeReconnectDelayMs(5, options), 32_000);
  assert.equal(computeReconnectDelayMs(10, options), 60_000);
});

test("reconnect jitter never exceeds the configured maximum", () => {
  const delay = computeReconnectDelayMs(6, {
    baseDelayMs: 2_000,
    maxDelayMs: 60_000,
    jitterMs: 1_000,
    random: () => 1,
  });

  assert.equal(delay, 60_000);
});

test("attempts reset only after a stable connection window", () => {
  const now = 1_000_000;

  assert.equal(shouldResetReconnectAttempts(now - 119_999, now, 120_000), false);
  assert.equal(shouldResetReconnectAttempts(now - 120_000, now, 120_000), true);
});
