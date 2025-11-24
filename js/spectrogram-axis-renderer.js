/**
 * spectrogram-axis-renderer.js
 * Y-axis rendering for spectrogram showing frequencies scaled by playback speed
 */

import * as State from './audio-state.js';

// Track previous playback rate for slight smoothing
let previousPlaybackRate = 1.0;
const SMOOTHING_FACTOR = 0.15; // Light smoothing (0 = no smoothing, 1 = full smoothing)

// Scale transition animation state
let scaleTransitionInProgress = false;
let scaleTransitionStartTime = null;
let scaleTransitionDuration = 400; // 400ms - balanced transition speed
let oldScaleType = null;
let scaleTransitionRAF = null;

/**
 * Get scale transition state for external use (e.g., feature boxes)
 * @returns {Object} { inProgress, interpolationFactor, oldScaleType }
 */
export function getScaleTransitionState() {
    if (!scaleTransitionInProgress || oldScaleType === null) {
        return { inProgress: false, interpolationFactor: 1.0, oldScaleType: null };
    }

    const elapsed = performance.now() - scaleTransitionStartTime;
    const progress = Math.min(elapsed / scaleTransitionDuration, 1.0);
    const interpolationFactor = 1 - Math.pow(1 - progress, 3); // Ease-out cubic

    return { inProgress: true, interpolationFactor, oldScaleType };
}

/**
 * Cancel scale transition RAF to prevent detached document leaks
 * Called during cleanup to ensure RAF callbacks are cancelled
 */
export function cancelScaleTransitionRAF() {
    if (scaleTransitionRAF !== null) {
        cancelAnimationFrame(scaleTransitionRAF);
        scaleTransitionRAF = null;
        scaleTransitionInProgress = false;
    }
}

/**
 * Draw frequency axis showing frequencies scaled by playback speed
 * 
 * When playback speed slows down, frequencies get lower:
 * - Original Nyquist = 50 Hz
 * - At 0.5x speed: Effective Nyquist = 25 Hz (half)
 * - At 2x speed: Effective Nyquist = 100 Hz (double)
 */
