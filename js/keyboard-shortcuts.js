/**
 * keyboard-shortcuts.js
 * Keyboard shortcuts for region navigation and feature drawing
 */

import { zoomToRegion, zoomToFull, getCurrentRegions, getActiveRegionIndex, isInFrequencySelectionMode, startFrequencySelection, addFeature, createRegionFromSelectionTimes, toggleRegionPlay, stopFrequencySelection, getStandaloneFeatures, deleteStandaloneFeature, renderStandaloneFeaturesList, updateCompleteButtonState, updateCmpltButtonState } from './region-tracker.js';
import { zoomState } from './zoom-state.js';
import * as State from './audio-state.js';
import { changeFrequencyScale, redrawAllCanvasFeatureBoxes } from './spectrogram-renderer.js';
import { isStudyMode } from './master-modes.js';
import { drawWaveformFromMinMax, notifyPageTurnUserDragged } from './waveform-renderer.js';
import { drawWaveformXAxis } from './waveform-x-axis-renderer.js';
import { drawSpectrogramXAxis } from './spectrogram-x-axis-renderer.js';
import { updateSpectrogramViewportFromZoom, renderCompleteSpectrogramForRegion, setScrollZoomHiRes } from './spectrogram-three-renderer.js';
import { updateAllFeatureBoxPositions } from './spectrogram-feature-boxes.js';
import { updateCanvasAnnotations } from './spectrogram-renderer.js';
import { drawSpectrogramPlayhead } from './spectrogram-playhead.js';
import { drawDayMarkers } from './day-markers.js';

// 🔥 FIX: Track if shortcuts are initialized to prevent duplicate listeners
let keyboardShortcutsInitialized = false;

/**
 * Initialize keyboard shortcuts
 */
export function initKeyboardShortcuts() {
    // 🔥 FIX: Only add listener once to prevent memory leaks
    if (keyboardShortcutsInitialized) {
        return;
    }
    
    // Use window.addEventListener with capture phase to ensure we catch events
    // This ensures keyboard shortcuts work even if other handlers prevent default
    window.addEventListener('keydown', handleKeyboardShortcut, true);
    window.addEventListener('keyup', handleArrowKeyUp, true);
    keyboardShortcutsInitialized = true;
    // Only log in dev/personal modes, not study mode
    if (!isStudyMode()) {
        console.log('⌨️ Keyboard shortcuts initialized');
    }
}

/**
 * Cleanup keyboard shortcuts event listeners
 * 🔥 FIX: Prevents memory leaks
 */
export function cleanupKeyboardShortcuts() {
    if (keyboardShortcutsInitialized) {
        window.removeEventListener('keydown', handleKeyboardShortcut, true);
        window.removeEventListener('keyup', handleArrowKeyUp, true);
        stopArrowHold();
        keyboardShortcutsInitialized = false;
    }
}

/**
 * Handle keyboard shortcut events
 */
