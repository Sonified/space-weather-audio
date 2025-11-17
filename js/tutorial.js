/**
 * tutorial.js
 * Tutorial overlay and guidance system
 * Shows helpful hints to guide users through the interface
 */

import * as State from './audio-state.js';

let tutorialOverlay = null;
let tutorialShownThisSession = false; // Track if tutorial has been shown in this session
let pulseShownThisSession = false; // Track if pulse animation has been shown in this session
let activeTypingTimeout = null; // Track active typing animation timeout
let activePulseTimeout = null; // Track active pulse animation timeout
let activeTypingText = null; // Track full text being typed (for skip functionality)
let activeTypingElement = null; // Track element being typed to (for skip functionality)
let activeTypingBaseText = null; // Track base text for pulse period (for skip functionality)

/**
 * Create tutorial overlay with "Click me!" text
 */
function createTutorialOverlay() {
    if (tutorialOverlay) return; // Already exists
    
    const waveformCanvas = document.getElementById('waveform');
    if (!waveformCanvas) return;
    
    // Create overlay div
    tutorialOverlay = document.createElement('div');
    tutorialOverlay.id = 'tutorial-overlay';
    tutorialOverlay.className = 'tutorial-click-me';
    tutorialOverlay.textContent = 'Click me!';
    
    // Position overlay centered on waveform canvas
    const parent = waveformCanvas.parentElement;
    if (parent) {
        // Position overlay absolutely relative to parent (which has position: relative)
        tutorialOverlay.style.position = 'absolute';
        tutorialOverlay.style.pointerEvents = 'none';
        tutorialOverlay.style.zIndex = '20';
        
        // Function to update position
        const updatePosition = () => {
            if (!tutorialOverlay || !waveformCanvas) return;
            const canvasRect = waveformCanvas.getBoundingClientRect();
            const parentRect = parent.getBoundingClientRect();
            const centerX = canvasRect.left - parentRect.left + canvasRect.width / 2;
            const centerY = canvasRect.top - parentRect.top + canvasRect.height / 2;
            tutorialOverlay.style.left = centerX + 'px';
            tutorialOverlay.style.top = centerY + 'px';
            tutorialOverlay.style.transform = 'translate(-50%, -50%)';
        };
        
        parent.appendChild(tutorialOverlay);
        
        // Initial positioning
        updatePosition();
        
        // Update overlay position when canvas resizes
        const resizeObserver = new ResizeObserver(() => {
            updatePosition();
        });
        resizeObserver.observe(waveformCanvas);
        resizeObserver.observe(parent);
    }
}

/**
 * Show tutorial overlay after first data fetch
 * Only shows once per session (not after every data fetch)
 */
export function showTutorialOverlay() {
    // Only show once per session
    if (tutorialShownThisSession) return;
    
    // Only show if user hasn't clicked waveform yet
    if (State.waveformHasBeenClicked) return;
    
    createTutorialOverlay();
    
    if (tutorialOverlay) {
        tutorialOverlay.style.display = 'block';
        tutorialOverlay.classList.add('visible');
        tutorialShownThisSession = true; // Mark as shown for this session
    }
}

/**
 * Hide tutorial overlay
 */
export function hideTutorialOverlay() {
    if (tutorialOverlay) {
        tutorialOverlay.style.display = 'none';
        tutorialOverlay.classList.remove('visible');
    }
    // Note: Don't reset tutorialShownThisSession here - once shown, it stays shown for the session
}

/**
 * Check if pulse animation should be shown
 * Only returns true once per session
 */
export function shouldShowPulse() {
    // Only show once per session
    if (pulseShownThisSession) return false;
    
    // Only show if user hasn't clicked waveform yet
    if (State.waveformHasBeenClicked) return false;
    
    return true;
}

/**
 * Mark pulse as shown for this session
 */
export function markPulseShown() {
    pulseShownThisSession = true;
}

/**
 * Type out text with human-like jitter and delay
 * Creates a typing animation effect from left to right
 * After completion, pulses the period at the end 5 times
 * @param {HTMLElement} element - The element to update
 * @param {string} text - The text to type out (should end with a period)
 * @param {number} baseDelay - Base delay between characters in ms (default: 30)
 * @param {number} jitterRange - Random jitter range in ms (default: 15)
 */
