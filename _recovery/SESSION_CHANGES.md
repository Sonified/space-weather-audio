# Recovery: Claude Session Changes (Feb 26, 2026)

## Status
- **Worker files**: FULLY RECOVERED in `_recovery/workers/` (still on disk, copied)
- **stretch_test.html**: CANNOT fully reconstruct — I was editing a version already modified by another AI session. My changes are documented below for reapplication.

## Files Modified

### 1. workers/paul-stretch-processor.js ✅ RECOVERED
### 2. workers/granular-stretch-processor.js ✅ RECOVERED
### 3. workers/resample-stretch-processor.js ✅ RECOVERED
### 4. workers/spectral-stretch-processor.js ✅ RECOVERED

All four workers: Added hard-stop logic to `load-audio` handler to prevent race conditions when switching files during playback:
```js
case 'load-audio':
    // Hard stop any in-progress playback/fades before loading new audio
    this.isPlaying = false;
    this.pendingPause = false;
    this.pendingSeekPosition = null;
    this.fadeOutRemaining = 0;
    this.fadeInRemaining = 0;
    // ... rest of load-audio handler unchanged
```

### 5. stretch_test.html — CHANGES LOG (for reapplication)

The base I was editing had already been restructured by another AI (optgroups in algorithm select, param-zone layout, etc.). Here are ALL my changes:

---

#### A. Stretch Factor Formula — 0.1x to 20x range
**sliderToStretch function:**
```js
// slider 0-1000 → stretch 0.1x-20x  (slider 435 ≈ 1x)
// f(x) = 0.1 * 200^(x/1000)
function sliderToStretch(sliderValue) {
    return 0.1 * Math.pow(200, sliderValue / 1000);
}
```

**Slider default value:** `value="435"` (not 500 or 151)

**Tick marks (full HTML):**
```html
<div style="font-size: 0.65em; color: #888; margin-top: 6px; position: relative; height: 12px;">
    <span style="position:absolute; left:calc(10px); transform:translateX(-50%);">0.1x</span>
    <span style="position:absolute; left:calc(10px + 22px); color:#555; font-size:11px;">Shorter</span>
    <span style="position:absolute; left:17.3%; transform:translateX(-50%); color:#555;">.25x</span>
    <span style="position:absolute; left:30%; transform:translateX(-50%);">0.5x</span>
    <span style="position:absolute; left:38.2%; transform:translateX(-50%); color:#555;">.75x</span>
    <span style="position:absolute; left:43.5%; transform:translateX(-50%);">1x</span>
    <span style="position:absolute; left:51.2%; transform:translateX(-50%); color:#555;">1.5x</span>
    <span style="position:absolute; left:57%; transform:translateX(-50%);">2x</span>
    <span style="position:absolute; left:64.3%; transform:translateX(-50%); color:#555;">3x</span>
    <span style="position:absolute; left:69.6%; transform:translateX(-50%); color:#555;">4x</span>
    <span style="position:absolute; left:74%; transform:translateX(-50%);">5x</span>
    <span style="position:absolute; left:87%; transform:translateX(-50%);">10x</span>
    <span style="position:absolute; right:calc(10px + 22px); color:#555; font-size:11px;">Longer</span>
    <span style="position:absolute; left:calc(100% - 10px); transform:translateX(-50%);">20x</span>
</div>
```

---

#### B. Algorithm/Window/Overlap controls — no flex expansion
All three controls in the top row had: `style="flex: none; min-width: auto;"` to keep them snug next to each other instead of stretching.

Same for windowGroup and overlapGroup in the param-zone.

---

#### C. GPU Badge styling (dimmed)
```css
#gpuBadge {
    color: rgba(91, 168, 160, 0.55);
    font-size: 15px;
    font-weight: 500;
    background: rgba(91, 168, 160, 0.07);
    padding: 0 8px;
    border-radius: 3px;
    border: 1px solid rgba(91, 168, 160, 0.1);
    align-self: stretch;
    display: inline-flex;
    align-items: center;
}
```

---

#### D. Wavelet optgroup label
Changed from `"Wavelet (Offline)"` to `"Wavelet (GPU Accelerated)"`

---

#### E. Algorithm select — no flex:1 on wrapper
The div wrapping `#algorithmSelect` should NOT have `flex: 1` — just `<div>` so GPU badge sits right next to it. Gap reduced to 8px.

---

