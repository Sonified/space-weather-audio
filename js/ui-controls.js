/**
 * ui-controls.js
 * UI controls: station loading, dataset config, filters, playback settings, cache purge.
 * Modal and survey logic split into ui-modals.js and ui-surveys.js.
 */

import * as State from './audio-state.js';
import { drawWaveform, changeWaveformFilter } from './minimap-window-renderer.js';
import { updatePlaybackSpeed } from './audio-player.js';
import { isStudyMode, CURRENT_MODE, AppMode } from './master-modes.js';
import { log, logGroup, logGroupEnd } from './logger.js';
const refreshSelectById = window.__customSelect?.refreshSelectById || (() => {});

// ═══════════════════════════════════════════════════════════════════════════════
// Re-exports from ui-modals.js (zero-breakage migration — consumers keep importing from here)
// ═══════════════════════════════════════════════════════════════════════════════
// Modal functions (re-exported for backward compatibility)
export {
    fadeOutOverlay,
    closeAllModals,
    setupModalEventListeners,
    openParticipantModal,
    closeParticipantModal,
    openParticipantInfoModal,
    openWelcomeModal,
    closeWelcomeModal,
    wireQuestionnaireModals,
    QUESTIONNAIRE_CONFIG
} from './ui-modals.js';

// Survey functions (re-exported for backward compatibility)
export {
    submitParticipantSetup
} from './ui-surveys.js';

export function loadStations() {
    // No-op: spacecraft selection is handled by updateDatasetOptions()
}

/**
 * Load saved spacecraft selection from localStorage and apply it
 * Called on page load to restore user's preferred spacecraft
 */
export async function loadSavedSpacecraft() {
    const spacecraftSelect = document.getElementById('spacecraft');
    if (!spacecraftSelect) return;

    // Skip localStorage restoration if loading from a share link
    // The share link handler (applySharedSession) already set the correct values
    if (sessionStorage.getItem('isSharedSession') === 'true') {
        log('share', 'Skipping localStorage restoration (share link active)');
        return;
    }

    // Start preference restoration group
    const prefGroupOpen = logGroup('data', 'Restoring saved preferences');

    // Migrate from old 'selectedVolcano' key if it exists
    const legacySelection = localStorage.getItem('selectedVolcano');
    if (legacySelection) {
        localStorage.setItem('selectedSpacecraft', legacySelection);
        localStorage.removeItem('selectedVolcano');
        console.log('Migrated: selectedVolcano → selectedSpacecraft');
    }

    // Load saved spacecraft from localStorage
    const savedSpacecraft = localStorage.getItem('selectedSpacecraft');
    // Validate against SPACECRAFT_DATASETS (space weather mode)
    if (savedSpacecraft && SPACECRAFT_DATASETS[savedSpacecraft]) {
        spacecraftSelect.value = savedSpacecraft;
        if (!isStudyMode() && window.pm?.init) {
            console.log(`Spacecraft: ${savedSpacecraft}`);
        }
        // Update the Data dropdown to match the restored spacecraft
        updateDatasetOptions();
    } else {
        // If no saved spacecraft or invalid, default to first option
        const firstOption = spacecraftSelect.options[0]?.value || 'PSP';
        spacecraftSelect.value = firstOption;
        localStorage.setItem('selectedSpacecraft', firstOption);
        if (window.pm?.init) console.log(`Spacecraft: ${firstOption} (default)`);
        updateDatasetOptions();
    }

    // Restore saved data type (after updateDatasetOptions populates the dropdown)
    const savedDataType = localStorage.getItem('selectedDataType');
    const dataTypeSelect = document.getElementById('dataType');
    if (savedDataType && dataTypeSelect) {
        // Check if the saved data type is valid for the current spacecraft
        const validOptions = Array.from(dataTypeSelect.options).map(opt => opt.value);
        if (validOptions.includes(savedDataType)) {
            dataTypeSelect.value = savedDataType;
            // Save the friendly label so inline script can show it instantly next load
            const selectedOpt = dataTypeSelect.options[dataTypeSelect.selectedIndex];
            if (selectedOpt) localStorage.setItem('selectedDataTypeLabel', selectedOpt.textContent);
            if (!isStudyMode() && window.pm?.init) {
                console.log(`Data type: ${savedDataType}`);
            }
        }
    }

    // Restore saved date/time settings
    loadSavedDateTime(prefGroupOpen);

    // Enhance date inputs with segmented editing (YYYY / MM / DD)
    enhanceDateInput('startDate', 'startDatePicker');
    enhanceDateInput('endDate', 'endDatePicker');

    // Enhance time inputs with segmented editing (HH / MM / SS)
    enhanceTimeInput(document.getElementById('startTime'));
    enhanceTimeInput(document.getElementById('endTime'));

    // Clean any residual .000 from values (localStorage, HTML defaults, etc.)
    for (const id of ['startTime', 'endTime']) {
        const el = document.getElementById(id);
        if (el) el.value = el.value.replace(/\.0+$/, '');
    }

}

/**
 * Enhance a text input to behave like a segmented date picker.
 * Format: YYYY-MM-DD  Segments: YYYY(0-3) - MM(5-6) - DD(8-9)
 * Calendar button opens the hidden native date picker; selection syncs back.
 * Tab from the last segment (DD) advances to the next focusable input.
 */
