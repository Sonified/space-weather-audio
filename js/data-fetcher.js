// ========== CDAWEB AUDIO FETCHER ==========
// Fetches pre-audified WAV files from NASA CDAWeb and decodes them for visualization

import * as State from './audio-state.js';
import { PlaybackState } from './audio-state.js';
import { updatePlaybackIndicator, drawWaveform, startPlaybackIndicator } from './minimap-window-renderer.js';
import { updatePlaybackSpeed } from './audio-player.js';
import { updatePlaybackDuration } from './ui-controls.js';
import { drawFrequencyAxis, positionAxisCanvas, initializeAxisPlaybackRate } from './spectrogram-axis-renderer.js';
import { drawMinimapAxis, positionMinimapAxisCanvas } from './minimap-axis-renderer.js';
import { positionMinimapXAxisCanvas, drawMinimapXAxis, positionMinimapDateCanvas, drawMinimapDate } from './minimap-x-axis-renderer.js';
import { drawSpectrogramXAxis, positionSpectrogramXAxisCanvas } from './spectrogram-x-axis-renderer.js';
import { startCompleteVisualization, clearCompleteSpectrogram } from './main-window-renderer.js';
import { zoomState } from './zoom-state.js';
import { updateCompleteButtonState, loadRegionsAfterDataFetch } from './feature-tracker.js';
import { isStudyMode } from './master-modes.js';
import { storeAudioData, getAudioData, updateCacheWithAllComponents } from './cdaweb-cache.js';
import { log, logGroup, logGroupEnd } from './logger.js';

// ========== CONSOLE DEBUG FLAGS ==========
// Centralized reference for all debug flags across the codebase
// Set to true to enable detailed logging for each category
//
// Available flags:
//   DEBUG_CHUNKS (data-fetcher.js) - Chunk loading, downloading, and processing logs
//   DEBUG_WAVEFORM (waveform-renderer.js, waveform-worker.js) - Waveform building and rendering logs
//   DEBUG_AXIS (minimap-x-axis-renderer.js) - Axis drawing and tick rendering logs

// Debug flag for chunk loading logs (set to true to enable detailed logging)
const DEBUG_CHUNKS = false;

// CDAWeb API Configuration
const CDASWS_BASE_URL = 'https://cdaweb.gsfc.nasa.gov/WS/cdasr/1';
const DATAVIEW = 'sp_phys';  // Space Physics dataview

// Debug flag for domain separation logging
const DEBUG_DOMAINS = false;

// Dataset to variable mapping
const DATASET_VARIABLES = {
    'PSP_FLD_L2_MAG_RTN': 'psp_fld_l2_mag_RTN',
    'PSP_FLD_L2_MAG_RTN_4_SA_PER_CYC': 'psp_fld_l2_mag_RTN_4_Sa_per_Cyc',
    'WI_H2_MFI': 'BGSE', // Wind uses component names
    'MMS1_FGM_SRVY_L2': 'mms1_fgm_b_gse_srvy_l2',
    'MMS1_FGM_BRST_L2': 'mms1_fgm_b_gse_brst_l2',
    // THEMIS FGM - Fluxgate Magnetometer, low-res (~4 Hz) GSE coordinates
    'THA_L2_FGM': 'tha_fgl_gse',
    'THB_L2_FGM': 'thb_fgl_gse',
    'THC_L2_FGM': 'thc_fgl_gse',
    'THD_L2_FGM': 'thd_fgl_gse',
    'THE_L2_FGM': 'the_fgl_gse',
    // THEMIS SCM - fast-survey GSE coordinates (X, Y, Z components)
    'THA_L2_SCM': 'tha_scf_gse',
    'THB_L2_SCM': 'thb_scf_gse',
    'THC_L2_SCM': 'thc_scf_gse',
    'THD_L2_SCM': 'thd_scf_gse',
    'THE_L2_SCM': 'the_scf_gse',
    // Solar Orbiter MAG - RTN coordinates (Radial, Tangential, Normal)
    'SOLO_L2_MAG-RTN-NORMAL': 'B_RTN',
    'SOLO_L2_MAG-RTN-BURST': 'B_RTN',
    // GOES-R Series Magnetometer - GSE coordinates (X, Y, Z) at 10 Hz
    'DN_MAGN-L2-HIRES_G16': 'b_gse',
    'DN_MAGN-L2-HIRES_G19': 'b_gse',
    // GOES-16 1-second magnetometer L2 - GSM coordinates
    // MMS1 Electric Double Probe - DC E-field, GSE coordinates (Ex, Ey, Ez)
    'MMS1_EDP_SLOW_L2_DCE': 'mms1_edp_dce_gse_slow_l2',
    'MMS1_EDP_FAST_L2_DCE': 'mms1_edp_dce_gse_fast_l2',
    'MMS1_EDP_BRST_L2_DCE': 'mms1_edp_dce_gse_brst_l2',
    // MMS1 Search Coil Magnetometer - GSE coordinates (Bx, By, Bz)
    'MMS1_SCM_SRVY_L2_SCSRVY': 'mms1_scm_acb_gse_scsrvy_srvy_l2',
    'MMS1_SCM_BRST_L2_SCB': 'mms1_scm_acb_gse_scb_brst_l2',
    // THEMIS EFI - Electric Field Instrument, slow-survey GSE coordinates (Ex, Ey, Ez)
    'THA_L2_EFI': 'tha_efs_dot0_gse',
    // Voyager 1 & 2 - HG coordinates (Radial, Tangential, Normal)
    'VOYAGER1_2S_MAG': 'B1',
    'VOYAGER2_2S_MAG': 'B1',
    'THB_L2_EFI': 'thb_efs_dot0_gse',
    'THC_L2_EFI': 'thc_efs_dot0_gse',
    'THD_L2_EFI': 'thd_efs_dot0_gse',
    'THE_L2_EFI': 'the_efs_dot0_gse',
    // PSP FIELDS - Digital Fields Board DC differential voltage waveform
    'PSP_FLD_L2_DFB_WF_DVDC': 'psp_fld_l2_dfb_wf_dVdc_sensor',
    // Cluster FGM - Fluxgate Magnetometer, 5 vectors/sec GSE coordinates
    'C1_CP_FGM_5VPS': 'B_vec_xyz_gse__C1_CP_FGM_5VPS',
    'C2_CP_FGM_5VPS': 'B_vec_xyz_gse__C2_CP_FGM_5VPS',
    'C3_CP_FGM_5VPS': 'B_vec_xyz_gse__C3_CP_FGM_5VPS',
    'C4_CP_FGM_5VPS': 'B_vec_xyz_gse__C4_CP_FGM_5VPS',
    // Cluster STAFF - Search Coil Magnetometer, CWF GSE coordinates
    'C1_CP_STA_CWF_GSE': 'B_vec_xyz_Instrument__C1_CP_STA_CWF_GSE',
    'C2_CP_STA_CWF_GSE': 'B_vec_xyz_Instrument__C2_CP_STA_CWF_GSE',
    'C3_CP_STA_CWF_GSE': 'B_vec_xyz_Instrument__C3_CP_STA_CWF_GSE',
    'C4_CP_STA_CWF_GSE': 'B_vec_xyz_Instrument__C4_CP_STA_CWF_GSE',
    // Cluster EFW - Electric Field, ISR2 coordinates
    'C1_CP_EFW_L3_E3D_INERT': 'E_Vec_xyz_ISR2__C1_CP_EFW_L3_E3D_INERT',
    'C2_CP_EFW_L3_E3D_INERT': 'E_Vec_xyz_ISR2__C2_CP_EFW_L3_E3D_INERT',
    'C3_CP_EFW_L3_E3D_INERT': 'E_Vec_xyz_ISR2__C3_CP_EFW_L3_E3D_INERT',
    'C4_CP_EFW_L3_E3D_INERT': 'E_Vec_xyz_ISR2__C4_CP_EFW_L3_E3D_INERT',
    // Geotail - Magnetic Field (Editor-B, 3-sec GSE)
    'GE_EDB3SEC_MGF': 'BGSE',
    // Geotail - Electric Field Detector (spherical probe, sunward & duskward)
    'GE_K0_EFD': 'Es',
    // ACE - Magnetic Field Investigation, GSE coordinates (1 sec)
    'AC_H3_MFI': 'BGSEc',
    // Solar Orbiter RPW - Radio and Plasma Waves, LFR survey E-field
    'SOLO_L2_RPW-LFR-SURV-CWF-E': 'EDC'
};

