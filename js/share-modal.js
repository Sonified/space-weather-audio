/**
 * Share Modal
 * UI for sharing space weather analysis sessions
 */

import * as ShareAPI from './share-api.js';
import * as State from './audio-state.js';
import { getRegions } from './region-tracker.js';
import { zoomState } from './zoom-state.js';
import { getParticipantId } from './qualtrics-api.js';
import { getCurrentColormap } from './colormaps.js';
import { updateDatasetOptions } from './ui-controls.js';

/**
 * Render x-axis with larger labels for thumbnail
 * @param {number} width - Canvas width
 * @param {number} height - Canvas height
 * @param {number} fontScale - Font scale multiplier (e.g., 1.5 for 50% larger)
 * @returns {HTMLCanvasElement} Canvas with rendered x-axis
 */
function renderXAxisForThumbnail(width, height, fontScale = 1.5) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    // Get time range
    let displayStartTime, displayEndTime;
    if (zoomState.isInRegion()) {
        const regionRange = zoomState.getRegionRange();
        displayStartTime = regionRange.startTime;
        displayEndTime = regionRange.endTime;
    } else {
        displayStartTime = State.dataStartTime;
        displayEndTime = State.dataEndTime;
    }

    if (!displayStartTime || !displayEndTime) return canvas;

    const startTimeUTC = new Date(displayStartTime);
    const endTimeUTC = new Date(displayEndTime);
    const actualTimeSpanSeconds = (endTimeUTC.getTime() - startTimeUTC.getTime()) / 1000;

    if (!isFinite(actualTimeSpanSeconds) || actualTimeSpanSeconds <= 0) return canvas;

    // Styling - larger font for thumbnail
    const baseFontSize = 16;
    const fontSize = Math.round(baseFontSize * fontScale);
    ctx.font = `${fontSize}px Arial, sans-serif`;
    ctx.fillStyle = '#ddd';
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    // Calculate ticks based on time span
    const timeSpanHours = actualTimeSpanSeconds / 3600;
    const ticks = calculateTicksForThumbnail(startTimeUTC, endTimeUTC, timeSpanHours);

    // Draw ticks
    ticks.forEach(tick => {
        const timeOffsetSeconds = (tick.utcTime.getTime() - startTimeUTC.getTime()) / 1000;
        const x = (timeOffsetSeconds / actualTimeSpanSeconds) * width;

        if (x < -10 || x > width + 10) return;

        // Draw tick line
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, Math.round(8 * fontScale));
        ctx.stroke();

        // Format label
        let label;
        if (tick.isDayCrossing) {
            const utcMonth = tick.utcTime.getUTCMonth() + 1;
            const utcDay = tick.utcTime.getUTCDate();
            label = `${utcMonth}/${utcDay}`;
            ctx.font = `bold ${fontSize}px Arial, sans-serif`;
        } else {
            const utcHours = tick.utcTime.getUTCHours();
            const utcMinutes = tick.utcTime.getUTCMinutes();
            label = utcHours === 0 && utcMinutes === 0 ? '0:00' :
                    `${utcHours}:${String(utcMinutes).padStart(2, '0')}`;
            ctx.font = `${fontSize}px Arial, sans-serif`;
        }

        ctx.fillText(label, x, Math.round(10 * fontScale));
    });

    return canvas;
}

/**
 * Calculate ticks for thumbnail (simplified version)
 * Aims for ~6-12 ticks for clean thumbnail appearance
 */
function calculateTicksForThumbnail(startUTC, endUTC, timeSpanHours) {
    const ticks = [];
    let intervalMs;

    // Choose interval based on time span (aim for ~6-12 ticks on thumbnail)
    if (timeSpanHours <= 1/3) intervalMs = 60 * 1000;            // 1 minute
    else if (timeSpanHours <= 2) intervalMs = 15 * 60 * 1000;    // 15 minutes (~8 ticks max)
    else if (timeSpanHours <= 6) intervalMs = 60 * 60 * 1000;    // 1 hour (~6 ticks max)
    else if (timeSpanHours <= 24) intervalMs = 2 * 60 * 60 * 1000; // 2 hours (~12 ticks max)
    else intervalMs = 6 * 60 * 60 * 1000;                        // 6 hours for >24h

    // Find first tick boundary
    const startMs = startUTC.getTime();
    const firstTickMs = Math.ceil(startMs / intervalMs) * intervalMs;

    let currentMs = firstTickMs;
    let previousDate = null;

    while (currentMs <= endUTC.getTime()) {
        const tickTime = new Date(currentMs);
        const currentDate = tickTime.toISOString().split('T')[0];
        const utcHours = tickTime.getUTCHours();
        const utcMinutes = tickTime.getUTCMinutes();

        const isDayCrossing = (previousDate !== null && previousDate !== currentDate) ||
                              (utcHours === 0 && utcMinutes === 0);

        if (currentMs >= startMs) {
            ticks.push({ utcTime: tickTime, isDayCrossing });
        }

        previousDate = currentDate;
        currentMs += intervalMs;
    }

    return ticks;
}

let shareModal = null;
let isSharing = false;
let currentSessionId = null;  // Track the current session ID
let slugCheckTimeout = null;  // Debounce for slug availability check
let capturedThumbnailDataUrl = null;  // Store captured thumbnail for upload

// Emoji overlay state - supports multiple emojis
let emojiOverlays = [];  // Array of {emoji, x, y, scale, rotation}
let selectedEmojiIndex = -1;  // Which emoji is selected (-1 = none)
let emojiDragState = {
    dragging: false,
    resizing: false,
    rotating: false,
    dragStart: null,     // {mouseX, mouseY, emojiX, emojiY, scale, rotation, cx, cy}
};
let thumbnailImage = null;  // Store the base thumbnail image

// Word lists for generating share slugs
const ADJECTIVES = [
    'awesome', 'amazing', 'incredible', 'remarkable', 'astounding',
    'spectacular', 'phenomenal', 'extraordinary', 'magnificent', 'brilliant',
    'stunning', 'fantastic', 'marvelous', 'wonderful', 'outstanding',
    'exceptional', 'impressive', 'sensational', 'striking', 'sublime',
    'superb', 'glorious', 'epic', 'legendary', 'majestic',
    'miraculous', 'astonishing', 'dazzling', 'splendid', 'grand',
    'noble', 'radiant', 'luminous', 'transcendent', 'profound',
    'powerful', 'captivating', 'enchanting', 'mesmerizing',
    'wondrous', 'vivid', 'vibrant'
];

const NOUNS = [
    'feature', 'region', 'observation', 'finding', 'discovery',
    'event', 'phenomenon', 'activity', 'analysis', 'structure',
    'detection', 'signature', 'occurrence', 'segment', 'insight',
    'moment', 'example', 'highlight', 'selection'
];

// Awkward pairings to avoid (adjective -> noun)
const BAD_PAIRINGS = {
    'phenomenal': ['phenomenon']
};

