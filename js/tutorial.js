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
            pulsePeriod(element, textWithoutPeriod, 5);
        } else {
            activeTypingTimeout = null; // Clear when done
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
            const baseAppended = textToAppend.slice(0, -1);
            pulsePeriod(statusEl, currentText + ' ' + baseAppended, 5);
        } else {
            activeTypingTimeout = null; // Clear when done
        }
    };
    
    // Start typing the appended text
    typeNextChar();
}

/**
 * Initialize tutorial system
 */
export function initTutorial() {
    // Tutorial overlay will be shown after first data fetch
    // and hidden when user clicks the waveform
}

