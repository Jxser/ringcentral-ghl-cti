const fs = require("node:fs");

const DEFAULT_DISPOSITIONS = [
  "Connected",
  "Completed",
  "Busy",
  "No Answer",
  "Left Voicemail",
  "Failed",
  "Canceled"
];

const PLACEHOLDER_PATTERNS = [
  /^replace-with/i,
  /^default provider id$/i,
  /^optional .* provider id$/i,
  /^RingCentral OAuth app /i,
  /^HighLevel Marketplace /i
];

function parseJsonConfig(raw, source) {
  try {
    const parsed = JSON.parse(raw);
    return {
      brands: Array.isArray(parsed) ? parsed : parsed.brands || [],
      defaults: Array.isArray(parsed) ? {} : parsed.defaults || {},
      locations: Array.isArray(parsed)
        ? {}
        : parsed.locations || parsed.locationOverrides || {}
    };
  } catch (error) {
    throw new Error(`Invalid ${source}: ${error.message}`);
  }
}

function isPlaceholder(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return true;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized));
}

function requireConfigValue(errors, label, value) {
  if (isPlaceholder(value)) errors.push(label);
}

function getRuntimeConfigIssues(config) {
  const errors = [];
  const ghlDefaults = config.defaults?.ghl || {};
  const rcDefaults = config.defaults?.ringcentral || {};
  const callProviderId = ghlDefaults.callConversationProviderId || ghlDefaults.conversationProviderId;
  const smsProviderId = ghlDefaults.smsConversationProviderId || ghlDefaults.conversationProviderId;

  requireConfigValue(errors, "PUBLIC_BASE_URL", config.publicBaseUrl);
  requireConfigValue(errors, "GHL_OAUTH_CLIENT_ID", config.ghlOAuth?.clientId);
  requireConfigValue(errors, "GHL_OAUTH_CLIENT_SECRET", config.ghlOAuth?.clientSecret);
  requireConfigValue(errors, "GHL_APP_ID", config.ghlApp?.id);
  requireConfigValue(errors, "GHL_APP_SHARED_SECRET", config.ghlApp?.sharedSecret);
  requireConfigValue(errors, "defaults.ghl.callConversationProviderId or defaults.ghl.conversationProviderId", callProviderId);
  requireConfigValue(errors, "defaults.ghl.smsConversationProviderId or defaults.ghl.conversationProviderId", smsProviderId);
  requireConfigValue(errors, "RINGCENTRAL_CLIENT_ID", rcDefaults.clientId);
  requireConfigValue(errors, "RINGCENTRAL_CLIENT_SECRET", rcDefaults.clientSecret);

  return errors;
}

function validateRuntimeConfig(config) {
  const errors = getRuntimeConfigIssues(config);
  if (errors.length) {
    throw new Error(`Missing or placeholder runtime config: ${errors.join(", ")}`);
  }
}

