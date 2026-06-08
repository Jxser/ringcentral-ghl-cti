# RingCentral GHL CTI

Backend service and Chrome extension for using RingCentral calls and SMS inside GoHighLevel.

Users work from a GHL contact record, call or text through RingCentral, and the app logs the activity back to the matching GHL contact with user attribution.

## How It Works

- The HighLevel Marketplace app is installed into each GHL sub-account/location.
- The backend stores HighLevel OAuth tokens per location.
- The Chrome extension reads the active GHL location and signed-in GHL user from the current tab.
- Each user connects RingCentral once from the extension.
- The user selects the RingCentral caller ID for outbound calls and SMS.
- Calls can run through RingOut or the browser Web Phone.
- The backend logs calls, SMS, notes, dispositions, metadata, and recordings into GHL Conversations.
- `backend/app-config.json` holds provider IDs, dispositions, scopes, and optional location overrides.
- `.env` holds deployment values and OAuth app credentials.

## Project Layout

- `backend/`: Node HTTP service for OAuth, RingCentral API calls, GHL activity logging, and webhooks.
- `extension/`: Chrome extension loaded into GHL/LeadConnector.
- `deploy/`: Docker Compose and Caddy deployment files for Hetzner.

## Docs

- [Backend setup](backend/README.md)
- [Hetzner deployment](deploy/README.md)

## Local Checks

```bash
cd backend
npm test
cd ..
node --test extension/test/*.test.js
```

The backend uses built-in Node APIs only, so there is no backend install step.