function handleKeyboardShortcut(event) {
    // Debug: Log Escape key presses
    // if (event.key === 'Escape') {
    //     console.log('🔍 [ESCAPE DEBUG] handleKeyboardShortcut() called with Escape key');
    //     console.log('🔍 [ESCAPE DEBUG] event.target:', event.target);
    //     console.log('🔍 [ESCAPE DEBUG] event.target.tagName:', event.target.tagName);
    // }
    
    // Don't capture shortcuts when user is typing in inputs, textareas, or contenteditable elements
    // EXCEPT for Escape key - Escape should always work to exit modes/zoom out
    const isTextInput = event.target.tagName === 'INPUT' && 
                       event.target.type !== 'range' && 
                       event.target.type !== 'checkbox';
    const isTextarea = event.target.tagName === 'TEXTAREA';
    const isContentEditable = event.target.isContentEditable;
    
    // Allow Escape and Ctrl+Z to work even when in text inputs/textareas
    const isEscapeKey = event.key === 'Escape';
    const isUndoKey = event.key === 'z' && (event.ctrlKey || event.metaKey) && !event.shiftKey;
    const isTypingInField = isTextInput || isTextarea || isContentEditable;

    if (isTypingInField && !isEscapeKey && !isUndoKey) {
        return; // Let browser handle normally (but not Escape or Ctrl+Z)
    }

    // Ctrl+Z / Cmd+Z: Undo last standalone feature
    if (isUndoKey) {
        const features = getStandaloneFeatures();
        if (features.length > 0) {
            event.preventDefault();
            deleteStandaloneFeature(features.length - 1);
            redrawAllCanvasFeatureBoxes();
            renderStandaloneFeaturesList();
            updateCompleteButtonState();
            updateCmpltButtonState();
            console.log(`⌨️ Ctrl+Z: undid feature (${features.length - 1} remaining)`);
        }
        return;
    }

    // Number keys (1-9): Zoom to region, or play region if already zoomed into it
    // Only in Region Creation mode — windowed modes don't use region navigation
    if (event.key >= '1' && event.key <= '9') {
        const viewingModeEl = document.getElementById('viewingMode');
        const viewingMode = viewingModeEl ? viewingModeEl.value : 'regionCreation';
        if (viewingMode !== 'regionCreation') return;

        const regionIndex = parseInt(event.key) - 1; // Convert '1' to 0, '2' to 1, etc.
        const regions = getCurrentRegions();
        
        if (regionIndex < regions.length) {
            event.preventDefault();
            const region = regions[regionIndex];
            
            // 🎓 Tutorial: Resolve promise if waiting for this specific number key
            if (State.waitingForNumberKeyPress && State.targetNumberKey === event.key && State._numberKeyPressResolve) {
                State.setWaitingForNumberKeyPress(false);
                const resolve = State._numberKeyPressResolve;
                State.setNumberKeyPressResolve(null);
                State.setTargetNumberKey(null);
                resolve();
            }
            
            // Always execute the action, even during tutorial (tutorial will track it separately)
            // Check if we're already zoomed into this specific region
            if (zoomState.isInRegion() && zoomState.getCurrentRegionId() === region.id) {
                // Already zoomed into this region - play it from the start
                toggleRegionPlay(regionIndex);
                console.log(`▶️ Playing region ${regionIndex + 1} from start`);
            } else {
                // Not zoomed into this region - zoom to it
                zoomToRegion(regionIndex);
            }
        }
        return;
    }
    
    // 'f' key: DEPRECATED - no longer needed, click-to-draw is always active when zoomed in
    // Keeping this here commented out for reference, can be removed later
    // if (event.key === 'f' || event.key === 'F') {
    //     // Feature drawing is now always enabled when zoomed into a region
    //     // Just clicking and dragging on the spectrogram will create features
    //     return;
    // }
    
    // 'r' key: Confirm/add region from current selection
    if (event.key === 'r' || event.key === 'R') {
        // Check if region creation is enabled (requires "Begin Analysis" to be pressed)
        if (!State.isRegionCreationEnabled()) {
            console.log('🔒 Region creation disabled - please press "Begin Analysis" first');
            return;
        }
        
        // Check if there's a valid selection
        if (State.selectionStart !== null && State.selectionEnd !== null) {
            event.preventDefault();
            createRegionFromSelectionTimes(State.selectionStart, State.selectionEnd);
            console.log('✅ Region created from selection');
        }
        return;
    }
    
    // Frequency scale shortcuts: 'c' for linear, 'v' for square root, 'b' for logarithmic
    // Disabled in windowed modes — keys conflict with typing in notes fields
    const _viewingMode = document.getElementById('viewingMode')?.value || 'regionCreation';
    const _isWindowed = _viewingMode === 'scroll' || _viewingMode === 'pageTurn' || _viewingMode === 'static';
    if (!_isWindowed && (event.key === 'c' || event.key === 'C')) {
        event.preventDefault();
        const select = document.getElementById('frequencyScale');
        if (select && State.frequencyScale !== 'linear') {
            select.value = 'linear';
            changeFrequencyScale();
            console.log('📊 Frequency scale changed to: Linear');
        }
        
        // 🎓 Tutorial: Track keyboard shortcut presses
        if (State.waitingForFrequencyScaleKeys) {
            State.setFrequencyScaleKeyPressCount(State.frequencyScaleKeyPressCount + 1);
            if (State.frequencyScaleKeyPressCount >= 2 && State._frequencyScaleKeysResolve) {
                State.setWaitingForFrequencyScaleKeys(false);
                const resolve = State._frequencyScaleKeysResolve;
                State.setFrequencyScaleKeysResolve(null);
                State.setFrequencyScaleKeyPressCount(0);
                resolve();
            }
        }
        return;
    }
    
    if (!_isWindowed && (event.key === 'v' || event.key === 'V')) {
        event.preventDefault();
        const select = document.getElementById('frequencyScale');
        if (select && State.frequencyScale !== 'sqrt') {
            select.value = 'sqrt';
            changeFrequencyScale();
            console.log('📊 Frequency scale changed to: Square Root');
        }
        
        // 🎓 Tutorial: Track keyboard shortcut presses
        if (State.waitingForFrequencyScaleKeys) {
            State.setFrequencyScaleKeyPressCount(State.frequencyScaleKeyPressCount + 1);
            if (State.frequencyScaleKeyPressCount >= 2 && State._frequencyScaleKeysResolve) {
                State.setWaitingForFrequencyScaleKeys(false);
                const resolve = State._frequencyScaleKeysResolve;
                State.setFrequencyScaleKeysResolve(null);
                State.setFrequencyScaleKeyPressCount(0);
                resolve();
            }
        }
        return;
    }
    
    if (!_isWindowed && (event.key === 'b' || event.key === 'B')) {
        event.preventDefault();
        const select = document.getElementById('frequencyScale');
        if (select && State.frequencyScale !== 'logarithmic') {
            select.value = 'logarithmic';
            changeFrequencyScale();
            console.log('📊 Frequency scale changed to: Logarithmic');
        }
        
        // 🎓 Tutorial: Track keyboard shortcut presses
        if (State.waitingForFrequencyScaleKeys) {
            State.setFrequencyScaleKeyPressCount(State.frequencyScaleKeyPressCount + 1);
            if (State.frequencyScaleKeyPressCount >= 2 && State._frequencyScaleKeysResolve) {
                State.setWaitingForFrequencyScaleKeys(false);
                const resolve = State._frequencyScaleKeysResolve;
                State.setFrequencyScaleKeysResolve(null);
                State.setFrequencyScaleKeyPressCount(0);
                resolve();
            }
        }
        return;
    }
    
    // Escape key: Exit feature selection mode first, then zoom back out to full view
    if (event.key === 'Escape') {
        // console.log('🔍 [ESCAPE DEBUG] Escape key pressed');
        // console.log('🔍 [ESCAPE DEBUG] isTypingInField:', isTypingInField);
        // console.log('🔍 [ESCAPE DEBUG] isInFrequencySelectionMode():', isInFrequencySelectionMode());
        // console.log('🔍 [ESCAPE DEBUG] zoomState.isInRegion():', zoomState.isInRegion());
        // console.log('🔍 [ESCAPE DEBUG] zoomState:', {
        //     mode: zoomState.mode,
        //     activeRegionId: zoomState.activeRegionId,
        //     initialized: zoomState.isInitialized()
        // });

        // If typing in a field, blur it first so Escape works
        if (isTypingInField) {
            // console.log('🔍 [ESCAPE DEBUG] Blurring active input/textarea');
            event.target.blur();
        }
        
        // First priority: Zoom out if in a region (also exits feature selection mode)
        if (zoomState.isInRegion()) {
            // Exit feature selection mode if active (before zooming out)
            if (isInFrequencySelectionMode()) {
                stopFrequencySelection();
            }
            // console.log('🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴');
            // console.log('🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴');
            // console.log('🔴🔴 ESCAPE PRESSED - STARTING ZOOM OUT 🔴🔴');
            
            // 🔍 DIAGNOSTIC: Check what's currently visible on the MAIN canvas before zoom out
            // const mainCanvas = document.getElementById('spectrogram');
            // if (mainCanvas) {
            //     const mainCtx = mainCanvas.getContext('2d', { willReadFrequently: true });
            //     const midX = Math.floor(mainCanvas.width / 2);
            //     const midY = Math.floor(mainCanvas.height / 2);
            //     const visiblePixel = mainCtx.getImageData(midX, midY, 1, 1).data;
            //     console.log(`🔍 MAIN CANVAS (what user sees) center pixel:`, {
            //         rgba: `${visiblePixel[0]}, ${visiblePixel[1]}, ${visiblePixel[2]}, ${visiblePixel[3]}`,
            //         brightness: visiblePixel[0] + visiblePixel[1] + visiblePixel[2]
            //     });
            // }
            
            event.preventDefault();
            zoomToFull();
        } else if (isInFrequencySelectionMode()) {
            // Not in region but in feature selection mode - just exit feature selection
            event.preventDefault();
            stopFrequencySelection();
        }
        return;
    }
    
    // Arrow keys: zoom and pan navigation (custom repeat — bypasses OS repeat delay)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' ||
        event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        if (!event.repeat) {
            startArrowHold(event.key);
        }
        return;
    }

    // Enter key: Trigger first fetch (only works before first fetch, handled in main.js)
    // We don't handle it here, but we need to make sure we don't prevent it
    // The actual handler is in main.js DOMContentLoaded
}

