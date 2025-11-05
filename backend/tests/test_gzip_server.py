#!/usr/bin/env python3
"""
Standalone Gzip test server - DOES NOT TOUCH MAIN.PY
Runs on port 8002 to avoid conflicts
"""
from flask import Flask, Response
from flask_cors import CORS
import numpy as np
import gzip
import os

app = Flask(__name__)
CORS(app)

@app.route('/api/test-gzip-compress', methods=['GET'])
def test_gzip_compress():
    """Simple test endpoint that returns gzip-compressed int32 data"""
    
    # Check if test file exists, if not create it
    test_file = os.path.join(os.path.dirname(__file__), 'test_gzip.bin.gz')
    
    if not os.path.exists(test_file):
        print("Creating test gzip file...")
        # Create test data (sequential for easy verification)
        data = np.arange(100000, dtype=np.int32)
        raw_bytes = data.tobytes()
        
        # Compress with gzip level 1
        compressed = gzip.compress(raw_bytes, compresslevel=1)
        
        # Save to file
        with open(test_file, 'wb') as f:
            f.write(compressed)
        
        print(f"  Created test file:")
        print(f"    Original: {len(raw_bytes)} bytes")
        print(f"    Compressed: {len(compressed)} bytes")
        print(f"    Ratio: {len(compressed)/len(raw_bytes)*100:.1f}%")
        print(f"    File: {test_file}")
    
    # Read and serve the file
    with open(test_file, 'rb') as f:
        compressed = f.read()
    
    print(f"\nServing gzip test file:")
    print(f"  Size: {len(compressed)} bytes")
    print(f"  First 32 bytes (hex): {compressed[:32].hex()}")
    print(f"  Last 32 bytes (hex): {compressed[-32:].hex()}")
    
    return Response(
        compressed,
        mimetype='application/octet-stream',
        headers={
            'Access-Control-Allow-Origin': '*',
            'Content-Length': str(len(compressed)),
            'X-Compression': 'gzip-level-1'
        }
    )

if __name__ == '__main__':
    print("="*70)
    print("GZIP TEST SERVER")
    print("="*70)
    print("Running on http://localhost:8002")
    print("Endpoint: http://localhost:8002/api/test-gzip-compress")
    print("="*70)
    app.run(host='0.0.0.0', port=8002, debug=False, use_reloader=False)

