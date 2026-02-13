/**
 * test-themis-fgm.mjs
 *
 * Local test to verify THEMIS FGM data can be fetched from CDAWeb as audio WAV.
 * Tests a short 1-hour window for THEMIS-A FGM (low-res, ~4 Hz GSE).
 *
 * Usage: node tests/test-themis-fgm.mjs
 */

const CDASWS_BASE_URL = 'https://cdaweb.gsfc.nasa.gov/WS/cdasr/1';
const DATAVIEW = 'sp_phys';

// Same mapping as data-fetcher.js
const FGM_DATASETS = {
    'THA_L2_FGM': 'tha_fgl_gse',
    'THB_L2_FGM': 'thb_fgl_gse',
    'THC_L2_FGM': 'thc_fgl_gse',
    'THD_L2_FGM': 'thd_fgl_gse',
    'THE_L2_FGM': 'the_fgl_gse',
};

// Test parameters - 1 hour of THEMIS-A FGM data from a known-good date
const TEST_DATASET = 'THA_L2_FGM';
const TEST_VARIABLE = FGM_DATASETS[TEST_DATASET];
const TEST_START = '20190601T120000Z';  // June 1, 2019 12:00 UTC
const TEST_END   = '20190601T130000Z';  // June 1, 2019 13:00 UTC

async function testFGMFetch() {
    console.log('=== THEMIS FGM CDAWeb Audio Test ===\n');
    console.log(`Dataset:  ${TEST_DATASET}`);
    console.log(`Variable: ${TEST_VARIABLE}`);
    console.log(`Window:   ${TEST_START} → ${TEST_END}`);
    console.log('');

    // Step 1: Request audio file list from CDAWeb
    const apiUrl = `${CDASWS_BASE_URL}/dataviews/${DATAVIEW}/datasets/${TEST_DATASET}/data/${TEST_START},${TEST_END}/${TEST_VARIABLE}?format=audio`;
    console.log(`[1/3] Requesting CDAWeb audio endpoint...`);
    console.log(`  URL: ${apiUrl}\n`);

    let response;
    try {
        response = await fetch(apiUrl, {
            headers: { 'Accept': 'application/json' }
        });
    } catch (err) {
        console.error(`FAIL: Network error - ${err.message}`);
        process.exit(1);
    }

    if (!response.ok) {
        const body = await response.text();
        console.error(`FAIL: HTTP ${response.status} ${response.statusText}`);
        console.error(`  Response: ${body.slice(0, 500)}`);
        process.exit(1);
    }

    const json = await response.json();
    const files = json?.FileDescription || [];

    if (files.length === 0) {
        console.error('FAIL: CDAWeb returned no audio files.');
        console.error('  This could mean no data exists for this time range.');
        console.error('  Full response:', JSON.stringify(json, null, 2).slice(0, 1000));
        process.exit(1);
    }

    console.log(`[2/3] CDAWeb returned ${files.length} audio component(s):`);
    for (const f of files) {
        console.log(`  - ${f.Name}`);
    }
    console.log('');

    // Step 2: Download the first WAV file and check its headers
    const wavUrl = files[0].Name;
    console.log(`[3/3] Downloading first component WAV...`);
    console.log(`  URL: ${wavUrl}\n`);

    let wavResponse;
    try {
        wavResponse = await fetch(wavUrl);
    } catch (err) {
        console.error(`FAIL: Could not download WAV - ${err.message}`);
        process.exit(1);
    }

    if (!wavResponse.ok) {
        console.error(`FAIL: WAV download HTTP ${wavResponse.status}`);
        process.exit(1);
    }

    const wavBuffer = await wavResponse.arrayBuffer();
    const wavBytes = new Uint8Array(wavBuffer);
    const wavSize = wavBytes.length;

    console.log(`  Downloaded: ${(wavSize / 1024).toFixed(1)} KB`);

    // Validate WAV header
    const riffTag = String.fromCharCode(...wavBytes.slice(0, 4));
    const waveTag = String.fromCharCode(...wavBytes.slice(8, 12));
    const fmtTag  = String.fromCharCode(...wavBytes.slice(12, 16));

    if (riffTag !== 'RIFF' || waveTag !== 'WAVE') {
        console.error(`FAIL: Not a valid WAV file (got "${riffTag}...${waveTag}")`);
        process.exit(1);
    }

    // Parse fmt chunk
    const view = new DataView(wavBuffer);
    const audioFormat = view.getUint16(20, true);    // 1 = PCM
    const numChannels = view.getUint16(22, true);
    const sampleRate  = view.getUint32(24, true);
    const bitsPerSample = view.getUint16(34, true);

    // Find data chunk size
    let dataSize = 0;
    for (let i = 36; i < wavBytes.length - 4; i++) {
        if (String.fromCharCode(...wavBytes.slice(i, i + 4)) === 'data') {
            dataSize = view.getUint32(i + 4, true);
            break;
        }
    }
    const numSamples = dataSize / (bitsPerSample / 8) / numChannels;
    const durationSec = numSamples / sampleRate;

    console.log('');
    console.log('  WAV Properties:');
    console.log(`    Format:       ${audioFormat === 1 ? 'PCM' : `Unknown (${audioFormat})`}`);
    console.log(`    Channels:     ${numChannels}`);
    console.log(`    Sample Rate:  ${sampleRate} Hz`);
    console.log(`    Bit Depth:    ${bitsPerSample}-bit`);
    console.log(`    Samples:      ${numSamples.toLocaleString()}`);
    console.log(`    Duration:     ${durationSec.toFixed(2)} sec`);
    console.log(`    Data Size:    ${(dataSize / 1024).toFixed(1)} KB`);
    console.log('');

    // Sanity checks
    const errors = [];
    if (audioFormat !== 1) errors.push('Expected PCM format');
    if (numChannels !== 1) errors.push(`Expected mono, got ${numChannels} channels`);
    if (sampleRate < 1000) errors.push(`Unexpected low sample rate: ${sampleRate}`);
    if (numSamples < 100) errors.push(`Very few samples: ${numSamples}`);
    if (wavSize < 1000) errors.push(`WAV file suspiciously small: ${wavSize} bytes`);

    if (errors.length > 0) {
        console.error('WARNINGS:');
        for (const e of errors) console.error(`  - ${e}`);
        console.log('');
    }

    // Check all 3 components exist (Bx, By, Bz)
    if (files.length === 3) {
        console.log('PASS: All 3 GSE components (Bx, By, Bz) returned.');
    } else {
        console.warn(`NOTE: Expected 3 components, got ${files.length}.`);
    }

    console.log('PASS: THEMIS FGM audio fetch successful!');
    console.log('');
    console.log('=== Test Complete ===');
}

testFGMFetch().catch(err => {
    console.error('Unhandled error:', err);
    process.exit(1);
});
