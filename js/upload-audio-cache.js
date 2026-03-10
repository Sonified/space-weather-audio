/**
 * upload-audio-cache.js
 * Browser utility to extract WAV files from IndexedDB and upload to Cloudflare R2.
 *
 * Usage (run in browser console on spaceweather.now.audio):
 *   import('/js/upload-audio-cache.js').then(m => m.uploadDefaultPSP())
 *
 * Or upload any cached entry:
 *   import('/js/upload-audio-cache.js').then(m => m.listCached().then(m.uploadEntry))
 */

import { initCache, listRecentSearches } from './cdaweb-cache.js';

function toBasicISO8601(isoString) {
    return isoString.replace(/\.\d{3}/g, '').replace(/-/g, '').replace(/:/g, '');
}

/**
 * List all cached entries in IndexedDB
 */
export async function listCached() {
    const entries = await listRecentSearches();
    console.log(`📦 ${entries.length} cached entries:`);
    entries.forEach((e, i) => {
        const blobCount = e.allComponentBlobs?.length || 1;
        const sizeKB = e.wavBlob ? (e.wavBlob.size / 1024).toFixed(1) : '?';
        console.log(`  [${i}] ${e.spacecraft} ${e.dataset} ${e.startTime} → ${e.endTime} (${blobCount} components, ${sizeKB} KB each)`);
    });
    return entries;
}

/**
 * Upload a cache entry's WAV blobs to Cloudflare R2
 * @param {Object|number} entryOrIndex - Cache entry object, or index from listCached()
 * @param {Array} [entries] - If entryOrIndex is a number, the entries array from listCached()
 */
export async function uploadEntry(entryOrIndex, entries) {
    let entry = entryOrIndex;
    if (typeof entryOrIndex === 'number') {
        if (!entries) {
            entries = await listRecentSearches();
        }
        entry = entries[entryOrIndex];
    }
    if (!entry) {
        console.error('❌ No entry found');
        return;
    }

    const { spacecraft, dataset, startTime, endTime, allComponentBlobs } = entry;
    const blobs = allComponentBlobs || [entry.wavBlob];
    const startBasic = toBasicISO8601(startTime);
    const endBasic = toBasicISO8601(endTime);
    // Use full Cloudflare URL when running from localhost
    const origin = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
        ? 'https://spaceweather.now.audio'
        : '';
    const baseUrl = `${origin}/api/audio-cache/${spacecraft}/${dataset}/${startBasic}/${endBasic}`;

    console.log(`☁️ Uploading ${blobs.length} WAV file(s) to ${baseUrl}`);

    for (let i = 0; i < blobs.length; i++) {
        const blob = blobs[i];
        if (!blob || !(blob instanceof Blob)) {
            console.warn(`  ⚠️ Skipping component ${i} (no blob)`);
            continue;
        }

        const filename = `${i}.wav`;
        const url = `${baseUrl}/${filename}`;
        const sizeKB = (blob.size / 1024).toFixed(1);

        console.log(`  📤 Uploading ${filename} (${sizeKB} KB)...`);

        const resp = await fetch(url, {
            method: 'PUT',
            body: blob,
            headers: { 'Content-Type': 'audio/wav' }
        });

        if (resp.ok) {
            const result = await resp.json();
            console.log(`  ✅ ${filename} uploaded (${result.size} bytes)`);
        } else {
            console.error(`  ❌ ${filename} failed: HTTP ${resp.status}`);
        }
    }

    console.log('☁️ Upload complete!');
}

/**
 * Upload the default PSP dataset (the Solar Portal default view)
 * PSP_FLD_L2_MAG_RTN, 2021-04-29 07:40 - 08:20
 */
export async function uploadDefaultPSP() {
    const entries = await listRecentSearches();
    const defaultEntry = entries.find(e =>
        e.spacecraft === 'PSP' &&
        e.dataset === 'PSP_FLD_L2_MAG_RTN' &&
        e.startTime.includes('2021-04-29')
    );

    if (!defaultEntry) {
        console.error('❌ Default PSP data not found in IndexedDB cache.');
        console.log('   Load it first by visiting spaceweather.now.audio and letting the default data fetch complete.');
        return;
    }

    console.log('🚀 Uploading default PSP dataset to Cloudflare...');
    await uploadEntry(defaultEntry);
}
