/**
 * tutorial.js
 * Tutorial overlay and guidance system
 * Shows helpful hints to guide users through the interface
 */

import * as State from './audio-state.js';

let tutorialOverlay = null;

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
 */
export function showTutorialOverlay() {
    // Only show if user hasn't clicked waveform yet
    if (State.waveformHasBeenClicked) return;
    
    createTutorialOverlay();
    
    if (tutorialOverlay) {
        tutorialOverlay.style.display = 'block';
        tutorialOverlay.classList.add('visible');
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
}

/**
 * Initialize tutorial system
 */
export function initTutorial() {
    // Tutorial overlay will be shown after first data fetch
    // and hidden when user clicks the waveform
}

