// ═══ VOLCANO STUDY ONLY — UI event wiring for volcano study buttons ═══
/**
 * volcano-study-ui-wiring.js
 * Extracted from main.js so shared/EMIC code never loads volcano study code.
 * Called conditionally by main.js only when NOT in EMIC study mode.
 */

import {
    openEndModal,
    openPreSurveyModal,
    openPostSurveyModal,
    openActivityLevelModal,
    openAwesfModal,
    openBeginAnalysisModal,
    openCompleteConfirmationModal,
    openTutorialRevisitModal
} from './volcano-study-modals.js';
import { attemptSubmission } from './volcano-study-surveys.js';
import { getParticipantId } from '../participant-id.js';
import * as State from '../audio-state.js';
import { zoomState } from '../zoom-state.js';
import { showAddRegionButton, updateCmpltButtonState, updateCompleteButtonState } from '../region-tracker.js';

/**
 * Wire up all volcano study-specific UI buttons and event listeners.
 * Called from main.js when NOT in EMIC study mode.
 */
export function wireVolcanoStudyButtons() {
    // Survey/Modal Buttons (admin panel — only exist in volcano index.html)
    const preSurveyBtn = document.getElementById('preSurveyModalBtn');
    if (preSurveyBtn) preSurveyBtn.addEventListener('click', openPreSurveyModal);

    const activityBtn = document.getElementById('activityLevelModalBtn');
    if (activityBtn) activityBtn.addEventListener('click', openActivityLevelModal);

    const awesfBtn = document.getElementById('awesfModalBtn');
    if (awesfBtn) awesfBtn.addEventListener('click', openAwesfModal);

    const postSurveyBtn = document.getElementById('postSurveyModalBtn');
    if (postSurveyBtn) postSurveyBtn.addEventListener('click', openPostSurveyModal);

    const endModalBtn = document.getElementById('endModalBtn');
    if (endModalBtn) {
        endModalBtn.addEventListener('click', () => {
            const participantId = getParticipantId() || 'TEST123';
            openEndModal(participantId, 1);
        });
    }

    // Test submit button (admin panel) - direct submission for testing
    const submitBtn = document.getElementById('submitBtn');
    if (submitBtn) {
        submitBtn.addEventListener('click', attemptSubmission);

        // Function to update submit button visibility based on zoom state
        window.updateSubmitButtonVisibility = () => {
            if (zoomState.isInRegion()) {
                submitBtn.style.display = 'inline-block';
            } else {
                submitBtn.style.display = 'none';
            }
        };

        // Initial state
        window.updateSubmitButtonVisibility();
    }

    // Complete button (Begin Analysis) - shows confirmation modal first
    const completeBtn = document.getElementById('completeBtn');
    if (completeBtn) {
        completeBtn.addEventListener('click', (e) => {
            // Prevent clicks when button is disabled (during tutorial)
            if (completeBtn.disabled) {
                e.preventDefault();
                e.stopPropagation();
                console.log('🔒 Begin Analysis button click blocked - button is disabled');
                return;
            }

            e.preventDefault();
            e.stopPropagation();
            if (window.pm?.interaction) console.log('🔵 Begin Analysis button clicked');

            // Check if tutorial is waiting for this click
            if (State.waitingForBeginAnalysisClick && State._beginAnalysisClickResolve) {
                console.log('✅ Tutorial waiting - skipping modal and transitioning to analysis mode');
                State.setWaitingForBeginAnalysisClick(false);

                // Fire the beginAnalysisConfirmed event to transition into analysis mode
                window.dispatchEvent(new CustomEvent('beginAnalysisConfirmed'));

                // Resolve the tutorial promise
                State._beginAnalysisClickResolve();
                State.setBeginAnalysisClickResolve(null);
            } else {
                // Normal flow - show confirmation modal
                openBeginAnalysisModal();
            }
        });
    }

    // Listen for confirmation to proceed with workflow
    window.addEventListener('beginAnalysisConfirmed', async () => {
        // Mark tutorial as completed (Begin Analysis was clicked) - PERSISTENT flag
        const { markTutorialAsCompleted, markBeginAnalysisClickedThisSession } = await import('./study-workflow.js');
        markTutorialAsCompleted();

        // Mark Begin Analysis as clicked THIS SESSION - SESSION flag (cleared each new session)
        markBeginAnalysisClickedThisSession();

        // Disable auto play checkbox after Begin Analysis is confirmed
        const autoPlayCheckbox = document.getElementById('autoPlay');
        if (autoPlayCheckbox) {
            autoPlayCheckbox.checked = false;
            autoPlayCheckbox.disabled = true;
        }
        console.log('✅ Auto play disabled after Begin Analysis confirmation');

        // Configure interaction dropdowns for analysis mode after Begin Analysis
        const mainDragSelect = document.getElementById('mainWindowDrag');
        if (mainDragSelect) {
            mainDragSelect.value = 'drawFeature';
            localStorage.setItem('emic_main_drag', 'drawFeature');
        }
        const mainReleaseSelect = document.getElementById('mainWindowRelease');
        if (mainReleaseSelect) {
            mainReleaseSelect.value = 'playAudio';
            localStorage.setItem('emic_main_release', 'playAudio');
        }
        console.log('✅ Main window interaction set for analysis: drag=drawFeature, release=playAudio');
        // Also disable the hidden playOnClick checkbox
        const playOnClickCheckbox = document.getElementById('playOnClick');
        if (playOnClickCheckbox) {
            playOnClickCheckbox.checked = false;
            playOnClickCheckbox.disabled = true;
        }

        // Enable region creation after "Begin Analysis" is confirmed
        const { setRegionCreationEnabled } = await import('../audio-state.js');
        setRegionCreationEnabled(true);
        console.log('✅ Region creation ENABLED after Begin Analysis confirmation');

        // If a region has already been selected, show the "Add Region" button
        if (State.selectionStart !== null && State.selectionEnd !== null && !zoomState.isInRegion()) {
            showAddRegionButton(State.selectionStart, State.selectionEnd);
            console.log('🎯 Showing Add Region button for existing selection');
        }

        // Disable spacecraft switching after confirmation
        const volcanoSelect = document.getElementById('spacecraft');
        if (volcanoSelect) {
            volcanoSelect.disabled = true;
            volcanoSelect.style.opacity = '0.6';
            volcanoSelect.style.cursor = 'not-allowed';
            console.log('🔒 Spacecraft switching disabled after Begin Analysis confirmation');
        }

        // Transform Begin Analysis button into Complete button
        const completeBtn = document.getElementById('completeBtn');
        if (completeBtn) {
            completeBtn.textContent = 'Complete';
            completeBtn.style.background = '#28a745';
            completeBtn.style.borderColor = '#28a745';
            completeBtn.style.border = '2px solid #28a745';
            completeBtn.style.color = 'white';
            completeBtn.className = '';
            completeBtn.removeAttribute('onmouseover');
            completeBtn.removeAttribute('onmouseout');

            // Remove old click handler and add new one
            const newBtn = completeBtn.cloneNode(true);
            completeBtn.parentNode.replaceChild(newBtn, completeBtn);

            newBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('✅ Complete button clicked');
                openCompleteConfirmationModal();
            });

            // Initially disable until features are identified
            newBtn.disabled = true;
            newBtn.style.opacity = '0.5';
            newBtn.style.cursor = 'not-allowed';

            updateCompleteButtonState();
            updateCmpltButtonState();

            console.log('🔄 Begin Analysis button transformed into Complete button');
        }
    });

    // Tutorial help button click handler
    const tutorialHelpBtn = document.getElementById('tutorialHelpBtn');
    if (tutorialHelpBtn) {
        tutorialHelpBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('❓ Tutorial help button clicked');
            openTutorialRevisitModal();
        });

        // Add hover effect
        tutorialHelpBtn.addEventListener('mouseenter', function() {
            this.style.backgroundColor = 'rgba(255, 255, 255, 0.15)';
            this.style.borderColor = '#ddd';
            this.style.color = '#ddd';
        });
        tutorialHelpBtn.addEventListener('mouseleave', function() {
            this.style.backgroundColor = 'transparent';
            this.style.borderColor = '#aaa';
            this.style.color = '#aaa';
        });
    }
}
