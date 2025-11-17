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
import { modalManager } from './modal-manager.js';
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
function hasSeenParticipantSetup() {
    if (isStudyCleanMode()) return false;
    return localStorage.getItem(STORAGE_KEYS.HAS_SEEN_PARTICIPANT_SETUP) === 'true';
}

function markParticipantSetupAsSeen() {
    localStorage.setItem(STORAGE_KEYS.HAS_SEEN_PARTICIPANT_SETUP, 'true');
    console.log('✅ Participant setup marked as seen (forever)');
}

/**
 * Check if user has seen welcome modal (once ever)
 */
function hasSeenWelcome() {
    if (isStudyCleanMode()) return false;
    return localStorage.getItem(STORAGE_KEYS.HAS_SEEN_WELCOME) === 'true';
}

function markWelcomeAsSeen() {
    localStorage.setItem(STORAGE_KEYS.HAS_SEEN_WELCOME, 'true');
    console.log('✅ Welcome marked as seen (forever)');
}

/**
 * Check if user has seen tutorial (once ever)
 */
function hasSeenTutorial() {
    if (isStudyCleanMode()) return false;
    return localStorage.getItem(STORAGE_KEYS.HAS_SEEN_TUTORIAL) === 'true';
}

function markTutorialAsSeen() {
    localStorage.setItem(STORAGE_KEYS.HAS_SEEN_TUTORIAL, 'true');
    console.log('✅ Tutorial marked as seen (forever)');
}

/**
 * Check if AWE-SF has been completed this week
 */
function hasCompletedAwesfThisWeek() {
    if (isStudyCleanMode()) return false;
    
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

function incrementSessionCount() {
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
    
    // 🔥 STUDY CLEAN MODE: Reset EVERYTHING
    if (isStudyCleanMode()) {
        console.log('🧹 STUDY CLEAN MODE: Resetting to brand new participant state');
        
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
    }
    
    // Disable waveform clicks initially (tutorial will enable when ready)
    const { disableWaveformClicks } = await import('./tutorial-effects.js');
    disableWaveformClicks();
    console.log('🔒 Waveform clicks disabled (will be enabled by tutorial)');
    
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
            await modalManager.openModal('participantModal', {
                keepOverlay: true,
                onOpen: () => console.log('👤 Participant modal opened')
            });
        markParticipantSetupAsSeen();
        
            // Step 2: Welcome (once ever)
            console.log('👋 Step 2: Welcome modal (first time)');
            await modalManager.swapModal('welcomeModal');
            markWelcomeAsSeen();
            
    } else {
            // ═══════════════════════════════════════════════════════════
            // RETURNING VISIT WORKFLOW
            // ═══════════════════════════════════════════════════════════
            
            console.log('🔁 RETURNING VISIT - Skipping onboarding');
        }
        
        // ═══════════════════════════════════════════════════════════
        // PRE-SURVEY (EVERY TIME)
        // ═══════════════════════════════════════════════════════════
        
        console.log('📊 Step 3: Pre-Survey (required every session)');
    
        // If welcome was open, swap. Otherwise open fresh.
        if (modalManager.currentModal === 'welcomeModal') {
            await modalManager.swapModal('preSurveyModal');
        } else {
            await modalManager.openModal('preSurveyModal', {
                keepOverlay: true,
                onOpen: () => {
                    const participantId = getParticipantId();
                    if (participantId) trackSurveyStart(participantId, 'pre');
                }
            });
    }
    
        console.log('✅ Pre-survey completed');
        
        // Close pre-survey and fade out overlay (back to app)
        await modalManager.closeModal('preSurveyModal', {
            keepOverlay: false
        });
    
        // ═══════════════════════════════════════════════════════════
        // TUTORIAL (FIRST TIME ONLY)
        // ═══════════════════════════════════════════════════════════
        
    // Enable region creation before tutorial (tutorial requires waveform clicks)
    const { setRegionCreationEnabled } = await import('./audio-state.js');
    setRegionCreationEnabled(true);
    
    if (!hasSeenTutorial()) {
            console.log('🎓 Step 4: Tutorial (first time)');
        await runTutorialWorkflow();
        markTutorialAsSeen();
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
        await modalManager.closeModal();  // Clean up on error
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
            await modalManager.openModal('activityLevelModal', {
                keepOverlay: true,
                onOpen: () => {
            const participantId = getParticipantId();
                    if (participantId) trackSurveyStart(participantId, 'activityLevel');
                }
            });
            console.log('✅ Activity Level completed');
            
            // ═══════════════════════════════════════════════════════════
            // AWE-SF (FIRST TIME EACH WEEK)
            // ═══════════════════════════════════════════════════════════
            
            const needsAwesf = !hasCompletedAwesfThisWeek();
            console.log(`🔍 AWE-SF check: needsAwesf=${needsAwesf}`);
            
            if (needsAwesf) {
                console.log('📋 Step 7: AWE-SF (first time this week)');
                await modalManager.swapModal('awesfModal');
                markAwesfCompleted();
                console.log('✅ AWE-SF completed');
            } else {
                console.log('✅ Step 7: AWE-SF (skipped - already completed this week)');
            }
            
            // ═══════════════════════════════════════════════════════════
            // POST-SURVEY (EVERY TIME)
            // ═══════════════════════════════════════════════════════════
            
            console.log('📋 Step 8: Post-Survey (every time)');
            await modalManager.swapModal('postSurveyModal');
            console.log('✅ Post-Survey completed');
                    
            // ═══════════════════════════════════════════════════════════
            // SUBMIT TO QUALTRICS
            // ═══════════════════════════════════════════════════════════
            
            console.log('📤 Step 9: Submitting to Qualtrics');
            const { attemptSubmission } = await import('./ui-controls.js');
            await attemptSubmission(true);  // fromWorkflow=true
            
            // ═══════════════════════════════════════════════════════════
            // END/CONFIRMATION (EVERY TIME)
            // ═══════════════════════════════════════════════════════════
            
            console.log('🎉 Step 10: Showing completion modal (every time)');
                    const participantId = getParticipantId();
            const sessionCount = incrementSessionCount();
            
            // Update end modal content before showing
            updateEndModalContent(participantId, sessionCount);
            
            await modalManager.swapModal('endModal');
            
            // End modal will close with full fade-out when user clicks "Close"
            // (handled by button event listener in ui-controls.js)
            
            console.log('═══════════════════════════════════════════════════════════');
            console.log('✅ STUDY MODE: Workflow complete!');
            console.log('═══════════════════════════════════════════════════════════');
            
            return true;
            
        } catch (error) {
            console.error('❌ Fatal error in handleStudyModeSubmit:', error);
            console.error('Stack trace:', error.stack);
            await modalManager.closeModal();  // Clean up on error
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
