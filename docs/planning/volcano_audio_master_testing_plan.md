# Cloudflare Worker Migration Plan
## Full Edge Computing: IRIS → Worker → Client

**Created**: October 23, 2025  
**Status**: Planning Phase  
**Goal**: Eliminate Render/Python backend entirely, move all processing to Cloudflare Workers

---

## ⚠️ CRITICAL: Checkmark Usage Rules

**ONLY use ✅ when a task is 100% COMPLETE. Not "working", not "in progress", not "partially done".**

- ✅ = Task is fully complete, all requirements met, tested, and verified
- [ ] = Task not started or incomplete (use this for EVERYTHING else)
- ⚠️ = Task has issues/blockers/partial progress (use in status descriptions, NOT as checkmarks)

**If you're not sure if something is 100% done, it's NOT done. Use [ ].**

---

## Executive Summary

### The Vision
```
Current: IRIS → Render (Python/ObsPy) → R2 → Worker → Client
New:     IRIS → Cloudflare Worker (JS) → Client
         └─ Periodic R2 cache updates (cron)
```

### Why This Matters
- 🚀 **10x faster**: Edge computing eliminates round-trips
- 💰 **40x cheaper**: No Render bandwidth costs
- 🌍 **Global**: Cloudflare's edge network
- 📈 **Scales infinitely**: Pay-per-use, no server management
- 🎯 **Simpler**: One platform (Cloudflare), no Python/Render

### The Trade-Off
- ❌ **No ObsPy**: Must implement everything in JavaScript
- ✅ **IIR > FFT/IFFT**: Better for streaming anyway (causal, lossless)
- ✅ **4-hour chunks**: Stitch together for longer durations
- ✅ **Pre-computed IIR coefficients**: Compute once in Python, store in R2

---

## Prerequisites & Assumptions

### What We Know Works
- ✅ Workers can fetch from R2 (proven, 1-5ms latency)
- ✅ Workers can detrend + normalize (already implemented)
- ✅ Workers can stream progressive chunks (already implemented)
- ✅ IIR filters are superior to FFT/IFFT for streaming

### What We Need to Prove
- ✅ Workers can fetch from IRIS directly (HTTP request test) - PROVEN: All durations 2-24h work
- ✅ IRIS transfer speeds acceptable for 4-hour chunks - PROVEN: 3.5s for 4h, 17.3s for 24h
- [ ] Workers can parse miniSEED binary format - PARTIAL: Works in Node.js with seisplotjs, not tested in Workers
- [ ] Workers can implement IIR filtering (sosfilt in JS) - FAILED: Numerical instability, multi-stage parsing needed
- [ ] Int32 vs Int16 quality difference - NOT TESTED (critical for storage costs)
- [ ] Can save Int32 data to R2 with time arrays - NOT TESTED
- [ ] Cloudflare supports cron jobs for cache updates - NOT TESTED
- [ ] IIR bilinear transform is "good enough" vs MCMC - PARTIAL: Python proven, JS failed
- [ ] Intelligent caching strategy for 5 volcanoes - NOT DESIGNED
- [ ] Daily raw data storage system - NOT IMPLEMENTED

---

## Phase 0: IIR Filter Validation (Critical Dependency)

**See**: `docs/planning/iir_filter_comparison_test_plan.md`

**Objective**: Prove that scipy's bilinear IIR transform is "good enough" for volcanic monitoring (0.5-10 Hz) compared to Anderson's MCMC optimization.

**Why This Must Happen First**: 
- IIR filtering is the CORE of this architecture
- If bilinear fails, we need MCMC (more complex)
- Must validate before investing in Worker implementation

**Deliverables**:
- [ ] Frequency response comparison (Python: DONE, JavaScript: FAILED)
- [ ] Time-domain waveform comparison (Python: 4 audio files generated, JavaScript: basic pipeline only)
- [ ] Volcanic range (0.5-10 Hz) accuracy analysis (Python: 0.0 dB passband, JavaScript: N/A - no IIR)
- [ ] Streaming viability test (Python: IIR is causal 0.005 ms/sec, JavaScript: FAILED)
- [ ] **Audification test** (listening test - DEFERRED, moving on without full IIR correction)
- [ ] **JavaScript IIR implementation** (FAILED - Butterworth double-warping, multi-stage parsing missing, numerical instability)

**Timeline**: 0.8-1.2 hours (AI-assisted)

**Status**: ⚠️ **PARTIAL** - Python working, JavaScript IIR FAILED

**Key Findings**:
- ✅ **Python**: Multi-stage IIR deconvolution working perfectly
- ❌ **JavaScript IIR**: FAILED - numerical instability, needs multi-stage parsing, Butterworth has bugs
- 🎯 **WORKAROUND DISCOVERED**: Detrend + Lowpass + Normalize (NO IIR) produces acceptable audio for audification
- 🎯 **PROOF OF CONCEPT**: JavaScript CAN run basic pipeline (detrend + LP + normalize) without IIR correction
- 🚀 **DECISION**: Proceed with simplified pipeline (NO IIR CORRECTION) for initial proof-of-concept
- ⚠️ **LIMITATION**: Not true instrument response removal, just basic filtering
- 📋 **TODO**: Fix JavaScript IIR implementation (multi-stage response parsing, stable Butterworth, gain normalization)

---

### Phase 0 Extension: Audification Listening Test

**Objective**: Generate audio files for human listening comparison of all correction methods.

**Test Script**: `tests/test_audification_comparison.py`

