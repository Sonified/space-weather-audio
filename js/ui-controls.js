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
import { isStudyMode, isStudyCleanMode, CURRENT_MODE, AppMode, isLocalEnvironment } from './master-modes.js';
import { modalManager } from './modal-manager.js';

/**
 * Fade in the permanent overlay background (modal background)
 * Standard design pattern: background fades up when modal appears
 * If overlay is already visible, skips the fade to prevent flicker
 */
/**
 * Hide tutorial help button and disable participant ID clicking when modals are open
 */
function hideUIElementsForModal() {
    const tutorialHelpBtn = document.getElementById('tutorialHelpBtn');
    if (tutorialHelpBtn) {
        tutorialHelpBtn.style.display = 'none';
    }
    
    const participantIdText = document.getElementById('participantIdText');
    if (participantIdText) {
        participantIdText.style.pointerEvents = 'none';
        participantIdText.style.cursor = 'default';
        participantIdText.style.opacity = '0.5';
    }
}

/**
 * Show tutorial help button and enable participant ID clicking when modals are closed
 */
function showUIElementsAfterModal() {
    // Only show if in study mode and no modals are visible
    const anyModalVisible = checkIfAnyModalVisible();
    if (anyModalVisible) {
        return; // Still have modals open, don't show yet
    }
    
    // Check if in study mode (synchronous check)
    const storedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('selectedMode') : null;
    const inStudyMode = storedMode === 'study' || storedMode === 'study_clean';
    
    const tutorialHelpBtn = document.getElementById('tutorialHelpBtn');
    if (tutorialHelpBtn && inStudyMode) {
        tutorialHelpBtn.style.display = 'flex';
    }
    
    const participantIdText = document.getElementById('participantIdText');
    if (participantIdText) {
        participantIdText.style.pointerEvents = 'auto';
        participantIdText.style.cursor = 'pointer';
        participantIdText.style.opacity = '1';
    }
}

/**
 * Check if any modal is currently visible
 */
function checkIfAnyModalVisible() {
    const allModalIds = [
        'welcomeModal',
        'participantModal',
        'preSurveyModal',
        'postSurveyModal',
        'activityLevelModal',
        'awesfModal',
        'endModal',
        'beginAnalysisModal',
        'missingStudyIdModal',
        'completeConfirmationModal',
        'tutorialIntroModal',
        'tutorialRevisitModal'
    ];
    
    return allModalIds.some(modalId => {
        const modal = document.getElementById(modalId);
        return modal && modal.style.display !== 'none' && modal.style.display !== '';
    });
}

function fadeInOverlay() {
    const overlay = document.getElementById('permanentOverlay');
    if (!overlay) return;
    
    // Hide UI elements when modal opens
    hideUIElementsForModal();
    
    // Check if overlay is already visible (opacity > 0 and display is not 'none')
    const isAlreadyVisible = overlay.style.display !== 'none' && 
                            (overlay.style.opacity === '1' || 
                             parseFloat(overlay.style.opacity) > 0 ||
                             !overlay.style.opacity); // No inline style means CSS default (likely visible)
    
    if (isAlreadyVisible) {
        // Overlay already visible - just ensure it's displayed, no fade needed
        overlay.style.display = 'flex';
        overlay.style.opacity = '1';
        return;
    }
    
    // Overlay not visible - fade it in
    overlay.style.opacity = '0';
    overlay.style.display = 'flex';
    
    // Force reflow
    void overlay.offsetHeight;
    
    overlay.style.transition = 'opacity 0.3s ease-in';
    overlay.style.opacity = '1';
}

/**
 * Fade out the permanent overlay background (modal background)
 * Standard design pattern: background fades down when modal leaves
 */
function fadeOutOverlay() {
    const overlay = document.getElementById('permanentOverlay');
    if (!overlay) return;
    
    overlay.style.transition = 'opacity 0.3s ease-out';
    overlay.style.opacity = '0';
    
    setTimeout(() => {
        if (overlay.style.opacity === '0') {
            overlay.style.display = 'none';
        }
        // Show UI elements after overlay fades out (check if no modals are visible)
        showUIElementsAfterModal();
    }, 300);
}

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
        if (!isStudyMode()) {
            console.log('💾 Restored volcano selection:', savedVolcano);
        }
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
    
    const defaultIndex = (volcano === 'kilauea') ? 3 : 0;
    
    stationSelect.innerHTML = stations.map((s, index) => 
        `<option value='${JSON.stringify(s)}' ${index === defaultIndex ? 'selected' : ''}>${s.label}</option>`
    ).join('');
    
    if (!isStudyMode()) {
        console.log(`✅ Populated ${stations.length} ${dataType} stations`);
    }
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

/**
 * Determine if there's another modal coming after this one in the workflow
 * Returns the next modal ID if there is one, null if this is the last modal
 * @param {string} currentModalId - The current modal ID being closed
 * @returns {string|null} - Next modal ID or null
 */
