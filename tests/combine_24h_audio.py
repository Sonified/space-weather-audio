#!/usr/bin/env python3
"""
Combine 24 hours of hourly chunks into one audio file
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from python_code.audio_utils import create_audio_file
from obspy import read, Stream
import glob

def combine_24h_audio():
    print("🎵 Combining 24 hours of Kilauea chunks into audio...")
    
    # Find all hourly chunk files
    chunk_files = sorted(glob.glob("mseed_files/hourly_chunks/kilauea_hour_*.mseed"))
    
    if not chunk_files:
        print("❌ No chunk files found!")
        return
        
    print(f"📁 Found {len(chunk_files)} chunk files")
    
    # Create combined stream
    combined_stream = Stream()
    
    print("🔗 Combining chunks...")
    for i, chunk_file in enumerate(chunk_files):
        try:
            st = read(chunk_file)
            if st:
                combined_stream += st
                print(f"  ✅ Hour {i:2d}: {os.path.basename(chunk_file)}")
            else:
                print(f"  ❌ Hour {i:2d}: Empty file")
        except Exception as e:
            print(f"  ❌ Hour {i:2d}: Error - {e}")
    
    if len(combined_stream) == 0:
        print("❌ No data to combine!")
        return
        
    # Merge traces if needed
    combined_stream.merge(fill_value=0)
    
    # Show combined info
    total_duration = (combined_stream[0].stats.endtime - combined_stream[0].stats.starttime) / 3600
    print(f"📊 Combined: {total_duration:.1f} hours of data")
    
    # Create audio
    output_file = "Audio_Files/Kilauea_24h_Combined.wav"
    print(f"🎵 Creating audio: {output_file}")
    
    create_audio_file(combined_stream, 75000, output_file)
    
    # Calculate playback stats
    total_samples = total_duration * 3600 * 100  # 100 Hz
    playback_seconds = total_samples / 75000
    playback_minutes = playback_seconds / 60
    speedup = (total_duration * 3600) / playback_seconds
    
    print(f"✅ Audio created!")
    print(f"   Duration: {playback_minutes:.1f} minutes")
    print(f"   Speedup: {speedup:.0f}x")
    print(f"   File: {output_file}")

if __name__ == "__main__":
    combine_24h_audio()











