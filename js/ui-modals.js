/**
 * ui-modals.js
 * Shared modal helpers, overlay management, and shared modal handlers (participant + welcome).
 * Volcano-study-only modals live in volcano-study-modals.js.
 * Extracted from ui-controls.js for maintainability.
 */

import * as State from './audio-state.js';
import { getParticipantId, storeParticipantId, getParticipantIdFromURL } from './qualtrics-api.js';
import { isStudyMode, isStudyCleanMode, isLocalEnvironment, isEmicStudyMode } from './master-modes.js';
import { hasSeenParticipantSetup, hasSeenWelcome, markParticipantSetupAsSeen, markWelcomeAsSeen } from './study-workflow.js';
import { checkUsernameAvailable, registerUsername } from './share-api.js';


// ── Shared helpers (exported for volcano-study-modals.js) ────────────────

export function hideUIElementsForModal() {
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
export function showUIElementsAfterModal() {
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
export function checkIfAnyModalVisible() {
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

export function showModal(modal) {
    if (!modal) return;
    modal.style.display = 'flex';
    // Trigger reflow so transition plays
    modal.offsetHeight;
    modal.classList.add('modal-visible');
}

export function hideModal(modal) {
    if (!modal) return;
    modal.classList.remove('modal-visible');
    setTimeout(() => {
        modal.style.display = 'none';
    }, 250);
}

export function fadeInOverlay() {
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

// ── Shared modal-wiring helpers ──────────────────────────────────────────

/** Block clicks on the overlay backdrop so modals can't be dismissed by clicking outside. */
export function preventClickOutside(modal) {
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
export function wireKeyboardSubmit(modal, submitBtn, opts = {}) {
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
export function wireQuickFill(modal, radioSelector, maxValue, onUpdate) {
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


let modalListenersSetup = false;

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

// ── Per-modal wiring functions (shared) ──────────────────────────────────

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
                const { openPreSurveyModal } = await import('./volcano-study-modals.js');
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
        import('./volcano-study-modals.js').then(volcanoModals => {
            volcanoModals.wireEndModal();
            volcanoModals.wireBeginAnalysisModal();
            volcanoModals.wireWelcomeBackModal();
            volcanoModals.wireCompleteConfirmationModal();
            volcanoModals.wireMissingStudyIdModal();
            volcanoModals.wirePreSurveyModal();
            volcanoModals.wirePostSurveyModal();
            volcanoModals.wireActivityLevelModal();
            volcanoModals.wireAwesfModal();
            volcanoModals.wireTutorialIntroModal();
            volcanoModals.wireTutorialRevisitModal();
            volcanoModals.toggleQuickFillButtons();
        });
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


// ── Shared open/close functions ──────────────────────────────────────────

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
            const { getNextModalInWorkflow } = await import('./volcano-study-modals.js');
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
        const { getNextModalInWorkflow } = await import('./volcano-study-modals.js');
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


// ── Re-exports from volcano-study-modals.js ──────────────────────────────
// These re-exports ensure existing consumers (ui-controls.js, dynamic imports)
// can continue importing from ui-modals.js without changes.

export {
    getNextModalInWorkflow,
    toggleQuickFillButtons,
    openEndModal,
    closeEndModal,
    openBeginAnalysisModal,
    closeBeginAnalysisModal,
    openWelcomeBackModal,
    closeWelcomeBackModal,
    openCompleteConfirmationModal,
    closeCompleteConfirmationModal,
    openTutorialIntroModal,
    closeTutorialIntroModal,
    openTutorialRevisitModal,
    closeTutorialRevisitModal,
    openMissingStudyIdModal,
    closeMissingStudyIdModal,
    openPreSurveyModal,
    closePreSurveyModal,
    openPostSurveyModal,
    closePostSurveyModal,
    openActivityLevelModal,
    closeActivityLevelModal,
    openAwesfModal,
    closeAwesfModal
} from './volcano-study-modals.js';
