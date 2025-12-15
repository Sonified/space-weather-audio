/**
 * spectrogram-feature-boxes.js
 * Manages persistent DOM feature boxes on the spectrogram
 * Boxes are positioned using eternal coordinates (samples + frequencies)
 */

import * as State from './audio-state.js';
import { zoomState } from './zoom-state.js';
import { getCurrentRegions, getCurrentFrequencySelection } from './region-tracker.js';
import { getYPositionForFrequencyScaled, getScaleTransitionState } from './spectrogram-axis-renderer.js';
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

    // Add feature number label in upper left corner
    // Format: region.feature (e.g., 1.1, 1.2, 2.1)
    const numberLabel = document.createElement('div');
    numberLabel.className = 'feature-box-number';
    numberLabel.textContent = `${regionIndex + 1}.${featureIndex + 1}`;
    numberLabel.style.position = 'absolute';
    numberLabel.style.top = '3px';
    numberLabel.style.left = '6px';
    numberLabel.style.fontSize = '16px'; // Bigger!
    numberLabel.style.fontWeight = 'bold';
    numberLabel.style.color = 'rgba(255, 160, 80, 0.85)'; // Softer orange-gold
    numberLabel.style.textShadow = '0 0 3px rgba(0, 0, 0, 0.8), 1px 1px 2px rgba(0, 0, 0, 0.7)';
    numberLabel.style.pointerEvents = 'none';
    numberLabel.style.userSelect = 'none';
    numberLabel.style.lineHeight = '1';
    boxElement.appendChild(numberLabel);

    // Store reference
    featureBoxes.set(key, boxElement);

    // console.log(`📦 Added feature box ${key}`);
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
        // console.log(`🗑️ Removed feature box ${key}`);
    }
}

/**
 * Renumber all feature boxes for a region after deletion
 * When feature 2 is deleted from [1,2,3,4,5], features [3,4,5] become [2,3,4]
 */