async function getNextModalInWorkflow(currentModalId) {
    // Only check workflow sequence in study mode
    if (!isStudyMode()) {
        return null; // In non-study modes, no automatic workflow
    }
    
    // ═══════════════════════════════════════════════════════════
    // GOSPEL: Follow VISIT RULES from study-workflow.js exactly
    // Use the same logic functions from study-workflow.js
    // ═══════════════════════════════════════════════════════════
    // 
    // FIRST VISIT EVER:
    //   1. Participant Setup → 2. Welcome → 3. Pre-Survey → 4. Tutorial → 
    //   5. Experience → 6. Activity Level → 7. AWE-SF (if first time week) → 
    //   8. Post-Survey → 9. End
    // 
    // SUBSEQUENT VISITS (SAME WEEK):
    //   1. Pre-Survey → 2. Experience → 3. Activity Level → 
    //   4. Post-Survey → 5. End
    // 
    // FIRST VISIT OF NEW WEEK:
    //   1. Pre-Survey → 2. Experience → 3. Activity Level → 
    //   4. AWE-SF → 5. Post-Survey → 6. End
    
    // Use workflow logic functions from study-workflow.js (same source of truth)
    // Note: These functions handle study_clean mode and test modes correctly
    const { hasSeenTutorial, hasCompletedAwesfThisWeek, hasSeenParticipantSetup } = await import('./study-workflow.js');
    
    // Tutorial should show if they haven't seen it yet (regardless of participant setup status)
    // The check for first visit ever is just for determining the flow, but tutorial is independent
    const needsTutorial = !hasSeenTutorial();
    const needsAwesf = !hasCompletedAwesfThisWeek();
    
    // Check if this is first visit ever for flow routing
    const isFirstVisitEver = !hasSeenParticipantSetup();
    
    switch (currentModalId) {
        case 'participantModal':
            // FIRST VISIT EVER: Step 1 → Step 2
            // Participant Setup → Welcome
            return 'welcomeModal';
            
        case 'welcomeModal':
            // FIRST VISIT EVER: Step 2 → Step 3
            // Welcome → Pre-Survey
            return 'preSurveyModal';
            
        case 'preSurveyModal':
            // Step 3 → Step 4 (if first visit) OR Step 3 → Experience (if returning)
            // Pre-Survey → Tutorial Intro (FIRST VISIT EVER only) OR Experience (returning visits - no modal)
            if (needsTutorial) {
                // FIRST VISIT EVER: Pre-Survey → Tutorial Intro
                return 'tutorialIntroModal';
            }
            // SUBSEQUENT VISITS: Pre-Survey → Experience (no modal, user explores)
            // Activity Level will come later when user clicks Submit (handled by handleStudyModeSubmit)
            return null; // No next modal - close overlay and let user explore
            
        case 'tutorialIntroModal':
            // FIRST VISIT EVER: Step 4 → Step 5 (Experience - not a modal)
            // Tutorial Intro → (tutorial runs, then user explores)
            // No next modal - tutorial will handle opening activity level later via workflow
            return null;
            
        case 'activityLevelModal':
            // Step 6 → Step 7 (if first time this week) OR Step 6 → Step 8 (if already done this week)
            // Activity Level → AWE-SF (if first time each week) OR Post-Survey
            if (needsAwesf) {
                // FIRST VISIT OF NEW WEEK or FIRST VISIT EVER: Activity Level → AWE-SF
                return 'awesfModal';
            }
            // SUBSEQUENT VISITS (SAME WEEK): Activity Level → Post-Survey (skip AWE-SF)
            return 'postSurveyModal';
            
        case 'awesfModal':
            // Step 7 → Step 8
            // AWE-SF → Post-Survey (always)
            return 'postSurveyModal';
            
        case 'postSurveyModal':
            // Step 8 → Step 9
            // Post-Survey → End (always)
            return 'endModal';
            
        case 'endModal':
            // Step 9 - Last modal, no next
            return null;
            
        default:
            // Not a workflow modal
            return null;
    }
}

/**
 * Close ALL modals - centralized function to prevent multiple modals showing
 * Call this before opening any modal to ensure only one modal is visible at a time
 */
export function closeAllModals() {
    const allModalIds = [
        'welcomeModal',
        'participantModal',
        'preSurveyModal',
        'postSurveyModal',
        'activityLevelModal',
        'awesfModal',
        'endModal',
        'beginAnalysisModal',
        'missingStudyIdModal',
        'completeConfirmationModal',
        'tutorialIntroModal'
    ];
    
    allModalIds.forEach(modalId => {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.style.display = 'none';
        }
    });
    
    // Check if we should show UI elements after closing modals
    // Use setTimeout to ensure modal display states are updated first
    setTimeout(() => {
        showUIElementsAfterModal();
    }, 50);
}

/**
 * Enable or disable quick-fill buttons based on environment
 * Shows quick-fill buttons on local server, hides them in production
 * Single variable check: isLocalEnvironment()
 */
export function toggleQuickFillButtons() {
    // Single variable: show quick-fill on local, hide in production
    const showQuickFill = isLocalEnvironment();
    
    // Find all quick-fill button containers and buttons
    const quickFillContainers = document.querySelectorAll('.quick-fill-buttons');
    const quickFillButtons = document.querySelectorAll('.quick-fill-btn');
    
    quickFillContainers.forEach(container => {
        if (showQuickFill) {
            container.style.display = 'flex';
        } else {
            container.style.display = 'none';
        }
    });
    
    quickFillButtons.forEach(btn => {
        if (showQuickFill) {
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
        } else {
            btn.disabled = true;
            btn.style.opacity = '0.5';
            btn.style.cursor = 'not-allowed';
        }
    });
}

