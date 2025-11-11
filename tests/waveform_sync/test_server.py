#!/usr/bin/env python3
"""
Simple HTTP server for waveform sync tests on port 8082
"""

import http.server
import socketserver
import os
import sys

PORT = 8082

class CORSRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

def run_server():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    
    with socketserver.TCPServer(("", PORT), CORSRequestHandler) as httpd:
        print(f"🧪 Test server running at http://localhost:{PORT}/", flush=True)
        print(f"📊 Open: http://localhost:{PORT}/test_player.html", flush=True)
        print(f"📂 Serving from: {os.getcwd()}", flush=True)
        print("Press Ctrl+C to stop\n", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n👋 Server stopped", flush=True)

if __name__ == "__main__":
    run_server()
