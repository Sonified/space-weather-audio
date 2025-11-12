#!/usr/bin/env python3
"""
Fix incorrectly named chunk file that crosses midnight.

The file HV_OBL_--_HHZ_1h_2025-11-11-23-00-00_to_2025-11-11-23-59-59.bin.zst
should be named HV_OBL_--_HHZ_1h_2025-11-11-23-00-00_to_2025-11-12-00-00-00.bin.zst

This script:
1. Finds the incorrectly named file on R2
2. Generates the correct filename using collector_loop.py logic
3. Copies the file to the correct name
4. Deletes the old file
"""
import boto3
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# Add parent directory to path to import collector_loop functions
sys.path.insert(0, str(Path(__file__).parent.parent))

# R2 Configuration (same as collector_loop.py)
R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID', '66f906f29f28b08ae9c80d4f36e25c7a')
R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID', '9e1cf6c395172f108c2150c52878859f')
R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY', '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec')
R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'hearts-data-cache')

def get_s3_client():
    """Get S3 client for R2 (same as collector_loop.py)"""
    return boto3.client(
        's3',
        endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name='auto'
    )

def parse_filename(filename):
    """
    Parse chunk filename to extract components.
    Format: NETWORK_STATION_LOCATION_CHANNEL_CHUNKTYPE_START_to_END.bin.zst
    Example: HV_OBL_--_HHZ_1h_2025-11-11-23-00-00_to_2025-11-11-23-59-59.bin.zst
    """
    if not filename.endswith('.bin.zst'):
        return None
    
    base = filename.replace('.bin.zst', '')
    parts = base.split('_')
    
    if len(parts) < 6 or '_to_' not in base:
        return None
    
    # Find the '_to_' separator
    to_index = base.find('_to_')
    before_to = base[:to_index]
    after_to = base[to_index + 4:]
    
    # Parse before '_to_'
    before_parts = before_to.split('_')
    if len(before_parts) < 5:
        return None
    
    network = before_parts[0]
    station = before_parts[1]
    location = before_parts[2]
    channel = before_parts[3]
    chunk_type = before_parts[4]
    
    # Parse start time (last part before _to_)
    start_str = '_'.join(before_parts[5:]) if len(before_parts) > 5 else ''
    
    # Parse end time (after _to_)
    end_str = after_to
    
    return {
        'network': network,
        'station': station,
        'location': location,
        'channel': channel,
        'chunk_type': chunk_type,
        'start_str': start_str,
        'end_str': end_str,
        'filename': filename
    }

def generate_correct_filename(parsed):
    """
    Generate correct filename using collector_loop.py logic.
    Uses requested start_time/end_time instead of trace.stats times.
    """
    # Parse start and end times
    # Format: YYYY-MM-DD-HH-MM-SS
    start_parts = parsed['start_str'].split('-')
    end_parts = parsed['end_str'].split('-')
    
    if len(start_parts) != 6 or len(end_parts) != 6:
        return None
    
    # Create datetime objects
    start_time = datetime(
        int(start_parts[0]), int(start_parts[1]), int(start_parts[2]),
        int(start_parts[3]), int(start_parts[4]), int(start_parts[5]),
        tzinfo=timezone.utc
    )
    
    # For 1-hour chunk starting at 23:00, end_time should be next day 00:00:00
    # Calculate correct end_time based on chunk_type
    chunk_type = parsed['chunk_type']
    if chunk_type == '1h':
        from datetime import timedelta
        end_time = start_time + timedelta(hours=1)
    elif chunk_type == '10m':
        from datetime import timedelta
        end_time = start_time + timedelta(minutes=10)
    elif chunk_type == '6h':
        from datetime import timedelta
        end_time = start_time + timedelta(hours=6)
    else:
        # Fallback: parse the end_str (but it might be wrong)
        end_time = datetime(
            int(end_parts[0]), int(end_parts[1]), int(end_parts[2]),
            int(end_parts[3]), int(end_parts[4]), int(end_parts[5]),
            tzinfo=timezone.utc
        )
    
    # Format using collector_loop.py logic
    start_str = start_time.strftime("%Y-%m-%d-%H-%M-%S")
    end_str = end_time.strftime("%Y-%m-%d-%H-%M-%S")
    
    # Generate filename (NEW format: no sample rate)
    location_str = parsed['location'] if parsed['location'] != '--' else '--'
    filename = f"{parsed['network']}_{parsed['station']}_{location_str}_{parsed['channel']}_{chunk_type}_{start_str}_to_{end_str}.bin.zst"
    
    return filename

