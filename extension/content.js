
let currentPopup = null;
let dispositionPopup = null;
let textPopup = null;
let callControlPopup = null;
let lastUrl = location.href;
let callStartedAt = null;
let callEndedAt = null;
let callTimerInterval = null;
let ringoutPollInterval = null;
let currentCtiCallId = null;
let currentRingcentralRingoutId = null;
let currentCallPhone = null;
let currentAgentPhone = null;
let currentWebPhone = null;
let currentWebPhoneSession = null;
let currentWebPhoneMuted = false;
let currentWebPhoneHeld = false;
let callNotesDraft = "";
let highLevelContextCache = {
  token: "",
  expiresAt: 0
};
let locationBootstrapCache = {
  locationId: "",
  expiresAt: 0,
  settings: null
};
const DEFAULT_BACKEND_URL = "https://cti.askroi.link";
const CURRENT_HOST = location.hostname.toLowerCase();
const STATIC_HIGHLEVEL_HOST_SUFFIXES = [
  "gohighlevel.com",
  "leadconnectorhq.com",
  "msgsndr.com",
  "ault.com"
];
let highLevelHostAllowed = STATIC_HIGHLEVEL_HOST_SUFFIXES.some((suffix) => (
  CURRENT_HOST === suffix || CURRENT_HOST.endsWith(`.${suffix}`)
));
const DEFAULT_DISPOSITIONS = [
  "Connected",
  "Completed",
  "Busy",
  "No Answer",
  "Left Voicemail",
  "Failed",
  "Canceled"
];

chrome.storage.local.get(["allowedHighLevelHosts"], (result) => {
  const allowedHosts = Array.isArray(result.allowedHighLevelHosts) ? result.allowedHighLevelHosts : [];
  highLevelHostAllowed = highLevelHostAllowed || allowedHosts.includes(CURRENT_HOST);
});

async function rememberCurrentHostAsHighLevel() {
  highLevelHostAllowed = true;
  const result = await chrome.storage.local.get(["allowedHighLevelHosts"]);
  const allowedHosts = Array.isArray(result.allowedHighLevelHosts) ? result.allowedHighLevelHosts : [];
  if (allowedHosts.includes(CURRENT_HOST)) return;

  await chrome.storage.local.set({
    allowedHighLevelHosts: [...allowedHosts, CURRENT_HOST].slice(-25)
  });
}

function rcLogo() {
  return `
    <div class="rc-brand">
      <div class="rc-logo-mark">RC</div>
      <div>
        <div class="rc-brand-title">RingCentral CTI</div>
        <div class="rc-brand-subtitle">GoHighLevel</div>
      </div>
    </div>
  `;
}

function normalizePhone(raw) {
  if (globalThis.RcGhlPhoneUtils?.normalizePhone) return globalThis.RcGhlPhoneUtils.normalizePhone(raw);
  if (!raw) return "";
  let cleaned = raw.replace(/[^\d+]/g, "");
  if (cleaned.startsWith("+")) {
    const digits = cleaned.slice(1).replace(/\D/g, "");
    return "+" + digits;
  }
  const digits = cleaned.replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return digits;
}

function formatPhoneForDisplay(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  }
  return phone;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getInitials(name) {
  if (!name) return "AG";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

async function getIntegrationSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["agentName", "agentKey", "agentEmail", "agentPhone", "backendUrl", "activeLocationId", "activeLocationName", "callMode", "agentSessionToken"], (result) => {
      resolve({
        agentName: result.agentName || "",
        agentKey: result.agentKey || "",
        agentEmail: result.agentEmail || "",
        agentPhone: result.agentPhone || "",
        backendUrl: result.backendUrl || DEFAULT_BACKEND_URL,
        activeLocationId: result.activeLocationId || "",
        activeLocationName: result.activeLocationName || "",
        callMode: result.callMode || "ringout",
        agentSessionToken: result.agentSessionToken || ""
      });
    });
  });
}

function hasRequiredSettings(settings) {
  return Boolean(settings.agentKey && settings.agentPhone && settings.backendUrl && settings.activeLocationId);
}

function backendUrl(settings, path) {
  return `${settings.backendUrl.replace(/\/$/, "")}${path}`;
}

async function claimRingCentralSession(settings, authSessionId) {
  const response = await fetch(backendUrl(settings, "/oauth/ringcentral/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authSessionId })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || data.error || "Unable to check RingCentral connection.");

  if (data.connected && data.agentSessionToken) {
    await chrome.storage.local.set({
      agentSessionToken: data.agentSessionToken,
      pendingRingCentralAuthSessionId: ""
    });
    return data.agentSessionToken;
  }

  return "";
}

async function refreshRuntimeSettings(settings) {
  const stored = await chrome.storage.local.get(["agentSessionToken", "pendingRingCentralAuthSessionId"]);
  let agentSessionToken = stored.agentSessionToken || settings.agentSessionToken || "";

  if (stored.pendingRingCentralAuthSessionId) {
    try {
      agentSessionToken = await claimRingCentralSession(settings, stored.pendingRingCentralAuthSessionId) || agentSessionToken;
    } catch (error) {}
  }

  return {
    ...settings,
    agentSessionToken
  };
}

function requestHighLevelSessionDetails(appId) {
  return new Promise((resolve, reject) => {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timeout = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("HighLevel session details timed out."));
    }, 1500);

    function onMessage(event) {
      if (event.source !== window) return;
      if (event.data?.source !== "rc-ghl-page-context") return;
      if (event.data?.requestId !== requestId) return;

      clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (event.data?.type === "rc-ghl-session-details-error") {
        const status = event.data.status ? ` ${event.data.status}` : "";
        reject(new Error(`HighLevel session details failed${status}: ${event.data.message || "request rejected"}`));
        return;
      }

      resolve(event.data.encryptedData || "");
    }

    window.addEventListener("message", onMessage);

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-context.js");
    script.dataset.requestId = requestId;
    script.dataset.appId = appId;
    document.documentElement.appendChild(script);
  });
}

