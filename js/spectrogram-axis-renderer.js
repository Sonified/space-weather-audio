/**
 * spectrogram-axis-renderer.js
 * Y-axis rendering for spectrogram showing frequencies scaled by playback speed
 */

import * as State from './audio-state.js';

// Track previous playback rate for slight smoothing
let previousPlaybackRate = 1.0;
const SMOOTHING_FACTOR = 0.15; // Light smoothing (0 = no smoothing, 1 = full smoothing)

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
    
    // Get original sample rate from metadata
    const originalSampleRate = State.currentMetadata?.original_sample_rate || 100;
    const originalNyquist = originalSampleRate / 2;
    
    // Get playback speed and apply slight smoothing
    const currentPlaybackRate = State.currentPlaybackRate || 1.0;
    const smoothedRate = previousPlaybackRate + (currentPlaybackRate - previousPlaybackRate) * (1 - SMOOTHING_FACTOR);
    previousPlaybackRate = smoothedRate;
    
    // Effective Nyquist scales with playback speed
    // Slower playback (0.5x) = lower frequencies = smaller max (25 Hz instead of 50 Hz)
    const effectiveNyquist = originalNyquist * smoothedRate;
    
    // Clear canvas (transparent background)
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    
    // Setup text styling - disable shadows/outlines
    ctx.font = '16px Arial, sans-serif';
    ctx.fillStyle = '#ddd';
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    // Disable any shadow effects
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    
    // Get current frequency scale
    const scaleType = State.frequencyScale;
    
    // Generate tick frequencies based on ORIGINAL Nyquist (keep labels consistent)
    // But scale their positions based on effective Nyquist
    let tickFrequencies = [];
    
    if (scaleType === 'logarithmic') {
        tickFrequencies = generateLogTicks(originalNyquist);
    } else if (scaleType === 'sqrt') {
        tickFrequencies = generateSqrtTicks(originalNyquist);
    } else {
        tickFrequencies = generateLinearTicks(originalNyquist);
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
        
        // For linear scale at 0.4x speed or slower, remove specific frequencies to reduce clutter
        if (scaleType === 'linear' && smoothedRate <= 0.4) {
            if (originalFreq === 5 || originalFreq === 15 || originalFreq === 25 || originalFreq === 35 || originalFreq === 45) {
                return;
            }
        }
        
        // Calculate Y position: normalize by originalNyquist, then scale by playback rate
        // This way: slower playback = smaller multiplier = tick moves DOWN
        // Example: 20 Hz / 50 Hz = 0.4 normalized
        //   At 1x: y = canvasHeight - (0.4 * 1.0 * canvasHeight) = 60% from bottom
        //   At 0.5x: y = canvasHeight - (0.4 * 0.5 * canvasHeight) = 80% from bottom (moved DOWN)
        const y = getYPositionForFrequencyScaled(originalFreq, originalNyquist, canvasHeight, scaleType, smoothedRate);
        
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
    ctx.font = '16px Arial, sans-serif';  // Same size as frequency labels
    ctx.fillStyle = '#ddd';  // Same color as frequency labels
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';  // Use middle baseline for sharper rendering
    // Ensure no shadow on Hz label
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    // Position at bottom: with middle baseline, y position is center of text
    // Estimate text height ~16px, so center should be at canvasHeight - 5 - 8 = canvasHeight - 13
    // But let's use a simpler approach: position near bottom accounting for half text height
    const textHeight = 16; // Approximate height of 16px font
    ctx.fillText('Hz', 8, canvasHeight - 5 - (textHeight / 2));  // Left aligned, positioned near bottom
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
 * Calculate Y position for a frequency scaled by playback rate
 * For nonlinear scales (log/sqrt), scale the frequency FIRST, then apply the transform
 * This preserves the correct visual behavior - slower playback moves ticks DOWN
 */
function getYPositionForFrequencyScaled(freq, originalNyquist, canvasHeight, scaleType, playbackRate) {
    // Scale the frequency by playback rate FIRST (in frequency space)
    // Slower playback = lower effective frequency = moves down
    const effectiveFreq = freq * playbackRate;
    
    if (scaleType === 'logarithmic') {
        // Logarithmic scale: apply log transform to the SCALED frequency
        const minFreq = 0.1; // Avoid log(0)
        const freqSafe = Math.max(effectiveFreq, minFreq);
        const logMin = Math.log10(minFreq);
        const logMax = Math.log10(originalNyquist);
        const logFreq = Math.log10(freqSafe);
        const normalizedLog = (logFreq - logMin) / (logMax - logMin);
        return canvasHeight - (normalizedLog * canvasHeight);
    } else if (scaleType === 'sqrt') {
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
function generateSqrtTicks(maxFreq) {
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
    
    return ticks;
}

/**
 * Generate tick frequencies for linear scale
 */
function generateLinearTicks(maxFreq) {
    const ticks = [0];
    
    // Calculate nice tick spacing
    let spacing;
    if (maxFreq <= 10) {
        spacing = 1;
    } else if (maxFreq <= 50) {
        spacing = 5;
    } else if (maxFreq <= 100) {
        spacing = 10;
    } else if (maxFreq <= 200) {
        spacing = 20;
    } else {
        spacing = 50;
    }
    
    // Generate evenly-spaced ticks
    for (let freq = spacing; freq < maxFreq; freq += spacing) {
        ticks.push(freq);
    }
    
    // Add max frequency
    ticks.push(maxFreq);
    
    return ticks;
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
        // No decimals for >= 10 Hz
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

