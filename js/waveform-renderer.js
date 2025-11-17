/**
 * waveform-renderer.js
 * Waveform drawing, interaction (scrubbing, selection), and playback indicator
 */

import * as State from './audio-state.js';
import { PlaybackState } from './audio-state.js';
import { seekToPosition, updateWorkletSelection } from './audio-player.js';
import { positionWaveformAxisCanvas, drawWaveformAxis } from './waveform-axis-renderer.js';
import { positionWaveformXAxisCanvas, drawWaveformXAxis, positionWaveformDateCanvas, drawWaveformDate, getInterpolatedTimeRange } from './waveform-x-axis-renderer.js';
import { drawRegionHighlights, showAddRegionButton, hideAddRegionButton, clearActiveRegion, resetAllRegionPlayButtons, getActiveRegionIndex, isPlayingActiveRegion, checkCanvasZoomButtonClick, checkCanvasPlayButtonClick, zoomToRegion, zoomToFull, getRegions, toggleRegionPlay } from './region-tracker.js';
import { drawRegionButtons } from './waveform-buttons-renderer.js';
import { printSelectionDiagnostics } from './selection-diagnostics.js';
import { drawSpectrogramPlayhead, drawSpectrogramScrubPreview, clearSpectrogramScrubPreview } from './spectrogram-playhead.js';
import { zoomState } from './zoom-state.js';

// Debug flag for waveform logs (set to true to enable detailed logging)
const DEBUG_WAVEFORM = false;

// Helper functions
function removeDCOffset(data, alpha = 0.995) {
    let mean = data[0];
    const y = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
        mean = alpha * mean + (1 - alpha) * data[i];
        y[i] = data[i] - mean;
    }
    return y;
}

function normalize(data) {
    let min = data[0];
    let max = data[0];
    for (let i = 1; i < data.length; i++) {
        if (data[i] < min) min = data[i];
        if (data[i] > max) max = data[i];
    }
    
    if (max === min) {
        return new Float32Array(data.length);
    }
    
    const normalized = new Float32Array(data.length);
    const range = max - min;
    for (let i = 0; i < data.length; i++) {
        normalized[i] = 2 * (data[i] - min) / range - 1;
    }
    
    return normalized;
}

export function drawWaveform() {
    console.log(`🎨 drawWaveform() called, completeSamplesArray length: ${State.completeSamplesArray ? State.completeSamplesArray.length : 'null'}`);
    
    if (!State.completeSamplesArray || State.completeSamplesArray.length === 0) {
        console.log(`⚠️ drawWaveform() aborted: no data`);
        return;
    }
    
    const canvas = document.getElementById('waveform');
    if (!canvas) return;
    
    const width = canvas.offsetWidth * window.devicePixelRatio;
    const height = canvas.offsetHeight * window.devicePixelRatio;
    
    const sampleRate = 44100;
    State.setTotalAudioDuration(State.completeSamplesArray.length / sampleRate);
    
    const removeDC = document.getElementById('removeDCOffset').checked;
    const slider = document.getElementById('waveformFilterSlider');
    const sliderValue = parseInt(slider.value);
    const alpha = 0.95 + (sliderValue / 100) * (0.9999 - 0.95);
    
    // 🏛️ Check if we're zoomed into a region
    let startSample = 0;
    let endSample = State.completeSamplesArray.length;
    let zoomInfo = 'full view';
    
    // 🏛️ Check if we're inside a region (within the temple walls)
    if (zoomState.isInRegion()) {
        const regionRange = zoomState.getRegionRange();
        startSample = regionRange.startSample;
        endSample = regionRange.endSample;
        const zoomLevel = zoomState.getZoomLevel();
        zoomInfo = `zoomed ${zoomLevel.toFixed(1)}x (samples ${startSample.toLocaleString()}-${endSample.toLocaleString()})`;
    }
    
    console.log(`🎨 Sending to waveform worker: ${width}px wide, ${zoomInfo}`);
    
    State.waveformWorker.postMessage({
        type: 'build-waveform',
        canvasWidth: width,
        canvasHeight: height,
        removeDC: removeDC,
        alpha: alpha,
        isComplete: true,
        totalExpectedSamples: State.completeSamplesArray.length,
        // 🏛️ NEW: Send zoom range to worker
        startSample: startSample,
        endSample: endSample
    });
}

