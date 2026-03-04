# RTPGHI WASM Real-Time Stretch — Implementation Plan

## What We're Building

Click-and-hold on a waveform position → continuous stretched audio output in real time.
RTPGHI (Real-Time Phase Gradient Heap Integration) reconstructs phase from magnitudes only — no phase accumulation, no drift, no phasiness.

---

## Algorithm: RTPGHI in ~30 Lines of Math

### Core Insight
For a Gaussian-windowed STFT, partial derivatives of phase are computable from partial derivatives of log-magnitude:

```
Time gradient:      dφ/dt  =  d(log|S|)/dω · γ/(a·M)  +  2π·a·m/M
Frequency gradient: dφ/dω = -d(log|S|)/dt · γ/(a·M)
```

Where:
- `S[m,n]` = STFT coefficient at freq bin `m`, time frame `n`
- `a` = hop size, `M` = FFT size
- `γ` = Gaussian window parameter: `g(t) = exp(-π·t²/γ)`

### Real-Time Update (per frame)

```
function rtpghi_update(log_mag_prev, log_mag_curr, phase_prev, a, M, gamma, tol):
    bins = M/2 + 1
    phase_curr = new Float32Array(bins)

    // Step 1: Compute time gradient from log-magnitude finite difference
    fmul = gamma / (a * M)
    for m = 0 to bins-1:
        // Time gradient: finite difference of log-mag across frequency
        tgrad = (log_mag_curr[m] - log_mag_prev[m]) * fmul + 2*PI*a*m/M

        // Propagate phase from previous frame using time gradient
        phase_curr[m] = phase_prev[m] + (tgrad_prev[m] + tgrad) / 2  // trapezoidal

    // Step 2: Refine with frequency gradient (sweep within current frame)
    for m = 1 to bins-1:
        if log_mag_curr[m] > threshold:
            // Frequency gradient from log-mag finite difference across time
            fgrad = -(log_mag_curr[m] - log_mag_curr[m-1]) * fmul
            phase_from_freq = phase_curr[m-1] + (fgrad_prev + fgrad) / 2

            // Use frequency-propagated phase if magnitude is higher
            // (higher magnitude = more reliable gradient estimate)
            if log_mag_curr[m] > log_mag_curr[m-1]:
                phase_curr[m] = phase_from_freq

    // Step 3: Backward sweep for symmetry
    for m = bins-2 down to 0:
        if log_mag_curr[m] > threshold:
            fgrad = -(log_mag_curr[m+1] - log_mag_curr[m]) * fmul
            phase_from_freq = phase_curr[m+1] - (fgrad_prev + fgrad) / 2
            if log_mag_curr[m] > log_mag_curr[m+1]:
                phase_curr[m] = phase_from_freq

    return phase_curr
```

### Time-Stretching with RTPGHI (Phase Vocoder Done Right)

```
stretch_factor = a_syn / a_ana

1. STFT Analysis: read input at hop = a_ana = floor(a_syn / stretch_factor)
2. Extract magnitudes: s = |STFT frame|
3. Compute log-magnitude: log_s = log(s + epsilon)
4. RTPGHI: reconstruct phase at SYNTHESIS rate from magnitudes
5. Combine: complex = s * exp(j * phase)
6. ISTFT Synthesis: overlap-add at hop = a_syn (fixed)
```

The key: analysis reads the source slowly (small hop), synthesis outputs at normal rate (fixed hop). RTPGHI fills in the phase coherently.

---

## Parameters

| Parameter | Value | Why |
|-----------|-------|-----|
| FFT size (M) | 2048 | Good freq resolution, fast FFT |
| Synthesis hop (a_syn) | 256 (M/8) | 87.5% overlap, best quality |
| Analysis hop (a_ana) | floor(256/stretch) | Varies with stretch factor |
| Window | Gaussian (γ ≈ 25.11) | Required for exact phase-magnitude relationship |
| Tolerance | -10 dB below peak | Skip low-energy bins (unreliable gradients) |
| Sample rate | 44100 Hz | AudioContext native |

**Latency**: 256 samples / 44100 = **5.8ms** per frame. Imperceptible.

