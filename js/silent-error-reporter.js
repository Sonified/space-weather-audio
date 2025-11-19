/**
 * silent-error-reporter.js
 * Quietly reports non-critical errors (like metadata mismatches) in the background
 * Does NOT show UI to users - just logs and submits to backend
 */

import { getParticipantId } from './qualtrics-api.js';

// Track reported errors to prevent spam (max 1 of each type per session)
const reportedErrors = new Set();

// Store recent console logs for context
const consoleLogs = [];
const MAX_LOG_ENTRIES = 200;

/**
 * Capture console logs for context
 */
function captureConsoleLogs() {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    function addLog(level, args) {
        if (consoleLogs.length >= MAX_LOG_ENTRIES) {
            consoleLogs.shift(); // Remove oldest
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
 * Report a metadata mismatch silently in the background
 * @param {string} errorType - Type of mismatch (e.g., 'session_id_mismatch', 'missing_responses')
 * @param {Object} details - Detailed information about the mismatch
 */
export async function reportMetadataMismatch(errorType, details) {
    // Check if we've already reported this type of error in this session
    if (reportedErrors.has(errorType)) {
        console.log(`🔕 Silent report skipped: ${errorType} (already reported this session)`);
        return;
    }

    try {
        const participantId = getParticipantId() || 'unknown';
        const timestamp = new Date().toISOString();

        // Build error report
        const errorReport = {
            participantId: participantId,
            timestamp: timestamp,
            errorType: errorType, // New field for categorizing metadata errors
            errorMessage: `Metadata Mismatch: ${errorType}`,
            errorDetails: {
                type: 'metadata_mismatch',
                category: errorType,
                details: details,
                handled: true, // Flag that this was caught and handled
                severity: 'warning' // Not critical, app continued
            },
            consoleLogs: consoleLogs.slice(-50), // Last 50 logs for context
            userAgent: navigator.userAgent,
            url: window.location.href,
            viewport: {
                width: window.innerWidth,
                height: window.innerHeight
            },
            source: 'silent-error-reporter',
            sessionInfo: {
                mode: localStorage.getItem('selectedMode'),
                volcano: localStorage.getItem('selectedVolcano')
            }
        };

        console.log(`🔕 Silent error report: ${errorType}`, details);

        // Submit to backend (silent - don't block on failure)
        const response = await fetch('https://volcano-audio-collector-production.up.railway.app/api/report-error', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(errorReport)
        });

        if (response.ok) {
            const result = await response.json();
            console.log(`✅ Silent report submitted: ${errorType} (report #${result.reportNumber || '?'})`);
            
            // Mark as reported to prevent duplicates
            reportedErrors.add(errorType);
        } else {
            console.warn(`⚠️ Silent report failed (status ${response.status}): ${errorType}`);
        }
    } catch (error) {
        // Fail silently - don't interrupt user experience
        console.warn(`⚠️ Silent error reporter failed:`, error);
    }
}

/**
 * Report a specific session ID mismatch
 * @param {string} storedSessionId - Session ID in stored responses
 * @param {string} currentSessionId - Current session state ID
 * @param {Object} additionalContext - Any additional context
 */
export async function reportSessionIdMismatch(storedSessionId, currentSessionId, additionalContext = {}) {
    await reportMetadataMismatch('session_id_mismatch', {
        storedSessionId,
        currentSessionId,
        mismatch: storedSessionId !== currentSessionId,
        ...additionalContext
    });
}

/**
 * Report missing or corrupted responses
 * @param {string} participantId - Participant ID
 * @param {Object} expectedStructure - What was expected
 * @param {Object} actualStructure - What was found
 */
export async function reportCorruptedResponses(participantId, expectedStructure, actualStructure) {
    await reportMetadataMismatch('corrupted_responses', {
        participantId,
        expectedStructure,
        actualStructure,
        description: 'Responses data structure does not match expected format'
    });
}

/**
 * Report localStorage parse error
 * @param {string} key - localStorage key that failed to parse
 * @param {string} rawValue - Raw value that couldn't be parsed
 * @param {Error} error - Parse error
 */
export async function reportLocalStorageParseError(key, rawValue, error) {
    await reportMetadataMismatch('localstorage_parse_error', {
        key,
        valueLength: rawValue?.length || 0,
        valuePreview: rawValue?.substring(0, 100) || '',
        errorMessage: error.message,
        errorStack: error.stack
    });
}

/**
 * Report a survey response mismatch
 * @param {string} surveyType - Type of survey (pre/post/awesf)
 * @param {Object} expected - Expected data structure
 * @param {Object} actual - Actual data found
 */
export async function reportSurveyResponseMismatch(surveyType, expected, actual) {
    await reportMetadataMismatch('survey_response_mismatch', {
        surveyType,
        expected,
        actual,
        hasPre: !!actual?.pre,
        hasPost: !!actual?.post,
        hasAwesf: !!actual?.awesf,
        hasActivityLevel: !!actual?.activityLevel
    });
}

/**
 * Report a session state inconsistency
 * @param {string} issue - Description of the issue
 * @param {Object} sessionState - Current session state
 * @param {Object} responses - Current responses
 */
export async function reportSessionStateInconsistency(issue, sessionState, responses) {
    await reportMetadataMismatch('session_state_inconsistency', {
        issue,
        sessionState: {
            exists: !!sessionState,
            sessionId: sessionState?.sessionId,
            status: sessionState?.status,
            participantId: sessionState?.participantId
        },
        responses: {
            exists: !!responses,
            sessionId: responses?.sessionId,
            hasPre: !!responses?.pre,
            hasPost: !!responses?.post,
            hasAwesf: !!responses?.awesf
        }
    });
}

/**
 * Initialize silent error reporter
 */
export function initSilentErrorReporter() {
    captureConsoleLogs();
    console.log('✅ Silent error reporter initialized (metadata mismatch tracking)');
}

