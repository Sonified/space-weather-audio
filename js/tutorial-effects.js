/**
 * tutorial-effects.js
 * Visual and UI effects for tutorials
 * Reusable effects like overlays, typing animations, glows, and status text
 */

import * as State from './audio-state.js';

// Overlay state
let tutorialOverlay = null;
let tutorialOverlayResizeObserver = null; // 🔥 FIX: Track ResizeObserver for cleanup
let tutorialShownThisSession = false;
let pulseShownThisSession = false;

// Typing animation state
let activeTypingTimeout = null;
let activePulseTimeout = null;
let activeTypingText = null;
let activeTypingElement = null;
let activeTypingBaseText = null;

// Status click handler state
let clickHandlerAttached = false;

/**
 * Create tutorial overlay with custom text
 * @param {string} text - The text to display (default: 'Click me!')
 */
function createTutorialOverlay(text = 'Click me!') {
    if (tutorialOverlay) {
        // Update text if overlay already exists
        tutorialOverlay.textContent = text;
        return;
    }
    
    const waveformCanvas = document.getElementById('waveform');
    if (!waveformCanvas) return;
    
    // Create overlay div
    tutorialOverlay = document.createElement('div');
    tutorialOverlay.id = 'tutorial-overlay';
    tutorialOverlay.className = 'tutorial-click-me';
    tutorialOverlay.textContent = text;
    
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
        // 🔥 FIX: Store ResizeObserver for cleanup to prevent memory leaks
        tutorialOverlayResizeObserver = new ResizeObserver(() => {
            updatePosition();
        });
        tutorialOverlayResizeObserver.observe(waveformCanvas);
        tutorialOverlayResizeObserver.observe(parent);
    }
}

/**
 * Show tutorial overlay after first data fetch
 * Only shows once per session (not after every data fetch)
 * @param {string} text - Optional custom text to display
 * @param {boolean} forceShow - If true, bypass session check and show even if already shown
 */