export function typeText(element, text, baseDelay = 30, jitterRange = 15) {
    if (!element) return;
    
    // Clear any previous animations
    if (activeTypingTimeout) {
        clearTimeout(activeTypingTimeout);
        activeTypingTimeout = null;
    }
    if (activePulseTimeout) {
        clearTimeout(activePulseTimeout);
        activePulseTimeout = null;
    }
    
    // Clear existing text
    element.textContent = '';
    
    // Check if text ends with a period
    const hasPeriod = text.endsWith('.');
    const textWithoutPeriod = hasPeriod ? text.slice(0, -1) : text;
    
    // Track for skip functionality
    activeTypingText = text;
    activeTypingElement = element;
    activeTypingBaseText = textWithoutPeriod;
    
    // Type out each character with jitter
    let index = 0;
    const typeNextChar = () => {
        if (index < text.length) {
            element.textContent += text[index];
            index++;
            
            // Calculate delay with jitter (baseDelay ± random jitter)
            const jitter = (Math.random() - 0.5) * 2 * jitterRange; // -jitterRange to +jitterRange
            const delay = Math.max(10, baseDelay + jitter); // Minimum 10ms delay
            
            activeTypingTimeout = setTimeout(typeNextChar, delay);
        } else if (hasPeriod) {
            // Typing complete - start pulsing the period at the end
            activeTypingTimeout = null; // Clear when done
            activeTypingText = null; // Clear tracking
            pulsePeriod(element, textWithoutPeriod, 5);
        } else {
            activeTypingTimeout = null; // Clear when done
            activeTypingText = null; // Clear tracking
            activeTypingElement = null;
            activeTypingBaseText = null;
        }
    };
    
    // Start typing
    typeNextChar();
}

/**
 * Cancel any active typing animation and pulse animation
 */
export function cancelTyping() {
    if (activeTypingTimeout) {
        clearTimeout(activeTypingTimeout);
        activeTypingTimeout = null;
    }
    if (activePulseTimeout) {
        clearTimeout(activePulseTimeout);
        activePulseTimeout = null;
    }
    // Clear tracking variables
    activeTypingText = null;
    activeTypingElement = null;
    activeTypingBaseText = null;
}

/**
 * Skip to end of any active typing or pulse animation
 * Immediately shows the final text state
 */
export function skipAnimations() {
    // Cancel any active timeouts
    cancelTyping();
    
    // If we have an element and text to display, show it immediately
    if (activeTypingElement) {
        if (activeTypingText) {
            // Show full text immediately
            activeTypingElement.textContent = activeTypingText;
        } else if (activeTypingBaseText) {
            // Show base text with period (final pulse state)
            activeTypingElement.textContent = activeTypingBaseText + '.';
        }
        
        // Clear tracking
        activeTypingText = null;
        activeTypingElement = null;
        activeTypingBaseText = null;
    }
}

/**
 * Pulse the period at the end of text 5 times (make and destroy)
 * @param {HTMLElement} element - The element containing the text
 * @param {string} baseText - The base text without the period
 * @param {number} pulseCount - Number of times to pulse (default: 5)
 */
function pulsePeriod(element, baseText, pulseCount = 5) {
    let currentPulse = 0;
    let showingPeriod = false;
    
    // Track for skip functionality
    activeTypingElement = element;
    activeTypingBaseText = baseText;
    
    const pulse = () => {
        if (currentPulse < pulseCount) {
            showingPeriod = !showingPeriod;
            element.textContent = baseText + (showingPeriod ? '.' : '');
            currentPulse++;
            activePulseTimeout = setTimeout(pulse, 300); // Track this!
        } else {
            // Final state - period stays visible
            element.textContent = baseText + '.';
            activePulseTimeout = null; // Clear when done
            activeTypingElement = null; // Clear tracking
            activeTypingBaseText = null;
        }
    };
    
    // Start pulsing after a short delay
    activePulseTimeout = setTimeout(pulse, 200); // Track initial delay too!
}

// Track if click handler has been attached
let clickHandlerAttached = false;

/**
 * Attach click handler to status element to copy text to clipboard
 */
function attachStatusClickHandler() {
    if (clickHandlerAttached) return;
    
    const statusEl = document.getElementById('status');
    if (statusEl) {
        statusEl.style.cursor = 'pointer';
        statusEl.title = 'Click to copy status message';
        statusEl.addEventListener('click', async () => {
            const textToCopy = statusEl.textContent.trim();
            if (textToCopy && textToCopy !== '✓ Copied!') {
                try {
                    await navigator.clipboard.writeText(textToCopy);
                    // Visual feedback - briefly change text
                    const originalText = textToCopy;
                    statusEl.textContent = '✓ Copied!';
                    setTimeout(() => {
                        statusEl.textContent = originalText;
                    }, 1000);
                } catch (err) {
                    console.error('Failed to copy:', err);
                }
            }
        });
        clickHandlerAttached = true;
    }
}

/**
 * Helper function to update status text with typing animation
 * Use this instead of directly setting textContent
 * @param {string} text - The text to display
 * @param {string} className - Optional CSS class (default: 'status info')
 */
