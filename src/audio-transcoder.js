export const VOICE_AUDIO_PROFILE_VERSION = "2026-11-11.1";
import { spawn } from "node:child_process";

// Um único perfil de voz para navegador/anexo, inclusive Ogg que já chega codificado.
export const VOICE_FFMPEG_ARGS = [
  "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
  "-map", "0:a:0", "-vn", "-map_metadata", "-1", "-map_chapters", "-1",
  "-af", "asetpts=PTS-STARTPTS", "-c:a", "libopus", "-application", "voip",
  "-frame_duration", "20", "-b:a", "32k", "-ac", "1", "-ar", "48000",
  "-avoid_negative_ts", "make_zero", "-fflags", "+bitexact", "-flags:a", "+bitexact",
  "-f", "ogg", "pipe:1",
];
export function transcodeVoiceAudio(input, { timeoutMs = 30000, maxBytes = 9 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", VOICE_FFMPEG_ARGS, { stdio: ["pipe", "pipe", "ignore"] });
    const chunks = []; let size = 0; let settled = false;
    const finish = (code, buffer) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code) {
        child.kill("SIGKILL");
        const error = new Error("audio conversion failed");
        error.code = code; error.httpStatus = code === "AUDIO_CONVERSION_FAILED" ? 422 : 503;
        reject(error);
      } else resolve(buffer);
    };
    const timer = setTimeout(() => finish("AUDIO_CONVERSION_TIMEOUT"), timeoutMs);
    child.on("error", () => finish("AUDIO_TRANSCODER_UNAVAILABLE"));
    child.stdin.on("error", () => { /* O fechamento confirma falha de entrada; não expor conteúdo. */ });
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) finish("AUDIO_CONVERSION_TOO_LARGE");
      else if (!settled) chunks.push(chunk);
    });
    child.on("close", code => {
      if (!settled) finish(code === 0 && size ? null : "AUDIO_CONVERSION_FAILED", Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}
