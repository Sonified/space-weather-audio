#!/usr/bin/env python3
"""
Audit min/max values in metadata vs actual data files.
Downloads random sample of binary files, decompresses them, and compares
actual min/max against what's stored in metadata.
"""

import os
import sys
import json
import boto3
import numpy as np
import zstandard as zstd
from pathlib import Path
from datetime import datetime, timezone

# R2 Configuration
R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID', '66f906f29f28b08ae9c80d4f36e25c7a')
R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID', '9e1cf6c395172f108c2150c52878859f')
R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY', '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec')
R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'hearts-data-cache')

# Initialize S3 client
s3 = boto3.client(
    's3',
    endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    region_name='auto'
)

def audit_file(binary_key, metadata_chunk, chunk_type):
    """
    Audit a single binary file against its metadata.
    Returns dict with audit results.
    """
    try:
        # Download binary file
        response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=binary_key)
        compressed_data = response['Body'].read()
        
        # Decompress
        decompressor = zstd.ZstdDecompressor()
        decompressed = decompressor.decompress(compressed_data)
        
        # Convert to int32 array
        data = np.frombuffer(decompressed, dtype=np.int32)
        
        # Calculate actual min/max
        actual_min = int(np.min(data))
        actual_max = int(np.max(data))
        
        # Get metadata min/max
        metadata_min = metadata_chunk.get('min', 0)
        metadata_max = metadata_chunk.get('max', 0)
        
        # Compare
        min_matches = (actual_min == metadata_min)
        max_matches = (actual_max == metadata_max)
        
        return {
            'file': binary_key,
            'chunk_type': chunk_type,
            'samples': len(data),
            'metadata_samples': metadata_chunk.get('samples', 0),
            'samples_match': len(data) == metadata_chunk.get('samples', 0),
            'actual_min': actual_min,
            'actual_max': actual_max,
            'metadata_min': metadata_min,
            'metadata_max': metadata_max,
            'min_matches': min_matches,
            'max_matches': max_matches,
            'status': 'PASS' if (min_matches and max_matches) else 'FAIL'
        }
    except Exception as e:
        return {
            'file': binary_key,
            'chunk_type': chunk_type,
            'status': 'ERROR',
            'error': str(e)
        }

