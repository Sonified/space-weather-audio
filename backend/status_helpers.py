"""
Helper functions for the /status endpoint.

This module provides optimized status calculation using publicly accessible
run logs instead of scanning the entire R2 bucket.
"""

import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


# Public CDN URL for run log
RUN_LOG_URL = 'https://cdn.now.audio/collector_logs/run_history.json'


def load_run_log_from_cdn():
    """
    Load run log from public CDN (no auth required).
    
    Returns:
        list of run dicts, or None if not found
    """
    try:
        with urllib.request.urlopen(RUN_LOG_URL, timeout=10) as response:
            data = json.loads(response.read().decode('utf-8'))
            # Handle both old format (direct list) and new format (object with 'runs' key)
            if isinstance(data, list):
                return data
            elif isinstance(data, dict) and 'runs' in data:
                return data['runs']
            else:
                return None
    except Exception as e:
        print(f"Warning: Could not load run log from CDN: {e}")
        return None


def get_active_station_count():
    """Get count of active stations from config"""
    try:
        config_path = Path(__file__).parent / 'stations_config.json'
        with open(config_path) as f:
            config = json.load(f)
        
        active_count = 0
        for network, volcanoes in config['networks'].items():
            for volcano, stations in volcanoes.items():
                active_count += sum(1 for s in stations if s.get('active', False))
        
        return active_count
    except Exception as e:
        print(f"Warning: Could not count active stations: {e}")
        return 0


def calculate_collection_stats_from_run_log(runs):
    """
    Calculate collection stats from run log instead of scanning R2.
    
    Args:
        runs: list of run dicts from run_history.json
    
    Returns:
        dict with collection stats, or None if insufficient data
    """
    if not runs:
        return None
    
    # Get latest run
    latest_run = runs[0] if runs else {}
    
    # Calculate stats from run log
    all_stations = latest_run.get('stations', [])
    files_created = latest_run.get('files_created', {'10m': 0, '1h': 0, '6h': 0})
    
    # Count total files across all runs (from last 7 days of history)
    total_10m = sum(run.get('files_created', {}).get('10m', 0) for run in runs)
    total_1h = sum(run.get('files_created', {}).get('1h', 0) for run in runs)
    total_6h = sum(run.get('files_created', {}).get('6h', 0) for run in runs)
    
    # Get active station count from config
    active_station_count = get_active_station_count()
    
    # Calculate collection cycles (from run log history)
    collection_cycles = len(runs)
    
    # Calculate coverage estimates
    # Each run creates files for all stations, so we can estimate coverage
    # based on the number of runs and file types
    coverage_hours = {
        '10m': (collection_cycles * 10) / 60,  # 10 min per cycle
        '1h': collection_cycles / 6,  # 1 hour file every 6 cycles
        '6h': collection_cycles / 36  # 6 hour file every 36 cycles
    }
    
    def format_hours_minutes(total_hours):
        """Format hours as '1h 40m' or '0h' or '2h'"""
        if total_hours == 0:
            return "0h"
        hours = int(total_hours)
        minutes = round((total_hours - hours) * 60)
        if minutes == 0:
            return f"{hours}h"
        return f"{hours}h {minutes}m"
    
    # Count failures in last 24h
    failures_24h = []
    for run in runs:
        if not run.get('success', True):
            failures_24h.append({
                'time': run.get('end_time') or run.get('timestamp'),
                'failed': run.get('failed', 0),
                'total': run.get('total_tasks', 0)
            })
    
    return {
        'active_stations': active_station_count,
        'stations_in_last_run': len(all_stations),
        'collection_cycles': collection_cycles,
        'files_created_last_run': files_created,
        'total_files_created_7d': {
            '10m': total_10m,
            '1h': total_1h,
            '6h': total_6h
        },
        'estimated_coverage': {
            '10m': format_hours_minutes(coverage_hours['10m']),
            '1h': format_hours_minutes(coverage_hours['1h']),
            '6h': format_hours_minutes(coverage_hours['6h'])
        },
        'failures_24h': failures_24h,
        'last_run_success': latest_run.get('success', False),
        'last_run_stats': {
            'total_tasks': latest_run.get('total_tasks', 0),
            'successful': latest_run.get('successful', 0),
            'skipped': latest_run.get('skipped', 0),
            'failed': latest_run.get('failed', 0)
        }
    }


def get_collection_stats_from_run_log():
    """
    Main entry point: Load run log and calculate stats.
    
    Returns:
        dict with collection stats, or None if run log doesn't exist
    """
    runs = load_run_log_from_cdn()
    if not runs:
        return None
    
    return calculate_collection_stats_from_run_log(runs)
