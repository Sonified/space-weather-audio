#!/usr/bin/env python3
"""
Audify CDAWeb text-format magnetometer data.

Parses the #-prefixed header, auto-detects numeric columns,
normalizes each to [-1, 1], and writes one WAV per column
plus an optional multichannel WAV.

Usage:
    python audify_text.py goes16_1h_text.txt
    python audify_text.py goes16_1h_text.txt --sample-rate 44100 --speed 100
    python audify_text.py goes16_1h_text.txt --columns X_GSE Z_GSE
"""

import argparse
import struct
import sys
import os
import re
from pathlib import Path


def parse_text_file(filepath):
    """Parse CDAWeb text format. Returns (column_names, data_columns)."""
    lines = Path(filepath).read_text().splitlines()

    # Skip # comment lines
    data_start = 0
    for i, line in enumerate(lines):
        if not line.startswith('#') and line.strip():
            data_start = i
            break

    # Line at data_start = column headers (UT, X_GSE, Y_GSE, Z_GSE, ...)
    header_line = lines[data_start]
    col_names = header_line.split()

    # Non-timestamp column names (skip UT / time-like headers)
    numeric_names = [n for n in col_names if n.upper() not in ('UT', 'TIME', 'EPOCH', 'DATE')]

    # Skip sub-header lines (units, labels) until we hit actual data
    # Data lines start with a date like dd-mm-yyyy
    row_start = data_start + 1
    date_pattern = re.compile(r'^\d{2}-\d{2}-\d{4}')
    for i in range(data_start + 1, len(lines)):
        if date_pattern.match(lines[i].strip()):
            row_start = i
            break

    # Parse: extract all floats from each row, map to numeric column names
    # Timestamp tokens (dd-mm-yyyy, hh:mm:ss.ms) won't parse as plain floats
    columns = {name: [] for name in numeric_names}

    for i in range(row_start, len(lines)):
        line = lines[i].strip()
        if not line:
            continue
        parts = line.split()
        floats = []
        for p in parts:
            try:
                floats.append(float(p))
            except ValueError:
                continue
        if len(floats) >= len(numeric_names):
            for name, val in zip(numeric_names, floats):
                columns[name].append(val)

    return numeric_names, columns


def normalize(data):
    """Normalize to [-1, 1] range."""
    mn, mx = min(data), max(data)
    rng = mx - mn
    if rng == 0:
        return [0.0] * len(data)
    return [(2.0 * (v - mn) / rng - 1.0) for v in data]


def resample_linear(data, factor):
    """Upsample by integer factor with linear interpolation."""
    if factor <= 1:
        return data
    out = []
    for i in range(len(data) - 1):
        out.append(data[i])
        for k in range(1, factor):
            t = k / factor
            out.append(data[i] * (1 - t) + data[i + 1] * t)
    out.append(data[-1])
    return out


def write_wav(filepath, channels, sample_rate):
    """Write a WAV file. channels = list of float arrays [-1, 1]."""
    n_channels = len(channels)
    n_samples = len(channels[0])
    bits_per_sample = 16
    max_val = 32767

    # Interleave
    raw = bytearray()
    for i in range(n_samples):
        for ch in channels:
            sample = int(ch[i] * max_val)
            sample = max(-32768, min(32767, sample))
            raw += struct.pack('<h', sample)

    data_size = len(raw)
    fmt_size = 16
    file_size = 4 + (8 + fmt_size) + (8 + data_size)

    with open(filepath, 'wb') as f:
        # RIFF header
        f.write(b'RIFF')
        f.write(struct.pack('<I', file_size))
        f.write(b'WAVE')
        # fmt chunk
        f.write(b'fmt ')
        f.write(struct.pack('<I', fmt_size))
        f.write(struct.pack('<H', 1))  # PCM
        f.write(struct.pack('<H', n_channels))
        f.write(struct.pack('<I', sample_rate))
        byte_rate = sample_rate * n_channels * (bits_per_sample // 8)
        block_align = n_channels * (bits_per_sample // 8)
        f.write(struct.pack('<I', byte_rate))
        f.write(struct.pack('<H', block_align))
        f.write(struct.pack('<H', bits_per_sample))
        # data chunk
        f.write(b'data')
        f.write(struct.pack('<I', data_size))
        f.write(raw)


def main():
    parser = argparse.ArgumentParser(description='Audify CDAWeb text magnetometer data')
    parser.add_argument('input', help='Path to text file')
    parser.add_argument('--sample-rate', '-r', type=int, default=44100,
                        help='Output WAV sample rate (default: 44100)')
    parser.add_argument('--speed', '-s', type=int, default=1,
                        help='Speed-up factor: how many data samples per audio sample. '
                             '1 = one data sample per audio sample (default). '
                             '10 = 10x compression. At 10Hz native, speed=1 gives 36k samples → 0.8s @ 44100Hz.')
    parser.add_argument('--columns', '-c', nargs='+', default=None,
                        help='Which columns to audify (default: all numeric)')
    parser.add_argument('--multi', '-m', action='store_true',
                        help='Also write a multichannel WAV with all selected columns')
    parser.add_argument('--output-dir', '-o', default=None,
                        help='Output directory (default: same as input file)')
    args = parser.parse_args()

    print(f"Parsing {args.input}...")
    col_names, columns = parse_text_file(args.input)
    print(f"Found {len(col_names)} numeric columns: {', '.join(col_names)}")
    print(f"Samples per column: {len(columns[col_names[0]]):,}")

    # Filter columns if requested
    selected = args.columns if args.columns else col_names
    for name in selected:
        if name not in columns:
            print(f"Error: column '{name}' not found. Available: {', '.join(col_names)}")
            sys.exit(1)

    out_dir = Path(args.output_dir) if args.output_dir else Path(args.input).parent
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = Path(args.input).stem

    # Compute resample factor: we want (native_samples / speed) audio samples
    # Then upsample to fill the sample rate nicely
    native_count = len(columns[selected[0]])
    compressed_count = max(1, native_count // args.speed)

    # Downsample by taking every Nth sample (simple decimation)
    # For better quality at low speed factors, we average windows instead
    def downsample(data, factor):
        if factor <= 1:
            return data
        out = []
        for i in range(0, len(data) - factor + 1, factor):
            window = data[i:i + factor]
            out.append(sum(window) / len(window))
        return out

    duration = compressed_count / args.sample_rate
    print(f"\nSpeed factor: {args.speed}x → {compressed_count:,} audio samples → {duration:.2f}s @ {args.sample_rate} Hz")

    # Process each column
    processed = {}
    for name in selected:
        raw = columns[name]
        decimated = downsample(raw, args.speed)
        normed = normalize(decimated)
        processed[name] = normed

        # Write individual WAV
        outpath = out_dir / f"{stem}_{name}.wav"
        write_wav(str(outpath), [normed], args.sample_rate)
        print(f"  → {outpath.name}  ({len(normed):,} samples, {len(normed)/args.sample_rate:.2f}s)")

    # Multichannel WAV
    if args.multi and len(selected) > 1:
        multi_path = out_dir / f"{stem}_all.wav"
        ch_data = [processed[name] for name in selected]
        # Ensure same length
        min_len = min(len(c) for c in ch_data)
        ch_data = [c[:min_len] for c in ch_data]
        write_wav(str(multi_path), ch_data, args.sample_rate)
        print(f"  → {multi_path.name}  ({len(selected)}-channel, {min_len:,} samples)")

    print("\nDone!")


if __name__ == '__main__':
    main()
