# Recovery: Claude Session 2 Changes (Feb 26, 2026 — WASM Session)

## Status
- **wasm/src/rtpghi_stretch.h**: SAFE — still on disk (untracked)
- **wasm/src/rtpghi_stretch.c**: SAFE — still on disk (untracked)
- **js/rtpghi-wasm-loader.js**: SAFE — still on disk (untracked)
- **wasm/build.sh**: SAFE — still modified on disk
- **wasm/rtpghi.wasm**: SAFE — compiled binary on disk (can rebuild via `cd wasm && ./build.sh`)
- **stretch_test.html**: LOST — changes below need reapplication ON TOP of Session 1 changes

## Changes Made ON TOP of Session 1's stretch_test.html

All changes below assume Session 1 (SESSION_CHANGES.md) changes are already applied.

---

### 1. Waveform Color — Amber Gold
In `drawWaveform()`, changed stroke color:
```js
ctx.strokeStyle = '#D4B47A';  // wheat-gold (was '#ccc' originally, Session 1 set '#B0B0B8')
```

### 2. Looping Status Text Fix
Changed the looping status to not say "Looping...":
```js
// In the loop handler where playback loops:
setStatus(playingStatus(), 'active');  // was: setStatus('Looping...', 'active')
```

### 3. Time Axis Ticks Inside Waveform
Added after the center line drawing in `drawWaveform()`:
```js
// Time axis ticks
if (sourceBuffer) {
    const duration = sourceBuffer.length / sourceSampleRate;
    const stretchFactor = sliderToStretch(parseFloat(stretchSlider.value));
    const totalDuration = duration * stretchFactor;

    // Auto-scale tick interval
    let tickInterval;
    if (totalDuration <= 5) tickInterval = 0.5;
    else if (totalDuration <= 15) tickInterval = 1;
    else if (totalDuration <= 60) tickInterval = 5;
    else if (totalDuration <= 300) tickInterval = 30;
    else tickInterval = 60;

    ctx.fillStyle = '#555';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';

    for (let t = tickInterval; t < totalDuration; t += tickInterval) {
        const x = (t / totalDuration) * canvas.width;
        // Tick mark
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, canvas.height - 12);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
        // Label
        const label = t >= 60 ? `${Math.floor(t/60)}:${(t%60).toString().padStart(2,'0')}` : `${t}s`;
        ctx.fillText(label, x, canvas.height - 14);
    }
}
```

### 4. Algorithm Dropdown — Three Groups with Optgroups
Restructured the `<select id="algorithmSelect">` into three optgroups:
```html
<select id="algorithmSelect">
    <optgroup label="Real-Time">
        <option value="resample">Resample</option>
        <option value="paul">Paul Stretch</option>
        <option value="granular">Granular</option>
        <option value="spectral">Spectral</option>
    </optgroup>
    <optgroup label="Offline">
        <option value="rtpghi" selected>RTPGHI</option>
    </optgroup>
    <optgroup label="Wavelet (Offline)">
        <option value="cwt">CWT (Morlet)</option>
        <option value="cqt">CQT/NSGT</option>
    </optgroup>
</select>
```

### 5. CustomSelect — Optgroup Support
Updated `_buildOptions()` in the `CustomSelect` class to handle `<optgroup>` elements:
```js
_buildOptions() {
    this.optionsList.innerHTML = '';
    const children = this.nativeSelect.children;
    for (const child of children) {
        if (child.tagName === 'OPTGROUP') {
            const groupLabel = document.createElement('div');
            groupLabel.className = 'csel-group-label';
            groupLabel.textContent = child.label;
            this.optionsList.appendChild(groupLabel);
            for (const opt of child.children) {
                this._createOptionItem(opt);
            }
        } else if (child.tagName === 'OPTION') {
            this._createOptionItem(child);
        }
    }
}

_createOptionItem(opt) {
    const item = document.createElement('div');
    item.className = 'csel-option';
    item.dataset.value = opt.value;
    item.textContent = opt.textContent;
    if (opt.selected) item.classList.add('selected');
    item.addEventListener('click', () => {
        this.nativeSelect.value = opt.value;
        this.nativeSelect.dispatchEvent(new Event('change'));
        this._updateDisplay();
        this.close();
    });
    this.optionsList.appendChild(item);
}
```

CSS for optgroup labels:
```css
.csel-group-label {
    color: #888;
    font-size: 0.7em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 6px 10px 2px;
    pointer-events: none;
}
```

### 6. Hop Divisor Labels with Overlap Percentages
Label changed to "Hop Divisor (Overlap)":
```html
<label for="overlapSelect" style="...">Hop Divisor (Overlap)</label>
```

Options:
```html
<option value="4">M/4 — 75%</option>
<option value="8" selected>M/8 — 87.5%</option>
<option value="16">M/16 — 93.8%</option>
<option value="32">M/32 — 96.9%</option>
```

### 7. Progress Bar — CSS
```css
#progressBar {
    position: absolute;
    bottom: 0;
    left: 0;
    height: 3px;
    background: linear-gradient(90deg, #5BA8A0, #7BC8C0);
    width: 0%;
    transition: opacity 0.2s ease-out;
    z-index: 10;
    pointer-events: none;
    border-radius: 0 1px 0 0;
}
```

