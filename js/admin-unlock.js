/**
 * admin-unlock.js
 * URL-param admin unlock with localStorage persistence.
 * ?admin=<key> unlocks advanced mode. Localhost auto-unlocks.
 */

const ADMIN_KEY = 'sw2026';
const STORAGE_KEY = 'admin_unlocked';

export function isLocalhost() {
    const h = window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '' || window.location.protocol === 'file:';
}

/**
 * Check if admin is unlocked. Sources (in order):
 * 1. Localhost → always unlocked
 * 2. localStorage → previously unlocked
 * 3. URL ?admin=<key> → unlock + persist + clean URL
 */
export function isAdminUnlocked() {
    if (isLocalhost()) return true;
    if (localStorage.getItem(STORAGE_KEY) === 'true') return true;

    const params = new URLSearchParams(window.location.search);
    const key = params.get('admin');
    if (key === ADMIN_KEY) {
        localStorage.setItem(STORAGE_KEY, 'true');
        // Clean key from URL so it's not bookmarked/shared
        params.delete('admin');
        const newUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '') + window.location.hash;
        history.replaceState({}, '', newUrl);
        return true;
    }

    return false;
}
