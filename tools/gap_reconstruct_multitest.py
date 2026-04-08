#!/usr/bin/env python3
"""
Gap Reconstruction Multi-Dataset Test
=======================================
Tests whether an end-user can accurately reconstruct gap-aligned audio
given ONLY a concatenated WAV + metadata (DataIntervals).

For each gappy dataset:
1. Download CDF (ground truth — has exact epoch timestamps)
2. Download WAV (what CDAWeb currently returns — concatenated, no gaps)
3. Simulate the proposed metadata (DataIntervals from CDF epochs)
4. Reconstruct gap-filled audio using ONLY the WAV + metadata
5. Verify: does the reconstruction match the CDF ground truth?

The key question: Is the reconstruction algorithm simple enough and
accurate enough to hand to an end-user?
"""

import cdflib
import numpy as np
import wave
import subprocess
import json
import os
import struct
import sys
from io import BytesIO

WAVDIR = os.path.dirname(os.path.abspath(__file__)) + '/gap_test_wavs'

# ============================================================================
# Test cases — datasets with known gaps
# ============================================================================
TEST_CASES = [
    {
        'label': 'PSP MAG RTN — Cruise (9 Hz, large gaps)',
        'dataset': 'PSP_FLD_L2_MAG_RTN',
        'variable': 'psp_fld_l2_mag_RTN',
        'epoch_var': 'epoch_mag_RTN',
        'start': '20200101T000000Z',
        'end': '20200101T120000Z',
        'component': 0,
    },
    {
        'label': 'PSP MAG RTN — Perihelion E4 (146 Hz, no gaps expected)',
        'dataset': 'PSP_FLD_L2_MAG_RTN',
        'variable': 'psp_fld_l2_mag_RTN',
        'epoch_var': 'epoch_mag_RTN',
        'start': '20200129T190000Z',
        'end': '20200129T200000Z',
        'component': 0,
    },
    {
        'label': 'MMS1 EDP Fast — Operational gaps',
        'dataset': 'MMS1_EDP_FAST_L2_DCE',
        'variable': 'mms1_edp_dce_gse_fast_l2',
        'epoch_var': 'mms1_edp_epoch_fast_l2',
        'start': '20220101T000000Z',
        'end': '20220101T060000Z',
        'component': 0,
    },
    {
        'label': 'Solar Orbiter MAG Normal — Occasional gaps',
        'dataset': 'SOLO_L2_MAG-RTN-NORMAL',
        'variable': 'B_RTN',
        'epoch_var': 'EPOCH',
        'start': '20220115T000000Z',
        'end': '20220116T000000Z',
        'component': 0,
    },
    {
        'label': 'GOES-16 MAG — Continuous (baseline, should be trivial)',
        'dataset': 'DN_MAGN-L2-HIRES_G16',
        'variable': 'b_gsm',
        'epoch_var': 'time',
        'start': '20220101T080000Z',
        'end': '20220101T090000Z',
        'component': 0,
    },
]


def download_cdf(dataset, start, end, variable, label):
    """Download CDF from CDAWeb. Returns path to downloaded file."""
    safe_label = label.replace(' ', '_').replace('—', '-').replace('(', '').replace(')', '').replace(',', '')
    cdf_path = f"{WAVDIR}/multitest_{safe_label}.cdf"

    if os.path.exists(cdf_path):
        print(f"    [cached] {cdf_path}")
        return cdf_path

    url = f"https://cdaweb.gsfc.nasa.gov/WS/cdasr/1/dataviews/sp_phys/datasets/{dataset}/data/{start},{end}/{variable}?format=cdf"
    print(f"    Downloading CDF...")

    # First get the JSON with download URL
    cmd = ["curl", "-s", "-H", "Accept: application/json", url]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        print(f"    ERROR: Bad JSON response: {result.stdout[:200]}")
        return None

    if 'FileDescription' not in data:
        if 'Error' in data or 'Message' in data:
            msg = data.get('Error', data.get('Message', ['Unknown']))
            print(f"    No data: {msg}")
        else:
            print(f"    No FileDescription in response")
        return None

    cdf_url = data['FileDescription'][0]['Name']
    cmd2 = ["curl", "-s", "-o", cdf_path, cdf_url]
    subprocess.run(cmd2, timeout=120)

    if os.path.exists(cdf_path) and os.path.getsize(cdf_path) > 100:
        print(f"    Downloaded: {cdf_path} ({os.path.getsize(cdf_path)} bytes)")
        return cdf_path
    else:
        print(f"    Download failed")
        return None


