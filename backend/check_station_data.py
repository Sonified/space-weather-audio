#!/usr/bin/env python3
"""
IRIS Station Data Checker

Quick script to check if IRIS has data for a specific station and time period.
Useful for debugging missing data or verifying data availability.

Usage:
    # Check specific station and time range
    python check_station_data.py AV SSLS -- BHZ 2025-11-15 00:40:00 00:50:00
    
    # Or modify the defaults below and run without arguments
    python check_station_data.py

Examples:
    # Check SSLS for first 30 minutes of Nov 15, 2025
    python check_station_data.py AV SSLS -- BHZ 2025-11-15 00:00:00 00:30:00
    
    # Check different station
    python check_station_data.py HV NPOC -- HHZ 2025-11-15 00:00:00 01:00:00
"""

import sys
from datetime import datetime, timezone
from obspy import UTCDateTime
from obspy.clients.fdsn import Client

# ============================================================================
# DEFAULTS - Modify these for quick testing without command-line arguments
# ============================================================================
DEFAULT_NETWORK = "AV"
DEFAULT_STATION = "SSLS"
DEFAULT_LOCATION = "--"  # Use "--" for empty location, will be converted to "" for IRIS
DEFAULT_CHANNEL = "BHZ"
DEFAULT_SAMPLE_RATE = 50.0  # Used for expected sample calculation
DEFAULT_START_TIME = datetime(2025, 11, 15, 0, 40, 0, tzinfo=timezone.utc)
DEFAULT_END_TIME = datetime(2025, 11, 15, 0, 50, 0, tzinfo=timezone.utc)


def parse_datetime(date_str, time_str):
    """Parse date and time strings into UTC datetime."""
    try:
        # Try parsing as "YYYY-MM-DD HH:MM:SS"
        if ' ' in date_str:
            return datetime.strptime(date_str, '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
        # Otherwise combine date and time
        dt_str = f"{date_str} {time_str}"
        return datetime.strptime(dt_str, '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
    except ValueError as e:
        print(f"❌ Error parsing datetime: {e}")
        print(f"   Expected format: YYYY-MM-DD HH:MM:SS")
        sys.exit(1)


def check_station_data(network, station, location, channel, start_time, end_time, sample_rate):
    """Check IRIS for data availability and print detailed information."""
    print(f"🔍 Checking IRIS for {network}.{station}.{location}.{channel}")
    print(f"   Time range: {start_time.strftime('%Y-%m-%d %H:%M:%S')} to {end_time.strftime('%H:%M:%S')} UTC")
    print()
    
    try:
        client = Client("IRIS")
        
        # Convert location: "--" becomes empty string for IRIS
        location_clean = "" if location == "--" else location
        
        print(f"📡 Fetching from IRIS...")
        stream = client.get_waveforms(
            network=network,
            station=station,
            location=location_clean,
            channel=channel,
            starttime=UTCDateTime(start_time),
            endtime=UTCDateTime(end_time)
        )
        
        if len(stream) == 0:
            print(f"❌ No data returned from IRIS")
            print(f"\n💡 This confirms that IRIS does not have data for this time period.")
            print(f"   The collector would have skipped this window.")
            return
        
        print(f"✅ Got {len(stream)} trace(s)")
        
        # Check each trace
        for i, trace in enumerate(stream):
            print(f"\n📊 Trace {i+1}:")
            print(f"   Start: {trace.stats.starttime}")
            print(f"   End: {trace.stats.endtime}")
            print(f"   Samples: {len(trace.data)}")
            print(f"   Sample rate: {trace.stats.sampling_rate} Hz")
            print(f"   Network: {trace.stats.network}")
            print(f"   Station: {trace.stats.station}")
            print(f"   Location: {trace.stats.location}")
            print(f"   Channel: {trace.stats.channel}")
        
        # Check for gaps
        gaps = stream.get_gaps()
        if gaps:
            print(f"\n⚠️  {len(gaps)} gap(s) detected:")
            for gap in gaps:
                gap_start = UTCDateTime(gap[4])
                gap_end = UTCDateTime(gap[5])
                duration = gap_end - gap_start
                print(f"   Gap: {gap_start} to {gap_end} (duration: {duration:.2f} seconds)")
        else:
            print(f"\n✅ No gaps detected")
        
        # Calculate expected samples
        requested_duration = (end_time - start_time).total_seconds()
        expected_samples = int(requested_duration * sample_rate)
        total_samples = sum(len(trace.data) for trace in stream)
        
        print(f"\n📈 Summary:")
        print(f"   Expected samples: {expected_samples}")
        print(f"   Total samples: {total_samples}")
        print(f"   Coverage: {(total_samples / expected_samples * 100):.1f}%")
        
    except Exception as e:
        error_str = str(e)
        if "No data available" in error_str or "204" in error_str:
            print(f"❌ No data available from IRIS for this time period")
            print(f"\n💡 This confirms that IRIS does not have data for this time window.")
            print(f"   The collector would have skipped this window.")
        else:
            print(f"❌ Error: {e}")
            import traceback
            traceback.print_exc()


def main():
    """Main entry point - handles command-line arguments or uses defaults."""
    if len(sys.argv) == 1:
        # No arguments - use defaults
        print("ℹ️  Using default values (modify script defaults or use command-line args)")
        print()
        check_station_data(
            DEFAULT_NETWORK,
            DEFAULT_STATION,
            DEFAULT_LOCATION,
            DEFAULT_CHANNEL,
            DEFAULT_START_TIME,
            DEFAULT_END_TIME,
            DEFAULT_SAMPLE_RATE
        )
    elif len(sys.argv) == 8:
        # Command-line arguments: network station location channel date start_time end_time
        network = sys.argv[1]
        station = sys.argv[2]
        location = sys.argv[3]
        channel = sys.argv[4]
        date_str = sys.argv[5]
        start_time_str = sys.argv[6]
        end_time_str = sys.argv[7]
        
        start_time = parse_datetime(date_str, start_time_str)
        end_time = parse_datetime(date_str, end_time_str)
        
        # Try to infer sample rate from common values
        # (You may want to adjust this based on channel type)
        if channel.startswith('BH') or channel.startswith('HH'):
            sample_rate = 50.0 if 'Z' in channel else 50.0
        elif channel.startswith('EH'):
            sample_rate = 100.0
        else:
            sample_rate = 50.0  # Default fallback
        
        check_station_data(network, station, location, channel, start_time, end_time, sample_rate)
    else:
        print("Usage:")
        print("  python check_station_data.py")
        print("  python check_station_data.py NETWORK STATION LOCATION CHANNEL DATE START_TIME END_TIME")
        print()
        print("Examples:")
        print("  python check_station_data.py AV SSLS -- BHZ 2025-11-15 00:40:00 00:50:00")
        print("  python check_station_data.py HV NPOC -- HHZ 2025-11-15 00:00:00 01:00:00")
        sys.exit(1)


if __name__ == "__main__":
    main()

