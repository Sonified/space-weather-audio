/**
 * master-modes.js
 * Centralized mode management for solar-audio
 * Controls tutorial flow, surveys, and Qualtrics integration
 */

/**
 * Available Application Modes
 *
 * ⚠️ TEST MODE PHILOSOPHY: Test modes ONLY set flags. All behavior comes from REAL LOGIC
 *    that checks those flags. Never add special cases for test modes - fix the logic instead.
 *
 * PERSONAL: Skip tutorial, direct access to app
 * DEV: Current development environment with tutorial
 * PRODUCTION: Solar Audio Study Live Interface - What users get when they show up
 * STUDY_CLEAN: Same as PRODUCTION but resets all flags on each load (for testing first-time users)
 * STUDY_W2_S1: Week 2, Session 1 - Sets flags for returning user (W1 complete, starting W2S1)
 * STUDY_W2_S1_RETURNING: Week 2, Session 1 - Mid-session (already clicked Begin Analysis, simulates page refresh)
 * STUDY_W2_S2: Week 2, Session 2 - Sets flags for returning user (W1 complete, W2S1 complete, starting W2S2)
 * TUTORIAL_END: Test mode - jump to last 2 messages of tutorial (tests tutorial completion flow)
 */
export const AppMode = {
    PERSONAL: 'personal',
    DEV: 'dev',
    PRODUCTION: 'production',
    STUDY_CLEAN: 'study_clean',
    STUDY_W2_S1: 'study_w2_s1',  // Week 2, Session 1 - starting new session
    STUDY_W2_S1_RETURNING: 'study_w2_s1_returning',  // Week 2, Session 1 - mid-session (page refresh)
    STUDY_W2_S2: 'study_w2_s2',  // Week 2, Session 2
    TUTORIAL_END: 'tutorial_end',
    SOLAR_PORTAL: 'solar_portal'  // Solar Portal mode - participant setup only, no study workflow
};

/**
 * ═══════════════════════════════════════════════════════════
 * 🎯 MODE SELECTION - Can be changed via UI dropdown or here
 * ═══════════════════════════════════════════════════════════
 */
export const DEFAULT_MODE = AppMode.PERSONAL; // Default if no localStorage selection

/**
 * Detect if running locally vs production
 * Returns true if running on localhost, 127.0.0.1, or file:// protocol
 */
export function isLocalEnvironment() {
    if (typeof window === 'undefined') return false;
    
    const hostname = window.location.hostname;
    const protocol = window.location.protocol;
    
    // Check for localhost, 127.0.0.1, or file:// protocol
    return hostname === 'localhost' || 
           hostname === '127.0.0.1' || 
           hostname === '' ||
           protocol === 'file:';
}

// Check localStorage for user's mode selection (set by dropdown)
// Falls back to DEFAULT_MODE if not set
let storedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('selectedMode') : null;

// Backward compatibility: map old "study" to new "production"
if (storedMode === 'study') {
    storedMode = 'production';
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem('selectedMode', 'production');
    }
}

// Production: Always force PERSONAL mode (changed from PRODUCTION)
// Local: Allow mode switching via localStorage or DEFAULT_MODE
export const CURRENT_MODE = isLocalEnvironment()
    ? (storedMode && Object.values(AppMode).includes(storedMode) 
        ? storedMode 
        : DEFAULT_MODE)
    : AppMode.PERSONAL; // Force PERSONAL mode for production (was AppMode.PRODUCTION)

/**
 * Mode Configuration
 * Each mode defines what features and flows are enabled
 */