def download_wav(dataset, start, end, variable, label):
    """Download WAV from CDAWeb audio endpoint. Returns path."""
    safe_label = label.replace(' ', '_').replace('—', '-').replace('(', '').replace(')', '').replace(',', '')
    wav_path = f"{WAVDIR}/multitest_{safe_label}.wav"

    if os.path.exists(wav_path):
        print(f"    [cached] {wav_path}")
        return wav_path

    url = f"https://cdaweb.gsfc.nasa.gov/WS/cdasr/1/dataviews/sp_phys/datasets/{dataset}/data/{start},{end}/{variable}?format=audio"
    print(f"    Downloading WAV...")

    cmd = ["curl", "-s", "-H", "Accept: application/json", url]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        print(f"    ERROR: Bad JSON response")
        return None

    if 'FileDescription' not in data:
        print(f"    No audio data available")
        return None

    # Download first component WAV
    wav_url = data['FileDescription'][0]['Name']
    cmd2 = ["curl", "-s", "-o", wav_path, wav_url]
    subprocess.run(cmd2, timeout=60)

    if os.path.exists(wav_path) and os.path.getsize(wav_path) > 100:
        print(f"    Downloaded: {wav_path} ({os.path.getsize(wav_path)} bytes)")
        return wav_path
    else:
        print(f"    Download failed")
        return None


def load_wav_samples(wav_path):
    """Load WAV file, return (samples_int16, sample_rate, n_channels)."""
    with wave.open(wav_path, 'rb') as w:
        n_channels = w.getnchannels()
        sampwidth = w.getsampwidth()
        framerate = w.getframerate()
        n_frames = w.getnframes()
        raw = w.readframes(n_frames)

    if sampwidth == 2:
        samples = np.frombuffer(raw, dtype=np.int16)
    else:
        raise ValueError(f"Unexpected sample width: {sampwidth}")

    return samples, framerate, n_channels


def analyze_cdf_blocks(epoch, gap_threshold_sec=30.0):
    """
    Find contiguous data blocks in epoch array.
    Uses absolute time threshold (not relative to cadence) to distinguish
    real gaps from cadence transitions.

    Returns list of dicts with start/end times, sample counts, cadences.
    """
    if len(epoch) < 2:
        return [{'start_ns': epoch[0], 'end_ns': epoch[0], 'n_samples': 1, 'cadence_ns': 0}]

    diffs = np.diff(epoch)
    threshold_ns = gap_threshold_sec * 1e9

    blocks = []
    block_start = 0

    for i in range(len(diffs)):
        if diffs[i] > threshold_ns:
            # End of a block
            block_epoch = epoch[block_start:i+1]
            block_diffs = np.diff(block_epoch) if len(block_epoch) > 1 else np.array([0])
            # Mode cadence
            if len(block_diffs) > 0 and np.any(block_diffs > 0):
                rounded = np.round(block_diffs / 1e3) * 1e3
                unique, counts = np.unique(rounded, return_counts=True)
                mode_cadence = unique[np.argmax(counts)]
            else:
                mode_cadence = 0

            blocks.append({
                'start_ns': int(epoch[block_start]),
                'end_ns': int(epoch[i]),
                'n_samples': i - block_start + 1,
                'cadence_ns': float(mode_cadence),
                'start_idx': block_start,
                'end_idx': i,
            })
            block_start = i + 1

    # Final block
    block_epoch = epoch[block_start:]
    block_diffs = np.diff(block_epoch) if len(block_epoch) > 1 else np.array([0])
    if len(block_diffs) > 0 and np.any(block_diffs > 0):
        rounded = np.round(block_diffs / 1e3) * 1e3
        unique, counts = np.unique(rounded, return_counts=True)
        mode_cadence = unique[np.argmax(counts)]
    else:
        mode_cadence = 0

    blocks.append({
        'start_ns': int(epoch[block_start]),
        'end_ns': int(epoch[-1]),
        'n_samples': len(epoch) - block_start,
        'cadence_ns': float(mode_cadence),
        'start_idx': block_start,
        'end_idx': len(epoch) - 1,
    })

    return blocks


