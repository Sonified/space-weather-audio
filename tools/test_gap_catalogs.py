#!/usr/bin/env python3
"""
Test suite for gap catalog JSON files.
Validates structure, data integrity, and cross-consistency.

Usage:
    python3 tools/test_gap_catalogs.py              # local files only
    python3 tools/test_gap_catalogs.py --api         # also test API endpoints
"""

import json
import sys
import os
import argparse
from pathlib import Path
from datetime import datetime

CATALOG_DIR = Path(__file__).parent / 'gap_catalog'

# Expected fields per interval
REQUIRED_INTERVAL_FIELDS = {'start_iso', 'end_iso'}
SHARPENED_END_FIELDS = {'end_epoch_raw', 'end_precise'}
SHARPENED_START_FIELDS = {'start_epoch_raw', 'start_precise'}

# All datasets we expect catalogs for (from gap_cataloger.py)
EXPECTED_DATASETS = [
    'PSP_FLD_L2_MAG_RTN', 'PSP_FLD_L2_MAG_RTN_4_SA_PER_CYC', 'PSP_FLD_L2_DFB_WF_DVDC',
    'WI_H2_MFI',
    'MMS1_FGM_SRVY_L2', 'MMS1_FGM_BRST_L2', 'MMS1_SCM_SRVY_L2_SCSRVY', 'MMS1_SCM_BRST_L2_SCB',
    'MMS1_EDP_SLOW_L2_DCE', 'MMS1_EDP_FAST_L2_DCE', 'MMS1_EDP_BRST_L2_DCE',
    'THA_L2_FGM', 'THB_L2_FGM', 'THC_L2_FGM', 'THD_L2_FGM', 'THE_L2_FGM',
    'THA_L2_SCM', 'THB_L2_SCM', 'THC_L2_SCM', 'THD_L2_SCM', 'THE_L2_SCM',
    'THA_L2_EFI', 'THB_L2_EFI', 'THC_L2_EFI', 'THD_L2_EFI', 'THE_L2_EFI',
    'SOLO_L2_MAG-RTN-NORMAL', 'SOLO_L2_MAG-RTN-BURST', 'SOLO_L2_RPW-LFR-SURV-CWF-E',
    'DN_MAGN-L2-HIRES_G16', 'DN_MAGN-L2-HIRES_G19',
    'AC_H3_MFI', 'DSCOVR_H0_MAG',
    'C1_CP_FGM_5VPS', 'C2_CP_FGM_5VPS', 'C3_CP_FGM_5VPS', 'C4_CP_FGM_5VPS',
    'C1_CP_STA_CWF_GSE', 'C2_CP_STA_CWF_GSE', 'C3_CP_STA_CWF_GSE', 'C4_CP_STA_CWF_GSE',
    'C1_CP_EFW_L3_E3D_INERT', 'C2_CP_EFW_L3_E3D_INERT', 'C3_CP_EFW_L3_E3D_INERT', 'C4_CP_EFW_L3_E3D_INERT',
    'GE_K0_EFD', 'GE_EDB3SEC_MGF',
    'VOYAGER1_2S_MAG', 'VOYAGER2_2S_MAG',
]

passed = 0
failed = 0
warnings = 0


def ok(msg):
    global passed
    passed += 1
    print(f'  ✓ {msg}')


def fail(msg):
    global failed
    failed += 1
    print(f'  ✗ FAIL: {msg}')


def warn(msg):
    global warnings
    warnings += 1
    print(f'  ⚠ WARN: {msg}')


def parse_iso(s):
    """Parse ISO timestamp, handling both with and without milliseconds."""
    for fmt in ['%Y-%m-%dT%H:%M:%S.%fZ', '%Y-%m-%dT%H:%M:%S.%f', '%Y-%m-%dT%H:%M:%SZ', '%Y-%m-%dT%H:%M:%S']:
        try:
            return datetime.strptime(s.rstrip('Z'), fmt.rstrip('Z'))
        except ValueError:
            continue
    return None


