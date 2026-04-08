#!/usr/bin/env python3
"""
Gap Healing Accuracy Test
==========================
The REAL test: does gap-healed audio match the length of continuous data?

For each test:
1. Pick a time window WITH gaps (from a known gappy period)
2. Pick a NEIGHBORING window of the SAME duration with NO gaps
3. Download CDFs for both
4. Gap-heal the gappy one
5. Compare sample counts — they should match

If the gap-healed version has the same number of samples as the
continuous version, the reconstruction is accurate.
"""

import cdflib
import numpy as np
import subprocess
import json
import os

WAVDIR = os.path.dirname(os.path.abspath(__file__)) + '/gap_test_wavs'

# Each test: a gappy window and a continuous window of the same duration
TESTS = [
    {
        'label': 'PSP Cruise Jan 1 2020 — 3 hours',
        'dataset': 'PSP_FLD_L2_MAG_RTN',
        'variable': 'psp_fld_l2_mag_RTN',
        'epoch_var': 'epoch_mag_RTN',
        'component': 0,
        # Gappy: 09:00-12:00 (data only at 10:53-11:23, ~30min of 3h)
        'gappy_start': '20200101T090000Z',
        'gappy_end': '20200101T120000Z',
        # Continuous: 00:00-03:00 (solid data block)
        'continuous_start': '20200101T000000Z',
        'continuous_end': '20200101T030000Z',
        'duration_label': '3 hours',
    },
    {
        'label': 'PSP Cruise Jan 1 2020 — 2 hours',
        'dataset': 'PSP_FLD_L2_MAG_RTN',
        'variable': 'psp_fld_l2_mag_RTN',
        'epoch_var': 'epoch_mag_RTN',
        'component': 0,
        # Gappy: 01:00-03:00 (data ends ~02:03, trailing gap)
        'gappy_start': '20200101T010000Z',
        'gappy_end': '20200101T030000Z',
        # Continuous: 00:00-02:00 (fully within data block)
        'continuous_start': '20200101T000000Z',
        'continuous_end': '20200101T020000Z',
        'duration_label': '2 hours',
    },
    {
        'label': 'PSP Cruise Jan 1-2 2020 — 12 hours (swiss cheese)',
        'dataset': 'PSP_FLD_L2_MAG_RTN',
        'variable': 'psp_fld_l2_mag_RTN',
        'epoch_var': 'epoch_mag_RTN',
        'component': 0,
        # Gappy: 00:00-12:00 Jan 1 (two blocks with 8.8h gap)
        'gappy_start': '20200101T000000Z',
        'gappy_end': '20200101T120000Z',
        # Continuous: perihelion E4, 12 hours of solid data
        'continuous_start': '20200129T060000Z',
        'continuous_end': '20200129T180000Z',
        'duration_label': '12 hours',
    },
]


def download_cdf(dataset, start, end, variable, label):
    """Download CDF, return path."""
    safe = label.replace(' ', '_').replace('—', '-').replace(',', '').replace('(', '').replace(')', '')
    path = f"{WAVDIR}/heal_{safe}.cdf"
    if os.path.exists(path) and os.path.getsize(path) > 100:
        return path

    url = (f"https://cdaweb.gsfc.nasa.gov/WS/cdasr/1/dataviews/sp_phys/datasets/"
           f"{dataset}/data/{start},{end}/{variable}?format=cdf")
    result = subprocess.run(
        ["curl", "-s", "-H", "Accept: application/json", url],
        capture_output=True, text=True, timeout=60)
    try:
        data = json.loads(result.stdout)
    except:
        print(f"    Bad response")
        return None

    if 'FileDescription' not in data:
        print(f"    No data available")
        return None

    cdf_url = data['FileDescription'][0]['Name']
    subprocess.run(["curl", "-s", "-o", path, cdf_url], timeout=120)
    return path if os.path.exists(path) and os.path.getsize(path) > 100 else None


def load_epoch(cdf_path, epoch_var):
    cdf = cdflib.CDF(cdf_path)
    return cdf.varget(epoch_var)