export function showTutorialOverlay(text = 'Click me!', forceShow = false) {
    // Only show once per session (unless forced)
    if (!forceShow && tutorialShownThisSession) return;
    
    // Only show if user hasn't clicked waveform yet
    if (State.waveformHasBeenClicked) return;
    
    createTutorialOverlay(text);
    
    if (tutorialOverlay) {
        tutorialOverlay.style.display = 'block';
        tutorialOverlay.classList.add('visible');
        if (!forceShow) {
            tutorialShownThisSession = true; // Mark as shown for this session
        }
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
    
    // 🔥 FIX: Disconnect ResizeObserver to prevent memory leaks
    if (tutorialOverlayResizeObserver) {
        tutorialOverlayResizeObserver.disconnect();
        tutorialOverlayResizeObserver = null;
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
    // Use Array.from to properly handle emojis and multi-byte Unicode characters
    const textArray = Array.from(text);
    let index = 0;
    const typeNextChar = () => {
        if (index < textArray.length) {
            element.textContent += textArray[index];
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
 * Add glow effect to spectrogram canvas with fade-in
 */
export function addSpectrogramGlow() {
    const spectrogramCanvas = document.getElementById('spectrogram');
    if (spectrogramCanvas) {
        // Add fading-in class first to start from opacity 0
        spectrogramCanvas.classList.add('fading-in');
        
        // Force reflow to ensure the fade-in class is applied before adding glow
        spectrogramCanvas.offsetHeight;
        
        // Add glow class which will fade in via CSS transition
        spectrogramCanvas.classList.add('spectrogram-glow');
        
        // Remove fade-in class after transition completes
        setTimeout(() => {
            spectrogramCanvas.classList.remove('fading-in');
        }, 500); // Match CSS transition duration
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
 * Add glow effect to regions panel with fade-in
 */
export function addRegionsPanelGlow() {
    const regionsPanel = document.getElementById('trackedRegionsPanel');
    if (regionsPanel) {
        // Add fading-in class first to start from opacity 0
        regionsPanel.classList.add('fading-in');
        
        // Force reflow to ensure the fade-in class is applied before adding glow
        regionsPanel.offsetHeight;
        
        // Add glow class which will fade in via CSS transition
        regionsPanel.classList.add('regions-panel-glow');
        
        // Remove fade-in class after transition completes
        setTimeout(() => {
            regionsPanel.classList.remove('fading-in');
        }, 500); // Match CSS transition duration
    }
}

/**
 * Remove glow effect from regions panel with fade-out
 */
export function removeRegionsPanelGlow() {
    const regionsPanel = document.getElementById('trackedRegionsPanel');
    if (regionsPanel) {
        // Add fading-out class to trigger fade transition
        regionsPanel.classList.add('fading-out');
        
        // Remove glow class after fade completes
        setTimeout(() => {
            regionsPanel.classList.remove('regions-panel-glow', 'fading-out');
        }, 500); // Match CSS transition duration
    }
}

/**
 * Disable all region buttons (both on waveform canvas and in panel)
 */
export function disableRegionButtons() {
    // Disable buttons in the regions panel
    const regionsPanel = document.getElementById('trackedRegionsPanel');
    if (regionsPanel) {
        const zoomButtons = regionsPanel.querySelectorAll('.zoom-btn');
        const playButtons = regionsPanel.querySelectorAll('.play-btn');
        
        zoomButtons.forEach(btn => {
            btn.style.pointerEvents = 'none';
            btn.style.opacity = '0.5';
        });
        playButtons.forEach(btn => {
            btn.style.pointerEvents = 'none';
            btn.style.opacity = '0.5';
        });
    }
    
    // Disable buttons on waveform canvas by setting a flag
    // The waveform buttons renderer will check this flag
    State.setRegionButtonsDisabled(true);
}

/**
 * Enable all region buttons (both on waveform canvas and in panel)
 */
export function enableRegionButtons() {
    // Enable buttons in the regions panel
    const regionsPanel = document.getElementById('trackedRegionsPanel');
    if (regionsPanel) {
        const zoomButtons = regionsPanel.querySelectorAll('.zoom-btn');
        const playButtons = regionsPanel.querySelectorAll('.play-btn');
        
        zoomButtons.forEach(btn => {
            btn.style.pointerEvents = 'auto';
            btn.style.opacity = '1';
        });
        playButtons.forEach(btn => {
            btn.style.pointerEvents = 'auto';
            btn.style.opacity = '1';
        });
    }
    
    // Enable buttons on waveform canvas
    State.setRegionButtonsDisabled(false);
}

/**
 * Enable only a specific region's play button (for tutorial)
 * @param {number} regionIndex - 0-indexed region index
 */
export function enableRegionPlayButton(regionIndex) {
    // Enable play button in the regions panel
    const regionsPanel = document.getElementById('trackedRegionsPanel');
    if (regionsPanel) {
        const regionCards = regionsPanel.querySelectorAll('.region-card');
        if (regionCards[regionIndex]) {
            const playBtn = regionCards[regionIndex].querySelector('.play-btn');
            if (playBtn) {
                playBtn.style.pointerEvents = 'auto';
                playBtn.style.opacity = '1';
            }
        }
    }
    
    // Enable play button on waveform canvas by setting a flag
    // The waveform buttons renderer will check this flag
    State.setRegionPlayButtonEnabled(regionIndex, true);
}

/**
 * Enable a specific region's zoom button (for tutorial)
 * @param {number} regionIndex - 0-indexed region index
 */
export function enableRegionZoomButton(regionIndex) {
    // Enable zoom button in the regions panel
    const regionsPanel = document.getElementById('trackedRegionsPanel');
    if (regionsPanel) {
        const regionCards = regionsPanel.querySelectorAll('.region-card');
        if (regionCards[regionIndex]) {
            const zoomBtn = regionCards[regionIndex].querySelector('.zoom-btn');
            if (zoomBtn) {
                zoomBtn.style.pointerEvents = 'auto';
                zoomBtn.style.opacity = '1';
            }
        }
    }
    
    // Enable zoom button on waveform canvas by setting a flag
    State.setRegionZoomButtonEnabled(regionIndex, true);
}

/**
 * Add glow effect to volume slider with fade-in
 * Only glows the slider bar, not the label text
 */
export function addVolumeSliderGlow() {
    const volumeSlider = document.getElementById('volumeSlider');
    
    if (volumeSlider) {
        // Add fading-in class first to start from opacity 0
        volumeSlider.classList.add('fading-in');
        
        // Force reflow to ensure the fade-in class is applied before adding glow
        volumeSlider.offsetHeight;
        
        // Add glow class which will fade in via CSS transition
        volumeSlider.classList.add('volume-slider-glow');
        
        // Remove fade-in class after transition completes
        setTimeout(() => {
            volumeSlider.classList.remove('fading-in');
        }, 500); // Match CSS transition duration
    }
}

/**
 * Remove glow effect from volume slider with fade-out
 */
export function removeVolumeSliderGlow() {
    const volumeSlider = document.getElementById('volumeSlider');
    
    if (volumeSlider) {
        // Add fading-out class to trigger fade transition
        volumeSlider.classList.add('fading-out');
        
        // Remove glow class after fade completes
        setTimeout(() => {
            volumeSlider.classList.remove('volume-slider-glow', 'fading-out');
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

/**
 * Disable frequency scale dropdown
 */
export function disableFrequencyScaleDropdown() {
    const frequencyScaleSelect = document.getElementById('frequencyScale');
    if (frequencyScaleSelect) {
        frequencyScaleSelect.disabled = true;
        frequencyScaleSelect.setAttribute('disabled', 'disabled');
        frequencyScaleSelect.style.opacity = '0.5';
        frequencyScaleSelect.style.cursor = 'not-allowed';
        frequencyScaleSelect.style.pointerEvents = 'none';
        console.log('🔒 Frequency scale dropdown disabled');
    } else {
        console.warn('⚠️ Could not find frequencyScale element to disable');
    }
}

/**
 * Enable frequency scale dropdown
 */
export function enableFrequencyScaleDropdown() {
    const frequencyScaleSelect = document.getElementById('frequencyScale');
    if (frequencyScaleSelect) {
        frequencyScaleSelect.disabled = false;
        frequencyScaleSelect.removeAttribute('disabled');
        frequencyScaleSelect.style.opacity = '1';
        frequencyScaleSelect.style.cursor = 'pointer';
        frequencyScaleSelect.style.pointerEvents = 'auto';
    }
}

/**
 * Add glow effect to loop button with fade-in
 */
export function addLoopButtonGlow() {
    const loopBtn = document.getElementById('loopBtn');
    if (loopBtn) {
        // Add fading-in class first to start from opacity 0
        loopBtn.classList.add('fading-in');
        
        // Force reflow to ensure the fade-in class is applied before adding glow
        loopBtn.offsetHeight;
        
        // Add glow class which will fade in via CSS transition
        loopBtn.classList.add('loop-button-glow');
        
        // Remove fade-in class after transition completes
        setTimeout(() => {
            loopBtn.classList.remove('fading-in');
        }, 500); // Match CSS transition duration
    }
}

/**
 * Remove glow effect from loop button with fade-out
 */
export function removeLoopButtonGlow() {
    const loopBtn = document.getElementById('loopBtn');
    if (loopBtn) {
        // Add fading-out class to trigger fade transition
        loopBtn.classList.add('fading-out');
        
        // Remove glow class after fade completes
        setTimeout(() => {
            loopBtn.classList.remove('loop-button-glow', 'fading-out');
        }, 500); // Match CSS transition duration
    }
}

/**
 * Add glow effect to frequency scale dropdown with fade-in
 */
export function addFrequencyScaleGlow() {
    const frequencyScaleSelect = document.getElementById('frequencyScale');
    if (frequencyScaleSelect) {
        // Add fading-in class first to start from opacity 0
        frequencyScaleSelect.classList.add('fading-in');
        
        // Force reflow to ensure the fade-in class is applied before adding glow
        frequencyScaleSelect.offsetHeight;
        
        // Add glow class which will fade in via CSS transition
        frequencyScaleSelect.classList.add('frequency-scale-glow');
        
        // Remove fade-in class after transition completes
        setTimeout(() => {
            frequencyScaleSelect.classList.remove('fading-in');
        }, 500); // Match CSS transition duration
    }
}

/**
 * Remove glow effect from frequency scale dropdown with fade-out
 */
export function removeFrequencyScaleGlow() {
    const frequencyScaleSelect = document.getElementById('frequencyScale');
    if (frequencyScaleSelect) {
        // Add fading-out class to trigger fade transition
        frequencyScaleSelect.classList.add('fading-out');
        
        // Remove glow class after fade completes
        setTimeout(() => {
            frequencyScaleSelect.classList.remove('frequency-scale-glow', 'fading-out');
        }, 500); // Match CSS transition duration
    }
}

