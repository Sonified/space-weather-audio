/**
 * zoom-state.js
 * Sacred coordinate system manager - all positions flow from Sample Truth
 * 
 * Philosophy: Regions are like temples with sacred walls.
 * Their positions are eternal (stored as sample indices).
 * We merely project them onto different viewing surfaces (pixels, time, etc).
 */

import * as State from './audio-state.js';

class ZoomState {
    constructor() {
        // Current view mode
        // 🏛️ 'full' = viewing the entire audio, 'region' = zoomed into a region (entering the temple)
        this.mode = 'full';  // 'full' | 'region'

        // 🙏 Timestamps as source of truth: Viewport bounds stored as Date objects (absolute time references)
        // Sample indices are calculated on-the-fly from these timestamps
        this.currentViewStartTime = null;  // Date object
        this.currentViewEndTime = null;    // Date object

        // Reference to complete dataset (still needed for some legacy code)
        this.totalSamples = 0;  // Set when audio loads

        // 🏛️ Active region ID when zoomed (the temple we're currently inside)
        this.activeRegionId = null;
    }

    /**
     * Get the sample rate for coordinate calculations
     * 
     * ⭐ THIS IS THE KEY FIX:
     * We use playback_samples_per_real_second, which tells us how many
     * 44.1kHz samples represent one second of real-world time.
     * 
     * This is consistent with what the worklet uses for position tracking.
     */
    get sampleRate() {
        // ⭐ Use playback_samples_per_real_second (the key fix!)
        // This is: totalPlaybackSamples / realWorldTimeSpanSeconds
        // e.g., 26,000,000 samples / 21,600 seconds ≈ 1,200 samples per real second
        const rate = State.currentMetadata?.playback_samples_per_real_second 
                  || State.currentMetadata?.original_sample_rate  // Legacy fallback
                  || 1200;  // Reasonable default
        
        return rate;
    }
    
    /**
     * Get the playback sample rate (44.1kHz)
     * Use this when you need the actual AudioContext rate
     */
    get playbackSampleRate() {
        return State.currentMetadata?.playback_sample_rate || 44100;
    }
    
    /**
     * Get the instrument sampling rate (for Y-axis labels only)
     * This is the original spacecraft sensor rate
     */
    get instrumentSampleRate() {
        return State.currentMetadata?.instrument_sampling_rate || 1;
    }
    
    /**
     * Convert original sample index to resampled sample index
     * 
     * ⚠️ LEGACY METHOD: With the new domain separation, everything is already in the playback domain.
     * This method is kept for backward compatibility but now just returns the input.
     * Regions are recalculated from timestamps when loaded, so they're already in the correct domain.
     */
    originalToResampledSample(originalSample) {
        // Everything is now in playback domain, so this is just an identity function
        return originalSample;
    }
    
    /**
     * Convert resampled sample index to original sample index
     * 
     * ⚠️ LEGACY METHOD: With the new domain separation, everything is already in the playback domain.
     * This method is kept for backward compatibility but now just returns the input.
     */
    resampledToOriginalSample(resampledSample) {
        // Everything is now in playback domain, so this is just an identity function
        return resampledSample;
    }
    
    /**
     * Initialize zoom state when audio data is loaded
     * @param {number} totalSamples - Total samples in PLAYBACK domain (44.1kHz)
     */
    initialize(totalSamples) {
        if (totalSamples <= 0) {
            console.warn('⚠️ ZoomState.initialize: Invalid totalSamples:', totalSamples);
            return;
        }
        this.totalSamples = totalSamples;
        // Set viewport timestamps to full data range
        this.currentViewStartTime = State.dataStartTime ? new Date(State.dataStartTime) : null;
        this.currentViewEndTime = State.dataEndTime ? new Date(State.dataEndTime) : null;
        // console.log(`🏛️ ZoomState initialized:`);
        // console.log(`   Total samples: ${totalSamples.toLocaleString()} (playback domain)`);
        // console.log(`   Sample rate: ${this.sampleRate.toFixed(2)} (samples per real second)`);

        // if (this.currentViewStartTime && this.currentViewEndTime) {
        //     const spanSeconds = (this.currentViewEndTime - this.currentViewStartTime) / 1000;
        //     console.log(`   Time span: ${spanSeconds.toLocaleString()} seconds`);
        //
        //     // Verify the math
        //     const calculatedRate = totalSamples / spanSeconds;
        //     console.log(`   Verification: ${totalSamples} / ${spanSeconds.toFixed(0)} = ${calculatedRate.toFixed(2)} ✓`);
        // }
    }
    
    /**
     * Check if zoom state is initialized
     * 🙏 Timestamps as source of truth: Check if viewport timestamps are set
     */
    isInitialized() {
        return this.currentViewStartTime !== null && this.currentViewEndTime !== null;
    }

