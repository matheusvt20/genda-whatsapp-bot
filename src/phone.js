export function normalizeBrazilianPhone(rawPhone) {
  const digits = String(rawPhone || "").replace(/\D/g, "");
  if (!digits) return null;

  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith("55")) {
    return `55${digits}`;
  }

  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) {
    return digits;
  }

  return digits;
}

export function whatsappPhoneCandidates(rawPhone) {
  const normalized = normalizeBrazilianPhone(rawPhone);
  if (!normalized) return [];

  const candidates = [normalized];
  if (!normalized.startsWith("55")) return candidates;

  const nationalNumber = normalized.slice(2);
  if (nationalNumber.length === 11 && nationalNumber[2] === "9") {
    candidates.push(`55${nationalNumber.slice(0, 2)}${nationalNumber.slice(3)}`);
  } else if (nationalNumber.length === 10) {
    candidates.push(`55${nationalNumber.slice(0, 2)}9${nationalNumber.slice(2)}`);
  }

  return [...new Set(candidates)];
}

export function phoneFromJid(jid) {
  const localPart = String(jid || "").split("@")[0];
  const phoneWithoutDeviceId = localPart.split(":")[0];
  return normalizeBrazilianPhone(phoneWithoutDeviceId);
}

export function pickCanonicalWhatsAppJid(results, phoneCandidates = []) {
  if (!Array.isArray(results)) return null;

  const existing = results.filter((result) => (
    result?.exists === true
    && typeof result?.jid === "string"
    && result.jid.endsWith("@s.whatsapp.net")
  ));

  if (existing.length === 0) return null;

  const priority = new Map(phoneCandidates.map((phone, index) => [phone, index]));
  existing.sort((left, right) => (
    (priority.get(phoneFromJid(left.jid)) ?? Number.MAX_SAFE_INTEGER)
    - (priority.get(phoneFromJid(right.jid)) ?? Number.MAX_SAFE_INTEGER)
  ));

  return existing[0].jid;
}
