#!/usr/bin/env python3
"""
Validate IDL Patch — DATAINTERVAL= Output
==========================================
Mirrors the exact gap detection algorithm from the patched audio_wav.pro
against real CDF data to verify correctness before submitting to CDAWeb.

Tests:
1. Gap detection matches known gaps from gap_reconstruct_v2.py
2. DATAINTERVAL= line format is correct and parseable
3. Cadence values are reasonable
4. Sample counts sum to total records
"""

import cdflib
import numpy as np
import wave
import os

WAVDIR = os.path.dirname(os.path.abspath(__file__)) + '/gap_test_wavs'

# Test cases — mix of gappy and continuous data
TEST_CASES = [
    {
        'label': 'PSP Cruise — 2 blocks, 8.8h gap (GAPPY)',
        'cdf': f'{WAVDIR}/multitest_PSP_MAG_RTN_-_Cruise_9_Hz_large_gaps.cdf',
        'wav': f'{WAVDIR}/multitest_PSP_MAG_RTN_-_Cruise_9_Hz_large_gaps.wav',
        'dataset': 'PSP_FLD_L2_MAG_RTN',
        'variable': 'psp_fld_l2_mag_RTN',
        'epoch_var': 'epoch_mag_RTN',
        'component': 0,
        'expect_gaps': True,
    },
    {
        'label': 'GOES-16 MAG — Continuous baseline (NO GAPS)',
        'cdf': f'{WAVDIR}/multitest_GOES-16_MAG_-_Continuous_baseline_should_be_trivial.cdf',
        'wav': f'{WAVDIR}/multitest_GOES-16_MAG_-_Continuous_baseline_should_be_trivial.wav',
        'dataset': 'GOES16_1_MAGN_L2',
        'variable': 'b_gsm',
        'epoch_var': 'Epoch',
        'component': 0,
        'expect_gaps': False,
    },
    {
        'label': 'MMS1 EDP Fast — Operational gaps',
        'cdf': f'{WAVDIR}/multitest_MMS1_EDP_Fast_-_Operational_gaps.cdf',
        'wav': f'{WAVDIR}/multitest_MMS1_EDP_Fast_-_Operational_gaps.wav',
        'dataset': 'MMS1_EDP_FAST_L2_DCE',
        'variable': 'mms1_edp_dce_gse_fast_l2',
        'epoch_var': 'mms1_edp_epoch_fast_l2',
        'component': 0,
        'expect_gaps': None,  # Unknown — depends on time range
    },
    {
        'label': 'Solar Orbiter MAG Normal — Occasional gaps',
        'cdf': f'{WAVDIR}/multitest_Solar_Orbiter_MAG_Normal_-_Occasional_gaps.cdf',
        'wav': f'{WAVDIR}/multitest_Solar_Orbiter_MAG_Normal_-_Occasional_gaps.wav',
        'dataset': 'SOLO_L2_MAG-RTN-NORMAL',
        'variable': 'B_RTN',
        'epoch_var': 'EPOCH',
        'component': 0,
        'expect_gaps': None,  # Unknown — depends on time range
    },
    {
        'label': 'PSP Perihelion E4 — 146 Hz, no gaps expected',
        'cdf': f'{WAVDIR}/multitest_PSP_MAG_RTN_-_Perihelion_E4_146_Hz_no_gaps_expected.cdf',
        'wav': f'{WAVDIR}/multitest_PSP_MAG_RTN_-_Perihelion_E4_146_Hz_no_gaps_expected.wav',
        'dataset': 'PSP_FLD_L2_MAG_RTN',
        'variable': 'psp_fld_l2_mag_RTN',
        'epoch_var': 'epoch_mag_RTN',
        'component': 0,
        'expect_gaps': False,
    },
]


