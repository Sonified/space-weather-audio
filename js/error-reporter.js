/**
 * error-reporter.js
 * Detects critical errors and allows users to report them
 */

import { getParticipantId } from './qualtrics-api.js';

// Store console logs for error reporting
const consoleLogs = [];
const MAX_LOG_ENTRIES = 500; // Limit to prevent memory issues

// Track if error has been reported to prevent duplicate submissions
let errorReported = false;

// Pink noise generator for flame effect
let pinkNoiseNode = null;
let pinkNoiseSource = null;
let errorFlameActive = false;

/**
 * Capture console logs
 */
function captureConsoleLogs() {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalInfo = console.info;

    function addLog(level, args) {
        if (consoleLogs.length >= MAX_LOG_ENTRIES) {
            consoleLogs.shift(); // Remove oldest entry
        }
        consoleLogs.push({
            timestamp: new Date().toISOString(),
            level: level,
            message: args.map(arg => {
                if (typeof arg === 'object') {
                    try {
                        return JSON.stringify(arg);
                    } catch (e) {
                        return String(arg);
                    }
                }
                return String(arg);
            }).join(' ')
        });
    }

    console.log = function(...args) {
        originalLog.apply(console, args);
        addLog('log', args);
    };

    console.error = function(...args) {
        originalError.apply(console, args);
        addLog('error', args);
    };

    console.warn = function(...args) {
        originalWarn.apply(console, args);
        addLog('warn', args);
    };

    console.info = function(...args) {
        originalInfo.apply(console, args);
        addLog('info', args);
    };
}

/**
 * Check if error is critical (not just a warning)
 * Critical errors are:
 * - Uncaught exceptions
 * - Unhandled promise rejections
 * - Errors that mention "TypeError", "ReferenceError", "SyntaxError"
 * - Errors that halt execution
 */
function isCriticalError(error, source, lineno, colno) {
    // Filter out common non-critical errors
    const nonCriticalPatterns = [
        /favicon\.ico/,
        /net::ERR_/,
        /Failed to load resource/,
        /404/,
        /CORS/,
        /NetworkError/,
        /ResizeObserver loop limit exceeded/,
        /Non-Error promise rejection/
    ];

    const errorString = String(error);
    for (const pattern of nonCriticalPatterns) {
        if (pattern.test(errorString)) {
            return false;
        }
    }

    // Critical errors are typically:
    // - TypeError, ReferenceError, SyntaxError, RangeError
    // - Uncaught exceptions
    // - Errors from our own code (not external resources)
    const criticalPatterns = [
        /TypeError/,
        /ReferenceError/,
        /SyntaxError/,
        /RangeError/,
        /is not a function/,
        /Cannot read propert/,
        /Cannot set propert/,
        /is undefined/,
        /is null/
    ];

    for (const pattern of criticalPatterns) {
        if (pattern.test(errorString)) {
            return true;
        }
    }

    // If error is from our own domain/code, it's likely critical
    if (source && (source.includes('volcano') || source.includes('now.audio') || source.includes('localhost'))) {
        return true;
    }

    return false;
}

/**
 * Generate pink noise using Web Audio API
 * Pink noise has equal energy per octave (1/f noise)
 */
function createPinkNoiseNode(audioContext) {
    const bufferSize = 4096;
    const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    
    // Generate pink noise using Voss-McCartney algorithm
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
    
    const pinkNoise = audioContext.createBufferSource();
    pinkNoise.buffer = buffer;
    pinkNoise.loop = true;
    
    return pinkNoise;
}

/**
 * Start pink noise-driven flame effect
 */
async function startErrorFlameEffect() {
    if (errorFlameActive) return;
    
    try {
        // Get or create audio context
        const State = await import('./audio-state.js');
        let audioContext = State.audioContext;
        
        // Create audio context if it doesn't exist
        if (!audioContext) {
            audioContext = new AudioContext({ 
                latencyHint: 'playback'
            });
            State.setAudioContext(audioContext);
            console.log(`🎵 Created audio context for flame effect (sampleRate: ${audioContext.sampleRate} Hz)`);
        }
        
        // Resume audio context if suspended (required for Web Audio API)
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
        
        // Create pink noise source
        pinkNoiseSource = createPinkNoiseNode(audioContext);
        
        // Create gain node - AMP IT UP for strong visual effect!
        pinkNoiseNode = audioContext.createGain();
        pinkNoiseNode.gain.value = 5.0; // AMPED UP for strong flame effect signal
        
        // Create analyser to feed oscilloscope
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        
        // Connect: pink noise -> gain (amped) -> analyser
        // DO NOT connect analyser to destination - visual only, no audio!
        pinkNoiseSource.connect(pinkNoiseNode);
        pinkNoiseNode.connect(analyser);
        // Note: analyser is NOT connected to destination - silent to user but strong signal for visuals!
        
        // Start pink noise
        pinkNoiseSource.start(0);
        
        // Enable error mode in oscilloscope renderer (dials flame way up)
        const { setErrorMode } = await import('./oscilloscope-renderer.js');
        setErrorMode(true);
        
        // Feed pink noise data to oscilloscope renderer
        const bufferSize = analyser.fftSize;
        const buffer = new Float32Array(bufferSize);
        
        function feedPinkNoiseToFlame() {
            if (!errorFlameActive || !analyser) return;
            
            analyser.getFloatTimeDomainData(buffer);
            
            // Send to oscilloscope renderer (drives flame effect)
            import('./oscilloscope-renderer.js').then(({ addOscilloscopeData }) => {
                // Send chunks of pink noise samples
                const chunkSize = 128;
                for (let i = 0; i < buffer.length; i += chunkSize) {
                    const chunk = buffer.slice(i, i + chunkSize);
                    addOscilloscopeData(chunk);
                }
            });
            
            requestAnimationFrame(feedPinkNoiseToFlame);
        }
        
        errorFlameActive = true;
        feedPinkNoiseToFlame();
        
        console.log('🔥 Error flame effect started (pink noise driven)');
    } catch (error) {
        console.error('❌ Failed to start error flame effect:', error);
    }
}

