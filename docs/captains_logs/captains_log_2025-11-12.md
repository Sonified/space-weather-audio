# Captain's Log - 2025-11-12

## v1.76 Fix: Midnight-Crossing Chunk Filename Generation

### Problem
Chunks that cross midnight (e.g., 23:00-00:00) were being saved with incorrect filenames:
- **Wrong**: `HV_OBL_--_HHZ_1h_2025-11-11-23-00-00_to_2025-11-11-23-59-59.bin.zst`
- **Correct**: `HV_OBL_--_HHZ_1h_2025-11-11-23-00-00_to_2025-11-12-00-00-00.bin.zst`

The backend was using `trace.stats.endtime` (which IRIS might return as 23:59:59.999) instead of the requested `end_time` parameter (which is correctly 00:00:00 the next day).

### Root Cause
In `backend/collector_loop.py`, the filename generation used:
```python
end_str = trace.stats.endtime.datetime.strftime("%Y-%m-%d-%H-%M-%S")
```

But `trace.stats.endtime` can be slightly off due to how IRIS returns data, especially for chunks ending exactly at midnight.

### Solution
Changed to use the requested `end_time` parameter instead:
```python
end_str = end_time.strftime("%Y-%m-%d-%H-%M-%S")
```

This ensures filenames match the actual requested time window, correctly handling midnight crossings.

### Frontend Fixes
1. **Midnight-crossing detection**: Frontend now checks both start date and end date folders when a chunk crosses midnight
2. **Correct end time calculation**: Uses calculated `endDateTime` instead of metadata `chunk.end` for filename generation
3. **Path checking**: Tries both `/2025/11/11/` and `/2025/11/12/` paths for midnight-crossing chunks

### Files Changed
- `backend/collector_loop.py`: Fixed filename generation to use `end_time` instead of `trace.stats.endtime`
- `js/data-fetcher.js`: Fixed end time calculation and added dual-path checking for midnight chunks
- `js/waveform-renderer.js`: Commented out debug logging statements

### Scripts Created
- `backend/scripts/fix_midnight_chunk_filename.py`: One-off script to rename the incorrectly named file
- `backend/scripts/fix_all_midnight_chunks.py`: Comprehensive scanner to find and fix all incorrectly named midnight-crossing chunks across all active volcanoes
- `backend/scripts/verify_file_exists.py`: Verification script to check file existence on R2

### Commit
**v1.76 Fix: Fixed midnight-crossing chunk filename generation and frontend path checking**

This ensures all future chunks crossing midnight will be named correctly, and the frontend can find them in either the start date or end date folder.

