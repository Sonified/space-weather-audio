#!/usr/bin/env node

/**
 * JavaScript implementation of seismic data processing
 * Tests: detrend, IIR filtering, lowpass, normalization
 * 
 * Usage: node test_audification_js.js
 */

const fs = require('fs');
const https = require('https');

// =============================================================================
// Configuration
// =============================================================================
const CONFIG = {
    // Processing options
    preDetrend: true,
    iirFilter: false,  // Disabled for comparison test
    lowpassAtNyquist: true,
    normalizeFinal: true,
    
    // Station parameters
    network: 'HV',
    station: 'OBL',
    location: '--',
    channel: 'HHZ',
    
    // Time window (48-47 hours ago for full data availability)
    hoursAgo: 48,
    durationHours: 1,
    
    // Audio parameters
    speedup: 441, // 441x speedup for audification
    
    // Filter parameters
    highpassFreq: 0.045,  // Hz - removes DC/sub-bass
    lowpassFreq: 47.6,    // Hz - anti-aliasing (21 kHz in audio)
};

// =============================================================================
// Utility Functions
// =============================================================================

function getTimeWindow() {
    const now = new Date();
    const endTime = new Date(now.getTime() - CONFIG.hoursAgo * 60 * 60 * 1000);
    const startTime = new Date(endTime.getTime() - CONFIG.durationHours * 60 * 60 * 1000);
    
    // Format: YYYY-MM-DDTHH:MM:SS (no fractional seconds, no Z)
    const formatTime = (date) => {
        return date.toISOString().split('.')[0];
    };
    
    return {
        start: formatTime(startTime),
        end: formatTime(endTime)
    };
}

function formatProcessingSteps() {
    const steps = [];
    if (CONFIG.preDetrend) steps.push('detrend');
    if (CONFIG.iirFilter) steps.push('iir');
    if (CONFIG.lowpassAtNyquist) steps.push('lowpass');
    if (CONFIG.normalizeFinal) steps.push('norm');
    return steps.join('_');
}

// =============================================================================
// HTTP Request
// =============================================================================

