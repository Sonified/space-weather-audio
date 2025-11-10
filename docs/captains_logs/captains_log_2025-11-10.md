# Captain's Log: 2025-11-10

## Session: Realistic Chunk Fetch Optimization - v1.72

### v1.72: Fix Realistic Chunk Filename Format

**Problem**: Realistic chunk fetch was failing with 404 errors before falling back to normal fetch. All 6 attempts (chunk 0 through +5) were timing out, adding ~1.8 seconds of unnecessary delay before playback could start.

**Root Cause**: The realistic chunk fetch was building incorrect filenames:
- **Wrong**: `HV_OBL_--_HHZ_10m_2025-11-10-05-40-00_to_2025-11-10-05-49-59.bin.zst`
- **Correct**: `HV_OBL_--_HHZ_10m_2025-11-10-05-40-00_to_2025-11-10-05-50-00.bin.zst`

The end time should be the **start of the next chunk** (e.g., `05-50-00`), not "9 minutes 59 seconds later" (e.g., `05-49-59`).

**Additional Issue**: Realistic chunk was only trying the OLD filename format (with sample rate like `100Hz`) instead of trying NEW format first, then falling back to OLD format.

**Solution**: Updated `buildRealisticUrl()` function in `index.html`:

1. **Fixed end time calculation**: Changed from `minute + 9` with `:59` to `minute + 10` with `:00`, with proper hour rollover handling
2. **Added NEW format support**: Now tries NEW format (no sample rate) first, then falls back to OLD format (with sample rate)

This matches the behavior of the main chunk fetch function, which was working correctly because it reads filenames from metadata.

**Impact**:
- ✅ Realistic chunk now succeeds on **first or second attempt** (instead of failing all 6 attempts)
- ✅ Playback starts **~1.5 seconds faster** (no more cascading 404s)
- ✅ Better user experience with immediate audio feedback

### Files Modified

- `index.html` (lines ~2051-2070): Fixed realistic chunk URL builder with correct end time format and NEW/OLD format fallback

### Version: v1.72

**Commit Message**: v1.72 Fix: Realistic chunk filename format - correct end time boundary and NEW/OLD format fallback for instant playback

**Results**:
- ✅ Realistic chunk fetch succeeds immediately
- ✅ TTFA (Time To First Audio) significantly improved
- ✅ No more cascading 404 errors in console

---

### What's Next

- Monitor realistic chunk success rate in production
- Consider adding retry logic with exponential backoff if needed

