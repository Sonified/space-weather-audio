/**
 * d1-sync.js — Progressive D1 save system for EMIC study
 *
 * Fire-and-forget saves to D1 via Cloudflare Worker /api/study/* routes.
 * Runs alongside the existing R2 upload system (data-uploader.js).
 * Never blocks UI — all saves are async with offline queue fallback.
 */

// ── Config ───────────────────────────────────────────────────────────────────

let _studyId = 'emic-pilot'; // default, overridden by setStudyId() or page config
const PENDING_KEY = 'd1_pending_sync';

export function getApiBase() {
    if (typeof window !== 'undefined' && window.location?.hostname === 'spaceweather.now.audio') {
        return window.location.origin;
    }
    return 'https://spaceweather.now.audio';
}

// ── UUID fallback for non-secure contexts ────────────────────────────────────

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function getParticipantId() {
    if (typeof localStorage === 'undefined') return null;
    return sessionStorage.getItem('participantId') || localStorage.getItem('participantId') || null;
}

export function getStudyId() {
    return _studyId;
}

/**
 * Set the active study ID. Called by the study HTML page on load.
 * Also reads from <meta name="study-id"> or URL param ?study= as fallback.
 */
export function setStudyId(id) {
    _studyId = id;
}

// Auto-detect study ID from page meta tag or URL param
if (typeof document !== 'undefined') {
    const meta = document.querySelector('meta[name="study-id"]');
    if (meta) _studyId = meta.content;
    else {
        const params = new URLSearchParams(window.location.search);
        if (params.get('study')) _studyId = params.get('study');
    }
}

/**
 * Fetch study config from D1 and return it.
 * Call on page load to drive the study flow.
 */
export async function fetchStudyConfig(studyId) {
    const sid = studyId || getStudyId();
    try {
        const resp = await fetch(`${getApiBase()}/api/study/${sid}/config`);
        if (resp.ok) {
            const data = await resp.json();
            log('✅', `loaded config for "${sid}"`);
            // Server returns { success, study: { id, name, config: {...} }, session: {...} | null }
            if (data.study && data.study.config) {
                // Attach session info to config so callers can access it
                const config = data.study.config;
                if (data.session) config._activeSession = data.session;
                return config;
            }
            // Fallback: maybe config is at top level
            if (data.config) return typeof data.config === 'string' ? JSON.parse(data.config) : data.config;
            return data;
        }
        log('❌', `config fetch failed: HTTP ${resp.status}`);
    } catch (e) {
        log('❌', `config fetch error: ${e.message}`);
    }
    return null;
}

function log(emoji, msg) {
    if (window.pm?.d1) console.log(`📡 D1: ${emoji} ${msg}`);
}

// ── Offline Queue ────────────────────────────────────────────────────────────

function enqueue(payload) {
    if (typeof localStorage === 'undefined') return;
    try {
        const pending = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
        pending.push(payload);
        localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
        log('📦', `queued offline (${pending.length} pending)`);
    } catch (e) {
        console.warn('D1 sync: failed to queue', e);
    }
}

async function flushQueue() {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return;
    let pending;
    try { pending = JSON.parse(raw); } catch { return; }
    if (!pending.length) return;

    const remaining = [];
    for (const item of pending) {
        try {
            const resp = await fetch(item.url, {
                method: item.method || 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(item.body),
            });
            if (resp.ok) {
                const r = await resp.json().catch(() => ({}));
                log('✅', `${(r.mode || 'LIVE').toUpperCase()} — flushed queued ${item.body?.type || 'item'}`);
            } else {
                remaining.push(item);
            }
        } catch {
            remaining.push(item);
            break; // still offline, stop trying
        }
    }
    localStorage.setItem(PENDING_KEY, JSON.stringify(remaining));
    if (!remaining.length) localStorage.removeItem(PENDING_KEY);
}

// ── Core fetch wrapper ───────────────────────────────────────────────────────