/**
 * Check if this is the default PSP dataset that's pre-cached on Cloudflare.
 * Only this specific dataset/time range gets the Cloudflare fallback.
 */
function isDefaultPSPDataset(spacecraft, dataset, startTime, endTime) {
    return spacecraft === 'PSP' &&
        dataset === 'PSP_FLD_L2_MAG_RTN' &&
        startTime.includes('2021-04-29T07:40') &&
        endTime.includes('2021-04-29T08:20');
}

/**
 * Try fetching pre-cached WAV files from Cloudflare R2 audio cache.
 * Returns { blobs: [Blob, ...] } or null if not cached.
 */
async function fetchFromCloudflareAudioCache(spacecraft, dataset, startTime, endTime) {
    const startBasic = toBasicISO8601(startTime);
    const endBasic = toBasicISO8601(endTime);
    // Use full Cloudflare URL when running from localhost
    const origin = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
        ? 'https://spaceweather.now.audio'
        : '';
    const baseUrl = `${origin}/api/audio-cache/${spacecraft}/${dataset}/${startBasic}/${endBasic}`;

    // Check what components are available
    const listResp = await fetch(baseUrl);
    if (!listResp.ok) return null;

    const listing = await listResp.json();
    if (!listing.components || listing.components.length === 0) return null;

    console.log(`☁️ Cloudflare cache hit: ${listing.components.length} WAV file(s)`);

    // Download all component WAVs in parallel
    const wavFiles = listing.components
        .filter(c => c.name.endsWith('.wav'))
        .sort((a, b) => a.name.localeCompare(b.name));

    const blobs = await Promise.all(
        wavFiles.map(async (wf) => {
            const resp = await fetch(`${baseUrl}/${wf.name}`);
            if (!resp.ok) throw new Error(`Failed to fetch ${wf.name}: HTTP ${resp.status}`);
            return await resp.blob();
        })
    );

    return { blobs };
}

/**
 * Fetch audio data from CDAWeb API
 * @param {string} spacecraft - Spacecraft name (e.g., 'PSP', 'Wind', 'MMS')
 * @param {string} dataset - Dataset ID
 * @param {string} startTime - ISO 8601 start time (e.g., '2025-07-31T22:00:00.000Z')
 * @param {string} endTime - ISO 8601 end time
 * @returns {Promise<Object>} Object containing decoded audio samples and metadata
 */
