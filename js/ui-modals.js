/**
 * ui-modals.js
 * Modal open/close handlers, overlay management, and modal event listener setup.
 * Extracted from ui-controls.js for maintainability.
 */

import * as State from './audio-state.js';
import { getParticipantId, storeParticipantId, getParticipantIdFromURL } from './qualtrics-api.js';
import { trackSurveyStart } from '../Qualtrics/participant-response-manager.js';
import { isStudyMode, isStudyCleanMode, isLocalEnvironment, isEmicStudyMode } from './master-modes.js';
import { modalManager } from './modal-manager.js';
import { startActivityTimer } from './session-management.js';
import { STORAGE_KEYS, hasSeenParticipantSetup, hasSeenWelcome, markParticipantSetupAsSeen, markWelcomeAsSeen } from './study-workflow.js';
import { checkUsernameAvailable, registerUsername } from './share-api.js';


function hideUIElementsForModal() {
    const tutorialHelpBtn = document.getElementById('tutorialHelpBtn');
    if (tutorialHelpBtn) {
        tutorialHelpBtn.style.display = 'none';
    }
    
    const participantIdText = document.getElementById('participantIdText');
    if (participantIdText) {
        participantIdText.style.pointerEvents = 'none';
        participantIdText.style.cursor = 'default';
        participantIdText.style.opacity = '0.5';
    }
}

/**
 * Show tutorial help button and enable participant ID clicking when modals are closed
 */
function showUIElementsAfterModal() {
    // Only show if in study mode and no modals are visible
    const anyModalVisible = checkIfAnyModalVisible();
    if (anyModalVisible) {
        return; // Still have modals open, don't show yet
    }
    
    // Check if in study mode (synchronous check)
    const storedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('selectedMode') : null;
    const inStudyMode = storedMode === 'study' || storedMode === 'study_clean';
    
    const tutorialHelpBtn = document.getElementById('tutorialHelpBtn');
    if (tutorialHelpBtn && inStudyMode) {
        tutorialHelpBtn.style.display = 'flex';
    }
    
    const participantIdText = document.getElementById('participantIdText');
    if (participantIdText) {
        participantIdText.style.pointerEvents = 'auto';
        participantIdText.style.cursor = 'pointer';
        participantIdText.style.opacity = '1';
    }
}

/**
 * Check if any modal is currently visible
 */
function checkIfAnyModalVisible() {
    const allModalIds = [
        'welcomeModal',
        'participantModal',
        'preSurveyModal',
        'postSurveyModal',
        'activityLevelModal',
        'awesfModal',
        'endModal',
        'beginAnalysisModal',
        'missingStudyIdModal',
        'completeConfirmationModal',
        'tutorialIntroModal',
        'tutorialRevisitModal',
        'welcomeBackModal'
    ];
    
    return allModalIds.some(modalId => {
        const modal = document.getElementById(modalId);
        return modal && modal.style.display !== 'none' && modal.style.display !== '';
    });
}

function showModal(modal) {
    if (!modal) return;
    modal.style.display = 'flex';
    // Trigger reflow so transition plays
    modal.offsetHeight;
    modal.classList.add('modal-visible');
}

function hideModal(modal) {
    if (!modal) return;
    modal.classList.remove('modal-visible');
    setTimeout(() => {
        modal.style.display = 'none';
    }, 250);
}

function fadeInOverlay() {
    const overlay = document.getElementById('permanentOverlay');
    if (!overlay) return;
    
    // Hide UI elements when modal opens
    hideUIElementsForModal();
    
    // Check if overlay is already visible (opacity > 0 and display is not 'none')
    const isAlreadyVisible = overlay.style.display !== 'none' && 
                            (overlay.style.opacity === '1' || 
                             parseFloat(overlay.style.opacity) > 0 ||
                             !overlay.style.opacity); // No inline style means CSS default (likely visible)
    
    if (isAlreadyVisible) {
        // Overlay already visible - just ensure it's displayed, no fade needed
        overlay.style.display = 'flex';
        overlay.style.opacity = '1';
        return;
    }
    
    // Overlay not visible - fade it in
    overlay.style.opacity = '0';
    overlay.style.display = 'flex';
    
    // Force reflow
    void overlay.offsetHeight;
    
    overlay.style.transition = 'opacity 0.3s ease-in';
    overlay.style.opacity = '1';
}

/**
 * Fade out the permanent overlay background (modal background)
 * Standard design pattern: background fades down when modal leaves
 */
export function fadeOutOverlay() {
    const overlay = document.getElementById('permanentOverlay');
    if (!overlay) return;
    
    overlay.style.transition = 'opacity 0.3s ease-out';
    overlay.style.opacity = '0';
    
    setTimeout(() => {
        if (overlay.style.opacity === '0') {
            overlay.style.display = 'none';
        }
        // Show UI elements after overlay fades out (check if no modals are visible)
        showUIElementsAfterModal();
    }, 300);
}

let modalListenersSetup = false;

/**
 * Determine if there's another modal coming after this one in the workflow
 * Returns the next modal ID if there is one, null if this is the last modal
 * @param {string} currentModalId - The current modal ID being closed
 * @returns {string|null} - Next modal ID or null
 */
async function getNextModalInWorkflow(currentModalId) {
    // Only check workflow sequence in study mode
    if (!isStudyMode()) {
        return null; // In non-study modes, no automatic workflow
    }
    
    // ═══════════════════════════════════════════════════════════
    // GOSPEL: Follow VISIT RULES from study-workflow.js exactly
    // Use the same logic functions from study-workflow.js
    // ═══════════════════════════════════════════════════════════
    // 
    // FIRST VISIT EVER:
    //   1. Participant Setup → 2. Welcome → 3. Pre-Survey → 4. Tutorial → 
    //   5. Experience → 6. Activity Level → 7. AWE-SF (if first time week) → 
    //   8. Post-Survey → 9. End
    // 
    // SUBSEQUENT VISITS (SAME WEEK):
    //   1. Pre-Survey → 2. Experience → 3. Activity Level → 
    //   4. Post-Survey → 5. End
    // 
    // FIRST VISIT OF NEW WEEK:
    //   1. Pre-Survey → 2. Experience → 3. Activity Level → 
    //   4. AWE-SF → 5. Post-Survey → 6. End
    
    // Use workflow logic functions from study-workflow.js (same source of truth)
    // Note: These functions handle study_clean mode and test modes correctly
    const { hasSeenTutorial, hasCompletedAwesfThisWeek, hasSeenParticipantSetup } = await import('./study-workflow.js');
    
    // Tutorial should show if they haven't seen it yet (regardless of participant setup status)
    // The check for first visit ever is just for determining the flow, but tutorial is independent
    const hasCompletedTutorial = hasSeenTutorial();
    const needsAwesf = !hasCompletedAwesfThisWeek();
    
    // Check if this is first visit ever for flow routing
    const isFirstVisitEver = !hasSeenParticipantSetup();
    
    switch (currentModalId) {
        case 'participantModal':
            // FIRST VISIT EVER: Step 1 → Step 2
            // Participant Setup → Welcome
            return 'welcomeModal';
            
        case 'welcomeModal':
            // FIRST VISIT EVER: Step 2 → Step 3
            // Welcome → Pre-Survey
            return 'preSurveyModal';
            
        case 'welcomeBackModal':
            // RETURNING VISIT: Welcome Back → Pre-Survey
            return 'preSurveyModal';
            
        case 'preSurveyModal':
            // Step 3 → Step 4 (if first visit) OR Step 3 → Experience (if returning)
            // Pre-Survey → Tutorial Intro (FIRST VISIT EVER only) OR Experience (returning visits - no modal)
            if (!hasCompletedTutorial) {
                // FIRST VISIT EVER: Pre-Survey → Tutorial Intro
                return 'tutorialIntroModal';
            }
            // SUBSEQUENT VISITS: Pre-Survey → Experience (no modal, user explores)
            // Activity Level will come later when user clicks Submit (handled by handleStudyModeSubmit)
            return null; // No next modal - close overlay and let user explore
            
        case 'tutorialIntroModal':
            // FIRST VISIT EVER: Step 4 → Step 5 (Experience - not a modal)
            // Tutorial Intro → (tutorial runs, then user explores)
            // No next modal - tutorial will handle opening activity level later via workflow
            return null;
            
        case 'activityLevelModal':
            // Step 6 → Step 7 (if first time this week) OR Step 6 → Step 8 (if already done this week)
            // Activity Level → AWE-SF (if first time each week) OR Post-Survey
            if (needsAwesf) {
                // FIRST VISIT OF NEW WEEK or FIRST VISIT EVER: Activity Level → AWE-SF
                return 'awesfModal';
            }
            // SUBSEQUENT VISITS (SAME WEEK): Activity Level → Post-Survey (skip AWE-SF)
            return 'postSurveyModal';
            
        case 'awesfModal':
            // Step 7 → Step 8
            // AWE-SF → Post-Survey (always)
            return 'postSurveyModal';
            
        case 'postSurveyModal':
            // Step 8 → Step 9
            // Post-Survey → End (always)
            return 'endModal';
            
        case 'endModal':
            // Step 9 - Last modal, no next
            return null;
            
        default:
            // Not a workflow modal
            return null;
    }
}

