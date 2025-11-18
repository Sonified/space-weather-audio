/**
 * oscilloscope-renderer.js
 * Real-time oscilloscope waveform display
 * Shows the last ~100ms of audio for visual feedback
 */

let canvas = null;
let ctx = null;
let audioBuffer = new Float32Array(2048); // Store last ~46ms at 44.1kHz (fewer samples)
let bufferIndex = 0;
let isInitialized = false;
let animationFrameId = null;
let scrollOffset = 0; // For smooth scrolling effect
let lowFreqAmplitude = 0; // Low frequency amplitude for glow effect
let lowFreqSmoother = 0; // Smooth the amplitude changes
let lowPassBuffer = new Float32Array(128); // Buffer for low-pass filtering
let lowPassIndex = 0;
let lowPassAlpha = 0.95; // Low-pass filter coefficient (higher = more filtering)
let lastAudioTime = 0; // Track when we last received audio
let fadeMultiplier = 1.0; // Fade multiplier (1.0 = full, 0.0 = faded out)

/**
 * Show the oscilloscope panel (positioned in the bar below spectrogram)
 */
export function positionOscilloscopePanel() {
    const oscilloscopePanel = document.getElementById('oscilloscope-panel');
    const frostOverlay = document.getElementById('oscilloscope-frost');
    if (oscilloscopePanel) {
        oscilloscopePanel.style.display = 'block';
    }
    if (frostOverlay) {
        frostOverlay.style.display = 'block';
    }
}

/**
 * Initialize the oscilloscope display
 */
export function initOscilloscope() {
    canvas = document.getElementById('oscilloscope');
    if (!canvas) {
        console.warn('⚠️ Oscilloscope canvas not found');
        return;
    }
    
    ctx = canvas.getContext('2d', { alpha: true });
    isInitialized = true;
    
    // Show the panel (it's positioned in the flex container below spectrogram)
    positionOscilloscopePanel();
    
    // Start rendering loop
    startRendering();
    
    console.log('🎨 Oscilloscope initialized');
}

/**
 * Analyze low frequency amplitude from audio samples
 * Proper low-pass filter to extract low frequency content
 */
function analyzeLowFrequency(samples) {
    if (!samples || samples.length === 0) return 0;
    
    // Add samples to circular buffer and calculate average
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
        lowPassBuffer[lowPassIndex] = Math.abs(samples[i]);
        lowPassIndex = (lowPassIndex + 1) % lowPassBuffer.length;
    }
    
    // Calculate moving average of entire buffer
    let bufferSum = 0;
    for (let j = 0; j < lowPassBuffer.length; j++) {
        bufferSum += lowPassBuffer[j];
    }
    const avg = bufferSum / lowPassBuffer.length;
    
    // Heavy exponential smoothing (very low-passed, alpha = 0.95 means 95% old, 5% new)
    lowFreqSmoother = lowFreqSmoother * lowPassAlpha + avg * (1 - lowPassAlpha);
    
    // Additional smoothing layer for very smooth transitions
    lowFreqAmplitude = lowFreqAmplitude * 0.9 + lowFreqSmoother * 0.1;
    
    return lowFreqAmplitude;
}

/**
 * Update panel glow based on low frequency amplitude
 */
function updatePanelGlow() {
    const panel = document.querySelector('.panel-visualization');
    if (!panel) return;
    
    // Check if audio has stopped (no samples for 200ms)
    const now = performance.now();
    const timeSinceAudio = now - lastAudioTime;
    if (timeSinceAudio > 200) {
        // Fade out gradually
        fadeMultiplier = Math.max(0, fadeMultiplier - 0.02); // Fade out over ~1 second
    } else {
        // Fade back in when audio resumes
        fadeMultiplier = Math.min(1, fadeMultiplier + 0.05);
    }
    
    // Map amplitude (0-1) to glow intensity (bigger, more fire effect)
    const intensity = Math.min(1, lowFreqAmplitude * 3) * fadeMultiplier; // Scale up, cap at 1, apply fade
    const glowOpacity = intensity * 0.25; // Max 25% opacity (increased from 15%)
    const glowBlur = 25 + (intensity * 50); // 25-75px blur (bigger)
    const glowSpread = intensity * 20; // 0-20px spread (more)
    
    // Fire-like colors: orange/red gradient
    const red = 255;
    const green = 100 + (intensity * 80); // 100-180 (orange to yellow)
    const blue = 50 + (intensity * 30); // 50-80 (warm tones)
    
    // Preserve existing box-shadow from CSS and add glow
    const existingShadow = '0 10px 20px rgba(80, 20, 20, 0.35), 0 6px 12px rgba(80, 20, 20, 0.25), 0 3px 6px rgba(255, 100, 100, 0.15), 0 1px 3px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.6)';
    
    panel.style.boxShadow = `
        ${existingShadow},
        0 0 ${glowBlur}px ${glowSpread}px rgba(${red}, ${green}, ${blue}, ${glowOpacity}),
        inset 0 0 ${glowBlur * 0.5}px rgba(${red}, ${green}, ${blue}, ${glowOpacity * 0.3})
    `;
}

/**
 * Add audio samples to the oscilloscope buffer
 */
export function addOscilloscopeData(samples) {
    if (!isInitialized || !samples || samples.length === 0) return;
    
    // Update last audio time
    lastAudioTime = performance.now();
    
    // Analyze low frequency amplitude
    analyzeLowFrequency(samples);
    
    // Update panel glow
    updatePanelGlow();
    
    // Add new samples to buffer (circular buffer)
    for (let i = 0; i < samples.length; i++) {
        audioBuffer[bufferIndex] = samples[i];
        bufferIndex = (bufferIndex + 1) % audioBuffer.length;
    }
}

/**
 * Render the oscilloscope waveform with fast scrolling effect
 */
