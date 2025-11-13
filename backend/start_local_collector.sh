#!/bin/bash
# Start data collector (cron loop) locally for testing

echo "🚀 Starting local data collector (cron loop)..."
echo "=================================="
echo ""

# Clean up any existing processes
echo "🧹 Cleaning up existing collector processes..."

# Kill any collector_loop.py processes
if pgrep -f "python.*collector_loop.py" >/dev/null 2>&1; then
    echo "   Killing collector_loop.py processes..."
    pkill -9 -f "python.*collector_loop.py" 
    sleep 1
fi

# Kill any standalone cron_job.py processes (shouldn't exist, but just in case)
if pgrep -f "python.*cron_job.py" >/dev/null 2>&1; then
    echo "   Killing stray cron_job.py processes..."
    pkill -9 -f "python.*cron_job.py" 
    sleep 1
fi

# Kill any process on port 5005
if lsof -ti:5005 >/dev/null 2>&1; then
    echo "   Killing process on port 5005..."
    lsof -ti:5005 | xargs kill -9 2>/dev/null
    sleep 1
fi

# Wait for port to actually be free (with timeout)
echo "   Waiting for port 5005 to be free..."
MAX_WAIT=10
WAITED=0
while lsof -ti:5005 >/dev/null 2>&1; do
    if [ $WAITED -ge $MAX_WAIT ]; then
        echo "   ⚠️  Warning: Port still in use after ${MAX_WAIT}s, trying anyway..."
        break
    fi
    sleep 1
    WAITED=$((WAITED + 1))
    echo "   Still waiting... (${WAITED}s)"
done

if ! lsof -ti:5005 >/dev/null 2>&1; then
    echo "   ✅ Port 5005 is free"
else
    echo "   ⚠️  Port may still be in use"
fi

echo ""
echo "Server will run on: http://localhost:5005"
echo ""
echo "Endpoints:"
echo "  - http://localhost:5005/health"
echo "  - http://localhost:5005/status"
echo "  - http://localhost:5005/stations"
echo "  - http://localhost:5005/validate/24h"
echo ""
echo "Press Ctrl+C to stop"
echo ""
echo "=================================="
echo ""

# Run collector loop on port 5005
# Force R2 uploads even in local mode so backfills save to R2
cd "$(dirname "$0")"
PORT=5005 FORCE_R2_UPLOAD=true python3 collector_loop.py