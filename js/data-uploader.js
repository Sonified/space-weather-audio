/**
 * Data Uploader
 * Uploads user's localStorage data to R2 via backend API
 * Structure: volcano-audio-anonymized-data/participants/{participantId}/
 *   - user-status/status.json (overwritten each time)
 *   - submissions/{participantId}_Complete_{timestamp}.json (append-only)
 */

import { STORAGE_KEYS } from './study-workflow.js';

// Backend endpoint (production)
const UPLOAD_ENDPOINT = 'https://volcano-audio-collector-production.up.railway.app/api/upload-user-data';

/**
 * Gather all localStorage data for upload
 * @param {string} participantId - The participant ID
 * @returns {Object} - Data package ready for upload
 */
function gatherUserData(participantId) {
    try {
        // Helper to safely parse JSON from localStorage
        const safeGet = (key, defaultValue = null) => {
            try {
                const value = localStorage.getItem(key);
                return value ? JSON.parse(value) : defaultValue;
            } catch {
                return localStorage.getItem(key) || defaultValue;
            }
        };
        
        // 🎯 THE 9 CORE WORKFLOW FLAGS (from UX doc)
        // Study progress flags (ONBOARDING)
        const hasSeenParticipantSetup = localStorage.getItem(STORAGE_KEYS.HAS_SEEN_PARTICIPANT_SETUP) === 'true';
        const hasSeenWelcome = localStorage.getItem(STORAGE_KEYS.HAS_SEEN_WELCOME) === 'true';
        const tutorialInProgress = localStorage.getItem(STORAGE_KEYS.TUTORIAL_IN_PROGRESS) === 'true';
        const tutorialCompleted = localStorage.getItem(STORAGE_KEYS.TUTORIAL_COMPLETED) === 'true';

        // Current session flags
        const hasSeenWelcomeBack = localStorage.getItem(STORAGE_KEYS.HAS_SEEN_WELCOME_BACK) === 'true';
        const preSurveyCompletionDate = localStorage.getItem(STORAGE_KEYS.PRE_SURVEY_COMPLETION_DATE);
        const beginAnalysisClickedThisSession = localStorage.getItem(STORAGE_KEYS.BEGIN_ANALYSIS_CLICKED_THIS_SESSION) === 'true';

        // Session timeout flag
        const sessionTimedOut = localStorage.getItem(STORAGE_KEYS.SESSION_TIMED_OUT) === 'true';

        // Session tracking
        const weeklySessionCount = parseInt(localStorage.getItem(STORAGE_KEYS.WEEKLY_SESSION_COUNT) || '0', 10);
        const weekStartDate = localStorage.getItem(STORAGE_KEYS.WEEK_START_DATE);
        const sessionCompletionTracker = localStorage.getItem(STORAGE_KEYS.SESSION_COMPLETION_TRACKER);

        const totalSessionsStarted = parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_SESSIONS_STARTED) || '0', 10);
        const totalSessionsCompleted = parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_SESSIONS_COMPLETED) || '0', 10);
        const totalSessionTime = parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_SESSION_TIME) || '0', 10);
        const totalSessionTimeHours = parseFloat((totalSessionTime / (1000 * 60 * 60)).toFixed(2));

        // Session history
        const sessionHistory = safeGet(STORAGE_KEYS.SESSION_HISTORY, []);

        // Current session (if any)
        const currentSessionStart = localStorage.getItem(STORAGE_KEYS.CURRENT_SESSION_START);
        
        // Preferences
        const selectedVolcano = localStorage.getItem('selectedVolcano');
        const selectedMode = localStorage.getItem('selectedMode');
        
        // Response data (all survey responses)
        const responseKey = `participant_response_${participantId}`;
        const responses = safeGet(responseKey, null);
        
        return {
            participantId,
            timestamp: new Date().toISOString(),
            
            // 🎯 THE 9 CORE WORKFLOW FLAGS
            // Study progress flags (ONBOARDING)
            hasSeenParticipantSetup,
            hasSeenWelcome,
            tutorialInProgress,
            tutorialCompleted,
            
            // Current session flags
            hasSeenWelcomeBack,
            preSurveyCompletionDate,
            beginAnalysisClickedThisSession,
            
            // Session timeout flag
            sessionTimedOut,
            
            // Session tracking
            weeklySessionCount,
            weekStartDate,
            sessionCompletionTracker,
            totalSessionsStarted,
            totalSessionsCompleted,
            totalSessionTime,
            totalSessionTimeHours,
            
            // Session history and current session
            sessionHistory,
            currentSessionStart,
            
            // Preferences
            selectedVolcano,
            selectedMode,
            
            // Full response data (if exists)
            responses
        };
    } catch (error) {
        console.error('❌ Error gathering user data:', error);
        return null;
    }
}

