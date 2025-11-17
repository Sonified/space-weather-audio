/**
 * tutorial-sequence.js
 * Individual tutorial sequences
 * Contains logic for specific tutorials like speed slider tutorial
 */

import { setStatusText, appendStatusText, showTutorialOverlay, cancelTyping } from './tutorial-effects.js';
import { resetSpeedTo1, togglePlayPause } from './audio-player.js';
import * as State from './audio-state.js';
import { setTutorialPhase, clearTutorialPhase } from './tutorial-state.js';

// Speed slider tutorial state
let speedSliderTutorialActive = false;
let speedSliderInitialValue = 667; // 1.0x speed
let speedSliderLastValue = 667;
let speedSliderDirection = null; // 'faster' or 'slower'
let speedSliderCrossedThreshold = false;
let speedSliderTutorialResolve = null;
let speedSliderInteractionResolve = null;
let speedSliderDirectionResolve = null;
let speedSliderThresholdResolve = null;
let speedSliderClickResolve = null;
// 🔥 FIX: Track setTimeout IDs for cleanup to prevent memory leaks
let speedSliderInteractionTimeout = null;
let speedSliderDirectionTimeout = null;
let speedSliderThresholdTimeout = null;

/**
 * Helper: Wait for slider interaction (user starts dragging)
 */
function waitForSliderInteraction(speedSlider) {
    return new Promise((resolve) => {
        speedSliderInteractionResolve = resolve;
        const initialValue = parseFloat(speedSlider.value);
        
        // 🔥 FIX: Clear any existing timeout to prevent accumulation
        if (speedSliderInteractionTimeout !== null) {
            clearTimeout(speedSliderInteractionTimeout);
            speedSliderInteractionTimeout = null;
        }
        
        const checkInteraction = () => {
            // 🔥 FIX: Clear timeout ID when done
            speedSliderInteractionTimeout = null;
            
            if (!speedSliderTutorialActive) {
                resolve();
                return;
            }
            const currentValue = parseFloat(speedSlider.value);
            if (Math.abs(currentValue - initialValue) > 0.5) {
                resolve();
                return;
            }
            // 🔥 FIX: Store timeout ID for cleanup
            speedSliderInteractionTimeout = setTimeout(checkInteraction, 100);
        };
        checkInteraction();
    });
}

/**
 * Helper: Wait for direction to be detected
 */
function waitForDirectionDetection() {
    return new Promise((resolve) => {
        speedSliderDirectionResolve = resolve;
        
        // 🔥 FIX: Clear any existing timeout to prevent accumulation
        if (speedSliderDirectionTimeout !== null) {
            clearTimeout(speedSliderDirectionTimeout);
            speedSliderDirectionTimeout = null;
        }
        
        const checkDirection = () => {
            // 🔥 FIX: Clear timeout ID when done
            speedSliderDirectionTimeout = null;
            
            if (!speedSliderTutorialActive) {
                resolve();
                return;
            }
            if (speedSliderDirection !== null) {
                resolve();
                return;
            }
            // 🔥 FIX: Store timeout ID for cleanup
            speedSliderDirectionTimeout = setTimeout(checkDirection, 100);
        };
        checkDirection();
    });
}

/**
 * Helper: Wait for threshold cross (1.0x = 667)
 */
function waitForThresholdCross() {
    return new Promise((resolve) => {
        speedSliderThresholdResolve = resolve;
        
        // 🔥 FIX: Clear any existing timeout to prevent accumulation
        if (speedSliderThresholdTimeout !== null) {
            clearTimeout(speedSliderThresholdTimeout);
            speedSliderThresholdTimeout = null;
        }
        
        // Store phase for Enter key skipping BEFORE starting the check loop
        // This allows Enter key to skip the wait
        setTutorialPhase('waiting_for_threshold_cross', [], () => {
            if (speedSliderThresholdTimeout !== null) {
                clearTimeout(speedSliderThresholdTimeout);
                speedSliderThresholdTimeout = null;
            }
            // Mark threshold as crossed so tutorial can continue
            speedSliderCrossedThreshold = true;
            resolve();
        });
        
        const checkThreshold = () => {
            // 🔥 FIX: Clear timeout ID when done
            speedSliderThresholdTimeout = null;
            
            if (!speedSliderTutorialActive) {
                clearTutorialPhase();
                resolve();
                return;
            }
            if (speedSliderCrossedThreshold) {
                clearTutorialPhase();
                resolve();
                return;
            }
            // 🔥 FIX: Store timeout ID for cleanup
            speedSliderThresholdTimeout = setTimeout(checkThreshold, 100);
        };
        
        checkThreshold();
    });
}

