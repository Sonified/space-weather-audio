#!/usr/bin/env python3
"""
CDF Gap Reconstruction — Sample-Perfect Accuracy Test
======================================================
Can we reconstruct time-aligned audio from CDF data with ZERO error?

CDF files contain TT2000 epoch timestamps for every sample.
If we use those (not inventory), we know EXACTLY when each sample occurred.

This test:
1. Loads a CDF with known gaps (PSP Jan 1 2020, 00:00–12:00)
2. Computes exact gap durations from epoch timestamps
3. Builds a gap-filled sample array
4. Verifies the total duration matches wall-clock time EXACTLY
"""

import cdflib
import numpy as np
import wave
import os
import subprocess
import json

WAV_SAMPLE_RATE = 22000

def load_cdf(cdf_path, epoch_var='epoch_mag_RTN', data_var='psp_fld_l2_mag_RTN', component=0):
    """Load epoch + one component from CDF."""
    cdf = cdflib.CDF(cdf_path)
    epoch = cdf.varget(epoch_var)
    data = cdf.varget(data_var)
    if data.ndim == 2:
        data = data[:, component].astype(np.float64)
    else:
        data = data.astype(np.float64)
    return epoch, data

def find_blocks(epoch, threshold_factor=2.0):
    """Split epoch into contiguous blocks. Returns list of (start_idx, end_idx) tuples."""
    if len(epoch) < 2:
        return [(0, len(epoch) - 1)]

    diffs = np.diff(epoch)
    median_dt = np.median(diffs)
    threshold = median_dt * threshold_factor

    blocks = []
    start = 0
    for i in range(len(diffs)):
        if diffs[i] > threshold:
            blocks.append((start, i))
            start = i + 1
    blocks.append((start, len(epoch) - 1))
    return blocks

def format_tt2000(tt2000_ns):
    dt = cdflib.cdfepoch.to_datetime(np.array([tt2000_ns]))[0]
    return str(dt.astype('datetime64[ms]'))

