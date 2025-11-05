#!/usr/bin/env python3
"""
Railway Cron Job: Fetch latest 10-minute data segments for the 3 closest stations per volcano.
Runs every 10 minutes to maintain fresh datasets.

This script:
1. Fetches 10 minutes of data from IRIS for each station
2. Processes and stores the data (to R2 or local cache)
3. Logs timing and success/failure metrics
"""

import sys
import os
from datetime import datetime, timedelta, timezone
from obspy import UTCDateTime
from obspy.clients.fdsn import Client
import time
import logging

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S UTC'
)
logger = logging.getLogger(__name__)

# Station data - 3 closest stations per volcano
CRON_STATIONS = {
    "kilauea": [
        {"network": "HV", "station": "UWE", "location": "", "channel": "HHZ", "distance_km": 0.4},
        {"network": "HV", "station": "OBL", "location": "", "channel": "HHZ", "distance_km": 0.5},
        {"network": "HV", "station": "UWB", "location": "", "channel": "HHZ", "distance_km": 1.1},
    ],
    "maunaloa": [
        {"network": "HV", "station": "MOKD", "location": "", "channel": "HHZ", "distance_km": 1.6},
        {"network": "HV", "station": "SWRD", "location": "", "channel": "EHZ", "distance_km": 2.6},
        {"network": "HV", "station": "WILD", "location": "", "channel": "EHZ", "distance_km": 3.0},
    ],
    "greatsitkin": [
        {"network": "AV", "station": "GSTD", "location": "", "channel": "BHZ", "distance_km": 3.3},
        {"network": "AV", "station": "GSTR", "location": "", "channel": "BHZ", "distance_km": 4.1},
        {"network": "AV", "station": "GSSP", "location": "", "channel": "BHZ", "distance_km": 4.9},
    ],
    "shishaldin": [
        {"network": "AV", "station": "SSLS", "location": "", "channel": "BHZ", "distance_km": 5.4},
        {"network": "AV", "station": "SSLN", "location": "", "channel": "BHZ", "distance_km": 6.5},
        {"network": "AV", "station": "SSBA", "location": "", "channel": "BHZ", "distance_km": 10.1},
    ],
    "spurr": [
        {"network": "AV", "station": "SPCP", "location": "", "channel": "BHZ", "distance_km": 6.4},
        {"network": "AV", "station": "SPBG", "location": "", "channel": "BHZ", "distance_km": 7.7},
        {"network": "AV", "station": "SPCN", "location": "", "channel": "BHZ", "distance_km": 9.2},
    ],
}

# Configuration from environment or defaults
DATA_DURATION_MINUTES = int(os.getenv('CRON_DATA_DURATION_MINUTES', '10'))
IRIS_DELAY_MINUTES = int(os.getenv('IRIS_DELAY_MINUTES', '5'))  # Delay from current time
STORE_TO_R2 = os.getenv('STORE_TO_R2', 'true').lower() == 'true'
REQUEST_DELAY_SECONDS = float(os.getenv('REQUEST_DELAY_SECONDS', '1.0'))