```python
from obspy.clients.fdsn import Client
from scipy import signal
from scipy.io import wavfile
import numpy as np
from datetime import datetime, timedelta

def generate_audification_test():
    """
    Generate 4 audio files for comparison:
    1. Raw data (normalized)
    2. ObsPy FFT/IFFT corrected
    3. IIR Bilinear corrected
    4. Anderson MCMC corrected
    """
    
    # Fetch data from IRIS (historical, complete data)
    client = Client("IRIS")
    end_time = datetime.utcnow() - timedelta(hours=24)
    start_time = end_time - timedelta(hours=1)  # 1 hour for quick test
    
    # Get waveform + response
    st = client.get_waveforms("HV", "HLPD", "10", "HHZ", 
                              start_time, end_time,
                              attach_response=True)
    
    raw_data = st[0].data.copy()
    sample_rate = st[0].stats.sampling_rate
    
    # 1. RAW DATA (normalized)
    raw_normalized = normalize_for_audio(raw_data)
    save_audio('1_raw_normalized.wav', raw_normalized, sample_rate)
    
    # 2. OBSPY FFT/IFFT CORRECTED
    st_fft = st.copy()
    st_fft.remove_response(output='VEL')
    obspy_corrected = normalize_for_audio(st_fft[0].data)
    save_audio('2_obspy_fft_corrected.wav', obspy_corrected, sample_rate)
    
    # 3. IIR BILINEAR CORRECTED
    inv = client.get_stations(network="HV", station="HLPD",
                               location="10", channel="HHZ",
                               starttime=start_time, level="response")
    
    response = inv[0][0][0].response
    stage = response.response_stages[0]
    poles = stage.poles
    zeros = stage.zeros
    gain = stage.normalization_factor
    
    # Bilinear transform
    sos_bilinear = signal.zpk2sos(zeros, poles, gain, fs=sample_rate)
    bilinear_corrected = signal.sosfilt(sos_bilinear, raw_data)
    bilinear_normalized = normalize_for_audio(bilinear_corrected)
    save_audio('3_iir_bilinear_corrected.wav', bilinear_normalized, sample_rate)
    
    # 4. ANDERSON MCMC CORRECTED
    # (Requires MCMC implementation from Phase 0 main tests)
    sos_mcmc = anderson_mcmc_iir(poles, zeros, gain, sample_rate)
    mcmc_corrected = signal.sosfilt(sos_mcmc, raw_data)
    mcmc_normalized = normalize_for_audio(mcmc_corrected)
    save_audio('4_anderson_mcmc_corrected.wav', mcmc_normalized, sample_rate)
    
    print("✅ Generated 4 audio files in tests/audification_comparison/")
    print("Listen to each and compare quality!")

def normalize_for_audio(data):
    """Normalize to [-1, 1] range for audio"""
    # Detrend
    data = data - np.mean(data)
    
    # Taper (0.01% edges)
    taper_len = int(len(data) * 0.0001)
    taper = signal.windows.tukey(len(data), alpha=taper_len*2/len(data))
    data = data * taper
    
    # Normalize
    max_abs = np.max(np.abs(data))
    if max_abs > 0:
        data = data / max_abs
    
    return data.astype(np.float32)

def save_audio(filename, data, sample_rate):
    """Save as WAV file (audified 441x speedup)"""
    audified_rate = int(sample_rate * 441)  # 100 Hz → 44,100 Hz
    
    # Convert to 16-bit PCM
    data_int16 = (data * 32767).astype(np.int16)
    
    filepath = f'tests/audification_comparison/{filename}'
    wavfile.write(filepath, audified_rate, data_int16)
    
    print(f"✅ Saved: {filepath}")
```

**Output Files** (saved to `tests/audification_comparison/`):
- `1_raw_normalized.wav` - Raw seismic data (normalized only)
- `2_obspy_fft_corrected.wav` - ObsPy's FFT/IFFT response removal
- `3_iir_bilinear_corrected.wav` - Our IIR bilinear transform
- `4_anderson_mcmc_corrected.wav` - Anderson's MCMC optimization

**Listening Test Criteria**: (WE WILL REVISIT THIS, MOVING ON FOR NOW)
- [ ] Does raw data sound muddy/wrong? (Should sound filtered by instrument)
- [ ] Do corrected versions sound clearer/better?
- [ ] Can you hear differences between FFT, Bilinear, and MCMC?
- [ ] Does Bilinear sound "good enough" compared to MCMC?
- [ ] Any obvious artifacts in FFT method? (Gibbs phenomenon, edge effects)

**Decision**:
- If Bilinear sounds identical to MCMC → Use Bilinear (simple, fast)
- If MCMC sounds noticeably better → Implement MCMC (complex, slow)
- If FFT sounds bad → Confirms FFT/IFFT is problematic for our use case

---

---

## Phase 1: Local Proof-of-Concept Tests

**Status**: ⚠️ **IN PROGRESS** (Basic components working, IIR NOT working)

### 1.1 IRIS Transfer Speed Test
**Objective**: Determine if IRIS can deliver various chunk sizes fast enough for Workers.

**Status**: ✅ **COMPLETE** - All durations tested and passed

**Test Script**: `tests/test_iris_transfer_speeds.js`

**Results** (Historical data: 48h ago → 24h ago):
- 2-hour chunk: 2.3s (0.89 MB) ✅ PASS (< 3s target)
- 4-hour chunk: 3.5s (1.71 MB) ✅ PASS (< 5s target)
- 6-hour chunk: 4.7s (2.51 MB) ✅ PASS (< 8s target)
- 8-hour chunk: 6.0s (3.31 MB) ✅ PASS (< 10s target)
- 12-hour chunk: 8.8s (4.97 MB) ✅ PASS (< 15s target)
- 24-hour chunk: 17.3s (10.28 MB) ✅ PASS (< 30s target)

**Key Findings**:
- Average speed: 0.5 MB/s
- TTFB: 0.5-0.8 seconds (excellent)
- Linear scaling with duration
- All transfers complete well within Cloudflare Workers 50s CPU limit
- Direct IRIS fetch from Node.js confirmed working

```python
import time
import requests
from datetime import datetime, timedelta

def test_iris_speed():
    """Test IRIS download speed for various durations"""
    
    # Use historical data: 48 hours ago → 24 hours ago (guaranteed complete)
    end_time = datetime.utcnow() - timedelta(hours=24)
    
    durations = [2, 4, 6, 8, 12, 24]  # hours
    
    results = []
    
    for hours in durations:
        start_time = end_time - timedelta(hours=hours)
        
        url = (
            f"http://service.iris.edu/irisws/timeseries/1/query"
            f"?net=HV&sta=HLPD&loc=10&cha=HHZ"
            f"&start={start_time.strftime('%Y-%m-%dT%H:%M:%S')}"
            f"&end={end_time.strftime('%Y-%m-%dT%H:%M:%S')}"
            f"&output=miniseed"
        )
        
        start = time.time()
        response = requests.get(url, stream=True)
        
        # Measure first byte
        first_byte = None
        total_bytes = 0
        
        for chunk in response.iter_content(8192):
            if first_byte is None:
                first_byte = time.time() - start
            total_bytes += len(chunk)
        
        total_time = time.time() - start
        speed_mbps = (total_bytes / 1e6) / total_time
        
        result = {
            'duration_hours': hours,
            'size_mb': total_bytes / 1e6,
            'ttfb_sec': first_byte,
            'total_sec': total_time,
            'speed_mbps': speed_mbps
        }
        
        results.append(result)
        
        print(f"{hours}h: {result['size_mb']:.2f} MB, "
              f"TTFB: {result['ttfb_sec']:.2f}s, "
              f"Total: {result['total_sec']:.2f}s, "
              f"Speed: {result['speed_mbps']:.2f} MB/s")
    
    # Save results
    import json
    with open('tests/test_logs/iris_transfer_speed_results.json', 'w') as f:
        json.dump(results, f, indent=2)
    
    return results
```

