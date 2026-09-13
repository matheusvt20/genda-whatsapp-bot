export function groupParticipantJid(participant) {
  return String(typeof participant === "string" ? participant : participant?.id || participant?.jid || "").trim() || null;
}

export function groupParticipantName(participant) {
  if (!participant || typeof participant === "string") return null;
  return String(participant.name || participant.notify || participant.verifiedName || "").trim() || null;
}

export async function loadGroupDetailsForParticipantUpdate(previousDetails, loadDetails) {
  if (previousDetails) return previousDetails;
  return typeof loadDetails === "function" ? await loadDetails() : null;
}

function mergeParticipant(previous, incoming, jid) {
  if (typeof previous !== "object" && typeof incoming !== "object") return incoming || previous || jid;

  return {
    ...(typeof previous === "object" && previous ? previous : {}),
    ...(typeof incoming === "object" && incoming ? incoming : {}),
    id: incoming?.id || previous?.id || jid,
  };
}

export function applyGroupParticipantUpdate(previousDetails, action, rawParticipants = []) {
  if (!previousDetails || !Array.isArray(rawParticipants) || rawParticipants.length === 0) {
    return previousDetails ?? null;
  }

  const participantsByJid = new Map(
    (Array.isArray(previousDetails.participants) ? previousDetails.participants : [])
      .map((participant) => [groupParticipantJid(participant), participant])
      .filter(([jid]) => Boolean(jid)),
  );
  let participantDelta = 0;

  for (const participant of rawParticipants) {
    const jid = groupParticipantJid(participant);
    if (!jid) continue;

    const previous = participantsByJid.get(jid);
    if (action === "add") {
      if (!previous) participantDelta += 1;
      participantsByJid.set(jid, mergeParticipant(previous, participant, jid));
      continue;
    }

    if (action === "remove") {
      if (participantsByJid.delete(jid)) participantDelta -= 1;
      continue;
    }

    if (action === "promote" || action === "demote") {
      const merged = mergeParticipant(previous, participant, jid);
      participantsByJid.set(jid, {
        ...(typeof merged === "object" && merged ? merged : { id: jid }),
        admin: action === "promote" ? "admin" : null,
      });
    }
  }

  const hasPreviousCount = typeof previousDetails.participantCount === "number"
    && Number.isFinite(previousDetails.participantCount);
  const participantCount = hasPreviousCount
    ? Math.max(0, previousDetails.participantCount + participantDelta)
    : participantsByJid.size;

  return {
    ...previousDetails,
    participants: [...participantsByJid.values()],
    participantCount,
  };
}
