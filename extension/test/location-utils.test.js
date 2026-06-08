const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  extractHighLevelLocationIdFromUrl,
  extractHighLevelLocationIdFromStorage
} = require("../location-utils");

test("extracts HighLevel location id from v2 location URL", () => {
  assert.equal(
    extractHighLevelLocationIdFromUrl("https://crm.ault.com/v2/location/IDKQ3j53SiOLOTdWsvfT/conversations"),
    "IDKQ3j53SiOLOTdWsvfT"
  );
});

test("extracts HighLevel location id from query parameters", () => {
  assert.equal(
    extractHighLevelLocationIdFromUrl("https://crm.ault.com/conversations?locationId=IDKQ3j53SiOLOTdWsvfT"),
    "IDKQ3j53SiOLOTdWsvfT"
  );
});

test("extracts HighLevel location id from selected location storage values", () => {
  assert.equal(
    extractHighLevelLocationIdFromStorage({
      localStorage: {
        selectedLocation: JSON.stringify({ id: "IDKQ3j53SiOLOTdWsvfT" })
      },
      sessionStorage: {}
    }),
    "IDKQ3j53SiOLOTdWsvfT"
  );
});
