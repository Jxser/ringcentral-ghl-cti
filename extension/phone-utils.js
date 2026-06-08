(function attachPhoneUtils(root) {
  function normalizePhone(raw) {
    if (!raw) return "";
    let cleaned = String(raw).replace(/[^\d+]/g, "");
    if (cleaned.startsWith("+")) {
      const digits = cleaned.slice(1).replace(/\D/g, "");
      return "+" + digits;
    }
    const digits = cleaned.replace(/\D/g, "");
    if (digits.length === 10) return "+1" + digits;
    if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
    return digits;
  }

  function extractPhoneFromText(value) {
    const match = String(value || "").match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
    return match ? normalizePhone(match[0]) : "";
  }

  function isPhoneLikeText(value) {
    const text = String(value || "").trim();
    if (!text || text.length > 48) return false;
    if (/[A-Za-z]{3,}/.test(text)) return false;
    return Boolean(extractPhoneFromText(text));
  }

  function extractPhoneFromElementSnapshot(snapshot = {}) {
    const hrefPhone = String(snapshot.href || "").match(/^tel:(.+)$/i);
    if (hrefPhone) return normalizePhone(hrefPhone[1]);

    const candidates = [
      snapshot.text,
      snapshot.ariaLabel,
      snapshot.title,
      snapshot.dataPhone
    ];

    for (const candidate of candidates) {
      if (isPhoneLikeText(candidate)) return extractPhoneFromText(candidate);
    }

    return "";
  }

  const api = {
    extractPhoneFromElementSnapshot,
    extractPhoneFromText,
    isPhoneLikeText,
    normalizePhone
  };

  root.RcGhlPhoneUtils = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
