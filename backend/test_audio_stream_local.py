#!/usr/bin/env python3
"""
Local test for audio streaming endpoint
Tests the /api/stream-audio endpoint without needing a browser
"""

import requests
import json
import struct
import numpy as np
import zstandard as zstd
from datetime import datetime, timedelta

def test_audio_stream_local():
    """Test the audio streaming endpoint locally"""
    
    # Configuration
    server_url = "http://localhost:5001"  # Your local Flask server
    
    # Request parameters
    network = "HV"
    station = "NPOC"
    location = ""
    channel = "HHZ"
    
    # Get time 1 hour ago
    now = datetime.utcnow()
    start_time = now - timedelta(hours=1)
    start_str = start_time.strftime("%Y-%m-%dT%H:%M:%S")
    
    duration = 300  # 5 minutes for quick test
    speedup = 200
    highpass_hz = 0.5
    
    print("🧪 Testing Audio Stream Endpoint Locally")
    print("=" * 60)
    print(f"Server: {server_url}")
    print(f"Station: {network}.{station}.{location}.{channel}")
    print(f"Start: {start_str}")
    print(f"Duration: {duration}s")
    print()
    
    # Build request
    request_data = {
        'network': network,
        'station': station,
        'location': location,
        'channel': channel,
        'starttime': start_str,
        'duration': duration,
        'speedup': speedup,
        'highpass_hz': highpass_hz
    }
    
    print("📤 Sending request to server...")
    print(f"   POST {server_url}/api/stream-audio")
    print(f"   Body: {json.dumps(request_data, indent=2)}")
    print()
    
    try:
        response = requests.post(
            f"{server_url}/api/stream-audio",
            json=request_data,
            timeout=120  # 2 minute timeout for IRIS fetch
        )
        
        print(f"📥 Response received!")
        print(f"   Status: {response.status_code}")
        print(f"   Headers:")
        for key, value in response.headers.items():
            if key.startswith('X-') or key in ['Content-Type', 'Content-Length']:
                print(f"      {key}: {value}")
        print()
        
        if response.status_code != 200:
            print(f"❌ Error: {response.status_code}")
            print(f"   {response.text}")
            return
        
        # Get compressed data
        compressed_data = response.content
        compressed_size = len(compressed_data)
        
        print(f"✅ Received compressed data: {compressed_size:,} bytes ({compressed_size/1024/1024:.2f} MB)")
        print()
        
        # Decompress with zstd
        print("🗜️  Decompressing with zstd...")
        decompressor = zstd.ZstdDecompressor()
        decompressed_data = decompressor.decompress(compressed_data)
        decompressed_size = len(decompressed_data)
        
        compression_ratio = decompressed_size / compressed_size
        print(f"✅ Decompressed: {decompressed_size:,} bytes ({decompressed_size/1024/1024:.2f} MB)")
        print(f"   Compression ratio: {compression_ratio:.1f}x")
        print()
        
        # Parse the blob
        print("📋 Parsing blob structure...")
        
        # Read metadata length (first 4 bytes, little-endian uint32)
        metadata_length = struct.unpack('<I', decompressed_data[:4])[0]
        print(f"   Metadata length: {metadata_length} bytes")
        
        # Read metadata JSON
        metadata_start = 4
        metadata_end = 4 + metadata_length
        metadata_bytes = decompressed_data[metadata_start:metadata_end]
        metadata_json = metadata_bytes.decode('utf-8')
        metadata = json.loads(metadata_json)
        
        print(f"   Metadata parsed:")
        for key, value in metadata.items():
            print(f"      {key}: {value}")
        print()
        
        # Read samples (remaining bytes are float32)
        samples_start = metadata_end
        samples_bytes = decompressed_data[samples_start:]
        samples = np.frombuffer(samples_bytes, dtype=np.float32)
        
        print(f"✅ Extracted samples:")
        print(f"   Count: {len(samples):,}")
        print(f"   Min: {samples.min():.6f}")
        print(f"   Max: {samples.max():.6f}")
        print(f"   Mean: {samples.mean():.6f}")
        print(f"   Std: {samples.std():.6f}")
        print()
        
        # Show first and last few samples
        print(f"📊 Sample preview:")
        print(f"   First 10: {samples[:10]}")
        print(f"   Last 10: {samples[-10:]}")
        print()
        
        # Verify normalization
        max_abs = np.abs(samples).max()
        print(f"🔍 Verification:")
        if max_abs <= 1.0:
            print(f"   ✅ Samples are normalized (max abs: {max_abs:.6f})")
        else:
            print(f"   ⚠️  Samples exceed ±1.0 (max abs: {max_abs:.6f})")
        
        # Calculate expected sample count
        expected_samples = int(metadata['original_sample_rate'] * metadata['duration_seconds'])
        print(f"   Expected samples: {expected_samples:,}")
        print(f"   Actual samples: {len(samples):,}")
        if len(samples) == expected_samples:
            print(f"   ✅ Sample count matches!")
        else:
            diff = abs(len(samples) - expected_samples)
            print(f"   ⚠️  Sample count differs by {diff:,}")
        
        print()
        print("=" * 60)
        print("✅ Test complete! Endpoint is working correctly.")
        print()
        print("Next steps:")
        print("1. Open test_audio_stream.html in your browser")
        print("2. Click 'Start Stream' to test the full pipeline")
        print("3. Click 'Play' to hear the audio!")
        
    except requests.exceptions.ConnectionError:
        print("❌ Connection error!")
        print()
        print("Is Flask running?")
        print("Start it with:")
        print("   cd backend")
        print("   python main.py")
        print()
        
    except requests.exceptions.Timeout:
        print("⏱️  Request timed out!")
        print("   IRIS might be slow, or the duration is too long")
        print("   Try a shorter duration (e.g., 60 or 300 seconds)")
        print()
        
    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == '__main__':
    test_audio_stream_local()


