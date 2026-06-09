const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

function randomSuffix() {
  return crypto.randomBytes(6).toString("hex");
}

function storageKey(brandKey, agentKey) {
  return `${brandKey}:${String(agentKey || "").toLowerCase()}`;
}

function authSessionKey(authSessionId) {
  return `authSession:${authSessionId}`;
}

function ghlTokenKey(brandKey) {
  return `ghl:${String(brandKey || "").trim()}`;
}

function ghlAgencyTokenKey(companyId) {
  return `ghlAgency:${String(companyId || "").trim()}`;
}

function installedLocationKey(locationId) {
  return `installedLocation:${String(locationId || "").trim()}`;
}

class FileTokenStore {
  constructor(filePath) {
    this.filePath = filePath;
    this._writeChain = Promise.resolve();
  }

  async readAll() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  async writeAll(data) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomSuffix()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tempPath, this.filePath);
  }

  async mutate(mutator) {
    const run = this._writeChain.then(async () => {
      const data = await this.readAll();
      const result = await mutator(data);
      await this.writeAll(data);
      return result;
    });
    this._writeChain = run.then(() => {}, () => {});
    return run;
  }

  async get(brandKey, agentKey) {
    const data = await this.readAll();
    return data[storageKey(brandKey, agentKey)] || null;
  }

  async set(brandKey, agentKey, tokenSet) {
    await this.mutate((data) => {
      data[storageKey(brandKey, agentKey)] = {
        ...tokenSet,
        updated_at: new Date().toISOString()
      };
    });
  }

  async setAuthSession(authSessionId, session) {
    await this.mutate((data) => {
      data[authSessionKey(authSessionId)] = {
        ...session,
        updated_at: new Date().toISOString()
      };
    });
  }

  async getAuthSession(authSessionId) {
    const data = await this.readAll();
    return data[authSessionKey(authSessionId)] || null;
  }

  async setGhlToken(brandKey, tokenSet) {
    await this.mutate((data) => {
      data[ghlTokenKey(brandKey)] = {
        ...tokenSet,
        updated_at: new Date().toISOString()
      };
    });
  }

  async getGhlToken(brandKey) {
    const data = await this.readAll();
    return data[ghlTokenKey(brandKey)] || null;
  }

  async setGhlAgencyToken(companyId, tokenSet) {
    await this.mutate((data) => {
      data[ghlAgencyTokenKey(companyId)] = {
        ...tokenSet,
        updated_at: new Date().toISOString()
      };
    });
  }

  async getGhlAgencyToken(companyId) {
    const data = await this.readAll();
    return data[ghlAgencyTokenKey(companyId)] || null;
  }

  async setInstalledLocation(locationId, location) {
    await this.mutate((data) => {
      data[installedLocationKey(locationId)] = {
        ...location,
        locationId,
        updated_at: new Date().toISOString()
      };
    });
  }

  async getInstalledLocation(locationId) {
    const data = await this.readAll();
    return data[installedLocationKey(locationId)] || null;
  }
}

module.exports = {
  authSessionKey,
  FileTokenStore,
  ghlAgencyTokenKey,
  ghlTokenKey,
  installedLocationKey,
  storageKey
};
