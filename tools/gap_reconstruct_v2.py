#!/usr/bin/env python3
"""
Gap Reconstruction v2 — Focused Test
======================================
Tests the reconstruction algorithm on time ranges with CONFIRMED gaps.
Fixed: uses cdflib for proper TT2000 conversion (no approximate offset).
"""

import cdflib
import numpy as np
import wave
import subprocess
import json
import os

WAVDIR = os.path.dirname(os.path.abspath(__file__)) + '/gap_test_wavs'

TEST_CASES = [
    {
        'label': 'PSP Cruise — 2 blocks, 8.8h gap',
        'dataset': 'PSP_FLD_L2_MAG_RTN',
        'variable': 'psp_fld_l2_mag_RTN',
        'epoch_var': 'epoch_mag_RTN',
        'start': '20200101T000000Z',
        'end': '20200101T120000Z',
        'component': 0,
    },
    {
        'label': 'MMS1 EDP Fast — gap across midnight',
        'dataset': 'MMS1_EDP_FAST_L2_DCE',
        'variable': 'mms1_edp_dce_gse_fast_l2',
        'epoch_var': 'mms1_edp_epoch_fast_l2',
        'start': '20220101T180000Z',
        'end': '20220102T060000Z',
        'component': 0,
    },
]


def fetch_json(url):
    result = subprocess.run(
        ["curl", "-s", "-H", "Accept: application/json", url],
        capture_output=True, text=True, timeout=60)
    return json.loads(result.stdout)


