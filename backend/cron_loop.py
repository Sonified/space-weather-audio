#!/usr/bin/env python3
"""
Continuous cron loop for Railway deployment
Runs cron_job.py every 10 minutes at :02, :12, :22, :32, :42, :52
Version: v1.00
"""
__version__ = "2025_11_04_v1.07"
import time
import subprocess
import sys
import os
import threading
from datetime import datetime, timezone
from flask import Flask, jsonify
from pathlib import Path

# Simple Flask app for health/status endpoint
app = Flask(__name__)

# Get or create deployment time
deploy_time_file = Path(__file__).parent / '.deploy_time'
if deploy_time_file.exists():
    with open(deploy_time_file, 'r') as f:
        deploy_time = f.read().strip()
else:
    deploy_time = datetime.now(timezone.utc).isoformat()
    with open(deploy_time_file, 'w') as f:
        f.write(deploy_time)

# Shared state
status = {
    'version': __version__,
    'deployed_at': deploy_time,
    'started_at': datetime.now(timezone.utc).isoformat(),
    'last_run': None,
    'next_run': None,
    'total_runs': 0,
    'successful_runs': 0,
    'failed_runs': 0,
    'currently_running': False
}

def get_dates_in_period(start_time, end_time):
    """
    Helper: Generate all dates between start_time and end_time (inclusive)
    Returns list of date objects
    Handles month/year boundaries naturally
    """
    from datetime import timedelta
    dates = []
    current = start_time.date()
    end = end_time.date()
    while current <= end:
        dates.append(current)
        current += timedelta(days=1)
    return dates

@app.route('/health')
def health():
    """Simple health check endpoint"""
    return jsonify({'status': 'healthy', 'uptime_seconds': (datetime.now(timezone.utc) - datetime.fromisoformat(status['started_at'])).total_seconds()})

