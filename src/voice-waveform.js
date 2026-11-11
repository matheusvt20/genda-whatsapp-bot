import { spawn } from "node:child_process";
import { prepareOutgoingAudio } from "./outgoing-audio.js";

const SAMPLE_RATE = 8000;
const BARS = 64;

// Mono PCM, s16le. Cada barra corresponde a um trecho real do áudio.
export function waveformFromPcm(pcm) {
  const count = Math.floor(pcm.length / 2);
  if (!count) throw new Error("audio decoder produced no samples");
  const levels = Array.from({ length: BARS }, (_, i) => {
    const start = Math.floor(i * count / BARS);
    const end = Math.floor((i + 1) * count / BARS);
    let sum = 0;
    for (let j = start; j < end; j++) sum += Math.abs(pcm.readInt16LE(j * 2));
    return end > start ? sum / (end - start) : 0;
  });
  const peak = Math.max(...levels);
  return {
    waveform: Uint8Array.from(levels, level => peak > 0 ? Math.round(100 * level / peak) : 0),
    seconds: Math.max(1, Math.ceil(count / SAMPLE_RATE)),
  };
}

/** ffmpeg já integra a imagem publicada; não depende do decoder opcional do Baileys. */
export function decodeVoiceMetadata(buffer, { timeoutMs = 30000, maxBytes = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, metadata) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) {
        child.kill("SIGKILL");
        const failure = new Error("voice waveform preparation failed");
        failure.code = "AUDIO_WAVEFORM_FAILED"; failure.httpStatus = 503;
        reject(failure);
      } else resolve(metadata);
    };
    const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs);
    child.on("error", finish);
    child.stdin.on("error", () => { /* a saída do processo decide se houve falha */ });
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) finish(new Error("decoded audio is too large"));
      else if (!settled) chunks.push(chunk);
    });
    child.on("close", code => {
      if (settled) return;
      if (code !== 0) return finish(new Error("decode failed"));
      try { finish(null, waveformFromPcm(Buffer.concat(chunks))); }
      catch (error) { finish(error); }
    });
    child.stdin.end(buffer);
  });
}

export async function prepareVoiceNote(buffer, transcode, decode = decodeVoiceMetadata) {
  const prepared = await prepareOutgoingAudio(buffer, transcode, { normalize: true });
  const { waveform, seconds } = await decode(prepared.buffer);
  if (!(waveform instanceof Uint8Array) || waveform.length !== BARS || !Number.isInteger(seconds) || seconds < 1) throw new Error("invalid voice metadata");
  return { prepared, payload: { audio: prepared.buffer, mimetype: prepared.mimeType, ptt: true, waveform, seconds } };
}