// localStorage keys for tracking used words
const USED_ADJ_KEY = 'space_weather_used_adjectives';
const USED_NOUN_KEY = 'space_weather_used_nouns';

/**
 * Get remaining (unused) words from a list
 * @param {string[]} fullList - The complete word list
 * @param {string} storageKey - localStorage key for tracking used words
 * @returns {string[]} Array of unused words
 */
function getRemainingWords(fullList, storageKey) {
    try {
        const used = JSON.parse(localStorage.getItem(storageKey) || '[]');
        const remaining = fullList.filter(word => !used.includes(word));
        // If all words used, reset and return full list
        if (remaining.length === 0) {
            localStorage.removeItem(storageKey);
            return [...fullList];
        }
        return remaining;
    } catch (e) {
        return [...fullList];
    }
}

/**
 * Mark a word as used
 * @param {string} word - The word to mark as used
 * @param {string} storageKey - localStorage key for tracking used words
 */
function markWordUsed(word, storageKey) {
    try {
        const used = JSON.parse(localStorage.getItem(storageKey) || '[]');
        used.push(word);
        localStorage.setItem(storageKey, JSON.stringify(used));
    } catch (e) {
        // Ignore storage errors
    }
}

/**
 * Pick a random adjective-noun pair, avoiding bad pairings
 * Uses localStorage to cycle through all words before repeating
 */
function pickAdjectiveNoun() {
    let adjective, noun;
    let attempts = 0;

    // Get remaining pools
    let remainingAdj = getRemainingWords(ADJECTIVES, USED_ADJ_KEY);
    let remainingNoun = getRemainingWords(NOUNS, USED_NOUN_KEY);

    do {
        adjective = remainingAdj[Math.floor(Math.random() * remainingAdj.length)];
        noun = remainingNoun[Math.floor(Math.random() * remainingNoun.length)];
        attempts++;

        // If we hit a bad pairing, try removing that adjective from consideration
        if (BAD_PAIRINGS[adjective]?.includes(noun) && attempts < 10) {
            remainingAdj = remainingAdj.filter(a => a !== adjective);
            if (remainingAdj.length === 0) remainingAdj = getRemainingWords(ADJECTIVES, USED_ADJ_KEY);
        }
    } while (BAD_PAIRINGS[adjective]?.includes(noun) && attempts < 10);

    // Mark these words as used
    markWordUsed(adjective, USED_ADJ_KEY);
    markWordUsed(noun, USED_NOUN_KEY);

    return { adjective, noun };
}

/**
 * Capture the spectrogram canvas as an optimized thumbnail image
 * Combines main spectrogram with axis labels, resizes for efficient transfer
 * Target: ~50-150KB JPEG instead of multi-MB PNG
 * @returns {string|null} Data URL of the thumbnail JPEG, or null if capture fails
 */
function captureSpectrogramThumbnail() {
    const spectrogramCanvas = document.getElementById('spectrogram');
    const axisCanvas = document.getElementById('spectrogram-axis');

    if (!spectrogramCanvas) {
        console.warn('Spectrogram canvas not found');
        return null;
    }

    try {
        // Calculate source dimensions
        const axisWidth = axisCanvas ? axisCanvas.width : 0;
        const sourceWidth = spectrogramCanvas.width + axisWidth;

        // Target width for social media previews
        // 1200px is the recommended OG image width for Twitter/Facebook
        const targetWidth = 1200;
        const scale = targetWidth / sourceWidth;
        const scaledSpectrogramHeight = Math.round(spectrogramCanvas.height * scale);

        // Make y-axis narrower (60% of scaled width) to avoid dominating the thumbnail
        const scaledAxisWidth = axisCanvas ? Math.round(axisWidth * scale * 0.6) : 0;
        const spectrogramW = targetWidth - scaledAxisWidth;

        // Render x-axis with 1.5x larger labels for thumbnail readability
        const xAxisFontScale = 1.5;
        const xAxisRenderHeight = Math.round(40 * xAxisFontScale);  // Full render height
        const xAxisDisplayHeight = Math.round(xAxisRenderHeight * 0.8);  // Clip bottom 20%
        const thumbnailXAxis = renderXAxisForThumbnail(spectrogramW, xAxisRenderHeight, xAxisFontScale);

        const targetHeight = scaledSpectrogramHeight + xAxisDisplayHeight;

        // Create combined canvas at reduced size
        const thumbnailCanvas = document.createElement('canvas');
        const ctx = thumbnailCanvas.getContext('2d');
        thumbnailCanvas.width = targetWidth;
        thumbnailCanvas.height = targetHeight;

        // Enable image smoothing for better downscaling
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        // Fill background (dark theme)
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, targetWidth, targetHeight);

        // Draw main spectrogram on the left (top portion)
        ctx.drawImage(spectrogramCanvas, 0, 0, spectrogramW, scaledSpectrogramHeight);

        // Draw feature boxes overlay (if any boxes are drawn)
        const overlayCanvas = document.getElementById('spectrogram-selection-overlay');
        if (overlayCanvas) {
            ctx.drawImage(overlayCanvas, 0, 0, spectrogramW, scaledSpectrogramHeight);
        }

        // Draw y-axis on the right side (clip from left, ticks are on the left side)
        if (axisCanvas) {
            // Use 9-arg drawImage to clip: take left 60% of source, draw at full scale
            const sourceClipWidth = Math.round(axisWidth * 0.6);
            ctx.drawImage(
                axisCanvas,
                0, 0, sourceClipWidth, axisCanvas.height,  // source: left portion only
                spectrogramW, 0, scaledAxisWidth, scaledSpectrogramHeight  // dest: right side of thumbnail
            );
        }

        // Draw x-axis at the bottom (rendered with larger labels, clipped to top 80%)
        ctx.drawImage(
            thumbnailXAxis,
            0, 0, spectrogramW, xAxisDisplayHeight,  // source: top portion only
            0, scaledSpectrogramHeight, spectrogramW, xAxisDisplayHeight  // dest: bottom of thumbnail
        );

        // Convert to JPEG at 70% quality - great for social media, small file size
        // Spectrograms are gradient-heavy, JPEG handles them well
        const dataUrl = thumbnailCanvas.toDataURL('image/jpeg', 0.70);

        // Log the approximate size for debugging
        const approxSizeKB = Math.round((dataUrl.length * 0.75) / 1024);
        console.log(`Thumbnail captured: ${targetWidth}x${targetHeight}, ~${approxSizeKB}KB`);

        return dataUrl;
    } catch (error) {
        console.error('Failed to capture spectrogram thumbnail:', error);
        return null;
    }
}

/**
 * Display thumbnail preview in the share modal
 */
