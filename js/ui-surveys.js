/**
 * ui-surveys.js
 * Survey submission logic and final Qualtrics submission.
 * Extracted from ui-controls.js for maintainability.
 */

import { submitCombinedSurveyResponse, getParticipantId, storeParticipantId } from './qualtrics-api.js';
import {
    saveSurveyResponse,
    getSessionResponses,
    getSessionState,
    isSessionComplete,
    getResponsesForSubmission,
    markSessionAsSubmitted,
    exportResponseMetadata
} from '../Qualtrics/participant-response-manager.js';
import { getRegions } from './region-tracker.js';
import { CURRENT_MODE, AppMode } from './master-modes.js';
import * as State from './audio-state.js';
import { STORAGE_KEYS } from './study-workflow.js';

export function submitParticipantSetup() {
    const participantId = document.getElementById('participantId').value.trim();
    
    // Save to localStorage for persistence across sessions
    if (participantId) {
        storeParticipantId(participantId);
        console.log('💾 Saved participant ID:', participantId);
        // Set EMIC registration flag + sync to server
        import('./master-modes.js').then(({ isEmicStudyMode }) => {
            if (isEmicStudyMode()) {
                import('./emic-study-flags.js').then(({ EMIC_FLAGS, setEmicFlag }) => {
                    setEmicFlag(EMIC_FLAGS.HAS_REGISTERED);
                });
                import('./data-uploader.js').then(({ syncEmicProgress }) => {
                    syncEmicProgress(participantId, 'registered');
                });
            }
        });
    } else {
        // If empty, remove from localStorage
        localStorage.removeItem('participantId');
        console.log('🗑️ Removed participant ID from storage');
    }
    
    console.log('📝 Participant Setup:');
    console.log('  - Participant ID:', participantId || '(none)');
    console.log('  - Timestamp:', new Date().toISOString());
    
    const statusEl = document.getElementById('status');
    statusEl.className = 'status success';
    statusEl.textContent = `✅ User Name Recorded`;

    // In Solar Portal mode, animate follow-up instruction after a brief delay
    // (Skip for shared sessions - they already have data loaded)
    const isSharedSession = sessionStorage.getItem('isSharedSession') === 'true';
    if (CURRENT_MODE === AppMode.SOLAR_PORTAL && !isSharedSession) {
        setTimeout(async () => {
            const { typeText } = await import('./tutorial-effects.js');
            statusEl.className = 'status info';
            const msg = State.isMobileScreen() ? 'Click Fetch Data to begin' : '👈 click Fetch Data to begin';
            typeText(statusEl, msg, 15, 5);
        }, 1200);
    }

    // Update participant ID display in top panel
    // Always show the display (even if no ID set) so users can click to enter their ID
    const displayElement = document.getElementById('participantIdDisplay');
    const valueElement = document.getElementById('participantIdValue');
    
    if (displayElement) displayElement.style.display = 'block';
    if (valueElement) valueElement.textContent = participantId || '--';
    
    // 🔥 REMOVED: Don't manually hide modal or fade overlay
    // Let the button handler and ModalManager do their job!
    // The workflow is waiting for the modal to properly close through ModalManager.
}

export async function submitPreSurvey() {
    const surveyData = {
        surveyType: 'pre',
        calm: document.querySelector('input[name="preCalm"]:checked')?.value || null,
        energized: document.querySelector('input[name="preEnergized"]:checked')?.value || null,
        connected: document.querySelector('input[name="preConnected"]:checked')?.value || null,
        nervous: document.querySelector('input[name="preNervous"]:checked')?.value || null,
        focused: document.querySelector('input[name="preFocused"]:checked')?.value || null,
        wonder: document.querySelector('input[name="preWonder"]:checked')?.value || null,
        timestamp: new Date().toISOString()
    };
    
    // Verify all questions are answered (button should be disabled if not, but double-check)
    const allAnswered = surveyData.calm && surveyData.energized && surveyData.connected && 
                        surveyData.nervous && surveyData.focused && surveyData.wonder;
    
    if (!allAnswered) {
        alert('Please answer all questions before submitting.');
        return;
    }
    
    // Get participant ID (from URL or localStorage) - optional for pre-survey
    const participantId = getParticipantId();
    
    // Allow pre-survey submission without participant ID (user can set it later)
    // Only require participant ID for saving responses, but allow submission to proceed
    if (!participantId) {
        console.log('⚠️ Pre-Survey submitted without participant ID - responses will not be saved');
    }
    
    console.log('📊 Pre-Survey Data:');
    console.log('  - Survey Type: Pre-Survey');
    console.log('  - Participant ID:', participantId || 'Not set');
    console.log('  - Calm:', surveyData.calm || 'not rated');
    console.log('  - Energized:', surveyData.energized || 'not rated');
    console.log('  - Connected to nature:', surveyData.connected || 'not rated');
    console.log('  - Nervous:', surveyData.nervous || 'not rated');
    console.log('  - Focused:', surveyData.focused || 'not rated');
    console.log('  - A sense of wonder:', surveyData.wonder || 'not rated');
    console.log('  - Timestamp:', surveyData.timestamp);
    
    const statusEl = document.getElementById('status');
    
    try {
        // Save response locally if participant ID is available
        if (participantId) {
            statusEl.className = 'status info';
            statusEl.textContent = '💾 Saving pre-survey response...';
            
            saveSurveyResponse(participantId, 'pre', surveyData);
            
            statusEl.className = 'status success';
            statusEl.textContent = '✅ Pre-Survey saved!';
            
            // Start session tracking (analysis session begins after pre-survey)
            try {
                const { startSession } = await import('./study-workflow.js');
                startSession();
                console.log('🚀 Session tracking started');
            } catch (error) {
                console.warn('⚠️ Could not start session tracking:', error);
            }
            
            // Wait 3s, then show next instruction (only if data not fetched AND tutorial not active)
            setTimeout(async () => {
                // Check if tutorial is active - if so, let tutorial control messages
                const { isTutorialActive } = await import('./tutorial-state.js');
                if (isTutorialActive()) {
                    return; // Tutorial controls its own messages
                }
                
                // Check if data has already been fetched
                const State = await import('./audio-state.js');
                const hasData = State.completeSamplesArray && State.completeSamplesArray.length > 0;
                
                // Only show fetch instruction if no data loaded yet
                // if (!hasData) {
                //     const { setStatusText } = await import('./tutorial-effects.js');
                //     setStatusText('<- Select a volcano to the left and hit Fetch Data to begin.', 'status info');
                // }
                // If data exists, the data-fetcher already set "Click Begin Analysis" message
            }, 3000);
            
            // Modal will be closed by event handler
        } else {
            // No participant ID - show warning modal after pre-survey closes
            // Event handler will close pre-survey modal, then we'll open missing study ID modal
            setTimeout(() => {
                import('./ui-modals.js').then(m => m.openMissingStudyIdModal());
            }, 350); // Wait for modal close animation
        }
        
        // Mark pre-survey as completed today (regardless of participant ID)
        const { markPreSurveyCompletedToday } = await import('./study-workflow.js');
        markPreSurveyCompletedToday();
        
        // Form doesn't need to clear itself - when modal reopens, it will be fresh
    } catch (error) {
        console.error('Failed to save pre-survey:', error);
        statusEl.className = 'status error';
        statusEl.textContent = `❌ Failed to save: ${error.message}`;
        // Don't close modal on error so user can try again
    }
}

