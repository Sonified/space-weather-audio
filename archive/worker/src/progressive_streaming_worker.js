/**
 * Volcano Audio - Cloudflare Worker
 * 
 * Streams seismic audio data from R2 with on-demand processing:
 * - Detrend (subtract mean)
 * - Normalize (scale by max absolute value)
 * - Progressive chunking (8→16→32→64→128→256→512 KB)
 * 
 * Co-located with R2 for minimal latency (~1-5ms vs 100-150ms via Render)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    // Route: /stream/kilauea/4?hours_ago=12
    const pathParts = url.pathname.split('/').filter(Boolean);
    
    if (pathParts[0] !== 'stream') {
      return new Response('Not Found', { status: 404 });
    }
    
    const volcano = pathParts[1];
    const durationHours = parseInt(pathParts[2]) || 4;
    const hoursAgo = parseInt(url.searchParams.get('hours_ago')) || 12;
    
    try {
      // Generate cache key (matches Python backend)
      const cacheKeyString = `${volcano}_${hoursAgo}h_ago_${durationHours}h_duration`;
      const cacheKey = await hashString(cacheKeyString);
      
      // Try to fetch raw int16 data from R2
      const r2Key = `cache/int16/raw/${cacheKey}.bin`;
      console.log(`Fetching from R2: ${r2Key}`);
      
      const startTime = Date.now();
      const r2Object = await env.R2_BUCKET.get(r2Key);
      const fetchTime = Date.now() - startTime;
      
      if (!r2Object) {
        return new Response(JSON.stringify({
          error: 'Data not cached',
          message: 'Please trigger cache population via Render backend first',
          cacheKey: r2Key
        }), { 
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      // Read raw int16 data
      const buffer = await r2Object.arrayBuffer();
      const int16Data = new Int16Array(buffer);
      const readTime = Date.now() - startTime - fetchTime;
      
      console.log(`Read ${int16Data.length} samples (${buffer.byteLength} bytes) in ${readTime}ms`);
      
      // DETREND: Calculate mean and subtract
      const detrendStart = Date.now();
      let sum = 0;
      for (let i = 0; i < int16Data.length; i++) {
        sum += int16Data[i];
      }
      const mean = sum / int16Data.length;
      
      // Create detrended float32 array
      const detrended = new Float32Array(int16Data.length);
      let maxAbs = 0;
      for (let i = 0; i < int16Data.length; i++) {
        detrended[i] = int16Data[i] - mean;
        const abs = Math.abs(detrended[i]);
        if (abs > maxAbs) maxAbs = abs;
      }
      
      // NORMALIZE: Scale by max absolute value
      for (let i = 0; i < detrended.length; i++) {
        detrended[i] /= maxAbs;
      }
      
      const processTime = Date.now() - detrendStart;
      console.log(`Processed (detrend + normalize) in ${processTime}ms`);
      
      // Convert back to int16 for streaming
      const processedInt16 = new Int16Array(detrended.length);
      for (let i = 0; i < detrended.length; i++) {
        processedInt16[i] = Math.round(detrended[i] * 32767);
      }
      
      // Stream with progressive chunks
      const totalBytes = processedInt16.byteLength;
      const chunkSizesKB = [8, 16, 32, 64, 128, 256];
      const remainingChunkKB = 512;
      
      // Create response with progressive chunking
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      
      // Stream chunks asynchronously
      (async () => {
        let offset = 0;
        let chunkIndex = 0;
        
        // Send progressive-sized chunks
        for (const chunkKB of chunkSizesKB) {
          if (offset >= totalBytes) break;
          
          const chunkBytes = chunkKB * 1024;
          const end = Math.min(offset + chunkBytes, totalBytes);
          const chunk = new Uint8Array(processedInt16.buffer, offset, end - offset);
          
          await writer.write(chunk);
          console.log(`Sent chunk ${chunkIndex + 1}: ${chunk.byteLength / 1024} KB`);
          
          offset = end;
          chunkIndex++;
        }
        
        // Send remaining in 512KB chunks
        while (offset < totalBytes) {
          const chunkBytes = remainingChunkKB * 1024;
          const end = Math.min(offset + chunkBytes, totalBytes);
          const chunk = new Uint8Array(processedInt16.buffer, offset, end - offset);
          
          await writer.write(chunk);
          console.log(`Sent chunk ${chunkIndex + 1}: ${chunk.byteLength / 1024} KB`);
          
          offset = end;
          chunkIndex++;
        }
        
        await writer.close();
        console.log(`Stream complete: ${chunkIndex} chunks`);
      })();
      
      const totalTime = Date.now() - startTime;
      
      return new Response(readable, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': totalBytes.toString(),
          'X-Worker-Fetch-MS': fetchTime.toString(),
          'X-Worker-Process-MS': processTime.toString(),
          'X-Worker-Total-MS': totalTime.toString(),
          'X-Samples': int16Data.length.toString(),
          'X-Cache-Key': cacheKey,
          ...corsHeaders
        }
      });
      
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({
        error: error.message,
        stack: error.stack
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
};

/**
 * Generate SHA-256 hash from string (for cache key matching)
 * Note: Using SHA-256 instead of MD5 since Web Crypto doesn't support MD5
 * Python backend needs to be updated to match this
 */
async function hashString(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex.substring(0, 16); // Take first 16 chars
}

