const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildExternalOutboundCallPayload,
  buildInboundMessagePayload,
  GhlClient,
  normalizeGhlCallStatus
} = require("../src/ghl");

test("buildExternalOutboundCallPayload includes outbound call metadata", () => {
  const payload = buildExternalOutboundCallPayload({
    contactId: "contact-1",
    conversationProviderId: "provider-call",
    to: "+19493745710",
    from: "+15555550100",
    agentName: "Mynor",
    callId: "ringout-1",
    disposition: "Connected",
    notes: "Good call",
    durationSeconds: 42,
    recordingUrl: "https://recordings.example/call.mp3",
    userId: "user-1",
    assignedTo: "user-1",
    occurredAt: "2026-06-02T12:00:00.000Z"
  });

  assert.equal(payload.type, "Call");
  assert.equal(payload.direction, "outbound");
  assert.equal(payload.contactId, "contact-1");
  assert.equal(payload.conversationProviderId, "provider-call");
  assert.equal(payload.call.to, "+19493745710");
  assert.equal(payload.call.recordingUrl, "https://recordings.example/call.mp3");
  assert.deepEqual(payload.attachments, ["https://recordings.example/call.mp3"]);
  assert.equal(payload.userId, "user-1");
  assert.equal(payload.assignedTo, "user-1");
  assert.equal(payload.call.status, "answered");
  assert.match(payload.message, /Connected/);
  assert.match(payload.message, /Good call/);
});

test("normalizeGhlCallStatus returns lowercase GHL call statuses", () => {
  assert.equal(normalizeGhlCallStatus("Connected"), "answered");
  assert.equal(normalizeGhlCallStatus("No Answer"), "no-answer");
  assert.equal(normalizeGhlCallStatus("Left Voicemail"), "voicemail");
  assert.equal(normalizeGhlCallStatus("Follow Up"), "completed");
});

test("buildExternalOutboundCallPayload maps business dispositions to valid GHL call statuses", () => {
  const cases = [
    ["Initiated", "pending"],
    ["Connected", "answered"],
    ["Appointment Set", "completed"],
    ["Sale Closed", "completed"],
    ["No Answer", "no-answer"],
    ["Left Voicemail", "voicemail"],
    ["Busy", "busy"],
    ["Canceled", "canceled"],
    ["Cancelled", "canceled"],
    ["Failed", "failed"]
  ];

  for (const [disposition, expectedStatus] of cases) {
    const payload = buildExternalOutboundCallPayload({
      contactId: "contact-1",
      conversationProviderId: "provider-call",
      to: "+19493745710",
      from: "+15555550100",
      callId: "ringout-1",
      disposition
    });

    assert.equal(payload.call.status, expectedStatus, disposition);
    assert.match(payload.metadata.disposition, new RegExp(disposition));
  }
});

test("buildExternalOutboundCallPayload omits empty attachments", () => {
  const payload = buildExternalOutboundCallPayload({
    contactId: "contact-1",
    conversationProviderId: "provider-call",
    to: "+19493745710",
    from: "+15555550100",
    agentName: "Mynor",
    callId: "ringout-1",
    disposition: "Initiated"
  });

  assert.equal(Object.hasOwn(payload, "attachments"), false);
});

test("buildInboundMessagePayload includes inbound SMS metadata", () => {
  const payload = buildInboundMessagePayload({
    contactId: "contact-1",
    conversationProviderId: "provider-sms",
    type: "SMS",
    direction: "inbound",
    from: "+19493745710",
    to: "+15555550100",
    message: "Hello",
    userId: "user-1",
    assignedTo: "user-1",
    occurredAt: "2026-06-02T12:00:00.000Z",
    sourceId: "sms-1"
  });

  assert.equal(payload.type, "SMS");
  assert.equal(payload.direction, "inbound");
  assert.equal(payload.contactId, "contact-1");
  assert.equal(payload.message, "Hello");
  assert.equal(payload.userId, "user-1");
  assert.equal(payload.assignedTo, "user-1");
  assert.equal(payload.sourceId, "sms-1");
});

test("buildInboundMessagePayload uses attachment URL strings for recordings", () => {
  const payload = buildInboundMessagePayload({
    contactId: "contact-1",
    conversationProviderId: "provider-call",
    type: "Call",
    direction: "inbound",
    from: "+19493745710",
    to: "+15555550100",
    message: "Inbound call",
    recordingUrl: "https://recordings.example/inbound.wav",
    sourceId: "call-1"
  });

  assert.deepEqual(payload.attachments, ["https://recordings.example/inbound.wav"]);
});

