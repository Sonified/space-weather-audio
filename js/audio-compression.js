/**
 * audio-compression.js — Lossless-quality compression for audio sample buffers
 * 
 * Converts Float32Array to Int16Array with a scale factor.
 * 50% memory savings. Quality loss < 0.003% (96 dB dynamic range).
 * 
 * The audio worklet needs Float32, so we decompress chunks on demand.
 */

/**
 * Compress Float32Array to Int16Array with scale factor.
 * @returns {{ data: Int16Array, scale: number, length: number }}
 */
export function compressToInt16(float32Array) {
    const length = float32Array.length;
    
    // Find peak value for optimal scaling
    let peak = 0;
    for (let i = 0; i < length; i++) {
        const abs = Math.abs(float32Array[i]);
        if (abs > peak) peak = abs;
    }
    
    // Scale factor: maps peak to Int16 max (32767)
    const scale = peak > 0 ? 32767 / peak : 1;
    
    const int16Array = new Int16Array(length);
    for (let i = 0; i < length; i++) {
        int16Array[i] = Math.round(float32Array[i] * scale);
    }
    
    return { data: int16Array, scale, length };
}

/**
 * Decompress a slice of Int16Array back to Float32Array.
 * @param {{ data: Int16Array, scale: number }} compressed
 * @param {number} start - Start index
 * @param {number} end - End index (exclusive)
 * @returns {Float32Array}
 */
export function decompressSlice(compressed, start, end) {
    const { data, scale } = compressed;
    const clampedStart = Math.max(0, start);
    const clampedEnd = Math.min(data.length, end);
    const length = clampedEnd - clampedStart;
    
    const float32Array = new Float32Array(length);
    const invScale = 1 / scale;
    
    for (let i = 0; i < length; i++) {
        float32Array[i] = data[clampedStart + i] * invScale;
    }
    
    return float32Array;
}

/**
 * Decompress the entire buffer back to Float32Array.
 */
export function decompressAll(compressed) {
    return decompressSlice(compressed, 0, compressed.length);
}
