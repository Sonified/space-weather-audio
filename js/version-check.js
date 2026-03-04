// version-check.js — Polls version.json and auto-reloads on new deploy

export async function checkAppVersion() {
    if (window.pm?.init) console.log('🔍 Checking for app updates...');
    try {
        // Fetch version.json with cache-busting
        const res = await fetch(`/version.json?_=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) {
            console.log('⚠️ Version check: Could not fetch version.json');
            return false;
        }

        // Read version from JSON content (updated automatically by GitHub Action on every push)
        const data = await res.json();
        const serverVersion = data.version;
        if (!serverVersion) {
            console.log('⚠️ Version check: No version found in version.json');
            return false;
        }

        const localVersion = localStorage.getItem('app_version');
        // Parse version string (YYYYMMDD.HHMMSS) into a readable date
        const versionParts = serverVersion.match(/(\d{4})(\d{2})(\d{2})\.(\d{2})(\d{2})(\d{2})/);
        const serverTime = versionParts
            ? new Date(Date.UTC(versionParts[1], versionParts[2]-1, versionParts[3], versionParts[4], versionParts[5], versionParts[6])).toLocaleString()
            : serverVersion;
        if (window.pm?.init) console.log(`📋 Version check: Local="${localVersion || '(first visit)'}" vs Server="${serverVersion}"`);

        if (localVersion && localVersion !== serverVersion) {
            console.log('%c🔄 NEW VERSION DETECTED - Refreshing page...', 'color: #FF9800; font-weight: bold; font-size: 14px');
            localStorage.setItem('app_version', serverVersion);
            location.reload();
            return true; // Will reload
        }

        localStorage.setItem('app_version', serverVersion);
        if (window.pm?.init) console.log(`%c✅ App is up to date (built ${serverTime})`, 'color: #4CAF50; font-weight: bold');
    } catch (e) {
        // Silently fail - version check is non-critical
        console.log('⚠️ Version check skipped (offline or error)', e.message);
    }
    return false;
}