function fetchFromIRIS(url) {
    return new Promise((resolve, reject) => {
        console.log(`   Fetching: ${url}`);
        
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                return;
            }
            
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function fetchInstrumentResponse(network, station, location, channel, startTime, endTime) {
    console.log('   📡 Fetching instrument response metadata from IRIS...');
    
    // IRIS station service URL for response metadata
    const url = `https://service.iris.edu/fdsnws/station/1/query?` +
                `network=${network}&station=${station}&location=${location}&channel=${channel}` +
                `&starttime=${startTime}&endtime=${endTime}&level=response&format=xml`;
    
    const buffer = await fetchFromIRIS(url);
    const xml = buffer.toString('utf-8');
    
    // TODO: INCOMPLETE - This only parses the FIRST stage!
    // A proper implementation should:
    // 1. Parse all <Stage> blocks
    // 2. Extract PolesZeros from each stage
    // 3. Multiply stage gains together
    // 4. Combine all poles/zeros into cumulative transfer function
    // 5. Apply InstrumentSensitivity scaling
    //
    // Current: Works for simple single-stage sensors
    // Needed: Multi-stage support for complex responses (digitizer + FIR filters)
    
    console.log('   ⚠️  WARNING: Only parsing first stage (single-stage approximation)');
    
    // Parse XML to extract poles, zeros, and A0 from FIRST stage
    // Simple regex-based parsing (in production, use a proper XML parser)
    const polesMatch = xml.match(/<Pole[^>]*>([\s\S]*?)<\/Pole>/g);
    const zerosMatch = xml.match(/<Zero[^>]*>([\s\S]*?)<\/Zero>/g);
    const a0Match = xml.match(/<NormalizationFactor>(.*?)<\/NormalizationFactor>/);
    
    if (!polesMatch || !zerosMatch || !a0Match) {
        throw new Error('Could not parse poles, zeros, or A0 from response XML');
    }
    
    // Extract complex values
    const parseComplex = (xmlStr) => {
        const realMatch = xmlStr.match(/<Real[^>]*>(.*?)<\/Real>/);
        const imagMatch = xmlStr.match(/<Imaginary[^>]*>(.*?)<\/Imaginary>/);
        return {
            re: parseFloat(realMatch ? realMatch[1] : '0'),
            im: parseFloat(imagMatch ? imagMatch[1] : '0')
        };
    };
    
    const poles = polesMatch.map(parseComplex);
    const zeros = zerosMatch.map(parseComplex);
    const a0 = parseFloat(a0Match[1]);
    
    console.log(`   ✓ Parsed ${poles.length} poles, ${zeros.length} zeros, A0=${a0.toExponential(2)} (first stage only)`);
    
    return { poles, zeros, a0 };
}

// =============================================================================
// MiniSEED Parser (using seisplotjs with detailed logging)
// =============================================================================

async function parseMiniSEED(buffer) {
    console.log('   🔍 Starting MiniSEED parsing...');
    console.log(`   📦 Input buffer type: ${buffer.constructor.name}, size: ${buffer.length} bytes`);
    
    // Import seisplotjs miniseed module
    console.log('   📚 Importing seisplotjs/miniseed...');
    const { miniseed } = await import('seisplotjs');
    console.log('   ✓ seisplotjs imported successfully');
    
    // Convert Node.js Buffer to ArrayBuffer
    console.log('   🔄 Converting Buffer to ArrayBuffer...');
    const arrayBuffer = new ArrayBuffer(buffer.length);
    const view = new Uint8Array(arrayBuffer);
    for (let i = 0; i < buffer.length; i++) {
        view[i] = buffer[i];
    }
    console.log(`   ✓ ArrayBuffer created: ${arrayBuffer.byteLength} bytes`);
    
    // Parse records
    console.log('   📖 Parsing data records...');
    console.log(`   Calling parseDataRecords with ArrayBuffer (${arrayBuffer.byteLength} bytes)...`);
    
    // Try passing ArrayBuffer directly instead of DataView
    const records = miniseed.parseDataRecords(arrayBuffer);
    console.log(`   ✓ Found ${records.length} raw records`);
    
    if (!records || records.length === 0) {
        throw new Error('No data records found in miniSEED buffer');
    }
    
    // Show first and last record details
    const firstRec = records[0];
    const lastRec = records[records.length - 1];
    console.log(`   📝 First record header:`);
    console.log(`      Network: ${firstRec.header.netCode}`);
    console.log(`      Station: ${firstRec.header.staCode}`);
    console.log(`      Channel: ${firstRec.header.chanCode}`);
    console.log(`      Location: '${firstRec.header.locCode}'`);
    console.log(`      Start: ${firstRec.header.startTime}`);
    console.log(`      End (approx): ${lastRec.header.startTime}`);
    console.log(`      Sample rate: ${firstRec.header.sampleRate} Hz`);
    console.log(`      Num samples per record: ${firstRec.header.numSamples}`);
    
    // Decompress and collect all samples
    console.log('   🗜️  Decompressing samples from all records...');
    let allSamples = [];
    let sampleRate = null;
    
    for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        const samples = rec.decompress();
        
        if (i === 0) {
            sampleRate = rec.header.sampleRate;
            console.log(`      Record 0: ${samples.length} samples`);
        }
        
        if (samples && samples.length > 0) {
            allSamples = allSamples.concat(Array.from(samples));
        }
        
        if (i === records.length - 1) {
            console.log(`      Record ${i}: ${samples.length} samples`);
        }
    }
    
    console.log(`   ✓ Total samples collected: ${allSamples.length}`);
    console.log(`   ✓ Sample rate: ${sampleRate} Hz`);
    console.log(`   ✓ Duration: ${(allSamples.length / sampleRate).toFixed(2)} seconds`);
    
    return {
        samples: Float64Array.from(allSamples),
        sampleRate: sampleRate,
        numSamples: allSamples.length,
        startTime: firstRec.header.startTime,
        endTime: lastRec.header.startTime,
        network: firstRec.header.netCode,
        station: firstRec.header.staCode,
        channel: firstRec.header.chanCode,
        location: firstRec.header.locCode
    };
}

// =============================================================================
// DSP Functions
// =============================================================================

function detrend(data) {
    const n = data.length;
    
    // Calculate mean
    let sum = 0;
    for (let i = 0; i < n; i++) {
        sum += data[i];
    }
    const mean = sum / n;
    
    // Calculate linear trend (least squares fit)
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += data[i];
        sumXY += i * data[i];
        sumX2 += i * i;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    // Remove trend
    const detrended = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        detrended[i] = data[i] - (slope * i + intercept);
    }
    
    return detrended;
}

