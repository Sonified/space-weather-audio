/**
 * waveform-renderer.js
 * Waveform drawing, interaction (scrubbing, selection), and playback indicator
 */

import * as State from './audio-state.js';
import { PlaybackState } from './audio-state.js';
import { seekToPosition, updateWorkletSelection } from './audio-player.js';
import { positionWaveformAxisCanvas, drawWaveformAxis } from './waveform-axis-renderer.js';
import { positionWaveformXAxisCanvas, drawWaveformXAxis, positionWaveformDateCanvas, drawWaveformDate } from './waveform-x-axis-renderer.js';
import { drawRegionHighlights, showAddRegionButton, hideAddRegionButton, clearActiveRegion, resetAllRegionPlayButtons, getActiveRegionIndex, isPlayingActiveRegion, resetRegionPlayButtonIfFinished } from './region-tracker.js';
import { printSelectionDiagnostics } from './selection-diagnostics.js';
import { drawSpectrogramPlayhead, drawSpectrogramScrubPreview, clearSpectrogramScrubPreview } from './spectrogram-playhead.js';

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
    console.log(`📏 Total audio duration: ${State.totalAudioDuration.toFixed(2)}s (${State.completeSamplesArray.length.toLocaleString()} samples @ 44100 Hz)`);
    
    const removeDC = document.getElementById('removeDCOffset').checked;
    const slider = document.getElementById('waveformFilterSlider');
    const sliderValue = parseInt(slider.value);
    const alpha = 0.95 + (sliderValue / 100) * (0.9999 - 0.95);
    
    console.log(`🎨 Sending to waveform worker: ${width}px wide, ${State.completeSamplesArray.length.toLocaleString()} samples`);
    
    State.waveformWorker.postMessage({
        type: 'build-waveform',
        canvasWidth: width,
        canvasHeight: height,
        removeDC: removeDC,
        alpha: alpha,
        isComplete: true,
        totalExpectedSamples: State.completeSamplesArray.length
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

export function drawWaveformWithSelection() {
    const canvas = document.getElementById('waveform');
    if (!canvas) return;
    
    if (!State.cachedWaveformCanvas) {
        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const height = canvas.height;
        
        if (State.totalAudioDuration > 0 && State.currentAudioPosition >= 0) {
            const progress = Math.min(State.currentAudioPosition / State.totalAudioDuration, 1.0);
            const x = progress * width;
            
            ctx.strokeStyle = '#ff0000';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }
        return;
    }
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(State.cachedWaveformCanvas, 0, 0);
    
    // Draw region highlights (before selection box)
    drawRegionHighlights(ctx, width, height);
    
    // Only draw yellow selection box if NOT playing an active region
    // When playing a region, we only want the blue region highlight, not the yellow selection box
    if (State.selectionStart !== null && State.selectionEnd !== null && !isPlayingActiveRegion()) {
        const startProgress = State.selectionStart / State.totalAudioDuration;
        const endProgress = State.selectionEnd / State.totalAudioDuration;
        const startX = startProgress * width;
        const endX = endProgress * width;
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
        const progress = Math.min(playheadPosition / State.totalAudioDuration, 1.0);
        const x = progress * width;
        
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
        const progress = Math.max(0, Math.min(1, x / rect.width));
        const targetPosition = progress * State.totalAudioDuration;
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
            drawRegionHighlights(ctx, canvas.width, canvasHeight);
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
            console.log(`🖱️ Mouse released - seeking to ${State.scrubTargetPosition.toFixed(2)}s`);
            
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
        State.setSelectionStartX(startX);
        
        State.setIsDragging(true);
        canvas.style.cursor = 'grabbing';
        updateScrubPreview(e);
        console.log('🖱️ Mouse down - waiting to detect drag vs click');
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
                
                // Clear active region when starting new waveform selection
                clearActiveRegion();
            }
            
            if (State.isSelecting) {
                const { targetPosition } = getPositionFromMouse(e);
                const startProgress = Math.max(0, Math.min(1, State.selectionStartX / rect.width));
                const startPos = startProgress * State.totalAudioDuration;
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
        if (State.isDragging) {
            State.setIsDragging(false);
            canvas.style.cursor = 'pointer';
            
            if (State.isSelecting) {
                const { targetPosition } = getPositionFromMouse(e);
                const rect = canvas.getBoundingClientRect();
                const startProgress = Math.max(0, Math.min(1, (State.selectionStartX || 0) / rect.width));
                const startPos = startProgress * State.totalAudioDuration;
                const endPos = targetPosition;
                
                State.setIsSelecting(false);
                
                const newSelectionStart = Math.min(startPos, endPos);
                const newSelectionEnd = Math.max(startPos, endPos);
                const newIsLooping = State.isLooping;
                
                console.log(`🖱️ Waveform selection created: ${newSelectionStart.toFixed(2)}s - ${newSelectionEnd.toFixed(2)}s (duration: ${(newSelectionEnd - newSelectionStart).toFixed(3)}s)`);
                
                // Print comprehensive diagnostics for the selection
                const currentX = e.clientX - rect.left;
                printSelectionDiagnostics(State.selectionStartX, currentX, rect.width);
                
                State.setSelectionStartX(null);
                
                // Reset all region play buttons since user is making a new selection (not playing within a region)
                resetAllRegionPlayButtons();
                
                // Show "Add Region" button for region tracker
                showAddRegionButton(newSelectionStart, newSelectionEnd);
                
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
                    drawRegionHighlights(ctx, canvas.width, canvas.height);
                }
                
                // Reset all region play buttons since user is clicking to seek (not playing within a region)
                resetAllRegionPlayButtons();
                
                const { targetPosition } = getPositionFromMouse(e);
                console.log(`🖱️ Waveform clicked at ${targetPosition.toFixed(2)}s - seeking to position`);
                clearSpectrogramScrubPreview();  // Clear scrub preview
                performSeek();
                drawSpectrogramPlayhead();  // Update spectrogram immediately after seek
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
    // Cancel any existing RAF to prevent parallel loops
    if (State.playbackIndicatorRAF !== null) {
        cancelAnimationFrame(State.playbackIndicatorRAF);
        State.setPlaybackIndicatorRAF(null);
    }
    // Start new loop
    State.setPlaybackIndicatorRAF(requestAnimationFrame(updatePlaybackIndicator));
}

export function updatePlaybackIndicator() {
    // 🔥 FIX: Cancel any existing RAF to prevent closure chain memory leak
    if (State.playbackIndicatorRAF !== null) {
        cancelAnimationFrame(State.playbackIndicatorRAF);
        State.setPlaybackIndicatorRAF(null);
    }
    
    // Early exit: dragging - schedule next frame but don't render
    if (State.isDragging) {
        State.setPlaybackIndicatorRAF(requestAnimationFrame(updatePlaybackIndicator));
        return;
    }
    
    // Early exit: not playing - stop the loop completely
    if (State.playbackState !== PlaybackState.PLAYING) {
        return;
    }
    
    // 🔥 FIX: Removed access to State.allReceivedData to prevent closure leak
    // The diagnostic code was accessing State.allReceivedData which contains thousands of Float32Array chunks
    // This created a closure chain: RAF callback → State module → allReceivedData → 4,237 Float32Array chunks (17MB)
    // Use State.completeSamplesArray.length instead if needed, or remove diagnostic code entirely
    
    if (State.totalAudioDuration > 0) {
        // Check if we've reached the end of an active region and reset play button
        if (State.playbackState === PlaybackState.PLAYING) {
            resetRegionPlayButtonIfFinished();
        }
        
        drawWaveformWithSelection();
        drawSpectrogramPlayhead();  // Draw playhead on spectrogram too
    }
    
    // 🔥 FIX: Store RAF ID for proper cleanup
    State.setPlaybackIndicatorRAF(requestAnimationFrame(updatePlaybackIndicator));
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

