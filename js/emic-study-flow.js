// ⚠️ When in any doubt, use Edit to surgically fix mistakes — never git checkout this file.
// ═══ EMIC STUDY — Study flow orchestrator for Lauren Blum EMIC wave research ═══
// TODO: Audit all collected data fields:
// - Study start time (login)
// - Each feature identification timestamp  
// - Complete button timestamp
// - All questionnaire responses + timestamps
// - Feature annotations (time/freq ranges)
// - Total session duration
// Server integration: uploads to Cloudflare Worker R2 via /api/emic/participants/:id/submit
// - Per-participant JSON: emic/participants/{id}/submission_{timestamp}.json (append-only)
// - Master participant list: emic/participants/_master.json (auto-updated)

/**
 * emic-study-flow.js
 * EMIC Study Flow: walks through the entire participant study flow
 * 
 * Instead of trying to clear existing feature boxes (no exported clear function),
 * we create a temporary test user ({username}_TEST1, _TEST2, etc.) which naturally
 * has no features. After the flow, we switch back to the real user.
 *
 * Uses a monkey-patch on modalManager.closeModal to force keepOverlay:true
 * during the flow sequence, so the dark backdrop stays persistent across
 * all modal transitions (no flicker).
 * 
 * Flow: Login (test user) → Welcome → Draw Features → Complete → Confirm → 
 *       Questionnaire Intro → Background → Data Analysis → Musical Experience →
 *       How Did You Learn → Feedback → Submission Complete → Restore real user
 */

import { modalManager } from './modal-manager.js';
import { getStandaloneFeatures } from './feature-tracker.js';
import { getParticipantId, storeParticipantId, generateParticipantId } from './participant-id.js';
import { uploadEmicSubmission, syncEmicProgress } from './data-uploader.js';
import { EMIC_FLAGS, getEmicFlag, setEmicFlag, clearAllEmicFlags, updateActiveFeatureCount } from './emic-study-flags.js';
import { QUESTIONNAIRE_CONFIG } from './ui-modals.js';
import { pausePlayback } from './audio-player.js';

// ═══════════════════════════════════════════════════════════════════════════════
// FLOW LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

function flowLog(message) {
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    console.log(`🔬 [SimulateFlow ${ts}] ${message}`);
}

// Flow state
let flowActive = false;
let flowRunning = false; // Keeps button visible during flow regardless of display mode
let savedDisplayMode = null; // Display mode before flow started
let savedSilentDownload = null; // silentDownload checkbox state before flow
let savedAutoDownload = null; // autoDownload checkbox state before flow
let savedDataRendering = null; // dataRendering mode before flow
let studyStartTime = null;
let completeTime = null;
let completeBtn = null;
let featurePollInterval = null;
let realUsername = localStorage.getItem('emic_real_username') || null; // Persisted — survives refresh
let simulationId = localStorage.getItem('emic_simulation_id') || null; // Persisted — survives refresh

// Track whether we're in the flow's modal sequence so the overlay patch cooperates
let inFlowSequence = false;

// Monkey-patch state
let originalCloseModal = null;

/**
 * Initialize: wire up the Simulate Flow button and display mode visibility
 */
export function initSimulateFlow() {
    const btn = document.getElementById('simulateFlowBtn');
    if (!btn) return;

    btn.addEventListener('click', () => {
        if (flowRunning) {
            cancelFlow();
        } else {
            startFlow();
        }
    });

    // If the page was refreshed mid-flow, only resume if in production mode (not advanced)
    const advancedCheckbox = document.getElementById('advancedMode');
    const isAdvanced = advancedCheckbox?.checked;
    if (getEmicFlag(EMIC_FLAGS.IS_SIMULATING) && !isAdvanced) {
        flowRunning = true;
        btn.textContent = 'Cancel Flow';
        btn.style.backgroundColor = '#dc3545';
        btn.style.background = '#dc3545';
        flowLog('Restored Cancel Flow button after page refresh');

        // Save settings so cancel can restore them (startFlow won't run on resume)
        const renderSelect = document.getElementById('dataRendering');
        if (renderSelect) savedDataRendering = renderSelect.value;
        if (advancedCheckbox) savedDisplayMode = advancedCheckbox.checked;

        // Resume flow based on flag state after page refresh
        if (getEmicFlag(EMIC_FLAGS.HAS_CONFIRMED_COMPLETE)) {
            flowLog('Resuming after refresh: confirmed complete, skipping to questionnaires');
            resumeFromConfirmed();
        } else if (getEmicFlag(EMIC_FLAGS.HAS_CLICKED_COMPLETE)) {
            flowLog('Resuming after refresh: clicked complete, showing confirmation');
            resumeFromComplete();
        } else if (!getEmicFlag(EMIC_FLAGS.HAS_REGISTERED)) {
            flowLog('Resuming after refresh: not registered, showing login');
            resumeFromUnregistered();
        } else if (!getEmicFlag(EMIC_FLAGS.HAS_CLOSED_WELCOME)) {
            flowLog('Resuming after refresh: showing welcome');
            resumeFromPreWelcome();
        } else {
            const renderSelect = document.getElementById('dataRendering');
            if (renderSelect) {
                savedDataRendering = renderSelect.value;
                renderSelect.value = 'triggered';
                renderSelect.dispatchEvent(new Event('change', { bubbles: true }));
            }
            flowLog('Resuming after refresh: drawing phase, showing welcome back');
            resumeFromDrawing();
        }
    } else if (getEmicFlag(EMIC_FLAGS.IS_SIMULATING)) {
        // Simulation exists but we're in advanced mode — stay dormant
        flowLog('Simulation state exists but in advanced mode — staying dormant');
    }

    // Hook into advanced mode changes to show/hide button
    if (advancedCheckbox) {
        const updateVisibility = () => {
            btn.style.display = (flowRunning || !advancedCheckbox.checked) ? '' : 'none';
        };
        updateVisibility();
        advancedCheckbox.addEventListener('change', updateVisibility);
        // Store ref for later use
        btn._updateVisibility = updateVisibility;
    }

    // Create the Complete button once, hidden by default
    completeBtn = document.getElementById('simulateFlowCompleteBtn');
    if (!completeBtn) {
        completeBtn = document.createElement('button');
        completeBtn.id = 'simulateFlowCompleteBtn';
        completeBtn.type = 'button';
        completeBtn.textContent = '✓ Complete';
        completeBtn.className = 'complete-btn';
        completeBtn.style.display = 'none';
        const playbackBar = document.querySelector('.panel-playback > div');
        if (playbackBar) playbackBar.appendChild(completeBtn);
    }

    // Wire up the Submission Complete preview button (questionnaires panel)
    const previewBtn = document.getElementById('submissionCompleteBtn');
    if (previewBtn) {
        previewBtn.addEventListener('click', () => openSubmissionCompletePreview());
    }
}

