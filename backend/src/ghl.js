const { normalizePhone } = require("./phone");

const DEFAULT_GHL_BASE_URL = "https://services.leadconnectorhq.com";
const DEFAULT_GHL_VERSION = "2023-02-21";
const USERS_API_VERSION = "2021-07-28";

function compact(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null && item !== "");
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => {
      if (item === undefined || item === null || item === "") return false;
      if (Array.isArray(item) && item.length === 0) return false;
      return true;
    })
  );
}

function formatCallMessage({ agentName, disposition, notes, durationSeconds, recordingUrl }) {
  const parts = [];
  if (agentName) parts.push(`Agent: ${agentName}`);
  if (disposition) parts.push(`Disposition: ${disposition}`);
  if (Number.isFinite(durationSeconds)) parts.push(`Duration: ${durationSeconds}s`);
  if (recordingUrl) parts.push(`Recording: ${recordingUrl}`);
  if (notes) parts.push(`Notes: ${notes}`);
  return parts.join("\n") || "RingCentral call";
}

function normalizeGhlCallStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return undefined;

  const statusMap = {
    initiated: "pending",
    pending: "pending",
    ringing: "pending",
    connected: "answered",
    answered: "answered",
    completed: "completed",
    complete: "completed",
    "appointment set": "completed",
    "sale closed": "completed",
    "not interested": "completed",
    "follow up": "completed",
    "wrong number": "failed",
    "no answer": "no-answer",
    "no-answer": "no-answer",
    noanswer: "no-answer",
    voicemail: "voicemail",
    "left voicemail": "voicemail",
    busy: "busy",
    canceled: "canceled",
    cancelled: "canceled",
    failed: "failed"
  };

  return statusMap[normalized] || "completed";
}

function buildExternalOutboundCallPayload(input) {
  return compact({
    type: "Call",
    direction: "outbound",
    contactId: input.contactId,
    conversationId: input.conversationId,
    conversationProviderId: input.conversationProviderId,
    userId: input.userId,
    date: input.occurredAt || new Date().toISOString(),
    sourceId: input.callId,
    message: formatCallMessage(input),
    call: compact({
      id: input.callId,
      to: normalizePhone(input.to),
      from: normalizePhone(input.from),
      status: normalizeGhlCallStatus(input.callStatus || input.disposition),
      duration: input.durationSeconds,
      recordingUrl: input.recordingUrl
    }),
    attachments: compact([
      input.recordingUrl || null
    ]),
    metadata: compact({
      agentName: input.agentName,
      pageUrl: input.pageUrl,
      ringcentralRingoutId: input.callId,
      disposition: input.disposition,
      notes: input.notes
    })
  });
}

function buildInboundMessagePayload(input) {
  return compact({
    type: input.type || "SMS",
    direction: input.direction || "inbound",
    contactId: input.contactId,
    conversationId: input.conversationId,
    conversationProviderId: input.conversationProviderId,
    userId: input.userId,
    date: input.occurredAt || new Date().toISOString(),
    sourceId: input.sourceId,
    message: input.message || "RingCentral activity",
    from: normalizePhone(input.from),
    to: normalizePhone(input.to),
    attachments: compact([
      input.recordingUrl || null
    ]),
    metadata: compact({
      agentName: input.agentName,
      recordingUrl: input.recordingUrl,
      durationSeconds: input.durationSeconds
    })
  });
}

