#!/usr/bin/env python3
"""
Generate embedded stations data for test_streaming.html
Filters for active stations within 20km for the 5 volcanoes.
"""

import json
from pathlib import Path

# Volcano mapping (name in file -> key for embedded data)
VOLCANO_MAPPING = {
    "Kilauea": "kilauea",
    "Mauna Loa": "maunaloa",
    "Great Sitkin": "greatsitkin",
    "Shishaldin": "shishaldin",
    "Spurr": "spurr"
}

MAX_DISTANCE_KM = 20.0

def generate_embedded_stations():
    """Generate embedded stations JavaScript constant from volcano_station_availability.json"""
    
    repo_root = Path(__file__).resolve().parent
    availability_path = repo_root / 'data' / 'reference' / 'volcano_station_availability.json'
    
    if not availability_path.exists():
        print(f"❌ File not found: {availability_path}")
        return None
    
    print(f"📖 Reading {availability_path}...")
    with open(availability_path, 'r') as f:
        data = json.load(f)
    
    embedded = {}
    
    for entry in data:
        volcano_name = entry.get('name')
        if volcano_name not in VOLCANO_MAPPING:
            continue
        
        key = VOLCANO_MAPPING[volcano_name]
        lat = entry.get('lat')
        lon = entry.get('lon')
        
        # Filter seismic channels: active (no end_time), within 20km
        seismic_channels = []
        for ch in entry.get('seismic_channels', []):
            if (not ch.get('end_time') and  # Active (no end_time)
                ch.get('distance_km', 999) <= MAX_DISTANCE_KM):  # Within 20km
                seismic_channels.append({
                    'network': ch['network'],
                    'station': ch['station'],
                    'location': ch.get('location', ''),
                    'channel': ch['channel'],
                    'distance_km': round(ch.get('distance_km', 0), 1),
                    'sample_rate': ch.get('sample_rate', 0.0),
                    'priority': 0 if ch['channel'].endswith('Z') else 1  # Z-component is priority 0
                })
        
        # Filter infrasound channels: active (no end_time), within 20km
        infrasound_channels = []
        for ch in entry.get('infrasound_channels', []):
            if (not ch.get('end_time') and  # Active
                ch.get('distance_km', 999) <= MAX_DISTANCE_KM):  # Within 20km
                infrasound_channels.append({
                    'network': ch['network'],
                    'station': ch['station'],
                    'location': ch.get('location', ''),
                    'channel': ch['channel'],
                    'distance_km': round(ch.get('distance_km', 0), 1),
                    'sample_rate': ch.get('sample_rate', 0.0)
                })
        
        # Sort by distance (closest first)
        seismic_channels.sort(key=lambda x: x['distance_km'])
        infrasound_channels.sort(key=lambda x: x['distance_km'])
        
        embedded[key] = {
            'name': volcano_name,
            'lat': lat,
            'lon': lon,
            'seismic': seismic_channels,
            'infrasound': infrasound_channels
        }
        
        print(f"✅ {volcano_name}: {len(seismic_channels)} seismic, {len(infrasound_channels)} infrasound (within {MAX_DISTANCE_KM}km)")
    
    # Generate JavaScript constant (minified single line to match existing format)
    js_code = json.dumps(embedded, separators=(',', ':'))
    
    js_output = f"        const EMBEDDED_STATIONS = {js_code};"
    
    return js_output, embedded

if __name__ == '__main__':
    result = generate_embedded_stations()
    if result:
        js_output, embedded_data = result
        print("\n" + "="*80)
        print("Generated JavaScript constant:")
        print("="*80)
        print(js_output)
        print("="*80)
        
        # Write to file for easy copy-paste
        output_path = Path(__file__).resolve().parent / 'embedded_stations_output.txt'
        with open(output_path, 'w') as f:
            f.write(js_output)
        print(f"\n💾 Also saved to: {output_path}")

