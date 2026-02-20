/**
 * audio-state.js
 * Centralized state management for the audio player
 * All modules import and share this state
 */

import { compressToInt16, decompressSlice, decompressAll } from './audio-compression.js';

// Playback state enum
export const PlaybackState = {
    STOPPED: 'STOPPED',  // Default/rest state (no audio, finished, or never started)
    PLAYING: 'PLAYING',  // Currently playing
    PAUSED: 'PAUSED'     // Paused (ready to resume)
};

// Audio nodes
export let audioContext = null;
export let workletNode = null;
export let analyserNode = null;
export let gainNode = null;

// Stretch audio nodes (dual-path: source vs stretch processor)
export let stretchNode = null;         // AudioWorkletNode for active stretch processor
export let stretchGainNode = null;     // GainNode for stretch path crossfade
export let sourceGainNode = null;      // GainNode for source path crossfade
export let stretchAlgorithm = 'resample';  // 'resample' | 'paul' | 'granular' | 'wavelet'
export let stretchNodes = {};          // Pre-primed nodes: { paul: node, granular: node, resample: node }
export let stretchActive = false;      // Whether stretch path is currently the active output
export let stretchFactor = 1.0;        // Current stretch factor (1/baseSpeed)
export let stretchStartTime = 0;       // audioContext.currentTime when stretch playback started
export let stretchStartPosition = 0;   // Source position (seconds) when stretch started

// Playback state
export let playbackState = PlaybackState.STOPPED;
export let isLooping = false;
export let currentPlaybackRate = 1.0;

// Timing
export let streamStartTime = 0;
export let lastUpdateTime = 0;
export let lastWorkletPosition = 0;
export let lastWorkletUpdateTime = 0;
export let playbackStartTime = null;
export let playbackPositionInterval = null;
export let pausedPosition = 0;
export let playbackDurationSeconds = null;

// Station data
export let availableStations = { seismic: [], infrasound: [] };

// Audio data
export let allReceivedData = [];
export let completeSamplesArray = null;
export let compressedSamplesBuffer = null; // { data: Int16Array, scale: number, length: number }
export let originalAudioBlob = null; // Store original WAV blob from CDAWeb for direct download
export let currentMetadata = null;
export let totalAudioDuration = 0;
export let currentAudioPosition = 0;
export let dataStartTime = null; // UTC Date object for start of data
export let dataEndTime = null; // UTC Date object for end of data
export let originalDataFrequencyRange = null; // { min: 0, max: XXX } - Original spacecraft data frequency (Hz)

// Device detection
export const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
export const isMobileScreen = () => window.innerWidth <= 768;

// Flags
export let isFetchingNewData = false;
export let loadingInterval = null;
export let spectrogramInitialized = false;
export let visualizationStarted = false;
export let isShowingFinalWaveform = false;
export let justSeeked = false;  // Track if we just performed a seek (to avoid race conditions)
export let spacecraftWithData = null;  // Track which spacecraft currently has data loaded

// Visualization state
export let frequencyScale = 'logarithmic'; // 'linear', 'sqrt', or 'logarithmic'
export let fftSize = 2048; // FFT size for spectrogram (256, 512, 1024, 2048, 4096, 8192)

// Animation frame IDs (for cleanup to prevent memory leaks)
export let playbackIndicatorRAF = null;
export let spectrogramRAF = null;

// Worklet event listeners (for cleanup to prevent memory leaks)
export let workletBufferStatusHandler = null;
export let workletRailwayBufferStatusHandler = null;

// Waveform rendering
export let cachedWaveformCanvas = null;
export let cachedFullWaveformCanvas = null; // Full view cached before zooming in (like spectrogram's elastic friend)
export let waveformMinMaxData = null;
export let waveformMaxAmplitude = null; // Cached max amplitude for color LUT normalization
export let waveformWorker = null;
export let crossfadeAnimation = null;

