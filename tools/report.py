#!/usr/bin/env python3
"""
Gap Cataloger Progress Report — Real-time monitoring dashboard.

Usage:
    python3 tools/report.py
"""

import json
import random
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from collections import defaultdict

LOG_PATH = Path(__file__).parent / 'gap_catalog_progress.log'
CATALOG_PATH = Path(__file__).parent / 'gap_catalog' / 'MMS1_FGM_BRST_L2.json'
TOTAL_GAPS = 92690

def parse_log():
    """Parse the progress log and extract all events with timestamps."""
    if not LOG_PATH.exists():
        print("No progress log found. Is the cataloger running?")
        sys.exit(1)

    text = LOG_PATH.read_text()
    lines = text.splitlines()

    # Find run start time
    run_start = None
    for line in lines:
        if line.startswith('Gap Cataloger started at'):
            run_start = datetime.fromisoformat(line.split('at ')[1])
            break

    if not run_start:
        print("Could not find run start time in log.")
        sys.exit(1)

    # Parse events by timestamp
    ts_pattern = re.compile(r'^\[(\d{2}:\d{2}:\d{2})\]')
    gap_pattern = re.compile(r'Gap (\d+)/(\d+)')
    rate_429_pattern = re.compile(r'429 #(\d+)!')
    rate_status_pattern = re.compile(r'Status: ([\d.]+)s interval .* 429s=(\d+), requests=(\d+)')
    sharpen_pattern = re.compile(r'(Start|End) sharpened:')
    error_pattern = re.compile(r'Sharpen error')
    inventory_fallback = re.compile(r'using inventory precision')

    # Track per-hour stats
    hours = defaultdict(lambda: {
        'gaps': 0,           # gap lines logged (each = 2 sharpenings attempted)
        'sharpenings': 0,    # successful sharpenings
        'rate_429s': 0,
        'errors': 0,
        'fallbacks': 0,
        'last_rate_interval': None,
        'last_total_429s': None,
        'last_total_requests': None,
        'gap_numbers': [],
    })

    all_gap_numbers = []
    total_sharpenings = 0
    total_errors = 0
    total_fallbacks = 0
    total_429s_final = 0
    total_requests_final = 0
    last_rate_interval = None
    last_ts = None
    prev_hour_429s = 0

    # We need to track 429 counts per hour from the incremental 429 # lines
    hour_429_counts = defaultdict(int)

    for line in lines:
        m = ts_pattern.match(line)
        if not m:
            continue

        time_str = m.group(1)
        # Reconstruct full datetime from run_start date
        h, mi, s = map(int, time_str.split(':'))
        ts = run_start.replace(hour=h, minute=mi, second=s, microsecond=0)
        # Handle day rollover
        if ts < run_start and (run_start - ts).total_seconds() > 43200:
            ts += timedelta(days=1)
        if last_ts and ts < last_ts and (last_ts - ts).total_seconds() > 43200:
            ts += timedelta(days=1)
        last_ts = ts

        hour_key = ts.strftime('%Y-%m-%d %H:00')

        # Gap line
        gm = gap_pattern.search(line)
        if gm:
            hours[hour_key]['gaps'] += 1
            gap_num = int(gm.group(1))
            hours[hour_key]['gap_numbers'].append(gap_num)
            all_gap_numbers.append(gap_num)

        # Successful sharpening
        if sharpen_pattern.search(line):
            hours[hour_key]['sharpenings'] += 1
            total_sharpenings += 1

        # 429
        rm = rate_429_pattern.search(line)
        if rm:
            hour_429_counts[hour_key] += 1

        # Rate status line (cumulative)
        sm = rate_status_pattern.search(line)
        if sm:
            last_rate_interval = float(sm.group(1))
            total_429s_final = int(sm.group(2))
            total_requests_final = int(sm.group(3))
            hours[hour_key]['last_rate_interval'] = last_rate_interval
            hours[hour_key]['last_total_429s'] = total_429s_final
            hours[hour_key]['last_total_requests'] = total_requests_final

        # Errors
        if error_pattern.search(line):
            hours[hour_key]['errors'] += 1
            total_errors += 1

        # Fallbacks
        if inventory_fallback.search(line):
            hours[hour_key]['fallbacks'] += 1
            total_fallbacks += 1

    return {
        'run_start': run_start,
        'last_ts': last_ts,
        'hours': dict(hours),
        'hour_429s': dict(hour_429_counts),
        'all_gap_numbers': all_gap_numbers,
        'total_sharpenings': total_sharpenings,
        'total_errors': total_errors,
        'total_fallbacks': total_fallbacks,
        'total_429s': total_429s_final,
        'total_requests': total_requests_final,
        'last_rate_interval': last_rate_interval,
    }