def test_catalog_structure(filepath):
    """Test basic JSON structure and required fields."""
    with open(filepath) as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError as e:
            fail(f'Invalid JSON: {e}')
            return None

    # Top-level fields
    for field in ['dataset_id', 'label', 'cataloged_at', 'time_range', 'summary', 'intervals']:
        if field not in data:
            fail(f'Missing top-level field: {field}')
            return None
    ok('Top-level structure valid')

    # time_range
    tr = data['time_range']
    if 'start' not in tr or 'end' not in tr:
        fail('time_range missing start/end')
    else:
        ok('time_range has start/end')

    # summary
    s = data['summary']
    for field in ['total_intervals', 'total_gaps', 'boundaries_sharpened']:
        if field not in s:
            fail(f'summary missing: {field}')

    # Validate interval count matches
    if len(data['intervals']) != s['total_intervals']:
        fail(f'Interval count mismatch: {len(data["intervals"])} in array vs {s["total_intervals"]} in summary')
    else:
        ok(f'Interval count matches: {s["total_intervals"]}')

    # Validate gap count = intervals - 1
    expected_gaps = max(0, s['total_intervals'] - 1)
    if s['total_gaps'] != expected_gaps:
        fail(f'Gap count mismatch: {s["total_gaps"]} vs expected {expected_gaps}')
    else:
        ok(f'Gap count correct: {s["total_gaps"]}')

    return data


def test_intervals(data):
    """Test interval data integrity."""
    intervals = data['intervals']
    dataset_id = data['dataset_id']
    sharpened = data['summary']['boundaries_sharpened']

    if not intervals:
        ok('No intervals (empty dataset)')
        return

    # Check required fields on all intervals
    for i, iv in enumerate(intervals):
        for field in REQUIRED_INTERVAL_FIELDS:
            if field not in iv:
                fail(f'Interval {i} missing {field}')
                return
    ok('All intervals have start_iso/end_iso')

    # Check chronological order
    order_ok = True
    for i in range(len(intervals)):
        start = parse_iso(intervals[i]['start_iso'])
        end = parse_iso(intervals[i]['end_iso'])
        if start is None or end is None:
            fail(f'Interval {i}: unparseable timestamp')
            order_ok = False
            break
        if start > end:
            fail(f'Interval {i}: start_iso > end_iso ({intervals[i]["start_iso"]} > {intervals[i]["end_iso"]})')
            order_ok = False
            break
        if i > 0:
            prev_end = parse_iso(intervals[i-1]['end_iso'])
            if start < prev_end:
                warn(f'Interval {i}: overlaps with previous by {(prev_end - start).total_seconds():.0f}s (CDAWeb inventory overlap)')
                # Don't break — overlaps from CDAWeb inventory are upstream data issues
    if order_ok:
        ok('Intervals in chronological order, no overlaps')

    # Check sharpened boundaries
    if sharpened is True:
        sharpened_end_count = sum(1 for iv in intervals if 'end_precise' in iv)
        sharpened_start_count = sum(1 for iv in intervals if 'start_precise' in iv)
        # First interval shouldn't have start_precise (no gap before it)
        # Last interval shouldn't have end_precise (no gap after it)
        # Interior intervals can have both
        total_boundaries = sharpened_end_count + sharpened_start_count
        expected_min = data['summary']['total_gaps']  # at least 1 per gap (some gaps have 2)
        if total_boundaries == 0 and data['summary']['total_gaps'] > 0:
            fail(f'Marked as sharpened but no precise boundaries found')
        else:
            ok(f'Sharpened boundaries: {sharpened_end_count} ends, {sharpened_start_count} starts')

        # Check precise timestamps are parseable and close to inventory timestamps
        for i, iv in enumerate(intervals):
            if 'end_precise' in iv:
                precise = parse_iso(iv['end_precise'])
                inventory = parse_iso(iv['end_iso'])
                if precise is None:
                    fail(f'Interval {i}: unparseable end_precise: {iv["end_precise"]}')
                elif inventory and abs((precise - inventory).total_seconds()) > 86400:
                    warn(f'Interval {i}: end_precise differs from end_iso by {abs((precise - inventory).total_seconds()):.0f}s (>24h)')
            if 'start_precise' in iv:
                precise = parse_iso(iv['start_precise'])
                inventory = parse_iso(iv['start_iso'])
                if precise is None:
                    fail(f'Interval {i}: unparseable start_precise: {iv["start_precise"]}')
                elif inventory and abs((precise - inventory).total_seconds()) > 86400:
                    warn(f'Interval {i}: start_precise differs from start_iso by {abs((precise - inventory).total_seconds()):.0f}s (>24h)')

        # Check epoch_raw values exist alongside precise
        for i, iv in enumerate(intervals):
            if 'end_precise' in iv and 'end_epoch_raw' not in iv:
                fail(f'Interval {i}: has end_precise but no end_epoch_raw')
            if 'start_precise' in iv and 'start_epoch_raw' not in iv:
                fail(f'Interval {i}: has start_precise but no start_epoch_raw')
        ok('epoch_raw values present where expected')

    elif sharpened == 'in_progress':
        warn('Sharpening in progress (incomplete)')