// Interaction state
export let isDragging = false;
export let scrubTargetPosition = null;
export let selectionStart = null;
export let selectionEnd = null;
export let isSelecting = false;
export let selectionStartX = null;
export let waveformHasBeenClicked = false;
export let waitingForSelection = false;
export let waitingForRegionCreation = false;
export let waitingForRegionPlayClick = false;
export let waitingForRegionPlayOrResume = false;
export let waitingForRegionZoom = false;
export let waitingForLoopButtonClick = false;
export let waitingForFrequencyScaleChange = false;
export let waitingForFrequencyScaleKeys = false;
export let frequencyScaleKeyPressCount = 0;
export let waitingForFeatureSelection = false;
export let waitingForFeatureDescription = false;
export let waitingForRepetitionDropdown = false;
export let waitingForTypeDropdown = false;
export let waitingForAddFeatureButtonClick = false;
export let waitingForZoomOut = false;
export let waitingForNumberKeyPress = false;
export let targetNumberKey = null; // '1' or '2'
export let waitingForBeginAnalysisClick = false;
export let _selectionTutorialResolve = null;
export let _waveformClickResolve = null;
export let _regionCreationResolve = null;
export let _regionPlayClickResolve = null;
export let _regionPlayOrResumeResolve = null;
export let _regionZoomResolve = null;
export let _loopButtonClickResolve = null;
export let _frequencyScaleChangeResolve = null;
export let _frequencyScaleKeysResolve = null;
export let _featureSelectionResolve = null;
export let _featureDescriptionResolve = null;
export let _repetitionDropdownResolve = null;
export let _typeDropdownResolve = null;
export let _addFeatureButtonClickResolve = null;
export let _zoomOutResolve = null;
export let _numberKeyPressResolve = null;
export let _beginAnalysisClickResolve = null;
export let regionButtonsDisabled = false;
export let enabledRegionPlayButtons = new Map(); // Map<regionIndex, enabled>
export let enabledRegionZoomButtons = new Map(); // Map<regionIndex, enabled>
export let regionCreationEnabled = false; // Region creation disabled until "Begin Analysis" is pressed

// Region tracking state
export let regions = [];
export let activeRegionIndex = null;
export let isSelectingFrequency = false;
export let currentFrequencySelection = null;

// Setters for modules that need to update state
export function setAudioContext(value) { audioContext = value; }
export function setWorkletNode(value) { workletNode = value; }
export function setAnalyserNode(value) { analyserNode = value; }
export function setGainNode(value) { gainNode = value; }
export function setStretchNode(value) { stretchNode = value; }
export function setStretchNodes(value) { stretchNodes = value; }
export function setStretchGainNode(value) { stretchGainNode = value; }
export function setSourceGainNode(value) { sourceGainNode = value; }
export function setStretchAlgorithm(value) { stretchAlgorithm = value; }
export function setStretchActive(value) { stretchActive = value; }
export function setStretchFactor(value) { stretchFactor = value; }
export function setStretchStartTime(value) { stretchStartTime = value; }
export function setStretchStartPosition(value) { stretchStartPosition = value; }
export function setPlaybackState(value) {
    // console.log(`🔧 setPlaybackState(${value}) - previous state: ${playbackState}`);
    playbackState = value;
}
export function setIsLooping(value) { isLooping = value; }
export function setCurrentPlaybackRate(value) { currentPlaybackRate = value; }
export function setStreamStartTime(value) { streamStartTime = value; }
export function setLastUpdateTime(value) { lastUpdateTime = value; }
export function setLastWorkletPosition(value) { lastWorkletPosition = value; }
export function setLastWorkletUpdateTime(value) { lastWorkletUpdateTime = value; }
export function setPlaybackStartTime(value) { playbackStartTime = value; }
export function setPlaybackPositionInterval(value) { playbackPositionInterval = value; }
export function setPausedPosition(value) { pausedPosition = value; }
export function setPlaybackDurationSeconds(value) { playbackDurationSeconds = value; }
export function setAvailableStations(value) { availableStations = value; }
export function setAllReceivedData(value) { allReceivedData = value; }
let _onCompleteSamplesReady = null;
export function setOnCompleteSamplesReady(fn) { _onCompleteSamplesReady = fn; }
export function setCompleteSamplesArray(value) {
    // 🔥 FIX: Explicitly null old value before setting new one to help GC
    // This ensures the old Float32Array reference is broken before assignment
    if (completeSamplesArray !== value) {
        completeSamplesArray = null;
    }
    completeSamplesArray = value;
    // Notify stretch processors to prime with new audio data
    if (value && _onCompleteSamplesReady) {
        _onCompleteSamplesReady(value);
    }
}
export function setCompressedSamplesBuffer(value) { compressedSamplesBuffer = value; }

/**
 * Compress the samples array to save memory. Call after initial rendering is complete.
 * The Float32 array is freed. Use getCompleteSamplesSlice() for on-demand decompression.
 */
