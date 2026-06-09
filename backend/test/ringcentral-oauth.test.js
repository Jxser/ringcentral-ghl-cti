const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RingCentralClient,
  buildAuthorizationUrl,
  exchangeAuthorizationCode
} = require("../src/ringcentral");

test("RingCentralClient surfaces a reauth-required error when refresh fails", async () => {
  const client = new RingCentralClient({
    clientId: "client-1",
    clientSecret: "secret-1",
    tokenSet: { access_token: "old", refresh_token: "dead-refresh", expires_at: 0 },
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_grant", error_description: "Token expired" })
    })
  });

  await assert.rejects(
    () => client.startRingOut({ phone: "+19493745710", agentPhone: "+15555550100" }),
    (error) => {
      assert.equal(error.code, "ringcentral_reauth_required");
      assert.equal(error.status, 401);
      return true;
    }
  );
});

test("RingCentralClient requires reconnect when no refresh token is stored", async () => {
  const client = new RingCentralClient({
    clientId: "client-1",
    clientSecret: "secret-1",
    tokenSet: { access_token: "old", expires_at: 0 }
  });

  await assert.rejects(
    () => client.startRingOut({ phone: "+19493745710", agentPhone: "+15555550100" }),
    (error) => {
      assert.equal(error.code, "ringcentral_reauth_required");
      assert.equal(error.status, 401);
      return true;
    }
  );
});

test("buildAuthorizationUrl creates RingCentral OAuth authorize URL", () => {
  const url = buildAuthorizationUrl({
    serverUrl: "https://platform.ringcentral.com",
    clientId: "client-1",
    redirectUri: "https://cti.askroi.link/oauth/ringcentral/callback",
    scopes: ["RingOut", "SMS", "VoIP Calling"],
    state: "state-1"
  });

  assert.equal(url.origin, "https://platform.ringcentral.com");
  assert.equal(url.pathname, "/restapi/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client-1");
  assert.equal(url.searchParams.get("redirect_uri"), "https://cti.askroi.link/oauth/ringcentral/callback");
  assert.equal(url.searchParams.has("scope"), false);
  assert.equal(url.searchParams.get("state"), "state-1");
});

test("exchangeAuthorizationCode exchanges code for token payload", async () => {
  const calls = [];
  const token = await exchangeAuthorizationCode({
    serverUrl: "https://platform.ringcentral.com",
    clientId: "client-1",
    clientSecret: "secret-1",
    code: "code-1",
    redirectUri: "https://cti.askroi.link/oauth/ringcentral/callback",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3600
        })
      };
    }
  });

  assert.equal(token.access_token, "access-1");
  assert.equal(calls[0].url, "https://platform.ringcentral.com/restapi/oauth/token");
  assert.equal(calls[0].options.body.get("grant_type"), "authorization_code");
  assert.equal(calls[0].options.body.get("code"), "code-1");
});

test("RingCentralClient refreshes OAuth tokens and persists updates", async () => {
  const saved = [];
  const client = new RingCentralClient({
    serverUrl: "https://platform.ringcentral.com",
    clientId: "client-1",
    clientSecret: "secret-1",
    tokenSet: {
      access_token: "old-access",
      refresh_token: "refresh-1",
      expires_at: 1
    },
    onTokenSet: async (tokenSet) => saved.push(tokenSet),
    fetchImpl: async (url, options) => {
      if (url.endsWith("/restapi/oauth/token")) {
        return {
          ok: true,
          json: async () => ({
            access_token: "new-access",
            refresh_token: "refresh-2",
            expires_in: 3600
          })
        };
      }

      return {
        ok: true,
        json: async () => ({ id: "ringout-1" })
      };
    }
  });

  const result = await client.startRingOut({
    phone: "+19493745710",
    agentPhone: "+15555550100"
  });

  assert.equal(result.id, "ringout-1");
  assert.equal(saved[0].access_token, "new-access");
  assert.equal(saved[0].refresh_token, "refresh-2");
});

