/**
 * study-workflow.js
 * Orchestrates the full Study Mode workflow with all visit rules
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ IMPORTANT: TEST MODE PHILOSOPHY
 * ═══════════════════════════════════════════════════════════════════════════
 * Test modes (study_w2_s1, study_w2_s2, study_w2_s1_returning) ONLY set FLAGS.
 * They DO NOT contain separate logic. All behavior is driven by the REAL LOGIC
 * that responds to these flags.
 * 
 * When fixing bugs or adding features:
 * ✅ DO: Fix the logic that checks flags (works for both real users and test modes)
 * ❌ DON'T: Add special cases for test modes (defeats the purpose of testing)
 * 
 * Test modes simulate user states by setting the SAME flags that real users would have.
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * VISIT RULES:
 * ============
 * FIRST VISIT EVER (W1S1):
 *   1. Participant Setup (once ever)
 *   2. Welcome (once ever)
 *   3. Pre-Survey (every session)
 *   4. Tutorial (once ever)
 *   5. Experience
 *   6. Activity Level (every session)
 *   7. AWE-SF (Session 1 of each week only)
 *   8. Post-Survey (every session)
 *   9. End/Confirmation (every session)
 * 
 * SESSION 2 OF ANY WEEK (W1S2, W2S2, W3S2):
 *   1. Pre-Survey (every session)
 *   2. Experience
 *   3. Activity Level (every session)
 *   4. Post-Survey (every session) [NO AWE-SF]
 *   5. End/Confirmation (every session)
 * 
 * SESSION 1 OF NEW WEEK (W2S1, W3S1):
 *   1. Pre-Survey (every session)
 *   2. Experience
 *   3. Activity Level (every session)
 *   4. AWE-SF (Session 1 of each week only) ← Returns!
 *   5. Post-Survey (every session)
 *   6. End/Confirmation (every session)
 */

import { isStudyMode, isStudyCleanMode } from './master-modes.js';
import { 
    openParticipantModal,
    openWelcomeModal,
    openPreSurveyModal,
    closePreSurveyModal,
    openActivityLevelModal,
    openAwesfModal,
    openPostSurveyModal,
    openEndModal
} from './ui-controls.js';
import { getParticipantId } from './qualtrics-api.js';
import { 
    saveSurveyResponse,
    trackSurveyStart,
    trackUserAction,
    markSessionAsSubmitted,
    exportResponseMetadata,
    getSessionState,
    getSessionResponses
} from '../Qualtrics/participant-response-manager.js';

// ═══════════════════════════════════════════════════════════
// 📊 PERSISTENT FLAGS (localStorage)
// ═══════════════════════════════════════════════════════════
// 
// SESSION TRACKING HISTORY:
// ========================
// ALREADY EXISTED (before Nov 19, 2025):
//   - TOTAL_SESSIONS_STARTED
//   - TOTAL_SESSIONS_COMPLETED
//   - TOTAL_SESSION_TIME
//   - SESSION_HISTORY (array of session objects)
//   - CURRENT_SESSION_START
//   - Functions: startSession(), completeSession(), getSessionStats()
//
// ADDED Nov 19, 2025:
//   - TOTAL_SESSION_COUNT (persistent counter across weeks)
//   - Enhanced error handling & backward compatibility
//   - Integration into submission flow (jsonDump metadata)
//
// BACKWARD COMPATIBILITY:
//   All functions handle missing/corrupt data gracefully
//   Returns safe defaults instead of crashing
// ═══════════════════════════════════════════════════════════

const STORAGE_KEYS = {
    HAS_SEEN_PARTICIPANT_SETUP: 'study_has_seen_participant_setup',
    HAS_SEEN_WELCOME: 'study_has_seen_welcome',
    HAS_SEEN_WELCOME_BACK: 'study_has_seen_welcome_back', // SESSION-LEVEL: cleared each new session
    TUTORIAL_IN_PROGRESS: 'study_tutorial_in_progress', // Set when user clicks "Begin Tutorial", cleared when completed
    TUTORIAL_COMPLETED: 'study_tutorial_completed',
    WEEKLY_SESSION_COUNT: 'study_weekly_session_count',
    WEEK_START_DATE: 'study_week_start_date',
    PRE_SURVEY_COMPLETION_DATE: 'study_pre_survey_completion_date',
    TOTAL_SESSIONS_STARTED: 'study_total_sessions_started',
    TOTAL_SESSIONS_COMPLETED: 'study_total_sessions_completed',
    TOTAL_SESSION_TIME: 'study_total_session_time', // in milliseconds
    SESSION_HISTORY: 'study_session_history', // JSON array of session objects
    CURRENT_SESSION_START: 'study_current_session_start', // timestamp of current session
    TOTAL_REGIONS_IDENTIFIED: 'study_total_regions_identified', // cumulative across all sessions
    TOTAL_FEATURES_IDENTIFIED: 'study_total_features_identified', // cumulative across all sessions
    SESSION_COMPLETION_TRACKER: 'study_session_completion_tracker', // tracks which specific sessions are complete
    BEGIN_ANALYSIS_CLICKED_THIS_SESSION: 'study_begin_analysis_clicked_this_session' // SESSION-LEVEL: cleared each new session
};

/**
 * Check if user has seen participant setup (once ever)
 */
export function hasSeenParticipantSetup() {
    // Returning modes: simulate returning user (true)
    const storedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('selectedMode') : null;
    if (storedMode === 'study_w2_s1' || storedMode === 'study_w2_s1_returning' || storedMode === 'study_w2_s2') return true;
    
    // Always act like first time in study_clean/test modes
    if (isStudyCleanMode() && storedMode === 'study_clean') return false;
    if (storedMode === 'tutorial_end') return false;
    
    return localStorage.getItem(STORAGE_KEYS.HAS_SEEN_PARTICIPANT_SETUP) === 'true';
}

function markParticipantSetupAsSeen() {
    localStorage.setItem(STORAGE_KEYS.HAS_SEEN_PARTICIPANT_SETUP, 'true');
    console.log('✅ Participant setup marked as seen (forever)');
}

/**
 * Check if user has seen welcome modal (once ever)
 */
export function hasSeenWelcome() {
    // Returning modes: simulate returning user (true)
    const storedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('selectedMode') : null;
    if (storedMode === 'study_w2_s1' || storedMode === 'study_w2_s1_returning' || storedMode === 'study_w2_s2') return true;
    
    // Always act like first time in study_clean/test modes
    if (isStudyCleanMode() && storedMode === 'study_clean') return false;
    if (storedMode === 'tutorial_end') return false;
    
    return localStorage.getItem(STORAGE_KEYS.HAS_SEEN_WELCOME) === 'true';
}

function markWelcomeAsSeen() {
    localStorage.setItem(STORAGE_KEYS.HAS_SEEN_WELCOME, 'true');
    console.log('✅ Welcome marked as seen (forever)');
}

/**
 * Check if user has seen welcome back modal (this session only)
 */
