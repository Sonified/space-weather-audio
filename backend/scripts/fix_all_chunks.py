#!/usr/bin/env python3
"""
Scan all active volcanoes and fix all incorrectly named chunk files.

Finds files with wrong ending times (using :59 instead of :00):
- Midnight-crossing: NET_STA_LOC_CHA_1h_YYYY-MM-DD-23-00-00_to_YYYY-MM-DD-23-59-59.bin.zst
  → NET_STA_LOC_CHA_1h_YYYY-MM-DD-23-00-00_to_YYYY-MM-DD+1-00-00-00.bin.zst
- Regular chunks: NET_STA_LOC_CHA_10m_YYYY-MM-DD-06-10-00_to_YYYY-MM-DD-06-19-59.bin.zst
  → NET_STA_LOC_CHA_10m_YYYY-MM-DD-06-10-00_to_YYYY-MM-DD-06-20-00.bin.zst

Uses collector_loop.py logic: start_time + duration = end_time
"""
import boto3
import os
import sys
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# R2 Configuration - loaded from .env file (local) or Railway dashboard (production)
R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID')
R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID')
R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY')
R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME')

# Validate that all R2 credentials are present
if not all([R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME]):
    missing = []
    if not R2_ACCOUNT_ID: missing.append('R2_ACCOUNT_ID')
    if not R2_ACCESS_KEY_ID: missing.append('R2_ACCESS_KEY_ID')
    if not R2_SECRET_ACCESS_KEY: missing.append('R2_SECRET_ACCESS_KEY')
    if not R2_BUCKET_NAME: missing.append('R2_BUCKET_NAME')
    raise ValueError(f"Missing required R2 environment variables: {', '.join(missing)}")

def get_s3_client():
    """Get S3 client for R2"""
    return boto3.client(
        's3',
        endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name='auto'
    )

def load_stations_config():
    """Load stations config and return list of active stations"""
    config_path = Path(__file__).parent.parent / 'stations_config.json'
    with open(config_path, 'r') as f:
        config = json.load(f)
    
    active_stations = []
    for network, volcanoes in config['networks'].items():
        for volcano, stations in volcanoes.items():
            for station in stations:
                if station.get('active', False):
                    active_stations.append({
                        'network': network,
                        'volcano': volcano,
                        'station': station['station'],
                        'location': station.get('location', '--'),
                        'channel': station['channel']
                    })
    
    return active_stations

def is_wrong_filename(filename):
    """
    Check if filename has wrong ending time format.
    Wrong: ends with XX-XX-59 (using :59 instead of :00)
    Correct: should end with XX-XX-00 (using exact end time)
    
    This catches:
    - Midnight-crossing chunks: 23-00-00_to_23-59-59 → should be 23-00-00_to_00-00-00
    - Regular chunks: 06-10-00_to_06-19-59 → should be 06-10-00_to_06-20-00
    """
    if not filename.endswith('.bin.zst'):
        return False
    
    # Check if it ends with -59.bin.zst (wrong format - should be -00)
    if filename.endswith('-59.bin.zst'):
        # Make sure it's not a valid time like 23:59:59 that should actually be 00:00:00 next day
        # But for now, we'll fix all -59 endings
        return True
    
    return False

