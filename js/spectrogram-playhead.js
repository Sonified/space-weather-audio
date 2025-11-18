/**
 * spectrogram-playhead.js
 * Draws playhead indicator on spectrogram (synchronized with waveform)
 */

import * as State from './audio-state.js';
import { getSpectrogramViewport } from './spectrogram-complete-renderer.js';
import { zoomState } from './zoom-state.js';
import { drawSpectrogramRegionHighlights, drawSpectrogramSelection } from './region-tracker.js';

// Track last playhead position to avoid unnecessary redraws
let lastPlayheadX = -1;
let lastPreviewX = -1;

/**
 * Draw playhead on spectrogram
 * Called during playback to show current position
 */
export function drawSpectrogramPlayhead() {
    // console.log(`▶️ [spectrogram-playhead.js] drawSpectrogramPlayhead CALLED`);
    
    // ✅ Wait for spectrogram to be ready before trying to draw playhead
    if (!State.spectrogramInitialized) {
        return;  // Spectrogram not rendered yet - wait for it
    }
    
    const canvas = document.getElementById('spectrogram');
    if (!canvas) return;
    
    // 🔧 FIX: Get the CURRENT viewport (stretched for playback rate), not the unstretched cache!
    const playbackRate = State.currentPlaybackRate || 1.0;
    const viewportCanvas = getSpectrogramViewport(playbackRate);
    
    if (!viewportCanvas) {
        // No viewport available yet - fallback check (shouldn't happen if spectrogramInitialized is true)
        return;
    }
    
    // Don't draw playhead while user is scrubbing
    if (State.isDragging) {
        console.log(`⚠️ [spectrogram-playhead.js] drawSpectrogramPlayhead: Skipping (dragging)`);
        return;
    }
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    // Calculate playhead position
    if (State.totalAudioDuration > 0 && State.currentAudioPosition >= 0) {
        // 🏛️ Use zoom-aware conversion
        let playheadX;
        if (zoomState.isInitialized()) {
            const sample = zoomState.timeToSample(State.currentAudioPosition);
            playheadX = Math.floor(zoomState.sampleToPixel(sample, width));
        } else {
            // Fallback to old behavior if zoom state not initialized
        const progress = Math.min(State.currentAudioPosition / State.totalAudioDuration, 1.0);
            playheadX = Math.floor(progress * width);
        }
        
        // Only redraw if playhead moved to a different pixel
        if (playheadX === lastPlayheadX) {
            return;  // Skip redraw - same position
        }
        
        const oldPlayheadX = lastPlayheadX;
        lastPlayheadX = playheadX;
        
        // OPTIMIZATION: Only redraw the narrow strips that changed
        // Instead of redrawing entire 1200x450 canvas (540k pixels),
        // only redraw the old playhead strip and new playhead strip
        
        const stripWidth = 4;  // Redraw 4px wide strips (2px line + 1px margin each side)
        
        // Restore old playhead area from VIEWPORT (not cache!)
        if (oldPlayheadX >= 0) {
            const oldX = Math.max(0, oldPlayheadX - stripWidth);
            const oldW = Math.min(stripWidth * 2, width - oldX);
            ctx.drawImage(
                viewportCanvas,  // 🔧 FIX: Use viewport, not cache!
                oldX, 0, oldW, height,  // Source
                oldX, 0, oldW, height   // Dest
            );
            
            // 🎨 Redraw regions/selections in this strip
            // COMMENTED OUT: Don't draw bars or yellow background when in zoomed region mode
            // ctx.save();
            // ctx.beginPath();
            // ctx.rect(oldX, 0, oldW, height);
            // ctx.clip();
            // if (!zoomState.isInRegion()) {
            //     drawSpectrogramRegionHighlights(ctx, width, height);
            //     drawSpectrogramSelection(ctx, width, height);
            // }
            // ctx.restore();
        }
        
        // Restore new playhead area from VIEWPORT
        const newX = Math.max(0, playheadX - stripWidth);
        const newW = Math.min(stripWidth * 2, width - newX);
        ctx.drawImage(
            viewportCanvas,  // 🔧 FIX: Use viewport, not cache!
            newX, 0, newW, height,  // Source
            newX, 0, newW, height   // Dest
        );
        
        // 🎨 Redraw regions/selections in this strip
        // COMMENTED OUT: Don't draw bars or yellow background when in zoomed region mode
        // ctx.save();
        // ctx.beginPath();
        // ctx.rect(newX, 0, newW, height);
        // ctx.clip();
        // if (!zoomState.isInRegion()) {
        //     drawSpectrogramRegionHighlights(ctx, width, height);
        //     drawSpectrogramSelection(ctx, width, height);
        // }
        // ctx.restore();
        
        // Draw faint grey playhead line (non-interactive)
        ctx.globalAlpha = 0.6;
        ctx.strokeStyle = '#808080';  // Grey color
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(playheadX, 0);
        ctx.lineTo(playheadX, height);
        ctx.stroke();
        ctx.globalAlpha = 1.0;  // Reset alpha
        
        // NOTE: Selection box now drawn on separate overlay canvas (spectrogram-renderer.js)
    }
}

// NOTE: drawSpectrogramWithOverlays() removed - no longer needed
// Selection box now renders on separate overlay canvas in spectrogram-renderer.js
// This eliminates conflicts with playhead updates, viewport refreshes, and other rendering systems

/**
 * Draw scrub preview on spectrogram (white/gray line while hovering/dragging)
 * Mirrors the waveform scrub preview behavior
 */
