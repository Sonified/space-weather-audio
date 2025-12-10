/**
 * logger.js
 * Centralized logging utility with toggleable categories
 *
 * Usage:
 *   import { log, logGroup, logGroupEnd } from './logger.js';
 *   log('data', '📡 Fetching data...');
 *   log('share', '🔗 Share link loaded');
 *
 * Toggle categories in browser console:
 *   Logger.enable('audio')
 *   Logger.disable('render')
 *   Logger.status()  // Show all category states
 *   Logger.all(true) // Enable all
 *   Logger.all(false) // Disable all
 */

// Log categories with default states
// true = enabled, false = disabled
const categories = {
    init: true,      // App initialization, module loading
    data: true,      // Data fetching, caching, decoding
    audio: false,    // Audio worklet, playback (can be noisy)
    regions: true,   // Region/feature creation, loading, saving
    share: true,     // Share link operations
    render: false,   // Spectrogram/waveform rendering (can be noisy)
    ui: false,       // User interactions, button clicks
    zoom: false,     // Zoom state changes
    memory: false,   // Memory health monitoring
    cache: true,     // IndexedDB cache operations
    error: true      // Errors (always recommended on)
};

// Category emoji prefixes for visual scanning
const categoryEmoji = {
    init: '🚀',
    data: '📡',
    audio: '🔊',
    regions: '🎯',
    share: '🔗',
    render: '🎨',
    ui: '👆',
    zoom: '🔍',
    memory: '🏥',
    cache: '💾',
    error: '❌'
};

/**
 * Log a message if its category is enabled
 */
export function log(category, ...args) {
    if (categories[category]) {
        const emoji = categoryEmoji[category] || '📝';
        console.log(`${emoji} [${category.toUpperCase()}]`, ...args);
    }
}

/**
 * Log a warning if its category is enabled
 */
export function logWarn(category, ...args) {
    if (categories[category]) {
        const emoji = categoryEmoji[category] || '⚠️';
        console.warn(`${emoji} [${category.toUpperCase()}]`, ...args);
    }
}

/**
 * Log an error (always logs, regardless of category state)
 */
export function logError(category, ...args) {
    const emoji = '❌';
    console.error(`${emoji} [${category.toUpperCase()}]`, ...args);
}

/**
 * Start a collapsed console group if category is enabled
 */
export function logGroup(category, label) {
    if (categories[category]) {
        const emoji = categoryEmoji[category] || '📝';
        console.groupCollapsed(`${emoji} [${category.toUpperCase()}] ${label}`);
    }
}

/**
 * End a console group if category is enabled
 */
export function logGroupEnd(category) {
    if (categories[category]) {
        console.groupEnd();
    }
}

// Global Logger object for console control
const Logger = {
    enable(category) {
        if (category in categories) {
            categories[category] = true;
            console.log(`✅ Logger: ${category} enabled`);
        } else {
            console.warn(`Unknown category: ${category}. Available: ${Object.keys(categories).join(', ')}`);
        }
    },

    disable(category) {
        if (category in categories) {
            categories[category] = false;
            console.log(`🚫 Logger: ${category} disabled`);
        } else {
            console.warn(`Unknown category: ${category}. Available: ${Object.keys(categories).join(', ')}`);
        }
    },

    toggle(category) {
        if (category in categories) {
            categories[category] = !categories[category];
            console.log(`${categories[category] ? '✅' : '🚫'} Logger: ${category} ${categories[category] ? 'enabled' : 'disabled'}`);
        }
    },

    status() {
        console.log('📋 Logger Category Status:');
        Object.entries(categories).forEach(([cat, enabled]) => {
            const emoji = categoryEmoji[cat] || '📝';
            console.log(`  ${emoji} ${cat}: ${enabled ? '✅ ON' : '🚫 OFF'}`);
        });
    },

    all(enabled) {
        Object.keys(categories).forEach(cat => {
            categories[cat] = enabled;
        });
        console.log(`${enabled ? '✅' : '🚫'} Logger: All categories ${enabled ? 'enabled' : 'disabled'}`);
    },

    // Get current state (for saving preferences)
    getState() {
        return { ...categories };
    },

    // Restore state (from saved preferences)
    setState(state) {
        Object.assign(categories, state);
    }
};

// Expose Logger globally for console access
if (typeof window !== 'undefined') {
    window.Logger = Logger;
}

export { Logger, categories };
