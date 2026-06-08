const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { createApp } = require("../src/server");

async function request(app, method, path, body, headers = {}) {
  const response = await app.handle({
    method,
    url: path,
    headers: { origin: "https://app.gohighlevel.com", ...headers },
    body
  });
  return response;
}

function evpBytesToKey(password, salt, keyLength, ivLength) {
  let material = Buffer.alloc(0);
  let previous = Buffer.alloc(0);

  while (material.length < keyLength + ivLength) {
    previous = crypto
      .createHash("md5")
      .update(Buffer.concat([previous, Buffer.from(password, "utf8"), salt]))
      .digest();
    material = Buffer.concat([material, previous]);
  }

  return {
    key: material.subarray(0, keyLength),
    iv: material.subarray(keyLength, keyLength + ivLength)
  };
}

function encryptHighLevelContext(value, secret) {
  const salt = Buffer.from("12345678", "utf8");
  const { key, iv } = evpBytesToKey(secret, salt, 32, 16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final()
  ]);

  return Buffer.concat([Buffer.from("Salted__", "utf8"), salt, encrypted]).toString("base64");
}

test("starts outbound call without logging GHL activity until disposition", async () => {
  const calls = [];
  const app = createApp({
    config: {
      brands: [{ key: "brand-a", ghl: {}, ringcentral: {} }]
    },
    tokenStore: {
      get: async () => ({ access_token: "access-1", agent_session_token: "session-1" }),
      set: async () => {}
    },
    getRingCentralClientForAgent: async () => ({
      startRingOut: async (payload) => {
        calls.push(["ringout", payload]);
        return { id: "ringout-1" };
      }
    }),
    createGhlClient: () => {
      throw new Error("GHL should not be called before disposition");
    }
  });

  const response = await request(app, "POST", "/api/extension/calls/start", {
    brandKey: "brand-a",
    phone: "(949) 374-5710",
    agentPhone: "+15555550100",
    agentName: "Mynor",
    agentKey: "agent@example.com"
  }, { "x-cti-agent-session": "session-1" });

  assert.equal(response.status, 200);
  assert.equal(response.body.ctiCallId, null);
  assert.equal(response.body.ringcentralRingoutId, "ringout-1");
  assert.equal(calls[0][0], "ringout");
  assert.equal(calls.length, 1);
});

test("returns outbound RingOut status for an active call", async () => {
  const calls = [];
  const app = createApp({
    config: {
      brands: [{ key: "brand-a", ghl: {}, ringcentral: {} }]
    },
    tokenStore: {
      get: async () => ({ access_token: "access-1", agent_session_token: "session-1" }),
      set: async () => {}
    },
    getRingCentralClientForAgent: async () => ({
      getRingOutStatus: async (ringoutId) => {
        calls.push(ringoutId);
        return {
          id: ringoutId,
          status: {
            callStatus: "Success",
            callerStatus: "Success",
            calleeStatus: "Success"
          }
        };
      }
    })
  });

  const response = await request(app, "POST", "/api/extension/calls/status", {
    brandKey: "brand-a",
    agentKey: "agent@example.com",
    ringcentralRingoutId: "ringout-1"
  }, { "x-cti-agent-session": "session-1" });

  assert.equal(response.status, 200);
  assert.equal(response.body.ringcentralRingoutId, "ringout-1");
  assert.equal(response.body.callStatus, "Success");
  assert.equal(response.body.callerStatus, "Success");
  assert.equal(response.body.calleeStatus, "Success");
  assert.deepEqual(calls, ["ringout-1"]);
});

test("cancels an outbound RingOut before it connects", async () => {
  const calls = [];
  const app = createApp({
    config: {
      brands: [{ key: "brand-a", ghl: {}, ringcentral: {} }]
    },
    tokenStore: {
      get: async () => ({ access_token: "access-1", agent_session_token: "session-1" }),
      set: async () => {}
    },
    getRingCentralClientForAgent: async () => ({
      cancelRingOut: async (ringoutId) => {
        calls.push(ringoutId);
        return { ok: true };
      }
    })
  });

  const response = await request(app, "POST", "/api/extension/calls/cancel", {
    brandKey: "brand-a",
    agentKey: "agent@example.com",
    ringcentralRingoutId: "ringout-1"
  }, { "x-cti-agent-session": "session-1" });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(calls, ["ringout-1"]);
});

test("returns Web Phone SIP info for an authenticated agent", async () => {
  const app = createApp({
    config: {
      brands: [{ key: "brand-a", ghl: {}, ringcentral: {} }]
    },
    tokenStore: {
      get: async () => ({ access_token: "access-1", agent_session_token: "session-1" }),
      set: async () => {}
    },
    getRingCentralClientForAgent: async () => ({
      createSipProvision: async () => ({
        deviceId: "device-1",
        sipInfo: {
          username: "sip-user",
          authorizationId: "auth-1"
        }
      })
    })
  });

  const response = await request(app, "POST", "/api/extension/webphone/sip-info", {
    brandKey: "brand-a",
    agentKey: "agent@example.com"
  }, { "x-cti-agent-session": "session-1" });

  assert.equal(response.status, 200);
  assert.equal(response.body.deviceId, "device-1");
  assert.equal(response.body.sipInfo.username, "sip-user");
});

