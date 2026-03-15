/**
 * goes-data-cache.js
 * IndexedDB cache for GOES magnetometer chunk data.
 * Stores raw (decompressed, un-normalized) Float32Arrays per chunk
 * so preloaded data persists across page reloads.
 */

const DB_NAME = 'goesChunkCache';
const DB_VERSION = 1;
const STORE_NAME = 'chunks';
const MAX_ENTRIES = 200;

let db = null;

/**
 * Initialize the IndexedDB database
 */
export async function initGoesCache() {
    if (db) return db;

    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => {
            console.error('Failed to open GOES chunk cache:', request.error);
            reject(request.error);
        };

        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
                store.createIndex('cachedAt', 'cachedAt', { unique: false });
            }
        };
    });
}

/**
 * Generate cache key for a chunk
 */
function chunkKey(satellite, component, date, chunkType, startTime) {
    return `${satellite}_${component}_${date}_${chunkType}_${startTime}`;
}

/**
 * Store a raw (un-normalized) chunk in IndexedDB
 */
export async function storeChunk(satellite, component, date, chunkType, startTime, rawSamples) {
    await initGoesCache();

    const entry = {
        id: chunkKey(satellite, component, date, chunkType, startTime),
        satellite, component, date, chunkType, startTime,
        rawSamples,
        sampleCount: rawSamples.length,
        byteSize: rawSamples.byteLength,
        cachedAt: Date.now(),
    };

    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(entry);

        req.onsuccess = () => {
            cleanupOldEntries();
            resolve();
        };
        req.onerror = () => reject(req.error);
    });
}

/**
 * Get a cached raw chunk, or null if not found
 */
export async function getChunk(satellite, component, date, chunkType, startTime) {
    await initGoesCache();

    const id = chunkKey(satellite, component, date, chunkType, startTime);

    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(id);

        req.onsuccess = () => {
            if (req.result) {
                resolve(req.result.rawSamples);
            } else {
                resolve(null);
            }
        };
        req.onerror = () => reject(req.error);
    });
}

/**
 * Clear all cached GOES chunks
 */
export async function clearGoesCache() {
    await initGoesCache();

    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

/**
 * Remove oldest entries when over MAX_ENTRIES
 */
async function cleanupOldEntries() {
    return new Promise((resolve) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('cachedAt');
        const req = index.openCursor(null, 'prev');

        let count = 0;
        req.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                count++;
                if (count > MAX_ENTRIES) {
                    cursor.delete();
                }
                cursor.continue();
            } else {
                resolve();
            }
        };
        req.onerror = () => resolve();
    });
}