export function drawFrequencyAxis() {
    const canvas = document.getElementById('spectrogram-axis');
    if (!canvas) return;
    
    // CRITICAL: Set width to 60px to match display width - ticks must stay OUTSIDE spectrogram
    canvas.width = 60;
    
    // Ensure canvas height is synced with spectrogram before drawing
    const spectrogramCanvas = document.getElementById('spectrogram');
    if (spectrogramCanvas && canvas.height !== spectrogramCanvas.height) {
        canvas.height = spectrogramCanvas.height;
    }
    
    const ctx = canvas.getContext('2d');
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;
    
    // Get original spacecraft data frequency range
    // This is the ORIGINAL data frequency (before audification), not the audio frequency
    const originalNyquist = State.originalDataFrequencyRange?.max || 50; // Default to 50 Hz if not set
    
    // 🎯 LOG: Show what we're using for Y-axis max
    if (!window._yAxisMaxLogged) {
        console.log(`📊 ⭐ Y-AXIS MAX FREQUENCY: ${originalNyquist.toFixed(2)} Hz (Nyquist frequency)`);
        window._yAxisMaxLogged = true; // Only log once to avoid spam
    }
    
    // Get playback speed and apply slight smoothing
    const currentPlaybackRate = State.currentPlaybackRate || 1.0;
    const smoothedRate = previousPlaybackRate + (currentPlaybackRate - previousPlaybackRate) * (1 - SMOOTHING_FACTOR);
    previousPlaybackRate = smoothedRate;
    
    // Effective Nyquist scales with playback speed
    // Slower playback (0.5x) = lower frequencies = smaller max (e.g., 25 Hz instead of 50 Hz)
    const effectiveNyquist = originalNyquist * smoothedRate;
    
    // Clear canvas (transparent background)
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    
    // Get CSS variables for styling
    const rootStyles = getComputedStyle(document.documentElement);
    const fontSize = rootStyles.getPropertyValue('--axis-label-font-size').trim() || '16px';
    const labelColor = rootStyles.getPropertyValue('--axis-label-color').trim() || '#ddd';
    const tickColor = rootStyles.getPropertyValue('--axis-tick-color').trim() || '#888';
    
    // Setup text styling - disable shadows/outlines
    ctx.font = `${fontSize} Arial, sans-serif`;
    ctx.fillStyle = labelColor;
    ctx.strokeStyle = tickColor;
    ctx.lineWidth = 1;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    // Disable any shadow effects
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    
    // Get current frequency scale (or interpolate during transition)
    let scaleType = State.frequencyScale;
    let interpolationFactor = 1.0;
    
    if (scaleTransitionInProgress && oldScaleType !== null) {
        const elapsed = performance.now() - scaleTransitionStartTime;
        const progress = Math.min(elapsed / scaleTransitionDuration, 1.0);
        
        // Ease-out cubic for smooth deceleration
        interpolationFactor = 1 - Math.pow(1 - progress, 3);
        
        // During transition, we'll interpolate between old and new scale positions
        // scaleType stays as new scale, but we'll blend Y positions
    }
    
    // Generate tick frequencies based on ORIGINAL Nyquist (keep labels consistent)
    // But scale their positions based on effective Nyquist
    let tickFrequencies = [];
    
    if (scaleType === 'logarithmic') {
        tickFrequencies = generateLogTicks(originalNyquist);
    } else if (scaleType === 'sqrt') {
        tickFrequencies = generateSqrtTicks(originalNyquist, smoothedRate);
    } else {
        tickFrequencies = generateLinearTicks(originalNyquist, smoothedRate);
    }
    
    // For all scales, add 50 Hz when speed drops below 0.95x
    if (smoothedRate < 0.95 && !tickFrequencies.includes(50) && 50 <= originalNyquist) {
        tickFrequencies.push(50);
        tickFrequencies.sort((a, b) => a - b);
    }
    
    // Calculate bottom threshold: bottom 6% of canvas height
    const bottomThreshold = canvasHeight * 0.94; // Hide labels in bottom 6%
    
    // Draw each tick - show ALL ticks regardless of playback speed
    tickFrequencies.forEach(originalFreq => {
        // Skip 0 Hz, 0.1 Hz (log scale), and max frequency
        // BUT: allow 50 Hz to show when speed < 0.95x (even if it's the Nyquist)
        if (originalFreq === 0 || originalFreq === 0.1) return;
        if (originalFreq === originalNyquist && !(originalFreq === 50 && smoothedRate < 0.95)) return;
        
        // For square root scale at slower speeds, remove specific frequencies to reduce clutter
        if (scaleType === 'sqrt') {
            // At 0.6x speed or slower, remove 2, 4, 12, 17 Hz
            if (smoothedRate <= 0.6) {
                if (originalFreq === 2 || originalFreq === 4 || originalFreq === 12 || originalFreq === 17) {
                    return;
                }
            }
            // At 0.4x speed or slower, also remove 45 Hz
            if (smoothedRate <= 0.4) {
                if (originalFreq === 45) {
                    return;
                }
            }
            // At 0.3x speed or slower, also remove 35 Hz and 25 Hz
            if (smoothedRate <= 0.3) {
                if (originalFreq === 35 || originalFreq === 25) {
                    return;
                }
            }
            // At 0.35x speed or slower, also remove 7 Hz
            if (smoothedRate <= 0.35) {
                if (originalFreq === 7) {
                    return;
                }
            }
        }
        
        // Linear scale tick filtering is now handled in generateLinearTicks()
        
        // Calculate Y position: normalize by originalNyquist, then scale by playback rate
        // This way: slower playback = smaller multiplier = tick moves DOWN
        // Example: 20 Hz / 50 Hz = 0.4 normalized
        //   At 1x: y = canvasHeight - (0.4 * 1.0 * canvasHeight) = 60% from bottom
        //   At 0.5x: y = canvasHeight - (0.4 * 0.5 * canvasHeight) = 80% from bottom (moved DOWN)
        
        // During scale transition, interpolate between the TWO MAPPING FUNCTIONS
        // This creates a smooth cross-fade between old and new scale mappings
        let y;
        if (scaleTransitionInProgress && oldScaleType !== null && interpolationFactor < 1.0) {
            // Calculate Y using OLD mapping function
            const oldY = getYPositionForFrequencyScaled(originalFreq, originalNyquist, canvasHeight, oldScaleType, smoothedRate);
            
            // Calculate Y using NEW mapping function
            const newY = getYPositionForFrequencyScaled(originalFreq, originalNyquist, canvasHeight, scaleType, smoothedRate);
            
            // Interpolate between the two mapping function results
            y = oldY + (newY - oldY) * interpolationFactor;
        } else {
            // No transition - use current scale
            y = getYPositionForFrequencyScaled(originalFreq, originalNyquist, canvasHeight, scaleType, smoothedRate);
        }
        
        // For logarithmic scale, hide ticks in the bottom 6% to avoid overlap with "Hz" label
        if (scaleType === 'logarithmic' && y > bottomThreshold) return;
        
        // Clamp to canvas bounds (but don't filter out - let them draw even if slightly out of bounds)
        if (y < -10 || y > canvasHeight + 10) return; // Allow slight overflow for smooth transitions
        
        // Format label - show the ORIGINAL frequency (seismic frequency, not audio frequency)
        const label = formatFrequencyLabel(originalFreq);
        
        // Draw tick mark (from left edge)
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(5, y);
        ctx.stroke();
        
        // Draw label (to the right of tick)
        ctx.fillText(label, 8, y);
    });
    
    // Draw "Hz" label at bottom, left aligned
    // Match the styling of frequency labels for consistency
    ctx.font = `${fontSize} Arial, sans-serif`;  // Use CSS variable for font size
    ctx.fillStyle = labelColor;  // Use CSS variable for color
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';  // Use middle baseline for sharper rendering
    // Ensure no shadow on Hz label
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    // Position at bottom: with middle baseline, y position is center of text
    // Move it down a bit lower than before
    const textHeight = 16; // Approximate height of 16px font
    ctx.fillText('Hz', 8, canvasHeight - 2 - (textHeight / 2));  // Left aligned, positioned lower near bottom
    
    // Continue animation if in progress
    if (scaleTransitionInProgress) {
        const elapsed = performance.now() - scaleTransitionStartTime;
        if (elapsed < scaleTransitionDuration) {
            scaleTransitionRAF = requestAnimationFrame(() => {
                // 🔥 FIX: Check document connection before executing RAF callback
                // This prevents RAF callbacks from retaining references to detached documents
                if (!document.body || !document.body.isConnected) {
                    scaleTransitionRAF = null;
                    scaleTransitionInProgress = false;
                    return;
                }
                drawFrequencyAxis();
            });
        } else {
            // Animation complete
            scaleTransitionInProgress = false;
            oldScaleType = null;
            scaleTransitionRAF = null;
        }
    }
}

