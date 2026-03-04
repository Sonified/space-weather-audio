/**
 * ui-controls.js
 * UI controls: station loading, dataset config, filters, playback settings, cache purge.
 * Modal and survey logic split into ui-modals.js and ui-surveys.js.
 */

import * as State from './audio-state.js';
import { drawWaveform, changeWaveformFilter } from './minimap-window-renderer.js';
import { updatePlaybackSpeed } from './audio-player.js';
import { isStudyMode, CURRENT_MODE, AppMode } from './master-modes.js';
import { log, logGroup, logGroupEnd } from './logger.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Re-exports from ui-modals.js (zero-breakage migration — consumers keep importing from here)
// ═══════════════════════════════════════════════════════════════════════════════
// Modal functions (re-exported for backward compatibility)
export {
    fadeOutOverlay,
    closeAllModals,
    setupModalEventListeners,
    openParticipantModal,
    closeParticipantModal,
    openParticipantInfoModal,
    openWelcomeModal,
    closeWelcomeModal
} from './ui-modals.js';

// Survey functions (re-exported for backward compatibility)
export {
    submitParticipantSetup
} from './ui-surveys.js';

export function loadStations() {
    // No-op: spacecraft selection is handled by updateDatasetOptions()
}

/**
 * Load saved spacecraft selection from localStorage and apply it
 * Called on page load to restore user's preferred spacecraft
 */
export async function loadSavedSpacecraft() {
    const spacecraftSelect = document.getElementById('spacecraft');
    if (!spacecraftSelect) return;

    // Skip localStorage restoration if loading from a share link
    // The share link handler (applySharedSession) already set the correct values
    if (sessionStorage.getItem('isSharedSession') === 'true') {
        log('share', 'Skipping localStorage restoration (share link active)');
        return;
    }

    // Start preference restoration group
    const prefGroupOpen = logGroup('data', 'Restoring saved preferences');

    // Migrate from old 'selectedVolcano' key if it exists
    const legacySelection = localStorage.getItem('selectedVolcano');
    if (legacySelection) {
        localStorage.setItem('selectedSpacecraft', legacySelection);
        localStorage.removeItem('selectedVolcano');
        console.log('Migrated: selectedVolcano → selectedSpacecraft');
    }

    // Load saved spacecraft from localStorage
    const savedSpacecraft = localStorage.getItem('selectedSpacecraft');
    // Validate against SPACECRAFT_DATASETS (space weather mode)
    if (savedSpacecraft && SPACECRAFT_DATASETS[savedSpacecraft]) {
        spacecraftSelect.value = savedSpacecraft;
        if (!isStudyMode()) {
            console.log(`Spacecraft: ${savedSpacecraft}`);
        }
        // Update the Data dropdown to match the restored spacecraft
        updateDatasetOptions();
    } else {
        // If no saved spacecraft or invalid, default to first option
        const firstOption = spacecraftSelect.options[0]?.value || 'PSP';
        spacecraftSelect.value = firstOption;
        localStorage.setItem('selectedSpacecraft', firstOption);
        console.log(`Spacecraft: ${firstOption} (default)`);
        updateDatasetOptions();
    }

    // Restore saved data type (after updateDatasetOptions populates the dropdown)
    const savedDataType = localStorage.getItem('selectedDataType');
    const dataTypeSelect = document.getElementById('dataType');
    if (savedDataType && dataTypeSelect) {
        // Check if the saved data type is valid for the current spacecraft
        const validOptions = Array.from(dataTypeSelect.options).map(opt => opt.value);
        if (validOptions.includes(savedDataType)) {
            dataTypeSelect.value = savedDataType;
            if (!isStudyMode()) {
                console.log(`Data type: ${savedDataType}`);
            }
        }
    }

    // Restore saved date/time settings
    loadSavedDateTime(prefGroupOpen);

}

/**
 * Load saved date/time settings from localStorage
 * @param {boolean} groupOpen - Whether a log group is open (to close it at the end)
 */