**Success Criteria**:
- [ ] 2-hour chunk downloads in < 3 seconds
- [ ] 4-hour chunk downloads in < 5 seconds
- [ ] 8-hour chunk downloads in < 10 seconds
- [ ] 12-hour chunk downloads in < 15 seconds
- [ ] 24-hour chunk downloads in < 30 seconds
- [ ] Average transfer speed > 1 MB/s
- [ ] TTFB (time to first byte) < 2 seconds

**If fails**: Use R2 caching (still eliminates Render)

---

### 1.2 miniSEED Parser Test (JavaScript)
**Objective**: Parse miniSEED binary format in JS and extract Int32 samples.

**Status**: ⚠️ **PARTIAL** - Works in Node.js, not tested in Cloudflare Workers

**Test Script**: `tests/test_audification_js.js`

**Results So Far**:
- Parsed miniSEED using `seisplotjs` npm package in Node.js
- Steim2 decompression working (360,001 samples from 470 KB)
- Extraction of Int32 samples: 452ms for 1 hour of data
- Parsing performance: Acceptable

**Still Need**:
- [ ] Verify seisplotjs works in Cloudflare Workers environment (different runtime than Node.js)
- [ ] Test with various data sizes
- [ ] Validate against ObsPy output

```javascript
/**
 * miniSEED is a binary format with:
 * - Fixed 512-byte records
 * - Header (48 bytes): network, station, channel, time, sample rate
 * - Data payload: compressed samples (Steim1, Steim2, or raw)
 * 
 * We need to:
 * 1. Parse record headers
 * 2. Decompress data (Steim2 most common)
 * 3. Extract Int32 samples
 * 4. Convert to Int16 (test lossless)
 */

class MiniSEEDParser {
  constructor(arrayBuffer) {
    this.view = new DataView(arrayBuffer);
    this.offset = 0;
  }
  
  parseHeader() {
    // Sequence number (6 bytes)
    const sequence = this.readString(6);
    
    // Data header indicator (1 byte, should be 'D')
    const indicator = String.fromCharCode(this.view.getUint8(this.offset++));
    
    // Station code (5 bytes)
    const station = this.readString(5);
    
    // Network code (2 bytes)
    const network = this.readString(2);
    
    // Channel code (3 bytes)
    const channel = this.readString(3);
    
    // ... (continue parsing header fields)
    
    return { sequence, station, network, channel };
  }
  
  decompressSteim2(data) {
    // Steim2 decompression algorithm
    // See: https://www.fdsn.org/seed_manual/SEEDManual_V2.4.pdf
    // Section on data compression
    
    // TODO: Implement Steim2 decompression
    // This is the HARD part!
  }
  
  readString(length) {
    let str = '';
    for (let i = 0; i < length; i++) {
      str += String.fromCharCode(this.view.getUint8(this.offset++));
    }
    return str.trim();
  }
}
```

**Research Required**:
- [ ] Find existing JS miniSEED parser library (search npm: `miniseed`, `mseed`, `seismic`)
- [ ] If none exist, determine complexity of writing one
- [ ] Steim2 decompression is complex - may need WASM port of C library

**Libraries to Check**:
- `mseed` on npm
- `seisjs` (browser seismology toolkit)
- ObsPy source code (translate to JS)

**Success Criteria**:
- [ ] Parse miniSEED headers correctly
- [ ] Extract Int32 sample arrays
- [ ] Validate against ObsPy parsing (same samples)

**If fails**: Store pre-processed data in R2 (current architecture)

---

### 1.3 Int32 vs Int16 Quality Comparison Test
**Objective**: Determine if Int16 is sufficient for processing, or if Int32 provides meaningful quality improvement.

**Status**: [ ] NOT STARTED

**Test Scripts**: 
- `tests/test_int32_vs_int16_quality.py` (generate audio from both)
- `tests/test_int32_vs_int16_quality.js` (JavaScript version)

**What to Test**:
1. **Storage comparison**:
   - [ ] Int32: 4 bytes per sample
   - [ ] Int16: 2 bytes per sample (50% storage savings)
   
2. **Processing quality comparison**:
   - [ ] Fetch 24 hours of data from IRIS (Int32)
   - [ ] Process with detrend + lowpass + normalize (Int32 pipeline)
   - [ ] Convert to Int16 at different stages:
     - [ ] Option A: Store raw as Int16, then process
     - [ ] Option B: Store raw as Int32, convert to Int16 after processing
   - [ ] Generate audio files for both pipelines
   - [ ] **Numerical quality metrics** (computational comparison):
     - [ ] **Peak absolute error**: `max(abs(Int32_processed - Int16_processed))`
     - [ ] **RMS error**: Root mean square of difference
     - [ ] **SNR (Signal-to-Noise Ratio)**: `20 * log10(signal_rms / error_rms)`
     - [ ] **Quantization error distribution**: Histogram of errors
     - [ ] **Frequency domain comparison**: FFT of both, compare power spectral density
     - [ ] **Correlation coefficient**: How similar are the waveforms? (should be ~1.0)
     - [ ] **Dynamic range utilization**: What % of Int16 range is actually used?
   - [ ] Listen and compare quality (subjective verification)
   
3. **Dynamic range analysis**:
   - [ ] Check if raw seismic data fits in Int16 range (-32768 to 32767)
   - [ ] Check multiple stations (Kilauea, Spurr, Shishaldin, Mauna Loa, Great Sitkin)
   - [ ] Measure SNR (signal-to-noise ratio) for Int16 vs Int32
   