/**
 * Helper: Wait for click on element
 */
function waitForClick(element) {
    return new Promise((resolve) => {
        speedSliderClickResolve = resolve;
        const handleClick = () => {
            element.removeEventListener('click', handleClick);
            resolve();
        };
        element.addEventListener('click', handleClick, { once: true });
    });
}

/**
 * Start speed slider tutorial (async/await version)
 */
export async function startSpeedSliderTutorial() {
    const speedSlider = document.getElementById('playbackSpeed');
    if (!speedSlider) {
        if (window._onSpeedSliderTutorialComplete) {
            window._onSpeedSliderTutorialComplete();
            window._onSpeedSliderTutorialComplete = null;
        }
        return;
    }
    
    speedSliderTutorialActive = true;
    speedSliderInitialValue = parseFloat(speedSlider.value);
    speedSliderLastValue = speedSliderInitialValue;
    speedSliderDirection = null;
    speedSliderCrossedThreshold = false;
    
    try {
        // Enable speed slider when tutorial starts
        speedSlider.disabled = false;
        const speedLabelEl = document.getElementById('speedLabel');
        if (speedLabelEl) {
            speedLabelEl.style.opacity = '1';
        }
        
        // Add glow to slider knob
        speedSlider.classList.add('speed-slider-glow');
        
        // Show initial tutorial message about dragging the slider
        setStatusText('👇 Drag the playback speed slider left/right to change playback speed.', 'status info');
        
        // Set up event handler for slider changes (detects interaction, direction, threshold)
        let hasInteracted = false;
        let recentValues = [];
        const TREND_WINDOW_SIZE = 20;
        const MIN_MOVEMENT_FOR_DIRECTION = 3;
        const THRESHOLD = 667;
        const TOLERANCE = 5;
        
        const handleSliderChange = () => {
            if (!speedSliderTutorialActive) return;
            
            const currentValue = parseFloat(speedSlider.value);
            
            // Detect interaction
            if (!hasInteracted && Math.abs(currentValue - speedSliderLastValue) > 0.5) {
                hasInteracted = true;
                if (speedSliderInteractionResolve) {
                    speedSliderInteractionResolve();
                    speedSliderInteractionResolve = null;
                }
            }
            
            // Track recent values for direction detection
            if (hasInteracted) {
                recentValues.push(currentValue);
                if (recentValues.length > TREND_WINDOW_SIZE) {
                    recentValues.shift();
                }
                
                // Detect direction
                if (speedSliderDirection === null && recentValues.length >= TREND_WINDOW_SIZE) {
                    const oldestValue = recentValues[0];
                    const newestValue = recentValues[recentValues.length - 1];
                    const totalMovement = Math.abs(newestValue - oldestValue);
                    
                    if (totalMovement >= MIN_MOVEMENT_FOR_DIRECTION) {
                        if (newestValue > oldestValue) {
                            speedSliderDirection = 'faster';
                        } else if (newestValue < oldestValue) {
                            speedSliderDirection = 'slower';
                        }
                        
                        if (speedSliderDirectionResolve) {
                            speedSliderDirectionResolve();
                            speedSliderDirectionResolve = null;
                        }
                    }
                }
            }
            
            // Detect threshold cross
            if (!speedSliderCrossedThreshold) {
                const wasBelow = speedSliderLastValue < (THRESHOLD - TOLERANCE);
                const wasAbove = speedSliderLastValue > (THRESHOLD + TOLERANCE);
                const isBelow = currentValue < (THRESHOLD - TOLERANCE);
                const isAbove = currentValue > (THRESHOLD + TOLERANCE);
                const isNearThreshold = currentValue >= (THRESHOLD - TOLERANCE) && currentValue <= (THRESHOLD + TOLERANCE);
                
                const crossedFromBelow = wasBelow && (isAbove || isNearThreshold);
                const crossedFromAbove = wasAbove && (isBelow || isNearThreshold);
                
                if (crossedFromBelow || crossedFromAbove) {
                    speedSliderCrossedThreshold = true;
                    if (speedSliderThresholdResolve) {
                        speedSliderThresholdResolve();
                        speedSliderThresholdResolve = null;
                    }
                }
            }
            
            speedSliderLastValue = currentValue;
        };
        
        speedSlider.addEventListener('input', handleSliderChange);
        speedSlider.addEventListener('change', handleSliderChange);
        speedSlider._tutorialHandler = handleSliderChange;
        
        // Wait for user to interact with slider
        await waitForSliderInteraction(speedSlider);
        if (!speedSliderTutorialActive) return;
        
        // Wait for direction to be detected
        await waitForDirectionDetection();
        if (!speedSliderTutorialActive) return;
        
        // Show frequency message based on direction
        await skippableWait(1000, 'speed_direction_wait');
        if (!speedSliderTutorialActive) return;
        
        if (speedSliderDirection === 'faster') {
            setStatusText('Notice how the frequencies stretch up as playback gets faster!', 'status info');
        } else if (speedSliderDirection === 'slower') {
            setStatusText('Notice how the frequencies compress down as playback gets slower!', 'status info');
        }
        
        // Wait 4 more seconds, then show "try other way"
        await skippableWait(4000, 'speed_try_other_way');
        if (!speedSliderTutorialActive) return;
        
        const directionEmoji = speedSliderDirection === 'faster' ? '👈' : '👉';
        setStatusText(`Now try going the other way. ${directionEmoji}`, 'status info');
        
        // Reset threshold flag so we wait for them to cross 1x speed going the other way
        speedSliderCrossedThreshold = false;
        
        // Wait for threshold cross (must cross 1x speed going the other direction)
        await waitForThresholdCross();
        if (!speedSliderTutorialActive) return;
        
        // Show "Great!" immediately when they hit 1x speed
        setStatusText('Great!', 'status success');
        
        // Show opposite direction message
        await skippableWait(2000, 'speed_opposite_wait');
        if (!speedSliderTutorialActive) return;
        
        if (speedSliderDirection === 'faster') {
            setStatusText('As the playback speed gets slower, the frequencies will fall.', 'status info');
        } else if (speedSliderDirection === 'slower') {
            setStatusText('As the playback speed gets faster, the frequencies will rise.', 'status info');
        }
        
        // Remove glow from slider, add to speed label
        await skippableWait(2000, 'speed_reset_wait');
        if (!speedSliderTutorialActive) return;
        
        speedSlider.classList.remove('speed-slider-glow');
        const speedValueEl = document.getElementById('speedValue');
        const speedLabel = document.getElementById('speedLabel');
        
        if (speedValueEl && speedLabel) {
            speedLabel.classList.add('speed-value-glow');
            
            // Show initial message with typing animation
            const initialSpeedText = speedValueEl.textContent || '1.0x';
            setStatusText(`↙️ Click on the text that says "Speed: ${initialSpeedText}" to reset the playback speed.`, 'status info');
            
            // Function to update just the speed value without retyping
            const updateSpeedMessage = () => {
                if (speedSliderTutorialActive && speedValueEl) {
                    const statusEl = document.getElementById('status');
                    if (statusEl) {
                        // Cancel any active typing animation first
                        cancelTyping();
                        
                        const currentSpeedText = speedValueEl.textContent || '1.0x';
                        // Update text directly without typing animation
                        statusEl.textContent = `↙️ Click on the text that says "Speed: ${currentSpeedText}" to reset the playback speed.`;
                    }
                }
            };
            
            // Watch for speed value changes and update without typing animation
            const speedValueObserver = new MutationObserver(() => {
                updateSpeedMessage();
            });
            
            speedValueObserver.observe(speedValueEl, {
                childList: true,
                characterData: true,
                subtree: true
            });
            
            speedSlider._speedValueObserver = speedValueObserver;
            
            // Wait for click on speed label
            await waitForClick(speedLabel);
            if (!speedSliderTutorialActive) return;
            
            // Clean up observer
            speedValueObserver.disconnect();
            speedSlider._speedValueObserver = null;
            
            // Reset speed
            resetSpeedTo1();
            speedLabel.classList.remove('speed-value-glow');
            
            // Wait 1 second, then show "Excellent"
            await skippableWait(1000, 'speed_excellent_wait');
            if (!speedSliderTutorialActive) return;
            
            setStatusText('Excellent!', 'status success');
            
            // Wait 2 seconds, then complete
            await skippableWait(2000, 'speed_complete');
        }
        
    } finally {
        endSpeedSliderTutorial();
        if (window._onSpeedSliderTutorialComplete) {
            window._onSpeedSliderTutorialComplete();
            window._onSpeedSliderTutorialComplete = null;
        }
    }
}