test("returns RingCentral caller IDs for the active HighLevel user", async () => {
  const token = encryptHighLevelContext({
    userId: "ghl-user-1",
    activeLocation: "loc-1"
  }, "shared-secret-1");
  const calls = [];
  const app = createApp({
    config: {
      ghlApp: {
        id: "app-1",
        sharedSecret: "shared-secret-1"
      },
      defaults: {
        ghl: {},
        ringcentral: {}
      },
      locationOverrides: {
        "loc-1": {
          name: "Ault"
        }
      },
      brands: []
    },
    tokenStore: {
      get: async (brandKey, agentKey) => {
        calls.push(["token", brandKey, agentKey]);
        return { access_token: "access-1", agent_session_token: "session-1" };
      },
      set: async () => {}
    },
    getRingCentralClientForAgent: async (brand, brandKey, agentKey) => {
      calls.push(["rc-client", brandKey, agentKey]);
      return {
        listCallerIds: async () => [
          { phoneNumber: "+15555550100", label: "Main DID", usageType: "DirectNumber" }
        ]
      };
    }
  });

  const response = await request(app, "POST", "/api/extension/ringcentral/caller-ids", {
    locationId: "loc-1",
    ghlUserContextToken: token
  }, { "x-cti-agent-session": "session-1" });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.callerIds, [
    { phoneNumber: "+15555550100", label: "Main DID", usageType: "DirectNumber" }
  ]);
  assert.deepEqual(calls[0], ["token", "location:loc-1", "ghl-user-1"]);
  assert.deepEqual(calls[1], ["rc-client", "location:loc-1", "ghl-user-1"]);
});

test("logs outbound call activity after disposition", async () => {
  const calls = [];
  const app = createApp({
    config: {
      brands: [{ key: "brand-a", ghl: {}, ringcentral: {} }]
    },
    tokenStore: {
      get: async () => ({ access_token: "access-1", agent_session_token: "session-1" }),
      set: async () => {}
    },
    createGhlClient: () => ({
      findContactByPhone: async (phone) => {
        calls.push(["find-contact", phone]);
        return { id: "contact-1" };
      },
      addOutboundCall: async (payload) => {
        calls.push(["ghl-call", payload]);
        return { id: "message-1" };
      }
    })
  });

  const response = await request(app, "POST", "/api/extension/calls/disposition", {
    brandKey: "brand-a",
    phone: "(949) 374-5710",
    agentPhone: "+15555550100",
    agentName: "Mynor",
    agentKey: "agent@example.com",
    ringcentralRingoutId: "ringout-1",
    disposition: "No Answer",
    notes: "Left a note",
    durationSeconds: 42,
    completedAt: "2026-06-03T12:00:00.000Z"
  }, { "x-cti-agent-session": "session-1" });

  assert.equal(response.status, 200);
  assert.equal(response.body.messageId, "message-1");
  assert.equal(calls[0][0], "find-contact");
  assert.equal(calls[1][0], "ghl-call");
  assert.deepEqual(calls[1][1], {
    contactId: "contact-1",
    conversationProviderId: undefined,
    to: "(949) 374-5710",
    from: "+15555550100",
    agentName: "Mynor",
    callId: "ringout-1",
    pageUrl: undefined,
    disposition: "No Answer",
    notes: "Left a note",
    durationSeconds: 42,
    occurredAt: "2026-06-03T12:00:00.000Z"
  });
});

test("assigns GHL owner from brand agent mapping when logging a call disposition", async () => {
  const calls = [];
  let outboundPayload = null;
  const app = createApp({
    config: {
      brands: [{
        key: "brand-a",
        ghl: {},
        ringcentral: {},
        agents: {
          "agent@example.com": {
            ghlUserId: "user-1"
          }
        }
      }]
    },
    tokenStore: {
      get: async () => ({ access_token: "access-1", agent_session_token: "session-1" }),
      set: async () => {}
    },
    createGhlClient: () => ({
      findContactByPhone: async () => ({ id: "contact-1" }),
      addOutboundCall: async (payload) => {
        outboundPayload = payload;
        return { id: "message-1", conversationId: "conversation-1" };
      },
      assignContactOwner: async (contactId, assignedTo) => {
        calls.push(["assign-contact", contactId, assignedTo]);
        return { contact: { id: contactId, assignedTo } };
      },
      assignConversationOwner: async (conversationId, assignedTo) => {
        calls.push(["assign-conversation", conversationId, assignedTo]);
        return { id: conversationId, assignedTo };
      }
    })
  });

  const response = await request(app, "POST", "/api/extension/calls/disposition", {
    brandKey: "brand-a",
    phone: "+19493745710",
    agentPhone: "+15555550100",
    agentName: "Ryan",
    agentKey: "agent@example.com",
    disposition: "Connected"
  }, { "x-cti-agent-session": "session-1" });

  assert.equal(response.status, 200);
  assert.equal(response.body.messageId, "message-1");
  assert.equal(response.body.ownerAssignment.assignedTo, "user-1");
  assert.equal(outboundPayload.userId, "user-1");
  assert.equal(outboundPayload.assignedTo, "user-1");
  assert.deepEqual(calls, [
    ["assign-contact", "contact-1", "user-1"],
    ["assign-conversation", "conversation-1", "user-1"]
  ]);
});