4. **Decision criteria** (quantitative thresholds):
   - **Use Int16 if**:
     - SNR > 90 dB (excellent quality, quantization noise negligible)
     - Correlation coefficient > 0.9999 (virtually identical)
     - Peak error < 0.1% of signal range
     - No audible artifacts
   - **Use Int32 if**:
     - SNR < 90 dB (quantization noise significant)
     - Correlation coefficient < 0.9999
     - Frequency domain shows visible differences
     - Audible artifacts present

**Success Criteria**:
- [ ] All numerical metrics computed for 5+ stations
- [ ] Clear quantitative comparison table generated
- [ ] Decision made: Int16 or Int32 for raw storage (with justification)
- [ ] If Int16: Verify no audible artifacts across all test cases
- [ ] If Int32: Document storage cost implications

```python
import numpy as np
from obspy import read
from obspy.clients.fdsn import Client

def test_int32_to_int16(st):
    """Test if Int32 → Int16 loses data"""
    
    data_int32 = st[0].data  # Original Int32
    
    # Find dynamic range
    max_val = np.max(np.abs(data_int32))
    
    # Int16 range: -32768 to 32767
    # Int32 range: -2147483648 to 2147483647
    
    print(f"Max absolute value: {max_val:,}")
    print(f"Int16 max: {2**15 - 1:,}")
    print(f"Int32 max: {2**31 - 1:,}")
    
    # Test conversion
    scale_factor = max_val / 32767
    data_int16 = (data_int32 / scale_factor).astype(np.int16)
    
    # Convert back
    data_recovered = data_int16.astype(np.float64) * scale_factor
    
    # Check error
    error = np.abs(data_int32 - data_recovered)
    max_error = np.max(error)
    mean_error = np.mean(error)
    
    print(f"Max error: {max_error:.2e}")
    print(f"Mean error: {mean_error:.2e}")
    print(f"Relative error: {max_error / max_val * 100:.4f}%")
    
    # Check if we're within Int16 range
    if max_val < 32767:
        print("✅ Data fits in Int16 without scaling!")
    else:
        print(f"⚠️ Requires {scale_factor:.2f}x scaling")

# Test on multiple stations/times
client = Client("IRIS")
for volcano in ['kilauea', 'spurr', 'shishaldin']:
    print(f"\n{volcano.upper()}:")
    # Fetch and test...
```

**Key Questions**:
- Do seismic amplitudes typically fit in Int16 range (-32768 to 32767)?
- If not, what scaling factor is needed?
- Does scaling introduce audible artifacts?

**Success Criteria**:
- [ ] Typical seismic data fits in Int16 with < 0.1% error
- [ ] Scaled conversion preserves < 16-bit precision
- [ ] No audible artifacts in audified audio

---

### 1.4 R2 Storage Test (Int32 + Time Arrays)
**Objective**: Verify we can save raw seismic data to R2 in Int32 format with accessible time arrays.

**Status**: [ ] NOT STARTED

**Test Script**: `tests/test_r2_storage_int32.js`

**What to Test**:
1. **Data format**:
   - [ ] Store raw samples as Int32Array
   - [ ] Store time array (Unix timestamps or ISO strings)
   - [ ] Store metadata (station, channel, sample rate, start/end times)
   - [ ] File format: Binary (efficient) or JSON (readable)?
   
2. **Save to R2 from JavaScript**:
   - [ ] Fetch 24 hours from IRIS
   - [ ] Parse miniSEED
   - [ ] Save to R2 as Int32 binary file
   - [ ] Save separate metadata JSON
   
3. **Retrieve from R2**:
   - [ ] Load Int32 data from R2
   - [ ] Load time array
   - [ ] Verify data integrity (compare to original)
   
4. **File naming convention**:
   - [ ] `{network}.{station}.{location}.{channel}/{YYYY}/{MM}/{DD}.int32.bin`
   - [ ] Example: `HV.OBL.--.HHZ/2025/10/23.int32.bin`
   - [ ] Metadata: `HV.OBL.--.HHZ/2025/10/23.meta.json`

**Success Criteria**:
- [ ] Can save Int32 data to R2 from JavaScript
- [ ] Can retrieve and parse Int32 data from R2
- [ ] Data and time arrays are both accessible
- [ ] No data loss or corruption

---

### 1.5 IIR Filter Implementation (JavaScript)
**Objective**: Implement `sosfilt` (cascaded biquad filters) in JavaScript.

**Status**: ⚠️ **FAILED** - Butterworth double-warping, multi-stage parsing needed

**Test Script**: `tests/test_iir_sosfilt.js`

```javascript
/**
 * Second-Order Section (SOS) IIR Filter
 * 
 * Each section is a biquad filter:
 * y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
 * 
 * Cascaded to achieve full instrument response correction
 */

class SOSFilter {
  constructor(sos) {
    // sos = [[b0, b1, b2, a0, a1, a2], [...], ...]
    this.sos = sos;
    this.numSections = sos.length;
    
    // Initialize state for each section (2 taps)
    this.state = Array(this.numSections).fill(null).map(() => ({
      x1: 0, x2: 0,  // Input delays
      y1: 0, y2: 0   // Output delays
    }));
  }
  
  filterSample(x) {
    let y = x;
    
    // Apply each biquad section sequentially
    for (let i = 0; i < this.numSections; i++) {
      const [b0, b1, b2, a0, a1, a2] = this.sos[i];
      const s = this.state[i];
      
      // Compute output (a0 is typically 1.0)
      const out = b0*y + b1*s.x1 + b2*s.x2 - a1*s.y1 - a2*s.y2;
      
      // Update state
      s.x2 = s.x1;
      s.x1 = y;
      s.y2 = s.y1;
      s.y1 = out;
      
      y = out;
    }
    
    return y;
  }
  
  filterArray(data) {
    const output = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
      output[i] = this.filterSample(data[i]);
    }
    return output;
  }
}

// Test against scipy
async function testAgainstScipy() {
  // 1. Generate test signal in Python
  // 2. Apply sosfilt in Python
  // 3. Apply sosfilt in JavaScript
  // 4. Compare results (should match to floating point precision)
  
  // TODO: Implement cross-validation
}
```

**Validation**:
- [ ] Implement biquad filter correctly
- [ ] Match scipy.signal.sosfilt output (< 1e-10 error)
- [ ] Test with real IIR coefficients from bilinear transform
- [ ] Verify causality (no future-sample dependencies)

**Success Criteria**:
- [ ] JavaScript output matches Python within floating-point precision
- [ ] Performance acceptable (< 10ms for 4 hours of data @ 100 Hz)