def find_blocks(epoch, gap_threshold_sec=30.0):
    """Find contiguous data blocks."""
    if len(epoch) < 2:
        return [{'start_idx': 0, 'end_idx': 0, 'n': 1,
                 'start_ns': int(epoch[0]), 'end_ns': int(epoch[0]),
                 'cadence_ns': 0}]

    diffs = np.diff(epoch)
    threshold = gap_threshold_sec * 1e9
    blocks = []
    start = 0

    for i in range(len(diffs)):
        if diffs[i] > threshold:
            blk = epoch[start:i+1]
            bd = np.diff(blk)
            rounded = np.round(bd / 1e3) * 1e3
            u, c = np.unique(rounded, return_counts=True)
            cadence = u[np.argmax(c)]
            blocks.append({
                'start_idx': start, 'end_idx': i, 'n': i - start + 1,
                'start_ns': int(epoch[start]), 'end_ns': int(epoch[i]),
                'cadence_ns': float(cadence),
            })
            start = i + 1

    # Final block
    blk = epoch[start:]
    bd = np.diff(blk) if len(blk) > 1 else np.array([0])
    if len(bd) > 0 and np.any(bd > 0):
        rounded = np.round(bd / 1e3) * 1e3
        u, c = np.unique(rounded, return_counts=True)
        cadence = u[np.argmax(c)]
    else:
        cadence = 0
    blocks.append({
        'start_idx': start, 'end_idx': len(epoch) - 1, 'n': len(epoch) - start,
        'start_ns': int(epoch[start]), 'end_ns': int(epoch[-1]),
        'cadence_ns': float(cadence),
    })
    return blocks


def gap_heal(blocks, request_start_ns, request_end_ns):
    """
    Given data blocks + request boundaries, compute the gap-healed
    total sample count. This is the PROPOSED algorithm.

    Uses each block's own cadence for its contribution, and the
    adjacent block's cadence for gap silence.
    """
    total = 0
    details = []

    # Leading gap
    if blocks[0]['start_ns'] > request_start_ns:
        gap_ns = blocks[0]['start_ns'] - request_start_ns
        cadence = blocks[0]['cadence_ns']
        n = int(round(gap_ns / cadence)) if cadence > 0 else 0
        total += n
        details.append(f"leading gap: {gap_ns/1e9:.1f}s → {n} silence")

    # Data blocks + internal gaps
    for i, b in enumerate(blocks):
        total += b['n']
        details.append(f"block {i}: {b['n']} data samples")

        if i < len(blocks) - 1:
            gap_ns = blocks[i+1]['start_ns'] - b['end_ns']
            # Use this block's cadence for gap fill
            cadence = b['cadence_ns']
            n = int(round(gap_ns / cadence)) if cadence > 0 else 0
            total += n
            details.append(f"gap: {gap_ns/1e9:.1f}s → {n} silence")

    # Trailing gap
    if blocks[-1]['end_ns'] < request_end_ns:
        gap_ns = request_end_ns - blocks[-1]['end_ns']
        cadence = blocks[-1]['cadence_ns']
        n = int(round(gap_ns / cadence)) if cadence > 0 else 0
        total += n
        details.append(f"trailing gap: {gap_ns/1e9:.1f}s → {n} silence")

    return total, details


def tt2000_str(ns):
    return str(cdflib.cdfepoch.to_datetime(np.array([ns]))[0].astype('datetime64[ms]'))