def find_incorrect_file(s3_client, prefix='data/2025/11/11/HV/kilauea/OBL/--/HHZ/1h/'):
    """
    Find the incorrectly named file on R2.
    """
    print(f"🔍 Searching for incorrectly named file in: {prefix}")
    
    try:
        response = s3_client.list_objects_v2(Bucket=R2_BUCKET_NAME, Prefix=prefix)
        
        if 'Contents' not in response:
            print(f"❌ No files found in {prefix}")
            return None
        
        # Look for file ending in 23-59-59
        for obj in response['Contents']:
            key = obj['Key']
            filename = key.split('/')[-1]
            
            if '23-00-00_to_2025-11-11-23-59-59' in filename:
                print(f"✅ Found incorrectly named file: {filename}")
                print(f"   Key: {key}")
                print(f"   Size: {obj['Size']:,} bytes")
                return key
        
        print(f"❌ Incorrectly named file not found")
        return None
        
    except Exception as e:
        print(f"❌ Error searching for file: {e}")
        return None

def copy_and_delete_file(s3_client, old_key, new_key):
    """
    Copy file to new key and delete old key.
    R2 doesn't support direct rename, so we copy then delete.
    """
    print(f"\n📋 Copying file...")
    print(f"   From: {old_key}")
    print(f"   To:   {new_key}")
    
    try:
        # Copy object (R2 uses copy_source format: {'Bucket': bucket, 'Key': key})
        copy_source = {
            'Bucket': R2_BUCKET_NAME,
            'Key': old_key
        }
        
        s3_client.copy_object(
            CopySource=copy_source,
            Bucket=R2_BUCKET_NAME,
            Key=new_key
        )
        
        print(f"✅ File copied successfully")
        
        # Delete old file
        print(f"\n🗑️  Deleting old file...")
        s3_client.delete_object(Bucket=R2_BUCKET_NAME, Key=old_key)
        print(f"✅ Old file deleted successfully")
        
        return True
        
    except Exception as e:
        print(f"❌ Error copying/deleting file: {e}")
        return False

def main():
    """Main function"""
    print("=" * 70)
    print("🔧 Fix Midnight Chunk Filename")
    print("=" * 70)
    print()
    
    # Initialize S3 client
    s3_client = get_s3_client()
    
    # Find the incorrectly named file
    old_key = find_incorrect_file(s3_client)
    
    if not old_key:
        print("\n❌ Could not find incorrectly named file")
        return 1
    
    # Parse the filename
    filename = old_key.split('/')[-1]
    parsed = parse_filename(filename)
    
    if not parsed:
        print(f"\n❌ Could not parse filename: {filename}")
        return 1
    
    print(f"\n📝 Parsed filename components:")
    print(f"   Network: {parsed['network']}")
    print(f"   Station: {parsed['station']}")
    print(f"   Location: {parsed['location']}")
    print(f"   Channel: {parsed['channel']}")
    print(f"   Chunk Type: {parsed['chunk_type']}")
    print(f"   Start: {parsed['start_str']}")
    print(f"   End (WRONG): {parsed['end_str']}")
    
    # Generate correct filename
    correct_filename = generate_correct_filename(parsed)
    
    if not correct_filename:
        print(f"\n❌ Could not generate correct filename")
        return 1
    
    print(f"\n✅ Correct filename: {correct_filename}")
    
    # Build new key (same path, different filename)
    path_parts = old_key.split('/')
    path_parts[-1] = correct_filename
    new_key = '/'.join(path_parts)
    
    print(f"\n📋 Summary:")
    print(f"   Old key: {old_key}")
    print(f"   New key: {new_key}")
    
    # Automatically proceed (no confirmation needed)
    print(f"\n🔄 Proceeding with rename...")
    print(f"   1. Copying file to new name")
    print(f"   2. Deleting old file")
    print()
    
    # Copy and delete
    success = copy_and_delete_file(s3_client, old_key, new_key)
    
    if success:
        print("\n" + "=" * 70)
        print("✅ SUCCESS! File renamed successfully")
        print("=" * 70)
        return 0
    else:
        print("\n" + "=" * 70)
        print("❌ FAILED! Could not rename file")
        print("=" * 70)
        return 1

if __name__ == '__main__':
    sys.exit(main())

