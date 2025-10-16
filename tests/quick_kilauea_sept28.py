#!/usr/bin/env python3
"""
Quick script to generate 24 hours of Kilauea data for Sept 28th
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from python_code.seismic_utils import fetch_seismic_data
from python_code.audio_utils import create_audio_file
from datetime import datetime

def quick_kilauea_audio():
    print("🌋 Generating 24 hours of Kilauea audio for Sept 27th...")
    
    # Use Sept 27th Kilauea data
    start_str = "2025-09-27T00:00:00"
    end_str = "2025-09-27T23:59:59"
    
    # Files with proper paths
    mseed_file = "mseed_files/Kilauea_Sept27_24h.mseed"
    audio_file = "Audio_Files/Kilauea_Sept27_24h.wav"
    
    # Create directories
    os.makedirs("mseed_files", exist_ok=True)
    os.makedirs("Audio_Files", exist_ok=True)
    
    print(f"📅 Requesting: {start_str} to {end_str} UTC")
    print(f"📡 Station: HV.OBL.HHZ (Kilauea)")
    
    # Fetch data
    st = fetch_seismic_data(start_str, end_str, mseed_file, network="HV", station="OBL", channel="HHZ")
    
    if st:
        print(f"✅ Got data! Creating audio...")
        
        # Show what we actually got
        data_start = st[0].stats.starttime
        data_end = st[0].stats.endtime
        duration_hours = (data_end - data_start) / 3600
        
        print(f"📊 Actual data: {data_start} to {data_end} ({duration_hours:.1f} hours)")
        
        # Create audio at 75kHz like your system
        create_audio_file(st, 75000, audio_file)
        
        print(f"🎵 Audio saved: {audio_file}")
        print(f"📁 Data saved: {mseed_file}")
        
        # Calculate playback time
        total_samples = duration_hours * 3600 * 100  # 100 Hz sampling
        playback_seconds = total_samples / 75000
        playback_minutes = playback_seconds / 60
        
        print(f"⚡ Playback time: {playback_minutes:.1f} minutes ({duration_hours*3600/playback_seconds:.0f}x speedup)")
        
    else:
        print("❌ No data returned")

if __name__ == "__main__":
    quick_kilauea_audio()
