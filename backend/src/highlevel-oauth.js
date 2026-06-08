const DEFAULT_HIGHLEVEL_BASE_URL = "https://services.leadconnectorhq.com";

async function exchangeHighLevelAuthorizationCode({
  baseUrl = DEFAULT_HIGHLEVEL_BASE_URL,
  clientId,
  clientSecret,
  code,
  redirectUri,
  userType = "Location",
  fetchImpl = fetch
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    user_type: userType
  });

  return tokenRequest(baseUrl, body, fetchImpl);
}

async function refreshHighLevelToken({
  baseUrl = DEFAULT_HIGHLEVEL_BASE_URL,
  clientId,
  clientSecret,
  refreshToken,
  userType = "Location",
  fetchImpl = fetch
}) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    user_type: userType
  });

  return tokenRequest(baseUrl, body, fetchImpl);
}

async function getHighLevelLocationToken({
  baseUrl = DEFAULT_HIGHLEVEL_BASE_URL,
  accessToken,
  companyId,
  locationId,
  fetchImpl = fetch
}) {
  const body = new URLSearchParams({
    companyId,
    locationId
  });

  const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/oauth/locationToken`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: "2023-02-21",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }

  if (!response.ok) {
    const detail = payload?.message || payload?.error || response.statusText || "HighLevel location token request failed";
    const error = new Error(`HighLevel location token ${response.status}: ${Array.isArray(detail) ? detail.join(", ") : detail}`);
    error.status = response.status;
    error.code = "highlevel_location_token_error";
    throw error;
  }

  return payload;
}

async function tokenRequest(baseUrl, body, fetchImpl) {
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }

  if (!response.ok) {
    const detail = payload?.message || payload?.error || response.statusText || "HighLevel OAuth request failed";
    throw new Error(`HighLevel OAuth ${response.status}: ${detail}`);
  }

  return payload;
}

module.exports = {
  exchangeHighLevelAuthorizationCode,
  getHighLevelLocationToken,
  refreshHighLevelToken
};
