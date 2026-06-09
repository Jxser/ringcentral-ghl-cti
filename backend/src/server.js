const http = require("node:http");
const crypto = require("node:crypto");

const {
  getBrandAgentProfile,
  getBrandDispositions,
  getBrandProfile,
  getLocationProfile,
  getPublicBrands
} = require("./config");
const { GhlClient } = require("./ghl");
const { resolveHighLevelUserContext } = require("./highlevel-user-context");
const {
  exchangeHighLevelAuthorizationCode,
  getHighLevelLocationToken,
  refreshHighLevelToken
} = require("./highlevel-oauth");
const { normalizePhone } = require("./phone");
const {
  RingCentralClient,
  buildAuthorizationUrl,
  exchangeAuthorizationCode
} = require("./ringcentral");
const { FileTokenStore } = require("./token-store");

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body
  };
}

function readNodeBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function originMatches(pattern, origin) {
  if (!origin) return false;
  if (pattern === "*") return true;
  if (pattern.includes("*")) {
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${escaped}$`).test(origin);
  }
  return pattern === origin;
}

function corsHeaders(config, origin) {
  const allowed = (config.corsOrigins || []).some((pattern) => originMatches(pattern, origin));
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "null",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-CTI-Agent-Session",
    "Access-Control-Max-Age": "86400"
  };
}

function getProviderId(brand, type) {
  if (type === "Call") return brand.ghl?.callConversationProviderId || brand.ghl?.conversationProviderId;
  return brand.ghl?.smsConversationProviderId || brand.ghl?.conversationProviderId;
}

function getConversationIdFromResult(result) {
  return result?.conversationId
    || result?.conversation?.id
    || result?.message?.conversationId
    || result?.message?.conversation?.id
    || null;
}

function getOwnerFromAgentProfile(brand, agentKey) {
  const profile = getBrandAgentProfile(brand, agentKey);
  return profile?.ghlUserId || profile?.userId || profile?.assignedTo || "";
}

function getOwnerFromHighLevelContext(config, brand, encryptedContext) {
  let context = null;
  try {
    context = resolveHighLevelUserContext(config, encryptedContext);
  } catch (error) {
    if (encryptedContext) {
      console.warn(`HighLevel user context could not be decrypted (check GHL_APP_SHARED_SECRET): ${error.message}`);
    }
    return null;
  }
  const userId = getUsableHighLevelUserId(context);
  if (!userId) return null;

  const activeLocation = context.activeLocation || context.locationId || "";
  if (activeLocation && brand.ghl?.locationId && activeLocation !== brand.ghl.locationId) {
    const error = new Error("HighLevel user context does not match the configured brand location");
    error.status = 403;
    error.code = "highlevel_context_location_mismatch";
    throw error;
  }

  return {
    userId,
    userName: context.userName || context.name || "",
    email: context.email || "",
    activeLocation,
    companyId: context.companyId || "",
    type: context.type || ""
  };
}

function getUsableHighLevelUserId(context) {
  const candidates = [
    context?.userId,
    context?.user?.id,
    context?.user?._id,
    context?.id
  ];

  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (!value) continue;
    if (/^(user|admin|agency|location|account)$/i.test(value)) continue;
    return value;
  }

  return "";
}

function getAgentIdentityFromRequest(config, requestBody = {}) {
  const context = getHighLevelContext(config, requestBody.ghlUserContextToken);
  const contextUserId = getUsableHighLevelUserId(context);
  const fallbackKey = String(requestBody.agentKey || "").trim().toLowerCase();

  return {
    agentKey: contextUserId || fallbackKey,
    source: contextUserId ? "highlevel_user_context" : fallbackKey ? "request_agent_key" : "",
    userId: contextUserId,
    userName: context?.userName || context?.name || requestBody.agentName || "",
    email: context?.email || ""
  };
}

async function resolveOwnerAssignment(config, brand, requestBody, ghl) {
  const context = getOwnerFromHighLevelContext(config, brand, requestBody?.ghlUserContextToken);
  if (context?.userId) {
    if (context.email && ghl?.findUserByEmail) {
      try {
        const user = await ghl.findUserByEmail(context.email, {
          companyId: context.companyId,
          locationId: context.activeLocation || brand.ghl?.locationId || ""
        });
        if (user?.id) {
          return {
            assignedTo: user.id,
            source: "ghl_location_user_email_lookup",
            verified: true,
            userName: user.name || [user.firstName, user.lastName].filter(Boolean).join(" ") || context.userName,
            email: user.email || context.email,
            contextUserId: context.userId
          };
        }
      } catch (error) {
        console.warn(`GHL location user lookup failed for ${context.email}: ${error.message}`);
      }
    }

    return {
      assignedTo: context.userId,
      source: "highlevel_user_context",
      verified: false,
      userName: context.userName,
      email: context.email,
      contextUserId: context.userId
    };
  }

  const mappedUserId = getOwnerFromAgentProfile(brand, requestBody?.agentKey);
  if (mappedUserId) return {
    assignedTo: mappedUserId,
    source: "brand_agent_mapping",
    verified: true
  };

  if (ghl?.findUserByEmail && String(requestBody?.agentKey || "").includes("@")) {
    try {
      const user = await ghl.findUserByEmail(requestBody.agentKey);
      if (user?.id) {
        return {
          assignedTo: user.id,
          source: "ghl_user_email_lookup",
          verified: true,
          userName: user.name || [user.firstName, user.lastName].filter(Boolean).join(" "),
          email: user.email || requestBody.agentKey
        };
      }
    } catch (error) {
      console.warn(`GHL user lookup failed for ${requestBody.agentKey}: ${error.message}`);
    }
  }

  return null;
}

function verifiedActorUserId(ownerAssignment) {
  return ownerAssignment?.verified ? ownerAssignment.assignedTo : "";
}

async function assignGhlOwner(ghl, { contactId, conversationId, assignment, currentContactOwnerId }) {
  if (!assignment?.assignedTo) return null;

  const summary = {
    assignedTo: assignment.assignedTo,
    source: assignment.source,
    contactAssigned: false,
    conversationAssigned: false,
    contactOwnerPreserved: false,
    errors: []
  };

  if (contactId && ghl.assignContactOwner) {
    const ownedByAnotherUser = currentContactOwnerId && currentContactOwnerId !== assignment.assignedTo;
    if (ownedByAnotherUser) {
      summary.contactOwnerPreserved = true;
    } else {
      try {
        await ghl.assignContactOwner(contactId, assignment.assignedTo);
        summary.contactAssigned = true;
      } catch (error) {
        console.warn(`GHL contact owner assignment failed for ${assignment.assignedTo}: ${error.message}`);
        summary.errors.push(error.message);
      }
    }
  }

  if (conversationId && ghl.assignConversationOwner) {
    try {
      await ghl.assignConversationOwner(conversationId, assignment.assignedTo);
      summary.conversationAssigned = true;
    } catch (error) {
      console.warn(`GHL conversation owner assignment failed for ${assignment.assignedTo}: ${error.message}`);
      summary.errors.push(error.message);
    }
  }

  return summary;
}

function newSecret() {
  return crypto.randomBytes(32).toString("base64url");
}

async function requireAgentSession(tokenStore, brandKey, agentKey, headers) {
  const provided = headers["x-cti-agent-session"] || headers["X-CTI-Agent-Session"];
  if (!provided) {
    const error = new Error("Agent session is required. Connect RingCentral from the extension popup.");
    error.status = 401;
    error.code = "missing_agent_session";
    throw error;
  }

  const tokenSet = await tokenStore.get(brandKey, agentKey);
  if (!tokenSet?.agent_session_token || tokenSet.agent_session_token !== provided) {
    const error = new Error("Agent session is invalid. Reconnect RingCentral from the extension popup.");
    error.status = 401;
    error.code = "invalid_agent_session";
    throw error;
  }

  return tokenSet;
}

function getRingCentralRedirectUri(config) {
  if (!config.publicBaseUrl) throw new Error("PUBLIC_BASE_URL is required for RingCentral OAuth");
  return `${config.publicBaseUrl}/oauth/ringcentral/callback`;
}

function getHighLevelRedirectUri(config) {
  if (!config.publicBaseUrl) throw new Error("PUBLIC_BASE_URL is required for HighLevel OAuth");
  return `${config.publicBaseUrl}/oauth/callback`;
}

function encodeState(data) {
  return Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
}

function decodeState(value) {
  return JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
}

function decodeOptionalState(value) {
  if (!value) return {};
  try {
    return decodeState(value);
  } catch (error) {
    return { brandKey: String(value) };
  }
}

function getLocationId(tokenSet) {
  return tokenSet?.locationId || tokenSet?.location_id || tokenSet?.location_id_v2 || tokenSet?.activeLocation || "";
}

function getCompanyId(value) {
  return value?.companyId || value?.company_id || value?.companyIdV2 || "";
}

function getHighLevelOAuthConfig(config, brand) {
  const brandOAuth = brand?.ghl?.oauth || {};
  return {
    baseUrl: brandOAuth.baseUrl || config.ghlOAuth?.baseUrl || brand?.ghl?.baseUrl,
    clientId: brandOAuth.clientId || config.ghlOAuth?.clientId,
    clientSecret: brandOAuth.clientSecret || config.ghlOAuth?.clientSecret,
    userType: brandOAuth.userType || config.ghlOAuth?.userType || "Location"
  };
}

function findBrandForHighLevelInstall(config, tokenSet, state) {
  const stateBrand = state?.brandKey ? (config.brands || []).find((brand) => brand.key === state.brandKey) : null;
  if (stateBrand) return stateBrand;

  const locationId = getLocationId(tokenSet);
  return (config.brands || []).find((brand) => brand.ghl?.locationId === locationId);
}

function getHighLevelContext(config, encryptedContext) {
  if (!encryptedContext) return null;

  try {
    return resolveHighLevelUserContext(config, encryptedContext);
  } catch (error) {
    console.warn(`HighLevel user context could not be decrypted (check GHL_APP_SHARED_SECRET): ${error.message}`);
    return null;
  }
}

function getHighLevelContextOrThrow(config, encryptedContext) {
  const context = resolveHighLevelUserContext(config, encryptedContext);
  if (!context?.activeLocation && !context?.locationId) {
    const error = new Error("HighLevel user context is missing active location");
    error.status = 400;
    error.code = "missing_highlevel_active_location";
    throw error;
  }
  return context;
}

function getRequestLocationId(config, body = {}) {
  const context = getHighLevelContext(config, body.ghlUserContextToken);
  const contextLocationId = context?.activeLocation || context?.locationId || "";
  if (contextLocationId) return contextLocationId;

  return String(body.locationId || "").trim();
}

function resolveProfileFromRequest(config, body = {}) {
  const locationId = getRequestLocationId(config, body);
  if (locationId) return getLocationProfile(config, locationId);
  return getBrandProfile(config, body.brandKey);
}

function resolveProfileFromKeyOrLocation(config, value) {
  const key = String(value || "").trim();
  const brand = (config.brands || []).find((candidate) => candidate.key === key);
  if (brand) return brand;
  return getLocationProfile(config, key);
}

function buildInstalledLocation(body, profile) {
  return {
    locationId: profile.ghl?.locationId,
    locationKey: profile.key,
    companyId: getCompanyId(body),
    name: body.locationName || body.name || profile.name,
    installType: body.installType || "",
    appId: body.appId || "",
    versionId: body.versionId || ""
  };
}

async function findContactOrThrow(ghl, phone) {
  const contact = await ghl.findContactByPhone(phone);
  if (!contact?.id) {
    const error = new Error(`No GHL contact found for ${normalizePhone(phone)}`);
    error.status = 404;
    error.code = "contact_not_found";
    throw error;
  }
  return contact;
}

function extractWebhookActivity(payload) {
  const body = payload.body || payload;
  const rawType = body.type || body.messageType || "";
  const type = /sms/i.test(rawType) || body.subject || body.text ? "SMS" : "Call";
  const direction = String(body.direction || body.directionName || "Inbound").toLowerCase().startsWith("out")
    ? "outbound"
    : "inbound";
  const from = body.from?.phoneNumber || body.from || body.parties?.[0]?.from?.phoneNumber || "";
  const toValue = Array.isArray(body.to) ? body.to[0] : body.to;
  const to = toValue?.phoneNumber || toValue || body.parties?.[0]?.to?.phoneNumber || "";
  const recordingUrl = body.recording?.contentUri || body.recordingUrl || body.recording?.url || "";

  return {
    type,
    direction,
    from,
    to,
    contactPhone: direction === "inbound" ? from : to,
    message: body.subject || body.text || body.message || "RingCentral activity",
    sourceId: String(body.id || body.sessionId || body.telephonySessionId || payload.uuid || ""),
    occurredAt: body.creationTime || body.startTime || payload.timestamp || new Date().toISOString(),
    durationSeconds: body.duration,
    recordingUrl
  };
}

function createApp({
  config,
  tokenStore = new FileTokenStore(config.tokenStorePath || "/data/ringcentral-tokens.json"),
  getRingCentralClientForAgent,
  exchangeHighLevelAuthorizationCode: exchangeHighLevelAuthorizationCodeImpl = exchangeHighLevelAuthorizationCode,
  getHighLevelLocationToken: getHighLevelLocationTokenImpl = getHighLevelLocationToken,
  refreshHighLevelToken: refreshHighLevelTokenImpl = refreshHighLevelToken,
  exchangeRingCentralAuthorizationCode: exchangeRingCentralAuthorizationCodeImpl = exchangeAuthorizationCode,
  createRingCentralClient = (brand) => new RingCentralClient(brand.ringcentral || {}),
  createGhlClient
}) {
  async function defaultRingCentralClientForAgent(profile, profileKey, agentKey) {
    if (!agentKey) {
      const error = new Error("Agent RingCentral connection is required");
      error.status = 400;
      error.code = "missing_agent_key";
      throw error;
    }

    const tokenSet = await tokenStore.get(profileKey, agentKey);
    if (!tokenSet) {
      const error = new Error("Agent has not connected RingCentral");
      error.status = 401;
      error.code = "ringcentral_not_connected";
      throw error;
    }

    return new RingCentralClient({
      ...(profile.ringcentral || {}),
      tokenSet,
      onTokenSet: (updatedTokenSet) => tokenStore.set(profileKey, agentKey, updatedTokenSet)
    });
  }

  const resolveRingCentralClientForAgent = getRingCentralClientForAgent || defaultRingCentralClientForAgent;

  async function defaultGhlClientForProfile(profile, profileKey) {
    const tokenSet = tokenStore.getGhlToken ? await tokenStore.getGhlToken(profileKey) : null;
    if (!tokenSet) return new GhlClient(profile.ghl || {});

    const oauthConfig = getHighLevelOAuthConfig(config, profile);
    return new GhlClient({
      ...(profile.ghl || {}),
      tokenSet,
      refreshToken: (currentTokenSet) => refreshHighLevelTokenImpl({
        ...oauthConfig,
        refreshToken: currentTokenSet.refresh_token
      }),
      onTokenSet: (updatedTokenSet) => tokenStore.setGhlToken(profileKey, updatedTokenSet)
    });
  }

  async function resolveGhlClient(profile, profileKey) {
    if (createGhlClient) return createGhlClient(profile, profileKey);
    return defaultGhlClientForProfile(profile, profileKey);
  }

  async function route(request) {
    const method = request.method || "GET";
    const url = new URL(request.url, "http://cti.local");
    const headers = request.headers || {};
    const cors = corsHeaders(config, headers.origin || headers.Origin);

    if (method === "OPTIONS") return jsonResponse(204, null, cors);
    if (method === "GET" && url.pathname === "/health") return jsonResponse(200, { ok: true }, cors);
    if ((method === "GET" || method === "POST") && url.pathname === "/external-auth/verify") {
      return jsonResponse(200, {
        ok: true,
        authenticated: true,
        service: "ringcentral-ghl-cti"
      }, cors);
    }

    if (method === "GET" && url.pathname === "/api/brands") {
      return jsonResponse(200, { brands: getPublicBrands(config) }, cors);
    }

    if (method === "GET" && url.pathname === "/api/extension/highlevel/context-config") {
      return jsonResponse(200, {
        enabled: Boolean(config.ghlApp?.id && config.ghlApp?.sharedSecret),
        appId: config.ghlApp?.id || ""
      }, cors);
    }

    if (method === "GET" && url.pathname === "/api/extension/dispositions") {
      const locationId = url.searchParams.get("locationId");
      const brand = locationId
        ? getLocationProfile(config, locationId)
        : getBrandProfile(config, url.searchParams.get("brandKey"));
      return jsonResponse(200, {
        brandKey: brand.key,
        locationId: brand.ghl?.locationId || "",
        dispositions: getBrandDispositions(brand)
      }, cors);
    }

    if (method === "POST" && url.pathname === "/api/extension/settings/validate") {
      const brand = resolveProfileFromRequest(config, request.body);
      const agentIdentity = getAgentIdentityFromRequest(config, request.body);
      const tokenSet = agentIdentity.agentKey
        ? await tokenStore.get(brand.key, agentIdentity.agentKey)
        : null;
      const providedSessionToken = headers["x-cti-agent-session"] || headers["X-CTI-Agent-Session"] || "";
      const sessionValid = Boolean(tokenSet?.agent_session_token && tokenSet.agent_session_token === providedSessionToken);

      return jsonResponse(200, {
        ok: true,
        brandKey: brand.key,
        brandName: brand.name || brand.key,
        locationId: brand.ghl?.locationId || "",
        agentKey: agentIdentity.agentKey,
        agentSource: agentIdentity.source,
        ringcentralConnected: Boolean(tokenSet?.access_token || tokenSet?.refresh_token),
        agentSessionValid: sessionValid
      }, cors);
    }

    if (method === "POST" && url.pathname === "/api/extension/bootstrap") {
      const context = request.body?.ghlUserContextToken
        ? getHighLevelContextOrThrow(config, request.body.ghlUserContextToken)
        : null;
      const locationId = context?.activeLocation || context?.locationId || request.body?.locationId;
      if (!locationId) {
        const error = new Error("HighLevel active location is required");
        error.status = 400;
        error.code = "missing_highlevel_active_location";
        throw error;
      }
      const profile = getLocationProfile(config, locationId);
      const contextUserId = getUsableHighLevelUserId(context);
      const agentKey = contextUserId || String(request.body?.agentKey || "").trim().toLowerCase();
      const tokenSet = agentKey
        ? await tokenStore.get(profile.key, agentKey)
        : null;
      const providedSessionToken = headers["x-cti-agent-session"] || headers["X-CTI-Agent-Session"] || "";
      const sessionValid = Boolean(tokenSet?.agent_session_token && tokenSet.agent_session_token === providedSessionToken);
      const installedLocation = tokenStore.getInstalledLocation
        ? await tokenStore.getInstalledLocation(locationId)
        : null;
      const ghlToken = tokenStore.getGhlToken ? await tokenStore.getGhlToken(profile.key) : null;

      return jsonResponse(200, {
        ok: true,
        locationId,
        locationKey: profile.key,
        locationName: profile.name && profile.name !== locationId ? profile.name : installedLocation?.name || locationId,
        agentKey,
        agentSource: contextUserId ? "highlevel_user_context" : agentKey ? "request_agent_key" : "",
        highLevelConnected: Boolean(ghlToken?.access_token),
        ringcentralConnected: Boolean(tokenSet?.access_token || tokenSet?.refresh_token),
        agentSessionValid: sessionValid,
        user: context
          ? {
              id: context.userId || "",
              name: context.userName || context.name || "",
              email: context.email || ""
            }
          : null,
        dispositions: getBrandDispositions(profile)
      }, cors);
    }

    if (method === "GET" && url.pathname === "/oauth/ringcentral/start") {
      const brandKey = url.searchParams.get("brandKey");
      const locationId = url.searchParams.get("locationId");
      const agentKey = String(url.searchParams.get("agentKey") || "").trim();
      if (!agentKey) {
        const error = new Error("RingCentral OAuth requires the signed-in HighLevel user. Open a GHL sub-account tab, run Check Setup, then connect RingCentral again.");
        error.status = 400;
        error.code = "missing_agent_state";
        throw error;
      }
      const brand = locationId ? getLocationProfile(config, locationId) : getBrandProfile(config, brandKey);
      const authSessionId = newSecret();
      const authorizationUrl = buildAuthorizationUrl({
        serverUrl: brand.ringcentral?.serverUrl,
        clientId: brand.ringcentral?.clientId,
        redirectUri: getRingCentralRedirectUri(config),
        state: encodeState({ brandKey: brand.key, locationId: brand.ghl?.locationId || "", agentKey, authSessionId })
      });

      await tokenStore.setAuthSession(authSessionId, {
        brandKey: brand.key,
        locationId: brand.ghl?.locationId || "",
        agentKey,
        connected: false
      });

      return jsonResponse(200, {
        authorizationUrl: authorizationUrl.toString(),
        authSessionId
      }, cors);
    }

    if (method === "POST" && url.pathname === "/oauth/ringcentral/session") {
      const session = await tokenStore.getAuthSession(request.body?.authSessionId);
      if (!session) {
        const error = new Error("Unknown RingCentral auth session");
        error.status = 404;
        error.code = "unknown_auth_session";
        throw error;
      }

      return jsonResponse(200, {
        connected: Boolean(session.connected && session.agentSessionToken),
        brandKey: session.brandKey,
        agentKey: session.agentKey,
        agentSessionToken: session.connected ? session.agentSessionToken : undefined
      }, cors);
    }

    if (method === "GET" && url.pathname === "/oauth/ringcentral/callback") {
      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        const error = new Error(`RingCentral OAuth error: ${url.searchParams.get("error_description") || oauthError}`);
        error.status = 400;
        error.code = "ringcentral_oauth_error";
        throw error;
      }

      const code = url.searchParams.get("code");
      const state = decodeOptionalState(url.searchParams.get("state"));
      const authSession = state.authSessionId && tokenStore.getAuthSession
        ? await tokenStore.getAuthSession(state.authSessionId)
        : null;
      const locationId = state.locationId || authSession?.locationId || "";
      const brandKey = state.brandKey || authSession?.brandKey || "";
      const agentKey = String(state.agentKey || authSession?.agentKey || "").trim();

      if (!code) {
        const error = new Error("RingCentral OAuth callback is missing code. Start the RingCentral connection from the extension popup.");
        error.status = 400;
        error.code = "missing_ringcentral_oauth_code";
        throw error;
      }

      if (!agentKey) {
        const error = new Error("RingCentral OAuth callback is missing agent state. Start the RingCentral connection from the extension popup while a GHL sub-account tab is active.");
        error.status = 400;
        error.code = "missing_agent_state";
        throw error;
      }

      if (!locationId && !brandKey) {
        const error = new Error("RingCentral OAuth callback is missing location state. Start the RingCentral connection from the extension popup while a GHL sub-account tab is active.");
        error.status = 400;
        error.code = "missing_agent_state";
        throw error;
      }

      const brand = locationId ? getLocationProfile(config, locationId) : getBrandProfile(config, brandKey);

      const tokenSet = await exchangeRingCentralAuthorizationCodeImpl({
        ...(brand.ringcentral || {}),
        code,
        redirectUri: getRingCentralRedirectUri(config)
      });
      const agentSessionToken = newSecret();
      await tokenStore.set(brand.key, agentKey, {
        ...tokenSet,
        agent_session_token: agentSessionToken
      });
      if (state.authSessionId) {
        await tokenStore.setAuthSession(state.authSessionId, {
          brandKey: brand.key,
          locationId: brand.ghl?.locationId || locationId || "",
          agentKey,
          connected: true,
          agentSessionToken
        });
      }

      return {
        status: 200,
        headers: {
          "Content-Type": "text/html"
        },
        body: "<!doctype html><title>RingCentral connected</title><h1>RingCentral connected</h1><p>You can close this tab and return to GoHighLevel.</p>"
      };
    }

    if (method === "GET" && url.pathname === "/oauth/callback") {
      const code = url.searchParams.get("code");
      const state = decodeOptionalState(url.searchParams.get("state"));
      const stateBrand = state?.brandKey
        ? (config.brands || []).find((brand) => brand.key === state.brandKey)
        : null;
      const oauthConfig = getHighLevelOAuthConfig(config, stateBrand);

      if (!code) {
        const error = new Error("HighLevel OAuth callback is missing code");
        error.status = 400;
        throw error;
      }

      const tokenSet = await exchangeHighLevelAuthorizationCodeImpl({
        ...oauthConfig,
        code,
        redirectUri: getHighLevelRedirectUri(config)
      });
      const brand = findBrandForHighLevelInstall(config, tokenSet, state);
      if (!brand) {
        const locationId = getLocationId(tokenSet);
        if (locationId) {
          const profile = getLocationProfile(config, locationId);
          await tokenStore.setGhlToken(profile.key, tokenSet);
          if (tokenStore.setInstalledLocation) {
            await tokenStore.setInstalledLocation(locationId, {
              locationId,
              locationKey: profile.key,
              companyId: getCompanyId(tokenSet),
              name: profile.name
            });
          }

          return {
            status: 200,
            headers: {
              "Content-Type": "text/html"
            },
            body: `<!doctype html><title>HighLevel connected</title><h1>HighLevel connected</h1><p>${profile.name || locationId} is connected. You can close this tab.</p>`
          };
        }

        const companyId = getCompanyId(tokenSet);
        if (companyId && tokenStore.setGhlAgencyToken) {
          await tokenStore.setGhlAgencyToken(companyId, tokenSet);
          return {
            status: 200,
            headers: {
              "Content-Type": "text/html"
            },
            body: "<!doctype html><title>HighLevel connected</title><h1>HighLevel agency connected</h1><p>Agency install token stored. Waiting for the app install webhook to connect selected sub-accounts.</p>"
          };
        }

        const error = new Error(`No configured brand matches HighLevel location: ${getLocationId(tokenSet) || "(missing)"}`);
        error.status = 400;
        error.code = "unknown_highlevel_location";
        throw error;
      }

      await tokenStore.setGhlToken(brand.key, tokenSet);
      if (tokenStore.setInstalledLocation && getLocationId(tokenSet)) {
        await tokenStore.setInstalledLocation(getLocationId(tokenSet), {
          locationId: getLocationId(tokenSet),
          locationKey: brand.key,
          companyId: getCompanyId(tokenSet),
          name: brand.name || brand.key
        });
      }

      return {
        status: 200,
        headers: {
          "Content-Type": "text/html"
        },
        body: `<!doctype html><title>HighLevel connected</title><h1>HighLevel connected</h1><p>${brand.name || brand.key} is connected. You can close this tab.</p>`
      };
    }

    if (method === "POST" && url.pathname === "/webhooks/highlevel/install") {
      const body = request.body || {};
      const locationId = getLocationId(body);
      const companyId = getCompanyId(body);
      if (!locationId) {
        const error = new Error("HighLevel install webhook is missing locationId");
        error.status = 400;
        error.code = "missing_highlevel_location";
        throw error;
      }
      const brand = getLocationProfile(config, locationId);

      const agencyToken = tokenStore.getGhlAgencyToken ? await tokenStore.getGhlAgencyToken(companyId) : null;
      if (!agencyToken?.access_token) {
        const error = new Error(`No HighLevel agency token found for company: ${companyId || "(missing)"}`);
        error.status = 400;
        error.code = "missing_highlevel_agency_token";
        throw error;
      }

      const locationToken = await getHighLevelLocationTokenImpl({
        ...getHighLevelOAuthConfig(config, brand),
        accessToken: agencyToken.access_token,
        companyId,
        locationId
      });

      await tokenStore.setGhlToken(brand.key, {
        ...locationToken,
        locationId
      });
      if (tokenStore.setInstalledLocation) {
        await tokenStore.setInstalledLocation(locationId, buildInstalledLocation(body, brand));
      }

      return jsonResponse(200, {
        ok: true,
        brandKey: brand.key,
        locationKey: brand.key,
        locationId
      }, cors);
    }

    if (method === "POST" && url.pathname === "/api/extension/calls/start") {
      const brand = resolveProfileFromRequest(config, request.body);
      const agentIdentity = getAgentIdentityFromRequest(config, request.body);
      await requireAgentSession(tokenStore, brand.key, agentIdentity.agentKey, headers);
      const rc = await resolveRingCentralClientForAgent(brand, brand.key, agentIdentity.agentKey);
      const ringout = await rc.startRingOut({
        phone: request.body.phone,
        agentPhone: request.body.agentPhone
      });
      return jsonResponse(200, {
        ctiCallId: null,
        ringcentralRingoutId: ringout.id || ringout.uri || null
      }, cors);
    }

    if (method === "POST" && url.pathname === "/api/extension/calls/status") {
      const brand = resolveProfileFromRequest(config, request.body);
      const agentIdentity = getAgentIdentityFromRequest(config, request.body);
      await requireAgentSession(tokenStore, brand.key, agentIdentity.agentKey, headers);
      const ringoutId = request.body.ringcentralRingoutId;
      if (!ringoutId) {
        const error = new Error("ringcentralRingoutId is required");
        error.status = 400;
        error.code = "missing_ringout_id";
        throw error;
      }
      const rc = await resolveRingCentralClientForAgent(brand, brand.key, agentIdentity.agentKey);
      const status = await rc.getRingOutStatus(ringoutId);
      return jsonResponse(200, {
        ringcentralRingoutId: status.id || ringoutId,
        callStatus: status.status?.callStatus || null,
        callerStatus: status.status?.callerStatus || null,
        calleeStatus: status.status?.calleeStatus || null,
        rawStatus: status.status || null
      }, cors);
    }

    if (method === "POST" && url.pathname === "/api/extension/calls/cancel") {
      const brand = resolveProfileFromRequest(config, request.body);
      const agentIdentity = getAgentIdentityFromRequest(config, request.body);
      await requireAgentSession(tokenStore, brand.key, agentIdentity.agentKey, headers);
      const ringoutId = request.body.ringcentralRingoutId;
      if (!ringoutId) {
        const error = new Error("ringcentralRingoutId is required");
        error.status = 400;
        error.code = "missing_ringout_id";
        throw error;
      }
      const rc = await resolveRingCentralClientForAgent(brand, brand.key, agentIdentity.agentKey);
      await rc.cancelRingOut(ringoutId);
      return jsonResponse(200, { ok: true }, cors);
    }

    if (method === "POST" && url.pathname === "/api/extension/webphone/sip-info") {
      const brand = resolveProfileFromRequest(config, request.body);
      const agentIdentity = getAgentIdentityFromRequest(config, request.body);
      await requireAgentSession(tokenStore, brand.key, agentIdentity.agentKey, headers);
      const rc = await resolveRingCentralClientForAgent(brand, brand.key, agentIdentity.agentKey);
      const sipProvision = await rc.createSipProvision();
      return jsonResponse(200, sipProvision, cors);
    }

    if (method === "POST" && url.pathname === "/api/extension/ringcentral/caller-ids") {
      const brand = resolveProfileFromRequest(config, request.body);
      const agentIdentity = getAgentIdentityFromRequest(config, request.body);
      await requireAgentSession(tokenStore, brand.key, agentIdentity.agentKey, headers);
      const rc = await resolveRingCentralClientForAgent(brand, brand.key, agentIdentity.agentKey);
      const callerIds = await rc.listCallerIds();
      return jsonResponse(200, { callerIds }, cors);
    }

    if (method === "POST" && url.pathname === "/api/extension/calls/disposition") {
      const brand = resolveProfileFromRequest(config, request.body);
      const agentIdentity = getAgentIdentityFromRequest(config, request.body);
      await requireAgentSession(tokenStore, brand.key, agentIdentity.agentKey, headers);
      const ghl = await resolveGhlClient(brand, brand.key);
      const contact = await findContactOrThrow(ghl, request.body.phone);
      const ownerAssignment = await resolveOwnerAssignment(config, brand, request.body, ghl);
      const actorUserId = verifiedActorUserId(ownerAssignment);
      const result = await ghl.addOutboundCall({
        contactId: contact.id,
        conversationProviderId: getProviderId(brand, "Call"),
        to: request.body.phone,
        from: request.body.agentPhone,
        agentName: request.body.agentName || agentIdentity.userName,
        ...(actorUserId ? { userId: actorUserId } : {}),
        callId: request.body.ringcentralRingoutId || request.body.ctiCallId,
        pageUrl: request.body.pageUrl,
        disposition: request.body.disposition,
        notes: request.body.notes,
        durationSeconds: request.body.durationSeconds,
        occurredAt: request.body.completedAt || new Date().toISOString()
      });
      const ownerAssignmentResult = await assignGhlOwner(ghl, {
        contactId: contact.id,
        conversationId: getConversationIdFromResult(result),
        assignment: ownerAssignment,
        currentContactOwnerId: contact.assignedTo
      });
      return jsonResponse(200, {
        messageId: result.id || result.messageId || null,
        conversationId: getConversationIdFromResult(result),
        ownerAssignment: ownerAssignmentResult,
        attribution: ownerAssignment
          ? {
              source: ownerAssignment.source,
              userId: ownerAssignment.assignedTo,
              userName: ownerAssignment.userName || "",
              email: ownerAssignment.email || ""
            }
          : null
      }, cors);
    }

    if (method === "POST" && url.pathname === "/api/extension/sms/send") {
      const brand = resolveProfileFromRequest(config, request.body);
      const agentIdentity = getAgentIdentityFromRequest(config, request.body);
      await requireAgentSession(tokenStore, brand.key, agentIdentity.agentKey, headers);
      const rc = await resolveRingCentralClientForAgent(brand, brand.key, agentIdentity.agentKey);
      const ghl = await resolveGhlClient(brand, brand.key);
      const ownerAssignment = await resolveOwnerAssignment(config, brand, request.body, ghl);
      const actorUserId = verifiedActorUserId(ownerAssignment);
      const sms = await rc.sendSms({
        to: request.body.to,
        from: request.body.from,
        message: request.body.message
      });
      const contact = await findContactOrThrow(ghl, request.body.to);
      const ghlMessage = await ghl.addInboundMessage({
        contactId: contact.id,
        conversationProviderId: getProviderId(brand, "SMS"),
        type: "SMS",
        direction: "outbound",
        from: request.body.from,
        to: request.body.to,
        message: request.body.message,
        agentName: request.body.agentName || agentIdentity.userName,
        ...(actorUserId ? { userId: actorUserId } : {}),
        sourceId: sms.id || sms.messageId,
        occurredAt: request.body.createdAt || new Date().toISOString()
      });
      const ownerAssignmentResult = await assignGhlOwner(ghl, {
        contactId: contact.id,
        conversationId: getConversationIdFromResult(ghlMessage),
        assignment: ownerAssignment,
        currentContactOwnerId: contact.assignedTo
      });
      return jsonResponse(200, {
        ringcentralMessageId: sms.id || sms.messageId || null,
        ghlMessageId: ghlMessage.id || ghlMessage.messageId || null,
        conversationId: getConversationIdFromResult(ghlMessage),
        ownerAssignment: ownerAssignmentResult,
        attribution: ownerAssignment
          ? {
              source: ownerAssignment.source,
              userId: ownerAssignment.assignedTo,
              userName: ownerAssignment.userName || "",
              email: ownerAssignment.email || ""
            }
          : null
      }, cors);
    }

    const webhookMatch = url.pathname.match(/^\/webhooks\/ringcentral\/([^/]+)$/);
    if (method === "POST" && webhookMatch) {
      const brand = resolveProfileFromKeyOrLocation(config, webhookMatch[1]);
      const ghl = await resolveGhlClient(brand, brand.key);
      const activity = extractWebhookActivity(request.body || {});
      const contact = await findContactOrThrow(ghl, activity.contactPhone);
      const basePayload = {
        ...activity,
        contactId: contact.id,
        conversationProviderId: getProviderId(brand, activity.type)
      };
      const result = activity.type === "Call" && activity.direction === "outbound"
        ? await ghl.addOutboundCall({
            ...basePayload,
            callId: activity.sourceId,
            to: activity.to,
            from: activity.from
          })
        : await ghl.addInboundMessage(basePayload);
      return jsonResponse(200, { messageId: result.id || result.messageId || null }, cors);
    }

    return jsonResponse(404, { error: "not_found" }, cors);
  }

  async function handle(request) {
    try {
      return await route(request);
    } catch (error) {
      return jsonResponse(error.status || 500, {
        error: error.code || "server_error",
        message: error.message
      }, corsHeaders(config, request.headers?.origin || request.headers?.Origin));
    }
  }

  function toNodeListener() {
    return async (req, res) => {
      let body = null;
      try {
        body = await readNodeBody(req);
      } catch (error) {
        const response = jsonResponse(400, { error: "invalid_json", message: error.message });
        res.writeHead(response.status, response.headers);
        res.end(JSON.stringify(response.body));
        return;
      }

      const response = await handle({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body
      });
      res.writeHead(response.status, response.headers);
      if (response.body === null) {
        res.end("");
      } else if (typeof response.body === "string") {
        res.end(response.body);
      } else {
        res.end(JSON.stringify(response.body));
      }
    };
  }

  return { handle, toNodeListener };
}

function listen(app, port) {
  const server = http.createServer(app.toNodeListener());
  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}

module.exports = {
  createApp,
  extractWebhookActivity,
  listen
};
