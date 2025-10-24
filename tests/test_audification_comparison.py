#!/usr/bin/env python3
"""
Phase 0: Audification Listening Test
Generate 4 audio files comparing different instrument response correction methods:
1. Raw data (normalized only)
2. ObsPy FFT/IFFT corrected
3. IIR Bilinear corrected
4. Anderson MCMC corrected (placeholder - needs MCMC implementation)

Output: WAV files at 44.1 kHz (441x speedup audification)
"""

from obspy import read
from obspy.clients.fdsn import Client
from scipy import signal
from scipy.io import wavfile
import numpy as np
from datetime import datetime, timedelta
import os
import requests

def generate_audification_test():
    """
    Generate 4 audio files for comparison
    """
    
    print("=" * 80)
    print("Phase 0: Audification Listening Test")
    print("=" * 80)
    
    # Fetch data from IRIS (simple HTTP request like backend does)
    print("\n1. Fetching data from IRIS...")
    
    # Use current time - 2 days for guaranteed complete data
    end_time = datetime.utcnow() - timedelta(days=2)
    start_time = end_time - timedelta(hours=1)  # 1 hour for quick test
    
    start_str = start_time.strftime("%Y-%m-%dT%H:%M:%S")
    end_str = end_time.strftime("%Y-%m-%dT%H:%M:%S")
    
    print(f"   Time range: {start_str} to {end_str}")
    print(f"   Station: HV.OBL.HHZ (Kilauea)")
    
    # Simple HTTP request to IRIS (exactly like backend does)
    url = "https://service.iris.edu/fdsnws/dataselect/1/query"
    params = {
        "net": "HV",
        "sta": "OBL",
        "loc": "--",
        "cha": "HHZ",
        "start": start_str,
        "end": end_str,
        "format": "miniseed"
    }
    
    print(f"   Fetching from IRIS...")
    response = requests.get(url, params=params)
    
    if response.status_code != 200:
        raise Exception(f"IRIS returned {response.status_code}")
    
    # Save and read miniSEED
    temp_file = 'tests/temp_test_data.mseed'
    with open(temp_file, 'wb') as f:
        f.write(response.content)
    
    st = read(temp_file)
    
    raw_data = st[0].data.copy()
    sample_rate = st[0].stats.sampling_rate
    
    print(f"   ✓ Fetched {len(raw_data):,} samples at {sample_rate} Hz")
    print(f"   Duration: {len(raw_data)/sample_rate:.1f} seconds")
    
    # Fetch instrument response metadata
    print("   Fetching instrument response metadata...")
    client = Client("IRIS")
    inventory = client.get_stations(network="HV", station="OBL",
                                     location="", channel="HHZ",
                                     starttime=start_time, level="response")
    print("   ✓ Got response metadata")
    
    # ==========================================================================
    # 1. RAW DATA (normalized only)
    # ==========================================================================
    print("\n2. Processing RAW data (normalized only)...")
    raw_normalized = normalize_for_audio(raw_data.copy())
    save_audio('1_raw_normalized.wav', raw_normalized, sample_rate)
    
    # ==========================================================================
    # 2. OBSPY FFT/IFFT CORRECTED
    # ==========================================================================
    print("\n3. Processing with ObsPy FFT/IFFT method...")
    st_fft = st.copy()
    
    # Critical: Use pre_filt to prevent amplifying noise during deconvolution
    # Format: (f1, f2, f3, f4) - cosine taper from f1->f2 and f3->f4
    # For 100 Hz sampling (50 Hz Nyquist) and volcanic monitoring (0.5-10 Hz):
    pre_filt = (0.005, 0.01, 45.0, 49.0)  # Hz
    
    print(f"   Using pre-filter: {pre_filt} Hz")
    st_fft.remove_response(inventory=inventory, output='VEL', pre_filt=pre_filt)
    
    # Apply anti-aliasing low-pass filter (same as IIR and HP methods)
    obspy_corrected = st_fft[0].data.copy()
    lp_freq = 47.6  # Hz → 21 kHz in audio domain
    print(f"   Anti-aliasing low-pass filter (<{lp_freq} Hz)...")
    print(f"   (In audified audio: <{lp_freq * 441:.0f} Hz)")
    sos_lp_obspy = signal.butter(4, lp_freq, btype='low', fs=sample_rate, output='sos')
    obspy_corrected = signal.sosfilt(sos_lp_obspy, obspy_corrected)
    
    obspy_corrected = normalize_for_audio(obspy_corrected)
    save_audio('2_obspy_fft_corrected.wav', obspy_corrected, sample_rate)
    
    # ==========================================================================
    # 3. IIR BILINEAR CORRECTED
    # ==========================================================================
    print("\n4. Processing with IIR Bilinear method...")
    
    # 1. Get analog poles/zeros from StationXML
    print("   Extracting poles/zeros from response metadata...")
    response = inventory[0][0][0].response
    
    print(f"\n   === Response has {len(response.response_stages)} stages ===")
    for i, s in enumerate(response.response_stages):
        print(f"   Stage {i+1}: {type(s).__name__} - Gain: {s.stage_gain if hasattr(s, 'stage_gain') else 'N/A'}")
    
    print(f"\n   Overall instrument sensitivity: {response.instrument_sensitivity.value:.6e}")
    print(f"   Input units: {response.instrument_sensitivity.input_units}")
    print(f"   Output units: {response.instrument_sensitivity.output_units}")
    
    stage = response.response_stages[0]
    poles = np.array([complex(p.real, p.imag) for p in stage.poles])
    zeros = np.array([complex(z.real, z.imag) for z in stage.zeros])
    
    # Use A0 (normalization factor) for poles/zeros representation
    gain = stage.normalization_factor
    
    print(f"\n   === RAW METADATA VALUES ===")
    print(f"   Stage: {stage.stage_sequence_number}")
    print(f"   Gain (stage_gain): {stage.stage_gain:.6e}")
    print(f"   Normalization factor (A0) [USING THIS]: {gain:.6e}")
    
    print(f"\n   POLES ({len(poles)}):")
    for i, p in enumerate(poles):
        print(f"     {i+1}. {p.real:+.6e} {p.imag:+.6e}j")
    
    print(f"\n   ZEROS ({len(zeros)}):")
    for i, z in enumerate(zeros):
        print(f"     {i+1}. {z.real:+.6e} {z.imag:+.6e}j")
    
    print(f"\n   Forward response: {len(poles)} poles, {len(zeros)} zeros")
    
    # 1.5. CRITICAL: Check the FORWARD response of the instrument
    print(f"\n   === FORWARD Instrument Response (what seismometer does) ===")
    w_forward, h_forward = signal.freqs_zpk(zeros, poles, gain, worN=2048)
    freq_forward = w_forward / (2 * np.pi)
    
    for f in [0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 10.0, 20.0]:
        idx = np.argmin(np.abs(freq_forward - f))
        gain_db = 20 * np.log10(np.abs(h_forward[idx]))
        print(f"   {f:6.2f} Hz: {gain_db:8.1f} dB")
    
    # 2. INVERT for deconvolution (swap poles and zeros)
    # A0 is a normalization constant for pole-zero math, NOT a physical gain!
    # When we swap poles↔zeros, we've already inverted the transfer function.
    # Keep gain near unity - don't invert A0!
    poles_inv = zeros.copy()
    zeros_inv = poles.copy()
    gain_inv = 1.0  # Keep gain=1, don't invert A0!
    
    print(f"   A0 is normalization constant (not inverted): {gain:.6e}")
    print(f"   Using gain_inv = 1.0 for deconvolution (already inverted by swapping poles/zeros)")
    
    # 3. PAD to make proper transfer function (critical step!)
    # Need equal number of poles and zeros for bilinear transform
    # If we have more zeros than poles after inversion, add poles at HIGH frequencies
    # (far beyond Nyquist, so they don't affect our band of interest)
    while len(poles_inv) < len(zeros_inv):
        # Add poles at very high frequency (1000 Hz >> 50 Hz Nyquist)
        poles_inv = np.append(poles_inv, -1000.0*2*np.pi + 0.0j)
    # Or add zeros at origin if we have more poles than zeros
    while len(zeros_inv) < len(poles_inv):
        zeros_inv = np.append(zeros_inv, 0.0+0.0j)
    
    print(f"   Inverted response: {len(poles_inv)} poles, {len(zeros_inv)} zeros")
    
    # 4. Apply bilinear transform with gain=1
    print("   Applying bilinear transform...")
    z_digital, p_digital, k_digital = signal.bilinear_zpk(
        zeros_inv, poles_inv, gain_inv, fs=sample_rate
    )
    
    # 5. Convert to SOS
    sos_bilinear = signal.zpk2sos(z_digital, p_digital, k_digital)
    
    print(f"   Digital filter gain (before normalization): k_digital = {k_digital:.6e}")
    
    # 6. NORMALIZE: Scale coefficients so min gain = 0 dB (everything else is boost)
    # Compute frequency response to find min gain
    w_norm, h_norm = signal.sosfreqz(sos_bilinear, worN=2048, fs=sample_rate)
    freq_norm = w_norm * sample_rate / (2 * np.pi)
    
    # Find min gain in passband (0.05 - 20 Hz)
    passband_mask = (freq_norm >= 0.05) & (freq_norm <= 20.0)
    min_gain = np.min(np.abs(h_norm[passband_mask]))
    min_gain_db = 20 * np.log10(min_gain)
    
    print(f"   Min gain in passband (0.05-20 Hz): {min_gain_db:.1f} dB")
    
    # Scale first section's b coefficients to normalize min to 0 dB
    scale_factor = 1.0 / min_gain
    sos_bilinear[0, :3] *= scale_factor
    
    print(f"   Scaling by {scale_factor:.6e} to normalize min to 0 dB")
    
    print(f"\n   === SOS Coefficients (after normalization) ===")
    for i, section in enumerate(sos_bilinear):
        print(f"   Section {i+1}: b={section[:3]}, a={section[3:]}")
    
    # 7. Check frequency response across full range (after normalization)
    print(f"\n   === Frequency Response (After Normalization) ===")
    w, h = signal.sosfreqz(sos_bilinear, worN=2048, fs=sample_rate)
    for freq in [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 10.0, 20.0]:
        idx = np.argmin(np.abs(w - freq))
        gain_db = 20 * np.log10(np.abs(h[idx]))
        print(f"   {freq:6.3f} Hz: {gain_db:7.1f} dB")
    
    print(f"\n   === Volcanic Band (0.5-10 Hz) ===")
    for freq in [0.5, 1.0, 2.0, 5.0, 8.0, 10.0]:
        idx = np.argmin(np.abs(w - freq))
        gain_db = 20 * np.log10(np.abs(h[idx]))
        print(f"   {freq:5.1f} Hz: {gain_db:6.1f} dB")
    
    # 8. Prepare data: DETREND AND TAPER FIRST (critical!)
    import time
    t_start = time.time()
    
    print("   Preparing data (detrend + taper)...")
    data_prepared = raw_data.copy()
    data_prepared = data_prepared - np.mean(data_prepared)
    taper = signal.windows.tukey(len(data_prepared), alpha=0.05)
    data_prepared = data_prepared * taper
    t_prep = time.time() - t_start
    
    # 9. HIGH-PASS FILTER BEFORE DECONVOLUTION
    # This removes DC and very low frequencies where gain explodes
    # OPTIONS:
    #   0.01 Hz → 4.4 Hz in audio (deep sub-bass, preserves maximum low frequency)
    #   0.045 Hz → 20 Hz in audio (removes sub-20Hz rumble, keeps bass)
    #   0.1 Hz → 44 Hz in audio (removes more low freq, may lose "volcano ride" feel)
    hp_freq = 0.045  # Hz → 20 Hz in audio domain
    print(f"   High-pass filtering (>{hp_freq} Hz) before deconvolution...")
    print(f"   (In audified audio: >{hp_freq * 441:.1f} Hz)")
    sos_hp = signal.butter(2, hp_freq, btype='high', fs=sample_rate, output='sos')
    t_hp_start = time.time()
    data_prepared = signal.sosfilt(sos_hp, data_prepared)
    t_hp = time.time() - t_hp_start
    
    # 10. NOW apply the deconvolution IIR filter (gain already baked in)
    print("   Applying deconvolution IIR filter...")
    t_iir_start = time.time()
    bilinear_corrected = signal.sosfilt(sos_bilinear, data_prepared)
    t_iir = time.time() - t_iir_start
    
    # 11. Anti-aliasing low-pass filter (removes frequencies above 21 kHz in audio)
    # 21 kHz audio / 441 speedup = 47.6 Hz seismic
    lp_freq = 47.6  # Hz → 21 kHz in audio domain
    print(f"   Anti-aliasing low-pass filter (<{lp_freq} Hz)...")
    print(f"   (In audified audio: <{lp_freq * 441:.0f} Hz)")
    sos_lp = signal.butter(4, lp_freq, btype='low', fs=sample_rate, output='sos')
    t_lp_start = time.time()
    bilinear_corrected = signal.sosfilt(sos_lp, bilinear_corrected)
    t_lp = time.time() - t_lp_start
    
    # Print timing
    duration_sec = len(raw_data) / sample_rate
    print(f"\n   === TIMING (for {duration_sec:.0f}s of seismic data) ===")
    print(f"   Detrend + Taper: {t_prep*1000:.1f} ms")
    print(f"   High-pass filter: {t_hp*1000:.1f} ms")
    print(f"   IIR deconvolution: {t_iir*1000:.1f} ms")
    print(f"   Low-pass filter: {t_lp*1000:.1f} ms")
    print(f"   TOTAL: {(t_prep + t_hp + t_iir + t_lp)*1000:.1f} ms")
    print(f"   Per second of seismic: {(t_prep + t_hp + t_iir + t_lp)/duration_sec*1000:.3f} ms")
    
    bilinear_normalized = normalize_for_audio(bilinear_corrected)
    save_audio('3_iir_bilinear_corrected.wav', bilinear_normalized, sample_rate)
    
    # ==========================================================================
    # 4. HIGH-PASS FILTER ONLY (no instrument response correction)
    # ==========================================================================
    print("\n5. Processing with HP filter only (no correction)...")
    
    t_hp_only_start = time.time()
    
    # Prepare data same as IIR method
    hp_only_data = raw_data.copy()
    hp_only_data = hp_only_data - np.mean(hp_only_data)
    taper_hp = signal.windows.tukey(len(hp_only_data), alpha=0.05)
    hp_only_data = hp_only_data * taper_hp
    
    # Apply ONLY the high-pass filter (same as before IIR correction)
    print(f"   High-pass filtering (>{hp_freq} Hz) only...")
    print(f"   (In audified audio: >{hp_freq * 441:.1f} Hz)")
    sos_hp_only = signal.butter(2, hp_freq, btype='high', fs=sample_rate, output='sos')
    hp_only_data = signal.sosfilt(sos_hp_only, hp_only_data)
    
    # Apply anti-aliasing low-pass filter (same as IIR method)
    print(f"   Anti-aliasing low-pass filter (<{lp_freq} Hz)...")
    print(f"   (In audified audio: <{lp_freq * 441:.0f} Hz)")
    sos_lp_only = signal.butter(4, lp_freq, btype='low', fs=sample_rate, output='sos')
    hp_only_data = signal.sosfilt(sos_lp_only, hp_only_data)
    
    t_hp_only_total = time.time() - t_hp_only_start
    
    print(f"\n   === TIMING (for {duration_sec:.0f}s of seismic data) ===")
    print(f"   TOTAL: {t_hp_only_total*1000:.1f} ms")
    print(f"   Per second of seismic: {t_hp_only_total/duration_sec*1000:.3f} ms")
    
    hp_only_normalized = normalize_for_audio(hp_only_data)
    save_audio('4_hp_filter_only.wav', hp_only_normalized, sample_rate)
    
    # ==========================================================================
    # Summary
    # ==========================================================================
    print("\n" + "=" * 80)
    print("✅ COMPLETE: Generated 4 audio files")
    print("=" * 80)
    print("\nOutput files in tests/audification_comparison/:")
    print("  1. 1_raw_normalized.wav        - Raw seismic (instrument-filtered)")
    print("  2. 2_obspy_fft_corrected.wav   - ObsPy's FFT/IFFT method")
    print("  3. 3_iir_bilinear_corrected.wav - Our IIR bilinear approach")
    print("  4. 4_hp_filter_only.wav         - High-pass filter only (no correction)")
    print("\n🎧 LISTENING TEST:")
    print("  1. Does raw data sound muddy/wrong?")
    print("  2. Do corrected versions sound clearer?")
    print("  3. Can you hear differences between FFT and Bilinear?")
    print("  4. What does HP-only sound like vs. full correction?")
    print("  5. Any obvious artifacts in FFT method?")
    print("\n" + "=" * 80)

