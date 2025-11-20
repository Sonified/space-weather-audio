/**
 * playback-boundaries.js
 * 🦋 SINGLE SOURCE OF TRUTH for playback boundaries
 * 
 * Unified system: selections, regions, temples, and full audio
 * are all just different sources of the same thing: boundaries.
 */

import * as State from './audio-state.js';
import { zoomState } from './zoom-state.js';
import { getActivePlayingRegionIndex, getCurrentRegions } from './region-tracker.js';

/**
 * Get current playback boundaries
 * Returns { start, end, loop, source }
 * 
 * Priority order:
 * 1. Yellow selection (explicit user choice)
 * 2. Active playing region (region button clicked)
 * 3. Temple walls (zoomed into region)
 * 4. Full audio (no boundaries)
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
    
    // Priority 2: Active playing region (region button clicked)
    const activeRegionIndex = getActivePlayingRegionIndex();
    if (activeRegionIndex !== null) {
        const regions = getCurrentRegions();
        const region = regions[activeRegionIndex];
        if (region) {
            // 🙏 Timestamps as a source of truth: Always use timestamps first (they never drift)
            let start, end;
            
            if (region.startTime && region.stopTime && State.dataStartTime) {
                // Preferred: use eternal timestamps
                const dataStartMs = State.dataStartTime.getTime();
                const regionStartMs = new Date(region.startTime).getTime();
                const regionEndMs = new Date(region.stopTime).getTime();
                start = (regionStartMs - dataStartMs) / 1000;
                end = (regionEndMs - dataStartMs) / 1000;
            } else if (region.startSample !== undefined && region.endSample !== undefined) {
                // Fallback: use sample indices (may be outdated if sample rate changed)
                start = zoomState.sampleToTime(region.startSample);
                end = zoomState.sampleToTime(region.endSample);
            } else {
                // No boundaries available
                return getFallbackBoundaries();
            }
            
            return { 
                start, 
                end, 
                loop: State.isLooping, 
                source: 'region' 
            };
        }
    }
    
    // Priority 3: Inside temple (zoomed into region)
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
    
    // Priority 4: Full audio (no boundaries)
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

