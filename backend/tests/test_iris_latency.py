#!/usr/bin/env python3
"""
Test IRIS data latency - measure delay between latest available data and current time.
Tests the 3 closest stations for each of the 5 main volcanoes with 30-minute data requests.
"""

import sys
from datetime import datetime, timedelta, timezone
from obspy import UTCDateTime
from obspy.clients.fdsn import Client
import time

# Station data - 3 closest stations per volcano
TEST_STATIONS = {
    "kilauea": [
        {"network": "HV", "station": "UWE", "location": "", "channel": "HHZ", "distance_km": 0.4},
        {"network": "HV", "station": "OBL", "location": "", "channel": "HHZ", "distance_km": 0.5},
        {"network": "HV", "station": "UWB", "location": "", "channel": "HHZ", "distance_km": 1.1},
    ],
    "maunaloa": [
        {"network": "HV", "station": "MOKD", "location": "", "channel": "HHZ", "distance_km": 1.6},
        {"network": "HV", "station": "SWRD", "location": "", "channel": "EHZ", "distance_km": 2.6},
        {"network": "HV", "station": "WILD", "location": "", "channel": "EHZ", "distance_km": 3.0},
    ],
    "greatsitkin": [
        {"network": "AV", "station": "GSTD", "location": "", "channel": "BHZ", "distance_km": 3.3},
        {"network": "AV", "station": "GSTR", "location": "", "channel": "BHZ", "distance_km": 4.1},
        {"network": "AV", "station": "GSSP", "location": "", "channel": "BHZ", "distance_km": 4.9},
    ],
    "shishaldin": [
        {"network": "AV", "station": "SSLS", "location": "", "channel": "BHZ", "distance_km": 5.4},
        {"network": "AV", "station": "SSLN", "location": "", "channel": "BHZ", "distance_km": 6.5},
        {"network": "AV", "station": "SSBA", "location": "", "channel": "BHZ", "distance_km": 10.1},
    ],
    "spurr": [
        {"network": "AV", "station": "SPCP", "location": "", "channel": "BHZ", "distance_km": 6.4},
        {"network": "AV", "station": "SPBG", "location": "", "channel": "BHZ", "distance_km": 7.7},
        {"network": "AV", "station": "SPCN", "location": "", "channel": "BHZ", "distance_km": 9.2},
    ],
}

def test_station_latency(volcano, station_info, duration_minutes=30):
    """
    Test latency for a single station by requesting recent data and checking the latest timestamp.
    
    Returns:
        dict with latency info or None if failed
    """
    network = station_info["network"]
    station = station_info["station"]
    location = station_info["location"] or "--"
    channel = station_info["channel"]
    distance = station_info["distance_km"]
    
    now_utc = datetime.now(timezone.utc)
    
    # Request data ending NOW (most recent 30 minutes)
    duration_seconds = duration_minutes * 60
    start_time = now_utc - timedelta(seconds=duration_seconds)
    end_time = now_utc
    
    start_str = start_time.strftime("%Y-%m-%dT%H:%M:%S")
    end_str = end_time.strftime("%Y-%m-%dT%H:%M:%S")
    
    print(f"  📡 Testing {network}.{station}.{location}.{channel} (distance: {distance}km)")
    print(f"     Request: {start_str} to {end_str}")
    
    try:
        client = Client("IRIS")
        
        # Request data (sequential, not concurrent)
        starttime = UTCDateTime(start_str)
        endtime = UTCDateTime(end_str)
        
        request_start = time.time()
        st = client.get_waveforms(
            network=network,
            station=station,
            location=location if location != "--" else "",
            channel=channel,
            starttime=starttime,
            endtime=endtime
        )
        request_time = time.time() - request_start
        
        if not st or len(st) == 0:
            print(f"     ❌ No data returned")
            return None
        
        # Merge traces and get latest timestamp
        st.merge(method=1, fill_value='interpolate')
        trace = st[0]
        
        # Get the latest timestamp from the trace
        latest_timestamp = trace.stats.endtime.datetime.replace(tzinfo=timezone.utc)
        
        # Calculate latency
        latency_seconds = (now_utc - latest_timestamp).total_seconds()
        latency_minutes = latency_seconds / 60
        
        # Get sample count
        sample_count = len(trace.data)
        sample_rate = trace.stats.sampling_rate
        
        # Calculate expected samples for 30 minutes
        expected_samples = duration_seconds * sample_rate
        
        # Data completeness (how much of the 30 minutes we got)
        completeness = (sample_count / expected_samples * 100) if expected_samples > 0 else 0
        
        result = {
            "volcano": volcano,
            "network": network,
            "station": station,
            "location": location,
            "channel": channel,
            "distance_km": distance,
            "request_start": start_str,
            "request_end": end_str,
            "latest_data_timestamp": latest_timestamp.isoformat(),
            "current_time": now_utc.isoformat(),
            "latency_seconds": latency_seconds,
            "latency_minutes": latency_minutes,
            "sample_count": sample_count,
            "sample_rate": sample_rate,
            "completeness_percent": completeness,
            "request_time_seconds": request_time,
        }
        
        print(f"     ✅ Latest data: {latest_timestamp.strftime('%Y-%m-%d %H:%M:%S UTC')}")
        print(f"     ⏱️  Latency: {latency_minutes:.2f} minutes ({latency_seconds:.0f} seconds)")
        print(f"     📊 Samples: {sample_count:,} / {expected_samples:,.0f} expected ({completeness:.1f}% complete)")
        print(f"     ⚡ Request time: {request_time:.2f}s")
        
        return result
        
    except Exception as e:
        print(f"     ❌ Error: {str(e)}")
        return None

