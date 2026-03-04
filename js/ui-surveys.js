/**
 * ui-surveys.js
 * Shared survey submission logic (participant setup).
 * Volcano-specific survey submission (Qualtrics) moved to volcano-study-surveys.js.
 */

import { storeParticipantId } from './qualtrics-api.js';
import { CURRENT_MODE, AppMode } from './master-modes.js';
import * as State from './audio-state.js';

export function submitParticipantSetup() {
    const participantId = document.getElementById('participantId').value.trim();

    // Save to localStorage for persistence across sessions
    if (participantId) {
        storeParticipantId(participantId);
        console.log('💾 Saved participant ID:', participantId);
        // Set EMIC registration flag + sync to server
        import('./master-modes.js').then(({ isEmicStudyMode }) => {
            if (isEmicStudyMode()) {
                import('./emic-study-flags.js').then(({ EMIC_FLAGS, setEmicFlag }) => {
                    setEmicFlag(EMIC_FLAGS.HAS_REGISTERED);
                });
                import('./data-uploader.js').then(({ syncEmicProgress }) => {
                    syncEmicProgress(participantId, 'registered');
                });
            }
        });
    } else {
        // If empty, remove from localStorage
        localStorage.removeItem('participantId');
        console.log('🗑️ Removed participant ID from storage');
    }

    console.log('📝 Participant Setup:');
    console.log('  - Participant ID:', participantId || '(none)');
    console.log('  - Timestamp:', new Date().toISOString());

    const statusEl = document.getElementById('status');
    statusEl.className = 'status success';
    statusEl.textContent = `✅ User Name Recorded`;

    // In Solar Portal mode, animate follow-up instruction after a brief delay
    // (Skip for shared sessions - they already have data loaded)
    const isSharedSession = sessionStorage.getItem('isSharedSession') === 'true';
    if (CURRENT_MODE === AppMode.SOLAR_PORTAL && !isSharedSession) {
        setTimeout(async () => {
            const { typeText } = await import('./tutorial-effects.js');
            statusEl.className = 'status info';
            const msg = State.isMobileScreen() ? 'Click Fetch Data to begin' : '👈 click Fetch Data to begin';
            typeText(statusEl, msg, 15, 5);
        }, 1200);
    }

    // Update participant ID display in top panel
    // Always show the display (even if no ID set) so users can click to enter their ID
    const displayElement = document.getElementById('participantIdDisplay');
    const valueElement = document.getElementById('participantIdValue');

    if (displayElement) displayElement.style.display = 'block';
    if (valueElement) valueElement.textContent = participantId || '--';

    // 🔥 REMOVED: Don't manually hide modal or fade overlay
    // Let the button handler and ModalManager do their job!
    // The workflow is waiting for the modal to properly close through ModalManager.
}

// Re-export volcano survey functions for backward compatibility
export {
    submitPreSurvey,
    submitPostSurvey,
    submitActivityLevelSurvey,
    submitAwesfSurvey,
    attemptSubmission
} from './volcano-study-surveys.js';
