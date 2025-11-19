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
    // Get visualization panel (main panel only)
    const visualizationPanel = document.querySelector('.panel-visualization');
    
    if (!visualizationPanel) return;
    
    // Get current time for sinusoidal variations
    const now = performance.now();
    
    // Check if audio has stopped (no samples for 200ms)
    const timeSinceAudio = lastAudioTime === 0 ? Infinity : now - lastAudioTime;
    
    // Frame-rate independent fade: uses randomized fade durations
    if (lastFadeUpdateTime === 0) {
        lastFadeUpdateTime = now; // Initialize on first frame
    }
    const deltaTime = now - lastFadeUpdateTime;
    lastFadeUpdateTime = now;
    
    if (timeSinceAudio > 200) {
        // Fade out gradually (frame-rate independent) - uses randomized fade down duration
        const fadeRate = deltaTime / glowFadeDownDuration; // Fraction to change per millisecond
        fadeMultiplier = Math.max(0, fadeMultiplier - fadeRate);
    } else {
        // Fade in gradually (frame-rate independent) - uses randomized fade up duration
        const fadeRate = deltaTime / glowFadeUpDuration; // Fraction to change per millisecond
        fadeMultiplier = Math.min(1, fadeMultiplier + fadeRate);
    }
    
    // Base intensity from audio amplitude - reduced for less prominent flames
    let baseIntensity = Math.min(1, lowFreqAmplitude * 3.5) * fadeMultiplier;
    
    // 🔥 ERROR MODE: Dial flame effect way up!
    if (errorModeActive) {
        baseIntensity = Math.min(1, lowFreqAmplitude * 8); // Much stronger amplification
        fadeMultiplier = 1.0; // Keep it at full intensity
    }
    
    // Create variable flame-like intensity using multiple sine waves as multipliers
    // Different frequencies and phases create organic, heat-like variations
    const time = now / 1000; // Time in seconds
    
    // Multiple sine waves at different frequencies (heat waves - further reduced amplitudes for smoother flames)
    // These will multiply the base intensity to create variation
    const wave1 = Math.sin(time * 4.2) * 0.12;      // Primary wave (~4.2 Hz) - further reduced amplitude
    const wave2 = Math.sin(time * 6.8 + Math.PI / 3) * 0.1;  // Medium wave (~6.8 Hz) - further reduced amplitude
    const wave3 = Math.sin(time * 10.2 + Math.PI / 2) * 0.08;  // Faster wave (~10.2 Hz) - further reduced amplitude
    const wave4 = Math.sin(time * 15.5 + Math.PI) * 0.06;      // Fast wave (~15.5 Hz) - further reduced amplitude
    
    // Combine waves to create a multiplier (centered around 1.0, varying above/below)
    // Sum ranges from ~-0.6 to ~0.6, so we add 1.0 to center it around 1.0
    const waveMultiplier = 1.0 + (wave1 + wave2 + wave3 + wave4); // Ranges from ~0.4 to ~1.6
    
    // Apply multiplier to base intensity (this creates rising and falling like heat)
    // Clamp the multiplier to even tighter bounds (0.92 to 1.15) - smoother, less jumpy variation
    const clampedMultiplier = Math.max(0.92, Math.min(1.15, waveMultiplier));
    let intensity = baseIntensity * clampedMultiplier;
    intensity = Math.max(0, Math.min(1, intensity)); // Clamp final intensity to 0-1
    
    const glowOpacity = errorModeActive 
        ? intensity * 0.18  // Max 18% opacity when error (reduced 10%)
        : intensity * 0.15; // Max 15% opacity normally (reduced for less prominent)
    const glowBlur = errorModeActive
        ? 30 + (intensity * 60)  // 30-90px blur when error
        : 20 + (intensity * 50);  // 20-70px blur normally (reduced for less prominent)
    const glowSpread = errorModeActive
        ? intensity * 30  // 0-30px spread when error
        : 12 + (intensity * 5); // 12-17px spread normally (reduced for less prominent)
    
    // Fire-like colors: subtle orange → amber variation
    const red = 255;
    const green = 100 + (intensity * 80); // 100-180 (orange to amber)
    const blue = 40 + (intensity * 40); // 40-80 (warm tones)
    
    // ===== AMBIENT GLOW PARAMETERS =====
    // Glow LOW (at rest/paused) - ALWAYS VISIBLE
    const minGlowOpacity = 0.18;   // 18% opacity minimum (always visible ambient glow)
    const minBlurScale = 0.3;      // 30% blur size (minimal variation - mostly opacity fade)
    
    // Glow HIGH (when playing) - FADES UP (not expanding)
    const maxGlowOpacity = 0.28;    // 28% opacity maximum
    const maxBlurScale = 0.32;      // 32% blur size (minimal variation - mostly opacity fade)
    
    // Fade time: Randomized between 400ms-3000ms on each state toggle (separate for fade up/down)
    
    // Calculate actual glow based on fadeMultiplier (0 = paused/minimum, 1 = playing/maximum)
    const glowFactor = minGlowOpacity + (maxGlowOpacity - minGlowOpacity) * fadeMultiplier;
    const blurFactor = minBlurScale + (maxBlurScale - minBlurScale) * fadeMultiplier;
    
    // 🔥 STATIC GLOW INTENSITY MULTIPLIER (opacity boost)
    const staticGlowMultiplier = 2; // 20% of original 10x
    
    // 🔥 AMBIENT GLOW: Blur multiplier for ambient glow
    const ambientBlurMultiplier = 6; // 6x blur radius
    
    // Single set of glow values - no instant switching! Fades smoothly with glowFactor
    // Old 4-layer configuration (commented out):
    // 0 0 ${66 * blurFactor * ambientBlurMultiplier}px ${11 * blurFactor * ambientBlurMultiplier}px rgba(255, 100, 0, ${Math.min(1, 0.135 * glowFactor * staticGlowMultiplier)}),
    // 0 0 ${88 * blurFactor * ambientBlurMultiplier}px ${17 * blurFactor * ambientBlurMultiplier}px rgba(255, 120, 20, ${Math.min(1, 0.108 * glowFactor * staticGlowMultiplier)}),
    // 0 0 ${110 * blurFactor * ambientBlurMultiplier}px ${22 * blurFactor * ambientBlurMultiplier}px rgba(200, 80, 0, ${Math.min(1, 0.09 * glowFactor * staticGlowMultiplier)}),
    // 0 0 ${44 * blurFactor * ambientBlurMultiplier}px ${6 * blurFactor * ambientBlurMultiplier}px rgba(255, 140, 40, ${Math.min(1, 0.072 * glowFactor * staticGlowMultiplier)})
    
    // Single smooth ambient glow (no banding possible!)
    const staticGlow = `
        0 0 ${80 * blurFactor * ambientBlurMultiplier}px ${15 * blurFactor * ambientBlurMultiplier}px rgba(255, 105, 15, ${Math.min(1, 0.35 * glowFactor * staticGlowMultiplier)})
    `;
    
    // Combine static glow + animated flame glow + panel styling
    const fullShadow = `
        ${staticGlow},
        0 0 ${glowBlur}px ${glowSpread}px rgba(${red}, ${green}, ${blue}, ${glowOpacity}),
        0 0 ${glowBlur * 1.5}px ${glowSpread * 1.5}px rgba(${red}, ${green}, ${blue}, ${glowOpacity * 0.5}),
        0 1px 3px rgba(0, 0, 0, ${0.05 + 0.05 * glowFactor}),
        inset 0 1px 0 rgba(255, 255, 255, ${0.3 + 0.3 * glowFactor})
    `;
    
    // Apply complete shadow directly (bypassing CSS)
    visualizationPanel.style.boxShadow = fullShadow;
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
    
    // 🔥 Update panel glow every frame (sine waves need to run continuously)
    // Note: updatePanelGlow() also handles fadeMultiplier updates
    updatePanelGlow();
    
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

/**
 * Enable error mode - dials flame effect way up
 */
export function setErrorMode(enabled) {
    errorModeActive = enabled;
    if (enabled) {
        fadeMultiplier = 1.0; // Keep at full intensity
        console.log('🔥 Error mode enabled - flame effect dialed way up!');
    }
}