export function closeAllModals() {
    const allModalIds = [
        'welcomeModal',
        'participantModal',
        'preSurveyModal',
        'postSurveyModal',
        'activityLevelModal',
        'awesfModal',
        'endModal',
        'beginAnalysisModal',
        'missingStudyIdModal',
        'completeConfirmationModal',
        'tutorialIntroModal',
        'tutorialRevisitModal',
        'welcomeBackModal'
    ];
    
    allModalIds.forEach(modalId => {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.style.display = 'none';
        }
    });
    
    // Check if we should show UI elements after closing modals
    // Use setTimeout to ensure modal display states are updated first
    setTimeout(() => {
        showUIElementsAfterModal();
    }, 50);
}

export function toggleQuickFillButtons() {
    // Single variable: show quick-fill on local, hide in production
    const showQuickFill = isLocalEnvironment();
    
    // Find all quick-fill button containers and buttons
    const quickFillContainers = document.querySelectorAll('.quick-fill-buttons');
    const quickFillButtons = document.querySelectorAll('.quick-fill-btn');
    
    quickFillContainers.forEach(container => {
        if (showQuickFill) {
            container.style.display = 'flex';
        } else {
            container.style.display = 'none';
        }
    });
    
    quickFillButtons.forEach(btn => {
        if (showQuickFill) {
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
        } else {
            btn.disabled = true;
            btn.style.opacity = '0.5';
            btn.style.cursor = 'not-allowed';
        }
    });
}

// ── Shared modal-wiring helpers ──────────────────────────────────────────

/** Block clicks on the overlay backdrop so modals can't be dismissed by clicking outside. */
function preventClickOutside(modal) {
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            e.preventDefault();
            e.stopPropagation();
            return false;
        }
    });
}

/**
 * Wire Enter (and optionally Escape) key handling for a modal.
 * @param {HTMLElement} modal
 * @param {HTMLButtonElement|null} submitBtn - clicked on Enter (respects .disabled)
 * @param {Object} opts
 * @param {Function} [opts.onEscape] - called on Escape
 * @param {boolean} [opts.documentLevel] - attach to document instead of modal
 */
