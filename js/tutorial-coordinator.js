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
    disableRegionButtons,
    enableRegionButtons,
    enableWaveformClicks, 
    shouldShowPulse, 
    markPulseShown, 
    showTutorialOverlay, 
    setTutorialPhase, 
    clearTutorialPhase 
} from './tutorial.js';

import { 
    startPauseButtonTutorial, 
    endPauseButtonTutorial, 
    startSpeedSliderTutorial, 
    endSpeedSliderTutorial,
    isPauseButtonTutorialActive
} from './tutorial-sequence.js';

import * as State from './audio-state.js';

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
            
            // Check if playback is paused (but NOT during pause button tutorial)
            // During pause button tutorial, we want timer to continue so we can show unpause instructions
            if (State.playbackState === State.PlaybackState.PAUSED && !isPauseButtonTutorialActive()) {
                // Pause the timer - wait for playback to resume
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
    await skippableWait(5000);
    
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

async function runSelectionTutorial() {
    // Set up the promise FIRST before showing the message to avoid race conditions
    const clickPromise = waitForWaveformClick();
    
    // Now enable waveform tutorial (shows message and enables clicks)
    await enableWaveformTutorial();
    
    // Wait for user to click waveform first
    await clickPromise;
    
    // Wait 6 seconds after waveform click, then show drag message
    await skippableWait(6000);
    
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
    // Show the "Type (R)" message
    setStatusTextAndTrack('Type (R) or click the Add Region button to create a new region.', 'status info');
    
    // Wait for user to create a region
    await waitForRegionCreation();
    
    // Show "You just created your first region!" message
    setStatusTextAndTrack('You just created your first region!', 'status success');
    await skippableWait(4000);
    
    // Disable all region buttons during tutorial explanation
    disableRegionButtons();
    
    // Add glow to regions panel and show message about regions being added below
    addRegionsPanelGlow();
    setStatusTextAndTrack('When a new region is created, it gets added down below.', 'status info');
    await skippableWait(4000);
    
    // Show explanation about regions
    setStatusTextAndTrack('Regions will help us move around and identify features.', 'status info');
    await skippableWait(4000);
    
    // Remove glow and re-enable buttons
    removeRegionsPanelGlow();
    enableRegionButtons();
    
    // Show zoom message
    setStatusTextAndTrack('Type 1 to zoom or click the play button on the region to explore it.', 'status info');
    
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
        await showWellDoneMessage();           // 2s
        await showVolcanoMessage();            // 5s  
        await showStationMetadataMessage();    // 7s
        await showVolumeSliderTutorial();      // 5s - volume slider glow and message
        await runPauseButtonTutorial();        // wait for user to pause & resume
        await showSpectrogramExplanation();    // 5s + 600ms fade
        await runSpeedSliderTutorial();        // wait for user to complete slider actions
        await runSelectionTutorial();          // enable waveform clicks, show message, wait for click, then wait for selection
        await runRegionIntroduction();         // region introduction tutorial
        
        console.log('🎓 Tutorial complete!');
    } finally {
        // 🔥 FIX: Clean up window properties to prevent memory leaks
        if (window._onSpeedSliderTutorialComplete) {
            window._onSpeedSliderTutorialComplete = null;
        }
    }
}