/**
 * Calculate Y position for a frequency, matching spectrogram's scale calculation
 */
function getYPositionForFrequency(freq, maxFreq, canvasHeight, scaleType) {
    const normalized = freq / maxFreq; // 0 to 1
    
    if (scaleType === 'logarithmic') {
        // Logarithmic scale
        const minFreq = 0.1; // Avoid log(0)
        const freqSafe = Math.max(freq, minFreq);
        const logMin = Math.log10(minFreq);
        const logMax = Math.log10(maxFreq);
        const logFreq = Math.log10(freqSafe);
        const normalizedLog = (logFreq - logMin) / (logMax - logMin);
        return canvasHeight - (normalizedLog * canvasHeight);
    } else if (scaleType === 'sqrt') {
        // Square root scale
        const sqrtNormalized = Math.sqrt(normalized);
        return canvasHeight - (sqrtNormalized * canvasHeight);
    } else {
        // Linear scale
        return canvasHeight - (normalized * canvasHeight);
    }
}

/**
 * Calculate stretch factor for logarithmic scale (matches spectrogram-complete-renderer.js logic)
 * This is needed because log scale is NOT homogeneous - we must stretch positions, not scale frequencies
 */
function calculateStretchFactorForLog(playbackRate, originalNyquist) {
    const minFreq = 0.1; // Match tick positioning (avoid log(0))
    const logMin = Math.log10(minFreq);
    const logMax = Math.log10(originalNyquist);
    const logRange = logMax - logMin;
    
    // Adapted from spectrogram stretch factor: targetMaxFreq = originalNyquist / playbackRate
    // At higher playbackRate, we show a smaller portion (zooming in on lower frequencies)
    const targetMaxFreq = originalNyquist / playbackRate;
    const logTargetMax = Math.log10(Math.max(targetMaxFreq, minFreq));
    const targetLogRange = logTargetMax - logMin;
    const fraction = targetLogRange / logRange;
    
    // Stretch to fill viewport: if showing fraction of log space, stretch by 1/fraction
    return 1 / fraction;
}