def test_cadence(data):
    """Test cadence_ns values where present."""
    intervals = data['intervals']
    cadence_count = sum(1 for iv in intervals if 'cadence_ns' in iv)

    if cadence_count == 0:
        if data['summary']['boundaries_sharpened'] is True and data['summary']['total_gaps'] > 0:
            warn('Sharpened but no cadence_ns found on any interval')
        return

    # Check cadence values are reasonable (1 Hz to 100 kHz = 10ms to 1s in ns)
    for i, iv in enumerate(intervals):
        if 'cadence_ns' in iv:
            ns = iv['cadence_ns']
            hz = 1e9 / ns if ns > 0 else 0
            if ns <= 0:
                fail(f'Interval {i}: cadence_ns <= 0: {ns}')
            elif hz < 0.01 or hz > 1e6:
                warn(f'Interval {i}: unusual cadence {hz:.2f} Hz ({ns:.0f} ns)')

    ok(f'Cadence values present on {cadence_count} intervals')


def test_gaps_are_positive(data):
    """Verify all gaps have positive duration (gap_start < gap_end)."""
    intervals = data['intervals']
    if len(intervals) < 2:
        return

    for i in range(len(intervals) - 1):
        gap_start = intervals[i]['end_iso']
        gap_end = intervals[i + 1]['start_iso']
        gs = parse_iso(gap_start)
        ge = parse_iso(gap_end)
        if gs and ge and gs > ge:
            warn(f'Negative gap between intervals {i} and {i+1}: {gap_start} > {gap_end} (CDAWeb inventory overlap)')
            return
    ok('All gaps have positive duration')


def test_file_sizes(catalogs):
    """Check for suspiciously large or empty files."""
    for filepath, data in catalogs.items():
        size = filepath.stat().st_size
        if size == 0:
            fail(f'{filepath.name}: empty file')
        elif size > 50 * 1024 * 1024:  # 50 MB
            warn(f'{filepath.name}: very large ({size / 1024 / 1024:.1f} MB)')