export function hasSeenWelcomeBack() {
    return localStorage.getItem(STORAGE_KEYS.HAS_SEEN_WELCOME_BACK) === 'true';
}

export function markWelcomeBackAsSeen() {
    localStorage.setItem(STORAGE_KEYS.HAS_SEEN_WELCOME_BACK, 'true');
    console.log('✅ Welcome Back marked as seen (this session)');
}

/**
 * Check if tutorial is in progress (user clicked "Begin Tutorial" but hasn't finished)
 */
export function isTutorialInProgress() {
    return localStorage.getItem(STORAGE_KEYS.TUTORIAL_IN_PROGRESS) === 'true';
}

export function markTutorialAsInProgress() {
    localStorage.setItem(STORAGE_KEYS.TUTORIAL_IN_PROGRESS, 'true');
    console.log('▶️ Tutorial marked as IN PROGRESS');
}

/**
 * Check if user has completed tutorial (once ever)
 * Only marked as completed when they click "Begin Analysis" button
 */
export function tutorialCompleted() {
    // Returning modes: simulate returning user who already completed tutorial (true)
    const storedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('selectedMode') : null;
    if (storedMode === 'study_w2_s1' || storedMode === 'study_w2_s1_returning' || storedMode === 'study_w2_s2') return true;
    
    // Always act like first time in study_clean/test modes
    if (isStudyCleanMode() && storedMode === 'study_clean') return false;
    if (storedMode === 'tutorial_end') return false;
    
    // 🔄 MIGRATION: Convert old flag to new flag
    const oldFlag = localStorage.getItem('study_has_seen_tutorial');
    if (oldFlag === 'true' && !localStorage.getItem(STORAGE_KEYS.TUTORIAL_COMPLETED)) {
        localStorage.setItem(STORAGE_KEYS.TUTORIAL_COMPLETED, 'true');
        localStorage.removeItem('study_has_seen_tutorial'); // Clean up old flag
    }
    
    return localStorage.getItem(STORAGE_KEYS.TUTORIAL_COMPLETED) === 'true';
}

export function markTutorialAsCompleted() {
    localStorage.setItem(STORAGE_KEYS.TUTORIAL_COMPLETED, 'true');
    // Clear in-progress flag when marking as completed
    localStorage.removeItem(STORAGE_KEYS.TUTORIAL_IN_PROGRESS);
    console.log('✅ Tutorial marked as COMPLETED (Begin Analysis was clicked)');
}

/**
 * Check if "Begin Analysis" was clicked THIS SESSION (session-level flag)
 * This is separate from tutorialCompleted() which is a persistent flag
 */
export function hasBegunAnalysisThisSession() {
    return localStorage.getItem(STORAGE_KEYS.BEGIN_ANALYSIS_CLICKED_THIS_SESSION) === 'true';
}

/**
 * Mark "Begin Analysis" as clicked THIS SESSION (session-level flag)
 * This gets cleared at the start of each new session
 */
export function markBeginAnalysisClickedThisSession() {
    localStorage.setItem(STORAGE_KEYS.BEGIN_ANALYSIS_CLICKED_THIS_SESSION, 'true');
    console.log('✅ Begin Analysis marked as clicked THIS SESSION');
}

// Keep old names for backwards compatibility
export const hasTutorialCompleted = tutorialCompleted;
export const hasSeenTutorial = tutorialCompleted;
export const markTutorialAsSeen = markTutorialAsCompleted;

/**
 * Check if AWE-SF should be shown
 * AWE-SF shows on Session 1 of each week only (W1S1, W2S1, W3S1)
 * NOT shown on Session 2 of any week (W1S2, W2S2, W3S2)
 */
export function shouldShowAwesf() {
    const storedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('selectedMode') : null;
    
    // W2 S1 modes: Show AWE-SF (first session of week)
    if (storedMode === 'study_w2_s1' || storedMode === 'study_w2_s1_returning') return true;
    
    // W2 S2 mode: Don't show AWE-SF (second session of week)
    if (storedMode === 'study_w2_s2') return false;
    
    // Study clean: Always show (simulates W1S1)
    if (isStudyCleanMode() && storedMode === 'study_clean') return true;
    if (storedMode === 'tutorial_end') return true;
    
    // Use session tracker to determine if this is Session 1 of the week
    const { currentWeek, sessionNumber } = getCurrentWeekAndSession();
    
    // AWE-SF shows on Session 1 of any week, not on Session 2
    const show = sessionNumber === 1;
    
    console.log(`🔍 AWE-SF check: Week ${currentWeek}, Session ${sessionNumber} → ${show ? 'SHOW AWE-SF' : 'SKIP AWE-SF'}`);
    return show;
}

// Keep old function name for backward compatibility
export function hasCompletedAwesfThisWeek() {
    return !shouldShowAwesf();
}



/**
 * Get session count for this week
 */
export function getSessionCountThisWeek() {
    // Returning modes: use simulated session count based on mode
    const storedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('selectedMode') : null;
    if (storedMode === 'study_w2_s1' || storedMode === 'study_w2_s1_returning') return 0; // First session of Week 2 (0 completed this week)
    if (storedMode === 'study_w2_s2') return 1; // Second session of Week 2 (1 completed this week)
    
    if (isStudyCleanMode() && storedMode === 'study_clean') return 0;
    
    const weekStartDate = localStorage.getItem(STORAGE_KEYS.WEEK_START_DATE);
    const sessionCount = parseInt(localStorage.getItem(STORAGE_KEYS.WEEKLY_SESSION_COUNT) || '0');
    
    // Get start of this week (Sunday)
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setHours(0, 0, 0, 0);
    startOfWeek.setDate(now.getDate() - now.getDay());
    const weekStartStr = startOfWeek.toISOString().split('T')[0];
    
    // Check if we're in the same week
    if (weekStartDate === weekStartStr) {
        return sessionCount;
    } else {
        // New week - reset count
        localStorage.setItem(STORAGE_KEYS.WEEK_START_DATE, weekStartStr);
        localStorage.setItem(STORAGE_KEYS.WEEKLY_SESSION_COUNT, '0');
        console.log(`📅 New week detected (${weekStartStr}) - session count reset`);
        
        // Initialize total count if needed (for week one)
        initializeTotalSessionCount();
        
        return 0;
    }
}

export function incrementSessionCount() {
    // Increment weekly count
    const currentWeeklyCount = getSessionCountThisWeek();
    const newWeeklyCount = currentWeeklyCount + 1;
    localStorage.setItem(STORAGE_KEYS.WEEKLY_SESSION_COUNT, newWeeklyCount.toString());
    
    console.log(`📊 Session count incremented: ${newWeeklyCount} this week`);
    return newWeeklyCount;
}


/**
 * Start a new session - track start time
 */
