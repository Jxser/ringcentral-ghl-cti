const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { FileTokenStore } = require("../src/token-store");

test("FileTokenStore saves and loads tokens by brand and agent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cti-token-store-"));
  const store = new FileTokenStore(path.join(dir, "tokens.json"));

  await store.set("brand-a", "agent@example.com", {
    access_token: "access-1",
    refresh_token: "refresh-1"
  });

  const loaded = await store.get("brand-a", "agent@example.com");
  const missing = await store.get("brand-a", "missing@example.com");

  assert.equal(loaded.access_token, "access-1");
  assert.equal(loaded.refresh_token, "refresh-1");
  assert.equal(missing, null);
});

test("FileTokenStore saves and loads OAuth auth sessions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cti-token-store-"));
  const store = new FileTokenStore(path.join(dir, "tokens.json"));

  await store.setAuthSession("auth-1", {
    brandKey: "brand-a",
    agentKey: "agent@example.com",
    agentSessionToken: "session-1"
  });

  const loaded = await store.getAuthSession("auth-1");
  const missing = await store.getAuthSession("missing");

  assert.equal(loaded.agentSessionToken, "session-1");
  assert.equal(missing, null);
});

test("FileTokenStore saves and loads HighLevel tokens by brand", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cti-token-store-"));
  const store = new FileTokenStore(path.join(dir, "tokens.json"));

  await store.setGhlToken("brand-a", {
    access_token: "ghl-access-1",
    refresh_token: "ghl-refresh-1",
    locationId: "loc-1"
  });

  const loaded = await store.getGhlToken("brand-a");
  const missing = await store.getGhlToken("missing");

  assert.equal(loaded.access_token, "ghl-access-1");
  assert.equal(loaded.refresh_token, "ghl-refresh-1");
  assert.equal(loaded.locationId, "loc-1");
  assert.equal(missing, null);
});

test("FileTokenStore saves and loads HighLevel agency tokens by company", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cti-token-store-"));
  const store = new FileTokenStore(path.join(dir, "tokens.json"));

  await store.setGhlAgencyToken("company-1", {
    access_token: "agency-access-1",
    refresh_token: "agency-refresh-1",
    companyId: "company-1",
    userType: "Company"
  });

  const loaded = await store.getGhlAgencyToken("company-1");
  const missing = await store.getGhlAgencyToken("missing");

  assert.equal(loaded.access_token, "agency-access-1");
  assert.equal(loaded.companyId, "company-1");
  assert.equal(loaded.userType, "Company");
  assert.equal(missing, null);
});

test("FileTokenStore saves and loads installed HighLevel locations", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cti-token-store-"));
  const store = new FileTokenStore(path.join(dir, "tokens.json"));

  await store.setInstalledLocation("loc-1", {
    locationId: "loc-1",
    companyId: "company-1",
    name: "Ault"
  });

  const loaded = await store.getInstalledLocation("loc-1");
  const missing = await store.getInstalledLocation("missing");

  assert.equal(loaded.locationId, "loc-1");
  assert.equal(loaded.companyId, "company-1");
  assert.equal(loaded.name, "Ault");
  assert.equal(missing, null);
});