@app.route('/status')
def get_status():
    """Return detailed status with R2 file counts and storage info"""
    import boto3
    import json
    from pathlib import Path
    
    # Collect data for response (build final response at the end)
    try:
        # Initialize R2 client
        R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID', '66f906f29f28b08ae9c80d4f36e25c7a')
        R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID', '9e1cf6c395172f108c2150c52878859f')
        R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY', '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec')
        R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'hearts-data-cache')
        
        s3 = boto3.client(
            's3',
            endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
            aws_access_key_id=R2_ACCESS_KEY_ID,
            aws_secret_access_key=R2_SECRET_ACCESS_KEY,
            region_name='auto'
        )
        
        # Count files and calculate storage
        paginator = s3.get_paginator('list_objects_v2')
        pages = paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix='data/')
        
        file_counts = {'10m': 0, '1h': 0, '6h': 0, 'metadata': 0, 'other': 0}
        station_file_counts = {}  # Track files per station: {station_key: {'10m': count, '1h': count, '6h': count}}
        oldest_files = {'10m': None, '1h': None, '6h': None}  # Track oldest file timestamp by type
        total_size = 0
        latest_modified = None
        
        for page in pages:
            if 'Contents' not in page:
                continue
                
            for obj in page['Contents']:
                total_size += obj['Size']
                
                # Track latest modified
                if latest_modified is None or obj['LastModified'] > latest_modified:
                    latest_modified = obj['LastModified']
                
                # Count by type and extract station from path
                # Path format: data/{YEAR}/{MONTH}/{NETWORK}/{VOLCANO}/{STATION}/{LOCATION}/{CHANNEL}/...
                key = obj['Key']
                path_parts = key.split('/')
                
                # Extract station identifier (network-station-location-channel)
                # Find station in path (should be 5th element: data/YEAR/MONTH/NETWORK/VOLCANO/STATION/...)
                station_key = None
                if len(path_parts) >= 6:
                    # Format: network_station_location_channel (for tracking)
                    network = path_parts[3] if len(path_parts) > 3 else None
                    station = path_parts[5] if len(path_parts) > 5 else None
                    location = path_parts[6] if len(path_parts) > 6 else None
                    channel = path_parts[7] if len(path_parts) > 7 else None
                    if network and station and location and channel:
                        station_key = f"{network}_{station}_{location}_{channel}"
                
                # Count by type and track oldest files
                file_type = None
                if '/10m/' in key:
                    file_counts['10m'] += 1
                    file_type = '10m'
                elif '/1h/' in key:
                    file_counts['1h'] += 1
                    file_type = '1h'
                elif '/6h/' in key:
                    file_counts['6h'] += 1
                    file_type = '6h'
                elif key.endswith('.json'):
                    file_counts['metadata'] += 1
                else:
                    file_counts['other'] += 1
                
                # Extract timestamp from filename to find oldest files
                if file_type and '.bin.zst' in key:
                    # Filename format: NETWORK_STATION_LOCATION_CHANNEL_RATEHz_YYYY-MM-DD-HH-MM-SS_to_YYYY-MM-DD-HH-MM-SS.bin.zst
                    filename = key.split('/')[-1]
                    try:
                        # Extract start timestamp (before "_to_")
                        if '_to_' in filename:
                            start_part = filename.split('_to_')[0]
                            # The timestamp is in format YYYY-MM-DD-HH-MM-SS (19 chars with dashes)
                            # Split by underscore and find the part that matches this pattern
                            parts = start_part.split('_')
                            for part in parts:
                                # Check if this part matches YYYY-MM-DD-HH-MM-SS pattern (19 chars, 5 dashes)
                                if len(part) == 19 and part.count('-') == 5:
                                    # Parse: YYYY-MM-DD-HH-MM-SS
                                    file_timestamp = datetime.strptime(part, '%Y-%m-%d-%H-%M-%S')
                                    file_timestamp = file_timestamp.replace(tzinfo=timezone.utc)
                                    
                                    # Track oldest file for this type
                                    if oldest_files[file_type] is None or file_timestamp < oldest_files[file_type]:
                                        oldest_files[file_type] = file_timestamp
                                    break
                    except (ValueError, IndexError):
                        # Skip if we can't parse the timestamp
                        pass
                
                # Track per-station counts for data files (not metadata)
                if station_key and file_type:
                    if station_key not in station_file_counts:
                        station_file_counts[station_key] = {'10m': 0, '1h': 0, '6h': 0}
                    station_file_counts[station_key][file_type] += 1
        
        total_files = sum(file_counts.values())
        storage_mb = total_size / (1024 * 1024)
        
        # Calculate collection cycles (based on 10m files divided by number of stations)
        # Each cycle creates 1 file per station
        config_path = Path(__file__).parent / 'stations_config.json'
        with open(config_path) as f:
            config = json.load(f)
        
        active_station_count = 0
        for network, volcanoes in config['networks'].items():
            for volcano, stations in volcanoes.items():
                active_station_count += sum(1 for s in stations if s.get('active', False))
        
        # Calculate per-station statistics
        station_10m_counts = [counts['10m'] for counts in station_file_counts.values()] if station_file_counts else []
        station_1h_counts = [counts['1h'] for counts in station_file_counts.values()] if station_file_counts else []
        station_6h_counts = [counts['6h'] for counts in station_file_counts.values()] if station_file_counts else []
        
        # Calculate stats for each period
        def calc_stats(counts, active_count):
            if not counts or active_count == 0:
                return {'min': 0, 'max': 0, 'avg': 0.0, 'is_uniform': True}
            min_count = min(counts) if counts else 0
            max_count = max(counts) if counts else 0
            avg_count = sum(counts) / len(counts) if counts else 0
            # Check if all stations have same count (uniform distribution)
            is_uniform = len(set(counts)) <= 1 if counts else True
            return {
                'min': min_count,
                'max': max_count,
                'avg': round(avg_count, 1),
                'is_uniform': is_uniform
            }
        
        stats_10m = calc_stats(station_10m_counts, active_station_count)
        stats_1h = calc_stats(station_1h_counts, active_station_count)
        stats_6h = calc_stats(station_6h_counts, active_station_count)
        
        # If we have fewer station counts than active stations, some stations are missing files
        stations_with_files = len(station_file_counts)
        missing_stations = active_station_count - stations_with_files if active_station_count > stations_with_files else 0
        
        collection_cycles = file_counts['10m'] // active_station_count if active_station_count > 0 else 0
        
        # Expected files based on collection cycles
        # Each cycle = 10 minutes
        # 1h files created every 6 cycles (60 minutes)
        # 6h files created every 36 cycles (360 minutes)
        expected_10m = collection_cycles * active_station_count
        expected_1h = (collection_cycles // 6) * active_station_count if collection_cycles >= 6 else 0
        expected_6h = (collection_cycles // 36) * active_station_count if collection_cycles >= 36 else 0
        
        # Status checks - account for currently_running
        is_running = status['currently_running']
        
        # For 10m files: if running and (not uniform or missing files), it's actively being created
        if is_running and (not stats_10m['is_uniform'] or file_counts['10m'] < expected_10m):
            status_10m = 'RUNNING'
        elif file_counts['10m'] == expected_10m and stats_10m['is_uniform']:
            status_10m = 'PERFECT'
        else:
            status_10m = 'MISSING'
        
        # For 1h files
        if is_running and (not stats_1h['is_uniform'] or (expected_1h > 0 and file_counts['1h'] < expected_1h)):
            status_1h = 'RUNNING'
        elif file_counts['1h'] == expected_1h and stats_1h['is_uniform']:
            status_1h = 'PERFECT'
        elif file_counts['1h'] >= expected_1h or expected_1h == 0:
            status_1h = 'OK'
        else:
            status_1h = 'INCOMPLETE'
        
        # For 6h files
        if is_running and (not stats_6h['is_uniform'] or (expected_6h > 0 and file_counts['6h'] < expected_6h)):
            status_6h = 'RUNNING'
        elif file_counts['6h'] == expected_6h and stats_6h['is_uniform']:
            status_6h = 'PERFECT'
        elif file_counts['6h'] >= expected_6h or expected_6h == 0:
            status_6h = 'OK'
        else:
            status_6h = 'INCOMPLETE'
        
        all_perfect = (file_counts['10m'] == expected_10m and stats_10m['is_uniform'] and not is_running)
        
        # Calculate coverage depth - how far back we have files
        now = datetime.now(timezone.utc)
        coverage_by_type = {}
        for file_type in ['10m', '1h', '6h']:
            if oldest_files[file_type] is not None:
                hours_back = (now - oldest_files[file_type]).total_seconds() / 3600
                coverage_by_type[file_type] = f"{round(hours_back, 1)}h"
            else:
                coverage_by_type[file_type] = "0h"
        
        # Full coverage = minimum across ALL types (if ANY type has 0, full coverage = 0)
        # Must have 10m, 1h, AND 6h files for full coverage
        hours_10m = (now - oldest_files['10m']).total_seconds() / 3600 if oldest_files['10m'] else 0
        hours_1h = (now - oldest_files['1h']).total_seconds() / 3600 if oldest_files['1h'] else 0
        hours_6h = (now - oldest_files['6h']).total_seconds() / 3600 if oldest_files['6h'] else 0
        
        # Full coverage requires ALL types
        if hours_10m > 0 and hours_1h > 0 and hours_6h > 0:
            full_coverage_hours_back = min(hours_10m, hours_1h, hours_6h)
        else:
            full_coverage_hours_back = 0
        
        full_coverage_days_back = round(full_coverage_hours_back / 24, 2) if full_coverage_hours_back > 0 else 0
        
        collection_stats = {
            'active_stations': active_station_count,
            'stations_with_files': stations_with_files,
            'missing_stations': missing_stations if missing_stations > 0 else None,
            'collection_cycles': collection_cycles,
            'coverage_depth': {
                'full_coverage_hours_back': round(full_coverage_hours_back, 1),
                'full_coverage_days_back': full_coverage_days_back,
                'by_type': coverage_by_type
            },
            'files_per_station': {
                '10m': stats_10m,
                '1h': stats_1h,
                '6h': stats_6h
            },
            'expected_vs_actual': {
                '10m': {
                    'actual': file_counts['10m'],
                    'expected': expected_10m,
                    'status': status_10m
                },
                '1h': {
                    'actual': file_counts['1h'],
                    'expected': expected_1h,
                    'status': status_1h
                },
                '6h': {
                    'actual': file_counts['6h'],
                    'expected': expected_6h,
                    'status': status_6h
                },
                'overall': 'PERFECT' if all_perfect else 'OK'
            }
        }
        
        r2_storage = {
            'total_files': total_files,
            'file_counts': file_counts,
            'total_size_mb': round(storage_mb, 2),
            'total_size_gb': round(storage_mb / 1024, 3),
            'latest_file': latest_modified.isoformat() if latest_modified else None
        }
        
    except Exception as e:
        r2_storage = {
            'error': str(e)
        }
        collection_stats = {}  # Empty on error
    
    # Build final response in explicit order: runtime fields FIRST, then data
    # Use json.dumps with sort_keys=False to preserve order
    import json as json_module
    from flask import Response
    
    final_response = {
        'version': status['version'],
        'currently_running': status['currently_running'],
        'deployed_at': status['deployed_at'],
        'failed_runs': status['failed_runs'],
        'last_run': status['last_run'],
        'next_run': status['next_run'],
        'collection_stats': collection_stats,
        'r2_storage': r2_storage,
        'started_at': status['started_at'],
        'total_runs': status['total_runs'],
        'successful_runs': status['successful_runs']
    }
    
    return Response(
        json_module.dumps(final_response, indent=2, sort_keys=False),
        mimetype='application/json'
    )

@app.route('/stations')
def get_stations():
    """Return currently active stations"""
    import json
    from pathlib import Path
    
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
                        'location': station['location'],
                        'channel': station['channel'],
                        'sample_rate': station['sample_rate']
                    })
    
    return jsonify({
        'total': len(active_stations),
        'stations': active_stations
    })

