/**
 * tutorial-coordinator.js
 * Clean, linear tutorial sequence with async/await
 * Each section is a LEGO block that can be reordered
 */

import { 
    setStatusText, 
    addSpectrogramGlow, 
    removeSpectrogramGlow,
    addRegionsPanelGlow,
    removeRegionsPanelGlow,
    addVolumeSliderGlow,
    removeVolumeSliderGlow,
    addLoopButtonGlow,
    removeLoopButtonGlow,
    addFrequencyScaleGlow,
    removeFrequencyScaleGlow,
    disableRegionButtons,
    enableRegionButtons,
    enableRegionPlayButton,
    enableRegionZoomButton,
    enableWaveformClicks, 
    shouldShowPulse, 
    markPulseShown, 
    showTutorialOverlay, 
    setTutorialPhase, 
    clearTutorialPhase,
    disableFrequencyScaleDropdown,
    enableFrequencyScaleDropdown,
    addSelectFeatureButtonGlow,
    removeSelectFeatureButtonGlow,
    enableSelectFeatureButton,
    addRepetitionDropdownGlow,
    removeRepetitionDropdownGlow,
    addTypeDropdownGlow,
    removeTypeDropdownGlow,
    addAddFeatureButtonGlow,
    removeAddFeatureButtonGlow,
    disableAddFeatureButton,
    enableAddFeatureButton
} from './tutorial.js';

import { 
    startPauseButtonTutorial, 
    endPauseButtonTutorial, 
    startSpeedSliderTutorial, 
    endSpeedSliderTutorial,
    isPauseButtonTutorialActive
} from './tutorial-sequence.js';

import * as State from './audio-state.js';
import { zoomState } from './zoom-state.js';
import { isTutorialActive } from './tutorial-state.js';
import { getCurrentRegions, getActiveRegionIndex, startFrequencySelection } from './region-tracker.js';

// Track last status message for replay on resume
let lastStatusMessage = null;
let lastStatusClassName = 'status info';

/**
 * Wrapper for setStatusText that tracks the last message
 */
function setStatusTextAndTrack(text, className = 'status info') {
    lastStatusMessage = text;
    lastStatusClassName = className;
    setStatusText(text, className);
}

/**
 * Helper: Wait for playback to resume if paused
 * Can be cancelled via a cancellation flag
 * Replays the last status message when playback resumes
 */
async function waitForPlaybackResume(cancelled) {
    // If already playing, no need to wait
    if (State.playbackState === State.PlaybackState.PLAYING) {
        return;
    }
    
    // Wait for playback to resume
    return new Promise((resolve) => {
        let timeoutId = null; // 🔥 FIX: Track timeout ID for cleanup
        
        const checkPlayback = () => {
            timeoutId = null; // Clear timeout ID when executing
            
            if (cancelled && cancelled.value) {
                resolve();
                return;
            }
            if (State.playbackState === State.PlaybackState.PLAYING) {
                // Playback resumed - replay the last message if we have one
                // (but NOT during pause button tutorial, as that has its own flow)
                if (lastStatusMessage && !isPauseButtonTutorialActive()) {
                    setStatusText(lastStatusMessage, lastStatusClassName);
                }
                resolve();
            } else {
                // 🔥 FIX: Store timeout ID for cleanup
                timeoutId = setTimeout(checkPlayback, 100); // Check every 100ms
            }
        };
        
        // Store cleanup function on cancelled object so it can be called
        if (cancelled) {
            cancelled.cleanup = () => {
                if (timeoutId !== null) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
            };
        }
        
        checkPlayback();
    });
}

/**
 * Helper: Create a skippable wait (for timed sections)
 * Enter key can skip these
 * Also pauses when user pauses playback and resumes when they resume
 * EXCEPT during pause button tutorial - in that case, timer continues normally
 */
function skippableWait(durationMs) {
    return new Promise(async (resolve) => {
        let elapsed = 0;
        const checkInterval = 50; // Check every 50ms
        let timeoutId = null;
        let isResolved = false;
        const cancelled = { value: false }; // Cancellation flag for waitForPlaybackResume
        
        const cleanup = () => {
            cancelled.value = true; // Cancel any pending playback resume wait
            
            // 🔥 FIX: Call cleanup function if it exists to clear timeout chain
            if (cancelled.cleanup) {
                cancelled.cleanup();
                cancelled.cleanup = null;
            }
            
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
        };
        
        const tick = () => {
            if (isResolved) return;
            
            // Check if playback is paused (but NOT during pause button tutorial OR during any tutorial)
            // During pause button tutorial, we want timer to continue so we can show unpause instructions
            // During any tutorial, we don't want waits to pause when playback ends/pauses
            if (State.playbackState === State.PlaybackState.PAUSED && !isPauseButtonTutorialActive() && !isTutorialActive()) {
                // Pause the timer - wait for playback to resume (only if NOT in tutorial)
                waitForPlaybackResume(cancelled).then(() => {
                    if (!isResolved && !cancelled.value) {
                        // Playback resumed - RESTART timer from 0 (reset elapsed)
                        elapsed = 0;
                        timeoutId = setTimeout(tick, checkInterval);
                    }
                });
                return;
            }
            
            elapsed += checkInterval;
            
            if (elapsed >= durationMs) {
                isResolved = true;
                cleanup();
                resolve();
            } else {
                timeoutId = setTimeout(tick, checkInterval);
            }
        };
        
        timeoutId = setTimeout(tick, checkInterval);
        
        // Store timeout so Enter key can skip it
        setTutorialPhase('timed_wait', [timeoutId], () => {
            isResolved = true;
            cleanup();
            resolve();
        });
    });
}