def check_running():
    """Check if cataloger is currently running."""
    import subprocess
    result = subprocess.run(['pgrep', '-f', 'gap_cataloger'], capture_output=True, text=True)
    pids = result.stdout.strip().split('\n') if result.stdout.strip() else []
    return len(pids) > 0, pids


def main():
    data = parse_log()
    is_running, pids = check_running()
    now = datetime.now()

    run_start = data['run_start']
    last_ts = data['last_ts']
    elapsed = last_ts - run_start if last_ts else timedelta(0)
    elapsed_hours = elapsed.total_seconds() / 3600

    # Compute unique gaps touched (max gap number seen across all workers)
    # Each gap line represents a gap being processed. Count unique gap numbers.
    unique_gaps = len(set(data['all_gap_numbers']))
    total_gaps_logged = len(data['all_gap_numbers'])

    # Header
    print()
    print('=' * 72)
    print('  MMS1 FGM BURST SHARPENING — PROGRESS REPORT')
    print('=' * 72)
    print()

    # Status
    status = '  RUNNING' if is_running else '  STOPPED'
    status_icon = '\033[92m●\033[0m' if is_running else '\033[91m●\033[0m'
    print(f'  Status:          {status_icon} {status}')
    print(f'  Run started:     {run_start.strftime("%Y-%m-%d %H:%M:%S")}')
    print(f'  Last activity:   {last_ts.strftime("%Y-%m-%d %H:%M:%S") if last_ts else "N/A"}')
    print(f'  Elapsed:         {elapsed_hours:.1f} hours ({elapsed})')
    print()

    # Total progress from catalog file
    catalog_sharpened = 0
    catalog_total = 0
    if CATALOG_PATH.exists():
        try:
            with open(CATALOG_PATH) as f:
                catalog = json.load(f)
            intervals = catalog.get('intervals', [])
            catalog_total = len(intervals)
            catalog_sharpened = sum(1 for i in intervals if 'start_precise' in i and 'end_precise' in i)
        except Exception:
            pass

    # Overall progress (from catalog, not log)
    total_for_pct = catalog_total or TOTAL_GAPS
    pct = (catalog_sharpened / total_for_pct) * 100 if total_for_pct else 0
    bar_width = 40
    filled = int(bar_width * pct / 100)
    bar = '█' * filled + '░' * (bar_width - filled)
    print(f'  TOTAL PROGRESS:  [{bar}] {pct:.1f}%')
    print(f'  Sharpened:       {catalog_sharpened:,} / {total_for_pct:,} intervals')
    print(f'  Remaining:       {total_for_pct - catalog_sharpened:,}')
    print()

    # This run
    print(f'  This run:        {unique_gaps:,} gaps touched (log)')
    print(f'  Sharpenings:     {data["total_sharpenings"]:,} successful')
    print(f'  Errors:          {data["total_errors"]:,} (fell back to inventory precision)')
    print()

    # Rate limiting
    print(f'  Current rate:    {data["last_rate_interval"]:.3f}s interval ({1/data["last_rate_interval"]:.2f} req/s)' if data['last_rate_interval'] else '  Current rate:    N/A')
    print(f'  Total 429s:      {data["total_429s"]:,} / {data["total_requests"]:,} requests ({data["total_429s"]/max(data["total_requests"],1)*100:.1f}%)')
    print()

    # Hourly table
    print('  ' + '-' * 68)
    print(f'  {"Hour":<18} {"Gaps":>6} {"Sharp":>6} {"429s":>5} {"Errs":>5} {"Rate(s)":>8} {"Gaps/hr":>8}')
    print('  ' + '-' * 68)

    sorted_hours = sorted(data['hours'].keys())
    recent_gaps_per_hour = []

    for i, hour_key in enumerate(sorted_hours):
        h = data['hours'][hour_key]
        hour_429s = data['hour_429s'].get(hour_key, 0)

        # Compute hour duration (partial for first/last hour)
        hour_start = datetime.strptime(hour_key, '%Y-%m-%d %H:%M')
        hour_end = hour_start + timedelta(hours=1)

        # Effective duration within this hour
        eff_start = max(hour_start, run_start)
        eff_end = min(hour_end, last_ts if last_ts else now)
        hour_duration = max((eff_end - eff_start).total_seconds() / 3600, 0.001)

        gaps_per_hour = h['gaps'] / hour_duration if hour_duration > 0 else 0
        rate_str = f"{h['last_rate_interval']:.3f}" if h['last_rate_interval'] else '  -'

        # Track recent hours for forecast
        recent_gaps_per_hour.append((hour_key, h['gaps'], hour_duration, gaps_per_hour))

        # Mark current hour
        marker = ' ◀' if hour_key == now.strftime('%Y-%m-%d %H:00') else ''

        print(f'  {hour_key:<18} {h["gaps"]:>6} {h["sharpenings"]:>6} {hour_429s:>5} {h["errors"]:>5} {rate_str:>8} {gaps_per_hour:>7.0f}{marker}')

    print('  ' + '-' * 68)
    print()

    # Forecast
    remaining = (total_for_pct - catalog_sharpened) if catalog_total else (TOTAL_GAPS - unique_gaps)
    if len(recent_gaps_per_hour) >= 1:
        # Use last 3 hours (or whatever we have)
        forecast_hours = recent_gaps_per_hour[-min(3, len(recent_gaps_per_hour)):]
        total_forecast_gaps = sum(g for _, g, _, _ in forecast_hours)
        total_forecast_duration = sum(d for _, _, d, _ in forecast_hours)

        if total_forecast_duration > 0 and total_forecast_gaps > 0:
            avg_rate = total_forecast_gaps / total_forecast_duration
            hours_remaining = remaining / avg_rate
            eta = now + timedelta(hours=hours_remaining)

            print(f'  FORECAST (based on last {len(forecast_hours)} hour(s)):')
            print(f'  Recent rate:     {avg_rate:.0f} gaps/hour')
            print(f'  Remaining:       {remaining:,} gaps')
            print(f'  Est. time left:  {hours_remaining:.1f} hours ({hours_remaining/24:.1f} days)')
            print(f'  Est. completion: {eta.strftime("%Y-%m-%d %H:%M")}')
        else:
            print('  FORECAST: Not enough data yet.')
    else:
        print('  FORECAST: Not enough data yet.')

    print()
    print('=' * 72)
    print()

    # Pick a random voice for Claude to deliver the results in
    VOICES = [
        "a golden retriever",
        "a barber who's seen everything",
        "an Olympic gymnastics coach",
        "a grandmother who just learned to text",
        "a jazz DJ at 2am",
        "a pilot making announcements",
        "a nature documentary narrator",
        "a used car salesman",
        "a yoga instructor",
        "a drill sergeant",
        "a wine sommelier",
        "a toddler explaining their day",
        "a sports commentator",
        "a pirate captain",
        "a therapist",
        "a surfer",
        "an auctioneer",
        "a librarian",
        "a mob boss",
        "Shakespeare",
        "a weather forecaster",
        "a kindergarten teacher",
        "a noir detective",
        "a conspiracy theorist",
        "a grandpa telling a war story",
        "a motivational speaker at 6am",
        "a Michelin star chef",
        "a spaceflight mission control operator",
        "a horse race announcer",
        "a stoned philosopher",
    ]

    # Track used voices so they don't repeat
    used_path = Path(__file__).parent / '.report_voices_used.json'
    used = []
    if used_path.exists():
        try:
            used = json.loads(used_path.read_text())
        except Exception:
            used = []

    available = [v for v in VOICES if v not in used]
    if not available:
        used = []
        available = VOICES[:]

    voice = random.choice(available)
    used.append(voice)
    used_path.write_text(json.dumps(used))

    print(f'  CLAUDE: Summarize these results like {voice}. Keep it to 2-3 sentences.')
    print()


if __name__ == '__main__':
    main()