@app.route('/validate/<period>/report')
def validate_report(period='24h'):
    """Generate human-readable text report from validation"""
    from flask import Response
    
    # Get JSON data from validate endpoint
    with app.test_client() as client:
        resp = client.get(f'/validate/{period}')
        data = resp.get_json()
    
    health = data.get('health', {})
    
    # Build text report
    lines = []
    lines.append("=" * 60)
    lines.append(f"  {health.get('icon', '❓')} STATUS: {health.get('status', 'UNKNOWN')}")
    lines.append("=" * 60)
    lines.append("")
    lines.append(f"Period: {data.get('period_hours', '?')} hours ({data.get('days_checked', '?')} days)")
    lines.append(f"Validation Time: {data.get('validation_time', 'N/A')[:19]}")
    lines.append("")
    lines.append(f"Message: {health.get('message', 'N/A')}")
    lines.append("")
    lines.append(f"Stations Checked: {health.get('stations_checked', 0)}")
    lines.append(f"  ✅ OK: {health.get('stations_ok', 0)}")
    lines.append(f"  ⚠️  With Issues: {health.get('stations_with_issues', 0)}")
    lines.append("")
    
    summary = data.get('summary', {})
    lines.append("Summary:")
    lines.append(f"  Missing Files: {summary.get('total_missing', 0)} files across {summary.get('missing_files', 0)} stations")
    lines.append(f"  Orphaned Files: {summary.get('total_orphaned', 0)} files across {summary.get('orphaned_files', 0)} stations")
    lines.append(f"  No Metadata: {summary.get('no_metadata', 0)} stations")
    lines.append(f"  Errors: {summary.get('error', 0)} stations")
    lines.append("")
    
    if not health.get('healthy', True):
        lines.append("Stations with Issues:")
        for station in data.get('stations', []):
            if station['status'] != 'OK':
                lines.append(f"  • {station['network']}.{station['station']} - {station['status']}")
                if station.get('orphaned_files'):
                    lines.append(f"      Orphaned: {len(station['orphaned_files'])} files")
                if station.get('missing_files'):
                    lines.append(f"      Missing: {len(station['missing_files'])} files")
                if station.get('issues'):
                    for issue in station['issues']:
                        lines.append(f"      {issue}")
        lines.append("")
    
    lines.append("=" * 60)
    lines.append("")
    
    return Response('\n'.join(lines), mimetype='text/plain')

