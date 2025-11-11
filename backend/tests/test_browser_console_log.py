#!/usr/bin/env python3
"""
Emulate EXACT browser console logging for min/max comparison.
This reproduces the console.log statements from index.html to see what discrepancies exist.
"""

import os
import json
import boto3
import numpy as np
import zstandard as zstd
from datetime import datetime, timezone

# R2 Configuration
R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID', '66f906f29f28b08ae9c80d4f36e25c7a')
R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID', '9e1cf6c395172f108c2150c52878859f')
R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY', '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec')
R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'hearts-data-cache')

s3 = boto3.client(
    's3',
    endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    region_name='auto'
)

def emulate_browser_fetch(metadata_key, num_chunks=3):
    """
    Emulate the exact browser fetch workflow from index.html (fetchFromR2Worker function)
    """
    print()
    print("=" * 100)
    print(f"BROWSER WORKFLOW EMULATION: {metadata_key}")
    print("=" * 100)
    
    # STEP 1: Fetch metadata (line 2081-2086)
    print("📋 Step 1: Fetching metadata from R2...")
    response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_key)
    metadata = json.loads(response['Body'].read().decode('utf-8'))
    print(f"📋 Metadata received: {metadata_key}")
    
    # STEP 2: Calculate normalization range from metadata (EXACT browser code at lines 2096-2107)
    # const chunks = (metadata.chunks && (metadata.chunks['10min'] || metadata.chunks['10m'])) || [];
    chunks = metadata.get('chunks', {}).get('10m', [])
    
    print(f"📋 Found {len(chunks)} chunks to fetch (first {num_chunks} of {len(chunks)} total)")
    
    if len(chunks) < num_chunks:
        print(f"⏭️  Not enough chunks (need {num_chunks}, have {len(chunks)}), skipping")
        return
    
    # const normMin = Math.min(...chunks.map(c => c.min));
    # const normMax = Math.max(...chunks.map(c => c.max));
    # NOTE: Browser uses ALL chunks for normMin/normMax, not just the first 3!
    normMin = min(c['min'] for c in chunks)
    normMax = max(c['max'] for c in chunks)
    print(f"🔍 Normalization range from metadata: [{normMin}, {normMax}]")
    
    # STEP 3: Determine which chunks to fetch (line 2110)
    # const chunksToFetch = chunks.slice(0, 3);
    chunksToFetch = chunks[:num_chunks]
    chunk_list = [f"{c['start']}-{c['end']}" for c in chunksToFetch]
    print(f"📦 Will fetch {len(chunksToFetch)} chunks: {chunk_list}")
    
    # Extract path info from metadata key
    parts = metadata_key.split('/')
    year = parts[1]
    month = parts[2]
    day = parts[3]
    network = parts[4]
    volcano = parts[5]
    station = parts[6]
    location = parts[7]
    channel = parts[8]
    date_str = metadata['date']
    sample_rate = metadata['sample_rate']
    rate_str = f"{sample_rate:.2f}".rstrip('0').rstrip('.') if '.' in str(sample_rate) else str(int(sample_rate))
    
    # STEP 4: Fetch chunks (lines 2117-2214)
    allInt32Chunks = []
    
    for i, chunk_meta in enumerate(chunksToFetch):
        start_time = chunk_meta['start'].replace(':', '-')
        end_time = chunk_meta['end'].replace(':', '-')
        
        filename = f"{network}_{station}_{location}_{channel}_{rate_str}Hz_10m_{date_str}-{start_time}_to_{date_str}-{end_time}.bin.zst"
        binary_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location}/{channel}/10m/{filename}"
        
        # Download and decompress
        response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=binary_key)
        compressed = response['Body'].read()
        
        decompressor = zstd.ZstdDecompressor()
        decompressed = decompressor.decompress(compressed)
        samples = np.frombuffer(decompressed, dtype=np.int32)
        
        allInt32Chunks.append(samples)
        print(f"  ✅ Chunk {i+1} downloaded: {len(samples):,} samples")
    
    # STEP 5: Stitch chunks (lines 2259-2266)
    totalSamples = sum(len(arr) for arr in allInt32Chunks)
    stitchedInt32 = np.concatenate(allInt32Chunks)
    print(f"🔗 Stitched {len(allInt32Chunks)} chunks: {len(stitchedInt32):,} total samples")
    
    # STEP 6: Find ACTUAL min/max (EXACT browser code at lines 2268-2275)
    # let actualMin = stitchedInt32[0];
    # let actualMax = stitchedInt32[0];
    # for (let i = 1; i < stitchedInt32.length; i++) {
    #     if (stitchedInt32[i] < actualMin) actualMin = stitchedInt32[i];
    #     if (stitchedInt32[i] > actualMax) actualMax = stitchedInt32[i];
    # }
    actualMin = int(stitchedInt32[0])
    actualMax = int(stitchedInt32[0])
    for i in range(1, len(stitchedInt32)):
        if stitchedInt32[i] < actualMin:
            actualMin = int(stitchedInt32[i])
        if stitchedInt32[i] > actualMax:
            actualMax = int(stitchedInt32[i])
    
    actualRange = actualMax - actualMin
    
    # STEP 7: Log comparison (EXACT browser console.log at line 2276)
    print(f"  📊 Metadata range: [{normMin}, {normMax}], Actual range: [{actualMin}, {actualMax}]")
    
    # STEP 8: Analysis
    print()
    print("🔬 ANALYSIS:")
    
    if actualMin == normMin and actualMax == normMax:
        print("  ✅ PERFECT MATCH - No issues detected")
    else:
        print("  ⚠️  MISMATCH DETECTED!")
        print(f"     Min: metadata={normMin}, actual={actualMin}, diff={actualMin - normMin}")
        print(f"     Max: metadata={normMax}, actual={actualMax}, diff={actualMax - normMax}")
        
        # Explain why
        if actualMin >= normMin and actualMax <= normMax:
            print()
            print("  💡 EXPLANATION:")
            print(f"     The metadata normMin/normMax is calculated from ALL {len(chunks)} chunks")
            print(f"     But browser only fetched the FIRST {num_chunks} chunks")
            print(f"     So the actual data range is NARROWER than metadata predicts")
            print()
            print("  🔧 IMPACT ON NORMALIZATION:")
            print(f"     Browser uses ACTUAL range [{actualMin}, {actualMax}] ✅")
            print(f"     So normalization is correct despite metadata mismatch")
        else:
            print()
            print("  ⚠️  CRITICAL ERROR:")
            print(f"     Actual data exceeds metadata bounds!")
            print(f"     This should NEVER happen - metadata is incorrect!")
    
    print()
    
    # Additional detail: show what normalization would look like
    print("📏 NORMALIZATION PREVIEW (first 10 samples):")
    metadataRange = normMax - normMin
    
    for i in range(min(10, len(stitchedInt32))):
        sample = int(stitchedInt32[i])
        
        # Using metadata range (what browser CALCULATES but doesn't USE)
        norm_from_metadata = ((sample - normMin) / metadataRange) * 2 - 1
        
        # Using actual range (what browser ACTUALLY USES - line 2282)
        norm_from_actual = 2 * (sample - actualMin) / actualRange - 1
        
        diff = abs(norm_from_metadata - norm_from_actual)
        
        if diff > 0.001:
            print(f"  Sample {i}: {sample:6d} → metadata: {norm_from_metadata:7.4f}, actual: {norm_from_actual:7.4f} (diff={diff:.4f})")


