# Gap Catalog: Precision Gap Detection for CDAWeb Audio Data

## The Problem: CDAWeb's Audio Endpoint Silently Drops Gaps

CDAWeb's audio endpoint (`?format=audio`) has a critical flaw for time-aligned sonification: **it silently concatenates samples across data gaps with zero indication.**

### What CDAWeb Returns

```
GET /WS/cdasr/1/dataviews/sp_phys/datasets/{id}/data/{start},{end}/{var}?format=audio
Accept: application/json
```

Response:
```json
{
  "FileDescription": [
    {
      "Name": "https://cdaweb.gsfc.nasa.gov/tmp/.../dataset__000_000.wav",
      "MimeType": "audio/wav",
      "StartTime": "2019-08-15T00:00:00.000Z",
      "EndTime": "2019-08-30T00:00:00.000Z",
      "Length": 10264092
    }
  ]
}
```

### What's Missing

- **No gap metadata.** The `StartTime` and `EndTime` are just the *requested* range echoed back — they say nothing about gaps within the data.
- **No silence insertion.** When there's a 10-day gap in magnetometer data, the WAV samples from before and after the gap are glued together seamlessly.
- **No sidecar file.** No companion JSON, no timestamps-per-sample, no gap manifest.

### The Cascading Error

If a dataset has gaps:
1. Every sample after the first gap has a **wrong timestamp** — shifted by the gap duration
2. Each subsequent gap **compounds** the error
3. For a dataset like Wind MFI (136 gaps over 30 years), the cumulative drift makes time alignment meaningless

**Verified empirically:** Requesting MMS1 FGM Survey data across a known 10-day gap (Aug 17-27, 2019) returns identical `StartTime`/`EndTime` = the requested range. The gap is invisible in the API response.

## The Solution: Pre-Computed Gap Catalogs

We build precision gap catalogs offline and serve them via Cloudflare.

### How It Works

1. **Inventory endpoint** (`/WS/cdasr/1/dataviews/sp_phys/datasets/{id}/inventory/{start},{end}`) returns data intervals at **second** precision — fast, free, gives us gap locations
2. **Boundary sharpening** downloads tiny CDFs (±2 min around each gap edge) and reads the actual epoch array to get **millisecond** precision on gap start/end times
3. Catalogs are saved as JSON and uploaded to **R2** for serving via Cloudflare Worker

### Catalog Format

```json
{
  "dataset_id": "MMS1_FGM_SRVY_L2",
  "label": "MMS1 FGM Survey",
  "cataloged_at": "2026-03-27T22:09:11.095979",
  "time_range": { "start": "2015-09-01", "end": "2025-12-31" },
  "summary": {
    "total_intervals": 7,
    "total_gaps": 6,
    "boundaries_sharpened": true
  },
  "intervals": [
    {
      "start_iso": "2015-09-01T00:00:12.000Z",
      "end_iso": "2019-08-17T20:27:50.000Z",
      "end_epoch_raw": 6.193457401773211e+17,
      "end_precise": "2019-08-17T20:27:50.993"
    },
    {
      "start_iso": "2019-08-27T22:18:26.000Z",
      "end_iso": "2020-02-10T00:00:11.000Z",
      "start_epoch_raw": 6.202163761587334e+17,
      "start_precise": "2019-08-27T22:18:26.974",
      "end_epoch_raw": 6.345648804159533e+17,
      "end_precise": "2020-02-10T00:00:11.231"
    }
  ]
}
```

- `start_iso` / `end_iso`: Second-precision from CDAWeb inventory
- `start_precise` / `end_precise`: Millisecond-precision from CDF epoch arrays
- `start_epoch_raw` / `end_epoch_raw`: Raw CDF epoch values (TT2000 nanoseconds or CDF_EPOCH milliseconds) for exact reconstruction
- `cadence_ns`: Sample cadence in nanoseconds, detected from the CDF epoch array at each boundary

### Why Intervals, Not Gaps?

The catalog records **intervals of data coverage**, not gaps directly. Gaps are implied — they're the spaces *between* consecutive intervals. This representation is more useful because:

1. **Both sides of each gap are precisely bounded.** Interval N's `end_precise` is the last real sample before the gap; interval N+1's `start_precise` is the first real sample after it. The app needs both timestamps to know exactly where to insert silence.
2. **Negative gaps (overlaps) are self-describing.** When interval N's end > interval N+1's start, that's a negative gap — CDAWeb's inventory says two files both claim coverage over the same time window. No silence needed; the app just sees continuous data. This happens in ~1 per dataset due to CDAWeb inventory rounding, and ~134 times in MMS burst mode.
3. **Cadence is per-interval.** Different intervals can have different sample rates (e.g., after instrument mode changes). Storing cadence on the interval makes this natural.

To compute gaps from the catalog:
```javascript
for (let i = 0; i < intervals.length - 1; i++) {
  const gapStart = intervals[i].end_precise || intervals[i].end_iso;
  const gapEnd = intervals[i + 1].start_precise || intervals[i + 1].start_iso;
  // If gapStart >= gapEnd, this is an overlap — skip it (no silence needed)
}
```

### API Endpoints

```
GET /api/gap-catalog/:datasetId    → catalog JSON (edge-cached, ~70ms)
GET /api/gap-catalog               → list all available catalogs
```

Served from R2 with Cloudflare Workers Cache API. First request reads R2 (~130ms), subsequent requests served from edge cache (~70ms). Compare to CDAWeb inventory endpoint: 200-800ms.

### Coverage

49 datasets across 11 spacecraft (PSP, Wind, MMS, THEMIS, SolO, GOES, ACE, DSCOVR, Cluster, Geotail, Voyager). Burst-mode datasets with >5,000 gaps store inventory-only precision (sharpening 90K+ gaps would require days of CDF downloads).

## Key Files

| File | Purpose |
|------|---------|
| `tools/gap_cataloger.py` | Offline cataloging tool — inventory fetch, CDF boundary sharpening, incremental save/resume |
| `tools/gap_catalog/*.json` | Generated catalog files (one per dataset) |
| `cloudflare-worker/src/index.js` | Worker endpoint serving catalogs from R2 with edge caching |

## Running the Cataloger

```bash
cd tools
python3 gap_cataloger.py                    # Catalog all 49 datasets, 8 workers
python3 gap_cataloger.py --workers 4        # Fewer workers (gentler on CDAWeb)
python3 gap_cataloger.py --no-sharpen       # Inventory-only (fast, second precision)
```

The cataloger is resumable — if killed, it reads existing catalog JSON files and picks up where it left off (intervals with `start_precise`/`end_precise` fields are skipped). Progress is saved to disk every 5 gaps.

## Uploading Catalogs to R2

```bash
cd cloudflare-worker
for f in ../tools/gap_catalog/*.json; do
  dataset=$(basename "$f" .json)
  npx wrangler@4 r2 object put "space-weather-audio/gap_catalog/${dataset}.json" \
    --file "$f" --content-type application/json --remote
done
```

## Future: App Integration

When the app loads a dataset, it fetches the gap catalog in parallel with the audio data. During playback, gaps are rendered as silence at the precise boundaries, maintaining correct time alignment across the entire dataset. The spectrogram shows gap regions visually, and timestamps on the x-axis account for gap durations.
