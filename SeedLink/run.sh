#!/bin/bash
# Quick launch script for SeedLink real-time audification

echo "🌋 Starting SeedLink Real-Time Audification"
echo "=========================================="
echo ""
echo "Dashboard will be available at:"
echo "http://localhost:8888 (or open dashboard.html directly)"
echo ""
echo "Press Ctrl+C to stop"
echo ""

cd "$(dirname "$0")"

# Check if requirements are installed
if ! python -c "import obspy" 2>/dev/null; then
    echo "⚠️  Dependencies not found. Installing..."
    pip install -r requirements.txt
fi

# Run the audifier
python live_audifier.py