def main():
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] 🧪 Browser Console Log Emulation")
    print("Reproducing EXACT browser workflow with console.log statements")
    
    # Find metadata files with multiple chunks
    paginator = s3.get_paginator('list_objects_v2')
    pages = paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix='data/2025/11/06/')
    
    metadata_files = []
    for page in pages:
        if 'Contents' not in page:
            continue
        for obj in page['Contents']:
            key = obj['Key']
            if key.endswith('.json'):
                # Check if it has enough chunks
                response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=key)
                metadata = json.loads(response['Body'].read().decode('utf-8'))
                if len(metadata.get('chunks', {}).get('10m', [])) >= 3:
                    metadata_files.append(key)
    
    print(f"Found {len(metadata_files)} metadata files with 3+ chunks")
    
    # Test each one
    for metadata_key in metadata_files[:5]:  # First 5
        emulate_browser_fetch(metadata_key, num_chunks=3)
    
    print()
    print("=" * 100)
    print("SUMMARY")
    print("=" * 100)
    print("The browser calculates normalization range from ALL chunks in metadata,")
    print("but only fetches the FIRST 3 chunks (30 minutes).")
    print()
    print("This can cause a mismatch if the fetched chunks have a narrower range")
    print("than the full day's data.")
    print()
    print("HOWEVER: The browser uses the ACTUAL data range for normalization (line 2282),")
    print("not the metadata range, so normalization is always correct! ✅")
    print("=" * 100)

if __name__ == "__main__":
    main()

