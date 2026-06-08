const DEFAULT_BACKEND_URL = "https://cti.askroi.link";

let currentAgent = {
  agentName: "",
  agentKey: "",
  agentEmail: ""
};

function normalizePhone(raw) {
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

function setStatus(message, className = "") {
  const status = document.getElementById("status");
  status.textContent = message;
  status.className = className;
}

function setButtonBusy(button, busy, label) {
  button.disabled = busy;
  if (label) button.textContent = label;
}

function formValues() {
  const callerIdSelect = document.getElementById("callerIdSelect");
  const selectedCallerId = callerIdSelect?.value || "";
  const manualCallerId = document.getElementById("agentPhone").value.trim();

  return {
    ...currentAgent,
    agentPhone: normalizePhone(selectedCallerId || manualCallerId),
    backendUrl: DEFAULT_BACKEND_URL,
    callMode: document.getElementById("callMode").value || "ringout"
  };
}

function validateIdentity(values) {
  if (!values.agentKey) {
    return "GHL user was not detected. Open a sub-account tab and confirm the Marketplace app id/shared secret are configured.";
  }
  return "";
}

function validateDialer(values) {
  const identityError = validateIdentity(values);
  if (identityError) return identityError;
  if (!values.agentPhone) return "Select or enter the RingCentral caller ID to use.";
  return "";
}

function saveSettings(values, callback) {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, () => {
      if (callback) callback();
      resolve();
    });
  });
}

function updateActiveLocationLabel(value) {
  const label = document.getElementById("activeLocationLabel");
  if (!label) return;
  label.textContent = value || "Detect from GHL";
}

function updateActiveUserLabel(agent) {
  const label = document.getElementById("activeUserLabel");
  if (!label) return;
  const name = agent?.agentName || "";
  const email = agent?.agentEmail || "";
  label.textContent = name && email ? `${name} (${email})` : name || email || "Detect from GHL";
}

function populateCallerIdSelect(callerIds, selectedPhone = "") {
  const select = document.getElementById("callerIdSelect");
  if (!select) return;

  select.innerHTML = '<option value="">Manual caller ID</option>';
  for (const callerId of callerIds || []) {
    if (!callerId.phoneNumber) continue;
    const option = document.createElement("option");
    option.value = callerId.phoneNumber;
    option.textContent = callerId.label && callerId.label !== callerId.phoneNumber
      ? `${callerId.label} (${callerId.phoneNumber})`
      : callerId.phoneNumber;
    select.appendChild(option);
  }

  const normalizedSelected = normalizePhone(selectedPhone);
  if (normalizedSelected && Array.from(select.options).some((option) => option.value === normalizedSelected)) {
    select.value = normalizedSelected;
    document.getElementById("agentPhone").value = normalizedSelected;
  } else {
    select.value = "";
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error("Open a GoHighLevel tab first.");
  return tab;
}

function isMissingContentScriptError(error) {
  return /Receiving end does not exist|Could not establish connection/i.test(error?.message || "");
}

async function injectContentScript(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["styles.css"]
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["location-utils.js", "phone-utils.js", "content.js"]
  });
}

