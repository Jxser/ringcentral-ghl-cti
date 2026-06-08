const crypto = require("node:crypto");

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

function decryptOpenSslAes(encryptedData, sharedSecret) {
  const payload = Buffer.from(String(encryptedData || ""), "base64");
  const marker = payload.subarray(0, 8).toString("utf8");
  if (marker !== "Salted__") {
    throw new Error("Unsupported HighLevel user context payload");
  }

  const salt = payload.subarray(8, 16);
  const encrypted = payload.subarray(16);
  const { key, iv } = evpBytesToKey(sharedSecret, salt, 32, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function decryptHighLevelUserContext(encryptedData, sharedSecret) {
  if (!sharedSecret) throw new Error("HighLevel shared secret is required");
  if (!encryptedData) throw new Error("HighLevel encrypted user context is required");

  try {
    return JSON.parse(decryptOpenSslAes(encryptedData, sharedSecret));
  } catch (error) {
    throw new Error(`Failed to decrypt HighLevel user context: ${error.message}`);
  }
}

function resolveHighLevelUserContext(config, encryptedData) {
  if (!encryptedData) return null;
  return decryptHighLevelUserContext(encryptedData, config.ghlApp?.sharedSecret);
}

module.exports = {
  decryptHighLevelUserContext,
  resolveHighLevelUserContext
};
