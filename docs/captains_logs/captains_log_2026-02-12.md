# Captain's Log - 2026-02-12

## Massive Dataset Expansion: Electric Fields + 6 New Spacecraft

The biggest single-day expansion of spaceweather.now.audio to date. What started as a response to Lynn Wilson's email asking for electric field data turned into a full fleet buildout. The interface went from 6 spacecraft with mag-only data to **12 spacecraft with 48 datasets** spanning magnetic field, electric field, and search coil magnetometer instruments.

---

## The Catalyst

Lynn Wilson (Wind Project Scientist, NASA GSFC) emailed on Jan 14, 2026 asking:
> "Any chance you could add electric field data too? Also, I think several of these spacecraft have both SCM and FGM data."

Challenge accepted.

---

## Electric Field + SCM Added to Existing Spacecraft

### MMS (Magnetospheric Multiscale)

Added 5 new datasets to the existing MMS entry:

| Dataset | Variable | Type | Notes |
|---------|----------|------|-------|
| `MMS1_EDP_SLOW_L2_DCE` | `mms1_edp_dce_gse_slow_l2` | E-Field (DC, Slow Survey) | Continuous coverage |
| `MMS1_EDP_FAST_L2_DCE` | `mms1_edp_dce_gse_fast_l2` | E-Field (DC, Fast Survey) | Continuous coverage |
| `MMS1_EDP_BRST_L2_DCE` | `mms1_edp_dce_gse_brst_l2` | E-Field (DC, Burst) | Only during magnetospheric events |
| `MMS1_SCM_SRVY_L2_SCSRVY` | `mms1_scm_acb_gse_scsrvy_srvy_l2` | Search Coil (Survey) | Continuous |
| `MMS1_SCM_BRST_L2_SCB` | `mms1_scm_acb_gse_scb_brst_l2` | Search Coil (Burst) | Only during events |

**Burst data caveat:** MMS burst mode only activates during specific magnetospheric events (reconnection, magnetopause crossings, etc.). Added a user-facing warning message in the status bar when burst data is requested for a time range with no burst coverage: *"MMS burst data is not available for this time range. Burst mode only activates during specific magnetospheric events. Try a different time period or use Survey/Fast mode instead."*

Testing confirmed burst datasets work using Robert's own Dec 9, 2016 reconnection event (the same event from the Lynn Wilson email thread).

### THEMIS (A-E)

Added Electric Field Instrument (EFI) for all 5 probes:

| Dataset | Variable |
|---------|----------|
| `THA_L2_EFI` | `tha_efs_dot0_gse` |
| `THB_L2_EFI` | `thb_efs_dot0_gse` |
| `THC_L2_EFI` | `thc_efs_dot0_gse` |
| `THD_L2_EFI` | `thd_efs_dot0_gse` |
| `THE_L2_EFI` | `the_efs_dot0_gse` |

Note: The key variable is `efs` (slow survey), not `eff` (fast survey). The fast survey variable failed in testing.

### Parker Solar Probe

| Dataset | Variable | Type |
|---------|----------|------|
| `PSP_FLD_L2_DFB_WF_DVDC` | `psp_fld_l2_dfb_wf_dVdc_sensor` | DC Voltage Waveform |

### Solar Orbiter

| Dataset | Variable | Type |
|---------|----------|------|
| `SOLO_L2_RPW-LFR-SURV-CWF-E` | `EDC` | RPW LFR Electric Field |

---

## 6 New Spacecraft Added

### ACE (Advanced Composition Explorer)
- **Location:** L1 Lagrange point
- **Dataset:** `AC_H3_MFI` -> `BGSEc` (1-sec magnetic field, GSE)
- The workhorse L1 solar wind monitor

### DSCOVR (Deep Space Climate Observatory)
- **Location:** L1 Lagrange point
- **Dataset:** `DSCOVR_H0_MAG` -> `B1GSE` (1-sec fluxgate magnetometer, GSE)
- Successor to ACE for real-time space weather forecasting

### Cluster (C1-C4)
ESA's 4-spacecraft constellation, studying Earth's magnetosphere in 3D.

**Magnetic Field (FGM) - 5 vectors/sec:**
| Dataset | Variable |
|---------|----------|
| `C1_CP_FGM_5VPS` | `B_vec_xyz_gse__C1_CP_FGM_5VPS` |
| `C2_CP_FGM_5VPS` | `B_vec_xyz_gse__C2_CP_FGM_5VPS` |
| `C3_CP_FGM_5VPS` | `B_vec_xyz_gse__C3_CP_FGM_5VPS` |
| `C4_CP_FGM_5VPS` | `B_vec_xyz_gse__C4_CP_FGM_5VPS` |

