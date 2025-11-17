/**
 * ui-controls.js
 * UI controls: station loading, modals, filters, cache purge
 */

import * as State from './audio-state.js';
import { EMBEDDED_STATIONS } from './station-config.js';
import { drawWaveform, changeWaveformFilter } from './waveform-renderer.js';
import { updatePlaybackSpeed } from './audio-player.js';
import { submitCombinedSurveyResponse, getSurveyResponse, getParticipantId, storeParticipantId, getParticipantIdFromURL } from './qualtrics-api.js';
import { 
    saveSurveyResponse, 
    getSessionResponses, 
    getSessionState, 
    isSessionComplete, 
    getResponsesForSubmission, 
    markSessionAsSubmitted,
    getQualtricsResponseId,
    exportResponseMetadata,
    restoreSurveyResponses,
    trackSurveyStart,
    trackUserAction
} from '../Qualtrics/participant-response-manager.js';
import { isAdminMode } from './admin-mode.js';
import { getRegions } from './region-tracker.js';

export function loadStations() {
    const volcanoSelect = document.getElementById('volcano');
    const volcano = volcanoSelect.value;
    const stationSelect = document.getElementById('station');
    
    // Save volcano selection to localStorage for persistence across sessions
    if (volcano) {
        localStorage.setItem('selectedVolcano', volcano);
        
        // Track volcano selection
        const participantId = getParticipantId();
        if (participantId) {
            trackUserAction(participantId, 'volcano_selected', { volcano: volcano });
        }
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
    const volcanoSelect = document.getElementById('volcano');
    const currentVolcano = volcanoSelect ? volcanoSelect.value : null;
    const volcanoWithData = State.volcanoWithData;
    
    // If we're on the volcano that already has data, keep fetch button disabled
    if (volcanoWithData && currentVolcano === volcanoWithData) {
        fetchBtn.disabled = true;
        fetchBtn.title = 'This volcano already has data loaded. Select a different volcano to fetch new data.';
        console.log(`🚫 Fetch button remains disabled - ${currentVolcano} already has data`);
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

// Modal functions
// 🔥 FIX: Track if listeners have been set up to prevent duplicate attachment
let modalListenersSetup = false;

export function setupModalEventListeners() {
    // 🔥 FIX: Prevent duplicate event listener attachment
    // If listeners are already set up, remove old ones first before re-adding
    if (modalListenersSetup) {
        console.warn('⚠️ Modal listeners already set up - removing old listeners first');
        removeModalEventListeners();
    }
    
    // Check if we're in Study Mode - if so, disable click-outside-to-close for ALL modals
    // Note: This is a synchronous check, so we need to import synchronously
    let inStudyMode = false;
    try {
        // Dynamic import check - we'll check mode at runtime
        import('./master-modes.js').then(({ isStudyMode }) => {
            inStudyMode = isStudyMode();
        }).catch(() => {
            // If import fails, default to false (not study mode)
            inStudyMode = false;
        });
    } catch (e) {
        inStudyMode = false;
    }
    
    // For now, check localStorage directly as a synchronous fallback
    const storedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('selectedMode') : null;
    inStudyMode = storedMode === 'study' || storedMode === 'study_clean';
    
    // Participant modal event listeners
    const participantModal = document.getElementById('participantModal');
    if (!participantModal) {
        console.error('❌ Participant modal not found in DOM');
    } else {
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
        
        if (participantCloseBtn) {
            participantCloseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Don't allow closing via X button either - it's hidden anyway
            });
        }
        
        if (participantSubmitBtn) {
            participantSubmitBtn.addEventListener('click', submitParticipantSetup);
        }
        
        // Initial button state check
        updateParticipantSubmitButton();
    }
    
    // Welcome modal event listeners
    const welcomeModal = document.getElementById('welcomeModal');
    if (!welcomeModal) {
        console.error('❌ Welcome modal not found in DOM');
    } else {
        // In Study Mode: NEVER allow closing by clicking outside
        // In Dev/Personal Mode: Allow closing by clicking outside (if we add it)
        if (inStudyMode) {
            // Prevent closing by clicking outside in Study Mode
            welcomeModal.addEventListener('click', (e) => {
                if (e.target === welcomeModal) {
                    e.preventDefault();
                    e.stopPropagation();
                    return false;
                }
            });
        }
        
        const welcomeSubmitBtn = welcomeModal.querySelector('.modal-submit');
        if (welcomeSubmitBtn) {
            welcomeSubmitBtn.addEventListener('click', closeWelcomeModal);
        }
    }
    
    // End modal event listeners
    const endModal = document.getElementById('endModal');
    if (!endModal) {
        console.error('❌ End modal not found in DOM');
    } else {
        // In Study Mode: NEVER allow closing by clicking outside
        if (inStudyMode) {
            // Prevent closing by clicking outside in Study Mode
            endModal.addEventListener('click', (e) => {
                if (e.target === endModal) {
                    e.preventDefault();
                    e.stopPropagation();
                    return false;
                }
            });
        }
        
        const endSubmitBtn = endModal.querySelector('.modal-submit');
        if (endSubmitBtn) {
            endSubmitBtn.addEventListener('click', closeEndModal);
        }
    }
    
    // Begin Analysis modal event listeners
    const beginAnalysisModal = document.getElementById('beginAnalysisModal');
    if (!beginAnalysisModal) {
        console.error('❌ Begin Analysis modal not found in DOM');
    } else {
        // Allow closing by clicking outside (not in Study Mode restriction)
        beginAnalysisModal.addEventListener('click', (e) => {
            if (e.target === beginAnalysisModal) {
                closeBeginAnalysisModal();
            }
        });
        
        const beginAnalysisCancelBtn = beginAnalysisModal.querySelector('.modal-cancel');
        if (beginAnalysisCancelBtn) {
            beginAnalysisCancelBtn.addEventListener('click', closeBeginAnalysisModal);
        }
        
        // The submit button will be handled in main.js to proceed with the workflow
        const beginAnalysisSubmitBtn = beginAnalysisModal.querySelector('.modal-submit');
        if (beginAnalysisSubmitBtn) {
            // Store a reference that main.js can use, or we can handle it here
            // For now, we'll handle it in main.js to keep the workflow logic together
            beginAnalysisSubmitBtn.addEventListener('click', () => {
                closeBeginAnalysisModal();
                // Trigger the actual workflow - this will be handled by main.js
                // We'll dispatch a custom event that main.js listens for
                window.dispatchEvent(new CustomEvent('beginAnalysisConfirmed'));
            });
        }
    }
    
    // Pre-Survey modal event listeners
    const preSurveyModal = document.getElementById('preSurveyModal');
    if (!preSurveyModal) {
        console.error('❌ Pre-survey modal not found in DOM');
    } else {
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
        
        // In Study Mode: NEVER allow closing by clicking outside
        // In Dev/Personal Mode: Allow closing by clicking outside
        if (!inStudyMode) {
            preSurveyModal.addEventListener('click', (e) => {
                if (e.target === preSurveyModal) {
                    closePreSurveyModal();
                }
            });
        } else {
            // Prevent closing by clicking outside in Study Mode
            preSurveyModal.addEventListener('click', (e) => {
                if (e.target === preSurveyModal) {
                    e.preventDefault();
                    e.stopPropagation();
                    return false;
                }
            });
        }
        
        if (preSurveyCloseBtn) {
            preSurveyCloseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closePreSurveyModal();
            });
        }
        
        if (preSurveySubmitBtn) {
            preSurveySubmitBtn.addEventListener('click', submitPreSurvey);
        }
        
        // Initial button state check
        updatePreSurveySubmitButton();
        
        // Quick-fill button handlers for pre-survey
        preSurveyModal.querySelectorAll('.quick-fill-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const value = btn.getAttribute('data-value');
                // Fill all pre-survey radio buttons with this value
                preSurveyModal.querySelectorAll(`input[name^="pre"]`).forEach(radio => {
                    if (radio.value === value) {
                        radio.checked = true;
                        radio.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                });
                // Visual feedback
                btn.style.background = '#4CAF50';
                btn.style.color = 'white';
                setTimeout(() => {
                    btn.style.background = 'white';
                    btn.style.color = '#4CAF50';
                }, 200);
            });
        });
    }
    
    // Post-Survey modal event listeners
    const postSurveyModal = document.getElementById('postSurveyModal');
    if (!postSurveyModal) {
        console.error('❌ Post-survey modal not found in DOM');
    } else {
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
        
        // In Study Mode: NEVER allow closing by clicking outside
        // In Dev/Personal Mode: Allow closing by clicking outside
        if (!inStudyMode) {
            postSurveyModal.addEventListener('click', (e) => {
                if (e.target === postSurveyModal) {
                    closePostSurveyModal();
                }
            });
        } else {
            // Prevent closing by clicking outside in Study Mode
            postSurveyModal.addEventListener('click', (e) => {
                if (e.target === postSurveyModal) {
                    e.preventDefault();
                    e.stopPropagation();
                    return false;
                }
            });
        }
        
        if (postSurveyCloseBtn) {
            postSurveyCloseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closePostSurveyModal();
            });
        }
        
        if (postSurveySubmitBtn) {
            postSurveySubmitBtn.addEventListener('click', submitPostSurvey);
        }
        
        // Initial button state check
        updatePostSurveySubmitButton();
        
        // Quick-fill button handlers for post-survey
        postSurveyModal.querySelectorAll('.quick-fill-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const value = btn.getAttribute('data-value');
                // Fill all post-survey radio buttons with this value
                postSurveyModal.querySelectorAll(`input[name^="post"]`).forEach(radio => {
                    if (radio.value === value) {
                        radio.checked = true;
                        radio.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                });
                // Visual feedback
                btn.style.background = '#4CAF50';
                btn.style.color = 'white';
                setTimeout(() => {
                    btn.style.background = 'white';
                    btn.style.color = '#4CAF50';
                }, 200);
            });
        });
    }
    
    // Activity Level modal event listeners
    const activityLevelModal = document.getElementById('activityLevelModal');
    if (!activityLevelModal) {
        console.error('❌ Activity Level modal not found in DOM');
    } else {
        const activityLevelCloseBtn = activityLevelModal.querySelector('.modal-close');
        const activityLevelSubmitBtn = activityLevelModal.querySelector('.modal-submit');
        
        // Function to check if activity level question is answered
        const updateActivityLevelSubmitButton = () => {
            const answered = document.querySelector('input[name="activityLevel"]:checked');
            
            if (activityLevelSubmitBtn) {
                activityLevelSubmitBtn.disabled = !answered;
            }
        };
        
        // Listen for changes to enable/disable submit button
        activityLevelModal.querySelectorAll('input[type="radio"]').forEach(radio => {
            radio.addEventListener('change', updateActivityLevelSubmitButton);
        });
        
        // In Study Mode: NEVER allow closing by clicking outside
        // In Dev/Personal Mode: Allow closing by clicking outside
        if (!inStudyMode) {
            activityLevelModal.addEventListener('click', (e) => {
                if (e.target === activityLevelModal) {
                    closeActivityLevelModal();
                }
            });
        } else {
            // Prevent closing by clicking outside in Study Mode
            activityLevelModal.addEventListener('click', (e) => {
                if (e.target === activityLevelModal) {
                    e.preventDefault();
                    e.stopPropagation();
                    return false;
                }
            });
        }
        
        if (activityLevelCloseBtn) {
            activityLevelCloseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeActivityLevelModal();
            });
        }
        
        if (activityLevelSubmitBtn) {
            activityLevelSubmitBtn.addEventListener('click', submitActivityLevelSurvey);
        }
        
        // Initial button state check
        updateActivityLevelSubmitButton();
    }
    
    // AWE-SF modal event listeners
    const awesfModal = document.getElementById('awesfModal');
    if (!awesfModal) {
        console.error('❌ AWE-SF modal not found in DOM');
    } else {
        const awesfCloseBtn = awesfModal.querySelector('.modal-close');
        const awesfSubmitBtn = awesfModal.querySelector('.modal-submit');
        
        // Function to check if all AWE-SF questions are answered
        const updateAwesfSubmitButton = () => {
            const allAnswered = 
                document.querySelector('input[name="slowDown"]:checked') &&
                document.querySelector('input[name="reducedSelf"]:checked') &&
                document.querySelector('input[name="chills"]:checked') &&
                document.querySelector('input[name="oneness"]:checked') &&
                document.querySelector('input[name="grand"]:checked') &&
                document.querySelector('input[name="diminishedSelf"]:checked') &&
                document.querySelector('input[name="timeSlowing"]:checked') &&
                document.querySelector('input[name="awesfConnected"]:checked') &&
                document.querySelector('input[name="small"]:checked') &&
                document.querySelector('input[name="vastness"]:checked') &&
                document.querySelector('input[name="challenged"]:checked') &&
                document.querySelector('input[name="selfShrink"]:checked');
            
            if (awesfSubmitBtn) {
                awesfSubmitBtn.disabled = !allAnswered;
            }
        };
        
        // Listen for changes to enable/disable submit button
        awesfModal.querySelectorAll('input[type="radio"]').forEach(radio => {
            radio.addEventListener('change', updateAwesfSubmitButton);
        });
        
        // In Study Mode: NEVER allow closing by clicking outside
        // In Dev/Personal Mode: Allow closing by clicking outside
        if (!inStudyMode) {
            awesfModal.addEventListener('click', closeAwesfModal);
        } else {
            // Prevent closing by clicking outside in Study Mode
            awesfModal.addEventListener('click', (e) => {
                if (e.target === awesfModal) {
                    e.preventDefault();
                    e.stopPropagation();
                    return false;
                }
            });
        }
        
        if (awesfCloseBtn) {
            awesfCloseBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent bubble to overlay
                closeAwesfModal(); // Close without event check
            });
        }
        
        if (awesfSubmitBtn) {
            awesfSubmitBtn.addEventListener('click', submitAwesfSurvey);
        }
        
        // Initial button state check
        updateAwesfSubmitButton();
        
        // Quick-fill button handlers for AWE-SF
        awesfModal.querySelectorAll('.quick-fill-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const value = btn.getAttribute('data-value');
                // Fill all AWE-SF radio buttons with this value
                awesfModal.querySelectorAll('input[type="radio"]').forEach(radio => {
                    if (radio.value === value) {
                        radio.checked = true;
                        radio.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                });
                // Visual feedback
                btn.style.background = '#4CAF50';
                btn.style.color = 'white';
                setTimeout(() => {
                    btn.style.background = 'white';
                    btn.style.color = '#4CAF50';
                }, 200);
            });
        });
    }
    
    modalListenersSetup = true;
    console.log('📋 Modal event listeners attached');
}