// ✅ ACTIVE PATH - This is the primary data fetching function used for CDAWeb audio
export async function fetchCDAWebAudio(spacecraft, dataset, startTime, endTime) {
    if (window.pm?.data) console.log(`🛰️ Fetching CDAWeb audio: ${spacecraft} ${dataset} ${startTime} to ${endTime}`);
    
    // Check if user wants to bypass local cache
    const bypassLocalCache = document.getElementById('drawerBypassCache')?.checked;

    // Check cache first (unless bypass is enabled)
    if (window.pm?.data) console.log(`🔍 Checking cache for: ${spacecraft} ${dataset} ${startTime} → ${endTime}${bypassLocalCache ? ' (BYPASSED)' : ''}`);
    const cached = !bypassLocalCache ? await getAudioData(spacecraft, dataset, startTime, endTime) : null;
    if (cached) {
        const expectedComponents = cached.metadata?.allFileUrls?.length || 1;
        const cachedBlobsArray = cached.allComponentBlobs || [];
        // Count actual valid blobs (not null/undefined) - the array might have gaps
        const validBlobCount = cachedBlobsArray.filter(blob => blob instanceof Blob).length;
        const hasAllComponents = validBlobCount >= expectedComponents;

        // Group cache load details (collapsed by default)
        const sizeKB = (cached.wavBlob.size / 1024).toFixed(2);
        if (logGroup('cache', `Loading from cache: ${sizeKB} KB, ${validBlobCount}/${expectedComponents} components`)) {
            console.log(`WAV blob size: ${sizeKB} KB`);
            console.log(`Metadata:`, cached.metadata);
            console.log(`File URLs:`, cached.metadata?.allFileUrls);
            logGroupEnd();
        }

        // Check if cache is INCOMPLETE (missing component blobs)
        // This can happen if background download failed or was interrupted
        if (!hasAllComponents && expectedComponents > 1) {
            console.warn(`⚠️ Cache incomplete: only ${validBlobCount}/${expectedComponents} components have valid blobs`);
            console.log(`🔄 Re-fetching from CDAWeb API to get fresh URLs for all components...`);
            // Fall through to fetch fresh data - don't use incomplete cache
        } else {
            // Cache is complete, use it
            if (window.pm?.audio) console.groupCollapsed(`🎵 [DECODE] WAV from cache`);
            const decoded = await decodeWAVBlob(cached.wavBlob, cached);
            if (window.pm?.audio) {
                console.log(`✅ Cache load complete: ${decoded.playback.totalSamples.toLocaleString()} samples decoded`);
                console.log(`📊 Decoded allFileUrls:`, decoded.allFileUrls);
                console.groupEnd();
            }
            return decoded;
        }
    }
    
    if (window.pm?.data) console.log(`📦 [CACHE] Cache miss — no cached data for ${spacecraft}/${dataset}, will fetch from network`);

    // Try Cloudflare audio cache for the default PSP dataset before hitting CDAWeb
    if (isDefaultPSPDataset(spacecraft, dataset, startTime, endTime)) {
        console.log('🌐 Default PSP dataset — trying Cloudflare audio cache...');
        try {
            const cfResult = await fetchFromCloudflareAudioCache(spacecraft, dataset, startTime, endTime);
            if (cfResult) {
                console.log('☁️ Loaded from Cloudflare audio cache');
                // Store in local IndexedDB too so future loads are instant
                await storeAudioData({
                    spacecraft, dataset, startTime, endTime,
                    wavBlob: cfResult.blobs[0],
                    allComponentBlobs: cfResult.blobs,
                    metadata: {
                        fileSize: cfResult.blobs[0].size,
                        source: 'cloudflare-cache',
                        allFileUrls: cfResult.blobs.map((_, i) => `cloudflare-cache:${i}`),
                        allComponentsDownloaded: true
                    }
                });
                return await decodeWAVBlob(cfResult.blobs[0], {
                    spacecraft, dataset, startTime, endTime,
                    metadata: {
                        allFileUrls: cfResult.blobs.map((_, i) => `cloudflare-cache:${i}`),
                        allComponentsDownloaded: true
                    }
                });
            }
        } catch (cfError) {
            console.warn('☁️ Cloudflare audio cache unavailable:', cfError.message);
        }
    }

    console.log('🌐 Fetching from CDAWeb API');

    // Convert to basic ISO 8601 format (required by CDASWS)
    const startTimeBasic = toBasicISO8601(startTime);
    const endTimeBasic = toBasicISO8601(endTime);
    
    // Get variable name for dataset
    const variable = DATASET_VARIABLES[dataset] || dataset;
    
    // Build API URL with cache buster to force fresh temporary files from CDAWeb
    const cacheBuster = Date.now();
    const apiUrl = `${CDASWS_BASE_URL}/dataviews/${DATAVIEW}/datasets/${dataset}/data/${startTimeBasic},${endTimeBasic}/${variable}?format=audio&_=${cacheBuster}`;

    console.log(`📡 CDAWeb API: ${apiUrl}`);
    
    const fetchStartTime = performance.now();
    
    try {
        // Fetch from CDAWeb API
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`CDAWeb API error (HTTP ${response.status}): ${errorText.substring(0, 200)}`);
        }
        
        const result = await response.json();
        const apiFetchTime = performance.now() - fetchStartTime;
        
        // Validate response
        if (!result || !result.FileDescription || result.FileDescription.length === 0) {
            // Provide helpful message for burst-mode datasets
            const burstDatasets = ['MMS1_EDP_BRST_L2_DCE', 'MMS1_FGM_BRST_L2', 'MMS1_SCM_BRST_L2_SCB', 'MMS1_EDP_BRST_L2_HMFE'];
            if (burstDatasets.includes(dataset)) {
                const statusEl = document.getElementById('status');
                if (statusEl) {
                    statusEl.textContent = '⚠️ MMS burst data is not available for this time range. Burst mode only activates during specific magnetospheric events. Try a different time period or use Survey/Fast mode instead.';
                    statusEl.className = 'status warning';
                }
                throw new Error('MMS burst data is not available for this time range. Burst mode only activates during specific magnetospheric events.');
            }
            throw new Error('No audio file created by CDAWeb API');
        }
        
        console.log(`📊 CDAWeb returned ${result.FileDescription.length} file(s):`, result.FileDescription.map(f => f.Name));

        // Store all file URLs for component switching (PSP returns [br, bt, bn])
        const allFileUrls = result.FileDescription.map(f => f.Name);
        const allFileInfo = result.FileDescription;

        // Get first audio file for initial playback
        const fileInfo = result.FileDescription[0];
        const audioFileUrl = fileInfo.Name;

        console.log(`📥 Downloading WAV file: ${audioFileUrl}`);
        console.log(`📊 CDAWeb FileInfo:`, fileInfo);

        // Download first WAV file immediately (user's requested component)
        const wavResponse = await fetch(audioFileUrl);
        if (!wavResponse.ok) {
            throw new Error(`Failed to download WAV file (HTTP ${wavResponse.status})`);
        }

        const wavBlob = await wavResponse.blob();
        const totalFetchTime = performance.now() - fetchStartTime;

        console.log(`✅ WAV downloaded: ${(wavBlob.size / 1024).toFixed(2)} KB in ${totalFetchTime.toFixed(0)}ms`);

        // Prepare metadata for caching
        const metadata = {
            fileSize: wavBlob.size,
            fileInfo: fileInfo,
            apiFetchTime,
            totalFetchTime,
            component: 'first',
            allFileUrls: allFileUrls,
            allFileInfo: allFileInfo,
            allComponentsDownloaded: allFileUrls.length === 1 // Only one component = already complete
        };

        // Cache first component immediately (so user can start listening)
        await storeAudioData({
            spacecraft,
            dataset,
            startTime,
            endTime,
            wavBlob,
            allComponentBlobs: [wavBlob], // Start with just the first blob
            metadata
        });

        // Background download other components (don't await - let it run in background)
        if (allFileUrls.length > 1) {
            downloadRemainingComponentsInBackground(
                spacecraft, dataset, startTime, endTime,
                allFileUrls, wavBlob
            );
        }

        // Decode and return immediately (user doesn't wait for other components)
        return await decodeWAVBlob(wavBlob, { spacecraft, dataset, startTime, endTime, metadata });
        
    } catch (error) {
        console.error('❌ CDAWeb fetch error:', error);
        throw error;
    }
}

/**
 * Download remaining component WAV files in the background
 * Called after the first component is loaded so user can start listening immediately
 * @param {string} spacecraft
 * @param {string} dataset
 * @param {string} startTime
 * @param {string} endTime
 * @param {Array<string>} allFileUrls - All component URLs from CDAWeb
 * @param {Blob} firstBlob - Already downloaded first component blob
 */
