/**
 * session-management.js
 * Session timeout management with inactivity detection
 * Shows warning at 10 minutes, hard timeout at 20 minutes
 * Only active in study modes (not dev/personal)
 * Reports metadata mismatches silently for debugging
 */

import { reportSessionStateInconsistency } from './silent-error-reporter.js';

// ===== SESSION TIMEOUT MANAGEMENT =====

let lastActivityTime = Date.now();
let timeoutWarningShown = false;
let timeoutCheckInterval = null;
let countdownInterval = null;

const INACTIVE_WARNING_MS = 10 * 60 * 1000;  // 10 minutes
const INACTIVE_TIMEOUT_MS = 20 * 60 * 1000;  // 20 minutes

// ===== HEARTBEAT TRACKING =====
let heartbeatInterval = null;
let userWasActiveSinceLastHeartbeat = false;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;  // 1 minute

/**
 * Set last activity time (for testing purposes)
 * @param {number} timestamp - Timestamp to set as last activity time
 */
export function setLastActivityTime(timestamp) {
    lastActivityTime = timestamp;
    timeoutWarningShown = false;
}

/**
 * Reset activity timer (call on any meaningful interaction)
 */
export function resetActivityTimer() {
    lastActivityTime = Date.now();
    timeoutWarningShown = false;
    userWasActiveSinceLastHeartbeat = true;  // Mark activity for heartbeat
    hideTimeoutWarning(); // Hide warning if it's showing
}

/**
 * Check for inactivity timeout (runs every 30 seconds)
 */
function checkInactivityTimeout() {
    const now = Date.now();
    const inactiveTime = now - lastActivityTime;
    
    // Show warning at 10 minutes
    if (inactiveTime >= INACTIVE_WARNING_MS && !timeoutWarningShown) {
        showTimeoutWarning();
        timeoutWarningShown = true;
    }
    
    // Hard timeout at 20 minutes
    if (inactiveTime >= INACTIVE_TIMEOUT_MS) {
        handleSessionTimeout();
    }
}

/**
 * Check for timeout on page visibility change or focus
 * Handles cases where page was backgrounded/closed for extended periods
 */
function checkTimeoutOnVisibilityChange() {
    const now = Date.now();
    const inactiveTime = now - lastActivityTime;
    
    // console.log(`👁️ Page became visible. Inactive time: ${(inactiveTime / 1000).toFixed(0)}s`);
    
    // If they were gone for 20+ minutes, timeout immediately
    if (inactiveTime >= INACTIVE_TIMEOUT_MS) {
        console.log('⏰ Timeout detected on page visibility change');
        handleSessionTimeout();
        return;
    }
    
    // If they were gone for 10+ minutes but less than 20, show warning
    if (inactiveTime >= INACTIVE_WARNING_MS && !timeoutWarningShown) {
        showTimeoutWarning();
        timeoutWarningShown = true;
    }
}

/**
 * Show 10-minute inactivity warning modal with countdown
 * Exported for testing purposes
 */
export function showTimeoutWarning() {
    // Don't show if already showing
    if (document.getElementById('timeout-warning-modal')) {
        return;
    }

    const modal = document.createElement('div');
    modal.id = 'timeout-warning-modal';
    modal.className = 'modal-overlay active';
    modal.innerHTML = `
        <div class="modal-window" style="display: flex;">
            <div class="modal-content" style="max-width: 500px;">
                <div class="modal-header">
                    <h2 class="modal-title">Still listening? 🌋</h2>
                </div>
                <div class="modal-body">
                    <p style="font-size: 16px; font-weight: 500;">You've been inactive for a while now. To maintain study data quality, your session will end in <span id="timeout-countdown" style="font-weight: 700; color: #c82333;">10</span> minutes.</p>
                </div>
                <div style="display: flex; justify-content: center; margin-top: 20px;">
                    <button id="timeout-continue-btn" style="padding: 12px 32px; font-size: 16px; font-weight: 600; border-radius: 6px; border: none; background: linear-gradient(135deg, #b85050 0%, #963030 100%); color: white; cursor: pointer; transition: all 0.2s;">I'm here, continue</button>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Update countdown every 10 seconds (smooth enough without being jittery)
    const modalBody = modal.querySelector('.modal-body');
    const countdownParagraph = modalBody.querySelector('p');
    
    countdownInterval = setInterval(() => {
        const now = Date.now();
        const timeRemaining = INACTIVE_TIMEOUT_MS - (now - lastActivityTime);
        
        if (timeRemaining <= 0) {
            clearInterval(countdownInterval);
            return;
        }
        
        const minutesRemaining = Math.ceil(timeRemaining / 60000); // Round up
        
        // Update countdown text
        if (minutesRemaining === 1) {
            countdownParagraph.innerHTML = `You've been inactive for a while now. To maintain study data quality, your session will end in <span id="timeout-countdown" style="font-weight: 700; color: #c82333;">${minutesRemaining}</span> minute.`;
        } else {
            countdownParagraph.innerHTML = `You've been inactive for a while now. To maintain study data quality, your session will end in <span id="timeout-countdown" style="font-weight: 700; color: #c82333;">${minutesRemaining}</span> minutes.`;
        }
    }, 10000); // Check every 10 seconds
    
    // Continue button - reset timer
    document.getElementById('timeout-continue-btn').addEventListener('click', () => {
        clearInterval(countdownInterval);
        resetActivityTimer();
    });
}