export function setStatusText(text, className = 'status info') {
    const statusEl = document.getElementById('status');
    if (statusEl) {
        statusEl.className = className;
        
        // Ensure click handler is attached
        attachStatusClickHandler();
        
        // Handle empty strings - just clear without animation
        if (!text || text.trim() === '') {
            statusEl.textContent = '';
            return;
        }
        
        // Type out the text (including period if present - it will pulse at the end)
        typeText(statusEl, text, 20, 10);
    }
}

/**
 * Append text to existing status message with typing animation
 * @param {string} textToAppend - The text to append (will be typed out)
 * @param {number} baseDelay - Base delay between characters in ms (default: 20)
 * @param {number} jitterRange - Random jitter range in ms (default: 10)
 */
export function appendStatusText(textToAppend, baseDelay = 20, jitterRange = 10) {
    const statusEl = document.getElementById('status');
    if (!statusEl || !textToAppend) return;
    
    // Clear any previous animations
    if (activeTypingTimeout) {
        clearTimeout(activeTypingTimeout);
        activeTypingTimeout = null;
    }
    if (activePulseTimeout) {
        clearTimeout(activePulseTimeout);
        activePulseTimeout = null;
    }
    
    const currentText = statusEl.textContent.trim();
    const fullText = currentText + ' ' + textToAppend;
    
    // Track for skip functionality
    activeTypingElement = statusEl;
    activeTypingText = fullText;
    if (textToAppend.endsWith('.')) {
        activeTypingBaseText = currentText + ' ' + textToAppend.slice(0, -1);
    } else {
        activeTypingBaseText = null;
    }
    
    // Type out just the appended part
    let index = 0;
    const typeNextChar = () => {
        if (index < textToAppend.length) {
            statusEl.textContent = currentText + ' ' + textToAppend.substring(0, index + 1);
            index++;
            
            // Calculate delay with jitter
            const jitter = (Math.random() - 0.5) * 2 * jitterRange;
            const delay = Math.max(10, baseDelay + jitter);
            
            activeTypingTimeout = setTimeout(typeNextChar, delay);
        } else if (textToAppend.endsWith('.')) {
            // If appended text ends with period, pulse it
            activeTypingTimeout = null; // Clear when done
            activeTypingText = null; // Clear tracking (pulsePeriod will set it)
            const baseAppended = textToAppend.slice(0, -1);
            pulsePeriod(statusEl, currentText + ' ' + baseAppended, 5);
        } else {
            activeTypingTimeout = null; // Clear when done
            activeTypingText = null; // Clear tracking
            activeTypingElement = null;
            activeTypingBaseText = null;
        }
    };
    
    // Start typing the appended text
    typeNextChar();
}

/**
 * Add glow effect to spectrogram canvas
 */
export function addSpectrogramGlow() {
    const spectrogramCanvas = document.getElementById('spectrogram');
    if (spectrogramCanvas) {
        spectrogramCanvas.classList.add('spectrogram-glow');
    }
}

/**
 * Remove glow effect from spectrogram canvas with fade-out
 */
export function removeSpectrogramGlow() {
    const spectrogramCanvas = document.getElementById('spectrogram');
    if (spectrogramCanvas) {
        // Add fading-out class to trigger fade transition
        spectrogramCanvas.classList.add('fading-out');
        
        // Remove glow class after fade completes
        setTimeout(() => {
            spectrogramCanvas.classList.remove('spectrogram-glow', 'fading-out');
        }, 500); // Match CSS transition duration
    }
}

/**
 * Disable waveform canvas clicks
 */
export function disableWaveformClicks() {
    const waveformCanvas = document.getElementById('waveform');
    if (waveformCanvas) {
        waveformCanvas.style.pointerEvents = 'none';
        waveformCanvas.style.opacity = '0.6';
    }
}

/**
 * Enable waveform canvas clicks
 */
export function enableWaveformClicks() {
    const waveformCanvas = document.getElementById('waveform');
    if (waveformCanvas) {
        waveformCanvas.style.pointerEvents = 'auto';
        waveformCanvas.style.opacity = '1';
    }
}

// Speed slider tutorial state
let speedSliderTutorialActive = false;
let speedSliderInitialValue = 667; // 1.0x speed
let speedSliderLastValue = 667;
let speedSliderDirection = null; // 'faster' or 'slower'
let speedSliderCrossedThreshold = false;
let speedSliderTutorialTimeout = null;

/**
 * Start speed slider tutorial
 */
