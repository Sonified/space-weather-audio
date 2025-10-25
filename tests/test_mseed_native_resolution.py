#!/usr/bin/env python3
"""
Check the native data resolution/dtype of MiniSEED files
"""
from obspy import read
import numpy as np
import glob

# Get all mseed files
test_files = glob.glob('mseed_files/*.mseed')

print('='*70)
print('MiniSEED NATIVE DATA RESOLUTION - SCANNING ALL FILES')
print('='*70)
print(f'\nFound {len(test_files)} MiniSEED files to analyze\n')

all_traces = []
files_exceeding_int16 = []

for fname in test_files:
    try:
        st = read(fname)
        fname_short = fname.split("/")[-1]
        
        # Scan ALL traces in this file
        file_min = float('inf')
        file_max = float('-inf')
        file_dtype = None
        
        for tr in st:
            all_traces.append(tr)
            data = tr.data
            file_dtype = data.dtype
            file_min = min(file_min, np.min(data))
            file_max = max(file_max, np.max(data))
        
        # Check if exceeds int16
        exceeds = file_min < -32768 or file_max > 32767
        status = '⚠️  EXCEEDS' if exceeds else '✅'
        
        if exceeds:
            files_exceeding_int16.append(fname_short)
        
        print(f'{status} {fname_short}')
        print(f'     {len(st)} traces, dtype={file_dtype}, range=[{file_min:,} to {file_max:,}]')
        
    except Exception as e:
        print(f'❌ {fname.split("/")[-1]}: Error - {e}')

print('\n' + '='*70)
print('SUMMARY')
print('='*70)

print(f'\nTotal files analyzed: {len(test_files)}')
print(f'Total traces scanned: {len(all_traces)}')

# Get unique dtypes
dtypes = [tr.data.dtype for tr in all_traces]
unique_dtypes = set(dtypes)
print(f'Native data types: {unique_dtypes}')

# Calculate global min/max across ALL traces
global_min = min(np.min(tr.data) for tr in all_traces)
global_max = max(np.max(tr.data) for tr in all_traces)

print(f'\nGlobal range across all traces:')
print(f'  Min: {global_min:,}')
print(f'  Max: {global_max:,}')
print(f'  Range: {global_max - global_min:,}')

print(f'\nint16 range: -32,768 to 32,767')

if files_exceeding_int16:
    print(f'\n❌ {len(files_exceeding_int16)} file(s) exceed int16 range:')
    for f in files_exceeding_int16:
        print(f'   - {f}')
    print('\n❌ RESULT: int32 needed for storage')
else:
    print(f'\n✅ RESULT: All data fits in int16 range - int16 storage is sufficient')
    print(f'   Native format is int32, but values stay within int16 bounds')

