/**
 * spectrogram-live-annotations.js
 * Shows feature annotation text above feature boxes during playback
 *
 * KEY: Uses EXACT same coordinate calculation as canvas box rendering
 * (spectrogram-renderer.js drawCanvasFeatureBox), just converts to CSS pixels for DOM
 */

import * as State from './audio-state.js';
import { zoomState } from './zoom-state.js';
import { getStandaloneFeatures } from './feature-tracker.js';
import { getInterpolatedTimeRange } from './minimap-x-axis-renderer.js';
import { getYPositionForFrequencyScaled } from './spectrogram-axis-renderer.js';
import { getHoveredBoxKey } from './spectrogram-renderer.js';

// Container for annotation overlays
let annotationContainer = null;

// Track active annotations
const activeAnnotations = new Map();

// Timing constants (milliseconds)
const FADE_IN_DURATION = 400;
const FADE_OUT_DURATION = 600;
const MIN_DISPLAY_TIME = 3000;
const LEAD_TIME_MS = 1000;

/**
 * Check if live annotation is enabled
 */
export function isLiveAnnotationEnabled() {
    const modeSelect = document.getElementById('annotationMode');
    const mode = modeSelect ? modeSelect.value : 'persistent';
    return mode === 'live' || mode === 'persistent';
}

/**
 * Initialize the annotation container (child of panel, like canvas overlay)
 */
function initAnnotationContainer() {
    if (annotationContainer) return;

    const canvas = document.getElementById('spectrogram');
    if (!canvas) return;

    const container = canvas.closest('.panel');
    if (!container) return;

    annotationContainer = document.createElement('div');
    annotationContainer.id = 'live-annotation-container';
    annotationContainer.style.position = 'absolute';
    annotationContainer.style.pointerEvents = 'none';
    annotationContainer.style.zIndex = '25';
    annotationContainer.style.left = '0';
    annotationContainer.style.top = '0';
    annotationContainer.style.width = '100%';
    annotationContainer.style.height = '100%';
    annotationContainer.style.overflow = 'visible';

    container.appendChild(annotationContainer);
}

/**
 * Create an annotation element
 */
function createAnnotationElement(text, regionIndex, featureIndex) {
    const el = document.createElement('div');
    el.className = 'live-annotation';

    const label = `${regionIndex + 1}.${featureIndex + 1}`;
    el.innerHTML = `<span class="live-annotation-label">${label}</span> ${text}`;

    el.style.position = 'absolute';
    el.style.color = '#fff';
    el.style.fontSize = '13px';
    el.style.fontWeight = '600';
    el.style.lineHeight = '1.3';
    el.style.maxWidth = '250px';
    el.style.textAlign = 'center';
    el.style.textShadow = '0 0 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7), 1px 1px 2px rgba(0,0,0,0.9)';
    el.style.whiteSpace = 'normal';
    el.style.pointerEvents = 'none';
    el.style.opacity = '0';
    el.style.transition = `opacity ${FADE_IN_DURATION}ms ease-out`;

    const labelEl = el.querySelector('.live-annotation-label');
    if (labelEl) {
        labelEl.style.color = '#ffa050';
        labelEl.style.fontWeight = '700';
        labelEl.style.marginRight = '4px';
    }

    return el;
}

/**
 * Get playhead timestamp
 */
function getPlayheadTimestamp() {
    if (!State.totalAudioDuration || State.totalAudioDuration === 0) return null;
    if (!zoomState.isInitialized()) return null;

    const sample = zoomState.timeToSample(State.currentAudioPosition);
    return zoomState.sampleToRealTimestamp(sample);
}

/**
 * Calculate feature box position in CSS pixels
 * EXACTLY like drawCanvasFeatureBox but returns CSS pixel coordinates
 */
