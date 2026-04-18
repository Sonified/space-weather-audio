# Work Plan — Active

Completed tasks move to `WORKPLAN_ARCHIVE.md`.

---

## Bug 3 — De-tone is too aggressive, removing data not just tones

**Symptom:** The de-tone pipeline is filtering more than just the spacecraft spin tones — real signal features are getting eaten.

**Core idea for the fix (per Robert):** spin tones are *long-lived* narrowband ridges — they persist across minutes or the entire fetch window, even if they pulse in and out periodically. Real physical signal features tend to be much shorter in duration. So after detection, trace each tone as a *ridge* along the time axis and measure its **total lifetime** (arc length along the time-frequency ridge, *including gaps* — it's the whole arc that matters, not any one instantaneous segment). If the lifetime is below some threshold, reject the tone: it's probably real.

**Implementation sketch (to refine when we start):**
1. After the per-frame tonality detection in `workers/denoise-detect-worker.js`, run a post-pass that clusters detections into ridges.
2. Two detections belong to the same ridge if they're close in frequency (say ±2 bins) and within a gap tolerance on time (e.g. up to N frames apart — we want to bridge the "pulsing" gaps).
3. For each ridge, compute total temporal extent (end_frame − start_frame), and also total active frames (number of frames containing a detection). Both are useful; extent is the "arc length including gaps" Robert described.
4. Reject ridges whose extent is shorter than a configurable threshold (maybe "at least 20% of the fetch duration" as a starting point — tune empirically).
5. Only the surviving ridges feed the mask + WASM notch filter.

**Other levers already available (useful but secondary):**
- `TONALITY_THRESH` in `workers/denoise-detect-worker.js` (currently 10 dB).
- `MASK_HALF_WIDTH` / notch Q in the WASM filter.
- Frame count threshold (min run length before a "tone" is committed — this is a weaker version of the ridge-lifetime idea).

**Diagnostic plan before fixing:**
- Pick a dataset where Robert can *see* which detected frequencies are real signal vs spin tone.
- Print the detection table (freq, frame count) and overlay the cluster output so we can visually confirm what the ridge tracker is bundling.
- Only then tune thresholds.

---

## Task 7 — Gap-aware audio stitching

**Symptom:** All datasets can have gaps (burst-mode frequently, survey-mode occasionally). Current pipeline assumes one contiguous audio buffer per request. Requesting a time range spanning gaps either fails or returns partial data.

**What we want:**
1. Check gap catalog for data windows within the requested range
2. Fetch each data segment separately from CDAWeb
3. Stitch into one audio buffer with silence inserted for *interior* gaps (preserves time axis)
4. **Edge intelligence:** if the request lands on a gap at either end, trim to actual data boundaries — don't pad silence at the edges. Show the user a message with the actual data range (e.g. "Data available 10:02–10:58 of your 10:00–11:00 request")
5. Spectrogram renders interior gaps visually (distinct from "no signal" — maybe a subtle pattern or dimmed region)

**Edge cases:**
- Gap at start only → trim start, no leading silence, notify user
- Gap at end only → trim end, no trailing silence, notify user
- Gap in middle → insert silence, preserve time axis
- Multiple interior gaps → multiple silence inserts
- Entire range is a gap → "no data available" message
- Single contiguous segment → current behavior, no change

**Why it matters:** Applies to ALL datasets, not just burst-mode. Survey data has gaps too (instrument safemodes, downlink windows, calibration periods). Users shouldn't need to know exact data boundaries before requesting — the tool should be smart about it.

**Implementation notes:**
- Gap catalog is already served from R2 at `/api/gap-catalog/:datasetId`
- Front end currently: one `fetch()` → one WAV → one buffer. Needs to become: catalog lookup → N fetches → N buffers → stitch with silence for interior gaps only.
- ~20-30 min implementation. Ship when ready.