/**
 * Hide timeout warning modal
 */
function hideTimeoutWarning() {
    const modal = document.getElementById('timeout-warning-modal');
    if (modal) {
        if (countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
        }
        modal.remove();
    }
}

/**
 * Handle session timeout (20 min or manual end)
 */
export async function handleSessionTimeout() {
    console.log('⏰ Session timed out due to inactivity');
    
    // 1. Stop audio playback
    try {
        const { pausePlayback } = await import('./audio-player.js');
        pausePlayback();
    } catch (error) {
        console.warn('⚠️ Could not pause playback:', error);
    }
    
    // 2. Submit pre-survey data with timeout flag and regions/features
    try {
        const { getParticipantId } = await import('./qualtrics-api.js');
        const { getSessionResponses, trackUserAction, getSessionState } = await import('../Qualtrics/participant-response-manager.js');
        const { getRegions } = await import('./region-tracker.js');
        const { submitCombinedSurveyResponse } = await import('./qualtrics-api.js');
        
        const participantId = getParticipantId();
        
        if (participantId) {
            console.log('📤 Submitting pre-survey data with timeout flag...');
            
            // Get current session responses
            const responses = getSessionResponses(participantId);
            
            if (responses && responses.pre) {
                // Get regions/features
                const regions = getRegions();
                
                // Get session state for consistency check
                const sessionState = getSessionState(participantId);
                
                // 🔕 Check for session inconsistencies during timeout
                if (sessionState && responses.sessionId !== sessionState.sessionId) {
                    reportSessionStateInconsistency(
                        'timeout_submission_session_id_mismatch',
                        sessionState,
                        responses
                    ).catch(e => console.warn('Silent report failed:', e));
                }
                
                // Format regions with features
                const formattedRegions = regions.map(region => ({
                    regionId: region.id,
                    startTime: region.startTime,
                    endTime: region.endTime,
                    startSample: region.startSample,
                    endSample: region.endSample,
                    description: region.description || '',
                    features: region.features ? region.features.map(feature => ({
                        featureNumber: feature.featureNumber,
                        featureType: feature.featureType,
                        featureRepetition: feature.featureRepetition,
                        featureStartTime: feature.featureStartTime,
                        featureEndTime: feature.featureEndTime,
                        featureNotes: feature.featureNotes || '',
                        frequency: feature.frequency || null
                    })) : []
                }));
                
                       // Get session counts and stats (BACKWARD COMPATIBLE - won't crash if missing)
                       let weeklySessionCount = 0;
                       let globalStats = {
                           totalSessionsStarted: 0,
                           totalSessionsCompleted: 0,
                           totalSessionTime: 0,
                           totalSessionTimeHours: 0
                       };
                       let sessionRecord = null;
                       
                       try {
                           const { getSessionCountThisWeek, getSessionStats, closeSession } = await import('./study-workflow.js');
                           
                           try {
                               weeklySessionCount = getSessionCountThisWeek() || 0;
                           } catch (e) {
                               console.warn('⚠️ Could not get weekly session count:', e);
                           }
                           
                           try {
                               globalStats = getSessionStats() || globalStats;
                           } catch (e) {
                               console.warn('⚠️ Could not get session stats:', e);
                           }
                           
                           try {
                               // Close the current session (they have pre-survey but timed out)
                               const completedAllSurveys = false; // Timed out, so incomplete
                               sessionRecord = closeSession(completedAllSurveys, true); // true = submitted to Qualtrics
                           } catch (e) {
                               console.warn('⚠️ Could not complete session record:', e);
                           }
                       } catch (error) {
                           console.warn('⚠️ Could not import session tracking functions:', error);
                       }
                       
                       // Build JSON dump with timeout flag and session metadata
                       // BACKWARD COMPATIBLE: All fields have safe defaults
                       const jsonDump = {
                           sessionId: responses.sessionId || null,
                           participantId: participantId || null,
                           
                           // Session timing (safe fallbacks)
                           sessionStarted: responses.createdAt || (sessionRecord && sessionRecord.startTime) || null,
                           sessionEnded: (sessionRecord && sessionRecord.endTime) || new Date().toISOString(),
                           sessionDurationMs: (sessionRecord && sessionRecord.duration) || null,
                           
                           // Session completion status (safe booleans)
                           completedAllSurveys: false, // Timed out
                           submittedToQualtrics: true, // We are submitting it now
                           
                           // Timeout-specific info
                           sessionTimedOut: true,
                           timeoutTimestamp: new Date().toISOString(),
                           submissionReason: 'session_timeout',
                           note: 'Session ended due to 20 minutes of inactivity',
                           
                           // Session counts (this session) - safe defaults
                           weeklySessionCount: weeklySessionCount || 0,
                           
                           // Global statistics (all sessions) - safe defaults
                           globalStats: {
                               totalSessionsStarted: (globalStats && globalStats.totalSessionsStarted) || 0,
                               totalSessionsCompleted: (globalStats && globalStats.totalSessionsCompleted) || 0,
                               totalSessionTimeMs: (globalStats && globalStats.totalSessionTime) || 0,
                               totalSessionTimeHours: (globalStats && globalStats.totalSessionTimeHours) || 0
                           },
                           
                           // Regions
                           regions: formattedRegions || []
                       };
                
                // Build combined responses (pre-survey only since they timed out)
                const combinedResponses = {
                    pre: responses.pre,
                    post: null,
                    awesf: null,
                    activityLevel: null,
                    sessionId: responses.sessionId,
                    participantId: participantId,
                    createdAt: responses.createdAt,
                    jsonDump: jsonDump
                };
                
                // Submit to Qualtrics
                const result = await submitCombinedSurveyResponse(combinedResponses, participantId);
                console.log('✅ Timeout submission successful:', result);
                
                // Upload submission data to R2 (backup)
                try {
                    const { uploadSubmissionData } = await import('./data-uploader.js');
                    await uploadSubmissionData(participantId, jsonDump);
                } catch (error) {
                    console.warn('⚠️ Could not upload timeout submission to R2:', error);
                }
                
                // Track the timeout event
                trackUserAction(participantId, 'session_timeout', {
                    timestamp: new Date().toISOString(),
                    regionCount: regions.length,
                    featureCount: regions.reduce((sum, r) => sum + (r.features?.length || 0), 0)
                });
                
                // Clear session-level flags so next session starts fresh
                try {
                    localStorage.removeItem('study_has_seen_welcome_back');
                    localStorage.removeItem('study_pre_survey_completion_date');
                    localStorage.removeItem('study_begin_analysis_clicked_this_session');
                    localStorage.removeItem('study_current_session_start');
                    localStorage.removeItem('study_timeout_session_id');
                    console.log('🧹 Cleared session flags after timeout (including timeout tracking)');
                } catch (error) {
                    console.warn('⚠️ Could not clear session flags:', error);
                }
            } else {
                console.warn('⚠️ No pre-survey data found for timeout submission');
                
                // 🔕 Report missing pre-survey at timeout
                if (responses && !responses.pre) {
                    reportSessionStateInconsistency(
                        'timeout_missing_pre_survey',
                        null,
                        responses
                    ).catch(e => console.warn('Silent report failed:', e));
                }
            }
        } else {
            console.warn('⚠️ No participant ID found - cannot submit timeout data');
        }
    } catch (error) {
        console.error('❌ Error submitting timeout data to Qualtrics:', error);
    }
    
    // 3. Hide timeout warning if showing
    hideTimeoutWarning();
    
    // 4. Show timeout message
    showTimeoutMessage();
    
    // 5. Stop activity timer
    stopActivityTimer();
}

