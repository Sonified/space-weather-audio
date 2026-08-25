# EMIC Study Audio Files

The six audio stimuli from the **chirp-pilot-study** (EMIC wave analysis, spaceweather.now.audio).
2 time regions × 3 processing types, all at the study's single playback speed of **1.25x**.
Every participant heard exactly two of these (one region + processing per task, counterbalanced
across 12 conditions).

| File | Region | Processing |
|---|---|---|
| GOES_REGION_1_2022-08-17_to_2022-08-20_resample_1.25x.wav | 1 | Resample (pitch shifts with speed) |
| GOES_REGION_1_2022-08-17_to_2022-08-20_paulstretch_1.25x.wav | 1 | PaulStretch, window 1024 |
| GOES_REGION_1_2022-08-17_to_2022-08-20_wavelet_1.25x.wav | 1 | Wavelet CWT (pre-rendered) |
| GOES_REGION_2_2022-01-14_to_2022-01-17_resample_1.25x.wav | 2 | Resample |
| GOES_REGION_2_2022-01-14_to_2022-01-17_paulstretch_1.25x.wav | 2 | PaulStretch, window 1024 |
| GOES_REGION_2_2022-01-14_to_2022-01-17_wavelet_1.25x.wav | 2 | Wavelet CWT (pre-rendered) |

Date ranges are exact: each region spans midnight-to-midnight UTC (00:00Z on the
start date to 00:00Z on the end date — exactly 72 hours; the end date is exclusive).

Source data: GOES-16 magnetometer (DN_MAGN-L2-HIRES_G16, Bx), 3 days per region,
audified to 44.1 kHz mono (58.8 s at 1x → 47.0 s at 1.25x).

## Provenance

- **Wavelet**: byte-identical copies of the R2 files served to participants
  (`/api/emic-audio/GOES_REGION_{1,2}_speed_cwt_1.25x.wav`). The study plays these
  verbatim — speed and processing are baked in.
- **Resample / PaulStretch**: rendered offline from
  `stretch_test_audio/GOES_REGION_{1,2}_GAINCURVED_*.wav`, which contain the study's
  live preprocessing chain (DC-offset detrend → per-region gain envelope from
  `gain_curves.json` → peak normalize). The 1.25x stage is a faithful port of the
  browser worklets: linear-interpolation readout (`workers/resample-stretch-processor.js`)
  and the paulstretch.js algorithm with window 1024 plus the ×2.0 gain compensation the
  player applies (`workers/paul-stretch-processor.js`). PaulStretch phase randomization
  is non-deterministic in the browser, so that render matches statistically, not
  sample-for-sample.

Render script: `tools/render_study_audio.py` (generated 2026-08-25).
