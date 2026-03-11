// ⚠️ When in any doubt, use Edit to surgically fix mistakes — never git checkout this file.
/**
 * main.js
 * Main orchestration: initialization, startStreaming, event handlers
 */


import * as State from './audio-state.js';
import { togglePlayPause, toggleLoop, changePlaybackSpeed, changeVolume, resetSpeedTo1, resetVolumeTo1, updatePlaybackSpeed, downloadAudio, switchStretchAlgorithm, calculateSliderForSpeed } from './audio-player.js';
import { initWaveformWorker, setupWaveformInteraction } from './minimap-window-renderer.js';
import { startStreaming, updateSpacecraftDropdownLabels } from './streaming.js';
import { changeFrequencyScale, loadFrequencyScale, changeColormap, loadColormap, changeFftSize, loadFftSize, setupSpectrogramSelection } from './spectrogram-renderer.js';
import { loadSavedSpacecraft, saveDateTime, updateStationList, updateDatasetOptions, enableFetchButton, purgeCloudflareCache, openParticipantModal, openWelcomeModal, changeBaseSampleRate, handleWaveformFilterChange, resetWaveformFilterToDefault, setupModalEventListeners, openParticipantInfoModal, wireQuestionnaireModals } from './ui-controls.js';
import { getParticipantIdFromURL, storeParticipantId, storeRealUsername } from './participant-id.js';
import { initAdminMode, toggleAdminMode } from './admin-mode.js';
import { initializeModals } from './modal-templates.js';
import { modalManager } from './modal-manager.js';
import { initErrorReporter } from './error-reporter.js';
import { initSilentErrorReporter } from './silent-error-reporter.js';
import { drawFrequencyAxis, setMinFreqMultiplier } from './spectrogram-axis-renderer.js';
import { updateCompleteButtonState, updateCmpltButtonState } from './feature-tracker.js';
import { initKeyboardShortcuts } from './keyboard-shortcuts.js';
import { isEmicStudyMode, isLocalEnvironment } from './master-modes.js';
import { initShareModal, openShareModal, checkAndLoadSharedSession, applySharedSession } from './share-modal.js';
import { logGroup, logGroupEnd } from './logger.js';
import { initializeAdvancedControls } from './advanced-controls.js';
import { checkAppVersion } from './version-check.js';
import { setupAudioDownloadHandlers } from './audio-download.js';
import { setupLifecycleHandlers } from './lifecycle-cleanup.js';
import { loadRecentSearches, restoreRecentSearch, saveRecentSearch } from './recent-searches.js';
import { setupResizeHandler } from './resize-handler.js';
import { detectGPUCapability } from './gpu-detection.js';
import { initializeApp, updateParticipantIdDisplay } from './mode-initializers.js';
import { initScrollZoom } from './scroll-zoom.js';

if (window.pm?.init) console.log('✅ CONSTANTS DEFINED');

// Re-export startStreaming for volcano/tutorial-coordinator.js dynamic import compatibility
export { startStreaming } from './streaming.js';

