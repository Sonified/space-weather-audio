#!/usr/bin/env python3
"""
Simulate cron job runs at different times to validate logic.

Tests:
1. 42 minutes past → should fetch XX:30-XX:40 (10-min chunk only)
2. 52 minutes past → should fetch XX:40-XX:50 (10-min chunk only)
3. 02 minutes past → should fetch XX:50-00:00 (10-min) + previous 6-hour chunk

The cron logic automatically determines what to fetch based on simulated current time.
"""

import sys
from datetime import datetime, timedelta, timezone

def determine_fetch_windows(current_time, iris_delay_minutes=2):
    """
    Determine what time windows to fetch based on current time.
    
    Cron runs at: :02, :12, :22, :32, :42, :52 each hour
    IRIS delay: 2 minutes buffer
    
    Logic:
    - Always fetch previous 10-minute chunk
    - At 6-hour checkpoints (00:02, 06:02, 12:02, 18:02): ALSO fetch previous 6-hour chunk
    
    Returns:
        List of (start_time, end_time, chunk_type) tuples
    """
    windows = []
    
    # Account for IRIS delay
    effective_time = current_time - timedelta(minutes=iris_delay_minutes)
    
    # ===== 10-MINUTE CHUNK (always fetched) =====
    # Round DOWN to nearest 10-minute mark
    minute = effective_time.minute
    quantized_minute = (minute // 10) * 10
    
    # Previous completed 10-minute window
    ten_min_end = effective_time.replace(minute=quantized_minute, second=0, microsecond=0)
    ten_min_start = ten_min_end - timedelta(minutes=10)
    
    windows.append((ten_min_start, ten_min_end, '10m'))
    
    # ===== 6-HOUR CHUNK (only at checkpoints) =====
    # Check if this is a 6-hour checkpoint
    # Cron runs at :02, so after IRIS delay we're at :00
    # Checkpoints: 00:00, 06:00, 12:00, 18:00 (after delay)
    
    if effective_time.hour % 6 == 0 and quantized_minute == 0:
        # This is a 6-hour checkpoint!
        # Fetch the completed 6-hour window
        six_hour_end = effective_time.replace(minute=0, second=0, microsecond=0)
        six_hour_start = six_hour_end - timedelta(hours=6)
        
        windows.append((six_hour_start, six_hour_end, '6h'))
    
    return windows


def format_window(start, end, chunk_type):
    """Format window for display"""
    duration = end - start
    duration_str = f"{duration.total_seconds() / 3600:.1f}h" if duration >= timedelta(hours=1) else f"{duration.total_seconds() / 60:.0f}m"
    return f"{chunk_type:4s} | {start.strftime('%Y-%m-%d %H:%M:%S')} to {end.strftime('%H:%M:%S')} ({duration_str})"


print("=" * 100)
print("CRON JOB SIMULATION - Testing Time-Based Fetch Logic")
print("=" * 100)
print("Simulating cron runs at different times to validate automatic window determination")
print("=" * 100)
print()

# Test scenarios
test_times = [
    datetime(2025, 11, 4, 22, 42, 0, tzinfo=timezone.utc),  # 22:42 → fetch XX:30-XX:40 only
    datetime(2025, 11, 4, 22, 52, 0, tzinfo=timezone.utc),  # 22:52 → fetch XX:40-XX:50 only
    datetime(2025, 11, 5, 0, 2, 0, tzinfo=timezone.utc),    # 00:02 → fetch XX:50-00:00 + 6h chunk (18:00-00:00)
]

for i, simulated_time in enumerate(test_times, 1):
    print(f"TEST {i}: Cron runs at {simulated_time.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print("-" * 100)
    
    windows = determine_fetch_windows(simulated_time)
    
    print(f"Fetch windows determined ({len(windows)} total):")
    for start, end, chunk_type in windows:
        print(f"  {format_window(start, end, chunk_type)}")
    
    print()

# Expected results summary
print("=" * 100)
print("EXPECTED RESULTS")
print("=" * 100)
print("Test 1 (22:42): Should fetch 1 window  → 10m chunk (22:30-22:40)")
print("Test 2 (22:52): Should fetch 1 window  → 10m chunk (22:40-22:50)")
print("Test 3 (00:02): Should fetch 2 windows → 10m chunk (23:50-00:00) + 6h chunk (18:00-00:00)")
print("=" * 100)

