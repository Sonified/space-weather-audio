/**
 * study-flow.js — Config-driven study flow controller
 *
 * Replaces hardcoded emic-study-flow.js for the universal study.html page.
 * Reads study config from D1 via fetchStudyConfig(), then walks through
 * config.steps[] driving registration, modals, analysis, surveys, and completion.
 *
 * Does NOT reinvent the audio/spectrogram — uses the same main.js infrastructure.
 * Does NOT modify emic_study.html or emic-study-flow.js.
 */

import { fetchStudyConfig, setStudyId, initParticipant, saveSurveyAnswer, saveFeature, saveResponse, markComplete, getParticipantId as d1GetParticipantId, startHeartbeat, stopHeartbeat, getApiBase } from './d1-sync.js';
import { modalManager } from './modal-manager.js';
import { getParticipantId, storeParticipantId, clearParticipantId, generateParticipantId } from './participant-id.js';
import { styleBodyHtml } from './study-builder/utils.js';
import { typeText, cancelTyping } from './status-text.js';
import { buildDimensionStyle, buildTitleFontStyle, buildHeaderUnderlineStyle, renderInfoModal, renderRegistrationModal, renderQuestionModal } from './survey-question-renderer.js';

// Heavy imports (Three.js) — deferred until after first modal paints
let _heavyModules = null;
let _ft, _ap;
function startHeavyImports() {
    if (_heavyModules) return _heavyModules;
    _heavyModules = Promise.all([
        import('./feature-tracker.js'),
        import('./audio-player.js'),
    ]);
    _heavyModules.then(([ft, ap]) => { _ft = ft; _ap = ap; });
    return _heavyModules;
}
const getHeavy = () => startHeavyImports().then(([ft, ap]) => { _ft = ft; _ap = ap; return { ft, ap }; });

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let studyConfig = null;     // Full config from D1
let currentStepIndex = 0;   // Current position in config.steps[]
let studySlug = null;       // e.g. "emic-pilot"
let studyStartTime = null;
let flowActive = false;
let analysisAbort = null;  // AbortController for current analysis step listeners
let isReturningParticipant = false;  // True when resuming from a saved step
let assignedCondition = null;  // Participant's assigned experimental condition
let assignConditionPromise = null;  // Awaitable guard — runAnalysis blocks on this if needed

// ── Complete Button Controller ──────────────────────────────────────────
// Single owner of all #completeBtn DOM mutations (show, hide, enable, disable, fade).
let completeBtnActive = false;

function initCompleteButton(step) {
    const btn = document.getElementById('completeBtn');
    if (!btn) return;
    btn.textContent = step.completeBtnText || '✓ Complete';
    btn.disabled = false;          // never disabled — .ready controls everything
    btn.classList.remove('ready');
    btn.style.cursor = '';
    // Kill any lingering animation from previous section (fill: 'forwards' persists visuals)
    if (completeBtnAnim) { completeBtnAnim.cancel(); completeBtnAnim = null; }
    btn.style.setProperty('display', 'block', 'important');
    completeBtnActive = true;
}

let completeBtnAnim = null;

function updateCompleteButton(detail) {
    if (window.pm?.features) console.log(`[COMPLETE-BTN] hasFeature=${detail.hasFeature} active=${completeBtnActive}`);
    if (!completeBtnActive) return;
    const btn = document.getElementById('completeBtn');
    if (!btn) return;
    const wasReady = btn.classList.contains('ready');

    if (detail.hasFeature && !wasReady) {
        // Cursor switches to pointer immediately (clickable during fade)
        btn.style.cursor = 'pointer';
        // Grey → blue fade
        if (completeBtnAnim) completeBtnAnim.cancel();
        completeBtnAnim = btn.animate(
            [{ filter: 'grayscale(100%)', opacity: 0.7 },
             { filter: 'grayscale(0%)',   opacity: 1 }],
            { duration: 1500, easing: 'ease-in-out', fill: 'forwards' }
        );
        // Sparkle kicks in after fade completes
        completeBtnAnim.onfinish = () => btn.classList.add('ready');
    } else if (!detail.hasFeature && wasReady) {
        btn.classList.remove('ready');
        btn.style.cursor = '';
        // Blue → grey: instant
        if (completeBtnAnim) completeBtnAnim.cancel();
        completeBtnAnim = null;
    }
}


// Listen for feature changes from feature-tracker.js
document.addEventListener('featurechange', (e) => updateCompleteButton(e.detail));

// localStorage keys for progress persistence
const PROGRESS_KEY = 'study_flow_step';
const STUDY_SLUG_KEY = 'study_flow_slug';
const CONDITION_KEY_PREFIX = 'study_condition_';  // + slug

// Per-step flag keys — auto-generated from config
let stepFlagKeys = [];  // ['study_flag_emic-pilot_0_registration', ...]

// Reusable modal container for smooth crossfades between consecutive modals
let studyModalEl = null;
let studyModalInner = null;

// ═══════════════════════════════════════════════════════════════════════════════
// PER-STEP FLAGS
// ═══════════════════════════════════════════════════════════════════════════════

function generateStepFlagKeys(config, slug) {
    return config.steps.map((step, i) => {
        const type = step.contentType === 'questions' ? 'questions' : step.type;
        return `study_flag_${slug}_${i}_${type}`;
    });
}

function setStepFlag(stepIndex) {
    if (window.__PREVIEW_MODE) return;
    if (stepIndex < 0 || stepIndex >= stepFlagKeys.length) return;
    const key = stepFlagKeys[stepIndex];
    localStorage.setItem(key, 'done');
    window.dispatchEvent(new CustomEvent('study-flag-change', {
        detail: { key, stepIndex, value: 'done' }
    }));
}

function clearStepFlag(stepIndex) {
    if (stepIndex < 0 || stepIndex >= stepFlagKeys.length) return;
    const key = stepFlagKeys[stepIndex];
    localStorage.removeItem(key);
    window.dispatchEvent(new CustomEvent('study-flag-change', {
        detail: { key, stepIndex, value: null }
    }));
}

function getStepFlag(stepIndex) {
    if (stepIndex < 0 || stepIndex >= stepFlagKeys.length) return false;
    return localStorage.getItem(stepFlagKeys[stepIndex]) === 'done';
}

/** Returns array of { key, stepIndex, type, title, done } for the debug panel */
function getStepFlagStates() {
    if (!studyConfig) return [];
    return studyConfig.steps.map((step, i) => ({
        key: stepFlagKeys[i],
        stepIndex: i,
        type: step.contentType === 'questions' ? 'questions' : step.type,
        title: step.title || step.type,
        done: localStorage.getItem(stepFlagKeys[i]) === 'done'
    }));
}

function clearAllStepFlags() {
    for (let i = 0; i < stepFlagKeys.length; i++) {
        localStorage.removeItem(stepFlagKeys[i]);
    }
    window.dispatchEvent(new CustomEvent('study-flag-change', { detail: { key: '*', value: null } }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONDITION ASSIGNMENT & STEP REORDERING
// ═══════════════════════════════════════════════════════════════════════════════

/** Processing algorithm mapping: builder values → audio-state values */
const PROCESSING_MAP = { resample: 'resample', paulStretch: 'paul', wavelet: 'wavelet' };

/** Piecewise linear gain curve — interpolate dB between control points */
function applyGainCurveToBuffer(buffer, envelope) {
    const out = new Float32Array(buffer);
    if (!envelope || envelope.length === 0) return out;
    const pts = [...envelope].sort((a, b) => a.sample - b.sample);
    const totalSamples = buffer.length;
    const allPts = [];
    if (pts[0].sample > 0) allPts.push({ sample: 0, dB: 0 });
    allPts.push(...pts);
    if (pts[pts.length - 1].sample < totalSamples - 1) allPts.push({ sample: totalSamples - 1, dB: 0 });
    let cpIdx = 0;
    for (let i = 0; i < out.length; i++) {
        while (cpIdx < allPts.length - 2 && allPts[cpIdx + 1].sample <= i) cpIdx++;
        const p0 = allPts[cpIdx];
        const p1 = allPts[cpIdx + 1];
        const segLen = p1.sample - p0.sample;
        const t = segLen > 0 ? (i - p0.sample) / segLen : 0;
        const dB = p0.dB + t * (p1.dB - p0.dB);
        if (dB !== 0) out[i] *= Math.pow(10, dB / 20);
    }
    return out;
}

function _logWaveletRMS(samples) {
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
    const rms = Math.sqrt(sumSq / samples.length);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
    console.log(`%c🔊 [WAVELET] Audio RMS: ${rms.toFixed(6)}, peak: ${peak.toFixed(6)}, samples: ${samples.length}`, 'color: #E040FB; font-weight: bold;');
}

// Pre-rendered wavelet audio — cached promises keyed by startDate
const _waveletAudioCache = {};  // { 'YYYY-MM-DD': Promise<Float32Array> }

// ── IndexedDB cache for wavelet WAV files ──
const WAV_DB_NAME = 'waveletAudioCache';
const WAV_DB_VERSION = 1;
const WAV_STORE = 'wavFiles';
let _wavDb = null;

async function _openWavDb() {
    if (_wavDb) return _wavDb;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(WAV_DB_NAME, WAV_DB_VERSION);
        req.onerror = () => { console.warn('IndexedDB wavelet cache unavailable'); resolve(null); };
        req.onsuccess = () => { _wavDb = req.result; resolve(_wavDb); };
        req.onupgradeneeded = (e) => {
            const d = e.target.result;
            if (!d.objectStoreNames.contains(WAV_STORE)) {
                d.createObjectStore(WAV_STORE, { keyPath: 'filename' });
            }
        };
    });
}

async function _getCachedWav(filename) {
    const d = await _openWavDb();
    if (!d) return null;
    return new Promise((resolve) => {
        const tx = d.transaction([WAV_STORE], 'readonly');
        const req = tx.objectStore(WAV_STORE).get(filename);
        req.onsuccess = () => resolve(req.result?.samples ?? null);
        req.onerror = () => resolve(null);
    });
}

async function _storeCachedWav(filename, samples) {
    const d = await _openWavDb();
    if (!d) return;
    return new Promise((resolve) => {
        const tx = d.transaction([WAV_STORE], 'readwrite');
        tx.objectStore(WAV_STORE).put({ filename, samples, cachedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
    });
}

/**
 * Build the API URL for a pre-rendered wavelet audio file.
 */
function getWaveletAudioUrl(filename) {
    const API_BASE = window.location.hostname === 'spaceweather.now.audio'
        ? window.location.origin
        : 'https://spaceweather.now.audio';
    return `${API_BASE}/api/emic-audio/${encodeURIComponent(filename)}`;
}

/**
 * Fetch + decode a pre-rendered wavelet WAV from R2. Returns Float32Array.
 * Checks IndexedDB first; on miss, fetches from R2 and caches locally.
 * In-memory promise cache deduplicates concurrent fetches.
 */
function fetchWaveletAudio(dateKey, filename) {
    if (_waveletAudioCache[dateKey]) return _waveletAudioCache[dateKey];
    _waveletAudioCache[dateKey] = (async () => {
        try {
            // 1. Check IndexedDB cache
            const cached = await _getCachedWav(filename);
            if (cached) {
                console.log(`%c🎵 [WAVELET] Cache hit (IndexedDB): ${filename} — ${cached.length} samples`, 'color: #E040FB; font-weight: bold;');
                _logWaveletRMS(cached);
                return cached;
            }

            // 2. Fetch from R2
            const url = getWaveletAudioUrl(filename);
            console.log(`%c🎵 [WAVELET] Fetching from R2: ${filename}`, 'color: #E040FB; font-weight: bold;');
            const resp = await fetch(url);
            if (!resp.ok) {
                console.warn(`🎵 [WAVELET] Pre-rendered audio not found (${resp.status}): ${url}`);
                return null;
            }
            const arrayBuffer = await resp.arrayBuffer();

            // 3. Decode WAV
            const tempCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
            const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
            const samples = new Float32Array(audioBuffer.getChannelData(0));  // Copy from AudioBuffer
            console.log(`%c🎵 [WAVELET] Decoded: ${samples.length} samples (${(samples.length / 44100).toFixed(1)}s)`, 'color: #E040FB;');
            _logWaveletRMS(samples);

            // 4. Cache in IndexedDB for next time
            await _storeCachedWav(filename, samples);
            console.log(`%c🎵 [WAVELET] Cached in IndexedDB: ${filename}`, 'color: #E040FB;');

            return samples;
        } catch (err) {
            console.error('🎵 [WAVELET] Fetch/decode failed:', err);
            return null;
        }
    })();
    return _waveletAudioCache[dateKey];
}

/**
 * Kick off early wavelet audio prefetch for any analysis steps that use wavelet processing.
 * Called after condition assignment, before the participant starts analysis.
 */
// Default wavelet audio filenames keyed by analysis step start date (YYYY-MM-DD)
const DEFAULT_WAVELET_AUDIO_MAP = {
    '2022-08-17': 'GOES_REGION_1_speed_cwt_1.25x.wav',
    '2022-01-14': 'GOES_REGION_2_speed_cwt_1.25x.wav',
};
const DEFAULT_WAVELET_SPEED = 1.25;

function getWaveletMap() {
    const ed = studyConfig?.experimentalDesign;
    const map = ed?.waveletAudioMap;
    return (map && Object.keys(map).length > 0) ? map : DEFAULT_WAVELET_AUDIO_MAP;
}

function getWaveletSpeed() {
    return studyConfig?.experimentalDesign?.waveletSpeed || DEFAULT_WAVELET_SPEED;
}

function prefetchWaveletAudio() {
    const waveletMap = getWaveletMap();

    // Find analysis steps and check which ones use wavelet
    const analysisIndices = [];
    studyConfig.steps.forEach((s, i) => { if (s.type === 'analysis') analysisIndices.push(i); });

    analysisIndices.forEach((stepIdx) => {
        const step = studyConfig.steps[stepIdx];
        if (step._assignedProcessing !== 'wavelet') return;

        const startDate = (step.startTime || step.startDate || '').slice(0, 10);
        const filename = waveletMap[startDate];
        if (filename) {
            fetchWaveletAudio(startDate, filename);  // Fire and forget — cached for later
        }
    });
}

/**
 * Load a previously assigned condition.
 * Checks sessionStorage first (per-tab, immune to cross-tab races),
 * then falls back to localStorage (for resume on reload).
 * After a reset, localStorage is untrusted (other tabs may have written to it).
 */
function loadSavedCondition(slug) {
    try {
        const raw = sessionStorage.getItem(CONDITION_KEY_PREFIX + slug);
        if (raw) return JSON.parse(raw);
        // Only fall back to localStorage if this tab hasn't been reset
        if (sessionStorage.getItem('_condition_reset')) return null;
        const local = localStorage.getItem(CONDITION_KEY_PREFIX + slug);
        return local ? JSON.parse(local) : null;
    } catch { return null; }
}

/** Save condition to both sessionStorage (per-tab) and localStorage (resume). */
function saveCondition(slug, condition) {
    const json = JSON.stringify(condition);
    sessionStorage.setItem(CONDITION_KEY_PREFIX + slug, json);
    localStorage.setItem(CONDITION_KEY_PREFIX + slug, json);
    sessionStorage.removeItem('_condition_reset'); // have a real condition now
}

/** Clear condition from both storages. Flags this tab to not trust localStorage. */
function clearCondition(slug) {
    sessionStorage.removeItem(CONDITION_KEY_PREFIX + slug);
    localStorage.removeItem(CONDITION_KEY_PREFIX + slug);
    sessionStorage.setItem('_condition_reset', '1');
}

/**
 * Assign a participant to an experimental condition.
 * If already assigned, returns the existing condition.
 * Called after registration completes.
 */
async function assignCondition() {
    const conditions = studyConfig.experimentalDesign?.conditions;
    if (!conditions || conditions.length === 0) return null;

    // Preview/test mode — use forced condition from URL param if provided
    if (window.__PREVIEW_MODE || window.__TEST_MODE) {
        const forcedIdx = parseInt(new URLSearchParams(window.location.search).get('condition'));
        if (forcedIdx && conditions[forcedIdx - 1]) {
            const picked = conditions[forcedIdx - 1];
            const mode = window.__PREVIEW_MODE ? 'preview' : 'test';
            const condition = {
                conditionIndex: forcedIdx,
                order: picked.order,
                task1Processing: picked.task1Processing,
                task2Processing: picked.task2Processing,
                assignmentMode: mode
            };
            console.log(`%c[ASSIGN] ${mode} — forced condition #${forcedIdx}`, 'color: #aa77ff; font-weight: bold;', condition);
            if (window.__TEST_MODE) saveCondition(studySlug, condition);
            return condition;
        }
        if (window.__PREVIEW_MODE) {
            if (window.pm?.study_flow) console.log('%c[ASSIGN] Preview mode — no condition forced, skipping', 'color: #aa77ff;');
            return null;
        }
        // Test mode without forced condition — fall through to server assignment
    }

    // Check for existing assignment
    const existing = loadSavedCondition(studySlug);
    if (existing) {
        if (window.pm?.study_flow) console.log(`🧪 Condition already assigned: #${existing.conditionIndex}`, existing);
        return existing;
    }

    // Server-side assignment for block/healingBlock methods
    const method = studyConfig.experimentalDesign?.randomization?.method;
    if (method === 'block' || method === 'healingBlock') {
        if (window.pm?.study_flow) console.log(`%c[ASSIGN] → Requesting server-side assignment (${method}) for ${getParticipantId()}`, 'color: #aa77ff;');
        try {
            const resp = await fetch(`${getApiBase()}/api/study/${studySlug}/assign`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ participant_id: getParticipantId() })
            });
            const data = await resp.json();
            if (window.pm?.study_flow) console.log(`%c[ASSIGN] ← Server response:`, 'color: #aa77ff;', data);
            if (data.success && data.conditionIndex != null) {
                const condition = {
                    conditionIndex: data.conditionIndex,
                    order: data.order,
                    task1Processing: data.task1Processing,
                    task2Processing: data.task2Processing,
                    assignmentMode: data.assignmentMode,
                    block: data.block,
                };
                saveCondition(studySlug, condition);
                if (window.pm?.study_flow) console.log(`%c[ASSIGN] ✅ Condition #${data.conditionIndex} (${data.assignmentMode} | block ${data.block} | ${data.phase} | step ${data.step})`, 'color: #aa77ff; font-weight: bold;');
                return condition;
            }
            // No active session — just proceed with default flow (no condition)
            console.warn(`[ASSIGN] ⚠️ No active study session — proceeding with default flow (no condition)`);
            return null;
        } catch (e) {
            console.warn('[ASSIGN] ⚠️ Server unreachable — proceeding with default flow (no condition)');
            return null;
        }
    }

    // Random assignment — ONLY for studies explicitly configured with method='random'
    const idx = Math.floor(Math.random() * conditions.length);
    const picked = conditions[idx];
    const condition = {
        conditionIndex: idx + 1,
        order: picked.order,
        task1Processing: picked.task1Processing,
        task2Processing: picked.task2Processing
    };

    // Persist locally
    saveCondition(studySlug, condition);
    if (window.pm?.study_flow) console.log(`🧪 Assigned to condition #${idx + 1} (random method):`, condition);

    // Sync to D1 (fire-and-forget)
    import('./d1-sync.js').then(({ syncCondition }) => {
        if (syncCondition) syncCondition(condition);
    }).catch(() => {});

    return condition;
}

