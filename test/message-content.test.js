import test from "node:test";
import assert from "node:assert/strict";
import {
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
