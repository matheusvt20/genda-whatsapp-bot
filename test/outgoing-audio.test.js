import test from "node:test";
import assert from "node:assert/strict";
import { WHATSAPP_OPUS_MIME_TYPE, isOggOpus, prepareOutgoingAudio } from "../src/outgoing-audio.js";

const oggOpus = Buffer.concat([
  Buffer.from("OggS\0\x02\0\0\0\0\0\0\0\0\0\0\0\0\x01\0\0\0\0\0\0\0", "binary"),
  Buffer.from("OpusHead\x01\x01\x80\xbb\0\0\0\0\0\0", "binary"),
]);

test("preserves a valid Ogg/Opus attachment and sends the WhatsApp MIME type", async () => {
  let invoked = false;
  const prepared = await prepareOutgoingAudio(oggOpus, async () => {
    invoked = true;
    return Buffer.alloc(0);
  });

  assert.equal(isOggOpus(oggOpus), true);
  assert.equal(invoked, false);
  assert.equal(prepared.buffer, oggOpus);
  assert.equal(prepared.mimeType, WHATSAPP_OPUS_MIME_TYPE);
  assert.equal(prepared.transcoded, false);
});

test("converts browser WebM audio to Ogg/Opus before sending", async () => {
  const prepared = await prepareOutgoingAudio(Buffer.from("webm input"), async (input) => {
    assert.equal(input.toString(), "webm input");
    return oggOpus;
  });

  assert.equal(prepared.buffer, oggOpus);
  assert.equal(prepared.mimeType, WHATSAPP_OPUS_MIME_TYPE);
  assert.equal(prepared.transcoded, true);
});

test("fails instead of accepting an audio conversion without Ogg/Opus output", async () => {
  await assert.rejects(
    prepareOutgoingAudio(Buffer.from("webm input"), async () => Buffer.from("invalid output")),
    (error) => error.code === "AUDIO_CONVERSION_FAILED" && error.httpStatus === 422,
  );
});
