const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const {
  getRuntimeConfigIssues,
  loadConfigFromEnv,
  getBrandProfile,
  getLocationProfile,
  validateRuntimeConfig
} = require("../src/config");
const { normalizePhone } = require("../src/phone");

function writeConfigFile(value) {
  const dir = mkdtempSync(path.join(tmpdir(), "cti-config-"));
  const filePath = path.join(dir, "app-config.json");
  writeFileSync(filePath, JSON.stringify(value), "utf8");
  return filePath;
}

test("loads app config from APP_CONFIG_PATH and secrets from env", () => {
  const config = loadConfigFromEnv({
    PORT: "4545",
    PUBLIC_BASE_URL: "https://cti.askroi.link",
    TOKEN_STORE_PATH: "/data/tokens.json",
    GHL_OAUTH_CLIENT_ID: "ghl-client",
    GHL_OAUTH_CLIENT_SECRET: "ghl-secret",
    GHL_APP_ID: "ghl-app-1",
    GHL_APP_SHARED_SECRET: "shared-secret-1",
    RINGCENTRAL_CLIENT_ID: "rc-client-env",
    RINGCENTRAL_CLIENT_SECRET: "rc-secret-env",
    RINGCENTRAL_EXTENSION_ID: "101",
    APP_CONFIG_PATH: writeConfigFile({
      defaults: {
        ghl: {
          callConversationProviderId: "call-provider-default",
          smsConversationProviderId: "sms-provider-default"
        }
      },
      brands: [
        {
          key: "brand-a",
          name: "Brand A",
          ghl: {
            locationId: "loc-1",
            conversationProviderId: "provider-1"
          },
          ringcentral: {
            serverUrl: "https://platform.ringcentral.com"
          }
        }
      ]
    })
  });

  assert.equal(config.port, 4545);
  assert.equal(config.publicBaseUrl, "https://cti.askroi.link");
  assert.equal(config.tokenStorePath, "/data/tokens.json");
  assert.equal(config.ghlOAuth.clientId, "ghl-client");
  assert.equal(config.ghlOAuth.clientSecret, "ghl-secret");
  assert.equal(config.ghlOAuth.userType, "Location");
  assert.equal(config.ghlApp.id, "ghl-app-1");
  assert.equal(config.ghlApp.sharedSecret, "shared-secret-1");
  assert.equal(config.defaults.ringcentral.clientId, "rc-client-env");
  assert.equal(config.defaults.ringcentral.clientSecret, "rc-secret-env");
  assert.equal(config.defaults.ringcentral.extensionId, "101");
  assert.equal(config.brands[0].key, "brand-a");
  assert.equal(config.brands[0].ghl.locationId, "loc-1");
  assert.equal(config.brands[0].ringcentral.clientId, undefined);
});

test("loads defaults and location overrides from APP_CONFIG_PATH", () => {
  const config = loadConfigFromEnv({
    RINGCENTRAL_CLIENT_ID: "rc-client-env",
    RINGCENTRAL_CLIENT_SECRET: "rc-secret-env",
    APP_CONFIG_PATH: writeConfigFile({
      defaults: {
        dispositions: ["Connected", "No Answer"],
        ghl: {
          callConversationProviderId: "call-provider-default",
          smsConversationProviderId: "sms-provider-default"
        },
        ringcentral: {
          serverUrl: "https://platform.ringcentral.com"
        }
      },
      locations: {
        "loc-1": {
          name: "Ault",
          dispositions: ["Connected"],
          ringcentral: {
            extensionId: "202"
          }
        }
      }
    })
  });

  const profile = getLocationProfile(config, "loc-1");

  assert.equal(profile.key, "location:loc-1");
  assert.equal(profile.name, "Ault");
  assert.equal(profile.ghl.locationId, "loc-1");
  assert.equal(profile.ghl.callConversationProviderId, "call-provider-default");
  assert.equal(profile.ringcentral.serverUrl, "https://platform.ringcentral.com");
  assert.equal(profile.ringcentral.clientId, "rc-client-env");
  assert.equal(profile.ringcentral.clientSecret, "rc-secret-env");
  assert.equal(profile.ringcentral.extensionId, "202");
  assert.deepEqual(profile.dispositions, ["Connected"]);
});

