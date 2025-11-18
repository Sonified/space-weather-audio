/**
 * spectrogram-playhead.js
 * Draws playhead indicator on spectrogram (synchronized with waveform)
 * Uses a dedicated transparent overlay canvas for efficient rendering
 */

import * as State from './audio-state.js';
import { zoomState } from './zoom-state.js';

// Overlay canvas for playhead (separate layer - no conflicts!)
let playheadOverlayCanvas = null;
let playheadOverlayCtx = null;

// Track last playhead position to avoid unnecessary redraws
let lastPlayheadX = -1;
let lastPreviewX = -1;

/**
 * Initialize playhead overlay canvas
 * Called once when spectrogram is ready
 */
function initPlayheadOverlay() {
    if (playheadOverlayCanvas) return; // Already initialized
    
    const canvas = document.getElementById('spectrogram');
    if (!canvas) return;
    
    const container = canvas.closest('.panel');
    if (!container) return;
    
    // Create dedicated overlay canvas for playhead
    playheadOverlayCanvas = document.createElement('canvas');
    playheadOverlayCanvas.id = 'spectrogram-playhead-overlay';
    playheadOverlayCanvas.style.position = 'absolute';
    playheadOverlayCanvas.style.pointerEvents = 'none';  // Pass events through to main canvas
    playheadOverlayCanvas.style.zIndex = '11';  // Above selection overlay (z-index 10), below other UI
    playheadOverlayCanvas.style.background = 'transparent';  // See through to spectrogram
    
    // Match main canvas size and position EXACTLY
    const canvasRect = canvas.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    playheadOverlayCanvas.style.left = (canvasRect.left - containerRect.left) + 'px';
    playheadOverlayCanvas.style.top = (canvasRect.top - containerRect.top) + 'px';
    
    // Use SAME dimensions as main canvas
    playheadOverlayCanvas.width = canvas.width;
    playheadOverlayCanvas.height = canvas.height;
    playheadOverlayCanvas.style.width = canvas.offsetWidth + 'px';
    playheadOverlayCanvas.style.height = canvas.offsetHeight + 'px';
    
    playheadOverlayCtx = playheadOverlayCanvas.getContext('2d');
    container.appendChild(playheadOverlayCanvas);
    
    // Update overlay size when canvas resizes
    const resizeObserver = new ResizeObserver(() => {
        if (playheadOverlayCanvas && canvas) {
            const canvasRect = canvas.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            playheadOverlayCanvas.style.left = (canvasRect.left - containerRect.left) + 'px';
            playheadOverlayCanvas.style.top = (canvasRect.top - containerRect.top) + 'px';
            playheadOverlayCanvas.width = canvas.width;
            playheadOverlayCanvas.height = canvas.height;
            playheadOverlayCanvas.style.width = canvas.offsetWidth + 'px';
            playheadOverlayCanvas.style.height = canvas.offsetHeight + 'px';
        }
    });
    resizeObserver.observe(canvas);
    
    console.log('✅ Created spectrogram playhead overlay canvas');
}

/**
 * Draw playhead on spectrogram overlay canvas
 * Called during playback to show current position
 */
export function drawSpectrogramPlayhead() {
    // ✅ Wait for spectrogram to be ready before trying to draw playhead
    if (!State.spectrogramInitialized) {
        return;  // Spectrogram not rendered yet - wait for it
    }
    
    // Initialize overlay canvas if needed
    if (!playheadOverlayCanvas) {
        initPlayheadOverlay();
    }
    
    if (!playheadOverlayCtx) return;
    
    // Don't draw playhead while user is scrubbing
    if (State.isDragging) {
        return;
    }
    
    const width = playheadOverlayCanvas.width;
    const height = playheadOverlayCanvas.height;
    
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
        
        lastPlayheadX = playheadX;
        
        // 🎉 MUCH SIMPLER: Just clear and redraw on overlay canvas!
        // No need to restore background - overlay is transparent!
        playheadOverlayCtx.clearRect(0, 0, width, height);
        
        // Cool playhead with glow and gradient
        const time = performance.now() * 0.001;
        const pulseIntensity = 0.2 + Math.sin(time * 3) * 0.08;
        
        playheadOverlayCtx.shadowBlur = 6;
        playheadOverlayCtx.shadowColor = 'rgba(255, 100, 100, 0.45)';
        playheadOverlayCtx.shadowOffsetX = 0;
        
        const gradient = playheadOverlayCtx.createLinearGradient(playheadX, 0, playheadX, height);
        gradient.addColorStop(0, `rgba(255, 150, 150, ${(0.5 + pulseIntensity) * 0.9})`);
        gradient.addColorStop(0.5, `rgba(255, 100, 100, ${(0.6 + pulseIntensity) * 0.9})`);
        gradient.addColorStop(1, `rgba(255, 150, 150, ${(0.5 + pulseIntensity) * 0.9})`);
        
        playheadOverlayCtx.strokeStyle = gradient;
        playheadOverlayCtx.lineWidth = 2.5;
        playheadOverlayCtx.globalAlpha = 0.9;
        playheadOverlayCtx.beginPath();
        playheadOverlayCtx.moveTo(playheadX, 0);
        playheadOverlayCtx.lineTo(playheadX, height);
        playheadOverlayCtx.stroke();
        
        playheadOverlayCtx.shadowBlur = 0;
        playheadOverlayCtx.strokeStyle = `rgba(255, 255, 255, ${(0.3 + pulseIntensity * 0.2) * 0.9})`;
        playheadOverlayCtx.lineWidth = 1;
        playheadOverlayCtx.beginPath();
        playheadOverlayCtx.moveTo(playheadX, 0);
        playheadOverlayCtx.lineTo(playheadX, height);
        playheadOverlayCtx.stroke();
        
        playheadOverlayCtx.globalAlpha = 1.0;
        playheadOverlayCtx.shadowColor = 'transparent';
    }
}