/**
 * Helper: Create a promise that resolves when user completes an action
 * Used for interactive sections like pause button and speed slider
 */
function userActionPromise(setupFn, phase) {
    return new Promise((resolve) => {
        // Set up the tutorial section and store resolve callback
        const cleanup = setupFn(resolve);
        
        // Store phase and resolve for Enter key skipping
        setTutorialPhase(phase, [], () => {
            if (cleanup) cleanup();
            resolve();
        });
    });
}

/**
 * ═══════════════════════════════════════════════════════════
 * LEGO BLOCKS - Each section is a clean async function
 * ═══════════════════════════════════════════════════════════
 */

/**
 * Wait for user to fetch data (detects when data fetching completes)
 */
function waitForDataFetch() {
    return new Promise((resolve) => {
        // Check if data is already loaded
        if (State.completeSamplesArray && State.completeSamplesArray.length > 0) {
            resolve();
            return;
        }
        
        // Set up a check interval to watch for data
        const checkInterval = 100; // Check every 100ms
        let timeoutId = null;
        
        const checkForData = () => {
            if (State.completeSamplesArray && State.completeSamplesArray.length > 0) {
                // Data is loaded!
                if (timeoutId !== null) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
                resolve();
            } else {
                // Keep checking
                timeoutId = setTimeout(checkForData, checkInterval);
            }
        };
        
        // Store phase for Enter key skipping
        setTutorialPhase('waiting_for_data_fetch', [timeoutId], () => {
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            resolve();
        });
        
        // Start checking
        checkForData();
    });
}

/**
 * Initial tutorial section - guides user to select volcano and fetch data
 */
async function showInitialFetchTutorial() {
    // Frequency scale dropdown is already disabled by runInitialTutorial()
    
    // Add glow to volcano selector
    const volcanoSelect = document.getElementById('volcano');
    if (volcanoSelect) {
        volcanoSelect.classList.add('pulse-glow');
    }
    
    // Show message guiding user to select volcano and fetch data
    setStatusTextAndTrack('<- Select a volcano and click Fetch Data.', 'status info');
    
    // Wait for user to fetch data
    await waitForDataFetch();
    
    // Remove glow from volcano selector
    if (volcanoSelect) {
        volcanoSelect.classList.remove('pulse-glow');
    }
    
    // Clear tutorial phase
    clearTutorialPhase();
}

async function showWellDoneMessage() {
    setStatusTextAndTrack('Success!', 'status success');
    await skippableWait(2000);
}

async function showVolcanoMessage() {
    const volcanoSelect = document.getElementById('volcano');
    const volcanoValue = volcanoSelect ? volcanoSelect.value : '';
    const volcanoNameMap = {
        'kilauea': 'Kīlauea',
        'maunaloa': 'Mauna Loa',
        'greatsitkin': 'Great Sitkin',
        'shishaldin': 'Shishaldin',
        'spurr': 'Mount Spurr'
    };
    const volcanoName = volcanoNameMap[volcanoValue] || 'the volcano';
    setStatusTextAndTrack(`This is the sound of seismic activity recorded at ${volcanoName} over the past 24 hours.`, 'status info');
    await skippableWait(5000);
}

async function showStationMetadataMessage() {
    // Get the currently selected station data from the dropdown
    const stationSelect = document.getElementById('station');
    if (!stationSelect || !stationSelect.value) {
        // Skip if no station selected
        return;
    }
    
    try {
        const stationData = JSON.parse(stationSelect.value);
        const distanceKm = stationData.distance_km || 0;
        const channel = stationData.channel || '';
        
        // Determine component description from channel
        // Channel format is typically like BHZ, HHZ, etc. where Z = vertical
        const component = channel.endsWith('Z') ? 'vertical (Z)' : 
                          channel.endsWith('N') ? 'north (N)' :
                          channel.endsWith('E') ? 'east (E)' : 'seismic';
        
        setStatusTextAndTrack(`The station is ${distanceKm}km from the volcano, and is measuring activity in the ${component} component.`, 'status info');
        await skippableWait(7000);
    } catch (error) {
        console.warn('Could not parse station data for metadata message:', error);
        // Skip if parsing fails
    }
}

async function showVolumeSliderTutorial() {
    // Add glow to volume slider
    addVolumeSliderGlow();
    
    // Show message about volume adjustment
    setStatusTextAndTrack('The volume can be adjusted here.', 'status info');
    
    // Wait 5 seconds
    await skippableWait(5000);
    
    // Remove glow
    removeVolumeSliderGlow();
}

async function runPauseButtonTutorial() {
    // The tutorial is now async, so we can await it directly
    // But we still need to handle skipping via Enter key
    await new Promise((resolve) => {
        // Store phase and resolve for Enter key skipping
        setTutorialPhase('pause_button', [], () => {
            endPauseButtonTutorial();
            resolve();
        });
        
        // Start the async tutorial
        startPauseButtonTutorial(resolve).catch(err => {
            console.error('Pause button tutorial error:', err);
            resolve();
        });
    });
}