test("uses matching location user for assignedTo while preserving context user as call actor", async () => {
  const token = encryptHighLevelContext({
    userId: "agency-user-1",
    userName: "Ryan Agency",
    email: "ryan@example.com",
    type: "agency",
    activeLocation: "loc-1"
  }, "shared-secret-1");
  const calls = [];
  let outboundPayload = null;
  const app = createApp({
    config: {
      ghlApp: {
        id: "app-1",
        sharedSecret: "shared-secret-1"
      },
      defaults: {
        ghl: {},
        ringcentral: {}
      },
      locationOverrides: {
        "loc-1": {
          name: "Ault"
        }
      },
      brands: []
    },
    tokenStore: {
      get: async () => ({ access_token: "access-1", agent_session_token: "session-1" }),
      set: async () => {}
    },
    createGhlClient: () => ({
      findContactByPhone: async () => ({ id: "contact-1" }),
      findUserByEmail: async (email) => {
        calls.push(["find-user", email]);
        return {
          id: "location-user-1",
          name: "Ryan Location",
          email
        };
      },
      addOutboundCall: async (payload) => {
        outboundPayload = payload;
        return { id: "message-1", conversationId: "conversation-1" };
      },
      assignContactOwner: async (contactId, assignedTo) => {
        calls.push(["assign-contact", contactId, assignedTo]);
        return { contact: { id: contactId, assignedTo } };
      },
      assignConversationOwner: async (conversationId, assignedTo) => {
        calls.push(["assign-conversation", conversationId, assignedTo]);
        return { id: conversationId, assignedTo };
      }
    })
  });

  const response = await request(app, "POST", "/api/extension/calls/disposition", {
    locationId: "loc-1",
    ghlUserContextToken: token,
    phone: "+19493745710",
    agentPhone: "+15555550100",
    disposition: "Connected"
  }, { "x-cti-agent-session": "session-1" });

  assert.equal(response.status, 200);
  assert.equal(outboundPayload.userId, "agency-user-1");
  assert.equal(outboundPayload.assignedTo, "location-user-1");
  assert.equal(response.body.ownerAssignment.assignedTo, "location-user-1");
  assert.equal(response.body.ownerAssignment.source, "ghl_location_user_email_lookup");
  assert.deepEqual(calls, [
    ["find-user", "ryan@example.com"],
    ["assign-contact", "contact-1", "location-user-1"],
    ["assign-conversation", "conversation-1", "location-user-1"]
  ]);
});

test("passes resolved GHL user into outbound SMS activity creation", async () => {
  let smsPayload = null;
  const app = createApp({
    config: {
      brands: [{
        key: "brand-a",
        ghl: {},
        ringcentral: {},
        agents: {
          "agent@example.com": {
            ghlUserId: "user-1"
          }
        }
      }]
    },
    tokenStore: {
      get: async () => ({ access_token: "access-1", agent_session_token: "session-1" }),
      set: async () => {}
    },
    getRingCentralClientForAgent: async () => ({
      sendSms: async () => ({ id: "sms-1" })
    }),
    createGhlClient: () => ({
      findContactByPhone: async () => ({ id: "contact-1" }),
      findUserByEmail: async () => null,
      addInboundMessage: async (payload) => {
        smsPayload = payload;
        return { id: "message-1", conversationId: "conversation-1" };
      },
      assignContactOwner: async () => ({}),
      assignConversationOwner: async () => ({})
    })
  });

  const response = await request(app, "POST", "/api/extension/sms/send", {
    brandKey: "brand-a",
    from: "+15555550100",
    to: "+19493745710",
    message: "Hello",
    agentName: "Ryan",
    agentKey: "agent@example.com"
  }, { "x-cti-agent-session": "session-1" });

  assert.equal(response.status, 200);
  assert.equal(smsPayload.userId, "user-1");
  assert.equal(smsPayload.assignedTo, "user-1");
});

test("keeps call logging successful when GHL owner assignment fails", async () => {
  const app = createApp({
    config: {
      brands: [{
        key: "brand-a",
        ghl: {},
        ringcentral: {},
        agents: {
          "agent@example.com": {
            ghlUserId: "user-1"
          }
        }
      }]
    },
    tokenStore: {
      get: async () => ({ access_token: "access-1", agent_session_token: "session-1" }),
      set: async () => {}
    },
    createGhlClient: () => ({
      findContactByPhone: async () => ({ id: "contact-1" }),
      addOutboundCall: async () => ({ id: "message-1", conversationId: "conversation-1" }),
      assignContactOwner: async () => {
        throw new Error("GHL 401: missing contacts.write");
      },
      assignConversationOwner: async () => {
        throw new Error("GHL 400: unsupported body");
      }
    })
  });

  const response = await request(app, "POST", "/api/extension/calls/disposition", {
    brandKey: "brand-a",
    phone: "+19493745710",
    agentPhone: "+15555550100",
    agentName: "Ryan",
    agentKey: "agent@example.com",
    disposition: "Connected"
  }, { "x-cti-agent-session": "session-1" });

  assert.equal(response.status, 200);
  assert.equal(response.body.messageId, "message-1");
  assert.equal(response.body.ownerAssignment.assignedTo, "user-1");
  assert.equal(response.body.ownerAssignment.contactAssigned, false);
  assert.equal(response.body.ownerAssignment.conversationAssigned, false);
  assert.equal(response.body.ownerAssignment.errors.length, 2);
});

