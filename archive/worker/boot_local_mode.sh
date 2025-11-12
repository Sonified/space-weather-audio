#!/bin/bash

echo "🚀 Starting Local Mode..."
echo "================================"

# Kill any existing processes
echo "🧹 Cleaning up existing processes..."
pkill -9 -f "wrangler dev" 2>/dev/null
pkill -9 -f "backend/main.py" 2>/dev/null
sleep 2

# Get the script's directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Clear old logs
> /tmp/wrangler.log
> /tmp/flask.log

# Start R2 Worker
echo "📡 Starting R2 Worker on localhost:8787..."
cd "$SCRIPT_DIR/worker" && npx wrangler dev --port 8787 > /tmp/wrangler.log 2>&1 &
WORKER_PID=$!

# Wait for worker to start
echo "   Waiting for R2 Worker to start..."
sleep 3

# Start Flask Backend
echo "🐍 Starting Flask Backend on localhost:5001..."
cd "$SCRIPT_DIR" && python3 backend/main.py > /tmp/flask.log 2>&1 &
FLASK_PID=$!

# Wait for Flask to fully load (ObsPy, boto3, etc. take time)
echo "   Waiting for Flask to load dependencies..."
sleep 6

echo ""
echo "================================"
echo "🔍 Checking Service Status..."
echo "================================"

# Check R2 Worker
WORKER_RUNNING=false
if lsof -i :8787 2>/dev/null | grep -q LISTEN; then
    echo "✅ R2 Worker:      http://localhost:8787 (RUNNING)"
    WORKER_RUNNING=true
else
    echo "❌ R2 Worker:      FAILED TO START"
    echo ""
    echo "📋 R2 Worker Logs (last 20 lines):"
    echo "-----------------------------------"
    tail -20 /tmp/wrangler.log
    echo "-----------------------------------"
    echo ""
fi

# Check Flask Backend
FLASK_RUNNING=false
if lsof -i :5001 2>/dev/null | grep -q LISTEN; then
    echo "✅ Flask Backend:  http://localhost:5001 (RUNNING)"
    FLASK_RUNNING=true
else
    echo "❌ Flask Backend:  FAILED TO START"
    echo ""
    echo "📋 Flask Logs (last 30 lines):"
    echo "-----------------------------------"
    tail -30 /tmp/flask.log
    echo "-----------------------------------"
    echo ""
fi

echo ""
echo "================================"

if [ "$WORKER_RUNNING" = true ] && [ "$FLASK_RUNNING" = true ]; then
    echo "✅ All Services Running Successfully!"
    echo ""
    echo "View Live Logs:"
    echo "   Worker: tail -f /tmp/wrangler.log"
    echo "   Flask:  tail -f /tmp/flask.log"
    echo ""
    echo "To stop all services:"
    echo "   pkill -9 -f 'wrangler dev'"
    echo "   pkill -9 -f 'backend/main.py'"
    echo ""
    echo "✅ All systems go!"
    echo "🎯 Ready to test! Open pipeline_dashboard.html"
else
    echo "⚠️  Some services failed to start. Check logs above."
    echo ""
    echo "📋 Troubleshooting:"
    if [ "$WORKER_RUNNING" = false ]; then
        echo "   • R2 Worker: Check Node.js/npm installation"
        echo "   • Full logs: tail -f /tmp/wrangler.log"
    fi
    if [ "$FLASK_RUNNING" = false ]; then
        echo "   • Flask: Check Python dependencies"
        echo "   • Install: pip3 install -r backend/requirements.txt"
        echo "   • Full logs: tail -f /tmp/flask.log"
    fi
    exit 1
fi