export function drawWaveformFromMinMax() {
    if (!State.waveformMinMaxData) {
        console.log(`⚠️ drawWaveformFromMinMax() aborted: no min/max data`);
        return;
    }
    
    const canvas = document.getElementById('waveform');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width = canvas.offsetWidth * window.devicePixelRatio;
    const height = canvas.height = canvas.offsetHeight * window.devicePixelRatio;
    
    if (State.isShowingFinalWaveform && State.cachedWaveformCanvas) {
        const oldCanvas = document.createElement('canvas');
        oldCanvas.width = width;
        oldCanvas.height = height;
        oldCanvas.getContext('2d').drawImage(State.cachedWaveformCanvas, 0, 0);
        
        const newCanvas = document.createElement('canvas');
        newCanvas.width = width;
        newCanvas.height = height;
        const newCtx = newCanvas.getContext('2d');
        
        newCtx.fillStyle = '#000';
        newCtx.fillRect(0, 0, width, height);
        
        newCtx.fillStyle = '#e8c0c0';
        const mid = height / 2;
        const { mins, maxs } = State.waveformMinMaxData;
        
        for (let x = 0; x < mins.length && x < width; x++) {
            const min = mins[x];
            const max = maxs[x];
            const yMin = mid + (min * mid * 0.9);
            const yMax = mid + (max * mid * 0.9);
            const lineHeight = Math.max(1, yMax - yMin);
            newCtx.fillRect(x, yMin, 1, lineHeight);
        }
        
        newCtx.strokeStyle = '#666';
        newCtx.lineWidth = 1;
        newCtx.beginPath();
        newCtx.moveTo(0, mid);
        newCtx.lineTo(width, mid);
        newCtx.stroke();
        
        if (State.crossfadeAnimation) cancelAnimationFrame(State.crossfadeAnimation);
        const startTime = performance.now();
        const duration = 300;
        
        const animate = () => {
            // 🔥 FIX: Check document connection before executing RAF callback
            // This prevents RAF callbacks from retaining references to detached documents
            if (!document.body || !document.body.isConnected) {
                State.setCrossfadeAnimation(null);
                return; // Document is detached, stop the animation
            }
            
            const elapsed = performance.now() - startTime;
            const progress = Math.min(elapsed / duration, 1.0);
            
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, width, height);
            
            ctx.globalAlpha = 1.0 - progress;
            ctx.drawImage(oldCanvas, 0, 0);
            
            ctx.globalAlpha = progress;
            ctx.drawImage(newCanvas, 0, 0);
            
            ctx.globalAlpha = 1.0;
            
            if (State.totalAudioDuration > 0 && State.currentAudioPosition >= 0) {
                const playheadProgress = Math.min(State.currentAudioPosition / State.totalAudioDuration, 1.0);
                const playheadX = playheadProgress * width;
                
                ctx.strokeStyle = '#ff0000';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(playheadX, 0);
                ctx.lineTo(playheadX, height);
                ctx.stroke();
            }
            
            // 🔥 Draw regions during crossfade so they stay visible throughout the transition
            drawRegionHighlights(ctx);
            drawRegionButtons(); // Draw buttons on overlay canvas
            
            if (progress < 1.0) {
                State.setCrossfadeAnimation(requestAnimationFrame(animate));
            } else {
                const cachedCanvas = document.createElement('canvas');
                cachedCanvas.width = width;
                cachedCanvas.height = height;
                cachedCanvas.getContext('2d').drawImage(newCanvas, 0, 0);
                State.setCachedWaveformCanvas(cachedCanvas);
                
                // Draw waveform axis after crossfade completes
                positionWaveformAxisCanvas();
                drawWaveformAxis();
                positionWaveformXAxisCanvas();
                drawWaveformXAxis();
                positionWaveformDateCanvas();
                drawWaveformDate();
                
                console.log(`✅ Waveform crossfade complete - pink detrended waveform`);
                
                if (State.totalAudioDuration > 0) {
                    drawWaveformWithSelection();
                }
            }
        };
        animate();
        
    } else {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        
        ctx.fillStyle = '#888888';
        const mid = height / 2;
        
        const { mins, maxs } = State.waveformMinMaxData;
        
        for (let x = 0; x < mins.length && x < width; x++) {
            const min = mins[x];
            const max = maxs[x];
            
            const yMin = mid + (min * mid * 0.9);
            const yMax = mid + (max * mid * 0.9);
            
            const lineHeight = Math.max(1, yMax - yMin);
            ctx.fillRect(x, yMin, 1, lineHeight);
        }
        
        ctx.strokeStyle = '#666';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, mid);
        ctx.lineTo(width, mid);
        ctx.stroke();
        
        const cachedCanvas = document.createElement('canvas');
        cachedCanvas.width = width;
        cachedCanvas.height = height;
        const cacheCtx = cachedCanvas.getContext('2d');
        cacheCtx.drawImage(canvas, 0, 0);
        State.setCachedWaveformCanvas(cachedCanvas);
        
        // Draw waveform axis after waveform is drawn
        positionWaveformAxisCanvas();
        drawWaveformAxis();
        positionWaveformXAxisCanvas();
        drawWaveformXAxis();
        positionWaveformDateCanvas();
        drawWaveformDate();
        
        if (DEBUG_WAVEFORM) console.log(`✅ Waveform drawn from min/max data (${mins.length} pixels) - progressive`);
    }
}

/**
 * Draw waveform with smooth zoom interpolation during transitions
 * Stretches the cached waveform to match the interpolating time range
 */