/**
 * Remove all modal event listeners to prevent NativeContext accumulation
 * Called before re-adding listeners to ensure old closures are broken
 */
function removeModalEventListeners() {
    // 🔥 FIX: Clone modals to break all event listener references
    // This ensures old closures (NativeContext instances) can be garbage collected
    const modalIds = ['participantModal', 'preSurveyModal', 'postSurveyModal', 'activityLevelModal', 'awesfModal'];
    
    modalIds.forEach(modalId => {
        const modal = document.getElementById(modalId);
        if (modal) {
            if (modal.parentNode) {
                // Clone to break all event listeners
                const cloned = modal.cloneNode(true); // Deep clone to preserve structure
                modal.parentNode.replaceChild(cloned, modal);
                // The original modal with listeners is now detached and can be GC'd
                // Clear all child nodes from the cloned modal to break internal references
                while (cloned.firstChild) {
                    cloned.removeChild(cloned.firstChild);
                }
                // Remove the clone itself
                cloned.parentNode.removeChild(cloned);
            } else {
                // Already detached, clear all child nodes to break internal references
                while (modal.firstChild) {
                    modal.removeChild(modal.firstChild);
                }
            }
        }
    });
    
    modalListenersSetup = false;
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
    
    document.getElementById('participantModal').style.display = 'flex';
    console.log('👤 Participant Setup modal opened');
}