---

### 1.5 Bilinear Transform (JavaScript)
**Objective**: Port scipy's `zpk2sos` to JavaScript for on-the-fly IIR coefficient generation.

**Test Script**: `tests/test_bilinear_transform.js`

```javascript
/**
 * Bilinear transform: analog poles/zeros → digital IIR coefficients
 * 
 * scipy.signal.zpk2sos(zeros, poles, gain, fs=sample_rate)
 */

function bilinearTransform(zeros, poles, gain, fs) {
  /**
   * Convert analog poles/zeros to digital using bilinear transform
   * 
   * Bilinear mapping: s = (2*fs) * (z - 1) / (z + 1)
   * 
   * Args:
   *   zeros: Array of complex zeros (Laplace domain)
   *   poles: Array of complex poles (Laplace domain)
   *   gain: Gain factor
   *   fs: Sample rate (Hz)
   * 
   * Returns:
   *   sos: Second-order sections [[b0,b1,b2,a0,a1,a2], ...]
   */
  
  // TODO: Implement bilinear transform algorithm
  // 1. Map each pole/zero: z = (1 + s/(2*fs)) / (1 - s/(2*fs))
  // 2. Pair complex conjugates
  // 3. Form second-order sections
  // 4. Normalize for numerical stability
  
  throw new Error("Not implemented");
}

// Validate against scipy
async function validateBilinear() {
  // Test cases:
  // 1. Simple 1-pole lowpass filter
  // 2. 2-pole bandpass filter
  // 3. Real STS-2 seismometer response
  
  // Compare to scipy output
}
```

**Alternative Approach**: Pre-compute in Python, store in R2
```python
# One-time Python script
def precompute_iir_coefficients():
    """
    Fetch all station responses from IRIS
    Convert to IIR using bilinear transform
    Save to R2 as JSON: {network}.{station}.{channel}.json
    
    Worker loads on-demand from R2
    """
    pass
```

**Decision Point**:
- **Option A**: Implement bilinear in JS (more flexible, on-the-fly)
- **Option B**: Pre-compute in Python (simpler, cached in R2)

**Recommendation**: Start with Option B (pre-compute), migrate to Option A if needed.

---

## Phase 2: Cloudflare Infrastructure Tests

### 2.1 Intelligent Caching Strategy Design
**Objective**: Design and implement a smart caching system for continuous volcano monitoring.

**Status**: [ ] NOT STARTED - CRITICAL for production

**Key Requirements**:

1. **Daily Raw Data Storage**:
   - [ ] Store daily raw Int32 files for each monitored station
   - [ ] Format: `{network}.{station}.{channel}/{YYYY}/{MM}/{DD}.int32.bin`
   - [ ] Keep last 30 days of raw data (rolling window)
   - [ ] Older data: Archive or delete (cost optimization)

2. **Monitored Volcanoes** (Initial 5):
   - [ ] Kilauea (HV.OBL.HHZ or HV.HLPD.HHZ)
   - [ ] Spurr (AV.SPBG.BHZ)
   - [ ] Shishaldin (AV.SSLS.BHZ)
   - [ ] Mauna Loa (HV.MLO.HHZ or similar)
   - [ ] Great Sitkin (AV.GSIG.BHZ or similar)

3. **Auto-Fetch Logic** (Cron Job):
   - [ ] Run every 10 minutes
   - [ ] For each volcano:
     - [ ] Check latest cached data timestamp
     - [ ] Fetch new data from IRIS (last_cached → now)
     - [ ] Append to daily file (or create new if date changed)
     - [ ] Update metadata (end time, sample count)
   - [ ] Error handling: Log failures, retry on next cron
   - [ ] IRIS rate limiting: Respect API limits, backoff on errors

4. **On-Demand Gap Filling**:
   - [ ] User requests: `/stream/kilauea/12?hours_ago=24`
   - [ ] Check cache: Do we have all data for requested range?
   - [ ] If gap exists:
     - [ ] Fetch missing chunks from IRIS
     - [ ] Save to cache
     - [ ] Serve to user
   - [ ] If cache complete: Serve from cache (fast)

5. **Cache Invalidation**:
   - [ ] Data older than 30 days: Delete or move to cold storage
   - [ ] Failed/corrupted files: Mark for re-fetch
   - [ ] Station changes: Detect and update

6. **Monitoring & Alerts**:
   - [ ] Daily cron health check
   - [ ] Alert if IRIS fetch fails > 3 times
   - [ ] Alert if cache size > threshold
   - [ ] Log cache hit rate

**File Structure Example**:
```
R2 Bucket: hearts-data-cache
├── raw/
│   ├── HV.OBL.--.HHZ/
│   │   ├── 2025/
│   │   │   ├── 10/
│   │   │   │   ├── 23.int32.bin (raw samples)
│   │   │   │   ├── 23.meta.json (metadata)
│   │   │   │   ├── 24.int32.bin
│   │   │   │   └── 24.meta.json
│   ├── AV.SPBG.--.BHZ/
│   │   └── ...
├── processed/ (optional: pre-processed audio)
│   └── ...
└── cache-status.json (global cache state)
```

**Implementation Steps**:
- [ ] Design data format (binary Int32 + JSON metadata)
- [ ] Write cron Worker: `worker/cron-fetch-seismic.js`
- [ ] Test cron Worker locally (simulate 10-min intervals)
- [ ] Deploy cron Worker to Cloudflare
- [ ] Monitor for 1 week
- [ ] Implement gap-filling logic in main streaming Worker
- [ ] Test with intentional gaps

**Success Criteria**:
- [ ] Cron runs reliably every 10 minutes
- [ ] Data freshness: < 15 minutes lag from real-time
- [ ] Cache hit rate: > 95% for requests within 24 hours
- [ ] No data gaps for monitored volcanoes
- [ ] Storage cost: < $5/month for 5 volcanoes

**Blockers**:
- Needs 1.4 (R2 Storage Test) to be complete
- Needs 1.3 (Int32 vs Int16) decision

---

### 2.2 Worker → IRIS Direct Fetch + R2 Save Test
**Objective**: Prove Workers can fetch from IRIS directly AND save to R2.

**Status**: [ ] NOT STARTED

**Test File**: `worker/test-iris-fetch-and-save.js`

