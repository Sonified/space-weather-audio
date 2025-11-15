"""
Pull actual metadata from R2 and count real chunks
"""
import os
import boto3
import json
from datetime import datetime, timezone, timedelta
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

s3 = boto3.client(
    's3',
    endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    region_name='auto'
)

# Test station: HV.OBL.--.HHZ (kilauea)
network = 'HV'
station = 'OBL'
location = '--'
channel = 'HHZ'
volcano = 'kilauea'

now = datetime.now(timezone.utc)
last_24h_start = now - timedelta(hours=24)
today = now.date()
yesterday = today - timedelta(days=1)

print(f'Testing station: {network}.{station}.{location}.{channel}')
print(f'Current time: {now.strftime("%Y-%m-%d %H:%M:%S UTC")}')
print(f'24h window: {last_24h_start.strftime("%Y-%m-%d %H:%M:%S")} → {now.strftime("%Y-%m-%d %H:%M:%S")}')
print('='*70)

actual = {'10m': 0, '1h': 0, '6h': 0}
all_chunks = {'10m': [], '1h': [], '6h': []}

for date in [yesterday, today]:
    year = date.year
    month = f"{date.month:02d}"
    day = f"{date.day:02d}"
    date_str = date.strftime("%Y-%m-%d")
    
    metadata_filename = f"{network}_{station}_{location}_{channel}_{date_str}.json"
    metadata_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location}/{channel}/{metadata_filename}"
    
    print(f'\nChecking {date_str}:')
    print(f'  Key: {metadata_key}')
    
    try:
        response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_key)
        metadata = json.loads(response['Body'].read().decode('utf-8'))
        
        print(f'  ✅ Metadata found!')
        
        for chunk_type in ['10m', '1h', '6h']:
            chunks = metadata.get('chunks', {}).get(chunk_type, [])
            print(f'  {chunk_type}: {len(chunks)} chunks total')
            
            # Count chunks that overlap with 24h window
            for chunk in chunks:
                chunk_start_str = chunk.get('start', '')
                chunk_end_str = chunk.get('end', '')
                if not chunk_start_str or not chunk_end_str:
                    continue
                
                try:
                    chunk_start = datetime.fromisoformat(f"{date}T{chunk_start_str}").replace(tzinfo=timezone.utc)
                    chunk_end = datetime.fromisoformat(f"{date}T{chunk_end_str}").replace(tzinfo=timezone.utc)
                    
                    # NEW LOGIC: chunk_start <= now AND chunk_end > last_24h_start
                    if chunk_start <= now and chunk_end > last_24h_start:
                        actual[chunk_type] += 1
                        all_chunks[chunk_type].append(f"{date_str} {chunk_start_str}-{chunk_end_str}")
                except (ValueError, TypeError):
                    continue
    
    except s3.exceptions.NoSuchKey:
        print(f'  ❌ Metadata NOT found')

print('\n' + '='*70)
print('ACTUAL CHUNKS IN 24H WINDOW:')
print(f'  10m: {actual["10m"]} chunks')
print(f'  1h:  {actual["1h"]} chunks')
print(f'  6h:  {actual["6h"]} chunks')

print(f'\nEXPECTED (from our calculation):')
print(f'  10m: 144')
print(f'  1h:  24')
print(f'  6h:  4')

print(f'\nDIFFERENCE:')
print(f'  10m: {144 - actual["10m"]} missing')
print(f'  1h:  {24 - actual["1h"]} missing')
print(f'  6h:  {4 - actual["6h"]} missing')

# Show 6h chunks in detail
print('\n' + '='*70)
print('6H CHUNKS IN DETAIL:')
for i, chunk_str in enumerate(all_chunks['6h'], 1):
    print(f'  {i}. {chunk_str}')

