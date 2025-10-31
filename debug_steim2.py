#!/usr/bin/env python3
"""Debug STEIM2 decoding frame by frame"""

import struct
from obspy import read

# Read with ObsPy for ground truth
st = read('test_miniseed.mseed')
obspy_samples = st[0].data
print(f"ObsPy first 30 samples: {obspy_samples[:30]}")

# Now manually decode first frame
with open('test_miniseed.mseed', 'rb') as f:
    f.seek(64)  # Data starts at offset 64
    frame = f.read(64)
    
    ctrl = struct.unpack('>I', frame[0:4])[0]
    x0 = struct.unpack('>i', frame[4:8])[0]
    xn_check = struct.unpack('>i', frame[8:12])[0]
    
    print(f"\n=== FRAME 0 ===")
    print(f"X0={x0}, Xn_check={xn_check}")
    print(f"Control: 0x{ctrl:08x}")
    
    # Manual decoding
    samples = [x0]  # Start with X0
    xn = x0  # Accumulator starts from X0
    
    for word_idx in range(15):
        nibble = (ctrl >> (30 - word_idx * 2)) & 0x3
        word_offset = 12 + word_idx * 4
        word_val = struct.unpack('>I', frame[word_offset:word_offset+4])[0]
        
        if nibble == 0:
            # No data
            continue
        elif nibble == 1:
            # Four 8-bit differences
            d0 = struct.unpack('>b', bytes([(word_val >> 24) & 0xFF]))[0]
            d1 = struct.unpack('>b', bytes([(word_val >> 16) & 0xFF]))[0]
            d2 = struct.unpack('>b', bytes([(word_val >> 8) & 0xFF]))[0]
            d3 = struct.unpack('>b', bytes([word_val & 0xFF]))[0]
            
            xn += d0; samples.append(xn)
            xn += d1; samples.append(xn)
            xn += d2; samples.append(xn)
            xn += d3; samples.append(xn)
            
            print(f"Word {word_idx:2d}: nibble=1 (4x8bit) -> diffs=[{d0}, {d1}, {d2}, {d3}] -> samples={samples[-4:]}")
        elif nibble == 2:
            dnib = (word_val >> 30) & 0x3
            
            if dnib == 0:
                # Two 16-bit
                d0 = struct.unpack('>h', struct.pack('>H', (word_val >> 16) & 0xFFFF))[0]
                d1 = struct.unpack('>h', struct.pack('>H', word_val & 0xFFFF))[0]
                xn += d0; samples.append(xn)
                xn += d1; samples.append(xn)
                print(f"Word {word_idx:2d}: nibble=2 dnib=0 (2x16bit) -> diffs=[{d0}, {d1}] -> samples={samples[-2:]}")
            elif dnib == 1:
                # Two 15-bit
                d0 = ((word_val >> 15) & 0x7FFF)
                d1 = (word_val & 0x7FFF)
                # Sign extend
                if d0 & 0x4000: d0 |= 0xFFFF8000
                if d1 & 0x4000: d1 |= 0xFFFF8000
                d0 = struct.unpack('>h', struct.pack('>H', d0 & 0xFFFF))[0]
                d1 = struct.unpack('>h', struct.pack('>H', d1 & 0xFFFF))[0]
                xn += d0; samples.append(xn)
                xn += d1; samples.append(xn)
                print(f"Word {word_idx:2d}: nibble=2 dnib=1 (2x15bit) -> diffs=[{d0}, {d1}] -> samples={samples[-2:]}")
            elif dnib == 2:
                # Three 10-bit
                d0 = (word_val >> 20) & 0x3FF
                d1 = (word_val >> 10) & 0x3FF
                d2 = word_val & 0x3FF
                # Sign extend from 10 bits
                if d0 & 0x200: d0 |= 0xFFFFFC00
                if d1 & 0x200: d1 |= 0xFFFFFC00
                if d2 & 0x200: d2 |= 0xFFFFFC00
                d0 = struct.unpack('>i', struct.pack('>I', d0 & 0xFFFFFFFF))[0]
                d1 = struct.unpack('>i', struct.pack('>I', d1 & 0xFFFFFFFF))[0]
                d2 = struct.unpack('>i', struct.pack('>I', d2 & 0xFFFFFFFF))[0]
                xn += d0; samples.append(xn)
                xn += d1; samples.append(xn)
                xn += d2; samples.append(xn)
                print(f"Word {word_idx:2d}: nibble=2 dnib=2 (3x10bit) -> diffs=[{d0}, {d1}, {d2}] -> samples={samples[-3:]}")
            elif dnib == 3:
                # Five 6-bit
                d0 = (word_val >> 24) & 0x3F
                d1 = (word_val >> 18) & 0x3F
                d2 = (word_val >> 12) & 0x3F
                d3 = (word_val >> 6) & 0x3F
                d4 = word_val & 0x3F
                # Sign extend from 6 bits
                if d0 & 0x20: d0 |= 0xFFFFFFC0
                if d1 & 0x20: d1 |= 0xFFFFFFC0
                if d2 & 0x20: d2 |= 0xFFFFFFC0
                if d3 & 0x20: d3 |= 0xFFFFFFC0
                if d4 & 0x20: d4 |= 0xFFFFFFC0
                d0 = struct.unpack('>i', struct.pack('>I', d0 & 0xFFFFFFFF))[0]
                d1 = struct.unpack('>i', struct.pack('>I', d1 & 0xFFFFFFFF))[0]
                d2 = struct.unpack('>i', struct.pack('>I', d2 & 0xFFFFFFFF))[0]
                d3 = struct.unpack('>i', struct.pack('>I', d3 & 0xFFFFFFFF))[0]
                d4 = struct.unpack('>i', struct.pack('>I', d4 & 0xFFFFFFFF))[0]
                xn += d0; samples.append(xn)
                xn += d1; samples.append(xn)
                xn += d2; samples.append(xn)
                xn += d3; samples.append(xn)
                xn += d4; samples.append(xn)
                print(f"Word {word_idx:2d}: nibble=2 dnib=3 (5x6bit) -> diffs=[{d0},{d1},{d2},{d3},{d4}] -> samples={samples[-5:]}")
        elif nibble == 3:
            dnib = (word_val >> 30) & 0x3
            
            if dnib == 0:
                # Six 5-bit
                diffs = []
                for j in range(6):
                    d = (word_val >> (25 - j * 5)) & 0x1F
                    if d & 0x10: d |= 0xFFFFFFE0
                    d = struct.unpack('>i', struct.pack('>I', d & 0xFFFFFFFF))[0]
                    xn += d
                    samples.append(xn)
                    diffs.append(d)
                print(f"Word {word_idx:2d}: nibble=3 dnib=0 (6x5bit) -> diffs={diffs} -> samples={samples[-6:]}")
            elif dnib == 1:
                # Seven 4-bit
                diffs = []
                for j in range(7):
                    d = (word_val >> (24 - j * 4)) & 0xF
                    if d & 0x8: d |= 0xFFFFFFF0
                    d = struct.unpack('>i', struct.pack('>I', d & 0xFFFFFFFF))[0]
                    xn += d
                    samples.append(xn)
                    diffs.append(d)
                print(f"Word {word_idx:2d}: nibble=3 dnib=1 (7x4bit) -> diffs={diffs} -> samples={samples[-7:]}")
            elif dnib == 2:
                # One 30-bit
                d = word_val & 0x3FFFFFFF
                if d & 0x20000000: d |= 0xC0000000
                d = struct.unpack('>i', struct.pack('>I', d & 0xFFFFFFFF))[0]
                xn += d
                samples.append(xn)
                print(f"Word {word_idx:2d}: nibble=3 dnib=2 (1x30bit) -> diff={d} -> sample={samples[-1]}")
    
    print(f"\n=== COMPARISON ===")
    print(f"Manual decode:  {samples[:min(30, len(samples))]}")
    print(f"ObsPy:          {list(obspy_samples[:min(30, len(samples))])}")
    
    # Check matches
    matches = sum(1 for i in range(min(len(samples), 30)) if samples[i] == obspy_samples[i])
    print(f"Matches: {matches}/{min(len(samples), 30)}")


