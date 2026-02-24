#!/usr/bin/env python3
"""
Tiny presigned URL server for R2 audification testing.
Generates time-limited presigned URLs for emic-data bucket objects.

Usage:
    python3 tests/browser/presign_server.py

Then open tests/browser/test_r2_audification.html in a browser.
"""

import json
import os
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import boto3
from dotenv import load_dotenv

load_dotenv()  # Load .env from project root

R2_ACCOUNT_ID = os.getenv("R2_ACCOUNT_ID")
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID")
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY")
R2_BUCKET = "emic-data"

s3 = boto3.client(
    "s3",
    endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    region_name="auto",
)


class PresignHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/presign":
            params = parse_qs(parsed.query)
            key = params.get("key", [None])[0]

            if not key:
                self._json({"error": "missing ?key= parameter"}, 400)
                return

            try:
                url = s3.generate_presigned_url(
                    "get_object",
                    Params={"Bucket": R2_BUCKET, "Key": key},
                    ExpiresIn=3600,
                )
                self._json({"url": url, "key": key, "expires_in": 3600})
            except Exception as e:
                self._json({"error": str(e)}, 500)
        else:
            self._json({"error": "use /presign?key=..."}, 404)

    def _json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        print(f"  {args[0]}")


if __name__ == "__main__":
    port = 8765
    server = HTTPServer(("localhost", port), PresignHandler)
    print(f"Presign server running on http://localhost:{port}")
    print(f"  GET /presign?key=data/2022/01/21/GOES-16/mag/bx/metadata.json")
    print(f"\nOpen test_r2_audification.html in your browser to test.")
    server.serve_forever()
