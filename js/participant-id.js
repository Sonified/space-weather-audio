/**
 * participant-id.js
 * Participant ID storage and retrieval — shared by both EMIC study and legacy volcano study.
 * Extracted from qualtrics-api.js so EMIC doesn't need to import Qualtrics for basic ID ops.
 */

/**
 * Parse participant ID from URL parameters
 * Supports common parameter names: ResponseID, ParticipantID, participantId, participant_id, id, pid
 * @returns {string|null} - Participant ID if found, null otherwise
 */
export function getParticipantIdFromURL() {
    const params = new URLSearchParams(window.location.search);

    // Try parameter names in order of likelihood
    const paramNames = ['ResponseID', 'responseId', 'ParticipantID', 'participantId', 'participant_id', 'id', 'pid'];

    // Local dev only: allow &part=FULL_ID to impersonate a participant
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
        const part = params.get('part');
        if (part && part.trim()) return part.trim();
    }

    for (const paramName of paramNames) {
        const value = params.get(paramName);
        if (value && value.trim()) {
            return value.trim();
        }
    }

    return null;
}

/**
 * Store participant ID in both sessionStorage (per-tab, prevents cross-tab races)
 * and localStorage (persists across reloads for session resume).
 * @param {string} participantId - The participant ID to store
 */
export function storeParticipantId(participantId) {
    if (participantId && participantId.trim()) {
        const id = participantId.trim();
        sessionStorage.setItem('participantId', id);
        localStorage.setItem('participantId', id);
        console.log('💾 Stored participant ID:', id);
    }
}

/**
 * Clear participant ID from both sessionStorage and localStorage.
 */
export function clearParticipantId() {
    sessionStorage.removeItem('participantId');
    localStorage.removeItem('participantId');
}

/**
 * Get participant ID — checks URL first, then sessionStorage (per-tab),
 * then falls back to localStorage (cross-tab, for resume on reload).
 * @returns {string|null} - Participant ID if found, null otherwise
 */
export function getParticipantId() {
    // First check URL parameters (takes precedence)
    const urlId = getParticipantIdFromURL();
    if (urlId) {
        storeRealUsername(urlId);
        return urlId;
    }

    // sessionStorage is per-tab — immune to cross-tab races
    return sessionStorage.getItem('participantId') || localStorage.getItem('participantId') || null;
}

/**
 * Store the researcher's real username — separate from participantId.
 * Set at login. Never touched by simulation.
 * @param {string} username - The researcher's username
 */
export function storeRealUsername(username) {
    if (username && username.trim()) {
        localStorage.setItem('emic_real_username', username.trim());
        console.log('💾 Stored real username:', username.trim());
    }
}

/**
 * Get the researcher's real username from localStorage
 * @returns {string|null}
 */
export function getRealUsernameStored() {
    return localStorage.getItem('emic_real_username') || null;
}

/**
 * Get the active ID for the current context.
 * Participant mode during simulation → participantId.
 * Otherwise → real username.
 * @returns {string} - The active ID or 'anonymous'
 */
export function getActiveId() {
    // On study.html, always use the participant ID from registration
    if (window.__STUDY_FLOW_MANAGED) {
        return sessionStorage.getItem('participantId') || localStorage.getItem('participantId') || 'anonymous';
    }
    const isAdvanced = document.getElementById('advancedMode')?.checked;
    const isSimulating = localStorage.getItem('emic_is_simulating') === 'true';
    if (!isAdvanced && isSimulating) {
        return sessionStorage.getItem('participantId') || localStorage.getItem('participantId') || 'anonymous';
    }
    return localStorage.getItem('emic_real_username') || sessionStorage.getItem('participantId') || localStorage.getItem('participantId') || 'anonymous';
}

/**
 * Generate a unique participant ID based on current timestamp + random suffix
 * Format: P_YYYYMMDD_HHMM_XXXXX (5 random uppercase letters)
 * @returns {string} - Generated participant ID
 */
export function generateParticipantId(prefix) {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let suffix = '';
    for (let i = 0; i < 5; i++) suffix += chars[Math.floor(Math.random() * 26)];
    const pfx = prefix || 'P';
    return `${pfx}_${yyyy}${mm}${dd}_${hh}${mi}_${suffix}`;
}