def main():
    """Main audit function"""
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] 🔍 Starting min/max audit...")
    
    # Get sample size from command line (default: 50 files)
    sample_size = int(sys.argv[1]) if len(sys.argv) > 1 else 50
    
    # List all metadata files
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] 📋 Scanning metadata files...")
    
    paginator = s3.get_paginator('list_objects_v2')
    pages = paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix='data/')
    
    metadata_files = []
    for page in pages:
        if 'Contents' not in page:
            continue
        
        for obj in page['Contents']:
            key = obj['Key']
            if key.endswith('.json'):
                metadata_files.append(key)
    
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] Found {len(metadata_files)} metadata files")
    
    # Sample metadata files (or use all if fewer than sample_size)
    import random
    if len(metadata_files) > sample_size:
        sampled_metadata = random.sample(metadata_files, sample_size)
    else:
        sampled_metadata = metadata_files
    
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] Auditing {len(sampled_metadata)} metadata files...")
    print()
    
    # Track results
    total_chunks = 0
    passed = 0
    failed = 0
    errors = 0
    failures = []
    
    # Audit each metadata file
    for i, metadata_key in enumerate(sampled_metadata):
        print(f"[{i+1}/{len(sampled_metadata)}] {metadata_key}")
        
        try:
            # Load metadata
            response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_key)
            metadata = json.loads(response['Body'].read().decode('utf-8'))
            
            # Extract path info from metadata key
            # Format: data/YYYY/MM/DD/NETWORK/VOLCANO/STATION/LOCATION/CHANNEL/filename.json
            parts = metadata_key.split('/')
            year = parts[1]
            month = parts[2]
            day = parts[3]
            network = parts[4]
            volcano = parts[5]
            station = parts[6]
            location = parts[7]
            channel = parts[8]
            
            # Audit chunks (sample up to 3 chunks per type to avoid too many downloads)
            for chunk_type in ['10m', '1h', '6h']:
                chunks = metadata['chunks'].get(chunk_type, [])
                
                # Sample chunks (take up to 3 random chunks per type)
                if len(chunks) > 3:
                    sampled_chunks = random.sample(chunks, 3)
                else:
                    sampled_chunks = chunks
                
                for chunk in sampled_chunks:
                    total_chunks += 1
                    
                    # Build binary file key
                    start_time = chunk['start'].replace(':', '-')
                    end_time = chunk['end'].replace(':', '-')
                    date_str = metadata['date']
                    sample_rate = metadata['sample_rate']
                    rate_str = f"{sample_rate:.2f}".rstrip('0').rstrip('.') if '.' in str(sample_rate) else str(int(sample_rate))
                    
                    filename = f"{network}_{station}_{location}_{channel}_{rate_str}Hz_{chunk_type}_{date_str}-{start_time}_to_{date_str}-{end_time}.bin.zst"
                    binary_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location}/{channel}/{chunk_type}/{filename}"
                    
                    # Audit this file
                    result = audit_file(binary_key, chunk, chunk_type)
                    
                    if result['status'] == 'PASS':
                        passed += 1
                        print(f"  ✅ {chunk_type} {chunk['start']}-{chunk['end']} PASS")
                    elif result['status'] == 'FAIL':
                        failed += 1
                        failures.append(result)
                        print(f"  ❌ {chunk_type} {chunk['start']}-{chunk['end']} FAIL")
                        print(f"     Metadata: min={result['metadata_min']}, max={result['metadata_max']}")
                        print(f"     Actual:   min={result['actual_min']}, max={result['actual_max']}")
                    else:
                        errors += 1
                        print(f"  ⚠️  {chunk_type} {chunk['start']}-{chunk['end']} ERROR: {result.get('error')}")
        
        except Exception as e:
            errors += 1
            print(f"  ⚠️  ERROR processing metadata: {e}")
            continue
        
        print()
    
    # Print summary
    print("=" * 80)
    print("AUDIT SUMMARY")
    print("=" * 80)
    print(f"Total chunks audited: {total_chunks}")
    print(f"Passed: {passed} ({passed/total_chunks*100:.1f}%)" if total_chunks > 0 else "Passed: 0")
    print(f"Failed: {failed} ({failed/total_chunks*100:.1f}%)" if total_chunks > 0 else "Failed: 0")
    print(f"Errors: {errors} ({errors/total_chunks*100:.1f}%)" if total_chunks > 0 else "Errors: 0")
    print("=" * 80)
    
    # Print detailed failures
    if failures:
        print()
        print("=" * 80)
        print("DETAILED FAILURES")
        print("=" * 80)
        for i, failure in enumerate(failures[:10]):  # Show first 10
            print(f"\nFailure {i+1}:")
            print(f"  File: {failure['file']}")
            print(f"  Chunk Type: {failure['chunk_type']}")
            print(f"  Metadata min/max: {failure['metadata_min']} / {failure['metadata_max']}")
            print(f"  Actual min/max:   {failure['actual_min']} / {failure['actual_max']}")
            print(f"  Difference: min={failure['actual_min']-failure['metadata_min']}, max={failure['actual_max']-failure['metadata_max']}")
        
        if len(failures) > 10:
            print(f"\n... and {len(failures)-10} more failures")
        print("=" * 80)
    
    # Save full report to file
    report = {
        'audit_time': datetime.now(timezone.utc).isoformat(),
        'total_chunks': total_chunks,
        'passed': passed,
        'failed': failed,
        'errors': errors,
        'failures': failures
    }
    
    report_file = Path(__file__).parent / f"minmax_audit_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.json"
    with open(report_file, 'w') as f:
        json.dump(report, indent=2, fp=f)
    
    print(f"\nFull report saved to: {report_file}")
    
    # Exit with error code if any failures
    sys.exit(0 if failed == 0 else 1)

if __name__ == "__main__":
    main()

