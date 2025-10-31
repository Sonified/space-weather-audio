#!/bin/bash
# Start Flask server on port 5005 for Simple_IRIS_Data_Audification.html

echo "🚀 Starting Flask server on port 5005..."
echo "=================================="
echo ""
echo "Server will run on: http://localhost:5005"
echo ""
echo "For Simple_IRIS_Data_Audification.html"
echo ""
echo "Press Ctrl+C to stop"
echo ""
echo "=================================="
echo ""

# Set Flask environment variables
export FLASK_APP=main.py
export FLASK_ENV=development
export FLASK_DEBUG=1
export PORT=5005

# Run Flask
cd "$(dirname "$0")"
python main.py