test("validateRuntimeConfig accepts complete production config", () => {
  const config = loadConfigFromEnv({
    PUBLIC_BASE_URL: "https://cti.askroi.link",
    GHL_OAUTH_CLIENT_ID: "ghl-client",
    GHL_OAUTH_CLIENT_SECRET: "ghl-secret",
    GHL_APP_ID: "ghl-app-1",
    GHL_APP_SHARED_SECRET: "shared-secret-1",
    RINGCENTRAL_CLIENT_ID: "rc-client",
    RINGCENTRAL_CLIENT_SECRET: "rc-secret",
    APP_CONFIG_PATH: writeConfigFile({
      defaults: {
        ghl: {
          conversationProviderId: "provider-default"
        }
      }
    })
  });

  assert.doesNotThrow(() => validateRuntimeConfig(config));
});

test("validateRuntimeConfig rejects missing or placeholder values", () => {
  const config = loadConfigFromEnv({
    PUBLIC_BASE_URL: "https://cti.askroi.link",
    GHL_OAUTH_CLIENT_ID: "replace-with-highlevel-marketplace-client-id",
    GHL_OAUTH_CLIENT_SECRET: "ghl-secret",
    GHL_APP_ID: "ghl-app-1",
    GHL_APP_SHARED_SECRET: "shared-secret-1",
    RINGCENTRAL_CLIENT_ID: "rc-client",
    RINGCENTRAL_CLIENT_SECRET: "",
    APP_CONFIG_PATH: writeConfigFile({
      defaults: {
        ghl: {
          conversationProviderId: "default provider id"
        }
      }
    })
  });

  assert.throws(
    () => validateRuntimeConfig(config),
    /GHL_OAUTH_CLIENT_ID.*defaults\.ghl.*RINGCENTRAL_CLIENT_SECRET/
  );
});

test("getRuntimeConfigIssues reports missing values without throwing", () => {
  const config = loadConfigFromEnv({
    PUBLIC_BASE_URL: "https://cti.askroi.link",
    APP_CONFIG_PATH: writeConfigFile({
      defaults: {
        ghl: {
          callConversationProviderId: "call-provider-default"
        }
      }
    })
  });

  assert.deepEqual(getRuntimeConfigIssues(config), [
    "GHL_OAUTH_CLIENT_ID",
    "GHL_OAUTH_CLIENT_SECRET",
    "GHL_APP_ID",
    "GHL_APP_SHARED_SECRET",
    "defaults.ghl.smsConversationProviderId or defaults.ghl.conversationProviderId",
    "RINGCENTRAL_CLIENT_ID",
    "RINGCENTRAL_CLIENT_SECRET"
  ]);
});

test("getLocationProfile uses a configured brand profile when it matches location id", () => {
  const profile = getLocationProfile({
    defaults: {
      ringcentral: {
        clientId: "default-client"
      }
    },
    brands: [{
      key: "brand-a",
      name: "Brand A",
      ghl: {
        locationId: "loc-1",
        callConversationProviderId: "call-provider-brand"
      },
      ringcentral: {
        clientId: "brand-client"
      }
    }]
  }, "loc-1");

  assert.equal(profile.key, "brand-a");
  assert.equal(profile.name, "Brand A");
  assert.equal(profile.ghl.locationId, "loc-1");
  assert.equal(profile.ghl.callConversationProviderId, "call-provider-brand");
  assert.equal(profile.ringcentral.clientId, "brand-client");
});

test("getBrandProfile returns the matching brand", () => {
  const brand = getBrandProfile({
    brands: [
      { key: "brand-a", name: "Brand A" },
      { key: "brand-b", name: "Brand B" }
    ]
  }, "brand-b");

  assert.equal(brand.name, "Brand B");
});

test("getBrandProfile throws for an unknown brand", () => {
  assert.throws(
    () => getBrandProfile({ brands: [{ key: "brand-a" }] }, "missing"),
    /Unknown brand/
  );
});

test("normalizePhone returns E.164-like US phone numbers", () => {
  assert.equal(normalizePhone("(949) 374-5710"), "+19493745710");
  assert.equal(normalizePhone("1-949-374-5710"), "+19493745710");
  assert.equal(normalizePhone("+44 20 7123 4567"), "+442071234567");
});