def main():
    os.makedirs(WAVDIR, exist_ok=True)

    print("=" * 80)
    print("GAP HEALING ACCURACY TEST")
    print("Compare gap-healed sample count vs continuous data sample count")
    print("=" * 80)

    summary = []

    for t in TESTS:
        print(f"\n{'='*80}")
        print(f"  {t['label']}")
        print(f"{'='*80}")

        # Download both CDFs
        print(f"\n  Gappy window: {t['gappy_start']} → {t['gappy_end']}")
        gappy_cdf = download_cdf(t['dataset'], t['gappy_start'], t['gappy_end'],
                                  t['variable'], f"{t['label']}_gappy")
        if not gappy_cdf:
            print("  SKIP — no gappy CDF")
            continue

        print(f"  Continuous window: {t['continuous_start']} → {t['continuous_end']}")
        cont_cdf = download_cdf(t['dataset'], t['continuous_start'], t['continuous_end'],
                                 t['variable'], f"{t['label']}_continuous")
        if not cont_cdf:
            print("  SKIP — no continuous CDF")
            continue

        # Load epochs
        gappy_epoch = load_epoch(gappy_cdf, t['epoch_var'])
        cont_epoch = load_epoch(cont_cdf, t['epoch_var'])

        # Analyze gappy data
        gappy_blocks = find_blocks(gappy_epoch)
        cont_blocks = find_blocks(cont_epoch)

        print(f"\n  GAPPY DATA:")
        print(f"    Records: {len(gappy_epoch)}")
        print(f"    Blocks: {len(gappy_blocks)}")
        for i, b in enumerate(gappy_blocks):
            hz = 1e9/b['cadence_ns'] if b['cadence_ns'] > 0 else 0
            print(f"      [{i}] {b['n']} samples @ {hz:.2f}Hz")
            print(f"          {tt2000_str(b['start_ns'])} → {tt2000_str(b['end_ns'])}")
            if i < len(gappy_blocks) - 1:
                gap = (gappy_blocks[i+1]['start_ns'] - b['end_ns']) / 1e9
                print(f"          ─── GAP: {gap:.1f}s ({gap/3600:.2f}h) ───")

        print(f"\n  CONTINUOUS DATA:")
        print(f"    Records: {len(cont_epoch)}")
        print(f"    Blocks: {len(cont_blocks)}")
        for b in cont_blocks:
            hz = 1e9/b['cadence_ns'] if b['cadence_ns'] > 0 else 0
            print(f"      {b['n']} samples @ {hz:.2f}Hz")
            print(f"      {tt2000_str(b['start_ns'])} → {tt2000_str(b['end_ns'])}")

        # Compute what continuous data SHOULD be for the same duration
        # Use the continuous block's actual cadence
        cont_cadence = cont_blocks[0]['cadence_ns']
        cont_hz = 1e9 / cont_cadence if cont_cadence > 0 else 0
        cont_duration = (cont_epoch[-1] - cont_epoch[0]) / 1e9
        cont_samples_per_sec = len(cont_epoch) / cont_duration if cont_duration > 0 else 0

        print(f"\n  Continuous reference:")
        print(f"    Duration: {cont_duration:.1f}s ({cont_duration/3600:.2f}h)")
        print(f"    Samples/sec: {cont_samples_per_sec:.4f}")
        print(f"    Cadence: {cont_cadence/1e6:.3f}ms ({cont_hz:.2f}Hz)")

        # Gap-heal the gappy data
        # Need request boundaries in TT2000
        # Use the continuous epoch to establish the cadence baseline,
        # then compute request boundaries from the gappy epoch context
        #
        # Actually — the request boundaries should come from the REQUEST,
        # not from the data. But we need TT2000 format. Let's derive from
        # the gappy data: the request window is larger than the data.
        # We know the gappy request and continuous request have the same duration.

        # For gap healing, we need TT2000 request boundaries.
        # Derive from the continuous data (which covers the full request):
        # The continuous window starts at cont_epoch[0] (approximately request start)
        # and ends at cont_epoch[-1] (approximately request end).
        # But we want the GAPPY window's request boundaries.
        # Since both are the same duration, let's compute:

        # Actually, let's just use the gappy epoch to figure out where the
        # request boundaries would be. We know the gappy window duration
        # from the test definition. Use the first gappy block's cadence.
        gappy_cadence = gappy_blocks[0]['cadence_ns']

        # Request start: either before or at the first sample
        # Request end: request_start + duration
        # Duration = continuous window duration (in seconds) * cadence = sample count
        # But we want TT2000 boundaries...

        # Simpler: just compute expected samples at the gappy cadence for the duration
        # Duration of the continuous window = len(cont_epoch) / cont_hz
        # Expected gap-healed count at gappy cadence = duration * gappy_hz

        # But actually the right way: use the ACTUAL epoch boundaries from gappy blocks
        # to compute gap healing. We need request start/end in TT2000.
        # Let me use the continuous epoch as proxy:
        # request_start ≈ cont_epoch[0] mapped to gappy window... this is getting circular.

        # SIMPLEST approach: use the continuous sample count as ground truth.
        # If cadences match (same dataset, same instrument mode), then
        # gap-healed count SHOULD equal continuous count.

        # But PSP cadence varies! Cruise=9Hz, perihelion=146Hz.
        # So for the 12-hour test, the cadences differ.
        # Only compare when cadences match.

        cadence_match = abs(cont_cadence - gappy_cadence) / cont_cadence < 0.05
        print(f"\n  Cadence comparison:")
        print(f"    Gappy:      {gappy_cadence/1e6:.3f}ms ({1e9/gappy_cadence:.2f}Hz)")
        print(f"    Continuous: {cont_cadence/1e6:.3f}ms ({cont_hz:.2f}Hz)")
        print(f"    Match:      {'✅ YES' if cadence_match else '❌ NO (different instrument modes)'}")

        if not cadence_match:
            print(f"\n  ⚠️ Cadences don't match — can't directly compare sample counts")
            print(f"  (Gappy period is cruise mode, continuous is perihelion mode)")
            # Scale the continuous count to gappy cadence
            scaled_expected = int(round(cont_duration * (1e9/gappy_cadence)))
            print(f"  Scaled expected at gappy cadence: {scaled_expected}")

        # Gap-heal: compute total using block boundaries
        # We need approximate TT2000 request boundaries.
        # For the gappy window, use inventory-style boundaries:
        # request_start = first block start - leading gap time
        # But we don't have that without TT2000 conversion...

        # OK let me just compute it relative to the first block:
        # The gappy request is X hours. The first sample is at gappy_epoch[0].
        # How far into the request is that first sample?
        # For 09:00-12:00 with first sample at 10:53:17: offset = 1h53m17s
        # We can get this from the ISO times...

        from datetime import datetime, timezone
        req_start_dt = datetime.strptime(t['gappy_start'], '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc)
        req_end_dt = datetime.strptime(t['gappy_end'], '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc)
        duration_sec = (req_end_dt - req_start_dt).total_seconds()

        first_dt = cdflib.cdfepoch.to_datetime(np.array([gappy_epoch[0]]))[0]
        first_dt_unix = first_dt.astype('datetime64[ms]').astype(np.int64) / 1000
        req_start_unix = req_start_dt.timestamp()

        leading_offset_sec = first_dt_unix - req_start_unix
        request_start_ns = gappy_epoch[0] - int(leading_offset_sec * 1e9)
        request_end_ns = request_start_ns + int(duration_sec * 1e9)

        healed_total, heal_details = gap_heal(gappy_blocks, request_start_ns, request_end_ns)

        print(f"\n  GAP HEALING:")
        for d in heal_details:
            print(f"    {d}")
        print(f"    ─────────────────────────────")
        print(f"    Total healed: {healed_total}")

        # What should it be? Use continuous count (same duration, same cadence)
        if cadence_match:
            expected = len(cont_epoch)
            error = healed_total - expected
            error_pct = abs(error) / expected * 100

            print(f"\n  VERDICT:")
            print(f"    Gap-healed:  {healed_total}")
            print(f"    Continuous:  {expected}")
            print(f"    Difference:  {error:+d} samples")
            print(f"    Error:       {error_pct:.6f}%")

            if error_pct < 0.001:
                status = "✅ SAMPLE-PERFECT"
            elif error_pct < 0.01:
                status = "✅ EXCELLENT"
            elif error_pct < 0.1:
                status = "⚠️ GOOD"
            else:
                status = f"❌ {error_pct:.4f}%"
            print(f"    Status:      {status}")

            summary.append({
                'label': t['label'],
                'duration': t['duration_label'],
                'healed': healed_total,
                'expected': expected,
                'error': error,
                'error_pct': error_pct,
                'status': status,
            })
        else:
            # Use scaled expectation
            expected = int(round(duration_sec * (1e9/gappy_cadence)))
            error = healed_total - expected
            error_pct = abs(error) / expected * 100

            print(f"\n  VERDICT (cadence-adjusted):")
            print(f"    Gap-healed:          {healed_total}")
            print(f"    Expected at {1e9/gappy_cadence:.2f}Hz: {expected}")
            print(f"    Difference:          {error:+d} samples")
            print(f"    Error:               {error_pct:.6f}%")

            status = "✅" if error_pct < 0.01 else "⚠️" if error_pct < 0.1 else "❌"
            print(f"    Status:              {status}")

            summary.append({
                'label': t['label'],
                'duration': t['duration_label'],
                'healed': healed_total,
                'expected': expected,
                'error': error,
                'error_pct': error_pct,
                'status': status + ' (cadence-adjusted)',
            })

    # Summary
    print(f"\n\n{'='*80}")
    print("SUMMARY")
    print(f"{'='*80}\n")
    for s in summary:
        print(f"  {s['label']}")
        print(f"    {s['duration']}: healed={s['healed']}, expected={s['expected']}, "
              f"diff={s['error']:+d}, error={s['error_pct']:.6f}% {s['status']}")
        print()


if __name__ == '__main__':
    main()
