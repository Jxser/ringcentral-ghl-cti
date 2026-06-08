function normalizePhone(raw) {
  if (!raw) return "";
  const cleaned = String(raw).replace(/[^\d+]/g, "");
  if (cleaned.startsWith("+")) {
    return `+${cleaned.slice(1).replace(/\D/g, "")}`;
  }

  const digits = cleaned.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits;
}

module.exports = { normalizePhone };