async function getHighLevelUserContextToken(settings, options = {}) {
  if (!options.force && highLevelContextCache.token && highLevelContextCache.expiresAt > Date.now()) {
    return highLevelContextCache.token;
  }

  try {
    const response = await fetch(backendUrl(settings, "/api/extension/highlevel/context-config"));
    const data = await response.json();
    if (!response.ok || !data.enabled || !data.appId) return "";

    const token = await requestHighLevelSessionDetails(data.appId);
    highLevelContextCache = {
      token,
      expiresAt: token ? Date.now() + 5 * 60 * 1000 : 0
    };
    return token;
  } catch (error) {
    highLevelContextCache = { token: "", expiresAt: 0 };
    throw new Error(`${error.message} Confirm the HighLevel Marketplace app id, shared secret, and sub-account install.`);
  }
}

function copyStorage(storage) {
  const snapshot = {};

  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key) snapshot[key] = storage.getItem(key);
    }
  } catch (error) {}

  return snapshot;
}

function getFallbackHighLevelLocationId(settings) {
  const utils = globalThis.RcGhlLocationUtils;
  if (!utils) return settings.activeLocationId || "";

  return utils.extractHighLevelLocationIdFromUrl(location.href)
    || utils.extractHighLevelLocationIdFromStorage({
      localStorage: copyStorage(localStorage),
      sessionStorage: copyStorage(sessionStorage)
    })
    || settings.activeLocationId
    || "";
}

async function bootstrapHighLevelLocation(settings, options = {}) {
  const cacheKey = settings.activeLocationId || "context";
  if (!options.force && locationBootstrapCache.settings && locationBootstrapCache.locationId === cacheKey && locationBootstrapCache.expiresAt > Date.now()) {
    return locationBootstrapCache.settings;
  }

  const runtimeSettings = await refreshRuntimeSettings(settings);
  const ghlUserContextToken = await getHighLevelUserContextToken(runtimeSettings, { force: options.force });
  const fallbackLocationId = getFallbackHighLevelLocationId(runtimeSettings);
  const headers = { "Content-Type": "application/json" };
  if (runtimeSettings.agentSessionToken) headers["X-CTI-Agent-Session"] = runtimeSettings.agentSessionToken;

  const response = await fetch(backendUrl(runtimeSettings, "/api/extension/bootstrap"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      agentKey: runtimeSettings.agentKey,
      locationId: fallbackLocationId,
      ghlUserContextToken
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || data.error || "Unable to detect HighLevel sub-account.");

  const bootstrapped = {
    ...runtimeSettings,
    activeLocationId: data.locationId || runtimeSettings.activeLocationId,
    activeLocationName: data.locationName || runtimeSettings.activeLocationName,
    agentKey: data.agentKey || runtimeSettings.agentKey,
    agentName: data.user?.name || runtimeSettings.agentName,
    agentEmail: data.user?.email || runtimeSettings.agentEmail,
    dispositions: Array.isArray(data.dispositions) ? data.dispositions : undefined,
    highLevelConnected: Boolean(data.highLevelConnected),
    ringcentralConnected: Boolean(data.ringcentralConnected),
    agentSessionValid: Boolean(data.agentSessionValid)
  };

  await rememberCurrentHostAsHighLevel();

  await chrome.storage.local.set({
    activeLocationId: bootstrapped.activeLocationId,
    activeLocationName: bootstrapped.activeLocationName,
    agentKey: bootstrapped.agentKey,
    agentName: bootstrapped.agentName,
    agentEmail: bootstrapped.agentEmail,
    agentSessionToken: bootstrapped.agentSessionToken || ""
  });

  locationBootstrapCache = {
    locationId: bootstrapped.activeLocationId || cacheKey,
    expiresAt: Date.now() + 60 * 1000,
    settings: bootstrapped
  };

  return bootstrapped;
}

async function loadDispositionOptions(settings) {
  if (Array.isArray(settings.dispositions) && settings.dispositions.length) return settings.dispositions;

  try {
    const url = new URL(backendUrl(settings, "/api/extension/dispositions"));
    url.searchParams.set("locationId", settings.activeLocationId);
    const response = await fetch(url.toString());
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || data.error || "Unable to load dispositions.");
    return Array.isArray(data.dispositions) && data.dispositions.length ? data.dispositions : DEFAULT_DISPOSITIONS;
  } catch (error) {
    return DEFAULT_DISPOSITIONS;
  }
}

