/**
 * Participant Response Manager
 * Tracks survey responses for each session and handles submission to Qualtrics
 * 
 * Features:
 * - Stores responses locally (localStorage) for persistence across page reloads
 * - Tracks session state (in-progress vs completed)
 * - Only submits once at the end when all surveys are complete
 * - Handles navigation away/back gracefully
 */

const STORAGE_KEY_PREFIX = 'participant_response_';
const SESSION_STATE_KEY = 'participant_session_state';

/**
 * Get storage key for a participant
 * @param {string} participantId - The participant ID
 * @returns {string} Storage key
 */
function getStorageKey(participantId) {
    return `${STORAGE_KEY_PREFIX}${participantId}`;
}

/**
 * Get current session state
 * @param {string} participantId - The participant ID
 * @returns {Object|null} Session state object or null if no session exists
 */
export function getSessionState(participantId) {
    if (!participantId) return null;
    
    try {
        const stateJson = localStorage.getItem(SESSION_STATE_KEY);
        if (!stateJson) return null;
        
        const state = JSON.parse(stateJson);
        // Only return state if it matches the current participant
        if (state.participantId === participantId) {
            return state;
        }
        return null;
    } catch (error) {
        console.error('Error reading session state:', error);
        return null;
    }
}

/**
 * Set session state
 * @param {string} participantId - The participant ID
 * @param {Object} state - Session state object
 */
function setSessionState(participantId, state) {
    if (!participantId) return;
    
    try {
        const stateToStore = {
            ...state,
            participantId,
            lastUpdated: new Date().toISOString()
        };
        localStorage.setItem(SESSION_STATE_KEY, JSON.stringify(stateToStore));
    } catch (error) {
        console.error('Error saving session state:', error);
    }
}

/**
 * Get all responses for a participant's current session
 * @param {string} participantId - The participant ID
 * @returns {Object|null} Response object or null if no responses exist
 */
export function getSessionResponses(participantId) {
    if (!participantId) return null;
    
    try {
        const key = getStorageKey(participantId);
        const responsesJson = localStorage.getItem(key);
        if (!responsesJson) {
            console.log(`📋 getSessionResponses: No responses found in localStorage for key: ${key}`);
            return null;
        }
        
        const responses = JSON.parse(responsesJson);
        // Check if this is for the current session
        const sessionState = getSessionState(participantId);
        console.log(`📋 getSessionResponses: Checking session match:`, {
            storedSessionId: responses.sessionId,
            currentSessionId: sessionState?.sessionId,
            matches: sessionState && responses.sessionId === sessionState.sessionId,
            hasPre: !!responses.pre,
            hasPost: !!responses.post,
            hasAwesf: !!responses.awesf
        });
        
        if (sessionState && responses.sessionId === sessionState.sessionId) {
            return responses;
        }
        
        if (responses.sessionId !== sessionState?.sessionId) {
            console.warn(`⚠️ getSessionResponses: Session ID mismatch!`, {
                storedSessionId: responses.sessionId,
                currentSessionId: sessionState?.sessionId,
                storedData: {
                    hasPre: !!responses.pre,
                    hasPost: !!responses.post,
                    hasAwesf: !!responses.awesf
                }
            });
        }
        
        return null;
    } catch (error) {
        console.error('Error reading session responses:', error);
        return null;
    }
}

/**
 * Track when a survey is started (opened)
 * @param {string} participantId - The participant ID
 * @param {string} surveyType - Type of survey ('pre', 'post', 'awesf')
 */
export function trackSurveyStart(participantId, surveyType) {
    if (!participantId) return;
    
    try {
        let sessionState = getSessionState(participantId);
        if (!sessionState) {
            // Create a new session if it doesn't exist
            sessionState = {
                sessionId: `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                status: 'in-progress',
                startedAt: new Date().toISOString(),
                participantId
            };
        }
        
        // Initialize tracking data if it doesn't exist
        if (!sessionState.tracking) {
            sessionState.tracking = {
                sessionStarted: sessionState.startedAt || new Date().toISOString(),
                events: []
            };
        }
        
        // Track survey start
        sessionState.tracking.events.push({
            type: 'survey_started',
            surveyType: surveyType,
            timestamp: new Date().toISOString()
        });
        
        setSessionState(participantId, sessionState);
        console.log(`📊 Tracked ${surveyType} survey start`);
    } catch (error) {
        console.error('Error tracking survey start:', error);
    }
}

/**
 * Track user actions (volcano selection, fetch data, etc.)
 * @param {string} participantId - The participant ID
 * @param {string} actionType - Type of action ('volcano_selected', 'fetch_data', etc.)
 * @param {Object} data - Additional data for the action (e.g., { volcano: 'kilauea' })
 */
export function trackUserAction(participantId, actionType, data = {}) {
    if (!participantId) return;
    
    try {
        let sessionState = getSessionState(participantId);
        if (!sessionState) {
            // Create a new session if it doesn't exist
            sessionState = {
                sessionId: `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                status: 'in-progress',
                startedAt: new Date().toISOString(),
                participantId
            };
        }
        
        // Initialize tracking data if it doesn't exist
        if (!sessionState.tracking) {
            sessionState.tracking = {
                sessionStarted: sessionState.startedAt || new Date().toISOString(),
                events: []
            };
        }
        
        // Track user action
        sessionState.tracking.events.push({
            type: actionType,
            data: data,
            timestamp: new Date().toISOString()
        });
        
        setSessionState(participantId, sessionState);
        console.log(`📊 Tracked ${actionType}:`, data);
    } catch (error) {
        console.error('Error tracking user action:', error);
    }
}

