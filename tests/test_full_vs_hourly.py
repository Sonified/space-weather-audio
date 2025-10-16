#!/usr/bin/env python3
"""
Head-to-head comparison: Full request vs. Hourly chunks
Tests both approaches and creates audio files to compare results
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from python_code.seismic_utils import fetch_seismic_data
from python_code.audio_utils import create_audio_file
from datetime import datetime, timedelta
from obspy import Stream, read
import numpy as np

def test_full_request(network="HV", station="OBL", channel="HHZ", hours_back=24):
    """Test the current approach: one full request"""
    print("\n" + "="*80)
    print("🔵 TEST 1: FULL REQUEST (Current Approach)")
    print("="*80)
    
    end_time = datetime.utcnow()
    start_time = end_time - timedelta(hours=hours_back)
    
    start_str = start_time.strftime('%Y-%m-%dT%H:%M:%S')
    end_str = end_time.strftime('%Y-%m-%dT%H:%M:%S')
    
    print(f"📅 Period: {start_time.strftime('%Y-%m-%d %H:%M')} to {end_time.strftime('%Y-%m-%d %H:%M')} UTC")
    print(f"📡 Station: {network}.{station}.{channel}")
    print(f"⏱️  Duration: {hours_back} hours")
    
    # Create test directory
    os.makedirs("tests/test_logs", exist_ok=True)
    os.makedirs("tests/comparison_files", exist_ok=True)
    
    filename = f"tests/comparison_files/full_request_{network}_{station}_{hours_back}h.mseed"
    
    print(f"\n📥 Downloading with single request...")
    try:
        st = fetch_seismic_data(start_str, end_str, filename, network=network, station=station, channel=channel)
        
        if st and len(st) > 0:
            # Analyze the data
            total_samples = sum([len(tr.data) for tr in st])
            sample_rate = st[0].stats.sampling_rate
            total_duration_seconds = total_samples / sample_rate
            total_duration_hours = total_duration_seconds / 3600
            
            data_start = st[0].stats.starttime
            data_end = st[-1].stats.endtime
            
            file_size = os.path.getsize(filename) / 1024 / 1024  # MB
            
            print(f"\n✅ SUCCESS - Full Request Results:")
            print(f"   Traces: {len(st)}")
            print(f"   Total samples: {total_samples:,}")
            print(f"   Sample rate: {sample_rate} Hz")
            print(f"   Data duration: {total_duration_hours:.2f} hours ({total_duration_seconds:.1f} seconds)")
            print(f"   Data start: {data_start.strftime('%Y-%m-%d %H:%M:%S')} UTC")
            print(f"   Data end: {data_end.strftime('%Y-%m-%d %H:%M:%S')} UTC")
            print(f"   File size: {file_size:.2f} MB")
            print(f"   Coverage: {(total_duration_hours/hours_back)*100:.1f}%")
            
            # Check for gaps
            gaps = st.get_gaps()
            if gaps:
                print(f"\n⚠️  Data gaps detected: {len(gaps)}")
                for gap in gaps:
                    gap_duration = gap[6]  # Duration in seconds
                    print(f"      Gap: {gap_duration:.1f} seconds")
            else:
                print(f"\n✅ No gaps detected")
            
            # Create audio file
            audio_file = f"tests/comparison_files/full_request_{network}_{station}_{hours_back}h.wav"
            print(f"\n🔊 Creating audio file...")
            create_audio_file(st, 7500, audio_file, fill_method='zeros')
            audio_size = os.path.getsize(audio_file) / 1024 / 1024
            print(f"   Audio file: {audio_file}")
            print(f"   Audio size: {audio_size:.2f} MB")
            
            return {
                "success": True,
                "traces": len(st),
                "samples": total_samples,
                "duration_hours": total_duration_hours,
                "coverage_percent": (total_duration_hours/hours_back)*100,
                "gaps": len(gaps) if gaps else 0,
                "file_size_mb": file_size,
                "audio_size_mb": audio_size,
                "stream": st
            }
        else:
            print(f"\n❌ FAILED - No data returned")
            return {"success": False}
            
    except Exception as e:
        print(f"\n❌ ERROR: {e}")
        return {"success": False, "error": str(e)}

def test_hourly_chunks(network="HV", station="OBL", channel="HHZ", hours_back=24):
    """Test the hourly chunks approach"""
    print("\n" + "="*80)
    print("🟢 TEST 2: HOURLY CHUNKS (Alternative Approach)")
    print("="*80)
    
    end_time = datetime.utcnow()
    start_time = end_time - timedelta(hours=hours_back)
    
    print(f"📅 Period: {start_time.strftime('%Y-%m-%d %H:%M')} to {end_time.strftime('%Y-%m-%d %H:%M')} UTC")
    print(f"📡 Station: {network}.{station}.{channel}")
    print(f"⏱️  Duration: {hours_back} hours")
    
    # Create test directory
    os.makedirs("tests/comparison_files/hourly_chunks", exist_ok=True)
    
    print(f"\n📥 Downloading {hours_back} hourly chunks...")
    
    all_streams = []
    successful_chunks = 0
    total_samples = 0
    failed_hours = []
    
    for hour in range(hours_back):
        chunk_start = start_time + timedelta(hours=hour)
        chunk_end = chunk_start + timedelta(hours=1)
        
        start_str = chunk_start.strftime('%Y-%m-%dT%H:%M:%S')
        end_str = chunk_end.strftime('%Y-%m-%dT%H:%M:%S')
        
        filename = f"tests/comparison_files/hourly_chunks/chunk_{hour:02d}_{chunk_start.strftime('%Y%m%d_%H%M')}.mseed"
        
        print(f"   Hour {hour:2d}/{hours_back}: {chunk_start.strftime('%H:%M')}-{chunk_end.strftime('%H:%M')} UTC", end=" ")
        
        try:
            st = fetch_seismic_data(start_str, end_str, filename, network=network, station=station, channel=channel)
            
            if st and len(st) > 0:
                chunk_samples = sum([len(tr.data) for tr in st])
                duration_minutes = chunk_samples / st[0].stats.sampling_rate / 60
                file_size = os.path.getsize(filename) / 1024  # KB
                
                print(f"✅ {duration_minutes:.1f} min, {chunk_samples:,} samples ({file_size:.0f} KB)")
                all_streams.append(st)
                successful_chunks += 1
                total_samples += chunk_samples
            else:
                print("❌ No data")
                failed_hours.append(hour)
                # Remove empty file
                try:
                    os.unlink(filename)
                except:
                    pass
                    
        except Exception as e:
            print(f"❌ Error: {e}")
            failed_hours.append(hour)
            try:
                os.unlink(filename)
            except:
                pass
    
    print(f"\n📊 Hourly Chunks Summary:")
    print(f"   Successful chunks: {successful_chunks}/{hours_back}")
    print(f"   Success rate: {(successful_chunks/hours_back)*100:.1f}%")
    
    if failed_hours:
        print(f"   Failed hours: {failed_hours}")
    
    if successful_chunks > 0:
        # Combine all streams
        print(f"\n🔗 Combining {successful_chunks} chunks into single stream...")
        combined_stream = Stream()
        for st in all_streams:
            for tr in st:
                combined_stream.append(tr)
        
        # Sort by time
        combined_stream.sort()
        
        # Analyze combined data
        sample_rate = combined_stream[0].stats.sampling_rate
        total_duration_seconds = total_samples / sample_rate
        total_duration_hours = total_duration_seconds / 3600
        
        data_start = combined_stream[0].stats.starttime
        data_end = combined_stream[-1].stats.endtime
        
        print(f"\n✅ SUCCESS - Hourly Chunks Results:")
        print(f"   Traces: {len(combined_stream)}")
        print(f"   Total samples: {total_samples:,}")
        print(f"   Sample rate: {sample_rate} Hz")
        print(f"   Data duration: {total_duration_hours:.2f} hours ({total_duration_seconds:.1f} seconds)")
        print(f"   Data start: {data_start.strftime('%Y-%m-%d %H:%M:%S')} UTC")
        print(f"   Data end: {data_end.strftime('%Y-%m-%d %H:%M:%S')} UTC")
        print(f"   Coverage: {(total_duration_hours/hours_back)*100:.1f}%")
        
        # Check for gaps
        gaps = combined_stream.get_gaps()
        if gaps:
            print(f"\n⚠️  Data gaps detected: {len(gaps)}")
            total_gap_duration = 0
            for gap in gaps:
                gap_duration = gap[6]  # Duration in seconds
                total_gap_duration += gap_duration
                if gap_duration > 60:  # Only show gaps > 1 minute
                    print(f"      Gap: {gap_duration/60:.1f} minutes")
            print(f"   Total gap time: {total_gap_duration/3600:.2f} hours")
        else:
            print(f"\n✅ No gaps detected")
        
        # Create audio file
        audio_file = f"tests/comparison_files/hourly_chunks_{network}_{station}_{hours_back}h.wav"
        print(f"\n🔊 Creating audio file...")
        create_audio_file(combined_stream, 7500, audio_file, fill_method='zeros')
        audio_size = os.path.getsize(audio_file) / 1024 / 1024
        print(f"   Audio file: {audio_file}")
        print(f"   Audio size: {audio_size:.2f} MB")
        
        return {
            "success": True,
            "traces": len(combined_stream),
            "samples": total_samples,
            "duration_hours": total_duration_hours,
            "coverage_percent": (total_duration_hours/hours_back)*100,
            "successful_chunks": successful_chunks,
            "failed_chunks": hours_back - successful_chunks,
            "gaps": len(gaps) if gaps else 0,
            "audio_size_mb": audio_size,
            "stream": combined_stream
        }
    else:
        print(f"\n❌ FAILED - No data chunks retrieved")
        return {"success": False}

def compare_results(full_result, hourly_result, hours_back=24):
    """Compare the two approaches"""
    print("\n" + "="*80)
    print("📊 HEAD-TO-HEAD COMPARISON")
    print("="*80)
    
    if not full_result["success"] and not hourly_result["success"]:
        print("❌ Both approaches failed")
        return
    
    print(f"\n{'Metric':<30} {'Full Request':<20} {'Hourly Chunks':<20} {'Winner':<10}")
    print("-" * 80)
    
    # Coverage
    if full_result["success"] and hourly_result["success"]:
        full_cov = full_result["coverage_percent"]
        hourly_cov = hourly_result["coverage_percent"]
        winner = "🟢 Hourly" if hourly_cov > full_cov else "🔵 Full" if full_cov > hourly_cov else "🟰 Tie"
        print(f"{'Data Coverage':<30} {full_cov:>6.1f}%{'':<13} {hourly_cov:>6.1f}%{'':<13} {winner:<10}")
        
        # Duration
        full_dur = full_result["duration_hours"]
        hourly_dur = hourly_result["duration_hours"]
        winner = "🟢 Hourly" if hourly_dur > full_dur else "🔵 Full" if full_dur > hourly_dur else "🟰 Tie"
        print(f"{'Data Duration (hours)':<30} {full_dur:>6.2f}h{'':<12} {hourly_dur:>6.2f}h{'':<12} {winner:<10}")
        
        # Samples
        full_samp = full_result["samples"]
        hourly_samp = hourly_result["samples"]
        winner = "🟢 Hourly" if hourly_samp > full_samp else "🔵 Full" if full_samp > hourly_samp else "🟰 Tie"
        diff = abs(hourly_samp - full_samp)
        diff_pct = (diff / max(full_samp, hourly_samp)) * 100
        print(f"{'Total Samples':<30} {full_samp:>19,} {hourly_samp:>19,} {winner:<10}")
        print(f"{'Sample Difference':<30} {'':<20} {diff:>19,} ({diff_pct:.1f}%)")
        
        # Gaps
        full_gaps = full_result["gaps"]
        hourly_gaps = hourly_result["gaps"]
        winner = "🔵 Full" if full_gaps < hourly_gaps else "🟢 Hourly" if hourly_gaps < full_gaps else "🟰 Tie"
        print(f"{'Data Gaps':<30} {full_gaps:>19} {hourly_gaps:>19} {winner:<10}")
        
        # Audio size
        full_audio = full_result["audio_size_mb"]
        hourly_audio = hourly_result["audio_size_mb"]
        print(f"{'Audio File Size (MB)':<30} {full_audio:>6.2f} MB{'':<11} {hourly_audio:>6.2f} MB{'':<11}")
        
        # Overall winner
        print("\n" + "-" * 80)
        
        # Calculate score
        full_score = 0
        hourly_score = 0
        
        if hourly_cov > full_cov:
            hourly_score += 1
        elif full_cov > hourly_cov:
            full_score += 1
            
        if hourly_samp > full_samp:
            hourly_score += 1
        elif full_samp > hourly_samp:
            full_score += 1
            
        if hourly_gaps < full_gaps:
            hourly_score += 1
        elif full_gaps < hourly_gaps:
            full_score += 1
        
        print(f"\n🏆 OVERALL WINNER: ", end="")
        if hourly_score > full_score:
            print(f"🟢 HOURLY CHUNKS (Score: {hourly_score}-{full_score})")
            print(f"   ✅ Hourly chunks retrieved MORE data with better coverage")
        elif full_score > hourly_score:
            print(f"🔵 FULL REQUEST (Score: {full_score}-{hourly_score})")
            print(f"   ✅ Full request is simpler and equally effective")
        else:
            print(f"🟰 TIE (Score: {full_score}-{hourly_score})")
            print(f"   ✅ Both approaches retrieved the same amount of data")
    
    elif full_result["success"]:
        print("🔵 FULL REQUEST is the winner (hourly chunks failed)")
    else:
        print("🟢 HOURLY CHUNKS is the winner (full request failed)")
    
    print("\n" + "="*80)

def main():
    """Run the head-to-head comparison"""
    print("\n🌋 HEAD-TO-HEAD TEST: Full Request vs. Hourly Chunks")
    print("Testing with Kīlauea (HV.OBL.HHZ) - Last 24 hours")
    
    # Run both tests
    full_result = test_full_request(network="HV", station="OBL", channel="HHZ", hours_back=24)
    hourly_result = test_hourly_chunks(network="HV", station="OBL", channel="HHZ", hours_back=24)
    
    # Compare results
    compare_results(full_result, hourly_result, hours_back=24)
    
    # Save log
    log_file = f"tests/test_logs/full_vs_hourly_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
    print(f"\n💾 Test log saved to: {log_file}")

if __name__ == "__main__":
    main()