async function showSpectrogramExplanation() {
    addSpectrogramGlow();
    
    // First message introducing the spectrogram
    setStatusTextAndTrack('This is a spectrogram of the data.', 'status info');
    await skippableWait(3000);
    
    // Second message about interesting features
    setStatusTextAndTrack('You may notice a variety of interesting features.', 'status info');
    await skippableWait(5000);
    
    // Third message about time flow
    setStatusTextAndTrack('Time flows from left to right 👉', 'status info');
    await skippableWait(5000);
    
    // Fourth message about frequency
    setStatusTextAndTrack('And frequency spans from low to high 👆', 'status info');
    await skippableWait(5000);
    
    // Additional message about selecting features (keep glow)
    setStatusTextAndTrack('A bit later we will use this space for selecting features.', 'status info');
    await skippableWait(5000);
    
    // Transition message before speed slider (keep glow)
    setStatusTextAndTrack('For now let\'s explore some more controls...', 'status info');
    await skippableWait(4000);
    
    // Remove glow when transitioning to speed slider
    removeSpectrogramGlow();
    await skippableWait(600); // Fade out duration
}

async function runSpeedSliderTutorial() {
    // The tutorial is now async, so we can await it directly
    // But we still need to handle skipping via Enter key
    await new Promise((resolve) => {
        // Store phase and resolve for Enter key skipping
        setTutorialPhase('speed_slider', [], () => {
            endSpeedSliderTutorial();
            resolve();
        });
        
        // Set up callback for when speed slider tutorial completes
        window._onSpeedSliderTutorialComplete = resolve;
        
        // Start the async tutorial
        startSpeedSliderTutorial().catch(err => {
            console.error('Speed slider tutorial error:', err);
            resolve();
        });
    });
}

async function enableWaveformTutorial() {
    // Enable waveform clicks
    enableWaveformClicks();
    
    // Show pulse and overlay if first time
    const waveformCanvas = document.getElementById('waveform');
    if (waveformCanvas && shouldShowPulse()) {
        waveformCanvas.classList.add('pulse');
        markPulseShown();
        showTutorialOverlay('Click here', true);
    }
    
    // Show final message
    setStatusTextAndTrack('Now click on the waveform to move the playhead somewhere interesting.', 'status success');
}

/**
 * Wait for user to click waveform (first click)
 * IMPORTANT: This must be called BEFORE showing the message to avoid race conditions
 */
function waitForWaveformClick() {
    return new Promise((resolve) => {
        console.log('🎯 waitForWaveformClick: Setting up promise, waveformHasBeenClicked:', State.waveformHasBeenClicked);
        
        // Check if already clicked
        if (State.waveformHasBeenClicked) {
            console.log('🎯 waitForWaveformClick: Already clicked, resolving immediately');
            resolve();
            return;
        }
        
        // Store resolve function FIRST to avoid race condition
        // This ensures that if a click happens immediately after, it will resolve the promise
        State.setWaveformClickResolve(resolve);
        console.log('🎯 waitForWaveformClick: Promise set up, waiting for click...');
        
        // Ensure clicks are enabled (in case they weren't already)
        enableWaveformClicks();
        
        // Store phase for Enter key skipping
        setTutorialPhase('waiting_for_waveform_click', [], () => {
            console.log('🎯 waitForWaveformClick: Skipped via Enter key');
            // Mark waveform click as satisfied when skipping
            State.setWaveformHasBeenClicked(true);
            if (State._waveformClickResolve) {
                State._waveformClickResolve();
                State.setWaveformClickResolve(null);
            }
            resolve();
        });
    });
}

/**
 * Wait for user to make a selection (drag and release)
 */
function waitForSelection() {
    return new Promise((resolve) => {
        // Set flag so waveform-renderer.js knows to resolve this promise
        State.setWaitingForSelection(true);
        State.setSelectionTutorialResolve(resolve);
        
        // Store phase for Enter key skipping
        setTutorialPhase('waiting_for_selection', [], () => {
            State.setWaitingForSelection(false);
            State.setSelectionTutorialResolve(null);
            resolve();
        });
    });
}

/**
 * Wait for user to create a region (press R or click Add Region button)
 */
function waitForRegionCreation() {
    return new Promise((resolve) => {
        // Set flag so region-tracker.js knows to resolve this promise
        State.setWaitingForRegionCreation(true);
        State.setRegionCreationResolve(resolve);
        
        // Store phase for Enter key skipping
        setTutorialPhase('waiting_for_region_creation', [], () => {
            State.setWaitingForRegionCreation(false);
            State.setRegionCreationResolve(null);
            resolve();
        });
    });
}

/**
 * Wait for user to click a region's play button
 */
function waitForRegionPlayClick() {
    return new Promise((resolve) => {
        // Set flag so region-tracker.js knows to resolve this promise
        State.setWaitingForRegionPlayClick(true);
        State.setRegionPlayClickResolve(resolve);
        
        // Store phase for Enter key skipping
        setTutorialPhase('waiting_for_region_play_click', [], () => {
            State.setWaitingForRegionPlayClick(false);
            State.setRegionPlayClickResolve(null);
            resolve();
        });
    });
}

/**
 * Wait for user to click region play button OR press spacebar/resume button
 */