function updateThumbnailPreview() {
    const thumbnailCanvas = document.getElementById('shareThumbnail');
    if (!thumbnailCanvas) return;

    capturedThumbnailDataUrl = captureSpectrogramThumbnail();

    if (capturedThumbnailDataUrl) {
        const img = new Image();
        img.onload = () => {
            // Size the canvas to match aspect ratio
            const aspectRatio = img.width / img.height;
            const displayWidth = 652;  // Modal content width minus padding
            const displayHeight = displayWidth / aspectRatio;

            thumbnailCanvas.width = img.width;
            thumbnailCanvas.height = img.height;
            thumbnailCanvas.style.height = `${displayHeight}px`;

            // Store the base image for re-rendering with emoji
            thumbnailImage = img;

            const ctx = thumbnailCanvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
        };
        img.src = capturedThumbnailDataUrl;
    }
}

/**
 * Draw a thick red arrow (custom shape, not an emoji)
 * Arrow points to the right by default, rotation is applied by caller
 */
function drawRedArrow(ctx, size) {
    const w = size * 0.9;  // Arrow width
    const h = size * 0.5;  // Arrow body height
    const headW = size * 0.4;  // Arrow head extra width

    ctx.beginPath();
    // Start at left middle, go clockwise
    ctx.moveTo(-w/2, -h/4);           // Left top of body
    ctx.lineTo(w/2 - headW, -h/4);    // Right top of body (before head)
    ctx.lineTo(w/2 - headW, -h/2);    // Top of arrow head
    ctx.lineTo(w/2, 0);               // Arrow tip
    ctx.lineTo(w/2 - headW, h/2);     // Bottom of arrow head
    ctx.lineTo(w/2 - headW, h/4);     // Right bottom of body
    ctx.lineTo(-w/2, h/4);            // Left bottom of body
    ctx.closePath();

    // Red fill with dark outline
    ctx.fillStyle = '#e53935';
    ctx.fill();
    ctx.strokeStyle = '#b71c1c';
    ctx.lineWidth = size * 0.03;
    ctx.stroke();
}

/**
 * Get emoji bounding box in canvas coordinates
 */
function getEmojiBounds(canvas, emojiObj) {
    const baseSize = Math.min(canvas.width, canvas.height) * 0.15;
    const size = baseSize * emojiObj.scale;
    const cx = emojiObj.x * canvas.width;
    const cy = emojiObj.y * canvas.height;
    return { cx, cy, size, halfSize: size / 2 };
}

/**
 * Get handle positions for the emoji (corners + rotation)
 */
function getHandlePositions(canvas, emojiObj) {
    const { cx, cy, halfSize } = getEmojiBounds(canvas, emojiObj);
    const handleSize = 12;
    const cos = Math.cos(emojiObj.rotation);
    const sin = Math.sin(emojiObj.rotation);

    // Rotate corner offsets
    const corners = [
        { dx: -halfSize, dy: -halfSize, cursor: 'nw-resize', corner: 'tl' },
        { dx: halfSize, dy: -halfSize, cursor: 'ne-resize', corner: 'tr' },
        { dx: halfSize, dy: halfSize, cursor: 'se-resize', corner: 'br' },
        { dx: -halfSize, dy: halfSize, cursor: 'sw-resize', corner: 'bl' },
    ].map(c => ({
        x: cx + c.dx * cos - c.dy * sin,
        y: cy + c.dx * sin + c.dy * cos,
        cursor: c.cursor,
        corner: c.corner,
        size: handleSize
    }));

    // Rotation handle (above the emoji)
    const rotateOffset = halfSize + 30;
    const rotateHandle = {
        x: cx + rotateOffset * sin,
        y: cy - rotateOffset * cos,
        cursor: 'grab',
        type: 'rotate',
        size: 16
    };

    return { corners, rotateHandle };
}

/**
 * Render the thumbnail with emoji overlay
 */
function renderThumbnailWithEmoji() {
    const canvas = document.getElementById('shareThumbnail');
    if (!canvas || !thumbnailImage) return;

    const ctx = canvas.getContext('2d');

    // Draw base image
    ctx.drawImage(thumbnailImage, 0, 0);

    // If no emojis, we're done
    if (emojiOverlays.length === 0) {
        capturedThumbnailDataUrl = canvas.toDataURL('image/jpeg', 0.70);
        return;
    }

    // Draw all emojis
    emojiOverlays.forEach((emojiObj, index) => {
        const { cx, cy, size } = getEmojiBounds(canvas, emojiObj);

        // Draw emoji or custom shape
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(emojiObj.rotation);
        if (emojiObj.emoji === '__arrow__') {
            drawRedArrow(ctx, size);
        } else {
            ctx.font = `${size}px Arial`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(emojiObj.emoji, 0, 0);
        }
        ctx.restore();

        // Draw selection UI only for selected emoji
        if (index === selectedEmojiIndex) {
            const handles = getHandlePositions(canvas, emojiObj);
            const halfSize = size / 2;

            // Bounding box
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(emojiObj.rotation);
            ctx.strokeStyle = 'rgba(102, 126, 234, 0.8)';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            ctx.strokeRect(-halfSize, -halfSize, size, size);
            ctx.setLineDash([]);
            ctx.restore();

            // Corner handles
            handles.corners.forEach(h => {
                ctx.fillStyle = 'rgba(102, 126, 234, 0.9)';
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.fillRect(h.x - h.size/2, h.y - h.size/2, h.size, h.size);
                ctx.strokeRect(h.x - h.size/2, h.y - h.size/2, h.size, h.size);
            });

            // Rotation handle
            const rh = handles.rotateHandle;
            ctx.beginPath();
            ctx.arc(rh.x, rh.y, rh.size/2, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(118, 75, 162, 0.9)';
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.stroke();

            // Rotation icon
            ctx.save();
            ctx.translate(rh.x, rh.y);
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(0, 0, 5, -Math.PI * 0.7, Math.PI * 0.5);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(3, 4);
            ctx.lineTo(5, 7);
            ctx.lineTo(7, 3);
            ctx.stroke();
            ctx.restore();

            // Line to rotation handle
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(102, 126, 234, 0.5)';
            ctx.lineWidth = 1;
            const topCx = cx + halfSize * Math.sin(emojiObj.rotation);
            const topCy = cy - halfSize * Math.cos(emojiObj.rotation);
            ctx.moveTo(topCx, topCy);
            ctx.lineTo(rh.x, rh.y);
            ctx.stroke();
        }
    });

    // Update captured data URL for sharing (render without handles)
    updateCapturedThumbnail();
}

/**
 * Update the captured thumbnail data URL (without handles, for sharing)
 */
function updateCapturedThumbnail() {
    if (!thumbnailImage || emojiOverlays.length === 0) {
        return;
    }

    // Create a temporary canvas to render without handles
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = thumbnailImage.width;
    tempCanvas.height = thumbnailImage.height;
    const ctx = tempCanvas.getContext('2d');

    // Draw base image
    ctx.drawImage(thumbnailImage, 0, 0);

    // Draw all emojis (without handles)
    emojiOverlays.forEach(emojiObj => {
        const { cx, cy, size } = getEmojiBounds(tempCanvas, emojiObj);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(emojiObj.rotation);
        if (emojiObj.emoji === '__arrow__') {
            drawRedArrow(ctx, size);
        } else {
            ctx.font = `${size}px Arial`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(emojiObj.emoji, 0, 0);
        }
        ctx.restore();
    });

    capturedThumbnailDataUrl = tempCanvas.toDataURL('image/jpeg', 0.70);
}

/**
 * Hit test: what did the user click on?
 * Returns { type, index } or null
 */
function hitTest(canvas, mouseX, mouseY) {
    // First check handles of selected emoji (if any)
    if (selectedEmojiIndex >= 0 && selectedEmojiIndex < emojiOverlays.length) {
        const emojiObj = emojiOverlays[selectedEmojiIndex];
        const handles = getHandlePositions(canvas, emojiObj);

        // Check rotation handle
        const rh = handles.rotateHandle;
        const rdist = Math.hypot(mouseX - rh.x, mouseY - rh.y);
        if (rdist <= rh.size) {
            return { type: 'rotate', index: selectedEmojiIndex };
        }

        // Check corner handles
        for (const h of handles.corners) {
            if (mouseX >= h.x - h.size/2 && mouseX <= h.x + h.size/2 &&
                mouseY >= h.y - h.size/2 && mouseY <= h.y + h.size/2) {
                return { type: 'resize', corner: h.corner, index: selectedEmojiIndex };
            }
        }
    }

    // Check all emoji bodies (in reverse order so topmost is checked first)
    for (let i = emojiOverlays.length - 1; i >= 0; i--) {
        const emojiObj = emojiOverlays[i];
        const { cx, cy, halfSize } = getEmojiBounds(canvas, emojiObj);

        // Transform mouse to emoji-local coordinates
        const dx = mouseX - cx;
        const dy = mouseY - cy;
        const cos = Math.cos(-emojiObj.rotation);
        const sin = Math.sin(-emojiObj.rotation);
        const localX = dx * cos - dy * sin;
        const localY = dx * sin + dy * cos;

        if (Math.abs(localX) <= halfSize && Math.abs(localY) <= halfSize) {
            return { type: 'move', index: i };
        }
    }

    return null;
}

/**
 * Get mouse position relative to canvas (in canvas coordinates)
 */
function getCanvasMousePos(canvas, event) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
        x: (event.clientX - rect.left) * scaleX,
        y: (event.clientY - rect.top) * scaleY
    };
}