**Memory per channel**: ~128KB total (input ring, output ring, FFT scratch, 3 frames of state).

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Main Thread                                     │
│                                                  │
│  User clicks waveform → position (samples)       │
│  MessagePort → AudioWorklet:                     │
│    { type: 'seek', position }                    │
│    { type: 'set-stretch', factor }               │
│    { type: 'load-audio', samples }               │
│                                                  │
│  WASM module loaded once, transferred to worklet │
└──────────────────────┬──────────────────────────-┘
                       │
        ┌──────────────▼──────────────────┐
        │  AudioWorkletProcessor           │
        │  rtpghi-stretch-processor.js     │
        │                                  │
        │  process(inputs, outputs):       │
        │    ┌─────────────────────┐       │
        │    │ Input Ring Buffer   │       │
        │    │ (accumulate 128→256)│       │
        │    └────────┬────────────┘       │
        │             │ when hop ready     │
        │    ┌────────▼────────────┐       │
        │    │ WASM: rtpghi_frame()│       │
        │    │  1. Window input    │       │
        │    │  2. FFT             │       │
        │    │  3. Magnitude+Phase │       │
        │    │  4. RTPGHI update   │       │
        │    │  5. IFFT            │       │
        │    │  6. Overlap-add     │       │
        │    └────────┬────────────┘       │
        │    ┌────────▼────────────┐       │
        │    │ Output Ring Buffer  │       │
        │    │ (drain 256→128)     │       │
        │    └────────┬────────────┘       │
        │             │ 128 samples        │
        │             ▼                    │
        │         outputs[0][0]            │
        └──────────────────────────────────┘
```

### Ring Buffer Details

AudioWorklet gives us 128 samples per `process()` call. RTPGHI needs `a_syn = 256` samples per frame.

- **Input ring**: Read from source buffer at analysis hop rate. Accumulate until we have a full window (M=2048).
- **Output ring**: ISTFT overlap-add produces `a_syn` samples per frame. Drain 128 at a time.
- On each `process()` call:
  1. Advance source read position by `128 / stretch_factor` samples (fractional, interpolated)
  2. If enough new input accumulated → run RTPGHI frame → push to output ring
  3. Pull 128 samples from output ring → fill output buffer

### Click-and-Hold Behavior

When user clicks and holds:
1. Source read position anchors near click point
2. Analysis hop = very small (high stretch) → reads same region repeatedly
3. RTPGHI reconstructs coherent phase each frame → smooth sustained output
4. Sound "freezes" at that spectral moment — like an infinite sustain
5. On release: crossfade back to normal playback (existing dual-path architecture)

For infinite stretch: set `a_ana = 1` (or even 0 = read same frame). RTPGHI handles this gracefully because it reconstructs phase fresh each frame from magnitudes.

---

## File Structure

```
wasm/
  rtpghi/
    rtpghi.c          — Core RTPGHI algorithm + STFT (standalone, no deps)
    rtpghi.h          — Public API
    Makefile           — Emscripten build → rtpghi.wasm + rtpghi.js

js/
  rtpghi-wasm-loader.js  — Load WASM, expose JS API (like kissfft-wasm-loader.js)

workers/
  rtpghi-stretch-processor.js  — AudioWorkletProcessor
```

---

## C Implementation: rtpghi.c

### Public API

```c
// Initialize (call once)
RTGPHIPlan* rtpghi_init(int M, int a_syn, float gamma, float tol);

// Process one frame (call per synthesis hop)
// mag_curr: M/2+1 magnitudes of current analysis frame
// out_complex: M complex values (real, imag interleaved) = phase-reconstructed frame
void rtpghi_process_frame(RTGPHIPlan* plan, const float* mag_curr, float* out_complex);

// Set stretch factor (changes analysis hop)
void rtpghi_set_stretch(RTGPHIPlan* plan, float stretch_factor);

// Full pipeline: source samples in → stretched samples out
// Returns number of output samples written
int rtpghi_stretch_block(
    RTGPHIPlan* plan,
    const float* input,       // source audio
    int input_length,
    float* output,            // stretched audio output
    int max_output_length,
    float stretch_factor
);

// Cleanup
void rtpghi_free(RTGPHIPlan* plan);
```

### Internal State (RTGPHIPlan)

```c
typedef struct {
    int M;              // FFT size (2048)
    int bins;           // M/2 + 1 (1025)
    int a_syn;          // synthesis hop (256)
    float gamma;        // Gaussian window parameter
    float tol;          // magnitude threshold (dB)

    // Phase state (persistent across frames)
    float* phase_prev;          // bins floats
    float* log_mag_prev;        // bins floats
    float* tgrad_prev;          // bins floats

    // Scratch buffers
    float* window;              // M floats (Gaussian)
    float* syn_window;          // M floats (synthesis window)
    float* fft_scratch;         // M*2 floats (complex)
    float* overlap_buf;         // M floats (overlap-add accumulator)

    // Source tracking
    float source_position;      // fractional sample position in source
    float a_ana;                // analysis hop (= a_syn / stretch_factor)
} RTGPHIPlan;
```

### FFT

Use KissFFT (already in the project) or a minimal radix-2 FFT. KissFFT is ideal — already built to WASM, BSD-3 license, proven.

Extend the existing `wasm/src/` build to include RTPGHI alongside KissFFT:

```c
#include "kiss_fftr.h"  // Real-valued FFT from existing KissFFT

