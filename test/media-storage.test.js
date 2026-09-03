import test from "node:test";
import assert from "node:assert/strict";
import { createMediaStorage, DEFAULT_MEDIA_RETENTION_MS } from "../src/media-storage.js";

const FIXED_NOW = Date.parse("2026-08-23T18:00:00.000Z");

test("persiste mídia privada e devolve URL assinada por 15 dias", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes("/object/sign/")) {
      return new Response(JSON.stringify({ signedURL: "/object/sign/whatsapp-media/user/arquivo?token=seguro" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(null, { status: 200 });
  };
  const storage = createMediaStorage({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-role",
    fetchImpl,
    now: () => FIXED_NOW,
  });

  const url = await storage.persistBuffer({
    buffer: Buffer.from("audio"),
    userId: "user-id",
    messageId: "message-id",
    mimeType: "audio/ogg; codecs=opus",
    fileName: null,
  });

  assert.equal(url, "https://project.supabase.co/storage/v1/object/sign/whatsapp-media/user/arquivo?token=seguro");
  assert.match(requests[0].url, /whatsapp-media\/user-id\/2026\/08\/23\/message-id\.ogg$/);
  assert.equal(requests[0].options.headers["x-upsert"], "true");
  assert.deepEqual(JSON.parse(requests[1].options.body), { expiresIn: DEFAULT_MEDIA_RETENTION_MS / 1000 });
  const metadata = JSON.parse(requests[2].options.body);
  assert.equal(metadata.expires_at, "2026-09-07T18:00:00.000Z");
  assert.equal(metadata.size_bytes, 5);
});

test("remove objeto e metadado quando a retenção vence", async () => {
  const requests = [];
  let listed = false;
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes("/rest/v1/whatsapp_media_objects?") && (!options.method || options.method === "GET")) {
      if (listed) return new Response(JSON.stringify([]), { status: 200 });
      listed = true;
      return new Response(JSON.stringify([{ id: "media-id", storage_path: "user/2026/08/01/audio.ogg" }]), { status: 200 });
    }
    return new Response(null, { status: 200 });
  };
  const storage = createMediaStorage({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-role",
    fetchImpl,
    now: () => FIXED_NOW,
  });

  const result = await storage.cleanupExpired();

  assert.deepEqual(result, { checked: 1, deleted: 1 });
  assert.ok(requests.some((request) => request.options.method === "DELETE" && request.url.includes("/storage/v1/object/whatsapp-media/")));
  assert.ok(requests.some((request) => request.options.method === "DELETE" && request.url.includes("id=eq.media-id")));
});

test("apaga o objeto se não conseguir registrar os metadados", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes("/object/sign/")) {
      return new Response(JSON.stringify({ signedURL: "/object/sign/whatsapp-media/file?token=x" }), { status: 200 });
    }
    if (String(url).includes("/rest/v1/whatsapp_media_objects")) return new Response(null, { status: 404 });
    return new Response(null, { status: 200 });
  };
  const storage = createMediaStorage({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-role",
    fetchImpl,
    now: () => FIXED_NOW,
  });

  await assert.rejects(
    storage.persistBuffer({ buffer: Buffer.from("image"), userId: "user", messageId: "message", mimeType: "image/jpeg" }),
    /metadata save failed/,
  );
  assert.ok(requests.some((request) => request.options.method === "DELETE" && request.url.includes("/storage/v1/object/")));
});
