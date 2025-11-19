/**
 * flame-engine.js
 * CORE SYSTEM - No app dependencies, always works
 * Standalone flame effect for error visualization
 */

import { initOscilloscope, addOscilloscopeData, setErrorMode } from '../oscilloscope-renderer.js';

let isOverheated = false;
let audioContext = null;
let noiseSource = null;
let noiseGain = null;
let analyser = null;
let animationFrameId = null;
let oscilloscopeReady = false;

/**
 * Generate pink noise buffer
 */
function createPinkNoiseBuffer(context) {
    const bufferSize = 4096;
    const buffer = context.createBuffer(1, bufferSize, context.sampleRate);
    const data = buffer.getChannelData(0);
    
    // Voss-McCartney algorithm for pink noise
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    
    for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        data[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        data[i] *= 0.11; // Scale down
        b6 = white * 0.115926;
    }
    
    return buffer;
}

/**
 * Drive oscilloscope with pink noise (flame effect)
 */
function feedFlameEffect() {
    if (!isOverheated || !analyser) {
        return;
    }
    
    const dataArray = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(dataArray);
    
    // Feed oscilloscope directly (core import)
    if (oscilloscopeReady) {
        try {
            // Send chunks of pink noise samples
            for (let i = 0; i < dataArray.length; i += 128) {
                const chunk = dataArray.slice(i, i + 128);
                addOscilloscopeData(chunk);
            }
        } catch (e) {
            // Oscilloscope not available, continue anyway
            console.warn('⚠️ Failed to feed oscilloscope:', e);
        }
    }
    
    animationFrameId = requestAnimationFrame(feedFlameEffect);
}

/**
 * Enter overheat mode - crank up the flames
 */
export async function enterOverheatMode() {
    if (isOverheated) {
        console.log('🔥 Already in overheat mode');
        return;
    }
    
    console.log('🔥 ENTERING OVERHEAT MODE');
    isOverheated = true;
    
    try {
        // Warm up background
        document.body.style.transition = 'background 1s ease-in-out';
        document.body.style.background = 'linear-gradient(135deg, #3f0a0a 0%, #4d1a1a 50%, #5a2a2a 100%)';
        
        // Initialize audio context for pink noise
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 44100,
                latencyHint: 'playback'
            });
            console.log('🎵 Created audio context for flame engine');
        }
        
        // Resume if suspended
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
        
        // Create pink noise source
        const buffer = createPinkNoiseBuffer(audioContext);
        noiseSource = audioContext.createBufferSource();
        noiseSource.buffer = buffer;
        noiseSource.loop = true;
        
        // Create gain node - AMPED for strong visual effect
        noiseGain = audioContext.createGain();
        noiseGain.gain.value = 5.0; // Cranked up for intense flames
        
        // Create analyser
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        
        // Connect: noise -> gain -> analyser (NO output, silent)
        noiseSource.connect(noiseGain);
        noiseGain.connect(analyser);
        // Note: NOT connected to destination - visual only!
        
        // Start pink noise
        noiseSource.start(0);
        
        // Enable error mode in oscilloscope (direct import)
        if (oscilloscopeReady) {
            try {
                setErrorMode(true);
            } catch (e) {
                console.warn('⚠️ Failed to enable error mode:', e);
            }
        }
        
        // Start feeding flame effect
        feedFlameEffect();
        
        console.log('🔥 Flame engine active' + (oscilloscopeReady ? ' with oscilloscope' : ' (no oscilloscope yet)'));
    } catch (error) {
        console.error('❌ Failed to start flame engine:', error);
        // Continue anyway - at least background is warm
    }
}

/**
 * Exit overheat mode
 */
export function exitOverheatMode() {
    if (!isOverheated) return;
    
    console.log('🔥 Exiting overheat mode');
    isOverheated = false;
    
    // Stop animation
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    
    // Stop audio
    if (noiseSource) {
        try {
            noiseSource.stop();
        } catch (e) {
            // Already stopped
        }
        noiseSource = null;
    }
    
    // Disconnect nodes
    if (noiseGain) {
        try {
            noiseGain.disconnect();
        } catch (e) {
            // Already disconnected
        }
        noiseGain = null;
    }
    
    if (analyser) {
        analyser = null;
    }
    
    // Disable error mode in oscilloscope (direct import)
    if (oscilloscopeReady) {
        try {
            setErrorMode(false);
        } catch (e) {
            // Ignore
        }
    }
    
    // Reset background
    document.body.style.background = '';
}

/**
 * Initialize oscilloscope (tries immediately, can retry later)
 */
function tryInitOscilloscope() {
    if (oscilloscopeReady) return true;
    
    try {
        const success = initOscilloscope();
        if (success) {
            oscilloscopeReady = true;
            console.log('🎨 Oscilloscope connected to flame engine (CORE)');
            return true;
        }
    } catch (e) {
        console.warn('⚠️ Failed to init oscilloscope (will retry):', e);
    }
    return false;
}

/**
 * Initialize flame engine (called early)
 */
export function initFlameEngine() {
    console.log('🔥 Flame engine initialized (ready for overheat)');
    
    // Try to initialize oscilloscope immediately
    tryInitOscilloscope();
    
    // If not ready, retry when DOM is loaded
    if (!oscilloscopeReady) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', tryInitOscilloscope);
        } else {
            // DOM already loaded, retry once
            setTimeout(tryInitOscilloscope, 100);
        }
    }
    
    return {
        enterOverheatMode,
        exitOverheatMode,
        retryInitOscilloscope: tryInitOscilloscope
    };
}