export function startSession() {
    const startTime = new Date().toISOString();
    localStorage.setItem(STORAGE_KEYS.CURRENT_SESSION_START, startTime);
    
    // Increment total sessions started
    const totalStarted = parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_SESSIONS_STARTED) || '0');
    localStorage.setItem(STORAGE_KEYS.TOTAL_SESSIONS_STARTED, (totalStarted + 1).toString());
    
    console.log(`🚀 Session started at ${startTime} (total started: ${totalStarted + 1})`);
    return startTime;
}

/**
 * Get current session start time
 */
export function getCurrentSessionStart() {
    return localStorage.getItem(STORAGE_KEYS.CURRENT_SESSION_START);
}

/**
 * Get session history
 * BACKWARD COMPATIBLE: Returns empty array if parse fails or invalid format
 */
export function getSessionHistory() {
    try {
        const history = localStorage.getItem(STORAGE_KEYS.SESSION_HISTORY);
        if (!history) return [];
        
        const parsed = JSON.parse(history);
        
        // Ensure it's an array
        if (!Array.isArray(parsed)) {
            console.warn('⚠️ Session history is not an array, resetting');
            return [];
        }
        
        return parsed;
    } catch (error) {
        console.error('❌ Error parsing session history:', error);
        // Don't crash - return empty array
        return [];
    }
}

/**
 * Complete a session - track end time and metadata
 * BACKWARD COMPATIBLE: Handles missing start time, invalid dates, parse errors
 */
