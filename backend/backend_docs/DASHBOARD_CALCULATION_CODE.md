# Dashboard Station Status 24h Calculation Code

## Problem
The expected file counts are inconsistent and not correctly calculating what files should exist for a floating 24-hour window.

## Current Time Example
- Current time: 23:40 UTC on 2025-11-12
- 24h window: 2025-11-11 23:40 → 2025-11-12 23:40

## What We SHOULD Expect
For a complete 24-hour period:
- **10m files**: 144 (6 per hour × 24 hours)
- **1h files**: 24 (1 per hour × 24 hours)
- **6h files**: 4 (4 windows per 24 hours)

BUT we need to account for incomplete periods at the current moment!

---

## EXPECTED COUNT CALCULATION (Lines 2690-2778)

```python
now = datetime.now(timezone.utc)
last_24h_start = now - timedelta(hours=24)

# Get today and yesterday to check metadata files
today = now.date()
yesterday = today - timedelta(days=1)
dates_to_check = [yesterday, today]

# ========== 10m FILES EXPECTED ==========
# Find the 10-min period that contains (now - 24h) - this is the FIRST expected file
start_period_minute = (last_24h_start.hour * 60 + last_24h_start.minute) // 10

# Find the LAST COMPLETE period (not the current one)
# Collection at XX:X2 creates the file for the PREVIOUS 10-min period
current_period_minute = (now.hour * 60 + now.minute) // 10
minute_in_period = now.minute % 10

if minute_in_period >= 3:
    # Collection has run (at :X2) for the previous period
    # The last complete period is the one before current
    last_complete_period = current_period_minute - 1
else:
    # Collection hasn't run yet for the previous period
    # The last complete period is 2 periods ago
    last_complete_period = current_period_minute - 2

# Count periods from start to last complete (inclusive)
# Add 144 to handle day wraparound
complete_10m_periods = (last_complete_period - start_period_minute) + 144 + 1

# ========== 1h FILES EXPECTED ==========
# Find the first hour boundary that contains or precedes the 24h start
first_hour_start = last_24h_start.replace(minute=0, second=0, microsecond=0)

# Find the last complete hour (accounting for collection time)
if now.minute >= 3:
    # Collection has run for the previous hour
    last_complete_time = now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=1)
else:
    # Collection hasn't run yet for previous hour
    last_complete_time = now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=2)

# Count hours from first hour to last complete hour
hours_span = (last_complete_time - first_hour_start).total_seconds() / 3600
complete_hours = int(hours_span) + 1  # +1 to include both endpoints

# ========== 6h FILES EXPECTED ==========
# Find the FIRST 6h window that touches our 24h start
first_window_start_hour = (last_24h_start.hour // 6) * 6
first_window_start = last_24h_start.replace(hour=first_window_start_hour, minute=0, second=0, microsecond=0)

# Find the LAST COMPLETE 6h window
current_window_start_hour = (now.hour // 6) * 6
current_window_start = now.replace(hour=current_window_start_hour, minute=0, second=0, microsecond=0)

# The current window is incomplete, so last complete is the previous one
current_6h_minute = (now.hour % 6) * 60 + now.minute
if current_6h_minute >= 3:
    # Collection has run - previous window is complete
    last_complete_window_start = current_window_start - timedelta(hours=6)
else:
    # Collection hasn't run yet - go back 2 windows
    last_complete_window_start = current_window_start - timedelta(hours=12)

# Count windows from first to last complete
hours_between = (last_complete_window_start - first_window_start).total_seconds() / 3600
complete_6h_periods = int(hours_between / 6) + 1  # +1 to include both endpoints

EXPECTED_24H = {
    '10m': complete_10m_periods,
    '1h': complete_hours,
    '6h': complete_6h_periods
}
```

---

## ACTUAL COUNT CALCULATION (Lines 2791-2816)

```python
# Count metadata chunks in last 24h
actual = {'10m': 0, '1h': 0, '6h': 0}

for date in dates_to_check:  # [yesterday, today]
    metadata = load_metadata_for_date(s3, network, volcano, station, location, channel, sample_rate, date)
    
    if not metadata:
        continue
    
    for chunk_type in ['10m', '1h', '6h']:
        for chunk in metadata.get('chunks', {}).get(chunk_type, []):
            chunk_start_str = chunk.get('start', '')  # e.g., "23:30:00"
            chunk_end_str = chunk.get('end', '')      # e.g., "23:39:59"
            if not chunk_start_str or not chunk_end_str:
                continue
            
            try:
                chunk_start = datetime.fromisoformat(f"{date}T{chunk_start_str}").replace(tzinfo=timezone.utc)
                chunk_end = datetime.fromisoformat(f"{date}T{chunk_end_str}").replace(tzinfo=timezone.utc)
                
                # Count chunks that OVERLAP with the 24h window
                # Chunk overlaps if: chunk_end > window_start AND chunk_start < window_end
                if chunk_end > last_24h_start and chunk_start < now:
                    actual[chunk_type] += 1
            except (ValueError, TypeError):
                continue
```

---

## METADATA EXAMPLE

For HV.OBL.--.HHZ on 2025-11-11:
- 10m chunks: 144 files (00:00:00 to 23:50:00)
- 1h chunks: 24 files (00:00:00 to 23:00:00)
- 6h chunks: 4 files (00:00:00 to 18:00:00)

For HV.OBL.--.HHZ on 2025-11-12:
- 10m chunks: 141 files (00:00:00 to 23:20:00)
- 1h chunks: 23 files (00:00:00 to 22:00:00)
- 6h chunks: 3 files (00:00:00 to 12:00:00)

---

## ISSUES TO FIX

1. **Expected calculation is overly complex** with day wraparound math
2. **Expected should be simpler**: Just count how many complete periods fit in 24h
3. **Actual counting** should match the expected logic

## SIMPLE APPROACH (What it SHOULD be)

At 23:40:
- 24h window: yesterday 23:40 → today 23:40
- Expected 10m: Count periods from yesterday 23:40 to last complete period before now
- A full 24h has 144 periods, minus any incomplete current period
- Expected = 143 or 144 depending on whether collection has run for the previous period

