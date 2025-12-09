/**
 * Space Weather Audio API Client
 * Handles sessions and sharing via Cloudflare Worker + R2
 */

// API Configuration - same origin in production, localhost for dev
const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const API_BASE = isLocalDev
    ? 'http://localhost:8787'  // wrangler dev
    : '';  // Same origin - spaceweather.now.audio/api/

// =============================================================================
// Session API - Save/load user's own sessions
// =============================================================================

/**
 * Save a session for a user
 * @param {string} username - The user's participant ID
 * @param {Object} sessionData - Session data to save
 * @returns {Promise<Object>} Save result with session_id
 */
export async function saveSession(username, sessionData) {
    const response = await fetch(`${API_BASE}/api/users/${encodeURIComponent(username)}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionData)
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || 'Failed to save session');
    }
    return data;
}

/**
 * List all sessions for a user
 * @param {string} username - The user's participant ID
 * @returns {Promise<Object>} List of sessions
 */
export async function listSessions(username) {
    const response = await fetch(`${API_BASE}/api/users/${encodeURIComponent(username)}/sessions`);
    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || 'Failed to list sessions');
    }
    return data;
}

/**
 * Get a specific session
 * @param {string} username - The user's participant ID
 * @param {string} sessionId - The session ID
 * @returns {Promise<Object>} Session data
 */
export async function getSession(username, sessionId) {
    const response = await fetch(
        `${API_BASE}/api/users/${encodeURIComponent(username)}/sessions/${encodeURIComponent(sessionId)}`
    );
    const data = await response.json();

    if (!response.ok) {
        if (response.status === 404) {
            throw new Error('Session not found');
        }
        throw new Error(data.error || 'Failed to get session');
    }
    return data;
}

/**
 * Delete a session
 * @param {string} username - The user's participant ID
 * @param {string} sessionId - The session ID
 * @returns {Promise<Object>} Deletion result
 */
export async function deleteSession(username, sessionId) {
    const response = await fetch(
        `${API_BASE}/api/users/${encodeURIComponent(username)}/sessions/${encodeURIComponent(sessionId)}`,
        { method: 'DELETE' }
    );
    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || 'Failed to delete session');
    }
    return data;
}

// =============================================================================
// Share API - Share sessions with others
// =============================================================================

/**
 * Create a shareable link from a saved session
 * @param {string} username - The creator's username
 * @param {string} sessionId - The session to share
 * @param {Object} options - Optional title/description
 * @returns {Promise<Object>} Share result with share_url
 */
export async function createShare(username, sessionId, options = {}) {
    const response = await fetch(`${API_BASE}/api/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            username,
            session_id: sessionId,
            share_id: options.share_id,
            title: options.title,
            description: options.description
        })
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || 'Failed to create share');
    }
    return data;
}

/**
 * Get a shared session
 * @param {string} shareId - The share ID
 * @returns {Promise<Object>} Share data with metadata and session
 */
export async function getShare(shareId) {
    const response = await fetch(`${API_BASE}/api/share/${encodeURIComponent(shareId)}`);
    const data = await response.json();

    if (!response.ok) {
        if (response.status === 404) {
            throw new Error('Share not found');
        }
        if (response.status === 410) {
            throw new Error('Share has expired');
        }
        throw new Error(data.error || 'Failed to get share');
    }
    return data;
}

/**
 * Check if a share ID is available
 * @param {string} shareId - The share ID to check
 * @returns {Promise<Object>} Availability info {available: boolean, share_id: string}
 */
export async function checkShareAvailable(shareId) {
    const response = await fetch(`${API_BASE}/api/share/${encodeURIComponent(shareId)}/available`);
    return await response.json();
}

/**
 * Clone a shared session to your own account
 * @param {string} shareId - The share ID to clone
 * @param {string} username - Your username to clone into
 * @returns {Promise<Object>} New session info
 */
export async function cloneShare(shareId, username) {
    const response = await fetch(`${API_BASE}/api/share/${encodeURIComponent(shareId)}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username })
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || 'Failed to clone share');
    }
    return data;
}

// =============================================================================
// Username API - Check/register unique usernames
// =============================================================================

/**
 * Check if a username is available
 * @param {string} username - The username to check
 * @returns {Promise<Object>} Availability info {available: boolean, username: string, error?: string}
 */
export async function checkUsernameAvailable(username) {
    const response = await fetch(`${API_BASE}/api/username/${encodeURIComponent(username)}/available`);
    return await response.json();
}

/**
 * Register a username (claim it as taken)
 * @param {string} username - The username to register
 * @returns {Promise<Object>} Registration result
 */
export async function registerUsername(username) {
    const response = await fetch(`${API_BASE}/api/username/${encodeURIComponent(username)}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || 'Failed to register username');
    }
    return data;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check API health
 * @returns {Promise<Object>} Health status
 */
export async function checkHealth() {
    try {
        const response = await fetch(`${API_BASE}/health`);
        return await response.json();
    } catch (error) {
        return { status: 'unreachable', error: error.message };
    }
}

/**
 * Parse share ID from URL if present
 * @returns {string|null} Share ID or null
 */
export function getShareIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('share');
}

/**
 * Generate a share URL for a given share ID
 * @param {string} shareId - The share ID
 * @returns {string} Full share URL
 */
export function generateShareUrl(shareId) {
    const baseUrl = window.location.origin + window.location.pathname;
    return `${baseUrl}?share=${shareId}`;
}

/**
 * Copy share URL to clipboard
 * @param {string} shareId - The share ID
 * @returns {Promise<boolean>} True if copied successfully
 */
export async function copyShareUrl(shareId) {
    const url = generateShareUrl(shareId);
    try {
        await navigator.clipboard.writeText(url);
        return true;
    } catch (error) {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = url;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        document.body.appendChild(textArea);
        textArea.select();
        try {
            document.execCommand('copy');
            return true;
        } catch (e) {
            return false;
        } finally {
            document.body.removeChild(textArea);
        }
    }
}

/**
 * Store recently viewed shares in localStorage
 * @param {Object} shareInfo - Share info to store
 */
export function addToRecentShares(shareInfo) {
    const key = 'space_weather_recent_shares';
    let recent = [];

    try {
        recent = JSON.parse(localStorage.getItem(key) || '[]');
    } catch (e) {
        recent = [];
    }

    // Remove if already exists
    recent = recent.filter(s => s.share_id !== shareInfo.share_id);

    // Add to front
    recent.unshift({
        share_id: shareInfo.share_id,
        title: shareInfo.title,
        spacecraft: shareInfo.spacecraft,
        viewed_at: new Date().toISOString()
    });

    // Keep only last 10
    recent = recent.slice(0, 10);

    localStorage.setItem(key, JSON.stringify(recent));
}

/**
 * Get recently viewed shares from localStorage
 * @returns {Array} Array of recent share info
 */
export function getRecentShares() {
    const key = 'space_weather_recent_shares';
    try {
        return JSON.parse(localStorage.getItem(key) || '[]');
    } catch (e) {
        return [];
    }
}

export default {
    // Sessions
    saveSession,
    listSessions,
    getSession,
    deleteSession,
    // Shares
    createShare,
    getShare,
    cloneShare,
    checkShareAvailable,
    // Usernames
    checkUsernameAvailable,
    registerUsername,
    // Utils
    checkHealth,
    getShareIdFromUrl,
    generateShareUrl,
    copyShareUrl,
    addToRecentShares,
    getRecentShares
};