function loadSavedDateTime(groupOpen) {
    const startDate = document.getElementById('startDate');
    const startTime = document.getElementById('startTime');
    const endDate = document.getElementById('endDate');
    const endTime = document.getElementById('endTime');

    const savedStartDate = localStorage.getItem('selectedStartDate');
    const savedStartTime = localStorage.getItem('selectedStartTime');
    const savedEndDate = localStorage.getItem('selectedEndDate');
    const savedEndTime = localStorage.getItem('selectedEndTime');

    if (savedStartDate && startDate) {
        startDate.value = savedStartDate;
    }
    if (savedStartTime && startTime) {
        startTime.value = savedStartTime;
    }
    if (savedEndDate && endDate) {
        endDate.value = savedEndDate;
    }
    if (savedEndTime && endTime) {
        endTime.value = savedEndTime;
    }

    if ((savedStartDate || savedEndDate) && window.pm?.data) {
        console.log(`📡 Date/time: ${savedStartDate} ${savedStartTime} → ${savedEndDate} ${savedEndTime}`);
    }

    // Close the preference restoration group
    if (groupOpen) logGroupEnd();
}

/**
 * Save current date/time settings to localStorage
 * Call this when any date/time field changes
 */
export function saveDateTime() {
    const startDate = document.getElementById('startDate');
    const startTime = document.getElementById('startTime');
    const endDate = document.getElementById('endDate');
    const endTime = document.getElementById('endTime');

    if (startDate?.value) localStorage.setItem('selectedStartDate', startDate.value);
    if (startTime?.value) localStorage.setItem('selectedStartTime', startTime.value);
    if (endDate?.value) localStorage.setItem('selectedEndDate', endDate.value);
    if (endTime?.value) localStorage.setItem('selectedEndTime', endTime.value);

    console.log('💾 Saved date/time:', startDate?.value, startTime?.value, '→', endDate?.value, endTime?.value);
}