@app.route('/validate')
@app.route('/validate/<period>')
def validate(period='24h'):
    """
    Validate R2 data integrity using metadata
    Checks: metadata vs actual files, orphaned files, missing files
    Examples: /validate/24h, /validate/2d, /validate/12h
    """
    import json
    import boto3
    from pathlib import Path
    from datetime import timedelta
    
    # Parse period
    if period.endswith('d'):
        hours = int(period[:-1]) * 24
    elif period.endswith('h'):
        hours = int(period[:-1])
    else:
        hours = int(period)
    
    # Initialize R2 client
    R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID', '66f906f29f28b08ae9c80d4f36e25c7a')
    R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID', '9e1cf6c395172f108c2150c52878859f')
    R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY', '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec')
    R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'hearts-data-cache')
    
    s3 = boto3.client(
        's3',
        endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name='auto'
    )
    
    # Load active stations
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
                        **station
                    })
    
    # Calculate time range
    now = datetime.now(timezone.utc)
    start_time = now - timedelta(hours=hours)
    dates_to_check = get_dates_in_period(start_time, now)
    
    # Results (health will be added at the end, but we initialize structure)
    results = {
        'validation_time': now.isoformat(),
        'period_hours': hours,
        'start_time': start_time.isoformat(),
        'end_time': now.isoformat(),
        'days_checked': len(dates_to_check),
        'total_stations': len(active_stations),
        'stations': []
    }
    
    # Validate each station across all dates
    for station_config in active_stations:
        network = station_config['network']
        volcano = station_config['volcano']
        station = station_config['station']
        location = station_config['location']
        channel = station_config['channel']
        sample_rate = station_config['sample_rate']
        location_str = location if location and location != '--' else '--'
        rate_str = f"{sample_rate:.2f}".rstrip('0').rstrip('.') if '.' in str(sample_rate) else str(int(sample_rate))
        
        station_result = {
            'network': network,
            'volcano': volcano,
            'station': station,
            'location': location_str,
            'channel': channel,
            'sample_rate': sample_rate,
            'metadata_chunks': {'10m': 0, '1h': 0, '6h': 0},
            'actual_files': {'10m': 0, '1h': 0, '6h': 0},
            'missing_files': [],
            'orphaned_files': [],
            'issues': []
        }
        
        try:
            # Validate across all dates in the period
            for check_date in dates_to_check:
                year = check_date.year
                month = f"{check_date.month:02d}"
                date_str = check_date.strftime("%Y-%m-%d")
                prefix = f"data/{year}/{month}/{network}/{volcano}/{station}/{location_str}/{channel}/"
                metadata_key = f"{prefix}{network}_{station}_{location_str}_{channel}_{rate_str}Hz_{date_str}.json"
                
                # Get metadata for this date
                metadata = None
                try:
                    response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_key)
                    metadata = json.loads(response['Body'].read().decode('utf-8'))
                except s3.exceptions.NoSuchKey:
                    # No metadata for this date - skip
                    continue
                
                # Build expected filenames from metadata for this date
                expected_files = set()
                for chunk_type in ['10m', '1h', '6h']:
                    station_result['metadata_chunks'][chunk_type] += len(metadata['chunks'].get(chunk_type, []))
                    for chunk in metadata['chunks'].get(chunk_type, []):
                        # Construct filename
                        start_time_str = chunk['start'].replace(':', '-')
                        end_time_str = chunk['end'].replace(':', '-')
                        filename = f"{network}_{station}_{location_str}_{channel}_{rate_str}Hz_{chunk_type}_{date_str}-{start_time_str}_to_{date_str}-{end_time_str}.bin.zst"
                        expected_files.add(filename)
                
                # List actual files in R2 for this date (now in subfolders by chunk type)
                actual_files = set()
                for chunk_type in ['10m', '1h', '6h']:
                    chunk_prefix = f"{prefix}{chunk_type}/"
                    response = s3.list_objects_v2(Bucket=R2_BUCKET_NAME, Prefix=chunk_prefix)
                    
                    if 'Contents' in response:
                        for obj in response['Contents']:
                            filename = obj['Key'].split('/')[-1]
                            if filename.endswith('.bin.zst'):
                                actual_files.add(filename)
                                station_result['actual_files'][chunk_type] += 1
                
                # Find missing files (in metadata but not in R2) for this date
                missing = expected_files - actual_files
                station_result['missing_files'].extend(sorted(list(missing)))
                
                # Find orphaned files (in R2 but not in metadata) for this date
                orphaned = actual_files - expected_files
                station_result['orphaned_files'].extend(sorted(list(orphaned)))
            
            # Report issues (after all dates checked)
            if len(station_result['missing_files']) > 0:
                station_result['issues'].append(f"{len(station_result['missing_files'])} files listed in metadata but missing in R2")
            if len(station_result['orphaned_files']) > 0:
                station_result['issues'].append(f"{len(station_result['orphaned_files'])} orphaned files in R2 (not in metadata)")
            
            # Determine status
            if len(station_result['missing_files']) == 0 and len(station_result['orphaned_files']) == 0:
                station_result['status'] = 'OK'
            elif len(station_result['missing_files']) > 0:
                station_result['status'] = 'MISSING_FILES'
            elif len(station_result['orphaned_files']) > 0:
                station_result['status'] = 'ORPHANED_FILES'
            
        except Exception as e:
            station_result['issues'].append(f"Validation error: {str(e)}")
            station_result['status'] = 'ERROR'
        
        results['stations'].append(station_result)
    
    # Summary
    ok_count = sum(1 for s in results['stations'] if s.get('status') == 'OK')
    missing_count = sum(1 for s in results['stations'] if s.get('status') == 'MISSING_FILES')
    orphaned_count = sum(1 for s in results['stations'] if s.get('status') == 'ORPHANED_FILES')
    no_metadata_count = sum(1 for s in results['stations'] if s.get('status') == 'NO_METADATA')
    error_count = sum(1 for s in results['stations'] if s.get('status') == 'ERROR')
    total_missing = sum(len(s.get('missing_files', [])) for s in results['stations'])
    total_orphaned = sum(len(s.get('orphaned_files', [])) for s in results['stations'])
    
    # Determine overall health
    all_healthy = (ok_count == len(active_stations) and 
                   missing_count == 0 and 
                   orphaned_count == 0 and 
                   no_metadata_count == 0 and 
                   error_count == 0)
    
    results['summary'] = {
        'ok': ok_count,
        'missing_files': missing_count,
        'orphaned_files': orphaned_count,
        'no_metadata': no_metadata_count,
        'error': error_count,
        'total_missing': total_missing,
        'total_orphaned': total_orphaned
    }
    
    # Human-readable report
    if all_healthy:
        status_icon = '✅'
        status_text = 'HEALTHY'
        status_message = f'All {len(active_stations)} stations are healthy. Metadata matches files perfectly.'
    else:
        status_icon = '⚠️'
        status_text = 'ISSUES DETECTED'
        issues = []
        if missing_count > 0:
            issues.append(f'{missing_count} stations with missing files ({total_missing} files)')
        if orphaned_count > 0:
            issues.append(f'{orphaned_count} stations with orphaned files ({total_orphaned} files)')
        if no_metadata_count > 0:
            issues.append(f'{no_metadata_count} stations without metadata')
        if error_count > 0:
            issues.append(f'{error_count} stations with errors')
        status_message = ' | '.join(issues)
    
    # Build final response with health at the top
    response = {
        'health': {
            'status': status_text,
            'healthy': all_healthy,
            'icon': status_icon,
            'message': status_message,
            'stations_checked': len(active_stations),
            'stations_ok': ok_count,
            'stations_with_issues': len(active_stations) - ok_count
        },
        'summary': results['summary'],
        'validation_time': results['validation_time'],
        'period_hours': results['period_hours'],
        'days_checked': results['days_checked'],
        'start_time': results['start_time'],
        'end_time': results['end_time'],
        'total_stations': results['total_stations'],
        'stations': results['stations']
    }
    
    return jsonify(response)

