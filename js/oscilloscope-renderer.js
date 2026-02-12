/**
 * oscilloscope-renderer.js
 * Real-time oscilloscope waveform display
 * Shows the last ~100ms of audio for visual feedback
 */

import { getColorLUT, getCurrentColormap } from './colormaps.js';

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
let lowPassAlpha = 0.92; // Low-pass filter coefficient (higher = more filtering) - increased for smoother, less jumpy flames
let lastAudioTime = 0; // Will be set when first audio arrives
let fadeMultiplier = 0.0; // Fade multiplier (1.0 = full, 0.0 = faded out) - start at 0, fade in when audio arrives
let errorModeActive = false; // When true, dials flame effect way up
let isCurrentlyPlaying = false; // Track playing state (set externally via setPlayingState)
let lastPlayingState = false; // Track previous playing state to detect toggles
let lastFadeUpdateTime = 0; // Track last fade update for delta-time calculation

// 🔥 GLOW FADE DURATION: Randomized fade durations (400ms - 3000ms)
let glowFadeUpDuration = 500; // Fade in duration (randomized on state toggle)
let glowFadeDownDuration = 500; // Fade out duration (randomized on state toggle)

// 🔥 GLOW THROTTLE: DOM box-shadow writes are expensive — throttle to ~10fps
let lastGlowRenderTime = 0;
const GLOW_RENDER_INTERVAL = 100; // ms between DOM updates (~10fps)
let cachedVisualizationPanel = null; // Cache querySelector result
let glowIsSettled = false; // True when fadeMultiplier is 0 and stable — skip all glow work
let loopRunning = false; // True when RAF loop is active — stopped when fully idle

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
    // Guard against multiple initializations
    if (isInitialized) {
        return true;
    }

    canvas = document.getElementById('oscilloscope');
    if (!canvas) {
        console.warn('⚠️ Oscilloscope canvas not found');
        return false;
    }

    ctx = canvas.getContext('2d', { alpha: true });
    isInitialized = true;
    
    // Show the panel (it's positioned in the flex container below spectrogram)
    positionOscilloscopePanel();
    
    // Start rendering loop
    startRendering();

    console.log('🎨 Oscilloscope initialized');
    return true;
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
    
    // Exponential smoothing (reduced for more responsiveness)
    lowFreqSmoother = lowFreqSmoother * lowPassAlpha + avg * (1 - lowPassAlpha);
    
    // Second smoothing layer (reduced for more responsiveness)
    lowFreqAmplitude = lowFreqAmplitude * 0.75 + lowFreqSmoother * 0.25;
    
    return lowFreqAmplitude;
}

/**
 * Update panel glow based on low frequency amplitude
 * Applies glow to visualization panel only, positioned behind panel content
 * Uses multiple sine waves to create variable, flame-like intensity
 */