export function closeParticipantModal(event) {
    // Only allow programmatic closing (after submission), not by clicking outside
    // Reset field to saved value (or empty) when closing without saving
    // In STUDY_CLEAN mode, don't load saved participant ID
    const storedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('selectedMode') : null;
    const isStudyClean = storedMode === 'study_clean';
    const savedParticipantId = isStudyClean ? null : localStorage.getItem('participantId');
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
    
    document.getElementById('participantModal').style.display = 'none';
    console.log('👤 Participant Setup modal closed');
}

// Welcome Modal Functions
export async function openWelcomeModal() {
    // In Study Mode, ONLY allow welcome modal through the workflow - NEVER allow manual opening
    const { isStudyMode, isStudyCleanMode } = await import('./master-modes.js');
    if (isStudyMode()) {
        // In STUDY mode, welcome modal can ONLY be opened through the workflow
        // Check if we're in the workflow by checking if pre-survey is already open
        const preSurveyModal = document.getElementById('preSurveyModal');
        const isPreSurveyOpen = preSurveyModal && preSurveyModal.style.display !== 'none';
        
        // If pre-survey is open, we're past the welcome step - don't allow welcome modal
        if (isPreSurveyOpen) {
            console.warn('⚠️ Welcome modal: Cannot open - pre-survey is already active');
            return;
        }
        
        const hasSeenParticipantSetup = localStorage.getItem('study_has_seen_participant_setup') === 'true';
        if (!hasSeenParticipantSetup) {
            console.warn('⚠️ Welcome modal: Participant setup must be completed first in Study Mode');
            return;
        }
        
        // In STUDY mode (not clean), only show welcome modal once (first time only)
        if (!isStudyCleanMode()) {
            const hasSeenWelcome = localStorage.getItem('study_has_seen_welcome') === 'true';
            if (hasSeenWelcome) {
                console.log('✅ Welcome modal already seen - skipping in STUDY mode');
                return;
            }
        }
    }
    
    const welcomeModal = document.getElementById('welcomeModal');
    if (!welcomeModal) {
        console.warn('⚠️ Welcome modal not found');
        return;
    }
    
    // CRITICAL: Close any other modals first to prevent multiple modals showing
    const allModals = ['preSurveyModal', 'postSurveyModal', 'activityLevelModal', 'awesfModal', 'endModal', 'participantModal'];
    allModals.forEach(modalId => {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.style.display = 'none';
        }
    });
    
    welcomeModal.style.display = 'flex';
    console.log('👋 Welcome modal opened');
}