/**
 * Handle emoji picker selection - adds a new emoji
 */
function handleEmojiSelect(emoji) {
    // Add new emoji at center (with slight offset if there are already emojis)
    const offset = emojiOverlays.length * 0.05;
    const newEmoji = {
        emoji: emoji,
        x: 0.5 + offset,
        y: 0.5 + offset,
        scale: 1,
        rotation: 0
    };

    emojiOverlays.push(newEmoji);
    selectedEmojiIndex = emojiOverlays.length - 1;

    // Show hint
    const hint = document.getElementById('emojiHint');
    if (hint) hint.style.display = 'block';

    // Update canvas cursor
    const canvas = document.getElementById('shareThumbnail');
    if (canvas) canvas.style.cursor = 'move';

    renderThumbnailWithEmoji();
}

/**
 * Delete the currently selected emoji
 */
function deleteSelectedEmoji() {
    if (selectedEmojiIndex >= 0 && selectedEmojiIndex < emojiOverlays.length) {
        emojiOverlays.splice(selectedEmojiIndex, 1);
        selectedEmojiIndex = -1;

        // Hide hint if no emojis left
        const hint = document.getElementById('emojiHint');
        if (hint && emojiOverlays.length === 0) hint.style.display = 'none';

        renderThumbnailWithEmoji();
    }
}

/**
 * Setup canvas interaction handlers
 */
function setupCanvasInteraction() {
    const canvas = document.getElementById('shareThumbnail');
    if (!canvas) return;

    canvas.addEventListener('mousedown', (e) => {
        const pos = getCanvasMousePos(canvas, e);
        const hit = hitTest(canvas, pos.x, pos.y);

        if (!hit) {
            // Clicked outside all emojis - deselect
            if (selectedEmojiIndex >= 0) {
                selectedEmojiIndex = -1;
                renderThumbnailWithEmoji();
            }
            return;
        }

        e.preventDefault();

        // Select the emoji that was hit
        selectedEmojiIndex = hit.index;
        const emojiObj = emojiOverlays[selectedEmojiIndex];
        const { cx, cy } = getEmojiBounds(canvas, emojiObj);

        emojiDragState.dragStart = {
            mouseX: pos.x,
            mouseY: pos.y,
            emojiX: emojiObj.x,
            emojiY: emojiObj.y,
            scale: emojiObj.scale,
            rotation: emojiObj.rotation,
            cx, cy
        };

        if (hit.type === 'move') {
            emojiDragState.dragging = true;
            canvas.style.cursor = 'grabbing';
        } else if (hit.type === 'resize') {
            emojiDragState.resizing = true;
        } else if (hit.type === 'rotate') {
            emojiDragState.rotating = true;
            canvas.style.cursor = 'grabbing';
        }

        renderThumbnailWithEmoji();
    });

    canvas.addEventListener('mousemove', (e) => {
        const pos = getCanvasMousePos(canvas, e);

        if (selectedEmojiIndex < 0 || selectedEmojiIndex >= emojiOverlays.length) {
            // Update cursor based on what's under mouse
            const hit = hitTest(canvas, pos.x, pos.y);
            canvas.style.cursor = hit ? 'pointer' : 'default';
            return;
        }

        const emojiObj = emojiOverlays[selectedEmojiIndex];

        if (emojiDragState.dragging && emojiDragState.dragStart) {
            // Move emoji
            const dx = pos.x - emojiDragState.dragStart.mouseX;
            const dy = pos.y - emojiDragState.dragStart.mouseY;
            emojiObj.x = emojiDragState.dragStart.emojiX + dx / canvas.width;
            emojiObj.y = emojiDragState.dragStart.emojiY + dy / canvas.height;

            // Clamp to canvas bounds
            emojiObj.x = Math.max(0.1, Math.min(0.9, emojiObj.x));
            emojiObj.y = Math.max(0.1, Math.min(0.9, emojiObj.y));

            renderThumbnailWithEmoji();
        } else if (emojiDragState.resizing && emojiDragState.dragStart) {
            // Resize emoji based on distance from center
            const { cx, cy } = emojiDragState.dragStart;
            const startDist = Math.hypot(
                emojiDragState.dragStart.mouseX - cx,
                emojiDragState.dragStart.mouseY - cy
            );
            const currentDist = Math.hypot(pos.x - cx, pos.y - cy);

            if (startDist > 0) {
                const scaleFactor = currentDist / startDist;
                emojiObj.scale = Math.max(0.2, Math.min(6, emojiDragState.dragStart.scale * scaleFactor));
                renderThumbnailWithEmoji();
            }
        } else if (emojiDragState.rotating && emojiDragState.dragStart) {
            // Rotate emoji based on angle from center
            const { cx, cy } = emojiDragState.dragStart;
            const startAngle = Math.atan2(
                emojiDragState.dragStart.mouseY - cy,
                emojiDragState.dragStart.mouseX - cx
            );
            const currentAngle = Math.atan2(pos.y - cy, pos.x - cx);

            emojiObj.rotation = emojiDragState.dragStart.rotation + (currentAngle - startAngle);
            renderThumbnailWithEmoji();
        } else {
            // Update cursor based on what's under mouse
            const hit = hitTest(canvas, pos.x, pos.y);
            if (hit) {
                if (hit.type === 'rotate') canvas.style.cursor = 'grab';
                else if (hit.type === 'resize') canvas.style.cursor = 'nwse-resize';
                else canvas.style.cursor = 'move';
            } else {
                canvas.style.cursor = 'default';
            }
        }
    });

    const handleMouseUp = () => {
        emojiDragState.dragging = false;
        emojiDragState.resizing = false;
        emojiDragState.rotating = false;
        emojiDragState.dragStart = null;

        if (selectedEmojiIndex >= 0) {
            canvas.style.cursor = 'move';
        }
    };

    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mouseleave', handleMouseUp);

    // Delete key removes selected emoji
    document.addEventListener('keydown', (e) => {
        if ((e.key === 'Delete' || e.key === 'Backspace') &&
            selectedEmojiIndex >= 0 &&
            shareModal?.style.display !== 'none' &&
            !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
            e.preventDefault();
            deleteSelectedEmoji();
        }
    });
}

