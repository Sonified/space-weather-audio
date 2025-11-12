#!/usr/bin/env node
/**
 * IRIS Transfer Speed Test
 * Tests download speeds for various duration chunks (2, 4, 6, 8, 12, 24 hours)
 * Uses historical data (48 hours ago → 24 hours ago) for reliable availability
 */

const https = require('https');
const fs = require('fs');

// Test configuration
const CONFIG = {
    network: 'HV',
    station: 'OBL',
    location: '--',
    channel: 'HHZ',
    durations: [2, 4, 6, 8, 12, 24],  // hours to test
    hoursAgo: 48,  // Start time (48 hours ago for reliable data)
};

function fetchFromIRIS(url) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        let firstByteTime = null;
        const chunks = [];
        
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                return;
            }
            
            res.on('data', (chunk) => {
                if (firstByteTime === null) {
                    firstByteTime = Date.now() - startTime;
                }
                chunks.push(chunk);
            });
            
            res.on('end', () => {
                const totalTime = Date.now() - startTime;
                const buffer = Buffer.concat(chunks);
                
                resolve({
                    buffer,
                    totalTime,
                    firstByteTime,
                    size: buffer.length
                });
            });
            
            res.on('error', reject);
        }).on('error', reject);
    });
}

function formatTime(date) {
    return date.toISOString().split('.')[0];
}

async function testDuration(hours) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`Testing ${hours}-hour chunk`);
    console.log('='.repeat(80));
    
    const now = new Date();
    // Start at 48 hours ago, move FORWARD toward present
    const startTime = new Date(now.getTime() - CONFIG.hoursAgo * 60 * 60 * 1000);
    const endTime = new Date(startTime.getTime() + hours * 60 * 60 * 1000);
    
    console.log(`Time range: ${formatTime(startTime)} to ${formatTime(endTime)}`);
    console.log(`Station: ${CONFIG.network}.${CONFIG.station}.${CONFIG.location}.${CONFIG.channel}`);
    
    const url = `https://service.iris.edu/fdsnws/dataselect/1/query?` +
                `net=${CONFIG.network}&sta=${CONFIG.station}&loc=${CONFIG.location}&cha=${CONFIG.channel}` +
                `&start=${formatTime(startTime)}&end=${formatTime(endTime)}&format=miniseed`;
    
    console.log(`Fetching...`);
    
    try {
        const result = await fetchFromIRIS(url);
        
        const sizeMB = result.size / (1024 * 1024);
        const totalSec = result.totalTime / 1000;
        const speedMBps = sizeMB / totalSec;
        const ttfbSec = result.firstByteTime / 1000;
        
        console.log(`\n✅ SUCCESS`);
        console.log(`   Size:          ${result.size.toLocaleString()} bytes (${sizeMB.toFixed(2)} MB)`);
        console.log(`   TTFB:          ${ttfbSec.toFixed(3)} seconds`);
        console.log(`   Total time:    ${totalSec.toFixed(3)} seconds`);
        console.log(`   Speed:         ${speedMBps.toFixed(2)} MB/s`);
        console.log(`   Per hour:      ${(result.size / hours).toLocaleString()} bytes/hour`);
        
        return {
            duration_hours: hours,
            size_bytes: result.size,
            size_mb: sizeMB,
            ttfb_sec: ttfbSec,
            total_sec: totalSec,
            speed_mbps: speedMBps,
            success: true
        };
        
    } catch (error) {
        console.log(`\n❌ FAILED: ${error.message}`);
        return {
            duration_hours: hours,
            success: false,
            error: error.message
        };
    }
}

async function main() {
    console.log('================================================================================');
    console.log('IRIS Transfer Speed Test');
    console.log('================================================================================');
    console.log(`Testing station: ${CONFIG.network}.${CONFIG.station}.${CONFIG.location}.${CONFIG.channel}`);
    console.log(`Historical data: ${CONFIG.hoursAgo} hours ago → ${CONFIG.hoursAgo - 24} hours ago`);
    console.log(`Durations to test: ${CONFIG.durations.join(', ')} hours`);
    console.log('================================================================================');
    
    const results = [];
    
    for (const hours of CONFIG.durations) {
        const result = await testDuration(hours);
        results.push(result);
        
        // Small delay between tests to be nice to IRIS
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Summary
    console.log(`\n${'='.repeat(80)}`);
    console.log('SUMMARY');
    console.log('='.repeat(80));
    console.log(`\nDuration | Size (MB) | TTFB (s) | Total (s) | Speed (MB/s) | Status`);
    console.log('-'.repeat(80));
    
    for (const r of results) {
        if (r.success) {
            const status = r.total_sec < 30 ? '✅ PASS' : '⚠️  SLOW';
            console.log(`${r.duration_hours.toString().padStart(3)}h     | ` +
                       `${r.size_mb.toFixed(2).padStart(8)} | ` +
                       `${r.ttfb_sec.toFixed(3).padStart(8)} | ` +
                       `${r.total_sec.toFixed(3).padStart(9)} | ` +
                       `${r.speed_mbps.toFixed(2).padStart(12)} | ${status}`);
        } else {
            console.log(`${r.duration_hours.toString().padStart(3)}h     | ` +
                       `     N/A |      N/A |       N/A |          N/A | ❌ FAIL`);
        }
    }
    
    console.log('='.repeat(80));
    
    // Success criteria
    console.log(`\n📊 SUCCESS CRITERIA:`);
    const criteria = [
        { hours: 2, maxTime: 3 },
        { hours: 4, maxTime: 5 },
        { hours: 6, maxTime: 8 },
        { hours: 8, maxTime: 10 },
        { hours: 12, maxTime: 15 },
        { hours: 24, maxTime: 30 }
    ];
    
    for (const c of criteria) {
        const result = results.find(r => r.duration_hours === c.hours);
        if (result && result.success) {
            const pass = result.total_sec < c.maxTime;
            console.log(`   ${c.hours}h < ${c.maxTime}s: ${pass ? '✅ PASS' : '❌ FAIL'} (${result.total_sec.toFixed(1)}s)`);
        } else {
            console.log(`   ${c.hours}h < ${c.maxTime}s: ❌ FAIL (no data)`);
        }
    }
    
    // Save results
    const outputDir = 'tests/test_logs';
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const outputFile = `${outputDir}/iris_transfer_speed_results.json`;
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`\n💾 Results saved to: ${outputFile}`);
    
    console.log('\n================================================================================');
}

main().catch(console.error);

