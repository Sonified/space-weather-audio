/**
 * cdaweb-cache.js
 * IndexedDB cache system for CDAWeb audio data
 * Stores WAV files and metadata for recent searches
 */

const DB_NAME = 'solarAudioCache';
const DB_VERSION = 1;
const STORE_NAME = 'audioData';
const MAX_CACHE_ENTRIES = 20;

let db = null;

/**
 * Initialize the IndexedDB database
 * @returns {Promise<IDBDatabase>}
 */
export async function initCache() {
    if (db) return db;
    
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = () => {
            console.error('❌ Failed to open IndexedDB:', request.error);
            reject(request.error);
        };
        
        request.onsuccess = () => {
            db = request.result;
            console.log('✅ IndexedDB cache initialized');
            resolve(db);
        };
        
        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            
            // Create object store if it doesn't exist
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                const objectStore = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
                
                // Create indexes for efficient querying
                objectStore.createIndex('cachedAt', 'cachedAt', { unique: false });
                objectStore.createIndex('spacecraft', 'spacecraft', { unique: false });
                objectStore.createIndex('dataset', 'dataset', { unique: false });
                
                console.log('🏗️ IndexedDB object store created');
            }
        };
    });
}

/**
 * Generate cache key from search parameters
 */
function generateCacheKey(spacecraft, dataset, startTime, endTime) {
    return `${spacecraft}_${dataset}_${startTime}_${endTime}`;
}

/**
 * Store audio data in IndexedDB cache
 * @param {Object} params - Cache parameters
 * @param {string} params.spacecraft - Spacecraft name (e.g., 'PSP')
 * @param {string} params.dataset - Dataset ID (e.g., 'PSP_FLD_L2_MAG_RTN')
 * @param {string} params.startTime - ISO 8601 start time
 * @param {string} params.endTime - ISO 8601 end time
 * @param {Blob} params.wavBlob - WAV audio file blob (first component)
 * @param {Array<Blob>} [params.allComponentBlobs] - All component blobs [br, bt, bn]
 * @param {Object} params.metadata - Additional metadata
 * @returns {Promise<string>} Cache key
 */
export async function storeAudioData({ spacecraft, dataset, startTime, endTime, wavBlob, allComponentBlobs, metadata }) {
    await initCache();

    const id = generateCacheKey(spacecraft, dataset, startTime, endTime);

    const entry = {
        id,
        spacecraft,
        dataset,
        startTime,
        endTime,
        wavBlob,
        allComponentBlobs: allComponentBlobs || [wavBlob], // Store all component blobs
        metadata: {
            ...metadata,
            sampleRate: 22000, // CDAWeb audio sample rate (22kHz)
        },
        cachedAt: Date.now()
    };

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const objectStore = transaction.objectStore(STORE_NAME);
        const request = objectStore.put(entry);

        request.onsuccess = () => {
            const blobCount = entry.allComponentBlobs?.length || 1;
            console.log(`💾 Cached audio data: ${id} (${blobCount} component${blobCount > 1 ? 's' : ''})`);

            // Clean up old entries if we exceed the limit
            cleanupOldEntries();

            resolve(id);
        };

        request.onerror = () => {
            console.error('❌ Failed to cache audio data:', request.error);
            reject(request.error);
        };
    });
}

/**
 * Update cache entry with additional component blobs (for background downloads)
 * @param {string} spacecraft
 * @param {string} dataset
 * @param {string} startTime
 * @param {string} endTime
 * @param {Array<Blob>} allComponentBlobs - All component blobs
 * @returns {Promise<void>}
 */
export async function updateCacheWithAllComponents(spacecraft, dataset, startTime, endTime, allComponentBlobs) {
    await initCache();

    const id = generateCacheKey(spacecraft, dataset, startTime, endTime);

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const objectStore = transaction.objectStore(STORE_NAME);
        const getRequest = objectStore.get(id);

        getRequest.onsuccess = () => {
            if (getRequest.result) {
                const entry = getRequest.result;
                entry.allComponentBlobs = allComponentBlobs;
                entry.metadata.allComponentsDownloaded = true;

                const putRequest = objectStore.put(entry);
                putRequest.onsuccess = () => {
                    console.log(`💾 Updated cache with all ${allComponentBlobs.length} components: ${id}`);
                    resolve();
                };
                putRequest.onerror = () => reject(putRequest.error);
            } else {
                console.warn(`⚠️ Cache entry not found for component update: ${id}`);
                resolve();
            }
        };

        getRequest.onerror = () => reject(getRequest.error);
    });
}

