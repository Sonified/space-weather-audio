/**
 * spectrogram-playhead.js
 * Draws playhead indicator on spectrogram (synchronized with waveform)
 */

import * as State from './audio-state.js';
import { getCachedSpectrogramCanvas } from './spectrogram-complete-renderer.js';

// Track last playhead position to avoid unnecessary redraws
let lastPlayheadX = -1;
let lastPreviewX = -1;

/**
 * Draw playhead on spectrogram
 * Called during playback to show current position
 */
export function drawSpectrogramPlayhead() {
    const canvas = document.getElementById('spectrogram');
    if (!canvas) return;
    
    const cachedCanvas = getCachedSpectrogramCanvas();
    if (!cachedCanvas) return;  // No cached spectrogram yet
    
    // Don't draw playhead while user is scrubbing
    if (State.isDragging) return;
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    // Calculate playhead position
    if (State.totalAudioDuration > 0 && State.currentAudioPosition >= 0) {
        const progress = Math.min(State.currentAudioPosition / State.totalAudioDuration, 1.0);
        const playheadX = Math.floor(progress * width);
        
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
        
        // Restore old playhead area (if it exists)
        if (oldPlayheadX >= 0) {
            const oldX = Math.max(0, oldPlayheadX - stripWidth);
            const oldW = Math.min(stripWidth * 2, width - oldX);
            ctx.drawImage(
                cachedCanvas,
                oldX, 0, oldW, height,  // Source
                oldX, 0, oldW, height   // Dest
            );
        }
        
        // Restore new playhead area first
        const newX = Math.max(0, playheadX - stripWidth);
        const newW = Math.min(stripWidth * 2, width - newX);
        ctx.drawImage(
            cachedCanvas,
            newX, 0, newW, height,  // Source
            newX, 0, newW, height   // Dest
        );
        
        // Draw faint grey playhead line (non-interactive)
        ctx.globalAlpha = 0.6;
        ctx.strokeStyle = '#808080';  // Grey color
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(playheadX, 0);
        ctx.lineTo(playheadX, height);
        ctx.stroke();
        ctx.globalAlpha = 1.0;  // Reset alpha
    }
}

/**
 * Draw scrub preview on spectrogram (white/gray line while hovering/dragging)
 * Mirrors the waveform scrub preview behavior
 */
export function drawSpectrogramScrubPreview(targetPosition, isDragging = false) {
    const canvas = document.getElementById('spectrogram');
    if (!canvas) return;
    
    const cachedCanvas = getCachedSpectrogramCanvas();
    if (!cachedCanvas) return;
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    if (!State.totalAudioDuration || State.totalAudioDuration === 0) return;
    
    const progress = Math.min(targetPosition / State.totalAudioDuration, 1.0);
    const previewX = Math.floor(progress * width);
    
    // KEEP IT SIMPLE: Clear and redraw from cache (like waveform does)
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(cachedCanvas, 0, 0);
    
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
    
    const canvas = document.getElementById('spectrogram');
    const cachedCanvas = getCachedSpectrogramCanvas();
    if (!canvas || !cachedCanvas) return;
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    const stripWidth = 4;
    const oldX = Math.max(0, lastPreviewX - stripWidth);
    const oldW = Math.min(stripWidth * 2, width - oldX);
    
    // Restore the area
    ctx.drawImage(
        cachedCanvas,
        oldX, 0, oldW, height,
        oldX, 0, oldW, height
    );
    
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
    lastPlayheadX = -1;
    lastPreviewX = -1;
    
    // Fully redraw from cache to clear any old playhead
    const canvas = document.getElementById('spectrogram');
    const cachedCanvas = getCachedSpectrogramCanvas();
    if (canvas && cachedCanvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(cachedCanvas, 0, 0);
    }
}

