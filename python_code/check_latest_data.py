#!/usr/bin/env python3
"""
Simple script to check how recent the available seismic data is from IRIS.
This will help determine if there's a lag between real-time and data availability.
"""

import requests
from datetime import datetime, timedelta, timezone
from obspy import read
import os

def main():
    # Current time in UTC and Alaska
    utc_now = datetime.now(timezone.utc)
    ak_offset = timedelta(hours=-8)  # Use -9 during standard time
    alaska_time = utc_now + ak_offset
    
    print(f"Current UTC time: {utc_now.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Current Alaska time: {alaska_time.strftime('%Y-%m-%d %H:%M:%S')}")
    
    # Set up time window for last 6 hours
    end_time_utc = utc_now
    start_time_utc = end_time_utc - timedelta(hours=6)
    
    # Format times for API
    end_str = end_time_utc.strftime("%Y-%m-%dT%H:%M:%S")
    start_str = start_time_utc.strftime("%Y-%m-%dT%H:%M:%S")
    
    print(f"Requesting data from {start_str} to {end_str} UTC")
    
    # Temporary file for the data
    temp_file = "temp_latest_data.mseed"
    
    # Fetch data from IRIS
    url = "https://service.iris.edu/fdsnws/dataselect/1/query"
    params = {
        "net": "AV",
        "sta": "SPCN",
        "loc": "--",
        "cha": "BHZ",
        "start": start_str,
        "end": end_str,
        "format": "miniseed",
        "nodata": 404
    }
    
    try:
        response = requests.get(url, params=params)
        
        if response.status_code == 200:
            with open(temp_file, "wb") as f:
                f.write(response.content)
            
            # Read the data to check actual time range
            st = read(temp_file)
            
            if len(st) > 0:
                data_start = st[0].stats.starttime
                data_end = st[0].stats.endtime
                
                # Convert to Python datetime
                data_end_dt = datetime(
                    data_end.year, data_end.month, data_end.day,
                    data_end.hour, data_end.minute, data_end.second,
                    data_end.microsecond, tzinfo=timezone.utc
                )
                
                # Calculate time lag
                lag = utc_now - data_end_dt
                
                print(f"\nLatest data available:")
                print(f"Data start: {data_start}")
                print(f"Data end: {data_end}")
                print(f"Data end (Alaska time): {(data_end_dt + ak_offset).strftime('%Y-%m-%d %H:%M:%S')}")
                print(f"\nLag between now and latest data: {lag}")
                print(f"Lag in hours: {lag.total_seconds() / 3600:.2f} hours")
            else:
                print("No data returned from IRIS")
        else:
            print(f"❌ Error {response.status_code}: No data found or request failed.")
    except Exception as e:
        print(f"Error fetching data: {e}")
    
    # Clean up
    if os.path.exists(temp_file):
        os.remove(temp_file)

if __name__ == "__main__":
    main() 