// Spacecraft to datasets mapping for the Data dropdown
// Spacecraft datasets organized by instrument group
// Items with 'group' key create <optgroup> headers; magnetic field groups always come first
const SPACECRAFT_DATASETS = {
    'PSP': [
        { group: 'Magnetic Field' },
        { value: 'PSP_FLD_L2_MAG_RTN', label: 'MAG RTN (Full Cadence)' },
        { value: 'PSP_FLD_L2_MAG_RTN_4_SA_PER_CYC', label: 'MAG RTN (4 Samples/Cycle)' },
        { group: 'Electric Field' },
        { value: 'PSP_FLD_L2_DFB_WF_DVDC', label: 'DFB DC Voltage Waveform' }
    ],
    'Wind': [
        { group: 'Magnetic Field' },
        { value: 'WI_H2_MFI', label: 'MFI (Magnetic Field Investigation)' }
    ],
    'MMS': [
        { group: 'Magnetic Field (FGM)' },
        { value: 'MMS1_FGM_SRVY_L2', label: 'FGM Survey' },
        { value: 'MMS1_FGM_BRST_L2', label: 'FGM Burst' },
        { group: 'Magnetic Field (Search Coil)' },
        { value: 'MMS1_SCM_SRVY_L2_SCSRVY', label: 'SCM Survey' },
        { value: 'MMS1_SCM_BRST_L2_SCB', label: 'SCM Burst' },
        { group: 'Electric Field (EDP)' },
        { value: 'MMS1_EDP_SLOW_L2_DCE', label: 'EDP Slow Survey' },
        { value: 'MMS1_EDP_FAST_L2_DCE', label: 'EDP Fast Survey' },
        { value: 'MMS1_EDP_BRST_L2_DCE', label: 'EDP Burst' }
    ],
    'THEMIS': [
        { group: 'Magnetic Field (FGM)' },
        { value: 'THA_L2_FGM', label: 'THEMIS-A FGM' },
        { value: 'THB_L2_FGM', label: 'THEMIS-B FGM' },
        { value: 'THC_L2_FGM', label: 'THEMIS-C FGM' },
        { value: 'THD_L2_FGM', label: 'THEMIS-D FGM' },
        { value: 'THE_L2_FGM', label: 'THEMIS-E FGM' },
        { group: 'Magnetic Field (Search Coil)' },
        { value: 'THA_L2_SCM', label: 'THEMIS-A SCM' },
        { value: 'THB_L2_SCM', label: 'THEMIS-B SCM' },
        { value: 'THC_L2_SCM', label: 'THEMIS-C SCM' },
        { value: 'THD_L2_SCM', label: 'THEMIS-D SCM' },
        { value: 'THE_L2_SCM', label: 'THEMIS-E SCM' },
        { group: 'Electric Field (EFI)' },
        { value: 'THA_L2_EFI', label: 'THEMIS-A EFI' },
        { value: 'THB_L2_EFI', label: 'THEMIS-B EFI' },
        { value: 'THC_L2_EFI', label: 'THEMIS-C EFI' },
        { value: 'THD_L2_EFI', label: 'THEMIS-D EFI' },
        { value: 'THE_L2_EFI', label: 'THEMIS-E EFI' }
    ],
    'SolO': [
        { group: 'Magnetic Field' },
        { value: 'SOLO_L2_MAG-RTN-NORMAL', label: 'MAG Normal Mode' },
        { value: 'SOLO_L2_MAG-RTN-BURST', label: 'MAG Burst Mode' },
        { group: 'Electric Field' },
        { value: 'SOLO_L2_RPW-LFR-SURV-CWF-E', label: 'RPW LFR Electric Field' }
    ],
    'GOES': [
        { group: 'Magnetic Field' },
        { value: 'DN_MAGN-L2-HIRES_G16', label: 'GOES-16 MAG 10 Hz (Aug 2018 - Apr 2025)' },
        { value: 'DN_MAGN-L2-HIRES_G19', label: 'GOES-19 MAG 10 Hz (Jun 2025 - present)' }
    ],
    'ACE': [
        { group: 'Magnetic Field' },
        { value: 'AC_H3_MFI', label: 'MFI 1-sec GSE' }
    ],
    'DSCOVR': [
        { group: 'Magnetic Field' },
        { value: 'DSCOVR_H0_MAG', label: 'Fluxgate MAG 1-sec GSE' }
    ],
    'Cluster': [
        { group: 'Magnetic Field (FGM)' },
        { value: 'C1_CP_FGM_5VPS', label: 'C1 FGM 5 Vec/s' },
        { value: 'C2_CP_FGM_5VPS', label: 'C2 FGM 5 Vec/s' },
        { value: 'C3_CP_FGM_5VPS', label: 'C3 FGM 5 Vec/s' },
        { value: 'C4_CP_FGM_5VPS', label: 'C4 FGM 5 Vec/s' },
        { group: 'Magnetic Field (Search Coil)' },
        { value: 'C1_CP_STA_CWF_GSE', label: 'C1 STAFF CWF GSE' },
        { value: 'C2_CP_STA_CWF_GSE', label: 'C2 STAFF CWF GSE' },
        { value: 'C3_CP_STA_CWF_GSE', label: 'C3 STAFF CWF GSE' },
        { value: 'C4_CP_STA_CWF_GSE', label: 'C4 STAFF CWF GSE' },
        { group: 'Electric Field (EFW)' },
        { value: 'C1_CP_EFW_L3_E3D_INERT', label: 'C1 EFW E3D Inertial' },
        { value: 'C2_CP_EFW_L3_E3D_INERT', label: 'C2 EFW E3D Inertial' },
        { value: 'C3_CP_EFW_L3_E3D_INERT', label: 'C3 EFW E3D Inertial' },
        { value: 'C4_CP_EFW_L3_E3D_INERT', label: 'C4 EFW E3D Inertial' }
    ],
    'Geotail': [
        { group: 'Magnetic Field' },
        { value: 'GE_EDB3SEC_MGF', label: 'MGF Editor-B 3-sec GSE' },
        { group: 'Electric Field' },
        { value: 'GE_K0_EFD', label: 'EFD Spherical Probe' }
    ],
    'Voyager 1': [
        { group: 'Magnetic Field' },
        { value: 'VOYAGER1_2S_MAG', label: 'MAG 1.92-sec HG' }
    ],
    'Voyager 2': [
        { group: 'Magnetic Field' },
        { value: 'VOYAGER2_2S_MAG', label: 'MAG 1.92-sec HG' }
    ]
};

/**
 * Update the Data (dataType) dropdown based on the selected spacecraft
 * Called when spacecraft selection changes
 */
export function updateDatasetOptions() {
    const spacecraftSelect = document.getElementById('spacecraft');
    const dataTypeSelect = document.getElementById('dataType');

    if (!spacecraftSelect || !dataTypeSelect) {
        console.warn('Spacecraft or dataType select not found');
        return;
    }

    const spacecraft = spacecraftSelect.value;
    const datasets = SPACECRAFT_DATASETS[spacecraft] || [];

    if (datasets.length === 0) {
        if (CURRENT_MODE !== AppMode.EMIC_STUDY) {
            console.warn(`No datasets configured for spacecraft: ${spacecraft}`);
        }
        dataTypeSelect.innerHTML = '<option value="">No datasets available</option>';
        return;
    }

    // Populate the dataType dropdown with optgroup headers and options
    let html = '';
    let firstValue = true;
    let inGroup = false;
    for (const ds of datasets) {
        if (ds.group) {
            // Close previous optgroup if open
            if (inGroup) html += '</optgroup>';
            html += `<optgroup label="${ds.group}">`;
            inGroup = true;
        } else {
            html += `<option value="${ds.value}"${firstValue ? ' selected' : ''}>${ds.label}</option>`;
            firstValue = false;
        }
    }
    if (inGroup) html += '</optgroup>';
    dataTypeSelect.innerHTML = html;

    console.log(`📊 Updated dataset options for ${spacecraft}: ${datasets.length} datasets available`);
}