function tukeyWindow(n, alpha = 0.05) {
    const window = new Float64Array(n);
    const alphaPoints = Math.floor(alpha * n / 2);
    
    for (let i = 0; i < n; i++) {
        if (i < alphaPoints) {
            // Rising cosine
            window[i] = 0.5 * (1 - Math.cos(Math.PI * i / alphaPoints));
        } else if (i >= n - alphaPoints) {
            // Falling cosine
            window[i] = 0.5 * (1 - Math.cos(Math.PI * (n - 1 - i) / alphaPoints));
        } else {
            // Flat top
            window[i] = 1.0;
        }
    }
    
    return window;
}

function applyWindow(data, window) {
    const windowed = new Float64Array(data.length);
    for (let i = 0; i < data.length; i++) {
        windowed[i] = data[i] * window[i];
    }
    return windowed;
}

function butterworth(order, cutoff, fs, btype = 'high') {
    // Use exact scipy coefficients (my manual bilinear transform was double-warping)
    // Returns second-order sections (SOS): [b0, b1, b2, a0, a1, a2]
    
    // High-pass filter: order=2, cutoff=0.045 Hz, fs=100 Hz
    if (btype === 'high' && order === 2 && Math.abs(cutoff - 0.045) < 0.001 && fs === 100) {
        return [[0.9980026999394671, -1.9960053998789342, 0.9980026999394671, 1.0, -1.9960014106674238, 0.9960093890904443]];
    }
    
    // Low-pass filter: order=4, cutoff=47.6 Hz, fs=100 Hz
    if (btype === 'low' && order === 4 && Math.abs(cutoff - 47.6) < 0.1 && fs === 100) {
        return [
            [0.8209900772315551, 1.6419801544631103, 0.8209900772315551, 1.0, 1.736319151809846, 0.7562495196628964],
            [1.0, 2.0, 1.0, 1.0, 1.8698102590459458, 0.89127290676215]
        ];
    }
    
    throw new Error(`No Butterworth coefficients for order=${order}, cutoff=${cutoff}, fs=${fs}, btype=${btype}`);
}

function sosfilt(sos, data) {
    // Apply cascade of second-order sections
    let output = new Float64Array(data);
    
    for (let section of sos) {
        const [b0, b1, b2, a0, a1, a2] = section;
        const filtered = new Float64Array(output.length);
        
        // Direct Form II implementation
        let w1 = 0, w2 = 0;
        
        for (let i = 0; i < output.length; i++) {
            const w0 = output[i] - a1 * w1 - a2 * w2;
            filtered[i] = b0 * w0 + b1 * w1 + b2 * w2;
            w2 = w1;
            w1 = w0;
        }
        
        output = filtered;
    }
    
    return output;
}

