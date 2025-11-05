# CRITICAL BUGS - Backend Data Collection

**Date Discovered:** 2025-11-05  
**Status:** ACTIVE - System is creating duplicate entries and may have date rollover issues

---

## Bug #1: Deduplication Check Fails - Creates Duplicate Metadata Entries

**Severity:** CRITICAL  
**File:** `backend/cron_job.py`  
**Lines:** 156-164 (check) vs 257-291 (append)

### The Problem:
The deduplication check happens BEFORE uploading the binary file, but then the code loads metadata AGAIN and appends without re-checking. This causes duplicate entries in the metadata.

### Evidence:
In `HV_OBL_--_HHZ_100Hz_2025-11-05.json`:
- `05:20:00` appears 2 times
- `05:30:00` appears 2 times  
- `05:40:00` appears 2 times
- `05:50:00` appears 2 times
- `06:00:00` appears 3 times
- `06:10:00` appears 3 times
- `06:50:00` appears 4 times
- `07:00:00` appears 3 times
- Many more duplicates throughout the day

### Code Flow:
```python
# Line 156-164: Check if chunk exists (BEFORE upload)
start_time_str = start_time.strftime("%H:%M:%S")
existing_chunks = metadata['chunks'].get(chunk_type, [])
for chunk in existing_chunks:
    if chunk['start'] == start_time_str:
        return 'skipped', None  # This should prevent duplicates

# Line 257: Load metadata AGAIN (fresh from R2)
metadata = json.loads(response['Body'].read().decode('utf-8'))

# Line 291: Blindly append without checking again
metadata['chunks'][chunk_type].append(chunk_meta)
```

### Why It Fails:
1. First check loads metadata to see if chunk exists
2. If exists, returns 'skipped' 
3. But if the check passes, it uploads the binary file
4. Then loads metadata FRESH from R2 (line 257)
5. Appends without checking again (line 291)
6. If multiple processes run simultaneously, they both pass the first check, then both append

### Fix Required:
Move the deduplication check to AFTER loading metadata at line 257, or check again before appending at line 291.

---

## Bug #2: No Day-Level Folder Structure

**Severity:** HIGH  
**File:** `backend/cron_job.py`  
**Impact:** Inefficient storage, hard to browse, will accumulate 30+ files per month in one folder

### Current Structure:
```
data/2025/11/HV/kilauea/OBL/--/HHZ/
  ├─ 10m/
  ├─ 1h/
  ├─ 6h/
  ├─ HV_OBL_--_HHZ_100Hz_2025-11-05.json
  ├─ HV_OBL_--_HHZ_100Hz_2025-11-06.json
  ├─ HV_OBL_--_HHZ_100Hz_2025-11-07.json
  ... (30+ metadata files per month)
```

### Should Be:
```
data/2025/11/05/HV/kilauea/OBL/--/HHZ/
  ├─ 10m/
  ├─ 1h/
  ├─ 6h/
  └─ HV_OBL_--_HHZ_100Hz_2025-11-05.json

data/2025/11/06/HV/kilauea/OBL/--/HHZ/
  ├─ 10m/
  ├─ 1h/
  ├─ 6h/
  └─ HV_OBL_--_HHZ_100Hz_2025-11-06.json
```

### Problems:
- After a month: 30+ metadata files in one folder
- Hard to browse by day
- Inefficient R2 listings (must filter by filename)
- No logical day-level organization
- Binary files ARE organized by day (in filename), but no folder hierarchy

---

## Bug #3: ~~Chunks Spanning Midnight~~ - FALSE ALARM / NOT A BUG

**Status:** RESOLVED - This is NOT actually a bug. The behavior is CORRECT.

### What Actually Happens:
At 00:02 UTC on Nov 6, a 6h chunk is created covering 18:00-00:00. This chunk:
- Starts at Nov 5 18:00
- Ends at Nov 6 00:00 (midnight)
- Gets assigned to Nov 5 metadata ✅ **CORRECT!**

The chunk is FROM Nov 5 (it covers the last 6 hours of Nov 5), so it BELONGS in Nov 5's folder/metadata. The fact that it ends exactly at midnight doesn't make it "Nov 6 data" - it's Nov 5 data that happens to end when Nov 6 begins.

### Why This Is Correct:
- Data from 18:00-23:59 on Nov 5 belongs to Nov 5
- The chunk ending at 00:00 is just the boundary, not "Nov 6 data"
- Assigning by START time is the right approach
- No chunks actually "span" midnight - they end AT midnight

### Conclusion:
This is not a bug. The original analysis was wrong.

---

## Bug #4: 6h Chunks Show Midnight Start Time (Misleading)

**Severity:** MEDIUM  
**File:** `backend/cron_job.py`  
**Impact:** Misleading timestamps, affects station activation time detection

### The Problem:
6h chunks created at 06:02 cover 00:00-05:59, even if data collection didn't start until 03:50. The chunk shows `start: "00:00:00"` but contains gap-filled data for the period before actual collection started.

### Example:
```json
{
  "start": "00:00:00",
  "end": "05:59:59",
  "samples": 2160000,
  "gap_count": 2,
  "gap_samples_filled": 3032  // <-- 3032 samples were interpolated
}
```

### Impact:
- The `/regenerate-station-activations` endpoint returns midnight as the start time
- Actual data collection started at 03:50, not 00:00
- The 00:00-03:50 period is gap-filled/interpolated, not real data

### Fix Required:
- Either: Don't create 6h chunks that span before data collection started
- Or: Store actual data start time separately from chunk window start time
- Or: Only use 10m chunks to determine station activation times (most accurate)

---

## Immediate Actions Required:

1. **STOP PRODUCTION COLLECTION** until deduplication is fixed
2. **NUKE existing data** from Nov 5-6 (duplicates are too messy to clean)
3. Fix deduplication check in `cron_job.py`
4. Add day-level folder structure: `data/2025/11/05/...` instead of `data/2025/11/...`
5. Restart collection with clean structure
6. Update `/regenerate-station-activations` to only use 10m chunks

---

## Testing Checklist:

- [ ] Nuke existing data from R2
- [ ] Add day-level folder structure to cron_job.py
- [ ] Fix deduplication check in cron_job.py
- [ ] Test with simultaneous runs to verify no race condition
- [ ] Wait for midnight rollover and verify new day folder is created
- [ ] Verify station activation times use 10m chunks, not 6h chunks

---

## Notes:

- The nuke on Nov 4 was intentional - cleared server to start fresh collection
- System has been running since Nov 5 04:02 UTC
- Duplicates started appearing shortly after collection began
- Metadata files exist and are accumulating, but with duplicate entries

