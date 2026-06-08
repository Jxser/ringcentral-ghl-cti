(async () => {
  const script = document.currentScript;
  const requestId = script?.dataset.requestId || "";
  const appId = script?.dataset.appId || "";

  try {
    if (!appId) throw new Error("HighLevel app id is missing.");
    if (typeof window.exposeSessionDetails !== "function") {
      throw new Error("HighLevel session details are unavailable on this page.");
    }

    const encryptedData = await window.exposeSessionDetails(appId);
    window.postMessage({
      source: "rc-ghl-page-context",
      type: "rc-ghl-session-details",
      requestId,
      encryptedData
    }, window.location.origin);
  } catch (error) {
    const status = error?.response?.status || error?.status || "";
    const responseData = error?.response?.data;
    const detail = responseData?.message || responseData?.error || responseData?.error_description || "";
    window.postMessage({
      source: "rc-ghl-page-context",
      type: "rc-ghl-session-details-error",
      requestId,
      status,
      message: detail || error.message || "HighLevel session details request failed."
    }, window.location.origin);
  } finally {
    script?.remove();
  }
})();