async function downloadRemainingComponentsInBackground(spacecraft, dataset, startTime, endTime, allFileUrls, firstBlob) {
    console.log(`🔄 Background: Downloading ${allFileUrls.length - 1} remaining component(s)...`);

    // Start with the first blob we already have
    const allBlobs = [firstBlob];

    // Download remaining components in parallel
    const remainingUrls = allFileUrls.slice(1);
    const downloadPromises = remainingUrls.map(async (url, index) => {
        const componentIndex = index + 1; // 0 is already downloaded
        const labels = ['br', 'bt', 'bn'];
        const label = labels[componentIndex] || `component ${componentIndex}`;

        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const blob = await response.blob();
            console.log(`   ✅ Background: Downloaded ${label} (${(blob.size / 1024).toFixed(1)} KB)`);
            return { index: componentIndex, blob, success: true };
        } catch (error) {
            console.warn(`   ⚠️ Background: Failed to download ${label}: ${error.message}`);
            return { index: componentIndex, blob: null, success: false };
        }
    });

    const results = await Promise.all(downloadPromises);

    // Build complete array of blobs in order
    for (const result of results) {
        if (result.success) {
            allBlobs[result.index] = result.blob;
        }
    }

    // Update cache with all component blobs
    const successCount = results.filter(r => r.success).length + 1; // +1 for first blob
    if (successCount === allFileUrls.length) {
        await updateCacheWithAllComponents(spacecraft, dataset, startTime, endTime, allBlobs);
        console.log(`✅ Background: All ${allBlobs.length} components cached and ready for switching`);

        // Notify component selector that blobs are ready
        window.dispatchEvent(new CustomEvent('componentsReady', {
            detail: { allBlobs, spacecraft, dataset, startTime, endTime }
        }));
    } else {
        console.warn(`⚠️ Background: Only ${successCount}/${allFileUrls.length} components downloaded`);
    }
}

/**
 * Decode WAV blob with CLEAN DOMAIN SEPARATION
 * 
 * Returns metadata that clearly distinguishes:
 * - Playback domain (44.1kHz, for all position/coordinate math)
 * - Instrument domain (original physics, for Y-axis labels only)
 * 
 * @param {Blob} wavBlob - WAV file blob
 * @param {Object} cacheEntry - Cache entry with metadata
 * @returns {Promise<Object>} Decoded audio data with domain separation
 */
async function decodeWAVBlob(wavBlob, cacheEntry) {
    if (window.pm?.audio) console.log(`🎵 Decoding WAV file (${(wavBlob.size / 1024).toFixed(2)} KB)...`);
    
    const decodeStartTime = performance.now();
    const arrayBuffer = await wavBlob.arrayBuffer();

    // Patch WAV header: change sample rate from 22kHz to 44.1kHz so the browser
    // won't resample (which would double the samples and halve all FFT frequencies).
    // WAV format: sample rate is a uint32 LE at byte offset 24, byte rate at offset 28.
    const headerView = new DataView(arrayBuffer);
    const origSampleRate = headerView.getUint32(24, true);
    const numChannels = headerView.getUint16(22, true);
    const bitsPerSample = headerView.getUint16(34, true);
    const targetSampleRate = 44100;
    if (origSampleRate !== targetSampleRate) {
        if (window.pm?.audio) console.log(`🔧 Patching WAV header: ${origSampleRate} Hz → ${targetSampleRate} Hz (prevents browser resampling)`);
        headerView.setUint32(24, targetSampleRate, true);  // sample rate
        headerView.setUint32(28, targetSampleRate * numChannels * (bitsPerSample / 8), true);  // byte rate
    }

    // Create AudioContext for decoding
    const offlineContext = new (window.AudioContext || window.webkitAudioContext)();

    try {
        // Browser sees 44.1kHz — no resampling, 1 data point = 1 sample
        const audioBuffer = await offlineContext.decodeAudioData(arrayBuffer);
        
        const decodeTime = performance.now() - decodeStartTime;
        if (window.pm?.audio) console.log(`✅ WAV decoded in ${decodeTime.toFixed(0)}ms`);
        
        // Extract samples (already at 44.1kHz)
        const samples = audioBuffer.getChannelData(0);
        
        // ============================================
        // TIME DOMAIN (real-world, the source of truth)
        // ============================================
        const startDate = new Date(cacheEntry.startTime);
        const endDate = new Date(cacheEntry.endTime);
        const realWorldTimeSpanSeconds = (endDate - startDate) / 1000;
        
        // ============================================
        // PLAYBACK DOMAIN
        // ============================================
        // With the WAV header patched to 44.1kHz, the browser doesn't resample.
        // 1 instrument data point = 1 audio sample. Simple.
        const playbackSampleRate = audioBuffer.sampleRate;  // 44100 Hz (tagged)
        const totalPlaybackSamples = audioBuffer.length;    // = instrument sample count
        const audioDurationSeconds = audioBuffer.duration;   // How long the audio plays

        // Samples per real-world second = instrument sampling rate (no resampling!)
        const playbackSamplesPerRealSecond = totalPlaybackSamples / realWorldTimeSpanSeconds;

        // ============================================
        // INSTRUMENT DOMAIN (for Y-axis frequency labels only)
        // ============================================
        // With no resampling, playback samples per real second IS the instrument rate
        const instrumentSamplingRate = playbackSamplesPerRealSecond;
        const instrumentNyquist = instrumentSamplingRate / 2;
        
        // ============================================
        // LOGGING - Make the math crystal clear
        // ============================================
        if (DEBUG_DOMAINS) {
            console.log(`\n📊 ═══════════════════════════════════════════════════════`);
            console.log(`📊 DOMAIN SEPARATION - THE TRUTH`);
            console.log(`📊 ═══════════════════════════════════════════════════════`);
            
            console.log(`\n🌍 TIME DOMAIN (Real World):`);
            console.log(`   Start: ${startDate.toISOString()}`);
            console.log(`   End:   ${endDate.toISOString()}`);
            console.log(`   Span:  ${realWorldTimeSpanSeconds.toLocaleString()} seconds (${(realWorldTimeSpanSeconds/3600).toFixed(2)} hours)`);
            
            console.log(`\n🔊 PLAYBACK DOMAIN (What the browser plays):`);
            console.log(`   AudioContext rate: ${playbackSampleRate.toLocaleString()} Hz`);
            console.log(`   Total samples:     ${totalPlaybackSamples.toLocaleString()}`);
            console.log(`   Audio duration:    ${audioDurationSeconds.toFixed(2)} seconds`);
            console.log(`   ⭐ Samples per real-world second: ${playbackSamplesPerRealSecond.toFixed(2)}`);
            console.log(`      (This is what the worklet uses for position tracking)`);
            
            console.log(`\n🛰️ INSTRUMENT DOMAIN (For Y-axis only):`);
            console.log(`   Instrument rate:   ${instrumentSamplingRate.toFixed(4)} Hz (= samples per real second, no resampling)`);
            console.log(`   Nyquist (Y-max):   ${instrumentNyquist.toFixed(4)} Hz`);
            
            console.log(`\n📐 VERIFICATION:`);
            console.log(`   Position at 50% playback:`);
            console.log(`   - Samples consumed: ${(totalPlaybackSamples/2).toLocaleString()}`);
            console.log(`   - Real-world time:  ${(totalPlaybackSamples/2 / playbackSamplesPerRealSecond).toFixed(2)}s`);
            console.log(`   - Expected:         ${(realWorldTimeSpanSeconds/2).toFixed(2)}s ✓`);
            console.log(`📊 ═══════════════════════════════════════════════════════\n`);
        }
        
        await offlineContext.close();
        
        return {
            // The actual audio samples (1 per instrument data point, tagged as 44.1kHz)
            samples: samples,
            
            // ============================================
            // PLAYBACK DOMAIN - Use these for all position/coordinate math
            // ============================================
            playback: {
                sampleRate: playbackSampleRate,              // 44100 Hz
                totalSamples: totalPlaybackSamples,          // Count at 44.1kHz
                audioDuration: audioDurationSeconds,         // Seconds of audio
                samplesPerRealSecond: playbackSamplesPerRealSecond,  // ⭐ THE KEY VALUE
            },
            
            // ============================================
            // TIME DOMAIN - Real-world timestamps
            // ============================================
            time: {
                start: startDate,
                end: endDate,
                spanSeconds: realWorldTimeSpanSeconds,
            },
            
            // ============================================
            // INSTRUMENT DOMAIN - Only for Y-axis labels
            // ============================================
            instrument: {
                samplingRate: instrumentSamplingRate,        // ~0.5-10 Hz typically
                nyquist: instrumentNyquist,                  // Y-axis max frequency
            },
            
            // Metadata passthrough
            metadata: cacheEntry.metadata || {},
            allFileUrls: cacheEntry.metadata?.allFileUrls || [],
            allFileInfo: cacheEntry.metadata?.allFileInfo || [],
            originalBlob: wavBlob,
        };

    } catch (error) {
        await offlineContext.close();
        console.error('❌ WAV decode error:', error);
        throw new Error(`Failed to decode WAV file: ${error.message}`);
    }
}

