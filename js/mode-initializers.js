// mode-initializers.js -- Mode-specific initialization (EMIC Study, Solar Portal)

import * as State from './audio-state.js';
import { getParticipantId, generateParticipantId, storeParticipantId, getActiveId } from './participant-id.js';
import { getEmicFlag, EMIC_FLAGS } from './emic-study-flags.js';
import { openParticipantModal } from './ui-controls.js';
import {
    isStudyMode,
    isLocalEnvironment
} from './master-modes.js';
import { isAdminUnlocked } from './admin-unlock.js';


export async function updateParticipantIdDisplay() {
    const displayElement = document.getElementById('participantIdDisplay');
    const valueElement = document.getElementById('participantIdValue');

    // Auto-generate ID if in auto mode and none exists yet
    const idMode = document.getElementById('participantIdMode')?.value
        || localStorage.getItem(isStudyMode() ? 'emic_participant_id_mode' : 'main_participant_id_mode')
        || 'manual';
    if (idMode === 'auto' && !getParticipantId()) {
        const newId = generateParticipantId();
        storeParticipantId(newId);
    }

    const activeId = getActiveId();
    if (valueElement) valueElement.textContent = activeId !== 'anonymous' ? activeId : '--';

    // Respect P_ID in Corner setting
    const cornerSetting = document.getElementById('pidCornerDisplay')?.value
        || localStorage.getItem(isStudyMode() ? 'emic_pid_corner_display' : 'main_pid_corner_display')
        || 'show';
    if (displayElement) displayElement.style.display = cornerSetting === 'hide' ? 'none' : 'block';

    // Wire live toggle for P_ID in Corner dropdown
    const cornerSelect = document.getElementById('pidCornerDisplay');
    if (cornerSelect && !cornerSelect._pidWired) {
        cornerSelect._pidWired = true;
        cornerSelect.addEventListener('change', () => {
            if (displayElement) displayElement.style.display = cornerSelect.value === 'hide' ? 'none' : 'block';
        });
    }

    // Wire live toggle for ID Mode dropdown — auto-generate on switch to auto
    const modeSelect = document.getElementById('participantIdMode');
    if (modeSelect && !modeSelect._pidWired) {
        modeSelect._pidWired = true;
        modeSelect.addEventListener('change', () => {
            if (modeSelect.value === 'auto' && !getParticipantId()) {
                const newId = generateParticipantId();
                storeParticipantId(newId);
                if (valueElement) valueElement.textContent = newId;
            }
        });
    }
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

    // Login/welcome modals are handled entirely by simulate flow (emic-study-flow.js)
    // Hide overlay unless actively resuming a simulation in participant mode
    const isSimulating = getEmicFlag(EMIC_FLAGS.IS_SIMULATING);
    const isAdvanced = document.getElementById('advancedMode')?.checked;
    if (!isSimulating || isAdvanced) {
        const overlay = document.getElementById('permanentOverlay');
        if (overlay) { overlay.style.display = 'none'; overlay.style.opacity = '0'; }
    }

    // Show startup prompt
    // Skip if mid-simulation — the simulate flow handles its own status text on resume
    const isSharedSession = sessionStorage.getItem('isSharedSession') === 'true';
    if (!isSharedSession && (!isSimulating || isAdvanced)) {
        setTimeout(async () => {
            const { typeText } = await import('./tutorial-effects.js');
            const statusEl = document.getElementById('status');
            if (statusEl) {
                statusEl.className = 'status info';
                const msg = isAdvanced
                    ? (State.isMobileScreen() ? 'Click Fetch Data to begin' : '👈 click Fetch Data to begin')
                    : 'Click the SIMULATE FLOW button to begin';
                typeText(statusEl, msg, 30, 10);
            }
        }, 500);
    }

    if (window.pm?.study_flow) console.log('🔬 EMIC Study mode initialized (skipLogin:', skipLogin, ')');
}

/**
 * SOLAR PORTAL MODE: Participant setup only, no study workflow
 */
export async function initializeSolarPortalMode() {

    // Advanced controls already initialized early in initializeMainApp()

    // Admin-only button visibility handled by CSS (.admin-only + data-admin attribute)

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
 * Route to appropriate workflow based on mode
 */
export async function initializeApp() {
    const { CURRENT_MODE, AppMode } = await import('./master-modes.js');

    if (!isStudyMode()) {
        if (window.pm?.study_flow) console.groupCollapsed(`🎯 [MODE] ${CURRENT_MODE} Initialization`);
    }
    if (window.pm?.study_flow) console.log(`🚀 Initializing app in ${CURRENT_MODE} mode`);

    switch (CURRENT_MODE) {
        case AppMode.SOLAR_PORTAL:
            await initializeSolarPortalMode();
            break;

        case AppMode.EMIC_STUDY:
            await initializeEmicStudyMode();
            break;

        default:
            console.error(`❌ Unknown mode: ${CURRENT_MODE}, falling back to Solar Portal`);
            await initializeSolarPortalMode();
    }

    if (!isStudyMode()) {
        console.groupEnd(); // End Mode Initialization
    }
}