// --- Arrow key hold system: tap = discrete step, hold = continuous smooth motion ---

let arrowHoldKey = null;
let arrowHoldTimer = null;     // 100ms timer to detect hold
let arrowContinuousRaf = null; // rAF id for continuous motion
const ARROW_HOLD_THRESHOLD_MS = 100;
// Continuous motion: ~5 discrete steps worth of movement per second (matches initial tap feel)
const ARROW_CONTINUOUS_RATE = 5.0; // steps per second

function startArrowHold(key) {
    stopArrowHold();
    arrowHoldKey = key;
    // Fire one discrete step immediately
    handleArrowNavigation(key);
    // After 100ms, if still held, switch to continuous smooth motion
    arrowHoldTimer = setTimeout(() => {
        arrowHoldTimer = null;
        startContinuousMotion();
    }, ARROW_HOLD_THRESHOLD_MS);
}

function startContinuousMotion() {
    if (!arrowHoldKey) return;
    // Cancel any in-progress discrete animation
    if (navAnimation) {
        cancelAnimationFrame(navAnimation.rafId);
        navAnimation = null;
    }

    let lastTime = performance.now();

    function tick(now) {
        if (!arrowHoldKey) return;
        const dt = (now - lastTime) / 1000; // seconds since last frame
        lastTime = now;

        if (!State.dataStartTime || !State.dataEndTime || !zoomState.isInitialized()) {
            arrowContinuousRaf = requestAnimationFrame(tick);
            return;
        }

        const startMs = zoomState.currentViewStartTime.getTime();
        const endMs = zoomState.currentViewEndTime.getTime();
        const spanMs = endMs - startMs;
        const dataStartMs = State.dataStartTime.getTime();
        const dataEndMs = State.dataEndTime.getTime();
        const dataSpanMs = dataEndMs - dataStartMs;

        const zoomStepEl = document.getElementById('arrowZoomStep');
        const panStepEl = document.getElementById('arrowPanStep');
        const zoomPct = (zoomStepEl ? parseInt(zoomStepEl.value) : 15) / 100;
        const panPct = (panStepEl ? parseInt(panStepEl.value) : 10) / 100;

        // Scale step by dt and rate
        const frameScale = dt * ARROW_CONTINUOUS_RATE;
        let newStartMs = startMs;
        let newEndMs = endMs;

        const key = arrowHoldKey;
        if (key === 'ArrowUp') {
            const factor = 1 - zoomPct * frameScale;
            const mid = (startMs + endMs) / 2;
            const halfSpan = spanMs * factor / 2;
            newStartMs = mid - halfSpan;
            newEndMs = mid + halfSpan;
        } else if (key === 'ArrowDown') {
            const factor = 1 + zoomPct * frameScale;
            const mid = (startMs + endMs) / 2;
            const halfSpan = spanMs * factor / 2;
            newStartMs = mid - halfSpan;
            newEndMs = mid + halfSpan;
        } else if (key === 'ArrowRight') {
            const shift = spanMs * panPct * frameScale;
            newStartMs += shift;
            newEndMs += shift;
        } else if (key === 'ArrowLeft') {
            const shift = spanMs * panPct * frameScale;
            newStartMs -= shift;
            newEndMs -= shift;
        }

        // Clamp to data bounds
        if (newStartMs < dataStartMs) {
            const offset = dataStartMs - newStartMs;
            newStartMs = dataStartMs;
            if (key === 'ArrowLeft' || key === 'ArrowRight') newEndMs += offset;
        }
        if (newEndMs > dataEndMs) {
            const offset = newEndMs - dataEndMs;
            newEndMs = dataEndMs;
            if (key === 'ArrowLeft' || key === 'ArrowRight') newStartMs -= offset;
        }
        if (newStartMs < dataStartMs) newStartMs = dataStartMs;
        if (newEndMs - newStartMs < 1000) {
            arrowContinuousRaf = requestAnimationFrame(tick);
            return;
        }

        if (newEndMs - newStartMs >= dataSpanMs * 0.99) {
            zoomState.setViewportToFull();
        } else {
            zoomState.currentViewStartTime = new Date(newStartMs);
            zoomState.currentViewEndTime = new Date(newEndMs);
        }
        renderNavFrame();

        arrowContinuousRaf = requestAnimationFrame(tick);
    }

    arrowContinuousRaf = requestAnimationFrame(tick);
}

