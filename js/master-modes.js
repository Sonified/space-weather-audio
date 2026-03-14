/**
 * master-modes.js — App context: Study vs Space Weather Portal
 *
 * study.html sets window.__STUDY_MODE = true before loading modules.
 * index.html sets nothing — defaults to portal mode.
 */

export const isStudyPage = typeof window !== 'undefined' && window.__STUDY_MODE === true;

export function isStudyMode() {
    return isStudyPage;
}

export function isLocalEnvironment() {
    if (typeof window === 'undefined') return false;
    const h = window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '' || window.location.protocol === 'file:';
}

// Legacy exports — callers still reference AppMode.EMIC_STUDY / SOLAR_PORTAL in switch statements.
// TODO: migrate these callers to isStudyMode() checks, then delete.
export const AppMode = { SPACE_WEATHER_PORTAL: 'space_weather_portal', EMIC_STUDY: 'emic_study', SOLAR_PORTAL: 'space_weather_portal' };
export const CURRENT_MODE = isStudyPage ? AppMode.EMIC_STUDY : AppMode.SPACE_WEATHER_PORTAL;

export function getCurrentModeConfig() {
    return {
        name: isStudyPage ? 'Study' : 'Space Weather Portal',
        welcomeMode: isStudyPage ? 'participant' : 'user'
    };
}

export function initializeMasterMode() {
    // Startup log for portal mode
    if (!isStudyPage && isLocalEnvironment()) {
        console.log('🌍 Space Weather Portal (LOCAL)');
    }
}