test("buildInboundMessagePayload omits empty attachments", () => {
  const payload = buildInboundMessagePayload({
    contactId: "contact-1",
    conversationProviderId: "provider-sms",
    type: "SMS",
    direction: "inbound",
    from: "+19493745710",
    to: "+15555550100",
    message: "Hello",
    sourceId: "sms-1"
  });

  assert.equal(Object.hasOwn(payload, "attachments"), false);
});

test("GhlClient finds contacts by normalized phone", async () => {
  const requests = [];
  const client = new GhlClient({
    tokenSet: { access_token: "token" },
    locationId: "loc-1",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () => ({ contacts: [{ id: "contact-1" }] })
      };
    }
  });

  const contact = await client.findContactByPhone("(949) 374-5710");

  assert.equal(contact.id, "contact-1");
  assert.match(requests[0].url, /contacts\/search\/duplicate/);
  assert.match(requests[0].url, /locationId=loc-1/);
  assert.match(requests[0].url, /number=%2B19493745710/);
  assert.equal(requests[0].options.headers.Version, "2023-02-21");
});

test("GhlClient assigns a contact owner", async () => {
  const requests = [];
  const client = new GhlClient({
    tokenSet: { access_token: "token" },
    locationId: "loc-1",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () => ({ contact: { id: "contact-1", assignedTo: "user-1" } })
      };
    }
  });

  const result = await client.assignContactOwner("contact-1", "user-1");

  assert.equal(result.contact.assignedTo, "user-1");
  assert.match(requests[0].url, /\/contacts\/contact-1$/);
  assert.equal(requests[0].options.method, "PUT");
  assert.deepEqual(JSON.parse(requests[0].options.body), { assignedTo: "user-1" });
});

test("GhlClient assigns a conversation owner", async () => {
  const requests = [];
  const client = new GhlClient({
    tokenSet: { access_token: "token" },
    locationId: "loc-1",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () => ({ id: "conversation-1", assignedTo: "user-1" })
      };
    }
  });

  const result = await client.assignConversationOwner("conversation-1", "user-1");

  assert.equal(result.assignedTo, "user-1");
  assert.match(requests[0].url, /\/conversations\/conversation-1$/);
  assert.equal(requests[0].options.method, "PUT");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    locationId: "loc-1",
    assignedTo: "user-1"
  });
});

test("GhlClient finds a location user by email", async () => {
  const requests = [];
  const client = new GhlClient({
    tokenSet: { access_token: "token" },
    locationId: "loc-1",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          users: [
            { id: "user-1", email: "other@example.com" },
            { id: "user-2", email: "agent@example.com" }
          ]
        })
      };
    }
  });

  const user = await client.findUserByEmail("agent@example.com", { companyId: "company-1" });

  assert.equal(user.id, "user-2");
  assert.match(requests[0].url, /\/users\/search\?/);
  assert.match(requests[0].url, /locationId=loc-1/);
  assert.match(requests[0].url, /companyId=company-1/);
});

test("GhlClient prefers account location user over agency user with the same email", async () => {
  const client = new GhlClient({
    tokenSet: { access_token: "token" },
    locationId: "loc-1",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        users: [
          {
            id: "agency-user-1",
            email: "agent@example.com",
            roles: { type: "agency" }
          },
          {
            id: "location-user-1",
            email: "agent@example.com",
            roles: {
              type: "account",
              locationIds: ["loc-1"]
            }
          }
        ]
      })
    })
  });

  const user = await client.findUserByEmail("agent@example.com");

  assert.equal(user.id, "location-user-1");
});

test("GhlClient refreshes expired HighLevel OAuth token and retries request", async () => {
  const requests = [];
  const persisted = [];
  const client = new GhlClient({
    locationId: "loc-1",
    tokenSet: {
      access_token: "expired-access",
      refresh_token: "refresh-1"
    },
    refreshToken: async (tokenSet) => {
      assert.equal(tokenSet.refresh_token, "refresh-1");
      return {
        access_token: "fresh-access",
        refresh_token: "refresh-2"
      };
    },
    onTokenSet: async (tokenSet) => {
      persisted.push(tokenSet);
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (requests.length === 1) {
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          json: async () => ({ message: "The token has expired" })
        };
      }
      return {
        ok: true,
        json: async () => ({ contact: { id: "contact-1" } })
      };
    }
  });

  const contact = await client.findContactByPhone("+19493745710");

  assert.equal(contact.id, "contact-1");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers.Authorization, "Bearer expired-access");
  assert.equal(requests[1].options.headers.Authorization, "Bearer fresh-access");
  assert.equal(persisted[0].refresh_token, "refresh-2");
});