export function compressSamplesArray() {
    if (!completeSamplesArray || compressedSamplesBuffer) return;
    
    console.log(`🗜️ Compressing ${completeSamplesArray.length.toLocaleString()} samples (${(completeSamplesArray.byteLength / 1024 / 1024).toFixed(1)} MB Float32)...`);
    const start = performance.now();
    
    compressedSamplesBuffer = compressToInt16(completeSamplesArray);
    
    const elapsed = performance.now() - start;
    const savedMB = (completeSamplesArray.byteLength - compressedSamplesBuffer.data.byteLength) / 1024 / 1024;
    console.log(`🗜️ Compressed in ${elapsed.toFixed(0)}ms — saved ${savedMB.toFixed(1)} MB (${(compressedSamplesBuffer.data.byteLength / 1024 / 1024).toFixed(1)} MB Int16)`);
    
    // Release the Float32 array
    completeSamplesArray = null;
}

/**
 * Get a Float32 slice of the samples, decompressing from Int16 if needed.
 * This is the universal accessor — use this instead of completeSamplesArray.slice() directly.
 */
export function getCompleteSamplesSlice(start, end) {
    if (completeSamplesArray) {
        return completeSamplesArray.slice(start, end);
    }
    if (compressedSamplesBuffer) {
        return decompressSlice(compressedSamplesBuffer, start, end);
    }
    return null;
}

/**
 * Get the full samples array (decompresses if compressed).
 * WARNING: This re-creates the full Float32 array — use sparingly.
 * Prefer getCompleteSamplesSlice() for partial reads.
 */
export function getCompleteSamplesArray() {
    if (completeSamplesArray) return completeSamplesArray;
    if (compressedSamplesBuffer) return decompressAll(compressedSamplesBuffer);
    return null;
}

/**
 * Get the total sample count without decompressing.
 */
export function getCompleteSamplesLength() {
    if (completeSamplesArray) return completeSamplesArray.length;
    if (compressedSamplesBuffer) return compressedSamplesBuffer.length;
    return 0;
}

