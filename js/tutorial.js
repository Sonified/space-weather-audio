/**
 * tutorial.js
 * Tutorial overlay and guidance system
 * Main entry point - re-exports from tutorial-effects, tutorial-sequence, and tutorial-state
 * Maintains backward compatibility with existing imports
 */

// Re-export all effects
export {
    showTutorialOverlay,
    hideTutorialOverlay,
    shouldShowPulse,
    markPulseShown,
    typeText,
    cancelTyping,
    skipAnimations,
    setStatusText,
    appendStatusText,
    addSpectrogramGlow,
    removeSpectrogramGlow,
    addRegionsPanelGlow,
    removeRegionsPanelGlow,
    addVolumeSliderGlow,
    removeVolumeSliderGlow,
    disableWaveformClicks,
    enableWaveformClicks,
    disableRegionButtons,
    enableRegionButtons
} from './tutorial-effects.js';

// Re-export all sequences
export {
    startSpeedSliderTutorial,
    endSpeedSliderTutorial,
    startPauseButtonTutorial,
    endPauseButtonTutorial
} from './tutorial-sequence.js';

// Re-export state management
export {
    setTutorialPhase,
    clearTutorialPhase,
    advanceTutorialPhase,
    initTutorial
} from './tutorial-state.js';

// Re-export the coordinator
export { runMainTutorial } from './tutorial-coordinator.js';
