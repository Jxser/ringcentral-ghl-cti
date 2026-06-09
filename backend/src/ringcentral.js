const { normalizePhone } = require("./phone");

const DEFAULT_RC_SERVER_URL = "https://platform.ringcentral.com";

function basicAuth(clientId, clientSecret) {
  return Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

function reauthRequiredError(message) {
  const error = new Error(message);
  error.status = 401;
  error.code = "ringcentral_reauth_required";
  return error;
}

function normalizeTokenSet(payload) {
  return {
    ...payload,
    expires_at: Date.now() + Number(payload.expires_in || 3600) * 1000
  };
}

function buildAuthorizationUrl({
  serverUrl = DEFAULT_RC_SERVER_URL,
  clientId,
  redirectUri,
  state
}) {
  const url = new URL("/restapi/oauth/authorize", serverUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  if (state) url.searchParams.set("state", state);
  return url;
}

async function exchangeAuthorizationCode({
  serverUrl = DEFAULT_RC_SERVER_URL,
  clientId,
  clientSecret,
  code,
  redirectUri,
  fetchImpl = fetch
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri
  });

  const response = await fetchImpl(`${serverUrl.replace(/\/$/, "")}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth(clientId, clientSecret)}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`RingCentral OAuth ${response.status}: ${payload.error_description || payload.error || "failed"}`);
  }

  return normalizeTokenSet(payload);
}

class RingCentralClient {
  constructor({
    serverUrl = DEFAULT_RC_SERVER_URL,
    clientId,
    clientSecret,
    tokenSet,
    onTokenSet,
    extensionId = "~",
    fetchImpl = fetch
  }) {
    this.serverUrl = serverUrl.replace(/\/$/, "");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokenSet = tokenSet || null;
    this.onTokenSet = onTokenSet;
    this.extensionId = extensionId || "~";
    this.fetchImpl = fetchImpl;
  }

  async getAccessToken() {
    if (this.tokenSet?.access_token && Date.now() < Number(this.tokenSet.expires_at || 0) - 60_000) {
      return this.tokenSet.access_token;
    }

    return this.refreshAccessToken();
  }

  async refreshAccessToken() {
    if (!this.tokenSet?.refresh_token) {
      throw reauthRequiredError("RingCentral agent is not connected. Reconnect RingCentral from the extension popup.");
    }

    const response = await this.fetchImpl(`${this.serverUrl}/restapi/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth(this.clientId, this.clientSecret)}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.tokenSet.refresh_token
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      const detail = payload.error_description || payload.error || "failed";
      throw reauthRequiredError(`RingCentral session expired. Reconnect RingCentral from the extension popup. (${detail})`);
    }

    this.tokenSet = {
      ...this.tokenSet,
      ...normalizeTokenSet(payload)
    };
    if (this.onTokenSet) await this.onTokenSet(this.tokenSet);
    return this.tokenSet.access_token;
  }

  async request(path, options = {}) {
    const token = await this.getAccessToken();
    const response = await this.fetchImpl(`${this.serverUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });

    let body = null;
    try {
      body = await response.json();
    } catch (error) {
      body = null;
    }

    if (!response.ok) {
      const detail = body?.message || body?.error_description || body?.error || response.statusText || "request failed";
      throw new Error(`RingCentral ${response.status}: ${detail}`);
    }

    return body;
  }

  async startRingOut({ phone, agentPhone }) {
    return this.request(`/restapi/v1.0/account/~/extension/${this.extensionId}/ring-out`, {
      method: "POST",
      body: JSON.stringify({
        from: { phoneNumber: normalizePhone(agentPhone) },
        to: { phoneNumber: normalizePhone(phone) },
        playPrompt: false
      })
    });
  }

  async getRingOutStatus(ringoutId) {
    return this.request(`/restapi/v1.0/account/~/extension/${this.extensionId}/ring-out/${encodeURIComponent(ringoutId)}`, {
      method: "GET"
    });
  }

  async cancelRingOut(ringoutId) {
    const result = await this.request(`/restapi/v1.0/account/~/extension/${this.extensionId}/ring-out/${encodeURIComponent(ringoutId)}`, {
      method: "DELETE"
    });
    return { ...(result || {}), ok: true };
  }

  async createSipProvision() {
    const result = await this.request("/restapi/v1.0/client-info/sip-provision", {
      method: "POST",
      body: JSON.stringify({
        sipInfo: [{ transport: "WSS" }]
      })
    });

    return {
      deviceId: result.device?.id || null,
      sipInfo: result.sipInfo?.[0] || null
    };
  }

  async listCallerIds() {
    const result = await this.request(`/restapi/v1.0/account/~/extension/${this.extensionId}/phone-number?perPage=100`, {
      method: "GET"
    });
    const records = Array.isArray(result?.records) ? result.records : [];

    return records
      .filter((record) => normalizePhone(record.phoneNumber))
      .map((record) => ({
        phoneNumber: normalizePhone(record.phoneNumber),
        label: record.label || record.name || normalizePhone(record.phoneNumber),
        usageType: record.usageType || ""
      }));
  }

  async sendSms({ to, from, message }) {
    return this.request(`/restapi/v1.0/account/~/extension/${this.extensionId}/sms`, {
      method: "POST",
      body: JSON.stringify({
        from: { phoneNumber: normalizePhone(from) },
        to: [{ phoneNumber: normalizePhone(to) }],
        text: message
      })
    });
  }
}

module.exports = {
  RingCentralClient,
  buildAuthorizationUrl,
  exchangeAuthorizationCode
};
