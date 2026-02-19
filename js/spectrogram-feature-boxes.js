/**
 * spectrogram-feature-boxes.js
 * Manages persistent DOM feature boxes on the spectrogram
 * Boxes are positioned using eternal coordinates (samples + frequencies)
 *
 * DEAD CODE TEST — All logic commented out to confirm this system is unused.
 * The canvas-drawn boxes in spectrogram-renderer.js are the real rendering system.
 * addFeatureBox() was never called, so the featureBoxes Map was always empty.
 */

// import * as State from './audio-state.js';
// import { zoomState } from './zoom-state.js';
// import { getCurrentRegions, getStandaloneFeatures, getCurrentFrequencySelection, getFlatFeatureNumber, deleteStandaloneFeature, renderStandaloneFeaturesList, updateCompleteButtonState, updateCmpltButtonState } from './region-tracker.js';
// import { getYPositionForFrequencyScaled, getScaleTransitionState } from './spectrogram-axis-renderer.js';
// import { getInterpolatedTimeRange } from './waveform-x-axis-renderer.js';

// // Track all feature boxes: Map<"regionIndex-featureIndex", HTMLElement>
// const featureBoxes = new Map();

// // Constants
// const MAX_FREQUENCY = 50; // Hz - Nyquist frequency for 100 Hz sample rate

/**
 * Add a feature box (called when selection completes)
 */
export function addFeatureBox(regionIndex, featureIndex, boxElement) {
    // const key = `${regionIndex}-${featureIndex}`;
    //
    // // Remove old box if it exists
    // if (featureBoxes.has(key)) {
    //     const oldBox = featureBoxes.get(key);
    //     if (oldBox.parentNode) {
    //         oldBox.remove();
    //     }
    // }
    //
    // // Change appearance from red (selection) to orange (persistent)
    // boxElement.style.border = '2px solid rgba(255, 140, 0, 0.8)';
    // boxElement.style.background = 'rgba(255, 140, 0, 0.15)';
    //
    // // Add flat sequential feature number label
    // const numberLabel = document.createElement('div');
    // numberLabel.className = 'feature-box-number';
    // const flatNum = getFlatFeatureNumber(regionIndex, featureIndex);
    // numberLabel.textContent = `${flatNum}`;
    // numberLabel.style.position = 'absolute';
    // numberLabel.style.top = '-20px';
    // numberLabel.style.left = '2px';
    // numberLabel.style.fontSize = '14px';
    // numberLabel.style.fontWeight = 'bold';
    // const isRed = flatNum <= 10;
    // numberLabel.style.color = isRed ? 'rgba(255, 80, 80, 0.9)' : 'rgba(255, 255, 255, 0.8)';
    // numberLabel.style.textShadow = isRed
    //     ? '0 0 4px rgba(255, 255, 255, 0.3), 1px 1px 2px rgba(0, 0, 0, 0.5)'
    //     : '0 0 3px rgba(0, 0, 0, 0.8), 1px 1px 2px rgba(0, 0, 0, 0.7)';
    // numberLabel.style.pointerEvents = 'none';
    // numberLabel.style.userSelect = 'none';
    // numberLabel.style.lineHeight = '1';
    // boxElement.appendChild(numberLabel);
    //
    // // Add delete button (X) in upper right corner
    // const deleteBtn = document.createElement('div');
    // deleteBtn.className = 'feature-box-delete';
    // deleteBtn.textContent = '\u00d7'; // ×
    // deleteBtn.style.position = 'absolute';
    // deleteBtn.style.top = '2px';
    // deleteBtn.style.right = '4px';
    // deleteBtn.style.fontSize = '14px';
    // deleteBtn.style.fontWeight = 'bold';
    // deleteBtn.style.color = 'rgba(255, 140, 100, 0.6)';
    // deleteBtn.style.cursor = 'pointer';
    // deleteBtn.style.lineHeight = '1';
    // deleteBtn.style.userSelect = 'none';
    // deleteBtn.style.opacity = '0';
    // deleteBtn.style.transition = 'opacity 0.15s';
    // deleteBtn.style.padding = '2px 4px';
    // deleteBtn.addEventListener('click', (e) => {
    //     e.stopPropagation();
    //     e.preventDefault();
    //     if (regionIndex === -1) {
    //         deleteStandaloneFeature(featureIndex);
    //         // Dynamic import to avoid circular dependency with spectrogram-renderer
    //         import('./spectrogram-renderer.js').then(mod => mod.redrawAllCanvasFeatureBoxes());
    //         renderStandaloneFeaturesList();
    //         updateCompleteButtonState();
    //         updateCmpltButtonState();
    //     }
    // });
    // boxElement.appendChild(deleteBtn);
    //
    // // Show/hide delete button on hover
    // boxElement.addEventListener('mouseenter', () => { deleteBtn.style.opacity = '1'; deleteBtn.style.color = 'rgba(255, 140, 100, 0.9)'; });
    // boxElement.addEventListener('mouseleave', () => { deleteBtn.style.opacity = '0'; });
    //
    // // Store reference
    // featureBoxes.set(key, boxElement);
}