test("falls back to mapped owner when HighLevel user context cannot be decrypted", async () => {
  const calls = [];
  const app = createApp({
    config: {
      ghlApp: {
        sharedSecret: "shared-secret-1"
      },
      brands: [{
        key: "brand-a",
        ghl: {},
        ringcentral: {},
        agents: {
          "agent@example.com": {
            ghlUserId: "mapped-user-1"
          }
        }
      }]
    },
    tokenStore: {
      get: async () => ({ access_token: "access-1", agent_session_token: "session-1" }),
      set: async () => {}
    },
    createGhlClient: () => ({
      findContactByPhone: async () => ({ id: "contact-1" }),
      addOutboundCall: async () => ({ id: "message-1" }),
      assignContactOwner: async (contactId, assignedTo) => {
        calls.push(["assign-contact", contactId, assignedTo]);
        return { contact: { id: contactId, assignedTo } };
      }
    })
  });

  const response = await request(app, "POST", "/api/extension/calls/disposition", {
    brandKey: "brand-a",
    phone: "+19493745710",
    agentPhone: "+15555550100",
    agentName: "Ryan",
    agentKey: "agent@example.com",
    disposition: "Connected",
    ghlUserContextToken: "not-a-valid-context-token"
  }, { "x-cti-agent-session": "session-1" });

  assert.equal(response.status, 200);
  assert.equal(response.body.ownerAssignment.assignedTo, "mapped-user-1");
  assert.deepEqual(calls, [["assign-contact", "contact-1", "mapped-user-1"]]);
});

test("falls back to looking up GHL user by agent email for owner assignment", async () => {
  const calls = [];
  const app = createApp({
    config: {
      brands: [{
        key: "brand-a",
        agents: {},
        ghl: {},
        ringcentral: {}
      }]
    },
    tokenStore: {
      get: async () => ({ access_token: "access-1", agent_session_token: "session-1" }),
      set: async () => {}
    },
    createGhlClient: () => ({
      findContactByPhone: async () => ({ id: "contact-1" }),
      addOutboundCall: async () => ({ id: "message-1", conversationId: "conversation-1" }),
      findUserByEmail: async (email) => {
        calls.push(["find-user", email]);
        return { id: "user-from-email" };
      },
      assignContactOwner: async (contactId, assignedTo) => {
        calls.push(["assign-contact", contactId, assignedTo]);
        return { contact: { id: contactId, assignedTo } };
      },
      assignConversationOwner: async (conversationId, assignedTo) => {
        calls.push(["assign-conversation", conversationId, assignedTo]);
        return { id: conversationId, assignedTo };
      }
    })
  });

  const response = await request(app, "POST", "/api/extension/calls/disposition", {
    brandKey: "brand-a",
    agentKey: "agent@example.com",
    phone: "+19493745710",
    agentPhone: "+15555550100",
    disposition: "Completed"
  }, { "x-cti-agent-session": "session-1" });

  assert.equal(response.status, 200);
  assert.equal(response.body.ownerAssignment.assignedTo, "user-from-email");
  assert.equal(response.body.ownerAssignment.source, "ghl_user_email_lookup");
  assert.deepEqual(calls, [
    ["find-user", "agent@example.com"],
    ["assign-contact", "contact-1", "user-from-email"],
    ["assign-conversation", "conversation-1", "user-from-email"]
  ]);
});

test("allows configured wildcard GHL origins", async () => {
  const app = createApp({
    config: {
      corsOrigins: ["https://*.gohighlevel.com"],
      brands: []
    }
  });

  const response = await request(app, "GET", "/health");

  assert.equal(response.status, 200);
  assert.equal(response.headers["Access-Control-Allow-Origin"], "https://app.gohighlevel.com");
});

test("returns configured disposition options for a brand", async () => {
  const app = createApp({
    config: {
      brands: [{
        key: "brand-a",
        dispositions: ["Connected", "Needs Review"],
        ghl: {},
        ringcentral: {}
      }]
    }
  });

  const response = await request(app, "GET", "/api/extension/dispositions?brandKey=brand-a");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.dispositions, ["Connected", "Needs Review"]);
});

test("returns default disposition options when a brand has none configured", async () => {
  const app = createApp({
    config: {
      brands: [{ key: "brand-a", ghl: {}, ringcentral: {} }]
    }
  });

  const response = await request(app, "GET", "/api/extension/dispositions?brandKey=brand-a");

  assert.equal(response.status, 200);
  assert.ok(response.body.dispositions.includes("Connected"));
  assert.ok(response.body.dispositions.includes("Completed"));
  assert.ok(response.body.dispositions.includes("Busy"));
  assert.ok(response.body.dispositions.includes("No Answer"));
  assert.ok(response.body.dispositions.includes("Failed"));
  assert.equal(response.body.dispositions.includes("Appointment Set"), false);
});