/**
 * Upload user status to R2 (user-status/status.json - overwritten)
 * Call this periodically or when key flags change
 * @param {string} participantId - The participant ID
 * @returns {Promise<Object>} - Upload result
 */
export async function uploadUserStatus(participantId) {
    if (!participantId) {
        console.warn('⚠️ Cannot upload status: missing participantId');
        return { status: 'skipped', reason: 'no_participant_id' };
    }
    
    try {
        const userData = gatherUserData(participantId);
        if (!userData) {
            return { status: 'failed', reason: 'data_gathering_failed' };
        }
        
        // Send to backend
        const response = await fetch(UPLOAD_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...userData,
                uploadType: 'status'
            })
        });
        
        const result = await response.json();
        
        if (response.ok) {
            console.log('✅ User status uploaded to R2:', result);
            return { status: 'success', ...result };
        } else {
            console.error('❌ Failed to upload user status:', result);
            return { status: 'failed', error: result.error };
        }
    } catch (error) {
        console.error('❌ Error uploading user status:', error);
        return { status: 'failed', error: error.message };
    }
}

/**
 * Upload submission data to R2 (submissions/{id}_Complete_{timestamp}.json - append-only)
 * Call this after successful Qualtrics submission or session timeout
 * @param {string} participantId - The participant ID
 * @param {Object} submissionData - The data to submit (jsonDump from Qualtrics submission)
 * @returns {Promise<Object>} - Upload result
 */
export async function uploadSubmissionData(participantId, submissionData) {
    if (!participantId) {
        console.warn('⚠️ Cannot upload submission: missing participantId');
        return { status: 'skipped', reason: 'no_participant_id' };
    }
    
    if (!submissionData) {
        console.warn('⚠️ Cannot upload submission: missing submissionData');
        return { status: 'skipped', reason: 'no_submission_data' };
    }
    
    try {
        const userData = gatherUserData(participantId);
        if (!userData) {
            return { status: 'failed', reason: 'data_gathering_failed' };
        }
        
        // Send to backend
        const response = await fetch(UPLOAD_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...userData,
                uploadType: 'submission',
                submissionData: submissionData
            })
        });
        
        const result = await response.json();
        
        if (response.ok) {
            console.log('✅ Submission data uploaded to R2:', result);
            return { status: 'success', ...result };
        } else {
            console.error('❌ Failed to upload submission data:', result);
            return { status: 'failed', error: result.error };
        }
    } catch (error) {
        console.error('❌ Error uploading submission data:', error);
        return { status: 'failed', error: error.message };
    }
}

/**
 * Upload both status and submission data in one call
 * @param {string} participantId - The participant ID
 * @param {Object} submissionData - The submission data (jsonDump)
 * @returns {Promise<Object>} - Upload result
 */
export async function uploadUserDataComplete(participantId, submissionData) {
    return await uploadSubmissionData(participantId, submissionData);
    // Note: uploadSubmissionData already includes status update
}

