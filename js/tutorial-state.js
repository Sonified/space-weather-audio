/**
 * tutorial-state.js
 * High-level tutorial state machine and coordination
 * Manages tutorial phases, keyboard shortcuts, and sequence coordination
 */

import { skipAnimations, hideTutorialOverlay } from './tutorial-effects.js';
import { isLocalEnvironment } from './master-modes.js';

// Tutorial sequence state machine
let tutorialPhase = null; // 'well_done', 'volcano_message', 'spectrogram_explanation', 'speed_slider', 'waveform_tutorial', null
let tutorialTimeouts = []; // Array of setTimeout IDs to cancel when skipping
let tutorialAdvanceCallback = null; // Callback to advance to next phase

// Tutorial history for left/right arrow navigation
let tutorialHistory = []; // Array of { phase, timeouts, callback, statusMessage, statusClassName } snapshots
let currentHistoryIndex = -1; // Current position in history (-1 means no history)
let promiseRecreator = null; // Function to recreate the promise for the current phase

/**
 * Set the current tutorial phase and store timeout references
 * @param {Function} recreatePromiseFn - Optional function to recreate the promise if going back
 */
export function setTutorialPhase(phase, timeouts = [], advanceCallback = null, recreatePromiseFn = null) {
    // Save current state to history before changing
    if (tutorialPhase !== null) {
        const statusEl = document.getElementById('status');
        const statusMessage = statusEl ? statusEl.textContent : null;
        const statusClassName = statusEl ? statusEl.className : 'status info';
        
        // Add to history (but only if it's a new phase, not a duplicate)
        if (tutorialHistory.length === 0 || tutorialHistory[tutorialHistory.length - 1].phase !== tutorialPhase) {
            tutorialHistory.push({
                phase: tutorialPhase,
                timeouts: [...tutorialTimeouts],
                callback: tutorialAdvanceCallback,
                statusMessage,
                statusClassName,
                recreatePromiseFn: promiseRecreator // Save the promise recreator for this step
            });
            currentHistoryIndex = tutorialHistory.length - 1;
            console.log('📚 Saved tutorial step to history:', tutorialPhase, 'index:', currentHistoryIndex);
        }
    }
    
    tutorialPhase = phase;
    tutorialTimeouts = timeouts;
    tutorialAdvanceCallback = advanceCallback;
    promiseRecreator = recreatePromiseFn; // Store the recreator for potential future use
}

/**
 * Clear tutorial phase tracking
 */
export function clearTutorialPhase() {
    tutorialPhase = null;
    tutorialTimeouts = [];
    tutorialAdvanceCallback = null;
    // Don't clear history - keep it for navigation
}

/**
 * Go back to previous tutorial step and recreate the promise
 */
export async function goBackTutorialStep() {
    if (currentHistoryIndex <= 0) {
        console.log('⚠️ Cannot go back - no previous step in history');
        return false;
    }
    
    // Cancel current timeouts first
    tutorialTimeouts.forEach(timeoutId => {
        if (timeoutId) clearTimeout(timeoutId);
    });
    
    // Skip animations (like right arrow does)
    skipAnimations();
    
    // Clear any existing promise resolvers to prevent conflicts
    const { clearAllTutorialResolvers } = await import('./tutorial-coordinator.js');
    clearAllTutorialResolvers();
    
    // Move back in history
    currentHistoryIndex--;
    const previousStep = tutorialHistory[currentHistoryIndex];
    
    console.log('⬅️ Going back to tutorial step:', previousStep.phase, 'index:', currentHistoryIndex);
    
    // Restore previous state
    tutorialPhase = previousStep.phase;
    tutorialTimeouts = [];
    tutorialAdvanceCallback = previousStep.callback;
    promiseRecreator = previousStep.recreatePromiseFn;
    
    // Restore status message
    if (previousStep.statusMessage) {
        const statusEl = document.getElementById('status');
        if (statusEl) {
            statusEl.textContent = previousStep.statusMessage;
            statusEl.className = previousStep.statusClassName;
        }
    }
    
    // Clear visual states
    const { clearAllTutorialVisualStates } = await import('./tutorial-coordinator.js');
    clearAllTutorialVisualStates();
    
    // 🔥 CRITICAL: Recreate the promise so tutorial can continue waiting
    if (promiseRecreator && typeof promiseRecreator === 'function') {
        console.log('🔄 Recreating promise for phase:', previousStep.phase);
        try {
            // Recreate the promise - this will set up the waiting state again
            await promiseRecreator();
            console.log('✅ Promise recreated successfully');
        } catch (err) {
            console.error('❌ Error recreating promise:', err);
        }
    } else {
        console.log('⚠️ No promise recreator function available for phase:', previousStep.phase);
    }
    
    return true;
}

