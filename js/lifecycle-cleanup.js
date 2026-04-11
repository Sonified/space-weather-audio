// lifecycle-cleanup.js — Page unload cleanup and visibility change handlers

import * as State from './audio-state.js';
import { PlaybackState } from './audio-state.js';
import { cleanupSpectrogramSelection, setupSpectrogramSelection, redrawAllCanvasFeatureBoxes } from './spectrogram-renderer.js';
import { clearCompleteSpectrogram, aggressiveCleanup } from './main-window-renderer.js';
import { clearWaveformRenderer, startPlaybackIndicator } from './minimap-window-renderer.js';
import { cancelZoomTransitionRAF, stopZoomTransition } from './minimap-x-axis-renderer.js';
import { cleanupKeyboardShortcuts } from './keyboard-shortcuts.js';
import { stopOscilloscope, initOscilloscope } from './oscilloscope-renderer.js';
import { exitOverheatMode } from './core/flame-engine.js';

/**
 * Set up all lifecycle cleanup handlers (beforeunload, pagehide, visibilitychange).
 * Call this once during app initialization.
 */
export function setupLifecycleHandlers() {
    // 🔥 FIX: Cancel all RAF callbacks on page unload to prevent detached document leaks
    // This ensures RAF callbacks scheduled before page unload are cancelled
    // 🔥 FIX: Use static imports instead of dynamic imports to prevent Context leaks
    // Dynamic imports create new Context instances each time, causing massive memory leaks
    // Since minimap-x-axis-renderer.js is already imported statically at the top, use it directly
    if (!window._solarAudioCleanupHandlers) {
        window._solarAudioCleanupHandlers = {};

        // Import only modules that aren't already statically imported
    import('./audio-player.js').then(audioPlayerModule => {
        import('./spectrogram-axis-renderer.js').then(axisModule => {
                // 🔥 FIX: Use statically imported functions instead of dynamic import
                // This prevents creating new Context instances (147k+ Context leak!)
                const cleanupOnUnload = () => {
                    // Cancel all animation loops
                    audioPlayerModule.cancelAllRAFLoops();
                    axisModule.cancelScaleTransitionRAF();
                    cancelZoomTransitionRAF();

                    // Cleanup event listeners
                    cleanupSpectrogramSelection();
                    cleanupKeyboardShortcuts();

                    // Dispose GPU resources (Three.js textures, materials, geometry)
                    clearCompleteSpectrogram();
                    clearWaveformRenderer();

                    // Terminate waveform worker
                    if (State.waveformWorker) {
                        State.waveformWorker.terminate();
                        State.setWaveformWorker(null);
                    }

                    // Close AudioContext (releases system audio resources)
                    if (State.audioContext && State.audioContext.state !== 'closed') {
                        State.audioContext.close().catch(() => {});
                    }

                    // Null large data arrays to help GC
                    aggressiveCleanup();
                    window.rawWaveformData = null;
                    window.displayWaveformData = null;
                };
                window._solarAudioCleanupHandlers.cleanupOnUnload = cleanupOnUnload;

                // 🔥 FIX: Only set window.stopZoomTransition once to prevent function accumulation
                // Use statically imported function instead of dynamic import
                if (!window.stopZoomTransition) {
                    window.stopZoomTransition = stopZoomTransition;
                }

                // 🔥 FIX: Remove old listeners before adding new ones to prevent accumulation
                // Use stored reference so removeEventListener can match
                if (window._solarAudioCleanupHandlers.beforeunload) {
                    window.removeEventListener('beforeunload', window._solarAudioCleanupHandlers.beforeunload);
                }
                if (window._solarAudioCleanupHandlers.pagehide) {
                    window.removeEventListener('pagehide', window._solarAudioCleanupHandlers.pagehide);
                }
                window.addEventListener('beforeunload', cleanupOnUnload);
                window._solarAudioCleanupHandlers.beforeunload = cleanupOnUnload;

                // Also handle pagehide (more reliable than beforeunload in some browsers)
                window.addEventListener('pagehide', cleanupOnUnload);
                window._solarAudioCleanupHandlers.pagehide = cleanupOnUnload;

                // 🔥 FIX: Store visibility change handler reference for cleanup
                const visibilityChangeHandler = () => {
                    if (document.hidden) {
                        // Aggressive cleanup when hidden - stop all processing
                        if (window.pm?.render) console.log('💤 Page hidden - aggressive cleanup');
                        audioPlayerModule.cancelAllRAFLoops();
                        axisModule.cancelScaleTransitionRAF();
                        stopOscilloscope();
                        exitOverheatMode();
                        cleanupSpectrogramSelection(); // Destroy canvas overlay
                    } else {
                        // Page visible again - recreate everything and restore state
                        if (window.pm?.render) console.log('👁️ Page visible again - recreating canvas and restoring state');

                        // Recreate spectrogram selection canvas
                        setupSpectrogramSelection();

                        // Redraw all feature boxes on fresh canvas
                        redrawAllCanvasFeatureBoxes();

                        // Restart oscilloscope + its data feed from analyser
                        initOscilloscope();
                        // Re-kick data collection if analyser exists
                        import('./audio-worklet-init.js').then(m => {
                            if (m.restartOscilloscopeData) m.restartOscilloscopeData();
                        });

                        // Restart playhead if playing when tab becomes visible again
                        if (State.playbackState === PlaybackState.PLAYING) {
                            startPlaybackIndicator();
                        }
                    }
                };
                if (window._solarAudioCleanupHandlers.visibilitychange) {
                    document.removeEventListener('visibilitychange', window._solarAudioCleanupHandlers.visibilitychange);
                }
                document.addEventListener('visibilitychange', visibilityChangeHandler);
                window._solarAudioCleanupHandlers.visibilitychange = visibilityChangeHandler;
        });
    });
    } // End if (!window._solarAudioCleanupHandlers)
}
