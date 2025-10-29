# IIR Filter Comparison Test Plan
## Bilinear vs Anderson's MCMC vs FFT/IFFT for Volcanic Seismic Streaming

**Created**: October 22, 2025  
**Status**: Ready to Implement  
**Purpose**: Determine if scipy's bilinear transform is "good enough" for streaming volcanic audio compared to Anderson's optimized MCMC method

---

## Executive Summary

### The Central Question
**Can we use scipy's simple bilinear IIR transform for real-time volcanic audio streaming, or do we need Anderson's computationally expensive MCMC optimization?**

### Why This Matters
- **Streaming requirement**: Need to process seismic data chunk-by-chunk in real-time
- **FFT/IFFT is not viable**: Requires full waveform, produces reconstruction artifacts
- **IIR is essential**: Enables true streaming with direct filtering
- **Performance vs Quality trade-off**: Bilinear is fast but approximate; MCMC is slow but optimized

---

## Background: The Fundamental Problem

### What We're Trying To Do
Remove **instrument response** from seismic recordings to get true ground motion (velocity or acceleration).

**Instrument response** = How the seismometer naturally distorts/colors the signal based on its physical properties (mass, springs, dampening, electronics).

**Example**: An STS-2 seismometer has:
- Natural resonance at ~0.008 Hz (120 second period)
- Roll-off at high frequencies
- Phase shifts across spectrum
- Amplification factors

**We need to "undo" this response to recover true ground motion.**

### The Three Approaches

#### Approach 1: FFT/IFFT (Analysis-Resynthesis)
**What it does:**
```
Raw Time-Domain Data
    ↓ FFT
Frequency Bins (complex amplitudes)
    ↓ Divide by instrument response
Modified Frequency Bins
    ↓ IFFT (RECONSTRUCTION!)
"Corrected" Time-Domain Data
```

**Critical flaw**: The output is a **reconstruction** from frequency components, NOT the original data!