/**
 * Reorder analysis steps and assign processing algorithms based on condition.
 * Mutates studyConfig.steps in place — deterministic from the condition,
 * so returning participants always get the same order.
 */
function applyConditionOrder(condition) {
    if (!condition || !studyConfig) return;

    // Find all analysis step indices
    const analysisIndices = [];
    studyConfig.steps.forEach((step, i) => {
        if (step.type === 'analysis') analysisIndices.push(i);
    });

    if (analysisIndices.length < 2) return;

    // condition.order is [0,1] or [1,0] — indices into the analysis steps
    const [first, second] = condition.order;

    // Swap if needed (order [1,0] means second analysis step should come first)
    if (first === 1 && second === 0) {
        const idx0 = analysisIndices[0];
        const idx1 = analysisIndices[1];
        const temp = studyConfig.steps[idx0];
        studyConfig.steps[idx0] = studyConfig.steps[idx1];
        studyConfig.steps[idx1] = temp;
        if (window.pm?.study_flow) console.log(`🧪 Swapped analysis steps: step ${idx0} ↔ step ${idx1}`);
    }

    // Assign processing to each analysis step (1st gets task1Processing, 2nd gets task2Processing)
    const step1 = studyConfig.steps[analysisIndices[0]];
    const step2 = studyConfig.steps[analysisIndices[1]];
    step1._assignedProcessing = condition.task1Processing;
    step2._assignedProcessing = condition.task2Processing;
    if (window.pm?.study_flow) console.log(`🧪 Processing: step ${analysisIndices[0]} → ${condition.task1Processing}, step ${analysisIndices[1]} → ${condition.task2Processing}`);
}

/**
 * Show a welcome-back modal before resuming an analysis step.
 * Reuses the existing info modal rendering pipeline.
 */