def generate_correct_filename(wrong_filename):
    """
    Generate correct filename for chunk with wrong ending time.
    Uses collector_loop.py logic: start_time + duration = end_time
    """
    if not is_wrong_filename(wrong_filename):
        return None
    
    # Parse the filename
    # Format: NET_STA_LOC_CHA_CHUNKTYPE_START_to_END.bin.zst
    base = wrong_filename.replace('.bin.zst', '')
    
    # Find the _to_ separator
    if '_to_' not in base:
        return None
    
    before_to, after_to = base.split('_to_', 1)
    
    # Extract chunk type (10m, 1h, or 6h)
    if '_10m_' in before_to:
        chunk_type = '10m'
        duration_minutes = 10
    elif '_1h_' in before_to:
        chunk_type = '1h'
        duration_minutes = 60
    elif '_6h_' in before_to:
        chunk_type = '6h'
        duration_minutes = 360
    else:
        return None
    
    # Parse start time from before_to
    # Format: NET_STA_LOC_CHA_CHUNKTYPE_YYYY-MM-DD-HH-MM-SS
    before_parts = before_to.split('_')
    if len(before_parts) < 6:
        return None
    
    # Last part should be the start time
    start_str = before_parts[-1]  # YYYY-MM-DD-HH-MM-SS
    
    # Parse start datetime
    start_parts = start_str.split('-')
    if len(start_parts) != 6:
        return None
    
    start_time = datetime(
        int(start_parts[0]), int(start_parts[1]), int(start_parts[2]),
        int(start_parts[3]), int(start_parts[4]), int(start_parts[5]),
        tzinfo=timezone.utc
    )
    
    # Calculate correct end time (start + duration)
    end_time = start_time + timedelta(minutes=duration_minutes)
    
    # Format correctly
    start_formatted = start_time.strftime("%Y-%m-%d-%H-%M-%S")
    end_formatted = end_time.strftime("%Y-%m-%d-%H-%M-%S")
    
    # Reconstruct filename
    # Replace the start time and end time parts
    before_to_new = '_'.join(before_parts[:-1]) + '_' + start_formatted
    correct_filename = f"{before_to_new}_to_{end_formatted}.bin.zst"
    
    return correct_filename

def find_wrong_files_in_directory(s3_client, prefix):
    """Find all incorrectly named files in a directory"""
    wrong_files = []
    
    try:
        response = s3_client.list_objects_v2(Bucket=R2_BUCKET_NAME, Prefix=prefix)
        if 'Contents' not in response:
            return wrong_files
        
        for obj in response['Contents']:
            key = obj['Key']
            filename = key.split('/')[-1]
            
            if is_wrong_filename(filename):
                correct_filename = generate_correct_filename(filename)
                if correct_filename:
                    # Build correct key (same path, different filename)
                    path_parts = key.split('/')
                    path_parts[-1] = correct_filename
                    correct_key = '/'.join(path_parts)
                    
                    wrong_files.append({
                        'old_key': key,
                        'old_filename': filename,
                        'new_key': correct_key,
                        'new_filename': correct_filename,
                        'size': obj['Size']
                    })
    
    except Exception as e:
        print(f"   ❌ Error listing {prefix}: {e}")
    
    return wrong_files

def copy_and_delete_file(s3_client, old_key, new_key):
    """Copy file to new key and delete old key"""
    try:
        copy_source = {
            'Bucket': R2_BUCKET_NAME,
            'Key': old_key
        }
        
        s3_client.copy_object(
            CopySource=copy_source,
            Bucket=R2_BUCKET_NAME,
            Key=new_key
        )
        
        s3_client.delete_object(Bucket=R2_BUCKET_NAME, Key=old_key)
        
        return True
    except Exception as e:
        print(f"      ❌ Error: {e}")
        return False

