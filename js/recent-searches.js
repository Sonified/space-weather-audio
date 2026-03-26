// recent-searches.js — Recent search history dropdown management

import { isStudyMode } from './master-modes.js';
import { updateDatasetOptions, saveDateTime } from './ui-controls.js';
import { startMemoryMonitoring } from './main-window-renderer.js';
const refreshSelectById = window.__customSelect?.refreshSelectById || (() => {});

// 🔍 RECENT SEARCHES SYSTEM (using IndexedDB cache)

/**
 * Load recent searches from IndexedDB cache and populate dropdown
 */
export async function loadRecentSearches() {
    if (isStudyMode()) return; // EMIC uses fixed dataset, no recent searches
    const dropdown = document.getElementById('recentSearches');
    if (!dropdown) return;

    // Clear existing options (except placeholder)
    dropdown.innerHTML = '<option value="">-- Select Recent Search --</option>';

    try {
        // Get recent searches from IndexedDB cache
        const { listRecentSearches, formatCacheEntryForDisplay } = await import('./cdaweb-cache.js');
        const recentSearches = await listRecentSearches();

        // Add each search as an option
        recentSearches.forEach((entry, index) => {
            const option = document.createElement('option');
            option.value = entry.id; // Use cache ID as value
            option.textContent = formatCacheEntryForDisplay(entry);
            option.dataset.cacheEntry = JSON.stringify({
                spacecraft: entry.spacecraft,
                dataset: entry.dataset,
                startTime: entry.startTime,
                endTime: entry.endTime
            });
            dropdown.appendChild(option);
        });

        refreshSelectById('recentSearches');
        console.log(`📋 Loaded ${recentSearches.length} recent searches from cache`);
        startMemoryMonitoring();
    } catch (e) {
        console.warn('Could not load recent searches:', e);
        startMemoryMonitoring();
    }
}

/**
 * Restore a search from recent searches by loading from cache
 */
export async function restoreRecentSearch(selectedOption) {
    try {
        if (!selectedOption.dataset.cacheEntry) return;

        // Bump this search to the top of the recent list
        const { touchCacheEntry } = await import('./cdaweb-cache.js');
        await touchCacheEntry(selectedOption.value);

        const cacheData = JSON.parse(selectedOption.dataset.cacheEntry);

        // Parse start/end times to populate form fields
        const startDate = new Date(cacheData.startTime);
        const endDate = new Date(cacheData.endTime);

        // Format for date inputs (YYYY-MM-DD)
        const startDateStr = startDate.toISOString().split('T')[0];
        const endDateStr = endDate.toISOString().split('T')[0];

        // Format for time inputs (HH:MM:SS.mmm)
        const startTimeStr = startDate.toISOString().split('T')[1].replace('Z', '');
        const endTimeStr = endDate.toISOString().split('T')[1].replace('Z', '');

        // Populate form fields - ORDER MATTERS!
        // 1. Set spacecraft first
        document.getElementById('spacecraft').value = cacheData.spacecraft;
        // 2. Update dataset dropdown options for the selected spacecraft
        updateDatasetOptions();
        // 3. Now set the dataset (after options are populated)
        document.getElementById('dataType').value = cacheData.dataset;
        // 4. Set date/time fields
        document.getElementById('startDate').value = startDateStr;
        document.getElementById('startTime').value = startTimeStr;
        document.getElementById('endDate').value = endDateStr;
        document.getElementById('endTime').value = endTimeStr;

        // 5. Save all restored values to localStorage for persistence
        localStorage.setItem('selectedSpacecraft', cacheData.spacecraft);
        localStorage.setItem('selectedDataType', cacheData.dataset);
        saveDateTime();

        console.log(`🔍 Restored recent search: ${selectedOption.textContent}`);

        // Automatically fetch the data from cache
        const startBtn = document.getElementById('startBtn');
        if (startBtn && !startBtn.disabled) {
            console.log(`🚀 Auto-fetching restored search data...`);
            startBtn.click();
        } else {
            console.warn('⚠️ Cannot auto-fetch: startBtn disabled or not found');
        }

    } catch (e) {
        console.warn('Could not restore recent search:', e);
    }
}

/**
 * Save current search - handled automatically by fetchCDAWebAudio caching
 * This function is kept for backward compatibility but does nothing
 */
export function saveRecentSearch() {
    // Searches are now automatically saved to IndexedDB cache by fetchCDAWebAudio
    // This function is intentionally empty
}
