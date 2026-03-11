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

import { fetchStudyConfig, setStudyId, initParticipant, saveSurveyAnswer, saveFeature, saveResponse, markComplete, getParticipantId as d1GetParticipantId } from './d1-sync.js';
import { modalManager } from './modal-manager.js';
import { getStandaloneFeatures } from './feature-tracker.js';
import { getParticipantId, storeParticipantId, generateParticipantId } from './participant-id.js';
import { styleBodyHtml } from './study-builder/utils.js';
import { pausePlayback } from './audio-player.js';
import { typeText, cancelTyping } from './tutorial-effects.js';

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let studyConfig = null;     // Full config from D1
let currentStepIndex = 0;   // Current position in config.steps[]
let studySlug = null;       // e.g. "emic-pilot"
let studyStartTime = null;
let flowActive = false;

// localStorage keys for progress persistence
const PROGRESS_KEY = 'study_flow_step';
const STUDY_SLUG_KEY = 'study_flow_slug';

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
// DEBUG FLAGS PANEL
// ═══════════════════════════════════════════════════════════════════════════════

let flagsPanelBuilt = false;

function initStudyFlagsPanel() {
    const btn = document.getElementById('showFlagsBtn');
    const panel = document.getElementById('emicFlagsPanel');
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

    const content = document.getElementById('emicFlagsContent') || panel;

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
    const closeBtn = document.getElementById('emicFlagsClose');
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
    const dragHandle = document.getElementById('emicFlagsDragHandle');
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

    console.log(`📋 Applied ${Object.keys(flat).length} app settings from config`);
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
 * Trigger data preload for an analysis step.
 * Applies the analysis config (spacecraft/dataset/dates) and clicks the
 * start button to begin downloading data in the background.
 */
function triggerPreloadForStep(stepIndex) {
    if (preloadTriggered[stepIndex]) return;
    preloadTriggered[stepIndex] = true;

    const step = studyConfig.steps[stepIndex];
    if (!step || step.type !== 'analysis') return;

    console.log(`📋 Preloading data for analysis step ${stepIndex} ("${step.title || 'Analysis'}")`);

    // Apply the analysis config so main.js knows what to fetch
    applyAnalysisConfig(step);

    // Trigger the data fetch via the start button
    // This is the same mechanism runAnalysis() uses
    const startBtn = document.getElementById('startBtn');
    if (startBtn && !startBtn.disabled) {
        startBtn.click();
        console.log(`📋 Preload triggered for step ${stepIndex}`);
    } else {
        // Mark as preloaded so analysis step knows data is already loading
        window.__DATA_PRELOADED = stepIndex;
        console.log(`📋 Preload: startBtn not ready, marked for step ${stepIndex}`);
    }
}

/**
 * Scan config for analysis steps with dataPreload settings and set up triggers.
 */
function initDataPreload(config) {
    if (!config.steps) return;

    config.steps.forEach((step, stepIndex) => {
        if (step.type !== 'analysis' || !step.dataPreload) return;

        if (step.dataPreload === 'pageLoad') {
            // Trigger immediately
            console.log(`📋 dataPreload: pageLoad for step ${stepIndex}`);
            triggerPreloadForStep(stepIndex);
        } else if (step.dataPreload.startsWith('step:')) {
            // Trigger when the specified step begins rendering
            const triggerAtStep = parseInt(step.dataPreload.split(':')[1], 10);
            if (!isNaN(triggerAtStep)) {
                // Store the mapping so runCurrentStep can check it
                if (!window.__PRELOAD_TRIGGERS) window.__PRELOAD_TRIGGERS = {};
                window.__PRELOAD_TRIGGERS[triggerAtStep] = stepIndex;
                console.log(`📋 dataPreload: will preload step ${stepIndex} when step ${triggerAtStep} starts`);
            }
        }
        // 'onEnter' or missing = default behavior (no preload setup needed)
    });
}

async function init() {
    studySlug = window.__STUDY_SLUG;
    if (!studySlug) {
        showError('No study specified. URL should be /study/{slug}');
        return;
    }

    // Set study ID for d1-sync.js
    setStudyId(studySlug);

    // Show loading state
    const titleEl = document.getElementById('studyTitle');
    if (titleEl) titleEl.textContent = 'Loading Study…';

    // Fetch config from D1
    studyConfig = await fetchStudyConfig(studySlug);

    if (!studyConfig) {
        // Fallback: try loading from local JSON file
        try {
            const resp = await fetch(`/studies/${studySlug}.json`);
            if (resp.ok) {
                studyConfig = await resp.json();
                console.log(`📋 Study config loaded from local JSON fallback`);
            }
        } catch (e) { /* ignore */ }
    }

    if (!studyConfig) {
        showError(`Study "${studySlug}" not found`);
        return;
    }

    console.log(`📋 Study config loaded: "${studyConfig.name}" (${studyConfig.steps.length} steps)`);

    // Generate per-step flag keys
    stepFlagKeys = generateStepFlagKeys(studyConfig, studySlug);

    // Update page title
    if (titleEl) titleEl.textContent = studyConfig.name || studySlug;
    document.title = (studyConfig.name || studySlug) + ' — spaceweather.now.audio';

    // Apply analysis step config to window.__EMIC_CONFIG so main.js uses it
    const analysisStep = studyConfig.steps.find(s => s.type === 'analysis');
    if (analysisStep) {
        applyAnalysisConfig(analysisStep);
    }

    // Apply app settings from config to DOM (drives settings-drawer.js)
    if (studyConfig.appSettings) {
        // Wait for settings drawer to be injected
        const waitForDrawer = () => new Promise(resolve => {
            if (document.getElementById('settingsDrawer')) { resolve(); return; }
            const obs = new MutationObserver(() => {
                if (document.getElementById('settingsDrawer')) { obs.disconnect(); resolve(); }
            });
            obs.observe(document.body, { childList: true, subtree: true });
            // Fallback timeout
            setTimeout(() => { obs.disconnect(); resolve(); }, 3000);
        });
        await waitForDrawer();
        applyAppSettings(studyConfig.appSettings);
    }

    // Check for admin mode
    if (studyConfig.adminKey) {
        initAdminMode(studyConfig);
    }

    // Set up data preloading for analysis steps
    initDataPreload(studyConfig);

    // ── Step Jump & Preview Mode ─────────────────────────────
    const urlParams = new URLSearchParams(window.location.search);
    const jumpToStep = urlParams.get('step');
    const mode = urlParams.get('mode');
    const isPreview = mode === 'preview' || urlParams.get('preview') === 'true';
    const isTestMode = mode === 'test' || urlParams.get('test') === 'true';

    // State dump for diagnostics
    console.log('📋 [STATE] mode param:', mode, '| isPreview:', isPreview, '| isTestMode:', isTestMode, '| jumpToStep:', jumpToStep);
    console.log('📋 [STATE] localStorage:', {
        participantId: localStorage.getItem('participantId'),
        progress: localStorage.getItem(PROGRESS_KEY),
        studySlug: localStorage.getItem(STUDY_SLUG_KEY),
        advancedMode: localStorage.getItem('emic_advanced_mode'),
        adminUnlocked: localStorage.getItem('admin_unlocked'),
        flagsVisible: localStorage.getItem('study_flags_panel_visible'),
    });
    console.log('📋 [STATE] window flags:', {
        __PREVIEW_MODE: window.__PREVIEW_MODE,
        __TEST_MODE: window.__TEST_MODE,
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

    // ── Test Mode ────────────────────────────────────────────
    // Like live mode (data IS saved), but participant ID is prefixed TEST_ so it can be filtered out later.
    if (isTestMode && !isPreview) {
        window.__TEST_MODE = true;
        const testChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const testSuffix = Array.from({ length: 5 }, () => testChars[Math.floor(Math.random() * 26)]).join('');
        const testId = `TEST_${testSuffix}`;
        window.__TEST_PARTICIPANT_ID = testId;

        // Clear previous session so registration runs fresh with test ID
        localStorage.removeItem('participantId');
        localStorage.removeItem(PROGRESS_KEY);
        localStorage.removeItem(STUDY_SLUG_KEY);
        currentStepIndex = 0;

        // Show test mode banner (subtle, like preview)
        const testBanner = document.createElement('div');
        testBanner.id = 'testBanner';
        testBanner.style.cssText = 'position:fixed;top:8px;left:8px;z-index:999999;background:rgba(255,152,0,0.55);color:#fff;padding:3px 10px;font-family:system-ui;font-size:11px;font-weight:500;border-radius:4px;pointer-events:none;backdrop-filter:blur(4px);';
        testBanner.textContent = '🧪 Test Mode';
        document.body.prepend(testBanner);

        // Update page tab
        const studyName2 = studyConfig.name || studySlug;
        document.title = `[Test] ${studyName2} — spaceweather.now.audio`;
        if (titleEl) titleEl.textContent = `[Test] ${studyName2}`;

        console.log(`🧪 Test mode active — participant: ${testId}`);
    }

    if (isPreview) {
        window.__PREVIEW_MODE = true;
        // Generate a preview participant ID — server will silently drop data for Preview_ users
        const previewChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const previewSuffix = Array.from({ length: 6 }, () => previewChars[Math.floor(Math.random() * 26)]).join('');
        const previewId = `Preview_${previewSuffix}`;
        // Don't set participantId yet — let registration run so it's visible in preview
        localStorage.removeItem('participantId');
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

        // Update page tab: 🚧 [Preview] Study Name + swap favicon
        const studyName = studyConfig.name || studySlug;
        document.title = `[Preview] ${studyName} — spaceweather.now.audio`;
        if (titleEl) titleEl.textContent = `[Preview] ${studyName}`;
        const favicon = document.querySelector('link[rel="icon"]');
        if (favicon) favicon.href = "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🚧</text></svg>";

        console.log(`📋 Preview mode active — participant: ${previewId}`);

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
            console.log(`📋 Jumped to step ${stepIndex} from URL`);

            // In preview mode, store and display the preview participant ID
            // (registration step is skipped when jumping directly to a step)
            if (isPreview && window.__PREVIEW_PARTICIPANT_ID) {
                storeParticipantId(window.__PREVIEW_PARTICIPANT_ID);
                updateParticipantDisplay(window.__PREVIEW_PARTICIPANT_ID);
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
    if (jumpToStep === null && !isPreview && !isTestMode) {
    // Restore progress or start fresh
    const savedSlug = localStorage.getItem(STUDY_SLUG_KEY);
    const savedStep = parseInt(localStorage.getItem(PROGRESS_KEY) || '0', 10);

    if (savedSlug === studySlug && savedStep > 0 && savedStep < studyConfig.steps.length) {
        currentStepIndex = savedStep;
        console.log(`📋 Resuming study at step ${currentStepIndex}`);
    } else {
        currentStepIndex = 0;
        localStorage.setItem(STUDY_SLUG_KEY, studySlug);
    }
    } // end jumpToStep === null / !isPreview

    // Init debug flags panel
    initStudyFlagsPanel();

    // Start the flow
    flowActive = true;
    studyStartTime = new Date().toISOString();
    runCurrentStep();
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
    const startTime = step.startTime || (step.startDate ? step.startDate + 'T00:00:00.000Z' : null) || window.__EMIC_CONFIG.startTime;
    const endTime = step.endTime || (step.endDate ? step.endDate + 'T00:00:00.000Z' : null) || window.__EMIC_CONFIG.endTime;

    // Update global config
    window.__EMIC_CONFIG = {
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
        console.log(`📋 Data source set to: ${dataSourceEl.value}`);
    }

    console.log(`📋 Analysis config applied: ${mapped.spacecraft} / ${mapped.dataset} / ${startTime} → ${endTime}`);
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
    console.log(`📋 openStudyModal: overlay=${overlay ? 'found' : 'MISSING'}, currentModal=${modalManager.currentModal}, studyModalEl=${studyModalEl ? 'exists' : 'MISSING'}, studyModalEl.id=${studyModalEl?.id}`);
    if (modalManager.currentModal === 'studyModal') {
        console.log('📋 openStudyModal: already open, skipping');
        return;
    }
    console.log('📋 openStudyModal: calling modalManager.openModal("studyModal")');
    modalManager.openModal('studyModal', { keepOverlay: true });
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
    } else if (nextStep.type !== 'modal' && nextStep.type !== 'registration' && nextStep.type !== 'question') {
        teardownStudyModal();
    }
    runCurrentStep();
}

async function runCurrentStep() {
    if (!flowActive || currentStepIndex >= studyConfig.steps.length) return;

    const step = studyConfig.steps[currentStepIndex];
    console.log(`📋 Step ${currentStepIndex}: ${step.type}${step.contentType ? ' (' + step.contentType + ')' : ''}`);

    // Check if entering this step should trigger a preload for another step
    if (window.__PRELOAD_TRIGGERS && window.__PRELOAD_TRIGGERS[currentStepIndex] !== undefined) {
        const analysisStepIndex = window.__PRELOAD_TRIGGERS[currentStepIndex];
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
    console.log(`📋 [REG] existingId=${existingId}, idMethod=${step.idMethod}, step=`, step);
    if (existingId) {
        console.log(`📋 Already registered as ${existingId}, skipping registration`);
        updateParticipantDisplay(existingId);
        advanceStep();
        return;
    }

    // Show overlay only when we actually need the registration modal
    const overlay = document.getElementById('permanentOverlay');
    console.log(`📋 [REG] showing overlay: ${overlay ? 'found' : 'MISSING'}`);
    if (overlay) { overlay.style.display = 'flex'; overlay.style.opacity = '1'; }

    const isAuto = step.idMethod === 'auto' || step.idMethod === 'auto_generate';

    if (isAuto && step.skipLogin) {
        // Auto-generate and skip login screen entirely
        const pid = generateParticipantId(step.idPrefix);
        storeParticipantId(pid);
        if (step.showIdCorner !== false) updateParticipantDisplay(pid);
        else hideParticipantDisplay();
        initParticipant(pid, studySlug);
        console.log(`📋 Auto-registered (skip login): ${pid}`);
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
        const title = step.regTitle || 'Welcome';
        const bodyHtml = step.regBodyHtml || '<p style="margin-bottom: 10px; color: #550000; font-size: 16px; font-weight: bold;">Enter a user name to begin:</p>';
        const buttonLabel = step.regButtonLabel || 'Confirm';
        const dimStyle = buildDimensionStyle(step, '480px');
        console.log('📋 Registration modal dimensions:', { modalWidth: step.modalWidth, modalHeight: step.modalHeight, dimStyle, stepKeys: Object.keys(step) });
        const ulStyle = buildHeaderUnderlineStyle(step);
        const titleFont = buildTitleFontStyle(step);
        const bodyFont = buildBodyFontStyle(step);
        const html = `
            <div class="modal-content" style="${dimStyle}">
                <div class="modal-header" style="${ulStyle}">
                    <h3 class="modal-title" style="${titleFont}">🔬 ${title}</h3>
                </div>
                <div class="modal-body" style="${bodyFont}">
                    ${styleBodyHtml(bodyHtml, `${bodyFont} line-height:1.6;margin:0;`)}
                    <div class="modal-form-group">
                        <input type="text" id="studyLoginInput" placeholder="${step.idPlaceholder || 'Enter your ID'}" style="font-size: 18px;" autocomplete="off">
                    </div>
                    <button type="button" id="studyLoginSubmit" class="modal-submit" disabled>✓ ${buttonLabel}</button>
                </div>
            </div>
        `;

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

        const doSubmit = () => {
            const pid = input.value.trim();
            if (!pid) return;
            storeParticipantId(pid);
            updateParticipantDisplay(pid);
            initParticipant(pid, studySlug);
            console.log(`📋 Registered: ${pid}`);
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
    if (container) container.style.display = '';
}

function hideParticipantDisplay() {
    const container = document.getElementById('participantIdDisplay');
    if (container) container.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL DIMENSION HELPER
// ═══════════════════════════════════════════════════════════════════════════════

/** Build inline style string for modal-content from step config dimensions */
function buildDimensionStyle(step, defaultMaxWidth) {
    const maxW = step.modalWidth || defaultMaxWidth;
    let s = `width: 90% !important; max-width: ${maxW} !important;`;
    if (step.modalHeight) s += ` height: ${step.modalHeight} !important;`;
    return s;
}

function buildTitleFontStyle(step) {
    let s = '';
    if (step.titleFontSize) s += `font-size: ${step.titleFontSize};`;
    if (step.titleFontColor) s += ` color: ${step.titleFontColor};`;
    if (step.titleFontBold === false) s += ' font-weight: normal;';
    else if (step.titleFontBold === true) s += ' font-weight: 700;';
    return s;
}

function buildBodyFontStyle(step) {
    let s = '';
    if (step.bodyFontSize) s += `font-size: ${step.bodyFontSize};`;
    if (step.bodyFontColor) s += ` color: ${step.bodyFontColor};`;
    if (step.bodyFontBold) s += ' font-weight: 700;';
    return s;
}

function buildHeaderUnderlineStyle(step) {
    if (step.titleUnderline === false) return 'border-bottom: none;';
    const size = step.titleUnderlineSize || '2px';
    const color = step.titleUnderlineColor || '#c86464';
    // Convert hex to rgba with 0.3 opacity to match default EMIC style
    const r = parseInt(color.slice(1,3), 16);
    const g = parseInt(color.slice(3,5), 16);
    const b = parseInt(color.slice(5,7), 16);
    return `border-bottom: ${size} solid rgba(${r}, ${g}, ${b}, 0.3);`;
}

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
        const dimStyle = buildDimensionStyle(step, '560px');
        const ulStyle = buildHeaderUnderlineStyle(step);
        const titleFont = buildTitleFontStyle(step);
        const bodyColor = step.bodyFontColor || '#333';
        const bodySize = step.bodyFontSize || '18px';
        const bodyWeight = step.bodyFontBold ? 'font-weight:700;' : '';
        const html = `
            <div class="modal-content" style="${dimStyle} text-align: center;">
                <div class="modal-header" style="${ulStyle}">
                    <h3 class="modal-title" style="${titleFont}">${step.title || ''}</h3>
                    ${step.closable ? '<button class="modal-close">&times;</button>' : ''}
                </div>
                <div class="modal-body">
                    <div style="color: ${bodyColor}; font-size: ${bodySize}; line-height: 1.6; text-align: left; margin-bottom: 20px; ${bodyWeight}">
                        ${styleBodyHtml(step.bodyHtml, `color:${bodyColor};font-size:${bodySize};line-height:1.6;margin:0;${bodyWeight}`)}
                    </div>
                    <button type="button" class="modal-submit" style="min-width: 140px;">${step.dismissLabel || 'OK'}</button>
                </div>
            </div>
        `;

        await setStudyModalContent(html);
        openStudyModalIfNeeded();

        const dismiss = () => {
            if (outsideHandler) studyModalEl.removeEventListener('click', outsideHandler);
            resolve();
            advanceStep();
        };
        studyModalInner.querySelector('.modal-submit')?.addEventListener('click', dismiss);
        studyModalInner.querySelector('.modal-close')?.addEventListener('click', dismiss);

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
function executePrompts(prompts) {
    if (!prompts || !prompts.length) return () => {};

    const statusDiv = document.getElementById('status');
    if (!statusDiv) return () => {};

    const cleanups = [];
    let previousPromptDone = null; // resolves when the previous prompt finishes displaying

    function showPrompt(prompt) {
        return new Promise((resolve) => {
            const delayMs = (prompt.delay || 0) * 1000;
            const tid = setTimeout(() => {
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
            }, delayMs);
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
            const handler = () => {
                const p = showPrompt(prompt);
                previousPromptDone = p;
            };
            window.addEventListener('featureCreated', handler, { once: true });
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
    console.log(`📋 Analysis step: entering drawing phase`);

    // Hide overlay so the player is visible (study modal fades out with it)
    const overlay = document.getElementById('permanentOverlay');
    if (overlay) {
        overlay.style.transition = 'opacity 0.3s ease-out';
        overlay.style.opacity = '0';
        setTimeout(() => {
            overlay.style.display = 'none';
            // Clean up study modal after overlay fade completes
            if (studyModalEl) {
                studyModalEl.style.display = 'none';
                studyModalEl.classList.remove('modal-visible');
                if (studyModalInner) studyModalInner.innerHTML = '';
            }
        }, 300);
    }

    // Trigger data render (same pattern as emic_study welcome modal dismiss)
    if (typeof window.triggerDataRender === 'function') {
        window.triggerDataRender();
        console.log(`📋 Triggered data render via triggerDataRender()`);
    }
    // Switch to progressive rendering mode
    const renderSelect = document.getElementById('dataRendering');
    if (renderSelect) {
        renderSelect.value = 'progressive';
        renderSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Execute config-driven prompts
    const cleanupPrompts = executePrompts(step.prompts);

    // Show and wire the Complete button
    const completeBtn = document.getElementById('completeBtn');
    if (completeBtn) {
        completeBtn.style.display = 'none';
        completeBtn.disabled = false;
        completeBtn.textContent = '✓ Complete';

        // Poll for features, show Complete when user draws at least minFeatures
        const minFeatures = step.minFeatures || 1;
        const pollInterval = setInterval(() => {
            const count = getStandaloneFeatures().length;
            if (count >= minFeatures) {
                completeBtn.style.display = '';
                clearInterval(pollInterval);
            }
        }, 500);

        // If features not required, show immediately
        if (step.requireMinFeatures === false) {
            setTimeout(() => {
                completeBtn.style.display = '';
                clearInterval(pollInterval);
            }, 2000);
        }

        // Wait for Complete click
        await new Promise((resolve) => {
            completeBtn.addEventListener('click', async () => {
                pausePlayback();

                // Save features to D1
                const features = getStandaloneFeatures();

                // Enforce minimum features at click time
                if (step.requireMinFeatures !== false && features.length < minFeatures) {
                    showPromptOverlay(`Please identify at least ${minFeatures} feature${minFeatures > 1 ? 's' : ''} before proceeding. You have ${features.length} so far.`);
                    return;
                }
                for (const feat of features) {
                    saveFeature(feat);
                }
                console.log(`📋 Saved ${features.length} features to D1`);

                // Confirmation modal if configured
                if (step.confirmCompletion?.enabled) {
                    const confirmed = await showConfirmationModal(step.confirmCompletion);
                    if (!confirmed) {
                        // User went back — wait for another Complete click
                        return;
                    }
                }

                clearInterval(pollInterval);
                cleanupPrompts();
                resolve();
            });
        });
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

        modalManager.openModal('studyConfirmModal', { keepOverlay: true });

        requestAnimationFrame(() => {
            document.getElementById('studyConfirmYes')?.addEventListener('click', () => {
                modalManager.closeModal('studyConfirmModal', { keepOverlay: true }).then(() => modal.remove());
                resolve(true);
            });
            document.getElementById('studyConfirmNo')?.addEventListener('click', () => {
                modalManager.closeModal('studyConfirmModal').then(() => modal.remove());
                if (overlay) { overlay.style.display = 'none'; }
                resolve(false);
            });
        });
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
            labelPrefixes: step.labelPrefixes,
            boldLabelPrefixes: step.boldLabelPrefixes,
        }];
    }
    if (!questions.length) { advanceStep(); return; }

    // Show overlay
    const overlay = document.getElementById('permanentOverlay');
    if (overlay) { overlay.style.display = 'flex'; overlay.style.opacity = '1'; overlay.style.transition = ''; }

    // Saved answers for back navigation
    const answers = {};

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
        const result = await showQuestionModal(q, displayIndex, displayTotal, progress, answers[q.id], showBack, step);

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

        // Save answer
        answers[q.id] = result;
        localStorage.setItem(`study_answer_${studySlug}_${q.id}`, JSON.stringify(result));

        // Save to D1
        const surveyType = isPreAnalysis() ? 'pre' : 'post';
        saveSurveyAnswer(q.id, result, surveyType);

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
        let questionHtml = '';
        if (question.type === 'radio') {
            questionHtml = buildRadioQuestion(question, previousAnswer);
        } else if (question.type === 'freetext') {
            questionHtml = buildFreetextQuestion(question, previousAnswer);
        }

        const isLast = index === total - 1;
        const nextLabel = isLast ? '✓ Submit' : 'Next →';
        const dims = stepDimensions || {};
        const dimStyle = buildDimensionStyle(dims, '750px');
        const ulStyle = buildHeaderUnderlineStyle(dims);
        const titleFont = buildTitleFontStyle(dims);

        const html = `
            <div class="modal-content emic-questionnaire-modal" style="${dimStyle}">
                <div class="modal-header" style="${ulStyle}">
                    <h3 class="modal-title" style="${titleFont}">${question.title || '📋 Questionnaire'}</h3>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 13px; color: #999; font-weight: 500;">${index + 1} / ${total}</span>
                        <div style="width: 120px; height: 4px; background: #e0e0e0; border-radius: 2px;">
                            <div style="height: 100%; width: ${progressPct}%; background: #2196F3; border-radius: 2px; transition: width 0.3s;"></div>
                        </div>
                    </div>
                </div>
                <div class="modal-body">
                    <div style="font-size: 18px; color: #222; margin-top: 12px; margin-bottom: 16px; text-align: left; font-weight: 700;">
                        ${index + 1}. ${question.text}
                        ${question.subtitle ? `<br><span style="font-size: 14px; color: #555; font-weight: normal;">${question.subtitle}</span>` : ''}
                    </div>
                    ${questionHtml}
                    <div style="text-align: center;">
                        <div style="display: inline-flex; gap: 12px; align-items: center;">
                            ${showBack ? '<button type="button" class="modal-back modal-submit" style="background: #e0e0e0; color: #555; box-shadow: none; text-shadow: none; width: auto; min-width: 100px;">← Back</button>' : ''}
                            <button type="button" class="modal-next modal-submit" style="width: auto; min-width: 140px;" ${question.type === 'radio' && !previousAnswer ? 'disabled' : ''}>${nextLabel}</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        await setStudyModalContent(html);
        openStudyModalIfNeeded();

        const nextBtn = studyModalInner.querySelector('.modal-next');
        const backBtn = studyModalInner.querySelector('.modal-back');

        if (question.type === 'radio') {
            studyModalInner.querySelectorAll(`input[name="sq_${question.inputName || question.id}"]`).forEach(radio => {
                radio.addEventListener('change', () => { nextBtn.disabled = false; });
            });
        }

        nextBtn?.addEventListener('click', () => {
            let answer;
            if (question.type === 'radio') {
                const checked = studyModalInner.querySelector(`input[name="sq_${question.inputName || question.id}"]:checked`);
                answer = checked?.value || '';
            } else {
                answer = studyModalInner.querySelector('textarea')?.value?.trim() || '';
            }
            resolve(answer);
        });

        backBtn?.addEventListener('click', () => {
            resolve('__BACK__');
        });
    });
}

function buildRadioQuestion(question, previousAnswer) {
    const options = question.options || [];
    const name = `sq_${question.inputName || question.id}`;
    const showLabels = question.labelPrefixes !== false;
    const boldLabels = question.boldLabelPrefixes !== false;
    return `
        <div style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px;">
            ${options.map(opt => {
                let labelHtml = '';
                if (showLabels && opt.label) {
                    labelHtml = boldLabels
                        ? `<strong>${opt.label}${opt.description ? ':' : ''}</strong> `
                        : `<span style="color:#333;">${opt.label}${opt.description ? ':' : ''}</span> `;
                }
                return `
                <label class="radio-choice">
                    <input type="radio" name="${name}" value="${opt.value}" ${previousAnswer === opt.value ? 'checked' : ''}>
                    <div>${labelHtml}<span style="color: #444; font-size: 0.92em;">${opt.description || ''}</span></div>
                </label>`;
            }).join('')}
        </div>
    `;
}

function buildFreetextQuestion(question, previousAnswer) {
    return `
        <textarea placeholder="${question.placeholder || 'Type your response here...'}"
            style="width: 100%; min-height: 200px; padding: 14px; font-size: 15px; font-family: inherit; border: 1px solid #ddd; border-radius: 8px; resize: vertical; box-sizing: border-box; line-height: 1.5; color: #333;"
        >${previousAnswer || ''}</textarea>
    `;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STUDY COMPLETE
// ═══════════════════════════════════════════════════════════════════════════════

function onStudyComplete() {
    console.log(`📋 Study complete!`);
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
