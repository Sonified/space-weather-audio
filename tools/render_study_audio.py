#!/usr/bin/env python3
"""Render the 4 real-time-processed EMIC study audio files offline.

Faithful ports of the browser worklets:
  - resample-stretch-processor.js: linear-interp readout at speed 1.25
  - paul-stretch-processor.js: paulstretch.js port, winSize=1024 (study config),
    displacePos = 512*speed, window (1-x^2)^1.25, amplitudes = |Re(FFT)|,
    random phases, 50% overlap-add. Browser applies paulStretchGain=2.0 at the
    gain node; we do the same and hard-clip at +/-1 like the DAC would.
Input: GAINCURVED wavs (= browser's detrend -> gain envelope -> peak normalize).
"""
import wave, numpy as np, os, sys

SRC = '/Users/robertalexander/GitHub/space-weather-audio/stretch_test_audio/'
OUT = '/Users/robertalexander/GitHub/space-weather-audio/EMIC_Study_Audio_Files/'
SPEED = 1.25
WIN = 1024          # paulWindowSize from chirp-pilot-study config
PAUL_GAIN = 2.0     # State.paulStretchGain applied for paulStretch in browser

REGIONS = {
    '1': 'GOES_REGION_1_GAINCURVED_DN_MAGN-L2-HIRES_G16_Bx_2022-08-17T00-00-00-000Z_2022-08-20T00-00-00-000Z.wav',
    '2': 'GOES_REGION_2_GAINCURVED_DN_MAGN-L2-HIRES_G16_Bx_2022-01-14T00-00-00-000Z_2022-01-17T00-00-00-000Z.wav',
}

def load_wav(path):
    with wave.open(path) as w:
        assert w.getnchannels() == 1, 'expected mono'
        sr = w.getframerate()
        sw = w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if sw == 2:
        x = np.frombuffer(raw, np.int16).astype(np.float32) / 32768.0
    elif sw == 4:
        x = np.frombuffer(raw, np.int32).astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f'unsupported sample width {sw}')
    return x, sr

def write_wav(path, x, sr):
    y = np.clip(x, -1.0, 1.0)
    pcm = np.round(y * 32767.0).astype(np.int16)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())

def render_resample(buf, speed):
    """Mirror of the worklet's normal playback loop: linear interp, pos += speed."""
    n = len(buf)
    n_out = int(np.ceil(n / speed))
    pos = np.arange(n_out, dtype=np.float64) * speed
    idx = np.floor(pos).astype(np.int64)
    valid = idx < n - 1                      # worklet outputs 0 at idx >= bufLen-1
    idx_c = np.clip(idx, 0, n - 2)
    frac = (pos - idx).astype(np.float32)
    out = buf[idx_c] + frac * (buf[idx_c + 1] - buf[idx_c])
    out[~valid] = 0.0
    return out.astype(np.float32)

def render_paulstretch(buf, speed, win_size):
    """Mirror of paul-stretch-processor.js processStretch loop."""
    half = win_size // 2
    displace = (win_size * 0.5) * speed      # 640.0 for 1024 @ 1.25
    # window: counter from -1 step 2/(N-1); (1 - c^2)^1.25
    c = -1.0 + np.arange(win_size) * (2.0 / (win_size - 1))
    win = np.power(np.maximum(0.0, 1.0 - c * c), 1.25).astype(np.float64)

    n = len(buf)
    out_blocks = []
    block_out = np.zeros(win_size)
    read_pos = 0.0
    rng = np.random.default_rng(20260825)   # browser uses Math.random(); any seed
    while True:
        start = int(np.floor(read_pos))
        if start + win_size > n:
            break                            # queue can't fill a window -> done
        block = buf[start:start + win_size].astype(np.float64) * win
        spec = np.fft.fft(block)
        amps = np.abs(spec.real[:half + 1])  # their quirk: |Re|, not |complex|
        phases = rng.uniform(0.0, 2.0 * np.pi, half + 1)
        full = np.zeros(win_size, dtype=np.complex128)
        full[:half + 1] = amps * np.exp(1j * phases)
        # symmetric part: re[512+i] = re[512-i], im[512+i] = -im[512-i], i=1..511
        i = np.arange(1, half)
        full[half + i] = np.conj(full[half - i])
        block = np.fft.ifft(full).real * win
        block[:half] += block_out[half:]
        block_out = block
        out_blocks.append(block[:half].copy())
        read_pos += displace
    out = np.concatenate(out_blocks) if out_blocks else np.zeros(0)
    return out.astype(np.float32)

def main():
    os.makedirs(OUT, exist_ok=True)
    for reg, fname in REGIONS.items():
        buf, sr = load_wav(SRC + fname)
        print(f'Region {reg}: {len(buf)} samples @ {sr} Hz ({len(buf)/sr:.1f}s)')

        rs = render_resample(buf, SPEED)
        p = OUT + f'GOES_REGION_{reg}_resample_1.25x.wav'
        write_wav(p, rs, sr)
        print(f'  resample:    {len(rs)} samples ({len(rs)/sr:.1f}s) peak={np.abs(rs).max():.4f} rms={np.sqrt((rs.astype(np.float64)**2).mean()):.5f} -> {os.path.basename(p)}')

        ps = render_paulstretch(buf, SPEED, WIN) * PAUL_GAIN
        clipped = int((np.abs(ps) > 1.0).sum())
        p = OUT + f'GOES_REGION_{reg}_paulstretch_1.25x.wav'
        write_wav(p, ps, sr)
        print(f'  paulstretch: {len(ps)} samples ({len(ps)/sr:.1f}s) peak={np.abs(ps).max():.4f} rms={np.sqrt((ps.astype(np.float64)**2).mean()):.5f} clipped={clipped} ({100*clipped/max(1,len(ps)):.4f}%) -> {os.path.basename(p)}')

if __name__ == '__main__':
    main()