/**
 * Show session timeout message
 * Exported for testing purposes
 */
export function showTimeoutMessage() {
    // Don't show if already showing
    if (document.getElementById('timeout-message-modal')) {
        return;
    }

    const modal = document.createElement('div');
    modal.id = 'timeout-message-modal';
    modal.className = 'modal-overlay active';
    modal.innerHTML = `
        <div class="modal-window" style="display: flex;">
            <div class="modal-content" style="max-width: 500px;">
                <div class="modal-header">
                    <h2 class="modal-title">🌋 Session timed out</h2>
                </div>
                <div class="modal-body">
                    <p style="margin-bottom: 15px; font-size: 16px; font-weight: 700;">You were away for 20+ minutes. Your regions and features were saved.</p>
                    <p style="font-size: 16px; font-weight: 500;">All sessions should be completed within one sitting. When you're ready to continue, you'll complete a quick pre-survey before you begin.</p>
                </div>
                <div style="display: flex; justify-content: center; margin-top: 20px;">
                    <button id="restart-session-btn" style="padding: 12px 32px; font-size: 16px; font-weight: 500; border-radius: 6px; border: none; background: linear-gradient(135deg, #b85050 0%, #963030 100%); color: white; cursor: pointer; transition: all 0.2s;">Start new session</button>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    document.getElementById('restart-session-btn').addEventListener('click', async () => {
        // Remove timeout modal
        modal.remove();
        
        // 🔄 Reset activity timestamp for fresh session start
        const { STORAGE_KEYS } = await import('./study-workflow.js');
        const { getParticipantId } = await import('./qualtrics-api.js');
        const participantId = getParticipantId();
        const now = Date.now();
        
        localStorage.setItem(STORAGE_KEYS.CURRENT_SESSION_START, new Date(now).toISOString());
        
        // 🔐 Tie timeout to this specific user/session
        if (participantId) {
            localStorage.setItem(STORAGE_KEYS.TIMEOUT_SESSION_ID, participantId);
            console.log(`🔐 Timeout session tied to participant: ${participantId}`);
        }
        
        lastActivityTime = now;
        console.log('🔄 Activity timestamp refreshed for new session');
        
        // Show pre-survey modal (your existing function)
        try {
            const { openPreSurveyModal } = await import('./ui-controls.js');
            openPreSurveyModal();
        } catch (error) {
            console.error('❌ Could not open pre-survey modal:', error);
        }
        
        // Restart activity timer (will be started after pre-survey completes)
    });
}

/**
 * Start activity monitoring
 * Only activates in study modes - disabled for dev/personal modes
 */
export async function startActivityTimer() {
    // Check if we're in a study mode
    try {
        const { isStudyMode } = await import('./master-modes.js');
        
        if (!isStudyMode()) {
            console.log('⏱️ Activity timer disabled (not in study mode)');
            return;
        }
    } catch (error) {
        console.warn('⚠️ Could not check study mode, enabling timer by default:', error);
    }
    
    lastActivityTime = Date.now();
    timeoutWarningShown = false;
    
    // Check every 30 seconds
    if (timeoutCheckInterval) {
        clearInterval(timeoutCheckInterval);
    }
    timeoutCheckInterval = setInterval(checkInactivityTimeout, 30000);
    
    // Track activity events
    document.addEventListener('mousemove', resetActivityTimer);
    document.addEventListener('click', resetActivityTimer);
    document.addEventListener('keydown', resetActivityTimer);
    
    // Check timeout when page becomes visible again (handles tab switches, sleep, etc.)
    document.addEventListener('visibilitychange', checkTimeoutOnVisibilityChange);
    window.addEventListener('focus', checkTimeoutOnVisibilityChange);
    
    console.log('⏱️ Activity timer started with visibility tracking (study mode)');
}

/**
 * Stop activity monitoring
 */
export function stopActivityTimer() {
    if (timeoutCheckInterval) {
        clearInterval(timeoutCheckInterval);
        timeoutCheckInterval = null;
    }
    
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    
    document.removeEventListener('mousemove', resetActivityTimer);
    document.removeEventListener('click', resetActivityTimer);
    document.removeEventListener('keydown', resetActivityTimer);
    document.removeEventListener('visibilitychange', checkTimeoutOnVisibilityChange);
    window.removeEventListener('focus', checkTimeoutOnVisibilityChange);

    console.log('⏱️ Activity timer stopped');
}

// =============================================================================
// HEARTBEAT TRACKING (for personal/logged-in users)
// =============================================================================

/**
 * Send heartbeat if user was active since last check
 */
async function sendHeartbeatIfActive() {
    if (!userWasActiveSinceLastHeartbeat) {
        return; // No activity since last heartbeat, skip
    }

    try {
        const { getParticipantId } = await import('./qualtrics-api.js');
        const username = getParticipantId();

        if (!username) {
            return; // No user logged in
        }

        const { sendHeartbeat } = await import('./share-api.js');
        await sendHeartbeat(username);

        // Reset the activity flag
        userWasActiveSinceLastHeartbeat = false;
    } catch (error) {
        // Silent fail - don't spam console
        console.debug('Heartbeat failed:', error.message);
    }
}

/**
 * Start heartbeat tracking (sends heartbeat every minute if user is active)
 */
export function startHeartbeatTracking() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
    }

    // Send initial heartbeat on page load
    userWasActiveSinceLastHeartbeat = true;
    sendHeartbeatIfActive();

    // Then check every minute
    heartbeatInterval = setInterval(sendHeartbeatIfActive, HEARTBEAT_INTERVAL_MS);
    console.log('💓 Heartbeat tracking started (1 min interval)');
}

/**
 * Stop heartbeat tracking
 */
export function stopHeartbeatTracking() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
    console.log('💓 Heartbeat tracking stopped');
}