test("verifies HighLevel external auth test requests", async () => {
  const app = createApp({
    config: {
      corsOrigins: ["https://*.gohighlevel.com"],
      brands: []
    }
  });

  const getResponse = await request(app, "GET", "/external-auth/verify?installKey=random", null);
  const postResponse = await request(app, "POST", "/external-auth/verify", {
    installKey: "random",
    locationId: ["loc-1"],
    approveAllLocations: false
  });

  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.body.ok, true);
  assert.equal(getResponse.body.authenticated, true);
  assert.equal(getResponse.body.service, "ringcentral-ghl-cti");

  assert.equal(postResponse.status, 200);
  assert.equal(postResponse.body.ok, true);
  assert.equal(postResponse.body.authenticated, true);
});

test("logs inbound RingCentral SMS webhook to GHL", async () => {
  const calls = [];
  const app = createApp({
    config: {
      brands: [{ key: "brand-a", ghl: {}, ringcentral: {} }]
    },
    createRingCentralClient: () => ({}),
    createGhlClient: () => ({
      findContactByPhone: async () => ({ id: "contact-1" }),
      addInboundMessage: async (payload) => {
        calls.push(payload);
        return { id: "message-1" };
      }
    })
  });

  const response = await request(app, "POST", "/webhooks/ringcentral/brand-a", {
    event: "/restapi/v1.0/account/~/extension/~/message-store",
    body: {
      type: "SMS",
      direction: "Inbound",
      from: { phoneNumber: "+19493745710" },
      to: [{ phoneNumber: "+15555550100" }],
      subject: "Hello from RC",
      id: "sms-1"
    }
  });

  assert.equal(response.status, 200);
  assert.equal(calls[0].type, "SMS");
  assert.equal(calls[0].direction, "inbound");
  assert.equal(calls[0].message, "Hello from RC");
});

test("returns RingCentral OAuth start URL for an agent", async () => {
  const app = createApp({
    config: {
      publicBaseUrl: "https://cti.askroi.link",
      brands: [{
        key: "brand-a",
        ringcentral: {
          serverUrl: "https://platform.ringcentral.com",
          clientId: "client-1",
          clientSecret: "secret-1",
          scopes: ["RingOut", "SMS"]
        }
      }]
    },
    tokenStore: {
      setAuthSession: async () => {},
      getAuthSession: async () => null,
      get: async () => null,
      set: async () => {}
    }
  });

  const response = await request(
    app,
    "GET",
    "/oauth/ringcentral/start?brandKey=brand-a&agentKey=agent%40example.com",
    null
  );

  assert.equal(response.status, 200);
  assert.match(response.body.authorizationUrl, /^https:\/\/platform\.ringcentral\.com\/restapi\/oauth\/authorize/);
  assert.ok(response.body.authSessionId);
});

test("returns RingCentral OAuth start URL for an active HighLevel location", async () => {
  const storedSessions = [];
  const app = createApp({
    config: {
      publicBaseUrl: "https://cti.askroi.link",
      defaults: {
        ringcentral: {
          serverUrl: "https://platform.ringcentral.com",
          clientId: "client-default",
          clientSecret: "secret-default",
          scopes: ["RingOut", "SMS"]
        }
      },
      locationOverrides: {
        "loc-1": {
          name: "Ault"
        }
      },
      brands: []
    },
    tokenStore: {
      setAuthSession: async (authSessionId, session) => storedSessions.push({ authSessionId, session }),
      getAuthSession: async () => null,
      get: async () => null,
      set: async () => {}
    }
  });

  const response = await request(
    app,
    "GET",
    "/oauth/ringcentral/start?locationId=loc-1&agentKey=agent%40example.com",
    null
  );

  assert.equal(response.status, 200);
  assert.match(response.body.authorizationUrl, /client_id=client-default/);
  assert.equal(storedSessions[0].session.brandKey, "location:loc-1");
  assert.equal(storedSessions[0].session.locationId, "loc-1");
});

test("RingCentral OAuth start rejects missing agent state", async () => {
  const app = createApp({
    config: {
      publicBaseUrl: "https://cti.askroi.link",
      defaults: {
        ringcentral: {
          serverUrl: "https://platform.ringcentral.com",
          clientId: "client-default",
          clientSecret: "secret-default",
          scopes: ["RingOut", "SMS"]
        }
      },
      locationOverrides: {
        "loc-1": {
          name: "Ault"
        }
      },
      brands: []
    },
    tokenStore: {
      setAuthSession: async () => {
        throw new Error("auth session should not be created without an agent");
      }
    }
  });

  const response = await request(app, "GET", "/oauth/ringcentral/start?locationId=loc-1", null);

  assert.equal(response.status, 400);
  assert.equal(response.body.error, "missing_agent_state");
  assert.match(response.body.message, /signed-in HighLevel user/);
});

test("RingCentral OAuth callback reports RingCentral authorization errors", async () => {
  const app = createApp({
    config: {
      publicBaseUrl: "https://cti.askroi.link",
      brands: []
    }
  });

  const response = await request(
    app,
    "GET",
    "/oauth/ringcentral/callback?error=access_denied&error_description=User%20cancelled",
    null
  );

  assert.equal(response.status, 400);
  assert.equal(response.body.error, "ringcentral_oauth_error");
  assert.match(response.body.message, /User cancelled/);
});