export function startSpeedSliderTutorial() {
    const speedSlider = document.getElementById('playbackSpeed');
    if (!speedSlider) return;
    
    speedSliderTutorialActive = true;
    speedSliderInitialValue = parseFloat(speedSlider.value);
    speedSliderLastValue = speedSliderInitialValue;
    speedSliderDirection = null;
    speedSliderCrossedThreshold = false;
    
    // Add glow to slider knob
    speedSlider.classList.add('speed-slider-glow');
    
    // Show tutorial message with down-pointing finger
    setStatusText('👇 Click the playback speed slider and drag left/right to change playback speed.', 'status info');
    
    // Track if user has interacted with slider yet
    let hasInteracted = false;
    
    // Add event listener to track slider changes
    const handleSliderChange = () => {
        if (!speedSliderTutorialActive) return;
        
        const currentValue = parseFloat(speedSlider.value);
        
        // Mark that user has interacted
        if (!hasInteracted && Math.abs(currentValue - speedSliderLastValue) > 1) {
            hasInteracted = true;
            
            // Wait 1 second after user clicks/starts dragging
            setTimeout(() => {
                if (!speedSliderTutorialActive) return;
                
                // Determine direction on first movement
                if (speedSliderDirection === null) {
                    if (currentValue > speedSliderLastValue) {
                        speedSliderDirection = 'faster';
                    } else if (currentValue < speedSliderLastValue) {
                        speedSliderDirection = 'slower';
                    }
                    
                    // Show direction-specific message
                    if (speedSliderDirection === 'faster') {
                        setStatusText('Notice how the frequencies stretch up as playback gets faster!', 'status info');
                    } else if (speedSliderDirection === 'slower') {
                        setStatusText('Notice how the frequencies compress down as playback gets slower!', 'status info');
                    }
                    
                    // After short pause, ask to go the other way
                    setTimeout(() => {
                        if (speedSliderTutorialActive) {
                            setStatusText('Now try going the other way.', 'status info');
                        }
                    }, 2000);
                }
            }, 1000);
        }
        
        // Check if crossed threshold of 1.0x (slider value 667)
        // We need to track if we've crossed from one side to the other
        const wasBelow = speedSliderLastValue < 667;
        const wasAbove = speedSliderLastValue > 667;
        const isBelow = currentValue < 667;
        const isAbove = currentValue > 667;
        
        // Crossed threshold if we went from below to above or above to below
        if ((wasBelow && isAbove) || (wasAbove && isBelow)) {
            // Crossed threshold!
            if (!speedSliderCrossedThreshold) {
                speedSliderCrossedThreshold = true;
                
                // Clear any pending encouragement timeout
                if (speedSliderTutorialTimeout) {
                    clearTimeout(speedSliderTutorialTimeout);
                    speedSliderTutorialTimeout = null;
                }
                
                setTimeout(() => {
                    if (speedSliderTutorialActive) {
                        setStatusText('Great!', 'status success');
                        // End tutorial after "Great!"
                        setTimeout(() => {
                            endSpeedSliderTutorial();
                        }, 2000);
                    }
                }, 1000);
            }
        }
        
        speedSliderLastValue = currentValue;
    };
    
    // Track both input (dragging) and change (released) events
    speedSlider.addEventListener('input', handleSliderChange);
    speedSlider.addEventListener('change', handleSliderChange);
    
    // Store handler for cleanup
    speedSlider._tutorialHandler = handleSliderChange;
    
    // If user doesn't cross threshold after 5 seconds, add encouragement
    speedSliderTutorialTimeout = setTimeout(() => {
        if (speedSliderTutorialActive && !speedSliderCrossedThreshold) {
            appendStatusText('Come on... you know you want to explore...', 20, 10);
        }
    }, 5000);
}

/**
 * End speed slider tutorial
 */
export function endSpeedSliderTutorial() {
    speedSliderTutorialActive = false;
    
    const speedSlider = document.getElementById('playbackSpeed');
    if (speedSlider) {
        speedSlider.classList.remove('speed-slider-glow');
        
        // Remove event listener
        if (speedSlider._tutorialHandler) {
            speedSlider.removeEventListener('input', speedSlider._tutorialHandler);
            speedSlider.removeEventListener('change', speedSlider._tutorialHandler);
            speedSlider._tutorialHandler = null;
        }
    }
    
    if (speedSliderTutorialTimeout) {
        clearTimeout(speedSliderTutorialTimeout);
        speedSliderTutorialTimeout = null;
    }
    
    // Trigger callback to continue with waveform tutorial
    if (window._onSpeedSliderTutorialComplete) {
        window._onSpeedSliderTutorialComplete();
        window._onSpeedSliderTutorialComplete = null;
    }
}

/**
 * Helper to get speed from slider value (same logic as audio-player.js)
 */
function getSpeedFromSliderValue(value) {
    let baseSpeed;
    if (value <= 667) {
        const normalized = value / 667;
        baseSpeed = 0.1 * Math.pow(10, normalized);
    } else {
        const normalized = (value - 667) / 333;
        baseSpeed = Math.pow(15, normalized);
    }
    return baseSpeed;
}

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