function updatePanelGlow() {
    // Cache panel element (avoid querySelector every frame)
    if (!cachedVisualizationPanel) {
        cachedVisualizationPanel = document.querySelector('.panel-visualization');
    }
    if (!cachedVisualizationPanel) return;

    const now = performance.now();

    // ── Fade multiplier update (cheap math, runs every frame) ──
    const timeSinceAudio = lastAudioTime === 0 ? Infinity : now - lastAudioTime;

    if (lastFadeUpdateTime === 0) {
        lastFadeUpdateTime = now;
    }
    const deltaTime = now - lastFadeUpdateTime;
    lastFadeUpdateTime = now;

    const prevFade = fadeMultiplier;
    if (timeSinceAudio > 200) {
        const fadeRate = deltaTime / glowFadeDownDuration;
        fadeMultiplier = Math.max(0, fadeMultiplier - fadeRate);
    } else {
        const fadeRate = deltaTime / glowFadeUpDuration;
        fadeMultiplier = Math.min(1, fadeMultiplier + fadeRate);
    }

    if (errorModeActive) {
        fadeMultiplier = 1.0;
    }

    // ── Settled check: if fadeMultiplier is 0 and hasn't changed, skip DOM work ──
    if (fadeMultiplier === 0 && prevFade === 0 && !errorModeActive) {
        if (glowIsSettled) return; // Already wrote the settled shadow, nothing to do
        glowIsSettled = true; // Will write one final shadow below, then stop
    } else {
        glowIsSettled = false;
    }

    // ── Throttle: only update DOM at ~10fps (unless settling) ──
    if (!glowIsSettled && (now - lastGlowRenderTime) < GLOW_RENDER_INTERVAL) {
        return;
    }
    lastGlowRenderTime = now;

    // ── Compute glow intensity ──
    let baseIntensity = Math.min(1, lowFreqAmplitude * 3.5) * fadeMultiplier;
    if (errorModeActive) {
        baseIntensity = Math.min(1, lowFreqAmplitude * 8);
    }

    // Sine wave flame variation
    const time = now / 1000;
    const wave1 = Math.sin(time * 4.2) * 0.12;
    const wave2 = Math.sin(time * 6.8 + Math.PI / 3) * 0.1;
    const wave3 = Math.sin(time * 10.2 + Math.PI / 2) * 0.08;
    const wave4 = Math.sin(time * 15.5 + Math.PI) * 0.06;
    const waveMultiplier = 1.0 + wave1 + wave2 + wave3 + wave4;
    const clampedMultiplier = Math.max(0.92, Math.min(1.15, waveMultiplier));
    let intensity = Math.max(0, Math.min(1, baseIntensity * clampedMultiplier));

    const glowOpacity = errorModeActive ? intensity * 0.18 : intensity * 0.15;
    const glowBlur = errorModeActive ? 30 + intensity * 60 : 20 + intensity * 50;
    const glowSpread = errorModeActive ? intensity * 30 : 12 + intensity * 5;

    // 🎨 Colormap colors
    const colorLUT = getColorLUT();
    const currentMap = getCurrentColormap();
    let colorIndex;
    if (currentMap === 'solar') {
        colorIndex = Math.floor(100 + intensity * 80);
    } else if (currentMap === 'inferno') {
        colorIndex = Math.floor(140 + intensity * 60);
    } else {
        colorIndex = Math.floor(180 + intensity * 75);
    }
    const red = colorLUT[colorIndex * 3];
    const green = colorLUT[colorIndex * 3 + 1];
    const blue = colorLUT[colorIndex * 3 + 2];

    // Ambient/static glow parameters
    const minGlowOpacity = 0.20;
    const minBlurScale = 0.32;
    const maxGlowOpacity = 0.30;
    const maxBlurScale = 0.35;

    const glowFactor = minGlowOpacity + (maxGlowOpacity - minGlowOpacity) * fadeMultiplier;
    const blurFactor = minBlurScale + (maxBlurScale - minBlurScale) * fadeMultiplier;
    const staticGlowMultiplier = 2.2;
    const ambientBlurMultiplier = 6.5;

    // Build shadow string and write to DOM (the expensive part — now throttled to ~10fps)
    const fullShadow = `0 0 ${(80 * blurFactor * ambientBlurMultiplier).toFixed(0)}px ${(15 * blurFactor * ambientBlurMultiplier).toFixed(0)}px rgba(${red},${green},${blue},${Math.min(1, 0.35 * glowFactor * staticGlowMultiplier).toFixed(3)}),0 0 ${(glowBlur * 1.3).toFixed(0)}px ${(glowSpread * 1.3).toFixed(0)}px rgba(${red},${green},${blue},${(glowOpacity * 1.2).toFixed(3)}),0 0 ${(glowBlur * 2).toFixed(0)}px ${(glowSpread * 2).toFixed(0)}px rgba(${red},${green},${blue},${(glowOpacity * 0.6).toFixed(3)}),0 1px 3px rgba(0,0,0,${(0.05 + 0.05 * glowFactor).toFixed(3)}),inset 0 1px 0 rgba(255,255,255,${(0.3 + 0.3 * glowFactor).toFixed(3)})`;

    cachedVisualizationPanel.style.boxShadow = fullShadow;
}

