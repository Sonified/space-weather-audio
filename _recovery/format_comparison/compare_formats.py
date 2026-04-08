#!/usr/bin/env python3
"""
Compare CDAWeb download formats: CDF vs Text vs JSON
Uses 1 hour of GOES-16 mag data as test case.
"""

import os
import time
import requests

CDAWEB_BASE = "https://cdaweb.gsfc.nasa.gov/WS/cdasr/1"
DATAVIEW = "sp_phys"
DATASET = "DN_MAGN-L2-HIRES_G16"
VARIABLE = "b_gse"

# 1 hour of data
START = "20220121T000000Z"
END = "20220121T010000Z"

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

FORMATS = ["cdf", "text", "json"]

for fmt in FORMATS:
    api_url = (
        f"{CDAWEB_BASE}/dataviews/{DATAVIEW}/datasets/{DATASET}"
        f"/data/{START},{END}/{VARIABLE}?format={fmt}"
    )

    print(f"\n{'='*60}")
    print(f"Format: {fmt}")
    print(f"URL: {api_url}")
    print(f"{'='*60}")

    # Step 1: Get the metadata/file listing
    t0 = time.time()
    resp = requests.get(api_url, headers={"Accept": "application/json"}, timeout=120)
    api_time = time.time() - t0

    print(f"  API response: {resp.status_code} ({api_time:.2f}s)")

    if resp.status_code != 200:
        print(f"  ERROR: {resp.text[:500]}")
        continue

    result = resp.json()
    files = result.get("FileDescription", [])

    if not files:
        print(f"  No files returned!")
        print(f"  Response keys: {list(result.keys())}")
        # Maybe the data is inline for text/json?
        out_path = os.path.join(OUT_DIR, f"response_{fmt}.json")
        with open(out_path, "w") as f:
            import json
            json.dump(result, f, indent=2)
        resp_size = len(resp.content)
        print(f"  Raw response size: {resp_size:,} bytes ({resp_size/1024:.1f} KB)")
        print(f"  Saved response to {out_path}")
        continue

    print(f"  Files returned: {len(files)}")
    for i, fd in enumerate(files):
        file_url = fd["Name"]
        file_size = fd.get("Length", "unknown")
        file_type = fd.get("MimeType", fd.get("Type", "unknown"))
        print(f"  [{i}] Size: {file_size} bytes, Type: {file_type}")
        print(f"      URL: {file_url}")

        # Download the actual file
        t1 = time.time()
        dl_resp = requests.get(file_url, timeout=300)
        dl_time = time.time() - t1
        dl_resp.raise_for_status()

        actual_size = len(dl_resp.content)
        ext = fmt if fmt != "text" else "txt"
        out_path = os.path.join(OUT_DIR, f"goes16_1h_{fmt}.{ext}")
        with open(out_path, "wb") as f:
            f.write(dl_resp.content)

        print(f"  Downloaded: {actual_size:,} bytes ({actual_size/1024:.1f} KB) in {dl_time:.2f}s")
        print(f"  Saved to: {out_path}")

    total_time = time.time() - t0
    print(f"  Total time (API + download): {total_time:.2f}s")

print(f"\n{'='*60}")
print("Summary - files in {OUT_DIR}:")
print(f"{'='*60}")
for f in sorted(os.listdir(OUT_DIR)):
    if f.startswith("goes16") or f.startswith("response"):
        path = os.path.join(OUT_DIR, f)
        size = os.path.getsize(path)
        print(f"  {f}: {size:,} bytes ({size/1024:.1f} KB)")
