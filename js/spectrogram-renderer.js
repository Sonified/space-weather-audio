/**
 * spectrogram-renderer.js
 * Spectrogram visualization
 */

import * as State from './audio-state.js';
import { PlaybackState } from './audio-state.js';
import { drawFrequencyAxis, positionAxisCanvas, resizeAxisCanvas, initializeAxisPlaybackRate } from './spectrogram-axis-renderer.js';
import { handleSpectrogramSelection, isInFrequencySelectionMode } from './region-tracker.js';
import { renderCompleteSpectrogram, clearCompleteSpectrogram, isCompleteSpectrogramRendered, renderCompleteSpectrogramForRegion, updateSpectrogramViewport } from './spectrogram-complete-renderer.js';
import { zoomState } from './zoom-state.js';

// Spectrogram selection state
let spectrogramSelectionActive = false;
let spectrogramStartX = null;
let spectrogramStartY = null;
let spectrogramEndY = null;
export let spectrogramSelectionBox = null;

export function drawSpectrogram() {
    console.log(`📺 [spectrogram-renderer.js] drawSpectrogram CALLED`);
    console.trace('📍 Call stack:');
    
    // 🔥 FIX: Copy State values to local variables IMMEDIATELY to break closure chain
    // This prevents RAF callbacks from capturing the entire State module
    // Access State only once at the start, then use local variables throughout
    const currentRAF = State.spectrogramRAF;
    const analyserNode = State.analyserNode;
    const playbackState = State.playbackState;
    const frequencyScale = State.frequencyScale;
    const spectrogramInitialized = State.spectrogramInitialized;
    
    // Clear RAF ID immediately to prevent duplicate scheduling
    // This must happen FIRST before any early returns to prevent accumulation
    State.setSpectrogramRAF(null);
    if (currentRAF !== null) {
        cancelAnimationFrame(currentRAF);
    }
    
    // 🔥 FIX: Check if document is still connected (not detached) before proceeding
    // This prevents RAF callbacks from retaining references to detached documents
    if (!document.body || !document.body.isConnected) {
        return; // Document is detached, stop the loop
    }
    
    // Early exit: no analyser - stop the loop completely
    if (!analyserNode) return;
    
    // Early exit: not playing - schedule next frame to keep checking
    if (playbackState !== PlaybackState.PLAYING) {
        // 🔥 FIX: Only schedule RAF if document is still connected and not already scheduled
        if (document.body && document.body.isConnected && State.spectrogramRAF === null) {
        State.setSpectrogramRAF(requestAnimationFrame(drawSpectrogram));
        }
        return;
    }
    
    const canvas = document.getElementById('spectrogram');
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    // Clear entire canvas only on first initialization
    if (!spectrogramInitialized) {
        ctx.clearRect(0, 0, width, height);
        State.setSpectrogramInitialized(true);
    }
    
    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyserNode.getByteFrequencyData(dataArray);
    
    // Helper function to calculate y position based on frequency scale
    const getYPosition = (binIndex, totalBins, canvasHeight) => {
        if (frequencyScale === 'logarithmic') {
            // Logarithmic scale: strong emphasis on lower frequencies
            // Map bin index to log scale (avoiding log(0))
            const minFreq = 1; // Minimum frequency bin (avoid log(0))
            const maxFreq = totalBins;
            const logMin = Math.log10(minFreq);
            const logMax = Math.log10(maxFreq);
            const logFreq = Math.log10(Math.max(binIndex + 1, minFreq));
            const normalizedLog = (logFreq - logMin) / (logMax - logMin);
            return canvasHeight - (normalizedLog * canvasHeight);
        } else if (frequencyScale === 'sqrt') {
            // Square root scale: gentle emphasis on lower frequencies (good middle ground)
            const normalized = binIndex / totalBins;
            const sqrtNormalized = Math.sqrt(normalized);
            return canvasHeight - (sqrtNormalized * canvasHeight);
        } else {
            // Linear scale (default) - even spacing
            return canvasHeight - (binIndex / totalBins) * canvasHeight;
        }
    };
    
    // Scroll 1 pixel per frame (standard scrolling behavior)
            ctx.drawImage(canvas, -1, 0);
            ctx.clearRect(width - 1, 0, 1, height);
            
            // Draw new column
            for (let i = 0; i < bufferLength; i++) {
                const value = dataArray[i];
                const percent = value / 255;
                const hue = percent * 60;
                const saturation = 100;
                const lightness = 10 + (percent * 60);
                const y = getYPosition(i, bufferLength, height);
                const nextY = getYPosition(i + 1, bufferLength, height);
                const barHeight = Math.max(1, Math.abs(y - nextY));
                ctx.fillStyle = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
                ctx.fillRect(width - 1, nextY, 1, barHeight);
    }
    
    // 🔥 FIX: Store RAF ID for proper cleanup
    // Only schedule if document is still connected and not already scheduled
    // This prevents creating multiple RAF callbacks that accumulate
    if (document.body && document.body.isConnected && State.spectrogramRAF === null) {
    State.setSpectrogramRAF(requestAnimationFrame(drawSpectrogram));
    } else {
        // Document is detached or already scheduled - stop the loop
        State.setSpectrogramRAF(null);
            }
}


