#!/usr/bin/env python3
"""
Inventory Precision Test
=========================
Compares CDAWeb inventory endpoint boundaries against actual CDF epoch timestamps.
Question: Does the inventory tell us EXACTLY where samples start and end?

Tests:
1. Query inventory for a time range with known gaps
2. Load the CDF for the same range
3. Compare inventory Start/End to first/last epoch timestamps in each data block
4. Report precision (ms, samples)
"""

import cdflib
import numpy as np
import subprocess
import json
import sys
from datetime import datetime, timezone

CDAWEB_BASE = "https://cdaweb.gsfc.nasa.gov/WS/cdasr/1"
DATASET = "PSP_FLD_L2_MAG_RTN"
EPOCH_VAR = "epoch_mag_RTN"
MAG_VAR = "psp_fld_l2_mag_RTN"

def query_inventory(dataset, start, end):
    """Query CDAWeb inventory endpoint."""
    url = f"{CDAWEB_BASE}/dataviews/sp_phys/datasets/{dataset}/inventory/{start},{end}"
    cmd = ["curl", "-s", "-H", "Accept: application/json", url]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    data = json.loads(result.stdout)

    intervals = []
    if "InventoryDescription" in data:
        for item in data["InventoryDescription"]:
            for interval in item.get("TimeInterval", []):
                intervals.append({
                    "start": interval["Start"],
                    "end": interval["End"],
                })
    return intervals

def iso_to_epoch_ms(iso_str):
    """Convert ISO string to milliseconds since epoch (for comparison)."""
    # Handle CDAWeb format: "2020-01-01T00:00:00.000Z"
    dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
    return dt.timestamp() * 1000

def tt2000_to_unix_ms(tt2000_ns):
    """Convert TT2000 nanoseconds to Unix milliseconds (approximate, for comparison)."""
    # TT2000 epoch: 2000-01-01T12:00:00 TT
    # Offset from Unix epoch: 946728069.184 seconds (including leap seconds ~69.184s)
    # But cdflib can convert for us
    dt = cdflib.cdfepoch.to_datetime(np.array([tt2000_ns]))[0]
    # numpy datetime64 to unix ms
    return dt.astype('datetime64[ms]').astype(np.int64)

def load_cdf_epochs(cdf_path):
    """Load epoch array from CDF."""
    cdf = cdflib.CDF(cdf_path)
    return cdf.varget(EPOCH_VAR)

def detect_data_blocks(epoch, threshold_factor=2.0):
    """Split epoch array into contiguous blocks based on cadence gaps."""
    if len(epoch) < 2:
        return [(0, len(epoch) - 1)]

    diffs = np.diff(epoch)
    median_dt = np.median(diffs)
    threshold = median_dt * threshold_factor

    blocks = []
    block_start = 0
    for i in range(len(diffs)):
        if diffs[i] > threshold:
            blocks.append((block_start, i))
            block_start = i + 1
    blocks.append((block_start, len(epoch) - 1))

    return blocks

def format_tt2000(tt2000_ns):
    """Format TT2000 to readable string."""
    dt = cdflib.cdfepoch.to_datetime(np.array([tt2000_ns]))[0]
    return str(dt.astype('datetime64[ms]'))

