const { normalizePhone } = require("./phone");

const DEFAULT_GHL_BASE_URL = "https://services.leadconnectorhq.com";
const DEFAULT_GHL_VERSION = "2023-02-21";

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
    assignedTo: input.assignedTo,
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
    assignedTo: input.assignedTo,
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

function isExpiredTokenError(status, detail) {
  return status === 401 && /expired|invalid jwt|invalid token|token is invalid/i.test(String(detail || ""));
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
    onTokenSet
  }) {
    this.tokenSet = tokenSet || null;
    this.locationId = locationId;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.version = version;
    this.fetchImpl = fetchImpl;
    this.refreshToken = refreshToken;
    this.onTokenSet = onTokenSet;
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
    return this.requestWithRetry(path, options, true);
  }

  async requestWithRetry(path, options = {}, canRefresh) {
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

    if (!response.ok) {
      const detail = body?.message || body?.error || response.statusText || "GHL request failed";
      if (canRefresh && isExpiredTokenError(response.status, detail)) {
        await this.refreshAccessToken();
        return this.requestWithRetry(path, options, false);
      }
      throw new Error(`GHL ${response.status}: ${detail}`);
    }

    return body;
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

    const params = new URLSearchParams({ locationId });
    if (options.companyId) params.set("companyId", options.companyId);
    const body = await this.request(`/users/search?${params.toString()}`, { method: "GET" });
    const users = Array.isArray(body.users) ? body.users : [];
    const matches = users.filter((user) => String(user.email || "").trim().toLowerCase() === normalizedEmail);
    return matches.sort((left, right) => userMatchRank(right, locationId) - userMatchRank(left, locationId))[0] || null;
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