export function setOriginalAudioBlob(value) { originalAudioBlob = value; }
export function setCurrentMetadata(value) { currentMetadata = value; }
export function setTotalAudioDuration(value) { totalAudioDuration = value; }
export function setCurrentAudioPosition(value) { currentAudioPosition = value; }
export function setDataStartTime(value) { dataStartTime = value; }
export function setDataEndTime(value) { dataEndTime = value; }
export function setOriginalDataFrequencyRange(value) { originalDataFrequencyRange = value; }
export function setIsFetchingNewData(value) { isFetchingNewData = value; }
export function setLoadingInterval(value) { loadingInterval = value; }
export function setSpectrogramInitialized(value) { spectrogramInitialized = value; }
export function setVisualizationStarted(value) { visualizationStarted = value; }
export function setIsShowingFinalWaveform(value) { isShowingFinalWaveform = value; }
export function setJustSeeked(value) { justSeeked = value; }
export function setFrequencyScale(value) { frequencyScale = value; }
export function setFftSize(value) { fftSize = value; }
export function setSpacecraftWithData(value) { spacecraftWithData = value; }
export function setPlaybackIndicatorRAF(value) { playbackIndicatorRAF = value; }
export function setSpectrogramRAF(value) { spectrogramRAF = value; }
export function setWorkletBufferStatusHandler(value) { workletBufferStatusHandler = value; }
export function setWorkletRailwayBufferStatusHandler(value) { workletRailwayBufferStatusHandler = value; }
export function setCachedWaveformCanvas(value) { cachedWaveformCanvas = value; }
export function setCachedFullWaveformCanvas(value) { cachedFullWaveformCanvas = value; }
export function setWaveformMinMaxData(value) { 
    waveformMinMaxData = value;
    // Pre-compute and cache max amplitude for color LUT
    if (value && value.mins && value.maxs) {
        let maxAmp = 0;
        for (let i = 0; i < value.mins.length; i++) {
            const amplitude = Math.max(Math.abs(value.mins[i]), Math.abs(value.maxs[i]));
            if (amplitude > maxAmp) maxAmp = amplitude;
        }
        waveformMaxAmplitude = maxAmp;
    } else {
        waveformMaxAmplitude = null;
    }
}
export function setWaveformWorker(value) { waveformWorker = value; }
export function setCrossfadeAnimation(value) { crossfadeAnimation = value; }
export function setIsDragging(value) { isDragging = value; }
export function setScrubTargetPosition(value) { scrubTargetPosition = value; }
export function setSelectionStart(value) { selectionStart = value; }
export function setSelectionEnd(value) { selectionEnd = value; }
export function setIsSelecting(value) { isSelecting = value; }
export function setSelectionStartX(value) { selectionStartX = value; }
export function setWaveformHasBeenClicked(value) { waveformHasBeenClicked = value; }
export function setWaitingForSelection(value) { waitingForSelection = value; }
export function setWaitingForRegionCreation(value) { waitingForRegionCreation = value; }
export function setWaitingForRegionPlayClick(value) { waitingForRegionPlayClick = value; }
export function setWaitingForRegionPlayOrResume(value) { waitingForRegionPlayOrResume = value; }
export function setWaitingForRegionZoom(value) { waitingForRegionZoom = value; }
export function setWaitingForLoopButtonClick(value) { waitingForLoopButtonClick = value; }
export function setWaitingForFrequencyScaleChange(value) { waitingForFrequencyScaleChange = value; }
export function setWaitingForFrequencyScaleKeys(value) { waitingForFrequencyScaleKeys = value; }
export function setFrequencyScaleKeyPressCount(value) { frequencyScaleKeyPressCount = value; }
export function setSelectionTutorialResolve(value) { _selectionTutorialResolve = value; }
export function setWaveformClickResolve(value) { _waveformClickResolve = value; }
export function setRegionCreationResolve(value) { _regionCreationResolve = value; }
export function setRegionPlayClickResolve(value) { _regionPlayClickResolve = value; }
export function setRegionPlayOrResumeResolve(value) { _regionPlayOrResumeResolve = value; }
export function setRegionZoomResolve(value) { _regionZoomResolve = value; }
export function setLoopButtonClickResolve(value) { _loopButtonClickResolve = value; }
export function setFrequencyScaleChangeResolve(value) { _frequencyScaleChangeResolve = value; }
export function setFrequencyScaleKeysResolve(value) { _frequencyScaleKeysResolve = value; }
export function setWaitingForFeatureSelection(value) { waitingForFeatureSelection = value; }
export function setWaitingForFeatureDescription(value) { waitingForFeatureDescription = value; }
export function setWaitingForRepetitionDropdown(value) { waitingForRepetitionDropdown = value; }
export function setWaitingForTypeDropdown(value) { waitingForTypeDropdown = value; }
export function setWaitingForAddFeatureButtonClick(value) { waitingForAddFeatureButtonClick = value; }
export function setWaitingForZoomOut(value) { waitingForZoomOut = value; }
export function setWaitingForNumberKeyPress(value) { waitingForNumberKeyPress = value; }
export function setTargetNumberKey(value) { targetNumberKey = value; }
export function setWaitingForBeginAnalysisClick(value) { waitingForBeginAnalysisClick = value; }
export function setFeatureSelectionResolve(value) { _featureSelectionResolve = value; }
export function setFeatureDescriptionResolve(value) { _featureDescriptionResolve = value; }
export function setRepetitionDropdownResolve(value) { _repetitionDropdownResolve = value; }
export function setTypeDropdownResolve(value) { _typeDropdownResolve = value; }
export function setAddFeatureButtonClickResolve(value) { _addFeatureButtonClickResolve = value; }
export function setZoomOutResolve(value) { _zoomOutResolve = value; }
export function setNumberKeyPressResolve(value) { _numberKeyPressResolve = value; }
export function setBeginAnalysisClickResolve(value) { _beginAnalysisClickResolve = value; }
export function setRegionButtonsDisabled(value) { regionButtonsDisabled = value; }
export function setRegionPlayButtonEnabled(regionIndex, enabled) {
    if (enabled) {
        enabledRegionPlayButtons.set(regionIndex, true);
    } else {
        enabledRegionPlayButtons.delete(regionIndex);
    }
}
export function setRegionZoomButtonEnabled(regionIndex, enabled) {
    if (enabled) {
        enabledRegionZoomButtons.set(regionIndex, true);
    } else {
        enabledRegionZoomButtons.delete(regionIndex);
    }
}
export function isRegionPlayButtonEnabled(regionIndex) {
    return enabledRegionPlayButtons.has(regionIndex);
}
export function isRegionZoomButtonEnabled(regionIndex) {
    return enabledRegionZoomButtons.has(regionIndex);
}
export function setRegionCreationEnabled(value) {
    regionCreationEnabled = value;
}
export function isRegionCreationEnabled() {
    return regionCreationEnabled;
}
export function setRegions(value) { regions = value; }
export function setActiveRegionIndex(value) { activeRegionIndex = value; }
export function setIsSelectingFrequency(value) { isSelectingFrequency = value; }
export function setCurrentFrequencySelection(value) { currentFrequencySelection = value; }