const MODE_CONFIG = {
    [AppMode.PERSONAL]: {
        name: 'Personal Mode',
        description: 'Direct app access without tutorial or surveys',
        skipTutorial: true,
        showPreSurveys: false,
        showPostSurveys: false,
        requireQualtricsSubmission: false,
        enableAdminFeatures: true,
        showSubmitButton: true, // For saving regions/features
        autoStartPlayback: false
    },
    
    [AppMode.DEV]: {
        name: 'Development Mode',
        description: 'Current development environment with tutorial',
        skipTutorial: false,
        showPreSurveys: false,
        showPostSurveys: false,
        requireQualtricsSubmission: false,
        enableAdminFeatures: true,
        showSubmitButton: true,
        autoStartPlayback: false
    },
    
    [AppMode.PRODUCTION]: {
        name: 'Production Mode',
        description: 'Solar Audio Study Live Interface',
        skipTutorial: false,
        showPreSurveys: true,
        showPostSurveys: true,
        requireQualtricsSubmission: true,
        enableAdminFeatures: false,
        showSubmitButton: true,
        autoStartPlayback: false,
        // Study-specific config
        requireResponseId: true, // Must have Qualtrics ResponseID in URL
        showProgressIndicator: true, // Show "Step 1 of 4: Pre-Survey" etc.
        enforceSequence: true // Must complete steps in order
    },
    
    [AppMode.STUDY_CLEAN]: {
        name: 'Study Clean Mode',
        description: 'Full research workflow with surveys and Qualtrics (resets flags on each load)',
        skipTutorial: false,
        showPreSurveys: true,
        showPostSurveys: true,
        requireQualtricsSubmission: true,
        enableAdminFeatures: false,
        showSubmitButton: true,
        autoStartPlayback: false,
        // Study-specific config
        requireResponseId: true, // Must have Qualtrics ResponseID in URL
        showProgressIndicator: true, // Show "Step 1 of 4: Pre-Survey" etc.
        enforceSequence: true, // Must complete steps in order
        resetFlagsOnLoad: true // Reset all study flags on each load
    },
    
    [AppMode.STUDY_W2_S1]: {
        name: 'Study W2 S1',
        description: 'Week 2, Session 1 - All Week 1 sessions complete, starting new week',
        skipTutorial: true, // Already completed tutorial in Week 1
        showPreSurveys: true,
        showPostSurveys: true,
        requireQualtricsSubmission: false,  // TEST MODE - don't submit to Qualtrics
        enableAdminFeatures: false,
        showSubmitButton: true,
        autoStartPlayback: false,
        // Study-specific config
        requireResponseId: true,
        showProgressIndicator: true,
        enforceSequence: true,
        resetFlagsOnLoad: true,
        // Test mode config (sets flags to simulate returning user state)
        simulateReturningUser: true,
        simulatedWeek: 2,
        simulatedSession: 1,
        completedSessions: {
            week1: [true, true],  // Week 1 both sessions complete
            week2: [false, false],
            week3: [false, false]
        },
        forceWelcomeBackModal: true,
        showAwesfSurvey: true  // First session of new week = AWE-SF appears
    },
    
    [AppMode.STUDY_W2_S1_RETURNING]: {
        name: 'Study W2 S1 Returning',
        description: 'Week 2, Session 1 - Mid-session (Begin Analysis clicked, simulates page refresh)',
        skipTutorial: true, // Already completed tutorial in Week 1
        showPreSurveys: true,
        showPostSurveys: true,
        requireQualtricsSubmission: false,  // TEST MODE - don't submit to Qualtrics
        enableAdminFeatures: false,
        showSubmitButton: true,
        autoStartPlayback: false,
        // Study-specific config
        requireResponseId: true,
        showProgressIndicator: true,
        enforceSequence: true,
        resetFlagsOnLoad: false,  // Don't clear session data - we're mid-session
        // Test mode config (sets flags to simulate mid-session state)
        simulateReturningUser: true,
        simulateInProgressSession: true,  // Key difference - preserve in-progress session
        simulatedWeek: 2,
        simulatedSession: 1,
        completedSessions: {
            week1: [true, true],  // Week 1 both sessions complete
            week2: [false, false],
            week3: [false, false]
        },
        forceWelcomeBackModal: false,  // Don't show welcome - already mid-session
        showAwesfSurvey: true  // First session of new week = AWE-SF appears (but not yet)
    },
    
    [AppMode.STUDY_W2_S2]: {
        name: 'Study W2 S2',
        description: 'Week 2, Session 2 - Week 1 complete, W2S1 complete, starting W2S2',
        skipTutorial: true, // Already completed tutorial in Week 1
        showPreSurveys: true,
        showPostSurveys: true,
        requireQualtricsSubmission: false,  // TEST MODE - don't submit to Qualtrics
        enableAdminFeatures: false,
        showSubmitButton: true,
        autoStartPlayback: false,
        // Study-specific config
        requireResponseId: true,
        showProgressIndicator: true,
        enforceSequence: true,
        resetFlagsOnLoad: true,
        // Test mode config (sets flags to simulate returning user state)
        simulateReturningUser: true,
        simulatedWeek: 2,
        simulatedSession: 2,
        completedSessions: {
            week1: [true, true],  // Week 1 both sessions complete
            week2: [true, false], // Week 2 Session 1 complete
            week3: [false, false]
        },
        forceWelcomeBackModal: true,
        showAwesfSurvey: false  // Second session of week = no AWE-SF
    },

    [AppMode.TUTORIAL_END]: {
        name: 'Tutorial End',
        description: 'Test mode - jump to last 2 tutorial messages (tests tutorial completion flow)',
        skipTutorial: true,
        showPreSurveys: false,
        showPostSurveys: false,
        requireQualtricsSubmission: false,  // TEST MODE - don't submit to Qualtrics
        enableAdminFeatures: true,
        showSubmitButton: true,
        autoStartPlayback: false,
        // Test mode config - jump to end of tutorial
        requireResponseId: false,  // No ResponseID needed for testing
        showProgressIndicator: false,
        enforceSequence: false,
        runDebugJump: true  // Jump to last 2 tutorial messages on load
    },
    
    [AppMode.SOLAR_PORTAL]: {
        name: 'Solar Portal',
        description: 'Participant setup only, no study workflow - Begin Analysis hidden, simulate panel hidden',
        skipTutorial: true,
        showPreSurveys: false,
        showPostSurveys: false,
        requireQualtricsSubmission: false,
        enableAdminFeatures: true,
        showSubmitButton: true, // For saving regions/features
        autoStartPlayback: false,
        // Solar Portal specific config
        requireResponseId: false,
        showProgressIndicator: false,
        enforceSequence: false,
        showParticipantSetup: true,  // Show participant setup on first visit
        hideBeginAnalysisButton: true,  // Permanently hide Begin Analysis button
        hideSimulatePanel: true  // Hide simulate panel at bottom
    }
};

