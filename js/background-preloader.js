// ========== BACKGROUND DATA PRELOADER ==========
// Downloads data chunks to the browser Cache API without decoding or rendering.
// When the user reaches an analysis step, goes-cloudflare-fetcher.js checks
// the cache first — making the data load feel instant.

import { fetchAllDayMetadata, buildChunkSchedule, resolveStepParams } from './chunk-url-utils.js';

const CACHE_NAME = 'sw-audio-data-v1';

/**
 * Background-download all chunks for a study analysis step into Cache API.
 * Does NOT decode, decompress, or render — only stores raw responses.
 *
 * @param {Object} step - Analysis step config (spacecraft, startDate, endDate, etc.)
 * @param {AbortSignal} [signal] - Optional abort signal
 * @returns {Promise<{cached: number, fetched: number, failed: number, total: number}>}
 */
export async function backgroundDownload(step, signal) {
    const { satellite, component, startTimeISO, endTimeISO } = resolveStepParams(step);

    if (!startTimeISO || !endTimeISO) {
        console.warn('⬇️ Background preload: missing start/end time, skipping');
        return { cached: 0, fetched: 0, failed: 0, total: 0 };
    }

    console.log(`⬇️ Background preload: ${satellite} ${component} ${startTimeISO} → ${endTimeISO}`);

    // Fetch metadata for all days in range
    const allDayMetadata = await fetchAllDayMetadata(startTimeISO, endTimeISO, satellite, component, signal);
    const validMetadata = allDayMetadata.filter(m => m !== null);

    if (validMetadata.length === 0) {
        console.warn('⬇️ Background preload: no metadata available');
        return { cached: 0, fetched: 0, failed: 0, total: 0 };
    }

    // Build chunk schedule (same logic as the fetcher)
    const startDate = new Date(startTimeISO);
    const endDate = new Date(endTimeISO);
    const chunkSchedule = buildChunkSchedule(startDate, endDate, allDayMetadata, satellite, component);

    // Filter to chunks that have URLs (skip missing/zero-fill chunks)
    const downloadable = chunkSchedule.filter(c => c.url && !c.isMissing);

    if (downloadable.length === 0) {
        console.log('⬇️ Background preload: no downloadable chunks');
        return { cached: 0, fetched: 0, failed: 0, total: 0 };
    }

    // Open cache
    let cache;
    try {
        cache = await caches.open(CACHE_NAME);
    } catch (e) {
        console.warn('⬇️ Background preload: Cache API unavailable:', e.message);
        return { cached: 0, fetched: 0, failed: 0, total: downloadable.length };
    }

    let cached = 0, fetched = 0, failed = 0;

    for (const chunk of downloadable) {
        if (signal?.aborted) break;

        // Check if already cached
        const hit = await cache.match(chunk.url);
        if (hit) {
            cached++;
            continue;
        }

        // Fetch and cache
        try {
            const resp = await fetch(chunk.url, { signal });
            if (resp.ok) {
                await cache.put(chunk.url, resp);
                fetched++;
            } else {
                failed++;
            }
        } catch (e) {
            if (e.name === 'AbortError') break;
            console.warn(`⬇️ Background fetch failed: ${chunk.url}`, e.message);
            failed++;
        }
    }

    const result = { cached, fetched, failed, total: downloadable.length };
    console.log(`⬇️ Background preload complete: ${cached} cached, ${fetched} fetched, ${failed} failed, ${downloadable.length} total`);

    // Dispatch event so other code can react
    window.dispatchEvent(new CustomEvent('preload-complete', { detail: result }));

    return result;
}

/**
 * Fetch a chunk URL, checking Cache API first.
 * Drop-in wrapper for fetch() in the streaming pipeline.
 *
 * @param {string} url - Chunk URL
 * @param {Object} [opts] - fetch options (signal, etc.)
 * @returns {Promise<Response>}
 */
export async function fetchWithCache(url, opts) {
    try {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(url);
        if (cached) {
            if (window.pm?.data) console.log(`⚡ Cache hit: ${url.split('/').slice(-3).join('/')}`);
            return cached;
        }

        const resp = await fetch(url, opts);
        if (resp.ok) {
            // Clone before caching — response body can only be consumed once
            await cache.put(url, resp.clone());
        }
        return resp;
    } catch (e) {
        // Cache API might be unavailable (e.g. opaque origin) — fall back to plain fetch
        if (e.name !== 'AbortError') {
            console.warn('⬇️ Cache fallback to plain fetch:', e.message);
        }
        return fetch(url, opts);
    }
}

export { CACHE_NAME };
