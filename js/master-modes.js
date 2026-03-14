/**
 * master-modes.js
 * App mode detection — determines which page context we're running in.
 * Each page loads its own study config; this module just identifies the context.
 */

import { log, logGroup, logGroupEnd } from './logger.js';

/**
 * Application Modes — one per entry point
 *
 * SOLAR_PORTAL: General-purpose sonification portal (index.html)
 * EMIC_STUDY: EMIC wave research interface (emic_study.html)
 */
export const AppMode = {
    SOLAR_PORTAL: 'solar_portal',
    EMIC_STUDY: 'emic_study'
};

/**
 * Detect if running locally vs production
 */
export function isLocalEnvironment() {
    if (typeof window === 'undefined') return false;
    const hostname = window.location.hostname;
    const protocol = window.location.protocol;
    return hostname === 'localhost' ||
           hostname === '127.0.0.1' ||
           hostname === '' ||
           protocol === 'file:';
}

// Detect mode from page context
const isEmicStudyPage = typeof window !== 'undefined' &&
    (window.location.pathname.includes('emic_study') || window.__EMIC_STUDY_MODE === true || window.__STUDY_MODE === true);

export const CURRENT_MODE = isEmicStudyPage ? AppMode.EMIC_STUDY : AppMode.SOLAR_PORTAL;

/**
 * Mode Configuration
 */
const MODE_CONFIG = {
    [AppMode.SOLAR_PORTAL]: {
        name: 'Solar Portal',
        description: 'General-purpose space weather sonification portal',
        welcomeMode: 'user'
    },

    [AppMode.EMIC_STUDY]: {
        name: 'EMIC Study',
        description: 'Lauren Blum EMIC wave research interface',
        welcomeMode: 'participant'
    }
};

/**
 * Get current mode configuration
 */
export function getCurrentModeConfig() {
    return MODE_CONFIG[CURRENT_MODE];
}

/**
 * Mode Check Helpers
 */
export function isStudyMode() {
    return CURRENT_MODE === AppMode.EMIC_STUDY;
}


/**
 * Initialize mode and log configuration
 */
export function initializeMasterMode() {
    const config = MODE_CONFIG[CURRENT_MODE];
    const isLocal = isLocalEnvironment();

    if (!isStudyMode()) {
        const env = isLocal ? '🔧 LOCAL' : '🌍 PRODUCTION';
        if (logGroup('init', `${config.name.toUpperCase()} (${env})`)) {
            console.log(`🎯 ${config.name}: ${config.description}`);
            logGroupEnd();
        }
    }
}
