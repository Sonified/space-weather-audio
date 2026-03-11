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

    for (const paramName of paramNames) {
        const value = params.get(paramName);
        if (value && value.trim()) {
            return value.trim();
        }
    }

    return null;
}

/**
 * Store participant ID (study/simulation) in localStorage
 * @param {string} participantId - The participant ID to store
 */
export function storeParticipantId(participantId) {
    if (participantId && participantId.trim()) {
        localStorage.setItem('participantId', participantId.trim());
        console.log('💾 Stored participant ID:', participantId.trim());
    }
}

/**
 * Get participant ID (study/simulation) from localStorage or URL
 * Checks URL first, then falls back to localStorage
 * @returns {string|null} - Participant ID if found, null otherwise
 */
export function getParticipantId() {
    // First check URL parameters (takes precedence)
    const urlId = getParticipantIdFromURL();
    if (urlId) {
        storeRealUsername(urlId);
        return urlId;
    }

    // Fall back to localStorage (check both keys — Solar Portal stores via storeRealUsername)
    const storedId = localStorage.getItem('participantId');
    if (storedId) return storedId;
    return localStorage.getItem('emic_real_username') || null;
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
    const isAdvanced = document.getElementById('advancedMode')?.checked;
    const isSimulating = localStorage.getItem('emic_is_simulating') === 'true';
    if (!isAdvanced && isSimulating) {
        return localStorage.getItem('participantId') || 'anonymous';
    }
    return localStorage.getItem('emic_real_username') || localStorage.getItem('participantId') || 'anonymous';
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