/**
 * Get current mode configuration
 */
export function getCurrentModeConfig() {
    return MODE_CONFIG[CURRENT_MODE];
}

/**
 * Mode Check Helpers
 */
export function isPersonalMode() {
    return CURRENT_MODE === AppMode.PERSONAL;
}

export function isDevMode() {
    return CURRENT_MODE === AppMode.DEV;
}

export function isStudyMode() {
    return CURRENT_MODE === AppMode.PRODUCTION || 
           CURRENT_MODE === AppMode.STUDY_CLEAN || 
           CURRENT_MODE === AppMode.STUDY_W2_S1 ||
           CURRENT_MODE === AppMode.STUDY_W2_S1_RETURNING ||
           CURRENT_MODE === AppMode.STUDY_W2_S2;
}

export function isStudyCleanMode() {
    return CURRENT_MODE === AppMode.STUDY_CLEAN || 
           CURRENT_MODE === AppMode.STUDY_W2_S1 || 
           CURRENT_MODE === AppMode.STUDY_W2_S1_RETURNING || 
           CURRENT_MODE === AppMode.STUDY_W2_S2;
}

export function isStudyReturningMode() {
    return CURRENT_MODE === AppMode.STUDY_W2_S1 || 
           CURRENT_MODE === AppMode.STUDY_W2_S1_RETURNING || 
           CURRENT_MODE === AppMode.STUDY_W2_S2;
}

export function getWeeklySessionCount() {
    const config = MODE_CONFIG[CURRENT_MODE];
    return config.weeklySessionCount || 0;
}

export function isTutorialEndMode() {
    return CURRENT_MODE === AppMode.TUTORIAL_END;
}

/**
 * Feature Checks - Use these throughout the codebase
 */
export function shouldSkipTutorial() {
    return MODE_CONFIG[CURRENT_MODE].skipTutorial;
}