/**
 * Stop pink noise-driven flame effect
 */
async function stopErrorFlameEffect() {
    if (!errorFlameActive) return;
    
    errorFlameActive = false;
    
    // Disable error mode in oscilloscope renderer
    const { setErrorMode } = await import('./oscilloscope-renderer.js');
    setErrorMode(false);
    
    if (pinkNoiseSource) {
        try {
            pinkNoiseSource.stop();
        } catch (e) {
            // Already stopped
        }
        pinkNoiseSource = null;
    }
    
    if (pinkNoiseNode) {
        try {
            pinkNoiseNode.disconnect();
        } catch (e) {
            // Already disconnected
        }
        pinkNoiseNode = null;
    }
    
    console.log('🔥 Error flame effect stopped');
}

/**
 * Warm up the body background
 */
function warmUpBackground() {
    // Page background stays fixed for contrast hierarchy - don't change it
    // document.body.style.transition = 'background 1s ease-in-out';
    // document.body.style.background = 'linear-gradient(135deg, #3f0a0a 0%, #4d1a1a 50%, #5a2a2a 100%)';
}

/**
 * Show error reporting UI in status bar and auto-submit
 */
function showErrorReportingUI(errorMessage, errorDetails) {
    if (errorReported) {
        return; // Already reported
    }

    const statusEl = document.getElementById('status');
    if (!statusEl) {
        return; // Status element not found
    }

    // Show message in status bar
    statusEl.textContent = 'The interface has overheated. Our team is working on it, thank you for your patience!';
    statusEl.className = 'status error';
    statusEl.style.cursor = 'default';
    
    // Warm up background
    warmUpBackground();
    
    // Start pink noise-driven flame effect (dialed way up)
    startErrorFlameEffect();
    
    // Auto-submit error report (no click required)
    submitErrorReport(errorMessage, errorDetails);
}

/**
 * Submit error report to Railway backend
 */
async function submitErrorReport(errorMessage, errorDetails) {
    if (errorReported) {
        return; // Already reported
    }

    errorReported = true;

    const participantId = getParticipantId() || 'unknown';
    const timestamp = new Date().toISOString();

    const errorReport = {
        participantId: participantId,
        timestamp: timestamp,
        errorMessage: errorMessage,
        errorDetails: errorDetails,
        consoleLogs: consoleLogs.slice(-100), // Last 100 log entries
        userAgent: navigator.userAgent,
        url: window.location.href,
        viewport: {
            width: window.innerWidth,
            height: window.innerHeight
        }
    };

    try {
        const response = await fetch('https://volcano-audio-collector-production.up.railway.app/api/report-error', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(errorReport)
        });

        if (response.ok) {
            console.log('✅ Error report submitted successfully');
            // Message stays as the error message - no need to change it
        } else {
            console.error('❌ Failed to submit error report:', response.statusText);
            errorReported = false; // Allow retry
        }
    } catch (error) {
        console.error('❌ Error submitting error report:', error);
        errorReported = false; // Allow retry
    }
}

/**
 * Initialize error reporting system
 */
export function initErrorReporter() {
    // Start capturing console logs
    captureConsoleLogs();

    // Handle uncaught errors
    window.onerror = (message, source, lineno, colno, error) => {
        const errorMessage = String(message);
        const errorDetails = {
            source: source,
            lineno: lineno,
            colno: colno,
            stack: error?.stack || 'No stack trace available',
            name: error?.name || 'Error'
        };

        if (isCriticalError(message, source, lineno, colno)) {
            console.error('🔥 CRITICAL ERROR DETECTED:', errorMessage, errorDetails);
            showErrorReportingUI(errorMessage, errorDetails);
        }

        // Return false to allow default error handling
        return false;
    };

    // Handle unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
        const error = event.reason;
        const errorMessage = error?.message || String(error) || 'Unhandled Promise Rejection';
        const errorDetails = {
            type: 'unhandledrejection',
            stack: error?.stack || 'No stack trace available',
            name: error?.name || 'PromiseRejection'
        };

        if (isCriticalError(error, null, null, null)) {
            console.error('🔥 CRITICAL PROMISE REJECTION:', errorMessage, errorDetails);
            showErrorReportingUI(errorMessage, errorDetails);
        }
    });

    console.log('✅ Error reporter initialized');
}

