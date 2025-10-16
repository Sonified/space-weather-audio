#!/usr/bin/env python3
"""
Test downloading data in 1-hour chunks to get full 24 hours
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from python_code.seismic_utils import fetch_seismic_data
from datetime import datetime, timedelta

def download_hourly_chunks():
    print("🌋 Testing hourly chunk downloads for Kilauea...")
    
    # Start from 24 hours ago
    end_time = datetime.utcnow()
    start_time = end_time - timedelta(hours=24)
    
    print(f"📅 Full period: {start_time.strftime('%Y-%m-%d %H:%M')} to {end_time.strftime('%Y-%m-%d %H:%M')} UTC")
    print(f"📡 Station: HV.OBL.HHZ")
    print("=" * 60)
    
    # Create directory
    os.makedirs("mseed_files/hourly_chunks", exist_ok=True)
    
    successful_chunks = 0
    total_hours = 0
    
    # Download each hour
    for hour in range(24):
        chunk_start = start_time + timedelta(hours=hour)
        chunk_end = chunk_start + timedelta(hours=1)
        
        start_str = chunk_start.strftime('%Y-%m-%dT%H:%M:%S')
        end_str = chunk_end.strftime('%Y-%m-%dT%H:%M:%S')
        
        filename = f"mseed_files/hourly_chunks/kilauea_hour_{hour:02d}_{chunk_start.strftime('%Y%m%d_%H%M')}.mseed"
        
        print(f"Hour {hour:2d}: {chunk_start.strftime('%H:%M')} to {chunk_end.strftime('%H:%M')} UTC", end=" ")
        
        try:
            st = fetch_seismic_data(start_str, end_str, filename, network="HV", station="OBL", channel="HHZ")
            
            if st and len(st) > 0:
                data_start = st[0].stats.starttime
                data_end = st[0].stats.endtime
                duration_minutes = (data_end - data_start) / 60
                
                file_size = os.path.getsize(filename) / 1024 / 1024  # MB
                
                print(f"✅ {duration_minutes:.1f} min ({file_size:.1f} MB)")
                successful_chunks += 1
                total_hours += duration_minutes / 60
            else:
                print("❌ No data")
                # Remove empty file
                try:
                    os.unlink(filename)
                except:
                    pass
                    
        except Exception as e:
            print(f"❌ Error: {e}")
            try:
                os.unlink(filename)
            except:
                pass
    
    print("=" * 60)
    print(f"📊 Summary:")
    print(f"   Successful chunks: {successful_chunks}/24")
    print(f"   Total data hours: {total_hours:.1f}")
    print(f"   Success rate: {successful_chunks/24*100:.1f}%")
    
    if successful_chunks > 0:
        print(f"   Files saved in: mseed_files/hourly_chunks/")

if __name__ == "__main__":
    download_hourly_chunks()