export function drawInterpolatedWaveform() {
    const canvas = document.getElementById('waveform');
    if (!canvas || !State.cachedWaveformCanvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    // Get the interpolated time range (same range the ticks are using)
    const interpolatedRange = getInterpolatedTimeRange();

    // Calculate what portion of the cached canvas to draw
    const dataStartMs = State.dataStartTime.getTime();
    const dataEndMs = State.dataEndTime.getTime();
    const dataDurationMs = dataEndMs - dataStartMs;

    const interpStartMs = interpolatedRange.startTime.getTime();
    const interpEndMs = interpolatedRange.endTime.getTime();

    // Calculate source rectangle in the cached canvas
    const startProgress = (interpStartMs - dataStartMs) / dataDurationMs;
    const endProgress = (interpEndMs - dataStartMs) / dataDurationMs;

    const cachedWidth = State.cachedWaveformCanvas.width;
    const sourceX = startProgress * cachedWidth;
    const sourceWidth = (endProgress - startProgress) * cachedWidth;

    // Clear and draw stretched portion
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(
        State.cachedWaveformCanvas,
        sourceX, 0, sourceWidth, State.cachedWaveformCanvas.height,  // source
        0, 0, width, height  // destination (stretched to fill)
    );

    // Draw region highlights on top (they use the same interpolated range)
    drawRegionHighlights(ctx);
    drawRegionButtons(); // Draw buttons on overlay canvas

    // Draw playhead (also using interpolated time range for smooth positioning)
    if (State.currentAudioPosition !== null && State.totalAudioDuration > 0 && State.currentAudioPosition >= 0) {
        // Convert playhead position to timestamp
        const playheadSample = zoomState.timeToSample(State.currentAudioPosition);
        const playheadTimestamp = zoomState.sampleToRealTimestamp(playheadSample);

        if (playheadTimestamp) {
            const playheadMs = playheadTimestamp.getTime();

            // Calculate playhead position within the interpolated time range
            const progress = (playheadMs - interpStartMs) / (interpEndMs - interpStartMs);
            const x = progress * width;

            ctx.strokeStyle = '#ff0000';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }
    }
}

export function drawWaveformWithSelection() {
    const canvas = document.getElementById('waveform');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    if (!State.cachedWaveformCanvas) {
        // No cached canvas - draw playhead only if needed
        if (State.totalAudioDuration > 0 && State.currentAudioPosition >= 0) {
            // 🏛️ Use zoom-aware conversion
            let x;
            if (zoomState.isInitialized()) {
                const sample = zoomState.timeToSample(State.currentAudioPosition);
                x = zoomState.sampleToPixel(sample, width);
            } else {
                // Fallback to old behavior if zoom state not initialized
            const progress = Math.min(State.currentAudioPosition / State.totalAudioDuration, 1.0);
                x = progress * width;
            }
            
            ctx.strokeStyle = '#ff0000';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }
        return;
    }
    
    // Now proceed with drawing - cache is guaranteed to match canvas size
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(State.cachedWaveformCanvas, 0, 0);  // ✅ Sizes match now!
    
    // Draw region highlights (before selection box)
    drawRegionHighlights(ctx);
    drawRegionButtons(); // Draw buttons on overlay canvas
    
    // Only draw yellow selection box if NOT playing an active region
    // When playing a region, we only want the blue region highlight, not the yellow selection box
    if (State.selectionStart !== null && State.selectionEnd !== null && !isPlayingActiveRegion()) {
        // 🏛️ Use zoom-aware conversion
        let startX, endX;
        if (zoomState.isInitialized()) {
            const startSample = zoomState.timeToSample(State.selectionStart);
            const endSample = zoomState.timeToSample(State.selectionEnd);
            startX = zoomState.sampleToPixel(startSample, width);
            endX = zoomState.sampleToPixel(endSample, width);
        } else {
            // Fallback to old behavior if zoom state not initialized
        const startProgress = State.selectionStart / State.totalAudioDuration;
        const endProgress = State.selectionEnd / State.totalAudioDuration;
            startX = startProgress * width;
            endX = endProgress * width;
        }
        const selectionWidth = endX - startX;
        
        ctx.fillStyle = 'rgba(255, 255, 0, 0.2)';
        ctx.fillRect(startX, 0, selectionWidth, height);
        
        ctx.strokeStyle = 'rgba(255, 200, 0, 0.8)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(startX, 0);
        ctx.lineTo(startX, height);
        ctx.moveTo(endX, 0);
        ctx.lineTo(endX, height);
        ctx.stroke();
    }
    
    let playheadPosition = null;
    
    if (State.isSelecting && State.selectionStart !== null) {
        playheadPosition = State.selectionStart;
    } else {
        playheadPosition = State.currentAudioPosition;
    }
    
    if (playheadPosition !== null && State.totalAudioDuration > 0 && playheadPosition >= 0) {
        // 🏛️ Use zoom-aware conversion
        let x;
        if (zoomState.isInitialized()) {
            const sample = zoomState.timeToSample(playheadPosition);
            x = zoomState.sampleToPixel(sample, width);
        } else {
            // Fallback to old behavior if zoom state not initialized
        const progress = Math.min(playheadPosition / State.totalAudioDuration, 1.0);
            x = progress * width;
        }
        
        ctx.strokeStyle = '#ff0000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
    }
}

export function setupWaveformInteraction() {
    const canvas = document.getElementById('waveform');
    if (!canvas) return;
    
    function getPositionFromMouse(event) {
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const progress = Math.max(0, Math.min(1, x / rect.width)); // Still needed for canvas pixel positioning
        
        // 🏛️ Use zoom-aware conversion
        let targetPosition;
        if (zoomState.isInitialized()) {
            const sample = zoomState.pixelToSample(x, rect.width);
            targetPosition = zoomState.sampleToTime(sample);
        } else {
            // Fallback to old behavior if zoom state not initialized
            targetPosition = progress * State.totalAudioDuration;
        }
        
        return { targetPosition, progress, x, width: rect.width };
    }
    
    function updateScrubPreview(event) {
        if (!State.completeSamplesArray || !State.totalAudioDuration) return;
        
        const { targetPosition, progress } = getPositionFromMouse(event);
        State.setScrubTargetPosition(targetPosition);
        
        const ctx = canvas.getContext('2d');
        const canvasHeight = canvas.height;
        const canvasX = progress * canvas.width;
        
        if (State.cachedWaveformCanvas) {
            ctx.clearRect(0, 0, canvas.width, canvasHeight);
            ctx.drawImage(State.cachedWaveformCanvas, 0, 0);
            
            // Draw region highlights during scrub preview
            drawRegionHighlights(ctx);
            drawRegionButtons(); // Draw buttons on overlay canvas
        }
        
        ctx.globalAlpha = 0.6;
        ctx.strokeStyle = State.isDragging ? '#bbbbbb' : '#ff0000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(canvasX, 0);
        ctx.lineTo(canvasX, canvasHeight);
        ctx.stroke();
        ctx.globalAlpha = 1.0;  // Reset alpha
        
        // Mirror on spectrogram
        drawSpectrogramScrubPreview(targetPosition, State.isDragging);
    }
    
    function performSeek() {
        if (!State.completeSamplesArray || !State.totalAudioDuration) {
            console.log('⏸️ Seeking disabled - no audio data loaded');
            return;
        }
        
        if (State.scrubTargetPosition !== null) {
            // console.log(`🖱️ Mouse released - seeking to ${State.scrubTargetPosition.toFixed(2)}s`);
            
            let clampedPosition = State.scrubTargetPosition;
            if (State.selectionStart !== null && State.selectionEnd !== null) {
                clampedPosition = Math.max(State.selectionStart, Math.min(State.scrubTargetPosition, State.selectionEnd));
            }
            State.setCurrentAudioPosition(clampedPosition);
            if (State.audioContext) {
                State.setLastUpdateTime(State.audioContext.currentTime);
            }
            
            drawWaveformWithSelection();
            drawSpectrogramPlayhead();  // Update spectrogram immediately
            seekToPosition(State.scrubTargetPosition, true); // Always start playback when clicking
            State.setScrubTargetPosition(null);
        }
    }
    
    canvas.addEventListener('mousedown', (e) => {
        if (!State.completeSamplesArray || State.totalAudioDuration === 0) return;
        
        const rect = canvas.getBoundingClientRect();
        const startX = e.clientX - rect.left;
        const startY = e.clientY - rect.top;
        
        // 🔍 DIAGNOSTIC: Log click context
        const waveformCanvas = document.getElementById('waveform');
        const buttonsCanvas = document.getElementById('waveform-buttons');
        
        // console.log('🖱️ CLICK DIAGNOSTICS:');
        // console.log(`  Click position: (${startX.toFixed(1)}, ${startY.toFixed(1)}) CSS pixels`);
        // console.log(`  Click % across: ${((startX / rect.width) * 100).toFixed(1)}%`);
        // console.log(`  Waveform canvas: ${waveformCanvas.offsetWidth}px × ${waveformCanvas.offsetHeight}px (CSS)`);
        // console.log(`  Waveform canvas: ${waveformCanvas.width}px × ${waveformCanvas.height}px (device)`);
        // if (buttonsCanvas) {
        //     console.log(`  Buttons canvas: ${buttonsCanvas.width}px × ${buttonsCanvas.height}px (device)`);
        // }
        // console.log(`  DPR: ${window.devicePixelRatio}`);
        
        // 🔧 FIX: Check if click is on a canvas button BEFORE starting scrub preview
        // This prevents the white playhead from appearing when clicking buttons
        // BUT: Only check if we're not already dragging/selecting (to avoid false positives)
        if (!State.isDragging && !State.isSelecting && State.selectionStartX === null) {
            const clickedZoomRegionIndex = checkCanvasZoomButtonClick(startX, startY);
            const clickedPlayRegionIndex = checkCanvasPlayButtonClick(startX, startY);
            
            // console.log(`  Zoom button hit: ${clickedZoomRegionIndex !== null ? `Region ${clickedZoomRegionIndex + 1}` : 'none'}`);
            // console.log(`  Play button hit: ${clickedPlayRegionIndex !== null ? `Region ${clickedPlayRegionIndex + 1}` : 'none'}`);
            
            if (clickedZoomRegionIndex !== null || clickedPlayRegionIndex !== null) {
                // Clicked on a button - don't start dragging/scrub preview
                // The button action will be handled in mouseup, but we prevent the scrub preview here
                e.stopPropagation();
                e.preventDefault();
                return; // Don't process as normal waveform click
            }
        }
        
        // Normal waveform interaction - start selection/drag
        State.setSelectionStartX(startX);
        State.setIsDragging(true);
        canvas.style.cursor = 'grabbing';
        updateScrubPreview(e);
        // console.log('🖱️ Mouse down - waiting to detect drag vs click');
    });
    
    canvas.addEventListener('mousemove', (e) => {
        if (State.isDragging && State.selectionStartX !== null) {
            const rect = canvas.getBoundingClientRect();
            const currentX = e.clientX - rect.left;
            const dragDistance = Math.abs(currentX - State.selectionStartX);
            
            if (dragDistance > 3 && !State.isSelecting) {
                State.setIsSelecting(true);
                canvas.style.cursor = 'col-resize';
                console.log('📏 Selection drag detected');
                
                // 🏛️ Only clear active region if NOT inside a region (outside the temple)
                // Inside the temple, selections are within sacred walls, flag stays up
                if (!zoomState.isInRegion()) {
                    clearActiveRegion();
                }
            }
            
            if (State.isSelecting) {
                const { targetPosition } = getPositionFromMouse(e);
                const rect = canvas.getBoundingClientRect();
                
                // 🏛️ Use zoom-aware conversion for start position too!
                let startPos;
                if (zoomState.isInitialized()) {
                    const startSample = zoomState.pixelToSample(State.selectionStartX, rect.width);
                    startPos = zoomState.sampleToTime(startSample);
                } else {
                    // Fallback to old behavior if zoom state not initialized
                    const startProgress = Math.max(0, Math.min(1, State.selectionStartX / rect.width));
                    startPos = startProgress * State.totalAudioDuration;
                }
                const endPos = targetPosition;
                
                State.setSelectionStart(Math.min(startPos, endPos));
                State.setSelectionEnd(Math.max(startPos, endPos));
                
                drawWaveformWithSelection();
            } else {
                updateScrubPreview(e);
            }
        }
    });
    
    canvas.addEventListener('mouseup', (e) => {
        // 🔧 FIX: Check for button clicks even when not dragging
        // (in case we returned early from mousedown to prevent scrub preview)
        const rect = canvas.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;
        const clickedZoomRegionIndex = checkCanvasZoomButtonClick(clickX, clickY);
        const clickedPlayRegionIndex = checkCanvasPlayButtonClick(clickX, clickY);
        
        if (clickedZoomRegionIndex !== null) {
            // Clicked on a zoom button - handle zoom
            e.stopPropagation();
            e.preventDefault();
            
            // Clear any dragging state
            State.setIsDragging(false);
            canvas.style.cursor = 'pointer';
            
            const regions = getRegions();
            const region = regions[clickedZoomRegionIndex];
            
            if (region) {
                // Check if we're already inside THIS temple
                if (zoomState.isInRegion() && zoomState.getCurrentRegionId() === region.id) {
                    // We're inside - exit the temple and return to full view
                    zoomToFull();
                } else {
                    // Zoom into this region
                    zoomToRegion(clickedZoomRegionIndex);
                }
            }
            
            // Clear selection state
            State.setSelectionStartX(null);
            State.setIsSelecting(false);
            State.setSelectionStart(null);
            State.setSelectionEnd(null);
            updateWorkletSelection();
            hideAddRegionButton();
            
            // Clear scrub preview if it was shown
            clearSpectrogramScrubPreview();
            
            // Redraw to update button states (canvas buttons will update via redraw)
            drawWaveformWithSelection();
            return; // Don't process as normal waveform click
        }
        
        if (clickedPlayRegionIndex !== null) {
            // Clicked on a play button - play region from start (mirrors panel play button)
            e.stopPropagation();
            e.preventDefault();
            
            // Clear all selection/dragging state to allow new selections
            State.setIsDragging(false);
            State.setIsSelecting(false);
            State.setSelectionStartX(null);
            canvas.style.cursor = 'pointer';
            
            // ✅ Call toggleRegionPlay synchronously (same logic as panel buttons)
            // This sets activePlayingRegionIndex and updates region.playing state
            // toggleRegionPlay already calls drawWaveformWithSelection() which redraws buttons
            toggleRegionPlay(clickedPlayRegionIndex);
            
            // Return early - don't process as normal waveform click
            return;
        }
        
        if (State.isDragging) {
            State.setIsDragging(false);
            canvas.style.cursor = 'pointer';
            
            // Check if click is on a canvas zoom button (only if not selecting/dragging)
            // Only check if it was a simple click, not a drag
            const startX = State.selectionStartX || 0;
            const endX = e.clientX - rect.left;
            const dragDistance = Math.abs(endX - startX);
            
            // Only check for button click if it was a simple click (not a drag)
            if (!State.isSelecting && dragDistance < 5) {
                // Already checked above, but keep this as fallback for edge cases
                const checkZoomAgain = checkCanvasZoomButtonClick(endX, clickY);
                const checkPlayAgain = checkCanvasPlayButtonClick(endX, clickY);
                
                if (checkZoomAgain !== null) {
                    // Clicked on a zoom button - handle zoom
                    e.stopPropagation();
                    e.preventDefault();
                    
                    const regions = getRegions();
                    const region = regions[checkZoomAgain];
                    
                    if (region) {
                        // Check if we're already inside THIS temple
                        if (zoomState.isInRegion() && zoomState.getCurrentRegionId() === region.id) {
                            // We're inside - exit the temple and return to full view
                            zoomToFull();
                        } else {
                            // Zoom into this region
                            zoomToRegion(checkZoomAgain);
                        }
                    }
                    
                    // Clear selection state
                    State.setSelectionStartX(null);
                    State.setIsSelecting(false);
                    State.setSelectionStart(null);
                    State.setSelectionEnd(null);
                    updateWorkletSelection();
                    hideAddRegionButton();
                    
                    // Clear scrub preview
                    clearSpectrogramScrubPreview();
                    
                    // Redraw to update button states (canvas buttons will update via redraw)
                    drawWaveformWithSelection();
                    return; // Don't process as normal waveform click
                }
                
                if (checkPlayAgain !== null) {
                    // Clicked on a play button - play region from start (mirrors panel play button)
                    e.stopPropagation();
                    e.preventDefault();
                    
                    // Clear all selection/dragging state to allow new selections
                    State.setIsDragging(false);
                    State.setIsSelecting(false);
                    State.setSelectionStartX(null);
                    
                    // ✅ Call toggleRegionPlay synchronously (same logic as panel buttons)
                    // This sets activePlayingRegionIndex and updates region.playing state
                    // toggleRegionPlay already calls drawWaveformWithSelection() which redraws buttons
                    toggleRegionPlay(checkPlayAgain);
                    
                    return; // Don't process as normal waveform click
                }
            }
            
            if (State.isSelecting) {
                const { targetPosition } = getPositionFromMouse(e);
                const rect = canvas.getBoundingClientRect();
                
                // 🏛️ Use zoom-aware conversion for start position too!
                let startPos;
                if (zoomState.isInitialized()) {
                    const startSample = zoomState.pixelToSample(State.selectionStartX || 0, rect.width);
                    startPos = zoomState.sampleToTime(startSample);
                } else {
                    // Fallback to old behavior if zoom state not initialized
                    const startProgress = Math.max(0, Math.min(1, (State.selectionStartX || 0) / rect.width));
                    startPos = startProgress * State.totalAudioDuration;
                }
                const endPos = targetPosition;
                
                State.setIsSelecting(false);
                
                const newSelectionStart = Math.min(startPos, endPos);
                const newSelectionEnd = Math.max(startPos, endPos);
                const newIsLooping = State.isLooping;
                
                const zoomMode = zoomState.isInRegion() ? 'temple (zoomed)' : 'full view';
                const zoomLevel = zoomState.isInitialized() ? zoomState.getZoomLevel().toFixed(1) : 'N/A';
                console.log(`🖱️ Waveform selection created: ${newSelectionStart.toFixed(2)}s - ${newSelectionEnd.toFixed(2)}s (duration: ${(newSelectionEnd - newSelectionStart).toFixed(3)}s)`);
                console.log(`   📍 Zoom mode: ${zoomMode} (${zoomLevel}x)`);
                
                // Print comprehensive diagnostics for the selection
                const currentX = e.clientX - rect.left;
                printSelectionDiagnostics(State.selectionStartX, currentX, rect.width);
                
                State.setSelectionStartX(null);
                
                // 🏛️ Only reset region buttons if NOT inside a region (outside the temple)
                // Inside the temple, selections are within sacred walls, flag stays up
                if (!zoomState.isInRegion()) {
                    resetAllRegionPlayButtons();
                }
                
                // 🏛️ Show "Add Region" button only if NOT inside a region (outside the temple)
                // When inside the temple, we don't want to add new regions
                if (!zoomState.isInRegion()) {
                    showAddRegionButton(newSelectionStart, newSelectionEnd);
                }
                
                // 🏠 AUTONOMOUS: Set selection state and send to worklet immediately
                // No timeout needed - worklet uses selection when making decisions, no coordination required!
                State.setSelectionStart(newSelectionStart);
                State.setSelectionEnd(newSelectionEnd);
                State.setIsLooping(newIsLooping);
                updateWorkletSelection();  // Send selection to worklet immediately
                
                // Update visuals
                State.setCurrentAudioPosition(newSelectionStart);
                if (State.audioContext) {
                    State.setLastUpdateTime(State.audioContext.currentTime);
                }
                drawWaveformWithSelection();
                clearSpectrogramScrubPreview();  // Clear scrub preview
                drawSpectrogramPlayhead();  // Update spectrogram immediately
                
                // 🔧 FIX: Restore spectrogram viewport state
                import('./spectrogram-complete-renderer.js').then(({ restoreViewportState }) => {
                    restoreViewportState();
                });
                
                // Seek to start and optionally start playback if playOnClick is enabled
                // Worklet handles fades autonomously based on its current state
                const shouldAutoPlay = document.getElementById('playOnClick').checked;
                seekToPosition(newSelectionStart, shouldAutoPlay);
            } else {
                State.setSelectionStart(null);
                State.setSelectionEnd(null);
                State.setSelectionStartX(null);
                
                // Hide "Add Region" button when selection is cleared
                hideAddRegionButton();
                
                updateWorkletSelection();
                
                const ctx = canvas.getContext('2d');
                if (State.cachedWaveformCanvas) {
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(State.cachedWaveformCanvas, 0, 0);
                    
                    // Draw region highlights after clearing selection
                    drawRegionHighlights(ctx);
                    drawRegionButtons(); // Draw buttons on overlay canvas
                }
                
                // 🏛️ Only reset region buttons if NOT inside a region (outside the temple)
                // Inside the temple, clicking seeks within sacred walls, flag stays up
                if (!zoomState.isInRegion()) {
                    resetAllRegionPlayButtons();
                }
                
                const { targetPosition } = getPositionFromMouse(e);
                const zoomMode = zoomState.isInRegion() ? 'temple (zoomed)' : 'full view';
                const zoomLevel = zoomState.isInitialized() ? zoomState.getZoomLevel().toFixed(1) : 'N/A';
                // console.log(`🖱️ Waveform clicked at ${targetPosition.toFixed(2)}s - seeking to position`);
                // console.log(`   📍 Zoom mode: ${zoomMode} (${zoomLevel}x)`);
                clearSpectrogramScrubPreview();  // Clear scrub preview
                performSeek();
                drawSpectrogramPlayhead();  // Update spectrogram immediately after seek
                
                // 🔧 FIX: Restore spectrogram viewport state
                import('./spectrogram-complete-renderer.js').then(({ restoreViewportState }) => {
                    restoreViewportState();
                });
            }
        }
    });
    
    canvas.addEventListener('mouseleave', () => {
        if (State.isDragging) {
            const wasSelecting = State.isSelecting;
            State.setIsDragging(false);
            State.setIsSelecting(false);
            canvas.style.cursor = State.completeSamplesArray && State.totalAudioDuration > 0 ? 'pointer' : 'default';
            
            if (State.selectionStartX !== null) {
                if (wasSelecting && State.selectionStart !== null && State.selectionEnd !== null) {
                    updateWorkletSelection();
                    State.setCurrentAudioPosition(State.selectionStart);
                    if (State.audioContext) {
                        State.setLastUpdateTime(State.audioContext.currentTime);
                    }
                    drawWaveformWithSelection();
                    clearSpectrogramScrubPreview();  // Clear scrub preview
                    drawSpectrogramPlayhead();  // Update spectrogram immediately
                    
                    // Seek to start and optionally start playback if playOnClick is enabled
                    const shouldAutoPlay = document.getElementById('playOnClick').checked;
                    seekToPosition(State.selectionStart, shouldAutoPlay);
                } else {
                    State.setSelectionStart(null);
                    State.setSelectionEnd(null);
                    updateWorkletSelection();
                    clearSpectrogramScrubPreview();  // Clear scrub preview
                    performSeek();
                }
            } else {
                performSeek();
            }
            
            State.setSelectionStartX(null);
            console.log('🖱️ Mouse left canvas during interaction');
        }
    });
    
    canvas.addEventListener('mouseenter', () => {
        if (State.completeSamplesArray && State.totalAudioDuration > 0) {
            canvas.style.cursor = 'pointer';
        }
    });
}

// Diagnostic logging state
let lastDiagnosticTime = 0;

// 🔥 HELPER: Start playback indicator loop (ensures cleanup before starting)
export function startPlaybackIndicator() {
    // 🔥 FIX: Check if document is connected before starting RAF
    // This prevents creating RAF callbacks that will be retained by detached documents
    if (!document.body || !document.body.isConnected) {
        console.warn('⚠️ Cannot start playback indicator - document is detached');
        return;
    }
    
    // 🔥 FIX: Prevent multiple simultaneous RAF loops
    // If RAF is already scheduled, don't create another one
    if (State.playbackIndicatorRAF !== null) {
        // Already running, don't create duplicate
        return;
    }
    
    // Start new loop
    State.setPlaybackIndicatorRAF(requestAnimationFrame(updatePlaybackIndicator));
}

export function updatePlaybackIndicator() {
    // 🔥 FIX: Copy State values to local variables IMMEDIATELY to break closure chain
    // This prevents RAF callbacks from capturing the entire State module
    // Access State only once at the start, then use local variables throughout
    const currentRAF = State.playbackIndicatorRAF;
    const isDragging = State.isDragging;
    const playbackState = State.playbackState;
    const totalAudioDuration = State.totalAudioDuration;
    
    // Clear RAF ID immediately to prevent duplicate scheduling
    // This must happen FIRST before any early returns to prevent accumulation
    State.setPlaybackIndicatorRAF(null);
    if (currentRAF !== null) {
        cancelAnimationFrame(currentRAF);
    }
    
    // 🔥 FIX: Check if document is still connected (not detached) before proceeding
    // This prevents RAF callbacks from retaining references to detached documents
    if (!document.body || !document.body.isConnected) {
        return; // Document is detached, stop the loop
    }
    
    // Early exit: dragging - schedule next frame but don't render
    if (isDragging) {
        // 🔥 FIX: Only schedule RAF if document is still connected and not already scheduled
        // This prevents creating RAF callbacks that will be retained by detached documents
        if (document.body && document.body.isConnected && State.playbackIndicatorRAF === null) {
        State.setPlaybackIndicatorRAF(requestAnimationFrame(updatePlaybackIndicator));
        }
        return;
    }
    
    // Early exit: not playing - stop the loop completely
    if (playbackState !== PlaybackState.PLAYING) {
        return;
    }
    
    // 🔥 FIX: Removed access to State.allReceivedData to prevent closure leak
    // The diagnostic code was accessing State.allReceivedData which contains thousands of Float32Array chunks
    // This created a closure chain: RAF callback → State module → allReceivedData → 4,237 Float32Array chunks (17MB)
    // Use State.completeSamplesArray.length instead if needed, or remove diagnostic code entirely
    
    if (totalAudioDuration > 0) {
        // Region button reset is handled by 'selection-end-reached' message from worklet
        // The worklet is the single source of truth for when boundaries are reached
        
        drawWaveformWithSelection();
        drawSpectrogramPlayhead();  // Draw playhead on spectrogram too
    }
    
    // 🔥 FIX: Store RAF ID for proper cleanup
    // Only schedule if document is still connected and not already scheduled
    // This prevents creating multiple RAF callbacks that accumulate
    if (document.body && document.body.isConnected && State.playbackIndicatorRAF === null) {
    State.setPlaybackIndicatorRAF(requestAnimationFrame(updatePlaybackIndicator));
    } else {
        // Document is detached or already scheduled - stop the loop
        State.setPlaybackIndicatorRAF(null);
    }
}

export function initWaveformWorker() {
    if (State.waveformWorker) {
        State.waveformWorker.onmessage = null;  // Break closure chain
        State.waveformWorker.terminate();
    }
    
    const worker = new Worker('workers/waveform-worker.js');
    State.setWaveformWorker(worker);
    
    worker.onmessage = (e) => {
        const { type } = e.data;
        
        if (type === 'waveform-ready') {
            const { waveformData, totalSamples, buildTime, isComplete } = e.data;
            
            if (isComplete) {
                State.setIsShowingFinalWaveform(true);
            }
            
            if (DEBUG_WAVEFORM) console.log(`🎨 Waveform ready: ${totalSamples.toLocaleString()} samples → ${waveformData.mins.length} pixels in ${buildTime.toFixed(0)}ms`);
            
            State.setWaveformMinMaxData(waveformData);
            drawWaveformFromMinMax();
            
            if (State.totalAudioDuration > 0) {
                drawWaveformWithSelection();
            }
            
            // 🔥 FIX: Clear waveformData references after use to allow GC of transferred ArrayBuffers
            // The mins/maxs buffers were transferred from worker - clearing helps GC
            // Note: We've already copied the data to State, so it's safe to clear here
            e.data.waveformData = null;
        } else if (type === 'reset-complete') {
            console.log('🎨 Waveform worker reset complete');
        }
    };
    
    console.log('🎨 Waveform worker initialized');
}

export function changeWaveformFilter() {
    const slider = document.getElementById('waveformFilterSlider');
    const value = parseInt(slider.value);
    const alpha = 0.95 + (value / 100) * (0.9999 - 0.95);
    
    document.getElementById('waveformFilterValue').textContent = `${alpha.toFixed(4)}`;
    
    if (window.rawWaveformData && window.rawWaveformData.length > 0) {
        const removeDC = document.getElementById('removeDCOffset').checked;
        
        console.log(`🎛️ changeWaveformFilter called: removeDC=${removeDC}, alpha=${alpha.toFixed(4)}`);
        
        let processedData = window.rawWaveformData;
        
        if (removeDC) {
            console.log(`🎛️ Removing drift with alpha=${alpha.toFixed(4)}...`);
            processedData = removeDCOffset(processedData, alpha);
            
            let minProc = processedData[0], maxProc = processedData[0];
            for (let i = 1; i < processedData.length; i++) {
                if (processedData[i] < minProc) minProc = processedData[i];
                if (processedData[i] > maxProc) maxProc = processedData[i];
            }
            console.log(`  📊 Drift-removed range: [${minProc.toFixed(1)}, ${maxProc.toFixed(1)}]`);
        } else {
            console.log(`🎛️ No drift removal (showing raw data)`);
        }
        
        const normalized = normalize(processedData);
        window.displayWaveformData = normalized;
        State.setCompleteSamplesArray(normalized);
        
        console.log(`  🎨 Redrawing waveform...`);
        drawWaveform();
    } else {
        console.log(`⚠️ No raw waveform data available yet - load data first`);
    }
}

