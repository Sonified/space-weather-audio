// advanced-controls.js -- Advanced settings control wiring and localStorage persistence

import * as State from './audio-state.js';
import { redrawAllCanvasFeatureBoxes } from './spectrogram-renderer.js';
import { loadRegionsAfterDataFetch } from './feature-tracker.js';
import { drawWaveformFromMinMax } from './minimap-window-renderer.js';
import {
    updateSpectrogramViewport,
    updateSpectrogramViewportFromZoom,
    setTileShaderMode,
    setLevelTransitionMode,
    setCrossfadePower,
    setCatmullSettings,
    setWaveformPanMode,
    setSpectrogramGainContrast,
    setNormalizationMode
} from './main-window-renderer.js';
import { setPyramidReduceMode, rebuildUpperLevels } from './spectrogram-pyramid.js';
import { drawSpectrogramXAxis, positionSpectrogramXAxisCanvas } from './spectrogram-x-axis-renderer.js';
import { drawMinimapXAxis } from './minimap-x-axis-renderer.js';
import { drawDayMarkers } from './day-markers.js';
import { initDataViewer, fetchUsers } from './data-viewer.js';
import { zoomState } from './zoom-state.js';
import { isStudyMode, isLocalEnvironment } from './master-modes.js';
import { isAdminUnlocked } from './admin-unlock.js';
import { getRealUsernameStored, getActiveId } from './participant-id.js';
import { pm } from './logger.js';
const upgradeAllSelects = window.__customSelect?.upgradeAllSelects || (() => new Map());
import { injectSettingsDrawer, injectGearPopovers } from './settings-drawer.js';