export function closeWelcomeModal() {
    document.getElementById('welcomeModal').style.display = 'none';
    console.log('👋 Welcome modal closed');
}

// End Modal Functions
export function openEndModal(participantId, sessionCount) {
    const modal = document.getElementById('endModal');
    
    // Update submission time with local time including seconds
    const now = new Date();
    const timeString = now.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit',
        hour12: true 
    });
    document.getElementById('submissionTime').textContent = timeString;
    
    // Update participant ID
    document.getElementById('submissionParticipantId').textContent = participantId;
    
    // Update session count
    document.getElementById('sessionCount').textContent = sessionCount;
    
    modal.style.display = 'flex';
    console.log('🎉 End modal opened');
}

export function closeEndModal() {
    document.getElementById('endModal').style.display = 'none';
    console.log('🎉 End modal closed');
}

// Begin Analysis Modal Functions
export function openBeginAnalysisModal() {
    const modal = document.getElementById('beginAnalysisModal');
    if (modal) {
        modal.style.display = 'flex';
        console.log('🔵 Begin Analysis modal opened');
    }
}

export function closeBeginAnalysisModal() {
    const modal = document.getElementById('beginAnalysisModal');
    if (modal) {
        modal.style.display = 'none';
        console.log('🔵 Begin Analysis modal closed');
    }
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
    
    // Update participant ID display in top panel
    // In Personal and Dev modes, always show the display (even if no ID set)
    // In Study modes, only show if participant ID exists
    const displayElement = document.getElementById('participantIdDisplay');
    const valueElement = document.getElementById('participantIdValue');
    
    // Import mode checkers - use dynamic import to avoid circular dependencies
    import('./master-modes.js').then(({ isPersonalMode, isDevMode }) => {
        const shouldShow = isPersonalMode() || isDevMode() || !!participantId;
        
        if (shouldShow) {
            if (displayElement) displayElement.style.display = 'block';
            if (valueElement) valueElement.textContent = participantId || '--';
        } else {
            if (displayElement) displayElement.style.display = 'none';
            if (valueElement) valueElement.textContent = '--';
        }
    }).catch(() => {
        // Fallback: show if participant ID exists
        if (participantId) {
            if (displayElement) displayElement.style.display = 'block';
            if (valueElement) valueElement.textContent = participantId;
        } else {
            if (displayElement) displayElement.style.display = 'none';
            if (valueElement) valueElement.textContent = '--';
        }
    });
    
    // Hide the participant modal after submission
    document.getElementById('participantModal').style.display = 'none';
}

export function openPreSurveyModal() {
    const preSurveyModal = document.getElementById('preSurveyModal');
    if (!preSurveyModal) {
        console.warn('⚠️ Pre-survey modal not found');
        return;
    }
    
    // CRITICAL: Close any other modals first to prevent multiple modals showing
    const allModals = ['welcomeModal', 'postSurveyModal', 'activityLevelModal', 'awesfModal', 'endModal', 'participantModal'];
    allModals.forEach(modalId => {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.style.display = 'none';
        }
    });
    
    preSurveyModal.style.display = 'flex';
    console.log('📊 Pre-Survey modal opened');
    
    // Track survey start
    const participantId = getParticipantId();
    if (participantId) {
        trackSurveyStart(participantId, 'pre');
    }
}