def fetch_and_store_station_data(volcano, station_info, end_time_utc, duration_minutes):
    """
    Fetch data from IRIS and store it (to R2 or log for now).
    
    Returns:
        dict with success status and metadata
    """
    network = station_info["network"]
    station = station_info["station"]
    location = station_info["location"] or ""
    channel = station_info["channel"]
    distance = station_info["distance_km"]
    
    duration_seconds = duration_minutes * 60
    start_time = end_time_utc - timedelta(seconds=duration_seconds)
    
    start_str = start_time.strftime("%Y-%m-%dT%H:%M:%S")
    end_str = end_time_utc.strftime("%Y-%m-%dT%H:%M:%S")
    
    logger.info(f"📡 Fetching {volcano} - {network}.{station}.{location}.{channel}")
    logger.info(f"   Time window: {start_str} to {end_str} ({duration_minutes} minutes)")
    
    try:
        client = Client("IRIS")
        
        starttime = UTCDateTime(start_str)
        endtime = UTCDateTime(end_str)
        
        request_start = time.time()
        st = client.get_waveforms(
            network=network,
            station=station,
            location=location if location else "",
            channel=channel,
            starttime=starttime,
            endtime=endtime
        )
        request_time = time.time() - request_start
        
        if not st or len(st) == 0:
            logger.warning(f"   ❌ No data returned")
            return {
                "success": False,
                "error": "No data returned",
                "request_time": request_time
            }
        
        # Merge traces
        st.merge(method=1, fill_value='interpolate')
        trace = st[0]
        
        # Get metadata
        sample_count = len(trace.data)
        sample_rate = trace.stats.sampling_rate
        latest_timestamp = trace.stats.endtime.datetime.replace(tzinfo=timezone.utc)
        
        # Calculate latency
        latency_seconds = (end_time_utc - latest_timestamp).total_seconds()
        
        logger.info(f"   ✅ Got {sample_count:,} samples @ {sample_rate} Hz")
        logger.info(f"   ⏱️  Latest data: {latest_timestamp.strftime('%Y-%m-%d %H:%M:%S UTC')}")
        logger.info(f"   📊 Latency: {latency_seconds:.0f} seconds")
        logger.info(f"   ⚡ Request time: {request_time:.2f}s")
        
        # TODO: Store to R2 cache here
        # For now, just log success
        if STORE_TO_R2:
            logger.info(f"   💾 Would store to R2 (not implemented yet)")
        
        return {
            "success": True,
            "volcano": volcano,
            "network": network,
            "station": station,
            "location": location,
            "channel": channel,
            "sample_count": sample_count,
            "sample_rate": sample_rate,
            "latest_timestamp": latest_timestamp.isoformat(),
            "latency_seconds": latency_seconds,
            "request_time": request_time,
        }
        
    except Exception as e:
        logger.error(f"   ❌ Error: {str(e)}")
        return {
            "success": False,
            "error": str(e),
            "request_time": 0
        }


def main():
    """Main cron job function"""
    logger.info("=" * 80)
    logger.info("CRON JOB: Fetch Latest Data")
    logger.info("=" * 80)
    
    # Calculate end time (current time minus delay)
    now_utc = datetime.now(timezone.utc)
    end_time_utc = now_utc - timedelta(minutes=IRIS_DELAY_MINUTES)
    
    logger.info(f"Current time: {now_utc.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    logger.info(f"Requesting data ending at: {end_time_utc.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    logger.info(f"Duration: {DATA_DURATION_MINUTES} minutes")
    logger.info(f"IRIS delay: {IRIS_DELAY_MINUTES} minutes")
    logger.info("")
    
    all_results = []
    total_stations = sum(len(stations) for stations in CRON_STATIONS.values())
    current_station = 0
    
    job_start_time = time.time()
    
    # Process each volcano sequentially
    for volcano, stations in CRON_STATIONS.items():
        logger.info(f"🌋 Processing {volcano.upper()} ({len(stations)} stations)")
        logger.info("-" * 80)
        
        for station_info in stations:
            current_station += 1
            logger.info(f"\n[{current_station}/{total_stations}] {volcano} - {station_info['station']}")
            
            result = fetch_and_store_station_data(
                volcano,
                station_info,
                end_time_utc,
                DATA_DURATION_MINUTES
            )
            
            all_results.append(result)
            
            # Delay between requests to avoid IRIS rate limiting
            if current_station < total_stations:
                time.sleep(REQUEST_DELAY_SECONDS)
    
    job_time = time.time() - job_start_time
    
    # Summary
    logger.info("\n" + "=" * 80)
    logger.info("CRON JOB SUMMARY")
    logger.info("=" * 80)
    
    successful = sum(1 for r in all_results if r.get("success", False))
    failed = len(all_results) - successful
    
    logger.info(f"Total stations: {total_stations}")
    logger.info(f"Successful: {successful}")
    logger.info(f"Failed: {failed}")
    logger.info(f"Total job time: {job_time:.2f} seconds")
    
    if successful > 0:
        successful_results = [r for r in all_results if r.get("success", False)]
        avg_latency = sum(r["latency_seconds"] for r in successful_results) / len(successful_results)
        avg_request_time = sum(r["request_time"] for r in successful_results) / len(successful_results)
        
        logger.info(f"Average latency: {avg_latency:.0f} seconds")
        logger.info(f"Average request time: {avg_request_time:.2f} seconds")
    
    # Exit with error code if any failures
    if failed > 0:
        logger.warning(f"⚠️  {failed} requests failed")
        sys.exit(1)
    else:
        logger.info("✅ All requests successful")
        sys.exit(0)


if __name__ == "__main__":
    main()

