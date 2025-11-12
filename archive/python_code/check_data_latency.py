#!/usr/bin/env python3
"""
Check data latency from IRIS by querying progressively smaller time windows.
This will help determine how recent the available data is and the data lag time.
"""

import os
from datetime import datetime, timedelta, timezone
from obspy import UTCDateTime, read
import requests

def fetch_seismic_data(start_str, end_str, filename="temp_latest_latency.mseed", 
                      network="AV", station="SPCN", channel="BHZ"):
    """Fetch seismic data from IRIS for a given time window"""
    # Fetch data from IRIS
    url = "https://service.iris.edu/fdsnws/dataselect/1/query"
    params = {
        "net": network,
        "sta": station,
        "loc": "--",
        "cha": channel,
        "start": start_str,
        "end": end_str,
        "format": "miniseed",
        "nodata": 404
    }
    
    response = requests.get(url, params=params)
    
    # Save if successful
    if response.status_code == 200:
        with open(filename, "wb") as f:
            f.write(response.content)
        return read(filename)
    else:
        print(f"❌ Error {response.status_code}: No data found or request failed.")
        return None

def main():
    """Test data latency by checking progressively smaller time windows"""
    # Current time in UTC
    utc_now = datetime.now(timezone.utc)
    print(f"Current UTC time: {utc_now.strftime('%Y-%m-%d %H:%M:%S')}")
    
    # Calculate Alaska time
    ak_offset = timedelta(hours=-8)  # Use -9 during standard time
    alaska_time = utc_now + ak_offset
    print(f"Current Alaska time: {alaska_time.strftime('%Y-%m-%d %H:%M:%S')}")
    
    # Temp file for data
    temp_file = "temp_latest_latency.mseed"
    
    # Test various time windows to find the latest available data
    windows = [
        ("24 hours ago", utc_now - timedelta(hours=24)),
        ("18 hours ago", utc_now - timedelta(hours=18)),
        ("15 hours ago", utc_now - timedelta(hours=15)),
        ("12 hours ago", utc_now - timedelta(hours=12)),
        ("9 hours ago", utc_now - timedelta(hours=9)),
        ("6 hours ago", utc_now - timedelta(hours=6)),
        ("3 hours ago", utc_now - timedelta(hours=3)),
        ("1 hour ago", utc_now - timedelta(hours=1)),
        ("30 minutes ago", utc_now - timedelta(minutes=30)),
        ("15 minutes ago", utc_now - timedelta(minutes=15))
    ]
    
    latest_data_time = None
    
    print("\n=== Testing data availability for different time windows ===")
    
    for label, start_time in windows:
        # Format times for API
        start_str = start_time.strftime("%Y-%m-%dT%H:%M:%S")
        end_str = utc_now.strftime("%Y-%m-%dT%H:%M:%S")
        
        print(f"\nRequesting data from {label} ({start_str}) to now")
        
        stream = fetch_seismic_data(start_str, end_str, temp_file)
        
        if stream and len(stream) > 0:
            data_start = stream[0].stats.starttime
            data_end = stream[0].stats.endtime
            
            # Calculate gap between latest data and now
            latest_data_dt = datetime(
                data_end.year, data_end.month, data_end.day,
                data_end.hour, data_end.minute, data_end.second,
                data_end.microsecond, tzinfo=timezone.utc
            )
            time_gap = utc_now - latest_data_dt
            
            print(f"Data received: {data_start} to {data_end}")
            print(f"Gap between latest data and now: {time_gap}")
            print(f"Gap in hours: {time_gap.total_seconds() / 3600:.2f} hours")
            
            latest_data_time = data_end
        else:
            print("No data returned")
    
    if latest_data_time:
        latest_data_dt = datetime(
            latest_data_time.year, latest_data_time.month, latest_data_time.day,
            latest_data_time.hour, latest_data_time.minute, latest_data_time.second,
            latest_data_time.microsecond, tzinfo=timezone.utc
        )
        
        # Calculate time difference from now
        time_diff = utc_now - latest_data_dt
        
        print("\n=== Summary ===")
        print(f"Latest data timestamp: {latest_data_time}")
        print(f"Latest data (Alaska time): {(latest_data_dt + ak_offset).strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"Data lag: {time_diff}")
        print(f"Data lag in hours: {time_diff.total_seconds() / 3600:.2f} hours")
    
    # Clean up temp file
    if os.path.exists(temp_file):
        os.remove(temp_file)

if __name__ == "__main__":
    main() 