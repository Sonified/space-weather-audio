# Work Plan — Active Bugs

Ground rules this round:
- No "fixed!" claims without a printed before/after from the browser.
- One bug at a time, in order.
- Robert runs the browser, Claude reads the logs Robert pastes.
- Add diagnostic prints FIRST. Understand the data path, then fix.

---

## Bug 1 — Waveform shows DC-removed samples, should show original

**Expected:** waveform display shows the *original* time series (with DC drift intact) while playback uses the DC-removed + normalized version. User wants to *see* the raw signal while *hearing* the cleaned one.

**Actual:** waveform shows the DC-removed version. Previous agent claimed "fixed" multiple times without ever verifying — never printed what the waveform worker actually received.

**Why this one first:** single data path, and fixing it forces us to map exactly how samples flow from `data-fetcher.js` → playback vs → waveform worker. That knowledge unlocks Bug 2.

**Diagnostic plan (do this BEFORE any fix):**
1. Print at the branch point in `js/data-fetcher.js` — the moment `audioData.samples` and `window._playbackSamples` diverge. Log `samples[0..5]` and mean for both.
2. Print at the waveform worker entry — whatever `postMessage` hands it. Log `samples[0..5]` and mean.
3. Print at `State.setCompleteSamplesArray` call site — what goes into playback.
4. Robert reloads, pastes the three log blocks. Now we *know* which branch the waveform is eating.

**Only then** edit the branch that's wrong.

---

## Bug 2 — Switching components then switching back loads data differently

**Expected:** Br → Bt → Br should leave Br identical to its first load.

**Actual:** something changes on the round-trip. Robert to specify *which* surface looks different (audio? waveform? spectrogram?) once we're on this bug.

**Likely suspects (to verify, not assume):**
- Stale `window._playbackSamples` / `window.rawWaveformData` from the prior component bleeding into the new one.
- `switchComponent` re-running DC removal on already-processed samples (double detrend).
- Cached state in `audio-state.js` not cleared between components.

**We tackle this after Bug 1 because** the Bug 1 diagnostic prints will already have mapped the load path — we'll re-use the same prints inside `switchComponent` to see what changes on the round-trip.

---

## Bug 3 — De-tone is too aggressive, removing data not just tones

**Symptom:** The de-tone pipeline is filtering more than just the spacecraft spin tones — real signal is getting eaten.

**Not starting this yet.** Flagged so we don't forget. Likely levers when we get here:
- Detection: `TONALITY_THRESH` in `workers/denoise-detect-worker.js` (currently 10 dB — maybe too permissive).
- Notch width: `MASK_HALF_WIDTH` / notch Q in the WASM filter.
- Frame count threshold (min run length before a "tone" is committed).

Defer until Bugs 1 & 2 are actually verified-fixed.
