import test from "node:test";
import assert from "node:assert/strict";
import { computeStatusOutboxRetryDelay } from "../src/status-outbox.js";

const configuration = {
  fastRetryMs: 250,
  fastRetryAttempts: 3,
  retryBaseMs: 2_000,
  retryMaxMs: 300_000,
};

test("retries new unmatched status receipts quickly before exponential backoff", () => {
  assert.equal(computeStatusOutboxRetryDelay(1, configuration), 250);
  assert.equal(computeStatusOutboxRetryDelay(2, configuration), 250);
  assert.equal(computeStatusOutboxRetryDelay(3, configuration), 250);
  assert.equal(computeStatusOutboxRetryDelay(4, configuration), 2_000);
  assert.equal(computeStatusOutboxRetryDelay(5, configuration), 4_000);
});

test("caps the normal retry delay", () => {
  assert.equal(computeStatusOutboxRetryDelay(20, configuration), 300_000);
});