function retryAfterMs(response, fallbackMs) {
  const header = response.headers?.get?.("retry-after");
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return fallbackMs;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function userHasLocation(user, locationId) {
  if (!locationId) return false;
  const locationIds = user?.roles?.locationIds || user?.locationIds || [];
  return Array.isArray(locationIds) && locationIds.includes(locationId);
}

function userMatchRank(user, locationId) {
  const isAccountUser = user?.roles?.type === "account";
  if (isAccountUser && userHasLocation(user, locationId)) return 4;
  if (isAccountUser) return 3;
  if (userHasLocation(user, locationId)) return 2;
  return 1;
}

class GhlClient {
  constructor({
    tokenSet,
    locationId,
    baseUrl = DEFAULT_GHL_BASE_URL,
    version = DEFAULT_GHL_VERSION,
    fetchImpl = fetch,
    refreshToken,
    onTokenSet,
    sleep = defaultSleep,
    maxRateLimitRetries = 2,
    rateLimitBackoffMs = 1000
  }) {
    this.tokenSet = tokenSet || null;
    this.locationId = locationId;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.version = version;
    this.fetchImpl = fetchImpl;
    this.refreshToken = refreshToken;
    this.onTokenSet = onTokenSet;
    this.sleep = sleep;
    this.maxRateLimitRetries = maxRateLimitRetries;
    this.rateLimitBackoffMs = rateLimitBackoffMs;
  }

  canRefreshToken() {
    return Boolean(this.refreshToken && this.tokenSet?.refresh_token);
  }

  headers(extra = {}) {
    const token = this.tokenSet?.access_token;
    if (!token) throw new Error("GHL access token is required");

    return {
      Authorization: `Bearer ${token}`,
      Version: this.version,
      "Content-Type": "application/json",
      ...extra
    };
  }

  async request(path, options = {}) {
    return this.requestWithRetry(path, options, {
      canRefresh: true,
      rateLimitRetries: this.maxRateLimitRetries
    });
  }

  async requestWithRetry(path, options = {}, state) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...options,
      headers: this.headers(options.headers || {})
    });

    let body = null;
    try {
      body = await response.json();
    } catch (error) {
      body = null;
    }

    if (response.ok) return body;

    const detail = body?.message || body?.error || response.statusText || "GHL request failed";

    if (state.canRefresh && response.status === 401 && this.canRefreshToken()) {
      await this.refreshAccessToken();
      return this.requestWithRetry(path, options, { ...state, canRefresh: false });
    }

    if (response.status === 429 && state.rateLimitRetries > 0) {
      await this.sleep(retryAfterMs(response, this.rateLimitBackoffMs));
      return this.requestWithRetry(path, options, { ...state, rateLimitRetries: state.rateLimitRetries - 1 });
    }

    const error = new Error(`GHL ${response.status}: ${Array.isArray(detail) ? detail.join(", ") : detail}`);
    error.status = response.status;
    error.code = "ghl_request_error";
    throw error;
  }

  async refreshAccessToken() {
    if (!this.refreshToken || !this.tokenSet?.refresh_token) {
      throw new Error("GHL OAuth refresh token is required");
    }

    const updatedTokenSet = await this.refreshToken(this.tokenSet);
    this.tokenSet = {
      ...this.tokenSet,
      ...updatedTokenSet
    };

    if (this.onTokenSet) await this.onTokenSet(this.tokenSet);
  }

  async findContactByPhone(phone) {
    const normalized = normalizePhone(phone);
    const params = new URLSearchParams({
      locationId: this.locationId,
      number: normalized
    });
    const body = await this.request(`/contacts/search/duplicate?${params.toString()}`, { method: "GET" });
    return body.contact || body.contacts?.[0] || null;
  }

  async findUserByEmail(email, options = {}) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const locationId = options.locationId || this.locationId;
    if (!normalizedEmail || !locationId) return null;

    const matchByEmail = (body) => {
      const users = Array.isArray(body?.users) ? body.users : Array.isArray(body) ? body : [];
      const matches = users.filter((user) => String(user.email || "").trim().toLowerCase() === normalizedEmail);
      return matches.sort((left, right) => userMatchRank(right, locationId) - userMatchRank(left, locationId))[0] || null;
    };

    try {
      const params = new URLSearchParams({ locationId });
      const body = await this.request(`/users/?${params.toString()}`, {
        method: "GET",
        headers: { Version: USERS_API_VERSION }
      });
      const user = matchByEmail(body);
      if (user) return user;
      if (!options.companyId) return null;
    } catch (error) {
      if (!options.companyId) throw error;
    }

    const params = new URLSearchParams({ companyId: options.companyId, locationId });
    const body = await this.request(`/users/search?${params.toString()}`, {
      method: "GET",
      headers: { Version: USERS_API_VERSION }
    });
    return matchByEmail(body);
  }

  async addOutboundCall(input) {
    const payload = buildExternalOutboundCallPayload(input);
    return this.request("/conversations/messages/outbound", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  async addInboundMessage(input) {
    const payload = buildInboundMessagePayload(input);
    return this.request("/conversations/messages/inbound", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  async assignContactOwner(contactId, assignedTo) {
    if (!contactId) throw new Error("contactId is required to assign contact owner");
    if (!assignedTo) throw new Error("assignedTo is required to assign contact owner");

    return this.request(`/contacts/${encodeURIComponent(contactId)}`, {
      method: "PUT",
      body: JSON.stringify({ assignedTo })
    });
  }

  async assignConversationOwner(conversationId, assignedTo) {
    if (!conversationId) throw new Error("conversationId is required to assign conversation owner");
    if (!assignedTo) throw new Error("assignedTo is required to assign conversation owner");

    return this.request(`/conversations/${encodeURIComponent(conversationId)}`, {
      method: "PUT",
      body: JSON.stringify(compact({
        locationId: this.locationId,
        assignedTo
      }))
    });
  }
}

module.exports = {
  GhlClient,
  buildExternalOutboundCallPayload,
  buildInboundMessagePayload,
  normalizeGhlCallStatus
};