@app.route('/repair/<period>/report')
def repair_report(period='24h'):
    """Generate human-readable text report from repair"""
    from flask import Response
    
    # Get JSON data from repair endpoint
    with app.test_client() as client:
        resp = client.get(f'/repair/{period}')
        data = resp.get_json()
    
    health = data.get('health', {})
    
    # Build text report
    lines = []
    lines.append("=" * 60)
    lines.append(f"  {health.get('status', 'UNKNOWN')}")
    lines.append("=" * 60)
    lines.append("")
    lines.append(f"Period: {data.get('period_hours', '?')} hours ({data.get('days_checked', '?')} days)")
    lines.append(f"Repair Time: {data.get('repair_time', 'N/A')[:19]}")
    lines.append("")
    lines.append(f"Message: {health.get('message', 'N/A')}")
    lines.append("")
    lines.append(f"Files Adopted: {data.get('files_adopted', 0)}")
    lines.append(f"Files Rejected: {data.get('files_rejected', 0)}")
    lines.append(f"Stations Repaired: {data.get('stations_repaired', 0)}")
    lines.append("")
    
    if data.get('stations_repaired', 0) > 0:
        lines.append("Repaired Stations:")
        for station in data.get('stations', []):
            if station['status'] == 'REPAIRED':
                lines.append(f"  • {station['network']}.{station['station']}")
                lines.append(f"      Adopted: {len(station['adopted'])} files")
                if station.get('rejected'):
                    lines.append(f"      Rejected: {len(station['rejected'])} files")
                if station.get('issues'):
                    for issue in station['issues']:
                        lines.append(f"      {issue}")
        lines.append("")
    
    lines.append("=" * 60)
    lines.append("")
    
    return Response('\n'.join(lines), mimetype='text/plain')

