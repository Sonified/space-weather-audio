/**
 * study-workflow.js
 * Orchestrates the full Study Mode workflow:
 * 1. Participant Setup (first time only)
 * 2. Pre-Survey (every time)
 * 3. Tutorial (first time only)
 * 4. [User explores data]
 * 5. Activity Level + AWE-SF (AWE-SF only first time each week)
 * 6. Post-Survey (every time)
 * 7. Submit to Qualtrics
 */

import { isStudyMode, isStudyCleanMode } from './master-modes.js';
import { 
    openParticipantModal,
    openWelcomeModal,
    closeWelcomeModal,
    openPreSurveyModal,
    openActivityLevelModal,
    openAwesfModal,
    openPostSurveyModal,
    openEndModal,
    closeEndModal,
    attemptSubmission
} from './ui-controls.js';
import { getParticipantId } from './qualtrics-api.js';

/**
 * Fade out the permanent overlay background
 * Called after pre-survey completes to allow user interaction
 */
function fadeOutPermanentOverlay() {
    const overlay = document.getElementById('permanentOverlay');
    if (!overlay) {
        console.warn('⚠️ Permanent overlay not found');
        return;
    }
    
    // Add transition for smooth fade-out
    overlay.style.transition = 'opacity 0.5s ease-out';
    
    // Fade out
    overlay.style.opacity = '0';
    
    // Hide completely after fade completes
    setTimeout(() => {
        overlay.style.display = 'none';
        console.log('✅ Permanent overlay faded out');
    }, 500); // Match transition duration
}

// Local storage keys for persistent flags
const STORAGE_KEYS = {
    HAS_SEEN_TUTORIAL: 'study_has_seen_tutorial',
    HAS_SEEN_PARTICIPANT_SETUP: 'study_has_seen_participant_setup',
    HAS_SEEN_WELCOME: 'study_has_seen_welcome',
    LAST_AWESF_DATE: 'study_last_awesf_date',
    WEEKLY_SESSION_COUNT: 'study_weekly_session_count',
    WEEK_START_DATE: 'study_week_start_date'
};

/**
 * Check if user has seen tutorial before
 * In STUDY_CLEAN mode, always returns false (acts like brand new)
 */
function hasSeenTutorial() {
    if (isStudyCleanMode()) return false;
    return localStorage.getItem(STORAGE_KEYS.HAS_SEEN_TUTORIAL) === 'true';
}

/**
 * Mark tutorial as seen
 */
function markTutorialAsSeen() {
    localStorage.setItem(STORAGE_KEYS.HAS_SEEN_TUTORIAL, 'true');
    console.log('✅ Tutorial marked as seen');
}

/**
 * Check if user has seen participant setup before
 * In STUDY_CLEAN mode, always returns false (acts like brand new)
 */
function hasSeenParticipantSetup() {
    if (isStudyCleanMode()) return false;
    return localStorage.getItem(STORAGE_KEYS.HAS_SEEN_PARTICIPANT_SETUP) === 'true';
}

/**
 * Mark participant setup as seen
 */
function markParticipantSetupAsSeen() {
    localStorage.setItem(STORAGE_KEYS.HAS_SEEN_PARTICIPANT_SETUP, 'true');
    console.log('✅ Participant setup marked as seen');
}

/**
 * Check if AWE-SF has been completed this week
 * In STUDY_CLEAN mode, always returns false (acts like brand new)
 * @returns {boolean}
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
    
    return lastAwesfDate >= startOfWeek;
}

/**
 * Mark AWE-SF as completed today
 */
function markAwesfCompleted() {
    localStorage.setItem(STORAGE_KEYS.LAST_AWESF_DATE, new Date().toISOString());
    console.log('✅ AWE-SF marked as completed for this week');
}

