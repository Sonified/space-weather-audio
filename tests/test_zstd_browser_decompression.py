#!/usr/bin/env python3
"""
Test script to validate zstd decompression implementations for browser compatibility.

This script:
1. Creates test data matching backend/audio_stream.py format
2. Compresses with zstandard (same as backend)
3. Tests Python decompression (baseline)
4. Saves test files for browser testing
5. Generates HTML test page for browser library validation
"""

import zstandard as zstd
import struct
import json
import os
import numpy as np
from pathlib import Path

# Test data configuration
TEST_CONFIGS = [
    {
        'name': 'small',
        'samples': 36000,  # 1 hour @ 10 Hz (small test)
        'sample_rate': 10.0,
        'format': 'float32'
    },
    {
        'name': 'medium',
        'samples': 360000,  # 1 hour @ 100 Hz (typical seismic)
        'sample_rate': 100.0,
        'format': 'float32'
    },
    {
        'name': 'large',
        'samples': 3600000,  # 1 hour @ 1000 Hz (high sample rate)
        'sample_rate': 1000.0,
        'format': 'float32'
    }
]

def create_test_data(num_samples, sample_rate, seed=42):
    """Create deterministic synthetic seismic-like test data."""
    # Use fixed seed for reproducibility
    np.random.seed(seed)
    
    # Generate realistic seismic-like waveform (mix of frequencies)
    t = np.linspace(0, num_samples / sample_rate, num_samples)
    
    # Create waveform with multiple frequency components (deterministic)
    signal = (
        0.5 * np.sin(2 * np.pi * 0.1 * t) +  # Very low frequency
        0.3 * np.sin(2 * np.pi * 1.0 * t) +  # Low frequency
        0.2 * np.sin(2 * np.pi * 10.0 * t) + # Mid frequency
        0.1 * np.random.randn(num_samples)    # Deterministic noise (seed=42)
    )
    
    # Normalize to [-0.95, 0.95] range (same as backend)
    max_val = np.abs(signal).max()
    if max_val > 0:
        signal = (signal / max_val) * 0.95
    
    return signal.astype(np.float32)

def compress_like_backend(uncompressed_blob, level=3):
    """Compress data exactly like backend/audio_stream.py does."""
    compressor = zstd.ZstdCompressor(level=level)
    compressed_blob = compressor.compress(uncompressed_blob)
    return compressed_blob

def decompress_with_python(compressed_blob):
    """Decompress with Python zstandard (baseline verification)."""
    decompressor = zstd.ZstdDecompressor()
    decompressed = decompressor.decompress(compressed_blob)
    return decompressed