export function completeSession(completedAllSurveys = false, submittedToQualtrics = false) {
    try {
        const startTime = localStorage.getItem(STORAGE_KEYS.CURRENT_SESSION_START);
        if (!startTime) {
            console.warn('⚠️ No session start time found - cannot complete session');
            return null;
        }
        
        const endTime = new Date().toISOString();
        let duration = 0;
        
        try {
            duration = new Date(endTime) - new Date(startTime);
            // Sanity check: duration should be positive and reasonable (< 24 hours)
            if (duration < 0 || duration > 24 * 60 * 60 * 1000) {
                console.warn('⚠️ Invalid session duration calculated:', duration);
                duration = 0;
            }
        } catch (error) {
            console.error('❌ Error calculating duration:', error);
            duration = 0;
        }
        
        // Safely get session count
        let weeklyCount = 0;
        try {
            weeklyCount = getSessionCountThisWeek();
        } catch (error) {
            console.error('❌ Error getting session count:', error);
        }
        
        // Create session record
        const sessionRecord = {
            sessionId: `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            startTime: startTime,
            endTime: endTime,
            duration: duration, // in milliseconds
            completedAllSurveys: Boolean(completedAllSurveys),
            submittedToQualtrics: Boolean(submittedToQualtrics),
            weeklySessionCount: weeklyCount
        };
        
        // Add to session history
        try {
            const history = getSessionHistory();
            history.push(sessionRecord);
            localStorage.setItem(STORAGE_KEYS.SESSION_HISTORY, JSON.stringify(history));
        } catch (error) {
            console.error('❌ Error saving to session history:', error);
        }
        
        // Update total sessions completed
        try {
            const totalCompleted = parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_SESSIONS_COMPLETED) || '0');
            localStorage.setItem(STORAGE_KEYS.TOTAL_SESSIONS_COMPLETED, (totalCompleted + 1).toString());
        } catch (error) {
            console.error('❌ Error updating total completed:', error);
        }
        
        // Update total session time
        try {
            const totalTime = parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_SESSION_TIME) || '0');
            localStorage.setItem(STORAGE_KEYS.TOTAL_SESSION_TIME, (totalTime + duration).toString());
        } catch (error) {
            console.error('❌ Error updating total time:', error);
        }
        
        // Clear current session start
        try {
            localStorage.removeItem(STORAGE_KEYS.CURRENT_SESSION_START);
        } catch (error) {
            console.error('❌ Error clearing session start:', error);
        }
        
        // Clear session-level flags so next session starts fresh
        // NOTE: Do NOT clear HAS_SEEN_WELCOME - that's for first-time welcome only
        // Returning users get "Welcome Back" modal automatically (HAS_SEEN_WELCOME_BACK cleared)
        try {
            localStorage.removeItem(STORAGE_KEYS.HAS_SEEN_WELCOME_BACK);
            localStorage.removeItem(STORAGE_KEYS.PRE_SURVEY_COMPLETION_DATE);
            localStorage.removeItem(STORAGE_KEYS.BEGIN_ANALYSIS_CLICKED_THIS_SESSION);
            console.log('🧹 Cleared session flags for next session (welcome back, pre-survey, begin analysis)');
        } catch (error) {
            console.error('❌ Error clearing session flags:', error);
        }
        
        console.log(`✅ Session completed:`, {
            duration: `${(duration / 1000 / 60).toFixed(1)} minutes`,
            completedAllSurveys,
            submittedToQualtrics,
            weeklyCount,
            totalCount
        });
        
        return sessionRecord;
    } catch (error) {
        console.error('❌ Error in completeSession:', error);
        return null;
    }
}

/**
 * Get session statistics
 * BACKWARD COMPATIBLE: Returns safe defaults for all fields if data is missing/corrupt
 */
export function getSessionStats() {
    try {
        const totalStarted = parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_SESSIONS_STARTED) || '0') || 0;
        const totalCompleted = parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_SESSIONS_COMPLETED) || '0') || 0;
        const totalTime = parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_SESSION_TIME) || '0') || 0;
        const history = getSessionHistory();
        
        return {
            totalSessionsStarted: isNaN(totalStarted) ? 0 : totalStarted,
            totalSessionsCompleted: isNaN(totalCompleted) ? 0 : totalCompleted,
            totalSessionTime: isNaN(totalTime) ? 0 : totalTime, // in milliseconds
            totalSessionTimeHours: isNaN(totalTime) ? 0 : (totalTime / 1000 / 60 / 60),
            sessionHistory: Array.isArray(history) ? history : [],
            currentSessionStart: getCurrentSessionStart() || null
        };
    } catch (error) {
        console.error('❌ Error getting session stats:', error);
        // Return safe defaults
        return {
            totalSessionsStarted: 0,
            totalSessionsCompleted: 0,
            totalSessionTime: 0,
            totalSessionTimeHours: 0,
            sessionHistory: [],
            currentSessionStart: null
        };
    }
}

/**
 * Increment cumulative region and feature counts
 * Called after successful session submission
 * @param {number} regionCount - Number of regions identified in this session
 * @param {number} featureCount - Number of features identified in this session
 */
export function incrementCumulativeCounts(regionCount = 0, featureCount = 0) {
    try {
        // Get current cumulative counts
        const currentRegions = parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_REGIONS_IDENTIFIED) || '0') || 0;
        const currentFeatures = parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_FEATURES_IDENTIFIED) || '0') || 0;
        
        // Add this session's counts
        const newRegions = currentRegions + regionCount;
        const newFeatures = currentFeatures + featureCount;
        
        // Save updated counts
        localStorage.setItem(STORAGE_KEYS.TOTAL_REGIONS_IDENTIFIED, newRegions.toString());
        localStorage.setItem(STORAGE_KEYS.TOTAL_FEATURES_IDENTIFIED, newFeatures.toString());
        
        console.log(`📊 Cumulative counts updated: ${newRegions} regions (+${regionCount}), ${newFeatures} features (+${featureCount})`);
        
        return {
            totalRegions: newRegions,
            totalFeatures: newFeatures,
            sessionRegions: regionCount,
            sessionFeatures: featureCount
        };
    } catch (error) {
        console.error('❌ Error incrementing cumulative counts:', error);
        return null;
    }
}

/**
 * Get cumulative region and feature counts across all sessions
 * @returns {Object} - {totalRegions, totalFeatures}
 */
export function getCumulativeCounts() {
    try {
        const totalRegions = parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_REGIONS_IDENTIFIED) || '0') || 0;
        const totalFeatures = parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_FEATURES_IDENTIFIED) || '0') || 0;
        
        return {
            totalRegions,
            totalFeatures
        };
    } catch (error) {
        console.error('❌ Error getting cumulative counts:', error);
        return {
            totalRegions: 0,
            totalFeatures: 0
        };
    }
}

/**
 * Get current week number and session number within that week
 * Uses the tracker as source of truth to determine which session to mark next
 * @returns {Object} - {currentWeek: 1-3, sessionNumber: 1-2, weeklySessionCount: number}
 */
export function getCurrentWeekAndSession() {
    const STUDY_START_DATE = new Date('2025-11-17T00:00:00');
    const TOTAL_STUDY_WEEKS = 3;
    const now = new Date();
    
    // Calculate current week
    const weeksDiff = Math.floor((now - STUDY_START_DATE) / (7 * 24 * 60 * 60 * 1000));
    const currentWeek = Math.max(1, Math.min(weeksDiff + 1, TOTAL_STUDY_WEEKS));
    
    // Get tracker to see what's already complete
    const tracker = getSessionCompletionTracker();
    const weekKey = `week${currentWeek}`;
    const weekSessions = tracker[weekKey] || [false, false];
    
    // Determine next available session in current week
    let sessionNumber;
    if (!weekSessions[0]) {
        sessionNumber = 1; // Session 1 not complete yet
    } else if (!weekSessions[1]) {
        sessionNumber = 2; // Session 1 done, Session 2 not complete
    } else {
        sessionNumber = 2; // Both complete, default to 2 (prevents overflow)
    }
    
    // Get weekly session count for backward compatibility
    const weeklySessionCount = (weekSessions[0] ? 1 : 0) + (weekSessions[1] ? 1 : 0);
    
    return {
        currentWeek,
        sessionNumber,
        weeklySessionCount,
        alreadyComplete: weekSessions[sessionNumber - 1] === true // Flag if already marked complete
    };
}

/**
 * Mark a specific session as complete
 * @param {number} week - Week number (1-3)
 * @param {number} session - Session number within week (1-2)
 */
export function markSessionComplete(week, session) {
    try {
        // Load existing tracker
        const stored = localStorage.getItem(STORAGE_KEYS.SESSION_COMPLETION_TRACKER);
        let tracker = stored ? JSON.parse(stored) : {};
        
        // Initialize structure if needed
        if (!tracker.week1) tracker.week1 = [false, false];
        if (!tracker.week2) tracker.week2 = [false, false];
        if (!tracker.week3) tracker.week3 = [false, false];
        
        // Mark session complete
        const weekKey = `week${week}`;
        if (tracker[weekKey] && session >= 1 && session <= 2) {
            tracker[weekKey][session - 1] = true;
            localStorage.setItem(STORAGE_KEYS.SESSION_COMPLETION_TRACKER, JSON.stringify(tracker));
            console.log(`✅ Marked Week ${week}, Session ${session} as complete`);
            return true;
        }
        
        return false;
    } catch (error) {
        console.error('❌ Error marking session complete:', error);
        return false;
    }
}

/**
 * Get session completion tracker
 * @returns {Object} - {week1: [bool, bool], week2: [bool, bool], week3: [bool, bool], completedCount: number, totalSessions: 6}
 */
export function getSessionCompletionTracker() {
    try {
        const stored = localStorage.getItem(STORAGE_KEYS.SESSION_COMPLETION_TRACKER);
        let tracker = stored ? JSON.parse(stored) : {};
        
        // Initialize structure if needed
        if (!tracker.week1) tracker.week1 = [false, false];
        if (!tracker.week2) tracker.week2 = [false, false];
        if (!tracker.week3) tracker.week3 = [false, false];
        
        // Calculate completed count
        const completedCount = 
            (tracker.week1[0] ? 1 : 0) + (tracker.week1[1] ? 1 : 0) +
            (tracker.week2[0] ? 1 : 0) + (tracker.week2[1] ? 1 : 0) +
            (tracker.week3[0] ? 1 : 0) + (tracker.week3[1] ? 1 : 0);
        
        return {
            week1: tracker.week1,
            week2: tracker.week2,
            week3: tracker.week3,
            completedCount,
            totalSessions: 6,
            progressPercent: Math.round((completedCount / 6) * 100)
        };
    } catch (error) {
        console.error('❌ Error getting session completion tracker:', error);
        return {
            week1: [false, false],
            week2: [false, false],
            week3: [false, false],
            completedCount: 0,
            totalSessions: 6,
            progressPercent: 0
        };
    }
}

/**
 * Reset all study flags (for testing - can be called from console)
 */
export function resetStudyFlags() {
    Object.values(STORAGE_KEYS).forEach(key => localStorage.removeItem(key));
    console.log('🔄 All study flags reset - refresh page to experience full workflow');
}

// Expose to window for console access
if (typeof window !== 'undefined') {
    window.resetStudyFlags = resetStudyFlags;
}

// ═══════════════════════════════════════════════════════════
// 🎬 MAIN WORKFLOW (START OF SESSION)
// ═══════════════════════════════════════════════════════════

/**
 * Get today's date as YYYY-MM-DD string
 */
function getTodayDateString() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Check if pre-survey was completed today
 */
function hasCompletedPreSurveyToday() {
    const completionDate = localStorage.getItem(STORAGE_KEYS.PRE_SURVEY_COMPLETION_DATE);
    if (!completionDate) return false;
    return completionDate === getTodayDateString();
}

/**
 * Mark pre-survey as completed today
 */
export function markPreSurveyCompletedToday() {
    localStorage.setItem(STORAGE_KEYS.PRE_SURVEY_COMPLETION_DATE, getTodayDateString());
    console.log(`✅ Pre-survey marked as completed today (${getTodayDateString()})`);
}

/**
 * Clear session data when starting a new day
 */
async function clearSessionForNewDay(participantId) {
    if (!participantId) return;
    
    const { clearSession } = await import('../Qualtrics/participant-response-manager.js');
    clearSession(participantId);
    console.log('🗑️ Cleared session data for new day');
    
    // Also clear the pre-survey completion date (will be set again when they complete it)
    localStorage.removeItem(STORAGE_KEYS.PRE_SURVEY_COMPLETION_DATE);
}

/**
 * Start the Study Mode workflow
 * ONLY runs in STUDY or STUDY_CLEAN modes
 * Called on page load - shows appropriate modals based on visit history
 */
export async function startStudyWorkflow() {
    const { CURRENT_MODE, isStudyMode } = await import('./master-modes.js');
    
    // ⛔ GUARD: Only run in Study modes
    if (!isStudyMode()) {
        console.error(`❌ startStudyWorkflow called in ${CURRENT_MODE} mode - not allowed`);
        console.error(`   This function only runs in STUDY or STUDY_CLEAN modes`);
        return;
    }
    
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`🎓 STUDY MODE: Starting workflow (mode: ${CURRENT_MODE})`);
    console.log('═══════════════════════════════════════════════════════════');
    
    // Verify modals exist before proceeding
    const participantModal = document.getElementById('participantModal');
    if (!participantModal) {
        console.error('❌ CRITICAL: Participant modal not found! Cannot start workflow.');
        console.error('   Modals may not have been initialized. Check initializeModals() was called.');
        return;
    }
    console.log('✅ Participant modal found in DOM');
    
    // ⏰ TIMEOUT CHECK: Only matters if user has clicked "Begin Analysis" (actively in session)
    // If they haven't clicked Begin Analysis, they're still in onboarding - timeout doesn't apply
    if (hasBegunAnalysisThisSession()) {
        // Check for simulated idle time FIRST (for testing)
        const simulatedLastActivity = localStorage.getItem('test_simulated_last_activity');
        const sessionStartTime = localStorage.getItem(STORAGE_KEYS.CURRENT_SESSION_START);
        
        if (simulatedLastActivity || sessionStartTime) {
            const now = Date.now();
            let lastActivityTime;
            
            // Use simulated time if available, otherwise use session start
            if (simulatedLastActivity) {
                lastActivityTime = parseInt(simulatedLastActivity);
                console.log('🧪 Using simulated last activity time for timeout check');
            } else {
                lastActivityTime = new Date(sessionStartTime).getTime();
            }
            
            const inactiveTime = now - lastActivityTime;
            const INACTIVE_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
            
            if (inactiveTime >= INACTIVE_TIMEOUT_MS) {
                console.log(`⏰ Session timeout detected: ${(inactiveTime / 1000 / 60).toFixed(1)} minutes elapsed`);
                const { handleSessionTimeout } = await import('./session-management.js');
                handleSessionTimeout();
                return; // Exit - timeout modal will handle continuation
            }
        }
    }
    
    // 🔥 CORRUPTED STATE CHECK: Incomplete onboarding? Reset to brand new
    const hasPreSurvey = localStorage.getItem(STORAGE_KEYS.PRE_SURVEY_COMPLETION_DATE) !== null;
    const isInTutorial = isTutorialInProgress();
    
    // Case 1: Seen participant setup but no tutorial completion AND not actively in tutorial
    if (hasSeenParticipantSetup() && !tutorialCompleted() && !isInTutorial) {
        console.log('⚠️ CORRUPTED STATE: User has seen participant setup but never completed tutorial');
        console.log(`   Has pre-survey: ${hasPreSurvey}, Tutorial in progress: ${isInTutorial}`);
        console.log('🧹 Resetting to brand new participant state...');
        
        // Clear ALL study workflow flags
        Object.entries(STORAGE_KEYS).forEach(([name, key]) => {
            localStorage.removeItem(key);
        });
        console.log('✅ All flags cleared - will restart from participant setup');
    }
    
    // Case 2: Completed pre-survey but tutorial is not in progress AND not completed (stopped between pre-survey and tutorial)
    if (hasPreSurvey && !tutorialCompleted() && !isInTutorial) {
        console.log('⚠️ CORRUPTED STATE: User completed pre-survey but stopped before tutorial');
        console.log('🧹 Resetting to brand new participant state...');
        
        // Clear ALL study workflow flags
        Object.entries(STORAGE_KEYS).forEach(([name, key]) => {
            localStorage.removeItem(key);
        });
        console.log('✅ All flags cleared - will restart from participant setup');
    }
    
    // 🔥 STUDY CLEAN MODE OR TUTORIAL_END: Reset EVERYTHING (always act like first time)
    const storedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('selectedMode') : null;
    const isTestMode = storedMode === 'tutorial_end';
    const isPureStudyClean = storedMode === 'study_clean';
    
    // Only clear EVERYTHING for pure study_clean and test modes
    // DO NOT clear for returning modes (W2 S1/S2 - they should act like returning users)
    if (isPureStudyClean || isTestMode) {
        const modeName = isPureStudyClean ? 'STUDY CLEAN MODE' : 'TUTORIAL_END MODE';
        console.log(`🧹 ${modeName}: Resetting to brand new participant state (always first time)`);
        
        // Clear participant ID
        localStorage.removeItem('participantId');
        console.log('   ✅ Cleared: participant ID');
        
        // Clear ALL study workflow flags
        const flagsCleared = [];
        Object.entries(STORAGE_KEYS).forEach(([name, key]) => {
            localStorage.removeItem(key);
            flagsCleared.push(name);
        });
        console.log(`   ✅ Cleared: ${flagsCleared.join(', ')}`);
        
        console.log('   🎭 Result: Will show FULL onboarding (Participant → Welcome → Pre-Survey → Tutorial)');
        console.log('   🎭 AWE-SF will show (simulates W1S1)');
    }
    
    // 🔥 STUCK STATE: Tutorial started but not completed? Resume tutorial
    if (isTutorialInProgress() && !tutorialCompleted()) {
        console.log('🔄 Tutorial in progress - opening tutorial intro modal to resume');
        const { openTutorialIntroModal } = await import('./ui-controls.js');
        openTutorialIntroModal();
        return; // Exit - tutorial modal will handle continuation
    }
    
    // 🔥 SIMPLE CHECK: Tutorial done but Begin Analysis not clicked? Show Welcome Back
    if (tutorialCompleted() && !hasBegunAnalysisThisSession()) {
        console.log('👋 SIMPLE CHECK: Tutorial done, Begin Analysis not clicked → Opening Welcome Back modal');
        
        // Enable all features for returning users (tutorial already completed)
        const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
        await enableAllTutorialRestrictedFeatures();
        console.log('✅ All features enabled for returning user (before Welcome Back modal)');
        
        const { openWelcomeBackModal } = await import('./ui-controls.js');
        openWelcomeBackModal();
        return; // Exit - modal will handle workflow continuation
    }
    
    // 🔥 RETURNING MODE (W2 S1 RETURNING): Mid-session, simulates page refresh after Begin Analysis
    const isReturningMidSession = storedMode === 'study_w2_s1_returning';
    if (isReturningMidSession) {
        console.log(`🔁 RETURNING MID-SESSION: Preserving in-progress session (simulates page refresh)`);
        
        // Get participant ID (needed for session creation)
        const participantId = getParticipantId();
        
        // Create an in-progress session with pre-survey data using saveSurveyResponse
        if (participantId) {
            const { saveSurveyResponse, trackSurveyStart } = await import('../Qualtrics/participant-response-manager.js');
            
            // Track that pre-survey was started
            trackSurveyStart(participantId, 'pre');
            
            // Save pre-survey responses (this automatically creates the session)
            const preSurveyData = {
                surveyType: 'pre',
                calm: '3',
                energized: '3',
                connected: '3',
                nervous: '3',
                focused: '3',
                wonder: '3',
                timestamp: new Date().toISOString(),
                submittedAt: new Date().toISOString()
            };
            
            saveSurveyResponse(participantId, 'pre', preSurveyData);
            
            console.log('   ✅ Created: in-progress session with pre-survey data');
        }
        
        // Set session completion tracker (simulates completed Week 1)
        const tracker = {
            week1: [true, true],   // Both Week 1 sessions complete
            week2: [false, false], // Starting Week 2 Session 1 (in progress)
            week3: [false, false]
        };
        localStorage.setItem(STORAGE_KEYS.SESSION_COMPLETION_TRACKER, JSON.stringify(tracker));
        console.log('   ✅ Set: session tracker (W1S1✅ W1S2✅ W2S1 in progress)');
        
        // Set BEGIN_ANALYSIS_CLICKED_THIS_SESSION = true (user already clicked it before refresh)
        localStorage.setItem(STORAGE_KEYS.BEGIN_ANALYSIS_CLICKED_THIS_SESSION, 'true');
        console.log('   ✅ Set: BEGIN_ANALYSIS_CLICKED_THIS_SESSION = true (volcano locked, button shows Complete)');
        
        // Set pre-survey completion date to today (already completed in this session)
        localStorage.setItem(STORAGE_KEYS.PRE_SURVEY_COMPLETION_DATE, getTodayDateString());
        console.log('   ✅ Set: PRE_SURVEY_COMPLETION_DATE = today (skip Welcome Back modal)');
        
        // Enable region creation (user already clicked Begin Analysis before refresh)
        const { setRegionCreationEnabled } = await import('./audio-state.js');
        setRegionCreationEnabled(true);
        console.log('   ✅ Enabled: region creation (Begin Analysis was clicked before refresh)');
        
        console.log('   🎭 Result: No modals → volcano locked → button shows "Complete" → can analyze');
    }
    
    // 🔥 RETURNING MODES (W2 S1 & S2): Set metadata to match real returning user state
    const isReturningMode = storedMode === 'study_w2_s1' || storedMode === 'study_w2_s2';
    if (isReturningMode) {
        console.log(`🧹 RETURNING MODE: Setting metadata for ${storedMode === 'study_w2_s1' ? 'Week 2, Session 1' : 'Week 2, Session 2'}`);
        
        // Get participant ID before clearing (we need to keep this!)
        const participantId = getParticipantId();
        
        // Clear session response data (pre-survey responses, session state)
        // This clears the "in-progress" session that makes the app think you're mid-session
        if (participantId) {
            const { clearSession } = await import('../Qualtrics/participant-response-manager.js');
            clearSession(participantId);
            console.log('   ✅ Cleared: session responses and state (removes in-progress session)');
        }
        
        // Clear SESSION-level flags only (NOT persistent onboarding/tutorial flags)
        const sessionFlagsToClear = [
            STORAGE_KEYS.HAS_SEEN_WELCOME_BACK,  // SESSION flag - clear so Welcome Back shows
            STORAGE_KEYS.PRE_SURVEY_COMPLETION_DATE,
            STORAGE_KEYS.CURRENT_SESSION_START,
            STORAGE_KEYS.BEGIN_ANALYSIS_CLICKED_THIS_SESSION  // SESSION flag - clear so volcano unlocked
        ];
        
        sessionFlagsToClear.forEach(key => {
            localStorage.removeItem(key);
        });
        
        // Set session completion tracker based on mode
        if (storedMode === 'study_w2_s1') {
            // Week 2, Session 1: Week 1 complete, starting new week
            const tracker = {
                week1: [true, true],   // Both Week 1 sessions complete
                week2: [false, false], // Starting Week 2 Session 1
                week3: [false, false]
            };
            localStorage.setItem(STORAGE_KEYS.SESSION_COMPLETION_TRACKER, JSON.stringify(tracker));
            console.log('   ✅ Set: session tracker (W1S1✅ W1S2✅ W2S1 starting)');
            console.log('   ✅ AWE-SF will SHOW (Session 1 of week)');
        } else {
            // Week 2, Session 2: Week 1 complete, W2S1 complete, starting W2S2
            const tracker = {
                week1: [true, true],   // Both Week 1 sessions complete
                week2: [true, false],  // W2S1 complete, starting W2S2
                week3: [false, false]
            };
            localStorage.setItem(STORAGE_KEYS.SESSION_COMPLETION_TRACKER, JSON.stringify(tracker));
            console.log('   ✅ Set: session tracker (W1S1✅ W1S2✅ W2S1✅ W2S2 starting)');
            console.log('   ✅ AWE-SF will NOT show (Session 2 of week)');
        }
        
        console.log('   ✅ Kept: participant ID, setup, welcome, TUTORIAL_COMPLETED flags');
        console.log('   🎭 Result: Will show Welcome Back → Pre-Survey → can select volcano → Begin Analysis');
    }
    
    // Disable waveform clicks initially (tutorial will enable when ready)
    const { disableWaveformClicks } = await import('./tutorial-effects.js');
    disableWaveformClicks();
    console.log('🔒 Waveform clicks disabled (will be enabled by tutorial)');
    
    // 🔒 Region creation disabled until tutorial starts OR Begin Analysis is pressed
    const { setRegionCreationEnabled } = await import('./audio-state.js');
    setRegionCreationEnabled(false); // Explicitly disable at start (will be enabled when tutorial starts)
    console.log('🔒 Region creation DISABLED (will be enabled when tutorial starts)');
    
    try {
        // ═══════════════════════════════════════════════════════════
        // DECISION: First visit ever?
        // ═══════════════════════════════════════════════════════════
        
        const isFirstVisitEver = !hasSeenParticipantSetup();
        console.log(`🔍 Is first visit ever? ${isFirstVisitEver}`);
        
        if (isFirstVisitEver) {
            // ═══════════════════════════════════════════════════════════
            // FIRST VISIT EVER WORKFLOW
            // ═══════════════════════════════════════════════════════════
            
            console.log('🆕 FIRST VISIT EVER - Full onboarding workflow');
            
            // Step 1: Participant Setup (once ever)
            console.log('📋 Step 1: Participant Setup (first time)');
            openParticipantModal();
            console.log('👤 Participant modal opened');
            // DON'T mark as seen here - mark it when user submits (in ui-controls.js event handler)
            
            // Step 2: Welcome (once ever)
            console.log('👋 Step 2: Welcome modal (first time)');
            // Note: Welcome modal will be opened by user clicking submit on participant modal
            // The event handler will call openWelcomeModal() after participant setup
            // DON'T mark as seen here - mark it when the modal is actually closed (in ui-controls.js)
            
    } else {
            // ═══════════════════════════════════════════════════════════
            // RETURNING VISIT WORKFLOW
            // ═══════════════════════════════════════════════════════════
            
            console.log('🔁 RETURNING VISIT - Skipping onboarding');
            
            // Check if tutorial is completed - if NOT, show tutorial intro modal
            if (!tutorialCompleted()) {
                console.log('🎓 Tutorial not completed - opening Tutorial Intro modal');
                const { openTutorialIntroModal } = await import('./ui-controls.js');
                openTutorialIntroModal();
                return; // Exit - tutorial modal will handle continuation
            }
            
            // Enable all features immediately for returning visits (no tutorial needed)
            const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
            await enableAllTutorialRestrictedFeatures();
            console.log('✅ All features enabled for returning visit');
            
            // 🔒 Region creation remains DISABLED until user clicks "Begin Analysis"
            // (Same as first visit - must click Begin Analysis to enable region creation)
            console.log('🔒 Region creation DISABLED for returning visit (will be enabled after Begin Analysis)');
            
            // For returning visits, check if they've clicked "Begin Analysis" THIS SESSION
            // If so, transform button to "Complete" mode AND re-enable region creation (restore session state)
            if (hasBegunAnalysisThisSession()) {
                console.log('👋 Welcome back! Hit Fetch Data to resume your session.');
                
                // Set status message with typing animation
                const { setStatusText } = await import('./tutorial-effects.js');
                setStatusText('👋 Welcome back! Hit Fetch Data to resume your session.', 'status info');
                
                // Enable region creation (user clicked Begin Analysis before refresh)
                const { setRegionCreationEnabled } = await import('./audio-state.js');
                setRegionCreationEnabled(true);
                console.log('✅ Region creation ENABLED (restoring state from before refresh)');
                
                // Transform the button (same logic as beginAnalysisConfirmed event)
                const completeBtn = document.getElementById('completeBtn');
                if (completeBtn && completeBtn.textContent === 'Begin Analysis') {
                    completeBtn.textContent = 'Complete';
                    completeBtn.style.background = '#28a745';
                    completeBtn.style.borderColor = '#28a745';
                    completeBtn.style.border = '2px solid #28a745';
                    completeBtn.style.color = 'white';
                    completeBtn.className = ''; // Remove begin-analysis-btn class
                    completeBtn.removeAttribute('onmouseover');
                    completeBtn.removeAttribute('onmouseout');
                    
                    // 🔥 FIX: Replace click handler to open Complete modal instead of Begin Analysis modal
                    const { openCompleteConfirmationModal } = await import('./ui-controls.js');
                    const newBtn = completeBtn.cloneNode(true);
                    completeBtn.parentNode.replaceChild(newBtn, completeBtn);
                    
                    // Add Complete button click handler
                    newBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        console.log('✅ Complete button clicked');
                        openCompleteConfirmationModal();
                    });
                    
                    console.log('✅ Button transformed to Complete mode with correct click handler');
                }
            } else {
                console.log('✅ Begin Analysis NOT clicked yet this session - button will show "Begin Analysis"');
            }
            
            // Button is always visible, just update its disabled state
            const { updateCompleteButtonState } = await import('./region-tracker.js');
            updateCompleteButtonState();
            console.log('✅ Complete button state updated for returning visit');
            
            // ═══════════════════════════════════════════════════════════
            // PRE-SURVEY (EVERY TIME - INCLUDING RETURNING VISITS)
            // ═══════════════════════════════════════════════════════════
            
            const participantId = getParticipantId();
            
            // Check if previous session was submitted (user completed their daily session)
            const sessionState = getSessionState(participantId);
            const sessionResponses = getSessionResponses(participantId);
            
            // Also check responses directly (in case sessionId mismatch)
            // getStorageKey is: `participant_response_${participantId}`
            let directResponses = null;
            try {
                const key = `participant_response_${participantId}`;
                const responsesJson = localStorage.getItem(key);
                if (responsesJson) {
                    directResponses = JSON.parse(responsesJson);
                }
            } catch (e) {
                // Ignore errors
            }
            
            console.log('🔍 Checking session state:', {
                sessionStateExists: !!sessionState,
                sessionStateStatus: sessionState?.status,
                sessionId: sessionState?.sessionId,
                sessionResponsesSubmitted: sessionResponses?.submitted,
                directResponsesSubmitted: directResponses?.submitted,
                hasQualtricsResponseId: !!(sessionResponses?.qualtricsResponseId || directResponses?.qualtricsResponseId)
            });
            
            // Check if session was submitted (either via session state status OR responses.submitted flag)
            const isSessionSubmitted = (sessionState && sessionState.status === 'submitted') || 
                                      (sessionResponses && sessionResponses.submitted === true) ||
                                      (directResponses && directResponses.submitted === true);
            
            if (isSessionSubmitted) {
                console.log('✅ Previous session was submitted - starting NEW session for today');
                console.log('🔄 Clearing submitted session and starting fresh');
                // Clear the submitted session - user is starting a new daily session
                // This also clears the pre-survey completion date
                await clearSessionForNewDay(participantId);
                console.log('📊 Starting new session - showing Pre-Survey');
                // Continue to show pre-survey below (don't return early)
            }
            
            // Check if pre-survey was completed today (for current in-progress session)
            const completedToday = hasCompletedPreSurveyToday();
            console.log('🔍 Pre-survey completion check:', {
                completedToday,
                completionDate: localStorage.getItem(STORAGE_KEYS.PRE_SURVEY_COMPLETION_DATE),
                today: getTodayDateString()
            });
            
            if (completedToday) {
                // Only skip pre-survey if session is still in-progress (not submitted)
                // If session was just cleared above, this will be null and we'll show pre-survey
                const currentSessionState = getSessionState(participantId);
                console.log('🔍 Current session state after checks:', {
                    exists: !!currentSessionState,
                    status: currentSessionState?.status
                });
                
                if (currentSessionState && currentSessionState.status === 'in-progress') {
                    console.log('📊 Pre-Survey already completed today for current session - skipping');
                    console.log('✅ User can proceed directly to experience');
                    // Button was already transformed above in the returning visit section
                    // Hide modal overlay (user is mid-session, no modals needed)
                    const { fadeOutOverlay } = await import('./ui-controls.js');
                    fadeOutOverlay();
                    // Don't show pre-survey modal - user can explore
                    return; // Exit early - user can explore
                } else {
                    // Session was cleared, doesn't exist, or was submitted - show pre-survey
                    console.log('📊 Pre-Survey completion date exists but session was cleared/submitted - showing Pre-Survey');
                    console.log('   Reason: Session state is', currentSessionState ? `status="${currentSessionState.status}"` : 'null');
                }
            }
            
            // Check if they've already seen Welcome Back AND clicked Begin Analysis
            // If Begin Analysis hasn't been clicked, clear the Welcome Back flag so they see it again
            if (!hasBegunAnalysisThisSession()) {
                console.log('🔄 Begin Analysis not clicked - clearing Welcome Back flag to show modal again');
                localStorage.removeItem(STORAGE_KEYS.HAS_SEEN_WELCOME_BACK);
            }
            
            // Check if pre-survey was completed on a different day
            const lastCompletionDate = localStorage.getItem(STORAGE_KEYS.PRE_SURVEY_COMPLETION_DATE);
            if (lastCompletionDate && lastCompletionDate !== getTodayDateString()) {
                console.log(`📅 Pre-Survey was completed on ${lastCompletionDate}, but today is ${getTodayDateString()} - clearing session`);
                // Clear the session for the new day
                await clearSessionForNewDay(participantId);
            }
            
            // Show Welcome Back if they haven't clicked Begin Analysis yet (even if they've seen it before reload)
            if (!hasSeenWelcomeBack() || !hasBegunAnalysisThisSession()) {
                console.log('👋 Step 2.5: Welcome Back (returning visit - not yet begun analysis)');
                // For returning visits, show welcome back modal first, then pre-survey
                const { openWelcomeBackModal } = await import('./ui-controls.js');
                openWelcomeBackModal();
                console.log('👋 Welcome Back modal opened (returning visit)');
                // Welcome Back modal will close and open pre-survey when user clicks "Start Now"
                return; // Exit early - welcome back modal event handler will continue workflow
            } else {
                console.log('👋 Welcome Back already seen this session AND Begin Analysis clicked, proceeding to Pre-Survey');
                // Fall through to pre-survey
            }
        }
        
        // ═══════════════════════════════════════════════════════════
        // PRE-SURVEY (EVERY TIME - FIRST VISIT EVER)
        // ═══════════════════════════════════════════════════════════
        
        console.log('📊 Step 3: Pre-Survey (required every session)');
        // Note: Pre-survey will be opened by user clicking submit on welcome modal
        // The event handler will call openPreSurveyModal() after welcome
        // Pre-survey will be closed by user clicking submit, which triggers the workflow to continue
    
        // ═══════════════════════════════════════════════════════════
        // TUTORIAL (FIRST TIME ONLY)
        // ═══════════════════════════════════════════════════════════
        
    // Region creation will be enabled when tutorial starts (tutorial requires it)
    // For first visit: disabled until tutorial starts
    // For returning visit: enabled below (line 297)
    
    if (!hasSeenTutorial()) {
            console.log('🎓 Step 4: Tutorial (first time)');
        // Tutorial intro modal will be opened by pre-survey submit handler
        // When user clicks "Begin Tutorial", the modal will start the tutorial
        // Note: Tutorial will be marked as seen when it completes
        console.log('💡 Waiting for tutorial intro modal - tutorial will start when user clicks "Begin Tutorial"');
    } else {
            console.log('✅ Step 4: Tutorial (skipped - already completed)');
        // Enable all features since tutorial won't run
        const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
        await enableAllTutorialRestrictedFeatures();
    }
    
        // ═══════════════════════════════════════════════════════════
        // EXPERIENCE (USER EXPLORES)
        // ═══════════════════════════════════════════════════════════
        
        console.log('🔍 Step 5: Explore data (user controls when to finish)');
    console.log('💡 User will click Submit button when ready to proceed');
    
        // Remaining steps (Activity Level, AWE-SF, Post-Survey, End) 
        // are handled by handleStudyModeSubmit() when user clicks Submit
        
    } catch (error) {
        console.error('❌ Error in study workflow:', error);
        // Clean up on error - close any open modals
        const { closeAllModals } = await import('./ui-controls.js');
        closeAllModals();
    }
}

// ═══════════════════════════════════════════════════════════
// 🎬 SUBMIT WORKFLOW (END OF SESSION)
// ═══════════════════════════════════════════════════════════

/**
 * Handle submit button click
 * Behavior depends on mode:
 * - STUDY modes: Full post-session survey workflow
 * - PERSONAL/DEV modes: Direct submission (no surveys)
 */
export async function handleStudyModeSubmit() {
    const { CURRENT_MODE, isStudyMode } = await import('./master-modes.js');
    
    // In STUDY mode: Show post-session surveys
    if (isStudyMode()) {
        console.log('🎓 Study Mode: Routing to post-session survey workflow');
        
        try {
            console.log('═══════════════════════════════════════════════════════════');
            console.log('📤 STUDY MODE: Submit workflow started');
            console.log('═══════════════════════════════════════════════════════════');
            
            // ═══════════════════════════════════════════════════════════
            // ACTIVITY LEVEL (EVERY TIME)
            // ═══════════════════════════════════════════════════════════
            
            console.log('📋 Step 6: Activity Level (every time)');
            console.log('🔄 Opening Activity Level modal...');
            
            // Open Activity Level modal - event handlers will chain the rest
            // Activity Level → AWE-SF (if needed) → Post-Survey → End
            openActivityLevelModal();
            const activityParticipantId = getParticipantId();
            if (activityParticipantId) trackSurveyStart(activityParticipantId, 'activityLevel');
            
            console.log('✅ Activity Level opened - event handlers will chain to AWE-SF → Post-Survey → End');
            console.log('💡 Workflow will complete when user finishes Post-Survey (handled by event handler)');
            
            // Workflow continues via event handlers:
            // Activity Level → AWE-SF (if needed) → Post-Survey → Qualtrics submission → End modal
            // Post-Survey event handler will handle submission and end modal
            
            return true;
            
        } catch (error) {
            console.error('❌ Fatal error in handleStudyModeSubmit:', error);
            console.error('Stack trace:', error.stack);
            const { closeAllModals } = await import('./ui-controls.js');
            closeAllModals(); // Clean up on error
            return false;
        }
    }
    
    // In PERSONAL/DEV mode: Direct submission (no surveys)
    console.log(`💾 ${CURRENT_MODE} Mode: Direct submission (no surveys)`);
    
    const { attemptSubmission } = await import('./ui-controls.js');
    await attemptSubmission(false);  // Direct submission
    
    return true;
}

// ═══════════════════════════════════════════════════════════
// 🛠️ HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════

/**
 * Run the tutorial workflow
 */
async function runTutorialWorkflow() {
    try {
        const { runInitialTutorial } = await import('./tutorial.js');
        await runInitialTutorial();
        console.log('✅ Tutorial completed');
    } catch (error) {
        console.error('Tutorial error:', error);
    }
}

/**
 * Update end modal content with current session data
 */
function updateEndModalContent(participantId, sessionCount) {
    const now = new Date();
    const timeString = now.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit',
        hour12: true 
    });
    
    const timeEl = document.getElementById('submissionTime');
    const idEl = document.getElementById('submissionParticipantId');
    const countEl = document.getElementById('sessionCount');
                
    if (timeEl) timeEl.textContent = timeString;
    if (idEl) idEl.textContent = participantId;
    if (countEl) countEl.textContent = sessionCount;
}