/**
 * Format date as YYYYMMDD-HHMM (URL-safe)
 */
function formatDateCompact(date) {
    if (!date) return null;
    const d = new Date(date);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const hours = String(d.getUTCHours()).padStart(2, '0');
    const mins = String(d.getUTCMinutes()).padStart(2, '0');
    return `${year}${month}${day}-${hours}${mins}`;
}

/**
 * Generate a default share slug
 * Format: username-adjective-noun-spacecraft-YYYYMMDD-HHMM-to-YYYYMMDD-HHMM
 */
function generateDefaultSlug() {
    const username = getParticipantId() || 'user';
    const { adjective, noun } = pickAdjectiveNoun();
    const spacecraft = (State.currentMetadata?.spacecraft || 'data').toLowerCase();

    // Sanitize username for slug (lowercase, alphanumeric + hyphens only)
    const cleanUsername = username.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 15);
    const cleanSpacecraft = spacecraft.replace(/[^a-z0-9-]/g, '').slice(0, 10);

    // Get date range if available
    const startDate = formatDateCompact(State.dataStartTime);
    const endDate = formatDateCompact(State.dataEndTime);

    if (startDate && endDate) {
        return `${cleanUsername}-${adjective}-${noun}-${cleanSpacecraft}-${startDate}-to-${endDate}`;
    } else {
        // Fallback to year if no date range
        const year = new Date().getFullYear();
        return `${cleanUsername}-${adjective}-${noun}-${cleanSpacecraft}-${year}`;
    }
}

/**
 * Create the share modal DOM element
 */