def normalize_for_audio(data):
    """
    Normalize to [-1, 1] range for audio
    
    Steps:
    1. Detrend (remove DC offset)
    2. Taper edges (avoid clicks)
    3. Normalize to unit amplitude
    """
    # Convert to float64 for processing
    data = data.astype(np.float64)
    
    # Detrend
    data = data - np.mean(data)
    
    # Taper (0.01% edges to avoid clicks)
    taper_len = int(len(data) * 0.0001)
    if taper_len > 0:
        taper = signal.windows.tukey(len(data), alpha=taper_len*2/len(data))
        data = data * taper
    
    # Normalize
    max_abs = np.max(np.abs(data))
    if max_abs > 0:
        data = data / max_abs
    
    return data.astype(np.float32)

def save_audio(filename, data, sample_rate):
    """
    Save as WAV file (audified with 441x speedup)
    
    Args:
        filename: Output filename
        data: Normalized float32 array [-1, 1]
        sample_rate: Original sample rate (e.g., 100 Hz)
    """
    # Audify: 441x speedup (100 Hz → 44,100 Hz)
    audified_rate = int(sample_rate * 441)
    
    # Convert to 16-bit PCM
    data_int16 = (data * 32767).astype(np.int16)
    
    # Save
    output_dir = 'tests/audification_comparison'
    os.makedirs(output_dir, exist_ok=True)
    filepath = os.path.join(output_dir, filename)
    
    wavfile.write(filepath, audified_rate, data_int16)
    
    duration_sec = len(data) / sample_rate
    audified_duration_sec = duration_sec / 441
    
    print(f"   ✓ Saved: {filename}")
    print(f"     Original duration: {duration_sec:.1f}s → Audified: {audified_duration_sec:.2f}s")
    print(f"     Sample rate: {sample_rate} Hz → {audified_rate} Hz")

if __name__ == '__main__':
    try:
        generate_audification_test()
    except Exception as e:
        print(f"\n❌ ERROR: {e}")
        import traceback
        traceback.print_exc()

