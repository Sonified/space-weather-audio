#!/usr/bin/env python3
"""
Check if duplicate records contain identical data or different data
"""
from obspy import read

fname = 'mseed_files/Kilauea_Sept27_24h.mseed'
print(f'📁 Checking if duplicates are identical: {fname.split("/")[-1]}\n')

st = read(fname)

# Compare overlapping traces
# Trace 2: 09:29:55 → 21:35:49
# Trace 3: 10:29:52 → 21:35:49
# They overlap from 10:29:52 → 21:35:49

trace2 = st[1]
trace3 = st[2]

print(f'Trace 2: {trace2.stats.starttime} → {trace2.stats.endtime} ({trace2.stats.npts} samples)')
print(f'Trace 3: {trace3.stats.starttime} → {trace3.stats.endtime} ({trace3.stats.npts} samples)')

# Find the overlap region
overlap_start = trace3.stats.starttime  # 10:29:52
overlap_end = min(trace2.stats.endtime, trace3.stats.endtime)  # 21:35:49

print(f'\nOverlap region: {overlap_start} → {overlap_end}')
print(f'Duration: {(overlap_end - overlap_start) / 3600:.2f} hours\n')

# Trim both traces to overlap region
trace2_overlap = trace2.copy().trim(starttime=overlap_start, endtime=overlap_end)
trace3_overlap = trace3.copy().trim(starttime=overlap_start, endtime=overlap_end)

print(f'Trace 2 overlap: {trace2_overlap.stats.npts} samples')
print(f'Trace 3 overlap: {trace3_overlap.stats.npts} samples')

# Compare the data
if trace2_overlap.stats.npts != trace3_overlap.stats.npts:
    print('\n⚠️  Different number of samples - cannot directly compare!')
else:
    import numpy as np
    data2 = trace2_overlap.data
    data3 = trace3_overlap.data
    
    # Check if identical
    if np.array_equal(data2, data3):
        print('\n✅ Data is IDENTICAL - perfect duplicate!')
    else:
        # Calculate differences
        diff = data2 - data3
        max_diff = np.max(np.abs(diff))
        mean_diff = np.mean(np.abs(diff))
        pct_different = np.sum(diff != 0) / len(diff) * 100
        
        print(f'\n❌ Data is DIFFERENT:')
        print(f'   Max difference: {max_diff}')
        print(f'   Mean difference: {mean_diff:.4f}')
        print(f'   % samples different: {pct_different:.2f}%')
        print(f'\n   Sample comparison (first 10):')
        for i in range(min(10, len(data2))):
            print(f'     Sample {i}: Trace2={data2[i]:10.2f}  Trace3={data3[i]:10.2f}  diff={diff[i]:10.2f}')

# Also check the duplicate 21:36:09 traces (Trace 6 and 7)
print('\n\n' + '='*60)
print('Checking Trace 6 vs Trace 7 (both 21:36:09 → 23:59:59):\n')

trace6 = st[5]
trace7 = st[6]

print(f'Trace 6: {trace6.stats.npts} samples')
print(f'Trace 7: {trace7.stats.npts} samples')

if trace6.stats.npts == trace7.stats.npts:
    if np.array_equal(trace6.data, trace7.data):
        print('\n✅ Trace 6 and 7 are IDENTICAL - perfect duplicate!')
    else:
        diff = trace6.data - trace7.data
        max_diff = np.max(np.abs(diff))
        mean_diff = np.mean(np.abs(diff))
        pct_different = np.sum(diff != 0) / len(diff) * 100
        
        print(f'\n❌ Trace 6 and 7 are DIFFERENT:')
        print(f'   Max difference: {max_diff}')
        print(f'   Mean difference: {mean_diff:.4f}')
        print(f'   % samples different: {pct_different:.2f}%')