// Forward: real → complex (M/2+1 bins)
kiss_fftr(fft_plan, windowed_input, freq_domain);

// Inverse: complex → real
kiss_fftri(ifft_plan, modified_freq, time_domain);
```

### Gaussian Window

```c
void make_gaussian_window(float* win, int M, float gamma) {
    float L = (float)M;
    for (int i = 0; i < M; i++) {
        float t = (float)i - L/2.0f;
        win[i] = expf(-PI * t * t / gamma);
    }
}
// gamma = M * M * 0.006;  // ≈ 25.11 for M=2048 (standard value)
```

---

## JS: rtpghi-wasm-loader.js

```javascript
// Pattern matches existing kissfft-wasm-loader.js

let wasmInstance = null;
let wasmMemory = null;

export async function initRTPGHI(wasmUrl) {
    const response = await fetch(wasmUrl);
    const wasmBuffer = await response.arrayBuffer();
    const module = await WebAssembly.compile(wasmBuffer);
    wasmInstance = await WebAssembly.instantiate(module, {
        env: { memory: new WebAssembly.Memory({ initial: 16 }) }  // ~1MB
    });
    wasmMemory = wasmInstance.exports.memory;
    return wasmInstance.exports;
}

export function createRTPGHIPlan(M = 2048, aSyn = 256, gamma = 25.11, tol = 10.0) {
    return wasmInstance.exports.rtpghi_init(M, aSyn, gamma, tol);
}

export function processFrame(plan, magnitudes) {
    // Copy magnitudes to WASM heap
    // Call rtpghi_process_frame
    // Copy complex output back
    // Return Float32Array
}