// Main initialization function
async function initializeMainApp() {
    // Capture wheel events on canvases immediately to prevent page scroll before data loads
    initScrollZoom();

    if (window.pm?.gpu) {
        console.log('════════════════════');
        console.log('☀️ SOLAR AUDIFICATION PORTAL - INITIALIZING!');
        console.log('════════════════════');
    }

    // ─── GPU Capability Detection ────────────────────────────────────────
    await detectGPUCapability();

    // Check for new version first (will reload page if update available)
    if (await checkAppVersion()) return;

    // Group core system initialization
    if (window.pm?.init) console.groupCollapsed('🔧 [INIT] Core Systems');
    
    // ═══════════════════════════════════════════════════════════
    // 📏 STATUS AUTO-RESIZE - Shrink font when text overflows
    // ═══════════════════════════════════════════════════════════
    const { setupStatusAutoResize } = await import('./status-auto-resize.js');
    setupStatusAutoResize();
    
    // ═══════════════════════════════════════════════════════════
    // 🎯 MASTER MODE - Initialize and check configuration
    // ═══════════════════════════════════════════════════════════
    const { initializeMasterMode, isStudyMode, CURRENT_MODE, AppMode } = await import('./master-modes.js');
    initializeMasterMode();
    
    // Initialize error reporter early (catches errors during initialization)
    initErrorReporter();
    
    // Initialize silent error reporter (tracks metadata mismatches quietly)
    initSilentErrorReporter();

    // Initialize share modal (for sharing analysis sessions)
    initShareModal();

    if (window.pm?.init) console.groupEnd(); // End Core Systems

    // Group UI setup
    if (window.pm?.init) console.groupCollapsed('🎨 [INIT] UI Setup');

    // ─── Advanced mode: restore state + inject controls EARLY ──────────
    // Advanced mode affects layout decisions throughout init (gear icons,
    // hamburger, control visibility in windowed mode), so set it up before
    // anything else reads it or renders dependent UI.
    const advancedCheckboxEarly = document.getElementById('advancedMode');
    if (advancedCheckboxEarly) {
        if (isLocalEnvironment()) {
            const savedAdvanced = localStorage.getItem('emic_advanced_mode');
            advancedCheckboxEarly.checked = savedAdvanced !== null ? savedAdvanced === 'true' : true;
        } else {
            advancedCheckboxEarly.checked = false;
        }
    }
    if (CURRENT_MODE === AppMode.EMIC_STUDY || CURRENT_MODE === AppMode.SOLAR_PORTAL) {
        initializeAdvancedControls();
    }

    // Hide simulate panel in Study Mode and Solar Portal mode
    if (isStudyMode() || CURRENT_MODE === AppMode.SOLAR_PORTAL) {
        const simulatePanel = document.querySelector('.panel-simulate');
        if (simulatePanel) {
            simulatePanel.style.display = 'none';
            if (CURRENT_MODE === AppMode.SOLAR_PORTAL) {
                if (window.pm?.init) console.log('☀️ Solar Portal Mode: Simulate panel hidden');
            } else {
                if (window.pm?.init) console.log('🎓 Production Mode: Simulate panel hidden (surveys controlled by workflow)');
            }
        }
        
        // Permanent overlay in Production Mode (fully controlled by modal system)
        // Modal system checks flags and decides whether to show overlay
        if (window.pm?.init) console.log('🎓 Production Mode: Modal system controls overlay (based on workflow flags)');
    } else {
        // Hide permanent overlay in non-Study modes (Dev, Personal)
        const permanentOverlay = document.getElementById('permanentOverlay');
        if (permanentOverlay) {
            permanentOverlay.style.display = 'none';
            if (!isStudyMode()) {
                if (window.pm?.init) console.log(`✅ ${CURRENT_MODE.toUpperCase()} Mode: Permanent overlay hidden`);
            }
        }
    }
    

    // Parse participant ID from URL parameters on page load
    // Qualtrics redirects with: ?ResponseID=${e://Field/ResponseID}
    // This automatically captures the ResponseID and stores it for survey submissions
    const urlParticipantId = getParticipantIdFromURL();
    if (urlParticipantId) {
        storeRealUsername(urlParticipantId);
        console.log('🔗 ResponseID detected from Qualtrics redirect:', urlParticipantId);
        console.log('💾 Stored ResponseID for use in survey submissions');
    }
    
    // Check if we should open participant modal from URL parameter (for simulator)
    // This should ONLY open the modal, not trigger study workflow
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('openParticipant') === 'true') {
        // Prevent study workflow from auto-starting
        localStorage.setItem('skipStudyWorkflow', 'true');
        // Small delay to ensure modals are initialized
        setTimeout(() => {
            openParticipantModal();
        }, 500);
    }

    // Default isSharedSession to false - will be set true only if share link found
    sessionStorage.setItem('isSharedSession', 'false');

    // Check for shared session in URL (?share=xxx)
    const sharedSessionData = await checkAndLoadSharedSession();
    if (sharedSessionData) {
        console.log('🔗 Loading shared session...');
        const result = applySharedSession(sharedSessionData);

        // 🔗 CONSUME the share link: Remove ?share= from URL so future refreshes
        // load from localStorage (user's own work) instead of the shared session.
        // This is standard UX for share links (Figma, Google Docs, Notion do the same)
        history.replaceState({}, '', window.location.pathname);
        console.log('🔗 Share link consumed - URL cleaned for future sessions');

        if (result.shouldFetch) {
            // Auto-fetch the shared data after a small delay for UI to update
            setTimeout(() => {
                const fetchBtn = document.getElementById('startBtn');
                if (fetchBtn) fetchBtn.click();
            }, 500);
        }
    }

    // Update participant ID display
    updateParticipantIdDisplay();

    // Memory monitoring is started after recent-searches cache loads (see below)
    
    // ═══════════════════════════════════════════════════════════
    // 🚨 STUDY MODE: Show overlay only during active simulation in participant mode
    // ═══════════════════════════════════════════════════════════
    if (isStudyMode() && localStorage.getItem('emic_is_simulating') === 'true'
        && localStorage.getItem('emic_advanced_mode') !== 'true') {
        const overlay = document.getElementById('permanentOverlay');
        if (overlay) {
            overlay.style.display = 'flex';
            overlay.style.opacity = '1';
        }
    }
    
    // Initialize modals first (all modes need them)
    try {
        await initializeModals();
        if (window.pm?.init) console.log('✅ Modals initialized successfully');
    } catch (error) {
        console.error('❌ CRITICAL: Failed to initialize modals:', error);
        // Don't proceed if modals failed - this will cause dark screen
        throw error;
    }
    
    // Setup UI controls (all modes need them)
    setupModalEventListeners();
    
    // Initialize complete button state (disabled until first feature is identified)
    updateCompleteButtonState();
    updateCmpltButtonState();
    
    // Setup spectrogram frequency selection
    setupSpectrogramSelection();
    
    // Initialize oscilloscope visualization immediately (don't wait for audio)
    import('./oscilloscope-renderer.js').then(({ initOscilloscope }) => {
        initOscilloscope();
        if (window.pm?.init) console.log('🎨 Oscilloscope initialized on UI load');
    });
    
    // Initialize keyboard shortcuts
    initKeyboardShortcuts();
    
    // Initialize admin mode (applies user mode by default)
    initAdminMode();
    
    // Load saved preferences immediately to avoid visual jumps
    // (Must be done before other initialization that might trigger change handlers)
    loadFrequencyScale();
    loadColormap();
    loadFftSize();

    initWaveformWorker();
    
    const sliderValueFor1x = calculateSliderForSpeed(1.0);
    document.getElementById('playbackSpeed').value = sliderValueFor1x;
    if (!isStudyMode()) {
        console.log(`Initialized playback speed slider at position ${sliderValueFor1x} for 1.0x speed`);
    }
    
    // Load saved spacecraft selection (or use default)
    await loadSavedSpacecraft();
    
    if (window.pm?.init) console.groupEnd(); // End UI Setup
    
    // ═══════════════════════════════════════════════════════════
    // 🎯 MODE-AWARE ROUTING
    // ═══════════════════════════════════════════════════════════
    
    // Small delay to let page settle before starting workflows
    setTimeout(async () => {
        await initializeApp();
        if (logGroup('init', 'v2.0 App Ready')) {
            console.log('📌 v2.0 (2026-02-12) Three.js GPU-accelerated rendering');
            console.log('✅ App ready');
            logGroupEnd();
        }
        loadRecentSearches();
    }, 100);

    // Group event listeners setup
    if (window.pm?.init) console.groupCollapsed('⌨️ [INIT] Event Listeners');
    
    // Add event listeners
    document.getElementById('spacecraft').addEventListener('change', async (e) => {
        // Remove pulsing glow when user selects a spacecraft
        const spacecraftSelect = document.getElementById('spacecraft');
        if (spacecraftSelect) {
            spacecraftSelect.classList.remove('pulse-glow');
        }
        const selectedSpacecraft = e.target.value;
        const spacecraftWithData = State.spacecraftWithData;

        // 💾 Save spacecraft selection to localStorage for persistence
        localStorage.setItem('selectedSpacecraft', selectedSpacecraft);
        console.log('💾 Saved spacecraft selection:', selectedSpacecraft);

        // 🛰️ Update the Data dropdown to show datasets for the selected spacecraft
        updateDatasetOptions();

        // 🎨 Visual reminder: If there's loaded data from a different spacecraft, mark it as "(Currently Loaded)"
        if (spacecraftWithData && selectedSpacecraft !== spacecraftWithData) {
            updateSpacecraftDropdownLabels(spacecraftWithData, selectedSpacecraft);
        } else if (spacecraftWithData && selectedSpacecraft === spacecraftWithData) {
            // User switched back to the loaded spacecraft - clear the flag
            updateSpacecraftDropdownLabels(null, selectedSpacecraft);
        }

        // 🎯 In STUDY mode: prevent re-fetching same spacecraft (one spacecraft per session)
        // 👤 In PERSONAL/DEV modes: allow re-fetching any spacecraft anytime
        if (isStudyMode() && spacecraftWithData && selectedSpacecraft === spacecraftWithData) {
            const fetchBtn = document.getElementById('startBtn');
            fetchBtn.disabled = true;
            fetchBtn.title = 'This spacecraft already has data loaded. Select a different spacecraft to fetch new data.';
            console.log(`🚫 Fetch button disabled - ${selectedSpacecraft} already has data`);
        } else {
            // Switching to a different spacecraft - enable fetch button
            enableFetchButton();
            const fetchBtn = document.getElementById('startBtn');
            if (fetchBtn) {
                fetchBtn.title = '';
            }
        }

        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    document.getElementById('dataType').addEventListener('change', (e) => {
        // 💾 Save data type selection to localStorage for persistence
        localStorage.setItem('selectedDataType', e.target.value);
        console.log('💾 Saved data type selection:', e.target.value);
        updateStationList();
        enableFetchButton();
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    document.getElementById('station').addEventListener('change', (e) => {
        enableFetchButton();
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    document.getElementById('duration').addEventListener('change', (e) => {
        enableFetchButton();
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });

    // 💾 Save date/time selections to localStorage for persistence
    ['startDate', 'startTime', 'endDate', 'endTime'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', () => {
                console.log(`📅 ${id} changed`);
                saveDateTime();
                enableFetchButton();
            });
            // Also save on input for immediate feedback
            el.addEventListener('input', () => saveDateTime());
        } else if (!isEmicStudyMode()) {
            console.warn(`⚠️ Could not find element: ${id}`);
        }
    });
    if (window.pm?.init) console.log('✅ Date/time persistence listeners attached');
    document.getElementById('highpassFreq').addEventListener('change', (e) => {
        enableFetchButton();
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    document.getElementById('enableNormalize').addEventListener('change', (e) => {
        enableFetchButton();
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    document.getElementById('bypassCache')?.addEventListener('change', (e) => {
        enableFetchButton();
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    document.getElementById('baseSampleRate').addEventListener('change', (e) => {
        changeBaseSampleRate();
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    
    updatePlaybackSpeed();
    
    document.getElementById('speedLabel').addEventListener('click', resetSpeedTo1);
    document.getElementById('volumeLabel').addEventListener('click', resetVolumeTo1);
    
    document.getElementById('frequencyScale').addEventListener('change', changeFrequencyScale);
    document.getElementById('colormap').addEventListener('change', changeColormap);
    document.getElementById('fftSize').addEventListener('change', changeFftSize);

    // Min frequency multiplier control
    const minFreqInput = document.getElementById('minFreqMultiplier');
    if (minFreqInput) {
        // Restore saved value
        const savedMultiplier = localStorage.getItem('minFreqMultiplier');
        if (savedMultiplier) {
            const value = parseFloat(savedMultiplier);
            minFreqInput.value = value;
            setMinFreqMultiplier(value);
        }

        // Handle changes
        minFreqInput.addEventListener('change', () => {
            const value = parseFloat(minFreqInput.value);
            if (!isNaN(value) && value > 0) {
                setMinFreqMultiplier(value);
                localStorage.setItem('minFreqMultiplier', value);
                // Redraw spectrogram and axis
                drawFrequencyAxis();
                import('./main-window-renderer.js').then(module => {
                    // Clear cached spectrogram to force re-render with new minFreq
                    module.resetSpectrogramState();
                    module.renderCompleteSpectrogram();
                });
            }
        });
    }

    document.getElementById('waveformFilterLabel').addEventListener('click', resetWaveformFilterToDefault);
    
    setupWaveformInteraction();
    
    // Space and Enter keyboard shortcuts are handled in keyboard-shortcuts.js

    // Blur sliders after interaction
    const playbackSpeedSlider = document.getElementById('playbackSpeed');
    const volumeSliderForBlur = document.getElementById('volumeSlider');
    [playbackSpeedSlider, volumeSliderForBlur].forEach(slider => {
        slider.addEventListener('mouseup', () => slider.blur());
        slider.addEventListener('change', () => slider.blur());
    });
    
    // Blur dropdowns
    const dropdowns = ['dataType', 'station', 'duration', 'frequencyScale'];
    dropdowns.forEach(id => {
        const dropdown = document.getElementById(id);
        if (dropdown) {
            dropdown.addEventListener('change', () => dropdown.blur());
        }
    });
    
    // Blur checkboxes
    const checkboxes = ['enableNormalize', 'bypassCache'];
    checkboxes.forEach(id => {
        const checkbox = document.getElementById(id);
        if (checkbox) {
            checkbox.addEventListener('change', () => checkbox.blur());
            checkbox.addEventListener('click', () => setTimeout(() => checkbox.blur(), 10));
        }
    });
    
    if (!isStudyMode()) {
        console.log('✅ Event listeners added for fetch button re-enabling');
    }
    
    // Window resize handler and canvas layout (extracted to resize-handler.js)
    setupResizeHandler();
    
    // Expose loadRecentSearches globally so startStreaming can call it
    window.loadRecentSearches = loadRecentSearches;
    
    // 🎯 SETUP EVENT LISTENERS (replaces onclick handlers to prevent memory leaks)
    // All event listeners are properly scoped and don't create permanent closures on window.*
    
    // Cache & Download & Share
    document.getElementById('purgeCacheBtn')?.addEventListener('click', purgeCloudflareCache);
    document.getElementById('downloadBtn')?.addEventListener('click', downloadAudio);
    document.getElementById('shareBtn')?.addEventListener('click', openShareModal);
    
    // Recent Searches
    document.getElementById('recentSearches').addEventListener('change', (e) => {
        const selectedOption = e.target.options[e.target.selectedIndex];
        if (selectedOption && selectedOption.value) {
            restoreRecentSearch(selectedOption);
            // Reset dropdown to placeholder after restoring
            e.target.value = '';
        }
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    
    if (window.pm?.init) console.log('🟢 LINE 2180 - About to attach startBtn event listener');

    // Data Fetching
    const startBtn = document.getElementById('startBtn');
    if (window.pm?.init) console.log('🟢 startBtn element:', startBtn ? 'FOUND' : 'NOT FOUND');
    if (startBtn) {
        startBtn.addEventListener('click', async (e) => {
            if (window.pm?.interaction) console.log('🔵 Fetch Data button clicked!');
            // Cancel any typing animation immediately
            const { cancelTyping } = await import('./tutorial-effects.js');
            cancelTyping();
            saveRecentSearch(); // Save search before fetching (no-op now, handled by cache)
            // EMIC mode: use config defined in emic_study.html
            const { isEmicStudyMode } = await import('./master-modes.js');
            if (isEmicStudyMode()) {
                await startStreaming(e, window.__EMIC_CONFIG);
            } else {
                await startStreaming(e);
            }
            e.target.blur(); // Blur so spacebar can toggle play/pause
        });
        if (window.pm?.init) console.log('🟢 startBtn event listener attached successfully!');
    } else {
        console.error('❌ startBtn NOT FOUND - cannot attach event listener!');
    }
    // Playback Controls
    document.getElementById('playPauseBtn').addEventListener('click', (e) => {
        togglePlayPause();
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    document.getElementById('loopBtn').addEventListener('click', toggleLoop);
    document.getElementById('playbackSpeed').addEventListener('input', () => {
        changePlaybackSpeed();
        // Remove glow when user interacts with speed slider
        const speedSlider = document.getElementById('playbackSpeed');
        if (speedSlider) {
            speedSlider.classList.remove('speed-slider-glow');
        }
    });
    // Stretch algorithm selector
    const stretchAlgoSelect = document.getElementById('stretchAlgorithm');
    if (stretchAlgoSelect) {
        stretchAlgoSelect.addEventListener('change', (e) => {
            switchStretchAlgorithm(e.target.value);
        });
    }
    const volumeSlider = document.getElementById('volumeSlider');
    if (volumeSlider) {
        volumeSlider.addEventListener('input', changeVolume);
    }
    
    // Waveform Filters
    document.getElementById('removeDCOffset').addEventListener('change', handleWaveformFilterChange);
    document.getElementById('waveformFilterSlider').addEventListener('input', handleWaveformFilterChange);
    
    // Anti-aliasing
    
    // Survey/Modal Buttons
    document.getElementById('participantModalBtn')?.addEventListener('click', openParticipantModal);
    document.getElementById('welcomeModalBtn')?.addEventListener('click', openWelcomeModal);
    document.getElementById('adminModeBtn')?.addEventListener('click', toggleAdminMode);

    // Start event listeners setup group
    const listenersGroupOpen = logGroup('ui', 'Setting up UI event listeners');

    // Participant ID display click handler
    const participantIdText = document.getElementById('participantIdText');
    if (participantIdText) {
        participantIdText.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('👤 Participant ID display clicked - opening info modal');
            openParticipantInfoModal();
        });
        // Add hover effect - keep dark background theme with reddish tint
        participantIdText.addEventListener('mouseenter', function() {
            this.style.backgroundColor = 'rgba(80, 50, 50, 0.6)';
        });
        participantIdText.addEventListener('mouseleave', function() {
            this.style.backgroundColor = 'rgba(40, 40, 40, 0.4)';
        });
    }
    
    // About info button click handler
    const aboutInfoBtn = document.getElementById('aboutInfoBtn');
    if (aboutInfoBtn) {
        aboutInfoBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const modalId = window.__EMIC_STUDY_MODE ? 'emicAboutModal' : 'aboutModal';
            await modalManager.openModal(modalId);
        });

        // Wire up close button inside the about modal
        const aboutModal = document.getElementById('aboutModal');
        if (aboutModal) {
            const aboutCloseBtn = aboutModal.querySelector('.modal-close');
            if (aboutCloseBtn) {
                aboutCloseBtn.addEventListener('click', () => {
                    modalManager.closeModal('aboutModal');
                });
            }
        }

        // Wire up close button inside the EMIC about modal
        const emicAboutModal = document.getElementById('emicAboutModal');
        if (emicAboutModal) {
            const emicAboutCloseBtn = emicAboutModal.querySelector('.modal-close');
            if (emicAboutCloseBtn) {
                emicAboutCloseBtn.addEventListener('click', () => {
                    modalManager.closeModal('emicAboutModal');
                });
            }
        }
    }

    // Post-study questionnaire modals (background, data analysis, musical, feedback, referral)
    wireQuestionnaireModals(modalManager);

    // Set up component selector listener
    const { setupComponentSelectorListener } = await import('./component-selector.js');
    setupComponentSelectorListener();
    
    // Set up download, recording, and ZIP export handlers
    setupAudioDownloadHandlers();

    // Close the event listeners group
    if (listenersGroupOpen) logGroupEnd();
    
    setupLifecycleHandlers();
    
    if (window.pm?.init) console.groupEnd(); // End Event Listeners
} // End initializeMainApp

// Call initialization when DOM is ready
if (document.readyState === 'loading') {
    // DOM is still loading, wait for DOMContentLoaded
    if (window.pm?.init) console.log('⏳ Waiting for DOMContentLoaded...');
    document.addEventListener('DOMContentLoaded', () => {
        if (window.pm?.init) console.log('🔵 DOMContentLoaded FIRED - calling initializeMainApp');
        initializeMainApp();
    });
} else {
    // DOM is already loaded (interactive or complete), initialize immediately
    // console.log('✅ DOM already loaded, initializing immediately');
    initializeMainApp();
}