export function setupModalEventListeners() {
    // 🔥 FIX: Prevent duplicate event listener attachment
    // If listeners are already set up, remove old ones first before re-adding
    if (modalListenersSetup) {
        console.warn('⚠️ Modal listeners already set up - removing old listeners first');
        removeModalEventListeners();
    }
    
    // Check if we're in Study Mode (used for other modal behaviors, not click-outside-to-close)
    // Note: Click-outside-to-close is now DISABLED for ALL modals regardless of mode
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
            participantSubmitBtn.addEventListener('click', async () => {
                submitParticipantSetup();  // Save data
                
                // Mark participant setup as seen when user submits (not before)
                if (isStudyMode()) {
                    localStorage.setItem('study_has_seen_participant_setup', 'true');
                    console.log('✅ Participant setup marked as seen');
                }
                
                // Close modal (auto-detects next modal and keeps overlay)
                await closeParticipantModal();
                
                // In study mode, open welcome modal next
                if (isStudyMode()) {
                    setTimeout(() => {
                        openWelcomeModal();
                    }, 350);
                }
            });
        }
        
        // Keyboard support: Enter to submit (if button is enabled)
        // Use document-level listener to catch Enter key reliably
        const participantKeyHandler = (e) => {
            // Only handle if modal is visible
            if (participantModal.style.display === 'none' || participantModal.style.display === '') return;
            
            // Don't trigger if user is typing in a textarea or contenteditable
            if (e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
                return;
            }
            
            if (e.key === 'Enter') {
                // Only submit if button is enabled (participant ID entered)
                if (participantSubmitBtn && !participantSubmitBtn.disabled) {
                    e.preventDefault();
                    e.stopPropagation();
                    participantSubmitBtn.click(); // Trigger the submit button click
                }
            }
        };
        
        // Attach to document so it works even when input loses focus
        document.addEventListener('keydown', participantKeyHandler);
        
        // Store handler for potential cleanup later
        participantModal._keyHandler = participantKeyHandler;
        
        // Initial button state check
        updateParticipantSubmitButton();
    }
    
    // Welcome modal event listeners
    const welcomeModal = document.getElementById('welcomeModal');
    if (!welcomeModal) {
        console.error('❌ Welcome modal not found in DOM');
    } else {
        // Prevent closing by clicking outside - clicks outside modal are ignored
        welcomeModal.addEventListener('click', (e) => {
            if (e.target === welcomeModal) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        });
        
        const welcomeSubmitBtn = welcomeModal.querySelector('.modal-submit');
        if (welcomeSubmitBtn) {
            welcomeSubmitBtn.addEventListener('click', async () => {
                // Mark welcome as seen when user submits (not before opening)
                if (isStudyMode()) {
                    localStorage.setItem('study_has_seen_welcome', 'true');
                    console.log('✅ Welcome marked as seen');
                }
                
                await closeWelcomeModal();
                // Open pre-survey after welcome closes
                setTimeout(() => {
                    openPreSurveyModal();
                }, 350);
            });
        }
        
        // Keyboard support: Enter to confirm/close
        // Use document-level listener to catch Enter key even when modal isn't focused
        const welcomeKeyHandler = (e) => {
            // Only handle if modal is visible
            if (welcomeModal.style.display === 'none' || welcomeModal.style.display === '') return;
            
            // Don't trigger if user is typing in an input field
            if (e.target.tagName === 'INPUT' && e.target.type === 'text') {
                return;
            }
            
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                if (welcomeSubmitBtn) {
                    welcomeSubmitBtn.click(); // Trigger the submit button click
                }
            }
        };
        
        // Attach to document so it works even if modal isn't focused
        document.addEventListener('keydown', welcomeKeyHandler);
        
        // Store handler for potential cleanup later
        welcomeModal._keyHandler = welcomeKeyHandler;
    }
    
    // End modal event listeners
    const endModal = document.getElementById('endModal');
    if (!endModal) {
        console.error('❌ End modal not found in DOM');
    } else {
        // Prevent closing by clicking outside - clicks outside modal are ignored
        endModal.addEventListener('click', (e) => {
            if (e.target === endModal) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        });
        
        const endSubmitBtn = endModal.querySelector('.modal-submit');
        if (endSubmitBtn) {
            endSubmitBtn.addEventListener('click', async () => {
                closeEndModal();
                
                // Check if we should run the study end walkthrough
                const { isStudyEndMode } = await import('./master-modes.js');
                if (isStudyEndMode()) {
                    console.log('🎬 End modal closed - starting Study End Walkthrough...');
                    // Small delay to ensure modal is fully closed
                    setTimeout(async () => {
                        const { runStudyEndWalkthrough } = await import('./tutorial-coordinator.js');
                        await runStudyEndWalkthrough();
                    }, 500);
                }
            });
        }
    }
    
    // Begin Analysis modal event listeners
    const beginAnalysisModal = document.getElementById('beginAnalysisModal');
    if (!beginAnalysisModal) {
        console.error('❌ Begin Analysis modal not found in DOM');
    } else {
        // Prevent closing by clicking outside - clicks outside modal are ignored
        beginAnalysisModal.addEventListener('click', (e) => {
            if (e.target === beginAnalysisModal) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        });
        
        const beginAnalysisCancelBtn = beginAnalysisModal.querySelector('.modal-cancel');
        if (beginAnalysisCancelBtn) {
            beginAnalysisCancelBtn.addEventListener('click', () => {
                closeBeginAnalysisModal(false); // Explicitly pass false to ensure overlay fades out
            });
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
        
        // Keyboard support: Enter to confirm, Escape to cancel
        beginAnalysisModal.addEventListener('keydown', (e) => {
            // Only handle if modal is visible
            if (beginAnalysisModal.style.display === 'none') return;
            
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                closeBeginAnalysisModal();
                window.dispatchEvent(new CustomEvent('beginAnalysisConfirmed'));
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeBeginAnalysisModal(false); // Explicitly pass false to ensure overlay fades out
            }
        });
    }
    
    // Complete Confirmation modal event listeners
    const completeConfirmationModal = document.getElementById('completeConfirmationModal');
    if (!completeConfirmationModal) {
        console.error('❌ Complete Confirmation modal not found in DOM');
    } else {
        // Prevent closing by clicking outside - clicks outside modal are ignored
        completeConfirmationModal.addEventListener('click', (e) => {
            if (e.target === completeConfirmationModal) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        });
        
        const completeCancelBtn = completeConfirmationModal.querySelector('.modal-cancel');
        if (completeCancelBtn) {
            completeCancelBtn.addEventListener('click', closeCompleteConfirmationModal);
        }
        
        const completeSubmitBtn = completeConfirmationModal.querySelector('.modal-submit');
        if (completeSubmitBtn) {
            completeSubmitBtn.addEventListener('click', async () => {
                // Check if a feature is selected
                const { hasIdentifiedFeature } = await import('./region-tracker.js');
                const hasFeature = hasIdentifiedFeature();
                
                if (!hasFeature) {
                    console.warn('⚠️ Complete button clicked but no feature selected');
                    // Keep modal open and show error
                    const statusEl = document.getElementById('status');
                    if (statusEl) {
                        statusEl.className = 'status error';
                        statusEl.textContent = '❌ Please identify at least one feature before completing.';
                    }
                    return;
                }
                
                // Enable features
                const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
                enableAllTutorialRestrictedFeatures();
                console.log('✅ Features enabled after feature selection');
                
                // In study mode, use the workflow. Otherwise, open activity level directly
                const { isStudyMode } = await import('./master-modes.js');
                if (isStudyMode()) {
                    console.log('🎓 Study Mode: Starting submit workflow...');
                    // Close with keepOverlay: true so overlay stays for Activity Level modal
                    await modalManager.closeModal('completeConfirmationModal', {
                        keepOverlay: true
                    });
                    console.log('✅ Complete Confirmation modal closed (overlay kept for workflow)');
                    
                    const { handleStudyModeSubmit } = await import('./study-workflow.js');
                    await handleStudyModeSubmit();
                } else {
                    // Not in study mode - close normally and open Activity Level modal directly
                    closeCompleteConfirmationModal();
                    openActivityLevelModal();
                }
            });
        }
    }
    
    // Missing Study ID modal event listeners
    const missingStudyIdModal = document.getElementById('missingStudyIdModal');
    if (!missingStudyIdModal) {
        console.error('❌ Missing Study ID modal not found in DOM');
    } else {
        // Prevent closing by clicking outside - clicks outside modal are ignored
        missingStudyIdModal.addEventListener('click', (e) => {
            if (e.target === missingStudyIdModal) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        });
        
        // "Enter Study ID" button - opens participant modal
        const enterStudyIdBtn = missingStudyIdModal.querySelector('.modal-submit');
        if (enterStudyIdBtn) {
            enterStudyIdBtn.addEventListener('click', () => {
                closeMissingStudyIdModal();
                // Small delay to ensure modal closes first
                setTimeout(() => {
                    openParticipantModal();
                }, 100);
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
        
        // Prevent closing by clicking outside - clicks outside modal are ignored
        preSurveyModal.addEventListener('click', (e) => {
            if (e.target === preSurveyModal) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        });
        
        if (preSurveyCloseBtn) {
            preSurveyCloseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closePreSurveyModal();
            });
        }
        
        if (preSurveySubmitBtn) {
            preSurveySubmitBtn.addEventListener('click', async () => {
                await submitPreSurvey();  // Save data
                
                // Auto-detect next modal using workflow logic
                const nextModal = await getNextModalInWorkflow('preSurveyModal');
                console.log('🔍 Pre-Survey submit: nextModal =', nextModal);
                
                await closePreSurveyModal(nextModal !== null);
                
                // In study mode, open the next modal in workflow
                if (isStudyMode() && nextModal) {
                    setTimeout(() => {
                        // Only open tutorial intro if it's the first visit
                        // For returning visits, close modal and let user explore (Activity Level comes after Submit)
                        if (nextModal === 'tutorialIntroModal') {
                            console.log('🎓 Opening Tutorial Intro modal...');
                            openTutorialIntroModal();
                        } else if (nextModal === 'activityLevelModal') {
                            // This shouldn't happen after pre-survey - Activity Level comes after Submit
                            // But if it does, we should close overlay and let user explore
                            console.warn('⚠️ Pre-Survey: Activity Level detected as next modal - this is wrong! Closing overlay and letting user explore.');
                            fadeOutOverlay();
                        } else {
                            // Returning visit: Pre-Survey → Experience (no modal, user explores)
                            // Activity Level will open when user clicks Submit button
                            console.log('📊 Pre-Survey complete - ready for experience. Activity Level will show after Submit.');
                            fadeOutOverlay(); // Make sure overlay is closed
                        }
                    }, 350);
                } else if (isStudyMode() && !nextModal) {
                    // No next modal - this is correct for returning visits
                    // Close overlay and let user explore
                    console.log('📊 Pre-Survey complete - no next modal (returning visit). Closing overlay, ready for experience.');
                    fadeOutOverlay();
                }
            });
        }
        
        // Keyboard support: Enter to submit (if button is enabled)
        // Use document-level listener to catch Enter key reliably
        const preSurveyKeyHandler = (e) => {
            // Only handle if modal is visible
            if (preSurveyModal.style.display === 'none' || preSurveyModal.style.display === '') return;
            
            // Don't trigger if user is typing in an input field
            if (e.target.tagName === 'INPUT' && e.target.type === 'text') {
                return;
            }
            
            if (e.key === 'Enter') {
                // Only submit if button is enabled (all questions answered)
                if (preSurveySubmitBtn && !preSurveySubmitBtn.disabled) {
                    e.preventDefault();
                    e.stopPropagation();
                    preSurveySubmitBtn.click(); // Trigger the submit button click
                }
            }
        };
        
        // Attach to document so it works even when modal isn't focused
        document.addEventListener('keydown', preSurveyKeyHandler);
        
        // Store handler for potential cleanup later
        preSurveyModal._keyHandler = preSurveyKeyHandler;
        
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
        
        // Prevent closing by clicking outside - clicks outside modal are ignored
        postSurveyModal.addEventListener('click', (e) => {
            if (e.target === postSurveyModal) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        });
        
        if (postSurveyCloseBtn) {
            postSurveyCloseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closePostSurveyModal();
            });
        }
        
        if (postSurveySubmitBtn) {
            postSurveySubmitBtn.addEventListener('click', async () => {
                await submitPostSurvey();  // Save data
                
                await closePostSurveyModal();
                
                // In study mode, submit to Qualtrics and show end modal
                if (isStudyMode()) {
                    setTimeout(async () => {
                        try {
                            // Submit all surveys to Qualtrics
                            const { attemptSubmission } = await import('./ui-controls.js');
                            await attemptSubmission(true);  // fromWorkflow=true
                            console.log('✅ Submission complete');
                        } catch (error) {
                            console.error('❌ Error during submission:', error);
                            // Continue to show end modal even if submission fails
                        }
                        
                        // Show end modal (always show, even if submission had issues)
                        const { getParticipantId } = await import('./qualtrics-api.js');
                        const { incrementSessionCount } = await import('./study-workflow.js');
                        const participantId = getParticipantId();
                        const sessionCount = incrementSessionCount();
                        
                        console.log('🎉 Opening end modal...', { participantId, sessionCount });
                        
                        // Show end modal (openEndModal already updates the content)
                        const { openEndModal } = await import('./ui-controls.js');
                        openEndModal(participantId, sessionCount);
                        console.log('✅ End modal should now be visible');
                    }, 350);
                }
            });
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
        
        // Prevent closing by clicking outside - clicks outside modal are ignored
        activityLevelModal.addEventListener('click', (e) => {
            if (e.target === activityLevelModal) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        });
        
        if (activityLevelCloseBtn) {
            activityLevelCloseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeActivityLevelModal();
            });
        }
        
        if (activityLevelSubmitBtn) {
            activityLevelSubmitBtn.addEventListener('click', async () => {
                console.log('🔵 Activity Level submit button clicked');
                const success = await submitActivityLevelSurvey();  // Save data

                if (!success) {
                    // If submission failed (e.g., no participant ID), don't close modal
                    // The function already showed an alert, so user can fix the issue
                    console.log('❌ Activity Level submission failed - keeping modal open');
                    return;
                }

                console.log('✅ Activity Level submission successful');

                // If we're in study mode workflow, close the modal so the workflow promise resolves
                // The workflow is waiting for the modal to close via its promise from openModal
                const { isStudyMode } = await import('./master-modes.js');
                console.log('🔍 isStudyMode:', isStudyMode());
                if (isStudyMode()) {
                    console.log('✅ Activity Level saved - closing modal for workflow...');
                    // Close the modal (auto-detects next modal and keeps overlay)
                    await closeActivityLevelModal();
                    // Open next survey in workflow
                    const needsAwesf = !localStorage.getItem('study_last_awesf_date');
                    if (needsAwesf) {
                        setTimeout(() => {
                            openAwesfModal();
                        }, 350);
                    } else {
                        setTimeout(() => {
                            openPostSurveyModal();
                        }, 350);
                    }
                    console.log('✅ Activity Level modal closed - workflow will continue');
                } else {
                    // Not in workflow - close normally
                    await closeActivityLevelModal();
                }
            });
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
            radio.addEventListener('change', (e) => {
                e.stopPropagation(); // Prevent event from bubbling
                updateAwesfSubmitButton();
            });
            // Also prevent click events from bubbling
            radio.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent click from bubbling to modal/overlay
            });
        });
        
        // Also prevent label clicks from bubbling (labels are often used with radio buttons)
        awesfModal.querySelectorAll('label').forEach(label => {
            label.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent label clicks from bubbling
            });
        });
        
        // Prevent closing by clicking outside - clicks outside modal are ignored
        awesfModal.addEventListener('click', (e) => {
            // Only prevent if clicking directly on modal background
            if (e.target === awesfModal) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        });
        
        if (awesfCloseBtn) {
            awesfCloseBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent bubble to overlay
                closeAwesfModal(); // Close without event check
            });
        }
        
        if (awesfSubmitBtn) {
            awesfSubmitBtn.addEventListener('click', async () => {
                await submitAwesfSurvey();  // Save data
                
                await closeAwesfModal();
                // Open post-survey after AWE-SF closes
                setTimeout(() => {
                    openPostSurveyModal();
                }, 350);
            });
        }
        
        // Initial button state check
        updateAwesfSubmitButton();
        
        // Quick-fill button handlers for AWE-SF
        awesfModal.querySelectorAll('.quick-fill-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent event from bubbling to modal/overlay
                e.preventDefault(); // Prevent any default behavior
                
                const value = btn.getAttribute('data-value');
                console.log(`🔵 Quick-fill button clicked: filling all AWE-SF questions with value ${value}`);
                
                // Fill all AWE-SF radio buttons with this value
                awesfModal.querySelectorAll('input[type="radio"]').forEach(radio => {
                    if (radio.value === value) {
                        radio.checked = true;
                        radio.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                });
                
                // Update submit button state after filling
                updateAwesfSubmitButton();
                
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
    
    // Tutorial Intro modal event listeners
    const tutorialIntroModal = document.getElementById('tutorialIntroModal');
    if (!tutorialIntroModal) {
        console.error('❌ Tutorial Intro modal not found in DOM');
    } else {
        // Prevent closing by clicking outside - clicks outside modal are ignored
        tutorialIntroModal.addEventListener('click', (e) => {
            if (e.target === tutorialIntroModal) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        });
        
        const tutorialIntroSubmitBtn = tutorialIntroModal.querySelector('.modal-submit');
        if (tutorialIntroSubmitBtn) {
            tutorialIntroSubmitBtn.addEventListener('click', async () => {
                closeTutorialIntroModal();
                
                // Start the tutorial after modal closes
                setTimeout(async () => {
                    const { runInitialTutorial } = await import('./tutorial.js');
                    await runInitialTutorial();
                    
                    // Mark tutorial as seen after it completes
                    const { markTutorialAsSeen } = await import('./study-workflow.js');
                    markTutorialAsSeen();
                }, 350);
            });
        }
        
        // Keyboard support: Enter to begin tutorial
        const tutorialIntroKeyHandler = (e) => {
            // Only handle if modal is visible
            if (tutorialIntroModal.style.display === 'none' || tutorialIntroModal.style.display === '') return;
            
            // Don't trigger if user is typing in an input field
            if (e.target.tagName === 'INPUT' && e.target.type === 'text') {
                return;
            }
            
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                if (tutorialIntroSubmitBtn) {
                    tutorialIntroSubmitBtn.click();
                }
            }
        };
        
        document.addEventListener('keydown', tutorialIntroKeyHandler);
        tutorialIntroModal._keyHandler = tutorialIntroKeyHandler;
    }
    
    // Tutorial Revisit modal event listeners
    const tutorialRevisitModal = document.getElementById('tutorialRevisitModal');
    if (!tutorialRevisitModal) {
        console.error('❌ Tutorial Revisit modal not found in DOM');
    } else {
        // Prevent closing by clicking outside - clicks outside modal are ignored
        tutorialRevisitModal.addEventListener('click', (e) => {
            if (e.target === tutorialRevisitModal) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        });
        
        const tutorialRevisitYesBtn = tutorialRevisitModal.querySelector('.modal-submit');
        const tutorialRevisitCancelBtn = tutorialRevisitModal.querySelector('.modal-cancel');
        
        if (tutorialRevisitYesBtn) {
            tutorialRevisitYesBtn.addEventListener('click', async () => {
                closeTutorialRevisitModal(false);
                
                // Clear tutorial seen flag to restart tutorial
                localStorage.removeItem('study_has_seen_tutorial');
                console.log('🔄 Tutorial flag cleared - will restart tutorial');
                
                // Restart the tutorial
                setTimeout(async () => {
                    const { runInitialTutorial } = await import('./tutorial-coordinator.js');
                    await runInitialTutorial();
                }, 300);
            });
        }
        
        if (tutorialRevisitCancelBtn) {
            tutorialRevisitCancelBtn.addEventListener('click', () => {
                closeTutorialRevisitModal(false);
            });
        }
        
        // Keyboard support: Enter for Yes, Escape for Cancel
        tutorialRevisitModal.addEventListener('keydown', (e) => {
            if (tutorialRevisitModal.style.display === 'none') return;
            
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                if (tutorialRevisitYesBtn) {
                    tutorialRevisitYesBtn.click();
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeTutorialRevisitModal(false);
            }
        });
    }
    
    // Enable/disable quick-fill buttons based on mode
    toggleQuickFillButtons();
    
    modalListenersSetup = true;
    console.log('📋 Modal event listeners attached (using ModalManager)');
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
    console.log('🔍 openParticipantModal() called');
    
    // Close all other modals first
    closeAllModals();
    
    const modal = document.getElementById('participantModal');
    if (!modal) {
        console.error('❌ CRITICAL: Participant modal not found in DOM!');
        console.error('   This means modals were not initialized. Check initializeModals() was called.');
        // Don't fade in overlay if modal doesn't exist
        return;
    }
    
    // Get participant ID from URL (takes precedence) or localStorage
    const participantId = getParticipantId();
    const urlId = getParticipantIdFromURL(); // Check if ID came from Qualtrics URL
    const participantIdInput = document.getElementById('participantId');
    const participantSubmitBtn = document.querySelector('#participantModal .modal-submit');
    const modalTitle = modal.querySelector('.modal-title');
    const instructionText = modal.querySelector('.modal-body p');
    
    // Determine context: initial setup vs upper right corner click
    const hasExistingId = participantId && participantId.trim().length > 0;
    const idFromQualtrics = urlId && urlId.trim().length > 0;
    
    // Dynamically update modal text based on context
    if (hasExistingId && !idFromQualtrics) {
        // User clicked from upper right corner - ID exists in localStorage
        if (modalTitle) {
            modalTitle.textContent = "You're All Set";
        }
        if (instructionText) {
            instructionText.textContent = "Your participant ID is stored.";
            instructionText.style.fontWeight = 'normal'; // Remove bold styling for confirmation message
        }
    } else if (hasExistingId && idFromQualtrics) {
        // Initial setup - ID came from Qualtrics URL
        if (modalTitle) {
            modalTitle.textContent = "Welcome";
        }
        if (instructionText) {
            instructionText.textContent = "Your participant ID has successfully been transferred from Qualtrics:";
            instructionText.style.fontWeight = 'bold'; // Keep bold styling for instruction
        }
    } else {
        // Initial setup - no ID exists
        if (modalTitle) {
            modalTitle.textContent = "Welcome";
        }
        if (instructionText) {
            instructionText.textContent = "Enter your participant ID number to begin:";
            instructionText.style.fontWeight = 'bold'; // Keep bold styling for instruction
        }
    }
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    
    if (participantIdInput) {
        // Pre-populate with ID from URL or localStorage
        participantIdInput.value = participantId || '';
        
        if (urlId) {
            console.log('🔗 Participant ID loaded from URL:', urlId);
        }
    } else {
        console.warn('⚠️ Participant ID input not found');
    }
    
    // Update button state based on whether there's a value
    if (participantSubmitBtn) {
        const hasValue = participantIdInput && participantIdInput.value.trim().length > 0;
        participantSubmitBtn.disabled = !hasValue;
    } else {
        console.warn('⚠️ Participant submit button not found');
    }
    
    // Show the modal
    modal.style.display = 'flex';
    console.log('👤 Participant Setup modal opened');
    console.log('   Modal element:', modal);
    console.log('   Modal display:', modal.style.display);
    console.log('   Overlay visible:', document.getElementById('permanentOverlay')?.style.display);
    console.log('   Has existing ID:', hasExistingId);
}

