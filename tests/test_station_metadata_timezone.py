#!/usr/bin/env python3
"""
Test fetching station metadata from IRIS and automatically determining timezone
"""

import requests
from timezonefinder import TimezoneFinder
import pytz
from datetime import datetime

def fetch_station_timezone(network, station):
    """
    Fetch station metadata from IRIS and determine timezone from coordinates
    
    Args:
        network (str): Network code (e.g., 'AV', 'HV')
        station (str): Station code (e.g., 'SPCN', 'OBL')
        
    Returns:
        dict: Station info including timezone
    """
    # Fetch station metadata from IRIS
    url = "https://service.iris.edu/fdsnws/station/1/query"
    params = {
        "net": network,
        "sta": station,
        "level": "station",
        "format": "text"
    }
    
    try:
        response = requests.get(url, params=params)
        response.raise_for_status()
        
        # Parse the response (skip header line)
        lines = response.text.strip().split('\n')
        if len(lines) < 2:
            raise ValueError("No station data returned")
            
        # Parse station data (format: Network|Station|Latitude|Longitude|Elevation|SiteName|StartTime|EndTime)
        data_line = lines[1]  # Skip header
        fields = data_line.split('|')
        
        if len(fields) < 6:
            raise ValueError(f"Invalid station data format: {data_line}")
            
        station_info = {
            'network': fields[0],
            'station': fields[1], 
            'latitude': float(fields[2]),
            'longitude': float(fields[3]),
            'elevation': float(fields[4]),
            'site_name': fields[5],
            'start_time': fields[6] if len(fields) > 6 else None,
            'end_time': fields[7] if len(fields) > 7 else None
        }
        
        # Determine timezone from coordinates
        tf = TimezoneFinder()
        timezone_str = tf.timezone_at(lat=station_info['latitude'], lng=station_info['longitude'])
        
        if timezone_str:
            station_info['timezone'] = timezone_str
            station_info['timezone_obj'] = pytz.timezone(timezone_str)
        else:
            raise ValueError(f"Could not determine timezone for coordinates {station_info['latitude']}, {station_info['longitude']}")
            
        return station_info
        
    except Exception as e:
        raise RuntimeError(f"Failed to fetch station metadata for {network}.{station}: {e}")

def test_station_metadata_fetch():
    """Test fetching metadata and timezone for multiple stations"""
    
    test_stations = [
        ("AV", "SPCN"),  # Mt. Spurr
        ("HV", "OBL"),   # Kilauea
    ]
    
    print("Testing Station Metadata and Timezone Detection")
    print("=" * 55)
    
    for network, station in test_stations:
        print(f"\n🌋 Testing {network}.{station}")
        
        try:
            station_info = fetch_station_timezone(network, station)
            
            print(f"   Site: {station_info['site_name']}")
            print(f"   Coordinates: {station_info['latitude']:.6f}°N, {station_info['longitude']:.6f}°W")
            print(f"   Elevation: {station_info['elevation']:.1f}m")
            print(f"   Timezone: {station_info['timezone']}")
            
            # Test current time conversion
            utc_now = datetime.now(pytz.UTC)
            local_time = utc_now.astimezone(station_info['timezone_obj'])
            
            print(f"   Current UTC: {utc_now.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            print(f"   Current Local: {local_time.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            print(f"   UTC Offset: {local_time.strftime('%z')}")
            print("   ✅ Success!")
            
        except Exception as e:
            print(f"   ❌ Error: {e}")

if __name__ == "__main__":
    test_station_metadata_fetch()
