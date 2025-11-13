#!/usr/bin/env python3
"""
Quick utility to download metadata files from CDN.
Matches the URL pattern used in data-fetcher.js
"""

import requests
import json
from datetime import datetime, timedelta
from pathlib import Path

CDN_BASE_URL = 'https://cdn.now.audio/data'

# Volcano name mapping (same as in data-fetcher.js)
VOLCANO_MAP = {
    'kilauea': 'kilauea',
    'maunaloa': 'maunaloa',
    'greatsitkin': 'greatsitkin',
    'shishaldin': 'shishaldin',
    'spurr': 'spurr'
}

def build_metadata_url(network, station, location, channel, volcano, date, sample_rate=None):
    """
    Build metadata URL - tries NEW format first (no sample rate), then OLD format.
    
    Args:
        network: Network code (e.g., 'HV')
        station: Station code (e.g., 'OBL')
        location: Location code (e.g., '--' or '')
        channel: Channel code (e.g., 'BHZ')
        volcano: Volcano name (e.g., 'kilauea')
        date: Date string in YYYY-MM-DD format
        sample_rate: Optional sample rate for OLD format (defaults to 100)
    
    Returns:
        tuple: (new_format_url, old_format_url)
    """
    location = location or '--'
    [year, month, day] = date.split('-')
    date_path = f"{year}/{month}/{day}"
    
    # NEW format (without sample rate)
    filename_new = f"{network}_{station}_{location}_{channel}_{date}.json"
    new_url = f"{CDN_BASE_URL}/{date_path}/{network}/{volcano}/{station}/{location}/{channel}/{filename_new}"
    
    # OLD format (with sample rate)
    sample_rate = sample_rate or 100
    filename_old = f"{network}_{station}_{location}_{channel}_{int(sample_rate)}Hz_{date}.json"
    old_url = f"{CDN_BASE_URL}/{date_path}/{network}/{volcano}/{station}/{location}/{channel}/{filename_old}"
    
    return new_url, old_url

def download_metadata(network, station, location, channel, volcano, date, sample_rate=None, save_to_file=None):
    """
    Download metadata file, trying NEW format first, then OLD format.
    
    Returns:
        dict: Metadata JSON or None if not found
    """
    new_url, old_url = build_metadata_url(network, station, location, channel, volcano, date, sample_rate)
    
    print(f"📋 Trying NEW format: {new_url}")
    response = requests.get(new_url)
    
    if response.ok:
        print(f"✅ Found NEW format metadata")
        metadata = response.json()
        if save_to_file:
            with open(save_to_file, 'w') as f:
                json.dump(metadata, f, indent=2)
            print(f"💾 Saved to: {save_to_file}")
        return metadata
    
    print(f"⚠️  NEW format not found (status {response.status_code}), trying OLD format...")
    print(f"📋 Trying OLD format: {old_url}")
    response = requests.get(old_url)
    
    if response.ok:
        print(f"✅ Found OLD format metadata")
        metadata = response.json()
        if save_to_file:
            with open(save_to_file, 'w') as f:
                json.dump(metadata, f, indent=2)
            print(f"💾 Saved to: {save_to_file}")
        return metadata
    
    print(f"❌ Metadata not found in NEW or OLD format (status {response.status_code})")
    return None

def download_multiple_dates(network, station, location, channel, volcano, start_date, end_date=None, sample_rate=None, output_dir=None):
    """
    Download metadata for multiple dates.
    
    Args:
        start_date: Start date (YYYY-MM-DD) or datetime
        end_date: End date (YYYY-MM-DD) or datetime, or None for single date
        output_dir: Optional directory to save files
    """
    # Parse dates
    if isinstance(start_date, str):
        start_date = datetime.strptime(start_date, '%Y-%m-%d')
    if end_date is None:
        end_date = start_date
    elif isinstance(end_date, str):
        end_date = datetime.strptime(end_date, '%Y-%m-%d')
    
    # Create output directory if specified
    if output_dir:
        Path(output_dir).mkdir(parents=True, exist_ok=True)
    
    current_date = start_date
    results = []
    
    while current_date <= end_date:
        date_str = current_date.strftime('%Y-%m-%d')
        print(f"\n{'='*70}")
        print(f"📅 Downloading metadata for {date_str}")
        print(f"{'='*70}")
        
        filename = f"{network}_{station}_{location or '--'}_{channel}_{date_str}.json" if output_dir else None
        save_path = str(Path(output_dir) / filename) if filename else None
        
        metadata = download_metadata(
            network, station, location, channel, volcano, date_str, 
            sample_rate=sample_rate, save_to_file=save_path
        )
        
        if metadata:
            results.append({'date': date_str, 'metadata': metadata, 'success': True})
            print(f"✅ Successfully downloaded {date_str}")
            # Print summary
            if 'chunks' in metadata:
                chunk_summary = {k: len(v) for k, v in metadata['chunks'].items()}
                print(f"   Chunks: {chunk_summary}")
        else:
            results.append({'date': date_str, 'metadata': None, 'success': False})
            print(f"❌ Failed to download {date_str}")
        
        current_date += timedelta(days=1)
    
    print(f"\n{'='*70}")
    print(f"📊 Summary: {sum(1 for r in results if r['success'])}/{len(results)} successful")
    print(f"{'='*70}")
    
    return results

if __name__ == '__main__':
    import argparse
    
    parser = argparse.ArgumentParser(description='Download metadata files from CDN')
    parser.add_argument('--network', required=True, help='Network code (e.g., HV)')
    parser.add_argument('--station', required=True, help='Station code (e.g., OBL)')
    parser.add_argument('--location', default='--', help='Location code (default: --)')
    parser.add_argument('--channel', required=True, help='Channel code (e.g., BHZ)')
    parser.add_argument('--volcano', required=True, choices=list(VOLCANO_MAP.keys()), help='Volcano name')
    parser.add_argument('--date', help='Single date (YYYY-MM-DD)')
    parser.add_argument('--start-date', help='Start date for range (YYYY-MM-DD)')
    parser.add_argument('--end-date', help='End date for range (YYYY-MM-DD)')
    parser.add_argument('--sample-rate', type=float, help='Sample rate for OLD format fallback')
    parser.add_argument('--output-dir', help='Directory to save metadata files')
    
    args = parser.parse_args()
    
    volcano_name = VOLCANO_MAP[args.volcano]
    
    if args.date:
        # Single date
        metadata = download_metadata(
            args.network, args.station, args.location, args.channel,
            volcano_name, args.date, sample_rate=args.sample_rate,
            save_to_file=args.output_dir
        )
        if metadata:
            print("\n📋 Metadata preview:")
            print(json.dumps(metadata, indent=2)[:500] + "...")
    else:
        # Date range
        start = args.start_date or datetime.now().strftime('%Y-%m-%d')
        download_multiple_dates(
            args.network, args.station, args.location, args.channel,
            volcano_name, start, end_date=args.end_date,
            sample_rate=args.sample_rate, output_dir=args.output_dir
        )

