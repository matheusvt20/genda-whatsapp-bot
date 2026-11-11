import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { transcodeVoiceAudio } from "../src/audio-transcoder.js";
import { prepareVoiceNote } from "../src/voice-waveform.js";

function webmFixture() {
  const encoded = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-metadata", "title=private metadata", "-metadata", "CHAPTER000=00:00:00.000", "-metadata", "CHAPTER000NAME=chapter", "-c:a", "libopus", "-f", "webm", "pipe:1"]);
  assert.equal(encoded.status, 0); return encoded.stdout;
}
function probe(buffer) {
  const result = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_chapters", "-show_format", "-of", "json", "pipe:0"], { input: buffer });
  assert.equal(result.status, 0); return JSON.parse(result.stdout);
}
test("normalizes WebM timestamps, codec and metadata before building the voice message", async () => {
  const { payload } = await prepareVoiceNote(webmFixture(), transcodeVoiceAudio);
  const meta = probe(payload.audio); const audio = meta.streams[0];
  assert.equal(audio.codec_name, "opus"); assert.equal(audio.channels, 1); assert.equal(audio.sample_rate, "48000");
  assert.ok(Number(audio.start_time) >= 0); assert.deepEqual(meta.chapters, []);
  const comments = JSON.stringify([meta.format.tags, audio.tags]);
  assert.ok(!comments.includes("private metadata")); assert.ok(!comments.includes("CHAPTER"));
  const decode = spawnSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-f", "null", "-"], { input: payload.audio });
  assert.equal(decode.status, 0); assert.equal(payload.waveform.length, 64); assert.equal(payload.ptt, true);
});
test("does not bypass normalization just because input already has an Ogg/Opus header", async () => {
  const ogg = await transcodeVoiceAudio(webmFixture());
  let calls = 0;
  const voice = await prepareVoiceNote(ogg, async input => { calls++; return transcodeVoiceAudio(input); });
  assert.equal(calls, 1); assert.equal(voice.prepared.transcoded, true);
});
test("refuses truncated audio instead of forwarding an invalid voice note", async () => {
  await assert.rejects(prepareVoiceNote(Buffer.from("OggS broken OpusHead"), transcodeVoiceAudio), error => error.code === "AUDIO_CONVERSION_FAILED");
});
