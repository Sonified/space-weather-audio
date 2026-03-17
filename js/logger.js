/**
 * logger.js
 * Centralized logging utility with toggleable categories
 *
 * Usage in code:
 *   import { log } from './logger.js';
 *   log('data', 'Fetching data...');
 *   log('share', 'Share link loaded');
 *
 * Toggle in browser console:
 *   pm.status()       // Show all flags
 *   pm.data = true    // Enable data logs
 *   pm.audio = false  // Disable audio logs
 *   pm.all(true)      // Enable all
 *   pm.all(false)     // Disable all
 */

// Category emoji prefixes for visual scanning
const emoji = {
    init: '🚀',
    data: '📡',
    audio: '🔊',
    regions: '🎯',
    share: '🔗',
    render: '🎨',
    interaction: '🖱️',
    zoom: '🔍',
    gpu: '🔺',
    study_flow: '🔬',
    features: '📦',
    memory: '🏥',
    cache: '💾',
    error: '❌'
};

/**
 * Print Manager - toggle log categories on/off
 */
const pm = {
    // === Category Flags (set directly: pm.data = true) ===
    init: false,     // App initialization, module loading
    data: false,     // Data fetching, caching, decoding
    audio: false,    // Audio worklet, playback (noisy)
    regions: true,   // Region/feature operations
    share: true,     // Share link operations
    render: false,   // Spectrogram/waveform rendering (noisy)
    interaction: false, // User interactions (clicks, drags, canvas events)
    zoom: false,     // Zoom state changes
    gpu: false,      // GPU compute, pyramid, zero-copy pipeline
    study_flow: false,    // EMIC study flow, mode initialization
    features: false, // Feature boxes, regions, standalone features
    memory: false,   // Memory health monitoring
    cache: false,    // IndexedDB cache operations
    d1: false,       // D1 database (participants, features, configs)
    error: true,     // Errors (keep on)

    // === Methods ===
    status() {
        console.log('📋 Print Manager Status:');
        console.log('─'.repeat(30));
        Object.keys(this).forEach(key => {
            if (typeof this[key] === 'boolean') {
                const e = emoji[key] || '📝';
                console.log(`  ${e} pm.${key} = ${this[key] ? '✅ true' : '🚫 false'}`);
            }
        });
        console.log('─'.repeat(30));
        console.log('  Set: pm.audio = true');
        console.log('  All: pm.all(true) or pm.all(false)');
    },

    all(enabled) {
        Object.keys(this).forEach(key => {
            if (typeof this[key] === 'boolean') {
                this[key] = enabled;
            }
        });
        console.log(`${enabled ? '✅' : '🚫'} All categories ${enabled ? 'enabled' : 'disabled'}`);
    }
};

/**
 * Log a message if its category is enabled
 */
export function log(category, ...args) {
    if (pm[category]) {
        const e = emoji[category] || '📝';
        console.log(`${e} [${category.toUpperCase()}]`, ...args);
    }
}

/**
 * Log a warning if its category is enabled
 */
export function logWarn(category, ...args) {
    if (pm[category]) {
        console.warn(`⚠️ [${category.toUpperCase()}]`, ...args);
    }
}

/**
 * Log an error (always logs, regardless of category state)
 */
export function logError(category, ...args) {
    console.error(`❌ [${category.toUpperCase()}]`, ...args);
}

/**
 * Start a collapsed group if category is enabled
 * Returns true if group was opened (so you know to close it)
 */
export function logGroup(category, label) {
    if (pm[category]) {
        const e = emoji[category] || '📝';
        console.groupCollapsed(`${e} [${category.toUpperCase()}] ${label}`);
        return true;
    }
    return false;
}

/**
 * End a group (only call if logGroup returned true)
 */
export function logGroupEnd() {
    console.groupEnd();
}

// Expose pm globally for console access
if (typeof window !== 'undefined') {
    window.pm = pm;
}

export { pm };
