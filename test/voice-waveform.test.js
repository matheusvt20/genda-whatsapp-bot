import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { transcodeVoiceAudio } from "../src/audio-transcoder.js";
import { waveformFromPcm, decodeVoiceMetadata, prepareVoiceNote } from "../src/voice-waveform.js";

function pcmFixture() {
  const pcm = Buffer.alloc(8000 * 2);
  for (let n = 2000; n < 4000; n++) pcm.writeInt16LE(Math.round(12000 * Math.sin(n / 10)), n * 2);
  for (let n = 6000; n < 8000; n++) pcm.writeInt16LE(Math.round(4000 * Math.sin(n / 10)), n * 2);
  return pcm;
}
function encodeOgg(pcm) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", "8000", "-ac", "1", "-i", "pipe:0", "-c:a", "libopus", "-f", "ogg", "pipe:1"], { input: pcm });
  assert.equal(result.status, 0, "ffmpeg must be installed to validate real audio"); return result.stdout;
}
test("64 bars follow real silence and voice levels, without inventing a decorative waveform", () => {
  const { waveform, seconds } = waveformFromPcm(pcmFixture());
  assert.equal(waveform.length, 64); assert.equal(seconds, 1);
  assert.ok(waveform.subarray(0, 16).every(n => n === 0));
  assert.ok(Math.max(...waveform.subarray(16, 32)) === 100);
  assert.ok(Math.max(...waveform.subarray(48)) < 40);
  assert.ok(waveformFromPcm(Buffer.alloc(16000)).waveform.every(n => n === 0));
});
test("decodes a real Ogg/Opus file and supplies waveform, duration and PTT to the sender", async () => {
  const ogg = encodeOgg(pcmFixture());
  const voice = await prepareVoiceNote(ogg, transcodeVoiceAudio);
  assert.equal(voice.payload.ptt, true); assert.equal(voice.payload.mimetype, "audio/ogg; codecs=opus");
  assert.equal(voice.payload.waveform.length, 64); assert.equal(voice.payload.seconds, 1);
  assert.ok(Math.max(...voice.payload.waveform) > 0);
  assert.ok(voice.payload.waveform[0] < voice.payload.waveform[20]);
});
test("preserves converted bytes and computes metadata after conversion", async () => {
  const ogg = encodeOgg(pcmFixture());
  const voice = await prepareVoiceNote(Buffer.from("webm input"), async () => ogg);
  assert.equal(voice.payload.audio, ogg); assert.equal(voice.prepared.transcoded, true);
});
test("refuses failed decoding and bounded output instead of sending without waves", async () => {
  await assert.rejects(decodeVoiceMetadata(Buffer.from("invalid")), error => error.code === "AUDIO_WAVEFORM_FAILED");
  await assert.rejects(decodeVoiceMetadata(encodeOgg(pcmFixture()), { maxBytes: 8 }), error => error.code === "AUDIO_WAVEFORM_FAILED");
});
test("Baileys preserves the waveform in the encoded WhatsApp voice message without a network send", async () => {
  const { generateWAMessageContent, proto } = await import("@whiskeysockets/baileys");
  const voice = await prepareVoiceNote(encodeOgg(pcmFixture()), transcodeVoiceAudio);
  const message = await generateWAMessageContent(voice.payload, {
    upload: async () => ({ mediaUrl: "https://example.invalid/audio", directPath: "/mock-audio" }),
  });
  const decoded = proto.Message.decode(proto.Message.encode(message).finish());
  assert.equal(decoded.audioMessage.ptt, true);
  assert.equal(decoded.audioMessage.seconds, voice.payload.seconds);
  assert.deepEqual(Uint8Array.from(decoded.audioMessage.waveform), voice.payload.waveform);
});