/**
 * Convert ISO 8601 extended format to basic format
 * e.g., "2025-07-31T22:00:00.000Z" -> "20250731T220000Z"
 */
function toBasicISO8601(isoString) {
    // Remove milliseconds if present
    let cleaned = isoString.replace(/\.\d{3}/g, '');
    // Remove all dashes and colons, keep T and Z
    cleaned = cleaned.replace(/-/g, '').replace(/:/g, '');
    return cleaned;
}

/**
 * Fetch and load CDAWeb audio data into application state
 * This is the main entry point called from startStreaming
 * @param {string} spacecraft - Spacecraft name
 * @param {string} dataset - Dataset ID
 * @param {string} startTimeISO - ISO 8601 start time
 * @param {string} endTimeISO - ISO 8601 end time
 */
// ✅ ACTIVE PATH - Main entry point for loading CDAWeb data (called from main.js)
export async function fetchAndLoadCDAWebData(spacecraft, dataset, startTimeISO, endTimeISO) {
    const logTime = () => `[${Math.round(performance.now() - window.streamingStartTime)}ms]`;

    if (window.pm?.data) console.log(`📡 [DATA] Fetching & Loading: ${spacecraft} ${dataset}`);
    
    try {
        if (window.pm?.data) console.log(`📡 ${logTime()} Fetching CDAWeb audio data...`);
        
        // Fetch and decode audio from CDAWeb (includes caching)
        const audioData = await fetchCDAWebAudio(spacecraft, dataset, startTimeISO, endTimeISO);
        
        if (window.pm?.data) console.log(`✅ ${logTime()} Audio decoded: ${audioData.playback.totalSamples.toLocaleString()} samples`);
        
        // ============================================
        // SET METADATA WITH CLEAN DOMAIN SEPARATION
        // ============================================
        State.setCurrentMetadata({
            // Playback domain (for worklet, position tracking, coordinates)
            playback_sample_rate: audioData.playback.sampleRate,           // 44100 Hz
            playback_total_samples: audioData.playback.totalSamples,       // Count at 44.1kHz
            playback_samples_per_real_second: audioData.playback.samplesPerRealSecond,  // ⭐ KEY
            
            // Time domain
            startTime: startTimeISO,
            endTime: endTimeISO,
            real_world_time_span: audioData.time.spanSeconds,
            
            // Instrument domain (Y-axis only)
            instrument_sampling_rate: audioData.instrument.samplingRate,
            instrument_nyquist: audioData.instrument.nyquist,
            
            // Legacy compatibility (some code still uses these)
            // TODO: Migrate all code to use new domain-specific fields
            original_sample_rate: audioData.playback.samplesPerRealSecond,  // ⭐ This is what worklet needs!
            
            // Additional metadata
            spacecraft: spacecraft,
            dataset: dataset,
        });
        
        if (window.pm?.data) {
            console.log(`📋 Metadata set:`);
            console.log(`   spacecraft: ${spacecraft}`);
            console.log(`   dataset: ${dataset}`);
            console.log(`   playback_samples_per_real_second: ${audioData.playback.samplesPerRealSecond.toFixed(2)}`);
            console.log(`   instrument_sampling_rate: ${(audioData.instrument.nyquist * 2).toFixed(4)} Hz`);
            console.log(`   instrument_nyquist: ${audioData.instrument.nyquist.toFixed(4)} Hz (for Y-axis)`);
        }
        
        // Apply de-trending before rendering if checkbox is checked
        const removeDCChecked = document.getElementById('removeDCOffset')?.checked;
        if (removeDCChecked) {
            const { removeDCOffset: detrend, normalize: norm } = await import('./minimap-window-renderer.js');
            const slider = document.getElementById('waveformFilterSlider');
            const sliderVal = slider ? parseInt(slider.value) : 95;
            const alpha = 0.95 + (sliderVal / 100) * (0.9999 - 0.95);
            // Back up raw data before de-trending
            window.rawWaveformData = new Float32Array(audioData.samples);
            audioData.samples = norm(detrend(audioData.samples, alpha));
            console.log(`🎛️ Pre-render de-trend applied (α=${alpha.toFixed(4)})`);
        }

        // Set state
        State.setCompleteSamplesArray(audioData.samples);
        State.setOriginalAudioBlob(audioData.originalBlob);
        State.setDataStartTime(audioData.time.start);
        State.setDataEndTime(audioData.time.end);
        
        // ============================================
        // FREQUENCY RANGE FOR Y-AXIS (Instrument domain)
        // ============================================
        State.setOriginalDataFrequencyRange({
            min: 0,
            max: audioData.instrument.nyquist
        });
        
        // ============================================
        // TOTAL AUDIO DURATION (Playback domain)
        // ============================================
        // This is in REAL-WORLD seconds, calculated from playback samples
        State.setTotalAudioDuration(audioData.time.spanSeconds);
        
        // 🎯 CDAWeb: Default to logarithmic scale for space physics data
        // Only if user has NO saved preference - respect their choice if they've set one
        const frequencyScaleSelect = document.getElementById('frequencyScale');
        if (frequencyScaleSelect) {
            const hasUserPreference = localStorage.getItem('frequencyScale') !== null;
            if (!hasUserPreference) {
                console.log('📊 CDAWeb data: Setting frequency scale to logarithmic (default for space physics)');
                frequencyScaleSelect.value = 'logarithmic';
                State.setFrequencyScale('logarithmic');
                localStorage.setItem('frequencyScale', 'logarithmic');
            }
        }
        
        // Initialize component selector if multiple files available
        if (window.pm?.data) console.groupCollapsed(`🔍 [COMPONENT SELECTOR] ${audioData.allFileUrls?.length || 0} files`);
        if (window.pm?.data) console.log(`allFileUrls:`, audioData.allFileUrls);
        if (audioData.allFileUrls && audioData.allFileUrls.length > 1) {
            if (window.pm?.data) console.log(`Multiple files detected - initializing selector`);
            const { initializeComponentSelector } = await import('./component-selector.js');
            // Pass metadata so component selector can look up cached blobs
            initializeComponentSelector(audioData.allFileUrls, {
                spacecraft,
                dataset,
                startTime: startTimeISO,
                endTime: endTimeISO
            });
        } else {
            if (window.pm?.data) console.log(`Single file - hiding selector`);
            const { hideComponentSelector } = await import('./component-selector.js');
            hideComponentSelector();
        }
        if (window.pm?.data) console.groupEnd();
        
        // Show download button after audio loads
        const downloadContainer = document.getElementById('downloadAudioContainer');
        if (downloadContainer) {
            downloadContainer.style.display = 'flex';
        }
        // Show "Download All Components" button only if multiple components
        const downloadAllBtn = document.getElementById('downloadAllComponentsBtn');
        if (downloadAllBtn) {
            downloadAllBtn.style.display = (audioData.allFileUrls?.length > 1) ? 'block' : 'none';
        }
        // console.log(`🔍 [PIPELINE] State.totalAudioDuration set: ${State.totalAudioDuration}s`);
        
        // Set playback duration (for UI display)
        State.setPlaybackDurationSeconds(audioData.time.spanSeconds);
        updatePlaybackDuration(audioData.time.spanSeconds);
        
        updateCompleteButtonState();
        
        // Send samples to waveform worker BEFORE building waveform
        // console.log(`🔍 [PIPELINE] Sending samples to waveform worker: ${audioData.samples.length} samples`);
        if (State.waveformWorker) {
            State.waveformWorker.postMessage({
                type: 'add-samples',
                samples: audioData.samples,
                rawSamples: audioData.samples // For CDAWeb, samples are already normalized, use same for raw
            });
            // console.log(`🔍 [PIPELINE] Samples sent to waveform worker`);
        } else {
            // console.error(`❌ [PIPELINE] Cannot send samples: State.waveformWorker is null!`);
        }
        
        // Initialize zoom coordinate system BEFORE any rendering
        // so axes and spectrogram see the correct viewport from the start
        zoomState.initialize(audioData.playback.totalSamples);
        zoomState.applyInitialViewport();

        // Draw waveform
        if (window.pm?.rendering) console.log(`🎨 ${logTime()} Drawing waveform...`);
        positionMinimapAxisCanvas();
        drawMinimapAxis();
        drawWaveform();

        // Draw x-axis
        positionMinimapXAxisCanvas();
        drawMinimapXAxis();
        positionSpectrogramXAxisCanvas();
        drawSpectrogramXAxis();

        // Draw frequency axis with new frequency range
        positionAxisCanvas();
        drawFrequencyAxis();

        // Start complete visualization (spectrogram)
        if (window.pm?.rendering) console.log(`📊 ${logTime()} Starting spectrogram visualization...`);
        await startCompleteVisualization();

        // Load regions after data fetch (if any)
        await loadRegionsAfterDataFetch();
        
        // Send samples to AudioWorklet for playback
        if (State.workletNode && State.audioContext) {
            // console.log(`🔍 [PIPELINE] Sending samples to AudioWorklet: ${audioData.samples.length} samples`);
            
            // 🎚️ CRITICAL: Set first-play flag BEFORE sending samples
            // This ensures auto-resume uses the long fade when it triggers
            State.workletNode.port.postMessage({
                type: 'set-first-play-flag'
            });

            // Mute sourceGainNode before audio arrives, then ramp up over 250ms
            // Belt-and-suspenders with worklet's internal fade to prevent first-play click
            if (State.sourceGainNode) {
                const now = State.audioContext.currentTime;
                State.sourceGainNode.gain.setValueAtTime(0.0001, now);
                State.sourceGainNode.gain.exponentialRampToValueAtTime(1.0, now + 0.25);
            }
            
            const WORKLET_CHUNK_SIZE = 1024;
            State.setAllReceivedData([]);

            // Check if this is a shared session BEFORE sending data
            // For shared sessions, disable auto-resume so worklet doesn't auto-start
            // Also respect the autoPlay checkbox — if user turned it off, don't let the worklet auto-start
            const isSharedSession = sessionStorage.getItem('isSharedSession') === 'true';
            const autoPlayChecked = document.getElementById('autoPlay')?.checked || false;
            const shouldAutoResume = !isSharedSession && autoPlayChecked;
            // console.log(`🔗 [SHARED SESSION DEBUG] isSharedSession=${isSharedSession}, shouldAutoResume=${shouldAutoResume}`);

            for (let i = 0; i < audioData.samples.length; i += WORKLET_CHUNK_SIZE) {
                const chunkSize = Math.min(WORKLET_CHUNK_SIZE, audioData.samples.length - i);
                // Copy slice to new ArrayBuffer for independent GC
                const slice = audioData.samples.slice(i, i + chunkSize);
                const chunk = new Float32Array(slice);

                State.workletNode.port.postMessage({
                    type: 'audio-data',
                    data: chunk,
                    autoResume: shouldAutoResume
                });

                State.allReceivedData.push(chunk);
            }
            
            // console.log(`🔍 [PIPELINE] Sent ${State.allReceivedData.length} chunks to AudioWorklet`);
            
            // ============================================
            // DATA-COMPLETE WITH CORRECT SAMPLE RATE
            // ============================================
            // ⭐ THIS IS THE FIX: Send playbackSamplesPerRealSecond, not instrument rate
            State.workletNode.port.postMessage({
                type: 'data-complete',
                totalSamples: audioData.playback.totalSamples,
                sampleRate: audioData.playback.samplesPerRealSecond  // ⭐ THE KEY FIX
            });
            
            if (window.pm?.data) {
                console.groupCollapsed(`📤 ${logTime()} data-complete sent`);
                console.log(`totalSamples: ${audioData.playback.totalSamples.toLocaleString()}`);
                if (window.pm?.audio) console.log(`sampleRate: ${audioData.playback.samplesPerRealSecond.toFixed(2)} (playback samples per real second)`);
                console.groupEnd();
            }
            
            // Update playback speed (needed for worklet)
            updatePlaybackSpeed();

            // Check if autoPlay is enabled (but NOT for shared sessions)
            // Note: isSharedSession was already checked above when sending audio data
            const autoPlayEnabled = !isSharedSession && (document.getElementById('autoPlay')?.checked || false);
            if (autoPlayEnabled) {
                // Start playback immediately
                State.workletNode.port.postMessage({ type: 'start-immediately' });
                // console.log(`🚀 Sent 'start-immediately' to worklet`);

                // Update playback state
                State.setPlaybackState(PlaybackState.PLAYING);

                // Notify oscilloscope that playback started
                const { setPlayingState } = await import('./oscilloscope-renderer.js');
                setPlayingState(true);

                // Note: Fade-in is handled by worklet's startFade() in startImmediately()

                // Reset position tracking
                State.setCurrentAudioPosition(0);
                State.setLastWorkletPosition(0);
                State.setLastWorkletUpdateTime(State.audioContext.currentTime);
                State.setLastUpdateTime(State.audioContext.currentTime);

                // Update play/pause button
                const playPauseBtn = document.getElementById('playPauseBtn');
                if (playPauseBtn) {
                    playPauseBtn.disabled = false;
                    playPauseBtn.textContent = '⏸️ Pause';
                    playPauseBtn.classList.remove('play-active', 'secondary');
                    playPauseBtn.classList.add('pause-active');
                }
            } else {
                if (isSharedSession) {
                    console.log(`🔗 Shared session loaded - waiting for user to click Play`);
                } else {
                    console.log(`⏸️ Auto Play disabled - waiting for user to click Play`);
                }
                State.setPlaybackState(PlaybackState.STOPPED);

                // Enable play button with pulse animation for shared sessions
                const playPauseBtn = document.getElementById('playPauseBtn');
                if (playPauseBtn) {
                    playPauseBtn.disabled = false;
                    playPauseBtn.textContent = '▶️ Play';
                    playPauseBtn.classList.remove('pause-active', 'secondary');
                    playPauseBtn.classList.add('play-active');

                    // Add pulse animation for shared sessions
                    if (isSharedSession) {
                        playPauseBtn.classList.add('pulse-attention');
                    }
                }

                // Show "ready to play" status for shared sessions
                if (isSharedSession) {
                    const status = document.getElementById('status');
                    if (status) {
                        status.textContent = '🎧 Ready! Click Play or press Space Bar to start playback';
                        status.className = 'status info';
                    }
                }
            }
        } else {
            // console.warn(`⚠️ [PIPELINE] Cannot send samples to worklet: workletNode=${!!State.workletNode}, audioContext=${!!State.audioContext}`);
        }
        
        if (window.pm?.rendering) console.log(`✅ ${logTime()} CDAWeb data loaded and visualized!`);

        // Stop the pulsing animation on Fetch Data button after first successful fetch
        const startBtn = document.getElementById('startBtn');
        if (startBtn) {
            startBtn.classList.add('fetched');
        }

        return audioData;

    } catch (error) {
        console.error('❌ Failed to load CDAWeb data:', error);
        alert(`Failed to load audio data: ${error.message}`);
        throw error;
    }
}

