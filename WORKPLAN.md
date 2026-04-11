# Work Plan — Active Bugs

Ground rules this round:
- No "fixed!" claims without a printed before/after from the browser.
- One bug at a time, in order.
- Robert runs the browser, Claude reads the logs Robert pastes.
- Add diagnostic prints FIRST. Understand the data path, then fix.

---

## ✅ Bug 1 — Waveform shows original (FIXED)

Visual waveform now reads `window.rawWaveformData` in `drawWaveform()`; playback still goes through `window._playbackSamples` (DC-removed + normalized). See commit `e9e1ca1`.

---

## ✅ Bug 2 — Component switch round-trip (FIXED)

Three stacked bugs in `switchComponent`:
1. WAV header not patched to 44.1 kHz → browser resampled, doubling sample count.
2. Raw samples handed to State/worklet without `detrend+norm` → 16× louder on round-trip.
3. `changeWaveformFilter()` fired a second `swap-buffer` with `normalize(raw)`, stomping the detrended buffer. Replaced with direct `drawWaveform()`.

See commit `a4d885a`.

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

## Task 4 — Clamp low/high frequency inputs so they can't cross

**Symptom:** when the user types a new value into the low or high frequency input, nothing stops them from setting the low frequency *higher* than the high (or vice versa), producing an inverted range that breaks the display.

**What we want:**
- On `change` / `blur` of the low-freq input, clamp its value to `≤ high - ε` (where ε is one step, or just "strictly less").
- On `change` / `blur` of the high-freq input, clamp its value to `≥ low + ε`.
- If the user types a crossing value, snap back to the boundary rather than silently rejecting — they should *see* what happened.
- Consider also a min/max floor/ceiling from the instrument's actual Nyquist so they can't go negative or above the sample rate/2.

**Implementation notes:**
- First step: locate the actual DOM ids for the low/high freq inputs (not obvious from a quick grep — only `minFreqMultiplier` and `highpassFreq` turned up, which don't look like the pair Robert means). Could be inside a drawer/modal that loads lazily.
- Wire two `input` / `change` listeners that mutually clamp.
- Make sure the clamp fires on Enter, blur, and any programmatic set.
