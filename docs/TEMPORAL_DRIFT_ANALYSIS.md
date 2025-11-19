# Temporal Drift Analysis: Features vs Regions

## Problem Statement
Features are appearing outside of regions, indicating temporal drift between how features and regions load/position themselves using timestamps.

## Side-by-Side Comparison

### 1. DATA STORAGE FORMAT

#### **FEATURES** (`spectrogram-feature-boxes.js`)
```javascript
// Storage format in region.features[i]
feature = {
    startTime: "2023-05-15T10:30:45.000Z",  // ISO timestamp string
    endTime: "2023-05-15T10:31:12.000Z",    // ISO timestamp string
    lowFreq: "12.5",                         // Hz (string)
    highFreq: "18.3"                         // Hz (string)
}
```
- **Storage**: ISO timestamp strings only
- **No sample indices**: Features do NOT store sample indices

#### **REGIONS** (`region-tracker.js`)
```javascript
// Storage format in regions[i]
region = {
    startSample: 2334349,                    // Absolute sample index (PREFERRED)
    endSample: 2595874,                      // Absolute sample index (PREFERRED)
    startTime: "2023-05-15T10:30:00.000Z",  // ISO timestamp (DERIVED/BACKUP)
    stopTime: "2023-05-15T10:35:00.000Z"    // ISO timestamp (DERIVED/BACKUP)
}
```
- **Storage**: BOTH sample indices (preferred) AND timestamps (backup)
- **Dual format**: Supports both old (timestamp-only) and new (sample-based) formats

---

### 2. TIMESTAMP LOADING FROM STORAGE

#### **FEATURES** (Lines 235-236 in `spectrogram-feature-boxes.js`)
```javascript
const startTimestamp = new Date(feature.startTime);  // Direct ISO string → Date
const endTimestamp = new Date(feature.endTime);      // Direct ISO string → Date
```
- **Method**: Direct conversion from ISO string to Date object
- **No validation**: Assumes `feature.startTime` is valid ISO string
- **No fallback**: If timestamp is missing/invalid, feature is hidden

#### **REGIONS** (Lines 749-762 in `region-tracker.js`)
```javascript
// Check for sample indices first (new format)
if (region.startSample !== undefined && region.endSample !== undefined) {
    // New format: convert from eternal sample indices
    regionStartSeconds = zoomState.sampleToTime(region.startSample);
    regionEndSeconds = zoomState.sampleToTime(region.endSample);
} else {
    // Old format: convert from timestamps (backward compatibility)
    const regionStartMs = new Date(region.startTime).getTime();
    const regionEndMs = new Date(region.stopTime).getTime();
    regionStartSeconds = (regionStartMs - dataStartMs) / 1000;
    regionEndSeconds = (regionEndMs - dataStartMs) / 1000;
}
```
- **Method**: Prefers sample indices, falls back to timestamps
- **Two-step conversion**: Samples → Time → Timestamp (or Timestamp → Time)
- **Validation**: Checks for both formats

---

### 3. TIME CONVERSION METHODS

#### **FEATURES** (Lines 235-253 in `spectrogram-feature-boxes.js`)
```javascript
// Step 1: Convert ISO strings to Date objects
const startTimestamp = new Date(feature.startTime);
const endTimestamp = new Date(feature.endTime);

// Step 2: Get interpolated display range
const interpolatedRange = getInterpolatedTimeRange();
const displayStartMs = interpolatedRange.startTime.getTime();
const displayEndMs = interpolatedRange.endTime.getTime();
const displaySpanMs = displayEndMs - displayStartMs;

// Step 3: Calculate progress within display range
const startMs = startTimestamp.getTime();
const endMs = endTimestamp.getTime();
const startProgress = (startMs - displayStartMs) / displaySpanMs;
const endProgress = (endMs - displayStartMs) / displaySpanMs;

// Step 4: Convert to pixels
startX = startProgress * canvas.offsetWidth;
endX = endProgress * canvas.offsetWidth;
```
- **Conversion path**: ISO string → Date → milliseconds → progress → pixels
- **Uses**: `getInterpolatedTimeRange()` for display range
- **No sample conversion**: Features never convert through samples

