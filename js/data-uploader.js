/**
 * Data Uploader
 * Uploads user's localStorage data to R2 via backend API
 * Structure: volcano-audio-anonymized-data/participants/{participantId}/
 *   - user-status/status.json (overwritten each time)
 *   - submissions/{participantId}_Complete_{timestamp}.json (append-only)
 */

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
        
        // Study progress flags
        const hasSeenParticipantSetup = localStorage.getItem('study_has_seen_participant_setup') === 'true';
        const hasSeenWelcome = localStorage.getItem('study_has_seen_welcome') === 'true';
        const hasSeenTutorial = localStorage.getItem('study_has_seen_tutorial') === 'true';
        const tutorialCompleted = localStorage.getItem('study_tutorial_completed') === 'true';
        
        // Session tracking
        const weeklySessionCount = parseInt(localStorage.getItem('study_weekly_session_count') || '0', 10);
        const weekStartDate = localStorage.getItem('study_week_start_date');
        const lastAwesfDate = localStorage.getItem('study_last_awesf_date');
        
        const totalSessionsStarted = parseInt(localStorage.getItem('study_total_sessions_started') || '0', 10);
        const totalSessionsCompleted = parseInt(localStorage.getItem('study_total_sessions_completed') || '0', 10);
        const totalSessionTime = parseInt(localStorage.getItem('study_total_session_time') || '0', 10);
        const totalSessionTimeHours = parseFloat((totalSessionTime / (1000 * 60 * 60)).toFixed(2));
        
        // Session history
        const sessionHistory = safeGet('study_session_history', []);
        
        // Current session (if any)
        const currentSessionStart = localStorage.getItem('study_current_session_start');
        
        // Preferences
        const selectedVolcano = localStorage.getItem('selectedVolcano');
        const selectedMode = localStorage.getItem('selectedMode');
        
        // Response data (all survey responses)
        const responseKey = `participant_response_${participantId}`;
        const responses = safeGet(responseKey, null);
        
        return {
            participantId,
            timestamp: new Date().toISOString(),
            
            // Study progress flags
            hasSeenParticipantSetup,
            hasSeenWelcome,
            hasSeenTutorial,
            tutorialCompleted,
            
            // Session tracking
            weeklySessionCount,
            weekStartDate,
            lastAwesfDate,
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

