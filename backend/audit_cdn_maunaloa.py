#!/usr/bin/env python3
"""
Audit CDN for Mauna Loa stations - last 24 hours
Shows what files and metadata actually exist on cdn.now.audio
"""
import requests
import json
from datetime import datetime, timedelta, timezone

CDN_BASE = "https://cdn.now.audio"

# Mauna Loa stations
maunaloa_stations = [
    {'network': 'HV', 'station': 'MOKD', 'location': '--', 'channel': 'HHZ'},
    {'network': 'HV', 'station': 'MOKE', 'location': '--', 'channel': 'HHZ'},
    {'network': 'HV', 'station': 'MOKL', 'location': '--', 'channel': 'HHZ'},
    {'network': 'HV', 'station': 'MOKT', 'location': '--', 'channel': 'HHZ'},
    {'network': 'HV', 'station': 'MOKB', 'location': '--', 'channel': 'BHZ'},
]

# Get last 24 hours dates
now = datetime.now(timezone.utc)
dates = [
    (now - timedelta(days=1)).strftime('%Y/%m/%d'),
    now.strftime('%Y/%m/%d')
]

print(f"🔍 Auditing CDN for Mauna Loa stations")
print(f"📅 Dates: {[d.replace('/', '-') for d in dates]}")
print(f"🌐 CDN: {CDN_BASE}")
print("=" * 80)
print()

for station_config in maunaloa_stations:
    network = station_config['network']
    station = station_config['station']
    location = station_config['location']
    channel = station_config['channel']
    
    print(f"🔍 Station: {network}.{station}.{location}.{channel}")
    print("-" * 80)
    
    for date_path in dates:
        date_str = date_path.replace('/', '-')
        
        # Check metadata
        metadata_url = f"{CDN_BASE}/data/{date_path}/{network}/maunaloa/{station}/{location}/{channel}/{network}_{station}_{location}_{channel}_{date_str}.json"
        
        try:
            response = requests.get(metadata_url, timeout=5)
            
            if response.status_code == 200:
                metadata = response.json()
                
                print(f"  📋 {date_str} Metadata: ✅ EXISTS")
                chunks_10m = metadata['chunks'].get('10m', [])
                chunks_1h = metadata['chunks'].get('1h', [])
                chunks_6h = metadata['chunks'].get('6h', [])
                
                print(f"     Chunks: 10m={len(chunks_10m)}, 1h={len(chunks_1h)}, 6h={len(chunks_6h)}")
                
                # Show time range of chunks
                if chunks_10m:
                    print(f"     10m range: {chunks_10m[0]['start']} to {chunks_10m[-1]['end']}")
                
                # Check a sample binary file for each type
                for chunk_type, chunks in [('10m', chunks_10m), ('1h', chunks_1h), ('6h', chunks_6h)]:
                    if chunks:
                        # Check first chunk
                        first_chunk = chunks[0]
                        start_str = first_chunk['start'].replace(':', '-')
                        end_str = first_chunk['end'].replace(':', '-')
                        
                        sample_url = f"{CDN_BASE}/data/{date_path}/{network}/maunaloa/{station}/{location}/{channel}/{chunk_type}/{network}_{station}_{location}_{channel}_{chunk_type}_{date_str}-{start_str}_to_{date_str}-{end_str}.bin.zst"
                        
                        sample_response = requests.head(sample_url, timeout=5)
                        if sample_response.status_code == 200:
                            size_kb = int(sample_response.headers.get('content-length', 0)) / 1024
                            print(f"     Sample {chunk_type}: ✅ EXISTS ({size_kb:.1f} KB)")
                        else:
                            print(f"     Sample {chunk_type}: ❌ MISSING (HTTP {sample_response.status_code})")
            else:
                print(f"  📋 {date_str} Metadata: ❌ MISSING (HTTP {response.status_code})")
                
        except requests.exceptions.Timeout:
            print(f"  📋 {date_str} Metadata: ⏱️ TIMEOUT")
        except Exception as e:
            print(f"  📋 {date_str} Metadata: ❌ ERROR ({str(e)})")
    
    print()

print("=" * 80)
print("✅ Audit complete!")