#### F. Stats Panel — shown for ALL modes, not just offline
**New `updateStats` helper function** (added before initAudio):
```js
function updateStats(opts = {}) {
    if (!sourceBuffer) return;
    const stretchFactor = opts.stretchFactor || sliderToStretch(parseFloat(stretchSlider.value));
    const inputDuration = sourceBuffer.length / sourceSampleRate;
    const outputDuration = inputDuration * stretchFactor;
    const wavSize = 44 + Math.ceil(sourceBuffer.length * stretchFactor) * 2;

    if (opts.processingMs != null) {
        const ms = opts.processingMs;
        document.getElementById('statTotal').textContent = ms < 1000 ? ms.toFixed(0) + 'ms' : (ms / 1000).toFixed(2) + 's';
    } else {
        document.getElementById('statTotal').textContent = 'Real-time';
    }
    const realtimeRatio = opts.processingMs != null ? (opts.processingMs / 1000) / inputDuration : null;
    document.getElementById('statRealtime').textContent = realtimeRatio != null ? realtimeRatio.toFixed(2) + 'x' : '-';
    document.getElementById('statLength').textContent = outputDuration.toFixed(1) + 's';
    document.getElementById('statSize').textContent = wavSize > 1048576 ? (wavSize / 1048576).toFixed(1) + ' MB' : (wavSize / 1024).toFixed(0) + ' KB';
    document.getElementById('statsPanel').style.display = '';
}
```

**Called from:**
- `loadAudioFile` after loading (no processingMs → shows "Real-time")
- `runOfflineStretch` after processing: `updateStats({ processingMs: elapsed })`
- Stretch slider input handler: `updateStats({ stretchFactor: stretch })`

**Offline render replaced** inline stats code with just: `updateStats({ processingMs: elapsed });`

**Removed** the render timing status message (`setStatus(...rendered in...)`) — replaced with just `setStatus(playingStatus(), 'active')`

---

#### G. Stats Panel HTML — faint FYI style
```html
<div id="statsPanel" style="display: none; padding: 6px 16px; margin-top: 24px; opacity: 0.75;">
    <div class="stats-grid" style="gap: 6px;">
        <div class="stat-box" style="padding: 4px 8px; background: transparent; border: none;"><div class="stat-label">Processing Time</div><div class="stat-value green" id="statTotal" style="font-size: 0.85em;">-</div></div>
        <div class="stat-box" style="padding: 4px 8px; background: transparent; border: none;"><div class="stat-label">Realtime</div><div class="stat-value green" id="statRealtime" style="font-size: 0.85em;">-</div></div>
        <div class="stat-box" style="padding: 4px 8px; background: transparent; border: none;"><div class="stat-label">Output Length</div><div class="stat-value" id="statLength" style="font-size: 0.85em;">-</div></div>
        <div class="stat-box" style="padding: 4px 8px; background: transparent; border: none;"><div class="stat-label">File Size</div><div class="stat-value" id="statSize" style="font-size: 0.85em;">-</div></div>
    </div>
</div>
```
NOT a `.panel` class — no box background/border.

---

#### H. CSS changes
- `.stat-label` color: `#aaa` (was `#888`)
- `.param-zone` padding: `12px 14px` (was `20px 14px`)
- `.track-list` added `min-height: 32px`
- Waveform strokeStyle: `#B0B0B8` (was `#D4B47A` yellow)

---

#### I. Window/Overlap row visibility fix
The `<div class="controls">` wrapping windowGroup and overlapGroup got `id="windowOverlapRow"` and is hidden/shown in `updateControlVisibility`:
```js
const windowOverlapRow = document.getElementById('windowOverlapRow');
if (algo === 'paul' || algo === 'granular' || algo === 'spectral') {
    windowOverlapRow.style.display = '';
} else {
    windowOverlapRow.style.display = 'none';
}
```

---

#### J. File-switch auto-play with crossfade
In `loadAudioFile`:
1. Capture `const wasPlaying = isPlaying;` before stopping
2. Do NOT send 'pause' to worklet before load-audio (load-audio does hard stop now)
3. Fade out old audio via gain node: 50ms fade + 30ms silence gap
4. After 80ms timeout, send load-audio and set `pendingResume = { position: 0, shouldPlay: true, restoreGain: true }`
5. For offline modes, restore gain and call `togglePlay()` directly

In `pendingResume` handler (inside `setupWorkletListeners`):
- Added `playStartTime = audioContext.currentTime;` (was missing — caused blip bug)
- Added `restoreGain` handling: if set, restore stretchGain to 1 before playing

---

#### K. Last loaded track persistence
- New variable: `let lastLoadedTrackFile = null;`
- Set in `loadTestTrack` after successful load: `lastLoadedTrackFile = filename; saveSettings();`
- Cleared in file drop/input handlers before `loadAudioFile`
- Saved in `saveSettings()`: `settings.lastTrackFile = lastLoadedTrackFile;`
- Restored in `loadSettings()`: `if (settings.lastTrackFile) { lastLoadedTrackFile = settings.lastTrackFile; }`
- Auto-load on page init (after track list built, before resize handler):
```js
if (lastLoadedTrackFile) {
    const trackItems = trackList.querySelectorAll('.track-item');
    testTracks.forEach((track, i) => {
        if (track.file === lastLoadedTrackFile && trackItems[i]) {
            trackItems[i].classList.add('active');
        }
    });
    loadTestTrack(lastLoadedTrackFile);
}
```

---

#### L. Removed console.log from waveform click handler
The diagnostic `console.log('🎯 Waveform click:...')` was removed. The early return simplified to just `if (!sourceBuffer) return;`