// NOTE: drawSpectrogramWithOverlays() removed - no longer needed
// Selection box now renders on separate overlay canvas in spectrogram-renderer.js
// This eliminates conflicts with playhead updates, viewport refreshes, and other rendering systems

/**
 * Draw scrub preview on spectrogram overlay (white/gray line while hovering/dragging)
 * Mirrors the waveform scrub preview behavior
 */
export function drawSpectrogramScrubPreview(targetPosition, isDragging = false) {
    // ✅ Wait for spectrogram to be ready before trying to draw scrub preview
    if (!State.spectrogramInitialized) {
        return;  // Spectrogram not rendered yet - wait for it
    }
    
    // Initialize overlay canvas if needed
    if (!playheadOverlayCanvas) {
        initPlayheadOverlay();
    }
    
    if (!playheadOverlayCtx) return;
    
    if (!State.totalAudioDuration || State.totalAudioDuration === 0) return;
    
    const width = playheadOverlayCanvas.width;
    const height = playheadOverlayCanvas.height;
    
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
    
    // 🎉 MUCH SIMPLER: Just clear and draw preview line on overlay!
    playheadOverlayCtx.clearRect(0, 0, width, height);
    
    // Draw preview line (gray if dragging, white if just hovering)
    playheadOverlayCtx.globalAlpha = 0.9;
    playheadOverlayCtx.strokeStyle = isDragging ? '#bbbbbb' : '#ffffff';
    playheadOverlayCtx.lineWidth = 2;
    playheadOverlayCtx.beginPath();
    playheadOverlayCtx.moveTo(previewX, 0);
    playheadOverlayCtx.lineTo(previewX, height);
    playheadOverlayCtx.stroke();
    playheadOverlayCtx.globalAlpha = 1.0;  // Reset alpha
    
    lastPreviewX = previewX;
}

/**
 * Clear scrub preview from spectrogram overlay
 */
export function clearSpectrogramScrubPreview() {
    if (lastPreviewX < 0 || !playheadOverlayCtx) return;
    
    // 🎉 MUCH SIMPLER: Just clear overlay and redraw playhead if needed!
    const width = playheadOverlayCanvas.width;
    const height = playheadOverlayCanvas.height;
    
    playheadOverlayCtx.clearRect(0, 0, width, height);
    
    // Redraw playhead if it exists
    if (lastPlayheadX >= 0) {
        const time = performance.now() * 0.001;
        const pulseIntensity = 0.2 + Math.sin(time * 3) * 0.08;
        
        playheadOverlayCtx.shadowBlur = 6;
        playheadOverlayCtx.shadowColor = 'rgba(255, 100, 100, 0.45)';
        
        const gradient = playheadOverlayCtx.createLinearGradient(lastPlayheadX, 0, lastPlayheadX, height);
        gradient.addColorStop(0, `rgba(255, 150, 150, ${(0.5 + pulseIntensity) * 0.9})`);
        gradient.addColorStop(0.5, `rgba(255, 100, 100, ${(0.6 + pulseIntensity) * 0.9})`);
        gradient.addColorStop(1, `rgba(255, 150, 150, ${(0.5 + pulseIntensity) * 0.9})`);
        
        playheadOverlayCtx.strokeStyle = gradient;
        playheadOverlayCtx.lineWidth = 2.5;
        playheadOverlayCtx.globalAlpha = 0.9;
        playheadOverlayCtx.beginPath();
        playheadOverlayCtx.moveTo(lastPlayheadX, 0);
        playheadOverlayCtx.lineTo(lastPlayheadX, height);
        playheadOverlayCtx.stroke();
        
        playheadOverlayCtx.shadowBlur = 0;
        playheadOverlayCtx.strokeStyle = `rgba(255, 255, 255, ${(0.3 + pulseIntensity * 0.2) * 0.9})`;
        playheadOverlayCtx.lineWidth = 1;
        playheadOverlayCtx.beginPath();
        playheadOverlayCtx.moveTo(lastPlayheadX, 0);
        playheadOverlayCtx.lineTo(lastPlayheadX, height);
        playheadOverlayCtx.stroke();
        
        playheadOverlayCtx.globalAlpha = 1.0;
        playheadOverlayCtx.shadowColor = 'transparent';
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
    
    // 🎉 MUCH SIMPLER: Just clear the overlay canvas!
    if (playheadOverlayCtx && playheadOverlayCanvas) {
        playheadOverlayCtx.clearRect(0, 0, playheadOverlayCanvas.width, playheadOverlayCanvas.height);
    }
}

