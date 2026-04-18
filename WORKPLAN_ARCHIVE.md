# Work Plan — Completed

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

## ✅ Task 4 — Clamp low/high frequency inputs so they can't cross (DONE)

Mutual clamping on the low/high frequency inputs so they can't produce inverted ranges.

---

## ✅ Task 5 — "Download all feature data" button (DONE)

Export every tracked feature's data (time range, frequency range, component, dataset, confidence, notes) as JSON or CSV. Split buttons for JSON/CSV + isolated/full audio. See commit `561b534`.

---

## ✅ Task 6 — Export features as audio files (DONE)

Per-feature WAV clips — time-sliced to the feature window, optionally band-passed. Both isolated and full audio export modes via split buttons. See commit `52f9985`.

---