export function closePreSurveyModal(event) {
    document.getElementById('preSurveyModal').style.display = 'none';
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
    
    if (!participantId) {
        alert('Please set your participant ID before submitting surveys.');
        return;
    }
    
    console.log('📊 Pre-Survey Data:');
    console.log('  - Survey Type: Pre-Survey');
    console.log('  - Participant ID:', participantId);
    console.log('  - Calm:', surveyData.calm || 'not rated');
    console.log('  - Energized:', surveyData.energized || 'not rated');
    console.log('  - Connected to nature:', surveyData.connected || 'not rated');
    console.log('  - Nervous:', surveyData.nervous || 'not rated');
    console.log('  - Focused:', surveyData.focused || 'not rated');
    console.log('  - A sense of wonder:', surveyData.wonder || 'not rated');
    console.log('  - Timestamp:', surveyData.timestamp);
    
    const statusEl = document.getElementById('status');
    
    try {
        // Save response locally instead of submitting immediately
        statusEl.className = 'status info';
        statusEl.textContent = '💾 Saving pre-survey response...';
        
        saveSurveyResponse(participantId, 'pre', surveyData);
        
        statusEl.className = 'status success';
        statusEl.textContent = '✅ Pre-Survey saved! Complete all surveys to submit.';
        
        closePreSurveyModal();
        
        setTimeout(() => {
            document.querySelectorAll('#preSurveyModal input[type="radio"]').forEach(radio => {
                radio.checked = false;
            });
        }, 300);
    } catch (error) {
        console.error('Failed to save pre-survey:', error);
        statusEl.className = 'status error';
        statusEl.textContent = `❌ Failed to save: ${error.message}`;
        // Don't close modal on error so user can try again
    }
}

export function openPostSurveyModal() {
    document.getElementById('postSurveyModal').style.display = 'flex';
    console.log('📊 Post-Survey modal opened');
    
    // Track survey start
    const participantId = getParticipantId();
    if (participantId) {
        trackSurveyStart(participantId, 'post');
    }
}

export function closePostSurveyModal(event) {
    document.getElementById('postSurveyModal').style.display = 'none';
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
    
    if (!participantId) {
        alert('Please set your participant ID before submitting surveys.');
        return;
    }
    
    console.log('📊 Post-Survey Data:');
    console.log('  - Survey Type: Post-Survey');
    console.log('  - Participant ID:', participantId);
    console.log('  - Calm:', surveyData.calm || 'not rated');
    console.log('  - Energized:', surveyData.energized || 'not rated');
    console.log('  - Connected to nature:', surveyData.connected || 'not rated');
    console.log('  - Nervous:', surveyData.nervous || 'not rated');
    console.log('  - Focused:', surveyData.focused || 'not rated');
    console.log('  - A sense of wonder:', surveyData.wonder || 'not rated');
    console.log('  - Timestamp:', surveyData.timestamp);
    
    const statusEl = document.getElementById('status');
    
    try {
        // Save response locally instead of submitting immediately
        statusEl.className = 'status info';
        statusEl.textContent = '💾 Saving post-survey response...';
        
        saveSurveyResponse(participantId, 'post', surveyData);
        
        statusEl.className = 'status success';
        statusEl.textContent = '✅ Post-Survey saved! Complete all surveys to submit.';
        
        closePostSurveyModal();
        
        setTimeout(() => {
            document.querySelectorAll('#postSurveyModal input[type="radio"]').forEach(radio => {
                radio.checked = false;
            });
        }, 300);
    } catch (error) {
        console.error('Failed to save post-survey:', error);
        statusEl.className = 'status error';
        statusEl.textContent = `❌ Failed to save: ${error.message}`;
        // Don't close modal on error so user can try again
    }
}

export function openActivityLevelModal() {
    document.getElementById('activityLevelModal').style.display = 'flex';
    console.log('🌋 Activity Level modal opened');
    
    // Track survey start
    const participantId = getParticipantId();
    if (participantId) {
        trackSurveyStart(participantId, 'activityLevel');
    }
}

export function closeActivityLevelModal(event) {
    document.getElementById('activityLevelModal').style.display = 'none';
    console.log('🌋 Activity Level modal closed');
}

export async function submitActivityLevelSurvey() {
    const surveyData = {
        surveyType: 'activityLevel',
        activityLevel: document.querySelector('input[name="activityLevel"]:checked')?.value || null,
        timestamp: new Date().toISOString()
    };
    
    // Verify question is answered
    if (!surveyData.activityLevel) {
        alert('Please select an activity level before submitting.');
        return;
    }
    
    // Get participant ID (from URL or localStorage)
    const participantId = getParticipantId();
    
    if (!participantId) {
        alert('Please set your participant ID before submitting surveys.');
        return;
    }
    
    console.log('🌋 Activity Level Survey Data:');
    console.log('  - Participant ID:', participantId);
    console.log('  - Activity Level:', surveyData.activityLevel || 'not rated');
    console.log('  - Timestamp:', surveyData.timestamp);
    
    const statusEl = document.getElementById('status');
    
    try {
        // Save response locally instead of submitting immediately
        statusEl.className = 'status info';
        statusEl.textContent = '💾 Saving activity level response...';
        
        saveSurveyResponse(participantId, 'activityLevel', surveyData);
        
        statusEl.className = 'status success';
        statusEl.textContent = '✅ Activity Level saved! Complete all surveys to submit.';
        
        closeActivityLevelModal();
        
        setTimeout(() => {
            document.querySelectorAll('#activityLevelModal input[type="radio"]').forEach(radio => {
                radio.checked = false;
            });
        }, 300);
    } catch (error) {
        console.error('Failed to save activity level survey:', error);
        statusEl.className = 'status error';
        statusEl.textContent = `❌ Failed to save: ${error.message}`;
        // Don't close modal on error so user can try again
    }
}

