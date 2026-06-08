const MENU_ID = "rc-ghl-open-dialer";

function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Open RingCentral dialer",
      contexts: ["selection", "link"]
    });
  });
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

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!isMissingContentScriptError(error)) throw error;
    await injectContentScript(tabId);
    return chrome.tabs.sendMessage(tabId, message);
  }
}

chrome.runtime.onInstalled.addListener(createContextMenu);
chrome.runtime.onStartup.addListener(createContextMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;

  sendToTab(tab.id, {
    type: "rc-ghl-open-dialer",
    phone: info.selectionText || info.linkUrl || ""
  }).catch(() => {});
});
