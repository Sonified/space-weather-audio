/**
 * gap-catalog-resolver.js
 * Two-tier gap catalog system: non-burst catalogs stored locally in IndexedDB,
 * burst catalogs queried from the Cloudflare Worker endpoint.
 *
 * CATALOG_TIERS controls per-dataset behavior along two axes:
 *   location:  'local' (bundled in IndexedDB) or 'remote' (queried from worker)
 *   precision: 'L1' (inventory-grade, second precision) or 'L2' (CDF-grade, ms precision)
 *
 * The bundle endpoint (/api/gap-catalog-bundle) strips L2 fields from datasets
 * configured as L1 to reduce payload size. Full L2 data stays in R2 for the
 * per-dataset endpoint. To change a dataset's treatment, edit both this config
 * and the matching BUNDLE_L1 set in the worker.
 */

// ---------------------------------------------------------------------------
// Tier configuration
// ---------------------------------------------------------------------------

export const CATALOG_TIERS = {
    // === LOCAL L2 (full precision in bundle) ===
    'AC_H3_MFI':            { location: 'local', precision: 'L2' },
    'DN_MAGN-L2-HIRES_G16': { location: 'local', precision: 'L2' },
    'DN_MAGN-L2-HIRES_G19': { location: 'local', precision: 'L2' },
    'DSCOVR_H0_MAG':        { location: 'local', precision: 'L2' },
    'GE_EDB3SEC_MGF':       { location: 'local', precision: 'L2' },
    'GE_K0_EFD':            { location: 'local', precision: 'L2' },
    'MMS1_FGM_SRVY_L2':     { location: 'local', precision: 'L2' },
    'MMS2_FGM_SRVY_L2':     { location: 'local', precision: 'L2' },
    'MMS3_FGM_SRVY_L2':     { location: 'local', precision: 'L2' },
    'MMS4_FGM_SRVY_L2':     { location: 'local', precision: 'L2' },
    'MMS1_SCM_SRVY_L2_SCSRVY': { location: 'local', precision: 'L2' },
    'MMS2_SCM_SRVY_L2_SCSRVY': { location: 'local', precision: 'L2' },
    'MMS3_SCM_SRVY_L2_SCSRVY': { location: 'local', precision: 'L2' },
    'MMS4_SCM_SRVY_L2_SCSRVY': { location: 'local', precision: 'L2' },
    'PSP_FLD_L2_DFB_WF_DVDC':           { location: 'local', precision: 'L2' },
    'PSP_FLD_L2_MAG_RTN':               { location: 'local', precision: 'L2' },
    'PSP_FLD_L2_MAG_RTN_4_SA_PER_CYC':  { location: 'local', precision: 'L2' },
    'RBSP-A_MAGNETOMETER_HIRES-GSE_EMFISIS-L3': { location: 'local', precision: 'L2' },
    'RBSP-B_MAGNETOMETER_HIRES-GSE_EMFISIS-L3': { location: 'local', precision: 'L2' },
    'RBSP-A_MAGNETOMETER_4SEC-GSE_EMFISIS-L3':  { location: 'local', precision: 'L2' },
    'RBSP-B_MAGNETOMETER_4SEC-GSE_EMFISIS-L3':  { location: 'local', precision: 'L2' },
    'RBSP-A_WFR-WAVEFORM-CONTINUOUS-BURST_EMFISIS-L2': { location: 'local', precision: 'L2' },
    'RBSP-B_WFR-WAVEFORM-CONTINUOUS-BURST_EMFISIS-L2': { location: 'local', precision: 'L2' },
    'SOLO_L2_MAG-RTN-NORMAL':           { location: 'local', precision: 'L2' },
    'SOLO_L2_RPW-LFR-SURV-CWF-E':      { location: 'local', precision: 'L2' },
    'THA_L2_EFI': { location: 'local', precision: 'L2' },
    'THB_L2_EFI': { location: 'local', precision: 'L2' },
    'THC_L2_EFI': { location: 'local', precision: 'L2' },
    'THD_L2_EFI': { location: 'local', precision: 'L2' },
    'THE_L2_EFI': { location: 'local', precision: 'L2' },
    'THA_L2_FGM': { location: 'local', precision: 'L2' },
    'THB_L2_FGM': { location: 'local', precision: 'L2' },
    'THC_L2_FGM': { location: 'local', precision: 'L2' },
    'THD_L2_FGM': { location: 'local', precision: 'L2' },
    'THE_L2_FGM': { location: 'local', precision: 'L2' },
    'THA_L2_FGM_FGH': { location: 'local', precision: 'L2' },
    'THB_L2_FGM_FGH': { location: 'local', precision: 'L2' },
    'THC_L2_FGM_FGH': { location: 'local', precision: 'L2' },
    'THD_L2_FGM_FGH': { location: 'local', precision: 'L2' },
    'THE_L2_FGM_FGH': { location: 'local', precision: 'L2' },
    'THA_L2_SCM': { location: 'local', precision: 'L2' },
    'THB_L2_SCM': { location: 'local', precision: 'L2' },
    'THC_L2_SCM': { location: 'local', precision: 'L2' },
    'THD_L2_SCM': { location: 'local', precision: 'L2' },
    'THE_L2_SCM': { location: 'local', precision: 'L2' },
    'VOYAGER1_2S_MAG': { location: 'local', precision: 'L2' },
    'VOYAGER2_2S_MAG': { location: 'local', precision: 'L2' },
    'WI_H2_MFI':      { location: 'local', precision: 'L2' },
    'C1_CP_FGM_5VPS':         { location: 'local', precision: 'L2' },
    'C2_CP_FGM_5VPS':         { location: 'local', precision: 'L2' },
    'C3_CP_FGM_5VPS':         { location: 'local', precision: 'L2' },
    'C4_CP_FGM_5VPS':         { location: 'local', precision: 'L2' },
    'C1_CP_STA_CWF_GSE':      { location: 'local', precision: 'L2' },
    'C2_CP_STA_CWF_GSE':      { location: 'local', precision: 'L2' },
    'C3_CP_STA_CWF_GSE':      { location: 'local', precision: 'L2' },
    'C4_CP_STA_CWF_GSE':      { location: 'local', precision: 'L2' },
    'C1_CP_EFW_L3_E3D_INERT': { location: 'local', precision: 'L2' },
    'C2_CP_EFW_L3_E3D_INERT': { location: 'local', precision: 'L2' },
    'C3_CP_EFW_L3_E3D_INERT': { location: 'local', precision: 'L2' },
    'C4_CP_EFW_L3_E3D_INERT': { location: 'local', precision: 'L2' },
    'MMS1_EDP_FAST_L2_DCE':   { location: 'local', precision: 'L2' },
    'MMS2_EDP_FAST_L2_DCE':   { location: 'local', precision: 'L2' },
    'MMS3_EDP_FAST_L2_DCE':   { location: 'local', precision: 'L2' },
    'MMS4_EDP_FAST_L2_DCE':   { location: 'local', precision: 'L2' },
    'MMS1_EDP_SLOW_L2_DCE':   { location: 'local', precision: 'L2' },
    'MMS2_EDP_SLOW_L2_DCE':   { location: 'local', precision: 'L2' },
    'MMS3_EDP_SLOW_L2_DCE':   { location: 'local', precision: 'L2' },
    'MMS4_EDP_SLOW_L2_DCE':   { location: 'local', precision: 'L2' },

    // === REMOTE (burst — too large for client bundle) ===
    'MMS1_FGM_BRST_L2':     { location: 'remote', precision: 'L2' },
    'MMS2_FGM_BRST_L2':     { location: 'remote', precision: 'L2' },
    'MMS3_FGM_BRST_L2':     { location: 'remote', precision: 'L2' },
    'MMS4_FGM_BRST_L2':     { location: 'remote', precision: 'L2' },
    'MMS1_SCM_BRST_L2_SCB': { location: 'remote', precision: 'L2' },
    'MMS2_SCM_BRST_L2_SCB': { location: 'remote', precision: 'L2' },
    'MMS3_SCM_BRST_L2_SCB': { location: 'remote', precision: 'L2' },
    'MMS4_SCM_BRST_L2_SCB': { location: 'remote', precision: 'L2' },
    'MMS1_EDP_BRST_L2_DCE': { location: 'remote', precision: 'L2' },
    'MMS2_EDP_BRST_L2_DCE': { location: 'remote', precision: 'L2' },
    'MMS3_EDP_BRST_L2_DCE': { location: 'remote', precision: 'L2' },
    'MMS4_EDP_BRST_L2_DCE': { location: 'remote', precision: 'L2' },
    'SOLO_L2_MAG-RTN-BURST': { location: 'remote', precision: 'L2' },
};