export function openAwesfModal() {
    document.getElementById('awesfModal').style.display = 'flex';
    console.log('✨ AWE-SF modal opened');
    
    // Track survey start
    const participantId = getParticipantId();
    if (participantId) {
        trackSurveyStart(participantId, 'awesf');
    }
}

export function closeAwesfModal(event) {
    document.getElementById('awesfModal').style.display = 'none';
    console.log('✨ AWE-SF modal closed');
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
    
    // Verify all questions are answered
    const allAnswered = surveyData.slowDown && surveyData.reducedSelf && surveyData.chills && 
                        surveyData.oneness && surveyData.grand && surveyData.diminishedSelf &&
                        surveyData.timeSlowing && surveyData.awesfConnected && surveyData.small &&
                        surveyData.vastness && surveyData.challenged && surveyData.selfShrink;
    
    if (!allAnswered) {
        alert('Please answer all questions before submitting.');
        return;
    }
    
    // Get participant ID (from URL or localStorage)
    const participantId = getParticipantId();
    
    if (!participantId) {
        alert('Please set your participant ID before submitting surveys.');
        return;
    }
    
    console.log('✨ AWE-SF Survey Data:');
    console.log('  - Participant ID:', participantId);
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
    
    try {
        // Save response locally instead of submitting immediately
        statusEl.className = 'status info';
        statusEl.textContent = '💾 Saving AWE-SF response...';
        
        saveSurveyResponse(participantId, 'awesf', surveyData);
        
        statusEl.className = 'status success';
        statusEl.textContent = '✅ AWE-SF saved! Complete all surveys to submit.';
        
        closeAwesfModal();
        
        setTimeout(() => {
            document.querySelectorAll('#awesfModal input[type="radio"]').forEach(radio => {
                radio.checked = false;
            });
        }, 300);
    } catch (error) {
        console.error('Failed to save AWE-SF survey:', error);
        statusEl.className = 'status error';
        statusEl.textContent = `❌ Failed to save: ${error.message}`;
        // Don't close modal on error so user can try again
    }
}

/**
 * Check if session is complete and submit all responses to Qualtrics if ready
 * @param {string} participantId - The participant ID
 */
async function checkAndSubmitIfComplete(participantId) {
    if (!participantId) return;
    
    try {
        // Check if session is complete
        if (isSessionComplete(participantId)) {
            const combinedResponses = getResponsesForSubmission(participantId);
            
            if (combinedResponses) {
                const statusEl = document.getElementById('status');
                statusEl.className = 'status info';
                statusEl.textContent = '📤 All surveys complete! Submitting to Qualtrics...';
                
                console.log('📤 Submitting combined responses to Qualtrics:', combinedResponses);
                
                const submissionResult = await submitCombinedSurveyResponse(combinedResponses, participantId);
                
                // Extract Qualtrics Response ID
                let qualtricsResponseId = null;
                if (submissionResult && submissionResult.result && submissionResult.result.responseId) {
                    qualtricsResponseId = submissionResult.result.responseId;
                    console.log('📋 Qualtrics Response ID:', qualtricsResponseId);
                }
                
                // Mark session as submitted with Qualtrics response ID
                markSessionAsSubmitted(participantId, qualtricsResponseId);
                
                // Export response metadata to JSON file
                if (qualtricsResponseId) {
                    exportResponseMetadata(participantId, qualtricsResponseId, submissionResult);
                }
                
                statusEl.className = 'status success';
                let successMsg = '✅ All surveys submitted successfully to Qualtrics!';
                if (qualtricsResponseId) {
                    successMsg += ` Response ID: ${qualtricsResponseId}`;
                }
                statusEl.textContent = successMsg;
                
                console.log('✅ Session completed and submitted successfully');
            }
        }
    } catch (error) {
        console.error('Error checking/submitting session:', error);
        const statusEl = document.getElementById('status');
        statusEl.className = 'status error';
        statusEl.textContent = `❌ Error submitting to Qualtrics: ${error.message}`;
        throw error;
    }
}

/**
 * Format regions and features for backend submission
 * Prepares data with all time fields in UTC ISO format
 * @param {Array} regions - Array of region objects from region-tracker
 * @returns {Array} Formatted regions array ready for submission
 */
function formatRegionsForSubmission(regions) {
    if (!regions || regions.length === 0) {
        return [];
    }
    
    return regions.map((region, regionIndex) => {
        const formattedRegion = {
            regionNumber: regionIndex + 1, // 1-indexed, reflects final order (shifts when regions deleted)
            regionId: region.id, // Internal tracking ID (persistent, not needed for backend)
            // Region times in UTC ISO format
            regionStartTime: region.startTime || null,
            regionEndTime: region.stopTime || null,
            featureCount: region.featureCount || 0,
            features: []
        };
        
        // Format features within this region
        if (region.features && region.features.length > 0) {
            formattedRegion.features = region.features.map((feature, featureIndex) => {
                return {
                    featureNumber: featureIndex + 1, // 1-indexed for display
                    // Feature times in UTC ISO format (prepared for backend endpoint)
                    featureStartTime: feature.startTime || null,
                    featureEndTime: feature.endTime || null,
                    // Frequency data
                    lowFreq: feature.lowFreq || null,
                    highFreq: feature.highFreq || null,
                    // Feature metadata
                    type: feature.type || null,
                    repetition: feature.repetition || null,
                    notes: feature.notes || null
                };
            });
        }
        
        return formattedRegion;
    });
}

