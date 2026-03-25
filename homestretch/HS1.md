# HS1 — Identify Ideal Settings for Wavelet and Paul Stretch

> **SHIP_IT.md:** Identify ideal settings for wavelet and Paul stretch algorithms

---

## Context: Existing Pipeline

**The heavy lifting is done.** The entire GPU wavelet stretch pipeline — chunked processing, crossfade, background re-stretch — is implemented and working in both `stretch_test.html` (standalone test page) and `js/audio-player.js` (main app).

### What Already Exists

- **`stretch_test.html`** (3544 lines) — Complete standalone test page with 7 stretch algorithms: Resample, Spectral, Paul Stretch, Granular, CWT (Morlet Wavelet), CQT (Constant-Q), RTPGHI
- **`js/audio-player.js`** — Main app integration with `waveletStretchAndLoad()`, `waveletComputeCWT()`, `switchStretchAlgorithm()`
- **`js/wavelet-gpu-compute.js`** — GPU engine with `waveletStretchChunked()`, auto chunk sizing, progress callbacks
- **`workers/`** — All 4 stretch worklet processors (resample, paul, granular, wavelet)
- **`stretch_test_python_renders/`** — Reference renders for validation

## What This Task Is

This is a **listening/tuning task**, not a code task. `stretch_test.html` is literally the tool built for this — load GOES data, try different algorithms and parameters, compare results.

### Settings to Determine

**Paul Stretch:**
- Window size
- Overlap %

**Wavelet (CWT):**
- w0 (Morlet parameter)
- dj (scale resolution)
- Phase mode
- Interpolation mode
- Bins per octave

### Process
1. Load representative GOES magnetometer data in `stretch_test.html`
2. Compare algorithms at target speed (1.25x)
3. A/B test parameter variations
4. Save chosen params as defaults in study config

## Complexity

~1-2 hours of listening and comparing with Robert.