def blocks_to_gap_filled_audio(epoch, data, request_start_ns, request_end_ns):
    """
    Reconstruct time-aligned audio from CDF data using exact epoch timestamps.

    Each data block's cadence is computed from ITS OWN epoch spacing (handles
    variable rates like PSP's 9Hz/73Hz/146Hz/293Hz).

    Gap durations are computed from the EXACT epoch timestamps of the last
    sample before the gap and the first sample after the gap.

    Returns: (audio_samples, report)
    """
    blocks = find_blocks(epoch)

    report = {
        'blocks': [],
        'total_data_samples': len(data),
        'request_duration_sec': (request_end_ns - request_start_ns) / 1e9,
    }

    # For each block, compute its native cadence
    block_infos = []
    for (s, e) in blocks:
        n = e - s + 1
        block_epoch = epoch[s:e+1]
        block_data = data[s:e+1]

        if n > 1:
            diffs = np.diff(block_epoch)
            # Use MODE cadence (most common), not median — handles startup bursts
            # Round to nearest 0.001ms to bin similar cadences
            rounded = np.round(diffs / 1e3) * 1e3  # round to nearest microsecond
            unique, counts = np.unique(rounded, return_counts=True)
            mode_dt = unique[np.argmax(counts)]
            cadence_hz = 1e9 / mode_dt
        else:
            mode_dt = 0
            cadence_hz = 0

        block_infos.append({
            'start_idx': s,
            'end_idx': e,
            'n_samples': n,
            'epoch_start': block_epoch[0],
            'epoch_end': block_epoch[-1],
            'cadence_ns': mode_dt,
            'cadence_hz': cadence_hz,
            'data': block_data,
        })

        report['blocks'].append({
            'samples': n,
            'start': format_tt2000(block_epoch[0]),
            'end': format_tt2000(block_epoch[-1]),
            'cadence_ms': mode_dt / 1e6,
            'cadence_hz': cadence_hz,
        })

    # Now build the output: data blocks with silence gaps between them
    # Use a SINGLE output cadence — the dominant cadence across all blocks
    # (CDAWeb uses a fixed 22kHz output rate anyway)

    # But wait — we need to think about this differently.
    # The CDF has N samples at cadence C spanning time T.
    # CDAWeb writes those N samples at 22kHz, so playback duration = N/22000 seconds.
    # The REAL duration is T seconds.
    # Compression ratio = (N/22000) / T = N / (22000 * T)
    #
    # For gap filling, we need silence duration in 22kHz samples.
    # If we just use the CDAWeb approach (write data samples at 22kHz),
    # then gap silence in 22kHz samples = gap_duration_sec * 22000... NO.
    # That would make silence proportional to wall-clock time but data
    # proportional to sample count. The timeline wouldn't match.
    #
    # The REAL question: what IS the correct output?
    #
    # Option A: Fixed output rate (22kHz). Each data sample → one 22kHz sample.
    #           Gap silence = gap_sec * 22000 samples. Timeline is wrong because
    #           data plays at 22000/cadence_hz speedup.
    #
    # Option B: Time-accurate output. Each data sample → one output sample at
    #           the data's native rate. Gap silence = gap_sec * data_cadence_hz.
    #           Output rate = data cadence. But 9 Hz or 146 Hz isn't audible...
    #           that's why CDAWeb resamples to 22kHz.
    #
    # Option C: CDAWeb approach + proportional gaps. Data at 22kHz (N samples).
    #           Gap silence = gap_sec * (N / data_duration_sec) = gap_sec * cadence_hz
    #           ...scaled to 22kHz... gap_22k = gap_sec * 22000.
    #           Hmm, this is Option A again.
    #
    # Actually — CDAWeb writes N data samples as N WAV samples at 22kHz.
    # That means 1 second of 146 Hz data (146 samples) plays back in
    # 146/22000 = 0.00664 seconds. It's a ~3320x speedup.
    # A 1-hour data segment with 146*3600 = 525,600 samples plays in
    # 525600/22000 = 23.9 seconds of audio.
    #
    # For the gap-filled version to have correct proportions, the gap
    # silence needs the SAME compression ratio: gap_audio = gap_sec / 3320 * 22000
    # = gap_sec * (22000/3320) = gap_sec * cadence_hz... wait:
    # compression = 22000/cadence. gap_audio = gap_sec * cadence_hz.
    #
    # OR: just count samples. In the original data, 1 second = cadence_hz samples.
    # In a gap of G seconds, the "missing" samples = G * cadence_hz.
    # Those missing samples become silence samples in the WAV (1:1 ratio).
    # Total WAV duration = (data_samples + gap_silence_samples) / 22000.
    # This preserves the time RATIO between data and gaps.

    chunks = []
    total_gap_samples = 0

    # Leading gap (before first data)
    if block_infos[0]['epoch_start'] > request_start_ns:
        leading_gap_ns = block_infos[0]['epoch_start'] - request_start_ns
        leading_gap_data_samples = int(round(leading_gap_ns / block_infos[0]['cadence_ns']))
        chunks.append(np.zeros(leading_gap_data_samples, dtype=np.float64))
        total_gap_samples += leading_gap_data_samples
        report['leading_gap_sec'] = leading_gap_ns / 1e9
        report['leading_gap_samples'] = leading_gap_data_samples

    for i, bi in enumerate(block_infos):
        # Data block
        chunks.append(bi['data'])

        # Internal gap to next block
        if i < len(block_infos) - 1:
            next_bi = block_infos[i + 1]
            gap_ns = next_bi['epoch_start'] - bi['epoch_end']
            # Use average cadence of the two adjacent blocks for gap fill
            # (handles rate transitions)
            avg_cadence = (bi['cadence_ns'] + next_bi['cadence_ns']) / 2
            gap_samples = int(round(gap_ns / avg_cadence))
            chunks.append(np.zeros(gap_samples, dtype=np.float64))
            total_gap_samples += gap_samples
            report['blocks'][-1 if i == len(block_infos)-1 else i]['gap_after_sec'] = gap_ns / 1e9
            report['blocks'][i]['gap_after_samples'] = gap_samples

    # Trailing gap
    if block_infos[-1]['epoch_end'] < request_end_ns:
        trailing_gap_ns = request_end_ns - block_infos[-1]['epoch_end']
        trailing_gap_data_samples = int(round(trailing_gap_ns / block_infos[-1]['cadence_ns']))
        chunks.append(np.zeros(trailing_gap_data_samples, dtype=np.float64))
        total_gap_samples += trailing_gap_data_samples
        report['trailing_gap_sec'] = trailing_gap_ns / 1e9
        report['trailing_gap_samples'] = trailing_gap_data_samples

    filled = np.concatenate(chunks)
    report['total_output_samples'] = len(filled)
    report['total_gap_samples'] = total_gap_samples

    return filled, report


