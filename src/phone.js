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

export function phoneFromJid(jid) {
  const localPart = String(jid || "").split("@")[0];
  const phoneWithoutDeviceId = localPart.split(":")[0];
  return normalizeBrazilianPhone(phoneWithoutDeviceId);
}
