"""
Find IRIS stations that use Anderson's seismometer models
"""
from obspy.clients.fdsn import Client
from obspy import UTCDateTime
import json

print("="*80)
print("FINDING STATIONS WITH ANDERSON'S SEISMOMETER MODELS")
print("="*80)

# Load Anderson's coefficients to see what models we have
with open('data/anderson_coefficients.json') as f:
    anderson = json.load(f)

# Extract unique seismometer types
seismometer_types = set()
for key, data in anderson.items():
    seismometer_types.add(data['seismometer'])

print(f"\nAnderson has coefficients for {len(seismometer_types)} seismometer types:")
for seis in sorted(seismometer_types):
    print(f"  - {seis}")

# Search for stations with these specific instruments
# We'll search IU network (global seismic network) which has good metadata
client = Client("IRIS")

print("\n" + "="*80)
print("SEARCHING FOR STATIONS (IU network, 2010-2020)")
print("="*80)

# Focus on a few key seismometer types that are most common
target_seismometers = [
    ('CMG-3T', ['CMG-3T', 'CMG3T', 'Guralp CMG-3T']),
    ('CMG-40T', ['CMG-40T', 'CMG40T', 'Guralp CMG-40T']),
    ('STS-2', ['STS-2', 'STS2', 'Streckeisen STS-2']),
    ('Trillium-120', ['Trillium 120', 'T120', 'Trillium-120']),
]

found_stations = {}

for seis_name, search_strings in target_seismometers:
    print(f"\n{seis_name}:")
    
    try:
        # Get inventory for IU network around 2015
        inv = client.get_stations(
            network="IU",
            channel="BHZ",  # Broadband high gain, vertical
            starttime=UTCDateTime("2015-01-01"),
            endtime=UTCDateTime("2015-12-31"),
            level="response"
        )
        
        # Check each station
        for network in inv:
            for station in network:
                for channel in station:
                    # Check if this channel has sensor info
                    if channel.sensor and channel.sensor.description:
                        desc = channel.sensor.description.lower()
                        
                        # Check if any of our search strings match
                        for search_str in search_strings:
                            if search_str.lower() in desc:
                                key = f"{network.code}.{station.code}.{channel.location_code}.{channel.code}"
                                
                                if seis_name not in found_stations:
                                    found_stations[seis_name] = []
                                
                                found_stations[seis_name].append({
                                    'network': network.code,
                                    'station': station.code,
                                    'location': channel.location_code,
                                    'channel': channel.code,
                                    'description': channel.sensor.description,
                                    'latitude': station.latitude,
                                    'longitude': station.longitude,
                                    'start': str(channel.start_date),
                                    'end': str(channel.end_date) if channel.end_date else 'present'
                                })
                                
                                print(f"  ✓ {key}: {channel.sensor.description}")
                                break
        
    except Exception as e:
        print(f"  ✗ Error: {e}")

print("\n" + "="*80)
print("SUMMARY")
print("="*80)

for seis_name, stations in found_stations.items():
    print(f"\n{seis_name}: {len(stations)} stations found")
    for sta in stations[:3]:  # Show first 3
        print(f"  {sta['network']}.{sta['station']}.{sta['location']}.{sta['channel']}")

# Save results
print("\nSaving to data/anderson_test_stations.json...")
with open('data/anderson_test_stations.json', 'w') as f:
    json.dump(found_stations, f, indent=2)
print("✓ Saved!")

print("\n" + "="*80)
print(f"Found {sum(len(v) for v in found_stations.values())} total stations")
print("="*80)