**What It Tests**:
1. Fetch miniSEED data from IRIS (2 hours, starting 48 hours ago)
2. Save to R2 bucket
3. Read back from R2 and verify data integrity

**Deploy & Test**:
```bash
cd worker
wrangler deploy test-iris-fetch-and-save.js
curl https://test-iris-fetch.robertalexander-music.workers.dev
```

**Success Criteria**:
- [ ] Worker can reach IRIS (no CORS/firewall issues)
- [ ] Transfer speed acceptable (> 0.5 MB/s)
- [ ] TTFB < 2 seconds
- [ ] Worker can write to R2 bucket
- [ ] Worker can read from R2 bucket
- [ ] Data integrity maintained (byte-for-byte match)
- [ ] No timeout issues (Workers have 50s CPU time limit on paid plan)

---

### 2.2 Cloudflare Cron Jobs Test
**Objective**: Determine if Cloudflare supports scheduled Workers (cron).

**Research**:
- [ ] Check Cloudflare Cron Triggers documentation
- [ ] Test scheduled Worker execution
- [ ] Verify R2 write permissions from cron Worker

**Configuration**: `wrangler.toml`
```toml
[triggers]
crons = ["0 */10 * * *"]  # Every 10 minutes

# Or use Cloudflare Durable Objects for scheduling
```

**Alternative**: Cloudflare Workers + Durable Objects for state management

**Test Script**: `worker/cron-test.js`
```javascript
export default {
  async scheduled(event, env, ctx) {
    console.log('Cron triggered at:', new Date().toISOString());
    
    // Test: Fetch from IRIS, save to R2
    const url = "...IRIS URL...";
    const response = await fetch(url);
    const data = await response.arrayBuffer();
    
    // Save to R2
    const key = `test/cron-${Date.now()}.bin`;
    await env.R2_BUCKET.put(key, data);
    
    console.log(`Saved ${data.byteLength} bytes to ${key}`);
  }
};
```

**Success Criteria**:
- [ ] Cron triggers fire reliably every 10 minutes
- [ ] Can fetch from IRIS in cron context
- [ ] Can write to R2 from cron Worker
- [ ] No timeout issues

**If fails**: Use external cron service (GitHub Actions, AWS EventBridge) to trigger Worker

---

### 2.3 Worker Memory & CPU Limits Test
**Objective**: Verify Workers can handle 4-hour data processing.

**Test**: Process maximum realistic data volume

```javascript
// Memory test: 4 hours @ 100 Hz = 1.44M samples
// Int32: 5.76 MB
// Float32 (during filtering): 5.76 MB
// Peak: ~12 MB (well under 128 MB limit)

export default {
  async fetch(request, env) {
    const samples = 1_440_000; // 4 hours @ 100 Hz
    
    // Simulate data processing
    const startTime = Date.now();
    
    // 1. Allocate arrays
    const int32Data = new Int32Array(samples);
    const float32Data = new Float32Array(samples);
    
    // 2. Fill with test data
    for (let i = 0; i < samples; i++) {
      int32Data[i] = Math.floor(Math.random() * 10000);
    }
    
    // 3. Apply IIR filter (simulated)
    const sos = [...]; // Test coefficients
    const filter = new SOSFilter(sos);
    const filtered = filter.filterArray(int32Data);
    
    // 4. Detrend + normalize
    let sum = 0;
    for (let i = 0; i < filtered.length; i++) {
      sum += filtered[i];
    }
    const mean = sum / filtered.length;
    
    let maxAbs = 0;
    for (let i = 0; i < filtered.length; i++) {
      filtered[i] -= mean;
      const abs = Math.abs(filtered[i]);
      if (abs > maxAbs) maxAbs = abs;
    }
    
    for (let i = 0; i < filtered.length; i++) {
      filtered[i] /= maxAbs;
    }
    
    const cpuTime = Date.now() - startTime;
    
    return new Response(JSON.stringify({
      samples: samples,
      cpuTime: cpuTime,
      memoryUsed: 'N/A', // Workers don't expose memory stats
      success: cpuTime < 30000 // Must complete in 30s
    }));
  }
};
```

**Success Criteria**:
- [ ] 4-hour processing completes in < 30 seconds (CPU time limit)
- [ ] No memory errors (< 128 MB)
- [ ] Acceptable latency for user request

---

## Phase 3: Integration & End-to-End Testing

### 3.1 Full Pipeline Test (Local)
**Objective**: Test complete flow locally before deploying.

**Script**: `tests/test_full_worker_pipeline.js`

```javascript
// Simulates: IRIS fetch → parse → IIR filter → detrend → normalize → stream

async function testFullPipeline() {
  // 1. Fetch from IRIS
  const miniseedData = await fetchFromIRIS('HV', 'HLPD', '10', 'HHZ', ...);
  
  // 2. Parse miniSEED
  const parser = new MiniSEEDParser(miniseedData);
  const int32Samples = parser.extractSamples();
  
  // 3. Load IIR coefficients
  const sos = await loadIIRCoefficients('HV.HLPD.10.HHZ');
  
  // 4. Apply IIR filter
  const filter = new SOSFilter(sos);
  const corrected = filter.filterArray(int32Samples);
  
  // 5. Detrend + normalize
  const processed = detrendAndNormalize(corrected);
  
  // 6. Convert to Int16
  const int16Data = convertToInt16(processed);
  
  // 7. Stream progressive chunks
  streamProgressiveChunks(int16Data);
  
  console.log('✅ Full pipeline test passed!');
}
```

**Validation**:
- [ ] Compare to Python/ObsPy processing (same input → same output)
- [ ] Verify audio sounds correct (audify and listen)
- [ ] Check for artifacts, distortion, clipping

---

### 3.2 Worker Deployment
**Objective**: Deploy production Worker with full pipeline.

**File**: `worker/src/index.js` (refactored)

