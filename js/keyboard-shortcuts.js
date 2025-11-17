/**
 * keyboard-shortcuts.js
 * Keyboard shortcuts for region navigation and feature drawing
 */

import { zoomToRegion, zoomToFull, getCurrentRegions, getActiveRegionIndex, isInFrequencySelectionMode, startFrequencySelection, addFeature, createRegionFromSelectionTimes, toggleRegionPlay } from './region-tracker.js';
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
    
    document.addEventListener('keydown', handleKeyboardShortcut);
    keyboardShortcutsInitialized = true;
    console.log('⌨️ Keyboard shortcuts initialized');
}

/**
 * Cleanup keyboard shortcuts event listeners
 * 🔥 FIX: Prevents memory leaks
 */
export function cleanupKeyboardShortcuts() {
    if (keyboardShortcutsInitialized) {
        document.removeEventListener('keydown', handleKeyboardShortcut);
        keyboardShortcutsInitialized = false;
    }
}

/**
 * Handle keyboard shortcut events
 */
function handleKeyboardShortcut(event) {
    // Don't capture shortcuts when user is typing in inputs, textareas, or contenteditable elements
    const isTextInput = event.target.tagName === 'INPUT' && 
                       event.target.type !== 'range' && 
                       event.target.type !== 'checkbox';
    const isTextarea = event.target.tagName === 'TEXTAREA';
    const isContentEditable = event.target.isContentEditable;
    
    if (isTextInput || isTextarea || isContentEditable) {
        return; // Let browser handle normally
    }
    
    // Number keys (1-9): Zoom to region, or play region if already zoomed into it
    if (event.key >= '1' && event.key <= '9') {
        const regionIndex = parseInt(event.key) - 1; // Convert '1' to 0, '2' to 1, etc.
        const regions = getCurrentRegions();
        
        if (regionIndex < regions.length) {
            event.preventDefault();
            const region = regions[regionIndex];
            
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
    
    // Escape key: Zoom back out to full view
    if (event.key === 'Escape') {
        if (zoomState.isInRegion()) {
            event.preventDefault();
            zoomToFull();
            // console.log('🔙 Zoomed out to full view');
        }
        return;
    }
}

