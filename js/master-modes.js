/**
 * master-modes.js
 * Centralized mode management for volcano-audio
 * Controls tutorial flow, surveys, and Qualtrics integration
 */

/**
 * Available Application Modes
 *
 * PERSONAL: Skip tutorial, direct access to app
 * DEV: Current development environment with tutorial
 * STUDY: Full research workflow (pre-surveys → tutorial → post-surveys → Qualtrics)
 * STUDY_CLEAN: Same as STUDY but resets all flags on each load (for testing)
 * STUDY_RETURNING_CLEAN_1: Returning user, first session of the week (resets flags)
 * STUDY_RETURNING_CLEAN_2: Returning user, second session of the week (resets flags)
 * STUDY_END: Study completion mode with end walkthrough (runs after study workflow completes)
 * TEST_STUDY_END: Debug mode to test the study end walkthrough (last 2 messages)
 */
export const AppMode = {
    PERSONAL: 'personal',
    DEV: 'dev',
    STUDY: 'study',
    STUDY_CLEAN: 'study_clean',
    STUDY_RETURNING_CLEAN_1: 'study_returning_clean_1',
    STUDY_RETURNING_CLEAN_2: 'study_returning_clean_2',
    STUDY_END: 'study_end',
    TEST_STUDY_END: 'test_study_end'
};

/**
 * ═══════════════════════════════════════════════════════════
 * 🎯 MODE SELECTION - Can be changed via UI dropdown or here
 * ═══════════════════════════════════════════════════════════
 */
export const DEFAULT_MODE = AppMode.DEV; // Default if no localStorage selection

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
const storedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('selectedMode') : null;

// Production: Always force STUDY mode (ignore localStorage)
// Local: Allow mode switching via localStorage or DEFAULT_MODE
export const CURRENT_MODE = isLocalEnvironment()
    ? (storedMode && Object.values(AppMode).includes(storedMode) 
        ? storedMode 
        : DEFAULT_MODE)
    : AppMode.STUDY; // Force STUDY mode for production

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
    
    [AppMode.STUDY]: {
        name: 'Study Mode',
        description: 'Full research workflow with surveys and Qualtrics',
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
    
    [AppMode.STUDY_RETURNING_CLEAN_1]: {
        name: 'Study Returning Clean 1',
        description: 'Returning user - first session of the week (resets flags, shows Welcome Back)',
        skipTutorial: true, // Already completed tutorial
        showPreSurveys: true,
        showPostSurveys: true,
        requireQualtricsSubmission: true,
        enableAdminFeatures: false,
        showSubmitButton: true,
        autoStartPlayback: false,
        // Study-specific config
        requireResponseId: true,
        showProgressIndicator: true,
        enforceSequence: true,
        resetFlagsOnLoad: true,
        // Returning user config
        simulateReturningUser: true,
        weeklySessionCount: 1, // First session of the week
        forceWelcomeBackModal: true
    },
    
    [AppMode.STUDY_RETURNING_CLEAN_2]: {
        name: 'Study Returning Clean 2',
        description: 'Returning user - second session of the week (resets flags, shows Welcome Back)',
        skipTutorial: true, // Already completed tutorial
        showPreSurveys: true,
        showPostSurveys: true,
        requireQualtricsSubmission: true,
        enableAdminFeatures: false,
        showSubmitButton: true,
        autoStartPlayback: false,
        // Study-specific config
        requireResponseId: true,
        showProgressIndicator: true,
        enforceSequence: true,
        resetFlagsOnLoad: true,
        // Returning user config
        simulateReturningUser: true,
        weeklySessionCount: 2, // Second session of the week
        forceWelcomeBackModal: true
    },
    
    [AppMode.STUDY_END]: {
        name: 'Study End Mode',
        description: 'Skip pre-survey and tutorial, go straight to analysis, then end walkthrough',
        skipTutorial: true,
        showPreSurveys: false,
        showPostSurveys: true,
        requireQualtricsSubmission: true,
        enableAdminFeatures: false,
        showSubmitButton: true,
        autoStartPlayback: false,
        // Study End specific config - runs walkthrough after completion
        requireResponseId: true, // Must have Qualtrics ResponseID in URL
        showProgressIndicator: false, // No progress indicator needed
        enforceSequence: true, // Must complete steps in order
        runEndWalkthrough: true // Run the study end walkthrough after completion
    },

    [AppMode.TEST_STUDY_END]: {
        name: 'Test Study End Mode',
        description: 'Debug mode - jump to last 2 messages of study end walkthrough',
        skipTutorial: true,
        showPreSurveys: false,
        showPostSurveys: false,
        requireQualtricsSubmission: false,
        enableAdminFeatures: true,
        showSubmitButton: true,
        autoStartPlayback: false,
        // Test mode specific config
        requireResponseId: false, // No ResponseID needed for testing
        showProgressIndicator: false, // No progress indicator
        enforceSequence: false, // Don't enforce sequence
        runDebugJump: true // Run the debug jump function on load
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
    return CURRENT_MODE === AppMode.STUDY || 
           CURRENT_MODE === AppMode.STUDY_CLEAN || 
           CURRENT_MODE === AppMode.STUDY_RETURNING_CLEAN_1 || 
           CURRENT_MODE === AppMode.STUDY_RETURNING_CLEAN_2 || 
           CURRENT_MODE === AppMode.STUDY_END || 
           CURRENT_MODE === AppMode.TEST_STUDY_END;
}

export function isStudyEndMode() {
    return CURRENT_MODE === AppMode.STUDY_END;
}

export function isStudyCleanMode() {
    return CURRENT_MODE === AppMode.STUDY_CLEAN || 
           CURRENT_MODE === AppMode.STUDY_RETURNING_CLEAN_1 || 
           CURRENT_MODE === AppMode.STUDY_RETURNING_CLEAN_2;
}

export function isStudyReturningCleanMode() {
    return CURRENT_MODE === AppMode.STUDY_RETURNING_CLEAN_1 || 
           CURRENT_MODE === AppMode.STUDY_RETURNING_CLEAN_2;
}

export function getWeeklySessionCount() {
    const config = MODE_CONFIG[CURRENT_MODE];
    return config.weeklySessionCount || 0;
}

export function isTestStudyEndMode() {
    return CURRENT_MODE === AppMode.TEST_STUDY_END;
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

