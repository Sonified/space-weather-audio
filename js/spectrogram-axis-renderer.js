/**
 * spectrogram-axis-renderer.js
 * Y-axis rendering for spectrogram showing ORIGINAL seismic frequencies (not sped-up audio)
 */

import * as State from './audio-state.js';

/**
 * Draw frequency axis showing original seismic data frequencies
 * 
 * For example, if original data is 100 Hz sample rate:
 * - Nyquist = 50 Hz
 * - Y-axis shows 0-50 Hz (actual earthquake frequencies)
 * - NOT the sped-up audio frequencies (0-22 kHz)
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
    
    // Clear canvas (transparent background)
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    
    // Setup text styling - disable shadows/outlines
    ctx.font = '16px Arial, sans-serif';  // Increased from 13px to 16px (+3pt)
    ctx.fillStyle = '#ddd';  // Slightly less bright than pure white
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
    
    // Define tick frequencies based on scale and original Nyquist
    let tickFrequencies = [];
    
    if (scaleType === 'logarithmic') {
        // Logarithmic scale - emphasize lower frequencies
        tickFrequencies = generateLogTicks(originalNyquist);
    } else if (scaleType === 'sqrt') {
        // Square root scale - gentle emphasis on lower frequencies
        tickFrequencies = generateSqrtTicks(originalNyquist);
    } else {
        // Linear scale - even spacing
        tickFrequencies = generateLinearTicks(originalNyquist);
    }
    
    // Draw each tick
    tickFrequencies.forEach(freq => {
        // Skip 0 Hz, 0.1 Hz (log scale), and max frequency (Nyquist)
        if (freq === 0 || freq === originalNyquist || freq === 0.1) return;
        
        // Calculate Y position matching the spectrogram's calculation
        const y = getYPositionForFrequency(freq, originalNyquist, canvasHeight, scaleType);
        
        // Clamp to canvas bounds
        if (y < 0 || y > canvasHeight) return;
        
        // Format label
        const label = formatFrequencyLabel(freq);
        
        // Draw tick mark (from left edge)
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(5, y);
        ctx.stroke();
        
        // Draw label (to the right of tick)
        ctx.fillText(label, 8, y);
    });
    
    // Draw "Hz" label at bottom, left aligned
    ctx.font = 'bold 15px Arial, sans-serif';  // Increased from 12px to 15px (+3pt)
    ctx.fillStyle = '#aaa';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    // Ensure no shadow on Hz label
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillText('Hz', 8, canvasHeight - 5);  // Left aligned at x=8, bottom with 5px padding
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
        [1, 2, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50].forEach(f => {
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
    axisCanvas.style.cssText = `
        position: absolute;
        left: ${rightEdge}px;
        top: ${topEdge}px;
        width: 60px;
        height: ${spectrogramRect.height}px;
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

