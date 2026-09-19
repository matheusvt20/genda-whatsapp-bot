export const WHATSAPP_OPUS_MIME_TYPE = "audio/ogg; codecs=opus";

function audioPreparationError(code, message, httpStatus = 422) {
  const error = new Error(message);
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

export function isOggOpus(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= 32
    && buffer.subarray(0, 4).toString("ascii") === "OggS"
    && buffer.includes(Buffer.from("OpusHead", "ascii"));
}

/**
 * WhatsApp voice messages must be Ogg/Opus. Preserve a valid Ogg/Opus file,
 * but convert every other browser or attachment format before it reaches
 * Baileys. The injected transcoder keeps this behavior independently testable.
 */
export async function prepareOutgoingAudio(buffer, transcodeToOggOpus) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw audioPreparationError("INVALID_AUDIO", "audio file is empty");
  }

  if (isOggOpus(buffer)) {
    return { buffer, mimeType: WHATSAPP_OPUS_MIME_TYPE, transcoded: false };
  }

  if (typeof transcodeToOggOpus !== "function") {
    throw audioPreparationError("AUDIO_TRANSCODER_UNAVAILABLE", "audio transcoder is unavailable", 503);
  }

  const transcoded = await transcodeToOggOpus(buffer);
  if (!isOggOpus(transcoded)) {
    throw audioPreparationError("AUDIO_CONVERSION_FAILED", "audio conversion did not produce Ogg/Opus");
  }

  return { buffer: transcoded, mimeType: WHATSAPP_OPUS_MIME_TYPE, transcoded: true };
}