function waitForRegionPlayOrResume() {
    return new Promise((resolve) => {
        // Set flag so we can resolve from multiple sources
        State.setWaitingForRegionPlayOrResume(true);
        State.setRegionPlayOrResumeResolve(resolve);
        
        // Store phase for Enter key skipping
        setTutorialPhase('waiting_for_region_play_or_resume', [], () => {
            State.setWaitingForRegionPlayOrResume(false);
            State.setRegionPlayOrResumeResolve(null);
            resolve();
        });
        
        // Also set up region play click handler (will resolve this promise too)
        State.setWaitingForRegionPlayClick(true);
        State.setRegionPlayClickResolve(resolve);
        
        // Monitor playback state - if it starts playing, resolve
        const checkPlayback = () => {
            if (State.playbackState === State.PlaybackState.PLAYING && State.waitingForRegionPlayOrResume) {
                State.setWaitingForRegionPlayOrResume(false);
                State.setWaitingForRegionPlayClick(false);
                State.setRegionPlayOrResumeResolve(null);
                State.setRegionPlayClickResolve(null);
                clearTutorialPhase();
                resolve();
            } else if (State.waitingForRegionPlayOrResume) {
                setTimeout(checkPlayback, 100);
            }
        };
        checkPlayback();
    });
}

/**
 * Wait for user to zoom into a region
 */
function waitForRegionZoom() {
    return new Promise((resolve) => {
        // Check if already zoomed
        if (zoomState.isInRegion()) {
            resolve();
            return;
        }
        
        // Set flag so zoomToRegion can resolve this promise when zoom happens
        State.setWaitingForRegionZoom(true);
        State.setRegionZoomResolve(resolve);
        
        // Store phase for Enter key skipping
        setTutorialPhase('waiting_for_region_zoom', [], () => {
            State.setWaitingForRegionZoom(false);
            State.setRegionZoomResolve(null);
            resolve();
        });
    });
}

/**
 * Wait for user to click the loop button
 */
function waitForLoopButtonClick() {
    return new Promise((resolve) => {
        // Set flag so toggleLoop can resolve this promise when clicked
        State.setWaitingForLoopButtonClick(true);
        State.setLoopButtonClickResolve(resolve);
        
        // Store phase for Enter key skipping
        setTutorialPhase('waiting_for_loop_button_click', [], () => {
            State.setWaitingForLoopButtonClick(false);
            State.setLoopButtonClickResolve(null);
            resolve();
        });
    });
}

/**
 * Wait for user to click the frequency scale dropdown (before changing)
 */
function waitForFrequencyScaleClick() {
    return new Promise((resolve) => {
        const frequencyScaleSelect = document.getElementById('frequencyScale');
        if (!frequencyScaleSelect) {
            resolve();
            return;
        }
        
        const handleClick = () => {
            frequencyScaleSelect.removeEventListener('click', handleClick);
            resolve();
        };
        
        frequencyScaleSelect.addEventListener('click', handleClick, { once: true });
        
        // Store phase for Enter key skipping
        setTutorialPhase('waiting_for_frequency_scale_click', [], () => {
            frequencyScaleSelect.removeEventListener('click', handleClick);
            resolve();
        });
    });
}

/**
 * Wait for user to change frequency scale (via dropdown)
 */
function waitForFrequencyScaleChange() {
    return new Promise((resolve) => {
        // Set flag so changeFrequencyScale can resolve this promise when changed
        State.setWaitingForFrequencyScaleChange(true);
        State.setFrequencyScaleChangeResolve(resolve);
        
        // Store phase for Enter key skipping
        setTutorialPhase('waiting_for_frequency_scale_change', [], () => {
            State.setWaitingForFrequencyScaleChange(false);
            State.setFrequencyScaleChangeResolve(null);
            resolve();
        });
    });
}

/**
 * Wait for user to press 2 frequency scale keyboard shortcuts (C, V, or B)
 * Also resolves after 8 seconds if they don't press 2 keys
 */
function waitForFrequencyScaleKeys() {
    return new Promise((resolve) => {
        // Reset counter
        State.setFrequencyScaleKeyPressCount(0);
        
        // Set flag so keyboard shortcuts can resolve this promise
        State.setWaitingForFrequencyScaleKeys(true);
        State.setFrequencyScaleKeysResolve(resolve);
        
        // Store phase for Enter key skipping
        setTutorialPhase('waiting_for_frequency_scale_keys', [], () => {
            State.setWaitingForFrequencyScaleKeys(false);
            State.setFrequencyScaleKeysResolve(null);
            State.setFrequencyScaleKeyPressCount(0);
            resolve();
        });
        
        // Timeout after 8 seconds if they don't press 2 keys
        setTimeout(() => {
            if (State.waitingForFrequencyScaleKeys) {
                State.setWaitingForFrequencyScaleKeys(false);
                State.setFrequencyScaleKeysResolve(null);
                State.setFrequencyScaleKeyPressCount(0);
                clearTutorialPhase();
                resolve();
            }
        }, 8000);
    });
}

/**
 * Wait for user to complete feature selection (draw a box on spectrogram)
 */
function waitForFeatureSelection() {
    return new Promise((resolve) => {
        // Check if feature is already selected
        const activeRegionIndex = getActiveRegionIndex();
        if (activeRegionIndex !== null) {
            const regions = getCurrentRegions();
            const region = regions[activeRegionIndex];
            if (region && region.features && region.features[0]) {
                const feature = region.features[0];
                if (feature.lowFreq && feature.highFreq && feature.startTime && feature.endTime) {
                    resolve();
                    return;
                }
            }
        }
        
        // Set flag so handleSpectrogramSelection can resolve this promise
        State.setWaitingForFeatureSelection(true);
        State.setFeatureSelectionResolve(resolve);
        
        // Store phase for Enter key skipping
        setTutorialPhase('waiting_for_feature_selection', [], () => {
            State.setWaitingForFeatureSelection(false);
            State.setFeatureSelectionResolve(null);
            resolve();
        });
    });
}

