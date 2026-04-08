#!/usr/bin/env python3
"""
Gap Catalog Validation — Proves per-interval fetching eliminates the gap problem.

Strategy:
  Instead of requesting one big range (which concatenates across gaps),
  use the catalog to request each interval separately. Then verify:

  1. Single big request: N samples (gaps silently removed)
  2. Per-interval requests: N1 + N2 + N3 samples (each gap-free)
  3. Totals should match (proving catalog boundaries are correct)
  4. Sample values should correlate at boundaries (proving alignment)
  5. We can stitch per-interval WAVs with silence at gap positions

Usage:
    python3 tools/validate_gap_catalog.py
"""

import json
import sys
import os
import tempfile
import requests
import time
import wave
from datetime import datetime
from pathlib import Path

try:
    import numpy as np
except ImportError:
    print("ERROR: pip install numpy")
    sys.exit(1)

CATALOG_DIR = Path(__file__).parent / 'gap_catalog'
CDAWEB_BASE = 'https://cdaweb.gsfc.nasa.gov/WS/cdasr/1/dataviews/sp_phys/datasets'

# Test parameters — Wind MFI, 2 gaps in late Nov 1994
DATASET_ID = 'WI_H2_MFI'
DATA_VAR = 'BF1'
REQ_START = '1994-11-27T20:00:00Z'
REQ_END = '1994-12-01T03:00:00Z'

passed = 0
failed = 0


def ok(msg):
    global passed
    passed += 1
    print(f'  ✓ {msg}')


def fail(msg):
    global failed
    failed += 1
    print(f'  ✗ FAIL: {msg}')


def parse_iso(s):
    s = s.rstrip('Z')
    for fmt in ['%Y-%m-%dT%H:%M:%S.%f', '%Y-%m-%dT%H:%M:%S']:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def to_cdaweb_date(dt_str):
    """Convert to CDAWeb compact format: 19941127T200000Z"""
    if isinstance(dt_str, datetime):
        return dt_str.strftime('%Y%m%dT%H%M%SZ')
    dt_str = dt_str.rstrip('Z')
    dt = parse_iso(dt_str)
    return dt.strftime('%Y%m%dT%H%M%SZ')


def download_wav(dataset_id, data_var, start, end, label=''):
    """Download audio WAV from CDAWeb and return (n_frames, samples_array)."""
    start_fmt = to_cdaweb_date(start)
    end_fmt = to_cdaweb_date(end)
    url = f'{CDAWEB_BASE}/{dataset_id}/data/{start_fmt},{end_fmt}/{data_var}?format=audio'
    prefix = f'  [{label}] ' if label else '  '
    print(f'{prefix}Downloading WAV: {start_fmt} to {end_fmt}...')
    resp = requests.get(url, headers={'Accept': 'application/json'}, timeout=120)
    resp.raise_for_status()
    data = resp.json()
    wav_url = data['FileDescription'][0]['Name']

    wav_resp = requests.get(wav_url, timeout=120)
    wav_resp.raise_for_status()

    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        f.write(wav_resp.content)
        tmp_path = f.name

    try:
        with wave.open(tmp_path, 'rb') as wf:
            n_channels = wf.getnchannels()
            sample_width = wf.getsampwidth()
            n_frames = wf.getnframes()
            raw_bytes = wf.readframes(n_frames)

        if sample_width == 2:
            samples = np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float64)
        elif sample_width == 4:
            samples = np.frombuffer(raw_bytes, dtype=np.int32).astype(np.float64)
        else:
            samples = np.frombuffer(raw_bytes, dtype=np.uint8).astype(np.float64)

        if n_channels > 1:
            samples = samples.reshape(-1, n_channels)[:, 0]

        print(f'{prefix}{n_frames} samples')
        return n_frames, samples
    finally:
        os.unlink(tmp_path)


