#!/usr/bin/env python3
"""Test the audit logic for incomplete chunks"""
from datetime import datetime, timezone

# Simulate the metadata for the incomplete chunk
metadata_map = {
    '2025-11-13': {
        '1h': {
            '02:00:00': {
                'end': '02:20:18',
                'samples': 121800
            }
        }
    }
}

# Simulate checking the 02:00-03:00 hour
hour_start = datetime(2025, 11, 13, 2, 0, 0, tzinfo=timezone.utc)
hour_end = datetime(2025, 11, 13, 3, 0, 0, tzinfo=timezone.utc)
sample_rate = 100.0

date_str = hour_start.strftime("%Y-%m-%d")
hour_start_str = hour_start.strftime("%H:%M:%S")
hour_end_str = hour_end.strftime("%H:%M:%S")

print(f"Checking hour: {hour_start_str} → {hour_end_str}")
print(f"Expected end: {hour_end_str}")
print(f"Date: {date_str}")

chunk_is_complete = False
if date_str in metadata_map and hour_start_str in metadata_map[date_str]['1h']:
    chunk_info = metadata_map[date_str]['1h'][hour_start_str]
    chunk_end_str = chunk_info['end']
    expected_samples = int((hour_end - hour_start).total_seconds() * sample_rate)
    actual_samples = chunk_info['samples']
    
    print(f"\nFound chunk in metadata:")
    print(f"  Start: {hour_start_str}")
    print(f"  End (metadata): {chunk_end_str}")
    print(f"  End (expected): {hour_end_str}")
    print(f"  Samples (metadata): {actual_samples}")
    print(f"  Samples (expected): {expected_samples}")
    print(f"  End times match: {chunk_end_str == hour_end_str}")
    
    if chunk_end_str == hour_end_str:
        sample_diff = abs(actual_samples - expected_samples)
        sample_tolerance = sample_diff / expected_samples
        print(f"  Sample difference: {sample_diff} ({sample_tolerance:.2%})")
        if sample_tolerance < 0.01:
            chunk_is_complete = True
            print(f"  ✅ COMPLETE")
        else:
            print(f"  ❌ INCOMPLETE (sample count off by {sample_tolerance:.2%})")
    else:
        print(f"  ❌ INCOMPLETE (end time mismatch)")

else:
    print("\n❌ Chunk NOT found in metadata")

print(f"\nFinal result: chunk_is_complete = {chunk_is_complete}")