@app.route('/repair')
@app.route('/repair/<period>')
def repair(period='24h'):
    """
    Repair metadata by adopting valid orphaned files
    Validates orphans: correct samples, proper naming, then adds to metadata
    Examples: /repair/24h, /repair/2d, /repair/1h
    """
    import json
    import boto3
    from pathlib import Path
    from datetime import timedelta
    
    # Parse period
    if period.endswith('d'):
        hours = int(period[:-1]) * 24
    elif period.endswith('h'):
        hours = int(period[:-1])
    else:
        hours = int(period)
    
    # Initialize R2 client
    R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID', '66f906f29f28b08ae9c80d4f36e25c7a')
    R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID', '9e1cf6c395172f108c2150c52878859f')
    R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY', '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec')
    R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'hearts-data-cache')
    
    s3 = boto3.client(
        's3',
        endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name='auto'
    )
    
    # Load active stations
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
                        **station
                    })
    
    now = datetime.now(timezone.utc)
    start_time = now - timedelta(hours=hours)
    dates_to_check = get_dates_in_period(start_time, now)
    
    results = {
        'repair_time': now.isoformat(),
        'period_hours': hours,
        'start_time': start_time.isoformat(),
        'days_checked': len(dates_to_check),
        'stations_repaired': 0,
        'files_adopted': 0,
        'files_rejected': 0,
        'stations': []
    }
    
    # Process each station
    for station_config in active_stations:
        network = station_config['network']
        volcano = station_config['volcano']
        station = station_config['station']
        location = station_config['location']
        channel = station_config['channel']
        sample_rate = station_config['sample_rate']
        location_str = location if location and location != '--' else '--'
        rate_str = f"{sample_rate:.2f}".rstrip('0').rstrip('.') if '.' in str(sample_rate) else str(int(sample_rate))
        
        station_result = {
            'network': network,
            'station': station,
            'adopted': [],
            'rejected': [],
            'issues': []
        }
        
        try:
            # Process each date in the period
            for check_date in dates_to_check:
                year = check_date.year
                month = f"{check_date.month:02d}"
                date_str = check_date.strftime("%Y-%m-%d")
                
                # Build paths for THIS date's folder
                prefix = f"data/{year}/{month}/{network}/{volcano}/{station}/{location_str}/{channel}/"
                metadata_key = f"{prefix}{network}_{station}_{location_str}_{channel}_{rate_str}Hz_{date_str}.json"
                
                # Load or create metadata for this date
                metadata = None
                try:
                    response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_key)
                    metadata = json.loads(response['Body'].read().decode('utf-8'))
                except s3.exceptions.NoSuchKey:
                    # Create new metadata structure
                    metadata = {
                        'date': date_str,
                        'network': network,
                        'volcano': volcano,
                        'station': station,
                        'location': location if location != '--' else '',
                        'channel': channel,
                        'sample_rate': sample_rate,
                        'created_at': now.isoformat().replace('+00:00', 'Z'),
                        'complete_day': False,
                        'chunks': {
                            '10m': [],
                            '1h': [],
                            '6h': []
                        }
                    }
                    station_result['issues'].append(f'Created new metadata for {date_str}')
                
                # Build set of existing files in metadata
                existing_entries = set()
                for chunk_type in ['10m', '1h', '6h']:
                    for chunk in metadata['chunks'].get(chunk_type, []):
                        start_time_str = chunk['start'].replace(':', '-')
                        end_time_str = chunk['end'].replace(':', '-')
                        filename = f"{network}_{station}_{location_str}_{channel}_{rate_str}Hz_{chunk_type}_{date_str}-{start_time_str}_to_{date_str}-{end_time_str}.bin.zst"
                        existing_entries.add(filename)
                
                # List files in this date's folder (now in subfolders by chunk type)
                orphans = []
                for chunk_type in ['10m', '1h', '6h']:
                    chunk_prefix = f"{prefix}{chunk_type}/"
                    response = s3.list_objects_v2(Bucket=R2_BUCKET_NAME, Prefix=chunk_prefix)
                    
                    if 'Contents' in response:
                        for obj in response['Contents']:
                            filename = obj['Key'].split('/')[-1]
                            if filename.endswith('.bin.zst') and filename not in existing_entries:
                                orphans.append({'filename': filename, 'size': obj['Size'], 'chunk_type': chunk_type})
                
                # Validate and adopt orphans (may belong to any date in the period)
                for orphan in orphans:
                    filename = orphan['filename']
                    
                    # Parse filename
                    try:
                        parts = filename.replace('.bin.zst', '').split('_')
                        
                        # Find chunk type
                        chunk_type = None
                        time_idx = None
                        for i, part in enumerate(parts):
                            if part in ['10m', '1h', '6h']:
                                chunk_type = part
                                time_idx = i + 1
                                break
                        
                        if not chunk_type or not time_idx:
                            station_result['rejected'].append(f"{filename} (invalid format)")
                            results['files_rejected'] += 1
                            continue
                        
                        # Extract timestamps
                        time_part = '_'.join(parts[time_idx:])
                        times = time_part.split('_to_')
                        if len(times) != 2:
                            station_result['rejected'].append(f"{filename} (invalid time format)")
                            results['files_rejected'] += 1
                            continue
                        
                        # Extract date from filename (first timestamp contains YYYY-MM-DD-HH-MM-SS)
                        # Format: YYYY-MM-DD-HH-MM-SS_to_YYYY-MM-DD-HH-MM-SS
                        start_full = times[0].split('-')
                        end_full = times[1].split('-')
                        
                        if len(start_full) < 6 or len(end_full) < 6:
                            station_result['rejected'].append(f"{filename} (invalid timestamp format)")
                            results['files_rejected'] += 1
                            continue
                        
                        # Extract date from filename (first 3 parts: YYYY-MM-DD)
                        file_date_str = '-'.join(start_full[:3])
                        
                        # Extract time parts (last 3 parts: HH-MM-SS)
                        start_parts = start_full[3:6]
                        end_parts = end_full[3:6]
                        
                        if len(start_parts) != 3 or len(end_parts) != 3:
                            station_result['rejected'].append(f"{filename} (invalid timestamp)")
                            results['files_rejected'] += 1
                            continue
                        
                        # Skip files outside our date range (they'll be processed in their own date iteration)
                        if file_date_str not in [d.strftime("%Y-%m-%d") for d in dates_to_check]:
                            continue
                        
                        # Use existing metadata if file belongs to date being checked, otherwise load/create for file's date
                        if file_date_str == date_str:
                            # File belongs to date we're checking - use existing metadata variable
                            file_metadata = metadata
                            file_metadata_key = metadata_key
                        else:
                            # File belongs to different date - load/create metadata for that date
                            file_year = int(file_date_str.split('-')[0])
                            file_month = f"{int(file_date_str.split('-')[1]):02d}"
                            file_prefix = f"data/{file_year}/{file_month}/{network}/{volcano}/{station}/{location_str}/{channel}/"
                            file_metadata_key = f"{file_prefix}{network}_{station}_{location_str}_{channel}_{rate_str}Hz_{file_date_str}.json"
                            
                            try:
                                response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=file_metadata_key)
                                file_metadata = json.loads(response['Body'].read().decode('utf-8'))
                            except s3.exceptions.NoSuchKey:
                                # Create new metadata for this file's date
                                file_metadata = {
                                    'date': file_date_str,
                                    'network': network,
                                    'volcano': volcano,
                                    'station': station,
                                    'location': location if location != '--' else '',
                                    'channel': channel,
                                    'sample_rate': sample_rate,
                                    'created_at': now.isoformat().replace('+00:00', 'Z'),
                                    'complete_day': False,
                                    'chunks': {
                                        '10m': [],
                                        '1h': [],
                                        '6h': []
                                    }
                                }
                                station_result['issues'].append(f'Created new metadata for {file_date_str} (while checking {date_str})')
                        
                        # Check if file already in metadata for its date
                        file_existing_entries = set()
                        for ct in ['10m', '1h', '6h']:
                            for chunk in file_metadata['chunks'].get(ct, []):
                                start_time_str = chunk['start'].replace(':', '-')
                                end_time_str = chunk['end'].replace(':', '-')
                                expected_filename = f"{network}_{station}_{location_str}_{channel}_{rate_str}Hz_{ct}_{file_date_str}-{start_time_str}_to_{file_date_str}-{end_time_str}.bin.zst"
                                file_existing_entries.add(expected_filename)
                        
                        if filename in file_existing_entries:
                            # Already in metadata, skip
                            continue
                        
                        start_time_hms = f"{start_parts[0]}:{start_parts[1]}:{start_parts[2]}"
                        end_time_hms = f"{end_parts[0]}:{end_parts[1]}:{end_parts[2]}"
                        
                        # Validate sample count based on chunk type and sample rate
                        expected_samples = {
                            '10m': 10 * 60 * sample_rate,
                            '1h': 60 * 60 * sample_rate,
                            '6h': 6 * 60 * 60 * sample_rate
                        }
                        
                        expected_size = expected_samples[chunk_type] * 4  # int32 = 4 bytes
                        # Allow 30-60% size due to compression (typical zstd ratio)
                        min_size = expected_size * 0.25
                        max_size = expected_size * 0.65
                        
                        if not (min_size <= orphan['size'] <= max_size):
                            station_result['rejected'].append(f"{filename} (unexpected size: {orphan['size']} bytes, expected ~{int(expected_size * 0.5)} bytes)")
                            results['files_rejected'] += 1
                            continue
                        
                        # Looks valid - adopt it to its own date's metadata!
                        chunk_meta = {
                            'start': start_time_hms,
                            'end': end_time_hms,
                            'min': 0,  # Unknown (file not decompressed)
                            'max': 0,  # Unknown
                            'samples': int(expected_samples[chunk_type]),
                            'gap_count': 0,  # Unknown
                            'gap_samples_filled': 0  # Unknown
                        }
                        
                        file_metadata['chunks'][chunk_type].append(chunk_meta)
                        
                        # Sort chunks chronologically
                        file_metadata['chunks']['10m'].sort(key=lambda c: c['start'])
                        file_metadata['chunks']['1h'].sort(key=lambda c: c['start'])
                        file_metadata['chunks']['6h'].sort(key=lambda c: c['start'])
                        
                        # Update complete_day flag
                        if len(file_metadata['chunks']['10m']) >= 144:
                            file_metadata['complete_day'] = True
                        
                        # Upload metadata for this file's date
                        s3.put_object(
                            Bucket=R2_BUCKET_NAME,
                            Key=file_metadata_key,
                            Body=json.dumps(file_metadata, indent=2).encode('utf-8'),
                            ContentType='application/json'
                        )
                        
                        station_result['adopted'].append(filename)
                        results['files_adopted'] += 1
                        
                        # Track if we modified metadata for the date being checked
                        if file_date_str == date_str:
                            date_adopted = True
                        
                    except Exception as e:
                        station_result['rejected'].append(f"{filename} (parse error: {str(e)})")
                        results['files_rejected'] += 1
                        continue
            
            # Set station status
            if len(station_result['adopted']) > 0:
                results['stations_repaired'] += 1
                station_result['status'] = 'REPAIRED'
            else:
                station_result['status'] = 'NO_ORPHANS'
        
        except Exception as e:
            station_result['issues'].append(f"Repair error: {str(e)}")
            station_result['status'] = 'ERROR'
        
        results['stations'].append(station_result)
    
    # Summary
    response = {
        'health': {
            'status': '✅ REPAIR COMPLETE' if results['files_adopted'] > 0 else 'ℹ️ NO REPAIRS NEEDED',
            'repaired': results['stations_repaired'] > 0,
            'message': f"Adopted {results['files_adopted']} files, rejected {results['files_rejected']} files across {results['stations_repaired']} stations"
        },
        'repair_time': results['repair_time'],
        'period_hours': results['period_hours'],
        'days_checked': results['days_checked'],
        'start_time': results['start_time'],
        'stations_repaired': results['stations_repaired'],
        'files_adopted': results['files_adopted'],
        'files_rejected': results['files_rejected'],
        'stations': results['stations']
    }
    
    return jsonify(response)