export function stretchBlock(plan, inputSamples, stretchFactor, maxOutput) {
    // Copy input to WASM heap
    // Call rtpghi_stretch_block
    // Copy output back
    // Return Float32Array of stretched audio
}
```

---

## JS: rtpghi-stretch-processor.js (AudioWorklet)

```javascript
class RTGPHIStretchProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.M = 2048;
        this.aSyn = 256;        // synthesis hop
        this.bins = this.M / 2 + 1;
        this.stretchFactor = 2.0;

        // Buffers
        this.samples = null;     // source audio (Float32Array)
        this.sourcePos = 0;      // fractional read position in source
        this.playing = false;

        // Ring buffers
        this.outputRing = new Float32Array(this.M * 2);  // output accumulator
        this.outputRead = 0;
        this.outputAvailable = 0;

        // WASM handle
        this.wasmPlan = null;

        // RTPGHI state (JS fallback if WASM not ready)
        this.phasePrev = new Float32Array(this.bins);
        this.logMagPrev = new Float32Array(this.bins);
        this.overlapBuf = new Float32Array(this.M);
        this.window = this._makeGaussianWindow();

        this.port.onmessage = this._handleMessage.bind(this);
    }

    _handleMessage(e) {
        const { type, data } = e.data || e;
        switch (type) {
            case 'load-audio':
                this.samples = data.samples;
                this.sourcePos = 0;
                this.port.postMessage({ type: 'loaded', duration: this.samples.length / 44100 });
                break;
            case 'play':
                this.playing = true;
                break;
            case 'pause':
                this.playing = false;
                break;
            case 'seek':
                this.sourcePos = data.position * 44100;  // convert seconds → samples
                this._resetPhaseState();
                break;
            case 'set-stretch':
                this.stretchFactor = data.factor;
                break;
            case 'init-wasm':
                this.wasmPlan = data.plan;  // WASM plan pointer
                break;
        }
    }

    _makeGaussianWindow() {
        const win = new Float32Array(this.M);
        const gamma = this.M * this.M * 0.006;
        for (let i = 0; i < this.M; i++) {
            const t = i - this.M / 2;
            win[i] = Math.exp(-Math.PI * t * t / gamma);
        }
        return win;
    }

    _resetPhaseState() {
        this.phasePrev.fill(0);
        this.logMagPrev.fill(-20);  // log(epsilon)
        this.overlapBuf.fill(0);
        this.outputAvailable = 0;
    }

    process(inputs, outputs, parameters) {
        if (!this.playing || !this.samples) {
            return true;
        }

        const output = outputs[0][0];  // mono
        const needed = output.length;   // 128

        // Generate frames until we have enough output
        while (this.outputAvailable < needed) {
            this._processOneFrame();
        }

        // Drain output ring
        for (let i = 0; i < needed; i++) {
            output[i] = this.outputRing[this.outputRead];
            this.outputRing[this.outputRead] = 0;
            this.outputRead = (this.outputRead + 1) % this.outputRing.length;
        }
        this.outputAvailable -= needed;

        return true;
    }

    _processOneFrame() {
        // 1. Read M samples from source at current position (with interpolation)
        const frame = new Float32Array(this.M);
        for (let i = 0; i < this.M; i++) {
            const pos = this.sourcePos + i;
            const idx = Math.floor(pos);
            const frac = pos - idx;
            if (idx >= 0 && idx < this.samples.length - 1) {
                frame[i] = this.samples[idx] * (1 - frac) + this.samples[idx + 1] * frac;
            }
        }

        // 2. Apply analysis window
        for (let i = 0; i < this.M; i++) {
            frame[i] *= this.window[i];
        }

        // 3. FFT → magnitudes + RTPGHI phase → IFFT
        // (This would call WASM, or JS fallback)
        const stretched = this._rtpghiFrame(frame);

        // 4. Overlap-add to output ring
        const writeStart = (this.outputRead + this.outputAvailable) % this.outputRing.length;
        for (let i = 0; i < this.M; i++) {
            const idx = (writeStart + i) % this.outputRing.length;
            this.outputRing[idx] += stretched[i] * this.window[i];  // synthesis window
        }
        this.outputAvailable += this.aSyn;

        // 5. Advance source position by analysis hop
        const aAna = this.aSyn / this.stretchFactor;
        this.sourcePos += aAna;

        // 6. Wrap or clamp source position
        if (this.sourcePos >= this.samples.length - this.M) {
            this.sourcePos = this.samples.length - this.M - 1;
            // Could loop back or stop here
        }
    }

    _rtpghiFrame(windowedFrame) {
        // TODO: Replace with WASM call
        // For now, JS implementation sketch:

        const bins = this.bins;
        const M = this.M;
        const gamma = M * M * 0.006;
        const fmul = gamma / (this.aSyn * M);
        const TWO_PI = 2 * Math.PI;
        const EPS = 1e-10;

        // FFT (need real FFT here — use KissFFT WASM or inline radix-2)
        const { re, im } = this._fft(windowedFrame);

        // Magnitudes and log-magnitudes
        const mag = new Float32Array(bins);
        const logMag = new Float32Array(bins);
        for (let m = 0; m < bins; m++) {
            mag[m] = Math.sqrt(re[m] * re[m] + im[m] * im[m]);
            logMag[m] = Math.log(mag[m] + EPS);
        }

        // Find threshold
        let maxLog = -Infinity;
        for (let m = 0; m < bins; m++) {
            if (logMag[m] > maxLog) maxLog = logMag[m];
        }
        const threshold = maxLog - 10;  // tol = 10

        // Time gradient → phase from previous frame
        const phase = new Float32Array(bins);
        for (let m = 0; m < bins; m++) {
            const tgrad = (logMag[m] - this.logMagPrev[m]) * fmul + TWO_PI * this.aSyn * m / M;
            phase[m] = this.phasePrev[m] + tgrad;
        }

        // Forward frequency sweep
        for (let m = 1; m < bins; m++) {
            if (logMag[m] > threshold && logMag[m] > logMag[m - 1]) {
                const fgrad = -(logMag[m] - logMag[m - 1]) * fmul;
                phase[m] = phase[m - 1] + fgrad;
            }
        }

        // Backward frequency sweep
        for (let m = bins - 2; m >= 0; m--) {
            if (logMag[m] > threshold && logMag[m] > logMag[m + 1]) {
                const fgrad = -(logMag[m + 1] - logMag[m]) * fmul;
                phase[m] = phase[m + 1] - fgrad;
            }
        }

        // Store state for next frame
        this.phasePrev.set(phase);
        this.logMagPrev.set(logMag);

        // Reconstruct complex spectrum
        for (let m = 0; m < bins; m++) {
            re[m] = mag[m] * Math.cos(phase[m]);
            im[m] = mag[m] * Math.sin(phase[m]);
        }

        // IFFT
        return this._ifft(re, im);
    }

    _fft(signal) {
        // Placeholder — use KissFFT WASM or inline implementation
        // Returns { re: Float32Array(bins), im: Float32Array(bins) }
    }

    _ifft(re, im) {
        // Placeholder — use KissFFT WASM or inline implementation
        // Returns Float32Array(M)
    }
}