    /**
     * Clamp a sample index to valid range [0, totalSamples]
     */
    clampSample(sampleIndex) {
        if (this.totalSamples <= 0) {
            console.warn('⚠️ ZoomState.clampSample: Not initialized');
            return 0;
        }
        return Math.max(0, Math.min(sampleIndex, this.totalSamples));
    }

    /**
     * Get current viewport range in samples (calculated from timestamps on-the-fly)
     * 🙏 Timestamps as source of truth: Convert timestamps → seconds → samples
     */
    getViewRangeSamples() {
        if (!this.isInitialized()) {
            return 0;
        }

        const viewStartSeconds = this.timestampToSeconds(this.currentViewStartTime);
        const viewEndSeconds = this.timestampToSeconds(this.currentViewEndTime);
        const durationSeconds = viewEndSeconds - viewStartSeconds;

        return Math.floor(durationSeconds * this.sampleRate);
    }

    /**
     * 👑 Helper: Convert timestamp to seconds from data start
     * This is the bridge between eternal timestamps and ephemeral samples
     */
    timestampToSeconds(timestamp) {
        if (!State.dataStartTime || !timestamp) {
            console.warn('⚠️ timestampToSeconds: Missing dataStartTime or timestamp');
            return 0;
        }
        const dataStartMs = State.dataStartTime.getTime();
        const timestampMs = timestamp.getTime();
        return (timestampMs - dataStartMs) / 1000;
    }
    
    /**
     * 👑 Convert timestamp to pixel position for current viewport
     * TIMESTAMPS ARE KING: The primary coordinate conversion method
     */
    timestampToPixel(timestamp, canvasWidth) {
        if (!this.isInitialized() || canvasWidth <= 0 || !timestamp) {
            return 0;
        }

        const viewStartMs = this.currentViewStartTime.getTime();
        const viewEndMs = this.currentViewEndTime.getTime();
        const timestampMs = timestamp.getTime();

        // 🔥 PROTECTION: Prevent division by zero if viewport has zero duration
        const viewDuration = viewEndMs - viewStartMs;
        if (viewDuration <= 0 || !isFinite(viewDuration)) {
            return 0;
        }

        const progress = (timestampMs - viewStartMs) / viewDuration;
        return progress * canvasWidth;
    }

    /**
     * 👑 Convert pixel position to timestamp
     * TIMESTAMPS ARE KING: User clicks return timestamps (eternal truth!)
     */
    pixelToTimestamp(pixelX, canvasWidth) {
        if (!this.isInitialized() || canvasWidth <= 0) {
            return this.currentViewStartTime; // Fallback to start
        }

        const progress = Math.max(0, Math.min(1, pixelX / canvasWidth));
        const viewStartMs = this.currentViewStartTime.getTime();
        const viewEndMs = this.currentViewEndTime.getTime();
        const timestampMs = viewStartMs + (progress * (viewEndMs - viewStartMs));

        return new Date(timestampMs);
    }

    /**
     * Convert absolute sample index to pixel position for current viewport
     * 👑 DEPRECATED: Use timestampToPixel() instead! This converts sample→timestamp→pixel
     */
    sampleToPixel(sampleIndex, canvasWidth) {
        if (!this.isInitialized() || canvasWidth <= 0) {
            return 0;
        }

        // Convert sample to timestamp, then timestamp to pixel
        const timestamp = this.sampleToRealTimestamp(sampleIndex);
        if (!timestamp) return 0;

        return this.timestampToPixel(timestamp, canvasWidth);
    }

    /**
     * Convert pixel position to absolute sample index
     * 👑 DEPRECATED: Use pixelToTimestamp() instead! This converts pixel→timestamp→sample
     */
    pixelToSample(pixelX, canvasWidth) {
        if (!this.isInitialized() || canvasWidth <= 0) {
            return 0;
        }

        // Convert pixel to timestamp, then timestamp to sample
        const timestamp = this.pixelToTimestamp(pixelX, canvasWidth);
        const seconds = this.timestampToSeconds(timestamp);

        return this.clampSample(Math.floor(seconds * this.sampleRate));
    }
    
    /**
     * Convert sample index to real-world time (seconds from start)
     * Sample index is in PLAYBACK domain
     */
    sampleToTime(sampleIndex) {
        if (!this.isInitialized()) {
            return 0;
        }
        // ⭐ Use sampleRate (playback_samples_per_real_second)
        return this.clampSample(sampleIndex) / this.sampleRate;
    }
    
    /**
     * Convert real-world time (seconds) to sample index
     * Returns sample index in PLAYBACK domain
     */
    timeToSample(timeSeconds) {
        if (!this.isInitialized() || timeSeconds < 0) {
            return 0;
        }
        // ⭐ Use sampleRate (playback_samples_per_real_second)
        const sample = Math.floor(timeSeconds * this.sampleRate);
        return this.clampSample(sample);
    }
    