test("RingCentral OAuth callback rejects missing auth state cleanly", async () => {
  const app = createApp({
    config: {
      publicBaseUrl: "https://cti.askroi.link",
      brands: []
    }
  });

  const response = await request(app, "GET", "/oauth/ringcentral/callback?code=rc-code-1", null);

  assert.equal(response.status, 400);
  assert.equal(response.body.error, "missing_agent_state");
  assert.match(response.body.message, /extension popup/);
});

test("RingCentral OAuth callback can recover agent state from auth session", async () => {
  const state = Buffer.from(JSON.stringify({
    locationId: "loc-1",
    authSessionId: "auth-session-1"
  }), "utf8").toString("base64url");
  const storedTokens = [];
  const storedSessions = [];
  const app = createApp({
    config: {
      publicBaseUrl: "https://cti.askroi.link",
      defaults: {
        ringcentral: {
          serverUrl: "https://platform.ringcentral.com",
          clientId: "client-default",
          clientSecret: "secret-default",
          scopes: ["RingOut", "SMS"]
        }
      },
      locationOverrides: {
        "loc-1": {
          name: "Ault"
        }
      },
      brands: []
    },
    tokenStore: {
      getAuthSession: async (authSessionId) => authSessionId === "auth-session-1"
        ? {
            brandKey: "location:loc-1",
            locationId: "loc-1",
            agentKey: "agent@example.com",
            connected: false
          }
        : null,
      setAuthSession: async (authSessionId, session) => storedSessions.push({ authSessionId, session }),
      set: async (brandKey, agentKey, tokenSet) => storedTokens.push({ brandKey, agentKey, tokenSet })
    },
    exchangeRingCentralAuthorizationCode: async (input) => {
      assert.equal(input.code, "rc-code-1");
      assert.equal(input.redirectUri, "https://cti.askroi.link/oauth/ringcentral/callback");
      return { access_token: "rc-access", refresh_token: "rc-refresh" };
    }
  });

  const response = await request(
    app,
    "GET",
    `/oauth/ringcentral/callback?code=rc-code-1&state=${encodeURIComponent(state)}`,
    null
  );

  assert.equal(response.status, 200);
  assert.deepEqual(storedTokens, [{
    brandKey: "location:loc-1",
    agentKey: "agent@example.com",
    tokenSet: {
      access_token: "rc-access",
      refresh_token: "rc-refresh",
      agent_session_token: storedTokens[0].tokenSet.agent_session_token
    }
  }]);
  assert.equal(storedSessions[0].authSessionId, "auth-session-1");
  assert.equal(storedSessions[0].session.connected, true);
});

test("bootstraps extension settings from HighLevel active location", async () => {
  const token = encryptHighLevelContext({
    userId: "user-1",
    userName: "Ryan",
    email: "agent@example.com",
    activeLocation: "loc-1"
  }, "shared-secret-1");

  const app = createApp({
    config: {
      ghlApp: {
        id: "app-1",
        sharedSecret: "shared-secret-1"
      },
      defaults: {
        dispositions: ["Connected", "No Answer"],
        ghl: {
          callConversationProviderId: "call-provider-default"
        },
        ringcentral: {}
      },
      locationOverrides: {
        "loc-1": {
          name: "Ault"
        }
      },
      brands: []
    },
    tokenStore: {
      get: async (brandKey, agentKey) => {
        assert.equal(brandKey, "location:loc-1");
        assert.equal(agentKey, "user-1");
        return { access_token: "rc-access", agent_session_token: "session-1" };
      },
      getGhlToken: async (brandKey) => {
        assert.equal(brandKey, "location:loc-1");
        return { access_token: "ghl-access" };
      },
      getInstalledLocation: async (locationId) => ({
        locationId,
        name: "Ault Installed"
      })
    }
  });

  const response = await request(
    app,
    "POST",
    "/api/extension/bootstrap",
    { agentKey: "agent@example.com", ghlUserContextToken: token },
    { "x-cti-agent-session": "session-1" }
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.locationId, "loc-1");
  assert.equal(response.body.locationKey, "location:loc-1");
  assert.equal(response.body.locationName, "Ault");
  assert.equal(response.body.agentKey, "user-1");
  assert.equal(response.body.user.id, "user-1");
  assert.equal(response.body.user.name, "Ryan");
  assert.equal(response.body.user.email, "agent@example.com");
  assert.equal(response.body.highLevelConnected, true);
  assert.equal(response.body.ringcentralConnected, true);
  assert.equal(response.body.agentSessionValid, true);
  assert.deepEqual(response.body.dispositions, ["Connected", "No Answer"]);
});

test("bootstraps RingCentral connection by HighLevel user id without a manual agent key", async () => {
  const token = encryptHighLevelContext({
    userId: "ghl-user-1",
    userName: "Ryan",
    email: "ryan@example.com",
    activeLocation: "loc-1"
  }, "shared-secret-1");

  const app = createApp({
    config: {
      ghlApp: {
        id: "app-1",
        sharedSecret: "shared-secret-1"
      },
      defaults: {
        ghl: {},
        ringcentral: {}
      },
      locationOverrides: {
        "loc-1": {
          name: "Ault"
        }
      },
      brands: []
    },
    tokenStore: {
      get: async (brandKey, agentKey) => {
        assert.equal(brandKey, "location:loc-1");
        assert.equal(agentKey, "ghl-user-1");
        return { access_token: "rc-access", agent_session_token: "session-1" };
      },
      getGhlToken: async () => null,
      getInstalledLocation: async () => null
    }
  });

  const response = await request(
    app,
    "POST",
    "/api/extension/bootstrap",
    { ghlUserContextToken: token },
    { "x-cti-agent-session": "session-1" }
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.agentKey, "ghl-user-1");
  assert.equal(response.body.ringcentralConnected, true);
  assert.equal(response.body.agentSessionValid, true);
});