function stopArrowHold() {
    arrowHoldKey = null;
    if (arrowHoldTimer) {
        clearTimeout(arrowHoldTimer);
        arrowHoldTimer = null;
    }
    if (arrowContinuousRaf) {
        cancelAnimationFrame(arrowContinuousRaf);
        arrowContinuousRaf = null;
        // Schedule hi-res after continuous motion stops
        scheduleHiResAfterNav();
    }
}

function handleArrowKeyUp(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' ||
        event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        stopArrowHold();
    }
}

// --- Arrow key navigation with smooth transitions ---

let navAnimation = null; // Current animation state (or null)
const NAV_DURATION_MS = 200;

function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}

function renderNavFrame() {
    drawWaveformFromMinMax();
    drawWaveformXAxis();
    drawSpectrogramXAxis();
    updateSpectrogramViewportFromZoom();
    updateAllFeatureBoxPositions();
    updateCanvasAnnotations();
    drawSpectrogramPlayhead();
    drawDayMarkers();
}

/**
 * Smoothly animate viewport to target start/end timestamps.
 * If called while animating, retargets to new destination.
 */
function smoothNavigateTo(targetStartMs, targetEndMs) {
    const fromStartMs = zoomState.currentViewStartTime.getTime();
    const fromEndMs = zoomState.currentViewEndTime.getTime();
    const startTime = performance.now();

    // If already animating, retarget: use current interpolated position as new "from"
    if (navAnimation) {
        cancelAnimationFrame(navAnimation.rafId);
    }

    function tick(now) {
        const elapsed = now - startTime;
        const t = Math.min(1, elapsed / NAV_DURATION_MS);
        const eased = easeOutCubic(t);

        const curStart = fromStartMs + (targetStartMs - fromStartMs) * eased;
        const curEnd = fromEndMs + (targetEndMs - fromEndMs) * eased;

        zoomState.currentViewStartTime = new Date(curStart);
        zoomState.currentViewEndTime = new Date(curEnd);
        renderNavFrame();

        if (t < 1) {
            navAnimation.rafId = requestAnimationFrame(tick);
        } else {
            navAnimation = null;
            // Trigger hi-res render after settling
            scheduleHiResAfterNav();
        }
    }

    navAnimation = { rafId: requestAnimationFrame(tick) };
}