/**
 * Wait for user to type description and press Enter
 */
function waitForFeatureDescription(regionIndex, featureIndex) {
    return new Promise((resolve) => {
        const notesField = document.getElementById(`notes-${regionIndex}-${featureIndex}`);
        if (!notesField) {
            resolve();
            return;
        }
        
        // Check if already has content
        if (notesField.value.trim()) {
            // Wait for Enter key
            const handleKeyDown = (e) => {
                if (e.key === 'Enter') {
                    notesField.removeEventListener('keydown', handleKeyDown);
                    notesField.removeEventListener('blur', handleBlur);
                    State.setWaitingForFeatureDescription(false);
                    State.setFeatureDescriptionResolve(null);
                    resolve();
                }
            };
            
            const handleBlur = () => {
                notesField.removeEventListener('keydown', handleKeyDown);
                notesField.removeEventListener('blur', handleBlur);
                State.setWaitingForFeatureDescription(false);
                State.setFeatureDescriptionResolve(null);
                resolve();
            };
            
            notesField.addEventListener('keydown', handleKeyDown);
            notesField.addEventListener('blur', handleBlur);
            return;
        }
        
        // Set flag so we can resolve when user types and presses Enter
        State.setWaitingForFeatureDescription(true);
        State.setFeatureDescriptionResolve(resolve);
        
        const handleKeyDown = (e) => {
            if (e.key === 'Enter' && notesField.value.trim()) {
                notesField.removeEventListener('keydown', handleKeyDown);
                notesField.removeEventListener('blur', handleBlur);
                State.setWaitingForFeatureDescription(false);
                State.setFeatureDescriptionResolve(null);
                clearTutorialPhase();
                resolve();
            }
        };
        
        const handleBlur = () => {
            if (notesField.value.trim()) {
                notesField.removeEventListener('keydown', handleKeyDown);
                notesField.removeEventListener('blur', handleBlur);
                State.setWaitingForFeatureDescription(false);
                State.setFeatureDescriptionResolve(null);
                clearTutorialPhase();
                resolve();
            }
        };
        
        notesField.addEventListener('keydown', handleKeyDown);
        notesField.addEventListener('blur', handleBlur);
        
        // Store phase for Enter key skipping
        setTutorialPhase('waiting_for_feature_description', [], () => {
            notesField.removeEventListener('keydown', handleKeyDown);
            notesField.removeEventListener('blur', handleBlur);
            State.setWaitingForFeatureDescription(false);
            State.setFeatureDescriptionResolve(null);
            resolve();
        });
    });
}

/**
 * Wait for user to click repetition dropdown
 */
function waitForRepetitionDropdown(regionIndex, featureIndex) {
    return new Promise((resolve) => {
        const select = document.getElementById(`repetition-${regionIndex}-${featureIndex}`);
        if (!select) {
            resolve();
            return;
        }
        
        // Set flag
        State.setWaitingForRepetitionDropdown(true);
        State.setRepetitionDropdownResolve(resolve);
        
        const handleClick = () => {
            select.removeEventListener('click', handleClick);
            State.setWaitingForRepetitionDropdown(false);
            State.setRepetitionDropdownResolve(null);
            clearTutorialPhase();
            resolve();
        };
        
        select.addEventListener('click', handleClick, { once: true });
        
        // Store phase for Enter key skipping
        setTutorialPhase('waiting_for_repetition_dropdown', [], () => {
            select.removeEventListener('click', handleClick);
            State.setWaitingForRepetitionDropdown(false);
            State.setRepetitionDropdownResolve(null);
            resolve();
        });
    });
}

/**
 * Wait for user to click type dropdown
 */
function waitForTypeDropdown(regionIndex, featureIndex) {
    return new Promise((resolve) => {
        const select = document.getElementById(`type-${regionIndex}-${featureIndex}`);
        if (!select) {
            resolve();
            return;
        }
        
        // Set flag
        State.setWaitingForTypeDropdown(true);
        State.setTypeDropdownResolve(resolve);
        
        const handleClick = () => {
            select.removeEventListener('click', handleClick);
            State.setWaitingForTypeDropdown(false);
            State.setTypeDropdownResolve(null);
            clearTutorialPhase();
            resolve();
        };
        
        select.addEventListener('click', handleClick, { once: true });
        
        // Store phase for Enter key skipping
        setTutorialPhase('waiting_for_type_dropdown', [], () => {
            select.removeEventListener('click', handleClick);
            State.setWaitingForTypeDropdown(false);
            State.setTypeDropdownResolve(null);
            resolve();
        });
    });
}