export function updateStationList() {
    const dataType = document.getElementById('dataType').value;
    const spacecraftEl = document.getElementById('spacecraft');
    const stationSelect = document.getElementById('station');

    // Skip if spacecraft/station elements don't exist
    if (!spacecraftEl || !stationSelect) {
        return;
    }

    const spacecraft = spacecraftEl.value;
    const stations = State.availableStations[dataType] || [];
    
    // Only log in dev/personal modes, not study mode
    if (!isStudyMode()) {
        console.log(`🔍 updateStationList: dataType="${dataType}", availableStations=`, State.availableStations);
        console.log(`🔍 Stations for ${dataType}:`, stations);
    }
    
    if (stations.length === 0) {
        if (!isStudyMode()) {
            console.warn(`⚠️ No ${dataType} stations available`);
        }
        stationSelect.innerHTML = '<option value="">No stations available</option>';
        return;
    }
    
    const defaultIndex = (spacecraft === 'kilauea') ? 3 : 0;
    
    stationSelect.innerHTML = stations.map((s, index) => 
        `<option value='${JSON.stringify(s)}' ${index === defaultIndex ? 'selected' : ''}>${s.label}</option>`
    ).join('');
    
    if (!isStudyMode()) {
        console.log(`✅ Populated ${stations.length} ${dataType} stations`);
    }
}

export function enableFetchButton() {
    const fetchBtn = document.getElementById('startBtn');
    const spacecraftSelect = document.getElementById('spacecraft');
    const currentSpacecraft = spacecraftSelect ? spacecraftSelect.value : null;
    const spacecraftWithData = State.spacecraftWithData;

    // If we're on the spacecraft that already has data, keep fetch button disabled
    if (spacecraftWithData && currentSpacecraft === spacecraftWithData) {
        fetchBtn.disabled = true;
        fetchBtn.title = 'This spacecraft already has data loaded. Select a different spacecraft to fetch new data.';
        console.log(`🚫 Fetch button remains disabled - ${currentSpacecraft} already has data`);
    } else {
        fetchBtn.disabled = false;
        fetchBtn.classList.remove('streaming');
        fetchBtn.title = '';
        console.log('✅ Fetch button re-enabled due to parameter change');
    }
}

export function changeBaseSampleRate() {
    updateHighPassFilterDisplay();
    updatePlaybackSpeed();
    updatePlaybackDuration();
}

export function updateHighPassFilterDisplay() {
    const baseSampleRateSelect = document.getElementById('baseSampleRate');
    const selectedRate = parseFloat(baseSampleRateSelect.value);
    const shorthand = formatSampleRateShorthand(selectedRate);
    
    const label = document.getElementById('highpassLabel');
    label.textContent = `High Pass (@ ${shorthand}):`;
    
    const highpassSelect = document.getElementById('highpassFreq');
    const selectedValue = highpassSelect.value;
    
    let originalSampleRate = 100;
    if (State.currentMetadata && State.currentMetadata.original_sample_rate) {
        originalSampleRate = State.currentMetadata.original_sample_rate;
    }
    
    const totalSpeedup = selectedRate / originalSampleRate;
    const freq001Hz = 0.01 * totalSpeedup;
    const freq002Hz = 0.02 * totalSpeedup;
    const freq0045Hz = 0.045 * totalSpeedup;
    
    const formatFreq = (freq) => {
        if (freq < 1) {
            return freq.toFixed(2) + ' Hz';
        } else if (freq < 10) {
            return freq.toFixed(1) + ' Hz';
        } else {
            return freq.toFixed(0) + ' Hz';
        }
    };
    
    const options = highpassSelect.options;
    options[0].text = 'None';
    options[1].text = `0.01 Hz (${formatFreq(freq001Hz)})`;
    options[2].text = `0.02 Hz (${formatFreq(freq002Hz)})`;
    options[3].text = `0.045 Hz (${formatFreq(freq0045Hz)})`;
    
    highpassSelect.value = selectedValue;
}