async function backendRequest(settings, path, payload) {
  const runtimeSettings = await bootstrapHighLevelLocation(settings, { force: true });
  const ghlUserContextToken = await getHighLevelUserContextToken(runtimeSettings);
  const headers = { "Content-Type": "application/json" };
  if (runtimeSettings.agentSessionToken) headers["X-CTI-Agent-Session"] = runtimeSettings.agentSessionToken;

  const response = await fetch(backendUrl(runtimeSettings, path), {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...payload,
      locationId: runtimeSettings.activeLocationId,
      ghlUserContextToken
    })
  });

  let data = {};
  try { data = await response.json(); } catch (error) {}

  if (!response.ok) {
    if (data.error === "missing_agent_session" || data.error === "invalid_agent_session") {
      throw new Error("Agent session is not ready. If you just connected RingCentral, try again once. Otherwise open the extension popup and reconnect RingCentral.");
    }
    if (data.error === "ringcentral_not_connected") {
      throw new Error("RingCentral is not connected for this agent. Open the extension popup and click Connect RingCentral.");
    }
    throw new Error(data.message || data.error || "Backend request failed");
  }

  return data;
}

function extractPhoneFromText(value) {
  if (globalThis.RcGhlPhoneUtils?.extractPhoneFromText) return globalThis.RcGhlPhoneUtils.extractPhoneFromText(value);
  const match = String(value || "").match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
  return match ? normalizePhone(match[0]) : "";
}

function elementPhoneSnapshot(element) {
  if (!element) return {};
  return {
    href: element.getAttribute?.("href") || "",
    text: element.textContent || "",
    ariaLabel: element.getAttribute?.("aria-label") || "",
    title: element.getAttribute?.("title") || "",
    dataPhone: element.getAttribute?.("data-phone") || ""
  };
}

function extractPhoneFromClickedElement(target) {
  const phoneUtils = globalThis.RcGhlPhoneUtils;
  const anchor = target?.closest?.("a[href^='tel:'], a[href^='TEL:']");
  if (anchor) {
    return phoneUtils?.extractPhoneFromElementSnapshot
      ? phoneUtils.extractPhoneFromElementSnapshot(elementPhoneSnapshot(anchor))
      : normalizePhone(anchor.getAttribute("href").replace(/^tel:/i, ""));
  }

  let node = target?.nodeType === Node.TEXT_NODE ? target.parentElement : target;
  for (let i = 0; i < 3 && node; i += 1) {
    const snapshot = elementPhoneSnapshot(node);
    const phone = phoneUtils?.extractPhoneFromElementSnapshot
      ? phoneUtils.extractPhoneFromElementSnapshot(snapshot)
      : extractPhoneFromText(snapshot.text);
    if (phone) return phone;
    node = node.parentElement;
  }

  return "";
}

function closeAllPopups() {
  if (currentPopup) { currentPopup.remove(); currentPopup = null; }
  if (dispositionPopup) { dispositionPopup.remove(); dispositionPopup = null; }
  if (textPopup) { textPopup.remove(); textPopup = null; }
  if (callControlPopup) { callControlPopup.remove(); callControlPopup = null; }
}

function clearCurrentCall() {
  currentCtiCallId = null;
  currentRingcentralRingoutId = null;
  currentCallPhone = null;
  currentAgentPhone = null;
  callStartedAt = null;
  callEndedAt = null;

  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
  if (ringoutPollInterval) {
    clearInterval(ringoutPollInterval);
    ringoutPollInterval = null;
  }
  currentWebPhoneSession = null;
  currentWebPhoneMuted = false;
  currentWebPhoneHeld = false;
  callNotesDraft = "";
}

function centerPopup(el) {
  el.classList.add("rc-centered-popup");
  el.style.left = "50%";
  el.style.top = "50%";
  el.style.right = "auto";
  el.style.bottom = "auto";
  el.style.transform = "translate(-50%, -50%)";
}

function agentCard(agentName) {
  const displayName = agentName || "Not configured";
  return `
    <div class="rc-agent-card">
      <div class="rc-avatar">${getInitials(displayName)}</div>
      <div>
        <div class="rc-agent-label">Agent</div>
        <div class="rc-agent-name">${displayName}</div>
      </div>
    </div>
  `;
}

function callModeLabel(mode) {
  return mode === "webphone" ? "Web Phone" : "RingOut";
}

function digitsForWebPhone(phone) {
  return normalizePhone(phone).replace(/^\+/, "");
}

function setCallControlStatus(message, type = "") {
  const status = document.getElementById("rc-ghl-call-status");
  if (!status) return;
  status.textContent = message;
  status.className = "rc-status " + type;
}

function stopRingOutPolling() {
  if (ringoutPollInterval) {
    clearInterval(ringoutPollInterval);
    ringoutPollInterval = null;
  }
}

function getActionPhone() {
  const input = document.getElementById("rc-ghl-action-phone");
  return normalizePhone(input?.value || "");
}

function settingsWarning(message) {
  return `
    <div class="rc-warning">
      ${escapeHtml(message || "Setup is incomplete. Open the extension, confirm the GHL user, connect RingCentral, and select a caller ID.")}
    </div>
  `;
}