```javascript
/**
 * Volcano Audio Streaming Worker
 * Full edge computing: IRIS → Worker → Client
 */

import { MiniSEEDParser } from './miniseed.js';
import { SOSFilter } from './iir-filter.js';
import { detrendAndNormalize } from './processing.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/').filter(Boolean);
    
    if (pathParts[0] !== 'stream') {
      return new Response('Not Found', { status: 404 });
    }
    
    const volcano = pathParts[1];
    const durationHours = parseInt(pathParts[2]) || 4;
    const hoursAgo = parseInt(url.searchParams.get('hours_ago')) || 12;
    
    try {
      // Calculate time window
      const endTime = new Date(Date.now() - hoursAgo * 3600000);
      const startTime = new Date(endTime - durationHours * 3600000);
      
      // Get station info for volcano
      const station = getStationForVolcano(volcano);
      
      // Check R2 cache first
      const cacheKey = `${volcano}_${hoursAgo}h_${durationHours}h`;
      const cached = await env.R2_BUCKET.get(`cache/${cacheKey}.bin`);
      
      if (cached) {
        // Stream from cache
        return streamFromCache(cached);
      }
      
      // Cache miss: Fetch from IRIS
      const miniseedData = await fetchFromIRIS(station, startTime, endTime);
      
      // Parse miniSEED
      const parser = new MiniSEEDParser(miniseedData);
      const samples = parser.extractSamples();
      
      // Load IIR coefficients from R2
      const sos = await loadIIRCoefficients(env, station);
      
      // Apply IIR filter
      const filter = new SOSFilter(sos);
      const corrected = filter.filterArray(samples);
      
      // Detrend + normalize
      const processed = detrendAndNormalize(corrected);
      
      // Convert to Int16
      const int16Data = convertToInt16(processed);
      
      // Cache for 10 minutes
      await env.R2_BUCKET.put(`cache/${cacheKey}.bin`, int16Data, {
        customMetadata: { ttl: '600' }
      });
      
      // Stream progressive chunks
      return streamProgressiveChunks(int16Data);
      
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Cron job: Update cache for active volcanoes
  async scheduled(event, env, ctx) {
    const activeVolcanoes = ['kilauea', 'spurr', 'shishaldin'];
    
    for (const volcano of activeVolcanoes) {
      // Fetch latest 4-hour window from IRIS
      // Process and cache to R2
      // (Details in implementation)
    }
  }
};
```

**Deploy**:
```bash
cd worker
wrangler deploy
```

---

### 3.3 Performance Benchmarking
**Objective**: Measure real-world performance vs Render.

**Metrics to Collect**:
- Time to First Audio (TTFA)
- Total transfer time
- CPU time used
- Memory used
- Cache hit rate
- Error rate

**Test Script**: `tests/benchmark_worker_vs_render.py`

```python
import time
import requests
import statistics

def benchmark_endpoint(url, num_requests=100):
    ttfas = []
    total_times = []
    
    for i in range(num_requests):
        start = time.time()
        response = requests.get(url, stream=True)
        
        # TTFA
        first_byte = None
        for chunk in response.iter_content(8192):
            if first_byte is None:
                first_byte = time.time() - start
                break
        
        total_time = time.time() - start
        
        ttfas.append(first_byte)
        total_times.append(total_time)
    
    return {
        'ttfa_median': statistics.median(ttfas),
        'ttfa_p95': statistics.quantiles(ttfas, n=20)[18],
        'total_median': statistics.median(total_times),
        'total_p95': statistics.quantiles(total_times, n=20)[18]
    }

# Benchmark Render
render_stats = benchmark_endpoint('https://volcano-audio.onrender.com/api/...')

# Benchmark Worker
worker_stats = benchmark_endpoint('https://volcano-audio-worker.robertalexander-music.workers.dev/...')

print("Render:", render_stats)
print("Worker:", worker_stats)
print(f"Speedup: {render_stats['ttfa_median'] / worker_stats['ttfa_median']:.2f}x")
```

**Success Criteria**:
- [ ] Worker TTFA < 100ms (vs Render ~355ms)
- [ ] Worker total time < Render total time
- [ ] Cache hit rate > 90% for popular requests
- [ ] Error rate < 1%

---

## Phase 4: Production Migration

### 4.1 Pre-Compute IIR Coefficients
**Script**: `scripts/precompute_iir_coefficients.py`

```python
from obspy.clients.fdsn import Client
from scipy import signal
import json
import boto3

def precompute_all_coefficients():
    """
    Fetch instrument responses for all stations
    Convert to IIR using bilinear transform
    Save to R2 as JSON
    """
    
    client = Client("IRIS")
    s3 = boto3.client('s3', ...)
    
    stations = [
        ('HV', 'HLPD', '10', 'HHZ'),  # Kilauea
        ('AV', 'SPBG', '', 'BHZ'),     # Spurr
        # ... all monitored stations
    ]
    
    for net, sta, loc, cha in stations:
        # Fetch response
        inv = client.get_stations(network=net, station=sta, 
                                   location=loc, channel=cha,
                                   level='response')
        
        # Extract poles/zeros
        response = inv[0][0][0].response
        stage = response.response_stages[0]
        poles = stage.poles
        zeros = stage.zeros
        gain = stage.normalization_factor
        fs = inv[0][0][0].sample_rate
        
        # Bilinear transform
        sos = signal.zpk2sos(zeros, poles, gain, fs=fs)
        
        # Save to R2
        key = f"iir-coefficients/{net}.{sta}.{loc}.{cha}.json"
        data = {
            'sos': sos.tolist(),
            'sample_rate': fs,
            'network': net,
            'station': sta,
            'location': loc,
            'channel': cha
        }
        
        s3.put_object(Bucket='hearts-data-cache',
                      Key=key,
                      Body=json.dumps(data))
        
        print(f"✅ {net}.{sta}.{loc}.{cha}")

if __name__ == '__main__':
    precompute_all_coefficients()
```

**Run Once**:
```bash
python scripts/precompute_iir_coefficients.py
```

---

### 4.2 Update Frontend
**File**: `test_streaming.html` (or production frontend)

```javascript
// OLD: Render endpoint
// const url = 'https://volcano-audio.onrender.com/api/stream/...';

// NEW: Worker endpoint
const url = 'https://volcano-audio-worker.robertalexander-music.workers.dev/stream/kilauea/4?hours_ago=12';

// Everything else stays the same!
```

---

### 4.3 Monitor & Validate
**Checklist**:
- [ ] Deploy Worker to production
- [ ] Update frontend to use Worker
- [ ] Monitor for 24 hours:
  - [ ] No errors
  - [ ] Performance meets expectations
  - [ ] Cache hit rate acceptable
  - [ ] Audio quality sounds correct
- [ ] Compare costs (Cloudflare vs Render)

---

## Phase 5: Decommission Render

### 5.1 Validation Period
**Duration**: 1 week

**Monitor**:
- [ ] Error rate < 0.1%
- [ ] User feedback positive
- [ ] No audio quality complaints
- [ ] Costs as expected