/**
 * Get session count for this week
 * In STUDY_CLEAN mode, always returns 0 (acts like brand new)
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
        return 0;
    }
}

/**
 * Increment session count for this week
 */
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
    localStorage.removeItem(STORAGE_KEYS.HAS_SEEN_TUTORIAL);
    localStorage.removeItem(STORAGE_KEYS.HAS_SEEN_PARTICIPANT_SETUP);
    localStorage.removeItem(STORAGE_KEYS.LAST_AWESF_DATE);
    localStorage.removeItem(STORAGE_KEYS.WEEKLY_SESSION_COUNT);
    localStorage.removeItem(STORAGE_KEYS.WEEK_START_DATE);
    console.log('🔄 All study flags reset - refresh page to experience full workflow');
}

/**
 * Start the Study Mode workflow
 * This is called on page load when in Study Mode
 */
export async function startStudyWorkflow() {
    // Import CURRENT_MODE to check what mode we're actually in
    const { CURRENT_MODE, isStudyMode, isStudyCleanMode } = await import('./master-modes.js');
    
    console.log(`🔍 startStudyWorkflow check: CURRENT_MODE=${CURRENT_MODE}, isStudyMode()=${isStudyMode()}, isStudyCleanMode()=${isStudyCleanMode()}`);
    
    if (!isStudyMode()) {
        console.warn('⚠️ Study workflow only available in Study Mode');
        console.warn(`⚠️ Current mode is: ${CURRENT_MODE}`);
        return;
    }
    
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`🎓 STUDY MODE: Starting workflow (mode: ${CURRENT_MODE})`);
    console.log('═══════════════════════════════════════════════════════════');
    
    // Study Clean Mode: Clear participant ID from localStorage (always start fresh)
    if (isStudyCleanMode()) {
        localStorage.removeItem('participantId');
        console.log('🧹 Study Clean Mode: Cleared participant ID from localStorage');
    }
    
    // Disable waveform clicks initially - tutorial will enable when it reaches that step
    const { disableWaveformClicks } = await import('./tutorial-effects.js');
    disableWaveformClicks();
    console.log('🔒 Waveform clicks disabled (will be enabled by tutorial)');
    
    // Step 1: Participant Setup (first time only)
    const hasSeenSetup = hasSeenParticipantSetup();
    console.log(`🔍 hasSeenParticipantSetup() = ${hasSeenSetup}, isStudyCleanMode() = ${isStudyCleanMode()}`);
    
    if (!hasSeenSetup) {
        console.log('📋 Step 1: Participant Setup (first time)');
        await showParticipantSetupModal();
        markParticipantSetupAsSeen();
        
        // Show Welcome modal after participant setup (first time only)
        console.log('👋 Step 1.5: Welcome modal (first time)');
        await showWelcomeModalAndWait();
        // Mark welcome modal as seen
        localStorage.setItem(STORAGE_KEYS.HAS_SEEN_WELCOME, 'true');
    } else {
        console.log('✅ Step 1: Participant Setup (skipped - already completed)');
        // Explicitly ensure welcome modal is closed if setup was already seen
        const welcomeModal = document.getElementById('welcomeModal');
        if (welcomeModal) {
            welcomeModal.style.display = 'none';
        }
    }
    
    // Step 2: Pre-Survey (every time)
    console.log('📋 Step 2: Pre-Survey (required every session)');
    
    // CRITICAL: Explicitly ensure welcome modal is closed before opening pre-survey
    const welcomeModal = document.getElementById('welcomeModal');
    if (welcomeModal && welcomeModal.style.display !== 'none') {
        console.warn('⚠️ Welcome modal still open - closing before pre-survey');
        welcomeModal.style.display = 'none';
        // Small delay to ensure it's closed
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log('🔍 About to show pre-survey modal...');
    await showPreSurveyModalAndWait();
    console.log('✅ Pre-survey modal completed');
    
    // Step 3: Tutorial (first time only)
    if (!hasSeenTutorial()) {
        console.log('🎓 Step 3: Tutorial (first time)');
        await runTutorialWorkflow();
        markTutorialAsSeen();
    } else {
        console.log('✅ Step 3: Tutorial (skipped - already completed)');
        // Enable all features since tutorial won't run
        const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
        enableAllTutorialRestrictedFeatures();
    }
    
    // Step 4: User explores data freely
    console.log('🔍 Step 4: Explore data (user controls when to finish)');
    console.log('💡 User will click Submit button when ready to proceed');
    
    // Steps 5-7 are handled by the Submit button (see setupSubmitWorkflow below)
}