/**
 * End speed slider tutorial
 */
export function endSpeedSliderTutorial() {
    speedSliderTutorialActive = false;
    
    // 🔥 FIX: Clear all setTimeout chains to prevent memory leaks
    if (speedSliderInteractionTimeout !== null) {
        clearTimeout(speedSliderInteractionTimeout);
        speedSliderInteractionTimeout = null;
    }
    if (speedSliderDirectionTimeout !== null) {
        clearTimeout(speedSliderDirectionTimeout);
        speedSliderDirectionTimeout = null;
    }
    if (speedSliderThresholdTimeout !== null) {
        clearTimeout(speedSliderThresholdTimeout);
        speedSliderThresholdTimeout = null;
    }
    
    const speedSlider = document.getElementById('playbackSpeed');
    if (speedSlider) {
        speedSlider.classList.remove('speed-slider-glow');
        
        // Remove event listener
        if (speedSlider._tutorialHandler) {
            speedSlider.removeEventListener('input', speedSlider._tutorialHandler);
            speedSlider.removeEventListener('change', speedSlider._tutorialHandler);
            speedSlider._tutorialHandler = null;
        }
        
        // Disconnect speed value observer if it exists
        if (speedSlider._speedValueObserver) {
            speedSlider._speedValueObserver.disconnect();
            speedSlider._speedValueObserver = null;
        }
        
        const speedLabelForCleanup = document.getElementById('speedLabel');
        if (speedLabelForCleanup && speedSlider._speedLabelClickHandler) {
            speedLabelForCleanup.removeEventListener('click', speedSlider._speedLabelClickHandler);
            speedSlider._speedLabelClickHandler = null;
        }
    }
    
    // Remove glow from speed label/value
    const speedLabel = document.getElementById('speedLabel');
    if (speedLabel) {
        speedLabel.classList.remove('speed-value-glow');
    }
    const speedValue = document.getElementById('speedValue');
    if (speedValue) {
        speedValue.classList.remove('speed-value-glow');
    }
}

