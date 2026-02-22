#!/usr/bin/env python3
"""
GOES Magnetometer Data → R2 Pipeline

Downloads GOES mag data from CDAWeb (CDF format), splits into chunks
(10m, 1h, 6h), zstd-compresses each component separately, and uploads
to Cloudflare R2 for progressive streaming.

Usage:
    python goes_to_r2.py 2022-01-21
    python goes_to_r2.py 2022-01-21 2022-01-27
    python goes_to_r2.py 2022-01-21 --dataset DN_MAGN-L2-HIRES_G19
    python goes_to_r2.py 2022-01-21 --dry-run
"""

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import boto3
import cdflib
import numpy as np
import requests
import zstandard as zstd
from dotenv import load_dotenv

load_dotenv()  # Load .env from project root

# =============================================================================
# Configuration
# =============================================================================

CDAWEB_BASE = "https://cdaweb.gsfc.nasa.gov/WS/cdasr/1"
DATAVIEW = "sp_phys"

# R2 credentials — set via .env file or environment variables (never hardcode)
R2_ACCOUNT_ID = os.getenv("R2_ACCOUNT_ID")
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID")
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY")
if not R2_ACCESS_KEY_ID or not R2_SECRET_ACCESS_KEY:
    raise EnvironmentError("R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set. See .env file.")
R2_BUCKET = "emic-data"

# Dataset → satellite name mapping
DATASET_TO_SAT = {
    "DN_MAGN-L2-HIRES_G16": "GOES-16",
    "DN_MAGN-L2-HIRES_G19": "GOES-19",
}

VARIABLE = "b_gse"
COMPONENTS = ["bx", "by", "bz"]  # indices 0, 1, 2 of b_gse
SAMPLE_RATE = 10  # Hz

CHUNK_DEFS = {
    "10m": 10 * 60,    # 600 seconds
    "15m": 15 * 60,    # 900 seconds  (matches pyramid L0 tile size)
    "1h":  60 * 60,    # 3600 seconds
    "6h":  6 * 60 * 60 # 21600 seconds
}

ZSTD_LEVEL = 3


def get_s3_client():
    return boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
    )


# =============================================================================
# CDAWeb Download
# =============================================================================

def download_goes_cdf(dataset, date_str):
    """Download one day of GOES mag data as CDF from CDAWeb."""
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    start = dt.strftime("%Y%m%dT000000Z")
    end = (dt + timedelta(days=1)).strftime("%Y%m%dT000000Z")

    api_url = (
        f"{CDAWEB_BASE}/dataviews/{DATAVIEW}/datasets/{dataset}"
        f"/data/{start},{end}/{VARIABLE}?format=cdf"
    )

    print(f"📡 Requesting CDF from CDAWeb: {dataset} {date_str}")
    resp = requests.get(api_url, headers={"Accept": "application/json"}, timeout=120)
    resp.raise_for_status()

    files = resp.json().get("FileDescription", [])
    if not files:
        print(f"  ❌ No files returned for {date_str}")
        return None

    cdf_url = files[0]["Name"]
    cdf_size = files[0].get("Length", 0)
    print(f"  📥 Downloading CDF ({cdf_size / 1024 / 1024:.1f} MB): {cdf_url}")

    tmp = tempfile.NamedTemporaryFile(suffix=".cdf", delete=False)
    cdf_resp = requests.get(cdf_url, timeout=300)
    cdf_resp.raise_for_status()
    tmp.write(cdf_resp.content)
    tmp.close()
    print(f"  ✅ Downloaded to {tmp.name}")
    return tmp.name


# =============================================================================
# Data Extraction
# =============================================================================

