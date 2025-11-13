#!/usr/bin/env python3
"""
Validate that metadata files have all expected chunks based on collector run time.
"""

import requests
import json
from datetime import datetime, timezone, timedelta
from collections import defaultdict

COLLECTOR_STATE_URL = 'https://volcano-audio-collector-production.up.railway.app/collector-state'
COLLECTOR_STATUS_URL = 'https://volcano-audio-collector-production.up.railway.app/status'  # Fallback
CDN_BASE_URL = 'https://cdn.now.audio/data'

VOLCANO_MAP = {
    'kilauea': 'kilauea',
    'maunaloa': 'maunaloa',
    'greatsitkin': 'greatsitkin',
    'shishaldin': 'shishaldin',
    'spurr': 'spurr'
}

def get_collector_state():
    """Get collector state (lightweight - just last run time and running status)."""
    try:
        response = requests.get(COLLECTOR_STATE_URL, timeout=5)
        response.raise_for_status()
        return response.json()
    except Exception:
        # Fallback to full status endpoint if lightweight endpoint fails
        response = requests.get(COLLECTOR_STATUS_URL, timeout=10)
        response.raise_for_status()
        status = response.json()
        return {
            'last_run_completed': status.get('last_run_completed'),
            'currently_running': status.get('currently_running', False)
        }

def get_last_complete_period(now, period_type):
    """Calculate the start time of the last period that SHOULD be complete."""
    if period_type == '10m':
        # Collector runs every 10 minutes, collects previous 10m period
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

