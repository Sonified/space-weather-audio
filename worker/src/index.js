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
        
        // Compress with Gzip level 3 (10 runs for small/medium, 1 run for large to avoid timeout)
        const t1 = performance.now();
        let gzipCompressed;
        const iterations = size === 'large' ? 1 : 10;
        for (let i = 0; i < iterations; i++) {
          gzipCompressed = pako.gzip(rawData, { level: 3 });
        }
        const gzipCompressTimeTotal = (performance.now() - t1);
        const gzipCompressTime = (gzipCompressTimeTotal / iterations).toFixed(4);
        
        console.log(`[Worker] Gzip compressed ${rawData.length} → ${gzipCompressed.length} bytes, ${iterations}x runs took ${gzipCompressTimeTotal.toFixed(4)}ms`);
        
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
      const isLinearSweep = url.searchParams.get('linear_sweep') === 'true'; // Use linear sweep test data
      
      try {
        console.log(`[Worker] Stream request: size=${size}, gzip=${useGzip}, linear_sweep=${isLinearSweep}`);
        
        const t0 = performance.now();
        
        // Fetch from R2 - either linear sweep or real seismic data
        let r2Key;
        if (isLinearSweep) {
          r2Key = `test/linear_sweep_${size}.bin`; // Raw int16, no gzip!
        } else {
          r2Key = useGzip 
            ? `test/worker_test_files/seismic_${size}_gzip3.bin.gz`
            : `test/worker_test_files/seismic_${size}_int32.bin`;
        }
        console.log(`[Worker] Fetching from R2: ${r2Key}`);
        
        const r2Object = await env.R2_BUCKET.get(r2Key);
        if (!r2Object) {
          return jsonError(`File not found in R2: ${r2Key}`, 404);
        }
        
        const rawData = new Uint8Array(await r2Object.arrayBuffer());
        const fetchTime = (performance.now() - t0).toFixed(4);
        console.log(`[Worker] Fetched ${rawData.length} bytes in ${fetchTime}ms`);
        
        // Step 1: Decompress if gzipped (skip for linear sweep)
        const t1 = performance.now();
        let decompressedBytes;
        if (isLinearSweep) {
          console.log('[Worker] Using raw int16 data (no decompression for linear sweep)');
          decompressedBytes = rawData;
        } else if (useGzip) {
          console.log('[Worker] Decompressing with Gzip...');
          decompressedBytes = pako.inflate(rawData);
        } else {
          console.log('[Worker] Using raw data (no decompression)');
          decompressedBytes = rawData;
        }
        const decompressTime = (performance.now() - t1).toFixed(4);
        
        // Step 2: Convert to Int32Array or Int16Array then to Float64 for processing
        let floatData;
        
        if (isLinearSweep) {
          // Linear sweep is already int16 format
          console.log('[Worker] Processing linear sweep (int16 format)');
          let int16Data;
          if (decompressedBytes.byteOffset % 2 === 0) {
            // Properly aligned
            int16Data = new Int16Array(decompressedBytes.buffer, decompressedBytes.byteOffset, decompressedBytes.byteLength / 2);
          } else {
            // Misaligned - copy to new buffer
            console.warn(`[Worker] ⚠️ Misaligned byteOffset (${decompressedBytes.byteOffset}), copying to aligned buffer`);
            const alignedBytes = new Uint8Array(decompressedBytes);
            int16Data = new Int16Array(alignedBytes.buffer);
          }
          console.log(`[Worker] Int16 samples: ${int16Data.length}`);
          
          // Convert to float for processing (normalize to -1 to 1 range)
          floatData = new Float64Array(int16Data.length);
          for (let i = 0; i < int16Data.length; i++) {
            floatData[i] = int16Data[i] / 32768.0; // int16 max
          }
        } else {
          // Real seismic data is int32 format
          console.log('[Worker] Processing seismic data (int32 format)');
          let int32Data;
          if (decompressedBytes.byteOffset % 4 === 0) {
            // Properly aligned
            int32Data = new Int32Array(decompressedBytes.buffer, decompressedBytes.byteOffset, decompressedBytes.byteLength / 4);
          } else {
            // Misaligned - copy to new buffer
            console.warn(`[Worker] ⚠️ Misaligned byteOffset (${decompressedBytes.byteOffset}), copying to aligned buffer`);
            const alignedBytes = new Uint8Array(decompressedBytes);
            int32Data = new Int32Array(alignedBytes.buffer);
          }
          console.log(`[Worker] Int32 samples: ${int32Data.length}`);
          
          // Convert to float for filtering (normalize to -1 to 1 range)
          floatData = new Float64Array(int32Data.length);
          for (let i = 0; i < int32Data.length; i++) {
            floatData[i] = int32Data[i] / 2147483648.0; // int32 max
          }
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
          console.log(`[Worker] ✅ STARTING HIGH-PASS FILTER (useFilter=${useFilter})`);
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
          const actualFilterTime = (performance.now() - t2).toFixed(4);
          console.log(`[Worker] ✅ High-pass filter COMPLETE in ${actualFilterTime}ms`);
        } else {
          filtered = floatData; // No filtering
          console.log(`[Worker] ⏭️ Skipped filtering (disabled via ?filter=false)`);
        }
        const filterTime = (performance.now() - t2).toFixed(4);
        console.log(`[Worker] 📊 filterTime header value: ${filterTime}ms`);
        
        // Step 4: Normalize (find max, scale to int16 range)
        console.log(`[Worker] ✅ STARTING NORMALIZATION`);
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
        console.log(`[Worker] ✅ Normalization COMPLETE in ${normalizeTime}ms`);
        console.log(`[Worker] 📊 normalizeTime header value: ${normalizeTime}ms`);
        
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
        
        const cleanBuffer = int16Data.buffer.slice(int16Data.byteOffset, int16Data.byteOffset + int16Data.byteLength);
        const totalBytes = cleanBuffer.byteLength;
        
        // 🔧 CRITICAL FIX: If both gzip=false AND filter=false, return RAW data without any framing!
        // This is for browser-side processing - we want PURE raw int16 data, no length prefixes!
        if (!useGzip && !useFilter) {
          console.log(`[Worker] 🔧 RAW MODE: gzip=false AND filter=false - returning COMPLETE raw data WITHOUT framing!`);
          console.log(`[Worker] Sending ${totalBytes} bytes as single raw response (no length prefixes, no chunking)`);
          
          return new Response(cleanBuffer, {
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
        }
        
        // ✅ LENGTH-PREFIX FRAMING: Send data with explicit chunk boundaries (for progressive streaming)
        // Format: [4-byte length][chunk data][4-byte length][chunk data]...
        // Pattern: 16KB → 32KB → 64KB → 128KB → 512KB (repeat)
        // This gives the browser EXACTLY the chunks we want!
        
        // Define progressive chunk sizes (in KB)
        const CHUNK_SIZES = [16, 32, 64, 128]; // Then repeat 512KB
        const FINAL_CHUNK_SIZE = 512; // KB
        
        console.log(`[Worker] Starting length-prefixed progressive chunking: ${totalBytes} bytes total`);
        
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
              
              // Extract chunk data
              const chunkData = new Uint8Array(cleanBuffer.slice(offset, offset + actualChunkSize));
              
              // Create frame: [4-byte length][chunk data]
              const frame = new Uint8Array(4 + actualChunkSize);
              const lengthView = new DataView(frame.buffer);
              lengthView.setUint32(0, actualChunkSize, true); // Little-endian length prefix
              frame.set(chunkData, 4); // Copy chunk data after length
              
              console.log(`[Worker] Framed chunk ${chunkIndex + 1}: ${actualChunkSize} bytes data + 4 bytes header = ${frame.byteLength} total (${chunkSizeKB}KB requested)`);
              
              // Send framed chunk
              controller.enqueue(frame);
              
              offset += actualChunkSize;
              chunkIndex++;
            }
            
            console.log(`[Worker] ✅ All framed chunks sent (${chunkIndex} chunks)`);
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
    
    // SSE STREAMING PIPELINE - Browser → R2 → Render → IRIS (with real-time events)
    if (url.pathname === '/request-stream') {
      if (request.method !== 'POST') {
        return jsonError('Use POST for request-stream endpoint', 405);
      }
      
      try {
        // Parse request body
        const body = await request.json();
        const { network, station, location, channel, starttime, duration } = body;
        
        if (!network || !station || station === undefined || !channel || !starttime || !duration) {
          return jsonError('Missing required parameters', 400);
        }
        
        console.log(`[R2 Worker] SSE Request: ${network}.${station}.${location}.${channel} @ ${starttime} for ${duration}s`);
        
        // Create SSE stream
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        
        // Helper to send SSE event
        const sendEvent = async (eventType, data) => {
          const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
          await writer.write(encoder.encode(message));
        };
        
        // Start async processing
        (async () => {
          try {
            // R2 received the request
            await sendEvent('r2_request_received', {
              message: 'R2 Worker received request from browser',
              network, station, location, channel, starttime, duration
            });
            
            // REAL R2 cache check (same logic as /request endpoint)
            const date = new Date(starttime);
            const year = date.getUTCFullYear();
            const month = String(date.getUTCMonth() + 1).padStart(2, '0');
            const day = String(date.getUTCDate()).padStart(2, '0');
            
            const locPart = location || '--';
            const metadataPath = `data/${year}/${month}/${network}/kilauea/${station}/${locPart}/${channel}/${year}-${month}-${day}.json`;
            
            console.log(`[R2 Worker] 🔍 REAL R2 CACHE CHECK STARTING...`);
            console.log(`[R2 Worker]    Bucket: ${env.R2_BUCKET ? 'hearts-data-cache' : 'NOT BOUND'}`);
            console.log(`[R2 Worker]    Path: ${metadataPath}`);
            console.log(`[R2 Worker]    Calling: await env.R2_BUCKET.head("${metadataPath}")`);
            
            const t0 = performance.now();
            const metadataObject = await env.R2_BUCKET.head(metadataPath);
            const checkTime = (performance.now() - t0).toFixed(2);
            
            console.log(`[R2 Worker]    R2 HEAD request completed in ${checkTime}ms`);
            console.log(`[R2 Worker]    Result: ${metadataObject ? 'FOUND (cache HIT)' : 'NOT FOUND (cache MISS)'}`);
            
            if (metadataObject) {
              console.log(`[R2 Worker] ✅ Cache HIT - metadata exists in R2`);
              console.log(`[R2 Worker]    Metadata: etag=${metadataObject.etag}, size=${metadataObject.size}, uploaded=${metadataObject.uploaded}`);
              await sendEvent('r2_cache_hit', {
                message: 'Data exists in R2 cache',
                metadataPath: metadataPath,
                checkTimeMs: checkTime
              });
              // TODO: Stream cached chunks directly to browser instead of forwarding to Render
              await sendEvent('complete', {
                message: 'Data served from R2 cache',
                cached: true
              });
              return;
            }
            
            // Cache MISS - send event
            console.log(`[R2 Worker] ❌ Cache MISS - no metadata found in R2`);
            await sendEvent('r2_cache_miss', {
              message: 'No cached data found in R2',
              metadataPath: metadataPath,
              checkTimeMs: checkTime
            });
            
            // Forward request to Render
            await sendEvent('r2_forward_to_render', {
              message: 'Forwarding request to Render backend'
            });
            
            // Connect to Render's SSE endpoint
            const renderUrl = env.RENDER_URL || 'http://localhost:5001';
            const renderSSEUrl = `${renderUrl}/api/request-stream`;
            
            console.log(`[R2 Worker] Connecting to Render SSE: ${renderSSEUrl}`);
            
            const renderResponse = await fetch(renderSSEUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(body),
            });
            
            if (!renderResponse.ok) {
              throw new Error(`Render returned ${renderResponse.status}`);
            }
            
            // Proxy Render's SSE stream to browser
            const reader = renderResponse.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let eventCount = 0;
            
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';
              
              // Forward each line to browser
              for (const line of lines) {
                if (line.startsWith('event:')) {
                  eventCount++;
                  const eventType = line.slice(7).trim();
                  console.log(`[R2 Worker] Proxying event #${eventCount}: ${eventType}`);
                }
                await writer.write(encoder.encode(line + '\n'));
              }
            }
            
            console.log(`[R2 Worker] ✅ SSE stream complete (proxied ${eventCount} events)`);
            
          } catch (error) {
            console.error('[R2 Worker] SSE Error:', error);
            await sendEvent('error', {
              error: error.message,
              source: 'r2_worker'
            });
          } finally {
            await writer.close();
          }
        })();
        
        return new Response(readable, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          }
        });
        
      } catch (error) {
        console.error('[R2 Worker] Request-stream error:', error);
        return jsonError(`Request-stream failed: ${error.message}`, 500);
      }
    }
    
    // REAL REQUEST PIPELINE - Browser → R2 → Render → IRIS
    if (url.pathname === '/request') {
      try {
        // Parse request params
        const network = url.searchParams.get('network') || 'HV';
        const station = url.searchParams.get('station') || 'NPOC';
        const location = url.searchParams.get('location') || '';  // NPOC has empty location
        const channel = url.searchParams.get('channel') || 'HHZ';
        const starttime = url.searchParams.get('starttime'); // ISO format
        const duration = url.searchParams.get('duration') || '3600'; // seconds (default 1 hour)
        
        if (!starttime) {
          return jsonError('Missing required parameter: starttime (ISO format)', 400);
        }
        
        console.log(`[Worker] Request: ${network}.${station}.${location}.${channel} @ ${starttime} for ${duration}s`);
        
        // Build R2 path based on IRIS conventions
        const date = new Date(starttime);
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        const hour = String(date.getUTCHours()).padStart(2, '0');
        const minute = String(date.getUTCMinutes()).padStart(2, '0');
        
        // Check R2 for cached metadata (handle empty location)
        const locPart = location || '--';
        const metadataPath = `data/${year}/${month}/${network}/kilauea/${station}/${locPart}/${channel}/${year}-${month}-${day}.json`;
        console.log(`[Worker] Checking R2 for metadata: ${metadataPath}`);
        
        const metadataObject = await env.R2_BUCKET.head(metadataPath);
        
        if (metadataObject) {
          console.log(`[Worker] ✅ Cache HIT - metadata exists in R2`);
          // TODO: Check if specific time range chunks exist
          // For now, return cache hit
          return new Response(JSON.stringify({
            status: 'cache_hit',
            message: 'Data exists in R2 cache',
            metadataPath: metadataPath,
            // Browser can now fetch chunks directly from R2
          }), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            }
          });
        }
        
        // Cache MISS - Forward to Render
        console.log(`[Worker] ❌ Cache MISS - forwarding to Railway`);
        
        const renderUrl = env.RENDER_URL || 'https://volcano-audio-collector-production.up.railway.app';
        const renderEndpoint = `${renderUrl}/api/request`;
        
        const renderRequest = {
          network,
          station,
          location,
          channel,
          starttime,
          duration: parseInt(duration),
          requestedBy: 'r2-worker',
          timestamp: new Date().toISOString(),
        };
        
        console.log(`[Worker] Forwarding to Render: ${renderEndpoint}`);
        
        // Forward to Render
        const renderResponse = await fetch(renderEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(renderRequest),
        });
        
        if (!renderResponse.ok) {
          throw new Error(`Render returned ${renderResponse.status}: ${await renderResponse.text()}`);
        }
        
        const renderData = await renderResponse.json();
        
        console.log(`[Worker] ✅ Render accepted request:`, renderData);
        
        // Return response indicating Render is processing
        return new Response(JSON.stringify({
          status: 'processing',
          message: 'Request forwarded to Render, processing in background',
          renderResponse: renderData,
          // Browser should listen for updates via WebSocket/SSE
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          }
        });
        
      } catch (error) {
        console.error('[Worker] Request pipeline error:', error);
        return jsonError(`Request failed: ${error.message}`, 500);
      }
    }
    
    // ===== NEW: PROGRESSIVE STREAMING ENDPOINTS =====
    
    // Helper: Get volcano name for a station by listing R2 directories
    async function findVolcanoForStation(bucket, network, station, location, channel, year, month, day) {
      // Try common volcano names first (fast path)
      const commonVolcanoes = ['kilauea', 'spurr', 'greatsitkin', 'shishaldin', 'maunaloa'];
      
      for (const volcano of commonVolcanoes) {
        const testPath = `data/${year}/${month}/${day}/${network}/${volcano}/${station}/${location}/${channel}/`;
        const listed = await bucket.list({ prefix: testPath, limit: 1 });
        if (listed.objects.length > 0) {
          console.log(`[Worker] Found volcano: ${volcano} for ${network}.${station}`);
          return volcano;
        }
      }
      
      // Not found in common names - scan all possible volcanoes
      const volcanoPrefix = `data/${year}/${month}/${day}/${network}/`;
      const listed = await bucket.list({ prefix: volcanoPrefix, delimiter: '/' });
      
      for (const prefix of (listed.delimitedPrefixes || [])) {
        const volcano = prefix.split('/')[4];  // Extract volcano name
        const testPath = `data/${year}/${month}/${day}/${network}/${volcano}/${station}/${location}/${channel}/`;
        const stationListed = await bucket.list({ prefix: testPath, limit: 1 });
        if (stationListed.objects.length > 0) {
          console.log(`[Worker] Found volcano: ${volcano} for ${network}.${station}`);
          return volcano;
        }
      }
      
      return null;
    }
    
    // Progressive Metadata endpoint - Smart chunk selection with correct min/max
    if (url.pathname === '/progressive-metadata') {
      try {
        const network = url.searchParams.get('network');
        const station = url.searchParams.get('station');
        const location = url.searchParams.get('location') || '--';
        const channel = url.searchParams.get('channel');
        const startTime = url.searchParams.get('start_time'); // ISO timestamp
        const durationMinutes = parseInt(url.searchParams.get('duration_minutes') || '30');
        
        if (!network || !station || !channel || !startTime) {
          return jsonError('Missing required parameters (network, station, channel, start_time)', 400);
        }
        
        console.log(`[Worker] Progressive metadata: ${network}.${station}.${location}.${channel}, start=${startTime}, duration=${durationMinutes}m`);
        
        // Parse start time
        const start = new Date(startTime);
        const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
        
        // Determine chunk selection strategy based on duration
        // Pattern: First hour = 10m chunks, Next 5 hours = 1h chunks, Beyond 6h = 6h chunks
        let strategy;
        if (durationMinutes <= 60) {
          strategy = 'all_10m';
        } else if (durationMinutes <= 360) {
          // 1-6 hours: First hour in 10m, rest in 1h
          strategy = 'first_hour_10m_then_1h';
        } else {
          // 6+ hours: First hour in 10m, next 5 hours in 1h, rest in 6h
          strategy = 'first_hour_10m_then_1h_then_6h';
        }
        
        console.log(`[Worker] Strategy for ${durationMinutes}m: ${strategy}`);
        
        // Get all dates in range (handle cross-day boundaries)
        const dates = [];
        let currentDate = new Date(start);
        currentDate.setUTCHours(0, 0, 0, 0);
        const endDate = new Date(end);
        endDate.setUTCHours(0, 0, 0, 0);
        
        while (currentDate <= endDate) {
          dates.push(new Date(currentDate));
          currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }
        
        console.log(`[Worker] Date range spans ${dates.length} day(s)`);
        
        // Load metadata from all dates
        const allMetadata = [];
        for (const date of dates) {
          const year = date.getUTCFullYear();
          const month = String(date.getUTCMonth() + 1).padStart(2, '0');
          const day = String(date.getUTCDate()).padStart(2, '0');
          const dateStr = `${year}-${month}-${day}`;
          
          // Find volcano
          const volcano = await findVolcanoForStation(env.R2_BUCKET, network, station, location, channel, year, month, day);
          if (!volcano) {
            console.log(`[Worker] No data found for ${dateStr}`);
            continue;
          }
          
          // Load metadata
          const metadataPrefix = `data/${year}/${month}/${day}/${network}/${volcano}/${station}/${location}/${channel}/`;
          const listed = await env.R2_BUCKET.list({ prefix: metadataPrefix });
          const metadataFile = listed.objects.find(obj => 
            obj.key.endsWith(`${dateStr}.json`)
          );
          
          if (metadataFile) {
            const object = await env.R2_BUCKET.get(metadataFile.key);
            const metadata = await object.json();
            allMetadata.push({ date: dateStr, metadata, volcano });
            const num10m = metadata.chunks['10m']?.length || 0;
            const num1h = metadata.chunks['1h']?.length || 0;
            const num6h = metadata.chunks['6h']?.length || 0;
            console.log(`[Worker] Loaded metadata for ${dateStr}: ${num10m} x 10m, ${num1h} x 1h, ${num6h} x 6h chunks`);
          }
        }
        
        if (allMetadata.length === 0) {
          return jsonError('No metadata found for requested time range', 404);
        }
        
        // Build chunk list based on time grid (NO LOOPS, NO OVERLAPS!)
        const selectedChunks = [];
        
        // Helper: Find chunk at exact time
        function findChunkAtTime(timeStr, chunkType) {
          const [dateStr, time] = timeStr.split('T');
          
          for (const { date, metadata, volcano } of allMetadata) {
            if (date !== dateStr) continue;
            
            const chunks = metadata.chunks[chunkType] || [];
            for (const chunk of chunks) {
              if (chunk.start === time) {
                return { ...chunk, date, volcano, sample_rate: metadata.sample_rate, network, station, location, channel };
              }
            }
          }
          return null;
        }
        
        // Build time grid based on strategy
        const timeGrid = [];
        let gridTime = new Date(start);
        
        // Round down to nearest 10m boundary
        gridTime.setUTCMinutes(Math.floor(gridTime.getUTCMinutes() / 10) * 10, 0, 0);
        
        while (gridTime < end) {
          const minutesFromStart = (gridTime - start) / (60 * 1000);
          const currentHour = gridTime.getUTCHours();
          const currentMinute = gridTime.getUTCMinutes();
          let chunkType, chunkDuration;
          
          if (strategy === 'all_10m') {
            chunkType = '10m';
            chunkDuration = 10;
          } else if (strategy === 'first_hour_10m_then_1h') {
            if (minutesFromStart < 60) {
              // First hour: always 10m
              chunkType = '10m';
              chunkDuration = 10;
            } else if (currentMinute === 0) {
              // After first hour AND at hour boundary: use 1h
              chunkType = '1h';
              chunkDuration = 60;
            } else {
              // After first hour but NOT at hour boundary: keep using 10m until boundary
              chunkType = '10m';
              chunkDuration = 10;
            }
          } else if (strategy === 'first_hour_10m_then_1h_then_6h') {
            if (minutesFromStart < 60) {
              // First hour: always 10m
              chunkType = '10m';
              chunkDuration = 10;
            } else if (minutesFromStart < 360) {
              // 1-6 hours region
              if (currentMinute === 0) {
                // At hour boundary: use 1h
                chunkType = '1h';
                chunkDuration = 60;
              } else {
                // Not at hour boundary: keep using 10m
                chunkType = '10m';
                chunkDuration = 10;
              }
            } else {
              // 6+ hours region
              if (currentHour % 6 === 0 && currentMinute === 0) {
                // At 6h boundary: use 6h
                chunkType = '6h';
                chunkDuration = 360;
              } else if (currentMinute === 0) {
                // At hour boundary but not 6h boundary: use 1h
                chunkType = '1h';
                chunkDuration = 60;
              } else {
                // Not at hour boundary: use 10m
                chunkType = '10m';
                chunkDuration = 10;
              }
            }
          }
          
          const dateStr = gridTime.toISOString().split('T')[0];
          const timeStr = gridTime.toTimeString().split(' ')[0]; // HH:MM:SS
          timeGrid.push({ dateStr, timeStr, chunkType });
          
          // Advance by chunk duration
          gridTime = new Date(gridTime.getTime() + chunkDuration * 60 * 1000);
        }
        
        console.log(`[Worker] Generated time grid with ${timeGrid.length} chunks`);
        
        // Look up each chunk from metadata
        for (const { dateStr, timeStr, chunkType } of timeGrid) {
          const chunk = findChunkAtTime(`${dateStr}T${timeStr}`, chunkType);
          if (chunk) {
            selectedChunks.push({ ...chunk, chunk_type: chunkType });
            console.log(`[Worker] ✅ Selected ${chunkType} chunk: ${chunk.start} → ${chunk.end} (${chunk.samples} samples)`);
          } else {
            console.warn(`[Worker] ⚠️  Missing ${chunkType} chunk at ${dateStr} ${timeStr}`);
          }
        }
        
        // Calculate min/max from ONLY the chunks that will actually be fetched (non-overlapping)
        // This ensures normalization matches the actual data that will be played
        let minVal = null;
        let maxVal = null;
        
        console.log(`[Worker] Calculating normalization from ${selectedChunks.length} non-overlapping chunks:`);
        for (const chunk of selectedChunks) {
          const chunkMin = chunk.min;
          const chunkMax = chunk.max;
          if (minVal === null || chunkMin < minVal) minVal = chunkMin;
          if (maxVal === null || chunkMax > maxVal) maxVal = chunkMax;
          
          console.log(`[Worker]   ${chunk.chunk_type} ${chunk.start}→${chunk.end}: min=${chunkMin}, max=${chunkMax} (global: [${minVal}, ${maxVal}])`);
        }
        
        console.log(`[Worker] ✅ Final normalization range: [${minVal}, ${maxVal}] (from ${selectedChunks.length} chunks that will be fetched)`);
        
        // Calculate total samples and check for gaps
        const totalSamples = selectedChunks.reduce((sum, c) => sum + (c.samples || 0), 0);
        const expectedDuration = durationMinutes * 60; // seconds
        const expectedSamples = (selectedChunks[0]?.sample_rate || 100) * expectedDuration;
        const actualSamples = totalSamples;
        const coverage = (actualSamples / expectedSamples * 100).toFixed(1);
        
        console.log(`[Worker] 📊 Coverage: ${actualSamples.toLocaleString()} / ${expectedSamples.toLocaleString()} samples (${coverage}%)`);
        if (actualSamples < expectedSamples * 0.95) {
          console.warn(`[Worker] ⚠️  Low coverage! Missing approximately ${Math.round((expectedSamples - actualSamples) / (selectedChunks[0]?.sample_rate || 100))} seconds of data`);
        }
        
        // Log chunk summary
        const chunkSummary = {};
        selectedChunks.forEach(c => {
          chunkSummary[c.chunk_type] = (chunkSummary[c.chunk_type] || 0) + 1;
        });
        console.log(`[Worker] 📦 Chunk summary:`, chunkSummary);
        
        // Return response
        return new Response(JSON.stringify({
          station: `${network}.${station}.${location}.${channel}`,
          start_time: startTime,
          end_time: end.toISOString(),
          duration_minutes: durationMinutes,
          sample_rate: selectedChunks[0]?.sample_rate || 100,
          normalization: {
            min: minVal,
            max: maxVal,
            range: maxVal - minVal
          },
          chunks: selectedChunks.map(c => ({
            type: c.chunk_type,
            date: c.date,
            start: c.start,
            end: c.end,
            samples: c.samples,
            min: c.min,
            max: c.max
          })),
          total_samples: totalSamples,
          total_chunks: selectedChunks.length,
          strategy: strategy
        }, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=300', // Cache for 5 minutes
          }
        });
        
      } catch (error) {
        console.error('[Worker] Progressive metadata error:', error);
        return jsonError(`Progressive metadata failed: ${error.message}`, 500);
      }
    }
    
    // Metadata endpoint - Returns JSON metadata for a station/date
    if (url.pathname === '/metadata') {
      const network = url.searchParams.get('network');
      const station = url.searchParams.get('station');
      const location = url.searchParams.get('location') || '--';
      const channel = url.searchParams.get('channel');
      const date = url.searchParams.get('date'); // YYYY-MM-DD
      
      if (!network || !station || !channel || !date) {
        return jsonError('Missing required parameters (network, station, channel, date)', 400);
      }
      
      // Parse date
      const [year, month, day] = date.split('-');
      
      // Find volcano name by scanning R2
      const volcano = await findVolcanoForStation(env.R2_BUCKET, network, station, location, channel, year, month, day);
      if (!volcano) {
        return jsonError(`Could not find volcano for station ${network}.${station}`, 404);
      }
      
      // Construct metadata path - CORRECT FORMAT with day folder!
      // Format: data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location}/{channel}/{filename}.json
      // List files to find the metadata file with sample rate
      const metadataPrefix = `data/${year}/${month}/${day}/${network}/${volcano}/${station}/${location}/${channel}/`;
      const listed = await env.R2_BUCKET.list({ prefix: metadataPrefix });
      
      // Find the .json file for this date
      const metadataFile = listed.objects.find(obj => 
        obj.key.endsWith(`${date}.json`) && obj.key.includes(`${network}_${station}_${location}_${channel}`)
      );
      
      if (!metadataFile) {
        return jsonError(`Metadata not found for ${network}.${station}.${location}.${channel} on ${date}`, 404);
      }
      
      console.log(`[Worker] Metadata request: ${metadataFile.key}`);
      
      const object = await env.R2_BUCKET.get(metadataFile.key);
      if (!object) {
        return jsonError('Metadata file not found in R2', 404);
      }
      
      return new Response(object.body, {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
        }
      });
    }
    
    // Chunk endpoint - Streams compressed .zst chunk directly
    if (url.pathname === '/chunk') {
      const network = url.searchParams.get('network');
      const station = url.searchParams.get('station');
      const location = url.searchParams.get('location') || '--';
      const channel = url.searchParams.get('channel');
      const date = url.searchParams.get('date'); // YYYY-MM-DD
      const start = url.searchParams.get('start'); // HH:MM:SS
      const end = url.searchParams.get('end'); // HH:MM:SS
      const chunkType = url.searchParams.get('chunk_type') || '10m'; // Chunk type: 10m, 1h, 6h
      
      if (!network || !station || !channel || !date || !start || !end) {
        return jsonError('Missing required parameters', 400);
      }
      
      // Parse date
      const [year, month, day] = date.split('-');
      
      // Find volcano name
      const volcano = await findVolcanoForStation(env.R2_BUCKET, network, station, location, channel, year, month, day);
      if (!volcano) {
        return jsonError(`Could not find volcano for station ${network}.${station}`, 404);
      }
      
      // Get sample rate from metadata
      const metadataPrefix = `data/${year}/${month}/${day}/${network}/${volcano}/${station}/${location}/${channel}/`;
      const metadataListed = await env.R2_BUCKET.list({ prefix: metadataPrefix });
      const metadataFile = metadataListed.objects.find(obj => 
        obj.key.endsWith(`${date}.json`) && obj.key.includes(`${network}_${station}_${location}_${channel}`)
      );
      
      let sampleRate = 100; // Default
      if (metadataFile) {
        const metadataObj = await env.R2_BUCKET.get(metadataFile.key);
        const metadata = await metadataObj.json();
        sampleRate = metadata.sample_rate || 100;
      }
      
      // Construct chunk filename
      // Format: {NETWORK}_{STATION}_{LOCATION}_{CHANNEL}_{RATE}Hz_{CHUNK_TYPE}_{START}_to_{END}.bin.zst
      const startISO = `${date}-${start.replace(/:/g, '-')}`;
      const endISO = `${date}-${end.replace(/:/g, '-')}`;
      const rateStr = sampleRate % 1 === 0 ? sampleRate.toFixed(0) : sampleRate.toString();
      const filename = `${network}_${station}_${location}_${channel}_${rateStr}Hz_${chunkType}_${startISO}_to_${endISO}.bin.zst`;
      
      // Full path with chunk type subfolder
      const chunkPath = `data/${year}/${month}/${day}/${network}/${volcano}/${station}/${location}/${channel}/${chunkType}/${filename}`;
      
      console.log(`[Worker] Chunk request: ${chunkPath}`);
      
      const object = await env.R2_BUCKET.get(chunkPath);
      if (!object) {
        return jsonError(`Chunk not found: ${filename}`, 404);
      }
      
      // Stream chunk directly (no decompression!)
      return new Response(object.body, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=31536000', // Cache forever (immutable)
          'X-Chunk-Size': object.size.toString(),
        }
      });
    }
    
    // Info endpoint
    if (url.pathname === '/') {
      return new Response(JSON.stringify({
        service: 'Seismic Data Streaming Worker',
        endpoints: {
          '/progressive-metadata': 'Smart metadata with chunk selection (params: network, station, location, channel, start_time, duration_minutes)',
          '/metadata': 'Get metadata JSON for single date (params: network, station, location, channel, date)',
          '/chunk': 'Stream compressed chunk (params: network, station, location, channel, date, start, end, chunk_type)',
          '/request': 'Request seismic data (checks R2 cache, forwards to Render if miss)',
          '/request-stream': 'SSE stream with cache check and Render forwarding',
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