export async function closeParticipantModal(keepOverlay = null) {
    // Auto-detect if overlay should be kept (if keepOverlay not explicitly provided)
    if (keepOverlay === null) {
        // If opened manually (not as part of workflow), always fade out overlay
        // Check if this is a manual open by seeing if we're in the middle of a workflow
        // If workflow is skipped OR if participant setup was already seen, this is manual
        const skipWorkflow = localStorage.getItem('skipStudyWorkflow') === 'true';
        const hasSeenParticipantSetup = localStorage.getItem('study_has_seen_participant_setup') === 'true';
        
        if (skipWorkflow || hasSeenParticipantSetup) {
            // Manual open - always fade out overlay
            keepOverlay = false;
        } else {
            // Part of workflow - check if there's a next modal
            const nextModal = await getNextModalInWorkflow('participantModal');
            keepOverlay = nextModal !== null;
        }
    }
    
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
    
    const modal = document.getElementById('participantModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    console.log(`👤 Participant Setup modal closed (keepOverlay: ${keepOverlay})`);
}

// Welcome Modal Functions
export function openWelcomeModal() {
    // In Study Mode, ONLY allow welcome modal through the workflow - NEVER allow manual opening
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
    
    // Close all other modals first
    closeAllModals();
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    
    welcomeModal.style.display = 'flex';
    console.log('👋 Welcome modal opened');
}

export async function closeWelcomeModal(keepOverlay = null) {
    // Auto-detect if overlay should be kept (if keepOverlay not explicitly provided)
    if (keepOverlay === null) {
        const nextModal = await getNextModalInWorkflow('welcomeModal');
        keepOverlay = nextModal !== null;
    }
    
    const modal = document.getElementById('welcomeModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    console.log(`👋 Welcome modal closed (keepOverlay: ${keepOverlay})`);
}

// End Modal Functions
export function openEndModal(participantId, sessionCount) {
    console.log('🔍 openEndModal called', { participantId, sessionCount });
    
    // Close all other modals first
    closeAllModals();
    
    const modal = document.getElementById('endModal');
    if (!modal) {
        console.error('❌ CRITICAL: End modal not found in DOM!');
        return;
    }
    console.log('✅ End modal found in DOM');
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    console.log('✅ Overlay faded in');
    
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

export function closeEndModal(keepOverlay = null) {
    // End modal is always the last - never keep overlay
    if (keepOverlay === null) {
        keepOverlay = false;
    }
    
    const modal = document.getElementById('endModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    console.log(`🎉 End modal closed (keepOverlay: ${keepOverlay})`);
}

// Begin Analysis Modal Functions
export function openBeginAnalysisModal() {
    // Close all other modals first
    closeAllModals();
    
    const modal = document.getElementById('beginAnalysisModal');
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    
    if (modal) {
        modal.style.display = 'flex';
        // Make modal focusable for keyboard events
        modal.setAttribute('tabindex', '-1');
        // Focus the modal so keyboard events work
        modal.focus();
        console.log('🔵 Begin Analysis modal opened');
    } else {
        console.error('❌ Begin Analysis modal not found in DOM');
    }
}

export function closeBeginAnalysisModal(keepOverlay = null) {
    // Begin Analysis modal is not part of workflow sequence - default to false
    if (keepOverlay === null) {
        keepOverlay = false;
    }
    
    const modal = document.getElementById('beginAnalysisModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    console.log(`🔵 Begin Analysis modal closed (keepOverlay: ${keepOverlay})`);
}

// Complete Confirmation Modal Functions
export function openCompleteConfirmationModal() {
    // Close all other modals first
    closeAllModals();
    
    const modal = document.getElementById('completeConfirmationModal');
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    
    if (modal) {
        modal.style.display = 'flex';
        console.log('✅ Complete Confirmation modal opened');
    } else {
        console.error('❌ Complete Confirmation modal not found in DOM');
    }
}

export function closeCompleteConfirmationModal(keepOverlay = null) {
    // Complete Confirmation modal is not part of workflow sequence - default to false
    if (keepOverlay === null) {
        keepOverlay = false;
    }
    
    const modal = document.getElementById('completeConfirmationModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    console.log(`✅ Complete Confirmation modal closed (keepOverlay: ${keepOverlay})`);
}

// Tutorial Intro Modal Functions
export function openTutorialIntroModal() {
    // Close all other modals first
    closeAllModals();
    
    const modal = document.getElementById('tutorialIntroModal');
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    
    if (modal) {
        modal.style.display = 'flex';
        console.log('🎓 Tutorial Intro modal opened');
    } else {
        console.error('❌ Tutorial Intro modal not found in DOM');
    }
}

export function closeTutorialIntroModal(keepOverlay = null) {
    // Auto-detect if overlay should be kept (if keepOverlay not explicitly provided)
    // Tutorial intro is followed by the tutorial itself (not a modal), so always fade out
    if (keepOverlay === null) {
        keepOverlay = false; // Tutorial starts after this, no next modal
    }
    
    const modal = document.getElementById('tutorialIntroModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    console.log(`🎓 Tutorial Intro modal closed (keepOverlay: ${keepOverlay})`);
}

// Tutorial Revisit Modal Functions
export function openTutorialRevisitModal() {
    // Close all other modals first
    closeAllModals();
    
    const modal = document.getElementById('tutorialRevisitModal');
    if (!modal) {
        console.error('❌ Tutorial Revisit modal not found in DOM');
        return;
    }
    
    // Fade in overlay background
    fadeInOverlay();
    
    modal.style.display = 'flex';
    console.log('❓ Tutorial Revisit modal opened');
}

export function closeTutorialRevisitModal(keepOverlay = null) {
    if (keepOverlay === null) {
        keepOverlay = false;
    }
    
    const modal = document.getElementById('tutorialRevisitModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    console.log(`❓ Tutorial Revisit modal closed (keepOverlay: ${keepOverlay})`);
}

// Missing Study ID Modal Functions
export function openMissingStudyIdModal() {
    // Close all other modals first
    closeAllModals();
    
    const modal = document.getElementById('missingStudyIdModal');
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    
    if (modal) {
        modal.style.display = 'flex';
        console.log('⚠️ Missing Study ID modal opened');
    }
}

export function closeMissingStudyIdModal(keepOverlay = null) {
    // If participant ID is now set, fade out the overlay
    // Otherwise, keep overlay visible for participant modal
    if (keepOverlay === null) {
        const participantId = getParticipantId();
        keepOverlay = !participantId;  // Keep overlay if no participant ID (participant modal will show)
    }
    
    const modal = document.getElementById('missingStudyIdModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    console.log(`⚠️ Missing Study ID modal closed (keepOverlay: ${keepOverlay})`);
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
    statusEl.textContent = `✅ ID recorded`;
    
    // Update participant ID display in top panel
    // Always show the display (even if no ID set) so users can click to enter their ID
    const displayElement = document.getElementById('participantIdDisplay');
    const valueElement = document.getElementById('participantIdValue');
    
    if (displayElement) displayElement.style.display = 'block';
    if (valueElement) valueElement.textContent = participantId || '--';
    
    // 🔥 REMOVED: Don't manually hide modal or fade overlay
    // Let the button handler and ModalManager do their job!
    // The workflow is waiting for the modal to properly close through ModalManager.
}

export function openPreSurveyModal() {
    // Close all other modals first
    closeAllModals();
    
    const preSurveyModal = document.getElementById('preSurveyModal');
    if (!preSurveyModal) {
        console.warn('⚠️ Pre-survey modal not found');
        return;
    }
    
    // 🔥 Check if this is a returning visit (user has seen welcome before)
    // If they've seen welcome, change title to "Welcome back"
    const modalTitle = preSurveyModal.querySelector('.modal-title');
    if (modalTitle) {
        const hasSeenWelcome = localStorage.getItem('study_has_seen_welcome') === 'true';
        if (hasSeenWelcome) {
            modalTitle.textContent = 'Welcome back';
        } else {
            // First visit - use default title
            modalTitle.textContent = '📊 Pre-Survey';
        }
    }
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    
    preSurveyModal.style.display = 'flex';
    console.log('📊 Pre-Survey modal opened');
    
    // Ensure quick-fill buttons are properly enabled/disabled based on mode
    toggleQuickFillButtons();
    
    // Track survey start
    const participantId = getParticipantId();
    if (participantId) {
        trackSurveyStart(participantId, 'pre');
    }
}

export async function closePreSurveyModal(keepOverlay = null) {
    // Auto-detect if overlay should be kept (if keepOverlay not explicitly provided)
    if (keepOverlay === null) {
        const nextModal = await getNextModalInWorkflow('preSurveyModal');
        keepOverlay = nextModal !== null;
    }
    
    const modal = document.getElementById('preSurveyModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    console.log(`📊 Pre-Survey modal closed (keepOverlay: ${keepOverlay})`);
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
    
    // Get participant ID (from URL or localStorage) - optional for pre-survey
    const participantId = getParticipantId();
    
    // Allow pre-survey submission without participant ID (user can set it later)
    // Only require participant ID for saving responses, but allow submission to proceed
    if (!participantId) {
        console.log('⚠️ Pre-Survey submitted without participant ID - responses will not be saved');
    }
    
    console.log('📊 Pre-Survey Data:');
    console.log('  - Survey Type: Pre-Survey');
    console.log('  - Participant ID:', participantId || 'Not set');
    console.log('  - Calm:', surveyData.calm || 'not rated');
    console.log('  - Energized:', surveyData.energized || 'not rated');
    console.log('  - Connected to nature:', surveyData.connected || 'not rated');
    console.log('  - Nervous:', surveyData.nervous || 'not rated');
    console.log('  - Focused:', surveyData.focused || 'not rated');
    console.log('  - A sense of wonder:', surveyData.wonder || 'not rated');
    console.log('  - Timestamp:', surveyData.timestamp);
    
    const statusEl = document.getElementById('status');
    
    try {
        // Save response locally if participant ID is available
        if (participantId) {
            statusEl.className = 'status info';
            statusEl.textContent = '💾 Saving pre-survey response...';
            
            saveSurveyResponse(participantId, 'pre', surveyData);
            
            statusEl.className = 'status success';
            statusEl.textContent = '✅ Pre-Survey saved!';
            
            // Modal will be closed by event handler
        } else {
            // No participant ID - show warning modal after pre-survey closes
            // Event handler will close pre-survey modal, then we'll open missing study ID modal
            setTimeout(() => {
                openMissingStudyIdModal();
            }, 350); // Wait for modal close animation
        }
        
        // Form doesn't need to clear itself - when modal reopens, it will be fresh
    } catch (error) {
        console.error('Failed to save pre-survey:', error);
        statusEl.className = 'status error';
        statusEl.textContent = `❌ Failed to save: ${error.message}`;
        // Don't close modal on error so user can try again
    }
}

export function openPostSurveyModal() {
    // Close all other modals first
    closeAllModals();
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    
    document.getElementById('postSurveyModal').style.display = 'flex';
    console.log('📊 Post-Survey modal opened');
    
    // Ensure quick-fill buttons are properly enabled/disabled based on mode
    toggleQuickFillButtons();
    
    // Track survey start
    const participantId = getParticipantId();
    if (participantId) {
        trackSurveyStart(participantId, 'post');
    }
}

export async function closePostSurveyModal(keepOverlay = null) {
    // Auto-detect if overlay should be kept (if keepOverlay not explicitly provided)
    if (keepOverlay === null) {
        const nextModal = await getNextModalInWorkflow('postSurveyModal');
        keepOverlay = nextModal !== null;
    }
    
    const modal = document.getElementById('postSurveyModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    console.log(`📊 Post-Survey modal closed (keepOverlay: ${keepOverlay})`);
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
        
        // Modal will be closed by event handler
        // Form doesn't need to clear itself - when modal reopens, it will be fresh
    } catch (error) {
        console.error('Failed to save post-survey:', error);
        statusEl.className = 'status error';
        statusEl.textContent = `❌ Failed to save: ${error.message}`;
        // Don't close modal on error so user can try again
    }
}

export function openActivityLevelModal() {
    // Close all other modals first
    closeAllModals();
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    
    document.getElementById('activityLevelModal').style.display = 'flex';
    console.log('🌋 Activity Level modal opened');
    
    // Track survey start
    const participantId = getParticipantId();
    if (participantId) {
        trackSurveyStart(participantId, 'activityLevel');
    }
}

export async function closeActivityLevelModal(keepOverlay = null) {
    // Auto-detect if overlay should be kept (if keepOverlay not explicitly provided)
    if (keepOverlay === null) {
        const nextModal = await getNextModalInWorkflow('activityLevelModal');
        keepOverlay = nextModal !== null;
    }
    
    const modal = document.getElementById('activityLevelModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    console.log(`🌋 Activity Level modal closed (keepOverlay: ${keepOverlay})`);
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
        return false;
    }
    
    // Get participant ID (from URL or localStorage)
    const participantId = getParticipantId();
    
    if (!participantId) {
        alert('Please set your participant ID before submitting surveys.');
        return false;
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
        
        // Modal will be closed by event handler
        // Form doesn't need to clear itself - when modal reopens, it will be fresh
        
        return true;
    } catch (error) {
        console.error('Failed to save activity level survey:', error);
        statusEl.className = 'status error';
        statusEl.textContent = `❌ Failed to save: ${error.message}`;
        // Don't close modal on error so user can try again
        return false;
    }
}

export function openAwesfModal() {
    // Close all other modals first
    closeAllModals();
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    
    document.getElementById('awesfModal').style.display = 'flex';
    console.log('✨ AWE-SF modal opened');
    
    // Ensure quick-fill buttons are properly enabled/disabled based on mode
    toggleQuickFillButtons();
    
    // Track survey start
    const participantId = getParticipantId();
    if (participantId) {
        trackSurveyStart(participantId, 'awesf');
    }
}

export async function closeAwesfModal(keepOverlay = null) {
    // Auto-detect if overlay should be kept (if keepOverlay not explicitly provided)
    if (keepOverlay === null) {
        const nextModal = await getNextModalInWorkflow('awesfModal');
        keepOverlay = nextModal !== null;
    }
    
    const modal = document.getElementById('awesfModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    console.log(`✨ AWE-SF modal closed (keepOverlay: ${keepOverlay})`);
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
        
        // Modal will be closed by event handler
        // Form doesn't need to clear itself - when modal reopens, it will be fresh
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
                    type: feature.type || null, // Impulsive or Continuous (Choice 9)
                    repetition: feature.repetition || null, // Unique in 24h? (Choice 11)
                    notes: feature.notes || null,
                    // Speed factor (Choice 3) - captured at feature creation time
                    speedFactor: feature.speedFactor !== undefined ? feature.speedFactor : null,
                    // Number of events in region (Choice 10) - feature count for this region
                    numberOfEvents: region.featureCount || 0
                };
            });
        }
        
        return formattedRegion;
    });
}

export async function attemptSubmission(fromWorkflow = false) {
    // ═══════════════════════════════════════════════════════════
    // 🎓 STUDY MODE: Route to study workflow for post-session surveys
    // ═══════════════════════════════════════════════════════════
    const { isStudyMode } = await import('./master-modes.js');
    if (isStudyMode() && !fromWorkflow) {
        console.log('🎓 Study Mode: Routing to study workflow submit handler');
        const { handleStudyModeSubmit } = await import('./study-workflow.js');
        return await handleStudyModeSubmit();
    }
    
    // If fromWorkflow is true, we're already in the workflow, so skip routing and go straight to submission
    if (fromWorkflow) {
        console.log('🎓 Study Mode: Already in workflow, proceeding directly to Qualtrics submission');
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
            
            // If called from workflow, transition back to main screen and open participant modal
            if (fromWorkflow) {
                console.log('   🔄 Transitioning back to main screen to collect participant ID...');
                // Close any open modals and fade out overlay
                closeAllModals();
                fadeOutOverlay();
                // Open participant modal
                setTimeout(() => {
                    openParticipantModal();
                    console.log('👤 Participant modal opened for ID collection');
                }, 350);
            }
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
        const hasActivityLevel = !!responses.activityLevel;
        console.log('   Pre-Survey:', hasPre ? '✅ COMPLETE' : '❌ MISSING');
        console.log('   Post-Survey:', hasPost ? '✅ COMPLETE' : '❌ MISSING');
        console.log('   AWE-SF:', hasAwesf ? '✅ COMPLETE' : '❌ MISSING');
        console.log('   Activity Level:', hasActivityLevel ? '✅ COMPLETE' : '❌ MISSING');
        
        if (hasPre) {
            console.log('   Pre-Survey Data:', JSON.stringify(responses.pre, null, 2));
        }
        if (hasPost) {
            console.log('   Post-Survey Data:', JSON.stringify(responses.post, null, 2));
        }
        if (hasAwesf) {
            console.log('   AWE-SF Data:', JSON.stringify(responses.awesf, null, 2));
        }
        if (hasActivityLevel) {
            console.log('   Activity Level Data:', JSON.stringify(responses.activityLevel, null, 2));
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
            if (!hasActivityLevel) missingSurveys.push('Activity Level');
            
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
            activityLevel: responses.activityLevel || null,
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
            activityLevel: hasActivityLevel ? 1 : 0,
            total: (hasPre ? 1 : 0) + (hasPost ? 1 : 0) + (hasAwesf ? 1 : 0) + (hasActivityLevel ? 1 : 0)
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
        if (combinedResponses.activityLevel) {
            console.log('   ✅ Activity Level data included:', Object.keys(combinedResponses.activityLevel));
        } else {
            console.warn('   ⚠️ Activity Level data MISSING - will not be submitted to Qualtrics');
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
        
        // ═══════════════════════════════════════════════════════════
        // 📤 QUALTRICS SUBMISSION
        // ═══════════════════════════════════════════════════════════
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

