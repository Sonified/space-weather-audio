/**
 * Phase 2.2: Worker → IRIS Direct Fetch + R2 Save Test
 * 
 * Tests:
 * 1. Can a Cloudflare Worker fetch from IRIS directly?
 * 2. Can a Cloudflare Worker save data to R2?
 * 3. What are the transfer speeds from Worker environment?
 * 
 * Deploy: wrangler deploy test-iris-fetch-and-save.js
 * Test: curl https://test-iris-fetch.robertalexander-music.workers.dev
 */

export default {
  async fetch(request, env) {
    const startTime = Date.now();
    const results = {
      test: "IRIS Fetch + R2 Save",
      timestamp: new Date().toISOString(),
      steps: []
    };

    try {
      // Step 1: Fetch from IRIS (2 hours, starting 48 hours ago)
      console.log("Step 1: Fetching from IRIS...");
      
      const now = new Date();
      const startTime = new Date(now.getTime() - 48 * 60 * 60 * 1000); // 48 hours ago
      const endTime = new Date(startTime.getTime() + 2 * 60 * 60 * 1000); // 2 hours forward
      
      const formatTime = (date) => date.toISOString().split('.')[0];
      
      const irisUrl = "https://service.iris.edu/fdsnws/dataselect/1/query?" +
                      "net=HV&sta=OBL&loc=--&cha=HHZ" +
                      `&start=${formatTime(startTime)}&end=${formatTime(endTime)}` +
                      "&format=miniseed";
      
      const fetchStart = Date.now();
      const response = await fetch(irisUrl);
      const ttfb = Date.now() - fetchStart;
      
      if (!response.ok) {
        throw new Error(`IRIS returned ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.arrayBuffer();
      const fetchTime = Date.now() - fetchStart;
      
      results.steps.push({
        step: "IRIS Fetch",
        success: true,
        dataSize: data.byteLength,
        ttfb: ttfb,
        totalTime: fetchTime,
        speed: (data.byteLength / 1e6) / (fetchTime / 1000) // MB/s
      });

      // Step 2: Save to R2
      console.log("Step 2: Saving to R2...");
      const saveStart = Date.now();
      const r2Key = `test/iris-fetch-test-${Date.now()}.mseed`;
      
      await env.R2_BUCKET.put(r2Key, data, {
        customMetadata: {
          source: 'IRIS',
          network: 'HV',
          station: 'OBL',
          channel: 'HHZ',
          startTime: formatTime(startTime),
          endTime: formatTime(endTime),
          durationHours: '2',
          fetchedAt: new Date().toISOString()
        }
      });
      
      const saveTime = Date.now() - saveStart;
      
      results.steps.push({
        step: "R2 Save",
        success: true,
        key: r2Key,
        dataSize: data.byteLength,
        saveTime: saveTime
      });

      // Step 3: Verify by reading back
      console.log("Step 3: Verifying R2 read...");
      const verifyStart = Date.now();
      const stored = await env.R2_BUCKET.get(r2Key);
      
      if (!stored) {
        throw new Error("Failed to read back from R2");
      }
      
      const storedData = await stored.arrayBuffer();
      const verifyTime = Date.now() - verifyStart;
      
      const matches = storedData.byteLength === data.byteLength;
      
      results.steps.push({
        step: "R2 Verify",
        success: matches,
        originalSize: data.byteLength,
        storedSize: storedData.byteLength,
        verifyTime: verifyTime
      });

      // Overall results
      results.success = true;
      results.totalTime = Date.now() - startTime;
      results.summary = {
        irisFetch: "✅ PASS",
        r2Save: "✅ PASS",
        r2Verify: matches ? "✅ PASS" : "❌ FAIL",
        dataIntegrity: matches ? "✅ INTACT" : "❌ CORRUPTED"
      };

    } catch (error) {
      results.success = false;
      results.error = error.message;
      results.stack = error.stack;
    }

    return new Response(JSON.stringify(results, null, 2), {
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
};