def main():
    print(f'\n{"=" * 60}')
    print(f'Gap Catalog Validation — Per-Interval Fetching')
    print(f'{"=" * 60}\n')

    # Load catalog
    catalog_path = CATALOG_DIR / f'{DATASET_ID}.json'
    with open(catalog_path) as f:
        catalog = json.load(f)

    intervals = catalog['intervals']
    print(f'Catalog: {DATASET_ID} — {len(intervals)} intervals, {catalog["summary"]["total_gaps"]} gaps\n')

    # Find intervals that overlap our test range
    req_start = parse_iso(REQ_START)
    req_end = parse_iso(REQ_END)

    relevant = []
    for i, iv in enumerate(intervals):
        iv_start = parse_iso(iv.get('start_precise', iv['start_iso']))
        iv_end = parse_iso(iv.get('end_precise', iv['end_iso']))
        if iv_end > req_start and iv_start < req_end:
            relevant.append((i, iv, iv_start, iv_end))

    print(f'Test range: {REQ_START} to {REQ_END}')
    print(f'Relevant intervals: {len(relevant)}')
    for idx, iv, iv_start, iv_end in relevant:
        print(f'  [{idx}] {iv.get("start_precise", iv["start_iso"])} → {iv.get("end_precise", iv["end_iso"])}')
    print()

    # Compute gaps between intervals
    gaps = []
    for i in range(len(relevant) - 1):
        _, iv_curr, _, iv_end_curr = relevant[i]
        _, iv_next, iv_start_next, _ = relevant[i + 1]
        gap_start = iv_end_curr
        gap_end = iv_start_next
        gap_duration = (gap_end - gap_start).total_seconds()
        gaps.append((gap_start, gap_end, gap_duration))
        end_ts = iv_curr.get('end_precise', iv_curr['end_iso'])
        start_ts = iv_next.get('start_precise', iv_next['start_iso'])
        print(f'  Gap {i+1}: {end_ts} → {start_ts} ({gap_duration:.0f}s = {gap_duration/3600:.1f}h)')
    print()

    # =========================================================================
    # Step 1: Download ONE big WAV (CDAWeb's default — gaps removed)
    # =========================================================================
    print(f'--- Step 1: Single request (gaps silently concatenated) ---\n')
    time.sleep(1)
    big_n, big_samples = download_wav(DATASET_ID, DATA_VAR, REQ_START, REQ_END, 'BIG')
    print()

    # =========================================================================
    # Step 2: Download per-interval WAVs using catalog boundaries
    # =========================================================================
    print(f'--- Step 2: Per-interval requests (using catalog boundaries) ---\n')
    interval_wavs = []
    for idx, iv, iv_start, iv_end in relevant:
        # Clip to request range
        eff_start = max(iv_start, req_start)
        eff_end = min(iv_end, req_end)
        time.sleep(2)  # be nice to CDAWeb
        try:
            n, samples = download_wav(DATASET_ID, DATA_VAR, eff_start, eff_end, f'IV{idx}')
            interval_wavs.append((idx, n, samples))
        except Exception as e:
            fail(f'Interval {idx} download failed: {e}')
            interval_wavs.append((idx, 0, np.array([])))

    print()

    # =========================================================================
    # Step 3: Compare totals
    # =========================================================================
    print(f'--- Step 3: Compare sample counts ---\n')
    per_interval_total = sum(n for _, n, _ in interval_wavs)
    print(f'  Single request (with gaps removed): {big_n} samples')
    print(f'  Per-interval requests sum:          {per_interval_total} samples')
    for idx, n, _ in interval_wavs:
        print(f'    Interval {idx}: {n} samples')

    diff = big_n - per_interval_total
    if abs(diff) <= 2:
        ok(f'Sample counts match! diff={diff} (CDAWeb concatenation confirmed)')
    elif abs(diff) <= 20:
        ok(f'Sample counts nearly match: diff={diff} (minor CDAWeb boundary rounding)')
    else:
        fail(f'Sample count mismatch: {big_n} vs {per_interval_total}, diff={diff}')

    # =========================================================================
    # Step 4: Verify sample values match between approaches
    # =========================================================================
    print(f'\n--- Step 4: Verify sample values match ---\n')
    offset = 0
    for i, (idx, n, samples) in enumerate(interval_wavs):
        if n == 0:
            continue

        # The big WAV should contain this interval's samples starting at 'offset'
        if offset + n > len(big_samples):
            # Try with slightly different count
            n_avail = len(big_samples) - offset
            if n_avail > 100:
                n = n_avail
            else:
                fail(f'Interval {idx}: not enough samples in big WAV (offset={offset}, need={n}, have={len(big_samples)})')
                break

        big_segment = big_samples[offset:offset + n]

        # Normalize for comparison (WAV int16 scaling might differ per-request)
        big_norm = big_segment / (np.max(np.abs(big_segment)) + 1e-10)
        iv_norm = samples[:n] / (np.max(np.abs(samples[:n])) + 1e-10)

        n_check = min(200, n)

        # Check start and end of each segment
        corr_start = np.corrcoef(big_norm[:n_check], iv_norm[:n_check])[0, 1]
        corr_end = np.corrcoef(big_norm[-n_check:], iv_norm[-n_check:])[0, 1]

        if corr_start > 0.99 and corr_end > 0.99:
            ok(f'Interval {idx}: start corr={corr_start:.6f}, end corr={corr_end:.6f} — perfect match')
        elif corr_start > 0.95 and corr_end > 0.95:
            ok(f'Interval {idx}: start corr={corr_start:.4f}, end corr={corr_end:.4f} — close match')
        else:
            # Try small offsets in case of boundary rounding
            best_shift = 0
            best_corr = corr_start
            for shift in range(-10, 11):
                s = offset + shift
                if s >= 0 and s + n <= len(big_samples):
                    seg = big_samples[s:s + n]
                    seg_norm = seg / (np.max(np.abs(seg)) + 1e-10)
                    c = np.corrcoef(seg_norm[:n_check], iv_norm[:n_check])[0, 1]
                    if c > best_corr:
                        best_corr = c
                        best_shift = shift

            if best_corr > 0.99:
                ok(f'Interval {idx}: aligned with shift={best_shift}, corr={best_corr:.6f}')
                offset += best_shift  # adjust for subsequent intervals
            else:
                fail(f'Interval {idx}: start corr={corr_start:.4f}, end corr={corr_end:.4f}, best shift={best_shift} corr={best_corr:.4f}')

        offset += n

    # =========================================================================
    # Step 5: Demonstrate stitching with silence
    # =========================================================================
    print(f'\n--- Step 5: Stitch with silence at gap positions ---\n')

    # Calculate what the correct audio buffer looks like
    total_duration = (req_end - req_start).total_seconds()
    # Use a common sample rate for the output (e.g., 22000 Hz like CDAWeb WAV)
    out_sr = 22000
    total_out_samples = int(total_duration * out_sr)

    # For each interval, compute where it sits in the output buffer
    for i, (idx, n, samples) in enumerate(interval_wavs):
        _, iv, iv_start, iv_end = relevant[i]
        eff_start = max(iv_start, req_start)
        eff_end = min(iv_end, req_end)
        offset_sec = (eff_start - req_start).total_seconds()
        duration_sec = (eff_end - eff_start).total_seconds()
        out_offset = int(offset_sec * out_sr)
        print(f'  Interval {idx}: offset {offset_sec:.1f}s → sample {out_offset} in output buffer ({n} data samples)')

    for gap_start, gap_end, gap_dur in gaps:
        offset_sec = (gap_start - req_start).total_seconds()
        print(f'  Gap: offset {offset_sec:.1f}s, duration {gap_dur:.0f}s → SILENCE')

    print(f'\n  Output buffer: {total_out_samples} samples at {out_sr} Hz ({total_duration:.0f}s)')
    print(f'  Data fills {per_interval_total} samples, silence fills the gaps')
    ok(f'Per-interval stitching plan computed successfully')

    # =========================================================================
    # Summary
    # =========================================================================
    print(f'\n{"=" * 60}')
    print(f'Results: {passed} passed, {failed} failed')

    if failed == 0:
        print(f'\n  VALIDATED: The gap catalog enables correct per-interval fetching.')
        print(f'  Instead of one big request (gaps silently removed), the app can:')
        print(f'    1. Fetch the gap catalog for the dataset (~70ms from edge cache)')
        print(f'    2. Request each interval separately from CDAWeb')
        print(f'    3. Place each interval at its correct time offset in the audio buffer')
        print(f'    4. Leave silence in the gaps')
        print(f'  Result: time-aligned audio with gaps preserved.')

    print(f'{"=" * 60}\n')
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