def extract_components(cdf_path):
    """Extract Bx, By, Bz as separate Float32 arrays from CDF file."""
    cdf = cdflib.CDF(cdf_path)
    b_gse = cdf.varget(VARIABLE)  # shape (N, 3), dtype float32

    # Trim to exact day boundary (CDAWeb often includes 1 extra sample at midnight)
    expected_samples = 24 * 3600 * SAMPLE_RATE  # 864,000
    if b_gse.shape[0] > expected_samples:
        print(f"  ✂️  Trimming {b_gse.shape[0]} → {expected_samples} samples (dropping boundary overlap)")
        b_gse = b_gse[:expected_samples]

    print(f"  📊 b_gse shape: {b_gse.shape}, dtype: {b_gse.dtype}")
    print(f"     Samples: {b_gse.shape[0]:,} ({b_gse.shape[0] / SAMPLE_RATE / 3600:.1f} hours at {SAMPLE_RATE} Hz)")

    # Replace fill values (-9999) with NaN, then interpolate
    FILL_VALUE = -9999.0
    fill_mask = b_gse <= FILL_VALUE
    total_fill = np.sum(fill_mask)
    if total_fill > 0:
        b_gse = b_gse.astype(np.float32)  # ensure float for NaN
        b_gse[fill_mask] = np.nan
        fill_pct = total_fill / b_gse.size * 100
        print(f"  🩹 Found {total_fill:,} fill values ({fill_pct:.2f}%) — interpolating")

        # Interpolate each component across the full day before chunking
        for col in range(3):
            series = b_gse[:, col]
            nans = np.isnan(series)
            if np.any(nans) and not np.all(nans):
                valid = np.where(~nans)[0]
                series[nans] = np.interp(np.where(nans)[0], valid, series[valid])
                b_gse[:, col] = series

    components = {}
    for i, name in enumerate(COMPONENTS):
        arr = b_gse[:, i].astype(np.float32)
        components[name] = arr
        print(f"     {name}: min={arr.min():.2f}, max={arr.max():.2f}")

    return components


# =============================================================================
# Chunking & Compression
# =============================================================================

def chunk_and_compress(components, date_str):
    """
    Split each component into 10m/1h/6h chunks, compress with zstd.

    Returns:
        dict: {component: {chunk_type: [{"start", "end", "min", "max", "samples", "data"}, ...]}}
    """
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    total_samples = len(next(iter(components.values())))
    compressor = zstd.ZstdCompressor(level=ZSTD_LEVEL)

    results = {}

    for comp_name, arr in components.items():
        results[comp_name] = {}

        for chunk_type, chunk_seconds in CHUNK_DEFS.items():
            chunk_samples = chunk_seconds * SAMPLE_RATE
            chunks = []
            offset = 0
            chunk_start_time = dt

            while offset < total_samples:
                end_sample = min(offset + chunk_samples, total_samples)
                chunk_data = arr[offset:end_sample]
                chunk_end_time = chunk_start_time + timedelta(seconds=(end_sample - offset) / SAMPLE_RATE)

                compressed = compressor.compress(chunk_data.tobytes())

                chunks.append({
                    "start": chunk_start_time.strftime("%H:%M:%S"),
                    "end": chunk_end_time.strftime("%H:%M:%S"),
                    "min": float(np.min(chunk_data)),
                    "max": float(np.max(chunk_data)),
                    "samples": len(chunk_data),
                    "compressed_size": len(compressed),
                    "data": compressed,
                })

                offset = end_sample
                chunk_start_time = chunk_end_time

            results[comp_name][chunk_type] = chunks
            total_compressed = sum(c["compressed_size"] for c in chunks)
            print(f"  🗜️  {comp_name}/{chunk_type}: {len(chunks)} chunks, {total_compressed / 1024:.0f} KB total compressed")

    return results


# =============================================================================
# R2 Upload
# =============================================================================