/**
 * Calculate Y position for a frequency scaled by playback rate
 * 
 * CRITICAL: Logarithmic scale uses a different approach than linear/sqrt!
 * - Linear/sqrt: Scale frequency FIRST, then apply transform (homogeneous transforms)
 * - Logarithmic: Calculate 1x position FIRST, then apply stretch factor to position (non-homogeneous)
 * 
 * This is because log scale is NOT homogeneous - stretching the position ≠ scaling the input
 */
export function getYPositionForFrequencyScaled(freq, originalNyquist, canvasHeight, scaleType, playbackRate) {
    if (scaleType === 'logarithmic') {
        // 🦋 LOGARITHMIC: Calculate position at 1x (no playback scaling in log space!)
        // Use FIXED denominator (logMax = log10(originalNyquist)) to match spectrogram rendering
        const minFreq = 0.1; // Avoid log(0)
        const freqSafe = Math.max(freq, minFreq);
        const logMin = Math.log10(minFreq);
        const logMax = Math.log10(originalNyquist); // FIXED denominator!
        const logFreq = Math.log10(freqSafe);
        const normalizedLog = (logFreq - logMin) / (logMax - logMin);
        const heightFromBottom_1x = normalizedLog * canvasHeight;
        
        // Apply stretch factor (matches spectrogram GPU stretching!)
        const stretchFactor = calculateStretchFactorForLog(playbackRate, originalNyquist);
        const heightFromBottom_scaled = heightFromBottom_1x * stretchFactor;
        
        return canvasHeight - heightFromBottom_scaled;
    } else {
        // Linear and sqrt: Scale the frequency by playback rate FIRST (in frequency space)
        // Slower playback = lower effective frequency = moves down
        const effectiveFreq = freq * playbackRate;
        
        if (scaleType === 'sqrt') {
        // Square root scale: normalize the SCALED frequency, then apply sqrt
        const normalized = effectiveFreq / originalNyquist;
        const sqrtNormalized = Math.sqrt(normalized);
        return canvasHeight - (sqrtNormalized * canvasHeight);
    } else {
        // Linear scale: normalize the SCALED frequency
        const normalized = effectiveFreq / originalNyquist;
        return canvasHeight - (normalized * canvasHeight);
        }
    }
}

/**
 * Generate tick frequencies for logarithmic scale
 */
function generateLogTicks(maxFreq) {
    const ticks = [];
    
    // Start with 0 Hz at the bottom
    ticks.push(0);
    
    // Logarithmic increments
    const decades = Math.ceil(Math.log10(maxFreq));
    for (let decade = -1; decade <= decades; decade++) {
        const base = Math.pow(10, decade);
        [1, 2, 5].forEach(mult => {
            const freq = base * mult;
            if (freq > 0 && freq <= maxFreq) {
                ticks.push(freq);
            }
        });
    }
    
    // Add specific frequencies for better granularity
    [0.3, 0.4, 0.7, 1.5, 3, 4, 7, 15, 30, 40].forEach(freq => {
        if (freq > 0 && freq <= maxFreq) {
            ticks.push(freq);
        }
    });
    
    // Add max frequency if not already included
    if (!ticks.includes(maxFreq)) {
        ticks.push(maxFreq);
    }
    
    return [...new Set(ticks)].sort((a, b) => a - b);
}

