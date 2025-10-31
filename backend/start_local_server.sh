#!/bin/bash
# Start Flask server locally for testing audio streaming

echo "🚀 Starting local Flask server..."
echo "=================================="
echo ""
echo "Server will run on: http://localhost:5001"
echo ""
echo "To test:"
echo "  1. Wait for server to start"
echo "  2. In another terminal: cd backend && python test_audio_stream_local.py"
echo "  3. Or open test_audio_stream.html in your browser"
echo ""
echo "Press Ctrl+C to stop"
echo ""
echo "=================================="
echo ""

# Set Flask environment variables
export FLASK_APP=main.py
export FLASK_ENV=development
export FLASK_DEBUG=1

# Run Flask
cd "$(dirname "$0")"
python main.py


