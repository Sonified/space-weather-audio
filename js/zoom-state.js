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
        
        // Viewport bounds (in absolute sample indices)
        this.currentViewStartSample = 0;
        this.currentViewEndSample = 0;  // Set when audio loads
        
        // Reference to complete dataset
        this.totalSamples = 0;  // Set when audio loads
        this.sampleRate = 44100;  // AudioContext sample rate (constant)
        
        // 🏛️ Active region ID when zoomed (the temple we're currently inside)
        this.activeRegionId = null;
    }
    
    /**
     * Initialize zoom state when audio data is loaded
     * Call this once after completeSamplesArray is populated
     */
    initialize(totalSamples) {
        if (totalSamples <= 0) {
            console.warn('⚠️ ZoomState.initialize: Invalid totalSamples:', totalSamples);
            return;
        }
        
        this.totalSamples = totalSamples;
        this.currentViewEndSample = totalSamples;
        console.log(`🏛️ ZoomState initialized: ${totalSamples.toLocaleString()} samples (${(totalSamples / this.sampleRate).toFixed(1)}s)`);
    }
    
    /**
     * Check if zoom state is initialized
     */
    isInitialized() {
        return this.totalSamples > 0;
    }
    
    /**
     * Clamp a sample index to valid range [0, totalSamples]
     */
    clampSample(sampleIndex) {
        if (!this.isInitialized()) {
            console.warn('⚠️ ZoomState.clampSample: Not initialized');
            return 0;
        }
        return Math.max(0, Math.min(sampleIndex, this.totalSamples));
    }
    
    /**
     * Get current viewport range in samples
     */
    getViewRangeSamples() {
        if (!this.isInitialized()) {
            return 0;
        }
        return this.currentViewEndSample - this.currentViewStartSample;
    }
    
    /**
     * Convert absolute sample index to pixel position for current viewport
     * This is how we "project" eternal coordinates onto the canvas
     */
    sampleToPixel(sampleIndex, canvasWidth) {
        if (!this.isInitialized() || canvasWidth <= 0) {
            return 0;
        }
        
        const viewRange = this.getViewRangeSamples();
        if (viewRange === 0) return 0;
        
        const relativePosition = sampleIndex - this.currentViewStartSample;
        return (relativePosition / viewRange) * canvasWidth;
    }
    
    /**
     * Convert pixel position to absolute sample index
     * This is how user clicks/drags get translated to eternal coordinates
     */
    pixelToSample(pixelX, canvasWidth) {
        if (!this.isInitialized() || canvasWidth <= 0) {
            return 0;
        }
        
        const viewRange = this.getViewRangeSamples();
        const progress = Math.max(0, Math.min(1, pixelX / canvasWidth));
        const sample = Math.floor(this.currentViewStartSample + (progress * viewRange));
        
        // Clamp to valid range
        return this.clampSample(sample);
    }
    
    /**
     * Convert absolute sample index to audio time (seconds)
     * Used for playback positioning
     */
    sampleToTime(sampleIndex) {
        if (!this.isInitialized()) {
            return 0;
        }
        return this.clampSample(sampleIndex) / this.sampleRate;
    }
    
    /**
     * Convert audio time (seconds) to absolute sample index
     * Inverse of sampleToTime
     */
    timeToSample(timeSeconds) {
        if (!this.isInitialized() || timeSeconds < 0) {
            return 0;
        }
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
        return endSample >= this.currentViewStartSample && 
               startSample <= this.currentViewEndSample;
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
     * Returns object with startSample, endSample, startTime, endTime
     * Returns null if not zoomed into a region (outside the temple)
     */
    getRegionRange() {
        if (this.mode !== 'region' || !this.isInitialized()) {
            return null;
        }
        return {
            startSample: this.currentViewStartSample,
            endSample: this.currentViewEndSample,
            startTime: this.sampleToTime(this.currentViewStartSample),
            endTime: this.sampleToTime(this.currentViewEndSample)
        };
    }
}

// Singleton instance - one source of truth for zoom state
export const zoomState = new ZoomState();

// Export class for testing
export { ZoomState };

