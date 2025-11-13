/**
 * ui-controls.js
 * UI controls: station loading, modals, filters, cache purge
 */

import * as State from './audio-state.js';
import { EMBEDDED_STATIONS } from './station-config.js';
import { drawWaveform, changeWaveformFilter } from './waveform-renderer.js';
import { updatePlaybackSpeed } from './audio-player.js';
import { submitSurveyResponse, getParticipantId, storeParticipantId, getParticipantIdFromURL } from './qualtrics-api.js';
import { isAdminMode } from './admin-mode.js';

export function loadStations() {
    const volcanoSelect = document.getElementById('volcano');
    const volcano = volcanoSelect.value;
    const stationSelect = document.getElementById('station');
    
    // Save volcano selection to localStorage for persistence across sessions
    if (volcano) {
        localStorage.setItem('selectedVolcano', volcano);
    }
    
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

/**
 * Load saved volcano selection from localStorage and apply it
 * Called on page load to restore user's preferred volcano
 */
export function loadSavedVolcano() {
    const volcanoSelect = document.getElementById('volcano');
    if (!volcanoSelect) return;
    
    // Load saved volcano from localStorage
    const savedVolcano = localStorage.getItem('selectedVolcano');
    if (savedVolcano && EMBEDDED_STATIONS[savedVolcano]) {
        volcanoSelect.value = savedVolcano;
        console.log('💾 Restored volcano selection:', savedVolcano);
        // Load stations for the saved volcano
        loadStations();
    } else {
        // If no saved volcano or invalid, use default and load stations
        loadStations();
    }
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
    const participantIdInput = document.getElementById('participantId');
    
    // Function to update button state based on input value
    const updateParticipantSubmitButton = () => {
        const hasValue = participantIdInput && participantIdInput.value.trim().length > 0;
        if (participantSubmitBtn) {
            participantSubmitBtn.disabled = !hasValue;
        }
    };
    
    // Listen for input changes to enable/disable submit button
    if (participantIdInput) {
        participantIdInput.addEventListener('input', updateParticipantSubmitButton);
        participantIdInput.addEventListener('keyup', updateParticipantSubmitButton);
    }
    
    // Don't allow closing by clicking outside - prevent overlay clicks
    participantModal.addEventListener('click', (e) => {
        // Only allow clicks on the modal content itself, not the overlay
        if (e.target === participantModal) {
            e.preventDefault();
            e.stopPropagation();
            return false;
        }
    });
    participantCloseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Don't allow closing via X button either - it's hidden anyway
    });
    participantSubmitBtn.addEventListener('click', submitParticipantSetup);
    
    // Initial button state check
    updateParticipantSubmitButton();
    
    // Pre-Survey modal event listeners
    const preSurveyModal = document.getElementById('preSurveyModal');
    const preSurveyCloseBtn = preSurveyModal.querySelector('.modal-close');
    const preSurveySubmitBtn = preSurveyModal.querySelector('.modal-submit');
    
    // Function to check if all pre-survey questions are answered
    const updatePreSurveySubmitButton = () => {
        const allAnswered = 
            document.querySelector('input[name="preCalm"]:checked') &&
            document.querySelector('input[name="preEnergized"]:checked') &&
            document.querySelector('input[name="preNervous"]:checked') &&
            document.querySelector('input[name="preFocused"]:checked') &&
            document.querySelector('input[name="preConnected"]:checked') &&
            document.querySelector('input[name="preWonder"]:checked');
        
        if (preSurveySubmitBtn) {
            preSurveySubmitBtn.disabled = !allAnswered;
        }
    };
    
    // Listen for changes to enable/disable submit button
    preSurveyModal.querySelectorAll('input[type="radio"]').forEach(radio => {
        radio.addEventListener('change', updatePreSurveySubmitButton);
    });
    
    // Allow closing by clicking outside
    preSurveyModal.addEventListener('click', (e) => {
        if (e.target === preSurveyModal) {
            closePreSurveyModal();
        }
    });
    preSurveyCloseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closePreSurveyModal();
    });
    preSurveySubmitBtn.addEventListener('click', submitPreSurvey);
    
    // Initial button state check
    updatePreSurveySubmitButton();
    
    // Post-Survey modal event listeners
    const postSurveyModal = document.getElementById('postSurveyModal');
    const postSurveyCloseBtn = postSurveyModal.querySelector('.modal-close');
    const postSurveySubmitBtn = postSurveyModal.querySelector('.modal-submit');
    
    // Function to check if all post-survey questions are answered
    const updatePostSurveySubmitButton = () => {
        const allAnswered = 
            document.querySelector('input[name="postCalm"]:checked') &&
            document.querySelector('input[name="postEnergized"]:checked') &&
            document.querySelector('input[name="postNervous"]:checked') &&
            document.querySelector('input[name="postFocused"]:checked') &&
            document.querySelector('input[name="postConnected"]:checked') &&
            document.querySelector('input[name="postWonder"]:checked');
        
        if (postSurveySubmitBtn) {
            postSurveySubmitBtn.disabled = !allAnswered;
        }
    };
    
    // Listen for changes to enable/disable submit button
    postSurveyModal.querySelectorAll('input[type="radio"]').forEach(radio => {
        radio.addEventListener('change', updatePostSurveySubmitButton);
    });
    
    // Allow closing by clicking outside
    postSurveyModal.addEventListener('click', (e) => {
        if (e.target === postSurveyModal) {
            closePostSurveyModal();
        }
    });
    postSurveyCloseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closePostSurveyModal();
    });
    postSurveySubmitBtn.addEventListener('click', submitPostSurvey);
    
    // Initial button state check
    updatePostSurveySubmitButton();
    
    // AWE-SF modal event listeners
    const awesfModal = document.getElementById('awesfModal');
    const awesfCloseBtn = awesfModal.querySelector('.modal-close');
    const awesfSubmitBtn = awesfModal.querySelector('.modal-submit');
    
    awesfModal.addEventListener('click', closeAwesfModal);
    awesfCloseBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent bubble to overlay
        closeAwesfModal(); // Close without event check
    });
    awesfSubmitBtn.addEventListener('click', submitAwesfSurvey);
    
    console.log('📋 Modal event listeners attached');
}