test("RingCentralClient preserves agent session token during OAuth refresh", async () => {
  const saved = [];
  const client = new RingCentralClient({
    serverUrl: "https://platform.ringcentral.com",
    clientId: "client-1",
    clientSecret: "secret-1",
    tokenSet: {
      access_token: "old-access",
      refresh_token: "refresh-1",
      agent_session_token: "session-1",
      expires_at: 1
    },
    onTokenSet: async (tokenSet) => saved.push(tokenSet),
    fetchImpl: async (url) => {
      if (url.endsWith("/restapi/oauth/token")) {
        return {
          ok: true,
          json: async () => ({
            access_token: "new-access",
            refresh_token: "refresh-2",
            expires_in: 3600
          })
        };
      }

      return {
        ok: true,
        json: async () => ({ id: "ringout-1" })
      };
    }
  });

  await client.startRingOut({
    phone: "+19493745710",
    agentPhone: "+15555550100"
  });

  assert.equal(saved[0].agent_session_token, "session-1");
});

test("RingCentralClient polls and cancels RingOut sessions", async () => {
  const calls = [];
  const client = new RingCentralClient({
    serverUrl: "https://platform.ringcentral.com",
    clientId: "client-1",
    clientSecret: "secret-1",
    tokenSet: {
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_at: Date.now() + 3600000
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });

      if (options.method === "DELETE") {
        return {
          ok: true,
          status: 204,
          json: async () => ({})
        };
      }

      return {
        ok: true,
        json: async () => ({
          id: "ringout-1",
          status: {
            callStatus: "Success",
            callerStatus: "Success",
            calleeStatus: "Success"
          }
        })
      };
    }
  });

  const status = await client.getRingOutStatus("ringout-1");
  const cancel = await client.cancelRingOut("ringout-1");

  assert.equal(status.status.callStatus, "Success");
  assert.equal(cancel.ok, true);
  assert.equal(calls[0].url, "https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/ring-out/ringout-1");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[1].url, "https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/ring-out/ringout-1");
  assert.equal(calls[1].options.method, "DELETE");
});

test("RingCentralClient provisions Web Phone SIP info", async () => {
  const calls = [];
  const client = new RingCentralClient({
    serverUrl: "https://platform.ringcentral.com",
    clientId: "client-1",
    clientSecret: "secret-1",
    tokenSet: {
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_at: Date.now() + 3600000
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          device: { id: "device-1" },
          sipInfo: [{ username: "sip-user", authorizationId: "auth-1" }]
        })
      };
    }
  });

  const result = await client.createSipProvision();

  assert.equal(result.deviceId, "device-1");
  assert.equal(result.sipInfo.username, "sip-user");
  assert.equal(calls[0].url, "https://platform.ringcentral.com/restapi/v1.0/client-info/sip-provision");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    sipInfo: [{ transport: "WSS" }]
  });
});

test("RingCentralClient lists extension caller IDs", async () => {
  const calls = [];
  const client = new RingCentralClient({
    serverUrl: "https://platform.ringcentral.com",
    clientId: "client-1",
    clientSecret: "secret-1",
    tokenSet: {
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_at: Date.now() + 3600000
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          records: [
            {
              phoneNumber: "+15555550100",
              usageType: "DirectNumber",
              label: "Main DID"
            },
            {
              phoneNumber: "+15555550101",
              usageType: "CompanyNumber"
            },
            {
              phoneNumber: "",
              usageType: "Other"
            }
          ]
        })
      };
    }
  });

  const numbers = await client.listCallerIds();

  assert.deepEqual(numbers, [
    { phoneNumber: "+15555550100", label: "Main DID", usageType: "DirectNumber" },
    { phoneNumber: "+15555550101", label: "+15555550101", usageType: "CompanyNumber" }
  ]);
  assert.equal(calls[0].url, "https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/phone-number?perPage=100");
  assert.equal(calls[0].options.method, "GET");
});