/**
 * Helper to get speed from slider value (same logic as audio-player.js)
 */
function getSpeedFromSliderValue(value) {
    let baseSpeed;
    if (value <= 667) {
        const normalized = value / 667;
        baseSpeed = 0.1 * Math.pow(10, normalized);
    } else {
        const normalized = (value - 667) / 333;
        baseSpeed = Math.pow(15, normalized);
    }
    return baseSpeed;
}

// Pause button tutorial state
let pauseButtonTutorialActive = false;
let pauseButtonTutorialResolve = null;
// 🔥 FIX: Track setTimeout ID for cleanup to prevent memory leaks
let pauseButtonStateTimeout = null;

/**
 * Check if pause button tutorial is currently active
 * Used by tutorial-coordinator to override pause detection
 */
export function isPauseButtonTutorialActive() {
    return pauseButtonTutorialActive;
}

/**
 * Helper: Create a skippable wait (for timed sections)
 * Enter key can skip these
 */
function skippableWait(durationMs, phase) {
    return new Promise((resolve) => {
        const timeoutId = setTimeout(resolve, durationMs);
        // Store timeout so Enter key can skip it
        setTutorialPhase(phase, [timeoutId], resolve);
    });
}

/**
 * Helper: Wait for playback state to change to target state
 */
function waitForPlaybackState(targetState, checkInterval = 100) {
    return new Promise((resolve) => {
        // 🔥 FIX: Clear any existing timeout to prevent accumulation
        if (pauseButtonStateTimeout !== null) {
            clearTimeout(pauseButtonStateTimeout);
            pauseButtonStateTimeout = null;
        }
        
        const checkState = () => {
            // 🔥 FIX: Clear timeout ID when done
            pauseButtonStateTimeout = null;
            
            if (!pauseButtonTutorialActive) {
                resolve();
                return;
            }
            if (State.playbackState === targetState) {
                resolve();
                return;
            }
            // 🔥 FIX: Store timeout ID for cleanup
            pauseButtonStateTimeout = setTimeout(checkState, checkInterval);
        };
        checkState();
    });
}

