# Captain's Log - 2025-10-15

## Major Discovery: Hourly Chunks vs. Full Request Comparison

### Objective
Conducted a comprehensive head-to-head test comparing two data retrieval approaches:
1. **Full Request** (current approach): Single large request for entire time period
2. **Hourly Chunks** (alternative): 24 separate 1-hour requests

### Test Configuration
- **Station**: HV.OBL.HHZ (Kīlauea, Hawaii)
- **Time Period**: Last 24 hours
- **Test Date**: 2025-10-15
- **Test Script**: `tests/test_full_vs_hourly.py`

### Results Summary

#### 🔵 Full Request Approach (Current)
- **Total Samples**: 8,632,723
- **Data Duration**: 23.98 hours
- **Coverage**: 99.9%
- **Traces**: 8
- **Data Gaps**: 7 gaps (49 seconds total)
- **File Size**: 10.28 MB (mseed), 1.75 MB (audio)
- **Pros**: Simpler, fewer API calls, fewer trace boundaries
- **Cons**: Slightly less data retrieved

#### 🟢 Hourly Chunks Approach (Alternative)
- **Total Samples**: 8,635,127 (+2,404 samples)
- **Data Duration**: 23.99 hours (+24 seconds)
- **Coverage**: 99.9%
- **Traces**: 31
- **Data Gaps**: 30 gaps (36 seconds total)
- **Success Rate**: 24/24 chunks (100%)
- **Audio Size**: 0.69 MB
- **Pros**: Retrieved MORE data, more resilient to server issues
- **Cons**: More API calls, more trace boundaries

### Key Findings

1. **Hourly Chunks Retrieved More Data**
   - 2,404 additional samples (0.03% more)
   - 24 seconds more audio duration
   - Winner by coverage and completeness

2. **Gap Analysis**
   - Full request: 7 larger gaps (49 sec total)
   - Hourly chunks: 30 smaller gaps (36 sec total)
   - Hourly chunks had LESS total gap time despite more gap events
   - More gaps in hourly approach are due to trace boundaries, not missing data

3. **Audio File Size Discrepancy**
   - Full request: 1.75 MB
   - Hourly chunks: 0.69 MB
   - This is unexpected and needs investigation - possibly due to how gaps are filled

4. **Reliability**
   - Hourly chunks: 100% success rate (24/24 hours)
   - Full request: Works but may miss edge data

### Technical Insights

**Why Hourly Chunks Get More Data:**
- IRIS server may have issues with very large time windows
- Smaller requests are more reliable and less prone to timeouts
- Edge cases at boundaries are handled better with multiple requests

**Trade-offs:**
- Hourly chunks: 24 API calls vs. 1 (or 2 with gap detection)
- More traces to manage and combine
- Slightly more complex processing

### Recommendation

**Switch to hourly chunks approach for production** because:
1. ✅ Retrieves more complete data (proven with real test)
2. ✅ 100% success rate in test
3. ✅ More resilient to server issues
4. ✅ Better for long time periods (24+ hours)
5. ⚠️ Trade-off: More API calls (but still reasonable)

### Next Steps

1. Integrate hourly chunk approach into main.py
2. Add option to choose between approaches (default to hourly)
3. Investigate audio file size discrepancy
4. Test with Mt. Spurr (AV.SPCN) to confirm results
5. Update dynamic_audification_test.ipynb with working implementation

### Files Created
- `tests/test_full_vs_hourly.py` - Comprehensive comparison test
- `tests/comparison_files/` - Test data and audio files for both approaches
- `tests/test_logs/full_vs_hourly_20251015_142321.txt` - Test log

---