export async function submitPostSurvey() {
    const surveyData = {
        surveyType: 'post',
        calm: document.querySelector('input[name="postCalm"]:checked')?.value || null,
        energized: document.querySelector('input[name="postEnergized"]:checked')?.value || null,
        connected: document.querySelector('input[name="postConnected"]:checked')?.value || null,
        nervous: document.querySelector('input[name="postNervous"]:checked')?.value || null,
        focused: document.querySelector('input[name="postFocused"]:checked')?.value || null,
        wonder: document.querySelector('input[name="postWonder"]:checked')?.value || null,
        timestamp: new Date().toISOString()
    };
    
    // Verify all questions are answered (button should be disabled if not, but double-check)
    const allAnswered = surveyData.calm && surveyData.energized && surveyData.connected && 
                        surveyData.nervous && surveyData.focused && surveyData.wonder;
    
    if (!allAnswered) {
        alert('Please answer all questions before submitting.');
        return;
    }
    
    // Get participant ID (from URL or localStorage)
    const participantId = getParticipantId();
    
    if (!participantId) {
        alert('Please set your participant ID before submitting surveys.');
        return;
    }
    
    console.log('📊 Post-Survey Data:');
    console.log('  - Survey Type: Post-Survey');
    console.log('  - Participant ID:', participantId);
    console.log('  - Calm:', surveyData.calm || 'not rated');
    console.log('  - Energized:', surveyData.energized || 'not rated');
    console.log('  - Connected to nature:', surveyData.connected || 'not rated');
    console.log('  - Nervous:', surveyData.nervous || 'not rated');
    console.log('  - Focused:', surveyData.focused || 'not rated');
    console.log('  - A sense of wonder:', surveyData.wonder || 'not rated');
    console.log('  - Timestamp:', surveyData.timestamp);
    
    const statusEl = document.getElementById('status');
    
    try {
        // Save response locally instead of submitting immediately
        statusEl.className = 'status info';
        statusEl.textContent = '💾 Saving post-survey response...';
        
        saveSurveyResponse(participantId, 'post', surveyData);
        
        statusEl.className = 'status success';
        statusEl.textContent = '✅ Post-Survey saved! Complete all surveys to submit.';
        
        // Modal will be closed by event handler
        // Form doesn't need to clear itself - when modal reopens, it will be fresh
    } catch (error) {
        console.error('Failed to save post-survey:', error);
        statusEl.className = 'status error';
        statusEl.textContent = `❌ Failed to save: ${error.message}`;
        // Don't close modal on error so user can try again
    }
}

export async function submitActivityLevelSurvey() {
    const surveyData = {
        surveyType: 'activityLevel',
        activityLevel: document.querySelector('input[name="activityLevel"]:checked')?.value || null,
        timestamp: new Date().toISOString()
    };
    
    // Verify question is answered
    if (!surveyData.activityLevel) {
        alert('Please select an activity level before submitting.');
        return false;
    }
    
    // Get participant ID (from URL or localStorage)
    const participantId = getParticipantId();
    
    if (!participantId) {
        alert('Please set your participant ID before submitting surveys.');
        return false;
    }
    
    console.log('🌋 Activity Level Survey Data:');
    console.log('  - Participant ID:', participantId);
    console.log('  - Activity Level:', surveyData.activityLevel || 'not rated');
    console.log('  - Timestamp:', surveyData.timestamp);
    
    const statusEl = document.getElementById('status');
    
    try {
        // Save response locally instead of submitting immediately
        statusEl.className = 'status info';
        statusEl.textContent = '💾 Saving activity level response...';
        
        saveSurveyResponse(participantId, 'activityLevel', surveyData);
        
        statusEl.className = 'status success';
        statusEl.textContent = '✅ Activity Level saved! Complete all surveys to submit.';
        
        // Modal will be closed by event handler
        // Form doesn't need to clear itself - when modal reopens, it will be fresh
        
        return true;
    } catch (error) {
        console.error('Failed to save activity level survey:', error);
        statusEl.className = 'status error';
        statusEl.textContent = `❌ Failed to save: ${error.message}`;
        // Don't close modal on error so user can try again
        return false;
    }
}