    /**
     * Convert absolute sample index to real-world timestamp
     * Used for axis labels and metadata
     */
    sampleToRealTimestamp(sampleIndex) {
        if (!this.isInitialized() || !State.dataStartTime || !State.dataEndTime) {
            return null;
        }
        
        const clampedSample = this.clampSample(sampleIndex);
        const progress = clampedSample / this.totalSamples;
        const totalDurationMs = State.dataEndTime.getTime() - State.dataStartTime.getTime();
        return new Date(State.dataStartTime.getTime() + (progress * totalDurationMs));
    }
    
    /**
     * Check if a sample range is visible in current viewport
     * Used to skip rendering off-screen elements
     */
    isRangeVisible(startSample, endSample) {
        if (!this.isInitialized()) {
            return false;
        }
        
        const viewStartSample = this.timeToSample(this.timestampToSeconds(this.currentViewStartTime));
        const viewEndSample = this.timeToSample(this.timestampToSeconds(this.currentViewEndTime));
        
        return endSample >= viewStartSample && startSample <= viewEndSample;
    }
    
    /**
     * Get current zoom level as a ratio
     * 1.0 = full view, 2.0 = zoomed 2x, etc.
     */
    getZoomLevel() {
        if (!this.isInitialized()) {
            return 1.0;
        }
        const viewRange = this.getViewRangeSamples();
        if (viewRange === 0) return 1.0;
        return this.totalSamples / viewRange;
    }
    
    /**
     * 🏛️ Helper: Check if we're inside a region (entering the temple)
     * When zoomed into a region, we're within its sacred walls
     * Replaces verbose: zoomState.mode === 'region' && zoomState.isInitialized()
     */
    isInRegion() {
        return this.mode === 'region' && this.isInitialized();
    }
    
    /**
     * 🏛️ Helper: Check if we're in full view mode (outside the temple)
     * Replaces: zoomState.mode === 'full'
     */
    isInFullView() {
        return this.mode === 'full';
    }
    
    /**
     * 🏛️ Helper: Get current region ID (the temple we're inside)
     * Returns null if not zoomed into a region (still outside the temple)
     * Replaces: zoomState.mode === 'region' ? zoomState.activeRegionId : null
     */
    getCurrentRegionId() {
        return this.mode === 'region' ? this.activeRegionId : null;
    }
    
    /**
     * 🏛️ Helper: Get current region range (the temple boundaries)
     * 🙏 Timestamps as source of truth: Returns timestamps and calculates samples on-the-fly
     * Returns object with startTime, endTime, startSample, endSample
     * Returns null if not zoomed into a region (outside the temple)
     */
    getRegionRange() {
        if (this.mode !== 'region' || !this.isInitialized()) {
            return null;
        }

        // 👑 Timestamps are primary - calculate samples from them
        const startSeconds = this.timestampToSeconds(this.currentViewStartTime);
        const endSeconds = this.timestampToSeconds(this.currentViewEndTime);

        return {
            startTime: new Date(this.currentViewStartTime),
            endTime: new Date(this.currentViewEndTime),
            startSample: Math.floor(startSeconds * this.sampleRate),
            endSample: Math.floor(endSeconds * this.sampleRate)
        };
    }

    /**
     * 👑 Set viewport to region timestamps (called when zooming in)
     */
    setViewportToRegion(startTime, endTime, regionId) {
        this.mode = 'region';
        this.currentViewStartTime = new Date(startTime);
        this.currentViewEndTime = new Date(endTime);
        this.activeRegionId = regionId;

        // console.log(`🏛️ Entered temple (region ${regionId}):`);
        // console.log(`   👑 Viewport: ${this.currentViewStartTime.toISOString()} to ${this.currentViewEndTime.toISOString()}`);
    }

    /**
     * 👑 Set viewport to full view (called when zooming out)
     */
    setViewportToFull() {
        this.mode = 'full';
        this.currentViewStartTime = State.dataStartTime ? new Date(State.dataStartTime) : null;
        this.currentViewEndTime = State.dataEndTime ? new Date(State.dataEndTime) : null;
        this.activeRegionId = null;

        // console.log(`🏛️ Exited temple (back to full view)`);
        // if (this.currentViewStartTime && this.currentViewEndTime) {
        //     console.log(`   👑 Viewport: ${this.currentViewStartTime.toISOString()} to ${this.currentViewEndTime.toISOString()}`);
        // }
    }
}

// Singleton instance - one source of truth for zoom state
export const zoomState = new ZoomState();

// Export class for testing
export { ZoomState };

