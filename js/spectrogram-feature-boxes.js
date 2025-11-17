/**
 * spectrogram-feature-boxes.js
 * Manages persistent DOM feature boxes on the spectrogram
 * Boxes are positioned using eternal coordinates (samples + frequencies)
 */

import * as State from './audio-state.js';
import { zoomState } from './zoom-state.js';
import { getCurrentRegions } from './region-tracker.js';
import { getInterpolatedTimeRange } from './waveform-x-axis-renderer.js';

// Track all feature boxes: Map<"regionIndex-featureIndex", HTMLElement>
const featureBoxes = new Map();

// Constants
const MAX_FREQUENCY = 50; // Hz - Nyquist frequency for 100 Hz sample rate

/**
 * Convert frequency to Y position on canvas
 */
function getYFromFrequency(frequency, maxFreq, canvasHeight, scaleType) {
    if (scaleType === 'logarithmic') {
        const minFreq = 0.1;
        const freqSafe = Math.max(frequency, minFreq);
        const logMin = Math.log10(minFreq);
        const logMax = Math.log10(maxFreq);
        const logFreq = Math.log10(freqSafe);
        const normalizedLog = (logFreq - logMin) / (logMax - logMin);
        return canvasHeight - (normalizedLog * canvasHeight);
    } else if (scaleType === 'sqrt') {
        const normalized = frequency / maxFreq;
        const sqrtNormalized = Math.sqrt(normalized);
        return canvasHeight - (sqrtNormalized * canvasHeight);
    } else {
        const normalized = frequency / maxFreq;
        return canvasHeight - (normalized * canvasHeight);
    }
}

/**
 * Add a feature box (called when selection completes)
 */
export function addFeatureBox(regionIndex, featureIndex, boxElement) {
    const key = `${regionIndex}-${featureIndex}`;
    
    // Remove old box if it exists
    if (featureBoxes.has(key)) {
        const oldBox = featureBoxes.get(key);
        if (oldBox.parentNode) {
            oldBox.remove();
        }
    }
    
    // Change appearance from red (selection) to orange (persistent)
    boxElement.style.border = '2px solid rgba(255, 140, 0, 0.8)';
    boxElement.style.background = 'rgba(255, 140, 0, 0.15)';
    
    // Store reference
    featureBoxes.set(key, boxElement);
    
    console.log(`📦 Added feature box ${key}`);
}

/**
 * Remove a feature box (called when feature is deleted)
 */
export function removeFeatureBox(regionIndex, featureIndex) {
    const key = `${regionIndex}-${featureIndex}`;
    
    if (featureBoxes.has(key)) {
        const box = featureBoxes.get(key);
        if (box.parentNode) {
            box.remove();
        }
        featureBoxes.delete(key);
        console.log(`🗑️ Removed feature box ${key}`);
    }
}

/**
 * Update ALL feature box positions based on their eternal coordinates
 * Called whenever zoom/pan/frequency scale changes
 */
export function updateAllFeatureBoxPositions() {
    console.log(`🔄 Updating ${featureBoxes.size} feature box positions`);
    
    if (!State.dataStartTime || !State.dataEndTime || !zoomState.isInitialized()) {
        return;
    }
    
    const canvas = document.getElementById('spectrogram');
    if (!canvas) return;
    
    const container = canvas.closest('.panel');
    if (!container) return;
    
    const canvasRect = canvas.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;
    
    const regions = getCurrentRegions();
    
    regions.forEach((region, regionIndex) => {
        if (!region.features) return;
        
        region.features.forEach((feature, featureIndex) => {
            const key = `${regionIndex}-${featureIndex}`;
            const box = featureBoxes.get(key);
            
            if (!box) return; // No box for this feature yet
            
            // Check if feature has eternal coordinates
            if (!feature.lowFreq || !feature.highFreq || !feature.startTime || !feature.endTime) {
                // Feature incomplete - hide box
                box.style.display = 'none';
                return;
            }
            
            // Convert eternal coordinates to current pixel positions
            const lowFreq = parseFloat(feature.lowFreq);
            const highFreq = parseFloat(feature.highFreq);
            
            // CSS pixels for Y (frequency)
            const lowFreqY = getYFromFrequency(lowFreq, MAX_FREQUENCY, canvas.offsetHeight, State.frequencyScale);
            const highFreqY = getYFromFrequency(highFreq, MAX_FREQUENCY, canvas.offsetHeight, State.frequencyScale);
            
            // CSS pixels for X (time) - zoom-aware!
            const startTimestamp = new Date(feature.startTime);
            const endTimestamp = new Date(feature.endTime);
            
            let startX, endX;
            const interpolatedRange = getInterpolatedTimeRange();
            const displayStartMs = interpolatedRange.startTime.getTime();
            const displayEndMs = interpolatedRange.endTime.getTime();
            const displaySpanMs = displayEndMs - displayStartMs;
            
            const startMs = startTimestamp.getTime();
            const endMs = endTimestamp.getTime();
            
            const startProgress = (startMs - displayStartMs) / displaySpanMs;
            const endProgress = (endMs - displayStartMs) / displaySpanMs;
            
            startX = startProgress * canvas.offsetWidth;
            endX = endProgress * canvas.offsetWidth;
            
            // Check if visible
            if (endX < 0 || startX > canvas.offsetWidth) {
                box.style.display = 'none';
                return;
            }
            
            // Update DOM position (relative to container)
            box.style.display = 'block';
            box.style.left = (canvasRect.left - containerRect.left + startX) + 'px';
            box.style.top = (canvasRect.top - containerRect.top + highFreqY) + 'px';
            box.style.width = (endX - startX) + 'px';
            box.style.height = Math.abs(highFreqY - lowFreqY) + 'px';
        });
    });
}

/**
 * Clear all feature boxes (called when switching volcanoes or loading new data)
 */
export function clearAllFeatureBoxes() {
    console.log(`🧹 Clearing all ${featureBoxes.size} feature boxes`);
    
    featureBoxes.forEach(box => {
        if (box.parentNode) {
            box.remove();
        }
    });
    
    featureBoxes.clear();
}

