// mode-initializers.js -- Mode-specific initialization (EMIC, Solar Portal, Personal, Dev)

import * as State from './audio-state.js';
import { getParticipantId } from './participant-id.js';
import { getEmicFlag, EMIC_FLAGS } from './emic-study-flags.js';
import { openParticipantModal } from './ui-controls.js';
import {
    CURRENT_MODE,
    AppMode,
    isStudyMode,
    isLocalEnvironment
} from './master-modes.js';


export async function updateParticipantIdDisplay() {
    const participantId = getParticipantId();
    const displayElement = document.getElementById('participantIdDisplay');
    const valueElement = document.getElementById('participantIdValue');

    // Always show the participant ID display (even if no ID set)
    // This allows users to see and click to enter their ID
    if (displayElement) displayElement.style.display = 'block';
    if (valueElement) valueElement.textContent = participantId || '--';
}

/**
 * PERSONAL MODE: Direct access, no tutorial, no surveys
 */
export async function initializePersonalMode() {
    console.log('👤 PERSONAL MODE: Direct access');

    // Enable all features immediately
    const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
    enableAllTutorialRestrictedFeatures();

    console.log('✅ Personal mode ready - all features enabled');
}

/**
 * DEV MODE: Direct access for development/testing
 */
export async function initializeDevMode() {
    console.log('🔧 DEV MODE: Direct access');

    // Enable all features immediately
    const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
    enableAllTutorialRestrictedFeatures();

    console.log('✅ Dev mode ready');
}

/**
 * EMIC STUDY MODE: Clean research interface, no modals, no tutorial
 */
export async function initializeEmicStudyMode() {
    // Hide unnecessary UI elements
    const completeBtn = document.getElementById('completeBtn');
    if (completeBtn) completeBtn.style.display = 'none';
    const simulatePanel = document.querySelector('.panel-simulate');
    if (simulatePanel) simulatePanel.style.display = 'none';

    // Enable all features immediately
    const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
    enableAllTutorialRestrictedFeatures();

    // Enable region creation
    const { setRegionCreationEnabled } = await import('./audio-state.js');
    setRegionCreationEnabled(true);

    // Advanced controls already initialized early in initializeMainApp()

    const skipLogin = localStorage.getItem('emic_skip_login_welcome') === 'true';

    if (!skipLogin) {
        // Show participant setup immediately
        openParticipantModal();
    } else {
        // Hide overlay, go straight to app — unless mid-simulation (flow will manage overlay)
        const isSimulating = getEmicFlag(EMIC_FLAGS.IS_SIMULATING);
        if (!isSimulating) {
            const overlay = document.getElementById('permanentOverlay');
            if (overlay) { overlay.style.display = 'none'; overlay.style.opacity = '0'; }
        }

        // Show "click Fetch Data to begin" prompt (same as Solar Portal)
        // Skip if mid-simulation — the simulate flow handles its own status text on resume
        const isSharedSession = sessionStorage.getItem('isSharedSession') === 'true';
        if (!isSharedSession && !isSimulating) {
            setTimeout(async () => {
                const { typeText } = await import('./tutorial-effects.js');
                const statusEl = document.getElementById('status');
                if (statusEl) {
                    statusEl.className = 'status info';
                    const msg = State.isMobileScreen() ? 'Click Fetch Data to begin' : '👈 click Fetch Data to begin';
                    typeText(statusEl, msg, 30, 10);
                }
            }, 500);
        }
    }

    if (window.pm?.study_flow) console.log('🔬 EMIC Study mode initialized (skipLogin:', skipLogin, ')');
}

/**
 * SOLAR PORTAL MODE: Participant setup only, no study workflow
 */
export async function initializeSolarPortalMode() {

    // Advanced controls already initialized early in initializeMainApp()

    // Show Advanced checkbox only on localhost
    const advToggle = document.getElementById('advancedToggle');
    if (advToggle) {
        advToggle.style.display = isLocalEnvironment() ? 'flex' : 'none';
    }

    // Hide Begin Analysis button permanently
    const completeBtn = document.getElementById('completeBtn');
    if (completeBtn) {
        completeBtn.style.display = 'none';
        // console.log('✅ Begin Analysis button hidden');
    }

    // Hide simulate panel
    const simulatePanel = document.querySelector('.panel-simulate');
    if (simulatePanel) {
        simulatePanel.style.display = 'none';
        // console.log('✅ Simulate panel hidden');
    }

    // Enable all features immediately
    const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
    enableAllTutorialRestrictedFeatures();

    // Check if user has a username set - if not, show participant setup
    const { getParticipantId } = await import('./participant-id.js');
    const participantId = getParticipantId();
    const hasUsername = participantId && participantId.trim() !== '';

    if (!hasUsername) {
        console.log('👤 No username found - opening participant setup');
        // Wait a bit for modals to initialize, then open participant modal
        setTimeout(() => {
            openParticipantModal();
        }, 500);
    } else {
        console.log(`✅ Welcome back, ${participantId}`);
        // Show instruction to click Fetch Data (only if not a shared session)
        const isSharedSession = sessionStorage.getItem('isSharedSession') === 'true';
        if (!isSharedSession) {
            setTimeout(async () => {
                const { typeText } = await import('./tutorial-effects.js');
                const statusEl = document.getElementById('status');
                if (statusEl) {
                    statusEl.className = 'status info';
                    const msg = State.isMobileScreen() ? 'Click Fetch Data to begin' : '👈 click Fetch Data to begin';
                    typeText(statusEl, msg, 30, 10);
                }
            }, 500);
        }
    }

    console.log('✅ Solar Portal mode ready');
}

/**
 * STUDY MODE: Placeholder (volcano study workflow removed)
 */
export async function initializeStudyMode() {
    console.log('🎓 STUDY MODE: No volcano workflow in EMIC codebase');

    // Enable all features immediately
    const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
    enableAllTutorialRestrictedFeatures();

    console.log('✅ Study mode ready');
}


/**
 * Route to appropriate workflow based on mode
 */
export async function initializeApp() {
    const { CURRENT_MODE, AppMode } = await import('./master-modes.js');

    if (!isStudyMode()) {
        if (window.pm?.study_flow) console.groupCollapsed(`🎯 [MODE] ${CURRENT_MODE} Initialization`);
    }
    if (window.pm?.study_flow) console.log(`🚀 Initializing app in ${CURRENT_MODE} mode`);

    switch (CURRENT_MODE) {
        case AppMode.PERSONAL:
            await initializePersonalMode();
            break;

        case AppMode.DEV:
            await initializeDevMode();
            break;

        case AppMode.SOLAR_PORTAL:
            await initializeSolarPortalMode();
            break;

        case AppMode.EMIC_STUDY:
            await initializeEmicStudyMode();
            break;

        case AppMode.PRODUCTION:
        case AppMode.STUDY_CLEAN:
        case AppMode.STUDY_W2_S1:
        case AppMode.STUDY_W2_S1_RETURNING:
        case AppMode.STUDY_W2_S2:
            await initializeStudyMode();
            break;

        default:
            console.error(`❌ Unknown mode: ${CURRENT_MODE}`);
            await initializeDevMode(); // Fallback to dev
    }

    if (!isStudyMode()) {
        console.groupEnd(); // End Mode Initialization
    }
}