registerProcessor('rtpghi-stretch-processor', RTGPHIStretchProcessor);
```

---

## Integration with Existing Audio Pipeline

### In audio-player.js

```javascript
// Add alongside existing stretch processors in primeStretchProcessors():

async primeRTPGHIProcessor(samples) {
    // Load WASM module
    await audioContext.audioWorklet.addModule('workers/rtpghi-stretch-processor.js');

    this.rtpghiNode = new AudioWorkletNode(audioContext, 'rtpghi-stretch-processor');
    this.rtpghiNode.connect(this.stretchGainNode);

    // Send audio data
    const copy = samples.slice();
    this.rtpghiNode.port.postMessage(
        { type: 'load-audio', data: { samples: copy } },
        [copy.buffer]  // transferable
    );
}

// Click-and-hold handler (in waveform UI):
onWaveformPointerDown(position) {
    this.rtpghiNode.port.postMessage({ type: 'seek', data: { position } });
    this.rtpghiNode.port.postMessage({ type: 'set-stretch', data: { factor: 100 } }); // or Infinity
    this.rtpghiNode.port.postMessage({ type: 'play' });
    this.engageStretch();  // crossfade to stretch path
}

onWaveformPointerUp() {
    this.rtpghiNode.port.postMessage({ type: 'pause' });
    this.disengageStretch();  // crossfade back to source
}

// Drag while holding:
onWaveformPointerMove(position) {
    this.rtpghiNode.port.postMessage({ type: 'seek', data: { position } });
}
```

---

## Build Pipeline

### Extend existing WASM Makefile

```makefile
# In wasm/ directory, add to existing build:

RTPGHI_SRC = rtpghi/rtpghi.c
KISSFFT_SRC = src/kiss_fft.c src/kiss_fftr.c

rtpghi.wasm: $(RTPGHI_SRC) $(KISSFFT_SRC)
	emcc $(RTPGHI_SRC) $(KISSFFT_SRC) \
		-I src/ \
		-o rtpghi.js \
		-s EXPORTED_FUNCTIONS='["_rtpghi_init","_rtpghi_process_frame","_rtpghi_stretch_block","_rtpghi_set_stretch","_rtpghi_free","_malloc","_free"]' \
		-s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPF32"]' \
		-s ALLOW_MEMORY_GROWTH=0 \
		-s INITIAL_MEMORY=1048576 \
		-s SINGLE_FILE=1 \
		-O3
```

`SINGLE_FILE=1` embeds the WASM binary as base64 in the JS file — makes it easy to load in AudioWorklet via `addModule()`.

---

## Phase 1: JS-Only Prototype (get it working)

1. Implement `rtpghi-stretch-processor.js` with inline JS FFT (borrow radix-2 from spectral-stretch-processor.js)
2. Wire up click-and-hold in the waveform UI
3. Test with existing audio data
4. Verify: no phasiness, smooth freeze, clean output

## Phase 2: WASM Optimization

1. Write `rtpghi.c` using existing KissFFT
2. Compile with Emscripten
3. Replace JS FFT/RTPGHI with WASM calls in the processor
4. Profile: should be well under 3ms per frame budget

## Phase 3: Polish

1. Smooth crossfades on engage/disengage
2. Position interpolation during drag
3. Stretch factor ramping (smooth transitions)
4. Handle edge cases (start/end of buffer, very short files)

---

## References

- PGHI Paper: Prusa, Balazs, Sondergaard — "A Noniterative Method for Reconstruction of Phase from STFT Magnitude" (IEEE 2017)
- RTPGHI Paper: Prusa, Sondergaard — "Real-Time Spectrogram Inversion Using Phase Gradient Heap Integration" (DAFx-16)
- Phase Vocoder Done Right: Prusa, Holighaus (EUSIPCO 2017)
- C Reference: github.com/ltfat/phaseret (libphaseret)
- JUCE Reference: github.com/ltfat/pvdoneright
- Python Reference: pypi.org/project/pghipy/