function wireKeyboardSubmit(modal, submitBtn, opts = {}) {
    const handler = (e) => {
        if (modal.style.display === 'none' || modal.style.display === '') return;
        if (e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
        if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;
        if (e.key === 'Enter') {
            if (!submitBtn || !submitBtn.disabled) {
                e.preventDefault();
                e.stopPropagation();
                submitBtn?.click();
            }
        } else if (e.key === 'Escape' && opts.onEscape) {
            e.preventDefault();
            e.stopPropagation();
            opts.onEscape();
        }
    };
    if (opts.documentLevel) {
        document.addEventListener('keydown', handler);
        modal._keyHandler = handler;
    } else {
        modal.addEventListener('keydown', handler);
    }
}

/**
 * Wire quick-fill buttons and Enter-key random fill for survey modals.
 * @param {HTMLElement} modal
 * @param {string} radioSelector - CSS selector for radio inputs (e.g. 'input[name^="pre"]')
 * @param {number} maxValue - max random value (e.g. 5 or 7)
 * @param {Function} [onUpdate] - called after filling (e.g. to update submit button state)
 */
function wireQuickFill(modal, radioSelector, maxValue, onUpdate) {
    const flashBtn = (btn) => {
        btn.style.background = '#4CAF50';
        btn.style.color = 'white';
        setTimeout(() => { btn.style.background = 'white'; btn.style.color = '#666'; }, 200);
    };

    modal.querySelectorAll('.quick-fill-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const value = btn.getAttribute('data-value');
            modal.querySelectorAll(radioSelector).forEach(radio => {
                if (radio.value === value) {
                    radio.checked = true;
                    radio.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
            if (onUpdate) onUpdate();
            flashBtn(btn);
        });
    });

    modal.addEventListener('keydown', (e) => {
        if (modal.style.display === 'none') return;
        if (e.key === 'Enter' && !e.target.matches('input[type="text"], input[type="number"], button')) {
            e.preventDefault();
            e.stopPropagation();
            const randomValue = Math.floor(Math.random() * maxValue) + 1;
            modal.querySelectorAll(radioSelector).forEach(radio => {
                if (radio.value === randomValue.toString()) {
                    radio.checked = true;
                    radio.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
            if (onUpdate) onUpdate();
            const quickFillBtn = modal.querySelector(`.quick-fill-btn[data-value="${randomValue}"]`);
            if (quickFillBtn) flashBtn(quickFillBtn);
        }
    });
}

// ── Per-modal wiring functions ───────────────────────────────────────────

function wireParticipantModal() {
    const participantModal = document.getElementById('participantModal');
    if (!participantModal) { console.error('❌ Participant modal not found in DOM'); return; }

    const participantCloseBtn = participantModal.querySelector('.modal-close');
    const participantSubmitBtn = participantModal.querySelector('.modal-submit');
    const participantIdInput = document.getElementById('participantId');
    const usernameStatusEl = document.getElementById('usernameStatus');

    let usernameCheckTimeout = null;
    let isUsernameAvailable = false;

    const updateParticipantSubmitButton = () => {
        const hasValue = participantIdInput && participantIdInput.value.trim().length >= 2;
        if (participantSubmitBtn) {
            participantSubmitBtn.disabled = !(hasValue && isUsernameAvailable);
        }
    };

    const checkUsername = async (username) => {
        if (!username || username.length < 3) {
            if (usernameStatusEl) {
                usernameStatusEl.innerHTML = '<span style="color: #666;">Enter at least 3 characters</span>';
            }
            isUsernameAvailable = false;
            updateParticipantSubmitButton();
            return;
        }

        const currentUsername = getParticipantId();
        if (currentUsername && username.toLowerCase() === currentUsername.toLowerCase()) {
            if (usernameStatusEl) {
                usernameStatusEl.innerHTML = '<span style="color: #28a745; font-weight: 600;">✓ Your current username</span>';
            }
            isUsernameAvailable = true;
            updateParticipantSubmitButton();
            return;
        }

        // Local environment: skip production API check, allow any valid username
        // Local usernames don't get added to the production pool
        if (isLocalEnvironment()) {
            if (usernameStatusEl) {
                usernameStatusEl.innerHTML = '<span style="color: #28a745; font-weight: 600;">✓ Local mode (not synced)</span>';
            }
            isUsernameAvailable = true;
            updateParticipantSubmitButton();
            return;
        }

        if (usernameStatusEl) {
            usernameStatusEl.innerHTML = '<span style="color: #666;">Checking availability...</span>';
        }

        try {
            const result = await checkUsernameAvailable(username);

            if (result.available) {
                if (usernameStatusEl) {
                    usernameStatusEl.innerHTML = result.message
                        ? `<span style="color: #28a745; font-weight: 600;">✓ ${result.message}</span>`
                        : '<span style="color: #28a745; font-weight: 600;">✓ Available</span>';
                }
                isUsernameAvailable = true;
            } else if (result.error) {
                if (usernameStatusEl) {
                    usernameStatusEl.innerHTML = `<span style="color: #dc3545;">${result.error}</span>`;
                }
                isUsernameAvailable = false;
            } else {
                if (usernameStatusEl) {
                    usernameStatusEl.innerHTML = '<span style="color: #dc3545;">✗ Username already taken</span>';
                }
                isUsernameAvailable = false;
            }
        } catch (error) {
            console.error('Username check error:', error);
            // On error, allow the username (graceful degradation)
            if (usernameStatusEl) {
                usernameStatusEl.innerHTML = '<span style="color: #999;">Could not verify - proceeding anyway</span>';
            }
            isUsernameAvailable = true;
        }

        updateParticipantSubmitButton();
    };

    const handleUsernameInput = (e) => {
        const username = e.target.value.trim();
        if (usernameCheckTimeout) clearTimeout(usernameCheckTimeout);
        isUsernameAvailable = false;
        updateParticipantSubmitButton();
        usernameCheckTimeout = setTimeout(() => checkUsername(username), 300);
    };

    if (participantIdInput) {
        participantIdInput.addEventListener('input', handleUsernameInput);
    }

    preventClickOutside(participantModal);

    if (participantCloseBtn) {
        participantCloseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }

    if (participantSubmitBtn) {
        participantSubmitBtn.addEventListener('click', async () => {
            const username = participantIdInput?.value.trim();

            // Register the username (claim it) - skip for local environment
            // Exception: EMIC study always registers (even localhost) so heartbeats + syncs work
            // Fire-and-forget: don't block modal close on network round-trip
            const { isEmicStudyMode: isEmic } = await import('./master-modes.js');
            if (username && isUsernameAvailable && (!isLocalEnvironment() || isEmic())) {
                registerUsername(username)
                    .then(() => console.log('✅ Username registered:', username))
                    .catch(error => console.warn('Username registration failed (may already be taken):', error));
            } else if (username && isLocalEnvironment()) {
                console.log('🏠 Local mode: username stored locally only (not registered to production)');
            }

            const { submitParticipantSetup } = await import('./ui-surveys.js');
            submitParticipantSetup();  // Save data locally

            // Mark participant setup as seen when user submits (not before)
            // Works for both Study mode and Solar Portal mode
            markParticipantSetupAsSeen();

            await closeParticipantModal();

            if (isStudyMode()) {
                setTimeout(() => openWelcomeModal(), 350);
            }
        });
    }

    wireKeyboardSubmit(participantModal, participantSubmitBtn, { documentLevel: true });
    updateParticipantSubmitButton();
}

function wireWelcomeModal() {
    const welcomeModal = document.getElementById('welcomeModal');
    if (!welcomeModal) { console.error('❌ Welcome modal not found in DOM'); return; }

    preventClickOutside(welcomeModal);

    const welcomeSubmitBtn = welcomeModal.querySelector('.modal-submit');
    if (welcomeSubmitBtn) {
        welcomeSubmitBtn.addEventListener('click', async () => {
            // Mark welcome as seen when user submits (not before opening)
            if (isStudyMode()) {
                markWelcomeAsSeen();
            }

            await closeWelcomeModal();
            // Open pre-survey after welcome closes (not in EMIC mode)
            const { isEmicStudyMode: isEmic } = await import('./master-modes.js');
            if (!isEmic()) {
                setTimeout(() => openPreSurveyModal(), 350);
            } else {
                // EMIC mode: show instructions with typewriter effect
                // Skip for shared/simulate sessions — fetch is auto-triggered
                const isSharedSession = sessionStorage.getItem('isSharedSession') === 'true';
                if (!isSharedSession) {
                    setTimeout(async () => {
                        const statusEl = document.getElementById('status');
                        if (statusEl) {
                            const { typeText } = await import('./tutorial-effects.js');
                            statusEl.className = 'status info';
                            const msg = State.isMobileScreen()
                                ? 'Press PLAY to begin playback (or use the space bar).'
                                : '👈 Press PLAY to begin playback (or use the space bar).';
                            typeText(statusEl, msg, 15, 5);

                            // After user clicks play, show the drag instruction
                            const playBtn = document.getElementById('playPauseBtn');
                            if (playBtn) {
                                playBtn.addEventListener('click', () => {
                                    setTimeout(async () => {
                                        const { typeText: typeText2 } = await import('./tutorial-effects.js');
                                        const statusEl2 = document.getElementById('status');
                                        if (statusEl2) {
                                            statusEl2.className = 'status info';
                                            const dragMsg = State.isMobileScreen()
                                                ? 'Click and drag on the spectrogram to identify an EMIC wave.'
                                                : 'Click and drag on the main window to identify an EMIC wave.';
                                            typeText2(statusEl2, dragMsg, 15, 5);
                                        }
                                    }, 1000);
                                }, { once: true });
                            }
                        }
                    }, 500);
                }
            }
        });
    }

    wireKeyboardSubmit(welcomeModal, welcomeSubmitBtn, { documentLevel: true });
}

function wireEndModal() {
    const endModal = document.getElementById('endModal');
    if (!endModal) { console.error('❌ End modal not found in DOM'); return; }

    preventClickOutside(endModal);

    const endSubmitBtn = endModal.querySelector('.modal-submit');
    if (endSubmitBtn) {
        endSubmitBtn.addEventListener('click', () => closeEndModal());
    }
}

function wireBeginAnalysisModal() {
    const beginAnalysisModal = document.getElementById('beginAnalysisModal');
    if (!beginAnalysisModal) { console.error('❌ Begin Analysis modal not found in DOM'); return; }

    preventClickOutside(beginAnalysisModal);

    const beginAnalysisCancelBtn = beginAnalysisModal.querySelector('.modal-cancel');
    if (beginAnalysisCancelBtn) {
        beginAnalysisCancelBtn.addEventListener('click', () => closeBeginAnalysisModal(false));
    }

    // Submit dispatches a custom event that main.js listens for to proceed with the workflow
    const beginAnalysisSubmitBtn = beginAnalysisModal.querySelector('.modal-submit');
    if (beginAnalysisSubmitBtn) {
        beginAnalysisSubmitBtn.addEventListener('click', () => {
            closeBeginAnalysisModal();
            window.dispatchEvent(new CustomEvent('beginAnalysisConfirmed'));
        });
    }

    // Custom keyboard: Enter confirms + dispatches event, Escape cancels
    beginAnalysisModal.addEventListener('keydown', (e) => {
        if (beginAnalysisModal.style.display === 'none') return;
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            closeBeginAnalysisModal();
            window.dispatchEvent(new CustomEvent('beginAnalysisConfirmed'));
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeBeginAnalysisModal(false);
        }
    });
}

function wireWelcomeBackModal() {
    const welcomeBackModal = document.getElementById('welcomeBackModal');
    if (!welcomeBackModal) { console.error('❌ Welcome Back modal not found in DOM'); return; }

    preventClickOutside(welcomeBackModal);

    const welcomeBackSubmitBtn = welcomeBackModal.querySelector('.modal-submit');
    if (welcomeBackSubmitBtn) {
        welcomeBackSubmitBtn.addEventListener('click', async () => await closeWelcomeBackModal());
    }

    wireKeyboardSubmit(welcomeBackModal, welcomeBackSubmitBtn);
}

function wireCompleteConfirmationModal() {
    const completeConfirmationModal = document.getElementById('completeConfirmationModal');
    if (!completeConfirmationModal) { console.error('❌ Complete Confirmation modal not found in DOM'); return; }

    preventClickOutside(completeConfirmationModal);

    const completeCancelBtn = completeConfirmationModal.querySelector('.modal-cancel');
    if (completeCancelBtn) {
        completeCancelBtn.addEventListener('click', closeCompleteConfirmationModal);
    }

    const completeSubmitBtn = completeConfirmationModal.querySelector('.modal-submit');
    if (completeSubmitBtn) {
        completeSubmitBtn.addEventListener('click', async () => {
            const { hasIdentifiedFeature } = await import('./region-tracker.js');
            if (!hasIdentifiedFeature()) {
                console.warn('⚠️ Complete button clicked but no feature selected');
                const statusEl = document.getElementById('status');
                if (statusEl) {
                    statusEl.className = 'status error';
                    statusEl.textContent = '❌ Please identify at least one feature before completing.';
                }
                return;
            }

            const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
            enableAllTutorialRestrictedFeatures();
            console.log('✅ Features enabled after feature selection');

            const { isStudyMode } = await import('./master-modes.js');
            // In study mode, use the workflow. Otherwise, open activity level directly
            if (isStudyMode()) {
                console.log('🎓 Study Mode: Starting submit workflow...');
                // keepOverlay: true so overlay stays for Activity Level modal
                await modalManager.closeModal('completeConfirmationModal', { keepOverlay: true });
                console.log('✅ Complete Confirmation modal closed (overlay kept for workflow)');
                const { handleStudyModeSubmit } = await import('./study-workflow.js');
                await handleStudyModeSubmit();
            } else {
                closeCompleteConfirmationModal();
                openActivityLevelModal();
            }
        });
    }
}

function wireMissingStudyIdModal() {
    const missingStudyIdModal = document.getElementById('missingStudyIdModal');
    if (!missingStudyIdModal) { console.error('❌ Missing Study ID modal not found in DOM'); return; }

    preventClickOutside(missingStudyIdModal);

    const enterStudyIdBtn = missingStudyIdModal.querySelector('.modal-submit');
    if (enterStudyIdBtn) {
        enterStudyIdBtn.addEventListener('click', () => {
            closeMissingStudyIdModal();
            setTimeout(() => openParticipantModal(), 100); // Small delay to ensure modal closes first
        });
    }
}

function wirePreSurveyModal() {
    const preSurveyModal = document.getElementById('preSurveyModal');
    if (!preSurveyModal) { console.error('❌ Pre-survey modal not found in DOM'); return; }

    const preSurveyCloseBtn = preSurveyModal.querySelector('.modal-close');
    const preSurveySubmitBtn = preSurveyModal.querySelector('.modal-submit');

    const updatePreSurveySubmitButton = () => {
        const allAnswered =
            document.querySelector('input[name="preCalm"]:checked') &&
            document.querySelector('input[name="preEnergized"]:checked') &&
            document.querySelector('input[name="preNervous"]:checked') &&
            document.querySelector('input[name="preFocused"]:checked') &&
            document.querySelector('input[name="preConnected"]:checked') &&
            document.querySelector('input[name="preWonder"]:checked');
        if (preSurveySubmitBtn) preSurveySubmitBtn.disabled = !allAnswered;
    };

    preSurveyModal.querySelectorAll('input[type="radio"]').forEach(radio => {
        radio.addEventListener('change', updatePreSurveySubmitButton);
    });

    preventClickOutside(preSurveyModal);

    if (preSurveyCloseBtn) {
        preSurveyCloseBtn.addEventListener('click', (e) => { e.stopPropagation(); closePreSurveyModal(); });
    }

    if (preSurveySubmitBtn) {
        preSurveySubmitBtn.addEventListener('click', async () => {
            const { submitPreSurvey } = await import('./ui-surveys.js');
            await submitPreSurvey();

            // Auto-detect next modal using workflow logic
            const nextModal = await getNextModalInWorkflow('preSurveyModal');
            console.log('🔍 Pre-Survey submit: nextModal =', nextModal);
            await closePreSurveyModal(nextModal !== null);
            startActivityTimer(); // Start activity timer after pre-survey completion

            // In study mode, open the next modal in workflow
            if (isStudyMode() && nextModal) {
                setTimeout(() => {
                    // First visit → tutorial intro; returning visit → user explores freely
                    if (nextModal === 'tutorialIntroModal') {
                        console.log('🎓 Opening Tutorial Intro modal...');
                        openTutorialIntroModal();
                    } else if (nextModal === 'activityLevelModal') {
                        // This shouldn't happen after pre-survey - Activity Level comes after Submit
                        console.warn('⚠️ Pre-Survey: Activity Level detected as next modal - this is wrong! Closing overlay and letting user explore.');
                        fadeOutOverlay();
                    } else {
                        // Returning visit: Activity Level will open when user clicks Submit button
                        console.log('📊 Pre-Survey complete - ready for experience. Activity Level will show after Submit.');
                        fadeOutOverlay();
                    }
                }, 350);
            } else if (isStudyMode() && !nextModal) {
                // No next modal - correct for returning visits. Close overlay and let user explore
                console.log('📊 Pre-Survey complete - no next modal (returning visit). Closing overlay, ready for experience.');
                fadeOutOverlay();
            }
        });
    }

    wireKeyboardSubmit(preSurveyModal, preSurveySubmitBtn, { documentLevel: true });
    updatePreSurveySubmitButton();
    wireQuickFill(preSurveyModal, 'input[name^="pre"]', 5, updatePreSurveySubmitButton);
}

function wirePostSurveyModal() {
    const postSurveyModal = document.getElementById('postSurveyModal');
    if (!postSurveyModal) { console.error('❌ Post-survey modal not found in DOM'); return; }

    const postSurveyCloseBtn = postSurveyModal.querySelector('.modal-close');
    const postSurveySubmitBtn = postSurveyModal.querySelector('.modal-submit');

    const updatePostSurveySubmitButton = () => {
        const allAnswered =
            document.querySelector('input[name="postCalm"]:checked') &&
            document.querySelector('input[name="postEnergized"]:checked') &&
            document.querySelector('input[name="postNervous"]:checked') &&
            document.querySelector('input[name="postFocused"]:checked') &&
            document.querySelector('input[name="postConnected"]:checked') &&
            document.querySelector('input[name="postWonder"]:checked');
        if (postSurveySubmitBtn) postSurveySubmitBtn.disabled = !allAnswered;
    };

    postSurveyModal.querySelectorAll('input[type="radio"]').forEach(radio => {
        radio.addEventListener('change', updatePostSurveySubmitButton);
    });

    preventClickOutside(postSurveyModal);

    if (postSurveyCloseBtn) {
        postSurveyCloseBtn.addEventListener('click', (e) => { e.stopPropagation(); closePostSurveyModal(); });
    }

    if (postSurveySubmitBtn) {
        postSurveySubmitBtn.addEventListener('click', async () => {
            const { submitPostSurvey } = await import('./ui-surveys.js');
            await submitPostSurvey();
            await closePostSurveyModal();

            // In study mode, submit all surveys to Qualtrics and show end modal
            if (isStudyMode()) {
                setTimeout(async () => {
                    try {
                        const { attemptSubmission } = await import('./ui-controls.js');
                        await attemptSubmission(true);  // fromWorkflow=true
                        console.log('✅ Submission complete');
                    } catch (error) {
                        console.error('❌ Error during submission:', error);
                        // Continue to show end modal even if submission fails
                    }

                    // Show end modal (always show, even if submission had issues)
                    const { getParticipantId } = await import('./qualtrics-api.js');
                    const { incrementSessionCount } = await import('./study-workflow.js');
                    const participantId = getParticipantId();
                    const sessionCount = incrementSessionCount();
                    console.log('🎉 Opening end modal...', { participantId, sessionCount });
                    openEndModal(participantId, sessionCount);
                    console.log('✅ End modal should now be visible');
                }, 350);
            }
        });
    }

    updatePostSurveySubmitButton();
    wireQuickFill(postSurveyModal, 'input[name^="post"]', 5, updatePostSurveySubmitButton);
}

function wireActivityLevelModal() {
    const activityLevelModal = document.getElementById('activityLevelModal');
    if (!activityLevelModal) { console.error('❌ Activity Level modal not found in DOM'); return; }

    const activityLevelCloseBtn = activityLevelModal.querySelector('.modal-close');
    const activityLevelSubmitBtn = activityLevelModal.querySelector('.modal-submit');

    const updateActivityLevelSubmitButton = () => {
        const answered = document.querySelector('input[name="activityLevel"]:checked');
        if (activityLevelSubmitBtn) activityLevelSubmitBtn.disabled = !answered;
    };

    activityLevelModal.querySelectorAll('input[type="radio"]').forEach(radio => {
        radio.addEventListener('change', updateActivityLevelSubmitButton);
    });

    preventClickOutside(activityLevelModal);

    if (activityLevelCloseBtn) {
        activityLevelCloseBtn.addEventListener('click', (e) => { e.stopPropagation(); closeActivityLevelModal(); });
    }

    if (activityLevelSubmitBtn) {
        activityLevelSubmitBtn.addEventListener('click', async () => {
            if (window.pm?.interaction) console.log('🔵 Activity Level submit button clicked');
            const { submitActivityLevelSurvey } = await import('./ui-surveys.js');
            const success = await submitActivityLevelSurvey();

            if (!success) {
                // Submission failed (e.g., no participant ID) - keep modal open
                console.log('❌ Activity Level submission failed - keeping modal open');
                return;
            }

            console.log('✅ Activity Level submission successful');

            // In study mode, the workflow is waiting for the modal to close via its promise from openModal
            const { isStudyMode } = await import('./master-modes.js');
            console.log('🔍 isStudyMode:', isStudyMode());
            if (isStudyMode()) {
                console.log('✅ Activity Level saved - closing modal for workflow...');
                // Close the modal (auto-detects next modal and keeps overlay)
                await closeActivityLevelModal();
                // Open next survey in workflow
                const { shouldShowAwesf } = await import('./study-workflow.js');
                if (shouldShowAwesf()) {
                    setTimeout(() => openAwesfModal(), 350);
                } else {
                    setTimeout(() => openPostSurveyModal(), 350);
                }
                console.log('✅ Activity Level modal closed - workflow will continue');
            } else {
                await closeActivityLevelModal();
            }
        });
    }

    updateActivityLevelSubmitButton();
}

function wireAwesfModal() {
    const awesfModal = document.getElementById('awesfModal');
    if (!awesfModal) { console.error('❌ AWE-SF modal not found in DOM'); return; }

    const awesfCloseBtn = awesfModal.querySelector('.modal-close');
    const awesfSubmitBtn = awesfModal.querySelector('.modal-submit');

    const updateAwesfSubmitButton = () => {
        const allAnswered =
            document.querySelector('input[name="slowDown"]:checked') &&
            document.querySelector('input[name="reducedSelf"]:checked') &&
            document.querySelector('input[name="chills"]:checked') &&
            document.querySelector('input[name="oneness"]:checked') &&
            document.querySelector('input[name="grand"]:checked') &&
            document.querySelector('input[name="diminishedSelf"]:checked') &&
            document.querySelector('input[name="timeSlowing"]:checked') &&
            document.querySelector('input[name="awesfConnected"]:checked') &&
            document.querySelector('input[name="small"]:checked') &&
            document.querySelector('input[name="vastness"]:checked') &&
            document.querySelector('input[name="challenged"]:checked') &&
            document.querySelector('input[name="selfShrink"]:checked');
        if (awesfSubmitBtn) awesfSubmitBtn.disabled = !allAnswered;
    };

    // AWE-SF needs extra stopPropagation on radios/labels to prevent event bubbling
    awesfModal.querySelectorAll('input[type="radio"]').forEach(radio => {
        radio.addEventListener('change', (e) => { e.stopPropagation(); updateAwesfSubmitButton(); });
        radio.addEventListener('click', (e) => e.stopPropagation());
    });
    awesfModal.querySelectorAll('label').forEach(label => {
        label.addEventListener('click', (e) => e.stopPropagation());
    });

    preventClickOutside(awesfModal);

    if (awesfCloseBtn) {
        awesfCloseBtn.addEventListener('click', (e) => { e.stopPropagation(); closeAwesfModal(); });
    }

    if (awesfSubmitBtn) {
        awesfSubmitBtn.addEventListener('click', async () => {
            const { submitAwesfSurvey } = await import('./ui-surveys.js');
            await submitAwesfSurvey();
            await closeAwesfModal();
            // Open post-survey after AWE-SF closes
            setTimeout(() => openPostSurveyModal(), 350);
        });
    }

    updateAwesfSubmitButton();
    wireQuickFill(awesfModal, 'input[type="radio"]', 7, updateAwesfSubmitButton);
}

function wireTutorialIntroModal() {
    const tutorialIntroModal = document.getElementById('tutorialIntroModal');
    if (!tutorialIntroModal) { console.error('❌ Tutorial Intro modal not found in DOM'); return; }

    preventClickOutside(tutorialIntroModal);

    const tutorialIntroSubmitBtn = tutorialIntroModal.querySelector('.modal-submit');
    if (tutorialIntroSubmitBtn) {
        tutorialIntroSubmitBtn.addEventListener('click', async () => {
            console.log('🎓🔥 BEGIN TUTORIAL BUTTON CLICKED - DISABLING CONTROLS NOW');
            console.trace('Stack trace for Begin Tutorial click:');

            // Mark tutorial as in progress immediately when user clicks "Begin Tutorial"
            const { markTutorialAsInProgress } = await import('./study-workflow.js');
            markTutorialAsInProgress();

            // Disable speed and volume controls during tutorial (tutorial will re-enable at appropriate time)
            const speedSlider = document.getElementById('playbackSpeed');
            const volumeSlider = document.getElementById('volumeSlider');
            const speedLabel = document.getElementById('speedLabel');
            const volumeLabel = document.getElementById('volumeLabel');
            if (speedSlider) speedSlider.disabled = true;
            if (volumeSlider) volumeSlider.disabled = true;
            if (speedLabel) speedLabel.style.opacity = '0.5';
            if (volumeLabel) volumeLabel.style.opacity = '0.5';
            console.log('🔒 Speed and volume controls DISABLED for tutorial');

            closeTutorialIntroModal();

            // Start the tutorial after modal closes
            setTimeout(async () => {
                const { runInitialTutorial } = await import('./tutorial.js');
                await runInitialTutorial();
                // Mark tutorial as seen after it completes
                const { markTutorialAsSeen } = await import('./study-workflow.js');
                markTutorialAsSeen();
            }, 350);
        });
    }

    wireKeyboardSubmit(tutorialIntroModal, tutorialIntroSubmitBtn, { documentLevel: true });
}

function wireTutorialRevisitModal() {
    const tutorialRevisitModal = document.getElementById('tutorialRevisitModal');
    if (!tutorialRevisitModal) { console.error('❌ Tutorial Revisit modal not found in DOM'); return; }

    preventClickOutside(tutorialRevisitModal);

    const tutorialRevisitBtn1 = tutorialRevisitModal.querySelector('#tutorialRevisitBtn1');
    const tutorialRevisitBtn2 = tutorialRevisitModal.querySelector('#tutorialRevisitBtn2');
    const tutorialRevisitBtn3 = tutorialRevisitModal.querySelector('#tutorialRevisitBtn3');

    // Button 1: Continue (when active) or Yes/restart (when not active)
    if (tutorialRevisitBtn1) {
        tutorialRevisitBtn1.addEventListener('click', async () => {
            const { isTutorialActive } = await import('./tutorial-state.js');
            if (isTutorialActive()) {
                closeTutorialRevisitModal(false);
                console.log('▶️ Continuing tutorial');
            } else {
                closeTutorialRevisitModal(false);
                localStorage.removeItem(STORAGE_KEYS.TUTORIAL_COMPLETED);
                console.log('🔄 Tutorial flag cleared - will restart tutorial');
                setTimeout(async () => {
                    const { runInitialTutorial } = await import('./tutorial-coordinator.js');
                    await runInitialTutorial();
                }, 300);
            }
        });
    }

    // Button 2: Restart (when active) or Cancel (when not active)
    if (tutorialRevisitBtn2) {
        tutorialRevisitBtn2.addEventListener('click', async () => {
            const { isTutorialActive } = await import('./tutorial-state.js');
            if (isTutorialActive()) {
                closeTutorialRevisitModal(false);
                const { clearTutorialPhase } = await import('./tutorial-state.js');
                clearTutorialPhase();
                localStorage.removeItem(STORAGE_KEYS.TUTORIAL_COMPLETED);
                console.log('🔄 Restarting tutorial');
                setTimeout(async () => {
                    const { runInitialTutorial } = await import('./tutorial-coordinator.js');
                    await runInitialTutorial();
                }, 300);
            } else {
                closeTutorialRevisitModal(false);
            }
        });
    }

    // Button 3: Exit tutorial (only shown when tutorial is active)
    if (tutorialRevisitBtn3) {
        tutorialRevisitBtn3.addEventListener('click', async () => {
            closeTutorialRevisitModal(false);
            const { clearTutorialPhase } = await import('./tutorial-state.js');
            clearTutorialPhase();
            const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
            await enableAllTutorialRestrictedFeatures();
            const { markTutorialAsSeen } = await import('./study-workflow.js');
            markTutorialAsSeen();
            console.log('🚪 Exited tutorial - features enabled');
        });
    }

    // Custom keyboard: Enter for first button, Escape to close
    tutorialRevisitModal.addEventListener('keydown', (e) => {
        if (tutorialRevisitModal.style.display === 'none') return;
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            if (tutorialRevisitBtn1) tutorialRevisitBtn1.click();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeTutorialRevisitModal(false);
        }
    });
}

// ── Main entry point ─────────────────────────────────────────────────────

export function setupModalEventListeners() {
    if (modalListenersSetup) {
        console.warn('⚠️ Modal listeners already set up - removing old listeners first');
        removeModalEventListeners();
    }

    // Shared modals (used by both EMIC and volcano study)
    wireParticipantModal();
    wireWelcomeModal();

    // Volcano study modals — skip in EMIC mode (these DOM elements don't exist in emic_study.html)
    if (!isEmicStudyMode()) {
        wireEndModal();
        wireBeginAnalysisModal();
        wireWelcomeBackModal();
        wireCompleteConfirmationModal();
        wireMissingStudyIdModal();
        wirePreSurveyModal();
        wirePostSurveyModal();
        wireActivityLevelModal();
        wireAwesfModal();
        wireTutorialIntroModal();
        wireTutorialRevisitModal();
        toggleQuickFillButtons();
    }

    modalListenersSetup = true;
    if (window.pm?.init) console.log('📋 Modal event listeners attached (using ModalManager)');
}

/**
 * Remove all modal event listeners to prevent NativeContext accumulation
 * Called before re-adding listeners to ensure old closures are broken
 */
function removeModalEventListeners() {
    // 🔥 FIX: Clone modals to break all event listener references
    // This ensures old closures (NativeContext instances) can be garbage collected
    const modalIds = ['participantModal', 'preSurveyModal', 'postSurveyModal', 'activityLevelModal', 'awesfModal'];
    
    modalIds.forEach(modalId => {
        const modal = document.getElementById(modalId);
        if (modal) {
            if (modal.parentNode) {
                // Clone to break all event listeners
                const cloned = modal.cloneNode(true); // Deep clone to preserve structure
                modal.parentNode.replaceChild(cloned, modal);
                // The original modal with listeners is now detached and can be GC'd
                // Clear all child nodes from the cloned modal to break internal references
                while (cloned.firstChild) {
                    cloned.removeChild(cloned.firstChild);
                }
                // Remove the clone itself
                cloned.parentNode.removeChild(cloned);
            } else {
                // Already detached, clear all child nodes to break internal references
                while (modal.firstChild) {
                    modal.removeChild(modal.firstChild);
                }
            }
        }
    });
    
    modalListenersSetup = false;
}

export async function openParticipantModal() {
    console.log('🔍 openParticipantModal() called');
    
    // Close all other modals first
    closeAllModals();
    
    const modal = document.getElementById('participantModal');
    if (!modal) {
        console.error('❌ CRITICAL: Participant modal not found in DOM!');
        console.error('   This means modals were not initialized. Check initializeModals() was called.');
        // Don't fade in overlay if modal doesn't exist
        return;
    }
    
    // Get participant ID from URL (takes precedence) or localStorage
    const participantId = getParticipantId();
    const urlId = getParticipantIdFromURL(); // Check if ID came from Qualtrics URL
    const participantIdInput = document.getElementById('participantId');
    const participantSubmitBtn = document.querySelector('#participantModal .modal-submit');
    const modalTitle = modal.querySelector('.modal-title');
    const allBodyParagraphs = modal.querySelectorAll('.modal-body p');
    const instructionText = allBodyParagraphs[0] || null;
    const subtitleText = allBodyParagraphs[1] || null;
    
    // Determine context: initial setup vs upper right corner click
    const hasExistingId = participantId && participantId.trim().length > 0;
    const idFromQualtrics = urlId && urlId.trim().length > 0;
    
    // Check welcome mode from master-modes config
    const { getCurrentModeConfig } = await import('./master-modes.js');
    const modeConfig = getCurrentModeConfig();
    const welcomeMode = modeConfig.welcomeMode || 'user';  // default to 'user'
    
    // Dynamically update modal text based on context + welcome mode
    if (welcomeMode === 'participant') {
        // Formal study mode — participant ID
        if (modalTitle) {
            modalTitle.textContent = "☀️ Welcome";
        }
        if (hasExistingId && idFromQualtrics) {
            if (instructionText) {
                instructionText.textContent = "Your participant ID has been transferred from Qualtrics:";
                instructionText.style.fontWeight = 'bold';
            }
        } else if (hasExistingId) {
            if (instructionText) {
                instructionText.textContent = "Enter your participant ID below:";
                instructionText.style.fontWeight = 'bold';
            }
        } else {
            if (instructionText) {
                instructionText.textContent = "Enter your participant ID below:";
                instructionText.style.fontWeight = 'bold';
            }
        }
        if (subtitleText) {
            subtitleText.textContent = "This will be used to track your responses for the study.";
        }
        // Update input placeholder
        if (participantIdInput) {
            participantIdInput.placeholder = 'Enter participant ID...';
        }
    } else {
        // Casual user mode (default) — user name
        if (hasExistingId && !idFromQualtrics) {
            if (modalTitle) {
                modalTitle.textContent = "☀️ Welcome!";
            }
            if (instructionText) {
                instructionText.textContent = "Enter your user name below:";
                instructionText.style.fontWeight = 'normal';
            }
        } else if (hasExistingId && idFromQualtrics) {
            if (modalTitle) {
                modalTitle.textContent = "☀️ Welcome";
            }
            if (instructionText) {
                instructionText.textContent = "Your participant ID has successfully been transferred from Qualtrics:";
                instructionText.style.fontWeight = 'bold';
            }
        } else {
            if (modalTitle) {
                modalTitle.textContent = "☀️ Welcome";
            }
            if (instructionText) {
                instructionText.textContent = "Enter a user name to begin:";
                instructionText.style.fontWeight = 'bold';
            }
        }
    }
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    
    if (participantIdInput) {
        // Pre-populate with ID from URL or localStorage
        participantIdInput.value = participantId || '';
        
        if (urlId) {
            console.log('🔗 Participant ID loaded from URL:', urlId);
        }
    } else {
        console.warn('⚠️ Participant ID input not found');
    }
    
    // Update button state based on whether there's a value
    if (participantSubmitBtn) {
        const hasValue = participantIdInput && participantIdInput.value.trim().length > 0;
        participantSubmitBtn.disabled = !hasValue;
    } else {
        console.warn('⚠️ Participant submit button not found');
    }
    
    // Show the modal with fade
    showModal(modal);
    console.log('👤 Participant Setup modal opened');
    console.log('   Modal element:', modal);
    console.log('   Modal display:', modal.style.display);
    console.log('   Overlay visible:', document.getElementById('permanentOverlay')?.style.display);
    console.log('   Has existing ID:', hasExistingId);
}

export async function closeParticipantModal(keepOverlay = null) {
    // Auto-detect if overlay should be kept (if keepOverlay not explicitly provided)
    if (keepOverlay === null) {
        // If opened manually (not as part of workflow), always fade out overlay
        // Check if this is a manual open by seeing if we're in the middle of a workflow
        // If workflow is skipped OR if participant setup was already seen, this is manual
        const skipWorkflow = localStorage.getItem('skipStudyWorkflow') === 'true';
        const hasSeenSetup = hasSeenParticipantSetup();
        
        const { isEmicStudyMode } = await import('./master-modes.js');
        if (isEmicStudyMode()) {
            // EMIC mode: always keep overlay (welcome modal follows)
            keepOverlay = true;
        } else if (skipWorkflow || hasSeenSetup) {
            // Manual open - always fade out overlay
            keepOverlay = false;
        } else {
            // Part of workflow - check if there's a next modal
            const nextModal = await getNextModalInWorkflow('participantModal');
            keepOverlay = nextModal !== null;
        }
    }
    
    // Only allow programmatic closing (after submission), not by clicking outside
    // Reset field to saved value (or empty) when closing without saving
    // In STUDY_CLEAN mode, don't load saved participant ID
    const storedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('selectedMode') : null;
    const isStudyClean = storedMode === 'study_clean';
    const savedParticipantId = isStudyClean ? null : localStorage.getItem('participantId');
    const participantIdInput = document.getElementById('participantId');
    const participantSubmitBtn = document.querySelector('#participantModal .modal-submit');
    
    if (participantIdInput) {
        participantIdInput.value = savedParticipantId || '';
    }
    
    // Update button state based on whether there's a value
    if (participantSubmitBtn) {
        const hasValue = participantIdInput && participantIdInput.value.trim().length > 0;
        participantSubmitBtn.disabled = !hasValue;
    }
    
    const modal = document.getElementById('participantModal');
    hideModal(modal);
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    console.log(`👤 Participant Setup modal closed (keepOverlay: ${keepOverlay})`);
}

// Participant Info Modal (read-only display when clicking participant ID)
export async function openParticipantInfoModal() {
    const modal = document.getElementById('participantInfoModal');
    if (!modal) {
        console.warn('⚠️ Participant info modal not found');
        return;
    }

    closeAllModals();

    // Populate the current participant ID
    const { getParticipantId, storeParticipantId } = await import('./qualtrics-api.js');
    const participantId = getParticipantId();
    const idDisplay = document.getElementById('participantInfoId');
    const idInput = document.getElementById('participantInfoInput');
    const changeBtn = document.getElementById('participantInfoChangeBtn');
    const saveBtn = document.getElementById('participantInfoSaveBtn');
    const cancelBtn = document.getElementById('participantInfoCancelBtn');

    if (idDisplay) {
        idDisplay.textContent = participantId || '--';
    }

    // Reset to display mode each time modal opens
    if (idDisplay) idDisplay.style.display = '';
    if (idInput) idInput.style.display = 'none';
    if (changeBtn) changeBtn.style.display = '';
    if (saveBtn) saveBtn.style.display = 'none';
    if (cancelBtn) cancelBtn.style.display = 'none';

    // Wire Change/Save/Cancel
    if (changeBtn) {
        changeBtn.onclick = () => {
            idDisplay.style.display = 'none';
            idInput.style.display = '';
            idInput.value = participantId || '';
            changeBtn.style.display = 'none';
            saveBtn.style.display = '';
            cancelBtn.style.display = '';
            idInput.focus();
            idInput.select();
        };
    }
    if (cancelBtn) {
        cancelBtn.onclick = () => {
            idDisplay.style.display = '';
            idInput.style.display = 'none';
            changeBtn.style.display = '';
            saveBtn.style.display = 'none';
            cancelBtn.style.display = 'none';
        };
    }
    if (saveBtn) {
        saveBtn.onclick = () => {
            const newId = idInput.value.trim();
            if (newId) {
                storeParticipantId(newId);
                idDisplay.textContent = newId;
                // Update the top-bar participant display
                const topBarValue = document.getElementById('participantIdValue');
                if (topBarValue) topBarValue.textContent = newId;
            }
            idDisplay.style.display = '';
            idInput.style.display = 'none';
            changeBtn.style.display = '';
            saveBtn.style.display = 'none';
            cancelBtn.style.display = 'none';
        };
    }
    // Allow Enter to save
    if (idInput) {
        idInput.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); saveBtn?.click(); }
            if (e.key === 'Escape') { e.preventDefault(); cancelBtn?.click(); }
        };
    }

    // Update title based on welcome mode
    const { getCurrentModeConfig } = await import('./master-modes.js');
    const modeConfig = getCurrentModeConfig();
    const welcomeMode = modeConfig.welcomeMode || 'user';
    const modalTitle = modal.querySelector('.modal-title');
    if (modalTitle) {
        modalTitle.textContent = welcomeMode === 'participant' ? 'Your Participant ID' : 'Your User Name';
    }

    // Wire close button
    const closeBtn = modal.querySelector('.modal-close');
    if (closeBtn) {
        closeBtn.onclick = () => {
            hideModal(modal);
            fadeOutOverlay();
        };
    }

    fadeInOverlay();
    showModal(modal);
}