def simulate_metadata(blocks):
    """
    Simulate what CDAWeb WOULD return as DataIntervals metadata.
    This is what we're proposing they add to the audio response.
    """
    intervals = []
    cumulative_samples = 0
    for b in blocks:
        intervals.append({
            'Start_ns': b['start_ns'],
            'End_ns': b['end_ns'],
            'Samples': b['n_samples'],
            'CadenceMs': b['cadence_ns'] / 1e6,
            'WavOffset': cumulative_samples,  # where in the WAV these samples start
        })
        cumulative_samples += b['n_samples']
    return intervals


def reconstruct_with_metadata(wav_samples, metadata, request_start_ns, request_end_ns, wav_rate=22000):
    """
    THE END-USER ALGORITHM.

    Given:
    - wav_samples: int16 array from CDAWeb WAV (concatenated, no gaps)
    - metadata: DataIntervals array (proposed enhancement)
    - request_start_ns, request_end_ns: what the user asked for

    Returns:
    - reconstructed: int16 array with silence inserted for gaps
    - report: dict with reconstruction details
    """
    report = {
        'input_samples': len(wav_samples),
        'n_intervals': len(metadata),
        'gaps_inserted': [],
    }

    if len(metadata) == 0:
        return wav_samples, report

    chunks = []

    # Leading gap: request started before first data
    first = metadata[0]
    if first['Start_ns'] > request_start_ns:
        leading_gap_ns = first['Start_ns'] - request_start_ns
        # How many WAV samples of silence? Use the first interval's cadence
        # to maintain the same time compression ratio
        cadence_ns = first['CadenceMs'] * 1e6
        if cadence_ns > 0:
            n_silence = int(round(leading_gap_ns / cadence_ns))
        else:
            n_silence = 0
        chunks.append(np.zeros(n_silence, dtype=np.int16))
        report['gaps_inserted'].append({
            'type': 'leading',
            'duration_sec': leading_gap_ns / 1e9,
            'silence_samples': n_silence,
        })

    # For each interval, extract its samples from the WAV and add gaps between
    for i, interval in enumerate(metadata):
        # Extract this interval's samples from the concatenated WAV
        offset = interval['WavOffset']
        n = interval['Samples']

        if offset + n <= len(wav_samples):
            chunk = wav_samples[offset:offset + n]
        else:
            # WAV might be shorter than expected (CDAWeb truncation)
            available = max(0, len(wav_samples) - offset)
            chunk = wav_samples[offset:offset + available]
            report['truncated'] = True

        chunks.append(chunk)

        # Gap to next interval
        if i < len(metadata) - 1:
            next_interval = metadata[i + 1]
            gap_ns = next_interval['Start_ns'] - interval['End_ns']

            # Use average cadence of adjacent intervals for gap fill
            cadence_this = interval['CadenceMs'] * 1e6
            cadence_next = next_interval['CadenceMs'] * 1e6
            avg_cadence = (cadence_this + cadence_next) / 2

            if avg_cadence > 0:
                n_silence = int(round(gap_ns / avg_cadence))
            else:
                n_silence = 0

            chunks.append(np.zeros(n_silence, dtype=np.int16))
            report['gaps_inserted'].append({
                'type': 'internal',
                'duration_sec': gap_ns / 1e9,
                'silence_samples': n_silence,
            })

    # Trailing gap
    last = metadata[-1]
    if last['End_ns'] < request_end_ns:
        trailing_gap_ns = request_end_ns - last['End_ns']
        cadence_ns = last['CadenceMs'] * 1e6
        if cadence_ns > 0:
            n_silence = int(round(trailing_gap_ns / cadence_ns))
        else:
            n_silence = 0
        chunks.append(np.zeros(n_silence, dtype=np.int16))
        report['gaps_inserted'].append({
            'type': 'trailing',
            'duration_sec': trailing_gap_ns / 1e9,
            'silence_samples': n_silence,
        })

    reconstructed = np.concatenate(chunks)
    report['output_samples'] = len(reconstructed)
    report['total_silence'] = sum(g['silence_samples'] for g in report['gaps_inserted'])

    return reconstructed, report