export function formatSampleRateShorthand(rate) {
    if (rate >= 1000000) {
        return (rate / 1000000).toFixed(0) + 'M';
    } else if (rate >= 1000) {
        const khz = rate / 1000;
        return khz % 1 === 0 ? khz.toFixed(0) + 'k' : khz.toFixed(1) + 'k';
    }
    return rate.toString();
}

export function updatePlaybackDuration() {
    // This is duplicated from audio-player.js - needs to be imported or refactored
    // For now, keeping it here to avoid circular dependencies
    
    // 🔥 FIX: Check document connection before DOM manipulation
    if (!document.body || !document.body.isConnected) {
        return;
    }
    
    // 🔥 FIX: Copy State values to local variables to avoid closure retention
    // Access State only once and copy values immediately
    const currentMetadata = State.currentMetadata;
    const allReceivedData = State.allReceivedData;
    
    if (!currentMetadata || !allReceivedData || allReceivedData.length === 0) {
        const playbackDurationEl = document.getElementById('playbackDuration');
        if (playbackDurationEl && playbackDurationEl.isConnected) {
            playbackDurationEl.textContent = '--';
        }
        return;
    }
    
    // 🔥 FIX: Use npts from metadata if available, otherwise calculate from array
    // Copy array reference to local variable to avoid retaining State reference
    const totalSamples = currentMetadata.npts || allReceivedData.reduce((sum, chunk) => sum + (chunk ? chunk.length : 0), 0);
    const originalSampleRate = currentMetadata.original_sample_rate;
    
    if (!totalSamples || !originalSampleRate) {
        const playbackDurationEl = document.getElementById('playbackDuration');
        if (playbackDurationEl && playbackDurationEl.isConnected) {
            playbackDurationEl.textContent = '--';
        }
        return;
    }
    
    const slider = document.getElementById('playbackSpeed');
    const sliderValue = parseFloat(slider.value);
    
    let baseSpeed;
    if (sliderValue <= 667) {
        const normalized = sliderValue / 667;
        baseSpeed = 0.1 * Math.pow(10, normalized);
    } else {
        const normalized = (sliderValue - 667) / 333;
        baseSpeed = Math.pow(15, normalized);
    }
    
    const baseSampleRateSelect = document.getElementById('baseSampleRate');
    const selectedRate = parseFloat(baseSampleRateSelect.value);
    const multiplier = selectedRate / 44100;
    
    const AUDIO_CONTEXT_SAMPLE_RATE = 44100;
    const originalDuration = totalSamples / originalSampleRate;
    const baseSpeedup = AUDIO_CONTEXT_SAMPLE_RATE / originalSampleRate;
    const totalSpeed = baseSpeedup * multiplier * baseSpeed;
    const playbackDurationSeconds = originalDuration / totalSpeed;
    
    window.playbackDurationSeconds = playbackDurationSeconds;
    
    const minutes = Math.floor(playbackDurationSeconds / 60);
    const seconds = Math.floor(playbackDurationSeconds % 60);
    
    const durationText = minutes > 0 ? `${minutes}m ${seconds}s` : `0m ${seconds}s`;
    
    // 🔥 FIX: Check element connection before updating DOM
    const playbackDurationEl = document.getElementById('playbackDuration');
    if (playbackDurationEl && playbackDurationEl.isConnected) {
        playbackDurationEl.textContent = durationText;
    }
}

export async function purgeCloudflareCache() {
    const btn = document.getElementById('purgeCacheBtn');
    const originalText = btn.textContent;
    
    try {
        btn.disabled = true;
        btn.textContent = '⏳ Purging...';
        
        const WORKER_URL = 'https://volcano-audio-cache-purge.robertalexander-music.workers.dev';
        
        const response = await fetch(WORKER_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        const result = await response.json();
        
        if (result.success) {
            btn.textContent = '✅ Purged!';
            console.log('✅ CDN cache purged successfully at:', result.timestamp);
            setTimeout(() => {
                btn.textContent = originalText;
                btn.disabled = false;
            }, 2000);
        } else {
            throw new Error(result.error || 'Purge failed');
        }
    } catch (error) {
        console.error('❌ Cache purge error:', error);
        btn.textContent = '❌ Failed';
        setTimeout(() => {
            btn.textContent = originalText;
            btn.disabled = false;
        }, 2000);
    }
}

// Waveform filter controls (wrapper functions)
export function handleWaveformFilterChange() {
    changeWaveformFilter();
}

export function resetWaveformFilterToDefault() {
    const slider = document.getElementById('waveformFilterSlider');
    slider.value = 50;
    changeWaveformFilter();
}

