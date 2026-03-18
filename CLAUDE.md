# Space Weather Audio — Project Guide

## What This Is
A browser-based tool that sonifies NASA space weather data (magnetometer readings from GOES, PSP, Wind, MMS, THEMIS, Solar Orbiter) into audible frequencies. Users see spectrograms, waveforms, and can annotate features. The **EMIC Wave Analysis Study** (Lauren Blum's research) uses this tool — participants identify electromagnetic ion cyclotron waves in GOES magnetometer data.

## Homestretch — Task-Specific Architecture Docs

The `homestretch/` folder contains **per-task architectural investigation documents** for all remaining items on the SHIP_IT.md TODO list. Each file is self-contained with:
- Task description from SHIP_IT.md
- Relevant file paths and line numbers
- Root cause analysis (for bugs)
- Proposed fixes and implementation plans

**Before working on any HS item, read its `homestretch/HSxx.md` file first.** It will give you the full architectural context so you can start coding immediately.

Files: `HS1.md`, `HS3.1.md`, `HS3.2.md`, `HS7.1.md`, `HS16.md`, `HS22.md`, `HS23.md`, `HS24.md`, `HS25.md`, `HS26.md`, `HS27.md`, `HS28.md`, `HS29.md`, `HS31.md`, `HS32.md`, `HS33.md`, `HS34.md`, `HS35.md`

**Key reference files:**
- `SHIP_IT.md` — canonical TODO list (the homestretch task tracker)
- `TODO-study.md` — additional study TODOs
- `stretch_test.html` — working stretch algorithm comparison page (3500+ lines, proof of concept for chunked wavelet pipeline)

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

## Server Infrastructure (Cloudflare)

**Worker:** `cloudflare-worker/src/index.js` — single Worker handles all API routes
- **Deploy:** `cd cloudflare-worker && npx wrangler@4 deploy` (use wrangler@4, not v3 — v3 has auth issues with D1)
- **Migrations:** `npx wrangler@4 d1 migrations apply study-db --remote` (migrations live in `cloudflare-worker/migrations/`)
- **Config:** `cloudflare-worker/wrangler.toml`
- **Secrets:** admin keys set via `wrangler secret put` — NOT in wrangler.toml

**Production domain:** `https://spaceweather.now.audio` — serves both static site and API routes
- API calls from the app use `spaceweather.now.audio` as base URL (not a separate API subdomain)
- There is NO `api.spaceweather.now.audio` — don't try it, DNS won't resolve
- The workers.dev domain exists but the app uses the custom domain

**D1 Database** (binding: `DB`, name: `study-db`, id: `11e25f65-bd80-4a0d-a0e2-6d774ee11e8b`):
- `studies` — study configs (id, name, config JSON, admin_key). Preserved across data nukes.
- `participants` — participant state (participant_id + study_id = composite PK, group_id links to session, responses stored as JSON string, step_history as JSON array)
- `features` — drawn feature annotations (UUID id, participant_id, study_id, analysis_session integer, start/end time, low/high freq, confidence, notes, speed_factor)
- `assignment_sessions` — test/live session tracking (session_id PK, study_id, mode `test`|`live`, assignment_state JSON holds the block table + algorithm state)
- Column `group_id` on participants = which assignment_session they belong to (renamed from session_id in migration 0010)
- **Schema is canonical in migration 0010** (`0010_clean_rebuild.sql`) — if in doubt about column names, read that file

**R2 Buckets:**
- `space-weather-audio` (binding: `BUCKET`) — general storage, config snapshots at `study_snapshots/{slug}/{sessionId}.json`
- `emic-data` (binding: `EMIC_DATA`) — EMIC study participant data uploads (submissions, feature JSONs)

**Participant ID prefixes:** `P_` (live), `TEST_` (test), `PREVIEW_` (preview) — all use format `{PREFIX}_{YYYYMMDD}_{HHMM}_{5chars}` via `generateParticipantId()` in `js/participant-id.js`
**Session ID prefixes:** `STUDY_` (live), `TEST_` (test) — format `{PREFIX}_{slug}_{YYYYMMDD}_{HHMM}_{5chars}`

**Key API routes:**
- `POST /api/study/:id/config` — save study config
- `GET /api/study/:id/config` — load study config
- `POST /api/study/:id/assign` — assign participant to condition (healing block algorithm)
- `GET /api/study/:id/participants` — list all participants with features joined. Supports `?session=SESSION_ID` filter
- `GET /api/study/:id/dashboard` — live session stats, algorithm state, active/inactive/completed counts
- `POST /api/study/:id/snapshot` — save frozen config snapshot to R2 (fires on study launch)
- `GET /api/study/:id/snapshot` — list all snapshots for a study
- `POST /api/study/:id/assignment-state` — upload pre-computed block table (from study builder)
- `POST /api/study/:id/heartbeat` — participant heartbeat for dropout detection
- `POST /api/verify-admin` — admin key verification with exponential backoff lockout
- `POST /api/study/:id/start-session` — create new test or live session
- `POST /api/study/:id/end-session` — end a session

**Debugging the server:**
- `curl -s "https://spaceweather.now.audio/api/study/SLUG/participants" | python3 -m json.tool` — quick data check
- `curl -s "https://spaceweather.now.audio/api/study/SLUG/snapshot"` — verify snapshots exist
- D1 console: `npx wrangler@4 d1 execute study-db --remote --command "SELECT COUNT(*) FROM participants"`

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
| `js/participant-id.js` | Participant ID generation (`generateParticipantId(prefix)`) |
| `study-builder.html` | Study config builder — conditions, randomization, launch/end, data panel |
| `data-viewer.html` | Participant data explorer — responses, features, export |
| `cloudflare-worker/src/index.js` | Cloudflare Worker — all API endpoints, assignment algorithm |

## Mode System (`master-modes.js`)

Two modes, determined by which page loads:
- **Study** — `study.html` sets `window.__STUDY_MODE = true`. Check with `isStudyMode()`.
- **Space Weather Portal** — `index.html` (default, no flag needed).

`isLocalEnvironment()` detects localhost for dev-only features.

## Study Flow

`study-flow.js` is config-driven: study configs define a sequence of steps (modals, analysis phases, questionnaires). The flow is: Registration → Welcome → Data loads → Draw features → Complete → Questionnaire modals → Submit.

**Key modules:**
- `data-uploader.js` — Uploads submissions to R2
- `participant-id.js` — `generateParticipantId(prefix)` creates `{PREFIX}_{YYYYMMDD}_{HHMM}_{5chars}`. ID from URL params or localStorage
- `study-builder.html` — Monolithic admin page: study config, conditions, randomization, launch/end, data panel. All JS is inline (not in `js/`)
- `data-viewer.html` — Participant data explorer with admin gate, also monolithic inline JS

**Study builder pages:** `study-builder.html` and `data-viewer.html` are large self-contained HTML files with all JS inline — they do NOT use the `js/` module system. When editing these, you're working in `<script>` tags inside HTML.

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