def main():
    """Test latency for all stations sequentially"""
    print("=" * 80)
    print("IRIS Data Latency Test")
    print("=" * 80)
    print(f"Start time: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print(f"Testing 3 closest stations per volcano, 30-minute data requests")
    print(f"Running sequentially to avoid IRIS rate limiting")
    print("=" * 80)
    print()
    
    all_results = []
    total_stations = sum(len(stations) for stations in TEST_STATIONS.values())
    current_station = 0
    
    for volcano, stations in TEST_STATIONS.items():
        print(f"\n🌋 {volcano.upper()}")
        print("-" * 80)
        
        for station_info in stations:
            current_station += 1
            print(f"\n[{current_station}/{total_stations}] Testing station...")
            
            result = test_station_latency(volcano, station_info, duration_minutes=30)
            
            if result:
                all_results.append(result)
            
            # Small delay between requests to be nice to IRIS
            if current_station < total_stations:
                time.sleep(1)
    
    # Summary
    print("\n" + "=" * 80)
    print("SUMMARY")
    print("=" * 80)
    
    if not all_results:
        print("❌ No successful requests")
        return
    
    # Calculate statistics
    latencies = [r["latency_minutes"] for r in all_results]
    avg_latency = sum(latencies) / len(latencies)
    min_latency = min(latencies)
    max_latency = max(latencies)
    
    # Group by volcano
    by_volcano = {}
    for result in all_results:
        volcano = result["volcano"]
        if volcano not in by_volcano:
            by_volcano[volcano] = []
        by_volcano[volcano].append(result)
    
    print(f"\nOverall Statistics:")
    print(f"  Successful requests: {len(all_results)}/{total_stations}")
    print(f"  Average latency: {avg_latency:.2f} minutes")
    print(f"  Min latency: {min_latency:.2f} minutes")
    print(f"  Max latency: {max_latency:.2f} minutes")
    
    print(f"\nBy Volcano:")
    for volcano, results in by_volcano.items():
        vol_latencies = [r["latency_minutes"] for r in results]
        vol_avg = sum(vol_latencies) / len(vol_latencies)
        vol_min = min(vol_latencies)
        vol_max = max(vol_latencies)
        print(f"  {volcano}: avg={vol_avg:.2f}min, min={vol_min:.2f}min, max={vol_max:.2f}min")
    
    # Recommendation for cron timing
    print(f"\n📅 Cron Job Timing Recommendation:")
    print(f"  Based on max latency of {max_latency:.2f} minutes:")
    
    # Round up to nearest minute for safety margin
    recommended_delay = int(max_latency) + 1
    print(f"  Recommended delay: {recommended_delay} minutes after the hour")
    print(f"  Suggested cron schedule: */10 minutes, starting at :{recommended_delay:02d}")
    print(f"  Example: Every 10 minutes at :{recommended_delay:02d}, :{recommended_delay+10:02d}, :{recommended_delay+20:02d}, etc.")
    
    # Alternative: If latency is low, suggest shorter intervals
    if max_latency < 5:
        print(f"\n  ⚡ Low latency detected! Consider:")
        print(f"     - Running every 5 minutes at :{recommended_delay:02d}, :{recommended_delay+5:02d}, etc.")
        print(f"     - Or every 3 minutes for near-real-time updates")
    
    print("\n" + "=" * 80)
    print("Detailed Results:")
    print("=" * 80)
    for result in all_results:
        print(f"\n{result['volcano']} - {result['network']}.{result['station']}.{result['channel']}")
        print(f"  Latest data: {result['latest_data_timestamp']}")
        print(f"  Latency: {result['latency_minutes']:.2f} minutes")
        print(f"  Completeness: {result['completeness_percent']:.1f}%")

if __name__ == "__main__":
    main()