test("starts RingOut using the HighLevel user id instead of a stale manual agent key", async () => {
  const token = encryptHighLevelContext({
    userId: "ghl-user-1",
    userName: "Ryan",
    email: "ryan@example.com",
    activeLocation: "loc-1"
  }, "shared-secret-1");
  const calls = [];

  const app = createApp({
    config: {
      ghlApp: {
        id: "app-1",
        sharedSecret: "shared-secret-1"
      },
      defaults: {
        ghl: {},
        ringcentral: {}
      },
      locationOverrides: {
        "loc-1": {
          name: "Ault"
        }
      },
      brands: []
    },
    tokenStore: {
      get: async (brandKey, agentKey) => {
        calls.push(["token", brandKey, agentKey]);
        return { access_token: "rc-access", agent_session_token: "session-1" };
      },
      set: async () => {}
    },
    getRingCentralClientForAgent: async (brand, brandKey, agentKey) => {
      calls.push(["rc-client", brandKey, agentKey]);
      return {
        startRingOut: async (payload) => {
          calls.push(["ringout", payload]);
          return { id: "ringout-1" };
        }
      };
    }
  });

  const response = await request(app, "POST", "/api/extension/calls/start", {
    locationId: "loc-1",
    ghlUserContextToken: token,
    agentKey: "stale@example.com",
    agentPhone: "+15555550100",
    phone: "+19493745710"
  }, { "x-cti-agent-session": "session-1" });

  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], ["token", "location:loc-1", "ghl-user-1"]);
  assert.deepEqual(calls[1], ["rc-client", "location:loc-1", "ghl-user-1"]);
});

test("bootstrapping prefers current HighLevel context over stored location id", async () => {
  const token = encryptHighLevelContext({
    userId: "user-2",
    activeLocation: "loc-2"
  }, "shared-secret-1");

  const app = createApp({
    config: {
      ghlApp: {
        id: "app-1",
        sharedSecret: "shared-secret-1"
      },
      defaults: {
        ghl: {},
        ringcentral: {}
      },
      brands: []
    },
    tokenStore: {
      get: async (brandKey) => {
        assert.equal(brandKey, "location:loc-2");
        return null;
      },
      getGhlToken: async (brandKey) => {
        assert.equal(brandKey, "location:loc-2");
        return { access_token: "ghl-access" };
      },
      getInstalledLocation: async () => null
    }
  });

  const response = await request(
    app,
    "POST",
    "/api/extension/bootstrap",
    { locationId: "loc-1", agentKey: "agent@example.com", ghlUserContextToken: token }
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.locationId, "loc-2");
  assert.equal(response.body.locationKey, "location:loc-2");
});

test("validates extension settings and RingCentral connection status", async () => {
  const app = createApp({
    config: {
      brands: [{
        key: "brand-a",
        name: "Brand A",
        ghl: {},
        ringcentral: {}
      }]
    },
    tokenStore: {
      get: async (brandKey, agentKey) => {
        if (brandKey === "brand-a" && agentKey === "agent@example.com") {
          return { access_token: "access-1", agent_session_token: "session-1" };
        }
        return null;
      },
      set: async () => {}
    }
  });

  const connected = await request(
    app,
    "POST",
    "/api/extension/settings/validate",
    { brandKey: "brand-a", agentKey: "agent@example.com" },
    { "x-cti-agent-session": "session-1" }
  );
  const notConnected = await request(
    app,
    "POST",
    "/api/extension/settings/validate",
    { brandKey: "brand-a", agentKey: "missing@example.com" },
    { "x-cti-agent-session": "session-1" }
  );

  assert.equal(connected.status, 200);
  assert.equal(connected.body.ok, true);
  assert.equal(connected.body.brandName, "Brand A");
  assert.equal(connected.body.ringcentralConnected, true);
  assert.equal(connected.body.agentSessionValid, true);

  assert.equal(notConnected.status, 200);
  assert.equal(notConnected.body.ringcentralConnected, false);
  assert.equal(notConnected.body.agentSessionValid, false);
});

test("HighLevel OAuth callback stores token for matching brand location", async () => {
  const stored = [];
  const app = createApp({
    config: {
      publicBaseUrl: "https://cti.askroi.link",
      ghlOAuth: {
        clientId: "ghl-client-1",
        clientSecret: "ghl-secret-1",
        userType: "Location"
      },
      brands: [{
        key: "brand-a",
        ghl: {
          locationId: "loc-1"
        }
      }]
    },
    tokenStore: {
      setGhlToken: async (brandKey, tokenSet) => stored.push({ brandKey, tokenSet }),
      getGhlToken: async () => null,
      get: async () => null,
      set: async () => {}
    },
    exchangeHighLevelAuthorizationCode: async (input) => {
      assert.equal(input.clientId, "ghl-client-1");
      assert.equal(input.clientSecret, "ghl-secret-1");
      assert.equal(input.code, "code-1");
      assert.equal(input.redirectUri, "https://cti.askroi.link/oauth/callback");
      return {
        access_token: "ghl-access-1",
        refresh_token: "ghl-refresh-1",
        locationId: "loc-1"
      };
    }
  });

  const response = await request(app, "GET", "/oauth/callback?code=code-1", null);

  assert.equal(response.status, 200);
  assert.equal(stored[0].brandKey, "brand-a");
  assert.equal(stored[0].tokenSet.access_token, "ghl-access-1");
  assert.equal(stored[0].tokenSet.locationId, "loc-1");
});