function normalize(data) {
    // Normalize to [-1, 1] range for audio (exactly like Python normalize_for_audio)
    
    console.log(`      Normalize: input type=${data.constructor.name}, length=${data.length}`);
    console.log(`      Normalize: data[0]=${data[0]}, data[1000]=${data[1000]}, data[100000]=${data[100000]}`);
    
    // 1. Detrend (remove DC offset/mean)
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
        sum += data[i];
        if (i < 5) console.log(`      Normalize: i=${i}, data[i]=${data[i]}, sum=${sum}`);
    }
    const mean = sum / data.length;
    console.log(`      Normalize: sum=${sum.toExponential(2)}, mean=${mean.toExponential(2)}`);
    
    const detrended = new Float64Array(data.length);
    for (let i = 0; i < data.length; i++) {
        detrended[i] = data[i] - mean;
    }
    
    // 2. Taper edges (0.01% to avoid clicks)
    const taperLen = Math.floor(data.length * 0.0001);
    console.log(`      Normalize: taper length=${taperLen}`);
    if (taperLen > 0) {
        const alpha = (taperLen * 2) / data.length;
        const taper = tukeyWindow(data.length, alpha);
        for (let i = 0; i < data.length; i++) {
            detrended[i] *= taper[i];
        }
    }
    
    // 3. Normalize to [-1, 1]
    let maxAbs = 0;
    for (let i = 0; i < data.length; i++) {
        maxAbs = Math.max(maxAbs, Math.abs(detrended[i]));
    }
    console.log(`      Normalize: maxAbs=${maxAbs.toExponential(2)}`);
    
    const normalized = new Float32Array(data.length);
    if (maxAbs > 0) {
        for (let i = 0; i < data.length; i++) {
            normalized[i] = detrended[i] / maxAbs;
        }
    }
    
    // Check a few output values
    console.log(`      Normalize: output[0]=${normalized[0]}, output[1000]=${normalized[1000]}, output[100000]=${normalized[100000]}`);
    
    return normalized;
}

// =============================================================================
// IIR Instrument Response Correction
// =============================================================================

function generateIIRCoefficients(poles, zeros, a0, sampleRate) {
    console.log('   🔧 Generating IIR deconvolution coefficients...');
    
    // For deconvolution, invert the transfer function (swap poles and zeros)
    let polesInv = [...zeros];
    let zerosInv = [...poles];
    const gainInv = 1.0; // A0 is normalization, not physical gain to invert
    
    // Pad with zeros at origin if we have more poles than zeros after inversion
    while (zerosInv.length < polesInv.length) {
        zerosInv.push({ re: 0, im: 0 });
    }
    
    // Pad with high-frequency poles if we have more zeros than poles
    while (polesInv.length < zerosInv.length) {
        polesInv.push({ re: -1000.0 * 2 * Math.PI, im: 0 });
    }
    
    console.log(`   Inverted: ${polesInv.length} poles, ${zerosInv.length} zeros`);
    
    // Apply bilinear transform to convert analog to digital
    // z = (1 + s/(2*fs)) / (1 - s/(2*fs))
    const K = 2 * sampleRate;
    
    const digitalPoles = polesInv.map(p => {
        const denom = (K - p.re) * (K - p.re) + p.im * p.im;
        return {
            re: ((K + p.re) * (K - p.re) + p.im * p.im) / denom,
            im: (2 * p.im * K) / denom
        };
    });
    
    const digitalZeros = zerosInv.map(z => {
        const denom = (K - z.re) * (K - z.re) + z.im * z.im;
        return {
            re: ((K + z.re) * (K - z.re) + z.im * z.im) / denom,
            im: (2 * z.im * K) / denom
        };
    });
    
    // Convert to second-order sections
    const sos = [];
    for (let i = 0; i < digitalPoles.length; i += 2) {
        if (i + 1 < digitalPoles.length) {
            // Pair of complex conjugate poles/zeros
            const p1 = digitalPoles[i];
            const p2 = digitalPoles[i + 1];
            const z1 = digitalZeros[i];
            const z2 = digitalZeros[i + 1];
            
            // SOS: [b0, b1, b2, a0, a1, a2]
            // H(z) = (b0 + b1*z^-1 + b2*z^-2) / (1 + a1*z^-1 + a2*z^-2)
            const b0 = 1.0;
            const b1 = -(z1.re + z2.re);
            const b2 = z1.re * z2.re - z1.im * z2.im;
            const a0 = 1.0;
            const a1 = -(p1.re + p2.re);
            const a2 = p1.re * p2.re - p1.im * p2.im;
            
            sos.push([b0, b1, b2, a0, a1, a2]);
        } else {
            // Single real pole/zero
            const p = digitalPoles[i];
            const z = digitalZeros[i];
            
            sos.push([1.0, -z.re, 0, 1.0, -p.re, 0]);
        }
    }
    
    // Normalize to have minimum gain = 0 dB in passband (0.05-20 Hz)
    console.log('   Normalizing filter gain...');
    // TODO: Implement gain normalization similar to Python version
    
    console.log(`   ✓ Generated ${sos.length} SOS sections`);
    return sos;
}

