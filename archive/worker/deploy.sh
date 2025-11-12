#!/bin/bash
# Deploy R2 Worker to Cloudflare

set -e  # Exit on error

echo "🚀 Deploying R2 Worker to Cloudflare..."
echo ""

# Check if wrangler.toml exists
if [ ! -f "wrangler.toml" ]; then
    echo "⚠️  wrangler.toml not found!"
    echo ""
    echo "Creating from example..."
    cp wrangler-r2-example.toml wrangler.toml
    echo ""
    echo "❌ STOP! You need to edit wrangler.toml first:"
    echo ""
    echo "1. Open worker/wrangler.toml"
    echo "2. Replace YOUR_ACCOUNT_ID_HERE with your actual Cloudflare account ID"
    echo "   (Find it at: https://dash.cloudflare.com - it's in the URL or sidebar)"
    echo ""
    echo "Then run this script again!"
    exit 1
fi

# Check if account_id is still the placeholder
if grep -q "YOUR_ACCOUNT_ID_HERE" wrangler.toml; then
    echo "❌ ERROR: You haven't updated the account_id in wrangler.toml yet!"
    echo ""
    echo "Please edit wrangler.toml and replace:"
    echo "  account_id = \"YOUR_ACCOUNT_ID_HERE\""
    echo ""
    echo "With your actual Cloudflare account ID."
    echo "(Find it at: https://dash.cloudflare.com)"
    exit 1
fi

echo "✅ Configuration looks good!"
echo ""

# Check if logged in
echo "🔐 Checking Cloudflare authentication..."
if ! wrangler whoami >/dev/null 2>&1; then
    echo "❌ Not logged in to Cloudflare!"
    echo ""
    echo "Please run: wrangler login"
    echo "Then try again."
    exit 1
fi

echo "✅ Authenticated!"
echo ""

# Deploy!
echo "📤 Deploying worker..."
wrangler deploy r2-worker-example.js

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📋 Next steps:"
echo "1. Copy the worker URL from above (e.g., https://volcano-audio-r2-worker.your-subdomain.workers.dev)"
echo "2. Edit index.html line ~2025:"
echo "   const R2_WORKER_URL = 'https://your-actual-url.workers.dev';"
echo "3. Upload some test data to R2 (or use Railway backend to generate it)"
echo "4. Set a station to active: true in backend/stations_config.json"
echo "5. Test it out!"
echo ""

