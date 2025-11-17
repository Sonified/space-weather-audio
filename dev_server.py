#!/usr/bin/env python3
"""
Development server with Cross-Origin headers for SharedArrayBuffer support.
Run with: python3 dev_server.py
"""
import http.server
import socketserver
import os
import json
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

PORT = 8001

class CORSRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Required for SharedArrayBuffer
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        
        # Allow loading resources from CDN
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        
        # Standard headers
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()
    
    def do_OPTIONS(self):
        """Handle preflight requests"""
        self.send_response(200)
        self.end_headers()
    
    def do_GET(self):
        """Handle GET requests"""
        # Inject .env variables into index.html
        if self.path == '/' or self.path == '/index.html':
            try:
                index_path = Path(__file__).parent / 'index.html'
                if index_path.exists():
                    with open(index_path, 'r', encoding='utf-8') as f:
                        html_content = f.read()
                    
                    # Inject mode selector secret from .env (same pattern as R2 keys)
                    # Loads from .env file via load_dotenv() at top of file
                    # Defaults to 'dvdv' if not set in .env
                    mode_selector_secret = os.getenv('MODE_SELECTOR_SECRET', 'dvdv')
                    injection_script = f'''
    <script>
        // Injected from .env file via dev_server.py
        window.MODE_SELECTOR_SECRET = '{mode_selector_secret}';
    </script>'''
                    
                    # Inject before closing </body> tag
                    html_content = html_content.replace('</body>', injection_script + '\n</body>')
                    
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/html')
                    self.end_headers()
                    self.wfile.write(html_content.encode('utf-8'))
                    return
            except Exception as e:
                print(f"❌ Error injecting env vars into HTML: {e}")
                # Fall through to default file serving
        
        # Default to file serving
        super().do_GET()
    
    def do_POST(self):
        """Handle POST requests for saving Qualtrics response metadata"""
        if self.path == '/api/save-qualtrics-response':
            try:
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data.decode('utf-8'))
                
                # Extract filename and content
                filename = data.get('filename', 'qualtrics_response.json')
                content = data.get('content', {})
                
                # Save to Qualtrics folder
                qual_folder = Path(__file__).parent / 'Qualtrics'
                qual_folder.mkdir(exist_ok=True)
                file_path = qual_folder / filename
                
                with open(file_path, 'w', encoding='utf-8') as f:
                    json.dump(content, f, indent=2, ensure_ascii=False)
                
                # Send success response
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                response = {'success': True, 'path': str(file_path)}
                self.wfile.write(json.dumps(response).encode('utf-8'))
                
                print(f"💾 Saved Qualtrics response to: {file_path}")
                
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                response = {'success': False, 'error': str(e)}
                self.wfile.write(json.dumps(response).encode('utf-8'))
                print(f"❌ Error saving Qualtrics response: {e}")
        else:
            # Default to file serving
            super().do_GET()

def run_server():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    
    with socketserver.TCPServer(("", PORT), CORSRequestHandler) as httpd:
        print(f"🚀 Development server running at http://localhost:{PORT}")
        print(f"✅ SharedArrayBuffer enabled (COOP/COEP headers active)")
        print(f"📂 Serving from: {os.getcwd()}")
        print(f"\n🔗 Open: http://localhost:{PORT}\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n\n✋ Server stopped.")

if __name__ == "__main__":
    run_server()