**Magnetic Field (STAFF Search Coil Waveforms):**
| Dataset | Variable |
|---------|----------|
| `C1_CP_STA_CWF_GSE` | `B_vec_xyz_Instrument__C1_CP_STA_CWF_GSE` |
| `C2_CP_STA_CWF_GSE` | `B_vec_xyz_Instrument__C2_CP_STA_CWF_GSE` |
| `C3_CP_STA_CWF_GSE` | `B_vec_xyz_Instrument__C3_CP_STA_CWF_GSE` |
| `C4_CP_STA_CWF_GSE` | `B_vec_xyz_Instrument__C4_CP_STA_CWF_GSE` |

**Electric Field (EFW):**
| Dataset | Variable |
|---------|----------|
| `C1_CP_EFW_L3_E3D_INERT` | `E_Vec_xyz_ISR2__C1_CP_EFW_L3_E3D_INERT` |
| `C2_CP_EFW_L3_E3D_INERT` | `E_Vec_xyz_ISR2__C2_CP_EFW_L3_E3D_INERT` |
| `C3_CP_EFW_L3_E3D_INERT` | `E_Vec_xyz_ISR2__C3_CP_EFW_L3_E3D_INERT` |
| `C4_CP_EFW_L3_E3D_INERT` | `E_Vec_xyz_ISR2__C4_CP_EFW_L3_E3D_INERT` |

Note: EFW data is in ISR2 (Inverted Spin Reference 2) frame, not GSE. Component labels set to Ex/Ey/Ez (ISR2).

### Geotail
- **Magnetic Field:** `GE_EDB3SEC_MGF` -> `BGSE` (Editor-B, 3-sec, GSE)
- **Electric Field:** `GE_K0_EFD` -> `Es` (2 components only: E-sunward, E-duskward)
- Note: Editor-A dataset (GE_EDA3SEC_MGF) returned "no data available" across all tested dates. Editor-B works.

### Voyager 1
- **Dataset:** `VOYAGER1_2S_MAG` -> `B1` (1.92-sec, Heliographic coords: BR, BT, BN)
- **Coverage:** 1977-1991 only (planetary encounter era)
- Does NOT cover the 2012 heliopause crossing (would need 48-sec dataset for that)

### Voyager 2
- **Dataset:** `VOYAGER2_2S_MAG` -> `B1` (1.92-sec, Heliographic coords: BR, BT, BN)
- **Coverage:** 1977-1991 only (planetary encounter era)
- Does NOT cover the 2018 heliopause crossing

---

## UI Improvements

### Optgroup Headers in Dataset Dropdown
All spacecraft now use `<optgroup>` headers to visually separate instrument types:
- "Magnetic Field" / "Magnetic Field (FGM)" / "Magnetic Field (Search Coil)" always on top
- "Electric Field" / "Electric Field (EDP)" / "Electric Field (EFW)" below
- Non-clickable group labels, native HTML rendering across all browsers

### Burst Data User Warning
When a user selects an MMS burst dataset and the requested time range has no burst data, the status bar displays a clear warning instead of a generic error.

---

## What Didn't Work

### Wind Electric Field
Exhaustive search of all Wind datasets on CDAWeb. The WAVES instrument (WI_H1_WAV, WI_H2_WAV, WI_K0_WAV, etc.) stores **spectral/frequency-domain data** (radio receiver voltages across frequency bands), not time-series waveforms. The CDAWeb audio API requires 1-D time series to generate WAVs. Wind has no electric field time-series dataset on CDAWeb. Lynn Wilson (Wind Project Scientist) is the right person to confirm whether one exists elsewhere.

### MMS EDP HMFE (High-Frequency Burst)
Tested but timed out / returned no audio. The extremely high cadence may exceed what the audio API can handle.

### Geotail Editor-A (GE_EDA3SEC_MGF)
Returns "no data available" for all tested time ranges. Possible data gap or access issue. Editor-B works fine.

---

## Files Modified

1. **`js/data-fetcher.js`** - Added 27 new entries to `DATASET_VARIABLES` mapping (now 48 total). Added burst data warning logic for MMS datasets.
2. **`js/ui-controls.js`** - Added 6 new spacecraft to `SPACECRAFT_DATASETS`. Restructured all entries to use optgroup format with `{ group: 'label' }` headers. Updated `updateDatasetOptions()` to render `<optgroup>` elements.
3. **`js/component-selector.js`** - Added component labels for new spacecraft. Added `DATASET_COMPONENT_LABELS` for instrument-specific labels (Cluster EFW in ISR2, Geotail EFD, Voyager HG coords).
4. **`index.html`** - Added 6 new `<option>` entries to spacecraft select.

## Spacecraft Dropdown Order (Final)
PSP, Wind, MMS, THEMIS, SolO, GOES, ACE, DSCOVR, Cluster, Geotail, Voyager 1, Voyager 2

---

## UI/Visual Polish

### Loading Animation
Ported the animated loading indicator from volcano.now.audio. When fetching data from CDAWeb, the status bar now shows:
- Animated shimmer gradient + diagonal stripe pattern
- Pulsing text with animated dots ("Fetching PSP PSP_FLD_L2_MAG_RTN from CDAWeb." → ".." → "...")
- Auto-cleanup on completion or error

