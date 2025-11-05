#!/bin/bash
# Start data collector (cron loop) locally for testing

echo "🚀 Starting local data collector (cron loop)..."
echo "=================================="
echo ""

# Clean up any existing process on port 5005
echo "🧹 Cleaning up existing processes on port 5005..."
lsof -ti:5005 | xargs kill -9 2>/dev/null || true
sleep 1

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
echo "Note: Using port 5005 (port 5000 blocked by macOS AirPlay)"
echo ""
echo "=================================="
echo ""

# Run cron loop on port 5005
cd "$(dirname "$0")"
PORT=5005 python cron_loop.py

