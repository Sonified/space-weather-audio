/**
 * Cloudflare Worker - Seismic Data Decompression Test
 * Tests Zstd vs Gzip decompression performance in production
 */

import { decompress as decompressZstd } from 'fzstd';
import pako from 'pako';

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
    
    // Info endpoint
    if (url.pathname === '/') {
      return new Response(JSON.stringify({
        service: 'Seismic Data Decompression Test Worker',
        endpoints: {
          '/test': 'Test decompression (params: size=small|medium|large, format=zstd3|gzip3)',
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
