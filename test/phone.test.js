import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBrazilianPhone, phoneFromJid } from "../src/phone.js";

test("phoneFromJid removes the Baileys device id suffix", () => {
  assert.equal(phoneFromJid("5521983405061:2@s.whatsapp.net"), "5521983405061");
});

test("phoneFromJid preserves a regular WhatsApp phone jid", () => {
  assert.equal(phoneFromJid("5521983405061@s.whatsapp.net"), "5521983405061");
});

test("normalizeBrazilianPhone adds the country code when needed", () => {
  assert.equal(normalizeBrazilianPhone("21983405061"), "5521983405061");
});