test("HighLevel OAuth callback stores agency token when no location is returned", async () => {
  const storedAgencyTokens = [];
  const app = createApp({
    config: {
      publicBaseUrl: "https://cti.askroi.link",
      ghlOAuth: {
        clientId: "ghl-client-1",
        clientSecret: "ghl-secret-1",
        userType: "Location"
      },
      brands: [{
        key: "brand-a",
        ghl: { locationId: "loc-1" }
      }]
    },
    tokenStore: {
      setGhlAgencyToken: async (companyId, tokenSet) => storedAgencyTokens.push({ companyId, tokenSet }),
      setGhlToken: async () => {
        throw new Error("should not store a brand token without a location");
      },
      getGhlToken: async () => null,
      get: async () => null,
      set: async () => {}
    },
    exchangeHighLevelAuthorizationCode: async () => ({
      access_token: "agency-access-1",
      refresh_token: "agency-refresh-1",
      companyId: "company-1",
      userType: "Company"
    })
  });

  const response = await request(app, "GET", "/oauth/callback?code=company-code-1", null);

  assert.equal(response.status, 200);
  assert.match(response.body, /HighLevel agency connected/);
  assert.equal(storedAgencyTokens[0].companyId, "company-1");
  assert.equal(storedAgencyTokens[0].tokenSet.access_token, "agency-access-1");
});

test("HighLevel app install webhook exchanges agency token for location token", async () => {
  const stored = [];
  const app = createApp({
    config: {
      ghlOAuth: {},
      brands: [{
        key: "brand-a",
        ghl: { locationId: "loc-1" }
      }]
    },
    tokenStore: {
      getGhlAgencyToken: async (companyId) => {
        assert.equal(companyId, "company-1");
        return {
          access_token: "agency-access-1",
          refresh_token: "agency-refresh-1",
          companyId: "company-1"
        };
      },
      setGhlToken: async (brandKey, tokenSet) => stored.push({ brandKey, tokenSet }),
      getGhlToken: async () => null,
      get: async () => null,
      set: async () => {}
    },
    getHighLevelLocationToken: async (input) => {
      assert.equal(input.companyId, "company-1");
      assert.equal(input.locationId, "loc-1");
      assert.equal(input.accessToken, "agency-access-1");
      return {
        access_token: "location-access-1",
        refresh_token: "location-refresh-1",
        locationId: "loc-1"
      };
    }
  });

  const response = await request(app, "POST", "/webhooks/highlevel/install", {
    type: "INSTALL",
    companyId: "company-1",
    locationId: "loc-1"
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.brandKey, "brand-a");
  assert.equal(stored[0].brandKey, "brand-a");
  assert.equal(stored[0].tokenSet.access_token, "location-access-1");
  assert.equal(stored[0].tokenSet.locationId, "loc-1");
});

test("HighLevel app install webhook stores unconfigured locations automatically", async () => {
  const storedTokens = [];
  const installedLocations = [];
  const app = createApp({
    config: {
      ghlOAuth: {
        clientId: "ghl-client-1",
        clientSecret: "ghl-secret-1"
      },
      defaults: {
        ghl: {
          callConversationProviderId: "call-provider-default"
        }
      },
      brands: []
    },
    tokenStore: {
      getGhlAgencyToken: async (companyId) => {
        assert.equal(companyId, "company-1");
        return {
          access_token: "agency-access-1",
          refresh_token: "agency-refresh-1",
          companyId: "company-1"
        };
      },
      setGhlToken: async (brandKey, tokenSet) => storedTokens.push({ brandKey, tokenSet }),
      setInstalledLocation: async (locationId, location) => installedLocations.push({ locationId, location }),
      getGhlToken: async () => null,
      get: async () => null,
      set: async () => {}
    },
    getHighLevelLocationToken: async (input) => {
      assert.equal(input.companyId, "company-1");
      assert.equal(input.locationId, "loc-2");
      assert.equal(input.accessToken, "agency-access-1");
      assert.equal(input.clientId, "ghl-client-1");
      return {
        access_token: "location-access-2",
        refresh_token: "location-refresh-2",
        locationId: "loc-2"
      };
    }
  });

  const response = await request(app, "POST", "/webhooks/highlevel/install", {
    type: "INSTALL",
    companyId: "company-1",
    locationId: "loc-2",
    locationName: "Ault Blockchain"
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.locationKey, "location:loc-2");
  assert.equal(storedTokens[0].brandKey, "location:loc-2");
  assert.equal(storedTokens[0].tokenSet.access_token, "location-access-2");
  assert.equal(installedLocations[0].locationId, "loc-2");
  assert.equal(installedLocations[0].location.name, "Ault Blockchain");
});