function createShareModal() {
    const modal = document.createElement('div');
    modal.id = 'shareModal';
    modal.style.cssText = 'display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 10000; align-items: center; justify-content: center;';
    modal.innerHTML = `
        <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #1a1a2e 100%); border-radius: 16px; width: 700px; max-width: 90vw; box-shadow: 0 20px 60px rgba(102, 126, 234, 0.3), 0 0 40px rgba(118, 75, 162, 0.2); border: 1px solid rgba(102, 126, 234, 0.3);">
            <div style="padding: 20px 24px; border-bottom: 1px solid rgba(102, 126, 234, 0.2); display: flex; justify-content: space-between; align-items: center;">
                <h3 style="margin: 0; color: #fff; font-size: 20px; font-weight: 600; display: flex; align-items: center; gap: 10px;">
                    <span style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Share Analysis</span>
                </h3>
                <button type="button" id="closeShareModal" style="width: 32px; height: 32px; background: rgba(255,255,255,0.1); border: none; border-radius: 50%; font-size: 20px; cursor: pointer; color: #888; display: flex; align-items: center; justify-content: center; transition: background 0.2s;">&times;</button>
            </div>
            <div id="shareModalBody" style="padding: 24px;">
                <!-- Form View -->
                <div id="shareFormView">
                    <!-- Thumbnail Preview -->
                    <div style="margin-bottom: 20px;">
                        <label style="display: block; margin-bottom: 10px; font-weight: 600; color: #ccc; font-size: 14px;">Preview Thumbnail</label>
                        <div id="thumbnailPreview" style="background: rgba(0,0,0,0.3); border-radius: 10px; overflow: hidden; border: 1px solid rgba(102, 126, 234, 0.2);">
                            <canvas id="shareThumbnail" style="width: 100%; display: block;"></canvas>
                        </div>
                        <div style="margin-top: 6px; font-size: 12px; color: #666;">This image will appear when sharing on social media</div>
                        <!-- Emoji Picker -->
                        <div style="margin-top: 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                            <span style="font-size: 12px; color: #888;">Add emoji:</span>
                            <div id="emojiPicker" style="display: flex; gap: 4px;">
                                <button type="button" class="emoji-btn" data-emoji="😱" style="width: 32px; height: 32px; border-radius: 6px; border: 2px solid transparent; background: rgba(255,255,255,0.05); cursor: pointer; font-size: 18px;">😱</button>
                                <button type="button" class="emoji-btn" data-emoji="🤯" style="width: 32px; height: 32px; border-radius: 6px; border: 2px solid transparent; background: rgba(255,255,255,0.05); cursor: pointer; font-size: 18px;">🤯</button>
                                <button type="button" class="emoji-btn" data-emoji="🙀" style="width: 32px; height: 32px; border-radius: 6px; border: 2px solid transparent; background: rgba(255,255,255,0.05); cursor: pointer; font-size: 18px;">🙀</button>
                                <button type="button" class="emoji-btn" data-emoji="🤩" style="width: 32px; height: 32px; border-radius: 6px; border: 2px solid transparent; background: rgba(255,255,255,0.05); cursor: pointer; font-size: 18px;">🤩</button>
                                <button type="button" class="emoji-btn" data-emoji="👉" style="width: 32px; height: 32px; border-radius: 6px; border: 2px solid transparent; background: rgba(255,255,255,0.05); cursor: pointer; font-size: 18px;">👉</button>
                                <button type="button" class="emoji-btn" data-emoji="__arrow__" style="width: 32px; height: 32px; border-radius: 6px; border: 2px solid transparent; background: rgba(255,255,255,0.05); cursor: pointer; font-size: 12px; color: #e53935; font-weight: bold;">➤</button>
                            </div>
                            <span id="emojiHint" style="font-size: 11px; color: #666; display: none; margin-left: auto;">(DELETE key to remove)</span>
                        </div>
                    </div>

                    <!-- Title Input -->
                    <div style="margin-bottom: 16px;">
                        <label for="shareTitle" style="display: block; margin-bottom: 8px; font-weight: 600; color: #ccc; font-size: 14px;">Title</label>
                        <input type="text" id="shareTitle" placeholder="My amazing discovery" style="width: 100%; padding: 12px 14px; font-size: 14px; border: 2px solid rgba(102, 126, 234, 0.3); border-radius: 10px; background: rgba(255,255,255,0.05); box-sizing: border-box; color: #fff; outline: none;" maxlength="100">
                    </div>

                    <!-- Description Input -->
                    <div style="margin-bottom: 20px;">
                        <label for="shareDescription" style="display: block; margin-bottom: 8px; font-weight: 600; color: #ccc; font-size: 14px;">Description <span style="color: #666; font-weight: normal;">(optional)</span></label>
                        <textarea id="shareDescription" placeholder="What makes this interesting?" style="width: 100%; padding: 12px 14px; font-size: 14px; border: 2px solid rgba(102, 126, 234, 0.3); border-radius: 10px; background: rgba(255,255,255,0.05); box-sizing: border-box; color: #fff; outline: none; resize: vertical; min-height: 60px;" maxlength="300"></textarea>
                    </div>

                    <!-- Share Link -->
                    <div style="margin-bottom: 20px;">
                        <label for="shareSlug" style="display: block; margin-bottom: 8px; font-weight: 600; color: #ccc; font-size: 14px;">Share Link</label>
                        <div style="display: flex; align-items: center; background: rgba(255,255,255,0.05); border: 2px solid rgba(102, 126, 234, 0.3); border-radius: 10px; overflow: hidden;">
                            <span style="padding: 12px 14px; color: #888; font-size: 12px; white-space: nowrap; background: rgba(0,0,0,0.2);">spaceweather.now.audio/?share=</span>
                            <input type="text" id="shareSlug" placeholder="my-share-name" style="flex: 1; padding: 12px 14px; font-size: 14px; border: none; background: transparent; box-sizing: border-box; min-width: 0; color: #fff; outline: none;">
                        </div>
                        <div id="slugStatus" style="margin-top: 6px; font-size: 12px; min-height: 18px;"></div>
                    </div>

                    <div style="display: flex; gap: 12px; justify-content: flex-end;">
                        <button type="button" id="cancelShareBtn" style="padding: 12px 28px; font-size: 14px; background: rgba(255,255,255,0.1); color: #ccc; border: 1px solid rgba(255,255,255,0.2); border-radius: 8px; cursor: pointer; font-weight: 500;">Cancel</button>
                        <button type="button" id="createShareBtn" style="padding: 12px 28px; font-size: 14px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);">Create Share Link</button>
                    </div>
                </div>

                <!-- Success View -->
                <div id="shareSuccessView" style="display: none; text-align: center; padding: 10px 0;">
                    <div style="font-size: 32px; margin-bottom: 8px;">✅</div>
                    <h4 style="color: #fff; margin-bottom: 14px; font-size: 18px;">Share Link Created!</h4>
                    <div style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 10px; margin-bottom: 14px; border: 1px solid rgba(102, 126, 234, 0.3);">
                        <input type="text" id="shareUrlInput" readonly style="width: 100%; padding: 10px; font-size: 13px; border: none; border-radius: 8px; text-align: center; box-sizing: border-box; background: rgba(0,0,0,0.3); color: #fff;">
                    </div>
                    <div style="display: flex; gap: 12px; justify-content: center;">
                        <button type="button" id="copyShareUrlBtn" style="padding: 10px 22px; font-size: 14px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);">📋 Copy Link</button>
                        <button type="button" id="doneShareBtn" style="padding: 10px 22px; font-size: 14px; background: rgba(255,255,255,0.1); color: #ccc; border: 1px solid rgba(255,255,255,0.2); border-radius: 8px; cursor: pointer; font-weight: 500;">Done</button>
                    </div>
                    <p id="shareExpiry" style="margin-top: 12px; color: #888; font-size: 12px;"></p>
                </div>

                <!-- Error View -->
                <div id="shareErrorView" style="display: none; text-align: center;">
                    <div style="font-size: 48px; margin-bottom: 15px;">❌</div>
                    <h4 style="color: #dc3545; margin-bottom: 10px;">Share Failed</h4>
                    <p id="shareErrorMessage" style="color: #666; margin-bottom: 20px;"></p>
                    <button type="button" id="retryShareBtn" style="padding: 12px 24px; font-size: 14px; background: #007bff; color: white; border: none; border-radius: 8px; cursor: pointer;">Try Again</button>
                </div>

                <!-- Loading View -->
                <div id="shareLoadingView" style="display: none; text-align: center; padding: 40px 0;">
                    <div class="share-spinner"></div>
                    <p id="shareLoadingText" style="color: #666;">Creating share link...</p>
                </div>
            </div>
        </div>
    `;

    // Add spinner styles
    const style = document.createElement('style');
    style.textContent = `
        .share-spinner {
            width: 40px;
            height: 40px;
            margin: 0 auto 20px auto;
            border: 4px solid rgba(102, 126, 234, 0.2);
            border-top-color: #667eea;
            border-radius: 50%;
            animation: share-spin 1s ease-in-out infinite, share-glow 2s ease-in-out infinite;
        }
        @keyframes share-spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        @keyframes share-glow {
            0%, 100% {
                box-shadow: 0 0 5px rgba(102, 126, 234, 0.3);
                border-top-color: #667eea;
            }
            50% {
                box-shadow: 0 0 20px rgba(102, 126, 234, 0.8), 0 0 30px rgba(118, 75, 162, 0.4);
                border-top-color: #764ba2;
            }
        }
    `;
    document.head.appendChild(style);

    return modal;
}

/**
 * Show a specific view in the modal
 */
function showView(viewId) {
    const views = ['shareFormView', 'shareSuccessView', 'shareErrorView', 'shareLoadingView'];
    views.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = id === viewId ? 'block' : 'none';
    });
}

/**
 * Check slug availability with debounce
 */
