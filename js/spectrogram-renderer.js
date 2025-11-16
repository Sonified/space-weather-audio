/**
 * spectrogram-renderer.js
 * Spectrogram visualization and scroll speed control
 */

import * as State from './audio-state.js';
import { PlaybackState } from './audio-state.js';
import { drawFrequencyAxis, positionAxisCanvas, resizeAxisCanvas, initializeAxisPlaybackRate } from './spectrogram-axis-renderer.js';
import { handleSpectrogramSelection, isInFrequencySelectionMode } from './region-tracker.js';
import { renderCompleteSpectrogram, clearCompleteSpectrogram, isCompleteSpectrogramRendered } from './spectrogram-complete-renderer.js';

// Spectrogram selection state
let spectrogramSelectionActive = false;
let spectrogramStartX = null;
let spectrogramStartY = null;
let spectrogramEndY = null;
let spectrogramSelectionBox = null;

export function drawSpectrogram() {
    // 🔥 FIX: Cancel any existing RAF to prevent closure chain memory leak
    if (State.spectrogramRAF !== null) {
        cancelAnimationFrame(State.spectrogramRAF);
        State.setSpectrogramRAF(null);
    }
    
    // Early exit: no analyser - stop the loop completely
    if (!State.analyserNode) return;
    
    // Early exit: not playing - schedule next frame to keep checking
    if (State.playbackState !== PlaybackState.PLAYING) {
        State.setSpectrogramRAF(requestAnimationFrame(drawSpectrogram));
        return;
    }
    
    const canvas = document.getElementById('spectrogram');
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    // Clear entire canvas only on first initialization
    if (!State.spectrogramInitialized) {
        ctx.clearRect(0, 0, width, height);
        State.setSpectrogramInitialized(true);
    }
    
    const bufferLength = State.analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    State.analyserNode.getByteFrequencyData(dataArray);
    
    const actualScrollSpeed = State.spectrogramScrollSpeed;
    
    if (actualScrollSpeed <= 0) {
        // 🔥 FIX: Store RAF ID before returning
        State.setSpectrogramRAF(requestAnimationFrame(drawSpectrogram));
        return;
    }
    
    // Helper function to calculate y position based on frequency scale
    const getYPosition = (binIndex, totalBins, canvasHeight) => {
        if (State.frequencyScale === 'logarithmic') {
            // Logarithmic scale: strong emphasis on lower frequencies
            // Map bin index to log scale (avoiding log(0))
            const minFreq = 1; // Minimum frequency bin (avoid log(0))
            const maxFreq = totalBins;
            const logMin = Math.log10(minFreq);
            const logMax = Math.log10(maxFreq);
            const logFreq = Math.log10(Math.max(binIndex + 1, minFreq));
            const normalizedLog = (logFreq - logMin) / (logMax - logMin);
            return canvasHeight - (normalizedLog * canvasHeight);
        } else if (State.frequencyScale === 'sqrt') {
            // Square root scale: gentle emphasis on lower frequencies (good middle ground)
            const normalized = binIndex / totalBins;
            const sqrtNormalized = Math.sqrt(normalized);
            return canvasHeight - (sqrtNormalized * canvasHeight);
        } else {
            // Linear scale (default) - even spacing
            return canvasHeight - (binIndex / totalBins) * canvasHeight;
        }
    };
    
    if (actualScrollSpeed < 1.0) {
        // Slow speed: skip frames
        State.setSpectrogramFrameCounter(State.spectrogramFrameCounter + 1);
        const skipFrames = Math.max(1, Math.round(1.0 / actualScrollSpeed));
        const shouldScroll = (State.spectrogramFrameCounter % skipFrames === 0);
        
        if (shouldScroll) {
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
        }
    } else {
        // Fast speed: scroll multiple pixels per frame
        const scrollPixels = Math.round(actualScrollSpeed);
        for (let p = 0; p < scrollPixels; p++) {
            ctx.drawImage(canvas, -1, 0);
        }
        
        // Clear the rightmost columns
        ctx.clearRect(width - scrollPixels, 0, scrollPixels, height);
        
        // Draw new columns on the right
        for (let p = 0; p < scrollPixels; p++) {
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
                ctx.fillRect(width - scrollPixels + p, nextY, 1, barHeight);
            }
        }
    }
    
    // 🔥 FIX: Store RAF ID for proper cleanup
    State.setSpectrogramRAF(requestAnimationFrame(drawSpectrogram));
}

