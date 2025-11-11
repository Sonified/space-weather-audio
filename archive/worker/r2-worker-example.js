/**
 * Cloudflare R2 Worker for Progressive Seismic Audio Streaming
 * 
 * This worker streams compressed chunks directly from R2 to the browser
 * without using presigned URLs - faster and simpler!
 * 
 * Endpoints:
 * - GET /metadata?network=HV&station=NPOC&location=--&channel=HHZ&date=2025-11-06
 *   Returns metadata JSON with chunk info and normalization ranges
 * 
 * - GET /chunk?network=HV&station=NPOC&location=--&channel=HHZ&date=2025-11-06&start=00:00:00&end=00:10:00
 *   Streams compressed .zst chunk directly from R2
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }
    
    // Route to appropriate handler
    if (url.pathname === '/metadata') {
      return handleMetadata(request, env, url);
    } else if (url.pathname === '/chunk') {
      return handleChunk(request, env, url);
    } else {
      return new Response('Not found', { status: 404 });
    }
  }
};

/**
 * Handle metadata request
 * Returns JSON metadata file for a specific station/date
 */
async function handleMetadata(request, env, url) {
  // Extract query parameters
  const network = url.searchParams.get('network');
  const station = url.searchParams.get('station');
  const location = url.searchParams.get('location') || '--';
  const channel = url.searchParams.get('channel');
  const date = url.searchParams.get('date'); // YYYY-MM-DD
  
  if (!network || !station || !channel || !date) {
    return new Response('Missing required parameters', { status: 400 });
  }
  
  // Construct metadata path in R2
  // Format: /data/{YEAR}/{MONTH}/{NETWORK}/{VOLCANO}/{STATION}/{LOCATION}/{CHANNEL}/{METADATA_FILE}
  // Example: /data/2025/11/HV/kilauea/NPOC/--/HHZ/HV_NPOC_--_HHZ_100Hz_2025-11-06.json
  
  // Parse date
  const [year, month, day] = date.split('-');
  
  // TODO: You'll need to determine the volcano name from the station
  // For now, hardcoded as example
  const volcano = 'kilauea'; // This should come from stations_config.json lookup
  
  // Construct metadata filename (sample rate will be in the actual file)
  // For now, we'll try to find any metadata file for this date
  const metadataPrefix = `data/${year}/${month}/${network}/${volcano}/${station}/${location}/${channel}/`;
  const metadataPattern = `${network}_${station}_${location}_${channel}_`;
  
  // List files in the directory to find the metadata file
  const listed = await env.BUCKET.list({
    prefix: metadataPrefix,
    delimiter: '/'
  });
  
  // Find the .json metadata file for this date
  const metadataFile = listed.objects.find(obj => 
    obj.key.endsWith(`${date}.json`) && obj.key.includes(metadataPattern)
  );
  
  if (!metadataFile) {
    return new Response(`Metadata not found for ${network}.${station}.${location}.${channel} on ${date}`, { 
      status: 404,
      headers: {
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
  
  console.log(`Fetching metadata: ${metadataFile.key}`);
  
  // Fetch metadata from R2
  const object = await env.BUCKET.get(metadataFile.key);
  
  if (!object) {
    return new Response('Metadata file not found in R2', { 
      status: 404,
      headers: {
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
  
  // Stream metadata back to client
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600' // Cache metadata for 1 hour
    }
  });
}

/**
 * Handle chunk request
 * Streams compressed .zst chunk directly from R2 to browser
 */
async function handleChunk(request, env, url) {
  // Extract query parameters
  const network = url.searchParams.get('network');
  const station = url.searchParams.get('station');
  const location = url.searchParams.get('location') || '--';
  const channel = url.searchParams.get('channel');
  const date = url.searchParams.get('date'); // YYYY-MM-DD
  const start = url.searchParams.get('start'); // HH:MM:SS
  const end = url.searchParams.get('end'); // HH:MM:SS
  
  if (!network || !station || !channel || !date || !start || !end) {
    return new Response('Missing required parameters', { status: 400 });
  }
  
  // Parse date
  const [year, month, day] = date.split('-');
  
  // TODO: You'll need to determine the volcano name and sample rate
  // For now, hardcoded as example
  const volcano = 'kilauea';
  const sampleRate = 100; // This should come from metadata or stations_config.json
  
  // Construct chunk filename
  // Format: {NETWORK}_{STATION}_{LOCATION}_{CHANNEL}_{SAMPLE_RATE}Hz_{START}_to_{END}.bin.zst
  // Example: HV_NPOC_--_HHZ_100Hz_2025-11-06-00-00-00_to_2025-11-06-00-10-00.bin.zst
  
  const startISO = `${date}-${start.replace(/:/g, '-')}`;
  const endISO = `${date}-${end.replace(/:/g, '-')}`;
  const filename = `${network}_${station}_${location}_${channel}_${sampleRate}Hz_${startISO}_to_${endISO}.bin.zst`;
  
  // Construct full R2 path
  const chunkPath = `data/${year}/${month}/${network}/${volcano}/${station}/${location}/${channel}/${filename}`;
  
  console.log(`Fetching chunk: ${chunkPath}`);
  
  // Fetch chunk from R2
  const object = await env.BUCKET.get(chunkPath);
  
  if (!object) {
    return new Response(`Chunk not found: ${filename}`, { 
      status: 404,
      headers: {
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
  
  // Stream chunk directly to client (no decompression in worker!)
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'zstd', // Tell browser it's compressed (though browser won't auto-decompress zstd)
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=31536000', // Cache chunks for 1 year (immutable)
      'X-Chunk-Size': object.size.toString()
    }
  });
}

