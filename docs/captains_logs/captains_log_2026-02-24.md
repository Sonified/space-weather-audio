# Captain's Log - 2026-02-24

## Wavelet Phase Vocoder: EMIC Study Audio Renders

Generated pre-rendered wavelet time-stretched audio files for the full 7-day EMIC study region (GOES-16 Bx, 2022-08-17 to 2022-08-24).

---

## Background: The w0 Parameter

The Morlet wavelet's `w0` (omega-zero) controls the time-frequency tradeoff. HARP's default is `w0=6` (per Torrence & Compo '98). Earlier experiments with the Julia Run 8 test audio compared `w0=6` vs `w0=10` — the higher value gives tighter frequency resolution at the cost of time localization. Preferred `w0=10` for this data.

Existing test scripts in `wavelets/` already had `w10` variants (`stretch_audio_3x_w10_waveletUtils.py`, `stretch_audio_4x_w10_waveletUtils.py`) documenting this preference.

## Streaming ICWT Architecture

The full 7-day CWT produces a 174 scales × 6,048,000 samples complex128 matrix — about 16.8 GB. Normally the stretch step would interpolate the entire matrix to the target length (doubling memory for 2× stretch), which would exceed available RAM.

**Solution:** Process one scale at a time during the inverse transform. For each scale: decompose to magnitude + phase, interpolate to stretched length, apply phase shift, accumulate into a running sum, then discard. Peak memory stays at ~14.5 GB regardless of stretch factor.

This is mathematically identical to the batch approach — ICWT is a sum across scales, so accumulating row-by-row gives the same result.

## New Script: `wavelets/emic_wavelet_stretch.py`

Self-contained script that:
1. Fetches GOES-16 Bx magnetometer data from CDAWeb (7 daily CDF files)
2. Handles fill value interpolation (-9999 → linear interp)
3. Runs forward CWT with Morlet w0=10, dj=0.12
4. Applies streaming stretch+ICWT for each target speed
5. Saves peak-normalized 16-bit WAV at 44100 Hz

Progress reporting at every 20 scales for both CWT and stretch phases.

## Output Files

Location: `emic_audio/`

| File | Speed | Stretch | Duration | Size |
|------|-------|---------|----------|------|
| `GOES16_Bx_EMIC_7day_20220817-20220824_wavelet_w0-10_0.75x.wav` | 0.75× | 1.333× | 182.9s | 15 MB |
| `GOES16_Bx_EMIC_7day_20220817-20220824_wavelet_w0-10_0.5x.wav` | 0.5× | 2.0× | 274.3s | 23 MB |

## Render Performance

- **CWT:** 174 scales × 6,048,000 samples in 263s (~4.4 min)
- **0.75× stretch:** 333s (~5.5 min)
- **0.5× stretch:** 332s (~5.5 min)
- **Total:** 929s (15.5 min)
- **Peak memory:** ~14.5 GB on 64 GB machine

## .gitignore Update

Added `!emic_audio/*.wav` exception so these render outputs track in git alongside the codebase. Previously all `.wav` files were ignored except `stretch_test_audio/`.

## Commit

`836edaf` — pushed to `main`.