def format_tt2000(ns):
    """Format TT2000 nanoseconds to readable string."""
    dt = cdflib.cdfepoch.to_datetime(np.array([ns]))[0]
    return str(dt.astype('datetime64[ms]'))


def iso_to_tt2000_approx(iso_str):
    """Approximate ISO to TT2000 for request boundary comparison."""
    from datetime import datetime, timezone
    dt = datetime.strptime(iso_str, '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc)
    j2000 = datetime(2000, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    delta = dt - j2000
    return int(delta.total_seconds() * 1e9)


def main():
    os.makedirs(WAVDIR, exist_ok=True)

    print("=" * 80)
    print("GAP RECONSTRUCTION — MULTI-DATASET TEST")
    print("=" * 80)
    print()
    print("Testing whether an end-user can reconstruct gap-aligned audio")
    print("from a concatenated WAV + DataIntervals metadata.")
    print()

    results = []

    for tc in TEST_CASES:
        print(f"\n{'='*80}")
        print(f"  {tc['label']}")
        print(f"  {tc['dataset']} | {tc['start']} → {tc['end']}")
        print(f"{'='*80}")

        # 1. Download CDF (ground truth)
        cdf_path = download_cdf(tc['dataset'], tc['start'], tc['end'],
                                tc['variable'], tc['label'])
        if not cdf_path:
            print("  SKIPPED — no CDF available")
            results.append({'label': tc['label'], 'status': 'SKIPPED'})
            continue

        # 2. Load CDF and analyze blocks
        try:
            cdf = cdflib.CDF(cdf_path)
            epoch = cdf.varget(tc['epoch_var'])
            data = cdf.varget(tc['variable'])
            if data.ndim == 2:
                data = data[:, tc['component']].astype(np.float64)
        except Exception as e:
            print(f"  ERROR loading CDF: {e}")
            results.append({'label': tc['label'], 'status': f'CDF ERROR: {e}'})
            continue

        blocks = analyze_cdf_blocks(epoch)

        print(f"\n  CDF Ground Truth:")
        print(f"    Total records: {len(epoch)}")
        print(f"    Data blocks: {len(blocks)}")
        for i, b in enumerate(blocks):
            hz = 1e9/b['cadence_ns'] if b['cadence_ns'] > 0 else 0
            print(f"      [{i}] {b['n_samples']} samples, {b['cadence_ns']/1e6:.3f}ms ({hz:.2f}Hz)")
            print(f"          {format_tt2000(b['start_ns'])} → {format_tt2000(b['end_ns'])}")

        # Gaps between blocks
        n_gaps = 0
        for i in range(len(blocks) - 1):
            gap_ns = blocks[i+1]['start_ns'] - blocks[i]['end_ns']
            gap_sec = gap_ns / 1e9
            if gap_sec > 30:
                n_gaps += 1
                print(f"      GAP: {gap_sec:.1f}s ({gap_sec/3600:.2f}h)")

        if n_gaps == 0:
            print(f"      No gaps (continuous data)")

        # 3. Download WAV
        wav_path = download_wav(tc['dataset'], tc['start'], tc['end'],
                                tc['variable'], tc['label'])
        if not wav_path:
            print("  SKIPPED — no WAV available")
            results.append({'label': tc['label'], 'status': 'NO WAV'})
            continue

        wav_samples, wav_rate, wav_channels = load_wav_samples(wav_path)

        print(f"\n  CDAWeb WAV:")
        print(f"    Samples: {len(wav_samples)}")
        print(f"    Rate: {wav_rate} Hz")
        print(f"    Duration: {len(wav_samples)/wav_rate:.3f}s")

        # 4. Simulate metadata (what CDAWeb WOULD return)
        metadata = simulate_metadata(blocks)

        print(f"\n  Simulated DataIntervals metadata:")
        for m in metadata:
            print(f"    Samples={m['Samples']}, Cadence={m['CadenceMs']:.3f}ms, WavOffset={m['WavOffset']}")

        # Verify: WAV sample count should match total CDF records
        total_cdf_samples = sum(b['n_samples'] for b in blocks)
        wav_vs_cdf = len(wav_samples) - total_cdf_samples
        print(f"\n  WAV samples vs CDF records: {len(wav_samples)} vs {total_cdf_samples} (diff: {wav_vs_cdf})")

        # 5. Reconstruct using ONLY WAV + metadata
        req_start_ns = iso_to_tt2000_approx(tc['start'])
        req_end_ns = iso_to_tt2000_approx(tc['end'])

        reconstructed, report = reconstruct_with_metadata(
            wav_samples, metadata, req_start_ns, req_end_ns, wav_rate)

        print(f"\n  Reconstruction:")
        print(f"    Input: {report['input_samples']} samples")
        print(f"    Output: {report['output_samples']} samples")
        print(f"    Silence inserted: {report['total_silence']} samples")
        print(f"    Gaps filled: {len(report['gaps_inserted'])}")
        for g in report['gaps_inserted']:
            print(f"      {g['type']}: {g['duration_sec']:.1f}s → {g['silence_samples']} silence samples")

        # 6. Accuracy check
        # Expected total: request duration in samples at the dominant cadence
        dominant_cadence = max(blocks, key=lambda b: b['n_samples'])['cadence_ns']
        if dominant_cadence > 0:
            expected_total = int(round((req_end_ns - req_start_ns) / dominant_cadence))
            error = report['output_samples'] - expected_total
            error_pct = abs(error) / expected_total * 100 if expected_total > 0 else 0

            print(f"\n  Accuracy:")
            print(f"    Expected ({(req_end_ns-req_start_ns)/1e9:.0f}s @ {1e9/dominant_cadence:.2f}Hz): {expected_total}")
            print(f"    Got: {report['output_samples']}")
            print(f"    Error: {error} samples ({error_pct:.4f}%)")

            status = '✅' if error_pct < 0.01 else '⚠️' if error_pct < 1.0 else '❌'
            print(f"    {status}")
        else:
            error_pct = 0
            status = '⚠️ (cadence unknown)'

        results.append({
            'label': tc['label'],
            'blocks': len(blocks),
            'gaps': n_gaps,
            'cdf_samples': total_cdf_samples,
            'wav_samples': len(wav_samples),
            'wav_vs_cdf_diff': wav_vs_cdf,
            'reconstructed_samples': report['output_samples'],
            'silence_samples': report['total_silence'],
            'error_pct': error_pct,
            'status': status,
        })

    # =========================================================================
    # Summary
    # =========================================================================
    print(f"\n\n{'='*80}")
    print("SUMMARY")
    print(f"{'='*80}\n")

    print(f"{'Dataset':<55} {'Blocks':>6} {'Gaps':>5} {'WAV≠CDF':>8} {'Error':>10} {'Status':>6}")
    print("-" * 95)
    for r in results:
        if 'blocks' in r:
            print(f"{r['label']:<55} {r['blocks']:>6} {r['gaps']:>5} {r['wav_vs_cdf_diff']:>+8} {r['error_pct']:>9.4f}% {r['status']:>6}")
        else:
            print(f"{r['label']:<55} {'':>6} {'':>5} {'':>8} {'':>10} {r['status']:>6}")

    print(f"\nKey findings:")
    print(f"  - WAV≠CDF: difference between WAV sample count and CDF record count")
    print(f"    (should be 0 if CDAWeb isn't adding/removing samples)")
    print(f"  - Error: reconstruction accuracy vs expected sample count for full duration")


if __name__ == '__main__':
    main()