/**
 * Get audio data from IndexedDB cache
 * @param {string} spacecraft
 * @param {string} dataset
 * @param {string} startTime
 * @param {string} endTime
 * @returns {Promise<Object|null>} Cached entry or null if not found
 */
export async function getAudioData(spacecraft, dataset, startTime, endTime) {
    await initCache();
    
    const id = generateCacheKey(spacecraft, dataset, startTime, endTime);
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const objectStore = transaction.objectStore(STORE_NAME);
        const request = objectStore.get(id);
        
        request.onsuccess = () => {
            if (request.result) {
                const entry = request.result;
                const ageMinutes = Math.round((Date.now() - entry.cachedAt) / 60000);
                const sizeKB = entry.wavBlob ? (entry.wavBlob.size / 1024).toFixed(2) : 'unknown';
                console.log(`✅ Cache hit: ${id}`);
                console.log(`   📦 Cache entry: ${sizeKB} KB, cached ${ageMinutes} min ago`);
                console.log(`   🛰️ Spacecraft: ${entry.spacecraft}, Dataset: ${entry.dataset}`);
                console.log(`   ⏰ Time range: ${entry.startTime} → ${entry.endTime}`);
                resolve(request.result);
            } else {
                console.log(`❌ Cache miss: ${id}`);
                resolve(null);
            }
        };
        
        request.onerror = () => {
            console.error('❌ Failed to get cached data:', request.error);
            reject(request.error);
        };
    });
}

/**
 * List all recent searches, sorted by most recent first
 * @returns {Promise<Array>} Array of cache entries
 */
export async function listRecentSearches() {
    await initCache();
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const objectStore = transaction.objectStore(STORE_NAME);
        const index = objectStore.index('cachedAt');
        const request = index.openCursor(null, 'prev'); // Reverse order (newest first)
        
        const results = [];
        
        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                results.push(cursor.value);
                cursor.continue();
            } else {
                // Return only the most recent MAX_CACHE_ENTRIES
                resolve(results.slice(0, MAX_CACHE_ENTRIES));
            }
        };
        
        request.onerror = () => {
            console.error('❌ Failed to list recent searches:', request.error);
            reject(request.error);
        };
    });
}

/**
 * Clean up old cache entries, keeping only the most recent MAX_CACHE_ENTRIES
 */
async function cleanupOldEntries() {
    await initCache();
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const objectStore = transaction.objectStore(STORE_NAME);
        const index = objectStore.index('cachedAt');
        const request = index.openCursor(null, 'prev'); // Reverse order (newest first)
        
        let count = 0;
        
        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                count++;
                if (count > MAX_CACHE_ENTRIES) {
                    // Delete entries beyond the limit
                    cursor.delete();
                    console.log(`🗑️ Removed old cache entry: ${cursor.value.id}`);
                }
                cursor.continue();
            } else {
                resolve();
            }
        };
        
        request.onerror = () => {
            console.error('❌ Failed to cleanup old entries:', request.error);
            reject(request.error);
        };
    });
}

/**
 * Clear all cached data (for debugging/testing)
 */
export async function clearAllCache() {
    await initCache();
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const objectStore = transaction.objectStore(STORE_NAME);
        const request = objectStore.clear();
        
        request.onsuccess = () => {
            console.log('🗑️ All cache cleared');
            resolve();
        };
        
        request.onerror = () => {
            console.error('❌ Failed to clear cache:', request.error);
            reject(request.error);
        };
    });
}

/**
 * Determine the encounter number based on the provided start date
 * @param {string|Date} startDate - Start date in ISO format or Date object
 * @returns {string} Encounter number (e.g., 'E1', 'E2') or 'Unknown_Encounter'
 */