### 8. Progress Bar — HTML
Added inside the waveform container (the div that holds the canvas):
```html
<div id="progressBar"></div>
```

### 9. Progress JS Functions
```js
function showProgress(fraction) {
    const bar = document.getElementById('progressBar');
    bar.style.opacity = '1';
    bar.style.width = (fraction * 100) + '%';

    // Glow the badge for WASM/GPU algorithms
    const algo = document.getElementById('algorithmSelect').value;
    if (algo === 'cwt' || algo === 'cqt' || algo === 'rtpghi') {
        const badge = document.getElementById('gpuBadge');
        if (badge) {
            badge.style.background = 'rgba(91, 168, 160, 0.2)';
            badge.style.boxShadow = '0 0 8px rgba(91, 168, 160, 0.3)';
        }
    }
}

function hideProgress() {
    const bar = document.getElementById('progressBar');
    // Snap to 100% instantly
    bar.style.transition = 'opacity 0.2s ease-out';
    bar.style.width = '100%';

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            bar.style.opacity = '0';

            // Remove badge glow
            const badge = document.getElementById('gpuBadge');
            if (badge) {
                badge.style.background = '';
                badge.style.boxShadow = '';
            }

            setTimeout(() => {
                bar.style.width = '0%';
            }, 200);
        });
    });
}
```

### 10. RTPGHI stretch() Made Async with Yields
The RTPGHI `stretch()` method was made async, yielding to UI every ~40ms for progress:
```js
// In the RTPGHIStretcher class stretch() method:
async stretch(source, stretchFactor, opts = {}) {
    // ... existing setup ...

    let lastYield = performance.now();
    for (let frame = 0; frame < numFrames; frame++) {
        // ... existing frame processing ...

        // Yield to UI periodically
        const now = performance.now();
        if (now - lastYield > 40) {
            if (opts.onProgress) opts.onProgress(frame / numFrames);
            await new Promise(r => setTimeout(r, 0));
            lastYield = performance.now();
        }
    }
    // ... existing normalization/trim ...
}
```

### 11. Play Button — No Hourglass During Processing
Changed from `'⏳'` to `'▶'`:
```js
playBtn.textContent = '▶';  // was: playBtn.textContent = '⏳';
```

### 12. Status Area — Dark Info Panel
```css
.status {
    /* Added: */
    flex: 1;
    background: #16171C;
    border-radius: 3px;
    border: 1px solid #1A1A1E;
}
```

### 13. WASM Integration — Script Tag
Added before the first `<script>` block:
```html
<script src="js/rtpghi-wasm-loader.js"></script>
```

### 14. WASM Init on Page Load
Added near the end of the page-load initialization:
```js
initRTPGHIWasm().catch(() => {});
```

### 15. RTPGHI Stretch — WASM First, JS Fallback
In `runOfflineStretch()`, the RTPGHI branch:
```js
if (algo === 'rtpghi') {
    showProgress(0);

    if (rtpghiWasmReady) {
        // WASM path — synchronous, fast
        const t0 = performance.now();
        stretchedBuffer = rtpghiStretchWASM(source, stretchFactor, {
            M: parseInt(fftSizeSelect.value),
            hopDiv: parseInt(overlapSelect.value),
            gamma: 0,
            tol: 10,
            phaseMode: 'full',
            windowType: windowSelect.value
        });
        const elapsed = performance.now() - t0;
        hideProgress();
        updateStats({ processingMs: elapsed });
    } else {
        // JS fallback — async with progress
        const stretcher = new RTPGHIStretcher(/* ... */);
        stretchedBuffer = await stretcher.stretch(source, stretchFactor, {
            onProgress: (frac) => showProgress(frac)
        });
        hideProgress();
        updateStats({ processingMs: elapsed });
    }
}
```

### 16. GPU Badge — Shows "WASM Accelerated" for RTPGHI
In `updateControlVisibility()` or wherever the badge text is set:
```js
if (algo === 'rtpghi') {
    gpuBadge.textContent = 'WASM Accelerated';
    gpuBadge.style.display = '';
} else if (algo === 'cwt' || algo === 'cqt') {
    gpuBadge.textContent = 'GPU Accelerated';
    gpuBadge.style.display = '';
} else {
    gpuBadge.style.display = 'none';
}
```

### 17. Stats — lastProcessingMs Persistence
Added variable to prevent stats flicker:
```js
let lastProcessingMs = null;

// In updateStats():
function updateStats(opts = {}) {
    if (opts.processingMs != null) {
        lastProcessingMs = opts.processingMs;
    }
    const ms = opts.processingMs != null ? opts.processingMs : lastProcessingMs;

    const algo = document.getElementById('algorithmSelect').value;
    const isOffline = algo === 'rtpghi' || algo === 'cwt' || algo === 'cqt';

    if (ms != null && isOffline) {
        document.getElementById('statTotal').textContent = ms < 1000 ? ms.toFixed(0) + 'ms' : (ms / 1000).toFixed(2) + 's';
    } else if (!isOffline) {
        document.getElementById('statTotal').textContent = 'Real-time';
    }
    // ... rest of stats
}

// On algorithm switch:
algorithmSelect.addEventListener('change', () => {
    lastProcessingMs = null;
    // ... rest of handler
});
```
