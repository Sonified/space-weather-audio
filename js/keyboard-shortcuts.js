/**
 * keyboard-shortcuts.js
 * Keyboard shortcuts for feature drawing and navigation
 */

import { isInFrequencySelectionMode, startFrequencySelection, stopFrequencySelection, getStandaloneFeatures, deleteStandaloneFeature, renderStandaloneFeaturesList, updateCompleteButtonState, updateCmpltButtonState } from './feature-tracker.js';
import { zoomState } from './zoom-state.js';
import * as State from './audio-state.js';
import { PlaybackState } from './audio-state.js';
import { changeFrequencyScale, redrawAllCanvasFeatureBoxes } from './spectrogram-renderer.js';
import { isStudyMode, isLocalEnvironment, isPersonalMode, isEmicStudyMode, CURRENT_MODE, AppMode } from './master-modes.js';
import { getEmicFlag, EMIC_FLAGS } from './emic-study-flags.js';
import { getHasPerformedFirstFetch } from './streaming.js';
import { drawWaveformFromMinMax, notifyPageTurnUserDragged } from './minimap-window-renderer.js';
import { drawWaveformXAxis } from './waveform-x-axis-renderer.js';
import { drawSpectrogramXAxis } from './spectrogram-x-axis-renderer.js';
import { updateSpectrogramViewportFromZoom, renderCompleteSpectrogramForRegion, setScrollZoomHiRes, notifyInteractionStart, notifyInteractionEnd } from './main-window-renderer.js';
import { updateAllFeatureBoxPositions } from './spectrogram-feature-boxes.js';
import { getBaseTileDuration, TILE_COLS } from './spectrogram-pyramid.js';
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

    // 'f' key: Toggle flags panel (localhost only)
    if ((event.key === 'f' || event.key === 'F') && isLocalEnvironment()) {
        const btn = document.getElementById('showFlagsBtn');
        if (btn) {
            event.preventDefault();
            btn.click();
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
    
    // Backtick: Toggle settings drawer (advanced mode only)
    if (event.key === '`') {
        const displayMode = document.getElementById('displayMode')?.value;
        if (displayMode === 'advanced') {
            event.preventDefault();
            const drawer = document.getElementById('settingsDrawer');
            if (drawer) {
                if (drawer.classList.contains('open')) {
                    drawer.classList.remove('open');
                    document.body.classList.remove('drawer-open');
                } else {
                    drawer.classList.add('open');
                    document.body.classList.add('drawer-open');
                }
                setTimeout(() => window.dispatchEvent(new Event('resize')), 260);
            }
        }
    }

    // Escape key: Exit feature selection mode first, then zoom back out to full view
    if (event.key === 'Escape') {
        // console.log('🔍 [ESCAPE DEBUG] Escape key pressed');
        // If typing in a field, blur it first so Escape works
        if (isTypingInField) {
            event.target.blur();
        }

        // Exit feature selection mode if active
        if (isInFrequencySelectionMode()) {
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

    // Spacebar: toggle play/pause (but not when focused on interactive elements)
    if (event.code === 'Space') {
        const isSelect = event.target.tagName === 'SELECT';
        const isButton = event.target.tagName === 'BUTTON';
        const isZoomButton = isButton && event.target.classList.contains('zoom-btn');

        // Let browser handle spacebar in form elements, except zoom buttons
        if (isTextInput || isTextarea || isSelect || (isButton && !isZoomButton) || isContentEditable) {
            return;
        }

        event.preventDefault();

        // In EMIC study flow, don't allow playback until welcome "Begin" has been clicked
        if (getEmicFlag(EMIC_FLAGS.IS_SIMULATING) && !getEmicFlag(EMIC_FLAGS.HAS_CLOSED_WELCOME)) {
            return;
        }

        const playPauseBtn = document.getElementById('playPauseBtn');
        const playbackState = State.playbackState;
        const allReceivedData = State.allReceivedData;

        if (!playPauseBtn.disabled && (playbackState !== PlaybackState.STOPPED || (allReceivedData && allReceivedData.length > 0))) {
            playPauseBtn.click();
        }
        return;
    }

    // Enter key: Begin Analysis button or trigger first fetch
    if (event.key === 'Enter' || event.keyCode === 13) {
        if (isTypingInField) {
            return;
        }

        // Check if any modal is open — if so, let the modal handle Enter
        const modalIds = ['welcomeModal', 'participantModal', 'preSurveyModal', 'postSurveyModal',
                         'activityLevelModal', 'awesfModal', 'endModal', 'beginAnalysisModal',
                         'missingStudyIdModal', 'completeConfirmationModal'];
        const isModalOpen = modalIds.some(modalId => {
            const modal = document.getElementById(modalId);
            return modal && modal.style.display !== 'none';
        });

        if (isModalOpen) {
            return;
        }

        // Priority 1: Check if "Begin Analysis" button is visible and enabled
        const completeBtn = document.getElementById('completeBtn');
        if (completeBtn &&
            completeBtn.textContent === 'Begin Analysis' &&
            !completeBtn.disabled &&
            completeBtn.style.display !== 'none' &&
            window.getComputedStyle(completeBtn).display !== 'none') {
            event.preventDefault();
            console.log('⌨️ Enter key pressed - triggering Begin Analysis button');
            completeBtn.click();
            return;
        }

        // Priority 2: In Personal Mode, trigger fetch data if fetch button is enabled (only on first load)
        if ((isPersonalMode() || isEmicStudyMode() || CURRENT_MODE === AppMode.SOLAR_PORTAL) && !getHasPerformedFirstFetch()) {
            const fetchBtn = document.getElementById('startBtn');
            if (fetchBtn &&
                !fetchBtn.disabled &&
                fetchBtn.style.display !== 'none' &&
                window.getComputedStyle(fetchBtn).display !== 'none') {
                event.preventDefault();
                console.log('⌨️ Enter key pressed - triggering fetch data (first load)');
                fetchBtn.click();
                return;
            }
        }

        return;
    }
}

// --- Arrow key hold system: tap = discrete step, hold = continuous smooth motion ---
// Stack-based: most recently pressed arrow key drives motion.
// Releasing a key only stops if it's the active one; otherwise the previous key resumes.

let arrowHoldKey = null;        // currently active arrow key
let arrowHeldKeys = [];         // stack of held arrow keys (most recent last)
let arrowHoldTimer = null;      // 100ms timer to detect hold
let arrowContinuousRaf = null;  // rAF id for continuous motion
const ARROW_HOLD_THRESHOLD_MS = 100;
// Continuous motion: ~5 discrete steps worth of movement per second (matches initial tap feel)
const ARROW_CONTINUOUS_RATE = 5.0; // steps per second

function startArrowHold(key) {
    notifyInteractionStart();
    // If a different arrow key is already held, push it to the stack
    if (arrowHoldKey && arrowHoldKey !== key) {
        // Add current active key to stack if not already there
        if (!arrowHeldKeys.includes(arrowHoldKey)) {
            arrowHeldKeys.push(arrowHoldKey);
        }
    }
    // Remove key from stack if it was there (it's now the active key)
    arrowHeldKeys = arrowHeldKeys.filter(k => k !== key);

    const wasInContinuousMotion = arrowContinuousRaf !== null;
    // Clear hold timer but preserve continuous motion rAF
    if (arrowHoldTimer) {
        clearTimeout(arrowHoldTimer);
        arrowHoldTimer = null;
    }

    arrowHoldKey = key;

    if (wasInContinuousMotion) {
        // Already in continuous motion — just switch direction, no discrete step
        return;
    }

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
    arrowHeldKeys = [];
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
    notifyInteractionEnd();
}

function handleArrowKeyUp(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' ||
        event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (event.key === arrowHoldKey) {
            // Released the active key — pop the previous key from the stack
            const prevKey = arrowHeldKeys.pop();
            if (prevKey) {
                // Resume the previous direction (already in continuous motion)
                arrowHoldKey = prevKey;
            } else {
                // No more keys held — stop everything
                stopArrowHold();
            }
        } else {
            // Released a non-active key — just remove from stack
            arrowHeldKeys = arrowHeldKeys.filter(k => k !== event.key);
        }
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
            notifyInteractionEnd();
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
        const baseTileColsInView = (viewDurationSec / getBaseTileDuration()) * TILE_COLS;
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

