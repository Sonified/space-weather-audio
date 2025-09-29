#!/usr/bin/env python3
"""
Test timezone detection for volcano stations using coordinates from IRIS metadata
"""

from timezonefinder import TimezoneFinder
import pytz
from datetime import datetime

def test_timezone_detection():
    """Test timezone detection for Mt. Spurr and Kilauea"""
    
    # Initialize timezone finder
    tf = TimezoneFinder()
    
    # Station coordinates from IRIS metadata
    stations = {
        "Mt. Spurr (SPCN)": {
            "lat": 61.223675,
            "lon": -152.18403,
            "network": "AV",
            "expected_tz": "US/Alaska"
        },
        "Kilauea (OBL)": {
            "lat": 19.417662,
            "lon": -155.284097,
            "network": "HV", 
            "expected_tz": "US/Hawaii"
        }
    }
    
    print("Testing Timezone Detection for Volcano Stations")
    print("=" * 50)
    
    for station_name, info in stations.items():
        print(f"\n🌋 {station_name}")
        print(f"   Coordinates: {info['lat']:.6f}°N, {info['lon']:.6f}°W")
        print(f"   Network: {info['network']}")
        
        # Get timezone string from coordinates
        timezone_str = tf.timezone_at(lat=info['lat'], lng=info['lon'])
        
        if timezone_str:
            print(f"   Detected timezone: {timezone_str}")
            
            # Get timezone object
            tz = pytz.timezone(timezone_str)
            
            # Test current time in that timezone
            utc_now = datetime.now(pytz.UTC)
            local_time = utc_now.astimezone(tz)
            
            print(f"   Current UTC time: {utc_now.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            print(f"   Current local time: {local_time.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            print(f"   UTC offset: {local_time.strftime('%z')}")
            
            # Check if it matches expected
            expected_tz = pytz.timezone(info['expected_tz'])
            expected_local = utc_now.astimezone(expected_tz)
            
            print(f"   Expected timezone: {info['expected_tz']}")
            print(f"   Expected local time: {expected_local.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            
            # Compare
            if timezone_str == expected_tz.zone:
                print("   ✅ MATCH: Detected timezone matches expected!")
            elif local_time.utctimetuple() == expected_local.utctimetuple():
                print("   ✅ EQUIVALENT: Times match (different timezone name)")
            else:
                print("   ❌ MISMATCH: Different timezone detected")
                
        else:
            print("   ❌ ERROR: Could not determine timezone from coordinates")

if __name__ == "__main__":
    test_timezone_detection()