def main():
    print("=" * 80)
    print("INVENTORY PRECISION TEST")
    print("=" * 80)

    # =========================================================================
    # Test 1: PSP Jan 1, 2020 — full day (known: data 00:00-02:03, gap, 10:53-11:23)
    # =========================================================================
    print("\n" + "=" * 80)
    print("TEST 1: PSP MAG RTN — Jan 1, 2020 (full day)")
    print("=" * 80)

    inv = query_inventory(DATASET, "20200101T000000Z", "20200102T000000Z")
    print(f"\nInventory returned {len(inv)} intervals:")
    for i, interval in enumerate(inv):
        print(f"  [{i}] {interval['start']} → {interval['end']}")

    # Load the CDF that covers 00:00-03:00 (has the first data block)
    cdf_path = "/Users/robertalexander/GitHub/space-weather-audio/tools/gap_test_wavs/psp_mag_rtn__20200101_0000-0300.cdf"
    epoch = load_cdf_epochs(cdf_path)
    blocks = detect_data_blocks(epoch)

    print(f"\nCDF '{cdf_path.split('/')[-1]}':")
    print(f"  Total records: {len(epoch)}")
    print(f"  Data blocks: {len(blocks)}")

    for i, (start_idx, end_idx) in enumerate(blocks):
        first_epoch = epoch[start_idx]
        last_epoch = epoch[end_idx]
        n_samples = end_idx - start_idx + 1

        # Cadence within block
        if n_samples > 1:
            block_diffs = np.diff(epoch[start_idx:end_idx+1])
            cadence_ms = np.median(block_diffs) / 1e6
        else:
            cadence_ms = 0

        print(f"\n  Block {i}: indices [{start_idx}:{end_idx}], {n_samples} samples")
        print(f"    CDF first: {format_tt2000(first_epoch)}")
        print(f"    CDF last:  {format_tt2000(last_epoch)}")
        print(f"    Cadence:   {cadence_ms:.3f} ms ({1000/cadence_ms:.2f} Hz)" if cadence_ms > 0 else "")

        # Compare to inventory
        if i < len(inv):
            inv_start_ms = iso_to_epoch_ms(inv[i]['start'])
            inv_end_ms = iso_to_epoch_ms(inv[i]['end'])
            cdf_start_ms = tt2000_to_unix_ms(first_epoch)
            cdf_end_ms = tt2000_to_unix_ms(last_epoch)

            start_diff_ms = cdf_start_ms - inv_start_ms
            end_diff_ms = cdf_end_ms - inv_end_ms

            start_diff_samples = abs(start_diff_ms) / cadence_ms if cadence_ms > 0 else 0
            end_diff_samples = abs(end_diff_ms) / cadence_ms if cadence_ms > 0 else 0

            print(f"    Inventory:  {inv[i]['start']} → {inv[i]['end']}")
            print(f"    ──────────────────────────────────────────────")
            print(f"    Start diff: {start_diff_ms:+.3f} ms ({start_diff_samples:.1f} samples)")
            print(f"    End diff:   {end_diff_ms:+.3f} ms ({end_diff_samples:.1f} samples)")

            if abs(start_diff_ms) < cadence_ms and abs(end_diff_ms) < cadence_ms:
                print(f"    ✅ PRECISE (within 1 sample)")
            elif abs(start_diff_ms) < 1000 and abs(end_diff_ms) < 1000:
                print(f"    ⚠️  CLOSE (within 1 second)")
            else:
                print(f"    ❌ IMPRECISE (>{max(abs(start_diff_ms), abs(end_diff_ms))/1000:.1f}s off)")

    # =========================================================================
    # Test 2: Load the 09:00-12:00 CDF (gap region)
    # =========================================================================
    print("\n\n" + "=" * 80)
    print("TEST 2: PSP MAG RTN — 09:00-12:00 (gap then data then gap)")
    print("=" * 80)

    cdf_path2 = "/Users/robertalexander/GitHub/space-weather-audio/tools/gap_test_wavs/psp_mag_rtn__20200101_0900-1200.cdf"
    epoch2 = load_cdf_epochs(cdf_path2)
    blocks2 = detect_data_blocks(epoch2)

    print(f"\nCDF '{cdf_path2.split('/')[-1]}':")
    print(f"  Total records: {len(epoch2)}")
    print(f"  Data blocks: {len(blocks2)}")

    for i, (start_idx, end_idx) in enumerate(blocks2):
        first_epoch = epoch2[start_idx]
        last_epoch = epoch2[end_idx]
        n_samples = end_idx - start_idx + 1

        if n_samples > 1:
            block_diffs = np.diff(epoch2[start_idx:end_idx+1])
            cadence_ms = np.median(block_diffs) / 1e6
        else:
            cadence_ms = 0

        print(f"\n  Block {i}: {n_samples} samples")
        print(f"    CDF first: {format_tt2000(first_epoch)}")
        print(f"    CDF last:  {format_tt2000(last_epoch)}")
        print(f"    Cadence:   {cadence_ms:.3f} ms ({1000/cadence_ms:.2f} Hz)" if cadence_ms > 0 else "")

    # Which inventory interval covers this?
    # The second interval should cover 10:53-11:23
    print(f"\n  Matching inventory interval:")
    for interval in inv:
        inv_start = interval['start']
        inv_end = interval['end']
        # Check if this interval overlaps with our CDF data
        cdf_start_ms = tt2000_to_unix_ms(epoch2[0])
        cdf_end_ms = tt2000_to_unix_ms(epoch2[-1])
        inv_start_ms = iso_to_epoch_ms(inv_start)
        inv_end_ms = iso_to_epoch_ms(inv_end)

        if inv_end_ms >= cdf_start_ms and inv_start_ms <= cdf_end_ms:
            block_diffs = np.diff(epoch2)
            cadence_ms = np.median(block_diffs) / 1e6

            start_diff = tt2000_to_unix_ms(epoch2[0]) - inv_start_ms
            end_diff = tt2000_to_unix_ms(epoch2[-1]) - inv_end_ms

            print(f"    Inventory: {inv_start} → {inv_end}")
            print(f"    CDF data:  {format_tt2000(epoch2[0])} → {format_tt2000(epoch2[-1])}")
            print(f"    Start diff: {start_diff:+.3f} ms ({abs(start_diff)/cadence_ms:.1f} samples)")
            print(f"    End diff:   {end_diff:+.3f} ms ({abs(end_diff)/cadence_ms:.1f} samples)")

    # =========================================================================
    # Test 3: Multiple CDFs on different dates
    # =========================================================================
    print("\n\n" + "=" * 80)
    print("TEST 3: Cross-date verification")
    print("=" * 80)

    test_cases = [
        {
            "cdf": "psp_mag_rtn__20200102_0241-0453.cdf",
            "inv_start": "20200102T000000Z",
            "inv_end": "20200103T000000Z",
            "label": "Jan 2, 2020"
        },
        {
            "cdf": "psp_mag_rtn__20200116_0203-0303.cdf",
            "inv_start": "20200116T000000Z",
            "inv_end": "20200117T000000Z",
            "label": "Jan 16, 2020"
        },
        {
            "cdf": "psp_mag_rtn__20200129_1900-2000.cdf",
            "inv_start": "20200129T000000Z",
            "inv_end": "20200130T000000Z",
            "label": "Jan 29, 2020 (near perihelion E4)"
        },
    ]

    for tc in test_cases:
        print(f"\n--- {tc['label']} ---")
        cdf_path = f"/Users/robertalexander/GitHub/space-weather-audio/tools/gap_test_wavs/{tc['cdf']}"

        try:
            epoch_tc = load_cdf_epochs(cdf_path)
        except Exception as e:
            print(f"  Error loading CDF: {e}")
            continue

        blocks_tc = detect_data_blocks(epoch_tc)
        inv_tc = query_inventory(DATASET, tc['inv_start'], tc['inv_end'])

        print(f"  CDF: {len(epoch_tc)} records, {len(blocks_tc)} blocks")
        print(f"  Inventory: {len(inv_tc)} intervals")

        for i, (start_idx, end_idx) in enumerate(blocks_tc):
            n = end_idx - start_idx + 1
            if n > 1:
                cadence_ms = np.median(np.diff(epoch_tc[start_idx:end_idx+1])) / 1e6
            else:
                continue

            cdf_start = format_tt2000(epoch_tc[start_idx])
            cdf_end = format_tt2000(epoch_tc[end_idx])

            # Find matching inventory interval
            cdf_start_ms = tt2000_to_unix_ms(epoch_tc[start_idx])
            cdf_end_ms = tt2000_to_unix_ms(epoch_tc[end_idx])

            matched = False
            for inv_interval in inv_tc:
                ims = iso_to_epoch_ms(inv_interval['start'])
                ime = iso_to_epoch_ms(inv_interval['end'])

                # Check overlap
                if ime >= cdf_start_ms - 60000 and ims <= cdf_end_ms + 60000:
                    sd = cdf_start_ms - ims
                    ed = cdf_end_ms - ime

                    start_samples = abs(sd) / cadence_ms
                    end_samples = abs(ed) / cadence_ms

                    status = "✅" if start_samples < 2 and end_samples < 2 else "⚠️" if start_samples < 10 and end_samples < 10 else "❌"

                    print(f"  Block {i}: {n} samples, {cadence_ms:.3f}ms cadence")
                    print(f"    CDF:  {cdf_start} → {cdf_end}")
                    print(f"    Inv:  {inv_interval['start']} → {inv_interval['end']}")
                    print(f"    Diff: start={sd:+.0f}ms ({start_samples:.1f} samp), end={ed:+.0f}ms ({end_samples:.1f} samp) {status}")
                    matched = True
                    break

            if not matched:
                print(f"  Block {i}: {n} samples — NO matching inventory interval!")

    # =========================================================================
    # Test 4: Non-PSP dataset — GOES-16 (continuous, should be trivial)
    # =========================================================================
    print("\n\n" + "=" * 80)
    print("TEST 4: GOES-16 MAG (continuous dataset — baseline)")
    print("=" * 80)

    goes_inv = query_inventory("DN_MAGN-L2-HIRES_G16", "20220101T000000Z", "20220101T060000Z")
    print(f"  Inventory: {len(goes_inv)} intervals")
    for interval in goes_inv:
        print(f"    {interval['start']} → {interval['end']}")

    # =========================================================================
    # Summary
    # =========================================================================
    print("\n\n" + "=" * 80)
    print("SUMMARY")
    print("=" * 80)
    print("""
The key question: Can we use inventory boundaries to precisely reconstruct
gap positions in concatenated audio?

If inventory boundaries are within ~1 sample of CDF epoch boundaries,
we can count exactly how many samples belong to each interval and
insert exact silence for gaps.

If they're off by seconds or more, we'd need a different approach.
""")


if __name__ == "__main__":
    main()