/**
 * Upload submission data to the EMIC R2 endpoint (emic-data bucket).
 * Endpoint: POST /api/emic/participants/{id}/submit
 * Used by both real study submissions (ui-controls.js) and simulate flow.
 * @param {string} participantId - The participant ID
 * @param {Object} submissionData - The submission payload
 * @returns {Promise<Object>} - Upload result
 */
export async function uploadEmicSubmission(participantId, submissionData) {
    if (!participantId) {
        console.warn('⚠️ EMIC upload: missing participantId');
        return { status: 'skipped', reason: 'no_participant_id' };
    }

    // Use current origin on production, otherwise hit production API directly (Worker handles CORS)
    const apiBase = window.location.hostname === 'spaceweather.now.audio'
        ? window.location.origin
        : 'https://spaceweather.now.audio';
    const endpoint = `${apiBase}/api/emic/participants/${encodeURIComponent(participantId)}/submit`;

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...submissionData,
                isSimulation: submissionData.isSimulation ?? false,
            }),
        });

        const result = await response.json();

        if (response.ok) {
            console.log('✅ EMIC submission uploaded to R2:', result);
            return { status: 'success', ...result };
        } else {
            console.error('❌ EMIC upload failed:', result);
            return { status: 'failed', error: result.error };
        }
    } catch (error) {
        console.error('❌ EMIC upload error (server may be unreachable):', error);
        return { status: 'failed', error: error.message };
    }
}

/**
 * Progressive sync: upload a snapshot of current participant state at each milestone.
 * Fire-and-forget — never blocks the participant's flow.
 * Each call creates a new timestamped file on the server, so the full timeline is preserved.
 * @param {string} participantId
 * @param {string} milestone - e.g. 'registered', 'welcome_closed', 'analysis_complete', 'questionnaire_background'
 */
export async function syncEmicProgress(participantId, milestone) {
    if (!participantId) return;
    try {
        const { getStandaloneFeatures } = await import('./region-tracker.js');
        const { EMIC_FLAGS, getEmicFlag, getEmicFlagNumber } = await import('./emic-study-flags.js');

        const standalone = getStandaloneFeatures();
        const features = standalone.map((feat, i) => ({
            index: i,
            timeRange: { start: feat.startTime || '', end: feat.endTime || '' },
            freqRange: { low: feat.lowFreq || '', high: feat.highFreq || '' },
            type: feat.type || null,
            repetition: feat.repetition || null,
            notes: feat.notes || null,
            speedFactor: feat.speedFactor ?? null,
            drawnAt: feat.createdAt || ''
        }));

        const flags = {
            registered: getEmicFlag(EMIC_FLAGS.HAS_REGISTERED),
            closedWelcome: getEmicFlag(EMIC_FLAGS.HAS_CLOSED_WELCOME),
            featureCount: getEmicFlagNumber(EMIC_FLAGS.ACTIVE_FEATURE_COUNT),
            completedAnalysis: getEmicFlag(EMIC_FLAGS.HAS_COMPLETED_ANALYSIS),
            submittedBackground: getEmicFlag(EMIC_FLAGS.HAS_SUBMITTED_BACKGROUND),
            submittedDataAnalysis: getEmicFlag(EMIC_FLAGS.HAS_SUBMITTED_DATA_ANALYSIS),
            submittedMusical: getEmicFlag(EMIC_FLAGS.HAS_SUBMITTED_MUSICAL),
            submittedReferral: getEmicFlag(EMIC_FLAGS.HAS_SUBMITTED_REFERRAL),
            submittedFeedback: getEmicFlag(EMIC_FLAGS.HAS_SUBMITTED_FEEDBACK),
        };

        await uploadEmicSubmission(participantId, {
            participantId,
            milestone,
            features,
            featureCount: features.length,
            flags,
            syncedAt: new Date().toISOString(),
            isProgressSync: true,
        });
        console.log(`📡 EMIC progress synced: ${milestone} (${features.length} features)`);
    } catch (e) {
        console.warn(`📡 EMIC progress sync failed (${milestone}):`, e.message);
    }
}