/**
 * Remove a feature box (called when feature is deleted)
 */
export function removeFeatureBox(regionIndex, featureIndex) {
    // const key = `${regionIndex}-${featureIndex}`;
    //
    // if (featureBoxes.has(key)) {
    //     const box = featureBoxes.get(key);
    //     if (box.parentNode) {
    //         box.remove();
    //     }
    //     featureBoxes.delete(key);
    // }
}

/**
 * Renumber all feature boxes for a region after deletion
 * When feature 2 is deleted from [1,2,3,4,5], features [3,4,5] become [2,3,4]
 */
export function renumberFeatureBoxes(regionIndex) {
    // const regions = getCurrentRegions();
    // const region = regions[regionIndex];
    // if (!region) return;
    //
    // // Build new map with updated keys
    // const newBoxes = new Map();
    //
    // // Iterate through current features in order
    // region.features.forEach((feature, newFeatureIndex) => {
    //     // Try to find this box by checking all possible old indices
    //     let foundBox = null;
    //     let oldKey = null;
    //
    //     // Search through all boxes for this region to find the one that matches
    //     for (let oldIndex = 0; oldIndex < 30; oldIndex++) { // Max 20 features, search a bit wider for safety
    //         const testKey = `${regionIndex}-${oldIndex}`;
    //         if (featureBoxes.has(testKey)) {
    //             foundBox = featureBoxes.get(testKey);
    //             oldKey = testKey;
    //
    //             // Update the number label
    //             const numberLabel = foundBox.querySelector('.feature-box-number');
    //             if (numberLabel) {
    //                 numberLabel.textContent = getFlatFeatureNumber(regionIndex, newFeatureIndex);
    //             }
    //
    //             // Store with new key
    //             const newKey = `${regionIndex}-${newFeatureIndex}`;
    //             newBoxes.set(newKey, foundBox);
    //
    //             // Remove from old map
    //             featureBoxes.delete(testKey);
    //
    //             break;
    //         }
    //     }
    // });
    //
    // // Merge new boxes back into main map
    // newBoxes.forEach((box, key) => {
    //     featureBoxes.set(key, box);
    // });
}

/**
 * Update ALL feature box positions based on their eternal coordinates
 * Called whenever zoom/pan/frequency scale changes
 */
