/**
 * spectrogram-feature-boxes.js
 * Manages persistent DOM feature boxes on the spectrogram
 * Boxes are positioned using eternal coordinates (samples + frequencies)
 */

import * as State from './audio-state.js';
import { zoomState } from './zoom-state.js';
import { getCurrentRegions } from './region-tracker.js';
import { getYPositionForFrequencyScaled } from './spectrogram-axis-renderer.js';
import { getInterpolatedTimeRange } from './waveform-x-axis-renderer.js';

// Track all feature boxes: Map<"regionIndex-featureIndex", HTMLElement>
const featureBoxes = new Map();

// Constants
const MAX_FREQUENCY = 50; // Hz - Nyquist frequency for 100 Hz sample rate

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
    // console.log(`🔄 Updating ${featureBoxes.size} feature box positions`);

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

    // DEBUG: Log canvas dimensions once
    if (Math.random() < 0.01) {
        console.log('📐 Canvas dimensions:', {
            device_width: canvas.width,
            device_height: canvas.height,
            css_width: canvas.offsetWidth,
            css_height: canvas.offsetHeight,
            scaleX: (canvas.width / canvas.offsetWidth).toFixed(3),
            scaleY: (canvas.height / canvas.offsetHeight).toFixed(3),
            canvasTop: canvasRect.top,
            containerTop: containerRect.top,
            offset: (canvasRect.top - containerRect.top).toFixed(1)
        });
    }
    
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

            // Removed console.log spam for performance

            // Convert eternal coordinates to current pixel positions
            const lowFreq = parseFloat(feature.lowFreq);
            const highFreq = parseFloat(feature.highFreq);

            // Get original sample rate (same as axis renderer)
            const originalSampleRate = State.currentMetadata?.original_sample_rate || 100;
            const originalNyquist = originalSampleRate / 2; // 50 Hz for 100 Hz sample rate

            // Get current playback rate (CRITICAL for scientific glue!)
            const playbackRate = State.currentPlaybackRate || 1.0;

            // DEVICE pixels for Y (frequency) - USE THE EXACT SAME FUNCTION AS AXIS TICKS!
            // This is THE TRUTH - same function, same parameters, same result as Y-axis ticks!
            const lowFreqY_device = getYPositionForFrequencyScaled(lowFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
            const highFreqY_device = getYPositionForFrequencyScaled(highFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);

            // Convert device pixels to CSS pixels for DOM positioning
            const scaleY = canvas.offsetHeight / canvas.height;
            const lowFreqY = lowFreqY_device * scaleY;
            const highFreqY = highFreqY_device * scaleY;

            // DEBUG: Always log to trace playback speed changes
            console.log(`📦 Box ${key} Y-calc:`, {
                lowFreq: lowFreq.toFixed(2),
                highFreq: highFreq.toFixed(2),
                originalNyquist,
                playbackRate: playbackRate.toFixed(3),
                scale: State.frequencyScale,
                canvas_height: canvas.height,
                lowFreqY_device: lowFreqY_device.toFixed(1),
                highFreqY_device: highFreqY_device.toFixed(1),
                box_will_be_at: `top=${(canvasRect.top - containerRect.top + (Math.min(highFreqY, lowFreqY))).toFixed(1)}px`
            });
            
            // CSS pixels for X (time) - USE ELASTIC INTERPOLATION! 🏄‍♂️
            const startTimestamp = new Date(feature.startTime);
            const endTimestamp = new Date(feature.endTime);

            let startX, endX;
            // 🎯 Use EXACT same interpolated time range as spectrogram elastic stretching!
            // This is THE TRUTH for X positioning during zoom transitions!
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

            // Check if completely off-screen horizontally (hide)
            if (endX < 0 || startX > canvas.offsetWidth) {
                box.style.display = 'none';
                return;
            }

            // Check if completely off-screen vertically (hide)
            // Note: Y coordinates are inverted (0 = top, height = bottom)
            const topY = Math.min(highFreqY, lowFreqY);
            const bottomY = Math.max(highFreqY, lowFreqY);
            if (bottomY < 0 || topY > canvas.offsetHeight) {
                box.style.display = 'none';
                return;
            }

            // Clip to visible viewport (don't draw off-screen)
            const clippedStartX = Math.max(0, startX);
            const clippedEndX = Math.min(canvas.offsetWidth, endX);
            const clippedTopY = Math.max(0, topY);
            const clippedBottomY = Math.min(canvas.offsetHeight, bottomY);

            // Check if box still has dimensions after clipping
            if (clippedEndX <= clippedStartX || clippedBottomY <= clippedTopY) {
                box.style.display = 'none';
                return;
            }

            // Update DOM position (relative to container)
            box.style.display = 'block';

            // NO TRANSITION - instant updates every frame, like the axis ticks!
            box.style.transition = 'none';

            box.style.left = (canvasRect.left - containerRect.left + clippedStartX) + 'px';
            box.style.top = (canvasRect.top - containerRect.top + clippedTopY) + 'px';
            box.style.width = (clippedEndX - clippedStartX) + 'px';
            box.style.height = (clippedBottomY - clippedTopY) + 'px';

            // Smart border: hide edges that extend beyond viewport (makes box appear to extend off-screen)
            const borderParts = [];
            if (clippedTopY > topY) borderParts.push('0'); // Top was clipped - hide border (appears to extend)
            else borderParts.push('2px solid rgba(255, 140, 0, 0.8)'); // Top fully visible - show border

            if (clippedEndX < endX) borderParts.push('0'); // Right was clipped - hide border
            else borderParts.push('2px solid rgba(255, 140, 0, 0.8)'); // Right fully visible - show border

            if (clippedBottomY < bottomY) borderParts.push('0'); // Bottom was clipped - hide border
            else borderParts.push('2px solid rgba(255, 140, 0, 0.8)'); // Bottom fully visible - show border

            if (clippedStartX > startX) borderParts.push('0'); // Left was clipped - hide border
            else borderParts.push('2px solid rgba(255, 140, 0, 0.8)'); // Left fully visible - show border

            box.style.borderWidth = borderParts.join(' '); // top right bottom left
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

