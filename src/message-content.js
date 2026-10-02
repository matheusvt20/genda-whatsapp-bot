import { extractMessageContent as extractBaileysMessageContent } from "@whiskeysockets/baileys";

export function unwrapMessageContent(message) {
  let content = message?.message;
  if (!content) return null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const normalized = extractBaileysMessageContent(content) || content;
    const nested =
      normalized.deviceSentMessage?.message ||
      normalized.protocolMessage?.editedMessage ||
      null;

    if (!nested || nested === content) return normalized;
    content = nested;
  }

  return extractBaileysMessageContent(content) || content;
}

export function extractMessageText(message) {
  const inner = unwrapMessageContent(message);
  if (!inner) return null;

  return (
    inner.conversation ||
    inner.extendedTextMessage?.text ||
    inner.imageMessage?.caption ||
    inner.videoMessage?.caption ||
    inner.buttonsResponseMessage?.selectedDisplayText ||
    inner.listResponseMessage?.title ||
    inner.templateButtonReplyMessage?.selectedDisplayText ||
    inner.interactiveResponseMessage?.body?.text ||
    null
  );
}

export function extractMessageType(message) {
  const inner = unwrapMessageContent(message);
  if (!inner) return "unknown";

  if (inner.imageMessage) return "image";
  if (inner.audioMessage) return "audio";
  if (inner.videoMessage) return "video";
  if (inner.documentMessage) return "document";
  if (inner.stickerMessage) return "sticker";
  if (
    inner.conversation ||
    inner.extendedTextMessage ||
    inner.buttonsResponseMessage ||
    inner.listResponseMessage ||
    inner.templateButtonReplyMessage ||
    inner.interactiveResponseMessage
  ) {
    return "text";
  }

  return "unknown";
}

export function extractMediaInfo(message) {
  const inner = unwrapMessageContent(message);
  if (!inner) return null;

  const mediaMessage =
    inner.imageMessage ||
    inner.videoMessage ||
    inner.audioMessage ||
    inner.documentMessage ||
    inner.stickerMessage ||
    null;

  if (!mediaMessage) return null;

  return {
    mimetype: mediaMessage.mimetype || "application/octet-stream",
    fileName: mediaMessage.fileName || null,
  };
}

const MAX_AD_THUMBNAIL_BYTES = 100 * 1024;

function adThumbnailDataUrl(thumbnail) {
  if (!thumbnail || typeof thumbnail.length !== "number" || thumbnail.length === 0 || thumbnail.length > MAX_AD_THUMBNAIL_BYTES) {
    return null;
  }
  const bytes = Buffer.from(thumbnail);
  const mime = bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg"
    : bytes[0] === 0x89 && bytes[1] === 0x50 ? "image/png"
    : null;
  return mime ? `data:${mime};base64,${bytes.toString("base64")}` : null;
}

function adMediaType(value) {
  if (value === 1 || value === "IMAGE") return "image";
  if (value === 2 || value === "VIDEO") return "video";
  return null;
}

// Mensagem que chegou de um anúncio "Enviar mensagem" (Instagram/Facebook): o WhatsApp entrega título, texto,
// miniatura, link e id do anúncio no contextInfo.externalAdReply. Devolve null quando a mensagem não veio de anúncio.
export function extractAdContext(message) {
  const inner = unwrapMessageContent(message);
  if (!inner || typeof inner !== "object") return null;

  for (const value of Object.values(inner)) {
    const contextInfo = value && typeof value === "object" ? value.contextInfo : null;
    const ad = contextInfo?.externalAdReply;
    if (!ad || typeof ad !== "object") continue;

    const context = {
      title: ad.title || null,
      body: ad.body || null,
      source_type: ad.sourceType || null,
      source_id: ad.sourceId || null,
      source_url: ad.sourceUrl || null,
      media_type: adMediaType(ad.mediaType),
      media_url: ad.mediaUrl || null,
      thumbnail_url: ad.thumbnailUrl || null,
      thumbnail_data: adThumbnailDataUrl(ad.thumbnail),
      ctwa_clid: ad.ctwaClid || contextInfo.ctwaClid || null,
    };
    return Object.values(context).some(Boolean) ? context : null;
  }

  return null;
}
