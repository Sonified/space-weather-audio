/**
 * playback-boundaries.js
 * 🦋 SINGLE SOURCE OF TRUTH for playback boundaries
 * 
 * Unified system: selections, temples, and full audio
 * are all just different sources of the same thing: boundaries.
 */

import * as State from './audio-state.js';
import { zoomState } from './zoom-state.js';

/**
 * Get current playback boundaries
 * Returns { start, end, loop, source }
 * 
 * Priority order:
 * 1. Yellow selection (explicit user choice)
 * 2. Temple walls (zoomed into region)
 * 3. Full audio (no boundaries)
 */
export function getCurrentPlaybackBoundaries() {
    // Priority 1: Yellow selection (explicit user choice)
    if (State.selectionStart !== null && State.selectionEnd !== null) {
        return {
            start: State.selectionStart,
            end: State.selectionEnd,
            loop: State.isLooping,
            source: 'selection'
        };
    }
    
    // Priority 2: Inside temple (zoomed into region)
    if (zoomState.isInRegion()) {
        const regionRange = zoomState.getRegionRange();
        // 🙏 Timestamps as a source of truth: Convert timestamps to seconds
        const dataStartMs = State.dataStartTime.getTime();
        const startMs = regionRange.startTime.getTime();
        const endMs = regionRange.endTime.getTime();
        const start = (startMs - dataStartMs) / 1000;
        const end = (endMs - dataStartMs) / 1000;
        
        return {
            start,
            end,
            loop: State.isLooping,
            source: 'temple'
        };
    }
    
    // Priority 3: Full audio (no boundaries)
    return getFallbackBoundaries();
}

/**
 * Fallback boundaries (full audio)
 */
function getFallbackBoundaries() {
    return {
        start: 0,
        end: State.totalAudioDuration || 0,
        loop: State.isLooping,
        source: 'full'
    };
}

/**
 * Check if playhead is at the end of current boundaries
 * Returns true if within 0.1s of the end
 */
export function isAtBoundaryEnd() {
    const b = getCurrentPlaybackBoundaries();
    return Math.abs(State.currentAudioPosition - b.end) < 0.1;
}

/**
 * Get the start position for restarting playback
 * (When user presses play while at the end)
 */
export function getRestartPosition() {
    const b = getCurrentPlaybackBoundaries();
    return b.start;
}

/**
 * Format boundaries for logging
 */
export function formatBoundaries(boundaries) {
    const b = boundaries || getCurrentPlaybackBoundaries();
    return `${b.source}: ${b.start.toFixed(2)}s-${b.end.toFixed(2)}s, loop=${b.loop}`;
}