async function showActionPopup(phone) {
  closeAllPopups();

  let settings = await getIntegrationSettings();
  let bootstrapError = "";
  try {
    settings = await bootstrapHighLevelLocation(settings, { force: true });
  } catch (error) {
    bootstrapError = error.message;
  }
  const { agentName } = settings;
  const settingsReady = hasRequiredSettings(settings);

  const popup = document.createElement("div");
  popup.id = "rc-ghl-action-popup";
  popup.className = "rc-card rc-animate";
  popup.innerHTML = `
    ${rcLogo()}

    <label class="rc-label">Phone Number</label>
    <input class="rc-input rc-phone-input" id="rc-ghl-action-phone" type="tel" value="${escapeHtml(phone || "")}" placeholder="+19493745710" />

    ${agentCard(agentName)}

    <div class="rc-mode-pill">
      <span>Call mode</span>
      <strong>${callModeLabel(settings.callMode)}</strong>
    </div>

    <div class="rc-mode-pill">
      <span>Sub-account</span>
      <strong>${escapeHtml(settings.activeLocationName || settings.activeLocationId || "Not detected")}</strong>
    </div>

    ${!settingsReady ? settingsWarning(bootstrapError || "") : ""}

    <div class="rc-actions">
      <button class="rc-btn rc-btn-primary" id="rc-ghl-call-btn" ${!settingsReady ? "disabled" : ""}>
        <span class="rc-btn-icon">☎</span> Call
      </button>
      <button class="rc-btn rc-btn-secondary" id="rc-ghl-text-btn" ${!settingsReady ? "disabled" : ""}>
        <span class="rc-btn-icon">💬</span> Text
      </button>
    </div>

    <button class="rc-btn rc-btn-light" id="rc-ghl-close-btn">Cancel</button>
    <div class="rc-status" id="rc-ghl-status"></div>
  `;

  document.body.appendChild(popup);
  centerPopup(popup);
  currentPopup = popup;

  document.getElementById("rc-ghl-close-btn").addEventListener("click", closeAllPopups);

  document.getElementById("rc-ghl-call-btn")?.addEventListener("click", async () => {
    const selectedPhone = getActionPhone();
    if (!selectedPhone) {
      setStatus("Enter a phone number to call.", "error");
      return;
    }
    await startCall(selectedPhone, settings);
  });

  document.getElementById("rc-ghl-text-btn")?.addEventListener("click", async () => {
    const selectedPhone = getActionPhone();
    if (!selectedPhone) {
      setStatus("Enter a phone number to text.", "error");
      return;
    }
    showTextPopup(selectedPhone, settings);
  });
}

function setStatus(message, type = "") {
  const status = document.getElementById("rc-ghl-status");
  if (!status) return;
  status.textContent = message;
  status.className = "rc-status " + type;
}