export async function submitAwesfSurvey() {
    const surveyData = {
        surveyType: 'awesf',
        slowDown: document.querySelector('input[name="slowDown"]:checked')?.value || null,
        reducedSelf: document.querySelector('input[name="reducedSelf"]:checked')?.value || null,
        chills: document.querySelector('input[name="chills"]:checked')?.value || null,
        oneness: document.querySelector('input[name="oneness"]:checked')?.value || null,
        grand: document.querySelector('input[name="grand"]:checked')?.value || null,
        diminishedSelf: document.querySelector('input[name="diminishedSelf"]:checked')?.value || null,
        timeSlowing: document.querySelector('input[name="timeSlowing"]:checked')?.value || null,
        awesfConnected: document.querySelector('input[name="awesfConnected"]:checked')?.value || null,
        small: document.querySelector('input[name="small"]:checked')?.value || null,
        vastness: document.querySelector('input[name="vastness"]:checked')?.value || null,
        challenged: document.querySelector('input[name="challenged"]:checked')?.value || null,
        selfShrink: document.querySelector('input[name="selfShrink"]:checked')?.value || null,
        timestamp: new Date().toISOString()
    };
    
    // Verify all questions are answered
    const allAnswered = surveyData.slowDown && surveyData.reducedSelf && surveyData.chills && 
                        surveyData.oneness && surveyData.grand && surveyData.diminishedSelf &&
                        surveyData.timeSlowing && surveyData.awesfConnected && surveyData.small &&
                        surveyData.vastness && surveyData.challenged && surveyData.selfShrink;
    
    if (!allAnswered) {
        alert('Please answer all questions before submitting.');
        return;
    }
    
    // Get participant ID (from URL or localStorage)
    const participantId = getParticipantId();
    
    if (!participantId) {
        alert('Please set your participant ID before submitting surveys.');
        return;
    }
    
    console.log('✨ AWE-SF Survey Data:');
    console.log('  - Participant ID:', participantId);
    console.log('  - I sensed things momentarily slow down:', surveyData.slowDown || 'not rated');
    console.log('  - I experienced a reduced sense of self:', surveyData.reducedSelf || 'not rated');
    console.log('  - I had chills:', surveyData.chills || 'not rated');
    console.log('  - I experienced a sense of oneness with all things:', surveyData.oneness || 'not rated');
    console.log('  - I felt that I was in the presence of something grand:', surveyData.grand || 'not rated');
    console.log('  - I felt that my sense of self was diminished:', surveyData.diminishedSelf || 'not rated');
    console.log('  - I noticed time slowing:', surveyData.timeSlowing || 'not rated');
    console.log('  - I had the sense of being connected to everything:', surveyData.awesfConnected || 'not rated');
    console.log('  - I felt small compared to everything else:', surveyData.small || 'not rated');
    console.log('  - I perceived vastness:', surveyData.vastness || 'not rated');
    console.log('  - I felt challenged to understand the experience:', surveyData.challenged || 'not rated');
    console.log('  - I felt my sense of self shrink:', surveyData.selfShrink || 'not rated');
    console.log('  - Timestamp:', surveyData.timestamp);
    
    const statusEl = document.getElementById('status');
    
    try {
        // Save response locally instead of submitting immediately
        statusEl.className = 'status info';
        statusEl.textContent = '💾 Saving AWE-SF response...';
        
        saveSurveyResponse(participantId, 'awesf', surveyData);
        
        statusEl.className = 'status success';
        statusEl.textContent = '✅ AWE-SF saved! Complete all surveys to submit.';
        
        // Modal will be closed by event handler
        // Form doesn't need to clear itself - when modal reopens, it will be fresh
    } catch (error) {
        console.error('Failed to save AWE-SF survey:', error);
        statusEl.className = 'status error';
        statusEl.textContent = `❌ Failed to save: ${error.message}`;
        // Don't close modal on error so user can try again
    }
}

/**
 * Check if session is complete and submit all responses to Qualtrics if ready
 * @param {string} participantId - The participant ID
 */
