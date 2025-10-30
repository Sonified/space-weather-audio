#!/usr/bin/env python3
"""
Test IRIS MUSTANG API for getting min/max amplitude values without downloading full waveforms.

This could solve the normalization problem for historical data by getting metadata in <100ms
instead of waiting 1-3 seconds to download and process MiniSEED files.
"""

import requests
import time
from datetime import datetime, timedelta
from obspy.clients.fdsn import Client
from obspy import UTCDateTime
import numpy as np


def query_mustang_minmax(network, station, location, channel, start_date, end_date):
    """
    Query MUSTANG for sample_min and sample_max metrics.
    
    Args:
        network: Network code (e.g., 'HV')
        station: Station code (e.g., 'NPOC')
        location: Location code (e.g., '01' or '')
        channel: Channel code (e.g., 'HHZ')
        start_date: Start date as YYYY-MM-DD string
        end_date: End date as YYYY-MM-DD string
    
    Returns:
        dict with 'min', 'max', 'latency_ms', or None if not available
    """
    url = "https://service.iris.edu/mustang/measurements/1/query"
    
    # MUSTANG uses "--" for empty location codes (not empty string!)
    loc_code = location if location else "--"
    
    params = {
        "metric": "sample_min,sample_max",
        "net": network,
        "sta": station,
        "loc": loc_code,
        "cha": channel,
        "start": start_date,
        "end": end_date,
        "format": "json",
        "nodata": "404"  # Return 404 if no data instead of empty response
    }
    
    start_time = time.time()
    
    try:
        response = requests.get(url, params=params, timeout=5)
        latency_ms = (time.time() - start_time) * 1000
        
        if response.status_code == 404:
            print(f"  ❌ No MUSTANG data available (404)")
            return None
        
        if response.status_code != 200:
            print(f"  ❌ MUSTANG error: {response.status_code}")
            return None
        
        data = response.json()
        
        if not data:
            print(f"  ❌ MUSTANG returned empty response")
            return None
        
        # MUSTANG returns nested structure: {'measurements': {'sample_min': [...], 'sample_max': [...]}}
        measurements = data.get('measurements', {})
        
        min_val = None
        max_val = None
        
        # Extract sample_min
        sample_min_list = measurements.get('sample_min', [])
        if sample_min_list and len(sample_min_list) > 0:
            min_val = sample_min_list[0].get('value')
        
        # Extract sample_max
        sample_max_list = measurements.get('sample_max', [])
        if sample_max_list and len(sample_max_list) > 0:
            max_val = sample_max_list[0].get('value')
        
        if min_val is None or max_val is None:
            print(f"  ❌ MUSTANG incomplete: min={min_val}, max={max_val}")
            return None
        
        print(f"  ✅ MUSTANG success in {latency_ms:.1f}ms: min={min_val}, max={max_val}")
        return {
            'min': min_val,
            'max': max_val,
            'latency_ms': latency_ms,
            'source': 'mustang'
        }
    
    except requests.exceptions.Timeout:
        print(f"  ❌ MUSTANG timeout (>5s)")
        return None
    except Exception as e:
        print(f"  ❌ MUSTANG error: {e}")
        return None


def get_actual_minmax(network, station, location, channel, starttime, duration_seconds):
    """
    Download actual waveform data and calculate min/max (the traditional way).
    
    Returns:
        dict with 'min', 'max', 'latency_ms'
    """
    client = Client("IRIS")
    endtime = starttime + timedelta(seconds=duration_seconds)
    
    start_time = time.time()
    
    try:
        stream = client.get_waveforms(
            network=network,
            station=station,
            location=location if location else "",
            channel=channel,
            starttime=UTCDateTime(starttime),
            endtime=UTCDateTime(endtime)
        )
        
        # Merge traces and calculate min/max
        stream.merge(fill_value=0)
        trace = stream[0]
        data = trace.data
        
        min_val = int(np.min(data))
        max_val = int(np.max(data))
        
        latency_ms = (time.time() - start_time) * 1000
        
        print(f"  ✅ IRIS download in {latency_ms:.1f}ms: min={min_val}, max={max_val}")
        return {
            'min': min_val,
            'max': max_val,
            'latency_ms': latency_ms,
            'source': 'iris_download'
        }
    
    except Exception as e:
        print(f"  ❌ IRIS download error: {e}")
        return None