async function runSelectionTutorial() {
    // 🎓 Check if user already made a selection (got ahead of tutorial)
    // Check if selection exists AND we're waiting for region creation (meaning user got ahead)
    if (State.selectionStart !== null && State.selectionEnd !== null) {
        if (State.waitingForRegionCreation) {
            // User already made selection - skip selection tutorial and go straight to region creation
            console.log('🎓 Tutorial: User already made selection, skipping selection tutorial');
            return; // Will continue to runRegionIntroduction
        }
        // If selection exists but we're not waiting for region creation yet, 
        // it means selection was made during this tutorial - resolve immediately
        if (State.waitingForSelection && State._selectionTutorialResolve) {
            console.log('🎓 Tutorial: Selection already exists, resolving immediately');
            State._selectionTutorialResolve();
            State.setSelectionTutorialResolve(null);
            State.setWaitingForSelection(false);
            // Show "Nice!" message
            await skippableWait(500);
            setStatusTextAndTrack('Nice!', 'status success');
            await skippableWait(1000);
            clearTutorialPhase();
            return; // Skip the rest of selection tutorial
        }
    }
    
    // Set up the promise FIRST before showing the message to avoid race conditions
    const clickPromise = waitForWaveformClick();
    
    // Now enable waveform tutorial (shows message and enables clicks)
    await enableWaveformTutorial();
    
    // Wait for user to click waveform first
    await clickPromise;
    
    // 🎓 Check again if selection was made while waiting for click
    if (State.selectionStart !== null && State.selectionEnd !== null && State.waitingForRegionCreation) {
        console.log('🎓 Tutorial: Selection made during click wait, skipping drag message');
        return; // Skip drag message and go to region creation
    }
    
    // Wait 5 seconds after waveform click, then show drag message
    await skippableWait(5000);
    
    // 🎓 Check one more time before showing drag message
    if (State.selectionStart !== null && State.selectionEnd !== null && State.waitingForRegionCreation) {
        console.log('🎓 Tutorial: Selection made during wait, skipping drag message');
        return; // Skip drag message and go to region creation
    }
    
    setStatusTextAndTrack('Now click on the waveform and DRAG and RELEASE to make a selection.', 'status info');
    
    // Wait for user to make a selection
    await waitForSelection();
    
    // Wait 0.5 seconds, then show "Nice!" for 1 second
    await skippableWait(500);
    setStatusTextAndTrack('Nice!', 'status success');
    await skippableWait(1000);
    
    // Selection tutorial complete - transition to region introduction
    // Clear tutorial phase
    clearTutorialPhase();
}

async function runRegionIntroduction() {
    // 🎓 Check if user already made a selection - if so, message was already shown
    if (State.selectionStart !== null && State.selectionEnd !== null && State.waitingForRegionCreation) {
        // User got ahead - message already shown, just wait for region creation
        console.log('🎓 Tutorial: User already made selection, waiting for region creation');
    } else {
        // Show the "Click Add Region" message
        setStatusTextAndTrack('Click Add Region or type (R) to create a new region.', 'status info');
    }
    
    // Wait for user to create a region
    await waitForRegionCreation();
    
    // Show "You just created your first region!" message
    setStatusTextAndTrack('You just created your first region!', 'status success');
    await skippableWait(3000);
    
    // Disable all region buttons during tutorial explanation
    disableRegionButtons();
    
    // Add glow to regions panel and show message about regions being added below
    addRegionsPanelGlow();
    setStatusTextAndTrack('When a new region is created, it gets added down below.', 'status info');
    await skippableWait(4000);
    
    // Remove glow and enable play button for region 1 (index 0)
    removeRegionsPanelGlow();
    enableRegionPlayButton(0);
    setStatusTextAndTrack('Press the play button for region 1 to have a listen.', 'status info');
    
    // Wait for user to click the play button
    await waitForRegionPlayClick();
    
    // Wait 2s before transitioning to next section (magnifier message)
    await skippableWait(2000);
    
    // Clear tutorial phase
    clearTutorialPhase();
}

/**
 * Region zooming tutorial section
 * Guides user to zoom into a region and notice features
 */
async function runRegionZoomingTutorial() {
    // Enable hourglass (loading indicator) and show message about zoom button
    const statusEl = document.getElementById('status');
    if (statusEl) {
        statusEl.classList.add('loading');
    }
    
    setStatusTextAndTrack('Click the magnifier 🔍 to the left of the play button to zoom in.', 'status info');
    
    // Enable zoom button for region 1 (index 0)
    enableRegionZoomButton(0);
    
    // Wait for user to zoom in
    await waitForRegionZoom();
    
    // Remove loading indicator
    if (statusEl) {
        statusEl.classList.remove('loading');
    }
    
    // Pause for a moment, then show message about features
    await skippableWait(2000);
    setStatusTextAndTrack('Notice that within regions it\'s easier to see features on the spectrogram.', 'status info');
    await skippableWait(5000);
    
    // Enable loop button first (before showing message)
    const loopBtn = document.getElementById('loopBtn');
    if (loopBtn) {
        loopBtn.disabled = false;
        console.log('🎓 Tutorial: Loop button enabled');
    }
    
    // Add glow and introduce it
    addLoopButtonGlow();
    
    // Set up loop button click resolver early to detect if user clicks before being asked
    let loopButtonClickedEarly = false;
    const earlyClickPromise = new Promise((resolve) => {
        State.setWaitingForLoopButtonClick(true);
        State.setLoopButtonClickResolve(() => {
            loopButtonClickedEarly = true;
            State.setWaitingForLoopButtonClick(false);
            State.setLoopButtonClickResolve(null);
            resolve();
        });
    });
    
    setStatusTextAndTrack('This is the loop button.', 'status info');
    console.log('🎓 Tutorial: Showing loop button message');
    
    // Wait 3s, but check if loop was clicked during this time
    await Promise.race([
        skippableWait(3000),
        earlyClickPromise
    ]);
    
    // If loop was clicked early, skip to "Loop is now enabled." message
    if (loopButtonClickedEarly) {
        // Reset the resolver since we already handled it
        State.setWaitingForLoopButtonClick(false);
        State.setLoopButtonClickResolve(null);
        
        // Show "Loop is now enabled." immediately
        setStatusTextAndTrack('Loop is now enabled.', 'status success');
    } else {
        // User didn't click early, continue with normal flow
        // Ask user to click it
        setStatusTextAndTrack('Try clicking it now to enable looping over this region.', 'status info');
        
        // Wait for user to click loop button
        await waitForLoopButtonClick();
        
        // 1s after click, say "Loop is now enabled."
        await skippableWait(1000);
        setStatusTextAndTrack('Loop is now enabled.', 'status success');
    }
    
    // Wait 2s
    await skippableWait(2000);
    
    // Remove glow from loop button
    removeLoopButtonGlow();
    
    // Ask user to press spacebar to play region from beginning
    setStatusTextAndTrack('Press the (space bar) to play this region from the beginning now', 'status info');
    
    // Wait for user to press spacebar (or click region play button/resume)
    await waitForRegionPlayOrResume();
    
    // Give freedom message and keep it on screen longer
    setStatusTextAndTrack('Feel free to play and pause as you wish from here on out!', 'status info');
    await skippableWait(5000);
    
    // Clear tutorial phase
    clearTutorialPhase();
}