function loadConfigFromEnv(env = process.env) {
  let appConfig = { brands: [], defaults: {}, locations: {} };

  if (env.APP_CONFIG_PATH) {
    appConfig = parseJsonConfig(fs.readFileSync(env.APP_CONFIG_PATH, "utf8"), "APP_CONFIG_PATH");
  }

  const configuredDefaults = appConfig.defaults || {};
  const configuredRingCentral = configuredDefaults.ringcentral || {};
  const ringCentralDefaults = compactObject({
    ...configuredRingCentral,
    serverUrl: env.RINGCENTRAL_SERVER_URL || configuredRingCentral.serverUrl || "https://platform.ringcentral.com",
    clientId: env.RINGCENTRAL_CLIENT_ID || "",
    clientSecret: env.RINGCENTRAL_CLIENT_SECRET || "",
    extensionId: env.RINGCENTRAL_EXTENSION_ID || configuredRingCentral.extensionId || "~"
  });

  return {
    port: Number(env.PORT || 8080),
    publicBaseUrl: (env.PUBLIC_BASE_URL || (env.CTI_DOMAIN ? `https://${env.CTI_DOMAIN}` : "")).replace(/\/$/, ""),
    tokenStorePath: env.TOKEN_STORE_PATH || "/data/ringcentral-tokens.json",
    corsOrigins: (env.CORS_ORIGINS || "https://*.gohighlevel.com,https://*.leadconnectorhq.com")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    ghlOAuth: {
      clientId: env.GHL_OAUTH_CLIENT_ID || "",
      clientSecret: env.GHL_OAUTH_CLIENT_SECRET || "",
      userType: env.GHL_OAUTH_USER_TYPE || "Location",
      baseUrl: env.GHL_BASE_URL || undefined
    },
    ghlApp: {
      id: env.GHL_APP_ID || "",
      sharedSecret: env.GHL_APP_SHARED_SECRET || ""
    },
    appConfigPath: env.APP_CONFIG_PATH || "",
    defaults: deepMerge(configuredDefaults, { ringcentral: ringCentralDefaults }),
    locations: appConfig.locations || {},
    locationOverrides: appConfig.locations || {},
    brands: appConfig.brands
  };
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== null && item !== "")
  );
}

function deepMerge(...sources) {
  const result = {};

  for (const source of sources) {
    if (!source || typeof source !== "object") continue;

    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        result[key] = deepMerge(result[key], value);
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}

function locationProfileKey(locationId) {
  return `location:${String(locationId || "").trim()}`;
}

function getBrandProfile(config, brandKey) {
  const normalizedKey = String(brandKey || "").trim();
  const brand = (config.brands || []).find((candidate) => candidate.key === normalizedKey);
  if (!brand) throw new Error(`Unknown brand: ${normalizedKey || "(empty)"}`);
  return deepMerge(config.defaults || {}, brand);
}

function getLocationProfile(config, locationId) {
  const normalizedLocationId = String(locationId || "").trim();
  if (!normalizedLocationId) throw new Error("HighLevel locationId is required");

  const configuredBrand = (config.brands || []).find((brand) => brand.ghl?.locationId === normalizedLocationId) || null;
  const locations = config.locations || config.locationOverrides || {};
  const override = locations[normalizedLocationId] || {};
  const merged = deepMerge(config.defaults || {}, configuredBrand || {}, override);

  return {
    ...merged,
    key: merged.key || configuredBrand?.key || locationProfileKey(normalizedLocationId),
    name: merged.name || configuredBrand?.name || normalizedLocationId,
    ghl: compactObject({
      ...(merged.ghl || {}),
      locationId: normalizedLocationId
    })
  };
}

function getPublicBrands(config) {
  return (config.brands || []).map((brand) => ({
    key: brand.key,
    name: brand.name || brand.key,
    dispositions: getBrandDispositions(brand)
  }));
}

function getBrandDispositions(brand) {
  const configured = brand.dispositions || brand.ghl?.dispositions;
  const list = Array.isArray(configured) ? configured : DEFAULT_DISPOSITIONS;
  return [...new Set(list.map((item) => String(item || "").trim()).filter(Boolean))];
}

function getBrandAgentProfile(brand, agentKey) {
  const normalizedAgentKey = String(agentKey || "").trim().toLowerCase();
  if (!normalizedAgentKey) return null;

  const agents = brand.agents || brand.ghl?.agents || {};
  const directMatch = agents[normalizedAgentKey];
  if (directMatch) return directMatch;

  return Object.entries(agents).find(([key]) => key.toLowerCase() === normalizedAgentKey)?.[1] || null;
}

module.exports = {
  DEFAULT_DISPOSITIONS,
  getRuntimeConfigIssues,
  getBrandAgentProfile,
  getBrandDispositions,
  getBrandProfile,
  getLocationProfile,
  getPublicBrands,
  isPlaceholder,
  locationProfileKey,
  loadConfigFromEnv,
  validateRuntimeConfig
};
