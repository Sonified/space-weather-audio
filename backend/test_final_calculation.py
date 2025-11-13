from datetime import datetime, timezone, timedelta

now = datetime.now(timezone.utc)
last_24h_start = now - timedelta(hours=24)

print(f'Current time: {now.strftime("%Y-%m-%d %H:%M:%S UTC")}')
print(f'24h window: {last_24h_start.strftime("%Y-%m-%d %H:%M:%S")} → {now.strftime("%Y-%m-%d %H:%M:%S")}')
print('='*70)

def get_last_complete_period(now, period_type):
    """Calculate the start time of the last period that SHOULD be complete"""
    if period_type == '10m':
        # If we're at minute :03 or later in a 10m period, the previous period is complete
        minute_in_period = now.minute % 10
        if minute_in_period >= 3:
            # Previous period is complete
            last_period_start = now - timedelta(minutes=(minute_in_period + 10))
        else:
            # Previous period collection hasn't run yet
            last_period_start = now - timedelta(minutes=(minute_in_period + 20))
        # Round to 10-minute boundary
        last_period_start = last_period_start.replace(minute=(last_period_start.minute // 10) * 10, second=0, microsecond=0)
        return last_period_start
    
    elif period_type == '1h':
        # If we're at :03 or later in the hour, previous hour is complete
        if now.minute >= 3:
            return (now - timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
        else:
            return (now - timedelta(hours=2)).replace(minute=0, second=0, microsecond=0)
    
    elif period_type == '6h':
        # 6h windows: 00:00, 06:00, 12:00, 18:00
        current_window_hour = (now.hour // 6) * 6
        minutes_into_window = (now.hour % 6) * 60 + now.minute
        
        if minutes_into_window >= 3:
            # Previous window is complete
            return (now.replace(hour=current_window_hour, minute=0, second=0, microsecond=0) - timedelta(hours=6))
        else:
            # Go back 2 windows
            return (now.replace(hour=current_window_hour, minute=0, second=0, microsecond=0) - timedelta(hours=12))

def get_first_period(window_start, period_type):
    """Find the first period that touches the 24h window"""
    if period_type == '10m':
        # Round down to 10-minute boundary
        return window_start.replace(minute=(window_start.minute // 10) * 10, second=0, microsecond=0)
    elif period_type == '1h':
        # Round down to hour boundary
        return window_start.replace(minute=0, second=0, microsecond=0)
    elif period_type == '6h':
        # Round down to 6h boundary
        window_hour = (window_start.hour // 6) * 6
        return window_start.replace(hour=window_hour, minute=0, second=0, microsecond=0)

# Calculate expected for each period type
EXPECTED_24H = {}
for period_type in ['10m', '1h', '6h']:
    first = get_first_period(last_24h_start, period_type)
    last = get_last_complete_period(now, period_type)
    
    # Period lengths
    period_seconds = {'10m': 600, '1h': 3600, '6h': 21600}[period_type]
    
    # Count periods from first to last (inclusive)
    if last >= first:
        time_span = (last - first).total_seconds()
        EXPECTED_24H[period_type] = int(time_span / period_seconds) + 1
    else:
        EXPECTED_24H[period_type] = 0
    
    print(f'\n{period_type.upper()} FILES:')
    print(f'  First period: {first.strftime("%Y-%m-%d %H:%M:%S")}')
    print(f'  Last complete: {last.strftime("%Y-%m-%d %H:%M:%S")}')
    print(f'  Time span: {time_span:.0f} seconds = {time_span/period_seconds:.1f} periods')
    print(f'  Expected count: {EXPECTED_24H[period_type]}')

print('\n' + '='*70)
print(f'FINAL EXPECTED COUNTS:')
print(f'  10m: {EXPECTED_24H["10m"]} (should be ~143-144)')
print(f'  1h:  {EXPECTED_24H["1h"]} (should be ~23-24)')
print(f'  6h:  {EXPECTED_24H["6h"]} (should be 4)')
print('='*70)

# Verify they're in reasonable range
assert 143 <= EXPECTED_24H["10m"] <= 144, f"10m count {EXPECTED_24H['10m']} is out of range!"
assert 23 <= EXPECTED_24H["1h"] <= 24, f"1h count {EXPECTED_24H['1h']} is out of range!"
assert EXPECTED_24H["6h"] == 4, f"6h count {EXPECTED_24H['6h']} should be 4!"

print('\n✅ All counts are correct!')