/**
 * Check if tutorial is currently active
 */
export function isTutorialActive() {
    return tutorialPhase !== null;
}

/**
 * Get the current tutorial phase
 */
export function getTutorialPhase() {
    return tutorialPhase;
}

/**
 * Advance to the next tutorial phase
 */
export async function advanceTutorialPhase() {
    // 🔥 FIX: Store callback FIRST and execute it IMMEDIATELY (synchronously)
    // This ensures the promise resolves right away, advancing to next step
    const callback = tutorialAdvanceCallback;
    tutorialAdvanceCallback = null; // Clear immediately to prevent double-call
    
    // Cancel all pending timeouts for current phase FIRST (before callback)
    // This prevents timeouts from firing after we've already advanced
    tutorialTimeouts.forEach(timeoutId => {
        if (timeoutId) clearTimeout(timeoutId);
    });
    tutorialTimeouts = [];
    
    // Skip current animation (synchronously)
    skipAnimations();
    
    // 🔥 CRITICAL: Execute callback IMMEDIATELY (synchronously) to resolve promise
    // This must happen BEFORE any async operations to ensure immediate advancement
    if (callback) {
        console.log('⚡ Executing tutorial advance callback IMMEDIATELY - resolving promise now');
        try {
            callback(); // This resolves the promise (e.g., skippableWait) - executes synchronously
            console.log('✅ Tutorial advance callback executed successfully');
        } catch (err) {
            console.error('❌ Error executing tutorial advance callback:', err);
        }
    } else {
        console.log('⚠️ No tutorial advance callback set - phase:', tutorialPhase);
    }
    
    // 🔒 SAFETY: Clear ALL tutorial visual states when advancing (async cleanup)
    // Import cleanup function dynamically to avoid circular dependencies
    const { clearAllTutorialVisualStates } = await import('./tutorial-coordinator.js');
    clearAllTutorialVisualStates();
    
    // Clear waveform tutorial overlay and pulse if visible (backup)
    hideTutorialOverlay();
    const waveformCanvas = document.getElementById('waveform');
    if (waveformCanvas) {
        waveformCanvas.classList.remove('pulse');
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
                // 🔒 LOCAL ONLY: Tutorial navigation only available on local servers
                if (!isLocalEnvironment()) {
                    return;
                }
                
                const activeElement = document.activeElement;
                const isInputField = activeElement && (
                    activeElement.tagName === 'INPUT' ||
                    activeElement.tagName === 'TEXTAREA' ||
                    activeElement.isContentEditable
                );

                // Skip if in an input field (don't interfere with typing)
                if (isInputField) {
                    return;
                }
                
                // Right Arrow: Advance to next tutorial step (like Enter used to)
                if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    console.log('⌨️ Right Arrow detected! tutorialPhase:', tutorialPhase);

                    // Advance to next tutorial phase if we're in a tutorial sequence
                    // (advanceTutorialPhase will skip animations, clear overlay and pulse, and execute callback)
                    if (tutorialPhase) {
                        console.log('▶️ Advancing tutorial phase:', tutorialPhase);
                        // 🔥 FIX: Execute synchronously - callback resolves promise immediately
                        // Don't await - we want immediate execution, cleanup happens async
                        advanceTutorialPhase().catch(err => {
                            console.error('❌ Error advancing tutorial phase:', err);
                        });
                    } else {
                        console.log('⚠️ No tutorial phase set - not advancing');
                        // If no phase set, still skip animations
                        skipAnimations();
                    }
                }
                // Left Arrow: Go back to previous tutorial step
                else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    console.log('⌨️ Left Arrow detected! Going back...');
                    
                    goBackTutorialStep().then(success => {
                        if (success) {
                            console.log('✅ Successfully went back to previous step');
                            // The promise will need to be re-awaited - this is a limitation
                            // We can't fully rewind async execution, but we've restored the state
                        } else {
                            console.log('⚠️ Could not go back - no previous step');
                        }
                    }).catch(err => {
                        console.error('❌ Error going back:', err);
                    });
                }
                // Enter/Return: Still works for backward compatibility
                else if (e.key === 'Enter' || e.key === 'Return') {
                    e.preventDefault();
                    console.log('⌨️ Enter key detected! tutorialPhase:', tutorialPhase);

                    // Advance to next tutorial phase if we're in a tutorial sequence
                    if (tutorialPhase) {
                        console.log('▶️ Advancing tutorial phase:', tutorialPhase);
                        advanceTutorialPhase().catch(err => {
                            console.error('❌ Error advancing tutorial phase:', err);
                        });
                    } else {
                        console.log('⚠️ No tutorial phase set - not advancing');
                        skipAnimations();
                    }
                }
            });
            window._tutorialSkipListenerAdded = true;
        }
    }
}