def get_expected_chunks_for_date(target_date, last_collector_run):
    """
    Determine what chunks SHOULD exist for a given date based on collector run time.
    
    Args:
        target_date: datetime object for the date to check (YYYY-MM-DD)
        last_collector_run: datetime when collector last ran
    
    Returns:
        dict: {chunk_type: [list of expected chunk start times]}
    """
    # Parse target_date if it's a string
    if isinstance(target_date, str):
        target_date = datetime.strptime(target_date, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    
    # Parse last_collector_run if it's a string
    if isinstance(last_collector_run, str):
        # Handle format: "2025-11-13 00:52:15 UTC"
        last_collector_run = datetime.strptime(last_collector_run.replace(' UTC', ''), '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
    
    expected = {
        '10m': [],
        '1h': [],
        '6h': []
    }
    
    # Start of target date
    date_start = target_date.replace(hour=0, minute=0, second=0, microsecond=0)
    date_end = date_start + timedelta(days=1)
    
    # Determine last complete period for each type
    last_complete_10m = get_last_complete_period(last_collector_run, '10m')
    last_complete_1h = get_last_complete_period(last_collector_run, '1h')
    last_complete_6h = get_last_complete_period(last_collector_run, '6h')
    
    # 10m chunks: every 10 minutes from 00:00:00 to last_complete_10m (if in this date)
    current_10m = date_start
    while current_10m < date_end:
        if current_10m <= last_complete_10m:
            expected['10m'].append(current_10m.strftime('%H:%M:%S'))
        current_10m += timedelta(minutes=10)
    
    # 1h chunks: every hour from 00:00:00 to last_complete_1h (if in this date)
    current_1h = date_start
    while current_1h < date_end:
        if current_1h <= last_complete_1h:
            expected['1h'].append(current_1h.strftime('%H:%M:%S'))
        current_1h += timedelta(hours=1)
    
    # 6h chunks: at 00:00, 06:00, 12:00, 18:00 up to last_complete_6h (if in this date)
    current_6h = date_start
    while current_6h < date_end:
        if current_6h <= last_complete_6h:
            expected['6h'].append(current_6h.strftime('%H:%M:%S'))
        current_6h += timedelta(hours=6)
    
    return expected

def download_metadata(network, station, location, channel, volcano, date):
    """Download metadata file."""
    location = location or '--'
    volcano_name = VOLCANO_MAP.get(volcano, volcano)
    [year, month, day] = date.split('-')
    date_path = f"{year}/{month}/{day}"
    
    # Try NEW format first
    new_url = f"{CDN_BASE_URL}/{date_path}/{network}/{volcano_name}/{station}/{location}/{channel}/{network}_{station}_{location}_{channel}_{date}.json"
    response = requests.get(new_url)
    
    if response.ok:
        return response.json()
    
    # Try OLD format
    old_url = f"{CDN_BASE_URL}/{date_path}/{network}/{volcano_name}/{station}/{location}/{channel}/{network}_{station}_{location}_{channel}_100Hz_{date}.json"
    response = requests.get(old_url)
    
    if response.ok:
        return response.json()
    
    return None

def validate_metadata_chunks(network, station, location, channel, volcano, date):
    """Validate that metadata has all expected chunks."""
    print(f"\n{'='*70}")
    print(f"Validating metadata for {network}.{station}.{location or '--'}.{channel}")
    print(f"Date: {date}")
    print(f"{'='*70}")
    
    # Get collector state (lightweight endpoint)
    print("\n📡 Fetching collector state...")
    state = get_collector_state()
    last_run = state['last_run_completed']
    currently_running = state.get('currently_running', False)
    print(f"✅ Collector last ran: {last_run}")
    if currently_running:
        print(f"⚠️  Collector is currently running (validation may be incomplete)")
    
    # Get expected chunks
    print(f"\n📋 Calculating expected chunks...")
    expected = get_expected_chunks_for_date(date, last_run)
    
    print(f"   Expected 10m chunks: {len(expected['10m'])}")
    print(f"   Expected 1h chunks: {len(expected['1h'])}")
    print(f"   Expected 6h chunks: {len(expected['6h'])}")
    
    if expected['10m']:
        print(f"   10m range: {expected['10m'][0]} to {expected['10m'][-1]}")
    if expected['1h']:
        print(f"   1h range: {expected['1h'][0]} to {expected['1h'][-1]}")
    if expected['6h']:
        print(f"   6h range: {expected['6h'][0]} to {expected['6h'][-1]}")
    
    # Download actual metadata
    print(f"\n📥 Downloading metadata...")
    metadata = download_metadata(network, station, location, channel, volcano, date)
    
    if not metadata:
        print(f"❌ Failed to download metadata!")
        return False
    
    print(f"✅ Metadata downloaded")
    print(f"   Created at: {metadata.get('created_at', 'N/A')}")
    print(f"   Complete day: {metadata.get('complete_day', False)}")
    
    # Get actual chunks
    actual = {
        '10m': [chunk['start'] for chunk in metadata.get('chunks', {}).get('10m', [])],
        '1h': [chunk['start'] for chunk in metadata.get('chunks', {}).get('1h', [])],
        '6h': [chunk['start'] for chunk in metadata.get('chunks', {}).get('6h', [])]
    }
    
    print(f"\n📊 Actual chunks in metadata:")
    print(f"   10m chunks: {len(actual['10m'])}")
    print(f"   1h chunks: {len(actual['1h'])}")
    print(f"   6h chunks: {len(actual['6h'])}")
    
    # Compare
    print(f"\n🔍 Comparison:")
    all_good = True
    
    for chunk_type in ['10m', '1h', '6h']:
        expected_set = set(expected[chunk_type])
        actual_set = set(actual[chunk_type])
        
        missing = expected_set - actual_set
        extra = actual_set - expected_set
        
        if missing:
            print(f"\n   ❌ {chunk_type.upper()} - MISSING {len(missing)} chunks:")
            for chunk_time in sorted(missing):
                print(f"      - {chunk_time}")
            all_good = False
        else:
            print(f"   ✅ {chunk_type.upper()} - All expected chunks present")
        
        if extra:
            print(f"   ⚠️  {chunk_type.upper()} - EXTRA {len(extra)} chunks (not expected):")
            for chunk_time in sorted(extra):
                print(f"      + {chunk_time}")
    
    print(f"\n{'='*70}")
    if all_good:
        print(f"✅ VALIDATION PASSED - All expected chunks are present!")
    else:
        print(f"❌ VALIDATION FAILED - Missing expected chunks")
    print(f"{'='*70}\n")
    
    return all_good

if __name__ == '__main__':
    import argparse
    
    parser = argparse.ArgumentParser(description='Validate metadata chunks')
    parser.add_argument('--network', required=True, help='Network code')
    parser.add_argument('--station', required=True, help='Station code')
    parser.add_argument('--location', default='--', help='Location code')
    parser.add_argument('--channel', required=True, help='Channel code')
    parser.add_argument('--volcano', required=True, choices=list(VOLCANO_MAP.keys()))
    parser.add_argument('--date', required=True, help='Date (YYYY-MM-DD)')
    
    args = parser.parse_args()
    
    validate_metadata_chunks(
        args.network, args.station, args.location, args.channel,
        args.volcano, args.date
    )