function attributionMessage(result, fallback) {
  const attribution = result?.attribution;
  if (!attribution?.userId) return fallback;
  const label = attribution.userName || attribution.email || attribution.userId;
  return `${fallback} Attributed to ${label} via ${attribution.source}.`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function startTimer(elementId) {
  if (!callStartedAt) callStartedAt = Date.now();
  callEndedAt = null;
  if (callTimerInterval) clearInterval(callTimerInterval);

  const update = () => {
    const el = document.getElementById(elementId);
    if (el) el.textContent = formatDuration(Date.now() - callStartedAt);
  };

  update();
  callTimerInterval = setInterval(update, 1000);
}

function stopTimer() {
  if (!callStartedAt) return;
  if (!callEndedAt) callEndedAt = Date.now();
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
}

function getCallDurationMs() {
  if (!callStartedAt) return 0;
  return Math.max(0, (callEndedAt || Date.now()) - callStartedAt);
}

function getElapsedCallSeconds() {
  return callStartedAt ? Math.floor(getCallDurationMs() / 1000) : null;
}

function notesEditorHtml() {
  return `
    <label class="rc-label">Notes</label>
    <textarea class="rc-textarea rc-call-notes" id="rc-ghl-live-notes" placeholder="Type notes while you talk...">${escapeHtml(callNotesDraft)}</textarea>
  `;
}

function wireNotesEditor() {
  const notes = document.getElementById("rc-ghl-live-notes");
  if (!notes) return;
  notes.addEventListener("input", () => {
    callNotesDraft = notes.value;
  });
}

async function startCall(phone, settings) {
  callNotesDraft = "";
  callStartedAt = null;
  callEndedAt = null;
  if (settings.callMode === "webphone") {
    await startWebPhoneCall(phone, settings);
    return;
  }

  await startRingOutCall(phone, settings);
}

async function startRingOutCall(phone, settings) {
  const { agentPhone, agentName } = settings;

  if (!phone || !agentPhone) {
    setStatus("Phone and agent are required.", "error");
    return;
  }

  setStatus("Starting RingOut. Your phone will ring first…", "info");

  const payload = {
    phone,
    agentPhone,
    agentName,
    agentKey: settings.agentKey,
    pageUrl: location.href,
    createdAt: new Date().toISOString()
  };

  try {
    const data = await backendRequest(settings, "/api/extension/calls/start", payload);
    const ctiCallId = data.ctiCallId || data.cti_call_id || null;
    const ringoutId = data.ringcentralRingoutId || data.ringcentral_ringout_id || data.id || "";

    currentCtiCallId = ctiCallId;
    currentRingcentralRingoutId = ringoutId;
    currentCallPhone = phone;
    currentAgentPhone = agentPhone;

    if (currentPopup) currentPopup.remove();
    currentPopup = null;
    showRingOutControlPopup(phone, settings, ringoutId, ctiCallId);
  } catch (error) {
    setStatus(`Error starting call. ${error.message}`, "error");
  }
}

function showRingOutControlPopup(phone, settings, ringoutId, ctiCallId) {
  const { agentPhone, agentName } = settings;

  if (callControlPopup) callControlPopup.remove();

  const popup = document.createElement("div");
  popup.id = "rc-ghl-call-control-popup";
  popup.className = "rc-card rc-animate";
  popup.innerHTML = `
    ${rcLogo()}
    <div class="rc-section-title">RingOut Call</div>

    <div class="rc-phone-card">
      <div class="rc-phone-number">${formatPhoneForDisplay(phone)}</div>
    </div>

    ${agentCard(agentName)}

    <div class="rc-call-state">
      <div>
        <span>Call status</span>
        <strong id="rc-ghl-ringout-call-status">Starting</strong>
      </div>
      <div>
        <span>Your line</span>
        <strong id="rc-ghl-ringout-caller-status">Waiting</strong>
      </div>
      <div>
        <span>Contact</span>
        <strong id="rc-ghl-ringout-callee-status">Waiting</strong>
      </div>
    </div>

    <div class="rc-timer-box">
      <span>Call time</span>
      <strong id="rc-call-timer">00:00</strong>
    </div>

    <div class="rc-status info" id="rc-ghl-call-status">Waiting for RingCentral to ring your phone or app.</div>

    ${notesEditorHtml()}

    <button class="rc-btn rc-btn-light" id="rc-ghl-cancel-ringout">Cancel RingOut</button>
    <button class="rc-btn rc-btn-success" id="rc-ghl-open-disposition">Log Disposition</button>
    <button class="rc-btn rc-btn-light" id="rc-ghl-close-call-control">Close</button>
  `;

  document.body.appendChild(popup);
  centerPopup(popup);
  callControlPopup = popup;

  const dispositionButton = document.getElementById("rc-ghl-open-disposition");
  dispositionButton.disabled = true;
  wireNotesEditor();
  startTimer("rc-call-timer");

  document.getElementById("rc-ghl-close-call-control").addEventListener("click", () => {
    stopRingOutPolling();
    popup.remove();
    callControlPopup = null;
  });

  document.getElementById("rc-ghl-cancel-ringout").addEventListener("click", async () => {
    const button = document.getElementById("rc-ghl-cancel-ringout");
    button.disabled = true;
    setCallControlStatus("Canceling RingOut...", "info");

    try {
      await backendRequest(settings, "/api/extension/calls/cancel", {
        agentKey: settings.agentKey,
        ringcentralRingoutId: ringoutId
      });
      stopRingOutPolling();
      stopTimer();
      setCallControlStatus("RingOut canceled.", "success");
      clearCurrentCall();
      setTimeout(() => {
        if (popup) popup.remove();
        callControlPopup = null;
      }, 900);
    } catch (error) {
      button.disabled = false;
      setCallControlStatus(`Unable to cancel RingOut. ${error.message}`, "error");
    }
  });

  dispositionButton.addEventListener("click", () => {
    const notes = document.getElementById("rc-ghl-live-notes");
    if (notes) callNotesDraft = notes.value;
    stopRingOutPolling();
    stopTimer();
    if (popup) popup.remove();
    callControlPopup = null;
    showDispositionPopup(phone, settings, ringoutId, ctiCallId);
  });

  pollRingOutStatus(phone, settings, ringoutId, ctiCallId);
  ringoutPollInterval = setInterval(() => {
    pollRingOutStatus(phone, settings, ringoutId, ctiCallId);
  }, 2500);
}

async function pollRingOutStatus(phone, settings, ringoutId, ctiCallId) {
  try {
    const data = await backendRequest(settings, "/api/extension/calls/status", {
      agentKey: settings.agentKey,
      ringcentralRingoutId: ringoutId
    });
    const callStatus = data.callStatus || "Unknown";
    const callerStatus = data.callerStatus || "Unknown";
    const calleeStatus = data.calleeStatus || "Unknown";

    const callEl = document.getElementById("rc-ghl-ringout-call-status");
    const callerEl = document.getElementById("rc-ghl-ringout-caller-status");
    const calleeEl = document.getElementById("rc-ghl-ringout-callee-status");
    const cancelButton = document.getElementById("rc-ghl-cancel-ringout");
    const dispositionButton = document.getElementById("rc-ghl-open-disposition");

    if (callEl) callEl.textContent = callStatus;
    if (callerEl) callerEl.textContent = callerStatus;
    if (calleeEl) calleeEl.textContent = calleeStatus;

    if (callStatus === "Success") {
      if (!callStartedAt) startTimer("rc-call-timer");
      if (cancelButton) cancelButton.disabled = true;
      if (dispositionButton) dispositionButton.disabled = false;
      setCallControlStatus("Connected. Use RingCentral to control the live call.", "success");
      return;
    }

    if (callStatus === "InProgress") {
      setCallControlStatus("Waiting for both call legs to connect.", "info");
      return;
    }

    if (callStatus === "Finished") {
      stopRingOutPolling();
      stopTimer();
      setCallControlStatus("Call finished. Add disposition to log the activity.", "success");
      if (dispositionButton) dispositionButton.disabled = false;
      return;
    }

    if (["CannotReach", "NoAnsweringMachine"].includes(callStatus) || ["Busy", "NoAnswer", "Rejected", "GenericError", "InternationalDisabled", "Invalid"].includes(callerStatus) || ["Busy", "NoAnswer", "Rejected", "GenericError", "InternationalDisabled", "Invalid"].includes(calleeStatus)) {
      stopRingOutPolling();
      stopTimer();
      if (dispositionButton) dispositionButton.disabled = false;
      if (cancelButton) cancelButton.disabled = true;
      setCallControlStatus("RingOut did not connect. You can log a disposition if needed.", "warning");
    }
  } catch (error) {
    stopRingOutPolling();
    stopTimer();
    const dispositionButton = document.getElementById("rc-ghl-open-disposition");
    if (dispositionButton) dispositionButton.disabled = false;
    setCallControlStatus(`RingOut status unavailable. ${error.message}`, "error");
  }
}

async function getWebPhoneConstructor() {
  if (!globalThis.WebPhone) {
    await import(chrome.runtime.getURL("vendor/ringcentral-web-phone.umd.js"));
  }
  const candidate = globalThis.WebPhone;
  return candidate?.default || candidate;
}

async function ensureWebPhone(settings) {
  if (currentWebPhone) return currentWebPhone;

  const WebPhoneCtor = await getWebPhoneConstructor();
  if (!WebPhoneCtor) {
    throw new Error("RingCentral Web Phone SDK is not loaded. Reload the extension and GHL tab.");
  }

  const provision = await backendRequest(settings, "/api/extension/webphone/sip-info", {
    agentKey: settings.agentKey
  });

  if (!provision.sipInfo) {
    throw new Error("RingCentral did not return SIP info for this user.");
  }

  const instanceId = `ghl-cti-${settings.activeLocationId}-${settings.agentKey}`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
  currentWebPhone = new WebPhoneCtor({
    sipInfo: provision.sipInfo,
    instanceId
  });
  await currentWebPhone.start();
  return currentWebPhone;
}

async function startWebPhoneCall(phone, settings) {
  const { agentPhone, agentName } = settings;

  if (!phone || !agentPhone) {
    setStatus("Phone and agent are required.", "error");
    return;
  }

  setStatus("Opening Web Phone...", "info");

  try {
    if (currentPopup) currentPopup.remove();
    currentPopup = null;
    showWebPhoneControlPopup(phone, settings);

    const webPhone = await ensureWebPhone(settings);
    setCallControlStatus("Dialing from browser...", "info");
    const session = await webPhone.call(digitsForWebPhone(phone), digitsForWebPhone(agentPhone));
    currentWebPhoneSession = session;
    currentCallPhone = phone;
    currentAgentPhone = agentPhone;

    wireWebPhoneSession(session, phone, settings);
    setCallControlStatus("Ringing contact...", "info");
  } catch (error) {
    setCallControlStatus(`Unable to start Web Phone call. ${error.message}`, "error");
  }
}

function showWebPhoneControlPopup(phone, settings) {
  const { agentName } = settings;

  if (callControlPopup) callControlPopup.remove();

  const popup = document.createElement("div");
  popup.id = "rc-ghl-call-control-popup";
  popup.className = "rc-card rc-animate";
  popup.innerHTML = `
    ${rcLogo()}
    <div class="rc-section-title">Web Phone</div>

    <div class="rc-phone-card">
      <div class="rc-phone-number">${formatPhoneForDisplay(phone)}</div>
    </div>

    ${agentCard(agentName)}

    <div class="rc-timer-box">
      <span>Call time</span>
      <strong id="rc-call-timer">00:00</strong>
    </div>

    <div class="rc-status info" id="rc-ghl-call-status">Preparing browser audio.</div>

    ${notesEditorHtml()}

    <div class="rc-control-grid">
      <button class="rc-icon-btn" id="rc-ghl-webphone-mute" type="button" title="Mute">Mute</button>
      <button class="rc-icon-btn" id="rc-ghl-webphone-hold" type="button" title="Hold">Hold</button>
      <button class="rc-icon-btn rc-danger" id="rc-ghl-webphone-hangup" type="button" title="Hang up">End</button>
    </div>

    <button class="rc-btn rc-btn-success" id="rc-ghl-open-disposition">Log Disposition</button>
    <button class="rc-btn rc-btn-light" id="rc-ghl-close-call-control">Close</button>
  `;

  document.body.appendChild(popup);
  centerPopup(popup);
  callControlPopup = popup;

  const dispositionButton = document.getElementById("rc-ghl-open-disposition");
  dispositionButton.disabled = true;
  wireNotesEditor();
  startTimer("rc-call-timer");

  document.getElementById("rc-ghl-webphone-mute").addEventListener("click", async () => {
    if (!currentWebPhoneSession) return;
    const button = document.getElementById("rc-ghl-webphone-mute");
    try {
      if (currentWebPhoneMuted) {
        await currentWebPhoneSession.unmute();
        currentWebPhoneMuted = false;
        button.textContent = "Mute";
      } else {
        await currentWebPhoneSession.mute();
        currentWebPhoneMuted = true;
        button.textContent = "Unmute";
      }
    } catch (error) {
      setCallControlStatus(`Mute failed. ${error.message}`, "error");
    }
  });

  document.getElementById("rc-ghl-webphone-hold").addEventListener("click", async () => {
    if (!currentWebPhoneSession) return;
    const button = document.getElementById("rc-ghl-webphone-hold");
    try {
      if (currentWebPhoneHeld) {
        await currentWebPhoneSession.unhold();
        currentWebPhoneHeld = false;
        button.textContent = "Hold";
      } else {
        await currentWebPhoneSession.hold();
        currentWebPhoneHeld = true;
        button.textContent = "Resume";
      }
    } catch (error) {
      setCallControlStatus(`Hold failed. ${error.message}`, "error");
    }
  });

  document.getElementById("rc-ghl-webphone-hangup").addEventListener("click", async () => {
    if (!currentWebPhoneSession) return;
    try {
      await currentWebPhoneSession.hangup();
      stopTimer();
      setCallControlStatus("Call ended. Add disposition to log the activity.", "success");
      dispositionButton.disabled = false;
    } catch (error) {
      setCallControlStatus(`Hangup failed. ${error.message}`, "error");
    }
  });

  document.getElementById("rc-ghl-close-call-control").addEventListener("click", () => {
    popup.remove();
    callControlPopup = null;
  });

  dispositionButton.addEventListener("click", () => {
    const notes = document.getElementById("rc-ghl-live-notes");
    if (notes) callNotesDraft = notes.value;
    if (popup) popup.remove();
    callControlPopup = null;
    stopTimer();
    showDispositionPopup(phone, settings, "", null);
  });
}

function wireWebPhoneSession(session, phone, settings) {
  if (!session?.on) {
    if (!callStartedAt) startTimer("rc-call-timer");
    const dispositionButton = document.getElementById("rc-ghl-open-disposition");
    if (dispositionButton) dispositionButton.disabled = false;
    return;
  }

  session.on("ringing", () => {
    setCallControlStatus("Ringing contact...", "info");
  });

  session.on("answered", () => {
    if (!callStartedAt) startTimer("rc-call-timer");
    setCallControlStatus("Connected through browser audio.", "success");
    const dispositionButton = document.getElementById("rc-ghl-open-disposition");
    if (dispositionButton) dispositionButton.disabled = false;
  });

  session.on("disposed", () => {
    stopTimer();
    setCallControlStatus("Call ended. Add disposition to log the activity.", "success");
    const dispositionButton = document.getElementById("rc-ghl-open-disposition");
    if (dispositionButton) dispositionButton.disabled = false;
  });

  session.on("failed", (error) => {
    stopTimer();
    setCallControlStatus(`Call failed. ${error?.message || "Check RingCentral Web Phone permissions."}`, "error");
    const dispositionButton = document.getElementById("rc-ghl-open-disposition");
    if (dispositionButton) dispositionButton.disabled = false;
  });
}

async function showDispositionPopup(phone, settings, ringoutId, ctiCallId) {
  const { agentPhone, agentName } = settings;
  const dispositions = await loadDispositionOptions(settings);
  const dispositionOptions = dispositions
    .map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`)
    .join("");

  if (dispositionPopup) dispositionPopup.remove();

  const popup = document.createElement("div");
  popup.id = "rc-ghl-disposition-popup";
  popup.className = "rc-card rc-animate";
  popup.innerHTML = `
    ${rcLogo()}
    <div class="rc-section-title">Call Disposition</div>

    <div class="rc-phone-card">
      <div class="rc-phone-number">${formatPhoneForDisplay(phone)}</div>
    </div>

    ${agentCard(agentName)}

    <div class="rc-timer-box">
      <span>Call timer</span>
      <strong id="rc-call-timer">00:00</strong>
    </div>

    <label class="rc-label">Result</label>
    <select class="rc-input" id="rc-ghl-disposition">
      <option value="">Select disposition</option>
      ${dispositionOptions}
    </select>

    <label class="rc-label">Notes</label>
    <textarea class="rc-textarea" id="rc-ghl-notes" placeholder="Add call notes...">${escapeHtml(callNotesDraft)}</textarea>

    <button class="rc-btn rc-btn-success" id="rc-ghl-submit-disposition">Submit Disposition</button>
    <button class="rc-btn rc-btn-light" id="rc-ghl-close-disposition">Close</button>
    <div class="rc-status" id="rc-ghl-disposition-status"></div>
  `;

  document.body.appendChild(popup);
  centerPopup(popup);
  dispositionPopup = popup;
  stopTimer();
  document.getElementById("rc-call-timer").textContent = formatDuration(getCallDurationMs());

  document.getElementById("rc-ghl-close-disposition").addEventListener("click", () => {
    stopTimer();
    popup.remove();
    dispositionPopup = null;
    clearCurrentCall();
  });

  document.getElementById("rc-ghl-submit-disposition").addEventListener("click", async () => {
    const disposition = document.getElementById("rc-ghl-disposition").value;
    const notes = document.getElementById("rc-ghl-notes").value;
    callNotesDraft = notes;
    const status = document.getElementById("rc-ghl-disposition-status");
    const durationSeconds = getElapsedCallSeconds();

    if (!disposition) {
      status.textContent = "Please select a disposition.";
      status.className = "rc-status error";
      return;
    }

    const payload = {
      ctiCallId: ctiCallId || currentCtiCallId,
      phone,
      agentPhone,
      agentName,
      agentKey: settings.agentKey,
      ringcentralRingoutId: ringoutId || currentRingcentralRingoutId,
      disposition,
      notes,
      durationSeconds,
      pageUrl: location.href,
      completedAt: new Date().toISOString()
    };

    try {
      const result = await backendRequest(settings, "/api/extension/calls/disposition", payload);

      status.textContent = attributionMessage(result, "Disposition submitted.");
      status.className = "rc-status success";

      setTimeout(() => {
        stopTimer();
        if (popup) popup.remove();
        dispositionPopup = null;
        clearCurrentCall();
      }, 900);
    } catch (error) {
      status.textContent = `Error submitting disposition. ${error.message}`;
      status.className = "rc-status error";
    }
  });
}

function showTextPopup(phone, settings) {
  const { agentPhone, agentName } = settings;

  if (textPopup) textPopup.remove();
  if (currentPopup) { currentPopup.remove(); currentPopup = null; }

  const popup = document.createElement("div");
  popup.id = "rc-ghl-text-popup";
  popup.className = "rc-card rc-animate";
  popup.innerHTML = `
    ${rcLogo()}
    <div class="rc-section-title">Send Text Message</div>

    <div class="rc-phone-card">
      <div class="rc-phone-number">${formatPhoneForDisplay(phone)}</div>
    </div>

    ${agentCard(agentName)}

    <label class="rc-label">Template</label>
    <select class="rc-input" id="rc-ghl-template">
      <option value="">Choose a template</option>
      <option value="Hi, this is ${agentName}. I’m following up with you.">Follow Up</option>
      <option value="Hi, this is ${agentName}. I wanted to remind you about your appointment.">Appointment Reminder</option>
      <option value="Thank you for your time today. Please let me know if you have any questions.">Thank You</option>
      <option value="Hi, this is ${agentName}. I’m sending the pricing information we discussed.">Pricing Information</option>
    </select>

    <label class="rc-label">Message</label>
    <textarea class="rc-textarea rc-sms-box" id="rc-ghl-message" placeholder="Type your message here..."></textarea>

    <button class="rc-btn rc-btn-secondary-full" id="rc-ghl-send-text">Send Text</button>
    <button class="rc-btn rc-btn-light" id="rc-ghl-close-text">Close</button>
    <div class="rc-status" id="rc-ghl-text-status"></div>
  `;

  document.body.appendChild(popup);
  centerPopup(popup);
  textPopup = popup;

  document.getElementById("rc-ghl-template").addEventListener("change", (e) => {
    const message = document.getElementById("rc-ghl-message");
    if (e.target.value) message.value = e.target.value;
  });

  document.getElementById("rc-ghl-close-text").addEventListener("click", () => {
    popup.remove();
    textPopup = null;
  });

  document.getElementById("rc-ghl-send-text").addEventListener("click", async () => {
    const message = document.getElementById("rc-ghl-message").value.trim();
    const status = document.getElementById("rc-ghl-text-status");

    if (!phone || !agentPhone || !message) {
      status.textContent = "Message is required.";
      status.className = "rc-status error";
      return;
    }

    status.textContent = "Sending text…";
    status.className = "rc-status info";

    const payload = {
      to: phone,
      from: agentPhone,
      agentName,
      agentKey: settings.agentKey,
      message,
      pageUrl: location.href,
      createdAt: new Date().toISOString()
    };

    try {
      const result = await backendRequest(settings, "/api/extension/sms/send", payload);

      status.textContent = attributionMessage(result, "Text sent successfully.");
      status.className = "rc-status success";

      setTimeout(() => {
        if (popup) popup.remove();
        textPopup = null;
      }, 900);
    } catch (error) {
      status.textContent = `Error sending text. ${error.message}`;
      status.className = "rc-status error";
    }
  });
}

document.addEventListener("click", (event) => {
  if (
    event.target.closest("#rc-ghl-action-popup") ||
    event.target.closest("#rc-ghl-call-control-popup") ||
    event.target.closest("#rc-ghl-disposition-popup") ||
    event.target.closest("#rc-ghl-text-popup")
  ) return;

  if (callControlPopup) return;
  if (!highLevelHostAllowed) return;

  const phone = extractPhoneFromClickedElement(event.target);
  if (!phone) {
    closeAllPopups();
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  showActionPopup(phone);
}, true);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "rc-ghl-bootstrap-location") {
    (async () => {
      try {
        const settings = await bootstrapHighLevelLocation(await getIntegrationSettings(), { force: true });
        sendResponse({
          ok: true,
          locationId: settings.activeLocationId,
          locationName: settings.activeLocationName,
          highLevelConnected: settings.highLevelConnected,
          ringcentralConnected: settings.ringcentralConnected,
          agentSessionValid: settings.agentSessionValid,
          agentKey: settings.agentKey,
          user: {
            id: settings.agentKey || "",
            name: settings.agentName || "",
            email: settings.agentEmail || ""
          }
        });
      } catch (error) {
        sendResponse({ ok: false, message: error.message });
      }
    })();
    return true;
  }

  if (message?.type !== "rc-ghl-open-dialer") return false;

  showActionPopup(extractPhoneFromText(message.phone || "") || normalizePhone(message.phone || ""));
  sendResponse({ ok: true });
  return true;
});

setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    highLevelContextCache = { token: "", expiresAt: 0 };
    locationBootstrapCache = { locationId: "", expiresAt: 0, settings: null };
    if (!callControlPopup) {
      closeAllPopups();
      clearCurrentCall();
    }
  }
}, 500);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (callControlPopup) return;
    closeAllPopups();
    clearCurrentCall();
  }
});

window.addEventListener("beforeunload", () => {
  if (currentWebPhone?.dispose) {
    currentWebPhone.dispose();
  }
});
