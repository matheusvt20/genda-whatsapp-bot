import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBrazilianPhone,
  phoneFromJid,
  pickCanonicalWhatsAppJid,
  whatsappPhoneCandidates,
} from "../src/phone.js";

test("phoneFromJid removes the Baileys device id suffix", () => {
  assert.equal(phoneFromJid("5521983405061:2@s.whatsapp.net"), "5521983405061");
});

test("phoneFromJid preserves a regular WhatsApp phone jid", () => {
  assert.equal(phoneFromJid("5521983405061@s.whatsapp.net"), "5521983405061");
});

test("normalizeBrazilianPhone adds the country code when needed", () => {
  assert.equal(normalizeBrazilianPhone("21983405061"), "5521983405061");
});

test("whatsappPhoneCandidates includes the Brazilian legacy form without the ninth digit", () => {
  assert.deepEqual(whatsappPhoneCandidates("62 99556-9636"), [
    "5562995569636",
    "556295569636",
  ]);
});

test("whatsappPhoneCandidates includes the modern form when a legacy number is provided", () => {
  assert.deepEqual(whatsappPhoneCandidates("556295569636"), [
    "556295569636",
    "5562995569636",
  ]);
});

test("pickCanonicalWhatsAppJid selects a registered canonical jid", () => {
  assert.equal(
    pickCanonicalWhatsAppJid([
      { jid: "556295569636@s.whatsapp.net", exists: true },
      { jid: "5562995569636@s.whatsapp.net", exists: false },
    ], ["5562995569636", "556295569636"]),
    "556295569636@s.whatsapp.net",
  );
});

test("pickCanonicalWhatsAppJid prefers the original registered candidate", () => {
  assert.equal(
    pickCanonicalWhatsAppJid([
      { jid: "556295569636@s.whatsapp.net", exists: true },
      { jid: "5562995569636@s.whatsapp.net", exists: true },
    ], ["5562995569636", "556295569636"]),
    "5562995569636@s.whatsapp.net",
  );
});

test("pickCanonicalWhatsAppJid rejects unregistered results", () => {
  assert.equal(
    pickCanonicalWhatsAppJid([{ jid: "5562995569636@s.whatsapp.net", exists: false }]),
    null,
  );
});