async function checkAndSubmitIfComplete(participantId) {
    if (!participantId) return;
    
    try {
        // Check if session is complete
        if (isSessionComplete(participantId)) {
            const combinedResponses = getResponsesForSubmission(participantId);
            
            if (combinedResponses) {
                const statusEl = document.getElementById('status');
                statusEl.className = 'status info';
                statusEl.textContent = '📤 All surveys complete! Submitting to Qualtrics...';
                
                console.log('📤 Submitting combined responses to Qualtrics:', combinedResponses);
                
                const submissionResult = await submitCombinedSurveyResponse(combinedResponses, participantId);
                
                // Extract Qualtrics Response ID
                let qualtricsResponseId = null;
                if (submissionResult && submissionResult.result && submissionResult.result.responseId) {
                    qualtricsResponseId = submissionResult.result.responseId;
                    console.log('📋 Qualtrics Response ID:', qualtricsResponseId);
                }
                
                // EMIC study mode: upload to EMIC R2 endpoint (emic-data bucket)
                // Build submission data from what's available in this scope
                try {
                    const { isEmicStudyMode: isEmic } = await import('./master-modes.js');
                    if (isEmic()) {
                        const { uploadEmicSubmission } = await import('./data-uploader.js');
                        const { getStandaloneFeatures } = await import('./region-tracker.js');

                        // Build features from standalone features (EMIC study uses direct canvas drawing)
                        const standalone = getStandaloneFeatures();
                        const features = standalone.map((feat, i) => ({
                            index: i,
                            timeRange: { start: feat.startTime || '', end: feat.endTime || '' },
                            freqRange: { low: feat.lowFreq || '', high: feat.highFreq || '' },
                            type: feat.type || null,
                            repetition: feat.repetition || null,
                            notes: feat.notes || null,
                            speedFactor: feat.speedFactor ?? null,
                            drawnAt: feat.createdAt || ''
                        }));

                        // Build questionnaire data from combinedResponses
                        const questionnaires = {};
                        if (combinedResponses.pre) {
                            questionnaires.background = { responses: combinedResponses.pre, completedAt: new Date().toISOString() };
                        }
                        if (combinedResponses.post) {
                            questionnaires.post = { responses: combinedResponses.post, completedAt: new Date().toISOString() };
                        }
                        if (combinedResponses.awesf) {
                            questionnaires.awesf = { responses: combinedResponses.awesf, completedAt: new Date().toISOString() };
                        }
                        if (combinedResponses.activityLevel) {
                            questionnaires.activityLevel = { responses: combinedResponses.activityLevel, completedAt: new Date().toISOString() };
                        }

                        const sessionState = getSessionState(participantId);
                        await uploadEmicSubmission(participantId, {
                            participantId,
                            studyStartTime: sessionState?.startedAt || '',
                            features,
                            questionnaires,
                            completedAt: new Date().toISOString(),
                            submittedAt: new Date().toISOString(),
                            featureCount: features.length,
                            isSimulation: false,
                            qualtricsResponseId: qualtricsResponseId || null
                        });
                        console.log('✅ EMIC submission uploaded to R2 endpoint');
                    }
                } catch (error) {
                    console.warn('⚠️ Could not upload EMIC submission to R2:', error);
                }
                
                // Mark session as submitted with Qualtrics response ID
                markSessionAsSubmitted(participantId, qualtricsResponseId);
                
                // Export response metadata to JSON file
                if (qualtricsResponseId) {
                    exportResponseMetadata(participantId, qualtricsResponseId, submissionResult);
                }
                
                statusEl.className = 'status success';
                let successMsg = '✅ All surveys submitted successfully to Qualtrics!';
                if (qualtricsResponseId) {
                    successMsg += ` Response ID: ${qualtricsResponseId}`;
                }
                statusEl.textContent = successMsg;
                
                console.log('✅ Session completed and submitted successfully');
            }
        }
    } catch (error) {
        console.error('Error checking/submitting session:', error);
        const statusEl = document.getElementById('status');
        statusEl.className = 'status error';
        statusEl.textContent = `❌ Error submitting to Qualtrics: ${error.message}`;
        throw error;
    }
}

/**
 * Format regions and features for backend submission
 * Prepares data with all time fields in UTC ISO format
 * @param {Array} regions - Array of region objects from region-tracker
 * @returns {Array} Formatted regions array ready for submission
 */
function formatRegionsForSubmission(regions) {
    if (!regions || regions.length === 0) {
        return [];
    }
    
    return regions.map((region, regionIndex) => {
        const formattedRegion = {
            regionNumber: regionIndex + 1, // 1-indexed, reflects final order (shifts when regions deleted)
            regionId: region.id, // Internal tracking ID (persistent, not needed for backend)
            // Region times in UTC ISO format
            regionStartTime: region.startTime || null,
            regionEndTime: region.stopTime || null,
            featureCount: region.featureCount || 0,
            features: []
        };
        
        // Format features within this region
        if (region.features && region.features.length > 0) {
            formattedRegion.features = region.features.map((feature, featureIndex) => {
                return {
                    featureNumber: featureIndex + 1, // 1-indexed for display
                    // Feature times in UTC ISO format (prepared for backend endpoint)
                    featureStartTime: feature.startTime || null,
                    featureEndTime: feature.endTime || null,
                    // Frequency data
                    lowFreq: feature.lowFreq || null,
                    highFreq: feature.highFreq || null,
                    // Feature metadata
                    type: feature.type || null, // Impulsive or Continuous (Choice 9)
                    repetition: feature.repetition || null, // Unique in 24h? (Choice 11)
                    notes: feature.notes || null,
                    // Speed factor (Choice 3) - captured at feature creation time
                    speedFactor: feature.speedFactor !== undefined ? feature.speedFactor : null,
                    // Number of events in region (Choice 10) - feature count for this region
                    numberOfEvents: region.featureCount || 0
                };
            });
        }
        
        return formattedRegion;
    });
}