/**
 * Show participant setup modal and wait for completion
 */
function showParticipantSetupModal() {
    return new Promise((resolve) => {
        openParticipantModal();
        
        const modal = document.getElementById('participantModal');
        if (!modal) {
            console.warn('⚠️ Participant modal not found');
            resolve();
            return;
        }
        
        // Wait for modal to close AND participant ID to be set
        const checkComplete = setInterval(() => {
            const participantId = getParticipantId();
            const isModalClosed = modal.style.display === 'none';
            
            if (participantId && isModalClosed) {
                clearInterval(checkComplete);
                console.log('✅ Participant ID set:', participantId);
                // Small delay to ensure modal is fully closed before next modal opens
                setTimeout(() => resolve(), 100);
            }
        }, 100); // Check more frequently for better responsiveness
    });
}

/**
 * Show pre-survey modal and wait for completion
 */
function showPreSurveyModalAndWait() {
    return new Promise((resolve) => {
        // Small delay to ensure previous modal is fully closed
        setTimeout(() => {
            openPreSurveyModal();
            
            // Listen for pre-survey modal to close
            const modal = document.getElementById('preSurveyModal');
            if (!modal) {
                console.warn('⚠️ Pre-survey modal not found');
                resolve();
                return;
            }
            
            const checkClosed = setInterval(() => {
                if (modal.style.display === 'none') {
                    clearInterval(checkClosed);
                    console.log('✅ Pre-survey completed');
                    // Fade out the permanent overlay after pre-survey completes
                    fadeOutPermanentOverlay();
                    resolve();
                }
            }, 100); // Check more frequently for better responsiveness
        }, 200); // Wait 200ms before opening to ensure previous modal is closed
    });
}

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
 * Setup the Submit button workflow for Study Mode
 * This handles the post-analysis surveys and submission
 */
export function setupSubmitWorkflow() {
    if (!isStudyMode()) return;
    
    console.log('📋 Study Mode: Submit button will trigger post-session surveys');
}

/**
 * Handle submit button click in Study Mode
 * Shows Activity Level, AWE-SF (if needed), Post-Survey, then submits to Qualtrics
 * @returns {Promise<boolean>} True if workflow completed, false if cancelled
 */
export async function handleStudyModeSubmit() {
    if (!isStudyMode()) {
        console.warn('⚠️ handleStudyModeSubmit called but not in Study Mode');
        return false;
    }
    
    console.log('═══════════════════════════════════════════════════════════');
    console.log('📤 STUDY MODE: Submit workflow started');
    console.log('═══════════════════════════════════════════════════════════');
    
    // Step 5: Activity Level
    console.log('📋 Step 5: Activity Level');
    const activityCompleted = await showActivityLevelModalAndWait();
    if (!activityCompleted) {
        console.log('❌ Activity Level cancelled - aborting submit');
        return false;
    }
    
    // Step 6: AWE-SF (only first time each week)
    if (!hasCompletedAwesfThisWeek()) {
        console.log('📋 Step 6: AWE-SF (first time this week)');
        const awesfCompleted = await showAwesfModalAndWait();
        if (!awesfCompleted) {
            console.log('❌ AWE-SF cancelled - aborting submit');
            return false;
        }
        markAwesfCompleted();
    } else {
        console.log('✅ Step 6: AWE-SF (skipped - already completed this week)');
    }
    
    // Step 7: Post-Survey
    console.log('📋 Step 7: Post-Survey');
    const postCompleted = await showPostSurveyModalAndWait();
    if (!postCompleted) {
        console.log('❌ Post-Survey cancelled - aborting submit');
        return false;
    }
    
    // Step 8: Submit to Qualtrics
    console.log('📤 Step 8: Submitting to Qualtrics');
    await attemptSubmission();
    
    // Step 9: Show End modal with session count
    console.log('🎉 Step 9: Showing completion modal');
    const participantId = getParticipantId();
    const sessionCount = incrementSessionCount();
    await showEndModalAndWait(participantId, sessionCount);
    
    console.log('═══════════════════════════════════════════════════════════');
    console.log('✅ STUDY MODE: Workflow complete!');
    console.log('═══════════════════════════════════════════════════════════');
    
    return true;
}

