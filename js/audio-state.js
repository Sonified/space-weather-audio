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

// Visualization state
export let spectrogramScrollSpeed = 1.0;
export let spectrogramFrameCounter = 0;
export let frequencyScale = 'sqrt'; // 'linear', 'sqrt', or 'logarithmic'

// Animation frame IDs (for cleanup to prevent memory leaks)
export let playbackIndicatorRAF = null;
export let spectrogramRAF = null;

// Waveform rendering
export let cachedWaveformCanvas = null;
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
export function setCompleteSamplesArray(value) { completeSamplesArray = value; }
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
export function setSpectrogramScrollSpeed(value) { spectrogramScrollSpeed = value; }
export function setSpectrogramFrameCounter(value) { spectrogramFrameCounter = value; }
export function setFrequencyScale(value) { frequencyScale = value; }
export function setPlaybackIndicatorRAF(value) { playbackIndicatorRAF = value; }
export function setSpectrogramRAF(value) { spectrogramRAF = value; }
export function setCachedWaveformCanvas(value) { cachedWaveformCanvas = value; }
export function setWaveformMinMaxData(value) { waveformMinMaxData = value; }
export function setWaveformWorker(value) { waveformWorker = value; }
export function setCrossfadeAnimation(value) { crossfadeAnimation = value; }
export function setIsDragging(value) { isDragging = value; }
export function setScrubTargetPosition(value) { scrubTargetPosition = value; }
export function setSelectionStart(value) { selectionStart = value; }
export function setSelectionEnd(value) { selectionEnd = value; }
export function setIsSelecting(value) { isSelecting = value; }
export function setSelectionStartX(value) { selectionStartX = value; }
export function setRegions(value) { regions = value; }
export function setActiveRegionIndex(value) { activeRegionIndex = value; }
export function setIsSelectingFrequency(value) { isSelectingFrequency = value; }
export function setCurrentFrequencySelection(value) { currentFrequencySelection = value; }