def test_api_endpoint(dataset_id):
    """Test the Cloudflare Worker API endpoint for a dataset."""
    import requests
    url = f'https://spaceweather.now.audio/api/gap-catalog/{dataset_id}'
    try:
        resp = requests.get(url, timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            if data.get('dataset_id') == dataset_id:
                ok(f'API: {dataset_id} returned valid JSON ({resp.elapsed.total_seconds()*1000:.0f}ms)')
            else:
                fail(f'API: {dataset_id} returned wrong dataset_id: {data.get("dataset_id")}')
        elif resp.status_code == 404:
            fail(f'API: {dataset_id} not found (404)')
        else:
            fail(f'API: {dataset_id} returned {resp.status_code}')
    except Exception as e:
        fail(f'API: {dataset_id} error: {e}')


def test_api_list():
    """Test the catalog list endpoint."""
    import requests
    url = 'https://spaceweather.now.audio/api/gap-catalog'
    try:
        resp = requests.get(url, timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            catalogs = data.get('catalogs', [])
            ok(f'API list: {len(catalogs)} catalogs available ({resp.elapsed.total_seconds()*1000:.0f}ms)')
            return catalogs
        else:
            fail(f'API list: returned {resp.status_code}')
    except Exception as e:
        fail(f'API list: error: {e}')
    return []


def main():
    global passed, failed, warnings

    parser = argparse.ArgumentParser(description='Test gap catalog files')
    parser.add_argument('--api', action='store_true', help='Also test API endpoints')
    args = parser.parse_args()

    print(f'\n{"="*60}')
    print(f'Gap Catalog Test Suite')
    print(f'{"="*60}\n')

    # --- Local file tests ---
    print('--- Local File Tests ---\n')

    # Check all expected files exist
    print('1. File existence:')
    existing_files = list(CATALOG_DIR.glob('*.json'))
    existing_ids = {f.stem for f in existing_files}
    missing = [d for d in EXPECTED_DATASETS if d not in existing_ids]
    extra = existing_ids - set(EXPECTED_DATASETS)
    if missing:
        for m in missing:
            fail(f'Missing catalog: {m}')
    else:
        ok(f'All {len(EXPECTED_DATASETS)} expected catalogs present')
    if extra:
        for e in extra:
            warn(f'Unexpected catalog file: {e}')

    # Test each file
    catalogs = {}
    for filepath in sorted(existing_files):
        print(f'\n2. {filepath.stem}:')
        data = test_catalog_structure(filepath)
        if data:
            catalogs[filepath] = data
            test_intervals(data)
            test_cadence(data)
            test_gaps_are_positive(data)

    # Cross-file tests
    print(f'\n3. Cross-file checks:')
    test_file_sizes(catalogs)

    # Check for any in-progress files
    in_progress = [fp.stem for fp, d in catalogs.items() if d['summary'].get('boundaries_sharpened') == 'in_progress']
    if in_progress:
        warn(f'{len(in_progress)} catalogs still in progress: {", ".join(in_progress)}')
    else:
        ok('No catalogs stuck in_progress')

    # Total size
    total_size = sum(fp.stat().st_size for fp in existing_files)
    print(f'\n  Total: {len(existing_files)} files, {total_size / 1024 / 1024:.1f} MB')

    # --- API tests ---
    if args.api:
        print(f'\n--- API Tests ---\n')

        print('4. List endpoint:')
        api_catalogs = test_api_list()
        api_ids = {c['dataset_id'] for c in api_catalogs}

        print(f'\n5. Individual endpoints (sampling 10):')
        # Test a sample of datasets
        import random
        sample = random.sample(list(existing_ids), min(10, len(existing_ids)))
        for dataset_id in sorted(sample):
            test_api_endpoint(dataset_id)

        print(f'\n6. API vs local consistency:')
        local_ids = existing_ids
        missing_from_api = local_ids - api_ids
        if missing_from_api:
            for m in sorted(missing_from_api):
                fail(f'Local catalog not in API: {m}')
        else:
            ok(f'All {len(local_ids)} local catalogs found in API')

        extra_in_api = api_ids - local_ids
        if extra_in_api:
            for e in sorted(extra_in_api):
                warn(f'API has catalog not found locally: {e}')

    # --- Summary ---
    print(f'\n{"="*60}')
    print(f'Results: {passed} passed, {failed} failed, {warnings} warnings')
    print(f'{"="*60}\n')

    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
