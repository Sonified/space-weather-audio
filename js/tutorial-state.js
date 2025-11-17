/**
 * tutorial-state.js
 * High-level tutorial state machine and coordination
 * Manages tutorial phases, keyboard shortcuts, and sequence coordination
 */

import { skipAnimations } from './tutorial-effects.js';

// Tutorial sequence state machine
let tutorialPhase = null; // 'well_done', 'volcano_message', 'spectrogram_explanation', 'speed_slider', 'waveform_tutorial', null
let tutorialTimeouts = []; // Array of setTimeout IDs to cancel when skipping
let tutorialAdvanceCallback = null; // Callback to advance to next phase

/**
 * Set the current tutorial phase and store timeout references
 */
export function setTutorialPhase(phase, timeouts = [], advanceCallback = null) {
    tutorialPhase = phase;
    tutorialTimeouts = timeouts;
    tutorialAdvanceCallback = advanceCallback;
}

/**
 * Clear tutorial phase tracking
 */
export function clearTutorialPhase() {
    tutorialPhase = null;
    tutorialTimeouts = [];
    tutorialAdvanceCallback = null;
}

/**
 * Advance to the next tutorial phase
 */
export function advanceTutorialPhase() {
    // Cancel all pending timeouts for current phase
    tutorialTimeouts.forEach(timeoutId => {
        if (timeoutId) clearTimeout(timeoutId);
    });
    tutorialTimeouts = [];
    
    // Skip current animation
    skipAnimations();
    
    // Call advance callback if it exists - this should immediately execute the next step
    if (tutorialAdvanceCallback) {
        const callback = tutorialAdvanceCallback;
        tutorialAdvanceCallback = null; // Clear to prevent double-call
        // Execute callback immediately to show next step
        callback();
    }
}

/**
 * Initialize tutorial system
 */
export function initTutorial() {
    // Tutorial overlay will be shown after first data fetch
    // and hidden when user clicks the waveform
    
    // Add keyboard listener for Enter/Return to skip animations AND advance tutorial
    if (typeof window !== 'undefined') {
        // Only add listener once
        if (!window._tutorialSkipListenerAdded) {
            window.addEventListener('keydown', (e) => {
                // Skip animations and advance tutorial on Enter/Return (but not if user is typing in an input field)
                if (e.key === 'Enter' || e.key === 'Return') {
                    const activeElement = document.activeElement;
                    const isInputField = activeElement && (
                        activeElement.tagName === 'INPUT' ||
                        activeElement.tagName === 'TEXTAREA' ||
                        activeElement.isContentEditable
                    );
                    
                    // Only skip if not in an input field
                    if (!isInputField) {
                        e.preventDefault();
                        
                        // Skip current animation
                        skipAnimations();
                        
                        // Advance to next tutorial phase if we're in a tutorial sequence
                        if (tutorialPhase) {
                            advanceTutorialPhase();
                        }
                    }
                }
            });
            window._tutorialSkipListenerAdded = true;
        }
    }
}