#### **REGIONS** (Lines 766-791 in `region-tracker.js`)
```javascript
// Step 1: Get interpolated display range
const interpolatedRange = getInterpolatedTimeRange();

// Step 2: Convert region samples to real-world timestamps
const regionStartTimestamp = zoomState.sampleToRealTimestamp(
    region.startSample !== undefined 
        ? region.startSample 
        : zoomState.timeToSample(regionStartSeconds)
);
const regionEndTimestamp = zoomState.sampleToRealTimestamp(
    region.endSample !== undefined 
        ? region.endSample 
        : zoomState.timeToSample(regionEndSeconds)
);

// Step 3: Calculate where timestamps fall within interpolated display range
const displayStartMs = interpolatedRange.startTime.getTime();
const displayEndMs = interpolatedRange.endTime.getTime();
const displaySpanMs = displayEndMs - displayStartMs;

const regionStartMs = regionStartTimestamp.getTime();
const regionEndMs = regionEndTimestamp.getTime();

// Step 4: Calculate progress
const startProgress = (regionStartMs - displayStartMs) / displaySpanMs;
const endProgress = (regionEndMs - displayStartMs) / displaySpanMs;

// Step 5: Convert to pixels
startX = startProgress * canvasWidth;
endX = endProgress * canvasWidth;
```
- **Conversion path**: Samples → Timestamp → milliseconds → progress → pixels (OR Timestamp → milliseconds → progress → pixels)
- **Uses**: `zoomState.sampleToRealTimestamp()` to convert samples to timestamps
- **Sample conversion**: Regions convert through sample space first

---

### 4. HOW TIMESTAMPS ARE CREATED

#### **FEATURES** (Lines 1462-1486 in `region-tracker.js`)
```javascript
// When user selects a feature on spectrogram:
const startSample = zoomState.pixelToSample(startX, canvasWidth);
const endSample = zoomState.pixelToSample(endX, canvasWidth);
const startTimestamp = zoomState.sampleToRealTimestamp(startSample);
const endTimestamp = zoomState.sampleToRealTimestamp(endSample);

if (startTimestamp && endTimestamp) {
    const actualStartMs = Math.min(startTimestamp.getTime(), endTimestamp.getTime());
    const actualEndMs = Math.max(startTimestamp.getTime(), endTimestamp.getTime());
    
    startTime = new Date(actualStartMs).toISOString();
    endTime = new Date(actualEndMs).toISOString();
}
```
- **Creation path**: Pixel → Sample → Timestamp → ISO string
- **Uses**: `zoomState.sampleToRealTimestamp()` which depends on `State.dataStartTime` and `State.dataEndTime`

#### **REGIONS** (Lines 578-583 in `region-tracker.js`)
```javascript
// When user creates a region from waveform selection:
const startTimestamp = zoomState.sampleToRealTimestamp(startSample);
const endTimestamp = zoomState.sampleToRealTimestamp(endSample);

const startTime = startTimestamp ? startTimestamp.toISOString() : null;
const endTime = endTimestamp ? endTimestamp.toISOString() : null;
```
- **Creation path**: Sample → Timestamp → ISO string (same as features!)
- **Uses**: Same `zoomState.sampleToRealTimestamp()` method

---

### 5. KEY DIFFERENCE: `sampleToRealTimestamp()` IMPLEMENTATION

Both features and regions use `zoomState.sampleToRealTimestamp()` when CREATING timestamps, but the implementation depends on `State.dataStartTime` and `State.dataEndTime`:

```javascript
// From zoom-state.js (Lines 133-142)
sampleToRealTimestamp(sampleIndex) {
    if (!this.isInitialized() || !State.dataStartTime || !State.dataEndTime) {
        return null;
    }
    
    const clampedSample = this.clampSample(sampleIndex);
    const progress = clampedSample / this.totalSamples;
    const totalDurationMs = State.dataEndTime.getTime() - State.dataStartTime.getTime();
    return new Date(State.dataStartTime.getTime() + (progress * totalDurationMs));
}
```

**Critical dependency**: This method assumes:
- `State.dataStartTime` and `State.dataEndTime` are set correctly
- `this.totalSamples` matches the actual data
- The sample index is relative to the SAME data range

---

## ROOT CAUSE ANALYSIS

### Potential Sources of Temporal Drift