let hiResNavTimer = null;
const HI_RES_NAV_DELAY_MS = 400;

async function scheduleHiResAfterNav() {
    if (hiResNavTimer) clearTimeout(hiResNavTimer);
    hiResNavTimer = setTimeout(async () => {
        if (!State.dataStartTime || !State.dataEndTime) return;

        const startMs = zoomState.currentViewStartTime.getTime();
        const endMs = zoomState.currentViewEndTime.getTime();
        const dataStartMs = State.dataStartTime.getTime();
        const dataEndMs = State.dataEndTime.getTime();
        const dataSpanMs = dataEndMs - dataStartMs;

        if (endMs - startMs >= dataSpanMs * 0.95) return;

        const startSeconds = (startMs - dataStartMs) / 1000;
        const endSeconds = (endMs - dataStartMs) / 1000;

        const viewDurationSec = (endMs - startMs) / 1000;
        const canvasWidth = document.getElementById('spectrogram')?.width || 1200;
        const baseTileColsInView = (viewDurationSec / (15 * 60)) * 1024;
        if (baseTileColsInView >= canvasWidth * 0.8) return;

        const viewSpanSeconds = endSeconds - startSeconds;
        const padding = viewSpanSeconds * 0.3;
        const dataDurationSeconds = dataSpanMs / 1000;
        const expandedStart = Math.max(0, startSeconds - padding);
        const expandedEnd = Math.min(dataDurationSeconds, endSeconds + padding);

        const success = await renderCompleteSpectrogramForRegion(expandedStart, expandedEnd, true);
        if (!success) return;

        setScrollZoomHiRes(expandedStart, expandedEnd);
        updateSpectrogramViewportFromZoom();
        updateAllFeatureBoxPositions();
        updateCanvasAnnotations();
        drawSpectrogramPlayhead();
        drawDayMarkers();
    }, HI_RES_NAV_DELAY_MS);
}