// Helper: Normalize data to [-1, 1] range (LEGACY - not needed for WAV files)
function normalize(data) {
    let min = data[0];
    let max = data[0];
    for (let i = 1; i < data.length; i++) {
        if (data[i] < min) min = data[i];
        if (data[i] > max) max = data[i];
    }
    
    if (max === min) {
        return new Float32Array(data.length);
    }
    
    const normalized = new Float32Array(data.length);
    const range = max - min;
    for (let i = 0; i < data.length; i++) {
        normalized[i] = 2 * (data[i] - min) / range - 1;
    }
    
    return normalized;
}

// Calculate which chunks are needed using progressive algorithm
function calculateChunksNeededMultiDay(startTime, endTime, allDayMetadata) {
    const chunks = [];
    
    // Helper to format time as HH:MM:SS
    const formatTime = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
    
    // Helper to find chunk in metadata
    const findChunk = (date, time, type) => {
        const dayMeta = allDayMetadata.find(m => m && m.date === date);
        if (!dayMeta || !dayMeta.chunks[type]) return null;
        return dayMeta.chunks[type].find(c => c.start === time);
    };
    
    // Helper to check alignment
    const isHourAligned = (minute) => minute === 0;
    const is6hAligned = (hour, minute) => hour % 6 === 0 && minute === 0;
    
    // Start from rounded 10m boundary
    let currentTime = new Date(startTime);
    currentTime.setUTCMinutes(Math.floor(currentTime.getUTCMinutes() / 10) * 10, 0, 0);
    
    let minutesElapsed = 0;
    let hasUsed1h = false;
    
    while (currentTime < endTime) {
        const currentDate = currentTime.toISOString().split('T')[0];
        const currentHour = currentTime.getUTCHours();
        const currentMinute = currentTime.getUTCMinutes();
        const timeStr = formatTime(currentHour, currentMinute);
        const remainingMinutes = (endTime - currentTime) / 1000 / 60;
        
        // FIRST 60 MINUTES: MUST use 10m chunks
        if (minutesElapsed < 60) {
            const chunkData = findChunk(currentDate, timeStr, '10m');
            if (chunkData) {
                chunks.push({
                    type: '10m',
                    start: chunkData.start,
                    end: chunkData.end,
                    min: chunkData.min,
                    max: chunkData.max,
                    samples: chunkData.samples,
                    date: currentDate
                });
                if (DEBUG_CHUNKS) console.log(`✅ Found 10m chunk: ${currentDate} ${timeStr} (${chunkData.samples.toLocaleString()} samples)`);
            } else {
                // Calculate expected end time for missing chunk
                const endTime = new Date(currentTime);
                endTime.setUTCMinutes(endTime.getUTCMinutes() + 10);
                const endTimeStr = formatTime(endTime.getUTCHours(), endTime.getUTCMinutes());
                
                // Get sample rate from first available metadata
                const firstDayMeta = allDayMetadata.find(m => m && m.sample_rate);
                const sampleRate = firstDayMeta ? firstDayMeta.sample_rate : 50; // Default to 50 Hz if not found
                const expectedSamples = 10 * 60 * sampleRate; // 10 minutes worth
                
                chunks.push({
                    type: '10m',
                    start: timeStr,
                    end: endTimeStr,
                    min: 0,
                    max: 0,
                    samples: expectedSamples,
                    date: currentDate,
                    isMissing: true // 🆕 Flag for missing data
                });
                console.warn(`⚠️ MISSING 10m chunk: ${currentDate} ${timeStr} - will fill with ${expectedSamples.toLocaleString()} zeros`);
            }
            currentTime.setUTCMinutes(currentTime.getUTCMinutes() + 10);
            minutesElapsed += 10;
            continue;
        }
        
        // AFTER 60 MINUTES: Use LARGEST chunk available at this boundary
        // Priority: 6h > 1h > 10m
        
        // Try 6h chunk (must have used 1h first, be at 6h boundary, have enough time)
        if (hasUsed1h && is6hAligned(currentHour, currentMinute) && remainingMinutes >= 360) {
            const chunkData = findChunk(currentDate, timeStr, '6h');
            if (chunkData) {
                chunks.push({
                    type: '6h',
                    start: chunkData.start,
                    end: chunkData.end,
                    min: chunkData.min,
                    max: chunkData.max,
                    samples: chunkData.samples,
                    date: currentDate
                });
                currentTime.setUTCHours(currentTime.getUTCHours() + 6);
                minutesElapsed += 360;
                continue;
            }
        }
        
        // Try 1h chunk (at hour boundary, have enough time)
        if (isHourAligned(currentMinute) && remainingMinutes >= 60) {
            const chunkData = findChunk(currentDate, timeStr, '1h');
            if (chunkData) {
                chunks.push({
                    type: '1h',
                    start: chunkData.start,
                    end: chunkData.end,
                    min: chunkData.min,
                    max: chunkData.max,
                    samples: chunkData.samples,
                    date: currentDate
                });
                currentTime.setUTCHours(currentTime.getUTCHours() + 1);
                minutesElapsed += 60;
                hasUsed1h = true; // Mark that we've used a 1h chunk
                continue;
            }
        }
        
        // Use 10m chunk
        const chunkData = findChunk(currentDate, timeStr, '10m');
        if (chunkData) {
            chunks.push({
                type: '10m',
                start: chunkData.start,
                end: chunkData.end,
                min: chunkData.min,
                max: chunkData.max,
                samples: chunkData.samples,
                date: currentDate
            });
            if (DEBUG_CHUNKS) console.log(`✅ Found 10m chunk: ${currentDate} ${timeStr} (${chunkData.samples.toLocaleString()} samples)`);
        } else {
            // Calculate expected end time for missing chunk
            const endTime = new Date(currentTime);
            endTime.setUTCMinutes(endTime.getUTCMinutes() + 10);
            const endTimeStr = formatTime(endTime.getUTCHours(), endTime.getUTCMinutes());
            
            // Get sample rate from first available metadata
            const firstDayMeta = allDayMetadata.find(m => m && m.sample_rate);
            const sampleRate = firstDayMeta ? firstDayMeta.sample_rate : 50; // Default to 50 Hz if not found
            const expectedSamples = 10 * 60 * sampleRate; // 10 minutes worth
            
            chunks.push({
                type: '10m',
                start: timeStr,
                end: endTimeStr,
                min: 0,
                max: 0,
                samples: expectedSamples,
                date: currentDate,
                isMissing: true // 🆕 Flag for missing data
            });
            console.warn(`⚠️ MISSING 10m chunk: ${currentDate} ${timeStr} - will fill with ${expectedSamples.toLocaleString()} zeros`);
        }
        currentTime.setUTCMinutes(currentTime.getUTCMinutes() + 10);
        minutesElapsed += 10;
    }
    
    return chunks;
}