export function initializeAdvancedControls() {
    // Inject the settings drawer + hamburger button into the DOM
    injectSettingsDrawer();
    // Inject gear popover content into shell divs
    injectGearPopovers();

    // Button lift on hover
    const buttonLift = false;
    document.documentElement.style.setProperty('--btn-lift', buttonLift ? 'translateY(-1px)' : 'none');

    // Persist all navigation panel controls to localStorage
    const navControls = [
        { id: 'viewingMode', key: 'emic_viewing_mode', type: 'select' },
        { id: 'navBarClick', key: 'emic_navbar_click', type: 'select' },
        { id: 'mainWindowClick', key: 'emic_main_click_mode', type: 'select' },
        { id: 'mainWindowRelease', key: 'emic_main_release', type: 'select' },
        { id: 'mainWindowDrag', key: 'emic_main_drag', type: 'select' },
        { id: 'navBarScroll', key: 'emic_navbar_scroll', type: 'select' },
        { id: 'navBarVSens', key: 'emic_navbar_vsens', type: 'select' },
        { id: 'navBarHScroll', key: 'emic_navbar_hscroll', type: 'select' },
        { id: 'navBarHSens', key: 'emic_navbar_hsens', type: 'select' },
        { id: 'mainWindowScroll', key: 'emic_main_scroll', type: 'select' },
        { id: 'mainWindowVSens', key: 'emic_main_vsens', type: 'select' },
        { id: 'mainWindowHScroll', key: 'emic_main_hscroll', type: 'select' },
        { id: 'mainWindowHSens', key: 'emic_main_hsens', type: 'select' },
        { id: 'miniMapView', key: 'emic_minimap_view', type: 'select' },
        { id: 'mainWindowView', key: 'emic_main_view', type: 'select' },
        { id: 'navBarMarkers', key: 'emic_navbar_markers', type: 'select' },
        { id: 'navBarFeatureBoxes', key: 'emic_navbar_feature_boxes', type: 'select' },
        { id: 'mainWindowMarkers', key: 'emic_main_markers', type: 'select' },
        { id: 'mainWindowXAxis', key: 'emic_main_xaxis', type: 'select' },
        { id: 'mainWindowNumbers', key: 'emic_main_numbers', type: 'select' },
        { id: 'mainWindowNumbersLoc', key: 'emic_main_numbers_loc', type: 'select' },
        { id: 'mainWindowNumbersWeight', key: 'emic_main_numbers_weight', type: 'select' },
        { id: 'mainWindowNumbersSize', key: 'emic_main_numbers_size', type: 'select' },
        { id: 'mainWindowNumbersShadow', key: 'emic_main_numbers_shadow', type: 'select' },
        { id: 'featureBoxesVisible', key: 'emic_feature_boxes_visible', type: 'checkbox' },
        { id: 'participantIdMode', key: 'emic_participant_id_mode', type: 'select' },
        { id: 'pidCornerDisplay', key: 'emic_pid_corner_display', type: 'select' },
        { id: 'skipLoginWelcome', key: 'emic_skip_login_welcome', type: 'checkbox' },
        { id: 'displayOnLoad', key: 'emic_display_on_load', type: 'select' },
        { id: 'initialHours', key: 'emic_initial_hours', type: 'select' },
        { id: 'arrowZoomStep', key: 'emic_arrow_zoom_step', type: 'select' },
        { id: 'arrowPanStep', key: 'emic_arrow_pan_step', type: 'select' },
        { id: 'mainWindowBoxFilter', key: 'emic_main_box_filter', type: 'select' },
        { id: 'mainWindowZoomOut', key: 'emic_zoom_out_mode', type: 'select' },
        { id: 'levelTransition', key: 'emic_level_transition', type: 'select' },
        { id: 'crossfadePower', key: 'emic_crossfade_power', type: 'range' },
        { id: 'catmullMode', key: 'emic_catmull_mode', type: 'select' },
        { id: 'catmullThreshold', key: 'emic_catmull_threshold', type: 'select' },
        { id: 'catmullCore', key: 'emic_catmull_core', type: 'range' },
        { id: 'catmullFeather', key: 'emic_catmull_feather', type: 'range' },
        { id: 'waveformPanMode', key: 'emic_waveform_pan_mode', type: 'select' },
        { id: 'renderOrder', key: 'emic_render_order', type: 'select' },
        { id: 'audioQuality', key: 'emic_audio_quality', type: 'select' },
        { id: 'tileChunkSize', key: 'emic_tile_chunk_size', type: 'select' },
        { id: 'featurePlaybackMode', key: 'emic_feature_playback_mode', type: 'select' },
        { id: 'annotationMode', key: 'emic_annotation_mode', type: 'select' },
        { id: 'dataSource', key: 'emic_data_source', type: 'select' },
        { id: 'drawerBypassCache', key: 'emic_bypass_cache', type: 'checkbox' },
        { id: 'silentDownload', key: 'emic_silent_download', type: 'checkbox' },
        { id: 'autoDownload', key: 'emic_auto_download', type: 'checkbox' },
        { id: 'autoPlay', key: 'emic_auto_play', type: 'checkbox' },
        { id: 'dataRendering', key: 'emic_data_rendering', type: 'select' },
        { id: 'tickFadeInTime', key: 'emic_tick_fade_in', type: 'range' },
        { id: 'tickFadeOutTime', key: 'emic_tick_fade_out', type: 'range' },
        { id: 'tickFadeInCurve', key: 'emic_tick_fade_in_curve', type: 'select' },
        { id: 'tickFadeOutCurve', key: 'emic_tick_fade_out_curve', type: 'select' },
        { id: 'tickZoomFadeMode', key: 'emic_tick_zoom_fade_mode', type: 'select' },
        { id: 'tickZoomSpatialCurve', key: 'emic_tick_zoom_spatial_curve', type: 'select' },
        { id: 'tickZoomSpatialWidth', key: 'emic_tick_zoom_spatial_width', type: 'range' },
        { id: 'tickEdgeFadeMode', key: 'emic_tick_edge_fade_mode', type: 'select' },
        { id: 'tickEdgeFadeCurve', key: 'emic_tick_edge_fade_curve', type: 'select' },
        { id: 'tickEdgeSpatialWidth', key: 'emic_tick_edge_spatial_width', type: 'range' },
        { id: 'tickEdgeTimeIn', key: 'emic_tick_edge_time_in', type: 'range' },
        { id: 'tickEdgeTimeOut', key: 'emic_tick_edge_time_out', type: 'range' },
        { id: 'printInit', key: 'emic_print_init', type: 'checkbox' },
        { id: 'printGPU', key: 'emic_print_gpu', type: 'checkbox' },
        { id: 'printMemory', key: 'emic_print_memory', type: 'checkbox' },
        { id: 'printAudio', key: 'emic_print_audio', type: 'checkbox' },
        { id: 'printStudy', key: 'emic_print_study', type: 'checkbox' },
        { id: 'printFeatures', key: 'emic_print_features', type: 'checkbox' },
        { id: 'printData', key: 'emic_print_data', type: 'checkbox' },
        { id: 'printD1', key: 'emic_print_d1', type: 'checkbox' },
        { id: 'printInteraction', key: 'emic_print_interaction', type: 'checkbox' },
        // Waveform de-trend controls (in main controls row, not settings drawer)
        { id: 'removeDCOffset', key: 'emic_detrend', type: 'checkbox' },
        { id: 'waveformFilterSlider', key: 'emic_detrend_alpha', type: 'range' },
    ];
    // Page-specific localStorage: emic_study keeps 'emic_*' keys, index.html uses 'main_*'
    const settingsPrefix = isStudyMode() ? 'emic_' : 'main_';
    for (const ctrl of navControls) {
        const el = document.getElementById(ctrl.id);
        if (!el) continue;
        const storageKey = ctrl.key.replace(/^emic_/, settingsPrefix);
        const saved = localStorage.getItem(storageKey);
        if (ctrl.type === 'checkbox') {
            if (saved !== null) el.checked = saved === 'true';
            el.addEventListener('change', () => localStorage.setItem(storageKey, el.checked));
        } else {
            if (saved !== null) {
                el.value = saved;
                if (ctrl.type === 'range') {
                    // Range inputs normalize values (e.g. "0.50" → "0.5"), so compare as numbers
                    if (Math.abs(parseFloat(el.value) - parseFloat(saved)) > 1e-9) {
                        localStorage.removeItem(storageKey);
                    }
                } else if (el.value !== saved) {
                    localStorage.removeItem(storageKey);
                    el.selectedIndex = 0;
                }
            }
            el.addEventListener('change', () => {
                localStorage.setItem(storageKey, el.value);
                el.blur();
            });
            if (ctrl.type === 'range') {
                el.addEventListener('input', () => localStorage.setItem(storageKey, el.value));
            }
        }
    }

    // Auto play defaults: ON for index.html, OFF for EMIC (unless user saved a preference)
    const autoPlayEl = document.getElementById('autoPlay');
    if (autoPlayEl) {
        const apKey = (isStudyMode() ? 'emic_' : 'main_') + 'auto_play';
        if (localStorage.getItem(apKey) === null) {
            autoPlayEl.checked = !isStudyMode();
        }
    }

    // Sync Prints checkboxes → pm flags (restore from localStorage + live toggle)
    const printMap = { printInit: 'init', printGPU: 'rendering', printMemory: 'memory', printAudio: 'audio', printStudy: 'study_flow', printFeatures: 'features', printData: 'data', printD1: 'd1', printInteraction: 'interaction' };
    for (const [id, pmKey] of Object.entries(printMap)) {
        const el = document.getElementById(id);
        if (!el) continue;
        pm[pmKey] = el.checked;
        if (pmKey === 'data') pm.cache = el.checked; // Data checkbox also controls cache logs
        el.addEventListener('change', () => {
            pm[pmKey] = el.checked;
            // Data checkbox also controls cache logs
            if (pmKey === 'data') pm.cache = el.checked;
            // Forward audio debug flag to worklet/stretch threads
            if (pmKey === 'audio') {
                const msg = { type: 'set-debug-audio', enabled: el.checked };
                State.workletNode?.port.postMessage(msg);
                State.stretchNode?.port.postMessage(msg);
                if (State.stretchNodes) {
                    for (const node of Object.values(State.stretchNodes)) {
                        node?.port.postMessage(msg);
                    }
                }
            }
        });
    }

    // Upgrade all native <select> elements to custom styled dropdowns
    const cselInstances = upgradeAllSelects();

    // Auto-download: only in study mode (portal users control when to fetch)
    const _adEl = document.getElementById('autoDownload');
    console.log(`🔧 autoDownload checkbox: checked=${_adEl?.checked}, localStorage=${localStorage.getItem(isStudyMode() ? 'emic_auto_download' : 'main_auto_download')}, studyMode=${isStudyMode()}`);
    if (isStudyMode() && _adEl?.checked) {
        setTimeout(() => {
            const fetchBtn = document.getElementById('startBtn');
            if (fetchBtn && !fetchBtn.disabled) {
                if (window.pm?.init) console.log('🚀 Auto-download enabled, triggering data fetch...');
                fetchBtn.click();
            }
        }, 500);
    }

    // Page-specific defaults (applied only when no saved value exists)
    if (!isStudyMode()) {
        const miniMapEl = document.getElementById('miniMapView');
        if (miniMapEl && !localStorage.getItem('main_minimap_view')) miniMapEl.value = 'both';
    }

    // Toggle feature boxes visibility immediately on change
    const fbVisCheckbox = document.getElementById('featureBoxesVisible');
    if (fbVisCheckbox) {
        fbVisCheckbox.addEventListener('change', () => {
            redrawAllCanvasFeatureBoxes();
            drawWaveformFromMinMax();
        });
    }

    // Sync mainWindowMode with viewingMode (both share the same localStorage key)
    const _mwMode = document.getElementById('mainWindowMode');
    const _vmMode = document.getElementById('viewingMode');
    if (_mwMode && _vmMode) {
        // On load, sync mainWindowMode to match viewingMode's restored value
        _mwMode.value = _vmMode.value;
        // On change of either, persist and sync
        _mwMode.addEventListener('change', () => {
            localStorage.setItem('emic_viewing_mode', _mwMode.value);
        });
    }

    // Wire up sensitivity selects: disable when paired scroll setting is off
    function updateSensPaired() {
        document.querySelectorAll('select[data-paired]').forEach(sensEl => {
            const pairedId = sensEl.dataset.paired;
            const pairedEl = document.getElementById(pairedId);
            if (!pairedEl) return;
            const isOff = pairedEl.value === 'none';
            sensEl.disabled = isOff;
            sensEl.style.opacity = isOff ? '0.4' : '1';
        });
    }
    updateSensPaired();
    ['navBarScroll', 'navBarHScroll', 'mainWindowScroll', 'mainWindowHScroll'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', updateSensPaired);
    });

    // Minimap mode change: re-render waveform with new mode
    const miniMapViewEl = document.getElementById('miniMapView');
    if (miniMapViewEl) {
        miniMapViewEl.addEventListener('change', () => {
            drawWaveformFromMinMax();
        });
    }

    // Main window mode change: re-render spectrogram/waveform with new mode
    const mainWindowViewEl = document.getElementById('mainWindowView');
    if (mainWindowViewEl) {
        mainWindowViewEl.addEventListener('change', () => {
            updateSpectrogramViewport(State.getPlaybackRate());
        });
    }

    // Main window x-axis toggle: show/hide spectrogram ticks + margin
    const mainWindowXAxisEl = document.getElementById('mainWindowXAxis');
    if (mainWindowXAxisEl) {
        const applyXAxisVisibility = () => {
            const show = mainWindowXAxisEl.value !== 'hide';
            const xAxisCanvas = document.getElementById('spectrogram-x-axis');
            const spectrogramCanvas = document.getElementById('spectrogram');
            if (xAxisCanvas) xAxisCanvas.style.display = show ? '' : 'none';
            if (spectrogramCanvas) spectrogramCanvas.style.marginBottom = show ? '30px' : '0';
            if (show) {
                positionSpectrogramXAxisCanvas();
                drawSpectrogramXAxis();
            }
        };
        applyXAxisVisibility();
        mainWindowXAxisEl.addEventListener('change', applyXAxisVisibility);
    }

    // --- Settings drawer (hamburger menu, push layout) ---
    const drawerEl = document.getElementById('settingsDrawer');
    const hamburgerBtn = document.getElementById('hamburgerBtn');
    const drawerCloseBtn = document.getElementById('drawerClose');

    function openSettingsDrawer() {
        if (drawerEl) drawerEl.classList.add('open');
        document.body.classList.add('drawer-open');
        setTimeout(() => window.dispatchEvent(new Event('resize')), 260);
    }
    function closeSettingsDrawer() {
        if (drawerEl) drawerEl.classList.remove('open');
        document.body.classList.remove('drawer-open');
        setTimeout(() => window.dispatchEvent(new Event('resize')), 260);
    }

    // --- Advanced mode toggle: controls visibility of all dev/admin UI ---
    const advancedCheckbox = document.getElementById('advancedMode');
    const advancedToggle = document.getElementById('advancedToggle');

    // Two display states: production (!isAdvanced) and advanced (isAdvanced)
    function applyDisplayMode(isAdvanced) {
        // Sync data attribute (used by early CSS to prevent flash)
        if (isAdvanced) {
            document.documentElement.setAttribute('data-advanced', '');
        } else {
            document.documentElement.removeAttribute('data-advanced');
        }

        // Sync checkbox
        if (advancedCheckbox) advancedCheckbox.checked = isAdvanced;

        // Gears: always visible on live portal, advanced-only in study/local
        const gearContainers = document.querySelectorAll('.panel-gear');
        const alwaysShowGears = !isStudyMode() && !isLocalEnvironment();
        gearContainers.forEach(g => g.style.display = (alwaysShowGears || isAdvanced) ? 'block' : 'none');
        if (isStudyMode()) {
            const hBtn = document.getElementById('hamburgerBtn');
            if (hBtn) hBtn.style.display = isAdvanced ? 'block' : 'none';
        }
        const questionnairesPanel = document.getElementById('questionnairesPanel');
        if (questionnairesPanel) questionnairesPanel.style.display = isAdvanced ? '' : 'none';
        if (!isAdvanced) closeSettingsDrawer();

        // Component selector + de-trend: advanced only
        const compContainer = document.getElementById('componentSelectorContainer');
        if (compContainer) compContainer.style.display = isAdvanced ? '' : 'none';
        const detrendContainer = document.getElementById('detrendContainer');
        if (detrendContainer) detrendContainer.style.display = isAdvanced ? '' : 'none';

        // Spectrogram controls (FFT, colormap, freq scale): advanced-only in EMIC, always visible in Space Weather Portal
        const spectrogramControls = document.querySelector('.spectrogram-controls');
        if (spectrogramControls && isStudyMode()) {
            spectrogramControls.style.visibility = isAdvanced ? 'visible' : 'hidden';
            spectrogramControls.style.pointerEvents = isAdvanced ? '' : 'none';
        }

        // Stretch + Speed button groups: advanced only
        const stretchGroup = document.getElementById('stretchGroup');
        if (stretchGroup) stretchGroup.style.display = isAdvanced ? '' : 'none';
        const speedGroup = document.getElementById('speedGroup');
        if (speedGroup) speedGroup.style.display = isAdvanced ? '' : 'none';

        // Participant ID display (top right): on study.html, study-flow.js owns this
        const isStudyPage = !!window.__STUDY_FLOW_MANAGED;
        const pidDisplay = document.getElementById('participantIdDisplay');
        if (pidDisplay && !isStudyPage) {
            const cornerSetting = document.getElementById('pidCornerDisplay')?.value || 'show';
            pidDisplay.style.display = (!isAdvanced && cornerSetting === 'hide') ? 'none' : '';
        }

        // Show the correct ID and label for the current context
        const pidValue = document.getElementById('participantIdValue');
        const pidLabel = document.getElementById('participantIdLabel');
        if (pidValue && !isStudyPage) {
            const activeId = getActiveId();
            pidValue.textContent = activeId !== 'anonymous' ? activeId : '--';
        }
        if (pidLabel && !isStudyPage) {
            pidLabel.textContent = 'User ID';
        }

        // EMIC controls panel (Fetch Data) is always hidden on study pages via CSS
        // Component and De-trend are toggled independently above

        // Move #status between controls panel and playback bar based on mode
        const statusEl = document.getElementById('status');
        if (statusEl) {
            const anchor = isAdvanced
                ? document.getElementById('statusAnchorControls')
                : document.getElementById('statusAnchorPlayback');
            if (anchor && statusEl.parentElement !== anchor) {
                anchor.appendChild(statusEl);
            }
        }

        // Data Viewer panel: independent toggle, don't touch it here
    }

    // Admin-only buttons visibility handled by CSS (.admin-only + data-admin attribute)

    // Data Viewer: independent toggle button
    const dvBtn = document.getElementById('dataViewerBtn');
    const dvPanel = document.getElementById('dataViewerPanel');
    if (dvBtn && dvPanel) {
        initDataViewer();
        let dvLoaded = false;
        dvBtn.addEventListener('click', () => {
            const showing = dvPanel.style.display === 'block';
            dvPanel.style.display = showing ? 'none' : 'block';
            dvBtn.style.background = showing ? '' : '#2a6';
            if (!showing && !dvLoaded) {
                fetchUsers();
                dvLoaded = true;
            }
            // Let spectrogram resize to fit
            setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
        });
    }

    if (advancedCheckbox) {
        // Restore saved preference — only allow advanced on localhost
        if (isLocalEnvironment()) {
            const savedAdvanced = localStorage.getItem('study_advanced_mode') || localStorage.getItem('emic_advanced_mode');
            advancedCheckbox.checked = savedAdvanced !== null ? savedAdvanced === 'true' : true;
        } else {
            advancedCheckbox.checked = false;
        }
        applyDisplayMode(advancedCheckbox.checked);

        advancedCheckbox.addEventListener('change', () => {
            localStorage.setItem('study_advanced_mode', advancedCheckbox.checked);
            localStorage.setItem('emic_advanced_mode', advancedCheckbox.checked);
            applyDisplayMode(advancedCheckbox.checked);
            updateControlsVisibility();
            // Reload features for the new active ID and redraw (if data is loaded)
            // On study.html, participant ID doesn't change with advanced toggle
            if (State.currentMetadata?.spacecraft && !window.__STUDY_FLOW_MANAGED) {
                loadRegionsAfterDataFetch();
                requestAnimationFrame(() => redrawAllCanvasFeatureBoxes());
            }
        });
    }
    if (hamburgerBtn) hamburgerBtn.addEventListener('click', () => {
        if (drawerEl?.classList.contains('open')) closeSettingsDrawer();
        else openSettingsDrawer();
    });
    if (drawerCloseBtn) drawerCloseBtn.addEventListener('click', closeSettingsDrawer);

    // --- Lock page scroll checkbox ---
    const lockScrollCb = document.getElementById('lockPageScroll');
    if (lockScrollCb) {
        lockScrollCb.addEventListener('change', () => {
            if (lockScrollCb.checked) {
                const scrollY = window.pageYOffset || document.documentElement.scrollTop;
                document.documentElement.style.overflow = 'hidden';
                document.body.style.overflow = 'hidden';
                document.body.style.position = 'fixed';
                document.body.style.top = `-${scrollY}px`;
                document.body.style.width = '100%';
            } else {
                const top = Math.abs(parseInt(document.body.style.top || '0', 10));
                document.documentElement.style.overflow = '';
                document.body.style.overflow = '';
                document.body.style.position = '';
                document.body.style.top = '';
                document.body.style.width = '';
                window.scrollTo(0, top);
            }
        });
    }

    // --- Panel height inputs in settings drawer ---
    const heightMinimapInput = document.getElementById('heightMinimap');
    const heightSpectrogramInput = document.getElementById('heightSpectrogram');
    const wfEl_ = document.getElementById('minimap');
    const specEl_ = document.getElementById('spectrogram');
    if (heightMinimapInput && wfEl_) heightMinimapInput.value = wfEl_.offsetHeight;
    if (heightSpectrogramInput && specEl_) heightSpectrogramInput.value = specEl_.offsetHeight;

    function applyPanelHeight(input, canvasId, axisId, buttonsId) {
        const h = parseInt(input.value);
        const min = parseInt(input.dataset.min || 0);
        const max = parseInt(input.dataset.max || 9999);
        if (isNaN(h) || h < min || h > max) return;
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        canvas.style.height = h + 'px';
        canvas.height = h;
        const companions = [axisId, buttonsId].filter(Boolean);
        for (const id of companions) {
            const el = document.getElementById(id);
            if (el) el.height = h;
        }
        window.dispatchEvent(new Event('resize'));
    }

    if (heightMinimapInput) {
        heightMinimapInput.addEventListener('change', () =>
            applyPanelHeight(heightMinimapInput, 'waveform', 'waveform-axis', 'waveform-buttons'));
    }
    if (heightSpectrogramInput) {
        heightSpectrogramInput.addEventListener('change', () =>
            applyPanelHeight(heightSpectrogramInput, 'spectrogram', 'spectrogram-axis', null));
    }

    // Min UI width
    const MIN_UI_WIDTH_DEFAULT = 1200;
    const minUIWidthInput = document.getElementById('minUIWidth');
    const containerEl = document.querySelector('.container');
    if (minUIWidthInput && containerEl) {
        const saved = localStorage.getItem('minUIWidth');
        const val = saved ? parseInt(saved) : MIN_UI_WIDTH_DEFAULT;
        minUIWidthInput.value = val;
        if (val > 0) containerEl.style.minWidth = val + 'px';
        minUIWidthInput.addEventListener('change', () => {
            const v = parseInt(minUIWidthInput.value);
            if (isNaN(v) || v < 0) return;
            containerEl.style.minWidth = v > 0 ? v + 'px' : '';
            localStorage.setItem('minUIWidth', v);
        });
    }

    // --- Annotation width spinner ---
    const annotWidthInput = document.getElementById('annotationWidth');
    if (annotWidthInput) {
        const saved = localStorage.getItem('annotationWidth');
        annotWidthInput.value = saved ? parseInt(saved) : 325;
        annotWidthInput.addEventListener('change', () => {
            const v = parseInt(annotWidthInput.value);
            if (isNaN(v) || v < 100) return;
            localStorage.setItem('annotationWidth', v);
        });
    }

    // --- Annotation font size spinner ---
    const annotFontInput = document.getElementById('annotationFontSize');
    if (annotFontInput) {
        const saved = localStorage.getItem('annotationFontSize');
        annotFontInput.value = saved ? parseInt(saved) : 13;
        annotFontInput.addEventListener('change', () => {
            const v = parseInt(annotFontInput.value);
            if (isNaN(v) || v < 8) return;
            localStorage.setItem('annotationFontSize', v);
        });
    }

    // --- Spectrogram gain & contrast sliders ---
    const gainSlider = document.getElementById('spectrogramGain');
    const contrastSlider = document.getElementById('spectrogramContrast');
    if (gainSlider && contrastSlider) {
        const gainLabel = document.getElementById('spectrogramGainValue');
        const contrastLabel = document.getElementById('spectrogramContrastValue');
        // Restore saved values (study mode only — portal always uses defaults)
        const savedGain = isStudyMode() ? localStorage.getItem(`${settingsPrefix}spectrogram_gain`) : null;
        const savedContrast = isStudyMode() ? localStorage.getItem(`${settingsPrefix}spectrogram_contrast`) : null;
        if (savedGain !== null) gainSlider.value = savedGain;
        if (savedContrast !== null) contrastSlider.value = savedContrast;
        const updateGainContrast = () => {
            const g = parseFloat(gainSlider.value);
            const c = parseFloat(contrastSlider.value);
            if (gainLabel) gainLabel.textContent = `${g > 0 ? '+' : ''}${g} dB`;
            if (contrastLabel) contrastLabel.textContent = c;
            localStorage.setItem(`${settingsPrefix}spectrogram_gain`, g);
            localStorage.setItem(`${settingsPrefix}spectrogram_contrast`, c);
            setSpectrogramGainContrast(g, c);
        };
        gainSlider.addEventListener('input', updateGainContrast);
        contrastSlider.addEventListener('input', updateGainContrast);
        // Click label or Option-click slider to reset to default
        const gainLabelEl = document.getElementById('spectrogramGainLabel');
        const contrastLabelEl = document.getElementById('spectrogramContrastLabel');
        if (gainLabelEl) gainLabelEl.addEventListener('click', (e) => {
            e.preventDefault();
            gainSlider.value = 0;
            updateGainContrast();
        });
        if (contrastLabelEl) contrastLabelEl.addEventListener('click', (e) => {
            e.preventDefault();
            contrastSlider.value = 100;
            updateGainContrast();
        });
        gainSlider.addEventListener('click', (e) => {
            if (e.altKey) { gainSlider.value = 0; updateGainContrast(); }
        });
        contrastSlider.addEventListener('click', (e) => {
            if (e.altKey) { contrastSlider.value = 100; updateGainContrast(); }
        });
        // Apply restored values on init
        if (savedGain !== null || savedContrast !== null) updateGainContrast();
    }

    // --- Spectrogram normalization dropdown ---
    const normalizeSelect = document.getElementById('spectrogramNormalize');
    if (normalizeSelect) {
        const savedNorm = localStorage.getItem(`${settingsPrefix}spectrogram_normalize`);
        if (savedNorm !== null) normalizeSelect.value = savedNorm;
        normalizeSelect.addEventListener('change', () => {
            localStorage.setItem(`${settingsPrefix}spectrogram_normalize`, normalizeSelect.value);
            setNormalizationMode(normalizeSelect.value);
        });
    }

    // --- Custom spinner buttons for number inputs ---
    document.querySelectorAll('.spinner-btn').forEach(btn => {
        const inputId = btn.dataset.for;
        const input = document.getElementById(inputId);
        if (!input) return;
        const step = parseInt(input.dataset.step || 1);
        const min = parseInt(input.dataset.min || 0);
        const max = parseInt(input.dataset.max || 9999);
        const isInc = btn.classList.contains('spinner-inc');
        let holdTimer = null;
        let holdInterval = null;

        function nudge() {
            let val = parseInt(input.value) || 0;
            val = isInc ? Math.min(val + step, max) : Math.max(val - step, min);
            input.value = val;
            input.dispatchEvent(new Event('change'));
        }

        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            nudge();
            holdTimer = setTimeout(() => {
                holdInterval = setInterval(nudge, 100);
            }, 400);
        });
        btn.addEventListener('mouseup', () => { clearTimeout(holdTimer); clearInterval(holdInterval); });
        btn.addEventListener('mouseleave', () => { clearTimeout(holdTimer); clearInterval(holdInterval); });
    });

    // Position gear icons over their respective canvases (top-right corner)
    function positionGearIcons() {
        const wfCanvas = document.getElementById('minimap');
        const navGear = document.getElementById('navBarGear');
        if (wfCanvas && navGear) {
            navGear.style.top = (wfCanvas.offsetTop + 2) + 'px';
            navGear.style.right = 'auto';
            navGear.style.left = (wfCanvas.offsetLeft + wfCanvas.offsetWidth - 32) + 'px';
        }
        const specCanvas = document.getElementById('spectrogram');
        const mainGear = document.getElementById('mainWindowGear');
        if (specCanvas && mainGear) {
            mainGear.style.top = (specCanvas.offsetTop + 2) + 'px';
            mainGear.style.right = 'auto';
            mainGear.style.left = (specCanvas.offsetLeft + specCanvas.offsetWidth - 32) + 'px';
        }
    }
    positionGearIcons();
    const wfEl = document.getElementById('minimap');
    const specEl = document.getElementById('spectrogram');
    if (wfEl) new ResizeObserver(positionGearIcons).observe(wfEl);
    if (specEl) new ResizeObserver(positionGearIcons).observe(specEl);

    // Toggle popover on gear click, close on click-outside
    document.querySelectorAll('.gear-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const popover = btn.nextElementSibling;
            const wasOpen = popover.classList.contains('open');
            document.querySelectorAll('.gear-popover').forEach(p => {
                p.classList.remove('open');
                p.closest('.panel-gear').style.zIndex = '30';
            });
            if (!wasOpen) {
                popover.classList.add('open');
                popover.closest('.panel-gear').style.zIndex = '35';
            }
        });
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.gear-popover') && !e.target.closest('.gear-btn')) {
            document.querySelectorAll('.gear-popover').forEach(p => {
                p.classList.remove('open');
                p.closest('.panel-gear').style.zIndex = '30';
            });
        }
    });
    document.querySelectorAll('.gear-select').forEach(sel => {
        sel.addEventListener('change', () => sel.blur());
    });

    // Wire per-panel day markers dropdowns to redraw
    const navBarMarkersEl = document.getElementById('navBarMarkers');
    const mainWindowMarkersEl = document.getElementById('mainWindowMarkers');
    if (navBarMarkersEl) navBarMarkersEl.addEventListener('change', () => drawDayMarkers());
    const navBarFeatBoxesEl = document.getElementById('navBarFeatureBoxes');
    if (navBarFeatBoxesEl) navBarFeatBoxesEl.addEventListener('change', () => drawWaveformFromMinMax());
    if (mainWindowMarkersEl) mainWindowMarkersEl.addEventListener('change', () => drawDayMarkers());
    if ((navBarMarkersEl && navBarMarkersEl.value !== 'none') ||
        (mainWindowMarkersEl && mainWindowMarkersEl.value !== 'none')) {
        drawDayMarkers();
    }

    // Wire Numbers dropdowns to redraw feature boxes
    const mainWindowNumbersEl = document.getElementById('mainWindowNumbers');
    const mainWindowNumbersLocEl = document.getElementById('mainWindowNumbersLoc');
    if (mainWindowNumbersEl) mainWindowNumbersEl.addEventListener('change', () => redrawAllCanvasFeatureBoxes());
    if (mainWindowNumbersLocEl) mainWindowNumbersLocEl.addEventListener('change', () => redrawAllCanvasFeatureBoxes());
    const mainWindowNumbersWeightEl = document.getElementById('mainWindowNumbersWeight');
    const mainWindowNumbersShadowEl = document.getElementById('mainWindowNumbersShadow');
    const mainWindowNumbersSizeEl = document.getElementById('mainWindowNumbersSize');
    if (mainWindowNumbersWeightEl) mainWindowNumbersWeightEl.addEventListener('change', () => redrawAllCanvasFeatureBoxes());
    if (mainWindowNumbersShadowEl) mainWindowNumbersShadowEl.addEventListener('change', () => redrawAllCanvasFeatureBoxes());
    if (mainWindowNumbersSizeEl) mainWindowNumbersSizeEl.addEventListener('change', () => redrawAllCanvasFeatureBoxes());

    // Wire box filter shader mode dropdown + apply persisted value
    const boxFilterEl = document.getElementById('mainWindowBoxFilter');
    if (boxFilterEl) {
        boxFilterEl.addEventListener('change', () => setTileShaderMode(boxFilterEl.value));
        setTileShaderMode(boxFilterEl.value);
    }

    // Wire pyramid reduce mode dropdown (average vs peak zoom-out)
    const zoomOutEl = document.getElementById('mainWindowZoomOut');
    if (zoomOutEl) {
        zoomOutEl.addEventListener('change', () => {
            setPyramidReduceMode(zoomOutEl.value);
            rebuildUpperLevels();
            updateSpectrogramViewportFromZoom();
            zoomOutEl.blur();
        });
        setPyramidReduceMode(zoomOutEl.value);
    }

    // Wire tile chunk size (adaptive vs fixed duration)
    const tileChunkEl = document.getElementById('tileChunkSize');
    if (tileChunkEl) {
        tileChunkEl.addEventListener('change', () => {
            tileChunkEl.blur();
            // Re-render spectrogram with new tile duration (old stays visible during compute)
            import('./main-window-renderer.js').then(module => {
                if (module.isCompleteSpectrogramRendered()) {
                    module.renderCompleteSpectrogram(false, true);
                }
            });
        });
    }

    // Wire level transition mode (stepped vs crossfade)
    const levelTransEl = document.getElementById('levelTransition');
    const powerRow = document.getElementById('crossfadePowerRow');
    const powerSlider = document.getElementById('crossfadePower');
    const powerLabel = document.getElementById('crossfadePowerLabel');

    function updateCrossfadeUI() {
        if (powerRow) powerRow.style.display = levelTransEl?.value === 'crossfade' ? 'flex' : 'none';
    }

    if (levelTransEl) {
        levelTransEl.addEventListener('change', () => {
            setLevelTransitionMode(levelTransEl.value);
            updateCrossfadeUI();
            levelTransEl.blur();
        });
        setLevelTransitionMode(levelTransEl.value);
        updateCrossfadeUI();
    }

    if (powerSlider) {
        powerSlider.addEventListener('input', () => {
            setCrossfadePower(parseFloat(powerSlider.value));
            if (powerLabel) powerLabel.textContent = parseFloat(powerSlider.value).toFixed(1);
        });
        setCrossfadePower(parseFloat(powerSlider.value));
        if (powerLabel) powerLabel.textContent = parseFloat(powerSlider.value).toFixed(1);
    }

    // Wire Catmull-Rom smooth curve controls
    const catmullModeEl = document.getElementById('catmullMode');
    const catmullSubControls = document.getElementById('catmullSubControls');
    const catmullThresholdEl = document.getElementById('catmullThreshold');
    const catmullCoreEl = document.getElementById('catmullCore');
    const catmullCoreLabel = document.getElementById('catmullCoreLabel');
    const catmullFeatherEl = document.getElementById('catmullFeather');
    const catmullFeatherLabel = document.getElementById('catmullFeatherLabel');

    function applyCatmullSettings() {
        const prefix = isStudyMode() ? 'emic_' : 'main_';
        const enabled = (localStorage.getItem(prefix + 'catmull_mode') || catmullModeEl?.value || 'default') === 'smooth';
        const threshold = localStorage.getItem(prefix + 'catmull_threshold') || catmullThresholdEl?.value || 128;
        const core = localStorage.getItem(prefix + 'catmull_core') || catmullCoreEl?.value || 1.0;
        const feather = localStorage.getItem(prefix + 'catmull_feather') || catmullFeatherEl?.value || 1.0;
        setCatmullSettings({ enabled, threshold, core, feather });
    }

    function updateCatmullSubControls() {
        if (catmullSubControls) {
            const prefix = isStudyMode() ? 'emic_' : 'main_';
            const mode = localStorage.getItem(prefix + 'catmull_mode') || catmullModeEl?.value || 'default';
            catmullSubControls.style.display = mode === 'smooth' ? 'block' : 'none';
        }
    }

    if (catmullModeEl) {
        catmullModeEl.addEventListener('change', () => {
            updateCatmullSubControls();
            applyCatmullSettings();
            catmullModeEl.blur();
        });
        updateCatmullSubControls();
        applyCatmullSettings();
    }
    if (catmullThresholdEl) {
        catmullThresholdEl.addEventListener('change', () => { applyCatmullSettings(); catmullThresholdEl.blur(); });
    }
    if (catmullCoreEl) {
        catmullCoreEl.addEventListener('input', () => {
            if (catmullCoreLabel) catmullCoreLabel.textContent = parseFloat(catmullCoreEl.value).toFixed(2);
            applyCatmullSettings();
        });
        if (catmullCoreLabel) catmullCoreLabel.textContent = parseFloat(catmullCoreEl.value).toFixed(2);
    }
    if (catmullFeatherEl) {
        catmullFeatherEl.addEventListener('input', () => {
            if (catmullFeatherLabel) catmullFeatherLabel.textContent = parseFloat(catmullFeatherEl.value).toFixed(1);
            applyCatmullSettings();
        });
        if (catmullFeatherLabel) catmullFeatherLabel.textContent = parseFloat(catmullFeatherEl.value).toFixed(1);
    }

    // Wire waveform pan mode
    const waveformPanModeEl = document.getElementById('waveformPanMode');
    if (waveformPanModeEl) {
        waveformPanModeEl.addEventListener('change', () => {
            setWaveformPanMode(waveformPanModeEl.value);
            waveformPanModeEl.blur();
        });
        // Apply saved setting on load
        const prefix = isStudyMode() ? 'emic_' : 'main_';
        const saved = localStorage.getItem(prefix + 'waveform_pan_mode');
        if (saved) setWaveformPanMode(saved);
    }

    // Wire Display on Load: show/hide hours row
    const displayOnLoadEl = document.getElementById('displayOnLoad');
    const initialHoursRow = document.getElementById('initialHoursRow');
    function updateInitialHoursVisibility() {
        if (initialHoursRow) initialHoursRow.style.display = displayOnLoadEl?.value === 'beginning' ? 'flex' : 'none';
    }
    if (displayOnLoadEl) {
        displayOnLoadEl.addEventListener('change', () => {
            updateInitialHoursVisibility();
            displayOnLoadEl.blur();
        });
        updateInitialHoursVisibility();
    }

    // Tick fade slider labels
    for (const { sliderId, labelId, storageKey, suffix } of [
        { sliderId: 'tickFadeInTime', labelId: 'tickFadeInLabel', storageKey: 'emic_tick_fade_in', suffix: 's' },
        { sliderId: 'tickFadeOutTime', labelId: 'tickFadeOutLabel', storageKey: 'emic_tick_fade_out', suffix: 's' },
        { sliderId: 'tickZoomSpatialWidth', labelId: 'tickZoomSpatialWidthLabel', storageKey: 'emic_tick_zoom_spatial_width', suffix: '' },
        { sliderId: 'tickEdgeSpatialWidth', labelId: 'tickEdgeSpatialWidthLabel', storageKey: 'emic_tick_edge_spatial_width', suffix: '' },
        { sliderId: 'tickEdgeTimeIn', labelId: 'tickEdgeTimeInLabel', storageKey: 'emic_tick_edge_time_in', suffix: 's' },
        { sliderId: 'tickEdgeTimeOut', labelId: 'tickEdgeTimeOutLabel', storageKey: 'emic_tick_edge_time_out', suffix: 's' },
    ]) {
        const slider = document.getElementById(sliderId);
        const label = document.getElementById(labelId);
        if (!slider) continue;
        const update = () => { if (label) label.textContent = parseFloat(slider.value).toFixed(2) + suffix; };
        slider.addEventListener('input', () => {
            update();
            localStorage.setItem(storageKey, slider.value);
        });
        update();
    }

    // Show/hide zoom fade sub-controls based on mode
    const zoomModeSelect = document.getElementById('tickZoomFadeMode');
    const zoomTimeControls = document.getElementById('tickZoomTimeControls');
    const zoomSpatialControls = document.getElementById('tickZoomSpatialControls');
    function updateZoomFadeControls() {
        const mode = zoomModeSelect?.value || 'time';
        if (zoomTimeControls) zoomTimeControls.style.display = mode === 'time' ? '' : 'none';
        if (zoomSpatialControls) zoomSpatialControls.style.display = mode === 'spatial' ? '' : 'none';
    }
    if (zoomModeSelect) {
        zoomModeSelect.addEventListener('change', updateZoomFadeControls);
        updateZoomFadeControls();
    }

    // Show/hide edge fade sub-controls based on mode
    const edgeModeSelect = document.getElementById('tickEdgeFadeMode');
    const spatialControls = document.getElementById('tickEdgeSpatialControls');
    const timeControls = document.getElementById('tickEdgeTimeControls');
    function updateEdgeFadeControls() {
        const mode = edgeModeSelect?.value || 'spatial';
        if (spatialControls) spatialControls.style.display = mode === 'spatial' ? '' : 'none';
        if (timeControls) timeControls.style.display = mode === 'time' ? '' : 'none';
    }
    if (edgeModeSelect) {
        edgeModeSelect.addEventListener('change', updateEdgeFadeControls);
        updateEdgeFadeControls();
    }

    // Toggle top bar controls visibility based on viewing mode
    function updateControlsVisibility() {
        const mode = document.getElementById('viewingMode')?.value;
        const isWindowed = mode === 'static' || mode === 'scroll' || mode === 'pageTurn';
        const advanced = document.getElementById('advancedMode')?.checked;
        const hideControls = isWindowed && !advanced;
        const comp = document.getElementById('componentSelectorContainer');
        const detrend = document.getElementById('detrendContainer');
        if (comp) comp.style.visibility = hideControls ? 'hidden' : '';
        if (detrend) detrend.style.visibility = hideControls ? 'hidden' : '';
    }

    // When switching viewing mode, reset waveform to full view and re-render
    // Both selects (nav bar "viewingMode" and main window "mainWindowMode") stay in sync
    const viewingModeSelect = document.getElementById('viewingMode');
    const mainWindowModeSelect = document.getElementById('mainWindowMode');

    function applyViewingMode(mode, sourceSelect) {
        if (mode === 'static' || mode === 'scroll' || mode === 'pageTurn') {
            zoomState.setViewportToFull();
        }
        // Sync the other select
        if (viewingModeSelect && viewingModeSelect !== sourceSelect) viewingModeSelect.value = mode;
        if (mainWindowModeSelect && mainWindowModeSelect !== sourceSelect) mainWindowModeSelect.value = mode;
        updateControlsVisibility();
        drawWaveformFromMinMax();
        drawMinimapXAxis();
        drawSpectrogramXAxis();
        drawDayMarkers();
        sourceSelect?.blur();
    }

    if (viewingModeSelect) {
        updateControlsVisibility();
        viewingModeSelect.addEventListener('change', () => {
            applyViewingMode(viewingModeSelect.value, viewingModeSelect);
        });
    }
    if (mainWindowModeSelect) {
        mainWindowModeSelect.addEventListener('change', () => {
            applyViewingMode(mainWindowModeSelect.value, mainWindowModeSelect);
        });
    }
}