// Welcome Modal Functions
export async function openWelcomeModal() {
    // In Study Mode, ONLY allow welcome modal through the workflow - NEVER allow manual opening
    // EMIC study always shows welcome modal — skip the guards
    const { isEmicStudyMode } = await import('./master-modes.js');
    if (isStudyMode() && !isEmicStudyMode()) {
        // In STUDY mode, welcome modal can ONLY be opened through the workflow
        // Check if we're in the workflow by checking if pre-survey is already open
        const preSurveyModal = document.getElementById('preSurveyModal');
        const isPreSurveyOpen = preSurveyModal && preSurveyModal.style.display !== 'none';
        
        // If pre-survey is open, we're past the welcome step - don't allow welcome modal
        if (isPreSurveyOpen) {
            console.warn('⚠️ Welcome modal: Cannot open - pre-survey is already active');
            return;
        }
        
        const hasSeenSetup = hasSeenParticipantSetup();
        if (!hasSeenSetup) {
            console.warn('⚠️ Welcome modal: Participant setup must be completed first in Study Mode');
            return;
        }
        
        // In STUDY mode (not clean), only show welcome modal once (first time only)
        if (!isStudyCleanMode()) {
            if (hasSeenWelcome()) {
                console.log('✅ Welcome modal already seen - skipping in STUDY mode');
                return;
            }
        }
    }
    
    const welcomeModal = document.getElementById('welcomeModal');
    if (!welcomeModal) {
        console.warn('⚠️ Welcome modal not found');
        return;
    }
    
    // Close all other modals first
    closeAllModals();
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    
    // Update content based on welcome mode
    const { getCurrentModeConfig } = await import('./master-modes.js');
    const modeConfig = getCurrentModeConfig();
    const welcomeMode = modeConfig.welcomeMode || 'user';
    
    if (welcomeMode === 'participant') {
        const title = welcomeModal.querySelector('.modal-title');
        const paragraphs = welcomeModal.querySelectorAll('.modal-body p');
        if (title) title.textContent = '🔬 EMIC Wave Analysis Study';
        // Update existing paragraphs in place (preserves button + its event handler)
        if (paragraphs[0]) {
            paragraphs[0].innerHTML = 'You will be listening to magnetometer data from the <b>GOES satellite</b> and identifying <b>EMIC waves</b>. Please use headphones or high-quality speakers in a quiet environment free from distractions.';
        }
        if (paragraphs[1]) {
            paragraphs[1].innerHTML = 'If you have any questions, contact Lucy Williams at <a href="mailto:lewilliams@smith.edu" style="color: #007bff; text-decoration: none; font-weight: 600;">lewilliams@smith.edu</a>.';
        }
        // Hide extra paragraphs (original has 4, we only need 2)
        if (paragraphs[2]) paragraphs[2].style.display = 'none';
        if (paragraphs[3]) paragraphs[3].style.display = 'none';
    }
    
    showModal(welcomeModal);
    console.log('👋 Welcome modal opened');
}