async function checkSlugAvailability(slug) {
    const statusEl = document.getElementById('slugStatus');
    const createBtn = document.getElementById('createShareBtn');

    if (!slug || slug.length < 3) {
        statusEl.innerHTML = '<span style="color: #666;">Enter at least 3 characters</span>';
        createBtn.disabled = true;
        return;
    }

    statusEl.innerHTML = '<span style="color: #666;">Checking availability...</span>';

    try {
        const result = await ShareAPI.checkShareAvailable(slug);

        if (result.available) {
            statusEl.innerHTML = '<span style="color: #28a745;">Available!</span>';
            createBtn.disabled = false;
        } else if (result.error) {
            statusEl.innerHTML = `<span style="color: #dc3545;">${result.error}</span>`;
            createBtn.disabled = true;
        } else {
            statusEl.innerHTML = '<span style="color: #dc3545;">This name is already taken</span>';
            createBtn.disabled = true;
        }
    } catch (error) {
        statusEl.innerHTML = '<span style="color: #dc3545;">Error checking availability</span>';
        createBtn.disabled = true;
    }
}

/**
 * Handle slug input changes with debounce
 */
function handleSlugInput(e) {
    const slug = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    e.target.value = slug;  // Auto-correct input

    // Clear previous timeout
    if (slugCheckTimeout) {
        clearTimeout(slugCheckTimeout);
    }

    // Debounce the availability check
    slugCheckTimeout = setTimeout(() => {
        checkSlugAvailability(slug);
    }, 300);
}

/**
 * Initialize the share modal (call once on app init)
 */
export function initShareModal() {
    if (shareModal) return;

    shareModal = createShareModal();
    document.body.appendChild(shareModal);

    // Event listeners
    document.getElementById('closeShareModal').addEventListener('click', closeShareModal);
    document.getElementById('cancelShareBtn').addEventListener('click', closeShareModal);
    document.getElementById('createShareBtn').addEventListener('click', handleCreateShare);
    document.getElementById('copyShareUrlBtn').addEventListener('click', handleCopyUrl);
    document.getElementById('doneShareBtn').addEventListener('click', closeShareModal);
    document.getElementById('retryShareBtn').addEventListener('click', () => showView('shareFormView'));

    // Slug input handler
    document.getElementById('shareSlug').addEventListener('input', handleSlugInput);

    // Emoji picker handlers
    document.querySelectorAll('.emoji-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            handleEmojiSelect(btn.dataset.emoji);
        });
    });

    // Setup canvas interaction for emoji drag/resize/rotate
    setupCanvasInteraction();

    // Close on backdrop click (only if mousedown also started on backdrop)
    let mouseDownOnBackdrop = false;
    shareModal.addEventListener('mousedown', (e) => {
        mouseDownOnBackdrop = (e.target === shareModal);
    });
    shareModal.addEventListener('click', (e) => {
        if (e.target === shareModal && mouseDownOnBackdrop) closeShareModal();
        mouseDownOnBackdrop = false;
    });

    // Close on escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && shareModal.style.display !== 'none') {
            closeShareModal();
        }
    });
}

/**
 * Open the share modal
 */
export function openShareModal() {
    if (!shareModal) initShareModal();

    // Reset to form view
    showView('shareFormView');

    // Reset emoji overlays
    emojiOverlays = [];
    selectedEmojiIndex = -1;
    emojiDragState.dragging = false;
    emojiDragState.resizing = false;
    emojiDragState.rotating = false;
    emojiDragState.dragStart = null;
    const hint = document.getElementById('emojiHint');
    if (hint) hint.style.display = 'none';

    // Capture spectrogram thumbnail
    updateThumbnailPreview();

    // Pre-populate info
    const spacecraft = State.currentMetadata?.spacecraft || document.getElementById('spacecraft')?.value || 'Unknown';

    // Generate engaging default title
    const defaultTitle = `Listen to these sounds from space!`;
    document.getElementById('shareTitle').value = defaultTitle;

    // Generate engaging default description
    const dataType = State.currentMetadata?.dataset || document.getElementById('dataType')?.value || '';
    const startStr = State.dataStartTime ? State.dataStartTime.toISOString().slice(0, 10) : '';
    const endStr = State.dataEndTime ? State.dataEndTime.toISOString().slice(0, 10) : '';

    let defaultDescription = `Check out this feature I identified in ${spacecraft}`;
    if (dataType) {
        defaultDescription += ` ${dataType}`;
    }
    defaultDescription += ` data`;
    if (startStr && endStr) {
        defaultDescription += ` from ${startStr} to ${endStr}`;
    }
    defaultDescription += `. I think you'll find it interesting!`;
    document.getElementById('shareDescription').value = defaultDescription;

    // Generate and set default slug
    const defaultSlug = generateDefaultSlug();
    document.getElementById('shareSlug').value = defaultSlug;
    document.getElementById('createShareBtn').disabled = true;

    // Check availability of default slug
    checkSlugAvailability(defaultSlug);

    // Show modal
    shareModal.style.display = 'flex';
}

/**
 * Close the share modal
 */
export function closeShareModal() {
    if (shareModal) {
        shareModal.style.display = 'none';
    }
}

/**
 * Gather session data for saving
 */
function gatherSessionData() {
    const regions = getRegions();
    const spacecraft = State.currentMetadata?.spacecraft || document.getElementById('spacecraft')?.value;
    const dataType = State.currentMetadata?.dataset || document.getElementById('dataType')?.value;

    // Debug: log what features we're capturing
    console.log('🔗 Gathering session data...');
    console.log(`🔗   ${regions.length} region(s) found`);
    regions.forEach((r, i) => {
        const featureCount = r.features?.length || 0;
        console.log(`🔗   Region ${i + 1} (id=${r.id}): ${featureCount} feature(s), featureCount=${r.featureCount}`);
        if (r.features && r.features.length > 0) {
            r.features.forEach((f, j) => {
                console.log(`🔗     Feature ${j + 1}: type=${f.type}, notes="${f.notes?.slice(0, 30) || ''}..."`);
            });
        }
    });

    return {
        session_id: currentSessionId,  // Re-use if we have one
        spacecraft,
        data_type: dataType,
        time_range: {
            start: State.dataStartTime?.toISOString(),
            end: State.dataEndTime?.toISOString()
        },
        regions: regions.map(r => ({
            id: r.id,
            startTime: r.startTime,
            stopTime: r.stopTime,
            minFrequency: r.minFrequency,
            maxFrequency: r.maxFrequency,
            label: r.label,
            color: r.color,
            featureCount: r.featureCount || 1,
            features: r.features || [],
            expanded: r.expanded || false
        })),
        view_settings: {
            frequency_scale: State.frequencyScale,
            colormap: getCurrentColormap(),
            fft_size: State.fftSize,
            zoom: zoomState.mode === 'region' ? {
                mode: 'region',
                region_id: zoomState.activeRegionId,
                start_time: zoomState.currentViewStartTime?.toISOString(),
                end_time: zoomState.currentViewEndTime?.toISOString()
            } : null
        }
    };
}

/**
 * Handle creating a new share
 */