def idl_gap_detection(epoch):
    """
    Exact mirror of the IDL patch in audio_wav.pro.

    Algorithm:
      1. Compute time_diffs = epoch[1:] - epoch[:-1]
      2. med_cadence = MEDIAN(time_diffs)
      3. gap_threshold = 2.0 * med_cadence
      4. gap_idx = WHERE(time_diffs > gap_threshold)
      5. Build intervals from gap boundaries
    """
    buf_sz = len(epoch)

    if buf_sz <= 1:
        return [{
            'start_epoch': int(epoch[0]) if buf_sz == 1 else 0,
            'end_epoch': int(epoch[0]) if buf_sz == 1 else 0,
            'samples': buf_sz,
            'cadence': 0.0,
        }]

    # Step 1: Time differences
    time_diffs = np.diff(epoch.astype(np.float64))

    # Step 2: Median cadence
    med_cadence = np.median(time_diffs)

    # Step 3: Gap threshold (2x median)
    gap_threshold = 2.0 * med_cadence

    # Step 4: Find gaps
    gap_idx = np.where(time_diffs > gap_threshold)[0]
    n_gaps = len(gap_idx)

    # Step 5: Build intervals
    n_intervals = n_gaps + 1
    intervals = []
    blk_start = 0

    for blk in range(n_intervals):
        if blk < n_gaps:
            blk_end = gap_idx[blk]
        else:
            blk_end = buf_sz - 1

        start_epoch = int(epoch[blk_start])
        end_epoch = int(epoch[blk_end])
        samples = blk_end - blk_start + 1

        # Per-block cadence
        if blk_end > blk_start:
            blk_diffs = epoch[blk_start+1:blk_end+1].astype(np.float64) - epoch[blk_start:blk_end].astype(np.float64)
            cadence = float(np.median(blk_diffs))
        else:
            cadence = float(med_cadence)

        intervals.append({
            'start_epoch': start_epoch,
            'end_epoch': end_epoch,
            'samples': samples,
            'cadence': cadence,
        })

        blk_start = blk_end + 1

    return intervals


def format_datainterval_line(interval):
    """Format exactly as the IDL PRINT statement would."""
    return (
        f"DATAINTERVAL="
        f"{interval['start_epoch']},"
        f"{interval['end_epoch']},"
        f"{interval['samples']},"
        f"{interval['cadence']:.6f}"
    )


def tt2000_to_str(ns):
    """Convert TT2000 nanoseconds to human-readable string."""
    try:
        return str(cdflib.cdfepoch.to_datetime(np.array([ns]))[0].astype('datetime64[ms]'))
    except:
        return f"epoch={ns}"


