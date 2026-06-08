const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const manifest = JSON.parse(readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));

test("content script can run on whitelabeled HighLevel HTTPS domains", () => {
  const matches = manifest.content_scripts.flatMap((script) => script.matches || []);

  assert.ok(
    matches.includes("https://*/*"),
    "content.js must be available on custom whitelabel GHL domains, not just gohighlevel.com"
  );
});

test("page context bridge is available on whitelabeled HighLevel HTTPS domains", () => {
  const matches = manifest.web_accessible_resources.flatMap((resource) => resource.matches || []);

  assert.ok(
    matches.includes("https://*/*"),
    "page-context.js must be injectable on custom whitelabel GHL domains"
  );
});

test("location helper loads before the content script", () => {
  const scripts = manifest.content_scripts[0].js;

  assert.deepEqual(scripts.slice(0, 3), ["location-utils.js", "phone-utils.js", "content.js"]);
});
