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
 * @param {Blob} params.wavBlob - WAV audio file blob
 * @param {Object} params.metadata - Additional metadata
 * @returns {Promise<string>} Cache key
 */
export async function storeAudioData({ spacecraft, dataset, startTime, endTime, wavBlob, metadata }) {
    await initCache();
    
    const id = generateCacheKey(spacecraft, dataset, startTime, endTime);
    
    const entry = {
        id,
        spacecraft,
        dataset,
        startTime,
        endTime,
        wavBlob,
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
            console.log(`💾 Cached audio data: ${id}`);
            
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
                console.log(`✅ Cache hit: ${id}`);
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
    
    return `${entry.spacecraft} ${datasetShort} ${dateStr} ${startTimeStr}-${endTimeStr} (${durationMinutes} min)`;
}