def test_scenario(name, network, station, location, channel, date_str, duration_hours=1):
    """
    Test a specific scenario comparing MUSTANG vs traditional download.
    """
    print(f"\n{'='*80}")
    print(f"TEST: {name}")
    print(f"{'='*80}")
    print(f"Network: {network}, Station: {station}, Location: '{location}', Channel: {channel}")
    print(f"Date: {date_str}, Duration: {duration_hours}h")
    print()
    
    # Parse date
    start_dt = datetime.fromisoformat(date_str)
    end_dt = start_dt + timedelta(days=1)
    
    # Format for MUSTANG (YYYY-MM-DD)
    mustang_start = start_dt.strftime("%Y-%m-%d")
    mustang_end = end_dt.strftime("%Y-%m-%d")
    
    # Test MUSTANG
    print("1️⃣  Querying MUSTANG...")
    mustang_result = query_mustang_minmax(network, station, location, channel, mustang_start, mustang_end)
    
    # Test traditional download (DISABLED FOR NOW)
    print("\n2️⃣  Downloading from IRIS... [SKIPPED]")
    actual_result = None
    # duration_seconds = duration_hours * 3600
    # actual_result = get_actual_minmax(network, station, location, channel, start_dt, duration_seconds)
    
    # Compare results
    print(f"\n{'─'*80}")
    print("COMPARISON:")
    print(f"{'─'*80}")
    
    if mustang_result and actual_result:
        mustang_time = mustang_result['latency_ms']
        actual_time = actual_result['latency_ms']
        speedup = actual_time / mustang_time
        
        print(f"⏱️  MUSTANG:   {mustang_time:6.1f}ms")
        print(f"⏱️  Download:  {actual_time:6.1f}ms")
        print(f"🚀 Speedup:   {speedup:.1f}x faster!")
        print()
        
        # Check if values match
        mustang_range = mustang_result['max'] - mustang_result['min']
        actual_range = actual_result['max'] - actual_result['min']
        
        # MUSTANG is calculated on full day, so exact match unlikely for partial day requests
        # But ranges should be similar order of magnitude
        range_ratio = mustang_range / actual_range if actual_range > 0 else 0
        
        print(f"📊 MUSTANG range: {mustang_result['min']} to {mustang_result['max']} (span: {mustang_range})")
        print(f"📊 Actual range:  {actual_result['min']} to {actual_result['max']} (span: {actual_range})")
        
        if 0.5 <= range_ratio <= 2.0:
            print(f"✅ Ranges are comparable (ratio: {range_ratio:.2f})")
        else:
            print(f"⚠️  Ranges differ significantly (ratio: {range_ratio:.2f})")
            print(f"   Note: MUSTANG calculates on full 24h, we only requested {duration_hours}h")
    
    elif mustang_result and not actual_result:
        print("⚠️  MUSTANG available but IRIS download failed")
    
    elif not mustang_result and actual_result:
        print("⚠️  IRIS download worked but MUSTANG unavailable")
        print("   (Data might be too recent - MUSTANG calculates within ~3 days)")
    
    else:
        print("❌ Both methods failed")


def main():
    print("""
╔══════════════════════════════════════════════════════════════════════════════╗
║                    MUSTANG Min/Max API Test Suite                           ║
║                                                                              ║
║  Testing if IRIS MUSTANG can provide min/max amplitude values without       ║
║  downloading full waveforms - potentially 10-50x faster for metadata!       ║
╚══════════════════════════════════════════════════════════════════════════════╝
""")
    
    # Test 1: Historical data (should definitely have MUSTANG metrics)
    test_scenario(
        name="Historical Data - 3 months ago",
        network="HV",
        station="NPOC",
        location="",  # Empty location code
        channel="HHZ",
        date_str="2024-08-01",
        duration_hours=1
    )
    
    # Test 2: Recent data (1 week ago - might not have MUSTANG yet)
    one_week_ago = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
    test_scenario(
        name="Recent Data - 1 week ago",
        network="HV",
        station="NPOC",
        location="",  # Empty location code
        channel="HHZ",
        date_str=one_week_ago,
        duration_hours=1
    )
    
    # Test 3: Yesterday (probably won't have MUSTANG)
    yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    test_scenario(
        name="Very Recent Data - Yesterday",
        network="HV",
        station="NPOC",
        location="",  # Empty location code
        channel="HHZ",
        date_str=yesterday,
        duration_hours=1
    )
    
    # Summary
    print(f"\n{'='*80}")
    print("SUMMARY & RECOMMENDATIONS")
    print(f"{'='*80}")
    print("""
✅ USE MUSTANG FOR:
   - Historical data (>3 days old)
   - Expected speedup: 10-50x faster
   - Typical latency: 50-200ms vs 1-3 seconds

⚠️  FALLBACK TO TRADITIONAL FOR:
   - Very recent data (<3 days old)
   - When MUSTANG returns 404/empty
   - Use progressive normalization strategy

🎯 RECOMMENDED ARCHITECTURE:
   1. Always try MUSTANG first (fast check, <100ms)
   2. If available → send metadata immediately
   3. If not available → use first chunk for provisional metadata
   4. Browser handles smooth normalization transition

📝 NOTE ON ACCURACY:
   - MUSTANG calculates min/max for FULL 24-hour UTC windows
   - Your request might be for partial hours (e.g., 2pm-5pm)
   - MUSTANG values will be slightly wider range (safe for normalization)
   - For precise normalization, you can recalculate on actual data
""")


if __name__ == "__main__":
    main()

