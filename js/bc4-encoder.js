/**
 * bc4-encoder.js — BC4 (RGTC1) texture compression for single-channel Uint8 data
 * 
 * BC4 divides texture into 4×4 blocks. Each block stores:
 *   - 2 endpoint bytes (min, max)
 *   - 16 × 3-bit indices into 8 interpolated levels
 *   = 8 bytes per block (0.5 bytes per texel)
 */

/**
 * Encode Uint8 data to BC4 compressed format.
 * @param {Uint8Array} data - Source data (width × height, row-major)
 * @param {number} width - Must be multiple of 4
 * @param {number} height - Must be multiple of 4  
 * @returns {Uint8Array} BC4 compressed data (width/4 × height/4 × 8 bytes)
 */
export function encodeBC4(data, width, height) {
    const bw = Math.ceil(width / 4);
    const bh = Math.ceil(height / 4);
    const output = new Uint8Array(bw * bh * 8);
    
    let outOffset = 0;
    
    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            // Extract 4×4 block
            const block = new Uint8Array(16);
            for (let y = 0; y < 4; y++) {
                for (let x = 0; x < 4; x++) {
                    const srcX = bx * 4 + x;
                    const srcY = by * 4 + y;
                    if (srcX < width && srcY < height) {
                        block[y * 4 + x] = data[srcY * width + srcX];
                    } else {
                        block[y * 4 + x] = 0;
                    }
                }
            }
            
            // Find endpoints (min and max in block)
            let alpha0 = block[0], alpha1 = block[0];
            for (let i = 1; i < 16; i++) {
                if (block[i] > alpha0) alpha0 = block[i];
                if (block[i] < alpha1) alpha1 = block[i];
            }
            
            // BC4 encoding: alpha0 > alpha1 means 8-level interpolation
            if (alpha0 === alpha1) {
                // Flat block — all indices 0
                output[outOffset] = alpha0;
                output[outOffset + 1] = alpha1;
                output[outOffset + 2] = 0;
                output[outOffset + 3] = 0;
                output[outOffset + 4] = 0;
                output[outOffset + 5] = 0;
                output[outOffset + 6] = 0;
                output[outOffset + 7] = 0;
                outOffset += 8;
                continue;
            }
            
            // Build interpolation palette (8 levels when alpha0 > alpha1)
            const palette = new Float32Array(8);
            palette[0] = alpha0;
            palette[1] = alpha1;
            palette[2] = (6 * alpha0 + 1 * alpha1) / 7;
            palette[3] = (5 * alpha0 + 2 * alpha1) / 7;
            palette[4] = (4 * alpha0 + 3 * alpha1) / 7;
            palette[5] = (3 * alpha0 + 4 * alpha1) / 7;
            palette[6] = (2 * alpha0 + 5 * alpha1) / 7;
            palette[7] = (1 * alpha0 + 6 * alpha1) / 7;
            
            // Find best index for each texel
            const indices = new Uint8Array(16);
            for (let i = 0; i < 16; i++) {
                let bestIdx = 0;
                let bestDist = Math.abs(block[i] - palette[0]);
                for (let j = 1; j < 8; j++) {
                    const dist = Math.abs(block[i] - palette[j]);
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestIdx = j;
                    }
                }
                indices[i] = bestIdx;
            }
            
            // Pack: 2 endpoint bytes + 16 × 3-bit indices packed into 6 bytes
            output[outOffset] = alpha0;
            output[outOffset + 1] = alpha1;
            
            // Pack 16 3-bit indices into 48 bits (6 bytes), LSB first
            let bits = 0n;
            for (let i = 0; i < 16; i++) {
                bits |= BigInt(indices[i]) << BigInt(i * 3);
            }
            output[outOffset + 2] = Number(bits & 0xFFn);
            output[outOffset + 3] = Number((bits >> 8n) & 0xFFn);
            output[outOffset + 4] = Number((bits >> 16n) & 0xFFn);
            output[outOffset + 5] = Number((bits >> 24n) & 0xFFn);
            output[outOffset + 6] = Number((bits >> 32n) & 0xFFn);
            output[outOffset + 7] = Number((bits >> 40n) & 0xFFn);
            
            outOffset += 8;
        }
    }
    
    return output;
}