export function openParticipantModal() {
    // Get participant ID from URL (takes precedence) or localStorage
    const participantId = getParticipantId();
    const participantIdInput = document.getElementById('participantId');
    const participantSubmitBtn = document.querySelector('#participantModal .modal-submit');
    
    if (participantIdInput) {
        // Pre-populate with ID from URL or localStorage
        participantIdInput.value = participantId || '';
        
        // If ID came from URL, show a message
        const urlId = getParticipantIdFromURL();
        if (urlId) {
            console.log('🔗 Participant ID loaded from URL:', urlId);
        }
    }
    
    // Update button state based on whether there's a value
    if (participantSubmitBtn) {
        const hasValue = participantIdInput && participantIdInput.value.trim().length > 0;
        participantSubmitBtn.disabled = !hasValue;
    }
    
    document.getElementById('participantModal').classList.add('active');
    console.log('👤 Participant Setup modal opened');
}

export function closeParticipantModal(event) {
    // Only allow programmatic closing (after submission), not by clicking outside
    // Reset field to saved value (or empty) when closing without saving
    const savedParticipantId = localStorage.getItem('participantId');
    const participantIdInput = document.getElementById('participantId');
    const participantSubmitBtn = document.querySelector('#participantModal .modal-submit');
    
    if (participantIdInput) {
        participantIdInput.value = savedParticipantId || '';
    }
    
    // Update button state based on whether there's a value
    if (participantSubmitBtn) {
        const hasValue = participantIdInput && participantIdInput.value.trim().length > 0;
        participantSubmitBtn.disabled = !hasValue;
    }
    
    document.getElementById('participantModal').classList.remove('active');
    console.log('👤 Participant Setup modal closed');
}

export function submitParticipantSetup() {
    const participantId = document.getElementById('participantId').value.trim();
    
    // Save to localStorage for persistence across sessions
    if (participantId) {
        storeParticipantId(participantId);
        console.log('💾 Saved participant ID:', participantId);
    } else {
        // If empty, remove from localStorage
        localStorage.removeItem('participantId');
        console.log('🗑️ Removed participant ID from storage');
    }
    
    console.log('📝 Participant Setup:');
    console.log('  - Participant ID:', participantId || '(none)');
    console.log('  - Timestamp:', new Date().toISOString());
    
    const statusEl = document.getElementById('status');
    statusEl.className = 'status success';
    statusEl.textContent = `✅ Participant setup recorded: ${participantId || 'Anonymous'}`;
    
    closeParticipantModal();
}

export function openPreSurveyModal() {
    document.getElementById('preSurveyModal').classList.add('active');
    console.log('📊 Pre-Survey modal opened');
}

export function closePreSurveyModal(event) {
    document.getElementById('preSurveyModal').classList.remove('active');
    console.log('📊 Pre-Survey modal closed');
}

