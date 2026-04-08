#!/usr/bin/env python3
"""
Compare CDF vs Text for PSP MAG RTN at full cadence (~293 Hz).
Tests: 1min, 10min, 15min, 30min, 1h, 2h, 6h
"""

import json
import time
import requests

CDAWEB_BASE = "https://cdaweb.gsfc.nasa.gov/WS/cdasr/1"
DATAVIEW = "sp_phys"
DATASET = "PSP_FLD_L2_MAG_RTN"
VARIABLE = "psp_fld_l2_mag_RTN"

# Perihelion pass — high cadence
BASE = "20210429T0800"

DURATIONS = [
    ("1 min",   "20210429T080000Z", "20210429T080100Z"),
    ("10 min",  "20210429T080000Z", "20210429T081000Z"),
    ("15 min",  "20210429T080000Z", "20210429T081500Z"),
    ("30 min",  "20210429T080000Z", "20210429T083000Z"),
    ("1 hour",  "20210429T080000Z", "20210429T090000Z"),
    ("2 hours", "20210429T080000Z", "20210429T100000Z"),
    ("6 hours", "20210429T080000Z", "20210429T140000Z"),
]

results = []

for label, start, end in DURATIONS:
    row = {"duration": label}

    for fmt in ["cdf", "text"]:
        api_url = (
            f"{CDAWEB_BASE}/dataviews/{DATAVIEW}/datasets/{DATASET}"
            f"/data/{start},{end}/{VARIABLE}?format={fmt}"
        )

        print(f"\n--- {label} / {fmt} ---")
        print(f"  URL: {api_url}")

        try:
            t0 = time.time()
            resp = requests.get(api_url, headers={"Accept": "application/json"}, timeout=300)
            api_time = time.time() - t0

            if resp.status_code != 200:
                print(f"  HTTP {resp.status_code}")
                row[f"{fmt}_size"] = f"HTTP {resp.status_code}"
                row[f"{fmt}_time"] = api_time
                continue

            meta = resp.json()
            files = meta.get("FileDescription", [])

            if not files:
                # Maybe inline (like JSON was)
                size = len(resp.content)
                row[f"{fmt}_size"] = size
                row[f"{fmt}_time"] = api_time
                print(f"  Inline response: {size:,} bytes in {api_time:.1f}s")
                continue

            file_url = files[0]["Name"]
            reported_size = files[0].get("Length", 0)

            t1 = time.time()
            dl = requests.get(file_url, timeout=600)
            dl_time = time.time() - t1
            dl.raise_for_status()

            actual_size = len(dl.content)
            total_time = api_time + dl_time

            row[f"{fmt}_size"] = actual_size
            row[f"{fmt}_time"] = total_time
            print(f"  {actual_size:,} bytes ({actual_size/1024/1024:.2f} MB) in {total_time:.1f}s (api {api_time:.1f}s + dl {dl_time:.1f}s)")

        except Exception as e:
            print(f"  ERROR: {e}")
            row[f"{fmt}_size"] = f"ERROR: {e}"
            row[f"{fmt}_time"] = None

    results.append(row)

# Print summary table
print(f"\n{'='*80}")
print(f"PSP MAG RTN Full Cadence (~293 Hz) — CDF vs Text")
print(f"{'='*80}")
print(f"{'Duration':<10} {'CDF Size':>14} {'CDF Time':>10} {'Text Size':>14} {'Text Time':>10} {'Ratio':>8}")
print(f"{'-'*10} {'-'*14} {'-'*10} {'-'*14} {'-'*10} {'-'*8}")

for r in results:
    cdf_s = r.get("cdf_size", "?")
    txt_s = r.get("text_size", "?")
    cdf_t = r.get("cdf_time")
    txt_t = r.get("text_time")

    if isinstance(cdf_s, int):
        cdf_str = f"{cdf_s/1024/1024:.2f} MB"
    else:
        cdf_str = str(cdf_s)

    if isinstance(txt_s, int):
        txt_str = f"{txt_s/1024/1024:.2f} MB"
    else:
        txt_str = str(txt_s)

    cdf_t_str = f"{cdf_t:.1f}s" if cdf_t else "?"
    txt_t_str = f"{txt_t:.1f}s" if txt_t else "?"

    if isinstance(cdf_s, int) and isinstance(txt_s, int) and cdf_s > 0:
        ratio = f"{txt_s/cdf_s:.2f}x"
    else:
        ratio = "?"

    print(f"{r['duration']:<10} {cdf_str:>14} {cdf_t_str:>10} {txt_str:>14} {txt_t_str:>10} {ratio:>8}")
