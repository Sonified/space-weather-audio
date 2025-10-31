#!/bin/bash

echo "🌋 Starting SeedLink Live Audifier..."
echo "================================"

# Kill any existing processes
echo "🧹 Cleaning up existing processes..."
pkill -9 -f "live_audifier.py" 2>/dev/null
sleep 1

# Get the script's directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Clear old log
> /tmp/seedlink_audifier.log

# Start SeedLink Audifier
echo "🔊 Starting SeedLink Audifier on localhost:8888..."
cd "$SCRIPT_DIR" && conda run -n plotbot_anaconda python live_audifier.py > /tmp/seedlink_audifier.log 2>&1 &
AUDIFIER_PID=$!

# Wait for audifier to load (ObsPy takes time)
echo "   Waiting for backend to load dependencies..."
MAX_WAIT=15
WAIT_COUNT=0

while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
    if lsof -i :8888 2>/dev/null | grep -q LISTEN; then
        break
    fi
    sleep 1
    WAIT_COUNT=$((WAIT_COUNT + 1))
done

echo ""
echo "================================"
echo "🔍 Checking Service Status..."
echo "================================"

# Check SeedLink Audifier
AUDIFIER_RUNNING=false
if lsof -i :8888 2>/dev/null | grep -q LISTEN; then
    echo "✅ SeedLink Audifier:  http://localhost:8888 (RUNNING)"
    AUDIFIER_RUNNING=true
else
    echo "❌ SeedLink Audifier:  FAILED TO START"
    echo ""
    echo "📋 Audifier Logs (last 30 lines):"
    echo "-----------------------------------"
    tail -30 /tmp/seedlink_audifier.log
    echo "-----------------------------------"
    echo ""
fi

echo ""
echo "================================"

if [ "$AUDIFIER_RUNNING" = true ]; then
    echo "✅ Service Running Successfully!"
    echo ""
    echo "📡 Dashboard: http://localhost:8888"
    echo ""
    echo "View Live Logs:"
    echo "   tail -f /tmp/seedlink_audifier.log"
    echo ""
    echo "To stop:"
    echo "   • Click 'Stop Backend' button on dashboard"
    echo "   • Or run: pkill -f 'live_audifier.py'"
    echo ""
    echo "✅ Ready to monitor seismic data!"
else
    echo "⚠️  Service failed to start. Check logs above."
    echo ""
    echo "📋 Troubleshooting:"
    echo "   • Check conda environment: conda env list"
    echo "   • Install dependencies: pip install -r requirements.txt"
    echo "   • Full logs: tail -f /tmp/seedlink_audifier.log"
    exit 1
fi

