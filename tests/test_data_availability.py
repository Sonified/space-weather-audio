#!/usr/bin/env python3
"""
Test script to check data availability from IRIS for a specific time window.
This will help diagnose why we're not getting a full 24 hours of data when requested.
"""

import os
from datetime import datetime, timedelta, timezone
from obspy import UTCDateTime, read
import requests
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

def fetch_seismic_data(start_str, end_str, filename="temp_test.mseed", 
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
        print(f"✅ Downloaded and saved file: {filename}")
        return read(filename)
    else:
        print(f"❌ Error {response.status_code}: No data found or request failed.")
        return None

def main():
    """Test data availability for different time windows"""
    # Current time in UTC
    utc_now = datetime.now(timezone.utc)
    print(f"Current UTC time: {utc_now.strftime('%Y-%m-%d %H:%M:%S')}")
    
    # Calculate Alaska time
    ak_offset = timedelta(hours=-8)  # Use -9 during standard time
    alaska_time = utc_now + ak_offset
    print(f"Current Alaska time: {alaska_time.strftime('%Y-%m-%d %H:%M:%S')}")
    
    print("\n=== Testing data availability for the past 24 hours ===")
    
    # Test 1: Last 24 hours
    end_time_1 = utc_now
    start_time_1 = end_time_1 - timedelta(days=1)
    
    # Format times for API
    start_str_1 = start_time_1.strftime("%Y-%m-%dT%H:%M:%S")
    end_str_1 = end_time_1.strftime("%Y-%m-%dT%H:%M:%S")
    
    print(f"Test 1: Requesting data from {start_str_1} to {end_str_1} UTC")
    stream_1 = fetch_seismic_data(start_str_1, end_str_1, "test1_data.mseed")
    
    if stream_1 and len(stream_1) > 0:
        data_start = stream_1[0].stats.starttime
        data_end = stream_1[0].stats.endtime
        duration = data_end - data_start
        
        print(f"Actual data received: {data_start} to {data_end} UTC")
        print(f"Duration: {duration:.2f} seconds ({duration/3600:.2f} hours)")
        
        # Check for gaps
        gaps = stream_1.get_gaps()
        if gaps:
            print(f"Found {len(gaps)} gaps in data")
            for gap in gaps:
                print(f"  Gap: {gap[4]} to {gap[5]}, duration: {gap[6]:.2f} seconds")
        else:
            print("No gaps found in the data")
    
    print("\n=== Testing data availability for previous day ===")
    
    # Test 2: Previous day (calendar day)
    day_ago = utc_now - timedelta(days=1)
    day_start = day_ago.replace(hour=0, minute=0, second=0, microsecond=0)
    day_end = day_start + timedelta(days=1) - timedelta(microseconds=1)
    
    # Format times for API
    start_str_2 = day_start.strftime("%Y-%m-%dT%H:%M:%S")
    end_str_2 = day_end.strftime("%Y-%m-%dT%H:%M:%S")
    
    print(f"Test 2: Requesting data from {start_str_2} to {end_str_2} UTC")
    stream_2 = fetch_seismic_data(start_str_2, end_str_2, "test2_data.mseed")
    
    if stream_2 and len(stream_2) > 0:
        data_start = stream_2[0].stats.starttime
        data_end = stream_2[0].stats.endtime
        duration = data_end - data_start
        
        print(f"Actual data received: {data_start} to {data_end} UTC")
        print(f"Duration: {duration:.2f} seconds ({duration/3600:.2f} hours)")
    
    print("\n=== Testing data availability for older data ===")
    
    # Test 3: Two days ago (full day)
    two_days_ago = utc_now - timedelta(days=2)
    day_start = two_days_ago.replace(hour=0, minute=0, second=0, microsecond=0)
    day_end = day_start + timedelta(days=1) - timedelta(microseconds=1)
    
    # Format times for API
    start_str_3 = day_start.strftime("%Y-%m-%dT%H:%M:%S")
    end_str_3 = day_end.strftime("%Y-%m-%dT%H:%M:%S")
    
    print(f"Test 3: Requesting data from {start_str_3} to {end_str_3} UTC")
    stream_3 = fetch_seismic_data(start_str_3, end_str_3, "test3_data.mseed")
    
    if stream_3 and len(stream_3) > 0:
        data_start = stream_3[0].stats.starttime
        data_end = stream_3[0].stats.endtime
        duration = data_end - data_start
        
        print(f"Actual data received: {data_start} to {data_end} UTC")
        print(f"Duration: {duration:.2f} seconds ({duration/3600:.2f} hours)")
    
    # Clean up temp files
    for file in ["test1_data.mseed", "test2_data.mseed", "test3_data.mseed"]:
        if os.path.exists(file):
            os.remove(file)
    
    print("\nTests completed.")

if __name__ == "__main__":
    main() 