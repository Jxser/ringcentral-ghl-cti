const crypto = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert/strict");

const { decryptHighLevelUserContext } = require("../src/highlevel-user-context");

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

function encryptLikeCryptoJs(value, secret) {
  const salt = Buffer.from("12345678", "utf8");
  const { key, iv } = evpBytesToKey(secret, salt, 32, 16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final()
  ]);

  return Buffer.concat([Buffer.from("Salted__", "utf8"), salt, encrypted]).toString("base64");
}

test("decryptHighLevelUserContext decrypts HighLevel session details", () => {
  const encryptedData = encryptLikeCryptoJs({
    userId: "user-1",
    userName: "Ryan Doucette",
    email: "ryan@example.com",
    activeLocation: "loc-1"
  }, "shared-secret-1");

  const context = decryptHighLevelUserContext(encryptedData, "shared-secret-1");

  assert.equal(context.userId, "user-1");
  assert.equal(context.userName, "Ryan Doucette");
  assert.equal(context.email, "ryan@example.com");
  assert.equal(context.activeLocation, "loc-1");
});

test("decryptHighLevelUserContext rejects missing shared secrets", () => {
  assert.throws(
    () => decryptHighLevelUserContext("encrypted", ""),
    /shared secret is required/
  );
});