def upload_to_r2(results, date_str, satellite, dataset, dry_run=False):
    """Upload compressed chunks and metadata to R2."""
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    year = dt.strftime("%Y")
    month = dt.strftime("%m")
    day = dt.strftime("%d")

    s3 = None if dry_run else get_s3_client()
    uploaded_count = 0
    total_bytes = 0

    for comp_name, chunk_types in results.items():
        # Build metadata for this component
        metadata = {
            "satellite": satellite,
            "dataset": dataset,
            "date": date_str,
            "component": comp_name,
            "variable": VARIABLE,
            "sample_rate": SAMPLE_RATE,
            "dtype": "float32",
            "chunks": {},
            "complete_day": False,
        }

        for chunk_type, chunks in chunk_types.items():
            metadata["chunks"][chunk_type] = []

            for chunk in chunks:
                # Filename
                start_str = chunk["start"].replace(":", "-")
                end_str = chunk["end"].replace(":", "-")
                filename = f"{satellite}_mag_{comp_name}_{chunk_type}_{date_str}-{start_str}_to_{date_str}-{end_str}.bin.zst"

                # R2 key
                r2_key = f"data/{year}/{month}/{day}/{satellite}/mag/{comp_name}/{chunk_type}/{filename}"

                if dry_run:
                    print(f"  [DRY RUN] Would upload: {r2_key} ({chunk['compressed_size']} bytes)")
                else:
                    s3.put_object(
                        Bucket=R2_BUCKET,
                        Key=r2_key,
                        Body=chunk["data"],
                        ContentType="application/octet-stream",
                    )
                    uploaded_count += 1
                    total_bytes += chunk["compressed_size"]

                # Add to metadata (without the binary data)
                metadata["chunks"][chunk_type].append({
                    "start": chunk["start"],
                    "end": chunk["end"],
                    "min": chunk["min"],
                    "max": chunk["max"],
                    "samples": chunk["samples"],
                    "compressed_size": chunk["compressed_size"],
                    "filename": filename,
                })

        # Check completeness
        if len(metadata["chunks"].get("10m", [])) >= 144:
            metadata["complete_day"] = True

        # Upload metadata
        metadata_key = f"data/{year}/{month}/{day}/{satellite}/mag/{comp_name}/metadata.json"
        metadata_json = json.dumps(metadata, indent=2)

        if dry_run:
            print(f"  [DRY RUN] Would upload metadata: {metadata_key}")
        else:
            s3.put_object(
                Bucket=R2_BUCKET,
                Key=metadata_key,
                Body=metadata_json.encode("utf-8"),
                ContentType="application/json",
            )
            uploaded_count += 1

    if not dry_run:
        print(f"\n✅ Uploaded {uploaded_count} files ({total_bytes / 1024 / 1024:.2f} MB) to R2 bucket '{R2_BUCKET}'")


# =============================================================================
# Main
# =============================================================================

def process_day(date_str, dataset, dry_run=False):
    """Full pipeline for one day."""
    satellite = DATASET_TO_SAT.get(dataset, dataset)
    print(f"\n{'='*60}")
    print(f"Processing {satellite} {date_str}")
    print(f"{'='*60}")

    # Download CDF
    cdf_path = download_goes_cdf(dataset, date_str)
    if not cdf_path:
        return False

    try:
        # Extract components
        components = extract_components(cdf_path)

        # Chunk and compress
        results = chunk_and_compress(components, date_str)

        # Upload
        upload_to_r2(results, date_str, satellite, dataset, dry_run=dry_run)

        return True
    finally:
        # Clean up temp file
        os.unlink(cdf_path)


def main():
    parser = argparse.ArgumentParser(description="Download GOES mag data and upload to R2")
    parser.add_argument("start_date", help="Start date (YYYY-MM-DD)")
    parser.add_argument("end_date", nargs="?", help="End date (YYYY-MM-DD), defaults to start_date")
    parser.add_argument("--dataset", default="DN_MAGN-L2-HIRES_G16", help="CDAWeb dataset ID")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be uploaded without uploading")
    args = parser.parse_args()

    end_date = args.end_date or args.start_date
    start = datetime.strptime(args.start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")

    current = start
    success_count = 0
    fail_count = 0

    while current <= end:
        date_str = current.strftime("%Y-%m-%d")
        try:
            if process_day(date_str, args.dataset, dry_run=args.dry_run):
                success_count += 1
            else:
                fail_count += 1
        except Exception as e:
            print(f"  ❌ Failed: {e}")
            import traceback
            traceback.print_exc()
            fail_count += 1

        current += timedelta(days=1)

    print(f"\n{'='*60}")
    print(f"Done! {success_count} days succeeded, {fail_count} failed")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
