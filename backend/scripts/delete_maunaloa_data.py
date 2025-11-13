#!/usr/bin/env python3
"""
Delete MOKD (1.6km) Mauna Loa data from R2 to start fresh with clean backfill.
This removes corrupted metadata and binary files for the last 2 days only.
"""
import boto3
import os
from datetime import datetime, timedelta

# R2 credentials (same as collector_loop.py)
R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID', '66f906f29f28b08ae9c80d4f36e25c7a')
R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID', '9e1cf6c395172f108c2150c52878859f')
R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY', '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec')
R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'hearts-data-cache')

# Get S3 client
s3 = boto3.client(
    's3',
    endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    region_name='auto'
)

# Only MOKD (1.6km station)
maunaloa_stations = [
    {'network': 'HV', 'station': 'MOKD', 'location': '--', 'channel': 'HHZ', 'distance': '1.6km'},
]

# Date range to clean (last 3 days to include today)
end_date = datetime.now() + timedelta(days=1)  # Include tomorrow to catch partial days
start_date = end_date - timedelta(days=3)

print(f"🧹 Cleaning MOKD (1.6km) Mauna Loa data from R2")
print(f"📅 Date range: {start_date.strftime('%Y-%m-%d')} to {end_date.strftime('%Y-%m-%d')} (last 2 days)")
print(f"📦 Bucket: {R2_BUCKET_NAME}")
print(f"🎯 Station: HV.MOKD.--.HHZ only")
print()

total_deleted = 0

for station_config in maunaloa_stations:
    network = station_config['network']
    station = station_config['station']
    location = station_config['location']
    channel = station_config['channel']
    
    station_key = f"{network}.{station}.{location}.{channel}"
    print(f"🔍 Checking {station_key}...")
    
    # Get current date
    current_date = start_date
    while current_date <= end_date:
        year = current_date.strftime('%Y')
        month = current_date.strftime('%m')
        day = current_date.strftime('%d')
        
        # List all objects for this station/date
        prefix = f"data/{year}/{month}/{day}/{network}/maunaloa/{station}/{location}/{channel}/"
        
        try:
            # List objects with this prefix
            response = s3.list_objects_v2(Bucket=R2_BUCKET_NAME, Prefix=prefix)
            
            if 'Contents' in response:
                objects_to_delete = [{'Key': obj['Key']} for obj in response['Contents']]
                
                if objects_to_delete:
                    print(f"  🗑️  Deleting {len(objects_to_delete)} objects for {current_date.strftime('%Y-%m-%d')}...")
                    
                    # Delete in batches of 1000 (R2 limit)
                    for i in range(0, len(objects_to_delete), 1000):
                        batch = objects_to_delete[i:i+1000]
                        s3.delete_objects(
                            Bucket=R2_BUCKET_NAME,
                            Delete={'Objects': batch}
                        )
                    
                    total_deleted += len(objects_to_delete)
                    print(f"  ✅ Deleted {len(objects_to_delete)} objects")
        
        except Exception as e:
            print(f"  ⚠️  Error checking {current_date.strftime('%Y-%m-%d')}: {e}")
        
        current_date += timedelta(days=1)
    
    print()

print("=" * 80)
print(f"✅ Cleanup complete! Deleted {total_deleted} total objects for MOKD")
print()
print("Next steps:")
print("1. Test backfill with 2 hours for MOKD: hours_back=2")
print("2. Verify metadata has ALL fields (start, end, min, max, samples)")
print("3. Check with diagnostic tool: data_audit.html")
print("4. If successful, run full 24-hour backfill")