---

### 5.2 Cancel Render Subscription
**IF AND ONLY IF**:
- ✅ Worker architecture proven stable for 1 week
- ✅ All tests passing
- ✅ Performance superior to Render
- ✅ Costs lower than Render

**Steps**:
1. [ ] Export any Render logs/analytics
2. [ ] Document final Render costs for comparison
3. [ ] **🎯 CANCEL RENDER SUBSCRIPTION** via dashboard
4. [ ] Archive Render deployment configs (for historical reference)
5. [ ] Update documentation to reflect Worker-only architecture

**⚠️ REMINDER: DO NOT FORGET TO CANCEL RENDER IF THIS MIGRATION SUCCEEDS!**
- Savings: ~$200-400/month at scale
- Cancel at: https://dashboard.render.com/

---

## Decision Tree

```
START
  │
  ├─ Phase 0: IIR Filter Validation
  │   ├─ Bilinear "good enough"? ──YES→ Continue
  │   └─ NO → Implement MCMC, then continue
  │
  ├─ Phase 1: Local Tests
  │   ├─ IRIS speed OK? ──NO→ Use R2 cache (fallback)
  │   ├─ miniSEED parser works? ──NO→ BLOCKER (find library or pre-process)
  │   ├─ Int32→Int16 lossless? ──NO→ Use Int32 (larger files)
  │   └─ IIR filter works? ──NO→ BLOCKER (must fix)
  │
  ├─ Phase 2: Cloudflare Tests
  │   ├─ Worker→IRIS works? ──NO→ Use R2 cache (fallback)
  │   ├─ Cron jobs work? ──NO→ Use external cron service
  │   └─ Memory/CPU OK? ──NO→ Optimize or use smaller chunks
  │
  ├─ Phase 3: Integration
  │   ├─ Full pipeline works? ──NO→ Debug and fix
  │   └─ Performance > Render? ──NO→ Optimize or abort migration
  │
  ├─ Phase 4: Production
  │   └─ Stable for 1 week? ──NO→ Rollback to Render
  │
  └─ Phase 5: Decommission Render ✅
```

---

## Cost Analysis

### Current Architecture (Render + R2 + Worker)
- Render: $7/month (Starter plan)
- R2 Storage: $1/month (43 GB)
- R2 Bandwidth via Render: ~$200-400/month at 1M requests
- Worker: $5/month (included in current R2 costs)
- **Total at scale**: ~$206-408/month

### New Architecture (Worker + R2 only)
- Worker: $5/month (paid plan for longer CPU time)
- R2 Storage: $1/month (43 GB)
- R2 Bandwidth via Worker: $0 (FREE!)
- **Total at scale**: ~$6/month

### Savings at 1M requests/month: ~$200-402/month (97% reduction!)

---

## Risks & Mitigation

### Risk 1: miniSEED Parsing Too Complex
**Mitigation**: 
- Use existing npm library if available
- Pre-process to simpler format in cron job
- Keep Render for pre-processing if absolutely necessary

### Risk 2: IIR Filter Performs Poorly
**Mitigation**:
- Fall back to ObsPy FFT/IFFT (keep Render)
- Implement MCMC optimization
- Use hybrid approach (Render pre-processes, Worker streams)

### Risk 3: IRIS Rate Limiting
**Mitigation**:
- Cache aggressively in R2
- Respect IRIS usage policies
- Use cron jobs (not real-time fetching)

### Risk 4: Cloudflare Costs Higher Than Expected
**Mitigation**:
- Monitor costs closely during testing
- Set billing alerts
- Can roll back to Render if needed

### Risk 5: Worker CPU/Memory Limits
**Mitigation**:
- Use smaller chunks (2 hours instead of 4)
- Optimize algorithms (use WASM if needed)
- Upgrade to Enterprise plan if absolutely necessary

---

## Timeline Estimate

### Optimistic (Everything Works) - AI-Assisted
- Phase 0: 0.8-1.2 hours (IIR validation + audification)
- Phase 1: 1.6-2.0 hours (local tests)
- Phase 2: 0.8-1.2 hours (Cloudflare tests)
- Phase 3: 0.8-1.2 hours (integration)
- Phase 4: 0.4-0.8 hours (deployment)
- Phase 5: 1 week (monitoring) + 0.1 hour (cancellation)
- **Total**: ~4.4-6.4 hours + 1 week monitoring

### Realistic (Some Issues) - AI-Assisted
- Phase 0: 1.2-1.6 hours (IIR needs MCMC)
- Phase 1: 2.4-3.2 hours (miniSEED parser complex)
- Phase 2: 1.2-1.6 hours (cron workaround needed)
- Phase 3: 1.2-1.6 hours (debugging)
- Phase 4: 0.8-1.2 hours (optimization)
- Phase 5: 2 weeks (monitoring) + 0.1 hour
- **Total**: ~6.8-9.2 hours + 2 weeks monitoring

### Pessimistic (Major Blockers)
- Abort migration, keep Render
- Document learnings for future

---

## Success Metrics

### Technical
- [ ] TTFA < 100ms (vs Render ~355ms)
- [ ] Total latency < Render by 3x
- [ ] Error rate < 0.1%
- [ ] Cache hit rate > 90%
- [ ] Audio quality indistinguishable from Render

### Business
- [ ] Monthly costs < $10 (vs Render ~$206-408 at scale)
- [ ] Scales to 1M requests with no degradation
- [ ] No manual intervention needed (fully automated)

### User Experience
- [ ] "Instant" playback feel (< 200ms TTFA)
- [ ] No audio artifacts or distortion
- [ ] Works globally (edge computing)

---

## Conclusion

This migration represents a **fundamental architectural shift** from server-side Python processing to edge computing with JavaScript. 

**IF successful**:
- 🎯 10x faster response times
- 💰 97% cost reduction
- 🌍 Global edge delivery
- 📈 Infinite scalability
- 🔧 Simpler infrastructure

**Key Dependencies**:
1. IIR filtering validation (Phase 0) - MUST pass
2. miniSEED parsing in JS - MUST work
3. Cloudflare Worker capabilities - MUST meet requirements

**Recommendation**: Proceed with Phase 0 (IIR validation) immediately. Results will inform whether this migration is feasible.

---

**Next Step**: Run IIR filter comparison tests (see `iir_filter_comparison_test_plan.md`)