function enhanceDateInput(textId, pickerId) {
    const input = document.getElementById(textId);
    const picker = document.getElementById(pickerId);
    const calBtn = input?.closest('.date-wrap')?.querySelector('.cal-btn');
    if (!input) return;

    // Segment definitions: [startIndex, endIndex]
    const SEGS = [[0, 4], [5, 7], [8, 10]]; // YYYY, MM, DD

    let activeSeg = 0;
    let digitBuf = '';

    function ensureFormat() {
        const val = input.value;
        const match = val.match(/^(\d{1,4})-?(\d{0,2})-?(\d{0,2})$/);
        if (!match) { input.value = '2021-01-01'; return; }
        const y = (match[1] || '2021').padStart(4, '0');
        const m = (match[2] || '01').padStart(2, '0');
        const d = (match[3] || '01').padStart(2, '0');
        input.value = `${y}-${m}-${d}`;
    }

    function selectSeg(idx, keepBuf) {
        const newSeg = Math.max(0, Math.min(2, idx));
        if (!keepBuf || newSeg !== activeSeg) digitBuf = '';
        activeSeg = newSeg;
        const [start, end] = SEGS[activeSeg];
        input.setSelectionRange(start, end);
    }

    function segFromCursor() {
        const pos = input.selectionStart;
        if (pos <= 4) return 0;
        if (pos <= 7) return 1;
        return 2;
    }

    function setSegValue(idx, numStr) {
        const [start, end] = SEGS[idx];
        const width = end - start;
        let padded = numStr.padStart(width, '0').slice(0, width);
        // Clamp values
        if (idx === 1) { // month 01-12
            let n = Math.min(Math.max(parseInt(padded, 10) || 0, 0), 12);
            padded = String(n).padStart(2, '0');
        } else if (idx === 2) { // day 01-31
            let n = Math.min(Math.max(parseInt(padded, 10) || 0, 0), 31);
            padded = String(n).padStart(2, '0');
        }
        const val = input.value;
        input.value = val.slice(0, start) + padded + val.slice(end);
    }

    function advanceToNextInput() {
        // Find the next focusable input after the date-wrap
        const wrap = input.closest('.date-wrap');
        if (!wrap) return false;
        // Look for the next .time-wrap or input sibling
        let el = wrap.nextElementSibling;
        while (el) {
            const target = el.querySelector?.('input[type="text"]') || (el.tagName === 'INPUT' ? el : null);
            if (target) {
                target.focus();
                if (target._timeSegmented) target._timeSegmented.selectSegment(0);
                else target.select();
                return true;
            }
            el = el.nextElementSibling;
        }
        return false;
    }

    // Calendar button → open native picker
    if (calBtn && picker) {
        calBtn.addEventListener('click', () => {
            picker.value = input.value;
            picker.showPicker();
        });
        picker.addEventListener('change', () => {
            input.value = picker.value;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
    }

    let clickPending = false;
    input.addEventListener('mousedown', () => { clickPending = true; });
    input.addEventListener('mouseup', () => {
        clickPending = false;
        ensureFormat();
        selectSeg(segFromCursor());
    });
    input.addEventListener('focus', () => {
        if (clickPending) return; // mouseup will handle it
        ensureFormat();
        selectSeg(activeSeg);
    });

    input.addEventListener('blur', () => {
        activeSeg = 0;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    input.addEventListener('keydown', (e) => {
        const key = e.key;

        if (key === 'Tab') {
            if (!e.shiftKey && activeSeg < 2) {
                e.preventDefault();
                selectSeg(activeSeg + 1);
                return;
            } else if (!e.shiftKey && activeSeg === 2) {
                // Last segment — advance to the time input
                if (advanceToNextInput()) { e.preventDefault(); }
                return;
            } else if (e.shiftKey && activeSeg > 0) {
                e.preventDefault();
                selectSeg(activeSeg - 1);
                return;
            }
            return;
        }

        if (key === 'ArrowRight') {
            e.preventDefault();
            if (activeSeg < 2) selectSeg(activeSeg + 1);
            return;
        }
        if (key === 'ArrowLeft') {
            e.preventDefault();
            if (activeSeg > 0) selectSeg(activeSeg - 1);
            return;
        }

        if (key === 'ArrowUp' || key === 'ArrowDown') {
            e.preventDefault();
            const [start, end] = SEGS[activeSeg];
            let n = parseInt(input.value.slice(start, end), 10) || 0;
            n += key === 'ArrowUp' ? 1 : -1;
            if (activeSeg === 0) { // year — no wrap
                n = Math.max(2000, Math.min(2099, n));
            } else if (activeSeg === 1) { // month
                if (n < 1) n = 12; if (n > 12) n = 1;
            } else { // day
                if (n < 1) n = 31; if (n > 31) n = 1;
            }
            setSegValue(activeSeg, String(n));
            selectSeg(activeSeg);
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        }

        if (/^\d$/.test(key)) {
            e.preventDefault();
            const width = activeSeg === 0 ? 4 : 2;
            digitBuf += key;

            if (digitBuf.length < width) {
                const preview = digitBuf.padEnd(width, '0');
                setSegValue(activeSeg, preview);
                selectSeg(activeSeg, true);
            } else {
                setSegValue(activeSeg, digitBuf);
                digitBuf = '';
                if (activeSeg < 2) selectSeg(activeSeg + 1);
                else selectSeg(activeSeg);
            }

            // Auto-advance month/day if first digit is too high
            if (activeSeg === 1 && digitBuf.length === 1 && parseInt(key, 10) > 1) {
                // Month can't be 20+, so single digit like 3 → 03, advance
                setSegValue(activeSeg, '0' + key);
                digitBuf = '';
                selectSeg(activeSeg + 1);
            } else if (activeSeg === 2 && digitBuf.length === 1 && parseInt(key, 10) > 3) {
                // Day can't be 40+, so single digit like 5 → 05, advance
                setSegValue(activeSeg, '0' + key);
                digitBuf = '';
                selectSeg(activeSeg);
            }
            return;
        }

        if (key === '-') {
            e.preventDefault();
            if (activeSeg < 2) selectSeg(activeSeg + 1);
            return;
        }

        if (key === 'Backspace') {
            e.preventDefault();
            const width = activeSeg === 0 ? 4 : 2;
            setSegValue(activeSeg, '0'.repeat(width));
            digitBuf = '';
            selectSeg(activeSeg);
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        }

        if (key === 'Enter') { e.preventDefault(); input.blur(); return; }

        if (!e.metaKey && !e.ctrlKey && key.length === 1) {
            e.preventDefault();
        }
    });

    input._dateSegmented = { selectSegment: selectSeg };
}

/**
 * Enhance a text input to behave like a segmented time picker.
 * Segments: HH : MM : SS  (positions 0-1, 3-4, 6-7)
 * Click selects the segment under the cursor. Typing fills and auto-advances.
 * Tab/ArrowRight advance to next segment; Shift+Tab/ArrowLeft go back.
 * Milliseconds (.mmm) are accepted if typed but not shown by default.
 */
function enhanceTimeInput(input) {
    if (!input) return;

    // Segments 0-2 are always present: HH(0-1) : MM(3-4) : SS(6-7)
    // Segment 3 (ms) is dynamic: .mmm(8-12) — only appears when user types '.'
    const BASE_SEGS = [[0, 2], [3, 5], [6, 8]];
    let activeSeg = 0;
    let digitBuf = '';
    let msMode = false;   // whether .mmm suffix is currently showing
    let msEdited = false;  // whether user actually typed ms digits

    function hasMs() { return input.value.length > 8 && input.value[8] === '.'; }

    function stripMs() {
        if (hasMs()) input.value = input.value.slice(0, 8);
        msMode = false;
        msEdited = false;
    }

    function addMs() {
        if (!hasMs()) input.value = input.value.slice(0, 8) + '.000';
        msMode = true;
        msEdited = false;
    }

    function getSegs() {
        if (msMode || hasMs()) return [...BASE_SEGS, [9, 12]];
        return BASE_SEGS;
    }

    function ensureFormat() {
        const val = input.value;
        const match = val.match(/^(\d{0,2}):?(\d{0,2}):?(\d{0,2})(\.(\d{0,3}))?$/);
        if (!match) { input.value = '00:00:00'; return; }
        const h = (match[1] || '00').padStart(2, '0');
        const m = (match[2] || '00').padStart(2, '0');
        const s = (match[3] || '00').padStart(2, '0');
        const msRaw = match[5] ? match[5].padEnd(3, '0') : '';
        const msNonZero = msRaw && msRaw !== '000';
        const ms = msNonZero ? '.' + msRaw : '';
        input.value = `${h}:${m}:${s}${ms}`;
        msMode = msNonZero;
    }

    function selectSeg(idx, keepBuf) {
        const segs = getSegs();
        const maxIdx = segs.length - 1;
        const newSeg = Math.max(0, Math.min(maxIdx, idx));
        if (!keepBuf || newSeg !== activeSeg) digitBuf = '';
        activeSeg = newSeg;
        const [start, end] = segs[activeSeg];
        input.setSelectionRange(start, end);
    }

    function segFromCursor() {
        const pos = input.selectionStart;
        if (pos <= 2) return 0;
        if (pos <= 5) return 1;
        if (pos <= 7) return 2;
        if (pos >= 8) {
            if (!hasMs()) addMs();
            return 3;
        }
        return 2;
    }

    function setSegValue(idx, numStr) {
        if (idx === 3) {
            // Milliseconds segment — 3 digits, no clamping needed (000-999)
            const padded = numStr.padEnd(3, '0').slice(0, 3);
            input.value = input.value.slice(0, 9) + padded;
            return;
        }
        const maxes = [23, 59, 59];
        let n = Math.min(parseInt(numStr, 10) || 0, maxes[idx]);
        const padded = String(n).padStart(2, '0');
        const val = input.value;
        const [start, end] = BASE_SEGS[idx];
        input.value = val.slice(0, start) + padded + val.slice(end);
    }

    let clickPending = false;
    input.addEventListener('mousedown', () => { clickPending = true; });
    input.addEventListener('mouseup', () => {
        clickPending = false;
        if (!msMode) ensureFormat();
        const seg = segFromCursor();
        if (msMode && seg < 3 && !msEdited) stripMs();
        selectSeg(seg);
    });
    input.addEventListener('focus', () => {
        if (clickPending) return;
        ensureFormat();
        selectSeg(activeSeg);
    });

    // Blur → strip .000 if user didn't edit ms, then notify
    input.addEventListener('blur', () => {
        if (msMode && !msEdited) stripMs();
        if (hasMs() && input.value.slice(9) === '000') stripMs();
        activeSeg = 0;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    input.addEventListener('keydown', (e) => {
        const key = e.key;
        const segs = getSegs();
        const maxSeg = segs.length - 1;

        // Tab: move between segments, then leave the input
        if (key === 'Tab') {
            if (!e.shiftKey && activeSeg < maxSeg) {
                e.preventDefault();
                selectSeg(activeSeg + 1);
                return;
            } else if (!e.shiftKey && activeSeg >= maxSeg) {
                // Forward Tab from last segment — find next date or button
                if (msMode && !msEdited) stripMs();
                if (hasMs() && input.value.slice(9) === '000') stripMs();
                const wrap = input.closest('.time-wrap');
                if (wrap) {
                    let el = wrap.nextElementSibling;
                    while (el) {
                        // Check for a label (skip it), date-wrap, or button
                        const target = el.querySelector?.('input[type="text"]') ||
                                       (el.tagName === 'INPUT' ? el : null) ||
                                       (el.tagName === 'BUTTON' ? el : null);
                        if (target) {
                            e.preventDefault();
                            target.focus();
                            if (target._dateSegmented) target._dateSegmented.selectSegment(0);
                            else if (target._timeSegmented) target._timeSegmented.selectSegment(0);
                            return;
                        }
                        el = el.nextElementSibling;
                    }
                }
                return;
            } else if (e.shiftKey && activeSeg > 0) {
                e.preventDefault();
                if (activeSeg === 3 && !msEdited) stripMs();
                selectSeg(activeSeg - 1);
                return;
            } else if (e.shiftKey && activeSeg === 0) {
                // Shift+Tab from HH → go back to date input's DD segment
                const wrap = input.closest('.time-wrap');
                const dateWrap = wrap?.previousElementSibling;
                const dateInput = dateWrap?.querySelector?.('input[type="text"]');
                if (dateInput?._dateSegmented) {
                    e.preventDefault();
                    dateInput.focus();
                    dateInput._dateSegmented.selectSegment(2);
                    return;
                }
            }
            // Leaving the input — clean up ms if needed
            if (msMode && !msEdited) stripMs();
            if (hasMs() && input.value.slice(9) === '000') stripMs();
            return;
        }

        // Arrow keys: navigate segments
        if (key === 'ArrowRight') {
            e.preventDefault();
            if (activeSeg < maxSeg) selectSeg(activeSeg + 1);
            return;
        }
        if (key === 'ArrowLeft') {
            e.preventDefault();
            if (activeSeg > 0) {
                if (activeSeg === 3 && !msEdited) stripMs();
                selectSeg(activeSeg - 1);
            }
            return;
        }

        // Up/Down: increment/decrement current segment
        if (key === 'ArrowUp' || key === 'ArrowDown') {
            e.preventDefault();
            if (activeSeg === 3) {
                let n = parseInt(input.value.slice(9, 12), 10) || 0;
                n += key === 'ArrowUp' ? 1 : -1;
                if (n < 0) n = 999; if (n > 999) n = 0;
                setSegValue(3, String(n).padStart(3, '0'));
                msEdited = true;
                selectSeg(3);
            } else {
                const [start, end] = BASE_SEGS[activeSeg];
                const maxes = [23, 59, 59];
                let n = parseInt(input.value.slice(start, end), 10) || 0;
                n += key === 'ArrowUp' ? 1 : -1;
                if (n < 0) n = maxes[activeSeg];
                if (n > maxes[activeSeg]) n = 0;
                setSegValue(activeSeg, String(n));
                selectSeg(activeSeg);
            }
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        }

        // Period: enter ms mode when on seconds segment
        if (key === '.') {
            e.preventDefault();
            if (activeSeg === 2) {
                addMs();
                selectSeg(3);
            }
            return;
        }

        // Digits
        if (/^\d$/.test(key)) {
            e.preventDefault();

            // Ms segment: 3 digits, fill left-to-right
            if (activeSeg === 3) {
                digitBuf += key;
                msEdited = true;
                if (digitBuf.length < 3) {
                    setSegValue(3, digitBuf.padEnd(3, '0'));
                    selectSeg(3, true);
                } else {
                    setSegValue(3, digitBuf);
                    digitBuf = '';
                    selectSeg(3);
                }
                return;
            }

            // HH/MM/SS segments: 2 digits
            digitBuf += key;
            if (digitBuf.length === 1) {
                setSegValue(activeSeg, key + '0');
                selectSeg(activeSeg, true);
            } else {
                setSegValue(activeSeg, digitBuf);
                digitBuf = '';
                if (activeSeg < 2) selectSeg(activeSeg + 1);
                else selectSeg(activeSeg);
            }
            return;
        }

        // Colon: advance to next segment
        if (key === ':') {
            e.preventDefault();
            if (activeSeg < 2) selectSeg(activeSeg + 1);
            return;
        }

        // Backspace: clear current segment (or exit ms mode)
        if (key === 'Backspace') {
            e.preventDefault();
            if (activeSeg === 3) {
                stripMs();
                selectSeg(2);
            } else {
                setSegValue(activeSeg, '00');
                digitBuf = '';
                selectSeg(activeSeg);
            }
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        }

        if (key === 'Enter') { e.preventDefault(); input.blur(); return; }

        // Block all other character input (allow Cmd+C, Cmd+V, etc.)
        if (!e.metaKey && !e.ctrlKey && key.length === 1) {
            e.preventDefault();
        }
    });

    // Expose API for external callers (e.g. date Tab handler)
    input._timeSegmented = { selectSegment: selectSeg };
}

/**
 * Load saved date/time settings from localStorage
 * @param {boolean} groupOpen - Whether a log group is open (to close it at the end)
 */
function loadSavedDateTime(groupOpen) {
    const startDate = document.getElementById('startDate');
    const startTime = document.getElementById('startTime');
    const endDate = document.getElementById('endDate');
    const endTime = document.getElementById('endTime');

    const savedStartDate = localStorage.getItem('selectedStartDate');
    const savedStartTime = localStorage.getItem('selectedStartTime');
    const savedEndDate = localStorage.getItem('selectedEndDate');
    const savedEndTime = localStorage.getItem('selectedEndTime');

    if (savedStartDate && startDate) {
        startDate.value = savedStartDate;
    }
    if (savedStartTime && startTime) {
        startTime.value = savedStartTime.replace(/\.0+$/, '');
    }
    if (savedEndDate && endDate) {
        endDate.value = savedEndDate;
    }
    if (savedEndTime && endTime) {
        endTime.value = savedEndTime.replace(/\.0+$/, '');
    }

    if ((savedStartDate || savedEndDate) && window.pm?.data) {
        console.log(`📡 Date/time: ${savedStartDate} ${savedStartTime} → ${savedEndDate} ${savedEndTime}`);
    }

    // Close the preference restoration group
    if (groupOpen) logGroupEnd();
}

/**
 * Save current date/time settings to localStorage
 * Call this when any date/time field changes
 */
export function saveDateTime() {
    const startDate = document.getElementById('startDate');
    const startTime = document.getElementById('startTime');
    const endDate = document.getElementById('endDate');
    const endTime = document.getElementById('endTime');

    if (startDate?.value) localStorage.setItem('selectedStartDate', startDate.value);
    if (startTime?.value) localStorage.setItem('selectedStartTime', startTime.value);
    if (endDate?.value) localStorage.setItem('selectedEndDate', endDate.value);
    if (endTime?.value) localStorage.setItem('selectedEndTime', endTime.value);

    console.log('💾 Saved date/time:', startDate?.value, startTime?.value, '→', endDate?.value, endTime?.value);
}

// Spacecraft to datasets mapping for the Data dropdown
// Spacecraft datasets organized by instrument group
// Items with 'group' key create <optgroup> headers; magnetic field groups always come first
const SPACECRAFT_DATASETS = {
    'PSP': [
        { group: 'Magnetic Field' },
        { value: 'PSP_FLD_L2_MAG_RTN', label: 'MAG RTN (Full Cadence)' },
        { value: 'PSP_FLD_L2_MAG_RTN_4_SA_PER_CYC', label: 'MAG RTN (4 Samples/Cycle)' },
        { group: 'Electric Field' },
        { value: 'PSP_FLD_L2_DFB_WF_DVDC', label: 'DFB DC Voltage Waveform' }
    ],
    'Wind': [
        { group: 'Magnetic Field' },
        { value: 'WI_H2_MFI', label: 'MFI (Magnetic Field Investigation)' }
    ],
    'MMS': [
        { group: 'Magnetic Field (FGM)' },
        { value: 'MMS1_FGM_SRVY_L2', label: 'FGM Survey' },
        { value: 'MMS1_FGM_BRST_L2', label: 'FGM Burst' },
        { group: 'Magnetic Field (Search Coil)' },
        { value: 'MMS1_SCM_SRVY_L2_SCSRVY', label: 'SCM Survey' },
        { value: 'MMS1_SCM_BRST_L2_SCB', label: 'SCM Burst' },
        { group: 'Electric Field (EDP)' },
        { value: 'MMS1_EDP_SLOW_L2_DCE', label: 'EDP Slow Survey' },
        { value: 'MMS1_EDP_FAST_L2_DCE', label: 'EDP Fast Survey' },
        { value: 'MMS1_EDP_BRST_L2_DCE', label: 'EDP Burst' }
    ],
    'THEMIS': [
        { group: 'Magnetic Field (FGM)' },
        { value: 'THA_L2_FGM', label: 'THEMIS-A FGM' },
        { value: 'THB_L2_FGM', label: 'THEMIS-B FGM' },
        { value: 'THC_L2_FGM', label: 'THEMIS-C FGM' },
        { value: 'THD_L2_FGM', label: 'THEMIS-D FGM' },
        { value: 'THE_L2_FGM', label: 'THEMIS-E FGM' },
        { group: 'Magnetic Field High-Res (FGM Burst, ~4 Hz)' },
        { value: 'THA_L2_FGM_FGH', label: 'THEMIS-A FGM High-Res' },
        { value: 'THB_L2_FGM_FGH', label: 'THEMIS-B FGM High-Res' },
        { value: 'THC_L2_FGM_FGH', label: 'THEMIS-C FGM High-Res' },
        { value: 'THD_L2_FGM_FGH', label: 'THEMIS-D FGM High-Res' },
        { value: 'THE_L2_FGM_FGH', label: 'THEMIS-E FGM High-Res' },
        { group: 'Magnetic Field (Search Coil)' },
        { value: 'THA_L2_SCM', label: 'THEMIS-A SCM' },
        { value: 'THB_L2_SCM', label: 'THEMIS-B SCM' },
        { value: 'THC_L2_SCM', label: 'THEMIS-C SCM' },
        { value: 'THD_L2_SCM', label: 'THEMIS-D SCM' },
        { value: 'THE_L2_SCM', label: 'THEMIS-E SCM' },
        { group: 'Electric Field (EFI)' },
        { value: 'THA_L2_EFI', label: 'THEMIS-A EFI' },
        { value: 'THB_L2_EFI', label: 'THEMIS-B EFI' },
        { value: 'THC_L2_EFI', label: 'THEMIS-C EFI' },
        { value: 'THD_L2_EFI', label: 'THEMIS-D EFI' },
        { value: 'THE_L2_EFI', label: 'THEMIS-E EFI' }
    ],
    'RBSP': [
        { group: 'Magnetic Field (EMFISIS)' },
        { value: 'RBSP-A_MAGNETOMETER_HIRES-GSE_EMFISIS-L3', label: 'RBSP-A MAG Hi-Res (64 S/s)' },
        { value: 'RBSP-B_MAGNETOMETER_HIRES-GSE_EMFISIS-L3', label: 'RBSP-B MAG Hi-Res (64 S/s)' },
        { value: 'RBSP-A_MAGNETOMETER_4SEC-GSE_EMFISIS-L3', label: 'RBSP-A MAG Survey (4-sec)' },
        { value: 'RBSP-B_MAGNETOMETER_4SEC-GSE_EMFISIS-L3', label: 'RBSP-B MAG Survey (4-sec)' },
        { group: 'Waves (EMFISIS WFR, audio-band)' },
        { value: 'RBSP-A_WFR-WAVEFORM-CONTINUOUS-BURST_EMFISIS-L2', label: 'RBSP-A WFR Burst Waveform (35 kHz)' },
        { value: 'RBSP-B_WFR-WAVEFORM-CONTINUOUS-BURST_EMFISIS-L2', label: 'RBSP-B WFR Burst Waveform (35 kHz)' }
    ],
    'SolO': [
        { group: 'Magnetic Field' },
        { value: 'SOLO_L2_MAG-RTN-NORMAL', label: 'MAG Normal Mode' },
        { value: 'SOLO_L2_MAG-RTN-BURST', label: 'MAG Burst Mode' },
        { group: 'Electric Field' },
        { value: 'SOLO_L2_RPW-LFR-SURV-CWF-E', label: 'RPW LFR Electric Field' }
    ],
    'GOES': [
        { group: 'Magnetic Field' },
        { value: 'DN_MAGN-L2-HIRES_G16', label: 'GOES-16 MAG 10 Hz (Aug 2018 - Apr 2025)' },
        { value: 'DN_MAGN-L2-HIRES_G19', label: 'GOES-19 MAG 10 Hz (Jun 2025 - present)' }
    ],
    'ACE': [
        { group: 'Magnetic Field' },
        { value: 'AC_H3_MFI', label: 'MFI 1-sec GSE' }
    ],
    'DSCOVR': [
        { group: 'Magnetic Field' },
        { value: 'DSCOVR_H0_MAG', label: 'Fluxgate MAG 1-sec GSE' }
    ],
    'Cluster': [
        { group: 'Magnetic Field (FGM)' },
        { value: 'C1_CP_FGM_5VPS', label: 'C1 FGM 5 Vec/s' },
        { value: 'C2_CP_FGM_5VPS', label: 'C2 FGM 5 Vec/s' },
        { value: 'C3_CP_FGM_5VPS', label: 'C3 FGM 5 Vec/s' },
        { value: 'C4_CP_FGM_5VPS', label: 'C4 FGM 5 Vec/s' },
        { group: 'Magnetic Field (Search Coil)' },
        { value: 'C1_CP_STA_CWF_GSE', label: 'C1 STAFF CWF GSE' },
        { value: 'C2_CP_STA_CWF_GSE', label: 'C2 STAFF CWF GSE' },
        { value: 'C3_CP_STA_CWF_GSE', label: 'C3 STAFF CWF GSE' },
        { value: 'C4_CP_STA_CWF_GSE', label: 'C4 STAFF CWF GSE' },
        { group: 'Electric Field (EFW)' },
        { value: 'C1_CP_EFW_L3_E3D_INERT', label: 'C1 EFW E3D Inertial' },
        { value: 'C2_CP_EFW_L3_E3D_INERT', label: 'C2 EFW E3D Inertial' },
        { value: 'C3_CP_EFW_L3_E3D_INERT', label: 'C3 EFW E3D Inertial' },
        { value: 'C4_CP_EFW_L3_E3D_INERT', label: 'C4 EFW E3D Inertial' }
    ],
    'Geotail': [
        { group: 'Magnetic Field' },
        { value: 'GE_EDB3SEC_MGF', label: 'MGF Editor-B 3-sec GSE' },
        { group: 'Electric Field' },
        { value: 'GE_K0_EFD', label: 'EFD Spherical Probe' }
    ],
    'Voyager 1': [
        { group: 'Magnetic Field' },
        { value: 'VOYAGER1_2S_MAG', label: 'MAG 1.92-sec HG' }
    ],
    'Voyager 2': [
        { group: 'Magnetic Field' },
        { value: 'VOYAGER2_2S_MAG', label: 'MAG 1.92-sec HG' }
    ]
};

/**
 * Update the Data (dataType) dropdown based on the selected spacecraft
 * Called when spacecraft selection changes
 */
export function updateDatasetOptions() {
    const spacecraftSelect = document.getElementById('spacecraft');
    const dataTypeSelect = document.getElementById('dataType');

    if (!spacecraftSelect || !dataTypeSelect) {
        console.warn('Spacecraft or dataType select not found');
        return;
    }

    const spacecraft = spacecraftSelect.value;
    const datasets = SPACECRAFT_DATASETS[spacecraft] || [];

    if (datasets.length === 0) {
        if (CURRENT_MODE !== AppMode.EMIC_STUDY) {
            console.warn(`No datasets configured for spacecraft: ${spacecraft}`);
        }
        dataTypeSelect.innerHTML = '<option value="">No datasets available</option>';
        refreshSelectById('dataType');
        return;
    }

    // Populate the dataType dropdown with optgroup headers and options
    let html = '';
    let firstValue = true;
    let inGroup = false;
    for (const ds of datasets) {
        if (ds.group) {
            // Close previous optgroup if open
            if (inGroup) html += '</optgroup>';
            html += `<optgroup label="${ds.group}">`;
            inGroup = true;
        } else {
            html += `<option value="${ds.value}"${firstValue ? ' selected' : ''}>${ds.label}</option>`;
            firstValue = false;
        }
    }
    if (inGroup) html += '</optgroup>';
    dataTypeSelect.innerHTML = html;

    // Cache the full dropdown HTML so the inline script can restore it instantly next load
    localStorage.setItem('_dataTypeHTML', html);
    localStorage.setItem('_dataTypeSpacecraft', spacecraft);

    // Sync the custom select wrapper (if active) with the new options
    refreshSelectById('dataType');

    if (window.pm?.data) console.log(`📊 Updated dataset options for ${spacecraft}: ${datasets.length} datasets available`);
}


export function enableFetchButton() {
    const fetchBtn = document.getElementById('startBtn');
    const spacecraftSelect = document.getElementById('spacecraft');
    const currentSpacecraft = spacecraftSelect ? spacecraftSelect.value : null;
    const spacecraftWithData = State.spacecraftWithData;

    // If we're on the spacecraft that already has data, keep fetch button disabled
    if (spacecraftWithData && currentSpacecraft === spacecraftWithData) {
        fetchBtn.disabled = true;
        fetchBtn.title = 'This spacecraft already has data loaded. Select a different spacecraft to fetch new data.';
        console.log(`🚫 Fetch button remains disabled - ${currentSpacecraft} already has data`);
    } else {
        fetchBtn.disabled = false;
        fetchBtn.classList.remove('streaming');
        fetchBtn.title = '';
        console.log('✅ Fetch button re-enabled due to parameter change');
    }
}

export function changeBaseSampleRate() {
    updateHighPassFilterDisplay();
    updatePlaybackSpeed();
    updatePlaybackDuration();
}

export function updateHighPassFilterDisplay() {
    const baseSampleRateSelect = document.getElementById('baseSampleRate');
    const selectedRate = parseFloat(baseSampleRateSelect.value);
    const shorthand = formatSampleRateShorthand(selectedRate);
    
    const label = document.getElementById('highpassLabel');
    label.textContent = `High Pass (@ ${shorthand}):`;
    
    const highpassSelect = document.getElementById('highpassFreq');
    const selectedValue = highpassSelect.value;
    
    let originalSampleRate = 100;
    if (State.currentMetadata && State.currentMetadata.original_sample_rate) {
        originalSampleRate = State.currentMetadata.original_sample_rate;
    }
    
    const totalSpeedup = selectedRate / originalSampleRate;
    const freq001Hz = 0.01 * totalSpeedup;
    const freq002Hz = 0.02 * totalSpeedup;
    const freq0045Hz = 0.045 * totalSpeedup;
    
    const formatFreq = (freq) => {
        if (freq < 1) {
            return freq.toFixed(2) + ' Hz';
        } else if (freq < 10) {
            return freq.toFixed(1) + ' Hz';
        } else {
            return freq.toFixed(0) + ' Hz';
        }
    };
    
    const options = highpassSelect.options;
    options[0].text = 'None';
    options[1].text = `0.01 Hz (${formatFreq(freq001Hz)})`;
    options[2].text = `0.02 Hz (${formatFreq(freq002Hz)})`;
    options[3].text = `0.045 Hz (${formatFreq(freq0045Hz)})`;
    
    highpassSelect.value = selectedValue;
}

export function formatSampleRateShorthand(rate) {
    if (rate >= 1000000) {
        return (rate / 1000000).toFixed(0) + 'M';
    } else if (rate >= 1000) {
        const khz = rate / 1000;
        return khz % 1 === 0 ? khz.toFixed(0) + 'k' : khz.toFixed(1) + 'k';
    }
    return rate.toString();
}

export function updatePlaybackDuration() {
    // This is duplicated from audio-player.js - needs to be imported or refactored
    // For now, keeping it here to avoid circular dependencies
    
    // 🔥 FIX: Check document connection before DOM manipulation
    if (!document.body || !document.body.isConnected) {
        return;
    }
    
    // 🔥 FIX: Copy State values to local variables to avoid closure retention
    // Access State only once and copy values immediately
    const currentMetadata = State.currentMetadata;
    const allReceivedData = State.allReceivedData;
    
    if (!currentMetadata || !allReceivedData || allReceivedData.length === 0) {
        const playbackDurationEl = document.getElementById('playbackDuration');
        if (playbackDurationEl && playbackDurationEl.isConnected) {
            playbackDurationEl.textContent = '--';
        }
        return;
    }
    
    // 🔥 FIX: Use npts from metadata if available, otherwise calculate from array
    // Copy array reference to local variable to avoid retaining State reference
    const totalSamples = currentMetadata.npts || allReceivedData.reduce((sum, chunk) => sum + (chunk ? chunk.length : 0), 0);
    const originalSampleRate = currentMetadata.original_sample_rate;
    
    if (!totalSamples || !originalSampleRate) {
        const playbackDurationEl = document.getElementById('playbackDuration');
        if (playbackDurationEl && playbackDurationEl.isConnected) {
            playbackDurationEl.textContent = '--';
        }
        return;
    }
    
    const slider = document.getElementById('playbackSpeed');
    const sliderValue = parseFloat(slider.value);
    
    let baseSpeed;
    if (sliderValue <= 667) {
        const normalized = sliderValue / 667;
        baseSpeed = 0.1 * Math.pow(10, normalized);
    } else {
        const normalized = (sliderValue - 667) / 333;
        baseSpeed = Math.pow(15, normalized);
    }
    
    const baseSampleRateSelect = document.getElementById('baseSampleRate');
    const selectedRate = parseFloat(baseSampleRateSelect.value);
    const multiplier = selectedRate / 44100;
    
    const AUDIO_CONTEXT_SAMPLE_RATE = 44100;
    const originalDuration = totalSamples / originalSampleRate;
    const baseSpeedup = AUDIO_CONTEXT_SAMPLE_RATE / originalSampleRate;
    const totalSpeed = baseSpeedup * multiplier * baseSpeed;
    const playbackDurationSeconds = originalDuration / totalSpeed;
    
    window.playbackDurationSeconds = playbackDurationSeconds;
    
    const minutes = Math.floor(playbackDurationSeconds / 60);
    const seconds = Math.floor(playbackDurationSeconds % 60);
    
    const durationText = minutes > 0 ? `${minutes}m ${seconds}s` : `0m ${seconds}s`;
    
    // 🔥 FIX: Check element connection before updating DOM
    const playbackDurationEl = document.getElementById('playbackDuration');
    if (playbackDurationEl && playbackDurationEl.isConnected) {
        playbackDurationEl.textContent = durationText;
    }
}

export async function purgeCloudflareCache() {
    const btn = document.getElementById('purgeCacheBtn');
    const originalText = btn.textContent;
    
    try {
        btn.disabled = true;
        btn.textContent = '⏳ Purging...';
        
        const WORKER_URL = 'https://volcano-audio-cache-purge.robertalexander-music.workers.dev';
        
        const response = await fetch(WORKER_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        const result = await response.json();
        
        if (result.success) {
            btn.textContent = '✅ Purged!';
            console.log('✅ CDN cache purged successfully at:', result.timestamp);
            setTimeout(() => {
                btn.textContent = originalText;
                btn.disabled = false;
            }, 2000);
        } else {
            throw new Error(result.error || 'Purge failed');
        }
    } catch (error) {
        console.error('❌ Cache purge error:', error);
        btn.textContent = '❌ Failed';
        setTimeout(() => {
            btn.textContent = originalText;
            btn.disabled = false;
        }, 2000);
    }
}

// Waveform filter controls (wrapper functions)
export function handleWaveformFilterChange() {
    changeWaveformFilter();
}

export function resetWaveformFilterToDefault() {
    const slider = document.getElementById('waveformFilterSlider');
    slider.value = 50;
    changeWaveformFilter();
}

