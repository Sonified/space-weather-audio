/**
 * feature-viewer.js
 * Lightweight controller for the feature review page.
 * Loads study config, applies analysis step settings, triggers data fetch,
 * and lets the feature-tracker load features from D1 in review mode.
 */

import { fetchStudyConfig, setStudyId } from './d1-sync.js';
import { startStreaming } from './streaming.js';

// ── Analysis config (duplicated from study-flow.js to avoid importing the full module) ──

const spacecraftMap = {
    'GOES-16': { spacecraft: 'GOES', dataset: 'DN_MAGN-L2-HIRES_G16' },
    'GOES-17': { spacecraft: 'GOES', dataset: 'DN_MAGN-L2-HIRES_G17' },
    'GOES-18': { spacecraft: 'GOES', dataset: 'DN_MAGN-L2-HIRES_G18' },
    'MMS':     { spacecraft: 'MMS', dataset: 'MMS1_FGM_SRVY_L2' },
    'THEMIS':  { spacecraft: 'THEMIS', dataset: 'THA_L2_FGM' },
    'Van Allen Probes': { spacecraft: 'RBSP', dataset: 'RBSPA_REL04_ECT-HOPE-SCI-L2SA' },
};

function applyAnalysisConfig(step) {
    const mapped = spacecraftMap[step.spacecraft] || { spacecraft: 'GOES', dataset: 'DN_MAGN-L2-HIRES_G16' };
    const startTime = step.startTime || (step.startDate ? step.startDate + 'T00:00:00.000Z' : null);
    const endTime = step.endTime || (step.endDate ? step.endDate + 'T00:00:00.000Z' : null);

    window.__STUDY_CONFIG = {
        spacecraft: mapped.spacecraft,
        dataset: mapped.dataset,
        startTime,
        endTime,
    };

    const scSelect = document.getElementById('spacecraft');
    const dtSelect = document.getElementById('dataType');
    if (scSelect) scSelect.innerHTML = `<option value="${mapped.spacecraft}" selected>${step.spacecraft || mapped.spacecraft}</option>`;
    if (dtSelect) dtSelect.innerHTML = `<option value="${mapped.dataset}" selected>${mapped.dataset}</option>`;

    const dataSourceEl = document.getElementById('dataSource');
    if (dataSourceEl) {
        const srcValue = (step.dataSource || '').toLowerCase();
        dataSourceEl.value = srcValue.includes('cdaweb') ? 'cdaweb' : 'cloudflare';
    }

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

    console.log(`🔎 [Review] Config: ${mapped.spacecraft} / ${mapped.dataset} / ${startTime} → ${endTime}`);
}

// ── Find the Nth analysis step ──

function findAnalysisStep(steps, sessionNumber) {
    const analysisSteps = steps.filter(s => s.type === 'analysis');
    return analysisSteps[sessionNumber - 1] || analysisSteps[0] || null;
}

// ── Init ──

let studyConfig = null;

