import test from "node:test";
import assert from "node:assert/strict";
import {
  applyGroupParticipantUpdate,
  groupParticipantJid,
  groupParticipantName,
  loadGroupDetailsForParticipantUpdate,
} from "../src/group-metadata.js";

test("normalizes participant identifiers and names", () => {
  assert.equal(groupParticipantJid("5511999999999@s.whatsapp.net"), "5511999999999@s.whatsapp.net");
  assert.equal(groupParticipantJid({ id: "123@lid" }), "123@lid");
  assert.equal(groupParticipantName({ notify: "Maria" }), "Maria");
});

test("updates cached membership without reloading group metadata", () => {
  const initial = {
    subject: "Turma ao vivo",
    participantCount: 1,
    participants: [{ id: "one@lid", notify: "Ana" }],
    loadedAt: 123,
  };

  const added = applyGroupParticipantUpdate(initial, "add", [{ id: "two@lid", notify: "Bia" }]);
  assert.equal(added.subject, "Turma ao vivo");
  assert.equal(added.loadedAt, 123);
  assert.equal(added.participantCount, 2);
  assert.deepEqual(added.participants.map(groupParticipantJid).sort(), ["one@lid", "two@lid"]);

  const duplicate = applyGroupParticipantUpdate(added, "add", [{ id: "two@lid", notify: "Beatriz" }]);
  assert.equal(duplicate.participantCount, 2);
  assert.equal(groupParticipantName(duplicate.participants.find((item) => groupParticipantJid(item) === "two@lid")), "Beatriz");

  const removed = applyGroupParticipantUpdate(duplicate, "remove", ["one@lid"]);
  assert.equal(removed.participantCount, 1);
  assert.deepEqual(removed.participants.map(groupParticipantJid), ["two@lid"]);
});

test("reuses cached metadata instead of asking WhatsApp to synchronize again", async () => {
  const cached = { subject: "Turma ao vivo", participantCount: 10, participants: [] };
  let remoteLoads = 0;

  const resolved = await loadGroupDetailsForParticipantUpdate(cached, async () => {
    remoteLoads += 1;
    return { subject: "remoto" };
  });

  assert.equal(resolved, cached);
  assert.equal(remoteLoads, 0);
});

test("loads metadata once when a group is not cached yet", async () => {
  let remoteLoads = 0;
  const loaded = { subject: "Novo grupo", participantCount: 1, participants: [] };

  const resolved = await loadGroupDetailsForParticipantUpdate(null, async () => {
    remoteLoads += 1;
    return loaded;
  });

  assert.equal(resolved, loaded);
  assert.equal(remoteLoads, 1);
});

test("applies role changes to the cached participant", () => {
  const initial = {
    participantCount: 1,
    participants: [{ id: "one@lid", notify: "Ana", admin: null }],
  };

  const promoted = applyGroupParticipantUpdate(initial, "promote", ["one@lid"]);
  assert.equal(promoted.participants[0].admin, "admin");
  assert.equal(promoted.participantCount, 1);

  const demoted = applyGroupParticipantUpdate(promoted, "demote", ["one@lid"]);
  assert.equal(demoted.participants[0].admin, null);
  assert.equal(demoted.participantCount, 1);
});
