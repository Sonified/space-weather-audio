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
 * Store participant ID in localStorage
 * @param {string} participantId - The participant ID to store
 */
export function storeParticipantId(participantId) {
    if (participantId && participantId.trim()) {
        localStorage.setItem('participantId', participantId.trim());
        console.log('💾 Stored participant ID:', participantId.trim());
    }
}

/**
 * Get participant ID from localStorage or URL
 * Checks URL first, then falls back to localStorage
 * @returns {string|null} - Participant ID if found, null otherwise
 */
export function getParticipantId() {
    // First check URL parameters (takes precedence)
    const urlId = getParticipantIdFromURL();
    if (urlId) {
        // Store it for future use
        storeParticipantId(urlId);
        return urlId;
    }

    // Fall back to localStorage
    const storedId = localStorage.getItem('participantId');
    return storedId || null;
}
