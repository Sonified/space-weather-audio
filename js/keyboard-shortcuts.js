/**
 * keyboard-shortcuts.js
 * Keyboard shortcuts for region navigation and feature drawing
 */

import { zoomToRegion, zoomToFull, getCurrentRegions, getActiveRegionIndex, isInFrequencySelectionMode, startFrequencySelection, addFeature, createRegionFromSelectionTimes, toggleRegionPlay, stopFrequencySelection } from './region-tracker.js';
import { zoomState } from './zoom-state.js';
import * as State from './audio-state.js';
import { changeFrequencyScale } from './spectrogram-renderer.js';

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
    keyboardShortcutsInitialized = true;
    console.log('⌨️ Keyboard shortcuts initialized');
}

/**
 * Cleanup keyboard shortcuts event listeners
 * 🔥 FIX: Prevents memory leaks
 */
export function cleanupKeyboardShortcuts() {
    if (keyboardShortcutsInitialized) {
        window.removeEventListener('keydown', handleKeyboardShortcut, true);
        keyboardShortcutsInitialized = false;
    }
}

/**
 * Handle keyboard shortcut events
 */
function handleKeyboardShortcut(event) {
    // Debug: Log Escape key presses
    if (event.key === 'Escape') {
        console.log('🔍 [ESCAPE DEBUG] handleKeyboardShortcut() called with Escape key');
        console.log('🔍 [ESCAPE DEBUG] event.target:', event.target);
        console.log('🔍 [ESCAPE DEBUG] event.target.tagName:', event.target.tagName);
    }
    
    // Don't capture shortcuts when user is typing in inputs, textareas, or contenteditable elements
    // EXCEPT for Escape key - Escape should always work to exit modes/zoom out
    const isTextInput = event.target.tagName === 'INPUT' && 
                       event.target.type !== 'range' && 
                       event.target.type !== 'checkbox';
    const isTextarea = event.target.tagName === 'TEXTAREA';
    const isContentEditable = event.target.isContentEditable;
    
    // Allow Escape key to work even when in text inputs/textareas
    const isEscapeKey = event.key === 'Escape';
    const isTypingInField = isTextInput || isTextarea || isContentEditable;
    
    if (isTypingInField && !isEscapeKey) {
        return; // Let browser handle normally (but not Escape)
    }
    
    // Debug: Log all key presses during tutorial (can be removed later)
    if (event.key === 'Escape' || (event.key >= '1' && event.key <= '9')) {
        console.log(`⌨️ Keyboard shortcut handler called: key=${event.key}, target=${event.target.tagName}`);
    }
    
    // Number keys (1-9): Zoom to region, or play region if already zoomed into it
    if (event.key >= '1' && event.key <= '9') {
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
    
    // 'f' key: Create new feature or enable feature drawing (only when zoomed into a region)
    if (event.key === 'f' || event.key === 'F') {
        if (!zoomState.isInRegion()) {
            return; // Only works when zoomed into a region
        }
        
        event.preventDefault();
        
        const activeRegionIndex = getActiveRegionIndex();
        if (activeRegionIndex === null) {
            console.warn('⚠️ Cannot create feature: no active region');
            return;
        }
        
        const regions = getCurrentRegions();
        const region = regions[activeRegionIndex];
        
        if (!region) {
            console.warn('⚠️ Cannot create feature: region not found');
            return;
        }
        
        // Check if we're already in feature selection mode
        if (isInFrequencySelectionMode()) {
            // Already in feature mode - do nothing
            return;
        }
        
        // Find the first feature that's ready for feature drawing (missing frequency or time data)
        const readyFeatureIndex = region.features.findIndex(feature => 
            !feature.lowFreq || !feature.highFreq || !feature.startTime || !feature.endTime
        );
        
        if (readyFeatureIndex !== -1) {
            // Found a feature ready for drawing - enable feature drawing for it
            startFrequencySelection(activeRegionIndex, readyFeatureIndex);
            console.log(`🎯 Enabled feature drawing for feature ${readyFeatureIndex + 1} in region ${activeRegionIndex + 1}`);
        } else {
            // No feature ready for drawing - create a new feature
            // Check if we've reached the maximum (10 features)
            if (region.featureCount >= 10) {
                console.warn('⚠️ Maximum features (10) reached');
                return;
            }
            
            addFeature(activeRegionIndex);
            console.log(`➕ Created new feature in region ${activeRegionIndex + 1}`);
            
            // The new feature will automatically enter selection mode (handled by addFeature)
        }
        return;
    }
    
    // 'r' key: Confirm/add region from current selection
    if (event.key === 'r' || event.key === 'R') {
        // Check if there's a valid selection
        if (State.selectionStart !== null && State.selectionEnd !== null) {
            event.preventDefault();
            createRegionFromSelectionTimes(State.selectionStart, State.selectionEnd);
            console.log('✅ Region created from selection');
        }
        return;
    }
    
    // Frequency scale shortcuts: 'c' for linear, 'v' for square root, 'b' for logarithmic
    if (event.key === 'c' || event.key === 'C') {
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
    
    if (event.key === 'v' || event.key === 'V') {
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
    
    if (event.key === 'b' || event.key === 'B') {
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
        console.log('🔍 [ESCAPE DEBUG] Escape key pressed');
        console.log('🔍 [ESCAPE DEBUG] isTypingInField:', isTypingInField);
        console.log('🔍 [ESCAPE DEBUG] isInFrequencySelectionMode():', isInFrequencySelectionMode());
        console.log('🔍 [ESCAPE DEBUG] zoomState.isInRegion():', zoomState.isInRegion());
        console.log('🔍 [ESCAPE DEBUG] zoomState:', {
            mode: zoomState.mode,
            activeRegionId: zoomState.activeRegionId,
            initialized: zoomState.isInitialized()
        });
        
        // If typing in a field, blur it first so Escape works
        if (isTypingInField) {
            console.log('🔍 [ESCAPE DEBUG] Blurring active input/textarea');
            event.target.blur();
        }
        
        // First priority: Exit feature selection mode if active
        if (isInFrequencySelectionMode()) {
            console.log('🔍 [ESCAPE DEBUG] Exiting feature selection mode');
            event.preventDefault();
            stopFrequencySelection();
            return;
        }
        
        // Second priority: Zoom out if in a region
        if (zoomState.isInRegion()) {
            console.log('🔍 [ESCAPE DEBUG] In region - preventing default and calling zoomToFull()');
            event.preventDefault();
            zoomToFull();
            console.log('🔙 Escape key: Zoomed out to full view');
        } else {
            console.log('🔍 [ESCAPE DEBUG] NOT in region and NOT in feature selection - Escape key ignored');
        }
        return;
    }
}

