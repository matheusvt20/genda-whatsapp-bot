import test from "node:test";
import assert from "node:assert/strict";
import { assertMessageStatusWebhookAccepted } from "../src/message-status.js";

test("accepts a status updated by the webhook", async () => {
  const result = await assertMessageStatusWebhookAccepted(new Response(JSON.stringify({
    success: true,
    updated: true,
    found: true,
    current_status: "delivered",
  }), { status: 200 }));

  assert.equal(result.current_status, "delivered");
});

test("accepts a status that was already advanced", async () => {
  const result = await assertMessageStatusWebhookAccepted(new Response(JSON.stringify({
    success: true,
    updated: false,
    found: true,
    current_status: "read",
  }), { status: 200 }));

  assert.equal(result.current_status, "read");
});

test("retries when the message row does not exist yet", async () => {
  await assert.rejects(
    assertMessageStatusWebhookAccepted(new Response(JSON.stringify({
      success: true,
      updated: false,
      found: false,
      current_status: null,
    }), { status: 200 })),
    (error) => error?.code === "WHATSAPP_STATUS_NOT_FOUND" && /not reconciled yet/.test(error.message),
  );
});

test("retries legacy unmatched responses without a found flag", async () => {
  await assert.rejects(
    assertMessageStatusWebhookAccepted(new Response(JSON.stringify({
      success: true,
      updated: false,
    }), { status: 200 })),
    /not reconciled yet/,
  );
});

test("retries HTTP and malformed responses", async () => {
  await assert.rejects(
    assertMessageStatusWebhookAccepted(new Response("temporary failure", { status: 503 })),
    /failed 503/,
  );
  await assert.rejects(
    assertMessageStatusWebhookAccepted(new Response("not-json", { status: 200 })),
    /invalid response/,
  );
});
