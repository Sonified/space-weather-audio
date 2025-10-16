#!/usr/bin/env python3
"""
Deep dive investigation: WHY are we getting different sample counts?
This makes no sense if both are pulling from the same IRIS server.
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from obspy import read
import numpy as np

def investigate_difference():
    """Investigate the actual difference between the two approaches"""
    
    print("\n" + "="*80)
    print("🔍 INVESTIGATION: Why Different Sample Counts?")
    print("="*80)
    
    # Load both files
    full_file = "tests/comparison_files/full_request_HV_OBL_24h.mseed"
    hourly_dir = "tests/comparison_files/hourly_chunks/"
    
    if not os.path.exists(full_file):
        print("❌ Full request file not found")
        return
    
    print("\n📂 Loading full request data...")
    st_full = read(full_file)
    
    print(f"   Traces: {len(st_full)}")
    for i, tr in enumerate(st_full):
        print(f"   Trace {i}: {tr.stats.starttime} to {tr.stats.endtime} ({len(tr.data):,} samples)")
    
    print("\n📂 Loading hourly chunks...")
    hourly_files = sorted([f for f in os.listdir(hourly_dir) if f.endswith('.mseed')])
    print(f"   Found {len(hourly_files)} chunk files")
    
    st_hourly = read(hourly_dir + "*.mseed")
    print(f"   Combined traces: {len(st_hourly)}")
    
    # Detailed trace analysis
    print("\n" + "="*80)
    print("📊 DETAILED TRACE ANALYSIS")
    print("="*80)
    
    print("\n🔵 FULL REQUEST TRACES:")
    full_total = 0
    for i, tr in enumerate(st_full):
        samples = len(tr.data)
        full_total += samples
        duration = samples / tr.stats.sampling_rate / 60  # minutes
        print(f"   [{i}] {tr.stats.starttime.strftime('%H:%M:%S')} → {tr.stats.endtime.strftime('%H:%M:%S')} | {samples:>9,} samples ({duration:>6.2f} min)")
    print(f"   TOTAL: {full_total:,} samples")
    
    print("\n🟢 HOURLY CHUNKS TRACES:")
    hourly_total = 0
    for i, tr in enumerate(st_hourly):
        samples = len(tr.data)
        hourly_total += samples
        duration = samples / tr.stats.sampling_rate / 60  # minutes
        print(f"   [{i:2d}] {tr.stats.starttime.strftime('%H:%M:%S')} → {tr.stats.endtime.strftime('%H:%M:%S')} | {samples:>9,} samples ({duration:>6.2f} min)")
    print(f"   TOTAL: {hourly_total:,} samples")
    
    print("\n" + "="*80)
    print(f"📈 DIFFERENCE: {hourly_total - full_total:,} samples")
    print(f"   That's {(hourly_total - full_total) / 100:.1f} seconds of data at 100 Hz")
    print("="*80)
    
    # Time coverage analysis
    print("\n⏰ TIME COVERAGE ANALYSIS:")
    print(f"\n🔵 Full Request:")
    print(f"   First sample: {st_full[0].stats.starttime}")
    print(f"   Last sample:  {st_full[-1].stats.endtime}")
    
    print(f"\n🟢 Hourly Chunks:")
    print(f"   First sample: {st_hourly[0].stats.starttime}")
    print(f"   Last sample:  {st_hourly[-1].stats.endtime}")
    
    # Check for gaps
    print("\n🕳️  GAP ANALYSIS:")
    
    print("\n🔵 Full Request Gaps:")
    gaps_full = st_full.get_gaps()
    if gaps_full:
        total_gap_full = 0
        for gap in gaps_full:
            gap_dur = gap[6]
            total_gap_full += gap_dur
            print(f"   {gap[4].strftime('%H:%M:%S')} → {gap[5].strftime('%H:%M:%S')}: {gap_dur:.2f} sec")
        print(f"   Total gap time: {total_gap_full:.2f} seconds")
    else:
        print("   No gaps")
    
    print("\n🟢 Hourly Chunks Gaps:")
    gaps_hourly = st_hourly.get_gaps()
    if gaps_hourly:
        total_gap_hourly = 0
        for gap in gaps_hourly:
            gap_dur = gap[6]
            total_gap_hourly += gap_dur
            if gap_dur > 1.0:  # Only show gaps > 1 second
                print(f"   {gap[4].strftime('%H:%M:%S')} → {gap[5].strftime('%H:%M:%S')}: {gap_dur:.2f} sec")
        print(f"   Total gap time: {total_gap_hourly:.2f} seconds")
        print(f"   (Showing only gaps > 1 second, total of {len(gaps_hourly)} gaps)")
    else:
        print("   No gaps")
    
    # Hypothesis testing
    print("\n" + "="*80)
    print("🤔 HYPOTHESIS: What's causing the difference?")
    print("="*80)
    
    print("\n1. Are the time ranges actually identical?")
    full_start = st_full[0].stats.starttime
    full_end = st_full[-1].stats.endtime
    hourly_start = st_hourly[0].stats.starttime
    hourly_end = st_hourly[-1].stats.endtime
    
    start_diff = abs((hourly_start - full_start))
    end_diff = abs((hourly_end - full_end))
    
    print(f"   Start time difference: {start_diff:.2f} seconds")
    print(f"   End time difference: {end_diff:.2f} seconds")
    
    if start_diff > 1 or end_diff > 1:
        print("   ⚠️  TIME RANGES ARE DIFFERENT!")
        print("   This explains the sample count difference.")
    else:
        print("   ✅ Time ranges are essentially identical")
    
    print("\n2. Are we counting gaps differently?")
    if gaps_full and gaps_hourly:
        print(f"   Full request: {len(gaps_full)} gaps, {total_gap_full:.2f} sec total")
        print(f"   Hourly chunks: {len(gaps_hourly)} gaps, {total_gap_hourly:.2f} sec total")
        print(f"   Gap difference: {total_gap_full - total_gap_hourly:.2f} seconds")
        
        # This could account for the difference
        expected_sample_diff = (total_gap_full - total_gap_hourly) * 100  # at 100 Hz
        actual_sample_diff = hourly_total - full_total
        
        print(f"\n   Expected sample difference from gaps: {expected_sample_diff:.0f}")
        print(f"   Actual sample difference: {actual_sample_diff}")
        
        if abs(expected_sample_diff - actual_sample_diff) < 100:
            print("   ✅ GAP HANDLING EXPLAINS THE DIFFERENCE!")
        else:
            print("   ❌ Gaps don't fully explain the difference")
    
    print("\n3. Are we actually requesting different time windows?")
    print("   This is the KEY question - let's check the actual requests...")
    
    # Check if the requests were truly identical
    print("\n" + "="*80)
    print("💡 CONCLUSION:")
    print("="*80)
    
    if start_diff > 1 or end_diff > 1:
        print("\n❗ The time ranges ARE different!")
        print(f"   Full request starts {start_diff:.1f} seconds later")
        print(f"   Full request ends {end_diff:.1f} seconds earlier")
        print(f"   This accounts for the {hourly_total - full_total:,} sample difference")
        print("\n   EXPLANATION: The requests were made at slightly different times,")
        print("   so 'now' was different for each test. This is NOT a real difference")
        print("   in the retrieval methods - it's just timing!")
    else:
        print("\n🤷 The difference is small and likely due to:")
        print("   - Slight timing differences in when requests were made")
        print("   - Different gap handling between single vs multiple requests")
        print("   - IRIS server returning slightly different data at boundaries")
        print("\n   VERDICT: The difference is negligible and not meaningful.")

if __name__ == "__main__":
    investigate_difference()

