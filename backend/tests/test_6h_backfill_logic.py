#!/usr/bin/env python3
"""
Test the 6h-based backfill logic without actually fetching/creating data.
Shows what requests would be made and what files would be created.
"""

import requests
from datetime import datetime, timedelta, timezone

RUN_HISTORY_URL = 'https://cdn.now.audio/collector_logs/run_history.json'

def get_most_recent_collector_run():
    """Get the most recent collector run from CDN"""
    try:
        response = requests.get(RUN_HISTORY_URL, timeout=10)
        response.raise_for_status()
        runs = response.json()
        
        for run in runs:
            files_created = run.get('files_created', {})
            total_files = files_created.get('10m', 0) + files_created.get('1h', 0) + files_created.get('6h', 0)
            
            if total_files > 0:
                start_time_str = run.get('start_time')
                if start_time_str:
                    run_time = datetime.fromisoformat(start_time_str.replace('+00:00', '+00:00'))
                else:
                    end_time_str = run.get('end_time') or run.get('timestamp')
                    run_time = datetime.fromisoformat(end_time_str.replace('+00:00', '+00:00'))
                
                chunk_time = run_time.replace(second=0, microsecond=0)
                chunk_time = chunk_time.replace(minute=(chunk_time.minute // 10) * 10)
                return chunk_time
        
        return datetime.now(timezone.utc) - timedelta(hours=2)
    except Exception as e:
        print(f"Error fetching run history: {e}")
        return datetime.now(timezone.utc) - timedelta(hours=2)

def round_down_to_6h_boundary(dt):
    """Round down to nearest 6h boundary (00:00, 06:00, 12:00, 18:00)"""
    hour = (dt.hour // 6) * 6
    return dt.replace(hour=hour, minute=0, second=0, microsecond=0)

def generate_1h_subchunks(start, end):
    """Generate list of COMPLETE 1h sub-chunks for a time range (excludes partial hours)"""
    chunks = []
    current = start
    while current < end:
        chunk_end = current + timedelta(hours=1)
        if chunk_end <= end:  # Only add if it's a complete hour
            chunks.append((current, chunk_end))
        current = chunk_end
    return chunks

def generate_10m_subchunks(start, end):
    """Generate list of 10m sub-chunks for a time range"""
    chunks = []
    current = start
    while current < end:
        chunk_end = min(current + timedelta(minutes=10), end)
        chunks.append((current, chunk_end))
        current = chunk_end
    return chunks

def generate_filename(network, station, location, channel, chunk_type, start, end):
    """Generate filename in the same format as the collector"""
    location_str = location if location and location != '--' else '--'
    start_str = start.strftime('%Y-%m-%d-%H-%M-%S')
    end_str = end.strftime('%Y-%m-%d-%H-%M-%S')
    return f"{network}_{station}_{location_str}_{channel}_{chunk_type}_{start_str}_to_{end_str}.bin.zst"

def main():
    print("=" * 80)
    print("🧪 6-Hour Backfill Logic Test (DRY RUN)")
    print("=" * 80)
    print()
    
    # 1. Get current time and most recent collector run
    now = datetime.now(timezone.utc)
    most_recent_run = get_most_recent_collector_run()
    
    print(f"⏰ Current time: {now.strftime('%Y-%m-%d %H:%M:%S')} UTC")
    print(f"📍 Most recent collector run processed chunk ending at: {most_recent_run.strftime('%Y-%m-%d %H:%M:%S')} UTC")
    print()
    
    # 2. Find the most recent 6h boundary
    most_recent_6h_boundary = round_down_to_6h_boundary(most_recent_run)
    print(f"🎯 Most recent 6h boundary: {most_recent_6h_boundary.strftime('%Y-%m-%d %H:%M:%S')} UTC")
    print()
    
    # 3. Calculate gap chunks (from 6h boundary to most recent run)
    gap_duration = most_recent_run - most_recent_6h_boundary
    gap_hours = gap_duration.total_seconds() / 3600
    
    print("=" * 80)
    print(f"📦 STEP 1: Fill Gap ({gap_hours:.1f} hours)")
    print(f"   From: {most_recent_6h_boundary.strftime('%Y-%m-%d %H:%M:%S')} UTC")
    print(f"   To:   {most_recent_run.strftime('%Y-%m-%d %H:%M:%S')} UTC")
    print("=" * 80)
    
    gap_1h_chunks = []
    gap_10m_chunks = []
    
    if gap_hours > 0:
        # ONE single IRIS fetch for the entire gap
        print(f"\n[Gap - Single Fetch]")
        print(f"  🌐 IRIS Fetch: {most_recent_6h_boundary.strftime('%Y-%m-%d %H:%M:%S')} → {most_recent_run.strftime('%Y-%m-%d %H:%M:%S')} ({gap_hours:.2f}h)")
        print(f"  📁 Will derive and create:")
        
        # Generate 1h sub-chunks to be derived from this single fetch
        gap_1h_chunks = generate_1h_subchunks(most_recent_6h_boundary, most_recent_run)
        print(f"     ├─ {len(gap_1h_chunks)} × 1h chunks:")
        for i, (start, end) in enumerate(gap_1h_chunks, 1):
            print(f"     │  {i}. {start.strftime('%H:%M:%S')} → {end.strftime('%H:%M:%S')}")
        
        # Generate 10m sub-chunks to be derived from this single fetch
        gap_10m_chunks = generate_10m_subchunks(most_recent_6h_boundary, most_recent_run)
        print(f"     └─ {len(gap_10m_chunks)} × 10m chunks:")
        for i in range(0, len(gap_10m_chunks), 6):
            batch = gap_10m_chunks[i:i+6]
            batch_str = ", ".join([f"{s.strftime('%H:%M')}" for s, e in batch])
            print(f"        {i+1}-{min(i+6, len(gap_10m_chunks))}: {batch_str}")
        
        # Metadata save after gap is complete
        print()
        print(f"  💾 Save metadata for date {most_recent_6h_boundary.date()} (all gap chunks)")
    else:
        print("\n✅ No gap to fill! Most recent run is exactly at a 6h boundary.")
    
    print()
    print("=" * 80)
    print("📦 STEP 2: Fill 4 Complete 6-Hour Chunks (going backwards)")
    print("=" * 80)
    
    # Station info for filename generation
    network = 'HV'
    station = 'MOKD'
    location = '--'
    channel = 'HHZ'
    
    # 4. Generate 4 complete 6h chunks going backwards
    for chunk_num in range(1, 5):
        chunk_end = most_recent_6h_boundary - timedelta(hours=6 * (chunk_num - 1))
        chunk_start = chunk_end - timedelta(hours=6)
        
        print(f"\n[6h Chunk {chunk_num}/4]")
        print(f"  🌐 IRIS Fetch: {chunk_start.strftime('%Y-%m-%d %H:%M:%S')} → {chunk_end.strftime('%Y-%m-%d %H:%M:%S')} (6.00h)")
        print(f"  📁 Will create:")
        
        # 6h chunk filename
        filename_6h = generate_filename(network, station, location, channel, '6h', chunk_start, chunk_end)
        print(f"     ├─ 6h chunk: {filename_6h}")
        
        # Check if this crosses midnight
        crosses_midnight = chunk_start.date() != chunk_end.date()
        if crosses_midnight:
            print(f"     │  ⚠️  MIDNIGHT BOUNDARY: {chunk_start.date()} → {chunk_end.date()}")
        
        # 1h sub-chunks
        subchunks_1h = generate_1h_subchunks(chunk_start, chunk_end)
        print(f"     ├─ {len(subchunks_1h)} × 1h sub-chunks:")
        for i, (s1h, e1h) in enumerate(subchunks_1h, 1):
            # Show filename for the chunk that crosses midnight
            if crosses_midnight and s1h.hour == 23:
                filename_1h = generate_filename(network, station, location, channel, '1h', s1h, e1h)
                print(f"     │  {i}. {s1h.strftime('%H:%M:%S')} → {e1h.strftime('%Y-%m-%d %H:%M:%S')} [CROSSES MIDNIGHT]")
                print(f"     │     Filename: {filename_1h}")
            else:
                print(f"     │  {i}. {s1h.strftime('%H:%M:%S')} → {e1h.strftime('%H:%M:%S')}")
        
        # 10m sub-chunks (show midnight crossing)
        subchunks_10m = generate_10m_subchunks(chunk_start, chunk_end)
        print(f"     └─ {len(subchunks_10m)} × 10m sub-chunks:")
        
        # Find the 10m chunk that crosses midnight
        midnight_10m = None
        for s10m, e10m in subchunks_10m:
            if s10m.date() != e10m.date():
                midnight_10m = (s10m, e10m)
                break
        
        if midnight_10m:
            s, e = midnight_10m
            filename_10m = generate_filename(network, station, location, channel, '10m', s, e)
            print(f"        Midnight 10m chunk: {s.strftime('%Y-%m-%d %H:%M:%S')} → {e.strftime('%Y-%m-%d %H:%M:%S')}")
            print(f"        Filename: {filename_10m}")
        
        for i in range(0, len(subchunks_10m), 6):
            batch = subchunks_10m[i:i+6]
            batch_str = ", ".join([f"{s.strftime('%H:%M')}" for s, e in batch])
            print(f"        {i+1}-{i+len(batch)}: {batch_str}")
        
        # Metadata save after this 6h chunk is complete
        # All chunks are saved under their START date, so we only save for chunk_start.date()
        # Even if we cross midnight, those chunks start on the previous day
        print()
        if crosses_midnight:
            print(f"  💾 Save metadata for date {chunk_start.date()} (this 6h chunk complete)")
            print(f"     Note: Chunks are stored by START date, even though we touch {chunk_end.date()} at midnight")
        else:
            print(f"  💾 Save metadata for date {chunk_start.date()} (this 6h chunk complete)")
    
    print()
    print("=" * 80)
    print("📊 SUMMARY")
    print("=" * 80)
    
    # Count IRIS fetches
    gap_fetch = 1 if gap_hours > 0 else 0
    complete_6h_fetches = 4
    total_iris_fetches = gap_fetch + complete_6h_fetches
    
    # Count files to create
    total_6h_files = 4
    total_1h_files = (6 * 4) + len(gap_1h_chunks)
    total_10m_files = (36 * 4) + len(gap_10m_chunks)
    
    print(f"🌐 IRIS Fetch Requests:")
    if gap_fetch > 0:
        print(f"   ├─ Gap: 1 fetch ({gap_hours:.2f}h)")
    print(f"   └─ Complete: {complete_6h_fetches} × 6h fetches")
    print(f"   TOTAL: {total_iris_fetches} IRIS requests")
    print()
    print(f"📁 Files to Create:")
    print(f"   ├─ 6h chunks: {total_6h_files}")
    print(f"   ├─ 1h chunks: {total_1h_files}")
    print(f"   └─ 10m chunks: {total_10m_files}")
    print(f"   TOTAL: {total_6h_files + total_1h_files + total_10m_files} files")
    print()
    print(f"💾 Metadata Save Strategy:")
    print(f"   • Save after gap is complete (if gap exists)")
    print(f"   • Save after each 6h chunk is complete")
    print(f"   • Batches all sub-chunks together per major chunk")
    print(f"   • Total saves: {gap_fetch + complete_6h_fetches} (one per IRIS fetch)")
    print("=" * 80)

if __name__ == '__main__':
    main()