export async function attemptSubmission() {
    // ═══════════════════════════════════════════════════════════
    // 🎓 STUDY MODE: Route to study workflow for post-session surveys
    // ═══════════════════════════════════════════════════════════
    const { isStudyMode } = await import('./master-modes.js');
    if (isStudyMode()) {
        console.log('🎓 Study Mode: Routing to study workflow submit handler');
        const { handleStudyModeSubmit } = await import('./study-workflow.js');
        return await handleStudyModeSubmit();
    }
    
    // ═══════════════════════════════════════════════════════════
    // 💾 PERSONAL/DEV MODE: Direct submission (no post-session surveys)
    // ═══════════════════════════════════════════════════════════
    console.log('═══════════════════════════════════════════════════════════');
    console.log('🚀 SUBMISSION ATTEMPT STARTED');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('⏰ Timestamp:', new Date().toISOString());
    
    const statusEl = document.getElementById('status');
    
    try {
        // Step 1: Get participant ID
        console.log('\n📋 STEP 1: Getting participant ID...');
        const participantId = getParticipantId();
        console.log('   Participant ID:', participantId || '❌ NOT FOUND');
        
        if (!participantId) {
            const errorMsg = 'No participant ID found. Please set your participant ID first.';
            console.error('   ❌ ERROR:', errorMsg);
            statusEl.className = 'status error';
            statusEl.textContent = `❌ ${errorMsg}`;
            return;
        }
        console.log('   ✅ Participant ID found');
        
        // Step 2: Get session state
        console.log('\n📋 STEP 2: Checking session state...');
        const sessionState = getSessionState(participantId);
        console.log('   Session State:', sessionState ? JSON.stringify(sessionState, null, 2) : '❌ NO SESSION FOUND');
        
        if (!sessionState) {
            const errorMsg = 'No active session found. Please complete at least one survey first.';
            console.error('   ❌ ERROR:', errorMsg);
            statusEl.className = 'status error';
            statusEl.textContent = `❌ ${errorMsg}`;
            return;
        }
        console.log('   ✅ Session found');
        console.log('   - Session ID:', sessionState.sessionId);
        console.log('   - Status:', sessionState.status);
        console.log('   - Started At:', sessionState.startedAt);
        
        // Step 3: Get session responses
        console.log('\n📋 STEP 3: Retrieving session responses...');
        const responses = getSessionResponses(participantId);
        console.log('   Responses:', responses ? JSON.stringify(responses, null, 2) : '❌ NO RESPONSES FOUND');
        
        if (!responses) {
            const errorMsg = 'No responses found for this session.';
            console.error('   ❌ ERROR:', errorMsg);
            statusEl.className = 'status error';
            statusEl.textContent = `❌ ${errorMsg}`;
            return;
        }
        console.log('   ✅ Responses retrieved');
        
        // Step 4: Check what surveys are completed
        console.log('\n📋 STEP 4: Checking survey completion status...');
        const hasPre = !!responses.pre;
        const hasPost = !!responses.post;
        const hasAwesf = !!responses.awesf;
        console.log('   Pre-Survey:', hasPre ? '✅ COMPLETE' : '❌ MISSING');
        console.log('   Post-Survey:', hasPost ? '✅ COMPLETE' : '❌ MISSING');
        console.log('   AWE-SF:', hasAwesf ? '✅ COMPLETE' : '❌ MISSING');
        
        if (hasPre) {
            console.log('   Pre-Survey Data:', JSON.stringify(responses.pre, null, 2));
        }
        if (hasPost) {
            console.log('   Post-Survey Data:', JSON.stringify(responses.post, null, 2));
        }
        if (hasAwesf) {
            console.log('   AWE-SF Data:', JSON.stringify(responses.awesf, null, 2));
        }
        
        // Step 5: Check if session is complete
        console.log('\n📋 STEP 5: Checking if session is complete...');
        const isComplete = isSessionComplete(participantId);
        console.log('   Session Complete:', isComplete ? '✅ YES' : '❌ NO');
        
        if (!isComplete) {
            const missingSurveys = [];
            if (!hasPre) missingSurveys.push('Pre-Survey');
            if (!hasPost) missingSurveys.push('Post-Survey');
            if (!hasAwesf) missingSurveys.push('AWE-SF');
            
            const warningMsg = `Session incomplete. Missing: ${missingSurveys.join(', ')}. Submitting partial data...`;
            console.warn('   ⚠️ WARNING:', warningMsg);
            statusEl.className = 'status info';
            statusEl.textContent = `⚠️ ${warningMsg}`;
        } else {
            console.log('   ✅ All surveys complete');
        }
        
        // Step 6: Prepare combined responses for submission
        console.log('\n📋 STEP 6: Preparing combined responses for submission...');
        
        // Get tracking data from session state
        const trackingData = sessionState.tracking || null;
        
        // Get regions and features data
        const regions = getRegions();
        const formattedRegions = formatRegionsForSubmission(regions);
        console.log('   📊 Regions data:', {
            regionCount: formattedRegions.length,
            totalFeatures: formattedRegions.reduce((sum, r) => sum + (r.features?.length || 0), 0),
            hasRegionTimes: formattedRegions.some(r => r.regionStartTime && r.regionEndTime),
            hasFeatureTimes: formattedRegions.some(r => r.features?.some(f => f.featureStartTime && f.featureEndTime))
        });
        
        // Build JSON dump with tracking information
        const jsonDump = {
            sessionId: responses.sessionId,
            participantId: responses.participantId,
            sessionStarted: trackingData?.sessionStarted || sessionState.startedAt || null,
            tracking: trackingData || null,
            regions: formattedRegions,
            submissionTimestamp: new Date().toISOString()
        };
        
        const combinedResponses = {
            pre: responses.pre || null,
            post: responses.post || null,
            awesf: responses.awesf || null,
            sessionId: responses.sessionId,
            participantId: responses.participantId,
            createdAt: responses.createdAt,
            jsonDump: jsonDump
        };
        console.log('   Combined Responses:', JSON.stringify(combinedResponses, null, 2));
        console.log('   JSON Dump:', JSON.stringify(jsonDump, null, 2));
        console.log('   Response Count:', {
            pre: hasPre ? 1 : 0,
            post: hasPost ? 1 : 0,
            awesf: hasAwesf ? 1 : 0,
            total: (hasPre ? 1 : 0) + (hasPost ? 1 : 0) + (hasAwesf ? 1 : 0)
        });
        
        // Detailed logging for each survey type
        if (combinedResponses.pre) {
            console.log('   ✅ Pre-survey data included:', Object.keys(combinedResponses.pre));
        } else {
            console.warn('   ⚠️ Pre-survey data MISSING - will not be submitted to Qualtrics');
        }
        if (combinedResponses.post) {
            console.log('   ✅ Post-survey data included:', Object.keys(combinedResponses.post));
        } else {
            console.warn('   ⚠️ Post-survey data MISSING - will not be submitted to Qualtrics');
        }
        if (combinedResponses.awesf) {
            console.log('   ✅ AWE-SF data included:', Object.keys(combinedResponses.awesf));
        } else {
            console.warn('   ⚠️ AWE-SF data MISSING - will not be submitted to Qualtrics');
        }
        
        // Step 7: Attempt submission
        console.log('\n📋 STEP 7: Submitting to Qualtrics API...');
        statusEl.className = 'status info';
        statusEl.textContent = '📤 Submitting to Qualtrics...';
        
        console.log('   API Endpoint: Qualtrics API v3');
        console.log('   Survey ID: SV_bNni117IsBWNZWu');
        console.log('   Participant ID:', participantId);
        console.log('   Payload Preview:', {
            hasPre,
            hasPost,
            hasAwesf,
            valuesCount: 'Will be calculated by API'
        });
        
        const startTime = Date.now();
        let submissionResult;
        
        try {
            submissionResult = await submitCombinedSurveyResponse(combinedResponses, participantId);
            const duration = Date.now() - startTime;
            
            console.log('   ✅ Submission successful!');
            console.log('   Response Time:', duration, 'ms');
            console.log('   API Response:', JSON.stringify(submissionResult, null, 2));
            
            // Extract Qualtrics Response ID
            let qualtricsResponseId = null;
            if (submissionResult && submissionResult.result && submissionResult.result.responseId) {
                qualtricsResponseId = submissionResult.result.responseId;
                console.log('   📋 Qualtrics Response ID:', qualtricsResponseId);
                console.log('   💡 Use this ID in Qualtrics/response-viewer.html to verify what was submitted');
            } else {
                console.warn('   ⚠️ No responseId found in submission result');
                console.log('   Full result:', submissionResult);
            }
            
            // Step 8: Mark session as submitted with Qualtrics response ID
            console.log('\n📋 STEP 8: Marking session as submitted...');
            markSessionAsSubmitted(participantId, qualtricsResponseId);
            console.log('   ✅ Session marked as submitted');
            
            // Step 9: Export response metadata to JSON file
            if (qualtricsResponseId) {
                console.log('\n📋 STEP 9: Exporting response metadata...');
                exportResponseMetadata(participantId, qualtricsResponseId, submissionResult);
                console.log('   ✅ Response metadata exported to JSON file');
            }
            
            statusEl.className = 'status success';
            let successMsg = '✅ Successfully submitted to Qualtrics!';
            if (qualtricsResponseId) {
                successMsg += ` Response ID: ${qualtricsResponseId}`;
            }
            statusEl.textContent = successMsg;
            
            console.log('\n═══════════════════════════════════════════════════════════');
            console.log('✅ SUBMISSION ATTEMPT COMPLETED SUCCESSFULLY');
            if (qualtricsResponseId) {
                console.log(`📋 Qualtrics Response ID: ${qualtricsResponseId}`);
            }
            console.log('═══════════════════════════════════════════════════════════');
            
        } catch (apiError) {
            const duration = Date.now() - startTime;
            console.error('   ❌ Submission failed!');
            console.error('   Response Time:', duration, 'ms');
            console.error('   Error Type:', apiError.constructor.name);
            console.error('   Error Message:', apiError.message);
            console.error('   Error Stack:', apiError.stack);
            
            if (apiError.message) {
                // Try to extract more details from error message
                try {
                    const errorMatch = apiError.message.match(/\{.*\}/);
                    if (errorMatch) {
                        const errorJson = JSON.parse(errorMatch[0]);
                        console.error('   Parsed Error Details:', JSON.stringify(errorJson, null, 2));
                    }
                } catch (e) {
                    // Ignore parsing errors
                }
            }
            
            statusEl.className = 'status error';
            statusEl.textContent = `❌ Submission failed: ${apiError.message}`;
            
            console.log('\n═══════════════════════════════════════════════════════════');
            console.log('❌ SUBMISSION ATTEMPT FAILED');
            console.log('═══════════════════════════════════════════════════════════');
            
            throw apiError;
        }
        
    } catch (error) {
        console.error('\n❌ FATAL ERROR in submission attempt:');
        console.error('   Error Type:', error.constructor.name);
        console.error('   Error Message:', error.message);
        console.error('   Error Stack:', error.stack);
        
        statusEl.className = 'status error';
        statusEl.textContent = `❌ Error: ${error.message}`;
        
        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('❌ SUBMISSION ATTEMPT FAILED WITH FATAL ERROR');
        console.log('═══════════════════════════════════════════════════════════');
        
        throw error;
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