@app.route('/nuke')
def nuke():
    """
    🔥 DANGER: Delete ALL data from R2 storage
    Deletes everything under data/ prefix
    Use for development/testing only!
    """
    import boto3
    
    # Initialize R2 client
    R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID', '66f906f29f28b08ae9c80d4f36e25c7a')
    R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID', '9e1cf6c395172f108c2150c52878859f')
    R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY', '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec')
    R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'hearts-data-cache')
    
    s3 = boto3.client(
        's3',
        endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name='auto'
    )
    
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] 🔥 NUKE INITIATED - Deleting all data from R2...")
    
    deleted_count = 0
    deleted_files = []
    
    try:
        # List all objects with data/ prefix
        paginator = s3.get_paginator('list_objects_v2')
        pages = paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix='data/')
        
        for page in pages:
            if 'Contents' not in page:
                continue
            
            # Delete in batches of 1000 (R2 limit)
            objects_to_delete = [{'Key': obj['Key']} for obj in page['Contents']]
            
            if objects_to_delete:
                response = s3.delete_objects(
                    Bucket=R2_BUCKET_NAME,
                    Delete={'Objects': objects_to_delete}
                )
                
                deleted = response.get('Deleted', [])
                deleted_count += len(deleted)
                deleted_files.extend([obj['Key'] for obj in deleted])
                
                print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] 🗑️  Deleted {len(deleted)} objects (total: {deleted_count})")
        
        print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] ✅ NUKE COMPLETE - Deleted {deleted_count} objects")
        
        return jsonify({
            'status': 'nuked',
            'deleted_count': deleted_count,
            'message': f'Successfully deleted {deleted_count} objects from R2',
            'deleted_files': deleted_files[:100] if len(deleted_files) > 100 else deleted_files,
            'truncated': len(deleted_files) > 100
        })
        
    except Exception as e:
        print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] ❌ NUKE FAILED: {e}")
        return jsonify({
            'status': 'error',
            'message': str(e),
            'deleted_count': deleted_count
        }), 500

