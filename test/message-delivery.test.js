import test from "node:test";
import assert from "node:assert/strict";
import { createMessageDeliveryTracker } from "../src/message-delivery.js";

test("deduplicates ordinary deliveries but forwards late ad evidence and later creative once", async () => {
  const tracker = createMessageDeliveryTracker();let calls = 0;
  const send = async () => { calls++; };
  assert.equal(await tracker.forward("owner:message", null, send), true);
  assert.equal(await tracker.forward("owner:message", null, send), false);
  assert.equal(await tracker.forward("owner:message", {source_id:"ad"}, send), true);
  assert.equal(await tracker.forward("owner:message", {source_id:"ad",title:"Title",ctwa_clid:"Opaque"}, send), true);
  assert.equal(await tracker.forward("owner:message", {source_id:"ad",title:"Title",ctwa_clid:"Opaque"}, send), false);
  assert.equal(calls, 3);
});
test("failed delivery can be retried, and concurrent enrichment waits without suppressing metadata", async () => {
  const tracker = createMessageDeliveryTracker();let calls = 0;
  await assert.rejects(tracker.forward("id", null, async () => { throw new Error("offline"); }));
  let release;const gate = new Promise(resolve => {release = resolve;});
  const first = tracker.forward("id", null, async () => {calls++;await gate;});
  const second = tracker.forward("id", {title:"Ad"}, async () => {calls++;});
  release();assert.equal(await first,true);assert.equal(await second,true);assert.equal(calls,2);
});
test("distinct owners and bounded eviction preserve ordinary behavior", async () => {
  const tracker = createMessageDeliveryTracker(2);const send = async () => {};
  assert.equal(await tracker.forward("owner-a:id",null,send),true);
  assert.equal(await tracker.forward("owner-b:id",null,send),true);
  assert.equal(await tracker.forward("owner-c:id",null,send),true);
  assert.equal(await tracker.forward("owner-a:id",null,send),true);
});
