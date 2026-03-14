# Space Weather Audio — Project Guide

## What This Is
A browser-based tool that sonifies NASA space weather data (magnetometer readings from GOES, PSP, Wind, MMS, THEMIS, Solar Orbiter) into audible frequencies. Users see spectrograms, waveforms, and can annotate features. The **EMIC Wave Analysis Study** (Lauren Blum's research) uses this tool — participants identify electromagnetic ion cyclotron waves in GOES magnetometer data.

## Architecture at a Glance

**No bundler.** Vanilla ES6 modules loaded directly by the browser. Three.js via CDN (`three@0.170.0/build/three.webgpu.js`). No npm, no webpack, no build step.

**Two entry points:**
- `study.html` — Study interface (config-driven via study-flow.js)
- `index.html` — Space Weather Portal (general-purpose sonification tool)

**Data flow:**
```
streaming.js → data-fetcher.js → audio-state.js → audio-player.js → AudioWorklet
                   ↑                                    ↑
            audio-worklet-init.js              (worklet setup, position tracking)
                                      ↓
                              spectrogram-gpu-compute.js → main-window-renderer.js (Three.js WebGPU)
                              waveform-worker.js → minimap-window-renderer.js (Three.js WebGPU)
```

## Key Directories

```
js/              # ES6 modules — all app code lives here
workers/         # Web Workers & AudioWorklets (audio processing, FFT)
cloudflare-worker/ # Cloudflare Worker API (R2 storage, session management)
docs/            # Architecture docs — read these for deep dives
```

## Key Files

| File | What it does |
|------|-------------|
| `js/main-window-renderer.js` | Three.js WebGPU spectrogram (infinite canvas) |
| `js/minimap-window-renderer.js` | Waveform mini-map renderer |
| `js/audio-player.js` | Playback controls, stretch algorithms, gain/speed |
| `js/data-fetcher.js` | CDAWeb API integration, chunk loading |
| `js/study-flow.js` | Config-driven study workflow (modals → analysis → questionnaires) |
| `js/ui-modals.js` | Modal open/close, overlay, questionnaire wiring |
| `js/feature-tracker.js` | Feature annotation — drawing, editing, selection |
| `js/keyboard-shortcuts.js` | All keyboard handlers (Space, Enter, Escape, arrows, undo) |
| `js/main.js` | App orchestrator — init, event wiring, mode routing |
| `js/ui-controls.js` | Settings, spacecraft/dataset selectors |
| `js/audio-worklet-init.js` | AudioWorklet setup, position tracking, oscilloscope |
| `js/modal-templates.js` | Modal HTML templates |
| `js/streaming.js` | Data fetch orchestration, spacecraft dropdown labels |
| `js/status-text.js` | Status bar typing animations, setStatusText, cancelTyping |

## Mode System (`master-modes.js`)

Two modes, determined by which page loads:
- **Study** — `study.html` sets `window.__STUDY_MODE = true`. Check with `isStudyMode()`.
- **Space Weather Portal** — `index.html` (default, no flag needed).

`isLocalEnvironment()` detects localhost for dev-only features.

## Study Flow

`study-flow.js` is config-driven: study configs define a sequence of steps (modals, analysis phases, questionnaires). The flow is: Registration → Welcome → Data loads → Draw features → Complete → Questionnaire modals → Submit.

**Key modules:**
- `data-uploader.js` — Uploads submissions to R2
- `participant-id.js` — ID from URL params or localStorage

## GPU Rendering Stack

Three.js WebGPU with TSL (Three Shading Language), not GLSL:
- `MeshBasicNodeMaterial` + `colorNode` (not `ShaderMaterial`)
- `renderAsync()` (not `render()`)
- Shared device: `renderer.backend.device`
- Import from `three/webgpu` only (never `three` separately — causes duplicates)
- `spectrogram-pyramid.js` — GPU cascade downsampling, zero CPU readback
- `spectrogram-gpu-compute.js` — WebGPU compute shader FFT
- `wavelet-gpu-compute.js` — WebGPU wavelet transform

## Centralized State (`audio-state.js`)

Single source of truth for playback state, audio context, gain nodes, stretch settings, current position. Every playback/visualization module imports from here. Don't create local state for things that belong in audio-state.

## Critical Patterns

- **DataTexture packing:** Row-major. `data[freqBin * numTimeSlices + timeSlice]`
- **`THREE.RedFormat` + `FloatType`** for single-channel data textures
- **`preserveDrawingBuffer: true`** needed for `drawImage`/`toDataURL` on WebGL canvas
- **`getContext('2d')` returns null** on a WebGL canvas — always null-check
- **Dynamic imports** for code splitting between modes
- **Console print gates:** `window.pm` object controls debug logging. Toggled via checkboxes in the hamburger menu (Settings drawer → Prints section). Categories: `init`, `gpu`, `memory`, `audio`, `study_flow`, `features`, `data`, `cache`, `interaction`. Gate logs with `if (window.pm?.category)` before `console.log()`. Defined in `settings-drawer.js`, wired in `advanced-controls.js`.

## Web Workers

Located in `workers/`:
- `audio-worklet.js` — Real-time playback (stretch, gain, filtering)
- `spectrogram-worker.js` / `waveform-worker.js` — Visualization computation
- `*-stretch-processor.js` — 4 stretch algorithm implementations
- `kissfft-wasm-loader.js` — WASM FFT module

## Testing & Running

- **Dev server:** `python dev_server.py` (serves on localhost)
- **No test framework configured** — test by loading in browser
- **Version auto-refresh:** `version.json` is auto-updated on commits; the app polls it

## Work Style

- **Spin up parallel agents** when a task involves multiple independent files or sections. One agent per file, all running simultaneously, verify integrity after. Much faster than sequential.
- Separate unrelated changes into different commits for clean reverts

## Git Conventions

- Never include AI attribution in commits or pushes
- The `_recovery/` folder is gitignored scratch space
