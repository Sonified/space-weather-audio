# CDAWeb API Gap Behavior — Investigation Results

**Date:** 2026-03-27
**Context:** Testing how CDAWeb handles data gaps in `format=audio` and `format=cdf` responses.

## Key Discovery: StartTime/EndTime in FileDescription

Every `FileDescription` entry in the API response includes `StartTime`, `EndTime`, `Length`, `MimeType`, and `LastModified`. These fields have always been there — we were only reading `Name`.

## Inventory Endpoint

**URL:** `GET /dataviews/sp_phys/datasets/{dataset}/inventory/{start},{end}`
**Speed:** 370–700ms for 1-month queries
**Returns:** Array of `TimeInterval` objects with `Start`/`End` for each contiguous data block.

### Example: PSP MAG RTN (full cadence), Jan 1 2020
- 00:00–02:03 (DATA, ~2h)
- 02:03–10:53 (GAP, ~9h)
- 10:53–11:23 (DATA, ~30min)
- 11:23+ (GAP)

### Example: GOES-16 MAG, Jan 2022
- One solid block for the entire month (no gaps, geostationary)

## Audio Endpoint (`format=audio`) Behavior

### Test 1: Request entirely within data (00:00–01:00)
- **StartTime/EndTime:** 00:00–01:00 ✅ matches request
- **Samples:** 32,960 | **Rate:** 9.16/sec | **Size:** 64.4 KB
- **Note:** Rate is ~9.16, not exactly 10. PSP full cadence is variable rate.

### Test 2: Data ends mid-request (01:00–03:00, data ends at 02:03)
- **StartTime/EndTime:** 01:00–03:00 ⚠️ matches REQUEST, not actual data
- **Samples:** 34,782 | **Rate:** 4.83/sec | **Size:** 68 KB
- **CRITICAL:** CDAWeb returns StartTime/EndTime matching the REQUEST, not the data. Only ~1h of real data exists, but the WAV spans the full 2h request. The gap is filled with... something (silence? interpolation? fill values mapped to audio?). The sample rate dropped from 9.16 to 4.83 — roughly halved because only half the window has data.

### Test 3: Request entirely in gap (04:00–08:00)
- **Result:** `"No data available"` error
- **Good:** At least it tells you when there's NO data at all.

### Test 4: Gap then data resumes (09:00–12:00, data at 10:53–11:23)
- **StartTime/EndTime:** 09:00–12:00 ⚠️ matches REQUEST
- **Samples:** 17,921 | **Rate:** 1.66/sec | **Size:** 35 KB
- **CRITICAL:** 3 hours requested, ~30 min of real data. Rate is 1.66/sec — the real data got smeared across the full time window.

### Test 5: Data→gap→data (00:00–12:00)
- **StartTime/EndTime:** 00:00–12:00 ⚠️ matches REQUEST
- **Samples:** 85,661 | **Rate:** 1.98/sec | **Size:** 167 KB
- 12 hours requested, ~2.5h of real data. All compressed into the WAV with gaps as... something.

### Test 6: GOES-16 baseline — no gaps (08:00–09:00)
- **StartTime/EndTime:** 08:00–09:00 ✅ matches request
- **Samples:** 36,002 | **Rate:** 10.00/sec | **Size:** 70.4 KB
- Perfect: exactly 10 Hz, clean data, no gaps.

## Critical Finding: Sample Rate as Gap Indicator

| Test | Requested | Real Data | Samples/sec | Expected Rate |
|------|-----------|-----------|-------------|---------------|
| Within data | 1h | 1h | 9.16 | ~9-10 |
| Trailing gap | 2h | ~1h | 4.83 | ~9-10 |
| Leading gap | 3h | ~30min | 1.66 | ~9-10 |
| Swiss cheese | 12h | ~2.5h | 1.98 | ~9-10 |
| GOES no gap | 1h | 1h | 10.00 | 10 |

**The effective sample rate drops proportionally to the gap ratio.** CDAWeb's audification puts N real samples into a WAV that spans the full requested duration. Gaps become compressed silence.

## What This Means for the Main App

1. **StartTime/EndTime on audio responses match the REQUEST, not the data** — they can't be used for gap detection directly.
2. **The inventory endpoint is the only reliable gap source** — must be queried before/alongside data requests.
3. **Sample rate anomalies = gap indicator** — if expected_rate (from inventory or known cadence) doesn't match actual_rate (samples / duration), there are gaps.
4. **The app has been playing gap-filled audio without knowing it** — gaps get baked into the WAV as compressed data, changing the effective playback speed/pitch.

## Earlier Discovery: CDF Endpoint Returns Whole Archival Files

When using `format=cdf`, CDAWeb returns the smallest archival file containing the requested range — NOT trimmed to the request. The CDF StartTime/EndTime reflects the FILE's range, not the request. We added client-side trimming using Epoch data to handle this.

## Recommendations

1. **Query inventory before fetching audio** — know where gaps are upfront
2. **Compare requested duration with expected samples** — detect gaps from sample count
3. **Consider splitting requests around gaps** — fetch only data-containing intervals
4. **Display gap regions visually** — use inventory intervals to mark gaps on spectrogram/waveform
5. **Inventory is fast (370–700ms)** — can be done in parallel with the audio fetch

## API Speed Summary

| Endpoint | Typical Response Time |
|----------|----------------------|
| Inventory (1 month) | 370–700ms |
| Audio API query | 750–2500ms |
| Audio WAV download | 100–600ms per file |
| CDF API query | ~3000ms |
| CDF download | 10,000–25,000ms |
