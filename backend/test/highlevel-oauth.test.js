const test = require("node:test");
const assert = require("node:assert/strict");

const { getHighLevelLocationToken } = require("../src/highlevel-oauth");

test("getHighLevelLocationToken posts form-encoded body with Version header", async () => {
  const requests = [];
  const token = await getHighLevelLocationToken({
    accessToken: "agency-access-1",
    companyId: "company-1",
    locationId: "loc-1",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          access_token: "location-access-1",
          refresh_token: "location-refresh-1"
        })
      };
    }
  });

  assert.equal(token.access_token, "location-access-1");
  assert.equal(requests[0].url, "https://services.leadconnectorhq.com/oauth/locationToken");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers.Authorization, "Bearer agency-access-1");
  assert.equal(requests[0].options.headers.Version, "2023-02-21");
  assert.equal(requests[0].options.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(requests[0].options.body.get("companyId"), "company-1");
  assert.equal(requests[0].options.body.get("locationId"), "loc-1");
});
