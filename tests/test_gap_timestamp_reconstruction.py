#!/usr/bin/env python3
"""
Test timestamp reconstruction for gaps - verify alignment and measure any offsets
"""
from obspy import read
import numpy as np

# Files with known gaps
test_files = [
    'mseed_files/Spurr_Last_1d_2025-03-27_T_190401.mseed',
    'mseed_files/Spurr_Last_1d_2025-03-27_T_184956.mseed',
    'mseed_files/Kilauea_Sept27_24h.mseed',
    'mseed_files/Spurr_Last_7d_2025-03-28_T_000918.mseed',
]

print('='*70)
print('GAP TIMESTAMP RECONSTRUCTION TEST')
print('='*70)

all_gaps = []

for fname in test_files:
    try:
        st = read(fname)
        gaps = st.get_gaps()
        
        if not gaps:
            continue
            
        print(f'\n📁 {fname.split("/")[-1]}')
        print(f'   Total gaps: {len(gaps)}')
        
        # Analyze each gap
        for i, gap in enumerate(gaps):
            # Unpack gap info
            network, station, location, channel, gap_start, gap_end, duration, n_samples = gap
            
            # Skip negative gaps (overlaps)
            if duration < 0:
                continue
            
            # Find the traces involved
            trace_before = None
            trace_after = None
            
            for tr in st:
                if tr.stats.endtime == gap_start:
                    trace_before = tr
                if tr.stats.starttime == gap_end:
                    trace_after = tr
            
            if not trace_before or not trace_after:
                continue
            
            sample_rate = trace_before.stats.sampling_rate
            dt = 1.0 / sample_rate
            
            # METHOD 1: Calculate from duration (WRONG - causes offset)
            expected_samples_from_duration = int(duration * sample_rate)
            expected_restart_from_duration = gap_start + (expected_samples_from_duration * dt)
            offset_method1 = gap_end - expected_restart_from_duration
            
            # METHOD 2: Calculate from actual timestamps (CORRECT)
            actual_gap_time = gap_end - gap_start
            actual_missing_samples = round(actual_gap_time * sample_rate)
            expected_restart_from_timestamps = gap_start + (actual_missing_samples * dt)
            offset_method2 = gap_end - expected_restart_from_timestamps
            
            gap_info = {
                'file': fname.split('/')[-1],
                'gap_start': str(gap_start),
                'gap_end': str(gap_end),
                'duration': duration,
                'sample_rate': sample_rate,
                'method1_samples': expected_samples_from_duration,
                'method1_offset': offset_method1,
                'method2_samples': actual_missing_samples,
                'method2_offset': offset_method2
            }
            
            all_gaps.append(gap_info)
            
            print(f'\n   Gap {i+1}:')
            print(f'      Duration: {duration:.3f}s @ {sample_rate} Hz')
            print(f'      METHOD 1 (from duration): {expected_samples_from_duration} samples → offset {offset_method1:.6f}s ({offset_method1 * sample_rate:.2f} samples)')
            print(f'      METHOD 2 (from timestamps): {actual_missing_samples} samples → offset {offset_method2:.9f}s ({offset_method2 * sample_rate:.6f} samples)')
            
            if len(all_gaps) >= 5:
                break
        
        if len(all_gaps) >= 5:
            break
            
    except Exception as e:
        print(f'   ❌ Error: {e}')
        continue

# Summary
print('\n' + '='*70)
print('SUMMARY OF GAPS ANALYZED')
print('='*70)

if not all_gaps:
    print('No valid gaps found!')
else:
    print(f'\nAnalyzed {len(all_gaps)} gaps:\n')
    
    method1_offsets = [g['method1_offset'] for g in all_gaps]
    method2_offsets = [g['method2_offset'] for g in all_gaps]
    
    print('METHOD 1 (from duration) - Offsets:')
    for i, gap in enumerate(all_gaps):
        print(f'  Gap {i+1}: {gap["method1_offset"]:+.9f}s ({gap["method1_offset"] * gap["sample_rate"]:+.3f} samples)')
    
    print(f'\n  Mean: {np.mean(method1_offsets):.9f}s')
    print(f'  Max:  {np.max(np.abs(method1_offsets)):.9f}s ({np.max(np.abs(method1_offsets)) * all_gaps[0]["sample_rate"]:.2f} samples)')
    
    print('\n' + '-'*70)
    print('\nMETHOD 2 (from timestamps) - Offsets:')
    for i, gap in enumerate(all_gaps):
        print(f'  Gap {i+1}: {gap["method2_offset"]:+.12f}s ({gap["method2_offset"] * gap["sample_rate"]:+.9f} samples)')
    
    print(f'\n  Mean: {np.mean(method2_offsets):.12f}s')
    print(f'  Max:  {np.max(np.abs(method2_offsets)):.12f}s ({np.max(np.abs(method2_offsets)) * 100:.9f} samples @ 100Hz)')
    
    # Check if method 2 fixes the problem
    max_method2_offset_samples = np.max(np.abs([g["method2_offset"] * g["sample_rate"] for g in all_gaps]))
    
    if max_method2_offset_samples < 0.001:
        print(f'\n✅ RESULT: METHOD 2 fixes the problem! Max offset < 0.001 samples')
        print(f'   Use: actual_missing_samples = round((gap_end - gap_start) * sample_rate)')
    else:
        print(f'\n⚠️  RESULT: METHOD 2 still has offset: {max_method2_offset_samples:.6f} samples')
        print(f'   May need further refinement.')

