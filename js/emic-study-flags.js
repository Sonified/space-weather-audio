// ═══ EMIC STUDY — Progress flags for EMIC study flow ═══
/**
 * emic-study-flags.js
 * Lightweight localStorage flag system for EMIC study state persistence.
 * Tracks user progress through registration, analysis, questionnaires, and submission
 * so the UI can restore state correctly after page refreshes.
 */

export const EMIC_FLAGS = {
    IS_SIMULATING:              'emic_is_simulating',
    HAS_REGISTERED:             'emic_has_registered',
    HAS_CLOSED_WELCOME:         'emic_has_closed_welcome',
    ACTIVE_FEATURE_COUNT:       'emic_active_feature_count',
    HAS_CLICKED_COMPLETE:       'emic_has_clicked_complete',
    HAS_CONFIRMED_COMPLETE:     'emic_has_confirmed_complete',
    HAS_COMPLETED_ANALYSIS:     'emic_has_completed_analysis', // legacy — kept for compat
    HAS_CLICKED_POST_OK:        'emic_has_clicked_post_ok',
    HAS_SUBMITTED:              'emic_has_submitted',
    HAS_SUBMITTED_BACKGROUND:   'emic_has_submitted_background',
    HAS_SUBMITTED_DATA_ANALYSIS:'emic_has_submitted_data_analysis',
    HAS_SUBMITTED_MUSICAL:      'emic_has_submitted_musical',
    HAS_SUBMITTED_REFERRAL:     'emic_has_submitted_referral',
    HAS_SUBMITTED_FEEDBACK:     'emic_has_submitted_feedback',
};

// ── Getters ──────────────────────────────────────────────────────────────────

export function getEmicFlag(key) {
    return localStorage.getItem(key) === 'true';
}

export function getEmicFlagNumber(key) {
    return parseInt(localStorage.getItem(key) || '0', 10);
}

// ── Setters ──────────────────────────────────────────────────────────────────

export function setEmicFlag(key, value = true) {
    localStorage.setItem(key, String(value));
    window.dispatchEvent(new CustomEvent('emic-flag-change', { detail: { key, value } }));
}

export function clearEmicFlag(key) {
    localStorage.removeItem(key);
    window.dispatchEvent(new CustomEvent('emic-flag-change', { detail: { key, value: null } }));
}

// ── Bulk operations ──────────────────────────────────────────────────────────

/** Clear all EMIC flags (for reset / new test session) */
export function clearAllEmicFlags() {
    Object.values(EMIC_FLAGS).forEach(key => {
        localStorage.removeItem(key);
        window.dispatchEvent(new CustomEvent('emic-flag-change', { detail: { key, value: null } }));
    });
}

/** Update the active feature count — call whenever features change */
export function updateActiveFeatureCount(count) {
    localStorage.setItem(EMIC_FLAGS.ACTIVE_FEATURE_COUNT, String(count));
    window.dispatchEvent(new CustomEvent('emic-flag-change', { detail: { key: EMIC_FLAGS.ACTIVE_FEATURE_COUNT, value: count } }));
}

// ── Flags Panel UI ───────────────────────────────────────────────────────────

let flagsBuilt = false; // Only build checkboxes once, then just sync state
let flagChangeListener = null; // Stored reference for cleanup