/**
 * Frequency scale tutorial section
 * Guides user to change frequency scale and use keyboard shortcuts
 */
async function runFrequencyScaleTutorial() {
    // Enable the frequency scale dropdown
    enableFrequencyScaleDropdown();
    
    // Make the box glow
    addFrequencyScaleGlow();
    
    // Wait 2s before showing message
    await skippableWait(2000);
    
    // Show message about frequency scaling
    setStatusTextAndTrack('Changing the frequency scaling of the spectrogram can help reveal more details.', 'status info');
    await skippableWait(5000);
    
    // Invite user to click and change to another frequency scale
    setStatusTextAndTrack('Try changing to another frequency scale in the lower right hand corner 👇', 'status info');
    
    // Wait for user to click the dropdown (then remove glow)
    await waitForFrequencyScaleClick();
    
    // Remove glow after click
    removeFrequencyScaleGlow();
    
    // Wait for user to change frequency scale
    await waitForFrequencyScaleChange();
    
    // Briefly congratulate using same pacing as before (1s wait, "Great!", 2s wait)
    await skippableWait(1000);
    setStatusTextAndTrack('Great!', 'status success');
    await skippableWait(2000);
    
    // Tell user about keyboard shortcuts
    setStatusTextAndTrack('You can also press (C) (V) and (B) on the keyboard to switch between modes, try this now.', 'status info');
    
    // Wait for user to press any 2 of these keys (or timeout after 8s)
    await waitForFrequencyScaleKeys();
    
    // Pause for 2s and say "Well done!"
    await skippableWait(2000);
    setStatusTextAndTrack('Well done!', 'status success');
    
    // Remove glow from frequency scale dropdown
    removeFrequencyScaleGlow();
    
    // Final message
    await skippableWait(2000);
    setStatusTextAndTrack('Pick a scaling that works well and let\'s select a feature.', 'status info');
    await skippableWait(6000);
    
    // Clear tutorial phase
    clearTutorialPhase();
    
    // Continue to feature selection tutorial
    await runFeatureSelectionTutorial();
}

/**
 * Feature selection tutorial section
 * Guides user through selecting a feature, adding description, and using dropdowns
 */
