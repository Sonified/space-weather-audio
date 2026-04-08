# Architecture Reference

Read this file when you need details about API routes, key files, database schema, or participant IDs.

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
| `js/status-text.js` | Status bar typing animations |
| `js/participant-id.js` | Participant ID generation |
| `study-builder.html` | Study config builder (inline JS) |
| `data-viewer.html` | Participant data explorer (inline JS) |
| `cloudflare-worker/src/index.js` | Cloudflare Worker — all API endpoints |

## Key Directories

```
js/              # ES6 modules — all app code
workers/         # Web Workers & AudioWorklets (audio processing, FFT)
cloudflare-worker/ # Cloudflare Worker API (R2, D1, session management)
docs/            # Architecture deep-dive docs
homestretch/     # Per-task investigation docs (HSxx.md files)
```

## API Routes (Cloudflare Worker)

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/study/:id/config` | GET/POST | Load/save study config |
| `/api/study/:id/assign` | POST | Assign participant to condition |
| `/api/study/:id/participants` | GET | List participants with features (supports `?session=SESSION_ID`) |
| `/api/study/:id/dashboard` | GET | Live session stats, algorithm state |
| `/api/study/:id/snapshot` | GET/POST | List/save frozen config snapshot to R2 |
| `/api/study/:id/assignment-state` | POST | Upload pre-computed block table |
| `/api/study/:id/heartbeat` | POST | Participant heartbeat for dropout detection |
| `/api/study/:id/start-session` | POST | Create new test or live session |
| `/api/study/:id/end-session` | POST | End a session |
| `/api/verify-admin` | POST | Admin key verification with backoff lockout |

## D1 Database

Binding: `DB`, name: `study-db`. Schema canonical in migration `0010_clean_rebuild.sql`.

| Table | Purpose |
|-------|---------|
| `studies` | Study configs (id, name, config JSON, admin_key) |
| `participants` | Participant state (participant_id + study_id = composite PK, group_id links to session) |
| `features` | Drawn feature annotations (UUID id, start/end time, low/high freq, confidence, notes) |
| `assignment_sessions` | Test/live session tracking (assignment_state JSON holds block table) |

## R2 Buckets

- `space-weather-audio` (binding: `BUCKET`) — general storage, config snapshots
- `emic-data` (binding: `EMIC_DATA`) — study participant data uploads

## Participant & Session IDs

- **Participant prefixes:** `P_` (live), `TEST_` (test), `PREVIEW_` (preview)
- **Session prefixes:** `STUDY_` (live), `TEST_` (test)
- **Format:** `{PREFIX}_{YYYYMMDD}_{HHMM}_{5chars}` via `generateParticipantId()` in `js/participant-id.js`

## Gotchas & Footguns

- **DataTexture packing:** Row-major. `data[freqBin * numTimeSlices + timeSlice]`. NOT column-major.
- **Single-channel textures:** Must use `THREE.RedFormat` + `FloatType`. Not RGBA.
- **2D context on WebGL canvas:** `getContext('2d')` returns null on a canvas that already has a WebGL context. Always null-check.
- **Debug logging:** Gated by `window.pm?.category` (toggled in Settings drawer → Prints). Use `if (window.pm?.audio) console.log(...)` not raw `console.log`.
- **Study builder inline JS:** `study-builder.html` and `data-viewer.html` have ALL JS in `<script>` tags — not in the `js/` module system. Don't look for their code in `js/`.
- **`preserveDrawingBuffer: true`** needed on WebGL canvas for `drawImage`/`toDataURL` to work.
- **Three.js imports:** Always from `three/webgpu` only. Importing `three` separately causes duplicate class issues.
- **`renderAsync()`** not `render()` for WebGPU renderer.

## Web Workers

Located in `workers/`:
- `audio-worklet.js` — Real-time playback (stretch, gain, filtering)
- `spectrogram-worker.js` / `waveform-worker.js` — Visualization computation
- `*-stretch-processor.js` — 4 stretch algorithm implementations
- `kissfft-wasm-loader.js` — WASM FFT module

## Study Flow

`study-flow.js` is config-driven: study configs define a sequence of steps. Flow: Registration → Welcome → Data loads → Draw features → Complete → Questionnaire modals → Submit.

Key modules: `data-uploader.js` (R2 uploads), `participant-id.js` (ID generation), `study-builder.html` and `data-viewer.html` (monolithic inline JS admin pages).