def create_test_file(config, output_dir):
    """Create a test file matching backend format."""
    print(f"\n📦 Creating {config['name']} test file...")
    print(f"   Samples: {config['samples']:,}")
    print(f"   Sample rate: {config['sample_rate']} Hz")
    
    # Create test data
    samples = create_test_data(config['samples'], config['sample_rate'])
    
    # Create metadata (matching backend format)
    metadata = {
        'network': 'HV',
        'station': 'TEST',
        'location': '',
        'channel': 'HHZ',
        'starttime': '2025-10-31T00:00:00.000000Z',
        'endtime': '2025-10-31T01:00:00.000000Z',
        'original_sample_rate': config['sample_rate'],
        'npts': len(samples),
        'duration_seconds': len(samples) / config['sample_rate'],
        'speedup': 200,
        'highpass_hz': 0.5,
        'normalized': True,
        'format': config['format'],
        'compressed': 'zstd',
        'obspy_decoder': True
    }
    
    # Create binary blob (matching backend format)
    metadata_json = json.dumps(metadata).encode('utf-8')
    metadata_length = len(metadata_json)
    
    # Convert samples to bytes
    if config['format'] == 'float32':
        samples_bytes = samples.tobytes()
    elif config['format'] == 'int32':
        samples_bytes = samples.astype(np.int32).tobytes()
    else:
        raise ValueError(f"Unknown format: {config['format']}")
    
    # Combine: [metadata_length (4 bytes)] [metadata_json] [samples]
    uncompressed_blob = (
        struct.pack('<I', metadata_length) +  # Little-endian uint32
        metadata_json +
        samples_bytes
    )
    
    print(f"   Uncompressed size: {len(uncompressed_blob):,} bytes ({len(uncompressed_blob)/1024/1024:.2f} MB)")
    
    # Compress with zstd (level 3, same as backend)
    compressed_blob = compress_like_backend(uncompressed_blob, level=3)
    compression_ratio = len(uncompressed_blob) / len(compressed_blob)
    print(f"   Compressed size: {len(compressed_blob):,} bytes ({len(compressed_blob)/1024/1024:.2f} MB)")
    print(f"   Compression ratio: {compression_ratio:.2f}x")
    
    # Verify Python decompression works
    print("   🔍 Verifying Python decompression...")
    decompressed = decompress_with_python(compressed_blob)
    
    if decompressed == uncompressed_blob:
        print("   ✅ Python decompression verified!")
    else:
        print(f"   ❌ Python decompression failed! Expected {len(uncompressed_blob)} bytes, got {len(decompressed)} bytes")
        return None
    
    # Verify metadata parsing
    view = struct.unpack('<I', decompressed[0:4])[0]
    metadata_length_check = view
    metadata_json_check = decompressed[4:4+metadata_length_check].decode('utf-8')
    metadata_check = json.loads(metadata_json_check)
    
    if metadata_check == metadata:
        print("   ✅ Metadata parsing verified!")
    else:
        print("   ⚠️  Metadata mismatch (but decompression works)")
    
    # Save compressed file
    output_file = output_dir / f"zstd_test_{config['name']}.bin"
    with open(output_file, 'wb') as f:
        f.write(compressed_blob)
    print(f"   💾 Saved: {output_file}")
    
    # Also save uncompressed for reference
    uncompressed_file = output_dir / f"zstd_test_{config['name']}_uncompressed.bin"
    with open(uncompressed_file, 'wb') as f:
        f.write(uncompressed_blob)
    
    # Save reference samples as JSON for browser validation
    # Take a sample of values (first 100, middle 100, last 100) for comparison
    sample_indices = list(range(0, min(100, len(samples)))) + \
                     list(range(len(samples)//2 - 50, len(samples)//2 + 50)) + \
                     list(range(max(0, len(samples) - 100), len(samples)))
    reference_samples = {
        'indices': sample_indices,
        'values': [float(samples[i]) for i in sample_indices],
        'all_samples_count': len(samples),
        'all_samples_hash': hash(samples.tobytes().hex()[:1000])  # Hash of first 1000 bytes as quick check
    }
    
    reference_file = output_dir / f"zstd_test_{config['name']}_reference.json"
    with open(reference_file, 'w') as f:
        json.dump({
            'metadata': metadata,
            'reference_samples': reference_samples,
            'full_blob_hash': hash(uncompressed_blob.hex()[:1000])  # Quick hash check
        }, f, indent=2)
    
    # Also save full samples as binary for byte-level comparison
    samples_file = output_dir / f"zstd_test_{config['name']}_samples.bin"
    with open(samples_file, 'wb') as f:
        f.write(samples_bytes)
    
    return {
        'config': config,
        'compressed_file': output_file,
        'uncompressed_file': uncompressed_file,
        'reference_file': reference_file,
        'samples_file': samples_file,
        'samples': samples,
        'samples_bytes': samples_bytes,
        'metadata': metadata,
        'compressed_size': len(compressed_blob),
        'uncompressed_size': len(uncompressed_blob),
        'compression_ratio': compression_ratio
    }

def generate_browser_test_html(test_results, output_dir):
    """Generate HTML test page for browser library validation."""
    html_content = '''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Zstd Browser Decompression Test</title>
    <style>
        body {
            font-family: monospace;
            max-width: 1200px;
            margin: 20px auto;
            padding: 20px;
            background: #1e1e1e;
            color: #d4d4d4;
        }
        h1 { color: #4ec9b0; }
        h2 { color: #569cd6; margin-top: 30px; }
        .test-case {
            background: #252526;
            border: 1px solid #3e3e42;
            border-radius: 4px;
            padding: 15px;
            margin: 10px 0;
        }
        .pass={color: #4ec9b0;}
        .fail { color: #f48771; }
        .info { color: #9cdcfe; }
        button {
            background: #0e639c;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            margin: 5px;
        }
        button:hover { background: #1177bb; }
        button:disabled { background: #3e3e42; cursor: not-allowed; }
        pre {
            background: #1e1e1e;
            padding: 10px;
            border-radius: 4px;
            overflow-x: auto;
        }
        .library-section {
            margin: 20px 0;
            padding: 15px;
            background: #2d2d30;
            border-radius: 4px;
        }
    </style>
</head>
<body>
    <h1>🧪 Zstd Browser Decompression Test</h1>
    <p class="info">Testing various JavaScript zstd libraries against backend-compressed data</p>
    
    <div id="status">Loading libraries...</div>
    
    <h2>Test Files</h2>
    <div id="test-files"></div>
    
    <h2>Library Tests</h2>
    <div id="library-tests"></div>
    
    <script>
        // Test files from Python script
        const TEST_FILES = {TEST_FILES_JSON};
        
        // Library configurations
        const LIBRARIES = [
            {
                name: 'fzstd',
                load: async () => {
                    if (typeof fzstd !== 'undefined') {
                        return { decompress: (data) => fzstd.decompress(data) };
                    }
                    // Try loading from CDN
                    const script = document.createElement('script');
                    script.src = 'https://cdn.jsdelivr.net/npm/fzstd@0.1.1/umd/index.min.js';
                    document.head.appendChild(script);
                    return new Promise((resolve, reject) => {
                        script.onload = () => {
                            if (typeof fzstd !== 'undefined') {
                                resolve({ decompress: (data) => fzstd.decompress(data) });
                            } else {
                                reject(new Error('fzstd not available'));
                            }
                        };
                        script.onerror = reject;
                    });
                }
            },
            {
                name: '@yoshihitoh/zstddec',
                load: async () => {
                    try {
                        const module = await import('https://unpkg.com/@yoshihitoh/zstddec@0.1.0/dist/index.js');
                        return { decompress: module.decompress };
                    } catch (e) {
                        throw new Error('Failed to load @yoshihitoh/zstddec: ' + e.message);
                    }
                }
            },
            {
                name: 'numcodecs.Zstd',
                load: async () => {
                    try {
                        const numcodecs = await import('https://cdn.jsdelivr.net/npm/numcodecs@0.3.1/+esm');
                        return {
                            decompress: async (data) => {
                                const codec = numcodecs.Zstd.fromConfig({ level: 3 });
                                return await codec.decode(data);
                            }
                        };
                    } catch (e) {
                        throw new Error('Failed to load numcodecs: ' + e.message);
                    }
                }
            }
        ];
        
        async function testLibrary(lib, testFile) {
            const results = [];
            
            try {
                console.log(`[${lib.name}] Loading library...`);
                const libInstance = await lib.load();
                console.log(`[${lib.name}] ✅ Library loaded`);
                
                // Fetch test file
                console.log(`[${lib.name}] Fetching ${testFile.name}...`);
                const response = await fetch(testFile.path);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                const compressed = new Uint8Array(await response.arrayBuffer());
                console.log(`[${lib.name}] ✅ Fetched ${compressed.length} bytes`);
                
                // Decompress
                const t0 = performance.now();
                let decompressed;
                if (libInstance.decompress.constructor.name === 'AsyncFunction') {
                    decompressed = await libInstance.decompress(compressed);
                } else {
                    decompressed = libInstance.decompress(compressed);
                }
                const t1 = performance.now();
                const decompressTime = (t1 - t0).toFixed(2);
                
                console.log(`[${lib.name}] ✅ Decompressed ${decompressed.length} bytes in ${decompressTime}ms`);
                
                // Verify format
                if (!(decompressed instanceof Uint8Array)) {
                    throw new Error(`Expected Uint8Array, got ${decompressed.constructor.name}`);
                }
                
                // Parse metadata
                const view = new DataView(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
                const metadataLength = view.getUint32(0, true);
                const metadataBytes = decompressed.slice(4, 4 + metadataLength);
                const metadataJson = new TextDecoder().decode(metadataBytes);
                const metadata = JSON.parse(metadataJson);
                
                // Verify sample count
                const samplesOffset = 4 + metadataLength;
                const samplesBytes = decompressed.slice(samplesOffset);
                const expectedSamples = testFile.expected_samples;
                const actualSamples = samplesBytes.length / 4; // float32 = 4 bytes
                
                if (Math.abs(actualSamples - expectedSamples) > 1) {
                    throw new Error(`Sample count mismatch: expected ${expectedSamples}, got ${actualSamples}`);
                }
                
                // Load reference data for comparison
                const referenceResponse = await fetch(testFile.reference_path);
                if (!referenceResponse.ok) {
                    throw new Error(`Failed to load reference: HTTP ${referenceResponse.status}`);
                }
                const reference = await referenceResponse.json();
                
                // Compare metadata exactly
                const metadataMatch = JSON.stringify(metadata) === JSON.stringify(reference.metadata);
                if (!metadataMatch) {
                    throw new Error('Metadata mismatch!');
                }
                
                // Load expected uncompressed blob for byte-level comparison
                const expectedResponse = await fetch(testFile.uncompressed_path);
                if (!expectedResponse.ok) {
                    throw new Error(`Failed to load expected data: HTTP ${expectedResponse.status}`);
                }
                const expectedBlob = new Uint8Array(await expectedResponse.arrayBuffer());
                
                // Byte-by-byte comparison
                let byteMatches = 0;
                let byteMismatches = 0;
                const maxMismatchesToReport = 10;
                const mismatches = [];
                
                if (decompressed.length !== expectedBlob.length) {
                    throw new Error(`Length mismatch: expected ${expectedBlob.length}, got ${decompressed.length}`);
                }
                
                for (let i = 0; i < decompressed.length; i++) {
                    if (decompressed[i] === expectedBlob[i]) {
                        byteMatches++;
                    } else {
                        byteMismatches++;
                        if (mismatches.length < maxMismatchesToReport) {
                            mismatches.push({ offset: i, expected: expectedBlob[i], actual: decompressed[i] });
                        }
                    }
                }
                
                if (byteMismatches > 0) {
                    throw new Error(`Byte mismatch: ${byteMismatches} bytes differ (${((byteMismatches/decompressed.length)*100).toFixed(4)}%). First mismatches: ${JSON.stringify(mismatches.slice(0, 5))}`);
                }
                
                // Sample value comparison (float32 precision)
                const decompressedSamples = new Float32Array(samplesBytes.buffer, samplesBytes.byteOffset, samplesBytes.length / 4);
                const referenceSamples = reference.reference_samples;
                let sampleMatches = 0;
                let sampleMismatches = 0;
                const sampleMismatchDetails = [];
                const FLOAT32_EPSILON = 1e-6; // Allow small floating point differences
                
                for (let i = 0; i < referenceSamples.indices.length; i++) {
                    const idx = referenceSamples.indices[i];
                    const expectedValue = referenceSamples.values[i];
                    const actualValue = decompressedSamples[idx];
                    const diff = Math.abs(actualValue - expectedValue);
                    
                    if (diff < FLOAT32_EPSILON) {
                        sampleMatches++;
                    } else {
                        sampleMismatches++;
                        if (sampleMismatchDetails.length < 5) {
                            sampleMismatchDetails.push({
                                index: idx,
                                expected: expectedValue,
                                actual: actualValue,
                                diff: diff
                            });
                        }
                    }
                }
                
                if (sampleMismatches > 0) {
                    throw new Error(`Sample value mismatch: ${sampleMismatches}/${referenceSamples.indices.length} reference samples differ. Details: ${JSON.stringify(sampleMismatchDetails)}`);
                }
                
                results.push({
                    success: true,
                    library: lib.name,
                    testFile: testFile.name,
                    compressedSize: compressed.length,
                    decompressedSize: decompressed.length,
                    decompressTime: decompressTime,
                    samples: actualSamples,
                    byteMatches: byteMatches,
                    byteMismatches: byteMismatches,
                    sampleMatches: sampleMatches,
                    sampleMismatches: sampleMismatches,
                    metadataMatch: metadataMatch,
                    verified: true
                });
                
            } catch (error) {
                console.error(`[${lib.name}] ❌ Error:`, error);
                results.push({
                    success: false,
                    library: lib.name,
                    testFile: testFile.name,
                    error: error.message
                });
            }
            
            return results;
        }
        
        async function runAllTests() {
            const statusDiv = document.getElementById('status');
            statusDiv.innerHTML = '<span class="info">Running tests...</span>';
            
            const allResults = [];
            
            // Test each library with each test file
            for (const lib of LIBRARIES) {
                for (const testFile of TEST_FILES) {
                    const results = await testLibrary(lib, testFile);
                    allResults.push(...results);
                }
            }
            
            // Display results
            displayResults(allResults);
            
            statusDiv.innerHTML = `<span class="pass">✅ Tests complete! Check results below.</span>`;
        }
        
        function displayResults(results) {
            const libraryTestsDiv = document.getElementById('library-tests');
            
            // Group by library
            const byLibrary = {};
            for (const result of results) {
                if (!byLibrary[result.library]) {
                    byLibrary[result.library] = [];
                }
                byLibrary[result.library].push(result);
            }
            
            let html = '';
            for (const [libName, libResults] of Object.entries(byLibrary)) {
                html += `<div class="library-section">`;
                html += `<h3>${libName}</h3>`;
                
                for (const result of libResults) {
                    if (result.success) {
                        html += `<div class="test-case">`;
                        html += `<span class="pass">✅ ${result.testFile}</span><br>`;
                        html += `Compressed: ${(result.compressedSize/1024).toFixed(1)} KB<br>`;
                        html += `Decompressed: ${(result.decompressedSize/1024/1024).toFixed(2)} MB<br>`;
                        html += `Time: ${result.decompressTime}ms<br>`;
                        html += `Samples: ${result.samples.toLocaleString()}<br>`;
                        if (result.verified) {
                            html += `<strong class="pass">✅ DATA VERIFIED:</strong><br>`;
                            html += `  Bytes: ${result.byteMatches.toLocaleString()} matched, ${result.byteMismatches} mismatched<br>`;
                            html += `  Samples: ${result.sampleMatches} matched, ${result.sampleMismatches} mismatched<br>`;
                            html += `  Metadata: ${result.metadataMatch ? '✅ Match' : '❌ Mismatch'}<br>`;
                        }
                        html += `</div>`;
                    } else {
                        html += `<div class="test-case">`;
                        html += `<span class="fail">❌ ${result.testFile}</span><br>`;
                        html += `Error: ${result.error}<br>`;
                        html += `</div>`;
                    }
                }
                
                html += `</div>`;
            }
            
            libraryTestsDiv.innerHTML = html;
        }
        
        // List test files
        const testFilesDiv = document.getElementById('test-files');
        let filesHtml = '';
        for (const testFile of TEST_FILES) {
            filesHtml += `<div class="test-case">`;
            filesHtml += `<strong>${testFile.name}</strong><br>`;
            filesHtml += `Expected samples: ${testFile.expected_samples.toLocaleString()}<br>`;
            filesHtml += `Sample rate: ${testFile.sample_rate} Hz<br>`;
            filesHtml += `Compressed size: ${(testFile.compressed_size/1024).toFixed(1)} KB<br>`;
            filesHtml += `</div>`;
        }
        testFilesDiv.innerHTML = filesHtml;
        
        // Auto-run tests when page loads
        window.addEventListener('load', () => {
            setTimeout(runAllTests, 1000);
        });
    </script>
    
    <!-- Load fzstd for testing -->
    <script src="https://cdn.jsdelivr.net/npm/fzstd@0.1.1/umd/index.min.js"></script>
</body>
</html>'''
    
    # Create JSON string for test files
    test_files_data = []
    for result in test_results:
        test_files_data.append({
            'name': result['config']['name'],
            'path': f"./zstd_test_{result['config']['name']}.bin",
            'reference_path': f"./zstd_test_{result['config']['name']}_reference.json",
            'uncompressed_path': f"./zstd_test_{result['config']['name']}_uncompressed.bin",
            'expected_samples': result['config']['samples'],
            'sample_rate': result['config']['sample_rate'],
            'compressed_size': result['compressed_size']
        })
    
    jsonstr = json.dumps(test_files_data, indent=8)
    html_content = html_content.replace('{TEST_FILES_JSON}', jsonstr)
    
    # Save HTML file
    html_file = output_dir / 'test_zstd_browser.html'
    with open(html_file, 'w') as f:
        f.write(html_content)
    print(f"\n📄 Generated browser test page: {html_file}")

def main():
    """Main test function."""
    print("=" * 70)
    print("🧪 Zstd Browser Decompression Test Generator")
    print("=" * 70)
    print("\nThis script creates test files matching backend/audio_stream.py format")
    print("and validates that various JavaScript zstd libraries can decompress them.\n")
    
    # Create output directory
    output_dir = Path(__file__).parent / 'zstd_browser_tests'
    output_dir.mkdir(exist_ok=True)
    print(f"📁 Output directory: {output_dir}\n")
    
    # Generate test files
    test_results = []
    for config in TEST_CONFIGS:
        result = create_test_file(config, output_dir)
        if result:
            test_results.append(result)
    
    # Generate browser test HTML
    if test_results:
        generate_browser_test_html(test_results, output_dir)
    
    print("\n" + "=" * 70)
    print("✅ Test file generation complete!")
    print("=" * 70)
    print(f"\n📂 Test files saved to: {output_dir}")
    print(f"🌐 Open {output_dir / 'test_zstd_browser.html'} in a browser to test libraries")
    print("\nNext steps:")
    print("1. Start a local HTTP server: python -m http.server 8000")
    print("2. Open http://localhost:8000/tests/zstd_browser_tests/test_zstd_browser.html")
    print("3. Check which libraries successfully decompress the test files")

if __name__ == '__main__':
    main()