async function d1Fetch(method, path, body = null, queueOnFail = true) {
    const url = `${getApiBase()}${path}`;
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    try {
        const resp = await fetch(url, opts);
        if (resp.ok) {
            flushQueue().catch(() => {});
            return await resp.json();
        }
        log('❌', `HTTP ${resp.status} on ${path}`);
        if (queueOnFail && body) enqueue({ url, method, body });
        return null;
    } catch (e) {
        log('❌', `network error: ${e.message}`);
        if (queueOnFail && body) enqueue({ url, method, body });
        return null;
    }
}

function d1Post(path, body, queueOnFail = true) {
    return d1Fetch('POST', path, body, queueOnFail);
}

function d1Put(path, body, queueOnFail = true) {
    return d1Fetch('PUT', path, body, queueOnFail);
}

function d1Get(path) {
    return d1Fetch('GET', path, null, false);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Register participant in D1. Call once at registration.
 */
export async function initParticipant(participantId, studyId) {

    const sid = studyId || getStudyId();
    const pid = participantId || getParticipantId();
    if (!pid) { log('⚠️', 'no participantId — skipping init'); return; }

    const r = await d1Post(`/api/study/${sid}/participants`, { id: pid });
    if (r) log('✅', `${(r.mode || 'LIVE').toUpperCase()} — registered participant ${pid}`);
}

/**
 * Generic response saver. Fire-and-forget.
 * @param {string} type - response type (survey, feature, playback_event, etc.)
 * @param {object} data - JSON-serializable payload
 * @param {object} [options] - { day, participantId }
 */
export function saveResponse(type, data, options = {}) {

    const pid = options.participantId || getParticipantId();
    const sid = getStudyId();
    if (!pid) { log('⚠️', 'no participantId — skipping save'); return; }

    const body = {
        id: options.id || (crypto.randomUUID ? crypto.randomUUID() : generateUUID()),
        participant_id: pid,
        type,
        data,
    };
    if (options.day != null) body.day = options.day;

    d1Post(`/api/study/${sid}/responses`, body)
        .then(r => r && log('✅', `${(r.mode || 'LIVE').toUpperCase()} — saved ${type}`));
}

/**
 * Save a feature annotation. Extracts key fields from feature object.
 */
export function saveFeature(featureData) {
    const coords = [];
    if (featureData.startTime) coords.push(featureData.startTime);
    if (featureData.endTime) coords.push(featureData.endTime);
    if (featureData.lowFreq != null) coords.push(featureData.lowFreq);
    if (featureData.highFreq != null) coords.push(featureData.highFreq);

    const payload = {
        lowFreq: featureData.lowFreq,
        highFreq: featureData.highFreq,
        startTime: featureData.startTime,
        endTime: featureData.endTime,
        notes: featureData.notes || '',
        confidence: featureData.confidence || 'confirmed',
        speedFactor: featureData.speedFactor || null,
        createdAt: featureData.createdAt || null,
        analysisSession: featureData.analysisSession || null,
        coordCount: coords.length,
    };

    // Use stable d1Id for upsert (avoids duplicates on re-save)
    saveResponse('feature', payload, { id: featureData.d1Id });
    log('📍', `saved feature ${featureData.d1Id ? featureData.d1Id.slice(0, 8) : '(new)'} (${coords.length} coords)`);
}

/**
 * Delete a feature from D1 by its stable ID. Fire-and-forget.
 */
export function deleteFeatureFromD1(featureId) {
    if (!featureId) return;
    const sid = getStudyId();
    d1Fetch('DELETE', `/api/study/${sid}/features/${encodeURIComponent(featureId)}`, null, false)
        .then(r => r && log('🗑️', `deleted feature ${featureId.slice(0, 8)}`));
}

/**
 * Save an individual survey answer as it's completed.
 * @param {string} questionId
 * @param {*} answer
 * @param {string} surveyType - 'pre' or 'post'
 * @param {string} [questionText] - The question text for self-contained records
 * @param {string} [questionType] - 'radio' or 'freetext'
 */
export function saveSurveyAnswer(questionId, answer, surveyType, questionText, questionType) {
    const type = surveyType === 'post' ? 'post_survey' : 'pre_survey';
    saveResponse(type, {
        questionId,
        question: questionText || null,
        questionType: questionType || null,
        answer,
        answered_at: new Date().toISOString(),
    });
}

/**
 * Mark participant as complete (submit a milestone response).
 */
export function markComplete() {
    saveResponse('milestone', { event: 'completed', completedAt: new Date().toISOString() });
}

// ── Progress & Step Sync ────────────────────────────────────────────────────

/**
 * Fire-and-forget: update current_step on server.
 * Call when a step is completed (not on entry).
 * @param {number} step - The step index just completed
 */
export function syncStep(step) {
    const pid = getParticipantId();
    const sid = getStudyId();
    if (!pid) { log('⚠️', 'no participantId — skipping step sync'); return; }

    d1Put(`/api/study/${sid}/participants/${encodeURIComponent(pid)}/step`, { step })
        .then(r => r && log('✅', `synced step ${step}`));
}

export function syncCondition(conditionData) {
    const pid = getParticipantId();
    const sid = getStudyId();
    if (!pid) { log('⚠️', 'no participantId — skipping condition sync'); return; }

    d1Put(`/api/study/${sid}/participants/${encodeURIComponent(pid)}/condition`, conditionData)
        .then(r => r && log('✅', `synced condition #${conditionData.conditionIndex}`));
}

/**
 * Fetch participant data from D1.
 * Returns { current_step, responses, flags, completed_at } or null.
 */
export async function fetchParticipantData(participantId, studyId) {
    const pid = participantId || getParticipantId();
    const sid = studyId || getStudyId();
    if (!pid) { log('⚠️', 'no participantId — skipping data fetch'); return null; }

    const data = await d1Get(`/api/study/${sid}/participants/${encodeURIComponent(pid)}/data`);
    if (data?.success) {
        log('✅', `fetched participant data: step ${data.current_step}`);
        return data;
    }
    return null;
}

/** @deprecated Use fetchParticipantData instead */
export const fetchProgress = fetchParticipantData;

/**
 * Fetch all features for a participant from D1.
 * Returns array of feature objects or empty array.
 */
export async function fetchFeatures(participantId, studyId) {
    const pid = participantId || getParticipantId();
    const sid = studyId || getStudyId();
    if (!pid) { log('⚠️', 'no participantId — skipping features fetch'); return []; }

    const data = await d1Get(`/api/study/${sid}/participants/${encodeURIComponent(pid)}/features`);
    if (data?.success) {
        log('✅', `fetched ${data.features.length} features`);
        return data.features;
    }
    return [];
}

// ── Keepalive ────────────────────────────────────────────────────────────────
// Lightweight idle keepalive — proves the page is still open when the user
// isn't actively triggering actions. Real "last active" tracking uses
// updated_at, which is bumped by every step/feature/response save.

let _keepaliveTimer = null;

/**
 * Start periodic keepalive pings. Fire-and-forget, never blocks UI.
 * @param {number} intervalMinutes - How often to ping (default 1)
 */
export function startHeartbeat(intervalMinutes = 1) {
    stopHeartbeat();
    const pid = getParticipantId();
    const sid = getStudyId();
    if (!pid || !sid) return;

    const ping = async () => {
        try {
            await fetch(`${getApiBase()}/api/study/${sid}/participants/${encodeURIComponent(pid)}/heartbeat`, {
                method: 'POST'
            });
        } catch {
            // Silent fail
        }
    };

    ping();
    _keepaliveTimer = setInterval(ping, intervalMinutes * 60000);
}

/** Stop the keepalive interval. */
export function stopHeartbeat() {
    if (_keepaliveTimer) {
        clearInterval(_keepaliveTimer);
        _keepaliveTimer = null;
    }
}