/**
 * Handle arrow key navigation: zoom in/out and pan left/right
 */
function handleArrowNavigation(key) {
    if (!State.dataStartTime || !State.dataEndTime) return;
    if (!zoomState.isInitialized()) return;

    notifyPageTurnUserDragged();

    const startMs = zoomState.currentViewStartTime.getTime();
    const endMs = zoomState.currentViewEndTime.getTime();
    const spanMs = endMs - startMs;
    if (spanMs <= 0) return;

    const dataStartMs = State.dataStartTime.getTime();
    const dataEndMs = State.dataEndTime.getTime();
    const dataSpanMs = dataEndMs - dataStartMs;

    // Read step sizes from settings (default: zoom 10%, pan 25%)
    const zoomStepEl = document.getElementById('arrowZoomStep');
    const panStepEl = document.getElementById('arrowPanStep');
    const zoomPct = (zoomStepEl ? parseInt(zoomStepEl.value) : 15) / 100;
    const panPct = (panStepEl ? parseInt(panStepEl.value) : 10) / 100;

    let newStartMs = startMs;
    let newEndMs = endMs;

    if (key === 'ArrowUp') {
        // Zoom in: shrink viewport by zoomPct, centered on midpoint
        const mid = (startMs + endMs) / 2;
        const halfSpan = spanMs * (1 - zoomPct) / 2;
        newStartMs = mid - halfSpan;
        newEndMs = mid + halfSpan;
    } else if (key === 'ArrowDown') {
        // Zoom out: expand viewport by zoomPct, centered on midpoint
        const mid = (startMs + endMs) / 2;
        const halfSpan = spanMs * (1 + zoomPct) / 2;
        newStartMs = mid - halfSpan;
        newEndMs = mid + halfSpan;
    } else if (key === 'ArrowRight') {
        // Pan right by panPct of current window
        const shift = spanMs * panPct;
        newStartMs = startMs + shift;
        newEndMs = endMs + shift;
    } else if (key === 'ArrowLeft') {
        // Pan left by panPct of current window
        const shift = spanMs * panPct;
        newStartMs = startMs - shift;
        newEndMs = endMs - shift;
    }

    // Clamp to data bounds
    if (newStartMs < dataStartMs) {
        const offset = dataStartMs - newStartMs;
        newStartMs = dataStartMs;
        // For pan, preserve window size by shifting end too
        if (key === 'ArrowLeft' || key === 'ArrowRight') {
            newEndMs = Math.min(dataEndMs, newEndMs + offset);
        }
    }
    if (newEndMs > dataEndMs) {
        const offset = newEndMs - dataEndMs;
        newEndMs = dataEndMs;
        if (key === 'ArrowLeft' || key === 'ArrowRight') {
            newStartMs = Math.max(dataStartMs, newStartMs - offset);
        }
    }

    // Minimum zoom: 1 second
    if (newEndMs - newStartMs < 1000) return;

    // Snap to full view if zoomed out to ≥99%
    if (newEndMs - newStartMs >= dataSpanMs * 0.99) {
        smoothNavigateTo(dataStartMs, dataEndMs);
        return;
    }

    smoothNavigateTo(newStartMs, newEndMs);
}