def download_file(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 100:
        return True
    subprocess.run(["curl", "-s", "-o", path, url], timeout=120)
    return os.path.exists(path) and os.path.getsize(path) > 100


def load_wav(path):
    with wave.open(path, 'rb') as w:
        raw = w.readframes(w.getnframes())
        return np.frombuffer(raw, dtype=np.int16), w.getframerate()


def find_blocks(epoch, gap_threshold_sec=30.0):
    """Find contiguous blocks using absolute time threshold."""
    if len(epoch) < 2:
        return [{'start_idx': 0, 'end_idx': 0, 'n': 1}]

    diffs = np.diff(epoch)
    threshold = gap_threshold_sec * 1e9

    blocks = []
    start = 0
    for i in range(len(diffs)):
        if diffs[i] > threshold:
            blk_diffs = np.diff(epoch[start:i+1])
            rounded = np.round(blk_diffs / 1e3) * 1e3
            u, c = np.unique(rounded, return_counts=True)
            cadence = u[np.argmax(c)]

            blocks.append({
                'start_idx': start, 'end_idx': i,
                'n': i - start + 1,
                'start_ns': int(epoch[start]), 'end_ns': int(epoch[i]),
                'cadence_ns': float(cadence),
            })
            start = i + 1

    # Final block
    blk_diffs = np.diff(epoch[start:])
    if len(blk_diffs) > 0:
        rounded = np.round(blk_diffs / 1e3) * 1e3
        u, c = np.unique(rounded, return_counts=True)
        cadence = u[np.argmax(c)]
    else:
        cadence = 0

    blocks.append({
        'start_idx': start, 'end_idx': len(epoch) - 1,
        'n': len(epoch) - start,
        'start_ns': int(epoch[start]), 'end_ns': int(epoch[-1]),
        'cadence_ns': float(cadence),
    })
    return blocks


def tt2000_str(ns):
    return str(cdflib.cdfepoch.to_datetime(np.array([ns]))[0].astype('datetime64[ms]'))


def main():
    os.makedirs(WAVDIR, exist_ok=True)

    print("=" * 80)
    print("GAP RECONSTRUCTION v2 — CONFIRMED GAPS")
    print("=" * 80)

    for tc in TEST_CASES:
        print(f"\n{'='*80}")
        print(f"  {tc['label']}")
        print(f"  {tc['dataset']} | {tc['start']} → {tc['end']}")
        print(f"{'='*80}")

        safe = tc['label'].replace(' ', '_').replace('—', '-').replace(',', '')
        cdf_path = f"{WAVDIR}/v2_{safe}.cdf"
        wav_path = f"{WAVDIR}/v2_{safe}.wav"

        # Download CDF
        print("  Downloading CDF...")
        cdf_json = fetch_json(
            f"https://cdaweb.gsfc.nasa.gov/WS/cdasr/1/dataviews/sp_phys/datasets/"
            f"{tc['dataset']}/data/{tc['start']},{tc['end']}/{tc['variable']}?format=cdf")
        if 'FileDescription' not in cdf_json:
            print(f"  No CDF data: {cdf_json}")
            continue
        download_file(cdf_json['FileDescription'][0]['Name'], cdf_path)

        # Download WAV
        print("  Downloading WAV...")
        wav_json = fetch_json(
            f"https://cdaweb.gsfc.nasa.gov/WS/cdasr/1/dataviews/sp_phys/datasets/"
            f"{tc['dataset']}/data/{tc['start']},{tc['end']}/{tc['variable']}?format=audio")
        if 'FileDescription' not in wav_json:
            print(f"  No WAV data: {wav_json}")
            continue
        download_file(wav_json['FileDescription'][0]['Name'], wav_path)

        # Also grab what CDAWeb reports in the WAV response
        wav_meta = wav_json['FileDescription'][0]
        print(f"  CDAWeb WAV metadata:")
        print(f"    StartTime: {wav_meta['StartTime']}")
        print(f"    EndTime:   {wav_meta['EndTime']}")
        print(f"    Length:    {wav_meta['Length']} bytes")

        # Load CDF
        cdf = cdflib.CDF(cdf_path)
        epoch = cdf.varget(tc['epoch_var'])
        data = cdf.varget(tc['variable'])
        if data.ndim == 2:
            data = data[:, tc['component']]

        # Load WAV
        wav_samples, wav_rate = load_wav(wav_path)

        print(f"\n  Ground Truth (CDF):")
        print(f"    Records: {len(epoch)}")

        blocks = find_blocks(epoch)
        print(f"    Blocks: {len(blocks)}")

        total_block_samples = 0
        for i, b in enumerate(blocks):
            hz = 1e9/b['cadence_ns'] if b['cadence_ns'] > 0 else 0
            print(f"      [{i}] {b['n']:>8} samples | {b['cadence_ns']/1e6:.3f}ms ({hz:.1f}Hz)")
            print(f"           {tt2000_str(b['start_ns'])} → {tt2000_str(b['end_ns'])}")
            total_block_samples += b['n']

            if i < len(blocks) - 1:
                gap_ns = blocks[i+1]['start_ns'] - b['end_ns']
                print(f"           ─── GAP: {gap_ns/1e9:.1f}s ({gap_ns/1e9/3600:.2f}h) ───")

        print(f"\n  CDAWeb WAV: {len(wav_samples)} samples")
        print(f"  CDF total:  {total_block_samples} samples")
        print(f"  Match:      {'✅ EXACT' if len(wav_samples) == total_block_samples else '❌ MISMATCH: ' + str(len(wav_samples) - total_block_samples)}")

        # =====================================================================
        # THE RECONSTRUCTION ALGORITHM
        # This is what the end-user would do with WAV + DataIntervals metadata
        # =====================================================================
        print(f"\n  ── RECONSTRUCTION ──")
        print(f"  Given: WAV ({len(wav_samples)} samples) + DataIntervals metadata")
        print(f"  Goal:  Insert silence for gaps, align to wall-clock time")

        # Simulate metadata (what CDAWeb would provide)
        metadata = []
        wav_offset = 0
        for b in blocks:
            metadata.append({
                'start_ns': b['start_ns'],
                'end_ns': b['end_ns'],
                'samples': b['n'],
                'cadence_ms': b['cadence_ns'] / 1e6,
                'wav_offset': wav_offset,
            })
            wav_offset += b['n']

        # Step 1: Split WAV at block boundaries
        print(f"\n  Step 1: Split WAV into {len(metadata)} chunks using sample counts")
        chunks = []
        for i, m in enumerate(metadata):
            chunk = wav_samples[m['wav_offset']:m['wav_offset'] + m['samples']]
            chunks.append(chunk)
            print(f"    Chunk {i}: samples [{m['wav_offset']}:{m['wav_offset']+m['samples']}] = {len(chunk)} samples")

        # Step 2: Calculate gap durations and silence samples
        print(f"\n  Step 2: Calculate silence for {len(blocks)-1} gap(s)")
        gaps = []
        for i in range(len(metadata) - 1):
            gap_ns = metadata[i+1]['start_ns'] - metadata[i]['end_ns']
            # Use cadence of the block BEFORE the gap to compute silence samples
            cadence_ns = metadata[i]['cadence_ms'] * 1e6
            n_silence = int(round(gap_ns / cadence_ns)) if cadence_ns > 0 else 0
            gaps.append({
                'after_block': i,
                'gap_sec': gap_ns / 1e9,
                'silence_samples': n_silence,
            })
            print(f"    Gap after block {i}: {gap_ns/1e9:.1f}s → {n_silence} silence samples")

        # Step 3: Interleave data chunks with silence
        print(f"\n  Step 3: Interleave data + silence")
        output = []
        for i, chunk in enumerate(chunks):
            output.append(chunk)
            if i < len(gaps):
                output.append(np.zeros(gaps[i]['silence_samples'], dtype=np.int16))

        reconstructed = np.concatenate(output)

        total_data = sum(len(c) for c in chunks)
        total_silence = sum(g['silence_samples'] for g in gaps)
        print(f"    Data samples:    {total_data}")
        print(f"    Silence samples: {total_silence}")
        print(f"    Total output:    {len(reconstructed)}")

        # Step 4: Verify — what SHOULD the total be?
        print(f"\n  Step 4: Accuracy check")
        # Total duration from first sample to last sample + gaps
        total_data_duration_ns = sum(
            (m['end_ns'] - m['start_ns']) for m in metadata
        )
        total_gap_duration_ns = sum(
            (metadata[i+1]['start_ns'] - metadata[i]['end_ns'])
            for i in range(len(metadata) - 1)
        )
        total_duration_ns = total_data_duration_ns + total_gap_duration_ns

        dominant = max(metadata, key=lambda m: m['samples'])
        dominant_cadence = dominant['cadence_ms'] * 1e6
        expected_total = total_data + int(round(total_gap_duration_ns / dominant_cadence))

        error = len(reconstructed) - expected_total
        error_pct = abs(error) / expected_total * 100 if expected_total > 0 else 0

        print(f"    Data duration:  {total_data_duration_ns/1e9:.1f}s")
        print(f"    Gap duration:   {total_gap_duration_ns/1e9:.1f}s ({total_gap_duration_ns/1e9/3600:.2f}h)")
        print(f"    Total span:     {total_duration_ns/1e9:.1f}s ({total_duration_ns/1e9/3600:.2f}h)")
        print(f"    Expected total: {expected_total}")
        print(f"    Got:            {len(reconstructed)}")
        print(f"    Error:          {error} samples ({error_pct:.6f}%)")

        if error_pct < 0.001:
            print(f"    ✅ SAMPLE-PERFECT")
        elif error_pct < 0.01:
            print(f"    ✅ EXCELLENT (<0.01%)")
        elif error_pct < 0.1:
            print(f"    ⚠️ GOOD (<0.1%)")
        else:
            print(f"    ❌ NEEDS WORK (>{error_pct:.2f}%)")

        # Write the reconstructed WAV for listening
        out_path = f"{WAVDIR}/v2_reconstructed_{safe}.wav"
        with wave.open(out_path, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(wav_rate)
            w.writeframes(reconstructed.tobytes())
        print(f"\n  Written: {out_path}")
        print(f"    Original WAV:      {len(wav_samples)/wav_rate:.3f}s")
        print(f"    Reconstructed WAV: {len(reconstructed)/wav_rate:.3f}s")
        print(f"    Ratio:             {len(reconstructed)/len(wav_samples):.1f}x longer")


if __name__ == '__main__':
    main()