// ---------------------------------------------------------------------------
// IndexedDB setup
// ---------------------------------------------------------------------------

const DB_NAME = 'gapCatalogBundle';
const DB_VERSION = 1;
const STORE_NAME = 'bundle';
const BUNDLE_KEY = 'current';
const STALENESS_MS = 24 * 60 * 60 * 1000;

let _db = null;
let _bundledDatasetIds = new Set();
let _catalogCache = new Map();
let _initPromise = null;

function _getOrigin() {
    const h = location.hostname;
    return (h === 'localhost' || h === '127.0.0.1')
        ? 'https://spaceweather.now.audio'
        : '';
}

function _openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            _db = request.result;
            resolve(_db);
        };
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
    });
}

function _getBundle(db) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(BUNDLE_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

function _putBundle(db, data) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(data, BUNDLE_KEY);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

function _loadIntoMemory(bundleData) {
    const { catalogs } = bundleData;
    _bundledDatasetIds = new Set(Object.keys(catalogs));
    _catalogCache = new Map(Object.entries(catalogs));
}

// ---------------------------------------------------------------------------
// Interval filtering (same logic as the Cloudflare worker query mode)
// ---------------------------------------------------------------------------

function _filterIntervals(catalog, startISO, endISO) {
    const intervals = catalog.intervals || [];
    const sharpened = catalog.summary?.boundaries_sharpened;
    const tier = sharpened === true ? 'L2' : 'L1';

    const matches = [];
    for (const iv of intervals) {
        const ivStart = iv.start_precise || iv.start_iso;
        const ivEnd = iv.end_precise || iv.end_iso;
        if (ivStart < endISO && ivEnd > startISO) {
            matches.push({
                start: ivStart,
                end: ivEnd,
                precision: (iv.start_precise && iv.end_precise) ? 'L2' : 'L1',
            });
        }
    }
    return { intervals: matches, tier };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the catalog bundle. Call once on page load.
 * Loads from IndexedDB if fresh, otherwise fetches from the worker.
 * Safe to call multiple times — subsequent calls return the same promise.
 */
export function initCatalogBundle() {
    if (_initPromise) return _initPromise;
    _initPromise = _doInit();
    return _initPromise;
}

async function _doInit() {
    try {
        const db = await _openDB();
        const existing = await _getBundle(db);

        if (existing && (Date.now() - existing.fetchedAt) < STALENESS_MS) {
            _loadIntoMemory(existing);
            console.log(`📦 Gap catalog bundle loaded from IndexedDB (${_bundledDatasetIds.size} datasets)`);
            return;
        }

        const url = `${_getOrigin()}/api/gap-catalog-bundle`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Bundle fetch failed: ${resp.status}`);
        const bundle = await resp.json();

        const record = { ...bundle, fetchedAt: Date.now() };
        _loadIntoMemory(record);
        console.log(`📦 Gap catalog bundle fetched (${_bundledDatasetIds.size} datasets, v${bundle.version})`);

        await _putBundle(db, record).catch(e =>
            console.warn('⚠️ Failed to persist bundle to IndexedDB:', e)
        );
    } catch (err) {
        console.warn('⚠️ Gap catalog bundle init failed, falling back to remote:', err.message);
        // If we have stale data in memory from a previous load, keep it
    }
}

/**
 * Resolve data availability intervals for a dataset within a time range.
 * Transparently queries local IndexedDB or the remote worker based on tier.
 *
 * @param {string} datasetId
 * @param {string} startISO - ISO 8601 start time
 * @param {string} endISO   - ISO 8601 end time
 * @returns {Promise<{dataset_id: string, tier: string, total_matches: number, intervals: Array}>}
 */
export async function resolveIntervals(datasetId, startISO, endISO) {
    if (_initPromise) await _initPromise;

    if (_bundledDatasetIds.has(datasetId)) {
        const catalog = _catalogCache.get(datasetId);
        if (catalog) {
            const { intervals, tier } = _filterIntervals(catalog, startISO, endISO);
            return {
                dataset_id: datasetId,
                tier,
                total_matches: intervals.length,
                intervals,
            };
        }
    }

    const origin = _getOrigin();
    const url = `${origin}/api/gap-catalog/${datasetId}?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Gap catalog query failed: ${resp.status}`);
    return resp.json();
}

/**
 * Synchronous tier check. Returns { location, precision } or null if unknown.
 */
export function getTier(datasetId) {
    if (_bundledDatasetIds.has(datasetId)) {
        const config = CATALOG_TIERS[datasetId];
        return config || { location: 'local', precision: 'L1' };
    }
    return CATALOG_TIERS[datasetId] || null;
}

/**
 * Whether the bundle has been loaded into memory.
 */
export function isBundleReady() {
    return _bundledDatasetIds.size > 0;
}