async function sendToActiveTab(message) {
  const tab = await getActiveTab();

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    if (!isMissingContentScriptError(error)) throw error;
    await injectContentScript(tab.id);
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

async function bootstrapActiveLocationFromTab() {
  const response = await sendToActiveTab({ type: "rc-ghl-bootstrap-location" });
  if (!response?.ok) {
    throw new Error(response?.message || "Unable to detect the active GHL sub-account.");
  }

  currentAgent = {
    agentName: response.user?.name || "",
    agentKey: response.agentKey || response.user?.id || "",
    agentEmail: response.user?.email || ""
  };

  await chrome.storage.local.set({
    activeLocationId: response.locationId || "",
    activeLocationName: response.locationName || "",
    agentName: currentAgent.agentName,
    agentKey: currentAgent.agentKey,
    agentEmail: currentAgent.agentEmail
  });
  updateActiveLocationLabel(response.locationName || response.locationId || "");
  updateActiveUserLabel(currentAgent);
  return response;
}

async function fetchCallerIds(values) {
  const stored = await chrome.storage.local.get(["activeLocationId", "agentSessionToken"]);
  if (!stored.agentSessionToken || !stored.activeLocationId || !values.agentKey) return [];

  const response = await fetch(`${DEFAULT_BACKEND_URL}/api/extension/ringcentral/caller-ids`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CTI-Agent-Session": stored.agentSessionToken
    },
    body: JSON.stringify({
      locationId: stored.activeLocationId,
      agentKey: values.agentKey
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || data.error || "Unable to load RingCentral caller IDs.");
  return Array.isArray(data.callerIds) ? data.callerIds : [];
}

async function refreshCallerIds(values) {
  try {
    const callerIds = await fetchCallerIds(values);
    populateCallerIdSelect(callerIds, values.agentPhone);
    if (!values.agentPhone && callerIds[0]?.phoneNumber) {
      document.getElementById("agentPhone").value = callerIds[0].phoneNumber;
      await saveSettings({ ...values, agentPhone: callerIds[0].phoneNumber });
    }
    return callerIds;
  } catch (error) {
    populateCallerIdSelect([], values.agentPhone);
    return [];
  }
}

async function checkSetup() {
  let stored = await chrome.storage.local.get(["agentSessionToken", "pendingRingCentralAuthSessionId"]);

  if (stored.pendingRingCentralAuthSessionId) {
    await claimRingCentralSession(stored.pendingRingCentralAuthSessionId);
    stored = await chrome.storage.local.get(["agentSessionToken", "pendingRingCentralAuthSessionId"]);
  }

  const button = document.getElementById("checkSetupBtn");
  setButtonBusy(button, true, "Checking...");

  try {
    const data = await bootstrapActiveLocationFromTab();
    let values = formValues();
    const identityError = validateIdentity(values);
    if (identityError) throw new Error(identityError);

    await saveSettings(values);
    const callerIds = data.ringcentralConnected && data.agentSessionValid
      ? await refreshCallerIds(values)
      : [];
    values = formValues();

    const dialerReady = data.ringcentralConnected && data.agentSessionValid && !validateDialer(values);
    setStatus(
      dialerReady
        ? `Ready: ${data.locationName || data.locationId}, ${currentAgent.agentName || "GHL user"}, ${values.agentPhone}.`
        : data.ringcentralConnected && data.agentSessionValid
          ? `RingCentral is connected. ${callerIds.length ? "Select a caller ID." : "Enter a caller ID."}`
          : `Sub-account detected for ${currentAgent.agentName || "the current GHL user"}. Connect RingCentral next.`,
      dialerReady ? "success" : "warning"
    );
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setButtonBusy(button, false, "Check Setup");
  }
}

async function claimRingCentralSession(authSessionId) {
  const response = await fetch(`${DEFAULT_BACKEND_URL}/oauth/ringcentral/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authSessionId })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || data.error || "Unable to check RingCentral connection.");

  if (data.connected && data.agentSessionToken) {
    await chrome.storage.local.set({
      agentKey: data.agentKey || currentAgent.agentKey,
      agentSessionToken: data.agentSessionToken,
      pendingRingCentralAuthSessionId: ""
    });
  }

  return data.connected;
}

async function bootstrapPendingRingCentralSession() {
  const stored = await chrome.storage.local.get(["pendingRingCentralAuthSessionId"]);
  if (!stored.pendingRingCentralAuthSessionId) return;

  try {
    const connected = await claimRingCentralSession(stored.pendingRingCentralAuthSessionId);
    if (connected) setStatus("RingCentral connected. Run Check Setup to load caller IDs.", "success");
  } catch (error) {}
}

async function openManualDialer() {
  const button = document.getElementById("openDialerBtn");
  setButtonBusy(button, true, "Opening...");

  try {
    await bootstrapActiveLocationFromTab();
    const values = formValues();
    const error = validateDialer(values);
    if (error) throw new Error(error);

    await saveSettings(values);
    await sendToActiveTab({
      type: "rc-ghl-open-dialer",
      phone: ""
    });
    setStatus("Dialer opened in the active GHL tab.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setButtonBusy(button, false, "Open Dialer");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get(["agentName", "agentKey", "agentEmail", "agentPhone", "activeLocationId", "activeLocationName", "callMode"], (result) => {
    currentAgent = {
      agentName: result.agentName || "",
      agentKey: result.agentKey || "",
      agentEmail: result.agentEmail || ""
    };
    document.getElementById("agentPhone").value = result.agentPhone || "";
    document.getElementById("callMode").value = result.callMode || "ringout";
    updateActiveLocationLabel(result.activeLocationName || result.activeLocationId || "");
    updateActiveUserLabel(currentAgent);
    populateCallerIdSelect([], result.agentPhone || "");
  });

  bootstrapPendingRingCentralSession();

  document.getElementById("callerIdSelect").addEventListener("change", (event) => {
    if (event.target.value) document.getElementById("agentPhone").value = event.target.value;
  });

  document.getElementById("saveBtn").addEventListener("click", async () => {
    try {
      await bootstrapActiveLocationFromTab();
      const values = formValues();
      await saveSettings(values);
      setStatus("Settings saved.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  document.getElementById("checkSetupBtn").addEventListener("click", checkSetup);
  document.getElementById("openDialerBtn").addEventListener("click", openManualDialer);

  document.getElementById("connectRingCentralBtn").addEventListener("click", async () => {
    const button = document.getElementById("connectRingCentralBtn");
    setButtonBusy(button, true, "Opening...");

    try {
      const location = await bootstrapActiveLocationFromTab();
      const values = formValues();
      const error = validateIdentity(values);
      if (error) throw new Error(error);

      await saveSettings(values);
      const params = new URLSearchParams({ locationId: location.locationId || "", agentKey: values.agentKey });
      const response = await fetch(`${DEFAULT_BACKEND_URL}/oauth/ringcentral/start?${params.toString()}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error || "Unable to start RingCentral authorization.");

      await chrome.storage.local.set({ pendingRingCentralAuthSessionId: data.authSessionId || "" });
      chrome.tabs.create({ url: data.authorizationUrl });
      setStatus("RingCentral sign-in opened. After approving, return here and run Check Setup.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      setButtonBusy(button, false, "Connect RingCentral");
    }
  });
});
