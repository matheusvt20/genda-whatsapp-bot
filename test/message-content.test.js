import test from "node:test";
import assert from "node:assert/strict";
import {
  extractAdContext,
  extractMediaInfo,
  extractMessageText,
  extractMessageType,
  unwrapMessageContent,
} from "../src/message-content.js";

test("extracts text from a regular incoming message", () => {
  const message = { message: { conversation: "teste 3" } };

  assert.equal(extractMessageText(message), "teste 3");
  assert.equal(extractMessageType(message), "text");
});

test("unwraps nested future-proof WhatsApp message containers", () => {
  const message = {
    message: {
      ephemeralMessage: {
        message: {
          viewOnceMessageV2Extension: {
            message: { extendedTextMessage: { text: "mensagem aninhada" } },
          },
        },
      },
    },
  };

  assert.deepEqual(unwrapMessageContent(message), {
    extendedTextMessage: { text: "mensagem aninhada" },
  });
  assert.equal(extractMessageText(message), "mensagem aninhada");
});

test("unwraps messages sent through another linked device", () => {
  const message = {
    message: {
      deviceSentMessage: {
        message: { conversation: "mensagem de dispositivo" },
      },
    },
  };

  assert.equal(extractMessageText(message), "mensagem de dispositivo");
});

test("recognizes supported media without exposing its content", () => {
  const message = {
    message: {
      documentWithCaptionMessage: {
        message: {
          documentMessage: {
            mimetype: "application/pdf",
            fileName: "arquivo.pdf",
          },
        },
      },
    },
  };

  assert.equal(extractMessageType(message), "document");
  assert.deepEqual(extractMediaInfo(message), {
    mimetype: "application/pdf",
    fileName: "arquivo.pdf",
  });
});

test("recognizes an incoming audio message", () => {
  const message = {
    message: {
      audioMessage: {
        mimetype: "audio/ogg; codecs=opus",
      },
    },
  };

  assert.equal(extractMessageType(message), "audio");
  assert.deepEqual(extractMediaInfo(message), {
    mimetype: "audio/ogg; codecs=opus",
    fileName: null,
  });
});

test("extracts the ad that a click-to-WhatsApp message came from", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const message = {
    message: {
      extendedTextMessage: {
        text: "Olá! Posso ter mais informações sobre isso?",
        contextInfo: {
          externalAdReply: {
            title: "Cílios com 20% off",
            body: "Agende sua avaliação",
            mediaType: 1,
            sourceType: "ad",
            sourceId: "120210",
            sourceUrl: "https://fb.me/abc",
            thumbnailUrl: "https://cdn.example/thumb.jpg",
            thumbnail: jpeg,
            ctwaClid: "clid-1",
          },
        },
      },
    },
  };

  assert.deepEqual(extractAdContext(message), {
    title: "Cílios com 20% off",
    body: "Agende sua avaliação",
    source_type: "ad",
    source_id: "120210",
    source_url: "https://fb.me/abc",
    media_type: "image",
    media_url: null,
    thumbnail_url: "https://cdn.example/thumb.jpg",
    thumbnail_data: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
    ctwa_clid: "clid-1",
  });
});

test("returns no ad context for a regular message or an oversized thumbnail", () => {
  assert.equal(extractAdContext({ message: { conversation: "oi" } }), null);
  assert.equal(extractAdContext({ message: { extendedTextMessage: { text: "oi", contextInfo: {} } } }), null);

  const big = Buffer.alloc(200 * 1024, 1);
  big[0] = 0xff;
  big[1] = 0xd8;
  const message = {
    message: { extendedTextMessage: { text: "oi", contextInfo: { externalAdReply: { title: "Anúncio", thumbnail: big } } } },
  };
  assert.equal(extractAdContext(message).thumbnail_data, null);
  assert.equal(extractAdContext(message).title, "Anúncio");
});
