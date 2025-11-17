/**
 * audio-state.js
 * Centralized state management for the audio player
 * All modules import and share this state
 */

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
export let currentMetadata = null;
export let totalAudioDuration = 0;
export let currentAudioPosition = 0;
export let dataStartTime = null; // UTC Date object for start of data
export let dataEndTime = null; // UTC Date object for end of data

// Flags
export let isFetchingNewData = false;
export let loadingInterval = null;
export let spectrogramInitialized = false;
export let visualizationStarted = false;
export let isShowingFinalWaveform = false;
export let justSeeked = false;  // Track if we just performed a seek (to avoid race conditions)
export let volcanoWithData = null;  // Track which volcano currently has data loaded

// Visualization state
export let frequencyScale = 'sqrt'; // 'linear', 'sqrt', or 'logarithmic'

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
export let regionButtonsDisabled = false;
export let enabledRegionPlayButtons = new Map(); // Map<regionIndex, enabled>
export let enabledRegionZoomButtons = new Map(); // Map<regionIndex, enabled>

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
export function setCompleteSamplesArray(value) { 
    // 🔥 FIX: Explicitly null old value before setting new one to help GC
    // This ensures the old Float32Array reference is broken before assignment
    if (completeSamplesArray !== value) {
        completeSamplesArray = null;
    }
    completeSamplesArray = value; 
}
export function setCurrentMetadata(value) { currentMetadata = value; }
export function setTotalAudioDuration(value) { totalAudioDuration = value; }
export function setCurrentAudioPosition(value) { currentAudioPosition = value; }
export function setDataStartTime(value) { dataStartTime = value; }
export function setDataEndTime(value) { dataEndTime = value; }
export function setIsFetchingNewData(value) { isFetchingNewData = value; }
export function setLoadingInterval(value) { loadingInterval = value; }
export function setSpectrogramInitialized(value) { spectrogramInitialized = value; }
export function setVisualizationStarted(value) { visualizationStarted = value; }
export function setIsShowingFinalWaveform(value) { isShowingFinalWaveform = value; }
export function setJustSeeked(value) { justSeeked = value; }
export function setFrequencyScale(value) { frequencyScale = value; }
export function setVolcanoWithData(value) { volcanoWithData = value; }
export function setPlaybackIndicatorRAF(value) { playbackIndicatorRAF = value; }
export function setSpectrogramRAF(value) { spectrogramRAF = value; }
export function setWorkletBufferStatusHandler(value) { workletBufferStatusHandler = value; }
export function setWorkletRailwayBufferStatusHandler(value) { workletRailwayBufferStatusHandler = value; }
export function setCachedWaveformCanvas(value) { cachedWaveformCanvas = value; }
export function setCachedFullWaveformCanvas(value) { cachedFullWaveformCanvas = value; }
export function setWaveformMinMaxData(value) { waveformMinMaxData = value; }
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
export function setFeatureSelectionResolve(value) { _featureSelectionResolve = value; }
export function setFeatureDescriptionResolve(value) { _featureDescriptionResolve = value; }
export function setRepetitionDropdownResolve(value) { _repetitionDropdownResolve = value; }
export function setTypeDropdownResolve(value) { _typeDropdownResolve = value; }
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
export function setRegions(value) { regions = value; }
export function setActiveRegionIndex(value) { activeRegionIndex = value; }
export function setIsSelectingFrequency(value) { isSelectingFrequency = value; }
export function setCurrentFrequencySelection(value) { currentFrequencySelection = value; }

