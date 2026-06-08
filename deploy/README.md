# Hetzner Deployment

This runs the CTI backend with Docker Compose and Caddy.

## Server

Use Ubuntu 24.04 LTS, Docker, and a DNS record pointing to the server.

Open these inbound ports:

- `22/tcp`
- `80/tcp`
- `443/tcp`

## Install Docker

```bash
ssh root@<server-ip>
apt update
apt install -y ca-certificates curl git ufw
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

## Clone

```bash
mkdir -p /opt/cti
git clone git@github.com:aultcapitalgroup/ringcentral-ghl-cti.git /opt/cti
cd /opt/cti
cp deploy/env.example .env
cp backend/app-config.example.json backend/app-config.json
```

## Configure `.env`

```bash
nano .env
```

Set:

```env
CTI_DOMAIN=cti.yourdomain.com
PUBLIC_BASE_URL=https://cti.yourdomain.com
ACME_EMAIL=admin@yourdomain.com
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
```

## Configure `backend/app-config.json`

```bash
nano backend/app-config.json
```

Set the shared provider values:

- `defaults.ghl.callConversationProviderId`
- `defaults.ghl.smsConversationProviderId`

Leave `locations` empty unless a specific GHL location needs different provider IDs or dispositions.

## Check Config

```bash
docker compose build backend
docker compose run --rm --no-deps backend npm run config:doctor
```

If anything is missing, the command prints the field names. It does not print secret values.

## HighLevel

Marketplace app settings:

```text
OAuth user type:
Location

OAuth redirect URL:
https://cti.yourdomain.com/oauth/callback

External auth verify URL:
https://cti.yourdomain.com/external-auth/verify

App install webhook URL:
https://cti.yourdomain.com/webhooks/highlevel/install
```

Install the app into each sub-account/location using the CTI.

Scopes needed:

- `conversations/message.write`
- `conversations/message.readonly`
- `conversations.readonly`
- `conversations.write`
- `contacts.readonly`
- `contacts.write`
- `users.readonly`
- `oauth.write`

## RingCentral

Create a RingCentral OAuth app using Authorization Code flow.

Redirect URI:

```text
https://cti.yourdomain.com/oauth/ringcentral/callback
```

Set these permissions on the RingCentral OAuth app:

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

Webhook delivery URL:

```text
https://cti.yourdomain.com/webhooks/ringcentral/<ghl-location-id>
```

Subscribe to the RingCentral events needed for inbound calls, outbound completion, recordings, and SMS.

## Start

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f backend
```

Health check:

```bash
curl https://cti.yourdomain.com/health
```

Expected:

```json
{"ok":true}
```

## Chrome Extension

Load the repo's `extension` folder in Chrome:

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click Load unpacked
4. Select the `extension` folder

For each user:

1. Open the target GHL sub-account.
2. Open the extension popup.
3. Connect RingCentral.
4. Select caller ID.
5. Choose RingOut or Web Phone.
6. Run Check Setup if needed.

## Updates

```bash
cd /opt/cti
git pull
docker compose build backend
docker compose run --rm --no-deps backend npm run config:doctor
docker compose up -d --build
docker compose logs -f backend
```

Back up server-only config:

```bash
cp backend/app-config.json /root/cti-app-config.backup.json
```