/**
 * Generate tick frequencies for square root scale
 */
function generateSqrtTicks(maxFreq, playbackRate = 1.0) {
    const ticks = [0];
    
    // Denser at lower frequencies
    if (maxFreq <= 10) {
        // Very low frequency data (e.g., 20 Hz sample rate)
        for (let i = 1; i <= maxFreq; i++) {
            ticks.push(i);
        }
    } else if (maxFreq <= 50) {
        // Typical seismic (100 Hz sample rate → 50 Hz Nyquist)
        [1, 2, 3, 4, 5, 7, 10, 12, 15, 17, 20, 25, 30, 35, 40, 45, 50].forEach(f => {
            if (f <= maxFreq) ticks.push(f);
        });
        
        // Add 6, 8, and 9 Hz when speed >= 1.6x
        if (playbackRate >= 1.6) {
            [6, 8, 9].forEach(f => {
                if (f <= maxFreq && !ticks.includes(f)) ticks.push(f);
            });
        }
        
        // Add 0.5 Hz increments when speed >= 9x
        if (playbackRate >= 9.0) {
            for (let f = 0.5; f <= 9; f += 0.5) {
                if (f <= maxFreq && !ticks.includes(f)) ticks.push(f);
            }
        }
    } else {
        // Higher frequency data
        [1, 5, 10, 20, 30, 40, 50, 75, 100, 150, 200].forEach(f => {
            if (f <= maxFreq) ticks.push(f);
        });
    }
    
    // Add max if not included
    if (!ticks.includes(maxFreq)) {
        ticks.push(maxFreq);
    }
    
    // Sort ticks to ensure proper order
    return ticks.sort((a, b) => a - b);
}

/**
 * Generate tick frequencies for linear scale
 */
function generateLinearTicks(maxFreq, playbackRate) {
    const ticks = [0];
    
    // Very high speed mode (10x and above): 0.1 Hz increments
    if (playbackRate >= 10.0) {
        // Add 0.1 Hz increments
        for (let freq = 0.1; freq <= maxFreq; freq += 0.1) {
            if (freq <= maxFreq) ticks.push(freq);
        }
    }
    // High speed mode (4.5x and above): 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9, 10...
    else if (playbackRate >= 4.5) {
        // Add .5 increments up to 5
        for (let freq = 0.5; freq <= 5; freq += 0.5) {
            if (freq <= maxFreq) ticks.push(freq);
        }
        // Then add whole numbers
        for (let freq = 6; freq <= maxFreq; freq += 1) {
            ticks.push(freq);
        }
    }
    // Medium-high speed mode (2.3x and above): 1, 2, 3, 4, 5, 6, 7, 8, 9, 10...
    else if (playbackRate >= 2.3) {
        for (let freq = 1; freq <= maxFreq; freq += 1) {
            ticks.push(freq);
        }
    }
    // Normal speed mode: increments of 5 Hz (5, 10, 15, 20, 25, 30, 35, 40, 45, 50...)
    else {
        // Generate ticks in 5 Hz increments
        for (let freq = 5; freq <= maxFreq; freq += 5) {
            ticks.push(freq);
        }
        
        // Below 0.6x: remove 5 Hz
        if (playbackRate <= 0.6) {
            const index5 = ticks.indexOf(5);
            if (index5 > -1) ticks.splice(index5, 1);
        }
        
        // Below 0.34x: remove 15, 25, 35, 45 Hz
        if (playbackRate <= 0.34) {
            [15, 25, 35, 45].forEach(freq => {
                const index = ticks.indexOf(freq);
                if (index > -1) ticks.splice(index, 1);
            });
        }
    }
    
    // Add max frequency if not already included
    if (!ticks.includes(maxFreq)) {
        ticks.push(maxFreq);
    }
    
    // Sort and return
    return ticks.sort((a, b) => a - b);
}