export async function submitPreSurvey() {
    const surveyData = {
        surveyType: 'pre',
        calm: document.querySelector('input[name="preCalm"]:checked')?.value || null,
        energized: document.querySelector('input[name="preEnergized"]:checked')?.value || null,
        connected: document.querySelector('input[name="preConnected"]:checked')?.value || null,
        nervous: document.querySelector('input[name="preNervous"]:checked')?.value || null,
        focused: document.querySelector('input[name="preFocused"]:checked')?.value || null,
        wonder: document.querySelector('input[name="preWonder"]:checked')?.value || null,
        timestamp: new Date().toISOString()
    };
    
    // Verify all questions are answered (button should be disabled if not, but double-check)
    const allAnswered = surveyData.calm && surveyData.energized && surveyData.connected && 
                        surveyData.nervous && surveyData.focused && surveyData.wonder;
    
    if (!allAnswered) {
        alert('Please answer all questions before submitting.');
        return;
    }
    
    // Get participant ID (from URL or localStorage)
    const participantId = getParticipantId();
    
    console.log('📊 Pre-Survey Data:');
    console.log('  - Survey Type: Pre-Survey');
    console.log('  - Participant ID:', participantId || 'none');
    console.log('  - Calm:', surveyData.calm || 'not rated');
    console.log('  - Energized:', surveyData.energized || 'not rated');
    console.log('  - Connected to nature:', surveyData.connected || 'not rated');
    console.log('  - Nervous:', surveyData.nervous || 'not rated');
    console.log('  - Focused:', surveyData.focused || 'not rated');
    console.log('  - A sense of wonder:', surveyData.wonder || 'not rated');
    console.log('  - Timestamp:', surveyData.timestamp);
    
    const statusEl = document.getElementById('status');
    
    // Submit to Qualtrics API
    try {
        statusEl.className = 'status info';
        statusEl.textContent = '📤 Submitting to Qualtrics...';
        
        await submitSurveyResponse(surveyData, participantId);
        
        statusEl.className = 'status success';
        statusEl.textContent = '✅ Pre-Survey submitted successfully!';
        
        closePreSurveyModal();
        
        setTimeout(() => {
            document.querySelectorAll('#preSurveyModal input[type="radio"]').forEach(radio => {
                radio.checked = false;
            });
        }, 300);
    } catch (error) {
        console.error('Failed to submit pre-survey:', error);
        statusEl.className = 'status error';
        statusEl.textContent = `❌ Failed to submit: ${error.message}`;
        // Don't close modal on error so user can try again
    }
}

export function openPostSurveyModal() {
    document.getElementById('postSurveyModal').classList.add('active');
    console.log('📊 Post-Survey modal opened');
}

export function closePostSurveyModal(event) {
    document.getElementById('postSurveyModal').classList.remove('active');
    console.log('📊 Post-Survey modal closed');
}

export async function submitPostSurvey() {
    const surveyData = {
        surveyType: 'post',
        calm: document.querySelector('input[name="postCalm"]:checked')?.value || null,
        energized: document.querySelector('input[name="postEnergized"]:checked')?.value || null,
        connected: document.querySelector('input[name="postConnected"]:checked')?.value || null,
        nervous: document.querySelector('input[name="postNervous"]:checked')?.value || null,
        focused: document.querySelector('input[name="postFocused"]:checked')?.value || null,
        wonder: document.querySelector('input[name="postWonder"]:checked')?.value || null,
        timestamp: new Date().toISOString()
    };
    
    // Verify all questions are answered (button should be disabled if not, but double-check)
    const allAnswered = surveyData.calm && surveyData.energized && surveyData.connected && 
                        surveyData.nervous && surveyData.focused && surveyData.wonder;
    
    if (!allAnswered) {
        alert('Please answer all questions before submitting.');
        return;
    }
    
    // Get participant ID (from URL or localStorage)
    const participantId = getParticipantId();
    
    console.log('📊 Post-Survey Data:');
    console.log('  - Survey Type: Post-Survey');
    console.log('  - Participant ID:', participantId || 'none');
    console.log('  - Calm:', surveyData.calm || 'not rated');
    console.log('  - Energized:', surveyData.energized || 'not rated');
    console.log('  - Connected to nature:', surveyData.connected || 'not rated');
    console.log('  - Nervous:', surveyData.nervous || 'not rated');
    console.log('  - Focused:', surveyData.focused || 'not rated');
    console.log('  - A sense of wonder:', surveyData.wonder || 'not rated');
    console.log('  - Timestamp:', surveyData.timestamp);
    
    const statusEl = document.getElementById('status');
    
    // Submit to Qualtrics API
    try {
        statusEl.className = 'status info';
        statusEl.textContent = '📤 Submitting to Qualtrics...';
        
        await submitSurveyResponse(surveyData, participantId);
        
        statusEl.className = 'status success';
        statusEl.textContent = '✅ Post-Survey submitted successfully!';
        
        closePostSurveyModal();
        
        setTimeout(() => {
            document.querySelectorAll('#postSurveyModal input[type="radio"]').forEach(radio => {
                radio.checked = false;
            });
        }, 300);
    } catch (error) {
        console.error('Failed to submit post-survey:', error);
        statusEl.className = 'status error';
        statusEl.textContent = `❌ Failed to submit: ${error.message}`;
        // Don't close modal on error so user can try again
    }
}

