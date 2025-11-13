/**
 * Admin Mode Management
 * Simple frontend toggle for admin/user mode UI
 */

// Default to user mode (false = user mode, true = admin mode)
let adminMode = false;

/**
 * Apply admin mode UI changes
 * Shows/hides elements based on admin mode status
 */
export function applyAdminModeUI() {
    // Control groups to hide in user mode
    const userModeHiddenControlGroups = [
        'stationControlGroup',    // Station dropdown
        'durationControlGroup',   // Duration dropdown
        'forceIrisControlGroup',  // Force IRIS Fetch button
    ];
    
    // Panel IDs to hide in user mode
    const userModeHiddenPanels = [
        'cachePanel',        // Cache panel
        'metricsPanel',      // Metrics panel
    ];
    
    if (adminMode) {
        // Admin mode: Show all elements
        userModeHiddenControlGroups.forEach(id => {
            const controlGroup = document.getElementById(id);
            if (controlGroup) {
                controlGroup.style.display = '';
            }
        });
        
        // Show panels
        userModeHiddenPanels.forEach(id => {
            const panel = document.getElementById(id);
            if (panel) {
                panel.style.display = '';
            }
        });
        
        console.log('👑 Admin mode: All controls visible');
    } else {
        // User mode: Hide admin elements
        userModeHiddenControlGroups.forEach(id => {
            const controlGroup = document.getElementById(id);
            if (controlGroup) {
                controlGroup.style.display = 'none';
            }
        });
        
        // Hide panels
        userModeHiddenPanels.forEach(id => {
            const panel = document.getElementById(id);
            if (panel) {
                panel.style.display = 'none';
            }
        });
        
        // Set default values for user mode
        setUserModeDefaults();
        
        console.log('👤 User mode: Admin controls hidden');
    }
}

/**
 * Set default values for user mode
 * When station and duration are hidden, we need defaults
 */
function setUserModeDefaults() {
    // Set default duration to 24 hours if not already set
    const durationSelect = document.getElementById('duration');
    if (durationSelect && !durationSelect.value) {
        durationSelect.value = '24';
    }
    
    // Note: Station will be auto-selected when volcano changes in user mode
    // The loadStations() function should handle selecting the first/default station
}

/**
 * Get admin mode status
 * @returns {boolean} - True if admin mode is enabled
 */
export function isAdminMode() {
    return adminMode;
}

/**
 * Toggle admin mode on/off
 */
export function toggleAdminMode() {
    adminMode = !adminMode;
    applyAdminModeUI();
    updateAdminModeButton();
    console.log('🔐 Admin mode:', adminMode ? 'ENABLED' : 'DISABLED (User mode)');
    return adminMode;
}

/**
 * Update admin mode button text and styling
 */
function updateAdminModeButton() {
    const btn = document.getElementById('adminModeBtn');
    if (btn) {
        if (adminMode) {
            btn.textContent = '👑 Admin Mode: ON';
            btn.style.background = '#28a745';
            btn.style.borderColor = '#28a745';
        } else {
            btn.textContent = '👑 Admin Mode: OFF';
            btn.style.background = '#6c757d';
            btn.style.borderColor = '#6c757d';
        }
    }
}

/**
 * Initialize admin mode on page load
 * Applies user mode immediately (default)
 */
export function initAdminMode() {
    // Apply user mode immediately (default) to avoid visual flash
    adminMode = false;
    applyAdminModeUI();
    updateAdminModeButton();
}

