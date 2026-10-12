import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { useMultiFileAuthState } from "@whiskeysockets/baileys";
import { createCredentialSaver, restoreSessionCredentials } from "../src/session-auth.js";

const credentials = (counter) => ({ noiseKey: {}, signedIdentityKey: {}, signedPreKey: {}, nextPreKeyId: counter });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("reconnect retains newer volume credentials and Signal keys instead of a stale remote backup", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "genda-auth-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { state, saveCreds } = await useMultiFileAuthState(directory);
  state.creds.nextPreKeyId = 99;
  await saveCreds();
  await state.keys.set({ "pre-key": { "98": { private: Buffer.from("local-test-key"), public: Buffer.from("local-public") } } });
  let downloads = 0;
  assert.equal(await restoreSessionCredentials(directory, async () => { downloads++; return credentials(1); }), "local");
  const restored = await useMultiFileAuthState(directory);
  assert.equal(restored.state.creds.nextPreKeyId, 99);
  assert.deepEqual((await restored.state.keys.get("pre-key", ["98"]))["98"].private, Buffer.from("local-test-key"));
  assert.equal(downloads, 0);
});

test("missing local credentials are restored from a valid remote backup", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "genda-auth-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.equal(await restoreSessionCredentials(directory, async () => credentials(10)), "remote");
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, "creds.json"))).nextPreKeyId, 10);
});

test("corrupt local credentials without a backup fail without silently creating a new identity", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "genda-auth-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "creds.json"), "{broken");
  await assert.rejects(restoreSessionCredentials(directory, async () => null), /no backup/);
  assert.equal(await fs.readFile(path.join(directory, "creds.json"), "utf8"), "{broken");
});

test("concurrent credential updates cannot upload older counters after newer ones", async () => {
  const firstUpload = deferred();
  const enteredUpload = deferred();
  let counter = 0;
  const uploads = [];
  const saver = createCredentialSaver({
    saveLocal: async () => { counter++; },
    readLocal: async () => JSON.stringify(credentials(counter)),
    upload: async (value) => {
      if (value.nextPreKeyId === 1) { enteredUpload.resolve(); await firstUpload.promise; }
      uploads.push(value.nextPreKeyId);
    },
  });
  const first = saver.save();
  await enteredUpload.promise;
  const second = saver.save();
  assert.equal(counter, 1);
  firstUpload.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(uploads, [1, 2]);
});

test("backup outages retry finitely and preserve valid local auth", async () => {
  let localSaved = false;
  const attempts = [];
  const saver = createCredentialSaver({
    saveLocal: async () => { localSaved = true; },
    readLocal: async () => credentials(99),
    upload: async () => { throw new Error("remote unavailable"); },
    onBackupError: (attempt) => attempts.push(attempt),
  });
  await saver.save();
  assert.equal(localSaved, true);
  assert.deepEqual(attempts, [1, 2, 3]);
});

test("logout waits for an in-flight save and prevents late credential uploads", async () => {
  const writing = deferred();
  const entered = deferred();
  let uploads = 0;
  const saver = createCredentialSaver({
    saveLocal: async () => { entered.resolve(); await writing.promise; },
    readLocal: async () => credentials(1),
    upload: async () => { uploads++; },
  });
  const save = saver.save();
  await entered.promise;
  let drained = false;
  const closing = saver.close().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  writing.resolve();
  await Promise.all([save, closing]);
  await saver.save();
  assert.equal(uploads, 0);
});