export function drawSpectrogramScrubPreview(targetPosition, isDragging = false) {
    // console.log(`👆 [spectrogram-playhead.js] drawSpectrogramScrubPreview CALLED: targetPosition=${targetPosition.toFixed(2)}, isDragging=${isDragging}`);
    
    // ✅ Wait for spectrogram to be ready before trying to draw scrub preview
    if (!State.spectrogramInitialized) {
        return;  // Spectrogram not rendered yet - wait for it
    }
    
    const canvas = document.getElementById('spectrogram');
    if (!canvas) return;
    
    // 🔧 FIX: Get the CURRENT viewport (stretched for playback rate), not the unstretched cache!
    const playbackRate = State.currentPlaybackRate || 1.0;
    const viewportCanvas = getSpectrogramViewport(playbackRate);
    
    if (!viewportCanvas) {
        // No viewport available yet - fallback check (shouldn't happen if spectrogramInitialized is true)
        return;
    }
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    if (!State.totalAudioDuration || State.totalAudioDuration === 0) return;
    
    // 🏛️ Use zoom-aware conversion
    let previewX;
    if (zoomState.isInitialized()) {
        const sample = zoomState.timeToSample(targetPosition);
        previewX = Math.floor(zoomState.sampleToPixel(sample, width));
    } else {
        // Fallback to old behavior if zoom state not initialized
    const progress = Math.min(targetPosition / State.totalAudioDuration, 1.0);
        previewX = Math.floor(progress * width);
    }
    
    // KEEP IT SIMPLE: Clear and redraw from VIEWPORT (not cache!)
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(viewportCanvas, 0, 0);  // 🔧 FIX: Use viewport, not cache!
    
    // 🎨 Redraw regions/selections on top
    // COMMENTED OUT: Don't draw bars or yellow background when in zoomed region mode
    // if (!zoomState.isInRegion()) {
    //     drawSpectrogramRegionHighlights(ctx, width, height);
    //     drawSpectrogramSelection(ctx, width, height);
    // }
    
    // Draw preview line (gray if dragging, white if just hovering)
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = isDragging ? '#bbbbbb' : '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(previewX, 0);
    ctx.lineTo(previewX, height);
    ctx.stroke();
    ctx.globalAlpha = 1.0;  // Reset alpha
    
    lastPreviewX = previewX;
}

/**
 * Clear scrub preview from spectrogram
 */
export function clearSpectrogramScrubPreview() {
    if (lastPreviewX < 0) return;
    
    // console.log(`🧹 [spectrogram-playhead.js] clearSpectrogramScrubPreview CALLED`);
    
    const canvas = document.getElementById('spectrogram');
    if (!canvas) return;
    
    // 🔧 FIX: Get the CURRENT viewport (stretched for playback rate), not the unstretched cache!
    const playbackRate = State.currentPlaybackRate || 1.0;
    const viewportCanvas = getSpectrogramViewport(playbackRate);
    if (!viewportCanvas) return;
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    const stripWidth = 4;
    const oldX = Math.max(0, lastPreviewX - stripWidth);
    const oldW = Math.min(stripWidth * 2, width - oldX);
    
    // Restore the area from VIEWPORT (not cache!)
    ctx.drawImage(
        viewportCanvas,  // 🔧 FIX: Use viewport, not cache!
        oldX, 0, oldW, height,
        oldX, 0, oldW, height
    );
    
    // 🎨 Redraw regions/selections in this strip
    // COMMENTED OUT: Don't draw bars or yellow background when in zoomed region mode
    // ctx.save();
    // ctx.beginPath();
    // ctx.rect(oldX, 0, oldW, height);
    // ctx.clip();
    // if (!zoomState.isInRegion()) {
    //     drawSpectrogramRegionHighlights(ctx, width, height);
    //     drawSpectrogramSelection(ctx, width, height);
    // }
    // ctx.restore();
    
    // Redraw faint grey playhead if it was in that area
    if (lastPlayheadX >= 0 && Math.abs(lastPlayheadX - lastPreviewX) < stripWidth * 2) {
        ctx.globalAlpha = 0.6;
        ctx.strokeStyle = '#808080';  // Grey color
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(lastPlayheadX, 0);
        ctx.lineTo(lastPlayheadX, height);
        ctx.stroke();
        ctx.globalAlpha = 1.0;  // Reset alpha
    }
    
    lastPreviewX = -1;
}

/**
 * Reset playhead tracking (call when loading new audio)
 */
export function resetSpectrogramPlayhead() {
    console.log(`🔄 [spectrogram-playhead.js] resetSpectrogramPlayhead CALLED`);
    
    lastPlayheadX = -1;
    lastPreviewX = -1;
    
    // Fully redraw from VIEWPORT to clear any old playhead
    const canvas = document.getElementById('spectrogram');
    if (!canvas) return;
    
    // 🔧 FIX: Get the CURRENT viewport (stretched for playback rate), not the unstretched cache!
    const playbackRate = State.currentPlaybackRate || 1.0;
    const viewportCanvas = getSpectrogramViewport(playbackRate);
    if (viewportCanvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(viewportCanvas, 0, 0);  // 🔧 FIX: Use viewport, not cache!
        
        // 🎨 Redraw regions/selections on top
        // COMMENTED OUT: Don't draw bars or yellow background when in zoomed region mode
        // if (!zoomState.isInRegion()) {
        //     drawSpectrogramRegionHighlights(ctx, canvas.width, canvas.height);
        //     drawSpectrogramSelection(ctx, canvas.width, canvas.height);
        // }
    }
}

