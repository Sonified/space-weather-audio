# CDN Cache Purge Worker

This Cloudflare Worker provides a secure endpoint for purging the CDN cache from the frontend without exposing API credentials.

## Why a Worker?

- **CORS**: Cloudflare API doesn't allow direct browser requests
- **Security**: API tokens should never be exposed in frontend code
- **Simplicity**: Provides a clean endpoint for the frontend to call

## Setup Instructions

### 1. Get Your Cloudflare Credentials

You need two pieces of information:

**Zone ID:**
1. Log into Cloudflare dashboard
2. Select your domain (e.g., `now.audio`)
3. Copy the Zone ID from the right sidebar under "API"

**API Token:**
1. Go to: https://dash.cloudflare.com/profile/api-tokens
2. Click "Create Token"
3. Use the "Edit zone DNS" template, or create custom with:
   - Permissions: Zone → Cache Purge → Purge
   - Zone Resources: Include → Specific zone → [your zone]
4. Copy the token (you'll only see it once!)

### 2. Deploy the Worker

From the `worker/` directory:

```bash
# Install Wrangler if you haven't already
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Deploy the worker
wrangler deploy --config wrangler-purge.toml

# You'll get a URL like:
# https://volcano-audio-cache-purge.YOUR_SUBDOMAIN.workers.dev
```

### 3. Set Environment Variables (Secrets)

```bash
# Set the API token (will prompt for value)
wrangler secret put CLOUDFLARE_API_TOKEN --config wrangler-purge.toml

# Set the Zone ID (will prompt for value)
wrangler secret put CLOUDFLARE_ZONE_ID --config wrangler-purge.toml
```

### 4. Update Frontend

In `index.html`, update the `WORKER_URL` constant (around line 4378):

```javascript
const WORKER_URL = 'https://volcano-audio-cache-purge.YOUR_SUBDOMAIN.workers.dev';
```

Replace with your actual worker URL from step 2.

### 5. (Optional) Set Up Custom Domain

Instead of using the `workers.dev` subdomain, you can use a custom route:

1. In `wrangler-purge.toml`, add:
   ```toml
   routes = [
     { pattern = "purge.now.audio", custom_domain = true }
   ]
   ```

2. Deploy again:
   ```bash
   wrangler deploy --config wrangler-purge.toml
   ```

3. Update frontend to use: `https://purge.now.audio`

## Testing

Once deployed, you can test the worker:

```bash
# Using curl
curl -X POST https://volcano-audio-cache-purge.YOUR_SUBDOMAIN.workers.dev

# Should return:
# {"success":true,"message":"CDN cache purged successfully","timestamp":"2025-..."}
```

Or just click the "🗑️ Purge CDN Cache" button in the app!

## Security Notes

- ✅ API token is stored as a worker secret (encrypted, never exposed)
- ✅ CORS headers allow frontend to call the worker
- ✅ Only POST requests are accepted
- ✅ Worker validates all responses from Cloudflare API

## Troubleshooting

**"Missing API token or Zone ID"**
- Make sure you ran both `wrangler secret put` commands
- Secrets are per-environment (if you have staging/production, set for both)

**"Worker not found"**
- Check the worker URL matches what you deployed
- Make sure the worker is deployed: `wrangler deployments list --config wrangler-purge.toml`

**"Purge failed"**
- Check the worker logs: `wrangler tail --config wrangler-purge.toml`
- Verify your API token has cache purge permissions
- Verify the Zone ID is correct