async function handleCreateShare() {
    if (isSharing) return;
    isSharing = true;

    const loadingText = document.getElementById('shareLoadingText');
    showView('shareLoadingView');

    try {
        const username = getParticipantId();
        if (!username) {
            throw new Error('Please set your username first (click your name in the header)');
        }

        const shareSlug = document.getElementById('shareSlug').value.trim();
        if (!shareSlug) {
            throw new Error('Please enter a share link name');
        }

        // Get title and description from inputs
        const title = document.getElementById('shareTitle').value.trim() || 'Space Weather Analysis';
        const description = document.getElementById('shareDescription').value.trim();

        // Step 1: Save session to R2
        loadingText.textContent = 'Saving session...';
        const sessionData = gatherSessionData();
        const saveResult = await ShareAPI.saveSession(username, sessionData);
        currentSessionId = saveResult.session_id;
        console.log('Session saved:', saveResult);

        // Step 2: Create share link with thumbnail
        loadingText.textContent = 'Creating share link...';
        const shareResult = await ShareAPI.createShare(username, currentSessionId, {
            title,
            description,
            share_id: shareSlug,
            thumbnail: capturedThumbnailDataUrl  // Include the captured thumbnail
        });

        // Show success view
        document.getElementById('shareUrlInput').value = shareResult.share_url;

        // Share links are permanent
        document.getElementById('shareExpiry').textContent = `This link never expires`;

        showView('shareSuccessView');
        console.log('Share created:', shareResult);

    } catch (error) {
        console.error('Share error:', error);
        document.getElementById('shareErrorMessage').textContent = error.message;
        showView('shareErrorView');
    } finally {
        isSharing = false;
    }
}

/**
 * Handle copying share URL to clipboard
 */
async function handleCopyUrl() {
    const urlInput = document.getElementById('shareUrlInput');
    const copyBtn = document.getElementById('copyShareUrlBtn');

    try {
        await navigator.clipboard.writeText(urlInput.value);
        copyBtn.textContent = '✓ Copied!';
        copyBtn.style.background = '#28a745';

        setTimeout(() => {
            copyBtn.textContent = '📋 Copy Link';
        }, 2000);
    } catch (error) {
        // Fallback for older browsers
        urlInput.select();
        document.execCommand('copy');
        copyBtn.textContent = '✓ Copied!';

        setTimeout(() => {
            copyBtn.textContent = '📋 Copy Link';
        }, 2000);
    }
}

/**
 * Check URL for shared session and load it
 * @returns {Promise<Object|null>} Share data if found, null otherwise
 */
export async function checkAndLoadSharedSession() {
    const shareId = ShareAPI.getShareIdFromUrl();
    if (!shareId) return null;

    // 🔗 SET THIS IMMEDIATELY - before any async work or timeouts can fire!
    sessionStorage.setItem('isSharedSession', 'true');
    console.log('🔗🔗🔗 [SHARE-MODAL] SET isSharedSession=true IMMEDIATELY (share ID found)');

    console.log('🔗 Found share ID in URL:', shareId);
    console.log('🔗 Current URL:', window.location.href);

    try {
        const shareData = await ShareAPI.getShare(shareId);
        console.log('Loaded shared session:', shareData);

        // Track as recently viewed
        ShareAPI.addToRecentShares({
            share_id: shareId,
            title: shareData.metadata.title,
            spacecraft: shareData.metadata.spacecraft
        });

        return shareData;
    } catch (error) {
        console.error('Failed to load shared session:', error);
        alert(`Failed to load shared session: ${error.message}`);
        return null;
    }
}

/**
 * Apply shared session data to the app
 * @param {Object} shareData - The share data from the API
 */
export function applySharedSession(shareData) {
    const { session, metadata } = shareData;

    // Set spacecraft and data type
    const spacecraftSelect = document.getElementById('spacecraft');
    const dataTypeSelect = document.getElementById('dataType');

    if (spacecraftSelect && session.spacecraft) {
        spacecraftSelect.value = session.spacecraft;
        // Directly update dataset options (event listener may not be attached yet)
        updateDatasetOptions();
    }

    // Set time range
    if (session.time_range?.start && session.time_range?.end) {
        const startDate = new Date(session.time_range.start);
        const endDate = new Date(session.time_range.end);

        document.getElementById('startDate').value = startDate.toISOString().slice(0, 10);
        document.getElementById('startTime').value = startDate.toISOString().slice(11, 23);
        document.getElementById('endDate').value = endDate.toISOString().slice(0, 10);
        document.getElementById('endTime').value = endDate.toISOString().slice(11, 23);
    }

    // Set data type (options are already populated by updateDatasetOptions above)
    if (dataTypeSelect && session.data_type) {
        dataTypeSelect.value = session.data_type;
    }

    // Note: isSharedSession was already set in checkAndLoadSharedSession() before any async work

    // Store regions to be applied after data loads
    if (session.regions && session.regions.length > 0) {
        console.log('🔗 Storing', session.regions.length, 'regions to sessionStorage');
        // Log feature counts for debugging
        session.regions.forEach((r, i) => {
            const featureCount = r.features?.length || 0;
            console.log(`🔗   Region ${i + 1}: ${featureCount} feature(s)`);
        });
        sessionStorage.setItem('pendingSharedRegions', JSON.stringify(session.regions));
    }

    // Store view settings
    if (session.view_settings) {
        sessionStorage.setItem('pendingSharedViewSettings', JSON.stringify(session.view_settings));
    }

    // Show notification
    const title = metadata.title || 'Shared Analysis';
    const status = document.getElementById('status');
    if (status) {
        status.textContent = `Loading shared analysis: "${title}"`;
        status.className = 'status info';
    }

    return {
        shouldFetch: true,
        session
    };
}

/**
 * Save current session to R2 (can be called when regions change)
 * @param {boolean} silent - If true, don't show errors to user
 */
export async function saveCurrentSession(silent = true) {
    const username = getParticipantId();
    if (!username) {
        if (!silent) console.warn('No username set, cannot save session');
        return null;
    }

    const regions = getRegions();
    if (regions.length === 0) {
        // Don't save empty sessions
        return null;
    }

    try {
        const sessionData = gatherSessionData();
        const result = await ShareAPI.saveSession(username, sessionData);
        currentSessionId = result.session_id;
        console.log('Session auto-saved:', result.session_id);
        return result;
    } catch (error) {
        if (!silent) {
            console.error('Failed to save session:', error);
        }
        return null;
    }
}

/**
 * Enable/disable the share button based on data availability
 */
export function updateShareButtonState() {
    const shareBtn = document.getElementById('shareBtn');
    if (!shareBtn) {
        console.log('🔗 Share button not found');
        return;
    }

    // Enable if we have loaded data
    const hasData = State.completeSamplesArray && State.completeSamplesArray.length > 0;
    // console.log('🔗 Share button state:', { hasData, length: State.completeSamplesArray?.length, disabled: !hasData });
    shareBtn.disabled = !hasData;
}

export default {
    initShareModal,
    openShareModal,
    closeShareModal,
    checkAndLoadSharedSession,
    applySharedSession,
    saveCurrentSession,
    updateShareButtonState
};