def scan_and_fix_all(s3_client, days_back=30):
    """Scan all active stations and fix wrong filenames"""
    print("=" * 70)
    print("🔧 Fix All Incorrectly Named Chunk Filenames")
    print("=" * 70)
    print()
    
    # Load active stations
    print("📋 Loading active stations...")
    active_stations = load_stations_config()
    print(f"   Found {len(active_stations)} active stations")
    print()
    
    # Determine date range
    end_date = datetime.now(timezone.utc).date()
    start_date = end_date - timedelta(days=days_back)
    
    print(f"📅 Scanning dates from {start_date} to {end_date}")
    print()
    
    all_wrong_files = []
    
    # Scan each station
    for station in active_stations:
        network = station['network']
        volcano = station['volcano']
        sta = station['station']
        location = station['location']
        channel = station['channel']
        
        print(f"🔍 Scanning {network}.{sta}.{location}.{channel} ({volcano})...")
        
        # Scan each day
        current_date = start_date
        while current_date <= end_date:
            year = current_date.year
            month = f"{current_date.month:02d}"
            day = f"{current_date.day:02d}"
            
            # Check 10m chunks directory
            prefix_10m = f"data/{year}/{month}/{day}/{network}/{volcano}/{sta}/{location}/{channel}/10m/"
            wrong_files_10m = find_wrong_files_in_directory(s3_client, prefix_10m)
            
            # Check 1h chunks directory
            prefix_1h = f"data/{year}/{month}/{day}/{network}/{volcano}/{sta}/{location}/{channel}/1h/"
            wrong_files_1h = find_wrong_files_in_directory(s3_client, prefix_1h)
            
            # Check 6h chunks directory
            prefix_6h = f"data/{year}/{month}/{day}/{network}/{volcano}/{sta}/{location}/{channel}/6h/"
            wrong_files_6h = find_wrong_files_in_directory(s3_client, prefix_6h)
            
            all_wrong_files.extend(wrong_files_10m)
            all_wrong_files.extend(wrong_files_1h)
            all_wrong_files.extend(wrong_files_6h)
            
            if wrong_files_10m or wrong_files_1h or wrong_files_6h:
                print(f"   📅 {current_date}: Found {len(wrong_files_10m)} wrong 10m chunks, {len(wrong_files_1h)} wrong 1h chunks, {len(wrong_files_6h)} wrong 6h chunks")
            
            current_date += timedelta(days=1)
    
    print()
    print("=" * 70)
    print(f"📊 Summary: Found {len(all_wrong_files)} incorrectly named files")
    print("=" * 70)
    
    if not all_wrong_files:
        print("✅ No incorrectly named files found!")
        return 0
    
    # Show sample of wrong files (first 5)
    print("\n📋 Sample files to fix (showing first 5):")
    for i, file_info in enumerate(all_wrong_files[:5], 1):
        print(f"\n{i}. {file_info['old_filename']}")
        print(f"   → {file_info['new_filename']}")
        print(f"   Size: {file_info['size']:,} bytes")
    
    if len(all_wrong_files) > 5:
        print(f"\n   ... and {len(all_wrong_files) - 5} more files")
    
    print(f"\n⚠️  This will rename {len(all_wrong_files)} files")
    print("   (Copy to new name, then delete old)")
    print()
    
    import sys
    if sys.stdin.isatty():
        response = input("Continue? (yes/no): ").strip().lower()
        if response != 'yes':
            print("❌ Cancelled")
            return 0
    else:
        print("✅ Auto-confirming (non-interactive mode)")
        print()
    
    # Fix all files
    print(f"\n🔄 Fixing {len(all_wrong_files)} files...")
    print()
    
    fixed = 0
    failed = 0
    
    import sys
    for i, file_info in enumerate(all_wrong_files, 1):
        # Only show every 10th file to reduce output spam
        if i % 10 == 0 or i <= 5:
            print(f"[{i}/{len(all_wrong_files)}] {file_info['old_filename']}", flush=True)
            print(f"   → {file_info['new_filename']}", flush=True)
        
        success = copy_and_delete_file(s3_client, file_info['old_key'], file_info['new_key'])
        
        if success:
            fixed += 1
            if i % 10 == 0 or i <= 5:
                print(f"   ✅ Fixed", flush=True)
        else:
            print(f"   ❌ FAILED: {file_info['old_filename']}", flush=True)
            failed += 1
        
        # Show progress every 50 files
        if i % 50 == 0:
            percent = (i * 100) // len(all_wrong_files)
            print(f"\n📊 Progress: {i}/{len(all_wrong_files)} ({percent}%) - ✅ Fixed: {fixed}, ❌ Failed: {failed}\n", flush=True)
        elif i % 10 == 0:
            print(flush=True)
    
    print("=" * 70)
    print(f"✅ Fixed: {fixed}")
    print(f"❌ Failed: {failed}")
    print("=" * 70)
    
    return 0 if failed == 0 else 1

def main():
    """Main function"""
    s3_client = get_s3_client()
    
    # Allow days_back to be specified as command line argument
    days_back = 30
    if len(sys.argv) > 1:
        try:
            days_back = int(sys.argv[1])
        except ValueError:
            print(f"⚠️  Invalid days_back argument, using default: 30")
    
    return scan_and_fix_all(s3_client, days_back=days_back)

if __name__ == '__main__':
    sys.exit(main())

