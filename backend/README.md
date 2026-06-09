# Backend

Node service for RingCentral OAuth, HighLevel OAuth, token storage, calls, SMS, webhooks, and GHL conversation activity logging.

## Commands

```bash
npm test
npm run config:doctor
npm start
```

The backend uses built-in Node APIs. There is no install step for local backend checks.

## Runtime Config

Deployment secrets and environment-specific values live in `.env`:

```env
PORT=8080
PUBLIC_BASE_URL=https://cti.example.com
TOKEN_STORE_PATH=/data/ringcentral-tokens.json
CORS_ORIGINS=https://*.gohighlevel.com,https://*.leadconnectorhq.com
GHL_OAUTH_CLIENT_ID=<HighLevel Marketplace app client id>
GHL_OAUTH_CLIENT_SECRET=<HighLevel Marketplace app client secret>
GHL_OAUTH_USER_TYPE=Location
GHL_APP_ID=<HighLevel Marketplace app id>
GHL_APP_SHARED_SECRET=<HighLevel Marketplace shared secret>
RINGCENTRAL_SERVER_URL=https://platform.ringcentral.com
RINGCENTRAL_CLIENT_ID=<RingCentral OAuth app client id>
RINGCENTRAL_CLIENT_SECRET=<RingCentral OAuth app client secret>
RINGCENTRAL_EXTENSION_ID=~
APP_CONFIG_PATH=/run/secrets/app_config_json
```

`GHL_APP_ID` and `GHL_APP_SHARED_SECRET` let the backend verify the signed-in GHL user sent by the Chrome extension.

## App Config

Provider IDs, dispositions, and per-location overrides live in `backend/app-config.json`.

```json
{
  "defaults": {
    "dispositions": ["Connected", "Completed", "Busy", "No Answer", "Left Voicemail", "Failed", "Canceled"],
    "ghl": {
      "callConversationProviderId": "replace-with-call-conversation-provider-id",
      "smsConversationProviderId": "replace-with-sms-conversation-provider-id"
    },
    "ringcentral": {
      "serverUrl": "https://platform.ringcentral.com",
      "extensionId": "~"
    }
  },
  "locations": {}
}
```

Most locations should use the shared defaults. Add a key under `locations` only when one GHL location needs different provider IDs or dispositions.

RingCentral client ID and client secret stay in `.env`, not this file.

Run this before starting the stack:

```bash
npm run config:doctor
```

## HighLevel

Marketplace app URLs:

```text
OAuth redirect URL:
https://cti.example.com/oauth/callback

External auth verify URL:
https://cti.example.com/external-auth/verify

App install webhook URL:
https://cti.example.com/webhooks/highlevel/install
```

Use OAuth user type `Location` and install the app into each sub-account using the CTI.

The app needs scopes for contacts, conversations/messages, provider message writes, user lookup, and location-token exchange. `users.readonly` is needed for reliable user attribution when the signed-in GHL user has to be resolved to a location user. `oauth.write` is needed when an agency install is exchanged for sub-account/location tokens.

## RingCentral

RingCentral OAuth app:

```text
Redirect URI:
https://cti.example.com/oauth/ringcentral/callback
```

Set these permissions on the RingCentral OAuth app in the RingCentral Developer Console:

```text
RingOut
SMS
ReadAccounts
VoIP Calling
WebSocket Subscriptions
ReadMessages
ReadCallLog
ReadCallRecording
SubscriptionWebhook
```

Webhook delivery:

```text
https://cti.example.com/webhooks/ringcentral/<ghl-location-id>
```

## Multi-sub-account model

One Marketplace app install serves many GHL sub-accounts (locations):

- The agency OAuth install is exchanged for per-location tokens via `/oauth/locationToken` (driven by the app-install webhook). Each location's GHL token is stored independently.
- Each agent's RingCentral grant is stored per `(location, GHL user id)`, so RingOut/SMS always run from the signed-in agent's own RingCentral extension.
- The signed-in GHL user is taken from the Marketplace SSO user context, then resolved to a **location** user (via email lookup) before being attached to any activity. The raw SSO id can be an agency-level user that GHL rejects with a 422, so it is never sent as a message `userId` unless verified, and contact/conversation ownership only uses verified ids.
- `conversationProviderId` comes from `defaults.ghl` and applies to every location unless a `locations` override is set. Use the app-level conversation provider so the same id is valid in all sub-accounts.

## Reliability

- **Token store** writes are serialized and written atomically (temp file + rename), so concurrent agents/locations can't clobber each other's tokens or read a half-written file.
- **GHL tokens** refresh automatically on any `401` when a refresh token is held, and requests retry on `429` honoring `Retry-After`. GHL errors propagate their real HTTP status (e.g. a `422` reaches the extension with GHL's own message).
- **RingCentral tokens** refresh proactively; a failed refresh (expired/rotated grant) surfaces as `ringcentral_reauth_required` so the agent is prompted to reconnect instead of the backend retrying a dead grant.
- **Owner assignment** only fills an empty contact owner, so an outbound touch never steals a lead already owned by another agent. Assignment failures are logged rather than silently swallowed.

## Notes

The Chrome extension stores user/session state, selected caller ID, and non-secret preferences. OAuth tokens and app credentials stay on the backend.

Call notes and dispositions are sent with the GHL conversation-provider activity payload. Native LC Phone disposition records are not exposed as writable records through the public APIs this app uses.
