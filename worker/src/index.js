/**
 * Cloudflare Worker - Seismic Data Decompression Test
 * Tests Zstd vs Gzip decompression performance in production
 */

import { decompress as decompressZstd } from 'fzstd';
import pako from 'pako';
import { init as initZstd, compress as compressZstd } from '@bokuweb/zstd-wasm';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }
    
    // Test endpoint - fetches and compares BOTH formats
    if (url.pathname === '/test') {
      const size = url.searchParams.get('size') || 'small';
      const format = url.searchParams.get('format') || 'zstd3';
      
      try {
        console.log(`[Worker] Test request: size=${size}, format=${format}`);
        console.log(`[Worker] Will also fetch and compare alternate format for verification`);
        
        const t0 = performance.now();
        
        // Fetch PRIMARY format (the one requested)
        const r2Key = `test/worker_test_files/seismic_${size}_${format}.bin${format.includes('gzip') ? '.gz' : ''}`;
        console.log(`[Worker] Fetching PRIMARY from R2: ${r2Key}`);
        
        const r2Object = await env.R2_BUCKET.get(r2Key);
        if (!r2Object) {
          return jsonError(`File not found in R2: ${r2Key}`, 404);
        }
        
        const compressed = new Uint8Array(await r2Object.arrayBuffer());
        const fetchTime = (performance.now() - t0).toFixed(4);
        console.log(`[Worker] Fetched ${compressed.length} bytes in ${fetchTime}ms`);
        
        // Fetch ALTERNATE format (for comparison)
        const altFormat = format.includes('zstd') ? 'gzip3' : 'zstd3';
        const altR2Key = `test/worker_test_files/seismic_${size}_${altFormat}.bin${altFormat.includes('gzip') ? '.gz' : ''}`;
        console.log(`[Worker] Fetching ALTERNATE from R2: ${altR2Key}`);
        
        const altR2Object = await env.R2_BUCKET.get(altR2Key);
        if (!altR2Object) {
          return jsonError(`Alternate file not found in R2: ${altR2Key}`, 404);
        }
        
        const altCompressed = new Uint8Array(await altR2Object.arrayBuffer());
        console.log(`[Worker] Fetched alternate: ${altCompressed.length} bytes`);
        
        // Decompress PRIMARY
        const t1 = performance.now();
        let decompressed;
        
        if (format.includes('zstd')) {
          console.log('[Worker] Decompressing PRIMARY with Zstd...');
          decompressed = decompressZstd(compressed);
        } else if (format.includes('gzip')) {
          console.log('[Worker] Decompressing PRIMARY with Gzip...');
          decompressed = pako.inflate(compressed);
        } else {
          return jsonError('Unknown format. Use zstd3 or gzip3', 400);
        }
        
        const decompressTime = (performance.now() - t1).toFixed(4);
        
        // Decompress ALTERNATE
        const t2 = performance.now();
        let altDecompressed;
        
        if (altFormat.includes('zstd')) {
          console.log('[Worker] Decompressing ALTERNATE with Zstd...');
          altDecompressed = decompressZstd(altCompressed);
        } else {
          console.log('[Worker] Decompressing ALTERNATE with Gzip...');
          altDecompressed = pako.inflate(altCompressed);
        }
        
        const altDecompressTime = (performance.now() - t2).toFixed(4);
        const totalTime = (performance.now() - t0).toFixed(4);
        
        // FIX: Copy to aligned buffer if there's an offset (for BOTH)
        let alignedData = decompressed;
        if (decompressed.byteOffset && decompressed.byteOffset !== 0) {
          console.log(`[Worker] PRIMARY: Non-zero byteOffset detected! Copying to aligned buffer...`);
          alignedData = new Uint8Array(decompressed);
        }
        
        let altAlignedData = altDecompressed;
        if (altDecompressed.byteOffset && altDecompressed.byteOffset !== 0) {
          console.log(`[Worker] ALTERNATE: Non-zero byteOffset detected! Copying to aligned buffer...`);
          altAlignedData = new Uint8Array(altDecompressed);
        }
        
        // Convert both to Int32Array
        const dataView = new Int32Array(alignedData.buffer || alignedData);
        const altDataView = new Int32Array(altAlignedData.buffer || altAlignedData);
        
        const firstValue = dataView[0];
        const lastValue = dataView[dataView.length - 1];
        const sampleCount = dataView.length;
        
        // Calculate min/max
        let min = dataView[0];
        let max = dataView[0];
        for (let i = 1; i < dataView.length; i++) {
          if (dataView[i] < min) min = dataView[i];
          if (dataView[i] > max) max = dataView[i];
        }
        
        // COMPARE THE TWO ARRAYS
        let identical = true;
        let firstDiffIndex = -1;
        let firstDiffPrimary = 0;
        let firstDiffAlt = 0;
        
        if (dataView.length !== altDataView.length) {
          identical = false;
          console.log(`[Worker] ❌ LENGTH MISMATCH: ${dataView.length} vs ${altDataView.length}`);
        } else {
          for (let i = 0; i < dataView.length; i++) {
            if (dataView[i] !== altDataView[i]) {
              identical = false;
              firstDiffIndex = i;
              firstDiffPrimary = dataView[i];
              firstDiffAlt = altDataView[i];
              console.log(`[Worker] ❌ FIRST DIFFERENCE at index ${i}: ${format}=${firstDiffPrimary}, ${altFormat}=${firstDiffAlt}`);
              break;
            }
          }
        }
        
        if (identical) {
          console.log(`[Worker] ✅ ARRAYS ARE IDENTICAL! Both formats decompress to the same data.`);
        }
        
        console.log(`[Worker] Decompressed ${decompressed.length} bytes in ${decompressTime}ms`);
        console.log(`[Worker] Data verified: ${sampleCount} samples, range [${min}, ${max}], first=${firstValue}, last=${lastValue}`);
        console.log(`[Worker] Total time: ${totalTime}ms`);
        
        // Return raw data with performance metrics AND comparison results in headers
        return new Response(decompressed, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'X-Fetch-Time, X-Decompress-Time, X-Total-Time, X-Compressed-Size, X-Decompressed-Size, X-Format, X-Size, X-Sample-Count, X-Data-Min, X-Data-Max, X-Data-First, X-Data-Last, X-Formats-Identical, X-First-Diff-Index, X-First-Diff-Primary, X-First-Diff-Alt',
            'X-Fetch-Time': fetchTime,
            'X-Decompress-Time': decompressTime,
            'X-Total-Time': totalTime,
            'X-Compressed-Size': compressed.length.toString(),
            'X-Decompressed-Size': decompressed.length.toString(),
            'X-Format': format,
            'X-Size': size,
            'X-Sample-Count': sampleCount.toString(),
            'X-Data-Min': min.toString(),
            'X-Data-Max': max.toString(),
            'X-Data-First': firstValue.toString(),
            'X-Data-Last': lastValue.toString(),
            'X-Formats-Identical': identical.toString(),
            'X-First-Diff-Index': firstDiffIndex.toString(),
            'X-First-Diff-Primary': firstDiffPrimary.toString(),
            'X-First-Diff-Alt': firstDiffAlt.toString(),
          }
        });
        
      } catch (error) {
        console.error('[Worker] Error:', error);
        return jsonError(`Worker error: ${error.message}`, 500);
      }
    }
    
    // Compression test endpoint - fetch raw data and compress it
    if (url.pathname === '/compress-test') {
      const size = url.searchParams.get('size') || 'small';
      
      try {
        console.log(`[Worker] Compress test request: size=${size}`);
        
        const t0 = performance.now();
        
        // Fetch raw int32 file from R2
        const r2Key = `test/worker_test_files/seismic_${size}_int32.bin`;
        console.log(`[Worker] Fetching raw data from R2: ${r2Key}`);
        
        const r2Object = await env.R2_BUCKET.get(r2Key);
        if (!r2Object) {
          return jsonError(`Raw file not found in R2: ${r2Key}`, 404);
        }
        
        const rawData = new Uint8Array(await r2Object.arrayBuffer());
        const fetchTime = (performance.now() - t0).toFixed(4);
        console.log(`[Worker] Fetched ${rawData.length} bytes in ${fetchTime}ms`);
        
        // Test BOTH Gzip and Zstd compression
        
        // Compress with Gzip level 3 (run 10 times to get measurable time)
        const t1 = performance.now();
        let gzipCompressed;
        for (let i = 0; i < 10; i++) {
          gzipCompressed = pako.gzip(rawData, { level: 3 });
        }
        const gzipCompressTime10x = (performance.now() - t1);
        const gzipCompressTime = (gzipCompressTime10x / 10).toFixed(4);
        
        console.log(`[Worker] Gzip compressed ${rawData.length} → ${gzipCompressed.length} bytes, 10x runs took ${gzipCompressTime10x.toFixed(4)}ms`);
        
        // Try Zstd compression
        let zstdCompressed = null;
        let zstdCompressTime = null;
        let zstdError = null;
        try {
          await initZstd();
          const t2 = performance.now();
          zstdCompressed = compressZstd(rawData, 3);
          zstdCompressTime = (performance.now() - t2).toFixed(4);
        } catch (err) {
          zstdError = err.message;
          console.error('[Worker] Zstd compression failed:', err);
        }
        
        const compressed = gzipCompressed;
        const compressTime = gzipCompressTime;
        
        const totalTime = (performance.now() - t0).toFixed(4);
        const compressionRatio = ((compressed.length / rawData.length) * 100).toFixed(1);
        
        console.log(`[Worker] ✅ Compressed ${rawData.length} bytes → ${compressed.length} bytes (${compressionRatio}%) in ${compressTime}ms`);
        console.log(`[Worker] Total time: ${totalTime}ms`);
        
        return new Response(JSON.stringify({
          success: true,
          size: size,
          rawSize: rawData.length,
          gzip: {
            compressedSize: gzipCompressed.length,
            compressionRatio: ((gzipCompressed.length / rawData.length) * 100).toFixed(1) + '%',
            compressTime: gzipCompressTime + ' ms',
            success: true
          },
          zstd: zstdCompressed ? {
            compressedSize: zstdCompressed.length,
            compressionRatio: ((zstdCompressed.length / rawData.length) * 100).toFixed(1) + '%',
            compressTime: zstdCompressTime + ' ms',
            success: true
          } : {
            success: false,
            error: zstdError
          },
          fetchTime: fetchTime + ' ms',
          totalTime: totalTime + ' ms',
        }, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          }
        });
        
      } catch (err) {
        console.error('[Worker] Compression test error:', err);
        return jsonError(`Compression failed: ${err.message}`, 500);
      }
    }
    
    // Streaming pipeline endpoint - REAL DATA through full pipeline
    if (url.pathname === '/stream') {
      const size = url.searchParams.get('size') || 'small';
      const useGzip = url.searchParams.get('gzip') === 'true'; // If true, use gzipped data
      const useFilter = url.searchParams.get('filter') !== 'false'; // Default true, set ?filter=false to skip
      
      try {
        console.log(`[Worker] Stream request: size=${size}, gzip=${useGzip}`);
        
        const t0 = performance.now();
        
        // Fetch from R2 (either gzipped or raw int32)
        const r2Key = useGzip 
          ? `test/worker_test_files/seismic_${size}_gzip3.bin.gz`
          : `test/worker_test_files/seismic_${size}_int32.bin`;
        console.log(`[Worker] Fetching from R2: ${r2Key}`);
        
        const r2Object = await env.R2_BUCKET.get(r2Key);
        if (!r2Object) {
          return jsonError(`File not found in R2: ${r2Key}`, 404);
        }
        
        const rawData = new Uint8Array(await r2Object.arrayBuffer());
        const fetchTime = (performance.now() - t0).toFixed(4);
        console.log(`[Worker] Fetched ${rawData.length} bytes in ${fetchTime}ms`);
        
        // Step 1: Decompress if gzipped
        const t1 = performance.now();
        let int32Bytes;
        if (useGzip) {
          console.log('[Worker] Decompressing with Gzip...');
          int32Bytes = pako.inflate(rawData);
        } else {
          console.log('[Worker] Using raw int32 data (no decompression)');
          int32Bytes = rawData;
        }
        const decompressTime = (performance.now() - t1).toFixed(4);
        
        // Step 2: Convert to Int32Array then to Float64 for processing
        // CRITICAL: Ensure 4-byte alignment for Int32Array
        let int32Data;
        if (int32Bytes.byteOffset % 4 === 0) {
          // Properly aligned
          int32Data = new Int32Array(int32Bytes.buffer, int32Bytes.byteOffset, int32Bytes.byteLength / 4);
        } else {
          // Misaligned - copy to new buffer
          console.warn(`[Worker] ⚠️ Misaligned byteOffset (${int32Bytes.byteOffset}), copying to aligned buffer`);
          const alignedBytes = new Uint8Array(int32Bytes);
          int32Data = new Int32Array(alignedBytes.buffer);
        }
        console.log(`[Worker] Int32 samples: ${int32Data.length}`);
        
        // Convert to float for filtering (normalize to -1 to 1 range)
        const floatData = new Float64Array(int32Data.length);
        for (let i = 0; i < int32Data.length; i++) {
          floatData[i] = int32Data[i] / 2147483648.0; // int32 max
        }
        
        // Check input data BEFORE filtering
        let inputSum = 0, inputMin = 1, inputMax = -1;
        for (let i = 0; i < Math.min(1000, floatData.length); i++) {
          const val = floatData[i];
          inputSum += val;
          if (val < inputMin) inputMin = val;
          if (val > inputMax) inputMax = val;
        }
        const inputMean = inputSum / Math.min(1000, floatData.length);
        let inputVariance = 0;
        for (let i = 0; i < Math.min(1000, floatData.length); i++) {
          const diff = floatData[i] - inputMean;
          inputVariance += diff * diff;
        }
        inputVariance /= Math.min(1000, floatData.length);
        const inputStdDev = Math.sqrt(inputVariance);
        console.log(`[Worker] INPUT (pre-filter): range [${inputMin.toFixed(6)}, ${inputMax.toFixed(6)}], stdDev=${inputStdDev.toFixed(6)}`);
        
        // Step 3: High-pass filter (optional, controlled by ?filter=false)
        const sampleRate = 100; // Seismic data sample rate (always needed for headers)
        const t2 = performance.now();
        let filtered;
        if (useFilter) {
          const cutoffHz = 0.1; // 0.1 Hz seismic → 20 Hz audio (200x speedup)
          const RC = 1.0 / (2 * Math.PI * cutoffHz);
          const alpha = RC / (RC + 1 / sampleRate);
          
          filtered = new Float64Array(floatData.length);
          let prevX = 0;
          let prevY = 0;
          
          for (let i = 0; i < floatData.length; i++) {
            const x = floatData[i];
            const y = alpha * (prevY + x - prevX);
            filtered[i] = y;
            prevX = x;
            prevY = y;
          }
          console.log(`[Worker] High-pass filtered in ${(performance.now() - t2).toFixed(4)}ms`);
        } else {
          filtered = floatData; // No filtering
          console.log(`[Worker] Skipped filtering (disabled via ?filter=false)`);
        }
        const filterTime = (performance.now() - t2).toFixed(4);
        
        // Step 4: Normalize (find max, scale to int16 range)
        const t3 = performance.now();
        let max = 0;
        for (let i = 0; i < filtered.length; i++) {
          const absVal = Math.abs(filtered[i]);
          if (absVal > max) max = absVal;
        }
        
        const scale = max > 0 ? 32767 / max : 1;
        console.log(`[Worker] Normalization: max=${max.toExponential(3)}, scale=${scale.toFixed(6)}`);
        
        // Step 5: Convert to Int16
        const int16Data = new Int16Array(filtered.length);
        for (let i = 0; i < filtered.length; i++) {
          const scaled = Math.round(filtered[i] * scale);
          int16Data[i] = Math.max(-32768, Math.min(32767, scaled));
        }
        const normalizeTime = (performance.now() - t3).toFixed(4);
        console.log(`[Worker] Normalized and converted to int16 in ${normalizeTime}ms`);
        
        const totalTime = (performance.now() - t0).toFixed(4);
        console.log(`[Worker] ✅ Pipeline complete: ${totalTime}ms total`);
        console.log(`[Worker] Output: ${int16Data.length} int16 samples (${int16Data.byteLength} bytes)`);
        
        // Check for white noise in output
        let sum = 0;
        let minVal = 32767, maxVal = -32768;
        for (let i = 0; i < Math.min(1000, int16Data.length); i++) {
          const val = int16Data[i];
          sum += val;
          if (val < minVal) minVal = val;
          if (val > maxVal) maxVal = val;
        }
        const mean = sum / Math.min(1000, int16Data.length);
        let variance = 0;
        for (let i = 0; i < Math.min(1000, int16Data.length); i++) {
          const diff = int16Data[i] - mean;
          variance += diff * diff;
        }
        variance /= Math.min(1000, int16Data.length);
        const stdDev = Math.sqrt(variance);
        console.log(`[Worker] First 1000 samples: range [${minVal}, ${maxVal}], mean=${mean.toFixed(1)}, stdDev=${stdDev.toFixed(1)}`);
        
        // ✅ PROGRESSIVE CHUNKING: Send data in explicit chunk sizes
        // Pattern: 8KB → 16KB → 32KB → 64KB → 128KB → 512KB (repeat)
        // This gives the browser EXACTLY the chunks we want, no auto-chunking!
        
        const cleanBuffer = int16Data.buffer.slice(int16Data.byteOffset, int16Data.byteOffset + int16Data.byteLength);
        const totalBytes = cleanBuffer.byteLength;
        
        // Define progressive chunk sizes (in KB)
        const CHUNK_SIZES = [8, 16, 32, 64, 128]; // Then repeat 512KB
        const FINAL_CHUNK_SIZE = 512; // KB
        
        console.log(`[Worker] Starting progressive chunking: ${totalBytes} bytes total`);
        
        const stream = new ReadableStream({
          async start(controller) {
            let offset = 0;
            let chunkIndex = 0;
            
            while (offset < totalBytes) {
              // Determine chunk size for this iteration
              let chunkSizeKB;
              if (chunkIndex < CHUNK_SIZES.length) {
                chunkSizeKB = CHUNK_SIZES[chunkIndex];
              } else {
                chunkSizeKB = FINAL_CHUNK_SIZE;
              }
              
              const chunkSizeBytes = chunkSizeKB * 1024;
              const remainingBytes = totalBytes - offset;
              const actualChunkSize = Math.min(chunkSizeBytes, remainingBytes);
              
              // Extract chunk
              const chunk = cleanBuffer.slice(offset, offset + actualChunkSize);
              
              console.log(`[Worker] Chunk ${chunkIndex + 1}: ${actualChunkSize} bytes (${chunkSizeKB}KB requested)`);
              
              // Send chunk
              controller.enqueue(new Uint8Array(chunk));
              
              offset += actualChunkSize;
              chunkIndex++;
            }
            
            console.log(`[Worker] ✅ All chunks sent (${chunkIndex} chunks)`);
            controller.close();
          }
        });
        
        return new Response(stream, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'X-Fetch-Time, X-Decompress-Time, X-Filter-Time, X-Normalize-Time, X-Total-Time, X-Sample-Count, X-Sample-Rate, X-Data-Type',
            'X-Fetch-Time': fetchTime,
            'X-Decompress-Time': decompressTime,
            'X-Filter-Time': filterTime,
            'X-Normalize-Time': normalizeTime,
            'X-Total-Time': totalTime,
            'X-Sample-Count': int16Data.length.toString(),
            'X-Sample-Rate': sampleRate.toString(),
            'X-Data-Type': 'int16',
          }
        });
        
      } catch (error) {
        console.error('[Worker] Stream error:', error);
        return jsonError(`Stream error: ${error.message}`, 500);
      }
    }
    
    // Info endpoint
    if (url.pathname === '/') {
      return new Response(JSON.stringify({
        service: 'Seismic Data Streaming Worker',
        endpoints: {
          '/stream': 'Stream processed data (params: size=small|medium|large, gzip=true|false)',
          '/test': 'Test decompression (params: size=small|medium|large, format=zstd3|gzip3)',
          '/compress-test': 'Test compression (params: size=small|medium|large)',
        },
        formats: ['zstd3', 'gzip3'],
        sizes: ['small', 'medium', 'large'],
      }, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }
    
    return new Response('Not Found', { status: 404 });
  }
};

function jsonError(message, status = 500) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    }
  });
}
