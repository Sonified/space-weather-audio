// resize-handler.js -- Window resize handler and canvas layout

import * as State from './audio-state.js';
import { setResizeRAFRef } from './audio-player.js';
import { resizeRendererToDisplaySize } from './main-window-renderer.js';
import { positionAxisCanvas, drawFrequencyAxis, initializeAxisPlaybackRate } from './spectrogram-axis-renderer.js';
import { positionWaveformAxisCanvas, drawWaveformAxis } from './waveform-axis-renderer.js';
import { positionWaveformXAxisCanvas, resizeWaveformXAxisCanvas, drawWaveformXAxis, positionWaveformDateCanvas, resizeWaveformDateCanvas, drawWaveformDate, initializeMaxCanvasWidth } from './waveform-x-axis-renderer.js';
import { positionWaveformButtonsCanvas, resizeWaveformButtonsCanvas, drawRegionButtons } from './waveform-buttons-renderer.js';
import { drawSpectrogramXAxis, positionSpectrogramXAxisCanvas, resizeSpectrogramXAxisCanvas } from './spectrogram-x-axis-renderer.js';
import { updateAllFeatureBoxPositions } from './spectrogram-feature-boxes.js';
import { drawWaveformFromMinMax, drawWaveformWithSelection } from './minimap-window-renderer.js';
import { drawDayMarkers } from './day-markers.js';

/**
 * Sets up the window resize event listener and initial axis positioning.
 * Handles repositioning and redrawing of all canvas overlays (axes, buttons, etc.)
 * when the browser window is resized or orientation changes on mobile.
 */