export function renumberFeatureBoxes(regionIndex) {
    const regions = getCurrentRegions();
    const region = regions[regionIndex];
    if (!region) return;

    // Build new map with updated keys
    const newBoxes = new Map();

    // Iterate through current features in order
    region.features.forEach((feature, newFeatureIndex) => {
        // Try to find this box by checking all possible old indices
        let foundBox = null;
        let oldKey = null;

        // Search through all boxes for this region to find the one that matches
        for (let oldIndex = 0; oldIndex < 30; oldIndex++) { // Max 20 features, search a bit wider for safety
            const testKey = `${regionIndex}-${oldIndex}`;
            if (featureBoxes.has(testKey)) {
                foundBox = featureBoxes.get(testKey);
                oldKey = testKey;

                // Update the number label
                const numberLabel = foundBox.querySelector('.feature-box-number');
                if (numberLabel) {
                    numberLabel.textContent = newFeatureIndex + 1; // Update to new 1-indexed number
                }

                // Store with new key
                const newKey = `${regionIndex}-${newFeatureIndex}`;
                newBoxes.set(newKey, foundBox);

                // Remove from old map
                featureBoxes.delete(testKey);

                // console.log(`🔢 Renumbered box ${oldKey} → ${newKey}`);
                break;
            }
        }
    });

    // Merge new boxes back into main map
    newBoxes.forEach((box, key) => {
        featureBoxes.set(key, box);
    });

    // console.log(`🔢 Renumbered all boxes for region ${regionIndex}`);
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

    // DEBUG: Disabled - was too noisy
    // if (Math.random() < 0.01) {
    //     console.log('📐 Canvas dimensions:', {
    //         device_width: canvas.width,
    //         device_height: canvas.height,
    //         css_width: canvas.offsetWidth,
    //         css_height: canvas.offsetHeight,
    //         scaleX: (canvas.width / canvas.offsetWidth).toFixed(3),
    //         scaleY: (canvas.height / canvas.offsetHeight).toFixed(3),
    //         canvasTop: canvasRect.top,
    //         containerTop: containerRect.top,
    //         offset: (canvasRect.top - containerRect.top).toFixed(1)
    //     });
    // }
    
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

            // DEVICE pixels for Y (frequency) - WITH SCALE INTERPOLATION! 🎯
            // Use exact same interpolation logic as Y-axis ticks during scale transitions
            const scaleTransition = getScaleTransitionState();

            let lowFreqY_device, highFreqY_device;

            if (scaleTransition.inProgress && scaleTransition.oldScaleType) {
                // Interpolate between old and new scale positions (like axis ticks!)
                const oldLowY = getYPositionForFrequencyScaled(lowFreq, originalNyquist, canvas.height, scaleTransition.oldScaleType, playbackRate);
                const newLowY = getYPositionForFrequencyScaled(lowFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
                const oldHighY = getYPositionForFrequencyScaled(highFreq, originalNyquist, canvas.height, scaleTransition.oldScaleType, playbackRate);
                const newHighY = getYPositionForFrequencyScaled(highFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);

                lowFreqY_device = oldLowY + (newLowY - oldLowY) * scaleTransition.interpolationFactor;
                highFreqY_device = oldHighY + (newHighY - oldHighY) * scaleTransition.interpolationFactor;
            } else {
                // No transition - use current scale directly
                lowFreqY_device = getYPositionForFrequencyScaled(lowFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
                highFreqY_device = getYPositionForFrequencyScaled(highFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
            }

            // Convert device pixels to CSS pixels for DOM positioning
            const scaleY = canvas.offsetHeight / canvas.height;
            const lowFreqY = lowFreqY_device * scaleY;
            const highFreqY = highFreqY_device * scaleY;

            // DEBUG: Disabled - was too noisy
            // console.log(`📦 Box ${key} Y-calc:`, {
            //     lowFreq: lowFreq.toFixed(2),
            //     highFreq: highFreq.toFixed(2),
            //     originalNyquist,
            //     playbackRate: playbackRate.toFixed(3),
            //     scale: State.frequencyScale,
            //     canvas_height: canvas.height,
            //     lowFreqY_device: lowFreqY_device.toFixed(1),
            //     highFreqY_device: highFreqY_device.toFixed(1),
            //     box_will_be_at: `top=${(canvasRect.top - containerRect.top + (Math.min(highFreqY, lowFreqY))).toFixed(1)}px`
            // });
            
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

            // ✨ Check if this box is currently selected (add glow effect)
            const currentSelection = getCurrentFrequencySelection();
            const isSelected = currentSelection &&
                              currentSelection.regionIndex === regionIndex &&
                              currentSelection.featureIndex === featureIndex;

            // Choose border color based on selection state
            const borderColor = isSelected ? 'rgba(255, 220, 120, 1)' : 'rgba(255, 140, 0, 0.8)';

            // Smart border: hide edges that extend beyond viewport (makes box appear to extend off-screen)
            const borderParts = [];
            if (clippedTopY > topY) borderParts.push('0'); // Top was clipped - hide border (appears to extend)
            else borderParts.push(`2px solid ${borderColor}`); // Top fully visible - show border

            if (clippedEndX < endX) borderParts.push('0'); // Right was clipped - hide border
            else borderParts.push(`2px solid ${borderColor}`); // Right fully visible - show border

            if (clippedBottomY < bottomY) borderParts.push('0'); // Bottom was clipped - hide border
            else borderParts.push(`2px solid ${borderColor}`); // Bottom fully visible - show border

            if (clippedStartX > startX) borderParts.push('0'); // Left was clipped - hide border
            else borderParts.push(`2px solid ${borderColor}`); // Left fully visible - show border

            box.style.borderWidth = borderParts.join(' '); // top right bottom left

            // ✨ Apply subtle GLOW effect if selected (10% more than before)
            if (isSelected) {
                box.style.boxShadow = '0 0 10px 2.5px rgba(255, 200, 100, 0.45), inset 0 0 7px rgba(255, 200, 100, 0.25)';
                box.style.background = 'rgba(255, 200, 100, 0.24)'; // Slightly brighter background
            } else {
                box.style.boxShadow = 'none';
                box.style.background = 'rgba(255, 140, 0, 0.15)'; // Normal background
            }
        });
    });
}

/**
 * Get a feature box element by region and feature index
 */
export function getFeatureBox(regionIndex, featureIndex) {
    const key = `${regionIndex}-${featureIndex}`;
    return featureBoxes.get(key) || null;
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