// Create progressive download batches
function createDownloadBatches(chunks) {
    if (chunks.length === 0) return [];
    
    const batches = [];
    let currentType = null;
    let batchSize = 1; // Start at 1 for each type
    let remainingInType = [];
    let chunksOfTypeProcessed = 0; // Track chunks processed in current type
    
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        
        // Type change → flush and reset
        if (chunk.type !== currentType) {
            // Flush any remaining from previous type
            if (remainingInType.length > 0) {
                batches.push([...remainingInType]);
                remainingInType = [];
            }
            
            currentType = chunk.type;
            batchSize = 1; // RESET to 1
            chunksOfTypeProcessed = 0; // RESET counter
        }
        
        remainingInType.push(i);
        
        // 🎯 SPECIAL: First 3 ten-minute chunks download individually for runway
        const isFirst3TenMinute = (currentType === '10m' && chunksOfTypeProcessed < 3);
        
        if (isFirst3TenMinute) {
            // Always flush after 1 chunk for first 3 ten-minute chunks
            batches.push([...remainingInType]);
            remainingInType = [];
            chunksOfTypeProcessed++;
            // Keep batchSize = 1 for first 3
        } else {
            // Normal batching logic
            if (remainingInType.length === batchSize) {
                batches.push([...remainingInType]);
                remainingInType = [];
                chunksOfTypeProcessed += batchSize;
                
                // Increment batch size for next batch (with cap for 6h)
                if (currentType === '6h') {
                    batchSize = Math.min(batchSize + 1, 4); // CAP at 4 for 6h chunks
                } else {
                    batchSize++; // No cap for 10m and 1h
                }
            }
        }
    }
    
    // Flush any remaining chunks
    if (remainingInType.length > 0) {
        batches.push(remainingInType);
    }
    
    return batches;
}