/**
 * Check if simulate flow is currently active.
 */
export function isFlowActive() {
    return flowActive;
}

/** Get the real username stashed during simulation (null if no simulation active) */
export function getRealUsername() {
    return realUsername;
}

/** Get the simulation/test ID in use (null if no simulation active) */
export function getSimulationId() {
    return simulationId;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OVERLAY PATCH
// Forces keepOverlay:true on closeModal calls during the flow sequence,
// preventing the dark backdrop from flickering between sequential modals.
// ═══════════════════════════════════════════════════════════════════════════════

let originalDisableScroll = null;

function installOverlayPatch() {
    if (originalCloseModal) return;
    originalCloseModal = modalManager.closeModal.bind(modalManager);
    modalManager.closeModal = async function(modalId, options = {}) {
        if (inFlowSequence) {
            options.keepOverlay = true;
        }
        return originalCloseModal(modalId, options);
    };
    // Don't let modals lock scroll during the flow — respect user's setting
    originalDisableScroll = modalManager.disableBackgroundScroll.bind(modalManager);
    modalManager.disableBackgroundScroll = function() {};
}

function removeOverlayPatch() {
    if (originalCloseModal) {
        modalManager.closeModal = originalCloseModal;
        originalCloseModal = null;
    }
    if (originalDisableScroll) {
        modalManager.disableBackgroundScroll = originalDisableScroll;
        originalDisableScroll = null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST USERNAME
// Creates a temporary test user so the flow has a clean slate (no features).
// Pattern: {realName}_TEST1, _TEST2, etc.
// ═══════════════════════════════════════════════════════════════════════════════

function stripTestSuffix(username) {
    // Remove any trailing _TEST\d+ suffixes (handles stacked ones too)
    return username.replace(/(_TEST\d+)+$/, '');
}

function generateTestUsername(baseUsername) {
    // Strip any existing _TEST suffixes first to prevent stacking
    const cleanBase = stripTestSuffix(baseUsername);

    // Find next available TEST number.
    // NOTE: Checks localStorage master list, not the server. This is fine for a dev tool —
    // not worth an async server round-trip. Server is the true source of truth for production data.
    // NOTE: Test usernames (_TEST suffix) will be registered on the production server via the
    // existing participant modal submit handler. This is expected — they're clearly labeled.
    let num = 1;
    while (true) {
        const candidate = `${cleanBase}_TEST${num}`;
        const masterList = getEMICMasterList();
        const exists = masterList.some(p => p.participantId === candidate);
        if (!exists) return candidate;
        num++;
        if (num > 99) return `${cleanBase}_TEST${Date.now()}`; // Safety valve
    }
}

function getEMICMasterList() {
    try {
        return JSON.parse(localStorage.getItem('emic_master_participant_list') || '[]');
    } catch {
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN FLOW
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Cancel a running flow
 */
function cancelFlow() {
    flowLog('Flow cancelled by user');
    clearAllEmicFlags();
    clearSavedAnswers();
    // Set flag — startFlow()'s async checks will see this and exit,
    // hitting the finally block which calls cleanup().
    // We also need to immediately close visible modals + overlay
    // so the UI responds instantly to cancel.
    flowActive = false;
    
    // Force-close any visible modals (don't await — instant visual response)
    // Resolve any dangling _closeResolver promises so async stack frames don't leak
    document.querySelectorAll('.modal-window').forEach(m => {
        if (m._closeResolver) {
            m._closeResolver(false); // false = cancelled
            m._closeResolver = null;
        }
        m.style.display = 'none';
        m.classList.remove('modal-visible');
    });
    // Also remove any dynamically created flow modals
    ['simulateFlowConfirmModal', 'simulateFlowIntroModal', 'simulateFlowSubmissionModal'].forEach(id => {
        document.getElementById(id)?.remove();
    });
    
    // Immediately hide overlay
    const overlay = document.getElementById('permanentOverlay');
    if (overlay) { overlay.style.display = 'none'; overlay.style.opacity = ''; }

    // Re-enable background scrolling (modals lock body with overflow:hidden + position:fixed)
    modalManager.enableBackgroundScroll();

    // Clear modalManager state so it doesn't think a modal is still open
    modalManager.currentModal = null;
    modalManager.isTransitioning = false;
    
    // Show cancellation message in status bar
    const statusEl = document.getElementById('status');
    if (statusEl) {
        statusEl.className = 'status info';
        import('./tutorial-effects.js').then(({ typeText }) => {
            typeText(statusEl, 'Study flow has been cancelled, click "Simulate Flow" to begin again.', 30, 10);
        });
    }

    // Restore user + cleanup immediately (cleanup is idempotent —
    // if startFlow's finally block calls it again, the null checks prevent double-restore)
    restoreRealUser();
    cleanup();
}

async function startFlow() {
    if (flowActive) return;
    flowActive = true;
    flowRunning = true;
    inFlowSequence = true;
    studyStartTime = null;
    completeTime = null;

    flowLog('Study flow beginning');

    // Blur the button so space bar doesn't re-trigger it (cancelling the flow)
    document.activeElement?.blur();

    // Stop any active playback before starting simulation
    pausePlayback();

    // Clear day markers from previous session
    import('./day-markers.js').then(({ clearDayMarkers }) => clearDayMarkers());

    // Update button to Cancel state
    const btn = document.getElementById('simulateFlowBtn');
    if (btn) {
        btn.textContent = 'Cancel Flow';
        btn.style.backgroundColor = '#dc3545';
        btn.style.background = '#dc3545';
    }

    // Save and switch to production mode (uncheck advanced)
    const advCheckbox = document.getElementById('advancedMode');
    if (advCheckbox) {
        savedDisplayMode = advCheckbox.checked;
        if (advCheckbox.checked) {
            advCheckbox.checked = false;
            advCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    // Save and enable silentDownload + autoDownload so data fetches happen quietly in background
    const silentCb = document.getElementById('silentDownload');
    const autoCb = document.getElementById('autoDownload');
    savedSilentDownload = silentCb?.checked ?? null;
    savedAutoDownload = autoCb?.checked ?? null;
    if (silentCb && !silentCb.checked) {
        silentCb.checked = true;
        silentCb.dispatchEvent(new Event('change'));
    }
    if (autoCb && !autoCb.checked) {
        autoCb.checked = true;
        autoCb.dispatchEvent(new Event('change'));
    }

    // Save and switch dataRendering to triggered (hide visuals until welcome "Begin")
    const renderSelect = document.getElementById('dataRendering');
    if (renderSelect) {
        savedDataRendering = renderSelect.value;
        renderSelect.value = 'triggered';
        renderSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    flowLog('Enabled silentDownload + autoDownload for background data fetch');

    // Save real username for restoration later
    realUsername = localStorage.getItem('emic_real_username') || getParticipantId() || 'Participant';
    localStorage.setItem('emic_real_username', realUsername);

    // Generate test username — auto mode uses P_ID format, manual uses _TEST suffix
    const idMode = document.getElementById('participantIdMode')?.value || 'manual';
    const testUsername = idMode === 'auto'
        ? generateParticipantId()
        : generateTestUsername(realUsername);
    simulationId = testUsername;
    localStorage.setItem('emic_simulation_id', simulationId);
    flowLog(`Resetting state, test user: ${testUsername}`);

    // Install overlay patch
    installOverlayPatch();

    // Clear all EMIC flags for clean test session
    clearAllEmicFlags();
    clearSavedAnswers();
    setEmicFlag(EMIC_FLAGS.IS_SIMULATING, true);

    // Reset questionnaire form inputs (not the user's features — those belong to real user)
    resetQuestionnaireInputs();

    try {
        // Disable auto-play so audio doesn't start during simulation
        const autoPlayCb = document.getElementById('autoPlay');
        if (autoPlayCb && autoPlayCb.checked) {
            autoPlayCb.checked = false;
            autoPlayCb.dispatchEvent(new Event('change'));
        }

        // ─── Step 2: Login Modal ─────────────────────────────────────────

        // Fire off the data download immediately while user reads the login modal
        const startBtn = document.getElementById('startBtn');
        if (startBtn && !startBtn.disabled) {
            startBtn.click();
            flowLog('Triggered background data fetch (startBtn clicked)');
        } else {
            flowLog('startBtn not available for background fetch');
        }

        const idMode = document.getElementById('participantIdMode')?.value || 'manual';
        if (idMode === 'auto') {
            // Auto mode: skip login modal, just set the test user silently
            storeParticipantId(testUsername);
            const valueEl = document.getElementById('participantIdValue');
            if (valueEl) valueEl.textContent = testUsername;
            flowLog('Auto ID mode — skipped login modal');
        } else {
            flowLog('Login modal shown');
            await openLoginWithTestUser(testUsername);
            flowLog('Login submitted');
        }
        studyStartTime = new Date().toISOString();
        setEmicFlag(EMIC_FLAGS.HAS_REGISTERED);
        syncEmicProgress(testUsername, 'registered');

        if (!flowActive) return;

        // ─── Step 3: Welcome Modal ───────────────────────────────────────
        if (idMode === 'auto') {
            // In auto mode, login modal submit handler didn't run, so we must
            // explicitly open the welcome modal
            const { openWelcomeModal } = await import('./ui-modals.js');
            openWelcomeModal();
        }
        flowLog('Welcome modal shown');

        await waitForModalToAppearAndClose('welcomeModal');
        setEmicFlag(EMIC_FLAGS.HAS_CLOSED_WELCOME);
        syncEmicProgress(testUsername, 'welcome_closed');
        flowLog('Welcome dismissed, entering main interface');

        if (!flowActive) return;

        // ─── Step 4: Main Interface — draw features ──────────────────────
        inFlowSequence = false; // Let overlay fade out naturally
        // If overlay is still up, close it
        const overlay = document.getElementById('permanentOverlay');
        if (overlay && overlay.style.display !== 'none') {
            overlay.style.transition = 'opacity 0.3s ease-out';
            overlay.style.opacity = '0';
            setTimeout(() => { overlay.style.display = 'none'; }, 300);
        }
        
        await showCompleteButton();
        flowLog('Complete button appeared (features detected)');

        if (!flowActive) return;

        // ─── Steps 5–8: Confirmation → Questionnaires → Submission ───────
        await resumeFromComplete(testUsername);

    } catch (err) {
        console.error('❌ Simulate flow error:', err);
        restoreRealUser();
        clearAllEmicFlags();
    clearSavedAnswers();
    } finally {
        cleanup();
    }
}

/**
 * Restore the real username after flow completes
 */
function restoreRealUser() {
    if (realUsername) {
        // Show real username in header again
        const pidValue = document.getElementById('participantIdValue');
        if (pidValue) pidValue.textContent = realUsername;
        flowLog(`Real user restored: ${realUsername}`);
        // Clear simulation state — realUsername stays in emic_real_username
        realUsername = null;
        simulationId = null;
        localStorage.removeItem('participantId');
        localStorage.removeItem('emic_simulation_id');
    }
}

/**
 * Resume from drawing phase: show welcome-back modal, then Complete button.
 * Called on refresh when HAS_CLOSED_WELCOME is set but CLICKED_COMPLETE is not.
 */
async function resumeFromDrawing() {
    await showWelcomeBackModal();
    // Trigger spectrogram render and restore rendering mode
    if (window.triggerDataRender) window.triggerDataRender();
    const renderSelect = document.getElementById('dataRendering');
    if (renderSelect && savedDataRendering) {
        renderSelect.value = savedDataRendering;
        renderSelect.dispatchEvent(new Event('change', { bubbles: true }));
        savedDataRendering = null;
    }
    flowLog('Welcome back modal closed, restoring Complete button');
    await showCompleteButton();
    flowLog('Complete button clicked after welcome back');
    resumeFromComplete();
}

/**
 * Resume from pre-welcome: show welcome modal, then resume drawing.
 * Called on refresh when HAS_REGISTERED is set but HAS_CLOSED_WELCOME is not.
 */
async function resumeFromPreWelcome() {
    const { openWelcomeModal } = await import('./ui-modals.js');
    openWelcomeModal();
    // Wait for the welcome modal to close (sets HAS_CLOSED_WELCOME flag)
    await new Promise(resolve => {
        function onFlagChange(e) {
            if (e.detail?.key === EMIC_FLAGS.HAS_CLOSED_WELCOME) {
                window.removeEventListener('emic-flag-change', onFlagChange);
                resolve();
            }
        }
        window.addEventListener('emic-flag-change', onFlagChange);
    });
    flowLog('Welcome modal closed after refresh, resuming drawing');
    resumeFromDrawing();
}

/**
 * Resume from unregistered: show login, then welcome, then drawing.
 * Called on refresh when IS_SIMULATING is set but HAS_REGISTERED is not.
 */
async function resumeFromUnregistered() {
    const testUsername = getParticipantId() || 'Participant';
    const idMode = document.getElementById('participantIdMode')?.value || 'manual';
    if (idMode === 'auto') {
        storeParticipantId(testUsername);
        flowLog('Auto ID mode — skipped login modal on resume');
    } else {
        await openLoginWithTestUser(testUsername);
        flowLog('Registration completed after refresh');
    }
    setEmicFlag(EMIC_FLAGS.HAS_REGISTERED);
    syncEmicProgress(testUsername, 'registered');
    flowLog('Showing welcome');
    resumeFromPreWelcome();
}

/**
 * Resume from after confirmation (Step 6+): questionnaire intro → questionnaires → submission.
 * Called on refresh when HAS_CONFIRMED_COMPLETE is set.
 */
async function resumeFromConfirmed(username) {
    const testUsername = username || getParticipantId();
    inFlowSequence = true;
    flowActive = true;

    // Ensure overlay patch is installed
    installOverlayPatch();

    try {
        // ─── Step 6: Questionnaire intro (skip if already clicked OK) ────
        if (!getEmicFlag(EMIC_FLAGS.HAS_CLICKED_POST_OK)) {
            flowLog('Resuming from confirmed: showing questionnaire intro');
            await showIntroModal();
            if (!flowActive) return;
        } else {
            flowLog('Resuming from confirmed: intro already seen, skipping');
        }

        // ─── Step 7: Questionnaire sequence (skips already-completed ones) ──
        const questionnaireData = await runQuestionnaireSequence();

        if (!flowActive) return;

        // ─── Step 8: Save + Submission Complete ──────────────────────────
        const submissionData = buildSubmissionData(questionnaireData, testUsername);
        saveToLocalStorage(submissionData);
        flowLog('Submission saved to localStorage');

        flowLog('Upload to server started');
        showSubmittingModal();
        await uploadToServer(submissionData);
        setEmicFlag(EMIC_FLAGS.HAS_SUBMITTED_TO_R2);

        flowLog('Submission complete modal shown');
        showSubmissionCompleteModal(submissionData.featureCount);

        // ─── Restore real user and clear flags ──────────────────────────
        restoreRealUser();
        clearAllEmicFlags();
    clearSavedAnswers();
        flowLog('Flow completed successfully — all flags cleared');

    } catch (err) {
        console.error('❌ Simulate flow error (resumeFromConfirmed):', err);
        restoreRealUser();
        clearAllEmicFlags();
    clearSavedAnswers();
    } finally {
        cleanup();
    }
}

/**
 * Resume the flow from Step 5 (confirmation → questionnaires → submission).
 * Called from both the normal flow and the refresh-restore Complete button handler.
 * @param {string} [username] - participant ID to use; defaults to current participant
 */
async function resumeFromComplete(username) {
    const testUsername = username || getParticipantId();
    inFlowSequence = true;
    flowActive = true;

    // Ensure overlay patch is installed
    installOverlayPatch();

    try {
        // ─── Step 5: Confirmation (loop until confirmed) ─────────────────
        let confirmed = false;
        while (!confirmed && flowActive) {
            setEmicFlag(EMIC_FLAGS.HAS_CLICKED_COMPLETE);
            syncEmicProgress(testUsername, 'analysis_complete');
            completeTime = new Date().toISOString();
            confirmed = await showConfirmModal();
            flowLog(`Confirmation ${confirmed ? 'confirmed' : 'declined'}`);
            if (!confirmed) {
                setEmicFlag(EMIC_FLAGS.HAS_CLICKED_COMPLETE, false);
                inFlowSequence = false;
                // Wait for user to click Complete again (button stays visible)
                await new Promise((resolve) => {
                    const onClick = () => {
                        completeBtn.removeEventListener('click', onClick);
                        resolve();
                    };
                    completeBtn.addEventListener('click', onClick);
                });
                if (!flowActive) return;
                inFlowSequence = true;
            }
        }
        if (!flowActive) return;

        // User confirmed — set confirmed flag
        setEmicFlag(EMIC_FLAGS.HAS_CONFIRMED_COMPLETE);
        flowLog('Complete confirmed');

        // ─── Step 6: Questionnaire intro (skip if already clicked OK) ────
        if (!getEmicFlag(EMIC_FLAGS.HAS_CLICKED_POST_OK)) {
            flowLog('Questionnaire intro shown');
            await showIntroModal();
            if (!flowActive) return;
        } else {
            flowLog('Intro already seen, skipping');
        }

        // ─── Step 7: Questionnaire sequence ──────────────────────────────
        const questionnaireData = await runQuestionnaireSequence();

        if (!flowActive) return;

        // ─── Step 8: Save + Submission Complete ──────────────────────────
        const submissionData = buildSubmissionData(questionnaireData, testUsername);
        saveToLocalStorage(submissionData);
        flowLog('Submission saved to localStorage');

        flowLog('Upload to server started');
        showSubmittingModal();
        await uploadToServer(submissionData);
        setEmicFlag(EMIC_FLAGS.HAS_SUBMITTED_TO_R2);

        flowLog('Submission complete modal shown');
        showSubmissionCompleteModal(submissionData.featureCount);

        // ─── Restore real user and clear flags ──────────────────────────
        restoreRealUser();
        clearAllEmicFlags();
    clearSavedAnswers();
        flowLog('Flow completed successfully — all flags cleared');

    } catch (err) {
        console.error('❌ Simulate flow error (resumeFromComplete):', err);
        restoreRealUser();
        clearAllEmicFlags();
    clearSavedAnswers();
    } finally {
        cleanup();
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Open the participant login modal pre-filled with the test username.
 * Uses storeParticipantId() to properly switch the active user — features
 * are stored by spacecraft+username key, giving a clean slate automatically.
 * Resolves when the modal closes (user submits).
 */
async function openLoginWithTestUser(testUsername) {
    const modal = document.getElementById('participantModal');
    if (!modal) return;

    // Set test user as active participant via existing infrastructure.
    // Region-tracker uses participantId in its storage key, so switching
    // the ID gives us a clean feature slate without clearing anything.
    storeParticipantId(testUsername);

    // Open via the REAL study flow — openParticipantModal() applies all
    // EMIC text patching (title, instructions, placeholder, etc.)
    const { openParticipantModal } = await import('./ui-controls.js');
    await openParticipantModal();

    // Pre-fill the input with the test username after the real function opens
    const input = modal.querySelector('#participantId');
    if (input) {
        input.value = testUsername;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Enable the submit button (normally disabled until input validates)
    const submitBtn = modal.querySelector('.modal-submit');
    if (submitBtn) {
        setTimeout(() => { submitBtn.disabled = false; }, 300);
    }

    // Wait for modal to close (user clicks submit → existing handler does
    // registration, welcome modal, etc.)
    return new Promise((resolve) => {
        const observer = new MutationObserver(() => {
            if (modal.style.display === 'none' || modal.style.display === '') {
                observer.disconnect();
                resolve();
            }
        });
        observer.observe(modal, { attributes: true, attributeFilter: ['style'] });
    });
}

/**
 * Wait for a modal to appear (become visible) then wait for it to close.
 * Used for the welcome modal which is opened by the existing participant handler.
 */
function waitForModalToAppearAndClose(modalId) {
    return new Promise((resolve) => {
        const modal = document.getElementById(modalId);
        if (!modal) { resolve(); return; }

        // If already visible, just wait for close
        if (modal.style.display === 'flex' || modal.style.display === 'block') {
            waitForClose();
            return;
        }

        // Wait for it to appear
        const appearObserver = new MutationObserver(() => {
            if (modal.style.display === 'flex' || modal.style.display === 'block') {
                appearObserver.disconnect();
                waitForClose();
            }
        });
        appearObserver.observe(modal, { attributes: true, attributeFilter: ['style'] });

        function waitForClose() {
            const closeObserver = new MutationObserver(() => {
                if (modal.style.display === 'none' || modal.style.display === '') {
                    closeObserver.disconnect();
                    resolve();
                }
            });
            closeObserver.observe(modal, { attributes: true, attributeFilter: ['style'] });
        }
    });
}

/**
 * Reset questionnaire form inputs (not user data — just the UI state)
 */
function resetQuestionnaireInputs() {
    ['backgroundQuestionModal', 'dataAnalysisQuestionModal', 'musicalExperienceQuestionModal'].forEach(id => {
        const modal = document.getElementById(id);
        if (!modal) return;
        modal.querySelectorAll('input[type="radio"]').forEach(r => r.checked = false);
        const submit = modal.querySelector('.modal-submit');
        if (submit) submit.disabled = true;
    });

    // Reset textareas + their submit button text
    ['feedbackQuestionModal', 'referralQuestionModal'].forEach(id => {
        const modal = document.getElementById(id);
        if (!modal) return;
        const textarea = modal.querySelector('textarea');
        if (textarea) textarea.value = '';
    });
}

/**
 * Show the ✓ Complete button and wait for click.
 * Button appears after user draws their first feature.
 */
function showCompleteButton() {
    return new Promise((resolve) => {
        completeBtn.style.display = 'none';
        completeBtn.disabled = false;

        const onClick = () => {
            completeBtn.removeEventListener('click', onClick);
            if (featurePollInterval) { clearInterval(featurePollInterval); featurePollInterval = null; }
            resolve();
        };
        completeBtn.addEventListener('click', onClick);

        // Poll for features > 0, also update the flag panel count
        if (featurePollInterval) clearInterval(featurePollInterval);
        featurePollInterval = setInterval(() => {
            const count = countFeatures();
            updateActiveFeatureCount(count);
            if (count > 0) {
                completeBtn.style.display = '';
                clearInterval(featurePollInterval);
                featurePollInterval = null;
            }
        }, 500);
    });
}

function countFeatures() {
    return getStandaloneFeatures().length;
}

/**
 * Confirmation modal: "Are you sure you're ready to finish?"
 */
function showConfirmModal() {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.id = 'simulateFlowConfirmModal';
        modal.className = 'modal-window';
        modal.style.display = 'none';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 420px; text-align: center;">
                <div class="modal-header">
                    <h3 class="modal-title">Complete?</h3>
                </div>
                <div class="modal-body">
                    <p style="color: #333; margin: 0 0 24px; padding: 16px; font-size: 18px; line-height: 1.5; font-weight: normal;">
                        Are you sure you're ready to finish? You won't be able to go back after this.
                    </p>
                    <div style="display: flex; gap: 24px; justify-content: center; align-items: center;">
                        <button type="button" id="sfConfirmNo" class="confirm-btn confirm-btn-back" style="min-width: 120px;">Go back</button>
                        <button type="button" id="sfConfirmYes" class="confirm-btn confirm-btn-proceed" style="min-width: 140px;">Yes, I'm done</button>
                    </div>
                </div>
            </div>
        `;
        const overlay = document.getElementById('permanentOverlay') || document.body;
        overlay.appendChild(modal);

        modalManager.openModal('simulateFlowConfirmModal');

        requestAnimationFrame(() => {
            document.getElementById('sfConfirmYes')?.addEventListener('click', () => {
                modalManager.closeModal('simulateFlowConfirmModal', { keepOverlay: true }).then(() => modal.remove());
                resolve(true);
            });
            document.getElementById('sfConfirmNo')?.addEventListener('click', () => {
                inFlowSequence = false; // Allow overlay to fade out (bypass patch)
                modalManager.closeModal('simulateFlowConfirmModal').then(() => modal.remove());
                resolve(false);
            });
        });
    });
}

/**
 * Questionnaire intro modal
 */
function showWelcomeBackModal() {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.id = 'simulateFlowWelcomeBackModal';
        modal.className = 'modal-window';
        modal.style.display = 'none';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 460px; text-align: center;">
                <div class="modal-header">
                    <h3 class="modal-title">Welcome Back!</h3>
                </div>
                <div class="modal-body">
                    <p style="color: #333; font-size: 18px; line-height: 1.6; font-weight: normal;">
                        Your progress has been saved. Click below to pick up where you left off.
                    </p>
                    <button type="button" class="modal-submit" style="min-width: 140px;">Start Now</button>
                </div>
            </div>
        `;
        const overlay = document.getElementById('permanentOverlay') || document.body;
        overlay.appendChild(modal);

        modalManager.openModal('simulateFlowWelcomeBackModal', { keepOverlay: true });

        requestAnimationFrame(() => {
            const dismiss = () => {
                modalManager.closeModal('simulateFlowWelcomeBackModal').then(() => modal.remove());
                document.removeEventListener('keydown', onKey);
                resolve();
            };
            const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); dismiss(); } };
            modal.querySelector('.modal-submit')?.addEventListener('click', dismiss);
            document.addEventListener('keydown', onKey);
        });
    });
}

function showIntroModal() {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.id = 'simulateFlowIntroModal';
        modal.className = 'modal-window';
        modal.style.display = 'none';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 460px; text-align: center;">
                <div class="modal-header">
                    <h3 class="modal-title">📋 Post-Study Questions</h3>
                </div>
                <div class="modal-body">
                    <p style="color: #333; font-size: 18px; line-height: 1.6;">
                        You will now be guided through a brief set of questions that should take 2–3 minutes.
                    </p>
                    <button type="button" class="modal-submit" style="min-width: 140px;">OK</button>
                </div>
            </div>
        `;
        const overlay = document.getElementById('permanentOverlay') || document.body;
        overlay.appendChild(modal);

        modalManager.openModal('simulateFlowIntroModal', { keepOverlay: true });

        requestAnimationFrame(() => {
            modal.querySelector('.modal-submit')?.addEventListener('click', () => {
                setEmicFlag(EMIC_FLAGS.HAS_CLICKED_POST_OK, true);
                modalManager.closeModal('simulateFlowIntroModal', { keepOverlay: true }).then(() => modal.remove());
                resolve();
            });
        });
    });
}

/**
 * Run through all 5 questionnaires in sequence.
 * Overlay stays persistent the entire time (via the global patch).
 * Existing submit handlers in main.js close each modal → patch forces keepOverlay.
 */
async function runQuestionnaireSequence() {
    const questionnaireData = {};
    let i = 0;

    // Restore saved answers from localStorage and re-populate DOM
    for (const q of QUESTIONNAIRE_CONFIG) {
        const saved = localStorage.getItem(`emic_answer_${q.key}`);
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                questionnaireData[q.key] = parsed;
                // Restore radio selection or textarea value in the DOM
                if (q.type === 'radio' && parsed.responses?.[q.inputName]) {
                    const radio = document.querySelector(`input[name="${q.inputName}"][value="${parsed.responses[q.inputName]}"]`);
                    if (radio) radio.checked = true;
                } else if (parsed.responses?.[q.key + 'Text']) {
                    const textarea = document.getElementById(q.inputName);
                    if (textarea) textarea.value = parsed.responses[q.key + 'Text'];
                }
            } catch (e) { /* ignore corrupt data */ }
        }
    }

    // Skip past already-completed questionnaires (resume after refresh)
    while (i < QUESTIONNAIRE_CONFIG.length && getEmicFlag(EMIC_FLAGS[QUESTIONNAIRE_CONFIG[i].flag])) {
        flowLog(`Skipping already-completed questionnaire: ${QUESTIONNAIRE_CONFIG[i].key}`);
        i++;
    }

    while (i < QUESTIONNAIRE_CONFIG.length) {
        const q = QUESTIONNAIRE_CONFIG[i];
        const resolvedFlag = EMIC_FLAGS[q.flag];
        const modal = document.getElementById(q.modalId);
        if (!modal) {
            console.warn(`⚠️ Questionnaire modal not found: ${q.modalId}, skipping`);
            i++;
            continue;
        }
        if (!flowActive) break;

        // If a radio is already selected (going back), enable submit
        if (q.type === 'radio') {
            const submitBtn = modal.querySelector('.modal-submit:not(.modal-back)');
            const checked = modal.querySelector(`input[name="${q.inputName}"]:checked`);
            if (submitBtn && checked) submitBtn.disabled = false;
        }

        // Wire one-time back and skip button listeners
        let wentBack = false;
        let skipped = false;
        const backBtn = modal.querySelector('.modal-back');
        const skipBtn = modal.querySelector('.modal-skip');
        const onBack = () => {
            wentBack = true;
            modalManager.closeModal(q.modalId, { keepOverlay: true });
        };
        const onSkip = () => {
            skipped = true;
            modalManager.closeModal(q.modalId, { keepOverlay: true });
        };
        if (backBtn) {
            backBtn.addEventListener('click', onBack, { once: true });
        }
        if (skipBtn) {
            skipBtn.addEventListener('click', onSkip, { once: true });
        }

        // Open this questionnaire (resolves when submit or back or skip closes it)
        await modalManager.openModal(q.modalId, { keepOverlay: true });

        // Clean up listeners if a different button was clicked
        if (backBtn && !wentBack) {
            backBtn.removeEventListener('click', onBack);
        }
        if (skipBtn && !skipped) {
            skipBtn.removeEventListener('click', onSkip);
        }

        if (wentBack) {
            // Go back: clear previous questionnaire's flag so it re-shows
            const prevIndex = i - 1;
            if (prevIndex >= 0) {
                const prevFlag = EMIC_FLAGS[QUESTIONNAIRE_CONFIG[prevIndex].flag];
                setEmicFlag(prevFlag, false);
                delete questionnaireData[QUESTIONNAIRE_CONFIG[prevIndex].key];
                flowLog(`Going back: cleared flag for "${QUESTIONNAIRE_CONFIG[prevIndex].key}"`);
            }
            i = Math.max(0, i - 1);
            continue;
        }

        if (skipped) {
            // Skip: advance without saving answer, but mark as completed
            setEmicFlag(resolvedFlag);
            syncEmicProgress(getParticipantId(), q.milestone);
            flowLog(`Questionnaire "${q.key}" skipped`);
            i++;
            continue;
        }

        // Collect responses after modal closes (submit path)
        const responses = {};
        if (q.type === 'radio') {
            responses[q.inputName] = document.querySelector(`input[name="${q.inputName}"]:checked`)?.value || '';
        } else {
            const textarea = document.getElementById(q.inputName);
            responses[q.key + 'Text'] = textarea?.value?.trim() || '';
        }

        questionnaireData[q.key] = {
            responses,
            completedAt: new Date().toISOString()
        };
        // Persist answer to localStorage for resume after refresh
        localStorage.setItem(`emic_answer_${q.key}`, JSON.stringify(questionnaireData[q.key]));
        setEmicFlag(resolvedFlag);
        syncEmicProgress(getParticipantId(), q.milestone);
        flowLog(`Questionnaire "${q.key}" completed: ${JSON.stringify(responses)}`);
        i++;
    }

    return questionnaireData;
}

/**
 * Submission Complete modal
 */
function showSubmittingModal() {
    const modal = createSubmittingElement();
    const overlay = document.getElementById('permanentOverlay') || document.body;
    overlay.appendChild(modal);
    modalManager.openModal('simulateFlowSubmissionModal', { keepOverlay: true });
    return modal;
}

function showSubmissionCompleteModal(featureCount) {
    return new Promise((resolve) => {
        // Remove the submitting modal if it exists
        const existing = document.getElementById('simulateFlowSubmissionModal');
        if (existing) {
            existing.classList.remove('modal-visible');
            existing.style.display = 'none';
            existing.remove();
            modalManager.currentModal = '__overlay_active__';
        }

        const modal = createSubmissionCompleteElement(featureCount);
        const overlay = document.getElementById('permanentOverlay') || document.body;
        overlay.appendChild(modal);
        modalManager.openModal('simulateFlowSubmissionModal', { keepOverlay: true });

        // Wire close button to dismiss modal and restore interface
        const closeBtn = modal.querySelector('.modal-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                modalManager.closeModal('simulateFlowSubmissionModal').then(() => modal.remove());
                const overlayEl = document.getElementById('permanentOverlay');
                if (overlayEl) { overlayEl.style.display = 'none'; overlayEl.style.opacity = ''; }
            });
        }
        resolve();
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA PERSISTENCE (localStorage + Cloudflare Worker R2)
// ═══════════════════════════════════════════════════════════════════════════════

function buildSubmissionData(questionnaireData, testUsername) {
    const standalone = getStandaloneFeatures();
    const features = standalone.map((feat, i) => ({
        index: i,
        timeRange: { start: feat.startTime || '', end: feat.endTime || '' },
        freqRange: { low: feat.lowFreq || '', high: feat.highFreq || '' },
        type: feat.type || null,
        repetition: feat.repetition || null,
        notes: feat.notes || null,
        speedFactor: feat.speedFactor ?? null,
        drawnAt: feat.createdAt || ''
    }));

    return {
        participantId: testUsername,
        realUsername: realUsername || '',
        studyStartTime: studyStartTime || '',
        features,
        questionnaires: questionnaireData,
        completedAt: completeTime,
        submittedAt: new Date().toISOString(),
        featureCount: features.length,
        isSimulation: true
    };
}

function clearSavedAnswers() {
    for (const q of QUESTIONNAIRE_CONFIG) {
        localStorage.removeItem(`emic_answer_${q.key}`);
    }
}

function saveToLocalStorage(submissionData) {
    const { participantId, submittedAt } = submissionData;

    // Per-participant data
    localStorage.setItem(
        `emic_participant_${participantId}_data`,
        JSON.stringify(submissionData)
    );

    // Master participant list
    let masterList = getEMICMasterList();
    const existing = masterList.findIndex(p => p.participantId === participantId);
    const entry = { participantId, submittedAt, featureCount: submissionData.featureCount, isSimulation: true };
    if (existing >= 0) masterList[existing] = entry;
    else masterList.push(entry);
    localStorage.setItem('emic_master_participant_list', JSON.stringify(masterList));

    console.log('📡 EMIC submission saved to localStorage:', participantId);
}

/**
 * Upload submission data to the EMIC R2 backend via shared uploadEmicSubmission().
 * Falls back gracefully — localStorage is the primary store.
 */
async function uploadToServer(submissionData) {
    const result = await uploadEmicSubmission(submissionData.participantId, submissionData);
    if (result.status === 'success') {
        flowLog('Upload to server succeeded');
    } else {
        flowLog(`Upload to server failed: ${result.error || result.reason || 'unknown'}`);
    }
    return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED MODAL ELEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create the Submission Complete modal element (shared by flow and preview).
 * Returns a detached DOM element — caller is responsible for appending + opening.
 */
function createSubmittingElement() {
    const existing = document.getElementById('simulateFlowSubmissionModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'simulateFlowSubmissionModal';
    modal.className = 'modal-window';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content emic-questionnaire-modal" style="text-align: center;">
            <div class="modal-header">
                <h3 class="modal-title">📡 Submitting</h3>
            </div>
            <div class="modal-body" style="display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1;">
                <div class="submitting-spinner" style="width: 40px; height: 40px; border: 3px solid #e0e0e0; border-top: 3px solid #2196F3; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 24px;"></div>
                <p style="font-size: 18px; color: #666; margin: 0;">Submitting responses...</p>
            </div>
        </div>
        <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
    `;
    return modal;
}

function createSubmissionCompleteElement(featureCount) {
    const existing = document.getElementById('simulateFlowSubmissionModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'simulateFlowSubmissionModal';
    modal.className = 'modal-window';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content emic-questionnaire-modal" style="text-align: center; position: relative;">
            <button type="button" class="modal-close" style="position: absolute; top: 12px; right: 16px; background: none; border: none; font-size: 22px; cursor: pointer; color: #999; line-height: 1; padding: 4px 8px;" aria-label="Close">&times;</button>
            <div class="modal-header">
                <h3 class="modal-title">📡 Submission Complete</h3>
            </div>
            <div class="modal-body" style="display: flex; flex-direction: column; align-items: center; flex: 1; font-size: 16px; color: #333; line-height: 1.6;">
                <div style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;">
                    <div style="font-size: 48px; margin-bottom: 16px;">🚀</div>
                    <p style="margin: 0 0 16px;">
                        <span style="color: #550000; font-size: 24px; font-weight: 700;">${featureCount}</span> feature${featureCount !== 1 ? 's' : ''} identified and recorded.
                    </p>
                    <p style="margin: 0 0 16px;">
                        Thank you for taking part in this study!
                    </p>
                    <p style="margin: 0;">
                        If you have additional questions or feedback, please reach out to the study coordinator:
                    </p>
                    <a href="mailto:lewilliams@smith.edu" style="color: #2196F3; text-decoration: none; font-size: 16px;">lewilliams@smith.edu</a>
                </div>
                <p style="margin: 0 0 8px; color: #999;">
                    You may now close this page.
                </p>
            </div>
        </div>
    `;
    return modal;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PREVIEW (from questionnaires panel button)
// ═══════════════════════════════════════════════════════════════════════════════

export function openSubmissionCompletePreview() {
    const modal = createSubmissionCompleteElement(countFeatures());
    const overlay = document.getElementById('permanentOverlay') || document.body;
    overlay.appendChild(modal);
    modalManager.openModal('simulateFlowSubmissionModal');

    // Close on overlay click (preview only)
    const closeIt = (e) => {
        if (e.target === overlay) {
            overlay.removeEventListener('click', closeIt);
            modalManager.closeModal('simulateFlowSubmissionModal').then(() => modal.remove());
        }
    };
    overlay.addEventListener('click', closeIt);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════════════

function cleanup() {
    flowActive = false;
    flowRunning = false;
    inFlowSequence = false;
    removeOverlayPatch();
    modalManager.enableBackgroundScroll(); // Safety net — always unlock scroll on cleanup
    if (featurePollInterval) { clearInterval(featurePollInterval); featurePollInterval = null; }
    if (completeBtn) completeBtn.style.display = 'none';

    // Restore button text and style
    const btn = document.getElementById('simulateFlowBtn');
    if (btn) {
        btn.textContent = 'Simulate Flow';
        btn.style.backgroundColor = '';
        btn.style.background = '';
        if (btn._updateVisibility) btn._updateVisibility();
    }

    // Restore previous advanced mode state
    if (savedDisplayMode !== null) {
        const advCheckbox = document.getElementById('advancedMode');
        if (advCheckbox && advCheckbox.checked !== savedDisplayMode) {
            advCheckbox.checked = savedDisplayMode;
            advCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
        }
        savedDisplayMode = null;
    }

    // Restore silentDownload + autoDownload checkboxes
    if (savedSilentDownload !== null) {
        const silentCb = document.getElementById('silentDownload');
        if (silentCb && silentCb.checked !== savedSilentDownload) {
            silentCb.checked = savedSilentDownload;
            silentCb.dispatchEvent(new Event('change'));
        }
        savedSilentDownload = null;
    }
    if (savedAutoDownload !== null) {
        const autoCb = document.getElementById('autoDownload');
        if (autoCb && autoCb.checked !== savedAutoDownload) {
            autoCb.checked = savedAutoDownload;
            autoCb.dispatchEvent(new Event('change'));
        }
        savedAutoDownload = null;
    }

    // Restore dataRendering mode
    if (savedDataRendering !== null) {
        const renderSelect = document.getElementById('dataRendering');
        if (renderSelect && renderSelect.value !== savedDataRendering) {
            renderSelect.value = savedDataRendering;
            renderSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
        savedDataRendering = null;
    }

    setEmicFlag(EMIC_FLAGS.IS_SIMULATING, false);
    flowLog('Settings restored, flow ended');
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-INIT
// ═══════════════════════════════════════════════════════════════════════════════

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSimulateFlow);
} else {
    setTimeout(initSimulateFlow, 200);
}