/**
 * Save a survey response for the current session
 * @param {string} participantId - The participant ID
 * @param {string} surveyType - Type of survey ('pre', 'post', 'awesf')
 * @param {Object} surveyData - The survey response data
 */
export function saveSurveyResponse(participantId, surveyType, surveyData) {
    if (!participantId) {
        console.warn('Cannot save survey response: no participant ID');
        return;
    }
    
    try {
        // Get or create session state
        let sessionState = getSessionState(participantId);
        console.log(`💾 saveSurveyResponse called for ${surveyType}:`, {
            existingSessionState: sessionState ? {
                sessionId: sessionState.sessionId,
                status: sessionState.status
            } : null
        });
        
        // Only create a new session if:
        // 1. No session state exists, OR
        // 2. The session was already submitted to Qualtrics (marked as 'submitted')
        // 
        // DO NOT create a new session just because status is 'completed' - 
        // that would wipe out survey data that hasn't been submitted yet!
        if (!sessionState || sessionState.status === 'submitted') {
            // Start a new session
            console.log(`🆕 Creating NEW session (reason: ${!sessionState ? 'no session state' : 'session already submitted to Qualtrics'})`);
            sessionState = {
                sessionId: `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                status: 'in-progress',
                startedAt: new Date().toISOString(),
                participantId
            };
        } else if (sessionState.status === 'completed') {
            // If session is marked as 'completed' but not 'submitted', 
            // this is likely from old logic - reset it to 'in-progress'
            console.warn(`⚠️ Session was marked as 'completed' but not 'submitted' - resetting to 'in-progress'`);
            sessionState.status = 'in-progress';
        }
        
        // Get or create responses object
        let responses = getSessionResponses(participantId);
        console.log(`📋 Current responses before save:`, {
            hasResponses: !!responses,
            existingSessionId: responses?.sessionId,
            currentSessionId: sessionState.sessionId,
            hasPre: !!responses?.pre,
            hasPost: !!responses?.post,
            hasAwesf: !!responses?.awesf
        });
        
        if (!responses || responses.sessionId !== sessionState.sessionId) {
            console.warn(`⚠️ Session ID mismatch or no responses - creating NEW responses object!`, {
                reason: !responses ? 'no responses found' : 'sessionId mismatch',
                oldSessionId: responses?.sessionId,
                newSessionId: sessionState.sessionId
            });
            responses = {
                sessionId: sessionState.sessionId,
                participantId,
                pre: null,
                post: null,
                awesf: null,
                createdAt: new Date().toISOString()
            };
        }
        
        // Initialize tracking data if it doesn't exist
        if (!sessionState.tracking) {
            sessionState.tracking = {
                sessionStarted: sessionState.startedAt || new Date().toISOString(),
                events: []
            };
        }
        
        // Track survey completion
        sessionState.tracking.events.push({
            type: 'survey_completed',
            surveyType: surveyType,
            timestamp: new Date().toISOString()
        });
        
        // Save the survey response
        const previousValue = responses[surveyType];
        responses[surveyType] = {
            ...surveyData,
            submittedAt: new Date().toISOString()
        };
        console.log(`💾 Saving ${surveyType} survey:`, {
            previousValue: previousValue ? 'existed' : 'null',
            newValue: responses[surveyType],
            allSurveysNow: {
                hasPre: !!responses.pre,
                hasPost: !!responses.post,
                hasAwesf: !!responses.awesf
            }
        });
        
        // Update session state
        const hasPre = !!responses.pre;
        const hasPost = !!responses.post;
        const hasAwesf = !!responses.awesf;
        
        // IMPORTANT: Do NOT mark session as 'completed' here!
        // A session should only be marked as 'completed' AFTER successful submission to Qualtrics.
        // Marking it as 'completed' here causes new surveys to create a new session,
        // which wipes out previously saved survey data.
        // 
        // The session remains 'in-progress' until the master Submit button is clicked
        // and the data is successfully submitted to Qualtrics.
        console.log(`📊 Session state after saving ${surveyType}:`, {
            status: sessionState.status,
            hasPre,
            hasPost,
            hasAwesf,
            allComplete: hasPre && hasPost && hasAwesf
        });
        
        // Save to localStorage
        const key = getStorageKey(participantId);
        localStorage.setItem(key, JSON.stringify(responses));
        setSessionState(participantId, sessionState);
        
        console.log(`💾 Saved ${surveyType} survey response for session ${sessionState.sessionId}`);
        console.log(`📊 Session status remains: ${sessionState.status} (not changed - stays in-progress until Qualtrics submission)`);
        
        return { responses, sessionState };
    } catch (error) {
        console.error('Error saving survey response:', error);
        throw error;
    }
}

/**
 * Check if a session is complete and ready for submission
 * @param {string} participantId - The participant ID
 * @returns {boolean} True if session is complete
 */
export function isSessionComplete(participantId) {
    const sessionState = getSessionState(participantId);
    if (!sessionState) return false;
    
    return sessionState.status === 'completed';
}

/**
 * Get all responses ready for submission
 * @param {string} participantId - The participant ID
 * @returns {Object|null} Combined response object ready for Qualtrics submission
 */
export function getResponsesForSubmission(participantId) {
    const responses = getSessionResponses(participantId);
    if (!responses) return null;
    
    // Check if we have all required surveys
    if (!responses.pre || !responses.post || !responses.awesf || !responses.activityLevel) {
        return null;
    }
    
    // Combine all responses into a single object for Qualtrics
    // Qualtrics expects all data in one submission
    return {
        // Pre-survey data
        pre: responses.pre,
        // Post-survey data
        post: responses.post,
        // AWE-SF data
        awesf: responses.awesf,
        // Activity Level data
        activityLevel: responses.activityLevel,
        // Metadata
        sessionId: responses.sessionId,
        participantId: responses.participantId,
        createdAt: responses.createdAt,
        // JSON_data - interface interaction data
        // This will be stored in the JSON_data embedded data field
        // Note: Regions/features are added in ui-controls.js when building jsonDump
        // This function is primarily for internal use; actual submission uses jsonDump from ui-controls.js
        jsonData: {
            timestamp: new Date().toISOString(),
            version: "1.0",
            note: "Regions and features are included in jsonDump during submission"
        }
    };
}

/**
 * Mark session as submitted and store Qualtrics response ID
 * @param {string} participantId - The participant ID
 * @param {string} qualtricsResponseId - The Qualtrics response ID from the API
 */
export function markSessionAsSubmitted(participantId, qualtricsResponseId = null) {
    if (!participantId) return;
    
    try {
        // Clear the session state
        const sessionState = getSessionState(participantId);
        if (sessionState) {
            sessionState.status = 'submitted';
            sessionState.submittedAt = new Date().toISOString();
            if (qualtricsResponseId) {
                sessionState.qualtricsResponseId = qualtricsResponseId;
            }
            setSessionState(participantId, sessionState);
        }
        
        // Store response ID with the responses
        const key = getStorageKey(participantId);
        const responsesJson = localStorage.getItem(key);
        if (responsesJson) {
            const responses = JSON.parse(responsesJson);
            responses.submitted = true;
            responses.submittedAt = new Date().toISOString();
            if (qualtricsResponseId) {
                responses.qualtricsResponseId = qualtricsResponseId;
            }
            localStorage.setItem(key, JSON.stringify(responses));
        }
        
        console.log(`✅ Session ${sessionState?.sessionId} marked as submitted`);
        if (qualtricsResponseId) {
            console.log(`📋 Qualtrics Response ID: ${qualtricsResponseId}`);
        }
    } catch (error) {
        console.error('Error marking session as submitted:', error);
    }
}

/**
 * Get the Qualtrics response ID for a submitted session
 * @param {string} participantId - The participant ID
 * @returns {string|null} - The Qualtrics response ID if available
 */
export function getQualtricsResponseId(participantId) {
    if (!participantId) return null;
    
    try {
        const sessionState = getSessionState(participantId);
        if (sessionState && sessionState.qualtricsResponseId) {
            return sessionState.qualtricsResponseId;
        }
        
        // Also check responses
        const key = getStorageKey(participantId);
        const responsesJson = localStorage.getItem(key);
        if (responsesJson) {
            const responses = JSON.parse(responsesJson);
            if (responses.qualtricsResponseId) {
                return responses.qualtricsResponseId;
            }
        }
        
        return null;
    } catch (error) {
        console.error('Error getting Qualtrics response ID:', error);
        return null;
    }
}

/**
 * Export Qualtrics response metadata to a downloadable JSON file
 * @param {string} participantId - The participant ID
 * @param {string} qualtricsResponseId - The Qualtrics response ID
 * @param {Object} submissionResult - The full submission result from Qualtrics API
 */
export function exportResponseMetadata(participantId, qualtricsResponseId, submissionResult = null) {
    if (!participantId || !qualtricsResponseId) {
        console.warn('Cannot export: missing participantId or qualtricsResponseId');
        return;
    }
    
    try {
        const sessionState = getSessionState(participantId);
        const responses = getSessionResponses(participantId);
        
        const metadata = {
            participantId: participantId,
            qualtricsResponseId: qualtricsResponseId,
            sessionId: sessionState?.sessionId || null,
            submittedAt: sessionState?.submittedAt || new Date().toISOString(),
            submissionTimestamp: new Date().toISOString(),
            surveyData: {
                hasPre: !!responses?.pre,
                hasPost: !!responses?.post,
                hasAwesf: !!responses?.awesf,
                preSubmittedAt: responses?.pre?.submittedAt || null,
                postSubmittedAt: responses?.post?.submittedAt || null,
                awesfSubmittedAt: responses?.awesf?.submittedAt || null
            },
            qualtricsApiResponse: submissionResult || null
        };
        
        // Create filename
        const dateStr = new Date().toISOString().split('T')[0];
        const filename = `qualtrics_response_${qualtricsResponseId}_${dateStr}.json`;
        
        // Create blob and trigger automatic download
        const jsonString = JSON.stringify(metadata, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('📥 QUALTRICS RESPONSE METADATA DOWNLOADED');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`💾 Filename: ${filename}`);
        console.log(`📁 Save to: Qualtrics/${filename}`);
        console.log('═══════════════════════════════════════════════════════════\n');
        
    } catch (error) {
        console.error('Error exporting response metadata:', error);
    }
}

/**
 * Clear session data (for testing or reset)
 * @param {string} participantId - The participant ID
 */
export function clearSession(participantId) {
    if (!participantId) return;
    
    try {
        const key = getStorageKey(participantId);
        localStorage.removeItem(key);
        localStorage.removeItem(SESSION_STATE_KEY);
        console.log(`🗑️ Cleared session data for participant ${participantId}`);
    } catch (error) {
        console.error('Error clearing session:', error);
    }
}

/**
 * Restore survey responses to UI when user returns
 * @param {string} participantId - The participant ID
 */
export function restoreSurveyResponses(participantId) {
    const responses = getSessionResponses(participantId);
    if (!responses) return false;
    
    let restored = false;
    
    // Restore pre-survey responses
    if (responses.pre) {
        restored = restoreSurveyToUI('pre', responses.pre) || restored;
    }
    
    // Restore post-survey responses
    if (responses.post) {
        restored = restoreSurveyToUI('post', responses.post) || restored;
    }
    
    // Restore AWE-SF responses
    if (responses.awesf) {
        restored = restoreSurveyToUI('awesf', responses.awesf) || restored;
    }
    
    if (restored) {
        console.log('📋 Restored survey responses from previous session');
    }
    
    return restored;
}

/**
 * Restore a specific survey's responses to the UI
 * @param {string} surveyType - Type of survey ('pre', 'post', 'awesf')
 * @param {Object} surveyData - The survey response data
 * @returns {boolean} True if any responses were restored
 */
function restoreSurveyToUI(surveyType, surveyData) {
    let restored = false;
    const prefix = surveyType === 'pre' ? 'pre' : surveyType === 'post' ? 'post' : '';
    
    if (surveyType === 'pre' || surveyType === 'post') {
        // Restore PANAS responses
        const fields = ['calm', 'energized', 'connected', 'nervous', 'focused', 'wonder'];
        fields.forEach(field => {
            const value = surveyData[field];
            if (value) {
                const radio = document.querySelector(`input[name="${prefix}${field.charAt(0).toUpperCase() + field.slice(1)}"][value="${value}"]`);
                if (radio) {
                    radio.checked = true;
                    restored = true;
                }
            }
        });
    } else if (surveyType === 'awesf') {
        // Restore AWE-SF responses
        const fields = [
            'slowDown', 'reducedSelf', 'chills', 'oneness', 'grand', 
            'diminishedSelf', 'timeSlowing', 'awesfConnected', 'small', 
            'vastness', 'challenged', 'selfShrink'
        ];
        fields.forEach(field => {
            const value = surveyData[field];
            if (value) {
                const radio = document.querySelector(`input[name="${field}"][value="${value}"]`);
                if (radio) {
                    radio.checked = true;
                    restored = true;
                }
            }
        });
    }
    
    return restored;
}