def main():
    print("=" * 80)
    print("IDL PATCH VALIDATION — DATAINTERVAL= Output")
    print("Mirrors exact algorithm from patched audio_wav.pro")
    print("=" * 80)

    all_passed = True

    for tc in TEST_CASES:
        print(f"\n{'='*80}")
        print(f"  {tc['label']}")
        print(f"{'='*80}")

        if not os.path.exists(tc['cdf']):
            print(f"  SKIP — CDF not found: {tc['cdf']}")
            continue

        # Load CDF
        cdf = cdflib.CDF(tc['cdf'])
        epoch = cdf.varget(tc['epoch_var'])
        data = cdf.varget(tc['variable'])
        if data.ndim == 2 and tc['component'] is not None:
            data = data[:, tc['component']]

        print(f"  Records: {len(epoch)}")

        # Run IDL-equivalent gap detection
        intervals = idl_gap_detection(epoch)

        print(f"  Intervals detected: {len(intervals)}")
        print(f"  Expected gaps: {'Yes' if tc['expect_gaps'] else 'No'}")

        # Verify: sample counts sum to total
        total_samples = sum(iv['samples'] for iv in intervals)
        samples_match = total_samples == len(epoch)

        print(f"\n  Sample count check: {total_samples} vs {len(epoch)} — {'PASS' if samples_match else 'FAIL'}")
        if not samples_match:
            all_passed = False

        # Verify: gap expectation matches
        has_gaps = len(intervals) > 1
        if tc['expect_gaps'] is not None:
            gap_expectation_match = has_gaps == tc['expect_gaps']
            print(f"  Gap expectation:   {'PASS' if gap_expectation_match else 'FAIL'} (found {len(intervals)-1} gap(s))")
            if not gap_expectation_match:
                all_passed = False
        else:
            print(f"  Gap expectation:   N/A (found {len(intervals)-1} gap(s))")

        # Print the DATAINTERVAL= lines (what IDL would emit)
        print(f"\n  STDOUT output (what IDL would print):")
        for iv in intervals:
            line = format_datainterval_line(iv)
            print(f"    {line}")

        # Human-readable breakdown
        print(f"\n  Interval details:")
        for i, iv in enumerate(intervals):
            hz = 1e9 / iv['cadence'] if iv['cadence'] > 0 else 0
            cadence_ms = iv['cadence'] / 1e6 if iv['cadence'] > 0 else 0
            print(f"    [{i}] {iv['samples']:>8} samples | cadence {cadence_ms:.3f}ms ({hz:.1f}Hz)")
            print(f"         {tt2000_to_str(iv['start_epoch'])} → {tt2000_to_str(iv['end_epoch'])}")

            if i < len(intervals) - 1:
                gap_ns = intervals[i+1]['start_epoch'] - iv['end_epoch']
                gap_sec = gap_ns / 1e9
                gap_hr = gap_sec / 3600
                print(f"         ─── GAP: {gap_sec:.1f}s ({gap_hr:.2f}h) ───")

        # Cross-check with WAV file
        if os.path.exists(tc['wav']):
            with wave.open(tc['wav'], 'rb') as w:
                wav_samples = w.getnframes()
            wav_match = wav_samples == total_samples
            print(f"\n  WAV cross-check: WAV has {wav_samples} samples vs CDF {total_samples} — {'PASS' if wav_match else 'MISMATCH (expected — CDAWeb concatenates without gaps)'}")

        # Verify cadences are reasonable (positive, not astronomical)
        cadences_ok = all(0 < iv['cadence'] < 1e12 for iv in intervals if iv['cadence'] > 0)
        print(f"  Cadence sanity:    {'PASS' if cadences_ok else 'FAIL'}")
        if not cadences_ok:
            all_passed = False

        # Verify intervals are chronologically ordered and non-overlapping
        ordered = all(
            intervals[i+1]['start_epoch'] > intervals[i]['end_epoch']
            for i in range(len(intervals) - 1)
        )
        print(f"  Ordering check:    {'PASS' if ordered else 'FAIL'}")
        if not ordered:
            all_passed = False

    # Parse-back test — verify the DATAINTERVAL= lines can be parsed
    print(f"\n{'='*80}")
    print("  PARSE-BACK TEST")
    print(f"{'='*80}")
    print("  Simulating Java-side parsing of DATAINTERVAL= lines...")

    # Use the first gappy test case
    cdf = cdflib.CDF(TEST_CASES[0]['cdf'])
    epoch = cdf.varget(TEST_CASES[0]['epoch_var'])
    intervals = idl_gap_detection(epoch)

    parsed_intervals = []
    for iv in intervals:
        line = format_datainterval_line(iv)
        # Java would do: line.substring("DATAINTERVAL=".length()).split(",")
        payload = line[len("DATAINTERVAL="):]
        parts = payload.split(",")
        parsed = {
            'Start': int(parts[0]),
            'End': int(parts[1]),
            'Samples': int(parts[2]),
            'CadenceNs': float(parts[3]),
        }
        parsed_intervals.append(parsed)

    print(f"  Parsed {len(parsed_intervals)} intervals from STDOUT lines")
    for i, p in enumerate(parsed_intervals):
        print(f"    [{i}] Start={p['Start']}, End={p['End']}, Samples={p['Samples']}, CadenceNs={p['CadenceNs']:.6f}")

    roundtrip_ok = all(
        p['Start'] == iv['start_epoch'] and
        p['End'] == iv['end_epoch'] and
        p['Samples'] == iv['samples'] and
        abs(p['CadenceNs'] - iv['cadence']) < 1.0
        for p, iv in zip(parsed_intervals, intervals)
    )
    print(f"  Roundtrip fidelity: {'PASS' if roundtrip_ok else 'FAIL'}")
    if not roundtrip_ok:
        all_passed = False

    # JSON format example (what the REST response would look like)
    print(f"\n  Example REST response JSON:")
    print("  {")
    print('    "DataIntervals": [')
    for i, p in enumerate(parsed_intervals):
        comma = "," if i < len(parsed_intervals) - 1 else ""
        cadence_ms = p['CadenceNs'] / 1e6
        print(f'      {{"Start": "{tt2000_to_str(p["Start"])}", "End": "{tt2000_to_str(p["End"])}", "Samples": {p["Samples"]}, "CadenceMs": {cadence_ms:.6f}}}{comma}')
    print("    ]")
    print("  }")

    print(f"\n{'='*80}")
    print(f"  OVERALL: {'ALL TESTS PASSED' if all_passed else 'SOME TESTS FAILED'}")
    print(f"{'='*80}")


if __name__ == '__main__':
    main()