export function shouldShowPreSurveys() {
    return MODE_CONFIG[CURRENT_MODE].showPreSurveys;
}

export function shouldShowPostSurveys() {
    return MODE_CONFIG[CURRENT_MODE].showPostSurveys;
}

export function shouldRequireQualtricsSubmission() {
    return MODE_CONFIG[CURRENT_MODE].requireQualtricsSubmission;
}

export function shouldEnableAdminFeatures() {
    return MODE_CONFIG[CURRENT_MODE].enableAdminFeatures;
}

export function shouldShowSubmitButton() {
    return MODE_CONFIG[CURRENT_MODE].showSubmitButton;
}

/**
 * Initialize mode and log configuration
 */
export function initializeMasterMode() {
    const config = MODE_CONFIG[CURRENT_MODE];
    const isLocal = isLocalEnvironment();
    
    // Only log in dev/personal modes, not study mode
    if (!isStudyMode()) {
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`🌐 Environment: ${isLocal ? '🔧 LOCAL (Development)' : '🌍 PRODUCTION (Online)'}`);
        if (!isLocal) {
            console.log(`🔒 Production Mode: STUDY mode enforced (mode switching disabled)`);
        }
        console.log(`🎯 App Mode: ${config.name.toUpperCase()}`);
        console.log(`📝 ${config.description}`);
        console.log('───────────────────────────────────────────────────────────');
        console.log(`Tutorial: ${config.skipTutorial ? '❌ Disabled' : '✅ Enabled'}`);
        console.log(`Pre-Surveys: ${config.showPreSurveys ? '✅ Enabled' : '❌ Disabled'}`);
        console.log(`Post-Surveys: ${config.showPostSurveys ? '✅ Enabled' : '❌ Disabled'}`);
        console.log(`Qualtrics: ${config.requireQualtricsSubmission ? '✅ Required' : '❌ Not Required'}`);
        console.log(`Admin Features: ${config.enableAdminFeatures ? '✅ Enabled' : '❌ Disabled'}`);
        console.log('═══════════════════════════════════════════════════════════');
    }
    
    // Study mode validations
    if (isStudyMode()) {
        validateStudyMode();
    }
    
    // Study Clean mode: Log that it's active (flags are checked dynamically, no reset needed)
    if (isStudyCleanMode()) {
        console.log('🧹 Study Clean Mode: All flag checks will return "not seen" (no localStorage modification)');
    }
}

/**
 * Validate Study Mode requirements
 */
function validateStudyMode() {
    const config = MODE_CONFIG[CURRENT_MODE];
    
    // Check for ResponseID if required
    if (config.requireResponseId) {
        const urlParams = new URLSearchParams(window.location.search);
        const responseId = urlParams.get('ResponseID');
        
        if (!responseId) {
            console.warn('⚠️ Study Mode: No ResponseID found in URL');
            console.warn('⚠️ Expected format: ?ResponseID=${e://Field/ResponseID}');
            // You might want to show an error modal here
        } else {
            console.log(`✅ Study Mode: ResponseID detected (${responseId})`);
        }
    }
}


/**
 * Get study workflow steps (for Study Mode only)
 */
export function getStudyWorkflowSteps() {
    if (!isStudyMode()) return [];
    
    return [
        {
            id: 'pre-survey',
            name: 'Pre-Survey',
            description: 'Initial demographic and background questions',
            required: true
        },
        {
            id: 'tutorial',
            name: 'Tutorial',
            description: 'Learn how to use the application',
            required: true
        },
        {
            id: 'analysis',
            name: 'Data Analysis',
            description: 'Explore seismic data and identify features',
            required: true
        },
        {
            id: 'post-survey',
            name: 'Post-Survey',
            description: 'Feedback and experience questions',
            required: true
        },
        {
            id: 'submission',
            name: 'Submit to Qualtrics',
            description: 'Submit your responses',
            required: true
        }
    ];
}

/**
 * Get current mode name for display
 */
export function getCurrentModeName() {
    return MODE_CONFIG[CURRENT_MODE].name;
}

/**
 * Get current mode description for display
 */
export function getCurrentModeDescription() {
    return MODE_CONFIG[CURRENT_MODE].description;
}