#### 1. **Data Reload Timing Issue** ⚠️ MOST LIKELY
- **Problem**: When data is reloaded, `State.dataStartTime` and `State.dataEndTime` may change
- **Impact**: Features created with old `dataStartTime/dataEndTime` will have timestamps calculated from old reference points
- **Why**: Features store ISO timestamps that were calculated using OLD `dataStartTime/dataEndTime`, but when positioning, they're compared against NEW `dataStartTime/dataEndTime` via `getInterpolatedTimeRange()`
- **Evidence**: Features use direct timestamp comparison, regions convert through samples which are more stable

#### 2. **Sample Rate Mismatch**
- **Problem**: If `zoomState.sampleRate` (44100 Hz) doesn't match actual audio sample rate
- **Impact**: Sample-to-time conversions will be wrong
- **Why**: Features don't use samples, so they're immune. Regions use samples, so they'd be affected differently

#### 3. **Total Samples Mismatch**
- **Problem**: If `zoomState.totalSamples` doesn't match actual audio length
- **Impact**: `sampleToRealTimestamp()` progress calculation will be wrong
- **Why**: Both features and regions use this when CREATING timestamps, but features don't use it when POSITIONING

#### 4. **Interpolated Range Calculation**
- **Problem**: `getInterpolatedTimeRange()` might return different ranges for features vs regions
- **Impact**: Features and regions would position relative to different display ranges
- **Why**: Both use the same function, so this is unlikely unless called at different times

#### 5. **Timestamp Precision Loss**
- **Problem**: ISO timestamps might lose precision during string conversion
- **Impact**: Milliseconds-level drift could accumulate
- **Why**: Features store strings, regions store samples (more precise)

---

## RECOMMENDED FIXES

### Fix 1: Make Features Use Sample-Based Storage (BEST SOLUTION)
**Why**: Regions work correctly because they use sample indices. Features should too.

**Changes needed**:
1. Store `startSample` and `endSample` in features (in addition to timestamps for display)
2. When positioning features, convert samples → timestamps → pixels (same as regions)
3. When creating features, store both samples and timestamps

**Code location**: `js/spectrogram-feature-boxes.js` and `js/region-tracker.js`

### Fix 2: Ensure Consistent `dataStartTime/dataEndTime` Reference
**Why**: If data is reloaded, all timestamps need to be recalculated OR features need to use samples

**Changes needed**:
1. When data loads, validate that existing feature timestamps are still valid
2. OR: Convert feature timestamps to samples on load, then use samples for positioning

### Fix 3: Add Validation and Debugging
**Why**: Need to detect when drift occurs

**Changes needed**:
1. Log `State.dataStartTime`, `State.dataEndTime`, `zoomState.totalSamples` when features are created
2. Log same values when features are positioned
3. Compare feature timestamps against current data range
4. Warn if feature timestamps fall outside current data range

---

## DEBUGGING STEPS

1. **Check if `State.dataStartTime/dataEndTime` changed**:
   - Log these values when features are created
   - Log these values when features are positioned
   - Compare to see if they differ

2. **Check if feature timestamps are outside data range**:
   - Compare `feature.startTime` against `State.dataStartTime`
   - Compare `feature.endTime` against `State.dataEndTime`
   - Features should be within this range

3. **Check `zoomState.totalSamples`**:
   - Ensure it matches actual audio length
   - If it's wrong, `sampleToRealTimestamp()` will be wrong

4. **Compare positioning calculations**:
   - Log the `displayStartMs` and `displayEndMs` used by features
   - Log the same values used by regions
   - They should be identical (both use `getInterpolatedTimeRange()`)

---

## CONCLUSION

**Root Cause**: Both features and regions store timestamps, BUT regions have a bug in their positioning code (line 774 in `region-tracker.js`):

When regions have `startSample` stored, the code converts samples → timestamps using `sampleToRealTimestamp()`, which uses the **CURRENT** `State.dataStartTime/dataEndTime`. This is wrong because:

1. Region was created with dataStartTime = T1, dataEndTime = T2
2. Region stored startSample = 1000 and startTime = "2023-05-15T10:30:00Z"
3. Data is reloaded with dataStartTime = T3, dataEndTime = T4
4. When positioning, `sampleToRealTimestamp(1000)` uses T3/T4, producing WRONG timestamp!
5. Features use timestamps directly, so they're correct
6. Regions convert samples through wrong data range, causing drift

**The Fix**: Regions should ALWAYS use their stored `startTime`/`stopTime` timestamps directly for positioning, never convert samples. Samples are only for backward compatibility or other purposes, but positioning must use timestamps as the source of truth.