async function showWelcomeBackModal({ title, bodyHtml, buttonLabel }) {
    return new Promise(async (resolve) => {
        const fakeStep = {
            title: title || 'Welcome Back',
            bodyHtml: bodyHtml || '',
            dismissLabel: buttonLabel || 'Continue',
            hideButton: false,
            closable: false
        };
        const html = renderInfoModal({ step: fakeStep, bodyHtml: fakeStep.bodyHtml });
        await setStudyModalContent(html);
        openStudyModalIfNeeded();

        const dismiss = () => {
            document.removeEventListener('keydown', enterHandler);
            resolve();
        };

        const btn = studyModalInner.querySelector('.modal-dismiss');
        if (btn) btn.addEventListener('click', dismiss, { once: true });

        const enterHandler = (e) => {
            if (e.key === 'Enter') dismiss();
        };
        document.addEventListener('keydown', enterHandler);
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEBUG FLAGS PANEL
// ═══════════════════════════════════════════════════════════════════════════════

let flagsPanelBuilt = false;

function initStudyFlagsPanel() {
    const btn = document.getElementById('showFlagsBtn');
    const panel = document.getElementById('studyFlagsPanel') || document.getElementById('emicFlagsPanel');
    if (!btn || !panel) return;

    btn.style.display = '';

    function showPanel() {
        panel.style.display = 'block';
        btn.textContent = 'Hide Flags';
        buildFlagsUI(panel);
        syncFlagsUI();
        window.addEventListener('study-flag-change', syncFlagsUI);
        localStorage.setItem('study_flags_panel_visible', 'true');
    }

    function hidePanel() {
        panel.style.display = 'none';
        btn.textContent = 'Show Flags';
        window.removeEventListener('study-flag-change', syncFlagsUI);
        localStorage.setItem('study_flags_panel_visible', 'false');
    }

    btn.addEventListener('click', () => {
        if (panel.style.display === 'none' || !panel.style.display) showPanel();
        else hidePanel();
    });

    // Restore visibility from previous session
    if (localStorage.getItem('study_flags_panel_visible') === 'true') {
        showPanel();
    }
}

function buildFlagsUI(panel) {
    if (flagsPanelBuilt) return;
    flagsPanelBuilt = true;

    const content = document.getElementById('studyFlagsContent') || document.getElementById('emicFlagsContent') || panel;

    const states = getStepFlagStates();
    const stepIcons = { registration: '👤', modal: '📋', analysis: '🔬', questions: '❓' };

    let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong style="color:#fff;font-size:13px;">Study Flags — ${studySlug}</strong>
        <div style="display:flex;gap:6px;">
            <button id="sfSelectAll" style="font-size:11px;padding:2px 8px;background:#333;border:1px solid #555;color:#aaa;border-radius:4px;cursor:pointer;">Select All</button>
            <button id="sfDeselectAll" style="font-size:11px;padding:2px 8px;background:#333;border:1px solid #555;color:#aaa;border-radius:4px;cursor:pointer;">Deselect All</button>
        </div>
    </div>`;

    html += `<div style="display:flex;flex-direction:column;gap:4px;">`;
    for (const s of states) {
        const icon = stepIcons[s.type] || '📄';
        html += `<label style="display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:4px;cursor:pointer;background:rgba(255,255,255,0.03);" data-step-flag="${s.stepIndex}">
            <input type="checkbox" data-flag-index="${s.stepIndex}" style="width:14px;height:14px;cursor:pointer;" ${s.done ? 'checked' : ''}>
            <span style="opacity:0.5;font-size:11px;">${s.stepIndex}.</span>
            <span>${icon} ${s.title}</span>
            <span style="margin-left:auto;font-size:10px;color:#666;">${s.type}</span>
        </label>`;
    }
    html += `</div>`;

    // Progress indicator
    html += `<div id="sfProgress" style="margin-top:8px;padding-top:8px;border-top:1px solid #333;font-size:11px;color:#666;"></div>`;

    content.innerHTML = html;
    content.style.display = 'block';

    // Wire checkboxes
    content.querySelectorAll('input[data-flag-index]').forEach(cb => {
        cb.addEventListener('change', () => {
            const idx = parseInt(cb.dataset.flagIndex, 10);
            if (cb.checked) setStepFlag(idx);
            else clearStepFlag(idx);
            syncFlagsUI();
        });
    });

    // Wire select all
    const selectBtn = content.querySelector('#sfSelectAll');
    if (selectBtn) {
        selectBtn.addEventListener('click', () => {
            for (let i = 0; i < getStepFlagStates().length; i++) setStepFlag(i);
            syncFlagsUI();
        });
    }

    // Wire deselect all
    const deselectBtn = content.querySelector('#sfDeselectAll');
    if (deselectBtn) {
        deselectBtn.addEventListener('click', () => {
            clearAllStepFlags();
            syncFlagsUI();
        });
    }

    // Wire close via the drag-handle close button (from HTML)
    const closeBtn = document.getElementById('studyFlagsClose') || document.getElementById('emicFlagsClose');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            panel.style.display = 'none';
            const btn = document.getElementById('showFlagsBtn');
            if (btn) btn.textContent = 'Show Flags';
            window.removeEventListener('study-flag-change', syncFlagsUI);
            localStorage.setItem('study_flags_panel_visible', 'false');
        });
    }

    // Wire drag handle
    const dragHandle = document.getElementById('studyFlagsDragHandle') || document.getElementById('emicFlagsDragHandle');
    if (dragHandle) {
        let dragging = false, startX, startY, startLeft, startTop;
        dragHandle.addEventListener('pointerdown', (e) => {
            dragging = true;
            startX = e.clientX; startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            startLeft = rect.left; startTop = rect.top;
            dragHandle.style.cursor = 'grabbing';
            dragHandle.setPointerCapture(e.pointerId);
        });
        dragHandle.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            panel.style.left = (startLeft + e.clientX - startX) + 'px';
            panel.style.top = (startTop + e.clientY - startY) + 'px';
            panel.style.right = 'auto';
        });
        dragHandle.addEventListener('pointerup', () => {
            dragging = false;
            dragHandle.style.cursor = 'grab';
        });
    }
}

function syncFlagsUI() {
    const states = getStepFlagStates();
    let doneCount = 0;
    for (const s of states) {
        const cb = document.querySelector(`input[data-flag-index="${s.stepIndex}"]`);
        if (cb) cb.checked = s.done;
        if (s.done) doneCount++;
    }
    const progress = document.getElementById('sfProgress');
    if (progress) {
        progress.textContent = `Progress: ${doneCount}/${states.length} steps · Current: ${currentStepIndex}`;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// APP SETTINGS → DOM MAPPING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Maps nested appSettings keys to DOM element IDs.
 * Format: { 'group.key': 'elementId' }
 */
const SETTINGS_MAP = {
    // Session
    'session.idMode': 'participantIdMode',
    'session.showIdCorner': 'pidCornerDisplay',
    'session.skipLoginWelcome': 'skipLoginWelcome',
    // Data Loading
    'dataLoading.source': 'dataSource',
    'dataLoading.bypassCache': 'drawerBypassCache',
    'dataLoading.silentDownload': 'silentDownload',
    'dataLoading.autoDownload': 'autoDownload',
    'dataLoading.autoPlay': 'autoPlay',
    'dataLoading.rendering': 'dataRendering',
    // Feature Boxes
    'featureBoxes.visible': 'featureBoxesVisible',
    'featureBoxes.annotationAlignment': 'annotationAlignment',
    'featureBoxes.annotationWidth': 'annotationWidth',
    'featureBoxes.annotationFontSize': 'annotationFontSize',
    // Display
    'display.displayOnLoad': 'displayOnLoad',
    'display.initialHours': 'initialHours',
    'display.minUIWidth': 'minUIWidth',
    'display.heightMinimap': 'heightMinimap',
    'display.heightSpectrogram': 'heightSpectrogram',
    // Audio
    'audio.quality': 'audioQuality',
    // Rendering
    'rendering.tileCompression': 'tileCompression',
    'rendering.tileEdgeMode': 'tileEdgeMode',
    'rendering.tileChunkSize': 'tileChunkSize',
    'rendering.zoomOutMode': 'mainWindowZoomOut',
    'rendering.levelTransition': 'levelTransition',
    'rendering.crossfadePower': 'crossfadePower',
    'rendering.renderOrder': 'renderOrder',
    'rendering.waveformPanMode': 'waveformPanMode',
    // Waveform Zoom
    'waveformZoom.catmullMode': 'catmullMode',
    'waveformZoom.catmullThreshold': 'catmullThreshold',
    'waveformZoom.catmullCore': 'catmullCore',
    'waveformZoom.catmullFeather': 'catmullFeather',
    // Navigation
    'navigation.arrowZoomStep': 'arrowZoomStep',
    'navigation.arrowPanStep': 'arrowPanStep',
    // X-Axis Ticks
    'xAxisTicks.zoomFadeMode': 'tickZoomFadeMode',
    'xAxisTicks.fadeInCurve': 'tickFadeInCurve',
    'xAxisTicks.fadeInTime': 'tickFadeInTime',
    'xAxisTicks.fadeOutCurve': 'tickFadeOutCurve',
    'xAxisTicks.fadeOutTime': 'tickFadeOutTime',
    'xAxisTicks.zoomSpatialCurve': 'tickZoomSpatialCurve',
    'xAxisTicks.zoomSpatialWidth': 'tickZoomSpatialWidth',
    'xAxisTicks.edgeFadeMode': 'tickEdgeFadeMode',
    'xAxisTicks.edgeFadeCurve': 'tickEdgeFadeCurve',
    'xAxisTicks.edgeSpatialWidth': 'tickEdgeSpatialWidth',
    'xAxisTicks.edgeTimeIn': 'tickEdgeTimeIn',
    'xAxisTicks.edgeTimeOut': 'tickEdgeTimeOut',
    // Feature Playback
    'featurePlayback.mode': 'featurePlaybackMode',
    // Page Scroll
    'pageScroll.lock': 'lockPageScroll',
    // Nav Bar (gear popover)
    'navBar.view': 'miniMapView',
    'navBar.viewingMode': 'viewingMode',
    'navBar.click': 'navBarClick',
    'navBar.markers': 'navBarMarkers',
    'navBar.featureBoxes': 'navBarFeatureBoxes',
    'navBar.vScroll': 'navBarScroll',
    'navBar.vSens': 'navBarVSens',
    'navBar.hScroll': 'navBarHScroll',
    'navBar.hSens': 'navBarHSens',
    // Main Window (gear popover)
    'mainWindow.view': 'mainWindowView',
    'mainWindow.mode': 'mainWindowMode',
    'mainWindow.click': 'mainWindowClick',
    'mainWindow.release': 'mainWindowRelease',
    'mainWindow.drag': 'mainWindowDrag',
    'mainWindow.markers': 'mainWindowMarkers',
    'mainWindow.xAxis': 'mainWindowXAxis',
    'mainWindow.boxFilter': 'mainWindowBoxFilter',
    'mainWindow.vScroll': 'mainWindowScroll',
    'mainWindow.vSens': 'mainWindowVSens',
    'mainWindow.hScroll': 'mainWindowHScroll',
    'mainWindow.hSens': 'mainWindowHSens',
    'mainWindow.numbers': 'mainWindowNumbers',
    'mainWindow.numbersLoc': 'mainWindowNumbersLoc',
    'mainWindow.numbersWeight': 'mainWindowNumbersWeight',
    'mainWindow.numbersSize': 'mainWindowNumbersSize',
    'mainWindow.numbersShadow': 'mainWindowNumbersShadow',
    // Debug
    'debug.printInit': 'printInit',
    'debug.printGPU': 'printGPU',
    'debug.printMemory': 'printMemory',
    'debug.printAudio': 'printAudio',
    'debug.printStudy': 'printStudy',
    'debug.printFeatures': 'printFeatures',
    'debug.printData': 'printData',
    'debug.printInteraction': 'printInteraction',
};

// Reverse map: elementId → 'group.key'
const REVERSE_SETTINGS_MAP = {};
for (const [key, elId] of Object.entries(SETTINGS_MAP)) {
    REVERSE_SETTINGS_MAP[elId] = key;
}

/**
 * Apply appSettings from config to DOM elements, dispatching change events
 * so settings-drawer.js listeners pick up the values.
 */
function applyAppSettings(settings) {
    if (!settings) return;

    // Flatten nested object: { session: { idMode: 'manual' } } → { 'session.idMode': 'manual' }
    const flat = {};
    for (const [group, values] of Object.entries(settings)) {
        if (typeof values === 'object' && values !== null) {
            for (const [key, val] of Object.entries(values)) {
                flat[`${group}.${key}`] = val;
            }
        }
    }

    for (const [path, value] of Object.entries(flat)) {
        // "auto" means "don't override — let the page's own logic handle it"
        if (value === 'auto') continue;

        const elId = SETTINGS_MAP[path];
        if (!elId) continue;

        const el = document.getElementById(elId);
        if (!el) continue;

        // Debug checkboxes: only apply if config explicitly enables them.
        // false/undefined = leave the user's hamburger preference alone.
        if (path.startsWith('debug.') && !value) continue;

        // Handle booleans for checkboxes
        if (el.type === 'checkbox') {
            el.checked = !!value;
        }
        // Handle select with boolean-to-string mapping (pidCornerDisplay: true → 'show')
        else if (el.tagName === 'SELECT' && typeof value === 'boolean') {
            el.value = value ? 'show' : 'hide';
        }
        // Handle range/number inputs
        else if (el.type === 'range' || el.type === 'number') {
            el.value = value;
        }
        // Handle text inputs (spinners) and selects
        else {
            el.value = String(value);
        }

        // Dispatch change event so listeners pick it up
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    if (window.pm?.study_flow) console.log(`📋 Applied ${Object.keys(flat).length} app settings from config`);
}

/**
 * Read current DOM state and build an appSettings object.
 */
function collectAppSettingsFromDOM() {
    const settings = {};

    for (const [path, elId] of Object.entries(SETTINGS_MAP)) {
        const el = document.getElementById(elId);
        if (!el) continue;

        const [group, key] = path.split('.');
        if (!settings[group]) settings[group] = {};

        if (el.type === 'checkbox') {
            settings[group][key] = el.checked;
        } else if (el.tagName === 'SELECT' && (path === 'session.showIdCorner')) {
            settings[group][key] = el.value === 'show';
        } else if (el.type === 'range') {
            settings[group][key] = parseFloat(el.value);
        } else if (el.classList.contains('spinner-value') || el.type === 'number') {
            settings[group][key] = parseInt(el.value, 10) || 0;
        } else {
            // Try to parse as number if it looks numeric
            const num = Number(el.value);
            settings[group][key] = isNaN(num) ? el.value : num;
        }
    }

    return settings;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN MODE
// ═══════════════════════════════════════════════════════════════════════════════

function initAdminMode(config) {
    const params = new URLSearchParams(window.location.search);
    const adminKey = params.get('admin');
    if (!adminKey || adminKey !== config.adminKey) return;

    window.__ADMIN_MODE = true;
    console.log('🔧 Admin mode activated');

    // Show hamburger/settings drawer even in study mode
    const hamburger = document.getElementById('hamburgerBtn');
    if (hamburger) hamburger.style.display = '';

    // Create admin bar
    const bar = document.createElement('div');
    bar.id = 'adminBar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#f5c518;color:#000;padding:8px 16px;display:flex;align-items:center;justify-content:space-between;font-family:system-ui;font-size:14px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
    bar.innerHTML = `
        <span>🔧 Admin Mode — changes save to all future participants</span>
        <button id="adminSaveBtn" style="background:#000;color:#f5c518;border:none;padding:6px 16px;border-radius:6px;font-weight:700;cursor:pointer;font-size:13px;">💾 Save Settings</button>
    `;
    document.body.prepend(bar);

    // Push body content down
    document.body.style.paddingTop = '44px';

    // Wire save button
    document.getElementById('adminSaveBtn').addEventListener('click', async () => {
        const btn = document.getElementById('adminSaveBtn');
        btn.textContent = '⏳ Saving...';
        btn.disabled = true;

        try {
            const appSettings = collectAppSettingsFromDOM();
            const updatedConfig = { ...config, appSettings };

            const API_BASE = window.location.hostname === 'spaceweather.now.audio'
                ? window.location.origin
                : 'https://spaceweather.now.audio';

            const resp = await fetch(`${API_BASE}/api/study/${studySlug}/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: studyConfig.name || studySlug, config: JSON.stringify(updatedConfig) }),
            });

            if (resp.ok) {
                btn.textContent = '✅ Saved!';
                setTimeout(() => { btn.textContent = '💾 Save Settings'; btn.disabled = false; }, 2000);
                console.log('🔧 Admin: settings saved to D1');
            } else {
                btn.textContent = '❌ Failed';
                setTimeout(() => { btn.textContent = '💾 Save Settings'; btn.disabled = false; }, 2000);
            }
        } catch (e) {
            btn.textContent = '❌ Error';
            setTimeout(() => { btn.textContent = '💾 Save Settings'; btn.disabled = false; }, 2000);
            console.error('Admin save error:', e);
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION — runs on import
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// DATA PRELOADING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Preload tracking: which analysis steps have been triggered for preload.
 * Maps analysis step index → true once triggered.
 */
const preloadTriggered = {};

/**
 * Sequential preload queue. Each entry is a step index.
 * processPreloadQueue() drains this one at a time, awaiting each fetch.
 */
const preloadQueue = [];
let preloadQueueRunning = false;

async function processPreloadQueue() {
    if (preloadQueueRunning) return;
    preloadQueueRunning = true;

    // Yield to the browser so any pending DOM updates (e.g., study modals) can paint
    // before heavy synchronous work (de-trend, gain curve, GPU compute) starts.
    await new Promise(r => setTimeout(r, 0));

    // Same mapping as applyAnalysisConfig — must match so session keys align
    const spacecraftMap = {
        'GOES-16': { spacecraft: 'GOES', dataset: 'DN_MAGN-L2-HIRES_G16' },
        'GOES-17': { spacecraft: 'GOES', dataset: 'DN_MAGN-L2-HIRES_G17' },
        'GOES-18': { spacecraft: 'GOES', dataset: 'DN_MAGN-L2-HIRES_G18' },
        'GOES-19': { spacecraft: 'GOES', dataset: 'DN_MAGN-L2-HIRES_G19' },
        'MMS':     { spacecraft: 'MMS', dataset: 'MMS1_FGM_SRVY_L2' },
        'THEMIS':  { spacecraft: 'THEMIS', dataset: 'THA_L2_FGM' },
        'Van Allen Probes': { spacecraft: 'RBSP', dataset: 'RBSPA_REL04_ECT-HOPE-SCI-L2SA' },
    };

    while (preloadQueue.length > 0) {
        const stepIndex = preloadQueue.shift();
        const step = studyConfig.steps[stepIndex];
        if (!step || step.type !== 'analysis') continue;

        // Only prefetch Cloudflare data (CDAWeb has its own cache)
        const srcValue = (step.dataSource || '').toLowerCase();
        if (srcValue.includes('cdaweb')) {
            if (window.pm?.data) console.log(`📦 [PRELOAD] Step ${stepIndex} uses CDAWeb — skipping prefetch`);
            continue;
        }

        // Resolve spacecraft/dataset from step config
        const mapped = spacecraftMap[step.spacecraft] || { spacecraft: 'GOES', dataset: 'DN_MAGN-L2-HIRES_G16' };
        const startTime = step.startTime || (step.startDate ? step.startDate + 'T00:00:00.000Z' : null);
        const endTime = step.endTime || (step.endDate ? step.endDate + 'T00:00:00.000Z' : null);

        if (!startTime || !endTime) {
            if (window.pm?.data) console.log(`📦 [PRELOAD] Step ${stepIndex} missing time range, skipping`);
            continue;
        }

        if (window.pm?.data) console.log(`📦 [PRELOAD] Starting prefetch for step ${stepIndex} ("${step.title || 'Analysis'}") — ${mapped.spacecraft}/${mapped.dataset} ${startTime} → ${endTime}`);

        try {
            const { prefetchCloudflareData, getSessionAudioBuffer } = await import('./goes-cloudflare-fetcher.js');
            await prefetchCloudflareData(mapped.spacecraft, mapped.dataset, startTime, endTime);
            if (window.pm?.data) console.log(`📦 [PRELOAD] Prefetch complete for step ${stepIndex}`);

            // HS25: Pre-render GPU pyramid tiles for the NEXT analysis step only
            // (only one pyramid can exist at a time — pre-rendering a second would destroy the first)
            // Only pre-render the step the user is about to enter, not future steps
            const nextAnalysisIdx = studyConfig.steps.findIndex((s, i) => i >= currentStepIndex && s.type === 'analysis');
            const isNextAnalysis = stepIndex === nextAnalysisIdx;
            const { isPreRenderDone } = await import('./main-window-renderer.js');
            const alreadyPreRendered = isPreRenderDone();
            console.log(`%c🎨 [HS25] Prefetch done step=${stepIndex}. preRenderPyramid=${studyConfig?.experimentalDesign?.preRenderPyramid}, alreadyPreRendered=${alreadyPreRendered}, isNextAnalysis=${isNextAnalysis} (nextAnalysisIdx=${nextAnalysisIdx})`, 'color: #d29922; font-weight: bold;');
            if (studyConfig?.experimentalDesign?.preRenderPyramid && !alreadyPreRendered && isNextAnalysis) {
                try {
                    const sessionData = getSessionAudioBuffer(mapped.spacecraft, mapped.dataset, startTime, endTime);
                    console.log(`%c🎨 [HS25] sessionData: buffer=${sessionData?.buffer?.length}, metadata=${!!sessionData?.metadata}`, 'color: #d29922;');
                    if (sessionData?.buffer && sessionData.metadata) {
                        const { computeSpectrogramTiles } = await import('./main-window-renderer.js');
                        const cacheKey = `${mapped.spacecraft}:${mapped.dataset}:${startTime}:${endTime}`;
                        // De-trend → set state → render (same pattern as index.html/CDAWeb)
                        let buffer = sessionData.buffer;
                        if (studyConfig?.experimentalDesign?.detrend) {
                            const { removeDCOffset, normalize } = await import('./minimap-window-renderer.js');
                            const slider = document.getElementById('waveformFilterSlider');
                            const value = slider ? parseInt(slider.value) : 50;
                            const alpha = 0.95 + (value / 100) * (0.9999 - 0.95);
                            window.rawWaveformData = new Float32Array(buffer);
                            let detrended = removeDCOffset(new Float32Array(buffer), alpha);
                            console.log(`%c🎨 [HS25] De-trended buffer (alpha=${alpha.toFixed(4)})`, 'color: #d29922;');
                            // Yield so the browser can paint/animate between heavy sync ops
                            await new Promise(r => requestAnimationFrame(r));

                            // Apply gain curve between de-trend and peak normalize
                            if (window.__gainCurveData) {
                                const startDate = startTime?.slice(0, 10);
                                const gcRegion = Object.values(window.__gainCurveData).find(r => r.startDate?.slice(0, 10) === startDate);
                                if (gcRegion?.gainEnvelope?.length) {
                                    detrended = applyGainCurveToBuffer(detrended, gcRegion.gainEnvelope);
                                    console.log(`%c🎨 [HS25] Gain curve applied: ${gcRegion.label}`, 'color: #d29922;');
                                }
                            }

                            buffer = normalize(detrended);
                        }
                        const State = await import('./audio-state.js');
                        State.setCompleteSamplesArray(buffer);
                        console.log(`%c🎨 [HS25] Starting compute pipeline: ${cacheKey}`, 'color: #d29922; font-weight: bold;');
                        await computeSpectrogramTiles(buffer, {
                            dataDurationSec: sessionData.metadata.realWorldSpanSeconds,
                            sampleRate: sessionData.metadata.playbackSamplesPerRealSecond,
                            totalExpectedSamples: sessionData.metadata.totalExpectedSamples,
                            cacheKey,
                        });
                        console.log(`%c🎨 [HS25] Compute pipeline DONE`, 'color: #3fb950; font-weight: bold;');
                    }
                } catch (preRenderErr) {
                    console.warn(`🎨 [HS25] Pre-render failed:`, preRenderErr);
                }
            }
        } catch (err) {
            if (window.pm?.data) console.log(`📦 [PRELOAD] Prefetch failed for step ${stepIndex}:`, err.message);
        }

        if (preloadQueue.length > 0) {
            if (window.pm?.data) console.log(`📦 [PRELOAD] ${preloadQueue.length} more in queue, starting next...`);
        }
    }

    preloadQueueRunning = false;
    if (window.pm?.data) console.log(`📦 [PRELOAD] Queue drained — all preloads complete`);
}

/**
 * Trigger data preload for an analysis step.
 * Queues the step for sequential background fetching.
 */
function triggerPreloadForStep(stepIndex) {
    if (preloadTriggered[stepIndex]) {
        if (window.pm?.data) console.log(`📦 [PRELOAD] Step ${stepIndex} already triggered, skipping`);
        return;
    }
    preloadTriggered[stepIndex] = true;

    const step = studyConfig.steps[stepIndex];
    if (!step || step.type !== 'analysis') {
        if (window.pm?.data) console.log(`📦 [PRELOAD] Step ${stepIndex} is not an analysis step, skipping`);
        return;
    }

    if (window.pm?.data) console.log(`📦 [PRELOAD] Queuing preload for step ${stepIndex} ("${step.title || 'Analysis'}") — queue position: ${preloadQueue.length + 1}`);
    preloadQueue.push(stepIndex);
    processPreloadQueue();
}

/**
 * Scan config for analysis steps with dataPreload settings and set up triggers.
 */
function initDataPreload(config) {
    if (!config.steps) return;

    if (window.pm?.data) console.log(`📦 [PRELOAD-INIT] Scanning ${config.steps.length} steps for dataPreload configs...`);

    let preloadCount = 0;
    config.steps.forEach((step, stepIndex) => {
        if (step.type !== 'analysis' || !step.dataPreload) return;

        if (step.dataPreload === 'pageLoad') {
            // Skip preloading steps we've already passed (e.g. resuming at step 5, don't preload step 3)
            if (stepIndex <= currentStepIndex) {
                if (window.pm?.data) console.log(`📦 [PRELOAD-INIT] Step ${stepIndex} has dataPreload=pageLoad but already at/past step ${currentStepIndex}, skipping`);
                return;
            }
            if (window.pm?.data) console.log(`📦 [PRELOAD-INIT] Step ${stepIndex} has dataPreload=pageLoad — triggering now`);
            triggerPreloadForStep(stepIndex);
            preloadCount++;
        } else if (step.dataPreload.startsWith('step:')) {
            // Trigger when the specified step begins rendering
            const triggerAtStep = parseInt(step.dataPreload.split(':')[1], 10);
            if (!isNaN(triggerAtStep)) {
                // Store the mapping so runCurrentStep can check it
                if (!window.__PRELOAD_TRIGGERS) window.__PRELOAD_TRIGGERS = {};
                window.__PRELOAD_TRIGGERS[triggerAtStep] = stepIndex;
                if (window.pm?.data) console.log(`📦 [PRELOAD-INIT] Step ${stepIndex} has dataPreload=step:${triggerAtStep} — will preload when step ${triggerAtStep} starts`);
                preloadCount++;
            }
        }
        // 'onEnter' or missing = default behavior (no preload setup needed)
    });

    if (window.pm?.data) console.log(`📦 [PRELOAD-INIT] Done — ${preloadCount} preload triggers configured, __PRELOAD_TRIGGERS:`, window.__PRELOAD_TRIGGERS || 'none');
}

async function init() {
    const _t0 = performance.now();
    const _tLog = (label) => console.log(`⏱️ [INIT] ${label}: ${(performance.now() - _t0).toFixed(0)}ms`);

    studySlug = window.__STUDY_SLUG;
    if (!studySlug) {
        showError('No study specified. URL should be /study/{slug}');
        return;
    }

    // Set study ID for d1-sync.js
    setStudyId(studySlug);

    const titleEl = document.getElementById('studyTitle');

    // Fetch config from D1 (same Cloudflare edge — fast)
    if (window.pm?.study_flow) console.log(`%c[INIT] ① Fetching study config: ${studySlug}`, 'color: #58a6ff; font-weight: bold;');
    studyConfig = await fetchStudyConfig(studySlug);
    _tLog(studyConfig ? '✅ config loaded' : '❌ config not found');

    if (!studyConfig) {
        showError(`Study "${studySlug}" not found`);
        return;
    }

    if (window.pm?.study_flow) console.log(`📋 Study config loaded: "${studyConfig.name}" (${studyConfig.steps.length} steps)`);

    // Generate per-step flag keys
    stepFlagKeys = generateStepFlagKeys(studyConfig, studySlug);

    // Update page title — fade in to match modal entrance
    if (titleEl) {
        titleEl.textContent = studyConfig.name || studySlug;
        void titleEl.offsetHeight;
        titleEl.style.opacity = '0.88';
    }
    document.title = (studyConfig.name || studySlug) + ' — spaceweather.now.audio';

    // Apply analysis step config to window.__STUDY_CONFIG so main.js uses it
    const analysisStep = studyConfig.steps.find(s => s.type === 'analysis');
    if (analysisStep) {
        applyAnalysisConfig(analysisStep);
    }

    // Apply app settings from config to DOM (drives settings-drawer.js)
    // Non-blocking: apply when drawer appears, don't hold up init
    if (studyConfig.appSettings) {
        const _applyWhenReady = () => {
            if (document.getElementById('settingsDrawer')) {
                applyAppSettings(studyConfig.appSettings);
                _tLog('applyAppSettings (immediate)');
                return;
            }
            const obs = new MutationObserver(() => {
                if (document.getElementById('settingsDrawer')) {
                    obs.disconnect();
                    applyAppSettings(studyConfig.appSettings);
                    _tLog('applyAppSettings (deferred)');
                }
            });
            obs.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => obs.disconnect(), 3000);
        };
        _applyWhenReady();
    }

    // Load gain curves (non-blocking — needed by prefetch, not by modal)
    if (studyConfig.experimentalDesign?.gainCurve) {
        fetch('/gain_curves.json').then(r => r.ok ? r.json() : null).then(data => {
            if (data) {
                window.__gainCurveData = data;
                if (window.pm?.study_flow) console.log('📋 Gain curves loaded for audio normalization');
            }
            _tLog('gainCurves');
        }).catch(e => console.warn('Failed to load gain_curves.json:', e));
    }

    // CSS rule in study.html keeps participantIdDisplay hidden by default.
    // study-flow.js is the sole authority — updateParticipantDisplay() adds
    // .sf-pid-visible to show it when showIdCorner !== false.

    // Check for admin mode
    if (studyConfig.adminKey) {
        initAdminMode(studyConfig);
    }

    // NOTE: initDataPreload() is called later, after currentStepIndex is determined,
    // so it can skip preloading steps we've already passed.

    // ── Step Jump & Preview Mode ─────────────────────────────
    const urlParams = new URLSearchParams(window.location.search);
    const jumpToStep = urlParams.get('step');
    const mode = urlParams.get('mode');
    const isPreview = mode === 'preview' || urlParams.get('preview') === 'true';
    const isTestMode = mode === 'test' || urlParams.get('test') === 'true';

    // Ungated mode banner — always visible, impossible to miss
    const modeLabel = isPreview ? 'PREVIEW' : isTestMode ? 'TEST' : 'LIVE';
    const modeDot = isPreview ? '⚪' : isTestMode ? '🟡' : '🟢';
    const host = location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? 'localhost' : location.hostname;
    const resetFlag = urlParams.has('reset') ? ' | RESET' : '';
    console.log(`%c${modeDot} ${studyConfig.name || studySlug} | ${modeLabel} mode | ${host}${resetFlag}`, 'font-size: 14px; font-weight: bold; padding: 4px 0;');

    // Ungated session status line
    const sess = studyConfig._activeSession;
    if (sess) {
        const sessMode = (sess.mode || 'test').toUpperCase();
        const sessDot = sess.mode === 'live' ? '🟢' : '🟡';
        const blockInfo = sess.currentBlock ? `Block ${sess.currentBlock}` : 'No blocks yet';
        const started = sess.startedAt ? new Date(sess.startedAt).toLocaleString() : 'unknown';
        console.log(`%c   ${sessDot} ${sessMode} session active | ${blockInfo} | Started ${started}`, 'font-size: 12px; color: #888; padding: 2px 0;');
    } else {
        console.log('%c   ⚫ No active study session', 'font-size: 12px; color: #888; padding: 2px 0;');
    }

    // State dump for diagnostics
    if (window.pm?.study_flow) {
        console.log('📋 [STATE] mode param:', mode, '| isPreview:', isPreview, '| isTestMode:', isTestMode, '| jumpToStep:', jumpToStep);
        console.log('📋 [STATE] localStorage:', {
            participantId: localStorage.getItem('participantId'),
            progress: localStorage.getItem(PROGRESS_KEY),
            studySlug: localStorage.getItem(STUDY_SLUG_KEY),
            advancedMode: localStorage.getItem('study_advanced_mode') || localStorage.getItem('emic_advanced_mode'),
            adminUnlocked: localStorage.getItem('admin_unlocked'),
            flagsVisible: localStorage.getItem('study_flags_panel_visible'),
        });
        console.log('📋 [STATE] window flags:', {
            __PREVIEW_MODE: window.__PREVIEW_MODE,
            __TEST_MODE: window.__TEST_MODE,
            __STUDY_MODE: window.__STUDY_MODE,
            __EMIC_STUDY_MODE: window.__EMIC_STUDY_MODE,
            __STUDY_SLUG: window.__STUDY_SLUG,
        });
        console.log('📋 [STATE] DOM:', {
            permanentOverlay: !!document.getElementById('permanentOverlay'),
            studyModal: !!document.getElementById('studyModal'),
            dataAdvanced: document.documentElement.hasAttribute('data-advanced'),
            dataAdmin: document.documentElement.hasAttribute('data-admin'),
            modalManagerCurrent: modalManager.currentModal,
        });
    }

    // ── Reset Mode ───────────────────────────────────────────
    // &reset in URL clears ALL session state so everything runs fresh.
    // Must run BEFORE test mode so test mode sees a clean slate.
    if (urlParams.has('reset')) {
        clearParticipantId();
        localStorage.removeItem(PROGRESS_KEY);
        localStorage.removeItem(STUDY_SLUG_KEY);
        clearCondition(studySlug);
        // Clear saved survey answers
        if (studyConfig?.steps) {
            for (const step of studyConfig.steps) {
                if (step.contentType === 'questions' && step.questions) {
                    for (const q of step.questions) {
                        localStorage.removeItem(`study_answer_${studySlug}_${q.id}`);
                    }
                } else if (step.type === 'question' && step.id) {
                    localStorage.removeItem(`study_answer_${studySlug}_${step.id}`);
                }
            }
        }
        currentStepIndex = 0;
        if (window.pm?.study_flow) console.log('🧹 Reset mode — cleared session state (including condition)');

        // Prepend ♻️ to page title and tab
        document.title = '♻️ ' + document.title;
        if (titleEl) titleEl.textContent = '♻️ ' + titleEl.textContent;
    }

    // ── Test Mode ────────────────────────────────────────────
    // Like live mode (data IS saved), but participant ID is prefixed TEST_ so it can be filtered out later.
    // Session persists across refreshes — only clears on first entry or with &reset.
    if (isTestMode && !isPreview) {
        window.__TEST_MODE = true;

        // Check if we already have a TEST_ session in progress
        const existingId = sessionStorage.getItem('participantId') || localStorage.getItem('participantId');
        const hasTestSession = existingId && existingId.startsWith('TEST_');

        if (hasTestSession) {
            // Resume existing test session
            window.__TEST_PARTICIPANT_ID = existingId;
            if (window.pm?.study_flow) console.log(`🧪 Test mode — resuming session: ${existingId}`);
        } else {
            // First entry into test mode — generate new test ID and clear old session
            const testId = generateParticipantId('TEST');
            window.__TEST_PARTICIPANT_ID = testId;
            clearParticipantId();
            localStorage.removeItem(PROGRESS_KEY);
            localStorage.removeItem(STUDY_SLUG_KEY);
            clearCondition(studySlug);
            // Clear saved survey answers from previous session
            if (studyConfig?.steps) {
                for (const step of studyConfig.steps) {
                    if (step.contentType === 'questions' && step.questions) {
                        for (const q of step.questions) {
                            localStorage.removeItem(`study_answer_${studySlug}_${q.id}`);
                        }
                    } else if (step.type === 'question' && step.id) {
                        localStorage.removeItem(`study_answer_${studySlug}_${step.id}`);
                    }
                }
            }
            currentStepIndex = 0;
            if (window.pm?.study_flow) console.log(`🧪 Test mode — new session: ${testId}`);
        }

        // Update page tab
        const studyName2 = studyConfig.name || studySlug;
        document.title = `[Test] ${studyName2} — spaceweather.now.audio`;
        if (titleEl) titleEl.textContent = `[Test] ${studyName2}`;
    }

    if (isPreview) {
        window.__PREVIEW_MODE = true;
        // Generate a preview participant ID — server will silently drop data for preview_ users
        const previewId = generateParticipantId('PREVIEW');
        // Don't set participantId yet — let registration run so it's visible in preview
        clearParticipantId();
        window.__PREVIEW_PARTICIPANT_ID = previewId;

        // Always start fresh in preview mode — clear any saved progress
        localStorage.removeItem(PROGRESS_KEY);
        localStorage.removeItem(STUDY_SLUG_KEY);
        currentStepIndex = 0;

        // Show preview banner
        const banner = document.createElement('div');
        const stepLabel = jumpToStep !== null ? `Step ${parseInt(jumpToStep,10)+1} of ${studyConfig.steps.length}` : '';
        banner.id = 'previewBanner';
        banner.style.cssText = 'position:fixed;top:8px;left:8px;z-index:999999;background:rgba(33,150,243,0.55);color:#fff;padding:3px 10px;font-family:system-ui;font-size:11px;font-weight:500;border-radius:4px;pointer-events:none;backdrop-filter:blur(4px);';
        banner.textContent = `🔍 Preview Mode${stepLabel ? ' Step ' + (parseInt(jumpToStep,10)+1) : ''}`;
        document.body.prepend(banner);

        // Update page tab: 👁 [Preview] Study Name + swap favicon
        const studyName = studyConfig.name || studySlug;
        document.title = `[Preview] ${studyName} — spaceweather.now.audio`;
        if (titleEl) titleEl.textContent = `[Preview] ${studyName}`;
        const favicon = document.querySelector('link[rel="icon"]');
        if (favicon) favicon.href = "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>👁</text></svg>";

        if (window.pm?.study_flow) console.log(`📋 Preview mode active — participant: ${previewId}`);

        // Live-reload: listen for step updates from the study builder via localStorage
        window.addEventListener('storage', (e) => {
            if (e.key !== 'study_preview_update' || !e.newValue) return;
            try {
                const { slug, steps } = JSON.parse(e.newValue);
                if (slug !== studySlug || !steps || !steps[currentStepIndex]) return;
                const step = steps[currentStepIndex];
                Object.assign(studyConfig.steps[currentStepIndex], step);
                if (step.type === 'info' || (step.type === 'modal' && step.contentType !== 'questions')) {
                    rerenderInfoModal(studyConfig.steps[currentStepIndex]);
                }
            } catch (err) { /* ignore parse errors */ }
        });
    }

    if (jumpToStep !== null) {
        const stepIndex = parseInt(jumpToStep, 10);
        if (!isNaN(stepIndex) && stepIndex >= 0 && stepIndex < studyConfig.steps.length) {
            currentStepIndex = stepIndex;
            // Mark all previous steps as complete so the flow doesn't restart
            for (let i = 0; i < stepIndex; i++) {
                setStepFlag(i);
            }
            if (window.pm?.study_flow) console.log(`📋 Jumped to step ${stepIndex} from URL`);

            // In preview mode jumping past registration, store the preview ID
            if (isPreview && window.__PREVIEW_PARTICIPANT_ID && stepIndex > 0) {
                storeParticipantId(window.__PREVIEW_PARTICIPANT_ID);
                const regStep = studyConfig.steps.find(s => s.type === 'registration');
                if (!regStep || regStep.showIdCorner !== false) updateParticipantDisplay(window.__PREVIEW_PARTICIPANT_ID);
            }

            // For analysis steps jumped to directly, apply config and auto-trigger
            const jumpStep = studyConfig.steps[stepIndex];
            if (jumpStep && jumpStep.type === 'analysis') {
                applyAnalysisConfig(jumpStep);
                // Force progressive rendering for preview
                const renderEl = document.getElementById('dataRendering');
                if (renderEl) {
                    renderEl.value = 'progressive';
                    renderEl.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        }
    }

    // Skip normal progress restore if we jumped, or are in preview/test mode
    if (jumpToStep === null && !isPreview) {
    // Restore progress: local first, then reconcile with D1
    if (window.pm?.study_flow) console.log(`%c[INIT] ② Detecting returning participant...`, 'color: #58a6ff; font-weight: bold;');
    const savedSlug = localStorage.getItem(STUDY_SLUG_KEY);
    const localStep = parseInt(localStorage.getItem(PROGRESS_KEY) || '0', 10);
    let bestStep = (savedSlug === studySlug && localStep > 0 && localStep < studyConfig.steps.length)
        ? localStep : 0;

    // Try to fetch server-side progress (non-blocking — if it fails, use local)
    try {
        const { fetchParticipantData } = await import('./d1-sync.js');
        const progress = await fetchParticipantData();
        if (progress && progress.current_step > bestStep && progress.current_step < studyConfig.steps.length) {
            bestStep = progress.current_step;
            if (window.pm?.study_flow) console.log(`%c[INIT] D1 progress ahead of local: bestStep=${bestStep}`, 'color: #58a6ff; font-weight: bold;');
        }
    } catch (e) {
        if (window.pm?.study_flow) console.warn('%c[INIT] D1 progress fetch failed, using local: ' + e.message, 'color: #ff9e64;');
    }

    currentStepIndex = bestStep;
    localStorage.setItem(STUDY_SLUG_KEY, studySlug);
    if (bestStep > 0) {
        isReturningParticipant = true;
        if (window.pm?.study_flow) console.log(`%c[INIT] ② Returning participant → bestStep=${bestStep}`, 'color: #58a6ff; font-weight: bold;');
        localStorage.setItem(PROGRESS_KEY, String(currentStepIndex));

        // Check if config says to restart from beginning
        const rpConfig = studyConfig.experimentalDesign?.returningParticipant;
        if (rpConfig?.defaultBehavior === 'beginning') {
            currentStepIndex = 0;
            isReturningParticipant = false;
            console.log(`🔄 Default behavior: returning to beginning`);
        }
    }
    if (bestStep === 0) {
        if (window.pm?.study_flow) console.log(`%c[INIT] ② New participant (bestStep=0)`, 'color: #58a6ff; font-weight: bold;');
    }
    } // end jumpToStep === null / !isPreview

    // ── Generate participant ID locally (sync — no server call) ──
    // Store ID so runRegistration() sees it and auto-skips.
    // Server init fires non-blocking below.
    if (window.pm?.study_flow) console.log(`%c[INIT] ③ Early registration (sync ID only)`, 'color: #58a6ff; font-weight: bold;');
    if (!getParticipantId() && !isPreview) {
        const regStep = studyConfig.steps.find(s => s.type === 'registration');
        const isAuto = regStep && (regStep.idMethod === 'auto' || regStep.idMethod === 'auto_generate');
        if (isAuto && regStep.skipLogin) {
            const pid = window.__TEST_PARTICIPANT_ID || generateParticipantId(regStep.idPrefix);
            storeParticipantId(pid);
            if (window.pm?.study_flow) console.log(`%c[INIT] ③ Stored ID locally: ${pid}`, 'color: #58a6ff; font-weight: bold;');
        }
    }

    // Init debug flags panel + step nav (sync, fast)
    initStudyFlagsPanel();
    initStepNav();

    // If resuming past registration, show participant ID if config says so
    if (currentStepIndex > 0) {
        const regStep = studyConfig.steps.find(s => s.type === 'registration');
        const pid = getParticipantId();
        if (pid && (!regStep || regStep.showIdCorner !== false)) {
            updateParticipantDisplay(pid);
        }
    }

    // ══ SHOW MODAL NOW — zero awaits between fetchStudyConfig and here ══
    if (window.pm?.study_flow) console.log(`%c[INIT] ④ Starting flow → runCurrentStep(${currentStepIndex})`, 'color: #58a6ff; font-weight: bold;');
    _tLog('preFlow');
    flowActive = true;
    studyStartTime = new Date().toISOString();
    runCurrentStep();

    // ── Everything below is background work — modal is already visible ──

    // Start heavy imports (Three.js) after browser paints the modal
    requestAnimationFrame(() => requestAnimationFrame(() => startHeavyImports()));

    // Server-side participant init (non-blocking)
    const pid = getParticipantId();
    if (pid) {
        initParticipant(pid, studySlug).then(() => {
            _tLog('initParticipant (background)');
            startHeartbeat();
        }).catch(e => console.warn('[INIT] initParticipant failed:', e));
    }

    // Condition assignment + step reordering (non-blocking)
    // Must complete before user reaches analysis steps — they have 2 info modals to click through.
    assignedCondition = loadSavedCondition(studySlug);
    if (assignedCondition) {
        applyConditionOrder(assignedCondition);
        if (window.pm?.study_flow) console.log(`%c[INIT] ⑤ Condition #${assignedCondition.conditionIndex} (saved)`, 'color: #58a6ff; font-weight: bold;');
    } else if (pid) {
        assignConditionPromise = assignCondition().then(cond => {
            if (cond) {
                assignedCondition = cond;
                applyConditionOrder(cond);
                prefetchWaveletAudio();
                if (window.pm?.study_flow) console.log(`%c[INIT] ⑤ Condition #${cond.conditionIndex} (assigned)`, 'color: #58a6ff; font-weight: bold;');
            }
            _tLog('assignCondition (background)');
        }).catch(e => console.warn('[INIT] assignCondition failed:', e));
    }
    if (assignedCondition) {
        prefetchWaveletAudio();
    }

    // Yield for paint, then start heavy preload work
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    if (window.pm?.study_flow) console.log(`%c[INIT] ⑥ Initializing data preload`, 'color: #58a6ff; font-weight: bold;');
    if (currentStepIndex > 0) {
        const currentStep = studyConfig.steps[currentStepIndex];
        if (currentStep?.type === 'analysis' && currentStep.dataPreload) {
            triggerPreloadForStep(currentStepIndex);
        }
    }
    initDataPreload(studyConfig);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYSIS CONFIG — apply config to the audio/spectrogram infrastructure
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Apply analysis step parameters to the global config that main.js reads.
 * Maps config fields (spacecraft, dataset, dates) to the internal format.
 */
function applyAnalysisConfig(step) {
    // Map user-friendly spacecraft names to internal values
    const spacecraftMap = {
        'GOES-16': { spacecraft: 'GOES', dataset: 'DN_MAGN-L2-HIRES_G16' },
        'GOES-17': { spacecraft: 'GOES', dataset: 'DN_MAGN-L2-HIRES_G17' },
        'GOES-18': { spacecraft: 'GOES', dataset: 'DN_MAGN-L2-HIRES_G18' },
        'MMS':     { spacecraft: 'MMS', dataset: 'MMS1_FGM_SRVY_L2' },
        'THEMIS':  { spacecraft: 'THEMIS', dataset: 'THA_L2_FGM' },
        'Van Allen Probes': { spacecraft: 'RBSP', dataset: 'RBSPA_REL04_ECT-HOPE-SCI-L2SA' },
    };

    const mapped = spacecraftMap[step.spacecraft] || { spacecraft: 'GOES', dataset: 'DN_MAGN-L2-HIRES_G16' };

    // Build ISO date strings from config
    const prevConfig = window.__STUDY_CONFIG || window.__EMIC_CONFIG || {};
    const startTime = step.startTime || (step.startDate ? step.startDate + 'T00:00:00.000Z' : null) || prevConfig.startTime;
    const endTime = step.endTime || (step.endDate ? step.endDate + 'T00:00:00.000Z' : null) || prevConfig.endTime;

    // Update global config
    window.__STUDY_CONFIG = {
        spacecraft: mapped.spacecraft,
        dataset: mapped.dataset,
        startTime,
        endTime,
    };

    // Update the hidden select elements so startStreaming() reads the right values
    const scSelect = document.getElementById('spacecraft');
    const dtSelect = document.getElementById('dataType');
    if (scSelect) {
        scSelect.innerHTML = `<option value="${mapped.spacecraft}" selected>${step.spacecraft || mapped.spacecraft}</option>`;
    }
    if (dtSelect) {
        dtSelect.innerHTML = `<option value="${mapped.dataset}" selected>${mapped.dataset}</option>`;
    }

    // Set data source (cdaweb vs cloudflare) so streaming.js uses the right fetch path
    const dataSourceEl = document.getElementById('dataSource');
    if (dataSourceEl) {
        const srcValue = (step.dataSource || '').toLowerCase();
        if (srcValue.includes('cdaweb') || srcValue === 'cdaweb') {
            dataSourceEl.value = 'cdaweb';
        } else {
            dataSourceEl.value = 'cloudflare';
        }
        // streaming.js reads this select when startStreaming() is called,
        // and shows "Fetching {spacecraft} {dataset} from CDAWeb/Cloudflare..." in the status bar
        if (window.pm?.study_flow) console.log(`📋 Data source set to: ${dataSourceEl.value}`);
    }

    // Set display-on-load from step config (overrides any local setting)
    if (step.displayOnLoad) {
        localStorage.setItem('emic_display_on_load', step.displayOnLoad);
        const displayEl = document.getElementById('displayOnLoad');
        if (displayEl) displayEl.value = step.displayOnLoad;
    }
    if (step.initialHours) {
        localStorage.setItem('emic_initial_hours', String(step.initialHours));
        const hoursEl = document.getElementById('initialHours');
        if (hoursEl) hoursEl.value = String(step.initialHours);
    }

    // Populate date/time form fields so startStreaming() can read them
    if (startTime) {
        const st = new Date(startTime);
        const sdEl = document.getElementById('startDate');
        const stEl = document.getElementById('startTime');
        if (sdEl) sdEl.value = st.toISOString().slice(0, 10);
        if (stEl) stEl.value = st.toISOString().slice(11, 23).replace(/\.0+$/, '');
    }
    if (endTime) {
        const et = new Date(endTime);
        const edEl = document.getElementById('endDate');
        const etEl = document.getElementById('endTime');
        if (edEl) edEl.value = et.toISOString().slice(0, 10);
        if (etEl) etEl.value = et.toISOString().slice(11, 23).replace(/\.0+$/, '');
    }

    // Apply de-trend setting from study config
    const detrend = studyConfig?.experimentalDesign?.detrend;
    if (detrend !== undefined) {
        const detrendCheckbox = document.getElementById('removeDCOffset');
        if (detrendCheckbox) {
            detrendCheckbox.checked = !!detrend;
            if (window.pm?.study_flow) console.log(`📋 De-trend set to: ${!!detrend}`);
        }
    }

    if (window.pm?.study_flow) console.log(`📋 Analysis config applied: ${mapped.spacecraft} / ${mapped.dataset} / ${startTime} → ${endTime} / display=${step.displayOnLoad || 'all'}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// REUSABLE MODAL — crossfade between consecutive modal steps
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check whether the NEXT step is also a modal-type step.
 */
function isNextStepModal() {
    const next = studyConfig.steps[currentStepIndex + 1];
    if (!next) return false;
    return next.type === 'modal' || next.type === 'registration' || next.type === 'question';
}

/**
 * Ensure a single persistent modal container exists on the overlay.
 */
function ensureStudyModal() {
    if (studyModalEl && document.contains(studyModalEl)) return;
    // Remove the HTML loading splash (if present)
    const splash = document.getElementById('studyLoadingSplash');
    if (splash) splash.remove();
    studyModalEl = document.createElement('div');
    studyModalEl.id = 'studyModal';
    studyModalEl.className = 'modal-window';
    studyModalEl.style.display = 'none';
    studyModalInner = document.createElement('div');
    studyModalInner.style.transition = 'opacity 0.2s ease';
    studyModalInner.style.opacity = '1';
    studyModalInner.style.width = '100%';
    studyModalInner.style.display = 'flex';
    studyModalInner.style.justifyContent = 'center';
    studyModalInner.style.alignItems = 'center';
    studyModalEl.appendChild(studyModalInner);
    const overlay = document.getElementById('permanentOverlay') || document.body;
    overlay.appendChild(studyModalEl);
}

/**
 * Swap modal content with crossfade. First content appears instantly;
 * subsequent swaps fade out (0.2s) → swap innerHTML → fade in (0.2s).
 */
function setStudyModalContent(html) {
    return new Promise((resolve) => {
        ensureStudyModal();
        const hadContent = studyModalInner.innerHTML.trim().length > 0;
        if (!hadContent) {
            studyModalInner.innerHTML = html;
            studyModalInner.style.opacity = '1';
            resolve();
            return;
        }
        // Crossfade: fade out → swap → fade in
        studyModalInner.style.opacity = '0';
        let resolved = false;
        const done = () => { if (!resolved) { resolved = true; resolve(); } };
        const onFadeOut = () => {
            studyModalInner.innerHTML = html;
            void studyModalInner.offsetHeight;
            studyModalInner.style.opacity = '1';
            studyModalInner.addEventListener('transitionend', done, { once: true });
            setTimeout(done, 280);
        };
        studyModalInner.addEventListener('transitionend', onFadeOut, { once: true });
        setTimeout(() => { if (studyModalInner.style.opacity === '0') onFadeOut(); }, 280);
    });
}

/**
 * Open the study modal via modalManager if not already open.
 * Also ensures the overlay is visible.
 */
function openStudyModalIfNeeded() {
    const overlay = document.getElementById('permanentOverlay');
    if (overlay) { overlay.style.display = 'flex'; overlay.style.opacity = '1'; overlay.style.transition = ''; }
    if (window.pm?.study_flow) console.log(`📋 openStudyModal: overlay=${overlay ? 'found' : 'MISSING'}, currentModal=${modalManager.currentModal}, studyModalEl=${studyModalEl ? 'exists' : 'MISSING'}, studyModalEl.id=${studyModalEl?.id}`);
    if (modalManager.currentModal === 'studyModal') {
        if (window.pm?.study_flow) console.log('📋 openStudyModal: already open, skipping');
        return;
    }
    // Show modal — fade in on first appearance, instant on subsequent
    if (studyModalEl) {
        const isFirstShow = !studyModalEl.dataset.hasShown;
        if (isFirstShow) {
            // Instant show — no CSS transition. Heavy prefetch work (de-trend, GPU compute)
            // can block the main thread and freeze CSS transitions mid-animation.
            studyModalEl.style.transition = 'none';
            studyModalEl.style.opacity = '1';
            studyModalEl.style.display = 'flex';
            studyModalEl.dataset.hasShown = '1';
        } else {
            studyModalEl.style.transition = 'none';
            studyModalEl.style.opacity = '1';
            studyModalEl.style.display = 'flex';
        }
        studyModalEl.classList.add('modal-visible');
    }
    modalManager.currentModal = 'studyModal';
    modalManager.disableBackgroundScroll();
    if (window.pm?.study_flow) console.log('📋 openStudyModal: forced visible with fade, set currentModal=studyModal');
}

/**
 * Tear down the study modal (reset content and modalManager state).
 */
function teardownStudyModal() {
    if (!studyModalEl) return;
    studyModalEl.style.display = 'none';
    studyModalEl.classList.remove('modal-visible');
    studyModalInner.innerHTML = '';
    if (modalManager.currentModal === 'studyModal') {
        modalManager.currentModal = null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP RUNNER
// ═══════════════════════════════════════════════════════════════════════════════

function saveProgress() {
    if (window.__PREVIEW_MODE) return; // Don't persist progress in preview mode
    localStorage.setItem(PROGRESS_KEY, String(currentStepIndex));
    // Fire-and-forget sync to D1
    import('./d1-sync.js').then(({ syncStep }) => syncStep(currentStepIndex));
}

function advanceStep() {
    setStepFlag(currentStepIndex); // Mark completing step as done
    currentStepIndex++;
    saveProgress();
    // Update preview banner step counter
    const banner = document.getElementById('previewBanner');
    if (banner && window.__PREVIEW_MODE) {
        banner.textContent = `🔍 Preview Mode Step ${currentStepIndex + 1}`;
    }
    if (currentStepIndex >= studyConfig.steps.length) {
        teardownStudyModal();
        onStudyComplete();
        return;
    }
    // If leaving modal sequence for analysis, let runAnalysis fade overlay
    // (modal content fades with it). Just clear modalManager state.
    const nextStep = studyConfig.steps[currentStepIndex];
    if (nextStep.type === 'analysis') {
        if (studyModalEl) modalManager.currentModal = null;
    } else if (nextStep.type !== 'modal' && nextStep.type !== 'registration' && nextStep.type !== 'question' && nextStep.type !== 'info') {
        teardownStudyModal();
    }
    runCurrentStep();
}

// ── Admin Step Navigation ───────────────────────────────────────────────────

function initStepNav() {
    // Show only in admin/test/preview mode
    const isAdmin = document.documentElement.hasAttribute('data-admin')
        || window.__PREVIEW_MODE || window.__TEST_MODE;
    if (!isAdmin) return;

    // Remove the old bottom-bar nav if present
    const oldGroup = document.getElementById('stepNavGroup');
    if (oldGroup) oldGroup.style.display = 'none';

    // Insert into top header bar's left spacer (mirrors participant ID on the right)
    const headerBar = document.querySelector('.top-header-bar');
    if (!headerBar) return;
    const leftSpacer = headerBar.firstElementChild;
    if (!leftSpacer) return;

    const nav = document.createElement('div');
    nav.id = 'floatingStepNav';
    nav.style.cssText = 'display:flex;align-items:center;gap:4px;font-family:system-ui;font-size:11px;max-width:320px;animation:adminFadeIn 0.6s ease;';

    const btnStyle = 'background:rgba(33,150,243,0.7);color:#fff;border:none;border-radius:4px;padding:2px 7px;font-size:11px;cursor:pointer;backdrop-filter:blur(4px);flex-shrink:0;';
    nav.innerHTML = `
        <button id="floatStepBack" style="${btnStyle}" title="Previous step">◀</button>
        <span id="floatStepLabel" style="color:#fff;background:rgba(33,150,243,0.55);padding:2px 8px;border-radius:4px;backdrop-filter:blur(4px);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;"></span>
        <button id="floatStepFwd" style="${btnStyle}" title="Next step">▶</button>
    `;
    leftSpacer.appendChild(nav);

    // Remove the old preview banner if present (step nav replaces it)
    const oldBanner = document.getElementById('previewBanner');
    if (oldBanner) oldBanner.remove();

    document.getElementById('floatStepBack').addEventListener('click', (e) => {
        e.currentTarget.blur();
        if (currentStepIndex > 0) goToStep(currentStepIndex - 1);
    });
    document.getElementById('floatStepFwd').addEventListener('click', (e) => {
        e.currentTarget.blur();
        if (studyConfig && currentStepIndex < studyConfig.steps.length - 1) goToStep(currentStepIndex + 1);
    });
}

function updateStepIndicator() {
    const label = document.getElementById('floatStepLabel') || document.getElementById('stepIndicator');
    if (!label || !studyConfig) return;
    const step = studyConfig.steps[currentStepIndex];
    const stepName = step?.title || step?.type || '';
    const prefix = window.__PREVIEW_MODE ? '🔍 Preview ' : '';
    label.textContent = `${prefix}Step ${currentStepIndex + 1}/${studyConfig.steps.length}: ${stepName}`;

    // Also update old banner if it still exists
    const banner = document.getElementById('previewBanner');
    if (banner) banner.style.display = 'none';
}

function goToStep(index) {
    if (!studyConfig || index < 0 || index >= studyConfig.steps.length) return;
    teardownStudyModal();
    currentStepIndex = index;
    saveProgress();
    runCurrentStep();
}

async function runCurrentStep() {
    if (!flowActive || currentStepIndex >= studyConfig.steps.length) return;
    updateStepIndicator();

    const step = studyConfig.steps[currentStepIndex];
    if (window.pm?.study_flow) console.log(`📋 Step ${currentStepIndex}: ${step.type}${step.contentType ? ' (' + step.contentType + ')' : ''}`);

    // Clear returning flag for non-analysis steps (welcome-back only applies to analysis)
    if (isReturningParticipant && step.type !== 'analysis') {
        isReturningParticipant = false;
    }

    // Check if entering this step should trigger a preload for another step
    if (window.__PRELOAD_TRIGGERS && window.__PRELOAD_TRIGGERS[currentStepIndex] !== undefined) {
        const analysisStepIndex = window.__PRELOAD_TRIGGERS[currentStepIndex];
        if (window.pm?.data) console.log(`📦 [PRELOAD] Step ${currentStepIndex} is a preload trigger → starting preload for analysis step ${analysisStepIndex}`);
        triggerPreloadForStep(analysisStepIndex);
    }

    switch (step.type) {
        case 'registration':
            await runRegistration(step);
            break;
        case 'modal':
            if (step.contentType === 'questions') {
                await runQuestionnaire(step);
            } else {
                await runInfoModal(step);
            }
            break;
        case 'info':
            await runInfoModal(step);
            break;
        case 'question':
            await runQuestionnaire(step);
            break;
        case 'analysis':
            // Show welcome-back modal for returning participants
            if (isReturningParticipant) {
                // HS25: Pre-render tiles while welcome-back modal is showing (fire-and-forget)
                if (studyConfig?.experimentalDesign?.preRenderPyramid) {
                    triggerPreloadForStep(currentStepIndex);
                }
                const rpConfig = studyConfig.experimentalDesign?.returningParticipant;
                if (rpConfig) {
                    const priorAnalysisCount = studyConfig.steps
                        .slice(0, currentStepIndex)
                        .filter(s => s.type === 'analysis').length;
                    const modalConfig = priorAnalysisCount === 0 ? rpConfig.analysis1 : rpConfig.analysis2;
                    if (modalConfig?.bodyHtml) {
                        await showWelcomeBackModal(modalConfig);
                    }
                }
                isReturningParticipant = false;
            }
            await runAnalysis(step);
            break;
        default:
            console.warn(`📋 Unknown step type: ${step.type}, skipping`);
            advanceStep();
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGISTRATION STEP
// ═══════════════════════════════════════════════════════════════════════════════

async function runRegistration(step) {
    // Check if already registered — skip without showing overlay
    const existingId = getParticipantId();
    if (window.pm?.study_flow) console.log(`📋 [REG] existingId=${existingId}, idMethod=${step.idMethod}, step=`, step);
    if (existingId) {
        if (window.pm?.study_flow) console.log(`📋 Already registered as ${existingId}, skipping registration`);
        startHeartbeat();
        if (step.showIdCorner !== false) updateParticipantDisplay(existingId);
        else hideParticipantDisplay();
        advanceStep();
        return;
    }

    // Show overlay only when we actually need the registration modal
    const overlay = document.getElementById('permanentOverlay');
    if (window.pm?.study_flow) console.log(`📋 [REG] showing overlay: ${overlay ? 'found' : 'MISSING'}`);
    if (overlay) { overlay.style.display = 'flex'; overlay.style.opacity = '1'; }

    const isAuto = step.idMethod === 'auto' || step.idMethod === 'auto_generate';

    if (isAuto && step.skipLogin) {
        // Auto-generate and skip login screen entirely
        // Early registration in init() already handled this for most cases.
        // Use existing TEST_ ID if available, then check localStorage, then generate new.
        const pid = window.__TEST_PARTICIPANT_ID || getParticipantId() || generateParticipantId(step.idPrefix);
        storeParticipantId(pid);
        if (step.showIdCorner !== false) updateParticipantDisplay(pid);
        else hideParticipantDisplay();
        await initParticipant(pid, studySlug);
        startHeartbeat();
        if (window.pm?.study_flow) console.log(`📋 Auto-registered (skip login): ${pid}`);
        if (!assignedCondition) {
            assignedCondition = await assignCondition();
            if (assignedCondition) {
                applyConditionOrder(assignedCondition);
                prefetchWaveletAudio();
            }
        }
        advanceStep();
    } else {
        // Show login modal — auto-generate pre-fills the ID, manual lets user type
        await showLoginModal(step);
    }

    // Apply ID corner visibility
    if (step.showIdCorner === false) hideParticipantDisplay();
}

function showLoginModal(step) {
    return new Promise(async (resolve) => {
        const bodyHtml = step.regBodyHtml || '<p style="margin-bottom: 10px; color: #550000; font-size: 16px; font-weight: bold;">Enter a user name to begin:</p>';
        const html = renderRegistrationModal({ step, bodyHtml });

        await setStudyModalContent(html);
        openStudyModalIfNeeded();

        const input = studyModalInner.querySelector('#studyLoginInput');
        const submitBtn = studyModalInner.querySelector('#studyLoginSubmit');

        // In preview mode, pre-fill with preview ID and add hint
        if (window.__PREVIEW_MODE && window.__PREVIEW_PARTICIPANT_ID && input) {
            input.value = window.__PREVIEW_PARTICIPANT_ID;
            submitBtn.disabled = false;
            const hint = document.createElement('div');
            hint.style.cssText = 'font-size:11px; color:#888; margin-top:6px; font-style:italic;';
            hint.textContent = 'Preview mode — names starting with "Preview_" won\'t save data';
            input.parentElement.after(hint);
        }

        // In test mode, pre-fill with test ID and add hint
        if (window.__TEST_MODE && window.__TEST_PARTICIPANT_ID && input) {
            input.value = window.__TEST_PARTICIPANT_ID;
            submitBtn.disabled = false;
            const hint = document.createElement('div');
            hint.style.cssText = 'font-size:11px; color:#e65100; margin-top:6px; font-style:italic;';
            hint.textContent = 'Test mode — data will be saved but flagged as test (TEST_ prefix)';
            input.parentElement.after(hint);
        }

        // Auto-generate mode (but not skipping login): pre-fill with generated ID
        const isAuto = step.idMethod === 'auto' || step.idMethod === 'auto_generate';
        if (isAuto && !window.__PREVIEW_MODE && !window.__TEST_MODE && input) {
            const autoId = generateParticipantId(step.idPrefix);
            input.value = autoId;
            submitBtn.disabled = false;
            input.readOnly = true;
            input.style.opacity = '0.7';
            input.style.cursor = 'default';
        }

        input?.addEventListener('input', () => {
            submitBtn.disabled = !input.value.trim();
        });

        const doSubmit = async () => {
            const pid = input.value.trim();
            if (!pid) return;
            storeParticipantId(pid);
            if (step.showIdCorner !== false) updateParticipantDisplay(pid);
            else hideParticipantDisplay();
            initParticipant(pid, studySlug);
            startHeartbeat();
            if (window.pm?.study_flow) console.log(`📋 Registered: ${pid}`);
            // Assign condition after manual registration
            if (!assignedCondition) {
                assignedCondition = await assignCondition();
                if (assignedCondition) {
                    applyConditionOrder(assignedCondition);
                    prefetchWaveletAudio();
                }
            }
            resolve();
            advanceStep();
        };

        submitBtn?.addEventListener('click', doSubmit);
        input?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !submitBtn.disabled) doSubmit();
        });
        input?.focus();
    });
}

function updateParticipantDisplay(pid) {
    const el = document.getElementById('participantIdValue');
    if (el) el.textContent = pid;
    const container = document.getElementById('participantIdDisplay');
    if (container) {
        container.classList.add('sf-pid-visible');
        container.style.removeProperty('display');
    }
}

function hideParticipantDisplay() {
    const container = document.getElementById('participantIdDisplay');
    if (container) container.classList.remove('sf-pid-visible');
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL DIMENSION HELPER
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// INFO MODAL STEP
// ═══════════════════════════════════════════════════════════════════════════════

/** Re-render an info modal in place (no crossfade) for live preview updates */
function rerenderInfoModal(step) {
    if (!studyModalInner) return;
    const dimStyle = buildDimensionStyle(step, '560px');
    const ulStyle = buildHeaderUnderlineStyle(step);
    const titleFont = buildTitleFontStyle(step);
    const bodyColor = step.bodyFontColor || '#333';
    const bodySize = step.bodyFontSize || '18px';
    const bodyWeight = step.bodyFontBold ? 'font-weight:700;' : '';

    const content = studyModalInner.querySelector('.modal-content');
    if (content) {
        content.style.cssText = `${dimStyle} text-align: center;`;
        const header = content.querySelector('.modal-header');
        if (header) header.style.cssText = ulStyle;
        const title = content.querySelector('.modal-title');
        if (title) { title.style.cssText = titleFont; title.textContent = step.title || ''; }
        const bodyDiv = content.querySelector('.modal-body > div');
        if (bodyDiv) {
            bodyDiv.style.cssText = `color: ${bodyColor}; font-size: ${bodySize}; line-height: 1.6; text-align: left; margin-bottom: 20px; ${bodyWeight}`;
            bodyDiv.innerHTML = styleBodyHtml(step.bodyHtml, `color:${bodyColor};font-size:${bodySize};line-height:1.6;margin:0;${bodyWeight}`);
        }
        const btn = content.querySelector('.modal-submit');
        if (btn) btn.textContent = step.dismissLabel || 'OK';
    }
}

function runInfoModal(step) {
    return new Promise(async (resolve) => {
        const btnParts = [];
        if (step.dismissColor) btnParts.push(`color:${step.dismissColor}`);
        if (step.dismissBgColor) btnParts.push(`background:${step.dismissBgColor}`);
        if (step.dismissBold) btnParts.push('font-weight:700');
        const html = renderInfoModal({ step, bodyHtml: step.bodyHtml, btnStyle: btnParts.join(';') });

        await setStudyModalContent(html);
        openStudyModalIfNeeded();

        // If no more actionable steps remain, mark study complete now
        // (e.g., a trailing 'launch' step is not a participant action)
        const actionableTypes = new Set(['registration', 'modal', 'info', 'question', 'analysis']);
        const hasMoreWork = studyConfig.steps.slice(currentStepIndex + 1).some(s => actionableTypes.has(s.type));
        if (!hasMoreWork) {
            onStudyComplete();
        }

        const dismiss = () => {
            if (outsideHandler) studyModalEl.removeEventListener('click', outsideHandler);
            if (enterHandler) document.removeEventListener('keydown', enterHandler);
            resolve();
            advanceStep();
        };
        studyModalInner.querySelector('.modal-submit')?.addEventListener('click', dismiss);
        studyModalInner.querySelector('.modal-close')?.addEventListener('click', dismiss);

        // Enter key confirms (default: true)
        let enterHandler = null;
        if (step.enterConfirms !== false) {
            enterHandler = (e) => {
                if (e.key === 'Enter') { e.preventDefault(); dismiss(); }
            };
            document.addEventListener('keydown', enterHandler);
        }

        // Click outside modal content to close (only when closable)
        let outsideHandler = null;
        if (step.closable) {
            outsideHandler = (e) => {
                if (!studyModalInner.querySelector('.modal-content')?.contains(e.target)) dismiss();
            };
            studyModalEl.addEventListener('click', outsideHandler);
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYSIS STEP
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// PROMPT SEQUENCER — config-driven text prompts during analysis
// ═══════════════════════════════════════════════════════════════════════════════

/** Speed name → baseDelay in ms for typeText */
const PROMPT_SPEED_MAP = { slow: 45, medium: 30, fast: 15 };

/**
 * Execute prompts array from an analysis step config.
 * Returns a cleanup function that removes all listeners.
 */
let _promptsPaused = false;
export function pausePrompts() { _promptsPaused = true; cancelTyping(); }
export function resumePrompts() { _promptsPaused = false; }

function executePrompts(prompts) {
    if (!prompts || !prompts.length) return () => {};

    const statusDiv = document.getElementById('status');
    if (!statusDiv) return () => {};

    const cleanups = [];
    let previousPromptDone = null; // resolves when the previous prompt finishes displaying

    function showPrompt(prompt) {
        return new Promise((resolve) => {
            const delayMs = (prompt.delay || 0) * 1000;
            const tryShow = () => {
                if (_promptsPaused) {
                    // Check again in 200ms
                    const retryId = setTimeout(tryShow, 200);
                    cleanups.push(() => clearTimeout(retryId));
                    return;
                }
                cancelTyping();
                if (prompt.effect === 'instant') {
                    statusDiv.textContent = prompt.text;
                    resolve();
                } else {
                    // typed effect
                    const baseDelay = PROMPT_SPEED_MAP[prompt.speed] || PROMPT_SPEED_MAP.medium;
                    const jitter = Math.round(baseDelay / 2);
                    typeText(statusDiv, prompt.text, baseDelay, jitter);
                    // Estimate typing duration to resolve when done
                    const chars = Array.from(prompt.text).length;
                    const estimatedMs = chars * baseDelay + 500;
                    setTimeout(resolve, estimatedMs);
                }
            };
            const tid = setTimeout(tryShow, delayMs);
            cleanups.push(() => clearTimeout(tid));
        });
    }

    // Process each prompt by trigger type
    prompts.forEach((prompt, i) => {
        const trigger = prompt.trigger;

        if (trigger === 'onLoad') {
            const p = showPrompt(prompt);
            previousPromptDone = p;

        } else if (trigger === 'onPlay') {
            // Listen for play button click or audio play event
            const playBtn = document.getElementById('playPauseBtn');
            const handler = () => {
                const p = showPrompt(prompt);
                previousPromptDone = p;
            };
            if (playBtn) {
                playBtn.addEventListener('click', handler, { once: true });
                cleanups.push(() => playBtn.removeEventListener('click', handler));
            }
            // Also listen for audio play events
            const onPlay = () => {
                window.removeEventListener('audioPlay', onPlay);
                handler();
            };
            window.addEventListener('audioPlay', onPlay);
            cleanups.push(() => window.removeEventListener('audioPlay', onPlay));

        } else if (trigger === 'onFeatureDraw') {
            let firedOnce = false;
            const handler = () => {
                if (prompt.frequency !== 'always' && firedOnce) return;
                firedOnce = true;
                // Interrupt any in-progress prompt — assert immediately
                cancelTyping();
                const p = showPrompt(prompt);
                previousPromptDone = p;
            };
            window.addEventListener('featureCreated', handler);
            cleanups.push(() => window.removeEventListener('featureCreated', handler));

        } else if (trigger === 'afterPrevious') {
            // Chain after the previous prompt finishes
            const prev = previousPromptDone || Promise.resolve();
            const p = prev.then(() => showPrompt(prompt));
            previousPromptDone = p;
        }
    });

    return () => { cleanups.forEach(fn => fn()); cancelTyping(); };
}

async function runAnalysis(step) {
    // Guard: if server-side condition assignment is in flight, wait for it
    // (only exists when a live/test session actually requested an assignment)
    if (assignConditionPromise && !assignedCondition) {
        if (window.pm?.study_flow) console.log(`%c[ANALYSIS] ⏳ Waiting for condition assignment...`, 'color: #f59e0b; font-weight: bold;');
        await assignConditionPromise;
    }

    // Abort any previous analysis step's listeners (prevents double-fire on admin skip-back)
    if (analysisAbort) analysisAbort.abort();
    analysisAbort = new AbortController();
    const signal = analysisAbort.signal;

    // Determine which analysis session this is (1 or 2)
    const analysisIndices = [];
    studyConfig.steps.forEach((s, i) => { if (s.type === 'analysis') analysisIndices.push(i); });
    const analysisSession = analysisIndices.indexOf(currentStepIndex) + 1; // 1-based
    window.__currentAnalysisSession = analysisSession;
    if (window.pm?.study_flow) console.log(`📋 Analysis step: entering drawing phase (session ${analysisSession})`);

    // Tell feature tracker which section we're in — button uses per-section feature count
    await getHeavy();
    _ft.setCurrentSection(analysisSession);

    // Apply this step's analysis config (spacecraft, dates, display settings)
    applyAnalysisConfig(step);

    // Reset audio position to start of new section (prevents stale position from previous section
    // bleeding into engageStretch, which reads State.currentAudioPosition)
    const { setCurrentAudioPosition } = await import('./audio-state.js');
    setCurrentAudioPosition(0);

    // Set condition-assigned processing algorithm (stretch) — just set the preference,
    // don't engage yet. Data loading will rebuild the worklet (destroying any active stretch
    // node), and the post-load updatePlaybackSpeed() will engage with the freshly-primed node.
    // No condition assigned (no active session, preview mode, etc.) — default to resample
    // so audio isn't 4400x too fast (raw 10Hz data played at 44100Hz)
    if (!step._assignedProcessing) {
        step._assignedProcessing = 'resample';
        console.log('🧪 No condition assigned — defaulting to resample processing');
    }
    if (step._assignedProcessing) {
        const mapped = PROCESSING_MAP[step._assignedProcessing];
        if (mapped) {
            const { setStretchAlgorithm, setWaveletPreRendered } = await import('./audio-state.js');
            setStretchAlgorithm(mapped);
            if (window.pm?.study_flow) console.log(`🧪 Applied processing: ${step._assignedProcessing} → ${mapped}`);

            // Show processing mode label on localhost
            if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
                const label = document.getElementById('processingModeLabel');
                if (label) {
                    label.textContent = step._assignedProcessing;
                    label.style.display = '';
                }
            }

            // Pre-rendered wavelet: load samples into wavelet worklet (bypass GPU CWT)
            if (step._assignedProcessing === 'wavelet') {
                const waveletMap = getWaveletMap();
                const startDate = (step.startTime || step.startDate || '').slice(0, 10);
                const filename = waveletMap[startDate];
                if (filename) {
                    const bakedSpeed = getWaveletSpeed();
                    // Await the cached promise (may already be resolved from prefetch)
                    const samples = await fetchWaveletAudio(startDate, filename);
                    if (samples) {
                        setWaveletPreRendered(true);
                        window.__waveletPreRendered = { samples, speed: bakedSpeed };
                        console.log(`%c🎵 [WAVELET] Pre-rendered audio ready (${samples.length} samples, ${bakedSpeed}× speed)`, 'color: #E040FB; font-weight: bold;');
                    }
                }
            } else {
                setWaveletPreRendered(false);
                window.__waveletPreRendered = null;
            }
        }
    }

    // Apply playback speed from step config — just set the slider position, don't call
    // updatePlaybackSpeed() which would trigger engageStretch() with stale section 1 data.
    // The post-load updatePlaybackSpeed() will handle actual engagement after fresh data arrives.
    const rawSpeed = step.playbackSpeed;
    const targetSpeed = parseFloat(String(rawSpeed || '1').replace(/x$/i, '')) || 1.0;
    if (targetSpeed !== 1.0) {
        const { calculateSliderForSpeed } = await import('./audio-player.js');
        const slider = document.getElementById('playbackSpeed');
        if (slider) {
            slider.value = calculateSliderForSpeed(targetSpeed);
            if (window.pm?.audio || window.pm?.init) console.log(`🔊 Setting playback speed to ${targetSpeed}x (slider=${slider.value})`);
        }
    }

    // Apply spectrogram speed bypass if configured
    const lockSpec = studyConfig.experimentalDesign?.lockSpectrogramTo1x;
    if (lockSpec) {
        const { setSpectrogramSpeedBypass } = await import('./audio-state.js');
        setSpectrogramSpeedBypass(true);
        if (window.pm?.study_flow) console.log('🔒 Spectrogram locked to 1× view (speed bypass active)');
    }

    // Save analysis session metadata to D1 (data config for this session)
    const sessionDataset = window.__STUDY_CONFIG?.dataset || null;
    saveResponse(`analysis_session_${analysisSession}`, {
        session: analysisSession,
        spacecraft: step.spacecraft,
        dataset: sessionDataset,
        startDate: step.startDate || step.startTime,
        endDate: step.endDate || step.endTime,
        processing: step._assignedProcessing || null,
        playbackSpeed: targetSpeed,
        stepIndex: currentStepIndex,
        enteredAt: new Date().toISOString(),
    });

    // Clear old axis ticks and canvases immediately so stale dates don't linger
    for (const id of ['minimap-x-axis', 'spectrogram-x-axis']) {
        const c = document.getElementById(id);
        if (c) { const ctx = c.getContext('2d'); if (ctx) ctx.clearRect(0, 0, c.width, c.height); }
    }

    // Show the (i) info button during analysis
    const aboutBtn = document.getElementById('aboutInfoBtn');
    if (aboutBtn) aboutBtn.style.display = '';

    // Apply silent data loading setting from config
    const silentCb = document.getElementById('silentDownload');
    if (silentCb) silentCb.checked = !!step.silentDataLoading;

    const overlay = document.getElementById('permanentOverlay');
    const detrending = !!studyConfig?.experimentalDesign?.detrend;

    // When de-trending is enabled, wait for complete data before presenting.
    // De-trending requires the full signal (forward-backward filter), so we can't
    // render progressively. Show a loading modal if prefetch isn't done yet.
    if (detrending) {
        const { isPreRenderDone } = await import('./main-window-renderer.js');
        const { getPrefetchStatus } = await import('./goes-cloudflare-fetcher.js');
        const cfg = window.__STUDY_CONFIG;

        if (!isPreRenderDone() && cfg) {
            // Show loading modal on the overlay
            if (studyModalInner) {
                const status = getPrefetchStatus(cfg.spacecraft, cfg.dataset, cfg.startTime, cfg.endTime);
                const pct = status?.totalCount ? Math.round((status.completedCount / status.totalCount) * 100) : 0;
                studyModalInner.innerHTML = `
                    <div class="modal-content" style="text-align: center; min-width: 500px; width: auto; max-width: 600px; background: linear-gradient(135deg, rgba(240, 240, 245, 0.97) 0%, rgba(230, 232, 238, 0.97) 100%);">
                        <div style="font-size: 22px; font-weight: 600; color: #444; margin-bottom: 20px;">Preparing analysis data</div>
                        <div style="background: rgba(0,0,0,0.08); border-radius: 8px; height: 28px; overflow: hidden; margin-bottom: 14px;">
                            <div id="preloadBar" style="height: 100%; width: ${pct}%; border-radius: 8px; transition: width 0.3s ease; background: repeating-linear-gradient(-45deg, #4a9eff, #4a9eff 10px, #6bb8ff 10px, #6bb8ff 20px); background-size: 28px 28px; animation: stripeMove 0.6s linear infinite;"></div>
                        </div>
                        <div id="preloadStatus" style="font-size: 15px; color: #444; font-weight: 600;">
                            Loading GOES data from R2 server, Files ${status?.completedCount || 0} of ${status?.totalCount || '?'}...
                        </div>
                    </div>`;
                if (studyModalEl) {
                    studyModalEl.style.display = 'flex';
                    studyModalEl.classList.add('modal-visible');
                }
            }

            // Poll until pre-render (de-trend + tile compute) is complete
            // Timeout after 45s — if GPU context is wedged, no amount of waiting helps
            await new Promise(resolve => {
                const startedAt = Date.now();
                const TIMEOUT_MS = 45000;
                const poll = setInterval(() => {
                    const s = getPrefetchStatus(cfg.spacecraft, cfg.dataset, cfg.startTime, cfg.endTime);
                    const el = document.getElementById('preloadStatus');
                    const bar = document.getElementById('preloadBar');
                    if (el && s) {
                        el.textContent = `Loading GOES data from R2 server, Files ${s.completedCount} of ${s.totalCount}...`;
                        if (bar && s.totalCount) {
                            bar.style.width = `${Math.round((s.completedCount / s.totalCount) * 100)}%`;
                        }
                    }
                    if (isPreRenderDone()) {
                        clearInterval(poll);
                        resolve();
                    } else if (Date.now() - startedAt > TIMEOUT_MS) {
                        clearInterval(poll);
                        console.error('[ANALYSIS] Pre-render timed out after 45s — GPU context may be wedged');
                        if (studyModalInner) {
                            studyModalInner.innerHTML = `
                                <div class="modal-content" style="text-align: center; min-width: 500px; width: auto; max-width: 600px; background: linear-gradient(135deg, rgba(240, 240, 245, 0.97) 0%, rgba(230, 232, 238, 0.97) 100%);">
                                    <div style="font-size: 22px; font-weight: 600; color: #c44; margin-bottom: 16px;">Unable to load analysis</div>
                                    <div style="font-size: 15px; color: #555; line-height: 1.6; margin-bottom: 20px;">
                                        Something went wrong while preparing the display.<br>
                                        Please <strong>close all browser tabs</strong>, then reopen this page.
                                    </div>
                                </div>`;
                        }
                        // Don't resolve — leave the modal up so the participant sees the message
                    }
                }, 250);
            });
            if (window.pm?.data) console.log(`📦 [ANALYSIS] De-trend mode — pre-render complete, presenting`);
        }
    }

    // Hide overlay so the player is visible (study modal fades out with it)
    if (overlay) {
        overlay.style.transition = 'opacity 0.3s ease-out';
        overlay.style.opacity = '0';
        modalManager.currentModal = null;
        setTimeout(() => {
            overlay.style.display = 'none';
            if (studyModalEl) {
                studyModalEl.style.display = 'none';
                studyModalEl.classList.remove('modal-visible');
                if (studyModalInner) studyModalInner.innerHTML = '';
            }
            if (document.activeElement && overlay.contains(document.activeElement)) {
                document.activeElement.blur();
            }
        }, 300);
    }

    // Trigger data fetch/render
    if (typeof window.triggerDataRender === 'function') {
        if (window.pm?.data) console.log(`📦 [ANALYSIS] Data was preloaded — calling triggerDataRender()`);
        window.triggerDataRender();
    } else {
        const startBtn = document.getElementById('startBtn');
        if (startBtn && !startBtn.disabled) {
            if (window.pm?.data) console.log(`📦 [ANALYSIS] No preload — triggering fresh data fetch via startBtn`);
            startBtn.click();
        } else {
            if (window.pm?.data) console.log(`📦 [ANALYSIS] No preload and startBtn not available — data fetch NOT triggered`);
        }
    }
    const renderSelect = document.getElementById('dataRendering');
    if (renderSelect) {
        renderSelect.value = 'progressive';
        renderSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Execute config-driven prompts
    const cleanupPrompts = executePrompts(step.prompts);

    // Show and wire the Complete button (single owner — see controller at top of file)
    initCompleteButton(step);
    const completeBtn = document.getElementById('completeBtn');
    if (completeBtn) {
        const minFeatures = step.minFeatures || 1;

        // Wait for Complete click
        await new Promise((resolve) => {
            completeBtn.addEventListener('click', async () => {
                if (signal.aborted) return;  // stale listener from previous analysis
                if (!completeBtn.classList.contains('ready') && !completeBtnAnim) return;  // not yet enabled
                completeBtn.classList.remove('ready');  // prevent re-entry while awaiting confirmation
                // Close any open feature popup before proceeding
                try {
                    const { closeFeaturePopup } = await import('./spectrogram-renderer.js');
                    closeFeaturePopup();
                } catch (e) { /* not critical */ }
                _ap.pausePlayback();
                // Hide (i) button when leaving analysis
                if (aboutBtn) aboutBtn.style.display = 'none';

                // Save features to D1
                const features = _ft.getStandaloneFeatures();

                // Enforce minimum features at click time
                if (step.requireMinFeatures !== false && features.length < minFeatures) {
                    showPromptOverlay(`Please identify at least ${minFeatures} feature${minFeatures > 1 ? 's' : ''} before proceeding. You have ${features.length} so far.`);
                    return;
                }
                for (const feat of features) {
                    if (window.pm?.features) console.log(`%c[FEATURE] Proceed bulk-save d1Id=${feat.d1Id?.slice(0,8)} notes="${feat.notes}" conf=${feat.confidence}`, 'color: #f0a; font-weight: bold');
                    saveFeature(feat);
                }
                if (window.pm?.d1) console.log(`📋 Saved ${features.length} features to D1`);

                // Confirmation modal if configured
                if (step.confirmCompletion?.enabled) {
                    // Replace # with styled feature count
                    const config = { ...step.confirmCompletion };
                    if (config.message) {
                        const styledCount = `<span style="font-size:1.4em; font-weight:700; color:#550000;">${features.length}</span>`;
                        config.message = config.message.replace(/#/g, styledCount);
                    }
                    const confirmed = await showConfirmationModal(config);
                    if (!confirmed) {
                        // User went back — restore button and wait for another Complete click
                        completeBtn.classList.add('ready');
                        if (aboutBtn) aboutBtn.style.display = '';
                        return;
                    }
                }

                cleanupPrompts();
                resolve();
            });
        });
    }

    // Don't hide the button — modal overlay covers it on non-analysis steps,
    // and initCompleteButton resets it cleanly for the next analysis section.
    completeBtnActive = false;

    // Clean visual slate between sections — black spectrogram, clear minimap/axes/overlays
    import('./main-window-renderer.js').then(({ clearDisplayForSectionTransition }) => {
        clearDisplayForSectionTransition();
    });
    import('./minimap-window-renderer.js').then(({ clearMinimapDisplay }) => {
        clearMinimapDisplay();
    });
    import('./day-markers.js').then(({ clearDayMarkers }) => clearDayMarkers());
    import('./spectrogram-renderer.js').then(({ clearAllCanvasFeatureBoxes }) => clearAllCanvasFeatureBoxes());
    // Clear 2D overlay canvases (playhead, frequency axis)
    for (const id of ['spectrogram-playhead-overlay', 'spectrogram-axis']) {
        const c = document.getElementById(id);
        if (c) { const ctx = c.getContext('2d'); if (ctx) ctx.clearRect(0, 0, c.width, c.height); }
    }

    // HS25: Trigger pre-render for the NEXT analysis section (fire-and-forget).
    // Data is already cached from initial prefetch — compute tiles in background
    // while between-section modals/questionnaires are showing.
    if (studyConfig?.experimentalDesign?.preRenderPyramid) {
        const nextAnalysisIdx = studyConfig.steps.findIndex((s, i) => i > currentStepIndex && s.type === 'analysis');
        if (nextAnalysisIdx !== -1) {
            import('./main-window-renderer.js').then(({ resetPreRender }) => {
                resetPreRender();
                preloadTriggered[nextAnalysisIdx] = false; // allow re-trigger
                triggerPreloadForStep(nextAnalysisIdx);
                console.log(`%c🎨 [HS25] Section complete — queued pre-render for next analysis step ${nextAnalysisIdx}`, 'color: #d29922; font-weight: bold;');
            });
        }
    }

    advanceStep();
}

function showConfirmationModal(config) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.id = 'studyConfirmModal';
        modal.className = 'modal-window';
        modal.style.display = 'none';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 420px; text-align: center;">
                <div class="modal-header">
                    <h3 class="modal-title">${config.title || 'Complete?'}</h3>
                </div>
                <div class="modal-body">
                    <p style="color: #333; margin: 0 0 24px; padding: 16px; font-size: 18px; line-height: 1.5;">
                        ${config.message || 'Are you sure?'}
                    </p>
                    <div style="display: flex; gap: 24px; justify-content: center;">
                        <button type="button" id="studyConfirmNo" class="confirm-btn confirm-btn-back" style="min-width: 120px;">${config.cancelLabel || 'Go back'}</button>
                        <button type="button" id="studyConfirmYes" class="confirm-btn confirm-btn-proceed" style="min-width: 140px;">${config.confirmLabel || 'Yes'}</button>
                    </div>
                </div>
            </div>
        `;

        const overlay = document.getElementById('permanentOverlay') || document.body;
        if (overlay) { overlay.style.display = 'flex'; overlay.style.opacity = '1'; overlay.style.transition = ''; }
        overlay.appendChild(modal);

        // Attach listeners BEFORE openModal — buttons are in the DOM, no race condition
        document.getElementById('studyConfirmYes')?.addEventListener('click', async () => {
            await modalManager.closeModal('studyConfirmModal', { keepOverlay: true });
            modal.remove();
            modalManager.currentModal = null;
            // Seed studyModalInner with placeholder so setStudyModalContent
            // takes the crossfade path (fade out → swap → fade in)
            ensureStudyModal();
            if (studyModalInner) {
                studyModalInner.innerHTML = '<div>&nbsp;</div>';
                studyModalInner.style.opacity = '1';
            }
            // Show studyModal instantly — the inner crossfade handles animation
            openStudyModalIfNeeded();
            resolve(true);
        });
        document.getElementById('studyConfirmNo')?.addEventListener('click', async () => {
            await modalManager.closeModal('studyConfirmModal');
            modal.remove();
            if (overlay) { overlay.style.display = 'none'; }
            resolve(false);
        });

        modalManager.openModal('studyConfirmModal', { keepOverlay: true });
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUESTIONNAIRE STEP — renders questions from config with back/next navigation
// ═══════════════════════════════════════════════════════════════════════════════

async function runQuestionnaire(step) {
    // Support both old format (step.questions array) and new flat format (single question at top level)
    let questions = step.questions || [];
    if (!questions.length && step.type === 'question') {
        // Flat question step — wrap into array for the questionnaire loop
        questions = [{
            id: step.id || 'q' + currentStepIndex,
            text: step.title || step.text || '',
            type: step.questionType || 'radio',
            inputName: step.inputName || step.id || 'q' + currentStepIndex,
            subtitle: step.subtitle,
            placeholder: step.placeholder,
            required: step.required,
            options: step.options,
            labelMode: step.labelMode || (step.labelPrefixes === false ? 'hidden' : (step.boldLabelPrefixes === false ? 'visible' : 'bold')),
            scaleLabels: step.scaleLabels,
            rows: step.rows,
            likertBoldRows: step.likertBoldRows,
            likertBoldCols: step.likertBoldCols,
            likertColFontSize: step.likertColFontSize,
            likertColAlign: step.likertColAlign,
            likertRowFontSize: step.likertRowFontSize,
            likertRowAlign: step.likertRowAlign,
            enterConfirms: step.enterConfirms,
        }];
    }
    if (!questions.length) { advanceStep(); return; }

    // Show overlay
    const overlay = document.getElementById('permanentOverlay');
    if (overlay) { overlay.style.display = 'flex'; overlay.style.opacity = '1'; overlay.style.transition = ''; }

    // Saved answers for back navigation
    const answers = {};
    // Freetext drafts — unsaved text preserved across back navigation
    if (!window._freetextDrafts) window._freetextDrafts = {};

    // Restore any previously saved answers
    for (const q of questions) {
        const saved = localStorage.getItem(`study_answer_${studySlug}_${q.id}`);
        if (saved) {
            try { answers[q.id] = JSON.parse(saved); } catch { /* ignore */ }
        }
    }

    // Detect chained question steps: consecutive 'question' type steps form a chain.
    // When in a chain, show "Question X of Y" relative to the chain, not the global step list.
    let chainOffset = 0;
    let chainTotal = questions.length;
    if (step.type === 'question' && questions.length === 1) {
        // Find the start and end of the consecutive question-step chain
        const steps = studyConfig.steps;
        let chainStart = currentStepIndex;
        while (chainStart > 0 && steps[chainStart - 1].type === 'question') chainStart--;
        let chainEnd = currentStepIndex;
        while (chainEnd < steps.length - 1 && steps[chainEnd + 1].type === 'question') chainEnd++;
        chainTotal = chainEnd - chainStart + 1;
        chainOffset = currentStepIndex - chainStart;
    }

    let qi = 0;

    while (qi < questions.length && flowActive) {
        const q = questions[qi];
        const displayIndex = chainOffset + qi;
        const displayTotal = chainTotal;
        const progress = ((displayIndex + 1) / displayTotal * 100).toFixed(0);

        const canGoBack = step.canGoBack !== false;
        // Show back button if canGoBack and not the first question in the chain
        // For flat question steps (1 question each), chainOffset > 0 means we're past the first in the chain
        const showBack = canGoBack && (qi > 0 || chainOffset > 0);
        const prevAnswer = answers[q.id] ?? window._freetextDrafts[q.id] ?? undefined;
        const result = await showQuestionModal(q, displayIndex, displayTotal, progress, prevAnswer, showBack, step);

        if (result === '__BACK__') {
            if (qi > 0) {
                // Back within this step's questions array
                qi = Math.max(0, qi - 1);
                continue;
            } else if (chainOffset > 0) {
                // Back to previous step — decrement currentStepIndex and re-run
                currentStepIndex--;
                saveProgress();
                const banner = document.getElementById('previewBanner');
                if (banner && window.__PREVIEW_MODE) {
                    banner.textContent = `🔍 Preview Mode Step ${currentStepIndex + 1}`;
                }
                runCurrentStep();
                return; // Exit this runQuestionnaire — previous step will handle itself
            }
            continue;
        }

        // Save answer + clear draft
        answers[q.id] = result;
        delete window._freetextDrafts[q.id];
        localStorage.setItem(`study_answer_${studySlug}_${q.id}`, JSON.stringify(result));

        // Save to D1
        const surveyType = isPreAnalysis() ? 'pre' : 'post';
        saveSurveyAnswer(q.id, result, surveyType, q.text, q.type);

        qi++;
    }

    advanceStep();
}

/**
 * Determine if current position is before the analysis step (pre-survey) or after (post-survey).
 */
function isPreAnalysis() {
    const analysisIndex = studyConfig.steps.findIndex(s => s.type === 'analysis');
    return currentStepIndex < analysisIndex;
}

/**
 * Show a single question modal. Returns the answer value, or '__BACK__' if back was pressed.
 */
function showQuestionModal(question, index, total, progressPct, previousAnswer, showBack, stepDimensions) {
    return new Promise(async (resolve) => {
        // Pass modalTitle from step config as question.title for the modal header
        if (stepDimensions?.modalTitle && !question.title) {
            question = { ...question, title: stepDimensions.modalTitle };
        }
        const html = renderQuestionModal({
            question, index, total, progressPct, previousAnswer, showBack,
            dims: stepDimensions
        });

        await setStudyModalContent(html);
        openStudyModalIfNeeded();

        const nextBtn = studyModalInner.querySelector('.modal-next');
        const backBtn = studyModalInner.querySelector('.modal-back');

        const qType = question.type || question.questionType || 'radio';
        const qName = question.inputName || question.id || 'q';

        if (qType === 'likert') {
            const totalRows = (question.rows || []).length;
            const allRadios = studyModalInner.querySelectorAll(`input[type="radio"][name^="sq_${qName}_row"]`);
            allRadios.forEach(radio => {
                radio.addEventListener('change', () => {
                    const filled = new Set();
                    allRadios.forEach(r => { if (r.checked) filled.add(r.name); });
                    nextBtn.disabled = filled.size < totalRows;
                });
            });
        } else if (qType === 'radio') {
            studyModalInner.querySelectorAll(`input[name="sq_${qName}"]`).forEach(radio => {
                radio.addEventListener('change', () => { nextBtn.disabled = false; });
            });
        } else if (question.required !== false) {
            const textarea = studyModalInner.querySelector('textarea');
            if (textarea) {
                textarea.addEventListener('input', () => {
                    nextBtn.disabled = !textarea.value.trim();
                });
            }
        }

        // Enter confirms for freetext questions (study builder toggle, default ON)
        if (qType === 'freetext' && question.enterConfirms !== false) {
            const textarea = studyModalInner.querySelector('textarea');
            if (textarea) {
                textarea.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        if (!nextBtn.disabled) nextBtn.click();
                    }
                });
            }
        }

        nextBtn?.addEventListener('click', () => {
            let answer;
            if (qType === 'likert') {
                answer = {};
                (question.rows || []).forEach((rowLabel, i) => {
                    const checked = studyModalInner.querySelector(`input[name="sq_${qName}_row${i}"]:checked`);
                    answer[rowLabel] = checked?.value || '';
                });
            } else if (qType === 'radio') {
                const checked = studyModalInner.querySelector(`input[name="sq_${qName}"]:checked`);
                const rawValue = checked?.value || '';
                const opt = (question.options || []).find(o => String(o.value) === rawValue);
                answer = opt?.label ? { value: rawValue, label: opt.label } : rawValue;
            } else {
                answer = studyModalInner.querySelector('textarea')?.value?.trim() || '';
            }
            resolve(answer);
        });

        backBtn?.addEventListener('click', () => {
            // Stash freetext draft so it restores when navigating back
            if (qType === 'freetext') {
                const textarea = studyModalInner.querySelector('textarea');
                if (textarea && textarea.value.trim()) {
                    window._freetextDrafts[question.id] = textarea.value;
                }
            }
            resolve('__BACK__');
        });
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// STUDY COMPLETE
// ═══════════════════════════════════════════════════════════════════════════════

let _studyCompleted = false;
function onStudyComplete() {
    if (_studyCompleted) return; // idempotent — may fire from final info modal + advanceStep
    _studyCompleted = true;
    if (window.pm?.study_flow) console.log(`📋 Study complete!`);
    stopHeartbeat();
    markComplete();

    // Clear progress and step flags
    localStorage.removeItem(PROGRESS_KEY);
    localStorage.removeItem(STUDY_SLUG_KEY);
    clearAllStepFlags();

    // Clean up saved answers
    if (studyConfig?.steps) {
        for (const step of studyConfig.steps) {
            if (step.contentType === 'questions' && step.questions) {
                for (const q of step.questions) {
                    localStorage.removeItem(`study_answer_${studySlug}_${q.id}`);
                }
            } else if (step.type === 'question' && step.id) {
                localStorage.removeItem(`study_answer_${studySlug}_${step.id}`);
            }
        }
    }

    flowActive = false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR DISPLAY
// ═══════════════════════════════════════════════════════════════════════════════

function showError(message) {
    const titleEl = document.getElementById('studyTitle');
    if (titleEl) titleEl.textContent = 'Study Not Found';

    const overlay = document.getElementById('permanentOverlay');
    if (overlay) {
        overlay.style.display = 'flex';
        overlay.style.opacity = '1';
        overlay.innerHTML = `
            <div style="text-align: center; color: #fff; max-width: 500px; padding: 40px;">
                <h2 style="margin-bottom: 16px;">⚠️ ${message}</h2>
                <p style="color: #aaa; font-size: 16px;">Check the URL and try again.</p>
            </div>
        `;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-INIT
// ═══════════════════════════════════════════════════════════════════════════════

// Expose flag API for debug panel
window.__studyFlags = {
    getStates: getStepFlagStates,
    set: setStepFlag,
    clear: clearStepFlag,
    clearAll: clearAllStepFlags,
    get: getStepFlag
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 100));
} else {
    setTimeout(init, 100);
}