/**
 * Load frequency scale from localStorage and apply it
 * Called on page load to restore user's preferred frequency scale
 */
export function loadFrequencyScale() {
    const select = document.getElementById('frequencyScale');
    if (!select) return;
    
    // Load saved value from localStorage (default: 'sqrt')
    const savedValue = localStorage.getItem('frequencyScale');
    if (savedValue !== null) {
        // Validate value is one of the allowed options
        const validValues = ['linear', 'sqrt', 'logarithmic'];
        if (validValues.includes(savedValue)) {
            select.value = savedValue;
            State.setFrequencyScale(savedValue);
            console.log(`📊 Loaded saved frequency scale: ${savedValue}`);
        }
    } else {
        // No saved value, use default and save it
        const defaultValue = 'sqrt';
        select.value = defaultValue;
        State.setFrequencyScale(defaultValue);
        localStorage.setItem('frequencyScale', defaultValue);
    }
}

export async function changeFrequencyScale() {
    const select = document.getElementById('frequencyScale');
    const value = select.value; // 'linear', 'sqrt', or 'logarithmic'
    
    // If already on this scale, don't process again
    if (State.frequencyScale === value) {
        console.log(`📊 Already on ${value} scale - skipping change`);
        return;
    }
    
    // Save to localStorage for persistence
    localStorage.setItem('frequencyScale', value);
    
    // Store old scale for animation
    const oldScale = State.frequencyScale;
    
    State.setFrequencyScale(value);
    
    // Blur dropdown so spacebar can toggle play/pause
    select.blur();
    
    console.log(`📊 Frequency scale changed to: ${value}`);
    
    // 🔍 Diagnostic: Check state before animation decision
    console.log(`🎨 [changeFrequencyScale] Checking if we should animate:`, {
        hasComplete: isCompleteSpectrogramRendered(),
        oldScale: oldScale,
        newScale: value,
        inRegion: zoomState.isInRegion()
    });
    
    // If complete spectrogram is rendered, animate transition
    if (isCompleteSpectrogramRendered()) {
        // console.log('✅ Animation path - have rendered spectrogram');
        console.log('🎨 Starting scale transition (axis + spectrogram in parallel)...');
        
        // Start axis animation immediately (don't wait for it)
        const { animateScaleTransition } = await import('./spectrogram-axis-renderer.js');
        const axisAnimationPromise = animateScaleTransition(oldScale);
        
        // Start spectrogram rendering immediately (in parallel with axis animation)
        console.log('🎨 Starting spectrogram re-render...');
        
        // 🔥 PAUSE playhead updates during fade!
        const playbackWasActive = State.playbackState === State.PlaybackState.PLAYING;
        const originalRAF = State.playbackIndicatorRAF;
        if (originalRAF !== null) {
            cancelAnimationFrame(originalRAF);
            State.setPlaybackIndicatorRAF(null);
        }
        
        const canvas = document.getElementById('spectrogram');
        if (canvas) {
            console.log(`🎨 [spectrogram-renderer.js] changeFrequencyScale: Starting fade animation`);
            console.trace('📍 Call stack:');
            
            const ctx = canvas.getContext('2d');
            const width = canvas.width;
            const height = canvas.height;
            
            // 🔧 FIX: Check if we're zoomed into a region - handle with fade animation!
            if (zoomState.isInitialized() && zoomState.isInRegion()) {
                const regionRange = zoomState.getRegionRange();
                console.log(`🔍 Inside region - animating scale transition`);
                
                // 🔥 Capture old spectrogram BEFORE re-rendering
                const oldSpectrogram = document.createElement('canvas');
                oldSpectrogram.width = width;
                oldSpectrogram.height = height;
                oldSpectrogram.getContext('2d').drawImage(canvas, 0, 0);
                
                // Re-render region with new frequency scale (in "background") - start immediately!
                const spectrogramModule = await import('./spectrogram-complete-renderer.js');
                const { resetSpectrogramState } = spectrogramModule;
                resetSpectrogramState(); // Clear state so it will re-render
                
                // Start rendering immediately (don't await - let it run in parallel with axis animation)
                const spectrogramRenderPromise = spectrogramModule.renderCompleteSpectrogramForRegion(
                    regionRange.startTime, 
                    regionRange.endTime, 
                    true  // Skip viewport update - we'll fade manually
                );
                
                // Wait for spectrogram to finish rendering (may complete before or after axis animation)
                await spectrogramRenderPromise;
                
                // Get the new spectrogram (without displaying it yet)
                const { getSpectrogramViewport } = spectrogramModule;
                const playbackRate = State.currentPlaybackRate || 1.0;
                const newSpectrogram = getSpectrogramViewport(playbackRate);
                
                if (!newSpectrogram) {
                    // Fallback: just update normally
                    spectrogramModule.updateSpectrogramViewport(playbackRate);
                    if (playbackWasActive) {
                        import('./waveform-renderer.js').then(module => {
                            module.startPlaybackIndicator();
                        });
                    }
                    console.log('✅ Region scale transition complete (no fade)');
                    return;
                }
                
                // 🎨 Crossfade old → new (300ms)
                const fadeDuration = 300;
                const fadeStart = performance.now();
                
                const fadeStep = () => {
                    if (!document.body || !document.body.isConnected) {
                        return;
                    }
                    
                    const elapsed = performance.now() - fadeStart;
                    const progress = Math.min(elapsed / fadeDuration, 1.0);
                    const alpha = 1 - Math.pow(1 - progress, 2); // Ease-out
                    
                    // Clear and draw blend
                    ctx.clearRect(0, 0, width, height);
                    
                    // Old fading OUT
                    ctx.globalAlpha = 1.0 - alpha;
                    ctx.drawImage(oldSpectrogram, 0, 0);
                    
                    // New fading IN
                    ctx.globalAlpha = alpha;
                    ctx.drawImage(newSpectrogram, 0, 0);
                    
                    // Playhead on top
                    ctx.globalAlpha = 1.0;
                    if (State.currentAudioPosition !== null && State.totalAudioDuration > 0) {
                        // Calculate playhead position relative to region
                        const regionDuration = regionRange.endTime - regionRange.startTime;
                        const positionInRegion = State.currentAudioPosition - regionRange.startTime;
                        const playheadX = (positionInRegion / regionDuration) * width;
                        
                        ctx.strokeStyle = '#616161';
                        ctx.lineWidth = 2;
                        ctx.beginPath();
                        ctx.moveTo(playheadX, 0);
                        ctx.lineTo(playheadX, height);
                        ctx.stroke();
                    }
                    
                    ctx.globalAlpha = 1.0;
                    
                    if (progress < 1.0) {
                        requestAnimationFrame(fadeStep);
                    } else {
                        // Fade complete - lock in new spectrogram
                        spectrogramModule.updateSpectrogramViewport(playbackRate);
                        
                        // Resume playhead
                        if (playbackWasActive) {
                            import('./waveform-renderer.js').then(module => {
                                module.startPlaybackIndicator();
                            });
                        }
                        
                        console.log('✅ Region scale transition complete (with fade)');
                    }
                };
                
                fadeStep();
                return;
            }
            
            // OLD SPECTROGRAM IS ALREADY ON SCREEN - DON'T TOUCH IT!
            // Reset state flag so we can re-render (but don't clear the canvas!)
            const { resetSpectrogramState } = await import('./spectrogram-complete-renderer.js');
            resetSpectrogramState();
            
            // Just render new spectrogram in background (skip viewport update) - start immediately!
            // This runs in parallel with the axis animation
            const spectrogramRenderPromise = renderCompleteSpectrogram(true); // Skip viewport update - old stays visible!
            
            // Wait for spectrogram to finish rendering (may complete before or after axis animation)
            await spectrogramRenderPromise;
            
            // Get the new spectrogram viewport without updating display canvas
            const { getSpectrogramViewport } = await import('./spectrogram-complete-renderer.js');
            const playbackRate = State.currentPlaybackRate || 1.0;
            const newSpectrogram = getSpectrogramViewport(playbackRate);
            
            if (!newSpectrogram) {
                // Fallback: just update normally
                updateSpectrogramViewport(playbackRate);
                // Resume playhead if it was active
                if (playbackWasActive) {
                    import('./waveform-renderer.js').then(module => {
                        module.startPlaybackIndicator();
                    });
                }
                return;
            }
            
            // 🔥 Capture old spectrogram for crossfade (BEFORE we start fading)
            const oldSpectrogram = document.createElement('canvas');
            oldSpectrogram.width = width;
            oldSpectrogram.height = height;
            oldSpectrogram.getContext('2d').drawImage(canvas, 0, 0);
            
            // Old spectrogram is STILL visible on display canvas
            // Now fade in the new one on top (300ms)
            const fadeDuration = 300;
            const fadeStart = performance.now();
            
            const fadeStep = () => {
                // console.log(`🎬 [spectrogram-renderer.js] changeFrequencyScale fadeStep: Drawing frame`);
                // 🔥 FIX: Check document connection before executing RAF callback
                // This prevents RAF callbacks from retaining references to detached documents
                if (!document.body || !document.body.isConnected) {
                    return; // Document is detached, stop the fade animation
                }
                
                const elapsed = performance.now() - fadeStart;
                const progress = Math.min(elapsed / fadeDuration, 1.0);
                
                // Ease-out for smooth fade
                const alpha = 1 - Math.pow(1 - progress, 2);
                
                // 🔥 CLEAR CANVAS - start fresh each frame!
                ctx.clearRect(0, 0, width, height);
                
                // Draw old spectrogram fading OUT
                ctx.globalAlpha = 1.0 - alpha;
                ctx.drawImage(oldSpectrogram, 0, 0);
                
                // Draw new spectrogram fading IN
                ctx.globalAlpha = alpha;
                ctx.drawImage(newSpectrogram, 0, 0);
                
                // Draw playhead on top with full opacity
                ctx.globalAlpha = 1.0;
                
                // 🔥 Draw playhead as medium grey during transition (WE control it during fade)
                if (State.currentAudioPosition !== null && State.totalAudioDuration > 0) {
                    const playheadX = (State.currentAudioPosition / State.totalAudioDuration) * width;
                    
                    ctx.strokeStyle = '#616161'; // A little darker grey
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(playheadX, 0);
                    ctx.lineTo(playheadX, height);
                    ctx.stroke();
                }
                
                // Reset alpha after drawing playhead
                ctx.globalAlpha = 1.0;
                
                if (progress < 1.0) {
                    requestAnimationFrame(fadeStep);
                } else {
                    // 🔥 FADE COMPLETE - LOCK IN THE NEW SPECTROGRAM!
                    // This updates cachedSpectrogramCanvas with the new frequency scale
                    updateSpectrogramViewport(playbackRate);
                    
                    // 🔥 RESUME playhead updates!
                    if (playbackWasActive) {
                        import('./waveform-renderer.js').then(module => {
                            module.startPlaybackIndicator();
                        });
                    }
                    
                    console.log('✅ Scale transition complete, cache updated, playhead resumed');
                }
            };
            
            fadeStep();
        } else {
            // Fallback: just re-render without fade
            clearCompleteSpectrogram();
            await renderCompleteSpectrogram();
        }
    } else {
        console.log('⚠️ No animation - no rendered spectrogram');
        // No spectrogram yet, just update axis
        positionAxisCanvas();
        initializeAxisPlaybackRate();
        drawFrequencyAxis();
    }
}