function getEncounterNumber(startDate) {
    // Convert input date to Date object
    let dateObj;
    if (typeof startDate === 'string') {
        dateObj = new Date(startDate);
        if (isNaN(dateObj.getTime())) {
            console.warn(`Warning: Could not parse date ${startDate}`);
            return 'Unknown_Encounter';
        }
    } else if (startDate instanceof Date) {
        dateObj = startDate;
    } else {
        console.warn(`Warning: Invalid date type: ${typeof startDate}`);
        return 'Unknown_Encounter';
    }
    
    // Convert to YYYY-MM-DD format for comparison
    const formattedDate = dateObj.toISOString().split('T')[0];
    
    const encounters = {
        'E1': ['2018-10-31', '2019-02-13'],
        'E2': ['2019-02-14', '2019-06-01'],
        'E3': ['2019-06-02', '2019-10-16'],
        'E4': ['2019-10-17', '2020-03-10'],
        'E5': ['2020-03-11', '2020-06-07'],
        'E6': ['2020-06-08', '2020-10-09'],
        'E7': ['2020-10-10', '2021-03-13'],
        'E8': ['2021-03-14', '2021-05-17'],
        'E9': ['2021-05-18', '2021-10-10'],
        'E10': ['2021-10-11', '2021-12-19'],
        'E11': ['2021-12-20', '2022-04-25'],
        'E12': ['2022-04-26', '2022-07-12'],
        'E13': ['2022-07-13', '2022-11-09'],
        'E14': ['2022-11-10', '2022-12-27'],
        'E15': ['2022-12-28', '2023-05-11'],
        'E16': ['2023-05-12', '2023-08-16'],
        'E17': ['2023-08-17', '2023-11-22'],
        'E18': ['2023-11-23', '2024-02-23'],
        'E19': ['2024-02-24', '2024-04-29'],
        'E20': ['2024-04-30', '2024-08-14'],
        'E21': ['2024-08-15', '2024-10-27'],
        'E22': ['2024-10-28', '2025-02-07'],
        'E23': ['2025-02-08', '2025-05-05'],
        'E24': ['2025-05-06', '2025-08-01'],
        'E25': ['2025-08-02', '2025-10-28'],
        'E26': ['2025-10-29', '2026-01-12']
    };
    
    for (const [encounter, [encStart, encStop]] of Object.entries(encounters)) {
        if (encStart <= formattedDate && formattedDate <= encStop) {
            return encounter;
        }
    }
    
    return 'Unknown_Encounter';
}

/**
 * Format a cache entry for display in the recent searches dropdown
 * @param {Object} entry - Cache entry
 * @returns {string} Formatted display string
 */
export function formatCacheEntryForDisplay(entry) {
    const start = new Date(entry.startTime);
    const end = new Date(entry.endTime);

    // Format date as YYYY-MM-DD
    const dateStr = start.toISOString().split('T')[0];

    // Format times as HH:MM
    const startTimeStr = start.toISOString().split('T')[1].substring(0, 5);
    const endTimeStr = end.toISOString().split('T')[1].substring(0, 5);

    // Calculate duration in minutes
    const durationMinutes = Math.round((end - start) / 60000);

    // Shorten dataset name for display
    let datasetShort = entry.dataset;
    if (datasetShort.includes('PSP_FLD_L2_MAG_RTN_4_SA_PER_CYC')) {
        datasetShort = 'MAG_RTN_4SA';
    } else if (datasetShort.includes('PSP_FLD_L2_MAG_RTN')) {
        datasetShort = 'MAG_RTN';
    } else if (datasetShort.includes('WI_H2_MFI')) {
        datasetShort = 'MFI';
    } else if (datasetShort.includes('MMS')) {
        datasetShort = datasetShort.replace('MMS1_FGM_', '').replace('_L2', '');
    }

    // Only show encounter prefix for PSP (Parker Solar Probe)
    if (entry.spacecraft === 'PSP') {
        const encounter = getEncounterNumber(start);
        return `${encounter}: ${entry.spacecraft} ${datasetShort} ${dateStr} ${startTimeStr}-${endTimeStr} (${durationMinutes} min)`;
    }

    // For other spacecraft (Wind, MMS), no encounter prefix
    return `${entry.spacecraft} ${datasetShort} ${dateStr} ${startTimeStr}-${endTimeStr} (${durationMinutes} min)`;
}

