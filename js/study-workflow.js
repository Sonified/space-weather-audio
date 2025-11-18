/**
 * study-workflow.js
 * Orchestrates the full Study Mode workflow with all visit rules
 * 
 * VISIT RULES:
 * ============
 * FIRST VISIT EVER:
 *   1. Participant Setup (once ever)
 *   2. Welcome (once ever)
 *   3. Pre-Survey (every time)
 *   4. Tutorial (once ever)
 *   5. Experience
 *   6. Activity Level (every time)
 *   7. AWE-SF (first time each week)
 *   8. Post-Survey (every time)
 *   9. End/Confirmation (every time)
 * 
 * SUBSEQUENT VISITS (SAME WEEK):
 *   1. Pre-Survey (every time)
 *   2. Experience
 *   3. Activity Level (every time)
 *   4. Post-Survey (every time)
 *   5. End/Confirmation (every time)
 * 
 * FIRST VISIT OF NEW WEEK:
 *   1. Pre-Survey (every time)
 *   2. Experience
 *   3. Activity Level (every time)
 *   4. AWE-SF (first time each week) ← Returns!
 *   5. Post-Survey (every time)
 *   6. End/Confirmation (every time)
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
    exportResponseMetadata
} from '../Qualtrics/participant-response-manager.js';

// ═══════════════════════════════════════════════════════════
// 📊 PERSISTENT FLAGS (localStorage)
// ═══════════════════════════════════════════════════════════

const STORAGE_KEYS = {
    HAS_SEEN_PARTICIPANT_SETUP: 'study_has_seen_participant_setup',
    HAS_SEEN_WELCOME: 'study_has_seen_welcome',
    HAS_SEEN_TUTORIAL: 'study_has_seen_tutorial',
    LAST_AWESF_DATE: 'study_last_awesf_date',
    WEEKLY_SESSION_COUNT: 'study_weekly_session_count',
    WEEK_START_DATE: 'study_week_start_date'
};

/**
 * Check if user has seen participant setup (once ever)
 */
export function hasSeenParticipantSetup() {
    // Always act like first time in clean/test modes
    if (isStudyCleanMode()) return false;
    const storedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('selectedMode') : null;
    if (storedMode === 'test_study_end') return false;
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
    // Always act like first time in clean/test modes
    if (isStudyCleanMode()) return false;
    const storedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('selectedMode') : null;
    if (storedMode === 'test_study_end') return false;
    return localStorage.getItem(STORAGE_KEYS.HAS_SEEN_WELCOME) === 'true';
}

function markWelcomeAsSeen() {
    localStorage.setItem(STORAGE_KEYS.HAS_SEEN_WELCOME, 'true');
    console.log('✅ Welcome marked as seen (forever)');
}

/**
 * Check if user has seen tutorial (once ever)
 */
export function hasSeenTutorial() {
    // Always act like first time in clean/test modes
    if (isStudyCleanMode()) return false;
    const storedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('selectedMode') : null;
    if (storedMode === 'test_study_end') return false;
    return localStorage.getItem(STORAGE_KEYS.HAS_SEEN_TUTORIAL) === 'true';
}

export function markTutorialAsSeen() {
    localStorage.setItem(STORAGE_KEYS.HAS_SEEN_TUTORIAL, 'true');
    console.log('✅ Tutorial marked as seen (forever)');
}

/**
 * Check if AWE-SF has been completed this week
 */
export function hasCompletedAwesfThisWeek() {
    // Always act like first time in clean/test modes (always show AWE-SF)
    if (isStudyCleanMode()) return false;
    const storedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('selectedMode') : null;
    if (storedMode === 'test_study_end') return false;
    
    const lastDate = localStorage.getItem(STORAGE_KEYS.LAST_AWESF_DATE);
    if (!lastDate) return false;
    
    const lastAwesfDate = new Date(lastDate);
    const now = new Date();
    
    // Get start of this week (Sunday)
    const startOfWeek = new Date(now);
    startOfWeek.setHours(0, 0, 0, 0);
    startOfWeek.setDate(now.getDate() - now.getDay());
    
    const completed = lastAwesfDate >= startOfWeek;
    console.log(`🔍 AWE-SF check: last=${lastDate}, startOfWeek=${startOfWeek.toISOString()}, completed=${completed}`);
    return completed;
}

function markAwesfCompleted() {
    const now = new Date().toISOString();
    localStorage.setItem(STORAGE_KEYS.LAST_AWESF_DATE, now);
    console.log(`✅ AWE-SF marked as completed (week of ${now})`);
}

/**
 * Get session count for this week
 */
function getSessionCountThisWeek() {
    if (isStudyCleanMode()) return 0;
    
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
        return 0;
    }
}

export function incrementSessionCount() {
    const currentCount = getSessionCountThisWeek();
    const newCount = currentCount + 1;
    localStorage.setItem(STORAGE_KEYS.WEEKLY_SESSION_COUNT, newCount.toString());
    console.log(`📊 Session count incremented: ${newCount} this week`);
    return newCount;
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
    
    // 🔥 STUDY CLEAN MODE OR TEST_STUDY_END: Reset EVERYTHING (always act like first time)
    const storedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('selectedMode') : null;
    const isTestMode = storedMode === 'test_study_end';
    
    if (isStudyCleanMode() || isTestMode) {
        const modeName = isStudyCleanMode() ? 'STUDY CLEAN MODE' : 'TEST_STUDY_END MODE';
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
        console.log('   🎭 AWE-SF will always show (first time each week)');
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
            
            // Enable all features immediately for returning visits (no tutorial needed)
            const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
            await enableAllTutorialRestrictedFeatures();
            console.log('✅ All features enabled for returning visit');
            
            // Enable region creation for returning visits
            const { setRegionCreationEnabled } = await import('./audio-state.js');
            setRegionCreationEnabled(true);
            console.log('✅ Region creation enabled for returning visit');
            
            // For returning visits, ensure Begin Analysis button is visible
            // (It starts visible, tutorial hides it - but returning visits skip tutorial)
            const { updateCompleteButtonState } = await import('./region-tracker.js');
            updateCompleteButtonState();
            console.log('✅ Begin Analysis button state updated for returning visit');
            
            // ═══════════════════════════════════════════════════════════
            // PRE-SURVEY (EVERY TIME - INCLUDING RETURNING VISITS)
            // ═══════════════════════════════════════════════════════════
            
            console.log('📊 Step 3: Pre-Survey (required every session)');
            // For returning visits, open pre-survey directly (no welcome modal)
            const { openPreSurveyModal } = await import('./ui-controls.js');
            openPreSurveyModal();
            console.log('📊 Pre-Survey modal opened (returning visit)');
            // Pre-survey will be closed by user clicking submit, which triggers the workflow to continue
            return; // Exit early - pre-survey event handler will continue workflow
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
    const { CURRENT_MODE, isStudyMode, isStudyEndMode } = await import('./master-modes.js');
    
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