export function openAwesfModal() {
    document.getElementById('awesfModal').classList.add('active');
    console.log('✨ AWE-SF modal opened');
}

export function closeAwesfModal(event) {
    if (!event || event.target.classList.contains('modal-overlay')) {
        document.getElementById('awesfModal').classList.remove('active');
        console.log('✨ AWE-SF modal closed');
    }
}

export async function submitAwesfSurvey() {
    const surveyData = {
        surveyType: 'awesf',
        slowDown: document.querySelector('input[name="slowDown"]:checked')?.value || null,
        reducedSelf: document.querySelector('input[name="reducedSelf"]:checked')?.value || null,
        chills: document.querySelector('input[name="chills"]:checked')?.value || null,
        oneness: document.querySelector('input[name="oneness"]:checked')?.value || null,
        grand: document.querySelector('input[name="grand"]:checked')?.value || null,
        diminishedSelf: document.querySelector('input[name="diminishedSelf"]:checked')?.value || null,
        timeSlowing: document.querySelector('input[name="timeSlowing"]:checked')?.value || null,
        awesfConnected: document.querySelector('input[name="awesfConnected"]:checked')?.value || null,
        small: document.querySelector('input[name="small"]:checked')?.value || null,
        vastness: document.querySelector('input[name="vastness"]:checked')?.value || null,
        challenged: document.querySelector('input[name="challenged"]:checked')?.value || null,
        selfShrink: document.querySelector('input[name="selfShrink"]:checked')?.value || null,
        timestamp: new Date().toISOString()
    };
    
    const hasRatings = Object.values(surveyData).some(v => v !== null && v !== surveyData.timestamp && v !== surveyData.surveyType);
    
    if (!hasRatings) {
        alert('Please rate at least one item before submitting.');
        return;
    }
    
    // Get participant ID (from URL or localStorage)
    const participantId = getParticipantId();
    
    console.log('✨ AWE-SF Survey Data:');
    console.log('  - Participant ID:', participantId || 'none');
    console.log('  - I sensed things momentarily slow down:', surveyData.slowDown || 'not rated');
    console.log('  - I experienced a reduced sense of self:', surveyData.reducedSelf || 'not rated');
    console.log('  - I had chills:', surveyData.chills || 'not rated');
    console.log('  - I experienced a sense of oneness with all things:', surveyData.oneness || 'not rated');
    console.log('  - I felt that I was in the presence of something grand:', surveyData.grand || 'not rated');
    console.log('  - I felt that my sense of self was diminished:', surveyData.diminishedSelf || 'not rated');
    console.log('  - I noticed time slowing:', surveyData.timeSlowing || 'not rated');
    console.log('  - I had the sense of being connected to everything:', surveyData.awesfConnected || 'not rated');
    console.log('  - I felt small compared to everything else:', surveyData.small || 'not rated');
    console.log('  - I perceived vastness:', surveyData.vastness || 'not rated');
    console.log('  - I felt challenged to understand the experience:', surveyData.challenged || 'not rated');
    console.log('  - I felt my sense of self shrink:', surveyData.selfShrink || 'not rated');
    console.log('  - Timestamp:', surveyData.timestamp);
    
    const statusEl = document.getElementById('status');
    
    // Submit to Qualtrics API
    try {
        statusEl.className = 'status info';
        statusEl.textContent = '📤 Submitting to Qualtrics...';
        
        await submitSurveyResponse(surveyData, participantId);
        
        statusEl.className = 'status success';
        statusEl.textContent = '✅ AWE-SF survey submitted successfully!';
        
        closeAwesfModal();
        
        setTimeout(() => {
            document.querySelectorAll('#awesfModal input[type="radio"]').forEach(radio => {
                radio.checked = false;
            });
        }, 300);
    } catch (error) {
        console.error('Failed to submit AWE-SF survey:', error);
        statusEl.className = 'status error';
        statusEl.textContent = `❌ Failed to submit: ${error.message}`;
        // Don't close modal on error so user can try again
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