export function changeSpectrogramScrollSpeed() {
    const slider = document.getElementById('spectrogramScrollSpeed');
    const value = parseFloat(slider.value);
    
    // Save slider value to localStorage for persistence across sessions
    localStorage.setItem('spectrogramScrollSpeed', value.toString());
    
    // Logarithmic mapping
    let rawSpeed;
    if (value <= 66.67) {
        const normalized = value / 66.67;
        rawSpeed = Math.pow(10, normalized * 0.903 - 0.903);
    } else {
        const normalized = (value - 66.67) / 33.33;
        rawSpeed = Math.pow(10, normalized * Math.log10(5));
    }
    
    // Snap to discrete achievable speeds
    // Rescaled so old 0.25x is now 1x, with more granular slow speeds
    const discreteSpeeds = [0.125, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 12.0, 16.0, 20.0];
    let displaySpeed = discreteSpeeds[0];
    for (let i = 0; i < discreteSpeeds.length - 1; i++) {
        const midpoint = (discreteSpeeds[i] + discreteSpeeds[i + 1]) / 2;
        if (rawSpeed >= midpoint) {
            displaySpeed = discreteSpeeds[i + 1];
        } else {
            displaySpeed = discreteSpeeds[i];
            break;
        }
    }
    
    State.setSpectrogramScrollSpeed(displaySpeed);
    
    // Update display - remove unnecessary zeros
    let displayText;
    if (displaySpeed < 1.0) {
        let speedStr = displaySpeed.toString();
        if (speedStr.startsWith('0.')) {
            speedStr = speedStr.substring(1);
        }
        speedStr = speedStr.replace(/\.?0+$/, '');
        displayText = speedStr + 'x';
    } else {
        displayText = displaySpeed.toFixed(0) + 'x';
    }
    document.getElementById('spectrogramScrollSpeedValue').textContent = displayText;
}

/**
 * Load spectrogram scroll speed from localStorage and apply it
 * Called on page load to restore user's preferred scroll speed
 * Updates the slider and display immediately to avoid visual jump
 */
export function loadSpectrogramScrollSpeed() {
    const slider = document.getElementById('spectrogramScrollSpeed');
    const displayElement = document.getElementById('spectrogramScrollSpeedValue');
    if (!slider) return;
    
    // Load saved value from localStorage (default: 67, which maps to 1.0x)
    const savedValue = localStorage.getItem('spectrogramScrollSpeed');
    if (savedValue !== null) {
        const value = parseFloat(savedValue);
        // Validate value is within slider range (0-100)
        if (!isNaN(value) && value >= 0 && value <= 100) {
            slider.value = value;
            
            // Calculate and update display immediately to avoid visual jump
            // (Same logic as changeSpectrogramScrollSpeed but without saving to localStorage)
            let rawSpeed;
            if (value <= 66.67) {
                const normalized = value / 66.67;
                rawSpeed = Math.pow(10, normalized * 0.903 - 0.903);
            } else {
                const normalized = (value - 66.67) / 33.33;
                rawSpeed = Math.pow(10, normalized * Math.log10(5));
            }
            
            const discreteSpeeds = [0.125, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 12.0, 16.0, 20.0];
            let displaySpeed = discreteSpeeds[0];
            for (let i = 0; i < discreteSpeeds.length - 1; i++) {
                const midpoint = (discreteSpeeds[i] + discreteSpeeds[i + 1]) / 2;
                if (rawSpeed >= midpoint) {
                    displaySpeed = discreteSpeeds[i + 1];
                } else {
                    displaySpeed = discreteSpeeds[i];
                    break;
                }
            }
            
            // Update state
            State.setSpectrogramScrollSpeed(displaySpeed);
            
            // Update display text immediately
            let displayText;
            if (displaySpeed < 1.0) {
                let speedStr = displaySpeed.toString();
                if (speedStr.startsWith('0.')) {
                    speedStr = speedStr.substring(1);
                }
                speedStr = speedStr.replace(/\.?0+$/, '');
                displayText = speedStr + 'x';
            } else {
                displayText = displaySpeed.toFixed(0) + 'x';
            }
            
            if (displayElement) {
                displayElement.textContent = displayText;
            }
            
            console.log('💾 Restored spectrogram scroll speed:', value, '→', displayText);
            return; // Don't call changeSpectrogramScrollSpeed to avoid saving default again
        }
    }
    
    // If no saved value, apply default (this will also update display)
    changeSpectrogramScrollSpeed();
}

export async function changeFrequencyScale() {
    const select = document.getElementById('frequencyScale');
    const value = select.value; // 'linear', 'sqrt', or 'logarithmic'
    
    State.setFrequencyScale(value);
    
    console.log(`📊 Frequency scale changed to: ${value}`);
    
    // If complete spectrogram is rendered, re-render with new scale
    if (isCompleteSpectrogramRendered()) {
        console.log('🎨 Re-rendering spectrogram with new frequency scale...');
        
        // Clear existing render
        clearCompleteSpectrogram();
        
        // Re-render with new scale
        await renderCompleteSpectrogram();
    }
    
    // Redraw axis with new scale (respects current playback speed)
    positionAxisCanvas();
    initializeAxisPlaybackRate();
    drawFrequencyAxis();
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
    
    const handleMouseUp = (e) => {
        if (!spectrogramSelectionActive) return;
        
        const rect = canvas.getBoundingClientRect();
        const endY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
        const endX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        
        // Call region tracker handler with X positions for time tracking
        handleSpectrogramSelection(spectrogramStartY, endY, canvas.height, spectrogramStartX, endX, canvas.width);
        
        // Cleanup
        if (spectrogramSelectionBox) {
            spectrogramSelectionBox.remove();
            spectrogramSelectionBox = null;
        }
        spectrogramSelectionActive = false;
        spectrogramStartX = null;
        spectrogramStartY = null;
        spectrogramEndY = null;
    };
    
    document.addEventListener('mouseup', handleMouseUp);
    
    // Handle escape key to cancel selection
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && spectrogramSelectionActive) {
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

