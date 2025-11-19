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
        // Enable speed and volume sliders when tutorial starts
        speedSlider.disabled = false;
        const speedLabelEl = document.getElementById('speedLabel');
        if (speedLabelEl) {
            speedLabelEl.style.opacity = '1';
        }
        
        // Enable volume slider too (user should be able to adjust during tutorial)
        const volumeSlider = document.getElementById('volumeSlider');
        if (volumeSlider) {
            volumeSlider.disabled = false;
            console.log('🔓 Volume slider ENABLED (during tutorial)');
        }
        const volumeLabelEl = document.getElementById('volumeLabel');
        if (volumeLabelEl) {
            volumeLabelEl.style.opacity = '1';
        }
        
        // Add glow to slider knob
        speedSlider.classList.add('speed-slider-glow');
        
        // Show initial tutorial message about dragging the slider
        setStatusText('👇 Drag the playback speed slider left/right to change playback speed.', 'status info');
        
        // ═══════════════════════════════════════════════════════════
        // STATE MACHINE: Polling-based detection with low-pass filter
        // ═══════════════════════════════════════════════════════════
        
        // State machine parameters
        const POLL_INTERVAL = 50; // 50ms polling rate (20 Hz)
        const LOW_PASS_ALPHA = 0.80; // Smoothing factor for low-pass filter
        const INITIAL_POSITIVE_THRESHOLD = 1.17; // 1.17x speed
        const INITIAL_NEGATIVE_THRESHOLD = 0.95; // 0.95x speed
        const CENTER_THRESHOLD = 1.0; // 1.0x speed (center)
        const COOLDOWN_MS = 100; // 100ms cooldown between state transitions
        
        // State machine state
        let stateMachineState = 'NEUTRAL'; // 'NEUTRAL' | 'POSITIVE' | 'NEGATIVE'
        let filteredSliderValue = speedSliderInitialValue;
        let positiveThreshold = INITIAL_POSITIVE_THRESHOLD;
        let negativeThreshold = INITIAL_NEGATIVE_THRESHOLD;
        let lastTransitionTime = 0;
        let hasInteracted = false;
        let pollingIntervalId = null;
        
        // Helper: Convert slider value to speed
        const sliderValueToSpeed = (value) => {
            if (value <= 667) {
                const normalized = value / 667;
                return 0.1 * Math.pow(10, normalized);
            } else {
                const normalized = (value - 667) / 333;
                return Math.pow(15, normalized);
            }
        };
        
        // State machine polling loop
        const stateMachineLoop = () => {
            if (!speedSliderTutorialActive) {
                return; // Stop if tutorial ended
            }
            
            // Read raw slider value
            const rawValue = parseFloat(speedSlider.value);
            
            // Apply low-pass filter: filteredValue = alpha * lastFiltered + (1 - alpha) * rawValue
            filteredSliderValue = LOW_PASS_ALPHA * filteredSliderValue + (1 - LOW_PASS_ALPHA) * rawValue;
            
            // Convert to speed
            const filteredSpeed = sliderValueToSpeed(filteredSliderValue);
            
            // Detect interaction (any movement from initial position)
            if (!hasInteracted && Math.abs(filteredSliderValue - speedSliderInitialValue) > 1.0) {
                hasInteracted = true;
                console.log('🎮 [STATE MACHINE] User interaction detected');
                if (speedSliderInteractionResolve) {
                    speedSliderInteractionResolve();
                    speedSliderInteractionResolve = null;
                }
            }
            
            // Check cooldown
            const now = Date.now();
            const inCooldown = (now - lastTransitionTime) < COOLDOWN_MS;
            
            if (!inCooldown && hasInteracted) {
                // State transitions
                if (stateMachineState === 'NEUTRAL') {
                    // NEUTRAL → POSITIVE or NEGATIVE
                    if (filteredSpeed >= positiveThreshold) {
                        stateMachineState = 'POSITIVE';
                        speedSliderDirection = 'faster';
                        negativeThreshold = CENTER_THRESHOLD; // Set new threshold for opposite direction
                        lastTransitionTime = now;
                        console.log(`🎮 [STATE MACHINE] NEUTRAL → POSITIVE (speed: ${filteredSpeed.toFixed(2)}x)`);
                        
                        if (speedSliderDirectionResolve) {
                            speedSliderDirectionResolve();
                            speedSliderDirectionResolve = null;
                        }
                    } else if (filteredSpeed <= negativeThreshold) {
                        stateMachineState = 'NEGATIVE';
                        speedSliderDirection = 'slower';
                        positiveThreshold = CENTER_THRESHOLD; // Set new threshold for opposite direction
                        lastTransitionTime = now;
                        console.log(`🎮 [STATE MACHINE] NEUTRAL → NEGATIVE (speed: ${filteredSpeed.toFixed(2)}x)`);
                        
                        if (speedSliderDirectionResolve) {
                            speedSliderDirectionResolve();
                            speedSliderDirectionResolve = null;
                        }
                    }
                } else if (stateMachineState === 'POSITIVE') {
                    // POSITIVE → NEGATIVE (crossing center going down)
                    if (filteredSpeed <= negativeThreshold) {
                        stateMachineState = 'NEGATIVE';
                        speedSliderCrossedThreshold = true;
                        lastTransitionTime = now;
                        console.log(`🎮 [STATE MACHINE] POSITIVE → NEGATIVE (crossed center at ${filteredSpeed.toFixed(2)}x)`);
                        
                        if (speedSliderThresholdResolve) {
                            speedSliderThresholdResolve();
                            speedSliderThresholdResolve = null;
                        }
                    }
                } else if (stateMachineState === 'NEGATIVE') {
                    // NEGATIVE → POSITIVE (crossing center going up)
                    if (filteredSpeed >= positiveThreshold) {
                        stateMachineState = 'POSITIVE';
                        speedSliderCrossedThreshold = true;
                        lastTransitionTime = now;
                        console.log(`🎮 [STATE MACHINE] NEGATIVE → POSITIVE (crossed center at ${filteredSpeed.toFixed(2)}x)`);
                        
                        if (speedSliderThresholdResolve) {
                            speedSliderThresholdResolve();
                            speedSliderThresholdResolve = null;
                        }
                    }
                }
            }
        };
        
        // Start polling loop
        console.log('🎮 [STATE MACHINE] Starting 50ms polling loop');
        pollingIntervalId = setInterval(stateMachineLoop, POLL_INTERVAL);
        
        // Store interval ID for cleanup
        speedSlider._stateMachineIntervalId = pollingIntervalId;
        
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
        
        // Check if they've already crossed the threshold going the other way
        const currentSliderValue = parseFloat(speedSlider.value);
        const oppositeDirection = speedSliderDirection === 'faster' ? 'slower' : 'faster';
        
        // Convert current slider value to speed
        let currentSpeed;
        if (currentSliderValue <= 667) {
            const normalized = currentSliderValue / 667;
            currentSpeed = 0.1 * Math.pow(10, normalized);
        } else {
            const normalized = (currentSliderValue - 667) / 333;
            currentSpeed = Math.pow(15, normalized);
        }
        
        const CENTER_SPEED = 1.0;
        const SPEED_TOLERANCE = 0.05; // 5% tolerance (0.95x - 1.05x)
        
        // Determine if they've already crossed based on direction
        let alreadyCrossed = false;
        if (oppositeDirection === 'slower') {
            // They went faster first, now check if they're already slower (below center)
            alreadyCrossed = currentSpeed < (CENTER_SPEED - SPEED_TOLERANCE);
        } else {
            // They went slower first, now check if they're already faster (above center)
            alreadyCrossed = currentSpeed > (CENTER_SPEED + SPEED_TOLERANCE);
        }
        
        if (!alreadyCrossed) {
            // Reset threshold flag so we wait for them to cross 1x speed going the other way
            speedSliderCrossedThreshold = false;
            
            // Wait for threshold cross (must cross 1x speed going the other direction) with 10s timeout
            const thresholdPromise = waitForThresholdCross();
            const timeoutPromise = new Promise((resolve) => {
                setTimeout(() => {
                    if (speedSliderTutorialActive && !speedSliderCrossedThreshold) {
                        // Timeout reached, resolve anyway
                        speedSliderCrossedThreshold = true;
                        if (speedSliderThresholdResolve) {
                            speedSliderThresholdResolve();
                            speedSliderThresholdResolve = null;
                        }
                        resolve();
                    }
                }, 10000);
            });
            
            await Promise.race([thresholdPromise, timeoutPromise]);
            if (!speedSliderTutorialActive) return;
        }
        
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
        await skippableWait(6000, 'speed_reset_wait');
        if (!speedSliderTutorialActive) return;
        
        speedSlider.classList.remove('speed-slider-glow');
        const speedValueEl = document.getElementById('speedValue');
        const speedLabel = document.getElementById('speedLabel');
        
        if (speedValueEl && speedLabel) {
            speedLabel.classList.add('speed-value-glow');
            
            // Show initial message with typing animation
            const initialSpeedText = speedValueEl.textContent || '1.0x';
            setStatusText(`↙️ Click on the GLOWING text that says "Speed: ${initialSpeedText}" to reset the playback speed.`, 'status info');
            
            // Function to update just the speed value without retyping
            const updateSpeedMessage = () => {
                if (speedSliderTutorialActive && speedValueEl) {
                    const statusEl = document.getElementById('status');
                    if (statusEl) {
                        // Cancel any active typing animation first
                        cancelTyping();
                        
                        const currentSpeedText = speedValueEl.textContent || '1.0x';
                        // Update text directly without typing animation
                        statusEl.textContent = `↙️ Click on the GLOWING text that says "Speed: ${currentSpeedText}" to reset the playback speed.`;
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
            
            // Immediately update status text to show reset
            setStatusText('The playback speed has been reset.', 'status success');
            
            // Wait 2 seconds, then complete
            await skippableWait(2000, 'speed_reset_complete');
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
        
        // Stop state machine polling loop
        if (speedSlider._stateMachineIntervalId) {
            console.log('🎮 [STATE MACHINE] Stopping polling loop');
            clearInterval(speedSlider._stateMachineIntervalId);
            speedSlider._stateMachineIntervalId = null;
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
        
        // Wait 1 second after "Great!" finishes typing
        await skippableWait(1000, 'pause_button_complete');
        
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