def wait_until_next_run():
    """Wait until the next scheduled run time (:02, :12, :22, etc.)"""
    now = datetime.now(timezone.utc)
    current_minute = now.minute
    
    # Find next run minute (2, 12, 22, 32, 42, 52)
    run_minutes = [2, 12, 22, 32, 42, 52]
    next_minute = None
    
    for minute in run_minutes:
        if minute > current_minute:
            next_minute = minute
            break
    
    if next_minute is None:
        # Next run is in the next hour
        next_minute = run_minutes[0]
        next_hour = now.hour + 1
        if next_hour >= 24:
            next_hour = 0
        
        # Calculate seconds until next run
        seconds_until_next_hour = 3600 - (now.minute * 60 + now.second)
        seconds_until_next_run = seconds_until_next_hour + (next_minute * 60)
        
        # Update next run time
        from datetime import timedelta
        status['next_run'] = (now + timedelta(seconds=seconds_until_next_run)).isoformat()
    else:
        # Next run is in the current hour
        minutes_until = next_minute - current_minute
        seconds_until_next_run = minutes_until * 60 - now.second
        
        # Update next run time
        from datetime import timedelta
        status['next_run'] = (now + timedelta(seconds=seconds_until_next_run)).isoformat()
    
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] Next run in {seconds_until_next_run} seconds")
    time.sleep(seconds_until_next_run)


def run_cron_job():
    """Execute the cron job"""
    status['currently_running'] = True
    status['total_runs'] += 1
    
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] ========== Starting cron job ==========")
    
    try:
        # Get the directory where this script is located
        script_dir = os.path.dirname(os.path.abspath(__file__))
        cron_job_path = os.path.join(script_dir, 'cron_job.py')
        
        result = subprocess.run(
            [sys.executable, cron_job_path],
            capture_output=False,
            text=True
        )
        
        if result.returncode == 0:
            print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] ✅ Cron job completed successfully")
            status['successful_runs'] += 1
        else:
            print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] ❌ Cron job failed with exit code {result.returncode}")
            status['failed_runs'] += 1
    
    except Exception as e:
        print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] ❌ Error running cron job: {e}")
        status['failed_runs'] += 1
    
    finally:
        status['currently_running'] = False
        status['last_run'] = datetime.now(timezone.utc).isoformat()


def run_scheduler():
    """Run the scheduler loop"""
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] Schedule: Every 10 minutes at :02, :12, :22, :32, :42, :52")
    
    while True:
        wait_until_next_run()
        run_cron_job()

def main():
    """Main entry point - starts Flask server and scheduler"""
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] 🚀 Cron loop started - {__version__}")
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] Deployed: {deploy_time}")
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] v1.07 Fix: Coverage depth requires ALL types, JSON order preservation, startup scripts, machine-readable docs")
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] Git commit: v1.07 Fix: Coverage depth requires ALL types, JSON order preservation, startup scripts, machine-readable docs")
    
    # Start Flask server in background thread
    port = int(os.getenv('PORT', 5000))
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] Starting health API on port {port}")
    flask_thread = threading.Thread(target=lambda: app.run(host='0.0.0.0', port=port, debug=False, use_reloader=False))
    flask_thread.daemon = True
    flask_thread.start()
    
    # Run scheduler in main thread
    run_scheduler()


if __name__ == "__main__":
    main()

