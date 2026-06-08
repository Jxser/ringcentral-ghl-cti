const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  extractPhoneFromElementSnapshot,
  extractPhoneFromText,
  isPhoneLikeText
} = require("../phone-utils");

test("extracts phone from tel links", () => {
  assert.equal(
    extractPhoneFromElementSnapshot({ href: "tel:+19493745710" }),
    "+19493745710"
  );
});

test("extracts phone from compact clicked text", () => {
  assert.equal(
    extractPhoneFromElementSnapshot({ text: "(949) 374-5710" }),
    "+19493745710"
  );
});

test("does not treat long mixed contact cards as direct phone clicks", () => {
  assert.equal(
    extractPhoneFromElementSnapshot({ text: "Ryan Doucette Lead Status Open (949) 374-5710 More actions" }),
    ""
  );
});

test("extractPhoneFromText still supports right-click selected text", () => {
  assert.equal(extractPhoneFromText("Call me at 949.374.5710 today"), "+19493745710");
});

test("rejects text that contains non-phone words", () => {
  assert.equal(isPhoneLikeText("Ryan 949 374 5710"), false);
});