export function updateAllFeatureBoxPositions() {
    // if (!State.dataStartTime || !State.dataEndTime || !zoomState.isInitialized()) {
    //     return;
    // }
    //
    // const canvas = document.getElementById('spectrogram');
    // if (!canvas) return;
    //
    // const container = canvas.closest('.panel');
    // if (!container) return;
    //
    // const canvasRect = canvas.getBoundingClientRect();
    // const containerRect = container.getBoundingClientRect();
    // const canvasWidth = canvas.width;
    // const canvasHeight = canvas.height;
    //
    // const regions = getCurrentRegions();
    //
    // regions.forEach((region, regionIndex) => {
    //     if (!region.features) return;
    //
    //     region.features.forEach((feature, featureIndex) => {
    //         const key = `${regionIndex}-${featureIndex}`;
    //         const box = featureBoxes.get(key);
    //
    //         if (!box) return; // No box for this feature yet
    //
    //         // Check if feature has eternal coordinates
    //         if (!feature.lowFreq || !feature.highFreq || !feature.startTime || !feature.endTime) {
    //             // Feature incomplete - hide box
    //             box.style.display = 'none';
    //             return;
    //         }
    //
    //         // Convert eternal coordinates to current pixel positions
    //         const lowFreq = parseFloat(feature.lowFreq);
    //         const highFreq = parseFloat(feature.highFreq);
    //
    //         // Get original sample rate (same as axis renderer)
    //         const originalSampleRate = State.currentMetadata?.original_sample_rate || 100;
    //         const originalNyquist = originalSampleRate / 2; // 50 Hz for 100 Hz sample rate
    //
    //         // Get current playback rate (CRITICAL for scientific glue!)
    //         const playbackRate = State.currentPlaybackRate || 1.0;
    //
    //         // DEVICE pixels for Y (frequency) - WITH SCALE INTERPOLATION!
    //         // Use exact same interpolation logic as Y-axis ticks during scale transitions
    //         const scaleTransition = getScaleTransitionState();
    //
    //         let lowFreqY_device, highFreqY_device;
    //
    //         if (scaleTransition.inProgress && scaleTransition.oldScaleType) {
    //             // Interpolate between old and new scale positions (like axis ticks!)
    //             const oldLowY = getYPositionForFrequencyScaled(lowFreq, originalNyquist, canvas.height, scaleTransition.oldScaleType, playbackRate);
    //             const newLowY = getYPositionForFrequencyScaled(lowFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
    //             const oldHighY = getYPositionForFrequencyScaled(highFreq, originalNyquist, canvas.height, scaleTransition.oldScaleType, playbackRate);
    //             const newHighY = getYPositionForFrequencyScaled(highFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
    //
    //             lowFreqY_device = oldLowY + (newLowY - oldLowY) * scaleTransition.interpolationFactor;
    //             highFreqY_device = oldHighY + (newHighY - oldHighY) * scaleTransition.interpolationFactor;
    //         } else {
    //             // No transition - use current scale directly
    //             lowFreqY_device = getYPositionForFrequencyScaled(lowFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
    //             highFreqY_device = getYPositionForFrequencyScaled(highFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
    //         }
    //
    //         // Convert device pixels to CSS pixels for DOM positioning
    //         const scaleY = canvas.offsetHeight / canvas.height;
    //         const lowFreqY = lowFreqY_device * scaleY;
    //         const highFreqY = highFreqY_device * scaleY;
    //
    //         // CSS pixels for X (time) - USE ELASTIC INTERPOLATION!
    //         const startTimestamp = new Date(feature.startTime);
    //         const endTimestamp = new Date(feature.endTime);
    //
    //         let startX, endX;
    //         // Use EXACT same interpolated time range as spectrogram elastic stretching!
    //         const interpolatedRange = getInterpolatedTimeRange();
    //         const displayStartMs = interpolatedRange.startTime.getTime();
    //         const displayEndMs = interpolatedRange.endTime.getTime();
    //         const displaySpanMs = displayEndMs - displayStartMs;
    //
    //         const startMs = startTimestamp.getTime();
    //         const endMs = endTimestamp.getTime();
    //
    //         const startProgress = (startMs - displayStartMs) / displaySpanMs;
    //         const endProgress = (endMs - displayStartMs) / displaySpanMs;
    //
    //         startX = startProgress * canvas.offsetWidth;
    //         endX = endProgress * canvas.offsetWidth;
    //
    //         // Check if completely off-screen horizontally (hide)
    //         if (endX < 0 || startX > canvas.offsetWidth) {
    //             box.style.display = 'none';
    //             return;
    //         }
    //
    //         // Check if completely off-screen vertically (hide)
    //         const topY = Math.min(highFreqY, lowFreqY);
    //         const bottomY = Math.max(highFreqY, lowFreqY);
    //         if (bottomY < 0 || topY > canvas.offsetHeight) {
    //             box.style.display = 'none';
    //             return;
    //         }
    //
    //         // Clip to visible viewport
    //         const clippedStartX = Math.max(0, startX);
    //         const clippedEndX = Math.min(canvas.offsetWidth, endX);
    //         const clippedTopY = Math.max(0, topY);
    //         const clippedBottomY = Math.min(canvas.offsetHeight, bottomY);
    //
    //         // Check if box still has dimensions after clipping
    //         if (clippedEndX <= clippedStartX || clippedBottomY <= clippedTopY) {
    //             box.style.display = 'none';
    //             return;
    //         }
    //
    //         // Update DOM position (relative to container)
    //         box.style.display = 'block';
    //
    //         // NO TRANSITION - instant updates every frame, like the axis ticks!
    //         box.style.transition = 'none';
    //
    //         const boxWidth = clippedEndX - clippedStartX;
    //         box.style.left = (canvasRect.left - containerRect.left + clippedStartX) + 'px';
    //         box.style.top = (canvasRect.top - containerRect.top + clippedTopY) + 'px';
    //         box.style.width = boxWidth + 'px';
    //         box.style.height = (clippedBottomY - clippedTopY) + 'px';
    //
    //         // Number label: smoothly slides from centered (narrow) to left-aligned (wide)
    //         const numberLabel = box.querySelector('.feature-box-number');
    //         if (numberLabel) {
    //             const labelWidth = numberLabel.offsetWidth || 10;
    //             const centeredLeft = (boxWidth - labelWidth) / 2;
    //             numberLabel.style.left = Math.min(2, centeredLeft) + 'px';
    //             numberLabel.style.width = 'auto';
    //             numberLabel.style.textAlign = 'left';
    //             // Color: red with glow for 1-10, white 80% for 11+
    //             const flatNum = getFlatFeatureNumber(regionIndex, featureIndex);
    //             const isRed = flatNum <= 10;
    //             numberLabel.style.color = isRed ? 'rgba(255, 80, 80, 0.9)' : 'rgba(255, 255, 255, 0.8)';
    //             numberLabel.style.textShadow = isRed
    //                 ? '0 0 4px rgba(255, 255, 255, 0.3), 1px 1px 2px rgba(0, 0, 0, 0.5)'
    //                 : '0 0 3px rgba(0, 0, 0, 0.8), 1px 1px 2px rgba(0, 0, 0, 0.7)';
    //         }
    //
    //         // Check if this box is currently selected (add glow effect)
    //         const currentSelection = getCurrentFrequencySelection();
    //         const isSelected = currentSelection &&
    //                           currentSelection.regionIndex === regionIndex &&
    //                           currentSelection.featureIndex === featureIndex;
    //
    //         // Choose border color based on selection state
    //         const borderColor = isSelected ? 'rgba(255, 220, 120, 1)' : 'rgba(255, 140, 0, 0.8)';
    //
    //         // Smart border: hide edges that extend beyond viewport
    //         const borderParts = [];
    //         if (clippedTopY > topY) borderParts.push('0');
    //         else borderParts.push(`2px solid ${borderColor}`);
    //
    //         if (clippedEndX < endX) borderParts.push('0');
    //         else borderParts.push(`2px solid ${borderColor}`);
    //
    //         if (clippedBottomY < bottomY) borderParts.push('0');
    //         else borderParts.push(`2px solid ${borderColor}`);
    //
    //         if (clippedStartX > startX) borderParts.push('0');
    //         else borderParts.push(`2px solid ${borderColor}`);
    //
    //         box.style.borderWidth = borderParts.join(' ');
    //
    //         // Apply subtle GLOW effect if selected
    //         if (isSelected) {
    //             box.style.boxShadow = '0 0 10px 2.5px rgba(255, 200, 100, 0.45), inset 0 0 7px rgba(255, 200, 100, 0.25)';
    //             box.style.background = 'rgba(255, 200, 100, 0.24)';
    //         } else {
    //             box.style.boxShadow = 'none';
    //             box.style.background = 'rgba(255, 140, 0, 0.15)';
    //         }
    //     });
    // });
}

/**
 * Get a feature box element by region and feature index
 */
export function getFeatureBox(regionIndex, featureIndex) {
    // const key = `${regionIndex}-${featureIndex}`;
    // return featureBoxes.get(key) || null;
    return null;
}

/**
 * Clear all feature boxes (called when switching volcanoes or loading new data)
 */
export function clearAllFeatureBoxes() {
    // console.log(`🧹 Clearing all ${featureBoxes.size} feature boxes`);
    //
    // featureBoxes.forEach(box => {
    //     if (box.parentNode) {
    //         box.remove();
    //     }
    // });
    //
    // featureBoxes.clear();
}
