#!/usr/bin/env python3
"""
Automated validation of last 24 hours of collections.
Checks all active stations and validates metadata completeness based on collector run time.
"""

import requests
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
from collections import defaultdict

COLLECTOR_STATE_URL = 'https://volcano-audio-collector-production.up.railway.app/collector-state'
COLLECTOR_STATUS_URL = 'https://volcano-audio-collector-production.up.railway.app/status'  # Fallback if needed
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

def get_active_stations():
    """Load active stations from stations_config.json."""
    config_path = Path(__file__).parent / 'stations_config.json'
    with open(config_path) as f:
        config = json.load(f)
    
    active_stations = []
    for network, volcanoes in config['networks'].items():
        for volcano, stations in volcanoes.items():
            for station in stations:
                if station.get('active', False):
                    active_stations.append({
                        'network': network,
                        'volcano': volcano,
                        'station': station['station'],
                        'location': station.get('location', '--'),
                        'channel': station['channel'],
                        'sample_rate': station.get('sample_rate', 100.0)
                    })
    
    return active_stations

def get_last_complete_period(now, period_type):
    """Calculate the start time of the last period that SHOULD be complete."""
    if period_type == '10m':
        minute_in_period = now.minute % 10
        if minute_in_period >= 3:
            last_period_start = now - timedelta(minutes=(minute_in_period + 10))
        else:
            last_period_start = now - timedelta(minutes=(minute_in_period + 20))
        last_period_start = last_period_start.replace(minute=(last_period_start.minute // 10) * 10, second=0, microsecond=0)
        return last_period_start
    
    elif period_type == '1h':
        if now.minute >= 3:
            return (now - timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
        else:
            return (now - timedelta(hours=2)).replace(minute=0, second=0, microsecond=0)
    
    elif period_type == '6h':
        current_window_hour = (now.hour // 6) * 6
        minutes_into_window = (now.hour % 6) * 60 + now.minute
        
        if minutes_into_window >= 3:
            return (now.replace(hour=current_window_hour, minute=0, second=0, microsecond=0) - timedelta(hours=6))
        else:
            return (now.replace(hour=current_window_hour, minute=0, second=0, microsecond=0) - timedelta(hours=12))

def get_expected_chunks_for_date(target_date, last_collector_run):
    """Determine what chunks SHOULD exist for a given date based on collector run time."""
    if isinstance(target_date, str):
        target_date = datetime.strptime(target_date, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    
    if isinstance(last_collector_run, str):
        last_collector_run = datetime.strptime(last_collector_run.replace(' UTC', ''), '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
    
    expected = {
        '10m': [],
        '1h': [],
        '6h': []
    }
    
    date_start = target_date.replace(hour=0, minute=0, second=0, microsecond=0)
    date_end = date_start + timedelta(days=1)
    
    last_complete_10m = get_last_complete_period(last_collector_run, '10m')
    last_complete_1h = get_last_complete_period(last_collector_run, '1h')
    last_complete_6h = get_last_complete_period(last_collector_run, '6h')
    
    # 10m chunks
    current_10m = date_start
    while current_10m < date_end:
        if current_10m <= last_complete_10m:
            expected['10m'].append(current_10m.strftime('%H:%M:%S'))
        current_10m += timedelta(minutes=10)
    
    # 1h chunks
    current_1h = date_start
    while current_1h < date_end:
        if current_1h <= last_complete_1h:
            expected['1h'].append(current_1h.strftime('%H:%M:%S'))
        current_1h += timedelta(hours=1)
    
    # 6h chunks
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
    response = requests.get(new_url, timeout=10)
    
    if response.ok:
        return response.json()
    
    # Try OLD format
    old_url = f"{CDN_BASE_URL}/{date_path}/{network}/{volcano_name}/{station}/{location}/{channel}/{network}_{station}_{location}_{channel}_100Hz_{date}.json"
    response = requests.get(old_url, timeout=10)
    
    if response.ok:
        return response.json()
    
    return None

def validate_station_date(station_info, date, last_collector_run):
    """Validate a single station/date combination."""
    network = station_info['network']
    station = station_info['station']
    location = station_info['location']
    channel = station_info['channel']
    volcano = station_info['volcano']
    
    # Get expected chunks
    expected = get_expected_chunks_for_date(date, last_collector_run)
    
    # Download metadata
    metadata = download_metadata(network, station, location, channel, volcano, date)
    
    if not metadata:
        return {
            'status': 'missing_metadata',
            'expected': expected,
            'actual': None,
            'missing': expected,
            'extra': {}
        }
    
    # Get actual chunks
    actual = {
        '10m': [chunk['start'] for chunk in metadata.get('chunks', {}).get('10m', [])],
        '1h': [chunk['start'] for chunk in metadata.get('chunks', {}).get('1h', [])],
        '6h': [chunk['start'] for chunk in metadata.get('chunks', {}).get('6h', [])]
    }
    
    # Compare
    missing = {}
    extra = {}
    all_good = True
    
    for chunk_type in ['10m', '1h', '6h']:
        expected_set = set(expected[chunk_type])
        actual_set = set(actual[chunk_type])
        
        chunk_missing = expected_set - actual_set
        chunk_extra = actual_set - expected_set
        
        if chunk_missing:
            missing[chunk_type] = sorted(chunk_missing)
            all_good = False
        
        if chunk_extra:
            extra[chunk_type] = sorted(chunk_extra)
    
    return {
        'status': 'ok' if all_good else 'missing_chunks',
        'expected': expected,
        'actual': actual,
        'missing': missing,
        'extra': extra,
        'created_at': metadata.get('created_at'),
        'complete_day': metadata.get('complete_day', False)
    }

def validate_last_24h():
    """Validate all active stations for the last 24 hours."""
    print(f"\n{'='*70}")
    print(f"VALIDATING LAST 24 HOURS OF COLLECTIONS")
    print(f"{'='*70}\n")
    
    # Get collector state (lightweight endpoint)
    print("📡 Fetching collector state...")
    state = get_collector_state()
    last_run = state['last_run_completed']
    currently_running = state.get('currently_running', False)
    print(f"✅ Collector last ran: {last_run}")
    if currently_running:
        print(f"⚠️  Collector is currently running (validation may be incomplete)")
    
    # Parse last run time
    last_run_dt = datetime.strptime(last_run.replace(' UTC', ''), '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
    
    # Calculate 24h window
    window_start = last_run_dt - timedelta(hours=24)
    
    print(f"📅 Validation window: {window_start.strftime('%Y-%m-%d %H:%M:%S')} to {last_run_dt.strftime('%Y-%m-%d %H:%M:%S')}")
    
    # Get dates to check (might span 2-3 days)
    dates_to_check = []
    current_date = window_start.date()
    end_date = last_run_dt.date()
    
    while current_date <= end_date:
        dates_to_check.append(current_date.strftime('%Y-%m-%d'))
        current_date += timedelta(days=1)
    
    print(f"📋 Dates to check: {', '.join(dates_to_check)}\n")
    
    # Get active stations
    print("📋 Loading active stations...")
    active_stations = get_active_stations()
    print(f"✅ Found {len(active_stations)} active stations\n")
    
    # Validate each station/date combination
    results = []
    total_checks = len(active_stations) * len(dates_to_check)
    current_check = 0
    
    for station_info in active_stations:
        station_key = f"{station_info['network']}.{station_info['station']}.{station_info['location']}.{station_info['channel']}"
        
        for date in dates_to_check:
            current_check += 1
            print(f"[{current_check}/{total_checks}] Checking {station_key} - {date}...", end=' ', flush=True)
            
            result = validate_station_date(station_info, date, last_run)
            result['station'] = station_key
            result['date'] = date
            results.append(result)
            
            if result['status'] == 'missing_metadata':
                print("❌ Missing metadata file")
            elif result['status'] == 'missing_chunks':
                missing_count = sum(len(v) for v in result['missing'].values())
                print(f"⚠️  Missing {missing_count} chunks")
            else:
                print("✅ OK")
    
    # Summary
    print(f"\n{'='*70}")
    print(f"VALIDATION SUMMARY")
    print(f"{'='*70}\n")
    
    total_checks = len(results)
    ok_count = sum(1 for r in results if r['status'] == 'ok')
    missing_metadata_count = sum(1 for r in results if r['status'] == 'missing_metadata')
    missing_chunks_count = sum(1 for r in results if r['status'] == 'missing_chunks')
    
    print(f"Total checks: {total_checks}")
    print(f"✅ OK: {ok_count}")
    print(f"❌ Missing metadata: {missing_metadata_count}")
    print(f"⚠️  Missing chunks: {missing_chunks_count}\n")
    
    # Detailed issues
    if missing_metadata_count > 0 or missing_chunks_count > 0:
        print(f"{'='*70}")
        print(f"DETAILED ISSUES")
        print(f"{'='*70}\n")
        
        # Group by issue type
        missing_metadata_list = [r for r in results if r['status'] == 'missing_metadata']
        missing_chunks_list = [r for r in results if r['status'] == 'missing_chunks']
        
        if missing_metadata_list:
            print("❌ MISSING METADATA FILES:")
            for r in missing_metadata_list:
                print(f"   {r['station']} - {r['date']}")
            print()
        
        if missing_chunks_list:
            print("⚠️  MISSING CHUNKS:")
            for r in missing_chunks_list:
                print(f"   {r['station']} - {r['date']}:")
                for chunk_type, missing_times in r['missing'].items():
                    if missing_times:
                        print(f"      {chunk_type}: {len(missing_times)} missing ({missing_times[0]}...{missing_times[-1] if len(missing_times) > 1 else ''})")
            print()
    
    print(f"{'='*70}\n")
    
    # Return exit code
    return 0 if (missing_metadata_count == 0 and missing_chunks_count == 0) else 1

if __name__ == '__main__':
    import sys
    exit_code = validate_last_24h()
    sys.exit(exit_code)

