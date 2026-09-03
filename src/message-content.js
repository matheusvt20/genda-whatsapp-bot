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