/**
 * Format frequency for display
 */
function formatFrequencyLabel(freq) {
    if (freq === 0) return '0';
    
    if (freq < 1) {
        // Show decimals for sub-Hz
        return freq.toFixed(1);
    } else if (freq < 10) {
        // One decimal for 1-10 Hz
        return freq.toFixed(Number.isInteger(freq) ? 0 : 1);
    } else {
        // No decimals for >= 10 Hz (just whole numbers)
        return Math.round(freq).toString();
    }
}

/**
 * Position the axis canvas to the right of the spectrogram
 * Optimized: Only updates position, doesn't redraw
 */
export function positionAxisCanvas() {
    const spectrogramCanvas = document.getElementById('spectrogram');
    const axisCanvas = document.getElementById('spectrogram-axis');
    const panel = spectrogramCanvas?.closest('.panel');
    
    if (!spectrogramCanvas || !axisCanvas || !panel) return;
    
    // Use getBoundingClientRect only once and cache values
    const spectrogramRect = spectrogramCanvas.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    
    // Calculate position: right edge of spectrogram, aligned with top
    const rightEdge = spectrogramRect.right - panelRect.left;
    const topEdge = spectrogramRect.top - panelRect.top;
    
    // Batch style updates to minimize reflows
    // Show the canvas after positioning to prevent flash
    axisCanvas.style.cssText = `
        position: absolute;
        left: ${rightEdge}px;
        top: ${topEdge}px;
        width: 60px;
        height: ${spectrogramRect.height}px;
        opacity: 1;
        visibility: visible;
    `;
}

/**
 * Resize axis canvas to match spectrogram height
 * CRITICAL: Set width to 60px to match display width - ticks must stay OUTSIDE spectrogram
 */
export function resizeAxisCanvas() {
    const spectrogramCanvas = document.getElementById('spectrogram');
    const axisCanvas = document.getElementById('spectrogram-axis');
    
    if (!spectrogramCanvas || !axisCanvas) return;
    
    // CRITICAL: Set width to match display width (60px) - prevents ticks from encroaching
    axisCanvas.width = 60;
    
    // Match height to spectrogram
    axisCanvas.height = spectrogramCanvas.height;
    
    // Reposition and redraw after resize
    positionAxisCanvas();
    drawFrequencyAxis();
}

/**
 * Update axis when playback speed changes
 * Called from audio-player.js when speed slider changes
 * Direct mapping with slight smoothing to avoid jitter
 */
export function updateAxisForPlaybackSpeed() {
    // Just redraw - the smoothing happens inside drawFrequencyAxis
    drawFrequencyAxis();
}

/**
 * Initialize the axis with current playback rate
 * Call this when data loads to set initial state
 */
export function initializeAxisPlaybackRate() {
    previousPlaybackRate = State.currentPlaybackRate || 1.0;
    drawFrequencyAxis();
}

/**
 * Start scale transition animation
 * Animates axis ticks from old scale to new scale over 400ms
 * @param {string} oldScale - Previous scale type ('linear', 'sqrt', 'logarithmic')
 * @returns {Promise} Resolves when animation completes
 */
export function animateScaleTransition(oldScale) {
    return new Promise((resolve) => {
        // Cancel any existing transition
        if (scaleTransitionRAF) {
            cancelAnimationFrame(scaleTransitionRAF);
        }
        
        // Store old scale type - we'll interpolate between old and new mapping functions
        oldScaleType = oldScale;
        scaleTransitionInProgress = true;
        scaleTransitionStartTime = performance.now();
        
        // Start animation loop
        drawFrequencyAxis();
        
        // Resolve after animation duration
        setTimeout(() => {
            scaleTransitionInProgress = false;
            oldScaleType = null;
            scaleTransitionRAF = null;
            resolve();
        }, scaleTransitionDuration);
    });
}

