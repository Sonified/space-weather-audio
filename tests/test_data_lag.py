#!/usr/bin/env python3
"""
Test data lag for all station presets
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from python_code.seismic_utils import fetch_seismic_data, compute_time_window
from datetime import datetime
import tempfile

def test_station_lag(network, station, channel, name):
    """Test actual data lag for a station"""
    print(f"\n🌋 {name} ({network}.{station}.{channel}):")
    
    try:
        # Get last few hours of data
        start_str, end_str, end_time = compute_time_window(0.25)  # 6 hours
        
        # Create unique temp file  
        import uuid
        tmp_path = f"/tmp/lag_test_{network}_{station}_{channel}_{uuid.uuid4().hex[:8]}.mseed"
        
        # Remove if exists
        try:
            os.unlink(tmp_path)
        except:
            pass
        
        # Fetch data
        st = fetch_seismic_data(start_str, end_str, tmp_path, network=network, station=station, channel=channel)
        
        if st and len(st) > 0:
            # Get latest sample timestamp
            latest_sample = st[0].stats.endtime
            latest_py = datetime(latest_sample.year, latest_sample.month, latest_sample.day,
                               latest_sample.hour, latest_sample.minute, latest_sample.second)
            
            # Calculate lag
            now = datetime.utcnow()
            lag_seconds = (now - latest_py).total_seconds()
            lag_minutes = lag_seconds / 60
            lag_hours = lag_minutes / 60
            
            print(f"  📅 Latest sample:  {latest_py.strftime('%Y-%m-%d %H:%M:%S')} UTC")
            print(f"  🕐 Current time:   {now.strftime('%Y-%m-%d %H:%M:%S')} UTC")
            print(f"  ⏰ Data lag:       {lag_minutes:.1f} minutes ({lag_hours:.1f} hours)")
            
        else:
            print("  ❌ No data returned")
            
        # Clean up
        try:
            os.unlink(tmp_path)
        except:
            pass
            
    except Exception as e:
        print(f"  ❌ Error: {e}")

if __name__ == "__main__":
    print("=" * 60)
    print("DATA LAG TEST FOR ALL STATION PRESETS")
    print("=" * 60)
    
    current_time = datetime.utcnow()
    print(f"Test started: {current_time.strftime('%Y-%m-%d %H:%M:%S')} UTC")
    
    # Test all stations from presets
    test_station_lag("AV", "SPCN", "BHZ", "Mt. Spurr")
    test_station_lag("HV", "OBL", "HHZ", "Kilauea Observatory Bluff")  
    test_station_lag("HV", "UWE", "HHZ", "Kilauea Uwekauhane Seismic")
    test_station_lag("HV", "UWE", "HDF", "Kilauea Uwekauhane Infrasound")
    
    print("\n" + "=" * 60)
    print("Test completed!")