export async function closeWelcomeModal(keepOverlay = null) {
    // Auto-detect if overlay should be kept (if keepOverlay not explicitly provided)
    const { isEmicStudyMode } = await import('./master-modes.js');
    if (isEmicStudyMode()) {
        // EMIC: welcome is the last modal, always dismiss overlay
        keepOverlay = false;
    } else if (keepOverlay === null) {
        const nextModal = await getNextModalInWorkflow('welcomeModal');
        keepOverlay = nextModal !== null;
    }
    
    const modal = document.getElementById('welcomeModal');
    hideModal(modal);
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        setTimeout(() => fadeOutOverlay(), 250);
    }
    
    console.log(`👋 Welcome modal closed (keepOverlay: ${keepOverlay})`);
    
    // Set EMIC welcome-closed flag + sync to server
    if (isEmicStudyMode()) {
        import('./emic-study-flags.js').then(({ EMIC_FLAGS, setEmicFlag }) => {
            setEmicFlag(EMIC_FLAGS.HAS_CLOSED_WELCOME);
        });
        import('./data-uploader.js').then(({ syncEmicProgress }) => {
            const pid = localStorage.getItem('participantId');
            if (pid) syncEmicProgress(pid, 'welcome_closed');
        });
    }
}

// End Modal Functions
export async function openEndModal(participantId, sessionCount) {
    console.log('🔍 openEndModal called', { participantId, sessionCount });
    
    // Close all other modals first
    closeAllModals();
    
    const modal = document.getElementById('endModal');
    if (!modal) {
        console.error('❌ CRITICAL: End modal not found in DOM!');
        return;
    }
    console.log('✅ End modal found in DOM');
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    console.log('✅ Overlay faded in');
    
    // Update submission date and time in formal certificate format
    try {
        const now = new Date();
        
        // Format date: "November 19, 2025"
        const dateString = now.toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric'
        });
        
        // Format time: "01:44:40 AM"
        const timeString = now.toLocaleTimeString('en-US', { 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit',
            hour12: true 
        });
        
        const dateEl = document.getElementById('submissionDate');
        const timeEl = document.getElementById('submissionTime');
        
        if (dateEl) {
            dateEl.textContent = dateString;
        }
        if (timeEl) {
            timeEl.textContent = timeString;
        }
    } catch (error) {
        console.warn('⚠️ Could not update submission date/time:', error);
    }
    
    // Update participant ID
    try {
        const pidEl = document.getElementById('submissionParticipantId');
        if (pidEl) {
            pidEl.textContent = participantId || 'Unknown';
        }
    } catch (error) {
        console.warn('⚠️ Could not update participant ID:', error);
    }
    
    // Week and session text removed from modal - no longer needed
    
    // Update visual session tracker
    try {
        const { getSessionCompletionTracker } = await import('./study-workflow.js');
        const tracker = getSessionCompletionTracker();
        
        // Update overall progress percentage
        const overallProgressPercentEl = document.getElementById('overallProgressPercent');
        if (overallProgressPercentEl) {
            overallProgressPercentEl.textContent = `${tracker.progressPercent}%`;
        }
        
        // Update visual session boxes
        const weeks = ['week1', 'week2', 'week3'];
        weeks.forEach((week, weekIndex) => {
            for (let session = 1; session <= 2; session++) {
                const boxId = `${week}session${session}`;
                const boxEl = document.getElementById(boxId);
                if (boxEl && tracker[week] && tracker[week][session - 1]) {
                    // Filled - completed session
                    boxEl.style.background = 'linear-gradient(135deg, #0056b3 0%, #0066cc 100%)';
                    boxEl.style.boxShadow = '0 2px 4px rgba(0, 86, 179, 0.3)';
                } else if (boxEl) {
                    // Empty - not completed
                    boxEl.style.background = '#e9ecef';
                    boxEl.style.boxShadow = 'none';
                }
            }
        });
    } catch (error) {
        console.warn('⚠️ Could not update session tracker:', error);
    }
    
    // Update cumulative stats (always display, even if 0)
    try {
        const { getCumulativeCounts } = await import('./study-workflow.js');
        const cumulativeStats = getCumulativeCounts();
        
        const cumulativeCard = document.getElementById('cumulativeStatsCard');
        const cumulativeRegionsEl = document.getElementById('cumulativeRegions');
        const cumulativeRegionWordEl = document.getElementById('cumulativeRegionWord');
        const cumulativeFeaturesEl = document.getElementById('cumulativeFeatures');
        const cumulativeFeatureWordEl = document.getElementById('cumulativeFeatureWord');
        
        if (cumulativeStats) {
            if (cumulativeRegionsEl) {
                cumulativeRegionsEl.textContent = cumulativeStats.totalRegions;
            }
            if (cumulativeRegionWordEl) {
                cumulativeRegionWordEl.textContent = cumulativeStats.totalRegions === 1 ? 'region' : 'regions';
            }
            if (cumulativeFeaturesEl) {
                cumulativeFeaturesEl.textContent = cumulativeStats.totalFeatures;
            }
            if (cumulativeFeatureWordEl) {
                cumulativeFeatureWordEl.textContent = cumulativeStats.totalFeatures === 1 ? 'feature' : 'features';
            }
            // Always show the card
            if (cumulativeCard) {
                cumulativeCard.style.display = 'block';
            }
        }
    } catch (error) {
        console.warn('⚠️ Could not load cumulative stats:', error);
    }
    
    // Display the modal (final step - always try to show something)
    try {
        modal.style.display = 'flex';
        console.log('🎉 End modal opened');
    } catch (error) {
        console.error('❌ CRITICAL: Could not display end modal:', error);
        // Last resort: try to show SOMETHING
        alert('Session completed! You may close this window.');
    }
}