def data_to_wav(data, filepath, sample_rate=WAV_SAMPLE_RATE):
    """Scale to 16-bit PCM, write WAV. Gap regions (0.0) stay as silence."""
    clean = data.copy()
    nan_mask = np.isnan(clean)
    clean[nan_mask] = 0.0

    non_zero = clean[~nan_mask & (clean != 0.0)]
    if len(non_zero) > 0:
        minval = np.min(non_zero)
        maxval = np.max(non_zero)
    else:
        minval, maxval = 0, 1

    if maxval == minval:
        maxval = minval + 1.0

    # Scale to 16-bit
    scaled = -32768 + (65535.0 * (clean - minval) / (maxval - minval))
    scaled = np.clip(scaled, -32768, 32767).astype(np.int16)

    # Force silence for gap regions (zeros in input) and NaN
    silence_mask = nan_mask | (data == 0.0)
    scaled[silence_mask] = 0

    with wave.open(filepath, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(scaled.tobytes())

    return len(scaled)


def main():
    wavdir = os.path.dirname(os.path.abspath(__file__)) + '/gap_test_wavs'

    print("=" * 80)
    print("CDF GAP RECONSTRUCTION — SAMPLE-PERFECT ACCURACY TEST")
    print("=" * 80)

    # =========================================================================
    # Test 1: PSP Jan 1 2020, 00:00–03:00 (data block, then trailing gap to 03:00)
    # =========================================================================
    print("\n--- Test 1: Single block + trailing gap (00:00–03:00) ---")

    cdf1 = wavdir + '/psp_mag_rtn__20200101_0000-0300.cdf'
    epoch1, data1 = load_cdf(cdf1)

    print(f"  CDF records: {len(epoch1)}")
    print(f"  First: {format_tt2000(epoch1[0])}")
    print(f"  Last:  {format_tt2000(epoch1[-1])}")

    blocks1 = find_blocks(epoch1)
    print(f"  Blocks: {len(blocks1)}")
    for i, (s, e) in enumerate(blocks1):
        n = e - s + 1
        if n > 1:
            diffs = np.diff(epoch1[s:e+1])
            unique_cadences = np.unique(np.round(diffs / 1e3) * 1e3)
            print(f"    Block {i}: {n} samples, cadences: {[f'{c/1e6:.3f}ms' for c in unique_cadences]}")

    # Use CDF epoch for request boundaries (convert to TT2000)
    # We know from CDF that data starts at 00:00:00.009 on Jan 1 2020
    # Request: 00:00:00 to 03:00:00
    # Need TT2000 for those boundaries
    req_start_1 = epoch1[0] - int(0.009 * 1e9)  # back to 00:00:00.000
    req_end_1 = req_start_1 + int(3 * 3600 * 1e9)  # +3 hours

    filled1, report1 = blocks_to_gap_filled_audio(epoch1, data1, req_start_1, req_end_1)

    print(f"\n  Gap-fill results:")
    print(f"    Data samples:  {report1['total_data_samples']}")
    print(f"    Gap samples:   {report1['total_gap_samples']}")
    print(f"    Total output:  {report1['total_output_samples']}")

    # Expected: 3 hours at the block's cadence
    block_cadence = report1['blocks'][0]['cadence_hz']
    expected_3h = int(round(3 * 3600 * block_cadence))
    error_pct = abs(report1['total_output_samples'] - expected_3h) / expected_3h * 100
    print(f"    Expected (3h @ {block_cadence:.2f}Hz): {expected_3h}")
    print(f"    Error: {report1['total_output_samples'] - expected_3h} samples ({error_pct:.6f}%)")

    # Cross-check: data duration from epochs
    data_duration = (epoch1[-1] - epoch1[0]) / 1e9
    print(f"\n    Data actual duration: {data_duration:.3f}s ({data_duration/3600:.4f}h)")
    samples_per_sec = len(epoch1) / data_duration
    print(f"    Actual rate: {samples_per_sec:.4f} Hz")

    # =========================================================================
    # Test 2: PSP Jan 1 2020, 09:00–12:00 (leading gap + data + trailing gap)
    # =========================================================================
    print("\n\n--- Test 2: Leading gap + data + trailing gap (09:00–12:00) ---")

    cdf2 = wavdir + '/psp_mag_rtn__20200101_0900-1200.cdf'
    epoch2, data2 = load_cdf(cdf2)

    print(f"  CDF records: {len(epoch2)}")
    blocks2 = find_blocks(epoch2)
    print(f"  Blocks: {len(blocks2)}")
    for i, (s, e) in enumerate(blocks2):
        n = e - s + 1
        if n > 1:
            diffs = np.diff(epoch2[s:e+1])
            rounded = np.round(diffs / 1e3) * 1e3
            unique, counts = np.unique(rounded, return_counts=True)
            for u, c in zip(unique, counts):
                print(f"    Block {i}: {c} samples at {u/1e6:.3f}ms ({1e9/u:.2f}Hz)")

    # Request: 09:00–12:00, data lives at ~10:53–11:23
    # Compute request bounds relative to the data
    import pandas as pd
    t0 = pd.Timestamp(cdflib.cdfepoch.to_datetime(np.array([epoch2[0]]))[0].astype('datetime64[ms]'))
    # Go back to 09:00:00.000
    secs_past_9 = (t0.hour - 9) * 3600 + t0.minute * 60 + t0.second + t0.microsecond/1e6
    req_start_2 = epoch2[0] - int(secs_past_9 * 1e9)
    req_end_2 = req_start_2 + int(3 * 3600 * 1e9)

    filled2, report2 = blocks_to_gap_filled_audio(epoch2, data2, req_start_2, req_end_2)

    print(f"\n  Gap-fill results:")
    print(f"    Data samples:  {report2['total_data_samples']}")
    print(f"    Gap samples:   {report2['total_gap_samples']}")
    print(f"    Total output:  {report2['total_output_samples']}")
    if 'leading_gap_sec' in report2:
        print(f"    Leading gap:   {report2['leading_gap_sec']:.1f}s ({report2['leading_gap_samples']} samples)")
    if 'trailing_gap_sec' in report2:
        print(f"    Trailing gap:  {report2['trailing_gap_sec']:.1f}s ({report2['trailing_gap_samples']} samples)")

    for bi in report2['blocks']:
        print(f"    Block: {bi['samples']} samples, {bi['cadence_ms']:.3f}ms, {bi['start']} → {bi['end']}")

    # What should 3 hours look like at the dominant cadence?
    # The dominant cadence is the 9.16 Hz block (17408 samples)
    # But there's also a 73 Hz startup burst (512 samples)
    # The "correct" comparison: total time / dominant cadence
    dominant_hz = report2['blocks'][-1]['cadence_hz']  # last/largest block
    expected_3h_2 = int(round(3 * 3600 * dominant_hz))
    error_pct_2 = abs(report2['total_output_samples'] - expected_3h_2) / expected_3h_2 * 100
    print(f"\n    Expected (3h @ {dominant_hz:.2f}Hz): {expected_3h_2}")
    print(f"    Got: {report2['total_output_samples']}")
    print(f"    Error: {report2['total_output_samples'] - expected_3h_2} samples ({error_pct_2:.4f}%)")

    # =========================================================================
    # Test 3: Cross-check — Data-rich CDF (should be ~0 gap samples)
    # =========================================================================
    print("\n\n--- Test 3: Data-rich CDF — no gaps expected (00:00–02:03) ---")

    # Use the 00:00–02:03 CDF but only request exactly its data range
    # (no leading/trailing gap)
    cdf3 = wavdir + '/psp_mag_rtn__20200101_0000-0300.cdf'
    epoch3, data3 = load_cdf(cdf3)

    # Request exactly the data range
    filled3, report3 = blocks_to_gap_filled_audio(epoch3, data3, epoch3[0], epoch3[-1])

    print(f"  Data samples:  {report3['total_data_samples']}")
    print(f"  Gap samples:   {report3['total_gap_samples']}")
    print(f"  Total output:  {report3['total_output_samples']}")
    print(f"  Gap samples should be 0: {'✅' if report3['total_gap_samples'] == 0 else '❌'}")

    # =========================================================================
    # Test 4: Perihelion data — continuous, different cadence (146 Hz)
    # =========================================================================
    print("\n\n--- Test 4: Perihelion data — 146 Hz, no gaps (Jan 29 2020) ---")

    cdf4 = wavdir + '/psp_mag_rtn__20200129_1900-2000.cdf'
    epoch4, data4 = load_cdf(cdf4)

    blocks4 = find_blocks(epoch4)
    diffs4 = np.diff(epoch4)
    rounded4 = np.round(diffs4 / 1e3) * 1e3
    unique4, counts4 = np.unique(rounded4, return_counts=True)

    print(f"  Records: {len(epoch4)}")
    print(f"  Blocks: {len(blocks4)}")
    for u, c in zip(unique4, counts4):
        print(f"    {c} intervals at {u/1e6:.3f}ms ({1e9/u:.2f}Hz)")

    # Request exactly the data range
    filled4, report4 = blocks_to_gap_filled_audio(epoch4, data4, epoch4[0], epoch4[-1])
    print(f"  Gap samples: {report4['total_gap_samples']} {'✅' if report4['total_gap_samples'] == 0 else '❌'}")

    # =========================================================================
    # Test 5: Write comparison WAVs for listening
    # =========================================================================
    print("\n\n--- Writing comparison WAVs ---")

    # Original (no gap fill) for the 09:00–12:00 range
    out_orig = wavdir + '/v2_original_no_gapfill.wav'
    n_orig = data_to_wav(data2, out_orig)
    print(f"  Original: {n_orig} samples, {n_orig/WAV_SAMPLE_RATE:.3f}s")

    # Gap-filled
    out_filled = wavdir + '/v2_gap_filled.wav'
    n_filled = data_to_wav(filled2, out_filled)
    print(f"  Gap-filled: {n_filled} samples, {n_filled/WAV_SAMPLE_RATE:.3f}s")

    print(f"\n  Ratio: gap-filled is {n_filled/n_orig:.1f}x longer")
    print(f"  Original plays {n_orig/WAV_SAMPLE_RATE:.3f}s of audio for 3h of data")
    print(f"  Gap-filled plays {n_filled/WAV_SAMPLE_RATE:.3f}s of audio for 3h of data")

    # =========================================================================
    # VERDICT
    # =========================================================================
    print(f"\n{'=' * 80}")
    print("VERDICT: CDF-based reconstruction precision")
    print(f"{'=' * 80}")
    print(f"""
  CDF epochs give us nanosecond-precision timestamps for every sample.
  Gap durations are computed from EXACT epoch differences, not inventory.

  Test 1 error: {error_pct:.6f}% (rounding only)
  Test 2 error: {error_pct_2:.4f}%
  Test 3 gap leak: {report3['total_gap_samples']} samples (should be 0)
  Test 4 gap leak: {report4['total_gap_samples']} samples (should be 0)

  The remaining error comes from:
  - Using MODE cadence for gap fill (integer rounding)
  - Multi-rate blocks (73 Hz startup + 9 Hz main)

  For the CDAWeb proposal: if the server includes per-block sample counts
  and start/end times (from CDF epochs, not inventory), the reconstruction
  is sample-perfect.
""")


if __name__ == '__main__':
    main()
