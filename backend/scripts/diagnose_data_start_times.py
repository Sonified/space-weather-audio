#!/usr/bin/env python3
"""
Diagnostic script to check how far after quantized 10-minute windows data actually starts.
Checks all active stations 24 hours ago at the top of the hour, progressing in 10-minute chunks.
"""

from datetime import datetime, timezone, timedelta
from obspy import UTCDateTime
from obspy.clients.fdsn import Client

# Active stations from stations_config.json
ACTIVE_STATIONS = [
    {"network": "HV", "station": "OBL", "location": "--", "channel": "HHZ", "sample_rate": 100.0, "volcano": "Kilauea"},
    {"network": "HV", "station": "MOKD", "location": "--", "channel": "HHZ", "sample_rate": 100.0, "volcano": "Maunaloa"},
    {"network": "AV", "station": "GSTD", "location": "--", "channel": "BHZ", "sample_rate": 50.0, "volcano": "Great Sitkin"},
    {"network": "AV", "station": "SSLS", "location": "--", "channel": "BHZ", "sample_rate": 50.0, "volcano": "Shishaldin"},
    {"network": "AV", "station": "SPCP", "location": "--", "channel": "BHZ", "sample_rate": 50.0, "volcano": "Spurr"},
]

def check_chunk(network, station, location, channel, volcano, sample_rate, start_time, end_time):
    """Check a single 10-minute chunk and report when data actually starts."""
    try:
        client = Client("IRIS")
        location_clean = "" if location == "--" else location
        
        stream = client.get_waveforms(
            network=network,
            station=station,
            location=location_clean,
            channel=channel,
            starttime=UTCDateTime(start_time),
            endtime=UTCDateTime(end_time)
        )
        
        if len(stream) == 0:
            return None, "No data"
        
        # Get the first trace (after merging if needed)
        trace = stream[0]
        actual_start = datetime.fromtimestamp(trace.stats.starttime.timestamp, tz=timezone.utc)
        
        # Calculate delay
        delay_seconds = (actual_start - start_time).total_seconds()
        delay_samples = int(round(delay_seconds * sample_rate))
        
        return {
            "actual_start": actual_start,
            "delay_seconds": delay_seconds,
            "delay_samples": delay_samples,
            "samples": len(trace.data),
            "expected_samples": int((end_time - start_time).total_seconds() * sample_rate)
        }, None
        
    except Exception as e:
        error_str = str(e)
        if "No data available" in error_str or "204" in error_str:
            return None, "No data available"
        return None, str(e)


def main():
    # Calculate 24 hours ago at the top of the hour
    now = datetime.now(timezone.utc)
    yesterday = now - timedelta(days=1)
    top_of_hour = yesterday.replace(minute=0, second=0, microsecond=0)
    
    print("=" * 80)
    print(f"Data Start Time Diagnostic")
    print(f"Checking 24 hours ago: {top_of_hour.strftime('%Y-%m-%d %H:%M:%S')} UTC")
    print(f"Current time: {now.strftime('%Y-%m-%d %H:%M:%S')} UTC")
    print("=" * 80)
    print()
    
    # Check 3 chunks: 00:00-00:10, 00:10-00:20, 00:20-00:30
    chunks = [
        (timedelta(minutes=0), timedelta(minutes=10)),
        (timedelta(minutes=10), timedelta(minutes=20)),
        (timedelta(minutes=20), timedelta(minutes=30)),
    ]
    
    results = {}
    
    for station_info in ACTIVE_STATIONS:
        network = station_info["network"]
        station = station_info["station"]
        location = station_info["location"]
        channel = station_info["channel"]
        volcano = station_info["volcano"]
        sample_rate = station_info["sample_rate"]
        
        station_id = f"{network}.{station}.{location}.{channel}"
        print(f"\n{'='*80}")
        print(f"{volcano} - {station_id} ({sample_rate} Hz)")
        print(f"{'='*80}")
        
        results[station_id] = []
        
        for chunk_offset, chunk_end_offset in chunks:
            chunk_start = top_of_hour + chunk_offset
            chunk_end = top_of_hour + chunk_end_offset
            
            start_str = chunk_start.strftime("%H:%M:%S")
            end_str = chunk_end.strftime("%H:%M:%S")
            
            print(f"\n  Chunk: {start_str} - {end_str}")
            result, error = check_chunk(
                network, station, location, channel, volcano, sample_rate,
                chunk_start, chunk_end
            )
            
            if error:
                print(f"    ❌ {error}")
                results[station_id].append({
                    "chunk": f"{start_str}-{end_str}",
                    "error": error
                })
            elif result:
                actual_start_str = result["actual_start"].strftime("%H:%M:%S.%f")[:-3]
                delay_sec = result["delay_seconds"]
                delay_samples = result["delay_samples"]
                
                if delay_sec == 0:
                    print(f"    ✅ Starts exactly on time")
                    print(f"       Actual start: {actual_start_str}")
                    print(f"       Samples: {result['samples']:,} (expected {result['expected_samples']:,})")
                elif delay_sec > 0:
                    print(f"    ⚠️  Starts {delay_sec:.3f} seconds late ({delay_samples} samples)")
                    print(f"       Requested: {start_str}")
                    print(f"       Actual:    {actual_start_str}")
                    print(f"       Samples: {result['samples']:,} (expected {result['expected_samples']:,})")
                else:
                    print(f"    ℹ️  Starts early (unexpected)")
                    print(f"       Actual start: {actual_start_str}")
                
                results[station_id].append({
                    "chunk": f"{start_str}-{end_str}",
                    "requested_start": start_str,
                    "actual_start": actual_start_str,
                    "delay_seconds": delay_sec,
                    "delay_samples": delay_samples,
                    "samples": result["samples"],
                    "expected_samples": result["expected_samples"]
                })
    
    # Summary
    print(f"\n\n{'='*80}")
    print("SUMMARY")
    print(f"{'='*80}")
    
    for station_id, chunk_results in results.items():
        print(f"\n{station_id}:")
        delays = [r.get("delay_seconds", 0) for r in chunk_results if "delay_seconds" in r]
        if delays:
            max_delay = max(delays)
            avg_delay = sum(delays) / len(delays)
            print(f"  Max delay: {max_delay:.3f} seconds")
            print(f"  Avg delay: {avg_delay:.3f} seconds")
            if max_delay > 0:
                print(f"  ⚠️  Some chunks start late - may need beginning padding")
        else:
            print(f"  No data available for any chunks")


if __name__ == "__main__":
    main()

