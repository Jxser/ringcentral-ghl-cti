(function attachLocationUtils(root) {
  const LOCATION_ID_PATTERN = /^[A-Za-z0-9_-]{10,80}$/;
  const QUERY_KEYS = [
    "locationId",
    "location_id",
    "activeLocation",
    "active_location",
    "selectedLocationId",
    "selected_location_id",
    "currentLocationId",
    "current_location_id"
  ];
  const OBJECT_KEYS = [
    "activeLocation",
    "locationId",
    "location_id",
    "selectedLocationId",
    "currentLocationId"
  ];
  const STORAGE_KEY_HINTS = [
    "location",
    "active-location",
    "selected-location",
    "selectedlocation",
    "currentlocation"
  ];

  function cleanCandidate(value) {
    const candidate = String(value || "").trim();
    if (!LOCATION_ID_PATTERN.test(candidate)) return "";
    return candidate;
  }

  function extractFromSearchParams(searchParams) {
    for (const key of QUERY_KEYS) {
      const candidate = cleanCandidate(searchParams.get(key));
      if (candidate) return candidate;
    }
    return "";
  }

  function extractFromPath(pathValue) {
    const value = String(pathValue || "");
    const match = value.match(/(?:^|\/)(?:v2\/)?locations?\/([A-Za-z0-9_-]{10,80})(?:[/?#]|$)/i);
    return match ? cleanCandidate(match[1]) : "";
  }

  function extractHighLevelLocationIdFromUrl(rawUrl) {
    if (!rawUrl) return "";

    try {
      const url = new URL(rawUrl);
      return extractFromSearchParams(url.searchParams)
        || extractFromPath(url.pathname)
        || extractFromPath(url.hash)
        || extractFromSearchParams(new URLSearchParams(String(url.hash || "").replace(/^#\??/, "")));
    } catch (error) {
      return extractFromPath(rawUrl);
    }
  }

  function tryParseJson(value) {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed || !/^[{["]/.test(trimmed)) return value;
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      return value;
    }
  }

  function keySuggestsLocation(key) {
    const normalized = String(key || "").toLowerCase();
    return STORAGE_KEY_HINTS.some((hint) => normalized.includes(hint));
  }

  function extractFromValue(value, keyHint = "", depth = 0) {
    if (depth > 3 || value === null || value === undefined) return "";

    const parsed = tryParseJson(value);
    if (typeof parsed === "string") {
      return keySuggestsLocation(keyHint) ? cleanCandidate(parsed) : "";
    }

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const candidate = extractFromValue(item, keyHint, depth + 1);
        if (candidate) return candidate;
      }
      return "";
    }

    if (typeof parsed !== "object") return "";

    for (const key of OBJECT_KEYS) {
      const candidate = extractFromValue(parsed[key], key, depth + 1);
      if (candidate) return candidate;
    }

    if (keySuggestsLocation(keyHint)) {
      const idCandidate = extractFromValue(parsed.id || parsed._id, "locationId", depth + 1);
      if (idCandidate) return idCandidate;
    }

    for (const [key, childValue] of Object.entries(parsed)) {
      if (!keySuggestsLocation(key)) continue;
      const candidate = extractFromValue(childValue, key, depth + 1);
      if (candidate) return candidate;
    }

    return "";
  }

  function extractHighLevelLocationIdFromStorage(storageSnapshot = {}) {
    const stores = [
      storageSnapshot.localStorage || {},
      storageSnapshot.sessionStorage || {}
    ];

    for (const store of stores) {
      for (const [key, value] of Object.entries(store)) {
        const candidate = extractFromValue(value, key);
        if (candidate) return candidate;
      }
    }

    return "";
  }

  const api = {
    extractHighLevelLocationIdFromStorage,
    extractHighLevelLocationIdFromUrl
  };

  root.RcGhlLocationUtils = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