export function startVisualization() {
    // Only start visualization once to prevent multiple animation loops
    if (State.visualizationStarted) {
        return;
    }
    State.setVisualizationStarted(true);
    
    // Initialize axis positioning and drawing
    positionAxisCanvas();
    // Draw initial axis (will use current playback rate)
    drawFrequencyAxis();
    
    drawSpectrogram();
}

/**
 * Setup spectrogram frequency selection
 * Called from main.js after DOM is ready
 */
export function setupSpectrogramSelection() {
    const canvas = document.getElementById('spectrogram');
    if (!canvas) return;
    
    // Use the panel as container (same as waveform selection)
    const container = canvas.closest('.panel');
    if (!container) return;
    
    canvas.addEventListener('mousedown', (e) => {
        // Only handle if in frequency selection mode
        if (!isInFrequencySelectionMode()) return;
        
        const canvasRect = canvas.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        spectrogramStartX = e.clientX - canvasRect.left;
        spectrogramStartY = e.clientY - canvasRect.top;
        spectrogramSelectionActive = true;
        
        // Create selection box
        if (spectrogramSelectionBox) {
            spectrogramSelectionBox.remove();
        }
        spectrogramSelectionBox = document.createElement('div');
        spectrogramSelectionBox.className = 'selection-box';
        spectrogramSelectionBox.style.position = 'absolute';
        spectrogramSelectionBox.style.left = (spectrogramStartX + canvasRect.left - containerRect.left) + 'px';
        spectrogramSelectionBox.style.top = (spectrogramStartY + canvasRect.top - containerRect.top) + 'px';
        spectrogramSelectionBox.style.width = '0px';
        spectrogramSelectionBox.style.height = '0px';
        spectrogramSelectionBox.style.border = '2px solid #ff4444';
        spectrogramSelectionBox.style.background = 'rgba(255, 68, 68, 0.2)';
        spectrogramSelectionBox.style.pointerEvents = 'none';
        spectrogramSelectionBox.style.zIndex = '100';
        container.appendChild(spectrogramSelectionBox);
    });
    
    canvas.addEventListener('mousemove', (e) => {
        if (!spectrogramSelectionActive || !spectrogramSelectionBox) return;
        
        const canvasRect = canvas.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const currentX = e.clientX - canvasRect.left;
        const currentY = e.clientY - canvasRect.top;
        spectrogramEndY = currentY;
        
        const left = Math.min(spectrogramStartX, currentX);
        const top = Math.min(spectrogramStartY, currentY);
        const width = Math.abs(currentX - spectrogramStartX);
        const height = Math.abs(currentY - spectrogramStartY);
        
        spectrogramSelectionBox.style.left = (left + canvasRect.left - containerRect.left) + 'px';
        spectrogramSelectionBox.style.top = (top + canvasRect.top - containerRect.top) + 'px';
        spectrogramSelectionBox.style.width = width + 'px';
        spectrogramSelectionBox.style.height = height + 'px';
    });
    
    const handleMouseUp = async (e) => {
        if (!spectrogramSelectionActive) return;
        
        const rect = canvas.getBoundingClientRect();
        const endY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
        const endX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        
        // Use CSS dimensions, not device dimensions!
        await handleSpectrogramSelection(
            spectrogramStartY, endY, 
            canvas.offsetHeight,  // ← CSS PIXELS!
            spectrogramStartX, endX, 
            canvas.offsetWidth    // ← CSS PIXELS!
        );
        
        // DON'T delete the box - keep it and convert to persistent feature box!
        // (Will be converted to orange in addFeatureBox)
        // Note: spectrogramSelectionBox is exported so region-tracker.js can access it
        // Reset the selection box variable so a new one can be created for the next selection
        // (The box itself is now managed by spectrogram-feature-boxes.js)
        spectrogramSelectionBox = null;
        spectrogramSelectionActive = false;
        spectrogramStartX = null;
        spectrogramStartY = null;
        spectrogramEndY = null;
    };
    
    document.addEventListener('mouseup', handleMouseUp);
    
    // Handle escape key to cancel selection
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && spectrogramSelectionActive) {
            // On escape, we DO want to remove the box (cancelled selection)
            if (spectrogramSelectionBox) {
                spectrogramSelectionBox.remove();
                spectrogramSelectionBox = null;
            }
            spectrogramSelectionActive = false;
            spectrogramStartX = null;
            spectrogramStartY = null;
            spectrogramEndY = null;
        }
    });
    
    console.log('🎯 Spectrogram frequency selection enabled');
}

