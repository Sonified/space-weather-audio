# CDAWeb Gap Analysis — Comprehensive Audit

**Date:** 2026-03-27
**Context:** Auditing all datasets offered by [spaceweather.now.audio](https://spaceweather.now.audio) for data gaps that affect audification via CDAWeb's `format=audio` endpoint.

## The Problem

CDAWeb's `audio_wav.pro` silently concatenates whatever CDF records exist into a WAV file. When time ranges have no data (no CDF records), those periods are simply absent from the audio — no silence inserted, no gap markers. The WAV timeline does NOT match wall-clock time. See [cdaweb-api-findings.md](cdaweb-api-findings.md) for detailed investigation.

## Comprehensive Gap Audit — All App Datasets

**Test period:** January 2022 (1 month)
**Method:** CDAWeb inventory endpoint, coverage clipped to request window

### Continuous Datasets (No Gaps)

These datasets have zero gaps and 100% coverage — audification works correctly as-is.

| Spacecraft | Dataset | Instrument |
|-----------|---------|------------|
| **Wind** | `WI_H2_MFI` | Magnetic Field Investigation |
| **MMS1** | `MMS1_FGM_SRVY_L2` | Fluxgate Magnetometer Survey |
| **MMS1** | `MMS1_SCM_SRVY_L2_SCSRVY` | Search Coil Magnetometer Survey |
| **THEMIS A-E** | `THx_L2_FGM` | Fluxgate Magnetometer |
| **THEMIS A-E** | `THx_L2_SCM` | Search Coil Magnetometer |
| **THEMIS A-E** | `THx_L2_EFI` | Electric Field Instrument |
| **GOES-16** | `DN_MAGN-L2-HIRES_G16` | Magnetometer 10 Hz |
| **ACE** | `AC_H3_MFI` | Magnetic Field 1-sec |
| **DSCOVR** | `DSCOVR_H0_MAG` | Fluxgate Magnetometer 1-sec |
| **Cluster** | `Cx_CP_STA_CWF_GSE` | STAFF Waveform |

### Gappy Datasets (Affected by the Bug)

| Spacecraft | Dataset | Instrument | Gaps/mo | Coverage | Severity |
|-----------|---------|------------|---------|----------|----------|
| **MMS1** | `MMS1_FGM_BRST_L2` | FGM Burst | **615** | **3.4%** | By design — event-triggered |
| **MMS1** | `MMS1_SCM_BRST_L2_SCB` | SCM Burst | **615** | **3.4%** | By design — event-triggered |
| **MMS1** | `MMS1_EDP_BRST_L2_DCE` | EDP Burst (E-field) | **615** | **3.4%** | By design — event-triggered |
| **MMS1** | `MMS1_EDP_SLOW_L2_DCE` | EDP Slow (E-field) | 16 | 58.0% | Operational gaps |
| **MMS1** | `MMS1_EDP_FAST_L2_DCE` | EDP Fast (E-field) | 14 | 73.4% | Operational gaps |
| **PSP** | `PSP_FLD_L2_MAG_RTN` | MAG Full Cadence (B-field) | 36 | 46.8% | Orbit/downlink gaps |
| **PSP** | `PSP_FLD_L2_DFB_WF_DVDC` | DFB DC Voltage (E-field) | 36 | 45.1% | Orbit/downlink gaps |
| **PSP** | `PSP_FLD_L2_MAG_RTN_4_SA_PER_CYC` | MAG 4 Samples/Cycle (B-field) | 12 | 77.1% | Orbit/downlink gaps |
| **SolO** | `SOLO_L2_MAG-RTN-NORMAL` | MAG Normal Mode (B-field) | 1 | 91.9% | Occasional gaps |
| **SolO** | `SOLO_L2_MAG-RTN-BURST` | MAG Burst Mode (B-field) | 1 | 91.9% | Occasional gaps |
| **SolO** | `SOLO_L2_RPW-LFR-SURV-CWF-E` | RPW LFR (E-field) | 2 | 85.8% | Occasional gaps |
| **Cluster** | `C1_CP_FGM_5VPS` | FGM 5 Vec/s (B-field) | 1 | 98.7% | Minor |
| **Geotail** | `GE_K0_EFD` | EFD Spherical Probe (E-field) | 6 | 98.5% | Minor |

### No Data Available (Jan 2022)

| Dataset | Reason |
|---------|--------|
| `C1_CP_EFW_L3_E3D_INERT` | Cluster EFW — may be decommissioned or intermittent |
| `GE_EDB3SEC_MGF` | Geotail MGF — mission ended 2022-11-28 |
| `VOYAGER1_2S_MAG` | Different archive structure |
| `VOYAGER2_2S_MAG` | Different archive structure |

### Summary

- **16 datasets** are gap-free (continuous) — audification works correctly
- **13 datasets** have gaps — audification silently drops time, producing incorrect WAVs
- **Affected instruments span both magnetic AND electric field data**
- Most severely affected: MMS burst modes (615 gaps/mo), PSP (36 gaps/mo), SolO (1-2 gaps/mo)

---

## PSP Deep Dive: ±6 Days from Perihelion = No Gaps

Across all 25 PSP encounters (E1–E25), data within ±6 days of perihelion is 100% continuous.

```
PSP MAG RTN — ±6 days from perihelion (clipped to window)
==============================================================
Enc     Coverage        Gap       Status
--------------------------------------------------------------
E1     100.0000%      0.0 min  ✅
E2     100.0000%      0.0 min  ✅
E3     100.0000%      0.0 min  ✅
E4     100.0000%      0.0 min  ✅
E5     100.0000%      0.0 min  ✅
E6     100.0000%      0.0 min  ✅
E7     100.0000%      0.0 min  ✅
E8     100.0000%      0.0 min  ✅
E9     100.0000%      0.0 min  ✅
E10    100.0000%      0.0 min  ✅
E11    100.0000%      0.0 min  ✅
E12    100.0000%      0.0 min  ✅
E13     99.9443%      9.6 min  ⚠️  (data ends 10min before window boundary)
E14    100.0000%      0.0 min  ✅
E15    100.0000%      0.0 min  ✅
E16    100.0000%      0.0 min  ✅
E17    100.0000%      0.0 min  ✅
E18    100.0000%      0.0 min  ✅
E19    100.0000%      0.0 min  ✅
E20    100.0000%      0.0 min  ✅
E21    100.0000%      0.0 min  ✅
E22    100.0000%      0.0 min  ✅
E23    100.0000%      0.0 min  ✅
E24    100.0000%      0.0 min  ✅
E25    100.0000%      0.0 min  ✅
```

### ±8 Days: Gaps Appear at the Fringe

Extending to ±8 days, 7 of 25 encounters show gaps — always at the tail end as PSP transitions out of encounter mode:

| Encounter | Gaps | Coverage | Gap Location |
|-----------|------|----------|-------------|
| E6 (Sep 2020) | 2 | 95.3% | Oct 3–4 (day +7/+8) |
| E8 (Apr 2021) | 2 | 95.6% | May 5–6 (day +6/+7) |
| E9 (Aug 2021) | 2 | 93.7% | Aug 15–16 (day +6/+7) |
| E11 (Feb 2022) | **5** | 92.4% | Mar 3–4 (day +6/+7) |
| E13 (Aug 2022) | **4** | 93.7% | Sep 11–13 (day +5/+7) |
| E17 (Sep 2023) | 2 | 96.7% | Oct 4 (day +7) |
| E18 (Dec 2023) | 1 | 96.5% | Dec 21 (day -8) |

### Cruise Phase (Away from Perihelion)

January 2020: **27 gaps, 60% coverage.** Data blocks as short as 30 minutes between multi-hour gaps.

---

## PSP Cadence Analysis

No mode flag or cadence metadata exists in the CDF files. `Time_resolution` is always `'full'`. Rate is entirely implicit in epoch spacing.

| Context | Cadence | Rate | Example |
|---------|---------|------|---------|
| Close perihelion (E15+) | 3.413 ms | **293 Hz** | 2023-03-17 |
| Near perihelion (E4–E12) | 6.827 ms | **146 Hz** | 2020-01-29 |
| Far from Sun / cruise | 109.227 ms | **9.16 Hz** | 2020-01-01, 2021-01-01 |
| 4SA reduced dataset | 218.453 ms | **4.58 Hz** | Always |

Within any single data block, cadence is >99% uniform (one dominant rate).

### 73 Hz Startup Burst (Cruise Phase Only)

Data blocks at 9 Hz cadence consistently begin with exactly **1,535 samples at 13.653 ms (73 Hz)** — a ~21-second high-rate burst at the start of each contact window (likely instrument settling/calibration). This pattern appears across Jan 1, Jan 2, and Jan 16, 2020. It does NOT appear in perihelion data (146/293 Hz blocks are clean).

---

## Root Cause in `audio_wav.pro`

The audification code (`audio_wav.pro` lines 536, 553) slices the data array using indices found by comparing epoch timestamps:

```idl
mytime = edat [rbegin:rend]                          ; line 536
mydata = REFORM (idat [rbegin:rend, wave_file])       ; line 553
```

It only operates on records that exist in the CDF. Missing time ranges have no records — `audio_wav.pro` never sees them. The `interpolate_audio_data` procedure (line 565) handles NaN fill values within existing records but has no concept of "missing records" or expected time coverage.

**Confirmed by CDF inspection:** Downloaded CDF for PSP 09:00–12:00 request. The file contains exactly 17,920 records spanning 10:53–11:23. Records for 09:00–10:53 and 11:23–12:00 simply don't exist. The filename itself reflects this: `psp_flds_l2_mag_rtn_20200101105317_20200101112329_cdaweb.cdf`.

---

## Inventory Precision — How Accurate Are the Gap Boundaries?

**Question:** Can we use inventory intervals to precisely reconstruct gap positions?

**Method:** Downloaded CDF files for known gappy time ranges, compared actual TT2000 epoch timestamps (millisecond precision) against inventory endpoint `Start`/`End` (which are ISO strings).

### Results

| Date | Boundary | Inventory Says | CDF Actual | Diff |
|------|----------|---------------|------------|------|
| Jan 1 Block 1 | Start | 00:00:00.000 | 00:00:00.009 | +9 ms |
| Jan 1 Block 1 | End | 02:03:18.000 | 02:03:18.930 | +930 ms |
| Jan 1 Block 2 | Start | 10:53:17.000 | 10:53:17.571 | +571 ms |
| Jan 1 Block 2 | End | 11:23:29.000 | 11:23:29.744 | +744 ms |

**Finding: Inventory timestamps are truncated to whole seconds.** CDF data has sub-millisecond precision but inventory floors to the nearest second. This means:

- At 9 Hz (cruise): ~9 samples of boundary uncertainty
- At 146 Hz (perihelion): ~146 samples of boundary uncertainty
- At 293 Hz (close perihelion): ~293 samples of boundary uncertainty

### What This Means

**The fuzz is in the silence, not the data.** Inventory is precise enough to:
1. Know exactly how many contiguous data intervals exist
2. Know approximately when each starts/ends (within ~1 second)
3. Split audio requests per-interval so each returned WAV is guaranteed gap-free
4. Insert correct-duration silence between intervals

Nobody will notice if a gap is 8h 49m 59s vs 8h 50m 0s of silence. The data samples themselves are untouched.

### Proposed Client-Side Pipeline

Instead of requesting one big WAV spanning gaps (which CDAWeb concatenates incorrectly), the app can:

1. **Query inventory** → list of contiguous `[start, end]` intervals (~500ms)
2. **Fetch audio per-interval** → one request per contiguous block, each WAV is gap-free
3. **Stitch with silence** → insert calculated silence based on time between intervals
4. **Display gap markers** → use interval boundaries on spectrogram/waveform

This requires **zero changes on CDAWeb's side** — the inventory endpoint already exists and is fast.

### Why Inventory Is Only Second-Precise

Investigated the CDASWS architecture to understand where the truncation happens:

| Layer | Precision | Source |
|-------|-----------|--------|
| CDF epoch records | **nanoseconds** | TT2000 timestamps in the data files |
| CDF archive filenames | **seconds** | e.g. `psp_flds_l2_mag_rtn_20200101105317_20200101112329.cdf` |
| Inventory endpoint | **seconds** | Built from CDF file catalog (filenames) |
| Audio `FileDescription` | **minutes** | Just echoes back request times (!) |

**The XSD schema (`CDAS.xsd`) uses `xsd:dateTime` for `TimeInterval` Start/End — which supports arbitrary sub-second precision.** The Java backing type is `java.util.Date` (millisecond precision). The IDL client parses with `F06.3` (also millisecond).

**The whole pipeline SUPPORTS milliseconds.** The truncation happens because the **inventory is built from the CDF archive file catalog**, which uses second-precision filenames. It's a data source limitation, not a schema limitation.

Verified in both JSON and XML responses — all inventory timestamps end in `.000Z`:
```json
{ "Start": "2020-01-01T10:53:17.000Z", "End": "2020-01-01T11:23:29.000Z" }
```

The audio endpoint is even worse — `FileDescription` StartTime/EndTime just echo the request:
```json
{ "StartTime": "2020-01-01T10:53:00.000Z", "EndTime": "2020-01-01T11:24:00.000Z" }
```
(We requested 10:53–11:24. Actual data is 10:53:17.571–11:23:29.744.)

### Gap Healing Accuracy Test

**Question:** If we gap-heal using DataIntervals metadata, does the result match a continuous data window of the same duration?

**Method:** Pick a gappy time window and a continuous window of the same duration and cadence. Gap-heal the gappy one. Compare sample counts.

| Test | Gappy Window | Continuous Window | Healed | Expected | Error |
|------|-------------|-------------------|--------|----------|-------|
| Trailing gap (2h) | 01:00–03:00 (data ends 02:03) | 00:00–02:00 | 65,919 | 65,918 | **+1 sample (0.0015%)** |
| Clean data (no burst) | Single 9 Hz block | Same block | 67,739 | 67,738 | **+1 sample** |

**Result: ±1 sample accuracy.** The algorithm works. The remaining error is integer rounding at gap boundaries — one sample of ~109ms cadence.

The 73 Hz PSP startup burst (512 samples at different cadence) adds ~0.3% error when present, but this is a PSP cruise-phase quirk that doesn't affect perihelion data or other spacecraft.

**The algorithm is trivial for an end-user:**
1. Parse `DataIntervals` from response (array of `{Start, End, Samples, CadenceMs}`)
2. Split WAV at cumulative sample offsets
3. Insert `round(gap_seconds / cadence_seconds)` silence samples between blocks
4. Done

### Proposed CDAWeb Enhancement — DATAINTERVAL= STDOUT Lines

**The fix is minimal.** `audio_wav.pro` already has the epoch array (`edat`) with full nanosecond precision. It already communicates with the Java layer via STDOUT `KEY=value` lines (`AUDIO=`, `STATUS=`, `ERROR=`, `WARNING=`, `DATASET=`). We add one more: `DATAINTERVAL=`.

**Change 1 — IDL (`audio_wav.pro`):**

After computing `mytime = edat[rbegin:rend]` (line 536), detect contiguous data blocks by finding epoch steps > 2× median cadence, then print one `DATAINTERVAL=` line per block:

```idl
DATAINTERVAL=start_epoch,end_epoch,samples,cadence_ns
```

Where:
- `start_epoch` / `end_epoch` — TT2000 nanoseconds (or CDF_EPOCH milliseconds, depending on epoch type)
- `samples` — integer count of records in this block
- `cadence_ns` — median time step between consecutive records within this block

**Example output (PSP cruise, 2 blocks + 8.8h gap):**
```
DATAINTERVAL=631108869193929600,631116268114105088,67740,109226752.000000
DATAINTERVAL=631148075494003712,631149878928804352,17408,109226752.000000
```

Continuous data (no gaps) emits exactly one `DATAINTERVAL=` line.

A complete, tested patch is at [`tools/cdaweb_source/audio_wav.pro`](cdaweb_source/audio_wav.pro) (original backed up as `audio_wav_original.pro`).

**Change 2 — Java (CDASWS server):**

The Java layer already parses `AUDIO=`, `STATUS=`, etc. from IDL STDOUT. Add parsing for `DATAINTERVAL=` lines and populate a new `DataIntervals` array in the `FileDescription` response. The Java-side change follows the exact same pattern as existing STDOUT parsing (~10 lines).

**Resulting REST response:**
```json
{
  "FileDescription": [{
    "Name": "...audio.wav",
    "StartTime": "2020-01-01T00:00:00.009Z",
    "EndTime": "2020-01-01T11:23:29.744Z",
    "Length": 171366,
    "DataIntervals": [
      {"Start": "2020-01-01T00:00:00.009Z", "End": "2020-01-01T02:03:18.930Z", "Samples": 67740, "CadenceMs": 109.227},
      {"Start": "2020-01-01T10:53:26.310Z", "End": "2020-01-01T11:23:29.744Z", "Samples": 17408, "CadenceMs": 109.227}
    ]
  }]
}
```

**What the client does with this:**
- Knows exactly how many samples came from each contiguous block
- Can insert precise silence for gaps (or skip them)
- Can display gap markers on spectrogram/waveform
- Can compute correct pitch (knows actual cadence per block)
- Handles variable-rate data cleanly (each interval has its own cadence)
- Backward compatible — existing clients that don't read `DataIntervals` still get the same WAV they always got

This is analogous to how FDSN/IRIS serves seismic data — miniSEED segments with per-segment timing headers.

### Validation

The gap detection algorithm was validated against 5 real CDF datasets using a Python equivalent ([`validate_idl_patch.py`](validate_idl_patch.py)):

| Dataset | Records | Intervals | Cadence | Sample Match | Ordering |
|---------|---------|-----------|---------|-------------|----------|
| PSP Cruise (gappy) | 85,660 | 3 | 9.2 Hz / 73 Hz | Exact | Pass |
| GOES-16 MAG (continuous) | 36,001 | 1 | 10 Hz | Exact | Pass |
| MMS1 EDP Fast | 647,846 | 1 | 32 Hz | Exact | Pass |
| Solar Orbiter MAG | 691,209 | 1 | 8 Hz | Exact | Pass |
| PSP Perihelion E4 | 527,342 | 1 | 146 Hz | Exact | Pass |

Parse-back test (simulating Java parsing of DATAINTERVAL= lines): roundtrip fidelity PASS.

---

## CDASWS Architecture

- **REST API:** Java web service at `cdaweb.gsfc.nasa.gov/WS/cdasr/1/`
- **Schema:** [`CDAS.xsd`](https://cdaweb.gsfc.nasa.gov/WebServices/REST/CDAS.xsd) — defines `TimeInterval`, `InventoryDescription`, `FileDescription`, etc.
- **Java classes:** `gov.nasa.gsfc.spdf.cdas.TimeInterval` (uses `java.util.Date`, ms precision)
- **IDL client:** `SpdfTimeInterval` (Julian Day doubles, ms precision via `F06.3` parsing)
- **Python client:** [`cdasws`](https://pypi.org/project/cdasws/) on PyPI
- **Server source:** NOT publicly available (Java WAR deployed at GSFC)
- **IDL source:** Public at [`cdaweb.gsfc.nasa.gov/pub/software/cdawlib/source/`](https://cdaweb.gsfc.nasa.gov/pub/software/cdawlib/source/)
- **API docs:** [REST](https://cdaweb.gsfc.nasa.gov/WebServices/REST/), [SOAP](https://cdaweb.gsfc.nasa.gov/WebServices/SOAP/public/api/), [Developer's Kit](https://cdaweb.gsfc.nasa.gov/WebServices/DevelopersKit.html)

## Source Code (IDL — Audification)

- [`audio_wav.pro`](cdaweb_source/audio_wav.pro) — CDAWeb's audification routine (evolved from Robert Alexander's original `spdf_audify`)
- [`audiomaster.pro`](cdaweb_source/audiomaster.pro) — Orchestrator that calls `audio_wav`
- Original procedure wrote at 44,100 Hz; current production uses **22,000 Hz**
- Fill value: `FILLVAL` attribute from CDF (NaN for PSP), defaults to 0 if not found

## API Endpoints Used

- **Inventory:** `GET /dataviews/sp_phys/datasets/{dataset}/inventory/{start},{end}` (370–700ms)
- **Audio:** `GET /dataviews/sp_phys/datasets/{dataset}/data/{start},{end}/{var}?format=audio`
- **CDF:** `GET /dataviews/sp_phys/datasets/{dataset}/data/{start},{end}/{var}?format=cdf`
