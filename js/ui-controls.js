/**
 * ui-controls.js
 * UI controls: station loading, modals, filters, cache purge
 */

import * as State from './audio-state.js';
import { EMBEDDED_STATIONS } from './station-config.js';
import { drawWaveform, changeWaveformFilter } from './waveform-renderer.js';
import { updatePlaybackSpeed } from './audio-player.js';

export function loadStations() {
    const volcano = document.getElementById('volcano').value;
    const stationSelect = document.getElementById('station');
    
    if (!EMBEDDED_STATIONS[volcano]) {
        stationSelect.innerHTML = '<option value="">Volcano not found</option>';
        return;
    }
    
    const volcanoData = EMBEDDED_STATIONS[volcano];
    State.setAvailableStations({
        seismic: volcanoData.seismic.map(s => ({
            network: s.network,
            station: s.station,
            location: s.location,
            channel: s.channel,
            distance_km: s.distance_km,
            sample_rate: s.sample_rate,
            label: `${s.network}.${s.station}.${s.location || '--'}.${s.channel} (${s.distance_km}km, ${s.sample_rate}Hz)`
        })),
        infrasound: (volcanoData.infrasound || []).map(s => ({
            network: s.network,
            station: s.station,
            location: s.location,
            channel: s.channel,
            distance_km: s.distance_km,
            sample_rate: s.sample_rate,
            label: `${s.network}.${s.station}.${s.location || '--'}.${s.channel} (${s.distance_km}km, ${s.sample_rate}Hz)`
        }))
    });
    
    updateStationList();
}

export function updateStationList() {
    const dataType = document.getElementById('dataType').value;
    const volcano = document.getElementById('volcano').value;
    const stationSelect = document.getElementById('station');
    const stations = State.availableStations[dataType] || [];
    
    console.log(`🔍 updateStationList: dataType="${dataType}", availableStations=`, State.availableStations);
    console.log(`🔍 Stations for ${dataType}:`, stations);
    
    if (stations.length === 0) {
        console.warn(`⚠️ No ${dataType} stations available`);
        stationSelect.innerHTML = '<option value="">No stations available</option>';
        return;
    }
    
    const defaultIndex = (volcano === 'kilauea') ? 3 : 0;
    
    stationSelect.innerHTML = stations.map((s, index) => 
        `<option value='${JSON.stringify(s)}' ${index === defaultIndex ? 'selected' : ''}>${s.label}</option>`
    ).join('');
    
    console.log(`✅ Populated ${stations.length} ${dataType} stations`);
}

export function enableFetchButton() {
    const fetchBtn = document.getElementById('startBtn');
    fetchBtn.disabled = false;
    fetchBtn.classList.remove('streaming');
    console.log('✅ Fetch button re-enabled due to parameter change');
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
    if (!State.currentMetadata || !State.allReceivedData || State.allReceivedData.length === 0) {
        document.getElementById('playbackDuration').textContent = '--';
        return;
    }
    
    const totalSamples = State.currentMetadata.npts || State.allReceivedData.reduce((sum, chunk) => sum + chunk.length, 0);
    const originalSampleRate = State.currentMetadata.original_sample_rate;
    
    if (!totalSamples || !originalSampleRate) {
        document.getElementById('playbackDuration').textContent = '--';
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
    document.getElementById('playbackDuration').textContent = durationText;
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

// Modal functions
export function setupModalEventListeners() {
    // Participant modal event listeners
    const participantModal = document.getElementById('participantModal');
    const participantCloseBtn = participantModal.querySelector('.modal-close');
    const participantSubmitBtn = participantModal.querySelector('.modal-submit');
    
    participantModal.addEventListener('click', closeParticipantModal);
    participantCloseBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent bubble to overlay
        closeParticipantModal(); // Close without event check
    });
    participantSubmitBtn.addEventListener('click', submitParticipantSetup);
    
    // Survey modal event listeners
    const surveyModal = document.getElementById('prePostSurveyModal');
    const surveyCloseBtn = surveyModal.querySelector('.modal-close');
    const surveySubmitBtn = surveyModal.querySelector('.modal-submit');
    
    surveyModal.addEventListener('click', closePrePostSurveyModal);
    surveyCloseBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent bubble to overlay
        closePrePostSurveyModal(); // Close without event check
    });
    surveySubmitBtn.addEventListener('click', submitPrePostSurvey);
    
    console.log('📋 Modal event listeners attached');
}

export function openParticipantModal() {
    document.getElementById('participantModal').classList.add('active');
    console.log('👤 Participant Setup modal opened');
}

export function closeParticipantModal(event) {
    if (!event || event.target.classList.contains('modal-overlay')) {
        document.getElementById('participantModal').classList.remove('active');
        console.log('👤 Participant Setup modal closed');
    }
}

export function submitParticipantSetup() {
    const participantId = document.getElementById('participantId').value;
    
    console.log('📝 Participant Setup Data (not submitted yet):');
    console.log('  - Participant ID:', participantId || '(none)');
    console.log('  - Timestamp:', new Date().toISOString());
    
    const statusEl = document.getElementById('status');
    statusEl.className = 'status success';
    statusEl.textContent = `✅ Participant setup recorded: ${participantId || 'Anonymous'}`;
    
    closeParticipantModal();
    
    setTimeout(() => {
        document.getElementById('participantId').value = '';
    }, 300);
}

export function openPrePostSurveyModal() {
    document.getElementById('prePostSurveyModal').classList.add('active');
    console.log('📊 Pre/Post Survey modal opened');
}

export function closePrePostSurveyModal(event) {
    if (!event || event.target.classList.contains('modal-overlay')) {
        document.getElementById('prePostSurveyModal').classList.remove('active');
        console.log('📊 Pre/Post Survey modal closed');
    }
}

export function submitPrePostSurvey() {
    const surveyData = {
        calm: document.querySelector('input[name="calm"]:checked')?.value || null,
        energized: document.querySelector('input[name="energized"]:checked')?.value || null,
        connected: document.querySelector('input[name="connected"]:checked')?.value || null,
        stressed: document.querySelector('input[name="stressed"]:checked')?.value || null,
        focused: document.querySelector('input[name="focused"]:checked')?.value || null,
        wonder: document.querySelector('input[name="wonder"]:checked')?.value || null,
        timestamp: new Date().toISOString()
    };
    
    const hasRatings = Object.values(surveyData).some(v => v !== null && v !== surveyData.timestamp);
    
    if (!hasRatings) {
        alert('Please rate at least one item before submitting.');
        return;
    }
    
    console.log('📊 Pre/Post Survey Data (not submitted yet):');
    console.log('  - Calm:', surveyData.calm || 'not rated');
    console.log('  - Energized:', surveyData.energized || 'not rated');
    console.log('  - Connected:', surveyData.connected || 'not rated');
    console.log('  - Stressed:', surveyData.stressed || 'not rated');
    console.log('  - Focused:', surveyData.focused || 'not rated');
    console.log('  - Sense of Wonder:', surveyData.wonder || 'not rated');
    console.log('  - Timestamp:', surveyData.timestamp);
    
    const statusEl = document.getElementById('status');
    statusEl.className = 'status success';
    statusEl.textContent = '✅ Pre/Post survey recorded!';
    
    closePrePostSurveyModal();
    
    setTimeout(() => {
        document.querySelectorAll('input[type="radio"]').forEach(radio => {
            radio.checked = false;
        });
    }, 300);
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