/**
 * Set the current playing state (called from audio-player.js)
 * Randomizes fade durations when state toggles
 */
export function setPlayingState(isPlaying) {
    // Detect state toggle
    if (isPlaying !== lastPlayingState) {
        // Randomize fade durations between 400ms and 3000ms
        glowFadeUpDuration = 400 + Math.random() * 2600; // 400-3000ms
        glowFadeDownDuration = 400 + Math.random() * 2600; // 400-3000ms
        // console.log(`🎮 State toggle: ${lastPlayingState} → ${isPlaying} | Fade up: ${glowFadeUpDuration.toFixed(0)}ms, Fade down: ${glowFadeDownDuration.toFixed(0)}ms`);
    }
    lastPlayingState = isPlaying;
    isCurrentlyPlaying = isPlaying;
}

/**
 * Add audio samples to the oscilloscope buffer
 */
export function addOscilloscopeData(samples) {
    if (!isInitialized || !samples || samples.length === 0) return;

    // Only update lastAudioTime when actually playing (not when paused/outputting silence)
    if (isCurrentlyPlaying) {
        lastAudioTime = performance.now();
        // Wake the render loop if it stopped itself during idle
        if (!loopRunning) startRendering();
    }
    
    // Analyze low frequency amplitude
    analyzeLowFrequency(samples);
    
    // Note: updatePanelGlow() now runs in render() loop for continuous sine wave animation
    
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

    // Update glow (throttled internally to ~10fps for DOM writes)
    updatePanelGlow();

    // Skip oscilloscope canvas drawing when fully faded — waveform is invisible
    if (fadeMultiplier === 0 && !errorModeActive) {
        return;
    }

    const width = canvas.width;
    const height = canvas.height;
    const centerY = height / 2;

    ctx.clearRect(0, 0, width, height);

    // Center line
    ctx.strokeStyle = `rgba(255, 150, 120, ${0.15 * fadeMultiplier})`;
    ctx.lineWidth = 0.5;
    ctx.shadowBlur = 3;
    ctx.shadowColor = `rgba(255, 100, 80, ${0.2 * fadeMultiplier})`;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(width, centerY);
    ctx.stroke();
    ctx.shadowBlur = 0;

    scrollOffset = (scrollOffset + 2) % audioBuffer.length;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const numSamples = 1024;
    const samplesPerPixel = width / numSamples;

    ctx.beginPath();

    for (let i = 0; i < numSamples; i++) {
        const bufferPos = (bufferIndex - scrollOffset - i + audioBuffer.length * 2) % audioBuffer.length;
        const sample = audioBuffer[bufferPos];
        const x = width - (i * samplesPerPixel);
        const amplifiedSample = sample * 2;
        const y = centerY - (amplifiedSample * centerY * 1.4);

        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    }

    const fade = fadeMultiplier;
    ctx.strokeStyle = `rgba(255, 130, 90, ${0.9 * fade})`;
    ctx.lineWidth = 1.5;
    ctx.shadowBlur = 6;
    ctx.shadowColor = `rgba(255, 100, 70, ${0.6 * fade})`;
    ctx.stroke();
    ctx.shadowBlur = 0;
}

/**
 * Start the rendering loop (idempotent — safe to call when already running)
 */
function startRendering() {
    if (loopRunning) return;
    loopRunning = true;

    function loop() {
        render();

        // Stop the loop entirely when glow is settled and canvas is idle
        if (glowIsSettled && fadeMultiplier === 0 && !errorModeActive) {
            loopRunning = false;
            animationFrameId = null;
            return;
        }
        animationFrameId = requestAnimationFrame(loop);
    }

    animationFrameId = requestAnimationFrame(loop);
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

/**
 * Enable error mode - dials flame effect way up
 */
export function setErrorMode(enabled) {
    errorModeActive = enabled;
    if (enabled) {
        fadeMultiplier = 1.0;
        if (!loopRunning) startRendering();
        console.log('🔥 Error mode enabled - flame effect dialed way up!');
    }
}

