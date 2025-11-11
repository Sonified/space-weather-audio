/**
 * spectrogram-renderer.js
 * Spectrogram visualization and scroll speed control
 */

import * as State from './audio-state.js';

export function drawSpectrogram() {
    if (!State.analyserNode) return;
    
    // Pause visualization when audio is paused or not playing
    if (State.isPaused || !State.isPlaying) {
        requestAnimationFrame(drawSpectrogram);
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
        return;
    }
    
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
                const y = height - (i / bufferLength) * height;
                ctx.fillStyle = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
                ctx.fillRect(width - 1, y, 1, height / bufferLength);
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
                const y = height - (i / bufferLength) * height;
                ctx.fillStyle = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
                ctx.fillRect(width - scrollPixels + p, y, 1, height / bufferLength);
            }
        }
    }
    
    requestAnimationFrame(drawSpectrogram);
}

export function changeSpectrogramScrollSpeed() {
    const slider = document.getElementById('spectrogramScrollSpeed');
    const value = parseFloat(slider.value);
    
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

export function startVisualization() {
    // Only start visualization once to prevent multiple animation loops
    if (State.visualizationStarted) {
        return;
    }
    State.setVisualizationStarted(true);
    drawSpectrogram();
}