/**
 * Start pause button tutorial (async/await version)
 * Should be called after "This is the sound of..." message
 */
export async function startPauseButtonTutorial(onComplete = null) {
    const pauseButton = document.getElementById('playPauseBtn');
    if (!pauseButton) {
        if (onComplete) onComplete();
        return;
    }
    
    pauseButtonTutorialActive = true;
    pauseButtonTutorialResolve = onComplete;
    const PlaybackState = State.PlaybackState;
    
    try {
        // Add glow to pause button
        pauseButton.classList.add('pause-button-glow');
        
        // Show tutorial message
        setStatusText('Press the (space bar) or the pause button at any time to stop the audio.', 'status info');
        
        // After 4 seconds, if they haven't paused, append "Try it now"
        const tryNowTimeout = setTimeout(() => {
            if (pauseButtonTutorialActive && State.playbackState === PlaybackState.PLAYING) {
                appendStatusText('Try it now.', 20, 10);
            }
        }, 4000);
        
        // Wait for user to pause
        await waitForPlaybackState(PlaybackState.PAUSED);
        clearTimeout(tryNowTimeout);
        
        if (!pauseButtonTutorialActive) return;
        
        // Remove glow from pause button
        pauseButton.classList.remove('pause-button-glow');
        
        // Wait 1 second, then show "Now press again to start again"
        await skippableWait(1000, 'pause_button_wait');
        if (!pauseButtonTutorialActive) return;
        
        setStatusText('Now press again to start again.', 'status info');
        
        // Wait for user to resume
        await waitForPlaybackState(PlaybackState.PLAYING);
        if (!pauseButtonTutorialActive) return;
        
        // Wait 1 second, then type "Great!"
        await skippableWait(1000, 'pause_button_great');
        if (!pauseButtonTutorialActive) return;
        
        setStatusText('Great!', 'status success');
        
        // Wait 2 seconds after "Great!" finishes typing
        await skippableWait(2000, 'pause_button_complete');
        
    } finally {
        endPauseButtonTutorial();
        if (pauseButtonTutorialResolve) {
            pauseButtonTutorialResolve();
            pauseButtonTutorialResolve = null;
        }
    }
}

/**
 * End pause button tutorial
 */
export function endPauseButtonTutorial() {
    pauseButtonTutorialActive = false;
    
    // 🔥 FIX: Clear setTimeout chain to prevent memory leaks
    if (pauseButtonStateTimeout !== null) {
        clearTimeout(pauseButtonStateTimeout);
        pauseButtonStateTimeout = null;
    }
    
    const pauseButton = document.getElementById('playPauseBtn');
    if (pauseButton) {
        pauseButton.classList.remove('pause-button-glow');
    }
}