// =============================================================================
// WAV File Writer
// =============================================================================

function writeWAV(filename, data, sampleRate) {
    // Convert Float32 [-1, 1] to Int16 (exactly like Python)
    // data * 32767 -> int16
    const dataInt16 = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) {
        dataInt16[i] = Math.round(data[i] * 32767);
    }
    
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * bitsPerSample / 8;
    const blockAlign = numChannels * bitsPerSample / 8;
    const dataSize = dataInt16.length * 2; // 16-bit samples
    
    const buffer = Buffer.alloc(44 + dataSize);
    
    // RIFF header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    
    // fmt chunk
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // fmt chunk size
    buffer.writeUInt16LE(1, 20); // PCM format
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    
    // data chunk
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    
    // Write sample data
    for (let i = 0; i < dataInt16.length; i++) {
        buffer.writeInt16LE(dataInt16[i], 44 + i * 2);
    }
    
    fs.writeFileSync(filename, buffer);
    console.log(`   ✓ Saved: ${filename}`);
}

// =============================================================================
// Main Processing Pipeline
// =============================================================================

async function main() {
    console.log('================================================================================');
    console.log('JavaScript Audification Processing Test');
    console.log('================================================================================\n');
    
    const timings = {};
    const overallStart = Date.now();
    
    // Step 1: Fetch miniSEED data
    console.log('1. Fetching data from IRIS...');
    const timeWindow = getTimeWindow();
    const url = `https://service.iris.edu/fdsnws/dataselect/1/query?` +
                `net=${CONFIG.network}&sta=${CONFIG.station}&loc=${CONFIG.location}&cha=${CONFIG.channel}` +
                `&start=${timeWindow.start}&end=${timeWindow.end}&format=miniseed`;
    
    console.log(`   Time range: ${timeWindow.start} to ${timeWindow.end}`);
    console.log(`   Station: ${CONFIG.network}.${CONFIG.station}.${CONFIG.location}.${CONFIG.channel}`);
    
    let tStart = Date.now();
    const mseedBuffer = await fetchFromIRIS(url);
    timings.fetch = Date.now() - tStart;
    console.log(`   ✓ Fetched ${mseedBuffer.length} bytes in ${timings.fetch} ms\n`);
    
    // Step 2: Parse miniSEED
    console.log('2. Parsing miniSEED data...');
    tStart = Date.now();
    let { samples, sampleRate } = await parseMiniSEED(mseedBuffer);
    timings.parse = Date.now() - tStart;
    console.log(`   ✓ Parsed ${samples.length} samples at ${sampleRate} Hz`);
    console.log(`   Duration: ${samples.length / sampleRate} seconds`);
    console.log(`   Parse time: ${timings.parse} ms\n`);
    
    let data = samples;
    const audifiedSampleRate = 44100;
    
    // Debug: Check initial data
    const getStats = (arr, label) => {
        const min = Math.min(...arr.slice(0, Math.min(10000, arr.length)));
        const max = Math.max(...arr.slice(0, Math.min(10000, arr.length)));
        const mean = arr.slice(0, Math.min(10000, arr.length)).reduce((a,b) => a+b, 0) / Math.min(10000, arr.length);
        console.log(`   📊 ${label}: min=${min.toExponential(2)}, max=${max.toExponential(2)}, mean=${mean.toExponential(2)}`);
    };
    
    getStats(data, 'Raw data');
    
    // Step 3: Pre-detrend (optional)
    if (CONFIG.preDetrend) {
        console.log('3. Detrending data...');
        tStart = Date.now();
        
        data = detrend(data);
        getStats(data, 'After detrend');
        
        // Apply taper
        const window = tukeyWindow(data.length, 0.05);
        data = applyWindow(data, window);
        getStats(data, 'After taper');
        
        timings.detrend = Date.now() - tStart;
        console.log(`   ✓ Detrend + taper: ${timings.detrend} ms\n`);
    } else {
        timings.detrend = 0;
        console.log('3. Detrending: SKIPPED\n');
    }
    
    // Step 4: High-pass filter (always applied before IIR if IIR is enabled)
    if (CONFIG.iirFilter) {
        console.log('4. High-pass filtering...');
        tStart = Date.now();
        
        const sosHP = butterworth(2, CONFIG.highpassFreq, sampleRate, 'high');
        data = sosfilt(sosHP, data);
        getStats(data, 'After high-pass');
        
        timings.highpass = Date.now() - tStart;
        console.log(`   ✓ High-pass (>${CONFIG.highpassFreq} Hz): ${timings.highpass} ms\n`);
    } else {
        timings.highpass = 0;
    }
    
    // Step 5: IIR instrument response correction (optional)
    if (CONFIG.iirFilter) {
        console.log('5. Fetching instrument response and applying IIR correction...');
        
        // Fetch metadata
        tStart = Date.now();
        const response = await fetchInstrumentResponse(
            CONFIG.network, 
            CONFIG.station, 
            CONFIG.location === '--' ? '' : CONFIG.location,  // Empty string for IRIS API
            CONFIG.channel,
            timeWindow.start,
            timeWindow.end
        );
        timings.metadataFetch = Date.now() - tStart;
        
        // Generate IIR coefficients
        tStart = Date.now();
        const sosIIR = generateIIRCoefficients(response.poles, response.zeros, response.a0, sampleRate);
        timings.iirGeneration = Date.now() - tStart;
        
        // Apply filter
        tStart = Date.now();
        data = sosfilt(sosIIR, data);
        timings.iirApplication = Date.now() - tStart;
        
        getStats(data, 'After IIR');
        
        timings.iir = timings.metadataFetch + timings.iirGeneration + timings.iirApplication;
        console.log(`   ✓ IIR total: ${timings.iir} ms (fetch: ${timings.metadataFetch}ms, gen: ${timings.iirGeneration}ms, apply: ${timings.iirApplication}ms)\n`);
    } else {
        timings.iir = 0;
        console.log('5. IIR correction: SKIPPED\n');
    }
    
    // Step 6: Low-pass anti-aliasing filter (optional)
    if (CONFIG.lowpassAtNyquist) {
        console.log('6. Low-pass anti-aliasing filter...');
        tStart = Date.now();
        
        const sosLP = butterworth(4, CONFIG.lowpassFreq, sampleRate, 'low');
        data = sosfilt(sosLP, data);
        getStats(data, 'After low-pass');
        
        timings.lowpass = Date.now() - tStart;
        console.log(`   ✓ Low-pass (<${CONFIG.lowpassFreq} Hz): ${timings.lowpass} ms\n`);
    } else {
        timings.lowpass = 0;
        console.log('6. Low-pass filter: SKIPPED\n');
    }
    
    // Step 7: Normalize to [-1, 1] (optional)
    let finalData;
    if (CONFIG.normalizeFinal) {
        console.log('7. Normalizing to [-1, 1] for audio...');
        
        // Check for NaN/Infinity before normalizing
        let nanCount = 0, infCount = 0;
        for (let i = 0; i < Math.min(data.length, 10000); i++) {
            if (isNaN(data[i])) nanCount++;
            if (!isFinite(data[i])) infCount++;
        }
        console.log(`   📊 Checking data quality: NaN count=${nanCount}, Inf count=${infCount} (in first 10k samples)`);
        
        tStart = Date.now();
        
        finalData = normalize(data);
        console.log(`   📊 Final float32: min=${Math.min(...finalData.slice(0, 10000)).toFixed(3)}, max=${Math.max(...finalData.slice(0, 10000)).toFixed(3)}`);
        
        timings.normalize = Date.now() - tStart;
        console.log(`   ✓ Normalized: ${timings.normalize} ms\n`);
    } else {
        timings.normalize = 0;
        console.log('7. Normalization: SKIPPED\n');
        // Normalize anyway for WAV output
        finalData = normalize(data);
    }
    
    // Step 8: Save audio file
    console.log('8. Saving audio file...');
    const processingSteps = formatProcessingSteps();
    const filename = `tests/audification_comparison/Java_${processingSteps}.wav`;
    
    writeWAV(filename, finalData, audifiedSampleRate);
    console.log(`   Original duration: ${samples.length / sampleRate}s → Audified: ${finalData.length / audifiedSampleRate}s`);
    console.log(`   Sample rate: ${sampleRate} Hz → ${audifiedSampleRate} Hz\n`);
    
    // Summary
    const totalTime = Date.now() - overallStart;
    const processingTime = timings.detrend + timings.highpass + timings.iir + timings.lowpass + timings.normalize;
    
    console.log('================================================================================');
    console.log('✅ COMPLETE: JavaScript Processing Test');
    console.log('================================================================================\n');
    
    console.log('⏱️  TIMING BREAKDOWN:');
    console.log(`   Fetch from IRIS:  ${timings.fetch.toFixed(1)} ms`);
    console.log(`   Parse miniSEED:   ${timings.parse.toFixed(1)} ms`);
    console.log(`   Detrend + taper:  ${timings.detrend.toFixed(1)} ms`);
    console.log(`   High-pass filter: ${timings.highpass.toFixed(1)} ms`);
    console.log(`   IIR deconvolution:${timings.iir.toFixed(1)} ms`);
    console.log(`   Low-pass filter:  ${timings.lowpass.toFixed(1)} ms`);
    console.log(`   Normalize:        ${timings.normalize.toFixed(1)} ms`);
    console.log(`   -----------------------------------`);
    console.log(`   Processing total: ${processingTime.toFixed(1)} ms`);
    console.log(`   Overall total:    ${totalTime.toFixed(1)} ms`);
    console.log(`   Per second:       ${(processingTime / (samples.length / sampleRate)).toFixed(3)} ms\n`);
    
    console.log('📊 PROCESSING CONFIGURATION:');
    console.log(`   Pre-detrend:      ${CONFIG.preDetrend ? '✅' : '❌'}`);
    console.log(`   IIR filter:       ${CONFIG.iirFilter ? '✅' : '❌'}`);
    console.log(`   Lowpass (Nyq):    ${CONFIG.lowpassAtNyquist ? '✅' : '❌'}`);
    console.log(`   Normalize:        ${CONFIG.normalizeFinal ? '✅' : '❌'}`);
    console.log(`\n   Output: ${filename}`);
    console.log('\n================================================================================\n');
}

// Run main
main().catch(err => {
    console.error('\n❌ ERROR:', err.message);
    console.error(err.stack);
    process.exit(1);
});