### Status Text Size Bouncing Fix
The status bar text was jumping between font sizes during the loading animation. Root cause: `status-auto-resize.js` had a `MutationObserver` that fired every 500ms (on each dot update), resetting font to 16px then shrinking it back down. Also, `setStatusText` calls during loading flipped the CSS class from `loading` (font-weight 700) to `info` (font-weight 600).

Fix:
- Auto-resize observer now skips entirely when `loading` class is present
- Loading interval re-asserts the `loading` class to prevent external class changes

### Contrast & Theme Improvements
- Page background now matches the colormap theme via `--page-bg` CSS variable
  - Solar: warm red-brown (`#3a2b2b`), Turbo: cool blue (`#2b303a`), Aurora: purple (`#332b3a`), etc.
- Visualization panel backgrounds (`--accent-bg`) lightened for better contrast hierarchy
- Solar theme panel darkened from brown to deep red-black (`#1a0f0a` → `#100805`) to avoid "poop brown"
- Waveform and spectrogram displays set to true black (`#000000`) for maximum colormap contrast
- Panel borders set to theme-independent white (`rgba(255,255,255,0.12)`)
- Spectrogram gets `inset box-shadow` for depth

### Component Labels
- Added Cluster and DSCOVR to `COMPONENT_LABELS` (were falling through to "Component 1, 2, 3")

### Scroll Fix
- Removed conflicting `overflow-y: auto` from `html` (body already has `overflow-y: scroll`)
- Dual overflow declarations were causing janky scroll resistance

### Minor Fixes
- "Recent:" label color matched to other labels (inherits panel style)
- "Recent:" label font-size preserved at 13px
- Recent search dropdown text left-aligned, slightly gray (`#888`)

---

## The Great Overlay Debugging Saga (Evening Session)

### The Bug
Waveform playhead and region highlights were rendering 2px too low — not reaching the top of the black waveform area and spilling 2px past the bottom edge. The spectrogram playhead was perfectly aligned, which made the waveform issue even more maddening.

### The 45-Minute Journey
What followed was an embarrassingly long debugging session involving ~8 failed fix attempts pushed directly to production (lesson learned). The approaches tried:

1. **Compensate for waveform border in overlay sizing** — made it worse
2. **Switch waveform `border` to `outline`** — no change
3. **Use `clientWidth`/`clientHeight`** — wrong direction
4. **Remove border entirely, use `box-shadow`** — no change
5. **Subtract parent panel's `clientTop`** — partially worked
6. **Copy spectrogram-playhead.js approach exactly** — still broken
7. **Add debug lines (green=top, red=bottom)** — pushed to production with users on it 🤦
8. **The actual fix: `offsetTop + clientTop` for position, `clientWidth/Height` for size**

### Root Cause
Every failed attempt used `getBoundingClientRect()` to compute overlay position. The problem: `getBoundingClientRect()` returns coordinates relative to the viewport's border-box edge, but `position: absolute` places elements relative to the containing block's **padding edge**. The panel has a 2px border, creating a persistent 2px offset that no amount of subtraction gymnastics could cleanly fix.

The spectrogram playhead had the same 2px offset, but its own 2px border masked it visually. The waveform's border masked the top but not the bottom.

### The Fix
Use `offsetTop`/`offsetLeft` (already in the correct coordinate space for absolute positioning) plus `clientTop`/`clientLeft` (to skip the waveform's own border). Size the overlay with `clientWidth`/`clientHeight` (content area only, no border). Zero `getBoundingClientRect()` math needed.

```javascript
// Before (broken): viewport coords → manual border subtraction → still wrong
const canvasRect = waveformCanvas.getBoundingClientRect();
const parentRect = parent.getBoundingClientRect();
overlay.style.top = (canvasRect.top - parentRect.top) + 'px';

// After (works): already in the right coordinate space
overlay.style.top = (waveformCanvas.offsetTop + waveformCanvas.clientTop) + 'px';
overlay.style.height = waveformCanvas.clientHeight + 'px';
```

### Lessons Learned
1. **Don't push debug visuals to production.** Work on a branch or test locally.
2. **Don't guess — diagnose.** Should have added debug lines on attempt #1, not attempt #7.
3. **`getBoundingClientRect()` vs `offsetTop`**: rect is viewport-relative; offset is offsetParent-relative. For `position: absolute`, use offset properties.
4. **`offsetHeight` vs `clientHeight`**: offset includes border; client excludes it. When overlaying content *inside* a bordered element, use client dimensions.
5. **When something works (spectrogram), understand *why* before copying it.** The spectrogram's border was masking the same bug.

---

## Process Notes

This work was done collaboratively with Nova (OpenClaw AI assistant) using parallel sub-agents. The initial electric field integration was handled by a single agent. The new spacecraft additions were parallelized across 5 simultaneous agents (ACE, DSCOVR, Cluster, Geotail, Voyagers), each independently testing the CDAWeb audio API and integrating confirmed-working datasets. Total wall-clock time for the full expansion: approximately 45 minutes.
