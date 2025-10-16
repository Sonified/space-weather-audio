#!/usr/bin/env python3
"""
Station Latency Test
Check how fresh the data actually is for various volcano stations
"""

from obspy.clients.fdsn import Client
from obspy import UTCDateTime
import sys

def get_latest_available_time(station_config, location=""):
    """
    Query IRIS to find the actual latest available data timestamp
    Uses a sliding window to find where data ends
    """
    client = Client("IRIS")
    now = UTCDateTime.now()
    
    # Start checking from 10 minutes ago and work backwards
    test_intervals = [
        (now - 600, now),      # Last 10 min
        (now - 1800, now - 600),  # 10-30 min ago
        (now - 3600, now - 1800), # 30-60 min ago
        (now - 7200, now - 3600), # 1-2 hours ago
        (now - 21600, now - 7200), # 2-6 hours ago
    ]
    
    for start, end in test_intervals:
        try:
            stream = client.get_waveforms(
                network=station_config['network'],
                station=station_config['station'],
                location=location,
                channel=station_config['channel'],
                starttime=start,
                endtime=end
            )
            if stream and len(stream) > 0:
                latest = stream[0].stats.endtime
                return latest
        except Exception:
            continue
    
    return None

def test_station_latency():
    """
    Test data latency for multiple volcano stations
    """
    print("=" * 80)
    print("VOLCANO STATION LATENCY TEST")
    print("=" * 80)
    
    # Load all active stations from our audit
    import json
    from pathlib import Path
    
    repo_root = Path(__file__).resolve().parent.parent
    active_path = repo_root / 'data' / 'reference' / 'active_volcano_stations.json'
    
    with open(active_path) as f:
        active_data = json.load(f)
    
    # Get unique Kilauea HHZ stations
    kilauea_stations = {}
    for d in active_data:
        if d['volcano'] == 'Kilauea' and d['type'] == 'seismic' and 'HHZ' in d.get('channel', ''):
            key = (d['network'], d['station'], d.get('location', ''))
            if key not in kilauea_stations:
                kilauea_stations[key] = {
                    'name': 'Kilauea',
                    'network': d['network'],
                    'station': d['station'],
                    'channel': 'HHZ',
                    'location': d.get('location', '')
                }
    
    # Add a few key stations from other volcanoes
    stations = list(kilauea_stations.values())
    stations.extend([
        {'name': 'Spurr', 'network': 'AV', 'station': 'BGL', 'channel': 'HHZ', 'location': ''},
        {'name': 'Spurr', 'network': 'AV', 'station': 'SPCN', 'channel': 'BHZ', 'location': ''},
        {'name': 'Shishaldin', 'network': 'AV', 'station': 'SSLS', 'channel': 'HHZ', 'location': ''},
    ])
    
    now = UTCDateTime.now()
    print(f"\nCurrent UTC time: {now}")
    print(f"\nTesting {len(stations)} stations...\n")
    print(f"{'Volcano':<15} {'Station':<10} {'Channel':<8} {'Latency (min)':<15} {'Status':<20}")
    print("-" * 80)
    
    results = []
    
    for station in stations:
        station_id = f"{station['network']}.{station['station']}"
        loc = station.get('location', '')
        if loc:
            station_id += f".{loc}"
        station_id += f".{station['channel']}"
        
        try:
            latest = get_latest_available_time(station, location=loc)
            
            if latest:
                latency_seconds = now - latest
                latency_minutes = latency_seconds / 60
                
                if latency_minutes < 5:
                    status = "✓ Near real-time"
                elif latency_minutes < 30:
                    status = "✓ Fresh"
                elif latency_minutes < 120:
                    status = "⚠ Delayed"
                else:
                    status = "⚠ Very delayed"
                
                results.append({
                    'name': station['name'],
                    'station': station_id,
                    'latency': latency_minutes,
                    'status': status
                })
                
                print(f"{station['name']:<15} {station_id:<10} {station['channel']:<8} {latency_minutes:>10.1f} min   {status:<20}")
            else:
                print(f"{station['name']:<15} {station_id:<10} {station['channel']:<8} {'N/A':>15}   ✗ No recent data")
                
        except Exception as e:
            print(f"{station['name']:<15} {station_id:<10} {station['channel']:<8} {'ERROR':>15}   ✗ {str(e)[:30]}")
    
    # Summary
    if results:
        print("\n" + "=" * 80)
        print("SUMMARY")
        print("=" * 80)
        
        best = min(results, key=lambda x: x['latency'])
        print(f"\n🎯 BEST (lowest latency): {best['station']}")
        print(f"   Latency: {best['latency']:.1f} minutes")
        print(f"   Status: {best['status']}")
        
        # Group by volcano
        print("\n📊 By Volcano:")
        volcanoes = {}
        for r in results:
            if r['name'] not in volcanoes:
                volcanoes[r['name']] = []
            volcanoes[r['name']].append(r)
        
        for volcano, stations in sorted(volcanoes.items()):
            best_station = min(stations, key=lambda x: x['latency'])
            print(f"   {volcano}: {best_station['station']} @ {best_station['latency']:.1f} min latency")
        
        print("=" * 80)

if __name__ == '__main__':
    try:
        test_station_latency()
    except KeyboardInterrupt:
        print("\n\n⚠️  Test interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n\n❌ Test failed: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)