export function setupResizeHandler() {
    // Handle window resize to reposition axis canvases - optimized for performance
    let resizeRAF = null;
    let waveformXAxisResizeTimer = null; // Timer for debouncing x-axis redraw on horizontal resize
    let waveformResizeTimer = null; // Timer for debouncing waveform redraw on resize
    let lastWaveformXAxisWidth = null; // Track waveform canvas width for x-axis horizontal resize detection
    let lastSpectrogramWidth = 0;
    let lastSpectrogramHeight = 0;
    let lastWaveformWidth = 0;
    let lastWaveformHeight = 0;

    // Initialize dimensions on page load
    setTimeout(() => {
        const spectrogramCanvas = document.getElementById('spectrogram');
        const waveformCanvas = document.getElementById('waveform');
        if (spectrogramCanvas) {
            lastSpectrogramWidth = spectrogramCanvas.width;
            lastSpectrogramHeight = spectrogramCanvas.height;
        }
        if (waveformCanvas) {
            lastWaveformWidth = waveformCanvas.offsetWidth;
            lastWaveformXAxisWidth = waveformCanvas.offsetWidth; // Update x-axis width tracker
            lastWaveformHeight = waveformCanvas.offsetHeight;
        }
    }, 0);

    // Handle orientation change on mobile - trigger resize logic
    window.addEventListener('orientationchange', () => {
        // Small delay to let the browser finish orientation change
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 100);
    });

    window.addEventListener('resize', () => {
        if (resizeRAF) return; // Already scheduled

        resizeRAF = requestAnimationFrame(() => {
            // 🔥 FIX: Check document connection before DOM manipulation
            if (!document.body || !document.body.isConnected) {
                resizeRAF = null;
                return;
            }

            // 🔥 FIX: Store resizeRAF reference for cleanup
            setResizeRAFRef(resizeRAF);

            const spectrogramCanvas = document.getElementById('spectrogram');
            const spectrogramAxisCanvas = document.getElementById('spectrogram-axis');
            const waveformCanvas = document.getElementById('waveform');
            const waveformAxisCanvas = document.getElementById('waveform-axis');

            // Sync spectrogram canvas buffer to CSS display size (responsive vh height)
            if (spectrogramCanvas) {
                resizeRendererToDisplaySize();
            }

            // Handle spectrogram axis
            if (spectrogramCanvas && spectrogramAxisCanvas) {
                // Always reposition during resize (fast - no redraw)
                positionAxisCanvas();

                // Only redraw if canvas dimensions actually changed (expensive operation)
                const currentWidth = spectrogramCanvas.width;
                const currentHeight = spectrogramCanvas.height;

                if (currentWidth !== lastSpectrogramWidth || currentHeight !== lastSpectrogramHeight) {
                    spectrogramAxisCanvas.width = 60; // Always 60px width
                    spectrogramAxisCanvas.height = currentHeight;
                    drawFrequencyAxis();
                    lastSpectrogramWidth = currentWidth;
                    lastSpectrogramHeight = currentHeight;
                }
            }

            // Handle waveform axis
            if (waveformCanvas && waveformAxisCanvas) {
                // Always reposition during resize (fast - no redraw)
                positionWaveformAxisCanvas();

                // Only redraw if canvas dimensions actually changed (expensive operation)
                // Use display dimensions (offsetHeight) not internal canvas dimensions
                const currentWidth = waveformCanvas.offsetWidth;
                const currentHeight = waveformCanvas.offsetHeight;

                if (currentWidth !== lastWaveformWidth || currentHeight !== lastWaveformHeight) {
                    waveformAxisCanvas.width = 60; // Always 60px width
                    waveformAxisCanvas.height = currentHeight; // Use display height
                    drawWaveformAxis();
                    lastWaveformWidth = currentWidth;
                    lastWaveformHeight = currentHeight;
                }
            }

            // Handle waveform x-axis
            const waveformXAxisCanvas = document.getElementById('waveform-x-axis');
            if (waveformCanvas && waveformXAxisCanvas) {
                // Always reposition during resize (fast - no redraw)
                positionWaveformXAxisCanvas();
                positionSpectrogramXAxisCanvas();

                // Check if canvas width changed (horizontal resize)
                const currentWidth = waveformCanvas.offsetWidth;
                if (currentWidth !== lastWaveformXAxisWidth) {
                    // Clear any existing timer
                    if (waveformXAxisResizeTimer !== null) {
                        clearTimeout(waveformXAxisResizeTimer);
                        waveformXAxisResizeTimer = null;
                    }

                    // Set new timer to wait 100ms after last resize event
                    waveformXAxisResizeTimer = setTimeout(() => {
                        // 🔥 FIX: Check document connection before DOM manipulation
                        if (!document.body || !document.body.isConnected) {
                            waveformXAxisResizeTimer = null;
                            return;
                        }

                        // Resize and redraw x-axis ticks after resize is complete
                        resizeWaveformXAxisCanvas();
                        resizeSpectrogramXAxisCanvas();
                        waveformXAxisResizeTimer = null;
                    }, 100);

                    lastWaveformXAxisWidth = currentWidth;
                }
            }

            // Handle waveform date panel
            const waveformDateCanvas = document.getElementById('waveform-date');
            if (waveformCanvas && waveformDateCanvas) {
                // Always reposition during resize
                positionWaveformDateCanvas();

                // Redraw if canvas dimensions changed
                const currentWidth = waveformCanvas.offsetWidth;
                if (currentWidth !== lastWaveformWidth) {
                    resizeWaveformDateCanvas();
                }
            }

            // Handle buttons canvas resize
            resizeWaveformButtonsCanvas();

            // Handle waveform canvas resize - trigger redraw to update button positions
            if (waveformCanvas) {
                const currentWidth = waveformCanvas.offsetWidth;
                const currentHeight = waveformCanvas.offsetHeight;

                // Check if canvas dimensions changed
                if (currentWidth !== lastWaveformWidth || currentHeight !== lastWaveformHeight) {
                    // Update canvas internal dimensions (device pixels)
                    const dpr = window.devicePixelRatio || 1;
                    waveformCanvas.width = currentWidth * dpr;
                    waveformCanvas.height = currentHeight * dpr;

                    // 🔥 CRITICAL: Clear cache immediately to prevent stretching!
                    // During the debounce period, any RAF or draw call would use the OLD cached canvas
                    // (at old size) drawn onto the NEW canvas (at new size) = STRETCHED WAVEFORM!
                    State.setCachedWaveformCanvas(null);

                    // Then regenerate with debounce
                    if (waveformResizeTimer !== null) {
                        clearTimeout(waveformResizeTimer);
                    }
                    waveformResizeTimer = setTimeout(() => {
                        // 🔥 FIX: Check document connection before DOM manipulation
                        if (!document.body || !document.body.isConnected) {
                            waveformResizeTimer = null;
                            return;
                        }

                        // Re-render waveform at correct size
                        if (State.getCompleteSamplesLength() > 0) {
                            drawWaveformFromMinMax();
                            drawWaveformWithSelection();
                        }

                        waveformResizeTimer = null;
                    }, 100);

                    lastWaveformWidth = currentWidth;
                    lastWaveformHeight = currentHeight;
                }
            }

            // Update feature box positions after resize (boxes need to reposition for new canvas dimensions)
            updateAllFeatureBoxPositions();

            // Redraw day markers (overlay canvas buffer gets cleared on resize)
            drawDayMarkers();

            resizeRAF = null;
        });
    });

    // Initial axis positioning and drawing on page load
    // Use setTimeout to ensure DOM is fully ready
    setTimeout(() => {
        positionAxisCanvas();
        initializeAxisPlaybackRate();
        positionWaveformAxisCanvas();
        drawWaveformAxis();
        // Initialize maxCanvasWidth baseline (1200px) for tick spacing logic
        initializeMaxCanvasWidth();
        positionWaveformXAxisCanvas();
        drawWaveformXAxis();
        positionSpectrogramXAxisCanvas();
        drawSpectrogramXAxis();
        drawDayMarkers();
        positionWaveformDateCanvas();
        drawWaveformDate();
        positionWaveformButtonsCanvas();
        drawRegionButtons();
        // Update dimensions after initial draw
        const spectrogramCanvas = document.getElementById('spectrogram');
        const waveformCanvas = document.getElementById('waveform');
        if (spectrogramCanvas) {
            lastSpectrogramWidth = spectrogramCanvas.width;
            lastSpectrogramHeight = spectrogramCanvas.height;
        }
        if (waveformCanvas) {
            lastWaveformWidth = waveformCanvas.offsetWidth;
            lastWaveformXAxisWidth = waveformCanvas.offsetWidth; // Update x-axis width tracker
            lastWaveformHeight = waveformCanvas.offsetHeight;
        }
    }, 100);
}
