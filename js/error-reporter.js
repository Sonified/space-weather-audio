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
 * Show error reporting UI in status bar
 */
function showErrorReportingUI(errorMessage, errorDetails) {
    if (errorReported) {
        return; // Already reported
    }

    const statusEl = document.getElementById('status');
    if (!statusEl) {
        return; // Status element not found
    }

    // Store error details for submission
    statusEl._errorMessage = errorMessage;
    statusEl._errorDetails = errorDetails;

    // Show message in status bar with click handler
    statusEl.textContent = 'Interface overheated, click to submit your error.';
    statusEl.className = 'status error';
    statusEl.style.cursor = 'pointer';
    statusEl.style.userSelect = 'none';
    
    // Add click handler
    statusEl.addEventListener('click', handleErrorReportClick, { once: true });
}

/**
 * Handle click on error message in status bar
 */
async function handleErrorReportClick() {
    const statusEl = document.getElementById('status');
    if (!statusEl || !statusEl._errorMessage) {
        return;
    }

    await submitErrorReport(statusEl._errorMessage, statusEl._errorDetails);
}

/**
 * Show success message after error report submission
 */
function showSuccessMessage() {
    const statusEl = document.getElementById('status');
    if (statusEl) {
        statusEl.textContent = 'Thanks! Our team is on it 🌋';
        statusEl.className = 'status success';
        statusEl.style.cursor = 'default';
        
        // Clear error details
        delete statusEl._errorMessage;
        delete statusEl._errorDetails;
    }
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
            showSuccessMessage();
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