function render() {
    if (!ctx || !canvas) return;
    
    // Check if audio has stopped and update fade
    const now = performance.now();
    const timeSinceAudio = now - lastAudioTime;
    if (timeSinceAudio > 200) {
        // Fade out gradually
        fadeMultiplier = Math.max(0, fadeMultiplier - 0.02); // Fade out over ~1 second
    } else {
        // Fade back in when audio resumes
        fadeMultiplier = Math.min(1, fadeMultiplier + 0.05);
    }
    
    const width = canvas.width;
    const height = canvas.height;
    const centerY = height / 2;
    
    // Clear canvas
    ctx.clearRect(0, 0, width, height);
    
    // Draw center line (subtle, glowing) - fade with multiplier
    ctx.strokeStyle = `rgba(255, 150, 120, ${0.15 * fadeMultiplier})`;
    ctx.lineWidth = 0.5;
    ctx.shadowBlur = 3;
    ctx.shadowColor = `rgba(255, 100, 80, ${0.2 * fadeMultiplier})`;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(width, centerY);
    ctx.stroke();
    ctx.shadowBlur = 0;
    
    scrollOffset = (scrollOffset + 2) % audioBuffer.length; // Fast scroll
    
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    // Draw 4 waves with different buffer sizes: 32, 64, 128, 256 samples
    // Add timing noise for each wave
    const timeNoise = Math.sin(scrollOffset * 0.1) * 2; // Slow sine wave for noise
    
    const waveConfigs = [
        { numSamples: 32, color: 'rgba(255, 120, 80, 0.7)', shadowColor: 'rgba(200, 80, 60, 0.5)', outerGlow: 'rgba(200, 80, 60, 0.15)', highlightColor: 'rgba(255, 160, 100, 0.75)', noiseOffset: Math.sin(scrollOffset * 0.15) * 0.2 },
        { numSamples: 64, color: 'rgba(255, 140, 90, 0.55)', shadowColor: 'rgba(220, 100, 70, 0.45)', outerGlow: 'rgba(220, 100, 70, 0.12)', highlightColor: 'rgba(255, 180, 120, 0.65)', noiseOffset: Math.sin(scrollOffset * 0.12) * 0.25 },
        { numSamples: 128, color: 'rgba(255, 160, 100, 0.45)', shadowColor: 'rgba(240, 120, 80, 0.35)', outerGlow: 'rgba(240, 120, 80, 0.1)', highlightColor: 'rgba(255, 200, 140, 0.55)', noiseOffset: Math.sin(scrollOffset * 0.08) * 0.3 },
        { numSamples: 256, color: 'rgba(255, 180, 110, 0.35)', shadowColor: 'rgba(250, 140, 90, 0.3)', outerGlow: 'rgba(250, 140, 90, 0.08)', highlightColor: 'rgba(255, 220, 160, 0.45)', noiseOffset: Math.sin(scrollOffset * 0.06) * 0.35 }
    ];
    
    for (const config of waveConfigs) {
        const numSamples = config.numSamples;
        const samplesPerPixel = width / numSamples;
        
        ctx.beginPath();
        
        for (let i = 0; i < numSamples; i++) {
            // Read from circular buffer with timing noise offset
            const noiseOffset = Math.round(config.noiseOffset);
            const bufferPos = (bufferIndex - scrollOffset - noiseOffset - i + audioBuffer.length * 2) % audioBuffer.length;
            const sample = audioBuffer[bufferPos];
            
            // Map sample index to x position
            const x = i * samplesPerPixel;
            
            // Scale to canvas height with amplification (2x) and y scaling
            const amplifiedSample = sample * 2; // Amplify signal by 2x
            const y = centerY - (amplifiedSample * centerY * 1.4); // 140% of height for more y-zoom
            
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        
        // Apply fade multiplier to all colors
        const fade = fadeMultiplier;
        
        // Helper to apply fade to rgba color strings
        const applyFade = (colorStr) => {
            const match = colorStr.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
            if (match) {
                const [, r, g, b, a] = match;
                return `rgba(${r}, ${g}, ${b}, ${parseFloat(a) * fade})`;
            }
            return colorStr;
        };
        
        // Outer glow
        ctx.strokeStyle = applyFade(config.outerGlow);
        ctx.lineWidth = 2;
        ctx.shadowBlur = 3;
        ctx.shadowColor = applyFade(config.shadowColor);
        ctx.stroke();
        
        // Main waveform
        ctx.strokeStyle = applyFade(config.color);
        ctx.lineWidth = 1.5;
        ctx.shadowBlur = 6;
        ctx.shadowColor = applyFade(config.shadowColor);
        ctx.stroke();
        
        // Inner highlight
        ctx.strokeStyle = applyFade(config.highlightColor);
        ctx.lineWidth = 0.5;
        ctx.shadowBlur = 4;
        ctx.shadowColor = applyFade(config.shadowColor);
        ctx.stroke();
    }
    
    ctx.shadowBlur = 0;
}

/**
 * Start the rendering loop
 */
function startRendering() {
    function loop() {
        render();
        animationFrameId = requestAnimationFrame(loop);
    }
    
    loop();
}

/**
 * Stop the rendering loop
 */
export function stopOscilloscope() {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    
    // Clear canvas
    if (ctx && canvas) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    
    // Hide panel
    const oscilloscopePanel = document.getElementById('oscilloscope-panel');
    if (oscilloscopePanel) {
        oscilloscopePanel.style.display = 'none';
    }
    
    isInitialized = false;
    console.log('🛑 Oscilloscope stopped');
}

/**
 * Clear the oscilloscope buffer
 */
export function clearOscilloscope() {
    audioBuffer.fill(0);
    bufferIndex = 0;
    
    if (ctx && canvas) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
}

