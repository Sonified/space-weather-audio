#!/usr/bin/env python3
"""
Test script to verify that cdn_backfill.py can accurately find file names on the server.
This script will:
1. Load metadata for a given date/time range
2. Construct expected filenames based on metadata
3. Check if those files actually exist on R2
4. Report what would be deleted (without actually deleting)
"""

import os
import json
import boto3
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Import functions from cdn_backfill
import sys
sys.path.insert(0, os.path.dirname(__file__))
from cdn_backfill import (
    get_s3_client, 
    load_metadata_for_date,
    R2_BUCKET_NAME,
    USE_R2
)

def check_file_exists_on_r2(s3_client, s3_key):
    """Check if a file exists on R2"""
    try:
        s3_client.head_object(Bucket=R2_BUCKET_NAME, Key=s3_key)
        return True
    except s3_client.exceptions.ClientError as e:
        if e.response['Error']['Code'] == '404':
            return False
        raise

def test_file_detection(network, station, location, channel, volcano, sample_rate, 
                       start_time, end_time):
    """
    Test file detection logic - construct filenames from metadata and verify they exist on R2.
    """
    print("=" * 80)
    print(f"🔍 Testing File Detection for {network}.{station}.{location}.{channel}")
    print(f"📅 Time Range: {start_time.strftime('%Y-%m-%d %H:%M:%S')} to {end_time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"💾 Mode: {'R2' if USE_R2 else 'Local'}")
    print("=" * 80)
    print()
    
    if not USE_R2:
        print("⚠️  This test requires R2 mode")
        return
    
    location_str = location if location and location != '--' else '--'
    s3 = get_s3_client()
    
    # Get all dates in range
    current_date = start_time.replace(hour=0, minute=0, second=0, microsecond=0)
    end_date = end_time.replace(hour=0, minute=0, second=0, microsecond=0)
    
    dates_to_check = []
    while current_date <= end_date:
        dates_to_check.append(current_date)
        current_date += timedelta(days=1)
    
    print(f"📅 Checking {len(dates_to_check)} date(s): {', '.join([d.strftime('%Y-%m-%d') for d in dates_to_check])}")
    print()
    
    total_found = {'10m': 0, '1h': 0, '6h': 0}
    total_missing = {'10m': 0, '1h': 0, '6h': 0}
    total_in_range = {'10m': 0, '1h': 0, '6h': 0}
    
    files_found = []
    files_missing = []
    
    for date in dates_to_check:
        year = date.year
        month = f"{date.month:02d}"
        day = f"{date.day:02d}"
        date_str = date.strftime('%Y-%m-%d')
        
        print(f"📂 Checking {date_str}...")
        
        # Load metadata for this date
        metadata = load_metadata_for_date(network, station, location, channel, volcano, date_str, sample_rate)
        
        if not metadata:
            print(f"   ⚠️  No metadata found for {date_str}")
            print()
            continue
        
        # Check each chunk type
        for chunk_type in ['10m', '1h', '6h']:
            chunks = metadata.get('chunks', {}).get(chunk_type, [])
            
            if not chunks:
                continue
            
            print(f"   📦 {chunk_type} chunks: {len(chunks)} in metadata")
            
            for chunk in chunks:
                chunk_start_str = chunk.get('start', '')
                
                if not chunk_start_str:
                    continue
                
                try:
                    # Parse chunk start time
                    chunk_datetime = datetime.strptime(f"{date_str} {chunk_start_str}", '%Y-%m-%d %H:%M:%S')
                    chunk_datetime = chunk_datetime.replace(tzinfo=timezone.utc)
                    
                    # Check if chunk is in our time range
                    in_range = start_time <= chunk_datetime < end_time
                    
                    if in_range:
                        total_in_range[chunk_type] += 1
                        
                        # Calculate end time based on chunk type
                        if chunk_type == '10m':
                            chunk_end_datetime = chunk_datetime + timedelta(minutes=10)
                        elif chunk_type == '1h':
                            chunk_end_datetime = chunk_datetime + timedelta(hours=1)
                        elif chunk_type == '6h':
                            chunk_end_datetime = chunk_datetime + timedelta(hours=6)
                        
                        # Build EXACT filename (same logic as delete_chunks_for_timerange)
                        start_str = chunk_datetime.strftime('%Y-%m-%d-%H-%M-%S')
                        end_str = chunk_end_datetime.strftime('%Y-%m-%d-%H-%M-%S')
                        filename = f"{network}_{station}_{location_str}_{channel}_{chunk_type}_{start_str}_to_{end_str}.bin.zst"
                        
                        # Build S3 key (same logic as delete_chunks_for_timerange)
                        s3_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/{chunk_type}/{filename}"
                        
                        # Check if file exists
                        exists = check_file_exists_on_r2(s3, s3_key)
                        
                        if exists:
                            total_found[chunk_type] += 1
                            files_found.append({
                                'type': chunk_type,
                                'date': date_str,
                                'time': chunk_start_str,
                                'filename': filename,
                                's3_key': s3_key
                            })
                        else:
                            total_missing[chunk_type] += 1
                            files_missing.append({
                                'type': chunk_type,
                                'date': date_str,
                                'time': chunk_start_str,
                                'filename': filename,
                                's3_key': s3_key,
                                'metadata': chunk
                            })
                
                except Exception as e:
                    print(f"      ⚠️  Error processing chunk {chunk_start_str}: {e}")
        
        print()
    
    # Print summary
    print("=" * 80)
    print("📊 SUMMARY")
    print("=" * 80)
    print()
    
    for chunk_type in ['10m', '1h', '6h']:
        in_range = total_in_range[chunk_type]
        found = total_found[chunk_type]
        missing = total_missing[chunk_type]
        
        if in_range > 0:
            print(f"📦 {chunk_type} chunks:")
            print(f"   ├─ In time range: {in_range}")
            print(f"   ├─ ✅ Found on R2: {found}")
            print(f"   └─ ❌ Missing on R2: {missing}")
            if in_range > 0:
                print(f"   └─ Success rate: {found/in_range*100:.1f}%")
            print()
    
    # Show sample of found files
    if files_found:
        print("=" * 80)
        print("✅ FILES FOUND ON R2 (sample - first 10):")
        print("=" * 80)
        for i, file_info in enumerate(files_found[:10], 1):
            print(f"{i}. {file_info['type']} | {file_info['date']} {file_info['time']}")
            print(f"   └─ {file_info['filename']}")
            print(f"   └─ s3://{R2_BUCKET_NAME}/{file_info['s3_key']}")
        if len(files_found) > 10:
            print(f"\n   ... and {len(files_found) - 10} more")
        print()
    
    # Show sample of missing files
    if files_missing:
        print("=" * 80)
        print("❌ FILES MISSING ON R2 (sample - first 10):")
        print("=" * 80)
        for i, file_info in enumerate(files_missing[:10], 1):
            print(f"{i}. {file_info['type']} | {file_info['date']} {file_info['time']}")
            print(f"   └─ Expected: {file_info['filename']}")
            print(f"   └─ s3://{R2_BUCKET_NAME}/{file_info['s3_key']}")
            print(f"   └─ Metadata: {json.dumps(file_info['metadata'], indent=6)}")
        if len(files_missing) > 10:
            print(f"\n   ... and {len(files_missing) - 10} more")
        print()
    
    # Final verdict
    print("=" * 80)
    total_in_range_sum = sum(total_in_range.values())
    total_found_sum = sum(total_found.values())
    total_missing_sum = sum(total_missing.values())
    
    if total_in_range_sum == 0:
        print("⚠️  No chunks found in the specified time range")
    elif total_missing_sum == 0:
        print("✅ PERFECT! All files that should exist are found on R2")
    elif total_found_sum > 0:
        print(f"⚠️  PARTIAL: {total_found_sum}/{total_in_range_sum} files found ({total_found_sum/total_in_range_sum*100:.1f}%)")
        print(f"   Missing: {total_missing_sum} files")
    else:
        print(f"❌ NONE FOUND: 0/{total_in_range_sum} files found on R2")
        print("   This suggests a filename construction issue")
    
    print("=" * 80)

if __name__ == '__main__':
    # Test with MOKD station - check last 24 hours
    from datetime import datetime, timedelta, timezone
    
    end_time = datetime.now(timezone.utc)
    start_time = end_time - timedelta(hours=24)
    
    test_file_detection(
        network='HV',
        station='MOKD',
        location='--',
        channel='HHZ',
        volcano='maunaloa',
        sample_rate=100,
        start_time=start_time,
        end_time=end_time
    )