function getFeatureBoxPosition(feature, canvas) {
    const lowFreq = parseFloat(feature.lowFreq) || 0;
    const highFreq = parseFloat(feature.highFreq) || 0;
    const startTime = new Date(feature.startTime);
    const endTime = new Date(feature.endTime);

    // Get display time range (same as canvas rendering)
    const interpolatedRange = getInterpolatedTimeRange();
    const displayStartMs = interpolatedRange.startTime.getTime();
    const displayEndMs = interpolatedRange.endTime.getTime();
    const displaySpanMs = displayEndMs - displayStartMs;

    if (displaySpanMs <= 0) return null;

    // X position (same calculation as canvas)
    const startMs = startTime.getTime();
    const endMs = endTime.getTime();
    const startProgress = (startMs - displayStartMs) / displaySpanMs;
    const endProgress = (endMs - displayStartMs) / displaySpanMs;

    // DEVICE pixels (like canvas code)
    const startX_device = startProgress * canvas.width;
    const endX_device = endProgress * canvas.width;

    // Check off-screen
    if (endX_device < 0 || startX_device > canvas.width) return null;

    // Y position (same calculation as canvas)
    const originalSampleRate = State.currentMetadata?.original_sample_rate || 100;
    const originalNyquist = originalSampleRate / 2;
    const playbackRate = State.getPlaybackRate();

    const lowFreqY_device = getYPositionForFrequencyScaled(lowFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
    const highFreqY_device = getYPositionForFrequencyScaled(highFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);

    // Box bounds in DEVICE pixels (same as canvas code)
    const x_device = Math.min(startX_device, endX_device);
    const y_device = Math.min(highFreqY_device, lowFreqY_device);
    const width_device = Math.abs(endX_device - startX_device);
    const midX_device = x_device + width_device / 2;

    // Convert DEVICE pixels to CSS pixels
    const scaleX = canvas.offsetWidth / canvas.width;
    const scaleY = canvas.offsetHeight / canvas.height;

    return {
        topY_css: y_device * scaleY,       // Top of box in CSS pixels
        midX_css: midX_device * scaleX     // Center X in CSS pixels
    };
}

/**
 * Update live annotations
 */
export function updateLiveAnnotations() {
    if (!isLiveAnnotationEnabled()) {
        hideAllAnnotations();
        return;
    }

    if (!annotationContainer) {
        initAnnotationContainer();
    }

    if (!annotationContainer) return;

    const canvas = document.getElementById('spectrogram');
    if (!canvas) return;

    const container = canvas.closest('.panel');
    if (!container) return;

    const playheadTimestamp = getPlayheadTimestamp();
    if (!playheadTimestamp) return;

    const playheadMs = playheadTimestamp.getTime();
    const now = performance.now();

    const canvasRect = canvas.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    const features = getStandaloneFeatures();

    // Debug on first run
    if (!window._liveAnnotationDebugLogged) {
        console.log('📝 Live annotation checking standalone features:', features.length);
        window._liveAnnotationDebugLogged = true;
    }

    features.forEach((feature, featureIndex) => {
        const key = `-1-${featureIndex}`;

        if (!feature.notes || !feature.notes.trim()) return;
        if (!feature.startTime || !feature.endTime) return;

        const featureStartMs = new Date(feature.startTime).getTime();
        const featureEndMs = new Date(feature.endTime).getTime();

        const timeUntilFeature = featureStartMs - playheadMs;
        const playbackRate = State.getPlaybackRate();
        const scaledLeadTime = LEAD_TIME_MS * playbackRate;

        const shouldShow = timeUntilFeature <= scaledLeadTime && timeUntilFeature > -(featureEndMs - featureStartMs);

        const existingAnnotation = activeAnnotations.get(key);

        if (shouldShow && !existingAnnotation) {
            // Get box position using EXACT same math as canvas rendering
            const boxPos = getFeatureBoxPosition(feature, canvas);
            if (!boxPos) return;

            const element = createAnnotationElement(feature.notes.trim(), -1, featureIndex);
            annotationContainer.appendChild(element);

            // Position in container coordinates
            const leftInContainer = (canvasRect.left - containerRect.left) + boxPos.midX_css;
            const topInContainer = (canvasRect.top - containerRect.top) + boxPos.topY_css;

            // Position ABOVE the box
            element.style.left = leftInContainer + 'px';
            element.style.top = (topInContainer - 40) + 'px';
            element.style.transform = 'translateX(-50%)';
            element.style.opacity = '1';

            activeAnnotations.set(key, {
                element,
                showTime: now,
                hideTime: null,
                state: 'fading-in',
                featureStartMs,
                featureEndMs,
                feature,
                initialTopInContainer: topInContainer
            });

        } else if (existingAnnotation) {
            const { element, showTime, state, feature: feat } = existingAnnotation;

            // Update position (for zoom/pan)
            const boxPos = getFeatureBoxPosition(feat, canvas);
            if (boxPos) {
                const leftInContainer = (canvasRect.left - containerRect.left) + boxPos.midX_css;
                const topInContainer = (canvasRect.top - containerRect.top) + boxPos.topY_css;

                element.style.left = (leftInContainer + 300) + 'px';
                element.style.top = (topInContainer - 20) + 'px';
            }

            // Handle fade out
            const timeSinceShow = now - showTime;
            const playheadPastFeature = playheadMs > featureEndMs;

            if ((state === 'fading-in' || state === 'visible') && timeSinceShow > FADE_IN_DURATION) {
                existingAnnotation.state = 'visible';
            }

            if (state !== 'fading-out' && timeSinceShow > MIN_DISPLAY_TIME && playheadPastFeature) {
                existingAnnotation.state = 'fading-out';
                existingAnnotation.hideTime = now;
                element.style.transition = `opacity ${FADE_OUT_DURATION}ms ease-in`;
                element.style.opacity = '0';
            }

            if (state === 'fading-out' && existingAnnotation.hideTime) {
                if (now - existingAnnotation.hideTime > FADE_OUT_DURATION) {
                    element.remove();
                    activeAnnotations.delete(key);
                }
            }
        }
    });
}

function hideAllAnnotations() {
    activeAnnotations.forEach(({ element }) => {
        if (element.parentNode) element.remove();
    });
    activeAnnotations.clear();
}

export function resetLiveAnnotations() {
    hideAllAnnotations();
    window._liveAnnotationDebugLogged = false;
    window._canvasBoxDebugLogged = {};  // Reset canvas debug too
}