async function init() {
    const slug = window.__STUDY_SLUG;
    if (!slug) {
        document.title = 'Feature Viewer — No study specified';
        return;
    }

    const pid = window.__REVIEW_PID;
    const session = window.__REVIEW_SESSION || 1;

    if (!pid) {
        document.title = 'Feature Viewer — No participant specified';
        return;
    }

    // Set study ID for d1-sync
    setStudyId(slug);

    // Fetch study config
    studyConfig = await fetchStudyConfig(slug);
    if (!studyConfig) {
        try {
            const resp = await fetch(`/studies/${slug}.json`);
            if (resp.ok) studyConfig = await resp.json();
        } catch (e) { /* ignore */ }
    }
    if (!studyConfig) {
        document.title = `Feature Viewer — Study "${slug}" not found`;
        return;
    }

    // Page title
    const studyName = studyConfig.name || slug;
    // Shorten test PIDs for tab: TEST_20260315_2038_DCVJW → TEST_DCVJW
    const shortPid = pid.startsWith('TEST_') ? 'TEST_' + pid.split('_').pop() : pid;
    document.title = `[Review] ${shortPid} — ${studyName}`;
    const titleEl = document.getElementById('studyTitle');
    if (titleEl) {
        titleEl.textContent = `[Review] ${studyName}`;
        titleEl.style.opacity = '0.88';
    }

    // Show participant ID
    const pidDisplay = document.getElementById('participantIdDisplay');
    const pidValue = document.getElementById('participantIdValue');
    if (pidDisplay) pidDisplay.classList.add('sf-pid-visible');
    if (pidValue) pidValue.textContent = pid;

    // Populate participant dropdown (non-blocking)
    populateParticipantSelector(slug, pid);

    // Force feature boxes visible
    const fbCheckbox = document.getElementById('featureBoxesVisible');
    if (fbCheckbox) fbCheckbox.checked = true;

    // Apply app settings from config
    if (studyConfig.appSettings) {
        const waitForDrawer = () => new Promise(resolve => {
            if (document.getElementById('settingsDrawer')) { resolve(); return; }
            const obs = new MutationObserver(() => {
                if (document.getElementById('settingsDrawer')) { obs.disconnect(); resolve(); }
            });
            obs.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { obs.disconnect(); resolve(); }, 3000);
        });
        await waitForDrawer();

        // Import and apply app settings (same pattern as study-flow.js)
        // Inline the settings we care about
        const settings = studyConfig.appSettings;
        for (const [key, value] of Object.entries(settings)) {
            const el = document.getElementById(key);
            if (!el) continue;
            if (el.type === 'checkbox') el.checked = !!value;
            else if (el.tagName === 'SELECT' || el.tagName === 'INPUT') el.value = String(value);
        }
    }

    // Find and apply the analysis step for this session
    const analysisStep = findAnalysisStep(studyConfig.steps, session);
    if (!analysisStep) {
        console.warn(`🔎 [Review] No analysis step found for session ${session}`);
        return;
    }
    applyAnalysisConfig(analysisStep);

    // Highlight the correct session button
    updateSessionButtons(session);

    // Force progressive rendering (appSettings may set it to 'triggered' which waits for triggerDataRender)
    const renderSelect = document.getElementById('dataRendering');
    if (renderSelect) {
        renderSelect.value = 'progressive';
        renderSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Start loading data — pass config directly so startStreaming skips form fields
    console.log(`🔎 [Review] Loading data for ${pid}, session ${session}`);
    await startStreaming(null, window.__STUDY_CONFIG);

    // Listen for session changes
    let switchingSession = false;
    window.addEventListener('review-session-change', async (e) => {
        const newSession = e.detail.session;
        if (switchingSession) {
            console.warn(`🔎 [Review] Already switching — ignoring session ${newSession}`);
            return;
        }
        switchingSession = true;
        window.__REVIEW_SESSION = newSession;
        const step = findAnalysisStep(studyConfig.steps, newSession);
        if (!step) {
            console.warn(`🔎 [Review] No analysis step for session ${newSession}`);
            switchingSession = false;
            return;
        }
        applyAnalysisConfig(step);
        updateSessionButtons(newSession);

        // Re-force progressive rendering (same as init — appSettings may have set 'triggered')
        const renderSelect = document.getElementById('dataRendering');
        if (renderSelect) {
            renderSelect.value = 'progressive';
            renderSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }

        console.log(`🔎 [Review] Switching to session ${newSession}`);
        try {
            await startStreaming(null, window.__STUDY_CONFIG);
        } catch (err) {
            console.error(`🔎 [Review] Failed to load session ${newSession}:`, err);
            const statusDiv = document.getElementById('status');
            if (statusDiv) {
                statusDiv.textContent = `Error loading session ${newSession}: ${err.message}`;
                statusDiv.className = 'status error';
            }
        } finally {
            switchingSession = false;
        }
    });
}

async function populateParticipantSelector(slug, currentPid) {
    const slot = document.getElementById('participantSelectorSlot');
    if (!slot) return;
    try {
        const base = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
            ? 'https://spaceweather.now.audio' : location.origin;
        const fetchUrl = `${base}/api/study/${encodeURIComponent(slug)}/participants?filter=all`;
        console.log('🔎 [Review] Fetching participants:', fetchUrl);
        const resp = await fetch(fetchUrl);
        const data = await resp.json();
        console.log('🔎 [Review] Participants response:', data.success, data.participants?.length, 'participants');
        if (!data.success || !data.participants?.length) return;

        const participants = data.participants.sort((a, b) =>
            (a.registered_at || '').localeCompare(b.registered_at || '')
        );

        const selector = document.createElement('select');
        selector.id = 'participantSelector';
        selector.className = 'gear-select';
        selector.style.cssText = 'min-width: 320px; flex: none; appearance: none; -webkit-appearance: none; padding-right: 22px; background-image: url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2710%27 height=%276%27%3E%3Cpath d=%27M0 0l5 6 5-6z%27 fill=%27%23aaa%27/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 6px center;';

        selector.innerHTML = participants.map((p, i) => {
            const features = p.feature_count > 0 ? ` (${p.feature_count} feat)` : '';
            const sel = p.participant_id === currentPid ? ' selected' : '';
            return `<option value="${p.participant_id}"${sel}>${i + 1}. ${p.participant_id}${features}</option>`;
        }).join('');

        slot.replaceWith(selector);

        selector.addEventListener('change', () => {
            const newPid = selector.value;
            if (!newPid || newPid === currentPid) return;
            const navUrl = new URL(window.location);
            navUrl.searchParams.set('pid', newPid);
            navUrl.searchParams.set('session', '1');
            window.location.href = navUrl.toString();
        });
        console.log('🔎 [Review] Participant selector populated:', participants.length, 'options');
    } catch (err) {
        console.warn('🔎 [Review] Could not load participant list:', err);
    }
}

function updateSessionButtons(activeSession) {
    document.querySelectorAll('.study-btn[data-session]').forEach(btn => {
        const s = parseInt(btn.getAttribute('data-session'), 10);
        btn.classList.toggle('active', s === activeSession);
    });
}

// Wait for DOM, then init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