/**
 * Show Welcome modal and wait for completion
 * Only shows if participant setup has been completed
 */
async function showWelcomeModalAndWait() {
    // Note: This is called right after markParticipantSetupAsSeen(), so setup is complete
    // The openWelcomeModal() function has its own guard check, so we don't need one here
    
    const modal = document.getElementById('welcomeModal');
    if (!modal) {
        console.warn('⚠️ Welcome modal not found');
        return true;
    }
    
    await openWelcomeModal();
    
    // Verify modal was actually opened
    if (modal.style.display === 'none') {
        console.warn('⚠️ Welcome modal failed to open (check console for openWelcomeModal warnings)');
        return true;
    }
    
    return new Promise((resolve) => {
        const checkClosed = setInterval(() => {
            if (modal.style.display === 'none') {
                clearInterval(checkClosed);
                console.log('✅ Welcome modal completed');
                // Small delay to ensure modal is fully closed before next modal opens
                setTimeout(() => resolve(true), 200);
            }
        }, 100); // Check more frequently for better responsiveness
    });
}

/**
 * Show End modal and wait for completion
 */
function showEndModalAndWait(participantId, sessionCount) {
    return new Promise((resolve) => {
        openEndModal(participantId, sessionCount);
        
        const modal = document.getElementById('endModal');
        if (!modal) {
            console.warn('⚠️ End modal not found');
            resolve(true);
            return;
        }
        
        const checkClosed = setInterval(() => {
            if (modal.style.display === 'none') {
                clearInterval(checkClosed);
                console.log('✅ End modal completed');
                resolve(true);
            }
        }, 500);
    });
}

/**
 * Show Activity Level modal and wait for completion
 */
function showActivityLevelModalAndWait() {
    return new Promise((resolve) => {
        openActivityLevelModal();
        
        const modal = document.getElementById('activityLevelModal');
        if (!modal) {
            console.warn('⚠️ Activity Level modal not found');
            resolve(false);
            return;
        }
        
        const checkClosed = setInterval(() => {
            if (modal.style.display === 'none') {
                clearInterval(checkClosed);
                console.log('✅ Activity Level completed');
                resolve(true);
            }
        }, 500);
    });
}

/**
 * Show AWE-SF modal and wait for completion
 */
function showAwesfModalAndWait() {
    return new Promise((resolve) => {
        openAwesfModal();
        
        const modal = document.getElementById('awesfModal');
        if (!modal) {
            console.warn('⚠️ AWE-SF modal not found');
            resolve(false);
            return;
        }
        
        const checkClosed = setInterval(() => {
            if (modal.style.display === 'none') {
                clearInterval(checkClosed);
                console.log('✅ AWE-SF completed');
                resolve(true);
            }
        }, 500);
    });
}

/**
 * Show Post-Survey modal and wait for completion
 */
function showPostSurveyModalAndWait() {
    return new Promise((resolve) => {
        openPostSurveyModal();
        
        const modal = document.getElementById('postSurveyModal');
        if (!modal) {
            console.warn('⚠️ Post-Survey modal not found');
            resolve(false);
            return;
        }
        
        const checkClosed = setInterval(() => {
            if (modal.style.display === 'none') {
                clearInterval(checkClosed);
                console.log('✅ Post-Survey completed');
                resolve(true);
            }
        }, 500);
    });
}

// Expose resetStudyFlags to window for easy console access during testing
if (typeof window !== 'undefined') {
    window.resetStudyFlags = resetStudyFlags;
}