**Problems**:
- ❌ Original sample values are destroyed
- ❌ Spectral leakage from windowing
- ❌ Gibbs phenomenon at discontinuities
- ❌ Edge effects require padding/tapering
- ❌ Requires entire waveform (can't stream)
- ❌ Introduces synthesis artifacts
- ❌ Time-domain precision lost in round-trip

**When it's used**: ObsPy's `remove_response()` method (default in seismology)

**Why seismologists accept it**: Historical reasons, computational simplicity, "good enough" for earthquake analysis (not real-time streaming)

#### Approach 2: Bilinear IIR Transform
**What it does:**
```
Analog Poles/Zeros (Laplace domain, continuous time)
    ↓ Bilinear Transform (simple mapping)
Digital IIR Coefficients (z-domain, discrete time)
    ↓ Apply IIR filter directly to samples
Filtered Time-Domain Data (DIRECT, no reconstruction!)
```

**How it works:**
```python
# Bilinear transform: s = 2*fs * (z-1)/(z+1)
# Maps analog poles/zeros to digital domain
sos = signal.zpk2sos(zeros, poles, gain, fs=sample_rate)
filtered = signal.sosfilt(sos, raw_data)
```

**Advantages**:
- ✅ Works with **actual samples** (no reconstruction)
- ✅ Direct convolution in time domain
- ✅ Can stream chunk-by-chunk
- ✅ Low latency (sample-by-sample if needed)
- ✅ Computationally efficient
- ✅ Preserves original data structure

**Disadvantages**:
- ⚠️ **Frequency warping** at high frequencies
- ⚠️ Approximation of analog response
- ⚠️ Most accurate near DC, less accurate near Nyquist

**Frequency warping**: 
- The bilinear transform compresses the entire analog frequency range (0 to ∞) into digital range (0 to Nyquist)
- Uses mapping: `Ω = 2*fs*tan(ω/2)` where Ω=analog, ω=digital
- **Result**: High frequencies get "squashed" toward Nyquist
- **Impact**: For volcanic monitoring (0.5-10 Hz with fs=100 Hz), warping is minimal

#### Approach 3: Anderson's MCMC IIR Optimization
**What it does:**
```
Analog Poles/Zeros
    ↓ MCMC Optimization (5-10 minutes!)
Optimized Digital Poles/Zeros
    ↓ Convert to IIR coefficients
Digital IIR Coefficients (optimized for target frequency range)
    ↓ Apply IIR filter directly to samples
Filtered Time-Domain Data (DIRECT, no reconstruction!)
```

**The MCMC Process**:
1. Start with analog poles/zeros from manufacturer specs
2. Apply bilinear transform as initial guess
3. Run Markov Chain Monte Carlo optimization:
   - Randomly perturb pole/zero locations
   - Evaluate frequency response error in target range (e.g., 0.5-10 Hz)
   - Accept if error decreases (or probabilistically if increases)
   - Repeat for thousands of iterations
4. Result: Digital poles/zeros that minimize error in volcanic frequency range

**Advantages**:
- ✅ All benefits of IIR (streaming, direct filtering, etc.)
- ✅ **Optimized for specific frequency range** (e.g., 0.5-10 Hz volcanic monitoring)
- ✅ Minimizes frequency warping in target range
- ✅ Better frequency response accuracy than bilinear

**Disadvantages**:
- ⚠️ Computationally expensive to **compute** (5-10 minutes per station/configuration)
- ⚠️ Complex implementation (MCMC algorithm)
- ⚠️ Must pre-compute for each station/sample rate combination

**Key insight**: MCMC is expensive to compute ONCE, but cheap to apply afterward (just IIR filtering)

---

## The Comparison Test

### Test Objective
**Compare three methods on THE SAME seismic data to determine if bilinear is "close enough" to Anderson's MCMC for volcanic monitoring.**

### Test Data Selection

**Pick a well-characterized station:**
- Network: IU (Global Seismic Network)
- Station: COLA (College Outpost, Alaska) or POHA (Pohakuloa, Hawaii)
- Channel: BHZ (Broadband High-gain, Vertical)
- Date: 2015-06-01 (known good metadata)
- Duration: 1 hour of continuous data
- Sample Rate: 100 Hz (or 40 Hz)

**Why this station:**
- Global network = excellent metadata quality
- STS-2 seismometer = well-documented response
- Historical data = stable, complete
- Volcanic-relevant location

### Method Implementation

#### Method 1: FFT/IFFT (Baseline for comparison)
```python
from obspy import read
from obspy.clients.fdsn import Client

# Fetch data
client = Client("IRIS")
st = client.get_waveforms("IU", "COLA", "10", "BHZ", 
                          starttime, endtime,
                          attach_response=True)

# Apply FFT/IFFT response removal
st_fft = st.copy()
st_fft.remove_response(output='VEL', pre_filt=None)

# Note: This is analysis-resynthesis!
fft_data = st_fft[0].data
```

**What happens internally:**
1. FFT of raw data
2. Compute instrument response in frequency domain
3. Divide FFT by response
4. IFFT to reconstruct time-domain signal
5. Return reconstructed data (NOT original samples!)

#### Method 2: Bilinear IIR
```python
from scipy import signal
import numpy as np

# Get instrument response (poles, zeros, gain)
inv = client.get_stations(network="IU", station="COLA", 
                          location="10", channel="BHZ",
                          starttime=starttime, level="response")

paz = inv[0][0][0].response.response_stages[0]
poles = paz.poles
zeros = paz.zeros
gain = paz.normalization_factor
fs = inv[0][0][0].sample_rate

# Convert to IIR using bilinear transform
sos = signal.zpk2sos(zeros, poles, gain)

# Apply IIR filter directly to raw data
raw_data = st[0].data
bilinear_data = signal.sosfilt(sos, raw_data)

# Note: Working with ACTUAL samples!
```

**What happens:**
1. Simple algebraic mapping: `s = 2*fs*(z-1)/(z+1)`
2. Convert analog poles/zeros to digital
3. Package as Second-Order Sections (SOS) for numerical stability
4. Apply difference equation directly to samples

#### Method 3: Anderson's MCMC IIR
```python
# Extract Anderson's MCMC implementation from R
# (Need to translate from TDD package)

def anderson_mcmc_iir(poles, zeros, gain, fs, 
                      target_freq_range=(0.5, 10.0),
                      n_iterations=50000):
    """
    Run Anderson's MCMC optimization on poles/zeros
    
    Args:
        poles: Array of analog poles (complex)
        zeros: Array of analog zeros (complex)
        gain: Normalization gain factor
        fs: Sample rate (Hz)
        target_freq_range: (f_min, f_max) to optimize for
        n_iterations: MCMC iterations (more = better, slower)
    
    Returns:
        sos: Optimized IIR coefficients (SOS format)
    """
    # 1. Apply bilinear as initial guess
    # 2. Define frequency response error metric
    # 3. MCMC loop:
    #    - Propose new pole/zero locations
    #    - Evaluate error in target frequency range
    #    - Accept/reject based on Metropolis criterion
    # 4. Convert best poles/zeros to SOS
    # 5. Return optimized IIR
    
    # TODO: Implement from TDD R code
    pass

# Run MCMC optimization (takes 5-10 minutes!)
sos_mcmc = anderson_mcmc_iir(poles, zeros, gain, fs)

# Apply optimized IIR filter
mcmc_data = signal.sosfilt(sos_mcmc, raw_data)

# Note: Still working with ACTUAL samples!
```

**What happens:**
1. Start with bilinear-transformed poles/zeros
2. Run MCMC to find better pole/zero placement
3. Minimize frequency response error in 0.5-10 Hz
4. Convert optimized poles/zeros to IIR
5. Apply to samples (same as bilinear, but optimized coefficients)

### Comparison Metrics

#### 1. Frequency Response Accuracy
**Compute frequency responses:**
```python
from scipy import signal

# Frequency range: 0.1 to 50 Hz (Nyquist for 100 Hz sampling)
freqs = np.logspace(-1, np.log10(50), 1000)

# Compute frequency response for each method
# (Compare to "true" analog response)
_, H_analog = signal.freqs_zpk(zeros, poles, gain, worN=freqs*2*np.pi)
_, H_bilinear = signal.sosfreqz(sos_bilinear, worN=freqs, fs=fs)
_, H_mcmc = signal.sosfreqz(sos_mcmc, worN=freqs, fs=fs)

# Calculate errors
mag_error_bilinear = np.abs(H_bilinear - H_analog) / np.abs(H_analog) * 100
mag_error_mcmc = np.abs(H_mcmc - H_analog) / np.abs(H_analog) * 100

# Focus on volcanic range (0.5-10 Hz)
volcanic_mask = (freqs >= 0.5) & (freqs <= 10.0)
volcanic_error_bilinear = np.mean(mag_error_bilinear[volcanic_mask])
volcanic_error_mcmc = np.mean(mag_error_mcmc[volcanic_mask])
```

**Plot**: Magnitude response, Phase response, Error vs frequency

#### 2. Time-Domain Waveform Comparison
**Visual inspection:**
```python
import matplotlib.pyplot as plt

fig, axes = plt.subplots(4, 1, figsize=(14, 12))

# Plot all four waveforms
axes[0].plot(times, raw_data, 'k-', alpha=0.7, label='Raw')
axes[1].plot(times, fft_data, 'b-', alpha=0.7, label='FFT/IFFT')
axes[2].plot(times, bilinear_data, 'r-', alpha=0.7, label='Bilinear IIR')
axes[3].plot(times, mcmc_data, 'g-', alpha=0.7, label='Anderson MCMC IIR')

# Compute residuals
axes[1].plot(times, fft_data - mcmc_data, 'b--', alpha=0.5, label='FFT - MCMC')
axes[2].plot(times, bilinear_data - mcmc_data, 'r--', alpha=0.5, label='Bilinear - MCMC')
```

**Metrics:**
- RMS difference from MCMC (use MCMC as reference, not FFT!)
- Peak amplitude differences
- Cross-correlation coefficient

#### 3. Volcanic Frequency Range Analysis (0.5-10 Hz)
**Bandpass filter all outputs to volcanic range:**
```python
# Bandpass 0.5-10 Hz
sos_bp = signal.butter(4, [0.5, 10.0], btype='band', fs=fs, output='sos')

fft_volcanic = signal.sosfilt(sos_bp, fft_data)
bilinear_volcanic = signal.sosfilt(sos_bp, bilinear_data)
mcmc_volcanic = signal.sosfilt(sos_bp, mcmc_data)

# Compare amplitudes in volcanic range
rms_fft = np.sqrt(np.mean(fft_volcanic**2))
rms_bilinear = np.sqrt(np.mean(bilinear_volcanic**2))
rms_mcmc = np.sqrt(np.mean(mcmc_volcanic**2))

error_fft = np.abs(rms_fft - rms_mcmc) / rms_mcmc * 100
error_bilinear = np.abs(rms_bilinear - rms_mcmc) / rms_mcmc * 100
```

#### 4. Computational Performance
```python
import time

# Time FFT/IFFT
start = time.time()
st.remove_response(output='VEL')
fft_time = time.time() - start

# Time bilinear (one-time conversion + filtering)
start = time.time()
sos = signal.zpk2sos(zeros, poles, gain)
bilinear_data = signal.sosfilt(sos, raw_data)
bilinear_time = time.time() - start

# Time MCMC (one-time optimization + filtering)
start = time.time()
sos_mcmc = anderson_mcmc_iir(poles, zeros, gain, fs)
mcmc_compute_time = time.time() - start

start = time.time()
mcmc_data = signal.sosfilt(sos_mcmc, raw_data)
mcmc_apply_time = time.time() - start
```

**Report:**
- FFT/IFFT: X seconds (includes reconstruction)
- Bilinear: X seconds (includes zpk2sos conversion)
- MCMC: X seconds to compute + X seconds to apply

**Note**: MCMC is expensive ONCE but can be cached; subsequent filtering is identical to bilinear

#### 5. Streaming Viability
**Test chunk-by-chunk processing:**
```python
# Split data into 10-second chunks
chunk_size = int(10 * fs)  # 10 seconds
chunks = [raw_data[i:i+chunk_size] for i in range(0, len(raw_data), chunk_size)]

# Process with IIR (maintains filter state between chunks)
zi = signal.sosfilt_zi(sos_bilinear)
bilinear_chunks = []
for chunk in chunks:
    filtered, zi = signal.sosfilt(sos_bilinear, chunk, zi=zi)
    bilinear_chunks.append(filtered)

bilinear_streamed = np.concatenate(bilinear_chunks)

# Compare to full-waveform filtering
difference = bilinear_data - bilinear_streamed
max_error = np.max(np.abs(difference))

print(f"Streaming error: {max_error:.2e}")  # Should be ~1e-14 (floating point precision)
```

**FFT/IFFT cannot do this!** (Needs entire waveform)

---

## Success Criteria

### Primary Criteria: Is Bilinear "Good Enough"?

**PASS if:**
1. ✅ Frequency response error in 0.5-10 Hz < 5%
2. ✅ Time-domain waveforms visually similar to MCMC
3. ✅ RMS amplitude difference < 10% in volcanic range
4. ✅ Can stream chunk-by-chunk with negligible error
5. ✅ Faster than FFT/IFFT

**FAIL if:**
1. ❌ Frequency response error > 10% in volcanic range
2. ❌ Visible artifacts or distortions in time domain
3. ❌ Amplitude errors > 20%

### Secondary Analysis: How Much Better is MCMC?

**Quantify improvement:**
- MCMC error vs Bilinear error (percentage improvement)
- Computational cost (is 5-10 minutes worth it?)
- Decision: Use bilinear (fast) or MCMC (optimized)?

### Tertiary: Prove FFT/IFFT is Reconstruction

**Show artifacts:**
- Spectral leakage effects
- Edge effects / windowing artifacts
- Gibbs phenomenon
- Time-domain reconstruction errors

**Goal**: Demonstrate FFT/IFFT is NOT the "gold standard" for streaming applications

---

## Implementation Plan

### Phase 1: Extract Anderson's MCMC Algorithm ✅ (Partially Done)
- [x] Download TDD R package
- [x] Extract DPZLIST data
- [ ] **Extract MCMC implementation** from R source code
- [ ] Translate to Python
- [ ] Validate on test case

**R Files to Examine:**
```bash
TDD/R/MakeDPZ.R          # Main MCMC function
TDD/R/SEISVelocify.R     # Response removal
TDD/man/MakeDPZ.Rd       # Documentation
```

### Phase 2: Implement Test Framework
**Create:** `tests/test_iir_comparison.py`

```python
def fetch_test_data(network, station, location, channel, 
                    starttime, duration_hours=1):
    """Fetch seismic data + metadata from IRIS"""
    pass

def apply_fft_method(stream):
    """Apply FFT/IFFT response removal (ObsPy)"""
    pass

def apply_bilinear_method(raw_data, poles, zeros, gain, fs):
    """Apply bilinear IIR transform"""
    pass

def apply_mcmc_method(raw_data, poles, zeros, gain, fs):
    """Apply Anderson's MCMC IIR optimization"""
    pass

def compare_frequency_responses(sos_bilinear, sos_mcmc, 
                                poles, zeros, gain, fs):
    """Compute and plot frequency response comparison"""
    pass

def compare_time_domain(fft_data, bilinear_data, mcmc_data):
    """Compute and plot waveform comparison"""
    pass

def test_streaming_viability(sos, raw_data, fs, chunk_seconds=10):
    """Verify IIR can stream chunk-by-chunk"""
    pass

def main():
    # Run full comparison test
    pass
```

### Phase 3: Run Tests & Generate Report
**Execute:**
```bash
cd /Users/robertalexander/GitHub/volcano-audio
python tests/test_iir_comparison.py
```

**Output:**
- `results/iir_comparison_summary.csv` - Numerical metrics
- `plots/iir_frequency_response.png` - Frequency response comparison
- `plots/iir_waveform_comparison.png` - Time-domain comparison
- `plots/iir_volcanic_range_analysis.png` - 0.5-10 Hz focused analysis
- `docs/reports/iir_comparison_report.md` - Full analysis with verdict

### Phase 4: Document Findings
**Update:**
- Captain's log with results
- README with recommended approach
- Technical documentation for chosen method

---

## Expected Outcomes

### Hypothesis 1: Bilinear is "Good Enough"
**If true:**
- Use `scipy.zpk2sos()` for all streaming
- Fast, simple, validated
- No need for MCMC complexity

**Benefits:**
- Instant conversion (milliseconds)
- Can compute on-the-fly for any station
- Simple codebase

### Hypothesis 2: MCMC is Necessary
**If true:**
- Pre-compute MCMC for common stations
- Cache optimized coefficients
- Worth the 5-10 minute investment

**Implementation:**
- Build database of pre-computed MCMC filters
- Fallback to bilinear for unknown stations
- More complex but higher quality

### Hypothesis 3: FFT/IFFT is Problematic
**Expected:**
- Reconstruction artifacts visible
- Not viable for streaming
- Confirms IIR is the right approach

**Impact:**
- Validates our IIR-focused strategy
- Justifies departure from ObsPy standard methods

---

## Technical Notes

### Frequency Warping in Bilinear Transform
**The Math:**
```
Bilinear mapping: s = (2/T) * (z-1)/(z+1)

Where:
  s = analog frequency (Laplace domain)
  z = digital frequency (z-domain)
  T = sampling period (1/fs)

This warps frequencies according to:
  Ω_digital = 2*fs*tan(Ω_analog/(2*fs))

At low frequencies (Ω << fs):
  tan(x) ≈ x, so minimal warping

At high frequencies (Ω → Nyquist):
  Significant compression
```

**For volcanic monitoring:**
- Target: 0.5-10 Hz
- Nyquist: 50 Hz (for 100 Hz sampling)
- Ratio: 10/50 = 0.2 (20% of Nyquist)
- **Warping is minimal in our range!**

### SOS (Second-Order Sections) Format
**Why SOS:**
- Numerically stable for high-order filters
- Each section is a 2nd-order filter (biquad)
- Cascaded to achieve full response

**Format:**
```python
sos = [
    [b0, b1, b2, a0, a1, a2],  # Section 1
    [b0, b1, b2, a0, a1, a2],  # Section 2
    ...
]
```

**Each section implements:**
```
y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
```

### MCMC Algorithm Overview
**Markov Chain Monte Carlo:**
1. Start with initial state (bilinear poles/zeros)
2. Propose perturbation (random small change)
3. Evaluate cost function (frequency response error)
4. Accept if better; probabilistically accept if worse
5. Repeat thousands of times
6. Converges to optimized solution

**Cost function for seismology:**
```python
def cost_function(poles, zeros, gain, fs, target_freqs):
    # Compute digital frequency response
    _, H_digital = signal.freqs_zpk(poles, zeros, gain, 
                                     worN=target_freqs)
    
    # Compute analog frequency response (ground truth)
    _, H_analog = get_analog_response(target_freqs)
    
    # Error in target frequency range
    error = np.mean(np.abs(H_digital - H_analog)**2)
    return error
```

Anderson's implementation likely includes:
- Constrained perturbations (maintain stability)
- Temperature schedule (simulated annealing)
- Target frequency range weighting

---

## Questions to Resolve

### Q1: Which method does ObsPy actually use internally?
**Check**: `obspy.core.trace.Trace.remove_response()` source code
- Is it pure FFT/IFFT?
- Does it have an IIR option?
- Are there hidden parameters?

### Q2: Can we use pre-computed MCMC from Anderson?
**Problem**: His coefficients are for generic instruments, not specific station responses
**Solution**: Need to run MCMC on actual IRIS poles/zeros
**Requirement**: Must implement MCMC algorithm ourselves

### Q3: How sensitive is MCMC to parameters?
**Variables:**
- Number of iterations
- Target frequency range
- Perturbation magnitude
- Temperature schedule

**Test**: Run with different parameters, see if results converge

### Q4: Does bilinear "good enough" depend on seismometer type?
**Hypothesis**: Some instruments (e.g., short-period) may have worse warping
**Test**: Run on multiple instrument types (STS-2, CMG-40T, Trillium-120)

---

## References

### Anderson's Work
- **TDD R Package**: https://cran.r-project.org/src/contrib/Archive/TDD/TDD_0.4.tar.gz
- **Paper**: Anderson, J. F., & Lees, J. M. (2014). "Instrument Corrections by Time-Domain Deconvolution." Seismological Research Letters, 85(1), 197-201. DOI: 10.1785/0220130062

### Bilinear Transform
- **scipy.signal.zpk2sos**: https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.zpk2sos.html
- **Theory**: Oppenheim & Schafer, "Discrete-Time Signal Processing"

### Seismology Standards
- **ObsPy**: https://docs.obspy.org/
- **SEED format**: https://www.fdsn.org/seed_manual/SEEDManual_V2.4.pdf
- **Instrument responses**: https://ds.iris.edu/ds/nodes/dmc/data/formats/resp/

---

## Conclusion

This test plan will definitively answer whether scipy's bilinear transform is sufficient for streaming volcanic audio, or whether we need to invest in implementing Anderson's MCMC optimization.

**The key insight**: We're not comparing to FFT/IFFT as "gold standard" - we're comparing IIR methods (bilinear vs MCMC) and showing FFT/IFFT is fundamentally flawed for streaming due to analysis-resynthesis.

**Expected outcome**: Bilinear is "good enough" for volcanic monitoring (0.5-10 Hz range), making our streaming architecture viable with simple, fast scipy methods.

**If bilinear fails**: We have a clear path forward (implement MCMC), and we know it's worth the investment.

**Timeline**: 
- Phase 1 (Extract MCMC): 2-4 hours
- Phase 2 (Implement framework): 2-3 hours
- Phase 3 (Run tests): 1 hour (plus 5-10 min per MCMC run)
- Phase 4 (Document): 1 hour

**Total**: ~8-12 hours of work for definitive answer.