export async function attemptSubmission(fromWorkflow = false) {
    // ═══════════════════════════════════════════════════════════
    // 🎓 STUDY MODE: Route to study workflow for post-session surveys
    // ═══════════════════════════════════════════════════════════
    const { isStudyMode } = await import('./master-modes.js');
    if (isStudyMode() && !fromWorkflow) {
        console.log('🎓 Study Mode: Routing to study workflow submit handler');
        const { handleStudyModeSubmit } = await import('./study-workflow.js');
        return await handleStudyModeSubmit();
    }
    
    // If fromWorkflow is true, we're already in the workflow, so skip routing and go straight to submission
    if (fromWorkflow) {
        console.log('🎓 Study Mode: Already in workflow, proceeding directly to Qualtrics submission');
    }
    
    // ═══════════════════════════════════════════════════════════
    // 💾 PERSONAL/DEV MODE: Direct submission (no post-session surveys)
    // ═══════════════════════════════════════════════════════════
    console.log('═══════════════════════════════════════════════════════════');
    console.log('🚀 SUBMISSION ATTEMPT STARTED');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('⏰ Timestamp:', new Date().toISOString());
    
    const statusEl = document.getElementById('status');
    
    try {
        // Step 1: Get participant ID
        console.log('\n📋 STEP 1: Getting participant ID...');
        const participantId = getParticipantId();
        console.log('   Participant ID:', participantId || '❌ NOT FOUND');
        
        if (!participantId) {
            const errorMsg = 'No participant ID found. Please set your participant ID first.';
            console.error('   ❌ ERROR:', errorMsg);
            statusEl.className = 'status error';
            statusEl.textContent = `❌ ${errorMsg}`;
            
            // If called from workflow, transition back to main screen and open participant modal
            if (fromWorkflow) {
                console.log('   🔄 Transitioning back to main screen to collect participant ID...');
                // Close any open modals and fade out overlay
                const { closeAllModals, fadeOutOverlay, openParticipantModal } = await import('./ui-modals.js');
                closeAllModals();
                fadeOutOverlay();
                // Open participant modal
                setTimeout(() => {
                    openParticipantModal();
                    console.log('👤 Participant modal opened for ID collection');
                }, 350);
            }
            return;
        }
        console.log('   ✅ Participant ID found');
        
        // Step 2: Get session state
        console.log('\n📋 STEP 2: Checking session state...');
        const sessionState = getSessionState(participantId);
        console.log('   Session State:', sessionState ? JSON.stringify(sessionState, null, 2) : '❌ NO SESSION FOUND');
        
        if (!sessionState) {
            const errorMsg = 'No active session found. Please complete at least one survey first.';
            console.error('   ❌ ERROR:', errorMsg);
            statusEl.className = 'status error';
            statusEl.textContent = `❌ ${errorMsg}`;
            return;
        }
        console.log('   ✅ Session found');
        console.log('   - Session ID:', sessionState.sessionId);
        console.log('   - Status:', sessionState.status);
        console.log('   - Started At:', sessionState.startedAt);
        
        // Step 3: Get session responses
        console.log('\n📋 STEP 3: Retrieving session responses...');
        const responses = getSessionResponses(participantId);
        console.log('   Responses:', responses ? JSON.stringify(responses, null, 2) : '❌ NO RESPONSES FOUND');
        
        if (!responses) {
            const errorMsg = 'No responses found for this session.';
            console.error('   ❌ ERROR:', errorMsg);
            statusEl.className = 'status error';
            statusEl.textContent = `❌ ${errorMsg}`;
            return;
        }
        console.log('   ✅ Responses retrieved');
        
        // Step 4: Check what surveys are completed
        console.log('\n📋 STEP 4: Checking survey completion status...');
        const hasPre = !!responses.pre;
        const hasPost = !!responses.post;
        const hasAwesf = !!responses.awesf;
        const hasActivityLevel = !!responses.activityLevel;
        console.log('   Pre-Survey:', hasPre ? '✅ COMPLETE' : '❌ MISSING');
        console.log('   Post-Survey:', hasPost ? '✅ COMPLETE' : '❌ MISSING');
        console.log('   AWE-SF:', hasAwesf ? '✅ COMPLETE' : '❌ MISSING');
        console.log('   Activity Level:', hasActivityLevel ? '✅ COMPLETE' : '❌ MISSING');
        
        if (hasPre) {
            console.log('   Pre-Survey Data:', JSON.stringify(responses.pre, null, 2));
        }
        if (hasPost) {
            console.log('   Post-Survey Data:', JSON.stringify(responses.post, null, 2));
        }
        if (hasAwesf) {
            console.log('   AWE-SF Data:', JSON.stringify(responses.awesf, null, 2));
        }
        if (hasActivityLevel) {
            console.log('   Activity Level Data:', JSON.stringify(responses.activityLevel, null, 2));
        }
        
        // Step 5: Check if session is complete
        console.log('\n📋 STEP 5: Checking if session is complete...');
        const isComplete = isSessionComplete(participantId);
        console.log('   Session Complete:', isComplete ? '✅ YES' : '❌ NO');
        
        if (!isComplete) {
            const missingSurveys = [];
            if (!hasPre) missingSurveys.push('Pre-Survey');
            if (!hasPost) missingSurveys.push('Post-Survey');
            if (!hasAwesf) missingSurveys.push('AWE-SF');
            if (!hasActivityLevel) missingSurveys.push('Activity Level');
            
            const warningMsg = `Session incomplete. Missing: ${missingSurveys.join(', ')}. Submitting partial data...`;
            console.warn('   ⚠️ WARNING:', warningMsg);
            statusEl.className = 'status info';
            statusEl.textContent = `⚠️ ${warningMsg}`;
        } else {
            console.log('   ✅ All surveys complete');
        }
        
        // Step 6: Prepare combined responses for submission
        console.log('\n📋 STEP 6: Preparing combined responses for submission...');
        
        // Get tracking data from session state
        const trackingData = sessionState.tracking || null;
        
        // Get regions and features data
        const regions = getRegions();
        const formattedRegions = formatRegionsForSubmission(regions);
        console.log('   📊 Regions data:', {
            regionCount: formattedRegions.length,
            totalFeatures: formattedRegions.reduce((sum, r) => sum + (r.features?.length || 0), 0),
            hasRegionTimes: formattedRegions.some(r => r.regionStartTime && r.regionEndTime),
            hasFeatureTimes: formattedRegions.some(r => r.features?.some(f => f.featureStartTime && f.featureEndTime))
        });
        
        // Get session counts and stats (BACKWARD COMPATIBLE - won't crash if missing)
        let weeklySessionCount = 0;
        let globalStats = {
            totalSessionsStarted: 0,
            totalSessionsCompleted: 0,
            totalSessionTime: 0,
            totalSessionTimeHours: 0
        };
        let sessionRecord = null;
        
        try {
            const { getSessionCountThisWeek, getSessionStats, closeSession, incrementCumulativeCounts, getCurrentWeekAndSession, markSessionComplete } = await import('./study-workflow.js');
            
            try {
                weeklySessionCount = getSessionCountThisWeek() || 0;
            } catch (e) {
                console.warn('⚠️ Could not get weekly session count:', e);
            }
            
            try {
                globalStats = getSessionStats() || globalStats;
            } catch (e) {
                console.warn('⚠️ Could not get session stats:', e);
            }
            
            try {
                // Calculate if all surveys were completed
                const completedAllSurveys = !!(responses.pre && responses.post && responses.awesf && responses.activityLevel);
                
                // Close the current session and get the session record
                sessionRecord = closeSession(completedAllSurveys, true); // true = submitted to Qualtrics
            } catch (e) {
                console.warn('⚠️ Could not close session record:', e);
            }
            
            try {
                // Increment cumulative region and feature counts
                const regionCount = formattedRegions.length;
                const featureCount = formattedRegions.reduce((sum, r) => sum + (r.features?.length || 0), 0);
                incrementCumulativeCounts(regionCount, featureCount);
            } catch (e) {
                console.warn('⚠️ Could not increment cumulative counts:', e);
            }
            
            try {
                // Mark this specific session as complete in the tracker
                const { currentWeek, sessionNumber, alreadyComplete } = getCurrentWeekAndSession();
                
                if (alreadyComplete) {
                    console.warn(`⚠️ Week ${currentWeek}, Session ${sessionNumber} already marked complete - participant may be resubmitting`);
                } else {
                    markSessionComplete(currentWeek, sessionNumber);
                    console.log(`✅ Marked Week ${currentWeek}, Session ${sessionNumber} as complete`);
                }
            } catch (e) {
                console.warn('⚠️ Could not mark session complete in tracker:', e);
            }
        } catch (error) {
            console.warn('⚠️ Could not import session tracking functions:', error);
        }
        
        // Build JSON dump with tracking information and session metadata
        // BACKWARD COMPATIBLE: All fields have safe defaults
        const jsonDump = {
            sessionId: responses.sessionId || null,
            participantId: responses.participantId || null,
            
            // Session timing (safe fallbacks)
            sessionStarted: trackingData?.sessionStarted || sessionState?.startedAt || sessionRecord?.startTime || null,
            sessionEnded: (sessionRecord && sessionRecord.endTime) || new Date().toISOString(),
            sessionDurationMs: (sessionRecord && sessionRecord.duration) || null,
            
            // Session completion status (safe booleans)
            completedAllSurveys: Boolean(sessionRecord && sessionRecord.completedAllSurveys),
            submittedToQualtrics: Boolean(sessionRecord && sessionRecord.submittedToQualtrics),
            
            // Session counts (this session) - safe defaults
            weeklySessionCount: weeklySessionCount || 0,
            
            // Global statistics (all sessions) - safe defaults
            globalStats: {
                totalSessionsStarted: (globalStats && globalStats.totalSessionsStarted) || 0,
                totalSessionsCompleted: (globalStats && globalStats.totalSessionsCompleted) || 0,
                totalSessionTimeMs: (globalStats && globalStats.totalSessionTime) || 0,
                totalSessionTimeHours: (globalStats && globalStats.totalSessionTimeHours) || 0
            },
            
            // Cumulative region and feature counts (across all sessions)
            cumulativeStats: (() => {
                try {
                    const stored = localStorage.getItem(STORAGE_KEYS.TOTAL_REGIONS_IDENTIFIED);
                    const totalRegions = parseInt(stored || '0') || 0;
                    const storedFeatures = localStorage.getItem(STORAGE_KEYS.TOTAL_FEATURES_IDENTIFIED);
                    const totalFeatures = parseInt(storedFeatures || '0') || 0;
                    return {
                        totalRegionsIdentified: totalRegions,
                        totalFeaturesIdentified: totalFeatures
                    };
                } catch (e) {
                    return { totalRegionsIdentified: 0, totalFeaturesIdentified: 0 };
                }
            })(),
            
            // Session completion tracker (which specific sessions are complete)
            sessionCompletionTracker: (() => {
                try {
                    const stored = localStorage.getItem(STORAGE_KEYS.SESSION_COMPLETION_TRACKER);
                    return stored ? JSON.parse(stored) : {
                        week1: [false, false],
                        week2: [false, false],
                        week3: [false, false]
                    };
                } catch (e) {
                    return {
                        week1: [false, false],
                        week2: [false, false],
                        week3: [false, false]
                    };
                }
            })(),
            
            // 🎯 THE 9 CORE WORKFLOW FLAGS (from UX doc)
            // These drive the app's state machine and are critical for understanding user flow
            workflowFlags: (() => {
                try {
                    return {
                        // 👤 ONBOARDING
                        study_has_seen_participant_setup: localStorage.getItem(STORAGE_KEYS.HAS_SEEN_PARTICIPANT_SETUP) === 'true',
                        study_has_seen_welcome: localStorage.getItem(STORAGE_KEYS.HAS_SEEN_WELCOME) === 'true',
                        study_tutorial_in_progress: localStorage.getItem(STORAGE_KEYS.TUTORIAL_IN_PROGRESS) === 'true',
                        study_tutorial_completed: localStorage.getItem(STORAGE_KEYS.TUTORIAL_COMPLETED) === 'true',
                        
                        // ⚡ CURRENT SESSION
                        study_has_seen_welcome_back: localStorage.getItem(STORAGE_KEYS.HAS_SEEN_WELCOME_BACK) === 'true',
                        study_pre_survey_completion_date: localStorage.getItem(STORAGE_KEYS.PRE_SURVEY_COMPLETION_DATE) || null,
                        study_begin_analysis_clicked_this_session: localStorage.getItem(STORAGE_KEYS.BEGIN_ANALYSIS_CLICKED_THIS_SESSION) === 'true',
                        
                        // 📅 SESSION COMPLETION (already included above in sessionCompletionTracker)
                        // study_session_completion_tracker: included separately
                        
                        // ⏰ SESSION TIMEOUT
                        study_session_timed_out: localStorage.getItem(STORAGE_KEYS.SESSION_TIMED_OUT) === 'true'
                    };
                } catch (e) {
                    console.warn('⚠️ Could not read workflow flags from localStorage:', e);
                    return {
                        study_has_seen_participant_setup: false,
                        study_has_seen_welcome: false,
                        study_tutorial_in_progress: false,
                        study_tutorial_completed: false,
                        study_has_seen_welcome_back: false,
                        study_pre_survey_completion_date: null,
                        study_begin_analysis_clicked_this_session: false,
                        study_session_timed_out: false
                    };
                }
            })(),
            
            // Event tracking and regions
            tracking: trackingData || null,
            regions: formattedRegions || [],
            
            // ✨ REDUNDANCY: Include actual survey responses in embedded data
            // This ensures we have a complete backup even if Qualtrics drops standard response data
            surveyResponses: {
                pre: responses.pre || null,
                post: responses.post || null,
                awesf: responses.awesf || null,
                activityLevel: responses.activityLevel || null
            },
            
            submissionTimestamp: new Date().toISOString(),

            // Data provenance flag: marks submissions using corrected logarithmic frequency formula
            usesCorrectedLogFormula: true
        };

        // 📋 JSON_data field: Interface interaction data + survey answers backup
        // This goes to the JSON_data embedded field in Qualtrics
        let jsonData = null;
        try {
            jsonData = {
                // Survey answers (backup redundancy)
                surveyAnswers: {
                    pre: responses.pre || null,
                    post: responses.post || null,
                    awesf: responses.awesf || null,
                    activityLevel: responses.activityLevel || null
                },
                
                // Workflow state at time of submission
                workflowState: {
                    study_has_seen_participant_setup: localStorage.getItem(STORAGE_KEYS.HAS_SEEN_PARTICIPANT_SETUP) === 'true',
                    study_has_seen_welcome: localStorage.getItem(STORAGE_KEYS.HAS_SEEN_WELCOME) === 'true',
                    study_tutorial_in_progress: localStorage.getItem(STORAGE_KEYS.TUTORIAL_IN_PROGRESS) === 'true',
                    study_tutorial_completed: localStorage.getItem(STORAGE_KEYS.TUTORIAL_COMPLETED) === 'true',
                    study_has_seen_welcome_back: localStorage.getItem(STORAGE_KEYS.HAS_SEEN_WELCOME_BACK) === 'true',
                    study_pre_survey_completion_date: localStorage.getItem(STORAGE_KEYS.PRE_SURVEY_COMPLETION_DATE) || null,
                    study_begin_analysis_clicked_this_session: localStorage.getItem(STORAGE_KEYS.BEGIN_ANALYSIS_CLICKED_THIS_SESSION) === 'true',
                    study_session_timed_out: localStorage.getItem(STORAGE_KEYS.SESSION_TIMED_OUT) === 'true'
                },
                
                // Interface interactions (future expansion)
                // This is where we'll add playback speed changes, zoom events, etc.
                interactions: trackingData?.events || [],
                
                timestamp: new Date().toISOString()
            };
        } catch (e) {
            console.warn('⚠️ Could not create JSON_data object:', e);
            jsonData = {
                surveyAnswers: {
                    pre: responses.pre || null,
                    post: responses.post || null,
                    awesf: responses.awesf || null,
                    activityLevel: responses.activityLevel || null
                },
                workflowState: {},
                interactions: [],
                timestamp: new Date().toISOString(),
                error: 'Failed to read workflow state from localStorage'
            };
        }
        
        const combinedResponses = {
            pre: responses.pre || null,
            post: responses.post || null,
            awesf: responses.awesf || null,
            activityLevel: responses.activityLevel || null,
            sessionId: responses.sessionId,
            participantId: responses.participantId,
            createdAt: responses.createdAt,
            jsonDump: jsonDump,
            jsonData: jsonData  // 📋 Interface interaction data + survey backup
        };
        console.log('   Combined Responses:', JSON.stringify(combinedResponses, null, 2));
        console.log('   JSON Dump (SessionTracking):', JSON.stringify(jsonDump, null, 2));
        console.log('   JSON Data (JSON_data):', JSON.stringify(jsonData, null, 2));
        console.log('   Response Count:', {
            pre: hasPre ? 1 : 0,
            post: hasPost ? 1 : 0,
            awesf: hasAwesf ? 1 : 0,
            activityLevel: hasActivityLevel ? 1 : 0,
            total: (hasPre ? 1 : 0) + (hasPost ? 1 : 0) + (hasAwesf ? 1 : 0) + (hasActivityLevel ? 1 : 0)
        });
        
        // Detailed logging for each survey type
        if (combinedResponses.pre) {
            console.log('   ✅ Pre-survey data included:', Object.keys(combinedResponses.pre));
        } else {
            console.warn('   ⚠️ Pre-survey data MISSING - will not be submitted to Qualtrics');
        }
        if (combinedResponses.post) {
            console.log('   ✅ Post-survey data included:', Object.keys(combinedResponses.post));
        } else {
            console.warn('   ⚠️ Post-survey data MISSING - will not be submitted to Qualtrics');
        }
        if (combinedResponses.awesf) {
            console.log('   ✅ AWE-SF data included:', Object.keys(combinedResponses.awesf));
        } else {
            console.warn('   ⚠️ AWE-SF data MISSING - will not be submitted to Qualtrics');
        }
        if (combinedResponses.activityLevel) {
            console.log('   ✅ Activity Level data included:', Object.keys(combinedResponses.activityLevel));
        } else {
            console.warn('   ⚠️ Activity Level data MISSING - will not be submitted to Qualtrics');
        }
        
        // Step 7: Attempt submission
        console.log('\n📋 STEP 7: Submitting to Qualtrics API...');
        statusEl.className = 'status info';
        statusEl.textContent = '📤 Submitting to Qualtrics...';
        
        console.log('   API Endpoint: Qualtrics API v3');
        console.log('   Survey ID: SV_bNni117IsBWNZWu');
        console.log('   Participant ID:', participantId);
        console.log('   Payload Preview:', {
            hasPre,
            hasPost,
            hasAwesf,
            valuesCount: 'Will be calculated by API'
        });
        
        // ═══════════════════════════════════════════════════════════
        // 📤 QUALTRICS SUBMISSION
        // ═══════════════════════════════════════════════════════════
        const startTime = Date.now();
        let submissionResult;
        
        try {
            submissionResult = await submitCombinedSurveyResponse(combinedResponses, participantId);
            const duration = Date.now() - startTime;
            
            console.log('   ✅ Submission successful!');
            console.log('   Response Time:', duration, 'ms');
            console.log('   API Response:', JSON.stringify(submissionResult, null, 2));
            
            // Extract Qualtrics Response ID
            let qualtricsResponseId = null;
            if (submissionResult && submissionResult.result && submissionResult.result.responseId) {
                qualtricsResponseId = submissionResult.result.responseId;
                console.log('   📋 Qualtrics Response ID:', qualtricsResponseId);
                console.log('   💡 Use this ID in Qualtrics/response-viewer.html to verify what was submitted');
            } else {
                console.warn('   ⚠️ No responseId found in submission result');
                console.log('   Full result:', submissionResult);
            }
            
            // Step 8: Mark session as submitted with Qualtrics response ID
            console.log('\n📋 STEP 8: Marking session as submitted...');
            markSessionAsSubmitted(participantId, qualtricsResponseId);
            console.log('   ✅ Session marked as submitted');
            
            // Step 9: Export response metadata to JSON file
            if (qualtricsResponseId) {
                console.log('\n📋 STEP 9: Exporting response metadata...');
                exportResponseMetadata(participantId, qualtricsResponseId, submissionResult);
                console.log('   ✅ Response metadata exported to JSON file');
            }
            
            statusEl.className = 'status success';
            let successMsg = '✅ Successfully submitted to Qualtrics!';
            if (qualtricsResponseId) {
                successMsg += ` Response ID: ${qualtricsResponseId}`;
            }
            statusEl.textContent = successMsg;
            
            console.log('\n═══════════════════════════════════════════════════════════');
            console.log('✅ SUBMISSION ATTEMPT COMPLETED SUCCESSFULLY');
            if (qualtricsResponseId) {
                console.log(`📋 Qualtrics Response ID: ${qualtricsResponseId}`);
            }
            console.log('═══════════════════════════════════════════════════════════');
            
        } catch (apiError) {
            const duration = Date.now() - startTime;
            console.error('   ❌ Submission failed!');
            console.error('   Response Time:', duration, 'ms');
            console.error('   Error Type:', apiError.constructor.name);
            console.error('   Error Message:', apiError.message);
            console.error('   Error Stack:', apiError.stack);
            
            if (apiError.message) {
                // Try to extract more details from error message
                try {
                    const errorMatch = apiError.message.match(/\{.*\}/);
                    if (errorMatch) {
                        const errorJson = JSON.parse(errorMatch[0]);
                        console.error('   Parsed Error Details:', JSON.stringify(errorJson, null, 2));
                    }
                } catch (e) {
                    // Ignore parsing errors
                }
            }
            
            statusEl.className = 'status error';
            statusEl.textContent = `❌ Submission failed: ${apiError.message}`;
            
            console.log('\n═══════════════════════════════════════════════════════════');
            console.log('❌ SUBMISSION ATTEMPT FAILED');
            console.log('═══════════════════════════════════════════════════════════');
            
            throw apiError;
        }
        
    } catch (error) {
        console.error('\n❌ FATAL ERROR in submission attempt:');
        console.error('   Error Type:', error.constructor.name);
        console.error('   Error Message:', error.message);
        console.error('   Error Stack:', error.stack);
        
        statusEl.className = 'status error';
        statusEl.textContent = `❌ Error: ${error.message}`;
        
        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('❌ SUBMISSION ATTEMPT FAILED WITH FATAL ERROR');
        console.log('═══════════════════════════════════════════════════════════');
        
        throw error;
    }
}