async function runFeatureSelectionTutorial() {
    // Ensure we're zoomed into a region
    if (!zoomState.isInRegion()) {
        console.warn('⚠️ Feature selection tutorial: Not zoomed into a region');
        return;
    }
    
    const activeRegionIndex = getActiveRegionIndex();
    if (activeRegionIndex === null) {
        console.warn('⚠️ Feature selection tutorial: No active region');
        return;
    }
    
    const regions = getCurrentRegions();
    const region = regions[activeRegionIndex];
    if (!region || !region.features || region.features.length === 0) {
        console.warn('⚠️ Feature selection tutorial: No features in region');
        return;
    }
    
    const featureIndex = 0; // First feature
    
    // Disable add feature button
    disableAddFeatureButton(activeRegionIndex);
    
    // "Have a look and listen around this region... what do you notice?" (8s)
    setStatusTextAndTrack('Have a look and listen around this region... what do you notice?', 'status info');
    await skippableWait(8000);
    
    // "Feel free to change the playback speed!" (10s)
    setStatusTextAndTrack('Feel free to change the playback speed!', 'status info');
    await skippableWait(10000);
    
    // "Once you've found something interesting, let's mark it as a feature."
    setStatusTextAndTrack('Once you\'ve found something interesting, let\'s mark it as a feature.', 'status info');
    await skippableWait(3000);
    
    // Enable select feature button and make it red (active)
    enableSelectFeatureButton(activeRegionIndex, featureIndex);
    
    // Start feature selection mode
    startFrequencySelection(activeRegionIndex, featureIndex);
    
    // Highlight spectrogram window
    addSpectrogramGlow();
    
    // "Now click and drag to create a box around a feature of interest." (15s)
    setStatusTextAndTrack('Now click and drag to create a box around a feature of interest.', 'status info');
    
    // Set up conditional message after 15s if they haven't drawn yet
    let hasDrawnBox = false;
    const conditionalMessageTimeout = setTimeout(() => {
        if (!hasDrawnBox && State.waitingForFeatureSelection) {
            setStatusTextAndTrack('Click on the spectrogram and drag your mouse to draw a box.', 'status info');
        }
    }, 15000);
    
    // Wait for feature selection
    await waitForFeatureSelection();
    hasDrawnBox = true;
    clearTimeout(conditionalMessageTimeout);
    
    // Remove spectrogram glow
    removeSpectrogramGlow();
    
    // "You've identified a feature!" - wait 3s
    setStatusTextAndTrack('You\'ve identified a feature!', 'status success');
    await skippableWait(3000);
    
    // "You can start typing now to provide a description." - wait 10s
    setStatusTextAndTrack('You can start typing now to provide a description.', 'status info');
    await skippableWait(10000);
    
    // "When you are done, hit enter/return."
    setStatusTextAndTrack('When you are done, hit enter/return.', 'status info');
    
    // Wait for description completion
    await waitForFeatureDescription(activeRegionIndex, featureIndex);
    
    // Pause 1s
    await skippableWait(1000);
    
    // Highlight repetition dropdown (far left)
    addRepetitionDropdownGlow(activeRegionIndex, featureIndex);
    setStatusTextAndTrack('Click the drop down menu on the far left to choose whether this event is unique or repeating', 'status info');
    
    // Wait for dropdown click with timeout
    const dropdownClickPromise = waitForRepetitionDropdown(activeRegionIndex, featureIndex);
    const dropdownTimeoutPromise = skippableWait(10000);
    
    const dropdownResult = await Promise.race([dropdownClickPromise, dropdownTimeoutPromise]);
    
    // If they clicked, wait 4s, otherwise just continue
    if (!State.waitingForRepetitionDropdown) {
        // They clicked
        await skippableWait(4000);
    }
    
    // Remove repetition dropdown glow
    removeRepetitionDropdownGlow(activeRegionIndex, featureIndex);
    
    // Highlight type dropdown (impulsive/continuous)
    addTypeDropdownGlow(activeRegionIndex, featureIndex);
    setStatusTextAndTrack('Impulsive events are short, and continuous events are long', 'status info');
    await skippableWait(7000);
    
    // Remove type dropdown glow
    removeTypeDropdownGlow(activeRegionIndex, featureIndex);
    
    // Glow select feature button (but don't make it red, just enabled)
    enableSelectFeatureButton(activeRegionIndex, featureIndex);
    addSelectFeatureButtonGlow(activeRegionIndex, featureIndex);
    setStatusTextAndTrack('You can click here if you ever change your mind and would like to change your selection.', 'status info');
    await skippableWait(5000);
    
    // Remove select feature button glow
    removeSelectFeatureButtonGlow(activeRegionIndex, featureIndex);
    
    // Enable add feature button
    enableAddFeatureButton(activeRegionIndex);
    
    // Highlight add feature button
    addAddFeatureButtonGlow(activeRegionIndex);
    setStatusTextAndTrack('Click this button now to add another feature.', 'status info');
    await skippableWait(5000);
    
    // Remove add feature button glow
    removeAddFeatureButtonGlow(activeRegionIndex);
    
    // Clear tutorial phase
    clearTutorialPhase();
}

/**
 * ═══════════════════════════════════════════════════════════
 * MAIN SEQUENCE - The beautiful linear flow ✨
 * ═══════════════════════════════════════════════════════════
 * 
 * Want to reorder sections? Just move the lines!
 * Want to add a new section? Drop in a new await!
 * Want to remove a section? Delete or comment the line!
 */
export async function runMainTutorial() {
    try {
        // Frequency scale dropdown is already disabled by runInitialTutorial()
        // (which runs before this function)
        
        await showWellDoneMessage();           // 2s - "Success!"
        await showVolumeSliderTutorial();      // 5s - volume slider glow and message
        await showVolcanoMessage();            // 5s  
        await showStationMetadataMessage();    // 7s
        await runPauseButtonTutorial();        // wait for user to pause & resume
        await showSpectrogramExplanation();    // 5s + 600ms fade
        await runSpeedSliderTutorial();        // wait for user to complete slider actions
        await runSelectionTutorial();          // enable waveform clicks, show message, wait for click, then wait for selection
        await runRegionIntroduction();         // region introduction tutorial
        await runRegionZoomingTutorial();      // region zooming tutorial (includes loop button)
        await runFrequencyScaleTutorial();     // frequency scale tutorial (includes feature selection tutorial)
        
        console.log('🎓 Tutorial complete!');
    } finally {
        // 🔥 FIX: Clean up window properties to prevent memory leaks
        if (window._onSpeedSliderTutorialComplete) {
            window._onSpeedSliderTutorialComplete = null;
        }
    }
}

/**
 * ═══════════════════════════════════════════════════════════
 * INITIAL TUTORIAL - Starts on page load, guides user to fetch data
 * ═══════════════════════════════════════════════════════════
 */
export async function runInitialTutorial() {
    try {
        // Disable frequency scale dropdown IMMEDIATELY at the very start
        disableFrequencyScaleDropdown();
        
        // Show initial fetch tutorial (always, even if data is already loaded)
        await showInitialFetchTutorial();
        
        // After data is fetched, continue with main tutorial
        // Small delay to let the UI settle after data loads
        await skippableWait(200);
        
        // Run the main tutorial sequence
        await runMainTutorial();
    } catch (error) {
        console.error('Initial tutorial error:', error);
    }
}

