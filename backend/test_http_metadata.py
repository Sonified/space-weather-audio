"""
Fetch metadata via HTTP like index.html does - NO CREDENTIALS
"""
import requests
import json
from datetime import datetime, timezone, timedelta

# Public R2 URL (no auth needed)
BASE_URL = "https://pub-3d85d24813fc4a98b39431ffc6db4ec0.r2.dev"

# Test station
network = 'HV'
station = 'OBL'
location = '--'
channel = 'HHZ'
volcano = 'kilauea'

now = datetime.now(timezone.utc)
last_24h_start = now - timedelta(hours=24)

# Get all dates we need to check
start_date = last_24h_start.date()
end_date = now.date()
dates_to_check = []
current = start_date
while current <= end_date:
    dates_to_check.append(current)
    current += timedelta(days=1)

print(f'Current time: {now.strftime("%Y-%m-%d %H:%M:%S UTC")}')
print(f'24h window: {last_24h_start.strftime("%Y-%m-%d %H:%M:%S")} → {now.strftime("%Y-%m-%d %H:%M:%S")}')
print(f'Dates to check: {[str(d) for d in dates_to_check]}')
print('='*70)

actual = {'10m': 0, '1h': 0, '6h': 0}

for date in dates_to_check:
    year = date.year
    month = f"{date.month:02d}"
    day = f"{date.day:02d}"
    date_str = date.strftime("%Y-%m-%d")
    
    # Build URL like index.html does
    metadata_url = f"{BASE_URL}/data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location}/{channel}/{network}_{station}_{location}_{channel}_{date_str}.json"
    
    print(f'\nFetching {date_str}:')
    print(f'  URL: {metadata_url}')
    
    try:
        response = requests.get(metadata_url, timeout=5)
        
        if response.status_code == 200:
            metadata = response.json()
            print(f'  ✅ Found!')
            
            for chunk_type in ['10m', '1h', '6h']:
                chunks = metadata.get('chunks', {}).get(chunk_type, [])
                print(f'    {chunk_type}: {len(chunks)} chunks')
                
                # Count chunks in window
                for chunk in chunks:
                    chunk_start_str = chunk.get('start', '')
                    chunk_end_str = chunk.get('end', '')
                    if not chunk_start_str or not chunk_end_str:
                        continue
                    
                    chunk_start = datetime.fromisoformat(f"{date}T{chunk_start_str}").replace(tzinfo=timezone.utc)
                    chunk_end = datetime.fromisoformat(f"{date}T{chunk_end_str}").replace(tzinfo=timezone.utc)
                    
                    # FIXED: chunk_start <= now (not <)
                    if chunk_start <= now and chunk_end > last_24h_start:
                        actual[chunk_type] += 1
        else:
            print(f'  ❌ Status {response.status_code}')
    
    except requests.exceptions.RequestException as e:
        print(f'  ❌ Error: {e}')

print('\n' + '='*70)
print(f'ACTUAL CHUNKS IN 24H WINDOW:')
print(f'  10m: {actual["10m"]}')
print(f'  1h:  {actual["1h"]}')
print(f'  6h:  {actual["6h"]}')

