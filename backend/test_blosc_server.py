#!/usr/bin/env python3
"""
Standalone Blosc test server - DOES NOT TOUCH MAIN.PY
Runs on port 8001 to avoid conflicts
"""
from flask import Flask, Response
from flask_cors import CORS
import numpy as np
from numcodecs import Blosc
import os

app = Flask(__name__)
CORS(app)

@app.route('/api/test-blosc-compress', methods=['GET'])
def test_blosc_compress():
    """Simple test endpoint that returns blosc-compressed int32 data"""
    
    # Check if test file exists, if not create it
    test_file = os.path.join(os.path.dirname(__file__), 'test_blosc.bin')
    
    if not os.path.exists(test_file):
        print("Creating test blosc file...")
        # Create test data (sequential for easy verification)
        data = np.arange(100000, dtype=np.int32)
        
        # Compress with blosc (zstd codec, level 5)
        codec = Blosc(cname='zstd', clevel=5, shuffle=Blosc.SHUFFLE)
        compressed = codec.encode(data)
        
        # Save to file
        with open(test_file, 'wb') as f:
            f.write(compressed)
        
        print(f"  Created test file:")
        print(f"    Original: {data.nbytes} bytes")
        print(f"    Compressed: {len(compressed)} bytes")
        print(f"    Ratio: {len(compressed)/data.nbytes*100:.1f}%")
        print(f"    File: {test_file}")
    
    # Read and serve the file
    with open(test_file, 'rb') as f:
        compressed = f.read()
    
    print(f"\nServing blosc test file:")
    print(f"  Size: {len(compressed)} bytes")
    print(f"  First 64 bytes (hex): {compressed[:64].hex()}")
    print(f"  Last 32 bytes (hex): {compressed[-32:].hex()}")
    
    return Response(
        compressed,
        mimetype='application/octet-stream',
        headers={
            'Access-Control-Allow-Origin': '*',
            'Content-Length': str(len(compressed)),
            'X-Compression': 'blosc-zstd'
        }
    )

if __name__ == '__main__':
    print("="*70)
    print("BLOSC TEST SERVER")
    print("="*70)
    print("Running on http://localhost:8001")
    print("Endpoint: http://localhost:8001/api/test-blosc-compress")
    print("="*70)
    app.run(host='0.0.0.0', port=8001, debug=True)



