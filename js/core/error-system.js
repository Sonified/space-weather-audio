/**
 * error-system.js
 * CORE SYSTEM - No app dependencies, always works
 * Standalone error detection and reporting
 */

const consoleLogs = [];
const MAX_LOG_ENTRIES = 200;
let errorReported = false;
let flameEngine = null;

/**
 * Capture console logs
 */
function captureConsoleLogs() {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    
    function addLog(level, args) {
        if (consoleLogs.length >= MAX_LOG_ENTRIES) {
            consoleLogs.shift();
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
}

/**
 * Check if error is critical
 */
function isCriticalError(error, source) {
    // Check error name directly
    if (error && typeof error === 'object' && error.name) {
        const errorName = String(error.name);
        if (errorName === 'SyntaxError' || 
            errorName === 'TypeError' || 
            errorName === 'ReferenceError' || 
            errorName === 'RangeError' ||
            errorName === 'EvalError') {
            return true;
        }
    }
    
    // Filter out non-critical patterns
    const nonCriticalPatterns = [
        /favicon\.ico/,
        /net::ERR_/,
        /Failed to load resource/,
        /404/,
        /ResizeObserver/
    ];
    
    const errorString = String(error);
    for (const pattern of nonCriticalPatterns) {
        if (pattern.test(errorString)) {
            return false;
        }
    }
    
    // Critical error patterns
    const criticalPatterns = [
        /SyntaxError/,
        /TypeError/,
        /ReferenceError/,
        /RangeError/,
        /is not a function/,
        /Cannot read propert/,
        /has already been declared/,
        /Unexpected token/,
        /Unexpected identifier/
    ];
    
    for (const pattern of criticalPatterns) {
        if (pattern.test(errorString)) {
            return true;
        }
    }
    
    // If from our domain, likely critical
    if (source && (source.includes('volcano') || source.includes('now.audio') || source.includes('localhost'))) {
        return true;
    }
    
    return false;
}

/**
 * Show error UI and trigger overheat mode
 */
async function handleCriticalError(errorMessage, errorDetails) {
    if (errorReported) {
        return; // Already handled
    }
    
    console.error('🔥 CRITICAL ERROR DETECTED (Core):', errorMessage);
    
    // Update status message
    const statusEl = document.getElementById('status');
    if (statusEl) {
        statusEl.textContent = 'The interface has overheated. Our team is working on it, thank you for your patience!';
        statusEl.className = 'status error';
        statusEl.style.cursor = 'default';
    }
    
    // Trigger flame effect
    if (flameEngine && flameEngine.enterOverheatMode) {
        await flameEngine.enterOverheatMode();
    }
    
    // Disable UI buttons (fail gracefully if they don't exist)
    try {
        const startBtn = document.getElementById('startBtn');
        if (startBtn) startBtn.disabled = true;
        
        const playPauseBtn = document.getElementById('playPauseBtn');
        if (playPauseBtn) playPauseBtn.disabled = true;
        
        const downloadBtn = document.getElementById('downloadBtn');
        if (downloadBtn) downloadBtn.disabled = true;
        
        const completeBtn = document.getElementById('completeBtn');
        if (completeBtn) completeBtn.disabled = true;
    } catch (e) {
        // Buttons might not exist yet
    }
    
    // Submit error report
    await submitErrorReport(errorMessage, errorDetails);
}

/**
 * Submit error report to backend (Cloudflare Worker → R2)
 */
async function submitErrorReport(errorMessage, errorDetails) {
    if (errorReported) return;
    errorReported = true;

    // Gather study context (fail gracefully on each)
    let participantId = 'unknown';
    let studyStep = null;
    let condition = null;
    let studySlug = null;
    try {
        participantId = localStorage.getItem('emic_participant_id') || localStorage.getItem('participantId') || 'unknown';
        studyStep = localStorage.getItem('study_flow_step');
        // Find condition key (study_condition_{slug})
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('study_condition_')) {
                studySlug = key.replace('study_condition_', '');
                try { condition = JSON.parse(localStorage.getItem(key)); } catch (e) { /* skip */ }
                break;
            }
        }
    } catch (e) {
        // localStorage not available
    }

    const errorReport = {
        participantId,
        studyStep: studyStep !== null ? parseInt(studyStep, 10) : null,
        studySlug,
        condition,
        timestamp: new Date().toISOString(),
        errorMessage,
        errorDetails,
        consoleLogs: consoleLogs.slice(-100),
        userAgent: navigator.userAgent,
        url: window.location.href,
        viewport: {
            width: window.innerWidth,
            height: window.innerHeight
        },
        source: 'core-error-system'
    };

    const apiBase = window.location.hostname === 'spaceweather.now.audio'
        ? window.location.origin
        : 'https://spaceweather.now.audio';

    try {
        const response = await fetch(`${apiBase}/api/emic/errors`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(errorReport)
        });

        if (response.ok) {
            console.log('✅ Error report submitted to R2');
        } else {
            console.error('❌ Failed to submit error report:', response.statusText);
            errorReported = false; // Allow retry
        }
    } catch (error) {
        console.error('❌ Error submitting report:', error);
        errorReported = false; // Allow retry
    }
}

/**
 * Initialize error system (called early)
 */
export function initErrorSystem(flameEngineRef) {
    flameEngine = flameEngineRef;
    
    // Start capturing console
    captureConsoleLogs();
    
    // Handle uncaught errors
    window.onerror = (message, source, lineno, colno, error) => {
        const errorMessage = String(message);
        const errorDetails = {
            source: source,
            lineno: lineno,
            colno: colno,
            stack: error?.stack || 'No stack trace',
            name: error?.name || 'Error',
            type: 'window.onerror'
        };
        
        // 🔥 ALWAYS log the error to console so we can see what's happening
        console.error('🚨 CRITICAL ERROR CAUGHT:', errorMessage);
        console.error('📍 Location:', `${source}:${lineno}:${colno}`);
        console.error('📚 Stack:', error?.stack || 'No stack trace');
        console.error('📦 Full error object:', error);
        console.error('🔍 Error details:', errorDetails);
        
        const errorToCheck = error || message;
        if (isCriticalError(errorToCheck, source)) {
            handleCriticalError(errorMessage, errorDetails);
        }
        
        return false; // Allow default error handling
    };
    
    // Handle unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
        const error = event.reason;
        const errorMessage = error?.message || String(error) || 'Unhandled Promise Rejection';
        const errorDetails = {
            type: 'unhandledrejection',
            stack: error?.stack || 'No stack trace',
            name: error?.name || 'PromiseRejection'
        };
        
        // 🔥 ALWAYS log the error to console so we can see what's happening
        console.error('🚨 UNHANDLED PROMISE REJECTION:', errorMessage);
        console.error('📚 Stack:', error?.stack || 'No stack trace');
        console.error('📦 Full error object:', error);
        console.error('🔍 Error details:', errorDetails);
        
        if (isCriticalError(error, null)) {
            handleCriticalError(errorMessage, errorDetails);
        }
    });
    
    if (window.pm?.init) console.log('✅ Core error system initialized');

    // Expose globally for app layer to use
    window.coreErrorSystem = {
        reportError: handleCriticalError
    };
    
    return {
        reportError: handleCriticalError
    };
}

