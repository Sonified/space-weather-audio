/**
 * tutorial-coordinator.js
 * Clean, linear tutorial sequence with async/await
 * Each section is a LEGO block that can be reordered
 */

import { 
    setStatusText, 
    addSpectrogramGlow, 
    removeSpectrogramGlow, 
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
    endSpeedSliderTutorial 
} from './tutorial-sequence.js';

/**
 * Helper: Create a skippable wait (for timed sections)
 * Enter key can skip these
 */
function skippableWait(durationMs) {
    return new Promise((resolve) => {
        const timeoutId = setTimeout(resolve, durationMs);
        
        // Store timeout so Enter key can skip it
        setTutorialPhase('timed_wait', [timeoutId], resolve);
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
    setStatusText('Well done!', 'status success');
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
    setStatusText(`This is the sound of ${volcanoName}, recorded over the past 24 hours.`, 'status info');
    await skippableWait(5000);
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
    setStatusText('This is a spectrogram of the data.', 'status info');
    await skippableWait(3000);
    
    // Second message about time flow
    setStatusText('Time flows from left to right 👉', 'status info');
    await skippableWait(5000);
    
    // Third message about frequency
    setStatusText('And frequency spans from low to high.', 'status info');
    await skippableWait(5000);
    
    // Additional message about selecting features (keep glow)
    setStatusText('A bit later we will use this space for selecting features.', 'status info');
    await skippableWait(5000);
    
    // Transition message before speed slider (keep glow)
    setStatusText('For now let\'s explore some more controls...', 'status info');
    await skippableWait(6000);
    
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
    setStatusText('Click on the waveform to move the playhead somewhere interesting.', 'status success');
    
    // Clear tutorial phase - we're done!
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
    await showWellDoneMessage();           // 2s
    await showVolcanoMessage();            // 5s  
    await runPauseButtonTutorial();        // wait for user to pause & resume
    await showSpectrogramExplanation();    // 5s + 600ms fade
    await runSpeedSliderTutorial();        // wait for user to complete slider actions
    await enableWaveformTutorial();        // final step - enable waveform clicks
    
    console.log('🎓 Tutorial complete!');
}