export function closeEndModal(keepOverlay = null) {
    // End modal is always the last - never keep overlay
    if (keepOverlay === null) {
        keepOverlay = false;
    }
    
    const modal = document.getElementById('endModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    console.log(`🎉 End modal closed (keepOverlay: ${keepOverlay})`);
}

// Begin Analysis Modal Functions
export function openBeginAnalysisModal() {
    // Close all other modals first
    closeAllModals();
    
    const modal = document.getElementById('beginAnalysisModal');
    const overlay = document.getElementById('permanentOverlay');
    
    // Ensure overlay has standard grey blocker background (like other modals)
    if (overlay) {
        overlay.style.background = 'rgba(0, 0, 0, 0.8)';
    }
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    
    if (modal) {
        modal.style.display = 'flex';
        // Make modal focusable for keyboard events
        modal.setAttribute('tabindex', '-1');
        // Focus the modal so keyboard events work
        modal.focus();
        if (window.pm?.interaction) console.log('🔵 Begin Analysis modal opened');
    } else {
        console.error('❌ Begin Analysis modal not found in DOM');
    }
}

export function closeBeginAnalysisModal(keepOverlay = null) {
    // Begin Analysis modal is not part of workflow sequence - default to false
    if (keepOverlay === null) {
        keepOverlay = false;
    }
    
    const modal = document.getElementById('beginAnalysisModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    if (window.pm?.interaction) console.log(`🔵 Begin Analysis modal closed (keepOverlay: ${keepOverlay})`);
}

// Welcome Back Modal Functions
export function openWelcomeBackModal() {
    // Close all other modals first
    closeAllModals();
    
    const modal = document.getElementById('welcomeBackModal');
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    
    if (modal) {
        modal.style.display = 'flex';
        // Make modal focusable for keyboard events
        modal.setAttribute('tabindex', '-1');
        modal.style.outline = 'none'; // Remove browser's blue focus outline
        // Focus the modal so keyboard events work
        modal.focus();
        console.log('👋 Welcome Back modal opened');
    } else {
        console.error('❌ Welcome Back modal not found in DOM');
    }
}

export async function closeWelcomeBackModal(keepOverlay = null) {
    // Mark welcome back as seen (session-level flag)
    const { markWelcomeBackAsSeen } = await import('./study-workflow.js');
    markWelcomeBackAsSeen();
    
    // Auto-detect if overlay should be kept (if keepOverlay not explicitly provided)
    if (keepOverlay === null) {
        const nextModal = await getNextModalInWorkflow('welcomeBackModal');
        keepOverlay = nextModal !== null;
    }
    
    const modal = document.getElementById('welcomeBackModal');
    if (modal) {
        modal.style.display = 'none';
        modal.removeAttribute('tabindex');
        modal.blur();
    }
    
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    // If there's a next modal, open it
    const nextModal = await getNextModalInWorkflow('welcomeBackModal');
    if (nextModal) {
        if (nextModal === 'preSurveyModal') {
            openPreSurveyModal();
        }
    }
    
    console.log(`👋 Welcome Back modal closed (keepOverlay: ${keepOverlay})`);
}

// Complete Confirmation Modal Functions
export async function openCompleteConfirmationModal() {
    // Close all other modals first
    closeAllModals();
    
    const modal = document.getElementById('completeConfirmationModal');
    
    // Get regions and calculate counts
    const { getRegions } = await import('./region-tracker.js');
    const regions = getRegions();
    const regionCount = regions.length;
    
    // Calculate total features across all regions
    const featureCount = regions.reduce((total, region) => total + (region.featureCount || 0), 0);
    
    // Update the modal content
    const regionCountEl = document.getElementById('completeRegionCount');
    const regionWordEl = document.getElementById('completeRegionWord');
    const featureCountEl = document.getElementById('completeFeatureCount');
    const featureWordEl = document.getElementById('completeFeatureWord');
    
    if (regionCountEl) {
        regionCountEl.textContent = regionCount;
    }
    if (regionWordEl) {
        regionWordEl.textContent = regionCount === 1 ? 'region' : 'regions';
    }
    if (featureCountEl) {
        featureCountEl.textContent = featureCount;
    }
    if (featureWordEl) {
        featureWordEl.textContent = featureCount === 1 ? 'feature' : 'features';
    }
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    
    if (modal) {
        modal.style.display = 'flex';
        console.log(`✅ Complete Confirmation modal opened (${regionCount} regions, ${featureCount} features)`);
    } else {
        console.error('❌ Complete Confirmation modal not found in DOM');
    }
}

export function closeCompleteConfirmationModal(keepOverlay = null) {
    // Complete Confirmation modal is not part of workflow sequence - default to false
    if (keepOverlay === null) {
        keepOverlay = false;
    }
    
    const modal = document.getElementById('completeConfirmationModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        // 🔥 FIX: When user clicks "Not yet", immediately hide overlay to restore UI
        // Don't wait for fade animation - user needs to continue working
        const overlay = document.getElementById('permanentOverlay');
        if (overlay) {
            overlay.style.display = 'none';
            overlay.style.opacity = '0';
        }
        // Show UI elements immediately
        showUIElementsAfterModal();
    } else {
        fadeOutOverlay();
    }
    
    console.log(`✅ Complete Confirmation modal closed (keepOverlay: ${keepOverlay})`);
}

// Tutorial Intro Modal Functions
export async function openTutorialIntroModal() {
    // Close all other modals first
    closeAllModals();
    
    const modal = document.getElementById('tutorialIntroModal');
    
    // Skip option removed - all users must complete tutorial
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    
    if (modal) {
        modal.style.display = 'flex';
        console.log('🎓 Tutorial Intro modal opened');
    } else {
        console.error('❌ Tutorial Intro modal not found in DOM');
    }
}

export function closeTutorialIntroModal(keepOverlay = null) {
    // Auto-detect if overlay should be kept (if keepOverlay not explicitly provided)
    // Tutorial intro is followed by the tutorial itself (not a modal), so always fade out
    if (keepOverlay === null) {
        keepOverlay = false; // Tutorial starts after this, no next modal
    }
    
    const modal = document.getElementById('tutorialIntroModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    console.log(`🎓 Tutorial Intro modal closed (keepOverlay: ${keepOverlay})`);
}

// Tutorial Revisit Modal Functions
export async function openTutorialRevisitModal() {
    // Close all other modals first
    closeAllModals();
    
    const modal = document.getElementById('tutorialRevisitModal');
    if (!modal) {
        console.error('❌ Tutorial Revisit modal not found in DOM');
        return;
    }
    
    // Check if tutorial is currently active
    const { isTutorialActive } = await import('./tutorial-state.js');
    const tutorialActive = isTutorialActive();
    
    const titleEl = modal.querySelector('#tutorialRevisitTitle');
    const subtextEl = modal.querySelector('#tutorialRevisitSubtext');
    const btn1 = modal.querySelector('#tutorialRevisitBtn1');
    const btn2 = modal.querySelector('#tutorialRevisitBtn2');
    const btn3 = modal.querySelector('#tutorialRevisitBtn3');
    
    if (tutorialActive) {
        // Tutorial is active - show "Tutorial Underway" mode
        if (titleEl) titleEl.textContent = 'Tutorial Underway';
        if (subtextEl) subtextEl.textContent = 'What would you like to do?';
        if (btn1) {
            btn1.textContent = 'Continue';
            btn1.className = 'modal-submit';
            btn1.style.background = '#007bff';
            btn1.style.borderColor = '#007bff';
            btn1.style.color = 'white';
        }
        if (btn2) {
            btn2.textContent = 'Restart';
            btn2.className = 'modal-submit';
            btn2.style.background = '#ffc107';
            btn2.style.borderColor = '#ffc107';
            btn2.style.color = '#000';
        }
        if (btn3) {
            btn3.style.display = 'block';
            btn3.textContent = 'Exit';
        }
    } else {
        // Tutorial not active - show "Revisit Tutorial" mode
        if (titleEl) titleEl.textContent = 'Revisit Tutorial';
        if (subtextEl) subtextEl.textContent = 'Would you like to revisit the tutorial?';
        if (btn1) {
            btn1.textContent = 'Yes';
            btn1.className = 'modal-submit';
            btn1.style.background = '#007bff';
            btn1.style.borderColor = '#007bff';
            btn1.style.color = 'white';
        }
        if (btn2) {
            btn2.textContent = 'Cancel';
            btn2.className = 'modal-cancel';
            btn2.style.background = '#6c757d';
            btn2.style.borderColor = '#6c757d';
            btn2.style.color = 'white';
        }
        if (btn3) {
            btn3.style.display = 'none';
        }
    }
    
    // Fade in overlay background
    fadeInOverlay();
    
    modal.style.display = 'flex';
    console.log(`❓ Tutorial Revisit modal opened (tutorial active: ${tutorialActive})`);
}

export function closeTutorialRevisitModal(keepOverlay = null) {
    if (keepOverlay === null) {
        keepOverlay = false;
    }
    
    const modal = document.getElementById('tutorialRevisitModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    console.log(`❓ Tutorial Revisit modal closed (keepOverlay: ${keepOverlay})`);
}

// Missing Study ID Modal Functions
export function openMissingStudyIdModal() {
    // Close all other modals first
    closeAllModals();
    
    const modal = document.getElementById('missingStudyIdModal');
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    
    if (modal) {
        modal.style.display = 'flex';
        console.log('⚠️ Missing Study ID modal opened');
    }
}

export function closeMissingStudyIdModal(keepOverlay = null) {
    // If participant ID is now set, fade out the overlay
    // Otherwise, keep overlay visible for participant modal
    if (keepOverlay === null) {
        const participantId = getParticipantId();
        keepOverlay = !participantId;  // Keep overlay if no participant ID (participant modal will show)
    }
    
    const modal = document.getElementById('missingStudyIdModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    console.log(`⚠️ Missing Study ID modal closed (keepOverlay: ${keepOverlay})`);
}


export function openPreSurveyModal() {
    // Close all other modals first
    closeAllModals();
    
    const preSurveyModal = document.getElementById('preSurveyModal');
    if (!preSurveyModal) {
        console.warn('⚠️ Pre-survey modal not found');
        return;
    }
    
    // Set title to default (Welcome Back modal handles the welcome back message)
    const modalTitle = preSurveyModal.querySelector('.modal-title');
    if (modalTitle) {
        modalTitle.textContent = '🌋 Pre-Survey';
    }
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    
    preSurveyModal.style.display = 'flex';
    console.log('📊 Pre-Survey modal opened');
    
    // Ensure quick-fill buttons are properly enabled/disabled based on mode
    toggleQuickFillButtons();
    
    // Track survey start
    const participantId = getParticipantId();
    if (participantId) {
        trackSurveyStart(participantId, 'pre');
    }
}

export async function closePreSurveyModal(keepOverlay = null) {
    // Auto-detect if overlay should be kept (if keepOverlay not explicitly provided)
    if (keepOverlay === null) {
        const nextModal = await getNextModalInWorkflow('preSurveyModal');
        keepOverlay = nextModal !== null;
    }
    
    const modal = document.getElementById('preSurveyModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    console.log(`📊 Pre-Survey modal closed (keepOverlay: ${keepOverlay})`);
}

export function openPostSurveyModal() {
    // Close all other modals first
    closeAllModals();
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    
    document.getElementById('postSurveyModal').style.display = 'flex';
    console.log('📊 Post-Survey modal opened');
    
    // Ensure quick-fill buttons are properly enabled/disabled based on mode
    toggleQuickFillButtons();
    
    // Track survey start
    const participantId = getParticipantId();
    if (participantId) {
        trackSurveyStart(participantId, 'post');
    }
}

export async function closePostSurveyModal(keepOverlay = null) {
    // Auto-detect if overlay should be kept (if keepOverlay not explicitly provided)
    if (keepOverlay === null) {
        const nextModal = await getNextModalInWorkflow('postSurveyModal');
        keepOverlay = nextModal !== null;
    }
    
    const modal = document.getElementById('postSurveyModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    console.log(`📊 Post-Survey modal closed (keepOverlay: ${keepOverlay})`);
}

export function openActivityLevelModal() {
    // Close all other modals first
    closeAllModals();
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    
    document.getElementById('activityLevelModal').style.display = 'flex';
    console.log('🌋 Activity Level modal opened');
    
    // Track survey start
    const participantId = getParticipantId();
    if (participantId) {
        trackSurveyStart(participantId, 'activityLevel');
    }
}

export async function closeActivityLevelModal(keepOverlay = null) {
    // Auto-detect if overlay should be kept (if keepOverlay not explicitly provided)
    if (keepOverlay === null) {
        const nextModal = await getNextModalInWorkflow('activityLevelModal');
        keepOverlay = nextModal !== null;
    }
    
    const modal = document.getElementById('activityLevelModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    console.log(`🌋 Activity Level modal closed (keepOverlay: ${keepOverlay})`);
}

export function openAwesfModal() {
    // Close all other modals first
    closeAllModals();
    
    // Fade in overlay background (standard design pattern)
    fadeInOverlay();
    
    document.getElementById('awesfModal').style.display = 'flex';
    console.log('✨ AWE-SF modal opened');
    
    // Ensure quick-fill buttons are properly enabled/disabled based on mode
    toggleQuickFillButtons();
    
    // Track survey start
    const participantId = getParticipantId();
    if (participantId) {
        trackSurveyStart(participantId, 'awesf');
    }
}

export async function closeAwesfModal(keepOverlay = null) {
    // Auto-detect if overlay should be kept (if keepOverlay not explicitly provided)
    if (keepOverlay === null) {
        const nextModal = await getNextModalInWorkflow('awesfModal');
        keepOverlay = nextModal !== null;
    }
    
    const modal = document.getElementById('awesfModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Only fade out overlay if NOT keeping it for next modal
    if (!keepOverlay) {
        fadeOutOverlay();
    }
    
    console.log(`✨ AWE-SF modal closed (keepOverlay: ${keepOverlay})`);
}