/** Initialize the Show Flags button and live flags panel */
export function initFlagsPanel() {
    const btn = document.getElementById('showFlagsBtn');
    const panel = document.getElementById('emicFlagsPanel');
    if (!btn || !panel) return;

    // Mirror visibility of simulateFlowBtn
    const simBtn = document.getElementById('simulateFlowBtn');
    if (simBtn) {
        const observer = new MutationObserver(() => {
            btn.style.display = simBtn.style.display;
        });
        observer.observe(simBtn, { attributes: true, attributeFilter: ['style'] });
        btn.style.display = simBtn.style.display;
    }

    btn.addEventListener('click', () => {
        const showing = panel.style.display !== 'none';
        if (showing) {
            panel.style.display = 'none';
            btn.textContent = 'Show Flags';
            if (flagChangeListener) {
                window.removeEventListener('emic-flag-change', flagChangeListener);
                flagChangeListener = null;
            }
        } else {
            panel.style.display = 'block';
            btn.textContent = 'Hide Flags';
            buildFlagCheckboxes();
            syncFlagCheckboxes();
            flagChangeListener = () => syncFlagCheckboxes();
            window.addEventListener('emic-flag-change', flagChangeListener);
        }
    });

    // Make panel draggable
    const handle = document.getElementById('emicFlagsDragHandle') || panel;
    let dragging = false, offsetX = 0, offsetY = 0;
    handle.addEventListener('mousedown', (e) => {
        dragging = true;
        offsetX = e.clientX - panel.getBoundingClientRect().left;
        offsetY = e.clientY - panel.getBoundingClientRect().top;
        handle.style.cursor = 'grabbing';
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        panel.style.left = (e.clientX - offsetX) + 'px';
        panel.style.top = (e.clientY - offsetY) + 'px';
        panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => {
        if (dragging) {
            dragging = false;
            handle.style.cursor = 'grab';
        }
    });
}

/**
 * Build the checkbox UI once. Each boolean flag gets a checkbox,
 * ACTIVE_FEATURE_COUNT gets a number input. All are interactive —
 * toggling a checkbox writes to localStorage immediately, persisting
 * across page close/open. Useful for simulating arbitrary study states.
 */
function buildFlagCheckboxes() {
    const container = document.getElementById('emicFlagsContent');
    if (!container || flagsBuilt) return;
    flagsBuilt = true;

    container.innerHTML = '';

    // Two-column layout: flow state (left) and questionnaires (right)
    const flowFlags = [
        'IS_SIMULATING', 'HAS_REGISTERED', 'HAS_CLOSED_WELCOME',
        'ACTIVE_FEATURE_COUNT', 'HAS_CLICKED_COMPLETE', 'HAS_CONFIRMED_COMPLETE',
        'HAS_CLICKED_POST_OK', 'HAS_SUBMITTED'
    ];
    const questionnaireFlags = [
        'HAS_SUBMITTED_BACKGROUND', 'HAS_SUBMITTED_DATA_ANALYSIS',
        'HAS_SUBMITTED_MUSICAL', 'HAS_SUBMITTED_REFERRAL', 'HAS_SUBMITTED_FEEDBACK'
    ];

    function makeColumn(title, flagNames) {
        const col = document.createElement('div');
        col.style.cssText = 'display: flex; flex-direction: column; gap: 3px;';

        const header = document.createElement('span');
        header.style.cssText = 'font-size: 11px; font-weight: 700; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px;';
        header.textContent = title;
        col.appendChild(header);

        for (const name of flagNames) {
            const key = EMIC_FLAGS[name];
            if (!key) continue;
            const displayName = key.replace(/^emic_/, '');
            const isNumber = key === EMIC_FLAGS.ACTIVE_FEATURE_COUNT;
            const id = `flag_${name}`;

            const wrapper = document.createElement('label');
            wrapper.style.cssText = 'display: flex; align-items: center; gap: 4px; white-space: nowrap; cursor: pointer; user-select: none;';

            if (isNumber) {
                const input = document.createElement('input');
                input.type = 'number';
                input.id = id;
                input.min = '0';
                input.max = '999';
                input.readOnly = true;
                input.tabIndex = -1;
                input.style.cssText = 'width: 48px; padding: 1px 4px; font-family: monospace; font-size: 12px; border: 1px solid #444; border-radius: 3px; background: #1a1a2e; color: #4fc3f7; text-align: center; pointer-events: none; opacity: 0.8;';
                wrapper.appendChild(input);
                wrapper.style.cursor = 'default';
            } else {
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.id = id;
                cb.style.cssText = 'accent-color: #66bb6a; cursor: pointer; width: 14px; height: 14px;';
                cb.addEventListener('change', () => {
                    if (cb.checked) {
                        localStorage.setItem(key, 'true');
                    } else {
                        localStorage.removeItem(key);
                    }
                });
                wrapper.appendChild(cb);
            }

            const label = document.createElement('span');
            label.style.cssText = 'color: #999; font-size: 12px;';
            label.textContent = displayName;
            wrapper.appendChild(label);

            col.appendChild(wrapper);
        }
        return col;
    }

    container.appendChild(makeColumn('Flow State', flowFlags));

    // Copy Flags button to the right of questionnaires column, aligned to top
    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 Copy Flags';
    copyBtn.style.cssText = 'padding: 6px 14px; font-size: 13px; font-weight: 600; border: 1px solid #555; border-radius: 4px; background: rgba(60,60,60,0.9); color: #ccc; cursor: pointer; white-space: nowrap; transition: all 0.15s;';
    copyBtn.addEventListener('click', () => {
        const parts = [];
        for (const [name, key] of Object.entries(EMIC_FLAGS)) {
            const short = name.replace(/^HAS_/, '').replace(/^IS_/, '').replace(/SUBMITTED_?/, 'SUB_');
            const val = localStorage.getItem(key);
            if (key === EMIC_FLAGS.ACTIVE_FEATURE_COUNT) {
                parts.push(`${short}=${val || '0'}`);
            } else {
                parts.push(`${short}=${val === 'true' ? '1' : '0'}`);
            }
        }
        const pid = localStorage.getItem('participantId') || '?';
        const text = `flags[${pid}]: ${parts.join(' ')}`;
        navigator.clipboard.writeText(text).then(() => {
            copyBtn.textContent = '✅ Copied!';
            setTimeout(() => { copyBtn.textContent = '📋 Copy Flags'; }, 1500);
        });
    });

    const qCol = makeColumn('Questionnaires', questionnaireFlags);
    qCol.appendChild(copyBtn);
    copyBtn.style.marginTop = '6px';
    container.appendChild(qCol);
}

/**
 * Sync checkbox/input states FROM localStorage (picks up changes
 * made by the simulate flow or other code). Doesn't rebuild DOM.
 */
function syncFlagCheckboxes() {
    Object.entries(EMIC_FLAGS).forEach(([name, key]) => {
        const id = `flag_${name}`;
        const isNumber = key === EMIC_FLAGS.ACTIVE_FEATURE_COUNT;
        const el = document.getElementById(id);
        if (!el) return;

        if (isNumber) {
            const val = localStorage.getItem(key) || '0';
            // Only update if not focused (don't fight the user's typing)
            if (document.activeElement !== el) {
                el.value = val;
            }
        } else {
            el.checked = localStorage.getItem(key) === 'true';
        }
    });
}
