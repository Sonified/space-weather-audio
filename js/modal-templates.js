// Modal HTML templates as ES6 template literals (shared + EMIC)
// Volcano study templates moved to volcano-modal-templates.js

import { isStudyMode, isEmicStudyMode } from './master-modes.js';

// 🔥 FIX: Track if modals have been initialized to prevent duplicate initialization
let modalsInitialized = false;

// NOTE: This welcome modal template is for the live spaceweather.now.audio site (volcano/solar portal).
// For the EMIC study, the text is dynamically patched by openWelcomeModal() in ui-controls.js
// when welcomeMode === 'participant'. Do not confuse these — this is NOT the EMIC study welcome.
export function createWelcomeModal() {
    const modal = document.createElement('div');
    modal.id = 'welcomeModal';
    modal.className = 'modal-window';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3 class="modal-title">☀️ Solar Audification Study</h3>
            </div>
            <div class="modal-body">
                <p style="margin-bottom: 20px; color: #333; font-size: 20px; line-height: 1.6;">
                    You will be listening to real volcanic data and identifying interesting features. Please use headphones or high-quality speakers in a quiet environment free from distractions.
                </p>
                <p style="margin-bottom: 20px; color: #333; font-size: 20px; line-height: 1.6;">
                    The data comes from active volcanoes in near-real-time and may contain gaps or sudden volume spikes. Please listen at a comfortable volume.
                </p>
                <p style="margin-bottom: 20px; color: #333; font-size: 20px; line-height: 1.6;">
                    This study includes short surveys that take about 2-3 minutes per session.
                </p>
                <p style="margin-bottom: 20px; color: #333; font-size: 20px; line-height: 1.6;">
                    Questions? Contact <a href="mailto:leif@uoregon.edu" style="color: #007bff; text-decoration: none; font-weight: 600;">leif@uoregon.edu</a>
                </p>
                <button type="button" class="modal-submit">Begin</button>
            </div>
        </div>
    `;
    return modal;
}

// NOTE: This participant/login modal template is for the live spaceweather.now.audio site.
// For the EMIC study, the text is dynamically patched by openParticipantModal() in ui-controls.js
// when welcomeMode === 'participant'. Do not confuse these — this is NOT the EMIC study login.
export function createParticipantModal() {
    const modal = document.createElement('div');
    modal.id = 'participantModal';
    modal.className = 'modal-window';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3 class="modal-title">🌋 Welcome</h3>
                <button class="modal-close" style="display: none;">&times;</button>
            </div>
            <div class="modal-body">
                <p style="margin-bottom: 10px; color: #550000; font-size: 16px; font-weight: bold;">Enter a user name to begin:</p>
                <p style="margin-bottom: 20px; color: #666; font-size: 14px; line-height: 1.5;">This name will be used for saving and loading features you identify, and will be automatically included in any new share links you create.</p>
                <div class="modal-form-group">
                    <label for="participantId" style="display: none;">User Name:</label>
                    <input type="text" id="participantId" placeholder="Enter a user name" style="font-size: 18px;" autocomplete="off">
                    <div id="usernameStatus" style="margin-top: 8px; font-size: 14px; min-height: 20px;"></div>
                </div>
                <button type="button" class="modal-submit" disabled>✓ Confirm</button>
            </div>
        </div>
    `;
    return modal;
}


export function createEmicAboutModal() {
    const modal = document.createElement('div');
    modal.id = 'emicAboutModal';
    modal.className = 'modal-window';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 720px;">
            <div class="modal-header">
                <h3 class="modal-title">About This Study</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body" style="text-align: left;">
                <p style="margin-bottom: 16px; color: #333; font-size: 16px; line-height: 1.6;">
                    Your task is to listen to magnetometer data from the <b>GOES satellite</b> and identifying <b>Electromagnetic Ion Cyclotron (EMIC) waves</b>.
                </p>
                <p style="margin-bottom: 16px; color: #333; font-size: 16px; line-height: 1.6;">
                    Please use headphones or high-quality speakers in a quiet environment free from distractions. Listen carefully and draw boxes around any features you identify in the spectrogram, and when you are finished use the "Complete" button to submit your results.
                </p>
                <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
                <p style="margin-bottom: 0; color: #555; font-size: 15px; line-height: 1.6;">
                    If you have any questions or need assistance, please contact the study coordinator, Lucy Williams, at
                    <a href="mailto:lewilliams@smith.edu" style="color: #007bff; text-decoration: none; font-weight: 600;">lewilliams@smith.edu</a>.
                </p>
            </div>
        </div>
    `;
    return modal;
}

export function createParticipantInfoModal() {
    const modal = document.createElement('div');
    modal.id = 'participantInfoModal';
    modal.className = 'modal-window';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 480px;">
            <div class="modal-header">
                <h3 class="modal-title">Your Participant ID</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body" style="text-align: left;">
                <p style="margin-bottom: 16px; color: #333; font-size: 16px; line-height: 1.6;">
                    You are currently logged in as:
                </p>
                <p id="participantInfoId" style="margin-bottom: 0; color: #550000; font-size: 20px; font-weight: 700; text-align: center; padding: 12px; background: rgba(85, 0, 0, 0.05); border-radius: 8px;">--</p>
                <input id="participantInfoInput" type="text" style="display: none; font-size: 18px; font-weight: 600; text-align: center; width: 100%; padding: 6px 10px; border: 2px solid #007bff; border-radius: 6px; outline: none; box-sizing: border-box;">
                <div style="text-align: center; margin-top: 8px; margin-bottom: 20px;">
                    <button id="participantInfoChangeBtn" type="button" style="font-size: 13px; color: #007bff; background: none; border: none; cursor: pointer; text-decoration: underline; padding: 2px 8px;">Change</button>
                    <button id="participantInfoSaveBtn" type="button" style="display: none; font-size: 13px; color: #fff; background: #007bff; border: none; border-radius: 4px; cursor: pointer; padding: 4px 14px; font-weight: 600;">Save</button>
                    <button id="participantInfoCancelBtn" type="button" style="display: none; font-size: 13px; color: #666; background: none; border: none; cursor: pointer; text-decoration: underline; padding: 2px 8px; margin-left: 4px;">Cancel</button>
                </div>
                <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
                <p style="margin-bottom: 0; color: #555; font-size: 15px; line-height: 1.6;">
                    If you have any questions or need assistance, please contact the study coordinator, Lucy Williams, at
                    <a href="mailto:lewilliams@smith.edu" style="color: #007bff; text-decoration: none; font-weight: 600;">lewilliams@smith.edu</a>.
                </p>
            </div>
        </div>
    `;
    return modal;
}

export function createAboutModal() {
    const modal = document.createElement('div');
    modal.id = 'aboutModal';
    modal.className = 'modal-window';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 560px;">
            <div class="modal-header">
                <h3 class="modal-title">About</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body" style="text-align: left;">
                <p style="margin-bottom: 16px; color: #333; font-size: 15px; line-height: 1.6;">
                    This portal provides interactive access to audified spacecraft data. The audification is performed using code incorporated into NASA's Coordinated Data Analysis Web (CDAWeb) service.
                </p>
                <p style="margin-bottom: 16px; color: #333; font-size: 15px; line-height: 1.6;">
                    <a href="https://cdaweb.gsfc.nasa.gov/audification_readme.html" target="_blank" rel="noopener noreferrer" style="color: #0056b3; text-decoration: none; font-weight: 600;">About the audification algorithm</a>
                </p>
                <p style="margin-bottom: 16px; color: #333; font-size: 15px; line-height: 1.6;">
                    <a href="https://cdaweb.gsfc.nasa.gov/" target="_blank" rel="noopener noreferrer" style="color: #0056b3; text-decoration: none; font-weight: 600;">NASA CDAWeb</a>
                </p>
                <p style="margin-bottom: 16px; color: #333; font-size: 15px; line-height: 1.6;">
                    <a href="https://cdaweb.gsfc.nasa.gov/WebServices/REST/" target="_blank" rel="noopener noreferrer" style="color: #0056b3; text-decoration: none; font-weight: 600;">CDASWS REST API</a>
                </p>
                <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
                <p style="margin-bottom: 0; color: #555; font-size: 14px; line-height: 1.6;">
                    For questions, comments, feedback and requests, reach out to Robert Alexander at
                    <a href="mailto:robert@auralab.io" target="_blank" rel="noopener noreferrer" style="color: #0056b3; text-decoration: none; font-weight: 600;">robert@auralab.io</a>
                </p>
            </div>
        </div>
    `;
    return modal;
}

export function createBackgroundQuestionModal() {
    const modal = document.createElement('div');
    modal.id = 'backgroundQuestionModal';
    modal.className = 'modal-window';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 750px;">
            <div class="modal-header">
                <h3 class="modal-title">📋 Questionnaire</h3>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-size: 13px; color: #999; font-weight: 500; white-space: nowrap;">1 / 5</span>
                    <div style="width: 120px; height: 4px; background: #e0e0e0; border-radius: 2px;">
                        <div style="height: 100%; width: 20%; background: #2196F3; border-radius: 2px; transition: width 0.3s;"></div>
                    </div>
                </div>
            </div>
            <div class="modal-body">
                <div style="font-size: 18px; color: #550000; margin-top: 12px; margin-bottom: 16px; text-align: left; font-weight: 700;">
                    1. What is your background in physics or space science?
                </div>

                <div style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px;">
                    <label class="radio-choice">
                        <input type="radio" name="backgroundLevel" value="1">
                        <div><strong>None:</strong> <span style="color: #666; font-size: 0.92em;">No prior background</span></div>
                    </label>
                    <label class="radio-choice">
                        <input type="radio" name="backgroundLevel" value="2">
                        <div><strong>Minimal:</strong> <span style="color: #666; font-size: 0.92em;">Less than 1 year of coursework or experience</span></div>
                    </label>
                    <label class="radio-choice">
                        <input type="radio" name="backgroundLevel" value="3">
                        <div><strong>Some:</strong> <span style="color: #666; font-size: 0.92em;">1–2 years of coursework or experience</span></div>
                    </label>
                    <label class="radio-choice">
                        <input type="radio" name="backgroundLevel" value="4">
                        <div><strong>Considerable:</strong> <span style="color: #666; font-size: 0.92em;">3–5 years of coursework or professional experience</span></div>
                    </label>
                    <label class="radio-choice">
                        <input type="radio" name="backgroundLevel" value="5">
                        <div><strong>Extensive:</strong> <span style="color: #666; font-size: 0.92em;">5+ years of coursework or professional experience</span></div>
                    </label>
                </div>

                <div style="text-align: center;">
                    <button type="button" class="modal-submit" style="width: auto; min-width: 140px;" disabled>Next →</button>
                </div>
            </div>
        </div>
    `;
    return modal;
}

export function createDataAnalysisQuestionModal() {
    const modal = document.createElement('div');
    modal.id = 'dataAnalysisQuestionModal';
    modal.className = 'modal-window';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 750px;">
            <div class="modal-header">
                <h3 class="modal-title">📋 Questionnaire</h3>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-size: 13px; color: #999; font-weight: 500; white-space: nowrap;">2 / 5</span>
                    <div style="width: 120px; height: 4px; background: #e0e0e0; border-radius: 2px;">
                        <div style="height: 100%; width: 40%; background: #2196F3; border-radius: 2px; transition: width 0.3s;"></div>
                    </div>
                </div>
            </div>
            <div class="modal-body">
                <div style="font-size: 18px; color: #550000; margin-top: 12px; margin-bottom: 16px; text-align: left; font-weight: 700;">
                    2. Have you previously analyzed scientific data?<br><span style="font-size: 14px; color: #888; font-weight: normal;">(e.g., time series, spectrograms, satellite measurements)</span>
                </div>

                <div style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px;">
                    <label class="radio-choice">
                        <input type="radio" name="dataAnalysisLevel" value="1">
                        <div><strong>Never:</strong> <span style="color: #666; font-size: 0.92em;">This was my first time working with scientific data</span></div>
                    </label>
                    <label class="radio-choice">
                        <input type="radio" name="dataAnalysisLevel" value="2">
                        <div><strong>Rarely:</strong> <span style="color: #666; font-size: 0.92em;">A few times in coursework or casually</span></div>
                    </label>
                    <label class="radio-choice">
                        <input type="radio" name="dataAnalysisLevel" value="3">
                        <div><strong>Occasionally:</strong> <span style="color: #666; font-size: 0.92em;">Regular coursework or some research involvement</span></div>
                    </label>
                    <label class="radio-choice">
                        <input type="radio" name="dataAnalysisLevel" value="4">
                        <div><strong>Frequently:</strong> <span style="color: #666; font-size: 0.92em;">Ongoing research or professional work</span></div>
                    </label>
                    <label class="radio-choice">
                        <input type="radio" name="dataAnalysisLevel" value="5">
                        <div><strong>Extensively:</strong> <span style="color: #666; font-size: 0.92em;">Multiple years of hands-on data analysis experience</span></div>
                    </label>
                </div>

                <div style="text-align: center;">
                    <div style="display: inline-flex; gap: 12px; align-items: center;">
                        <button type="button" class="modal-back modal-submit" style="background: #e0e0e0; color: #555; box-shadow: none; text-shadow: none; width: auto; min-width: 100px;">← Back</button>
                        <button type="button" class="modal-submit" style="width: auto; min-width: 140px;" disabled>Next →</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    return modal;
}

export function createMusicalExperienceQuestionModal() {
    const modal = document.createElement('div');
    modal.id = 'musicalExperienceQuestionModal';
    modal.className = 'modal-window';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 950px;">
            <div class="modal-header">
                <h3 class="modal-title">📋 Questionnaire</h3>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-size: 13px; color: #999; font-weight: 500; white-space: nowrap;">3 / 5</span>
                    <div style="width: 120px; height: 4px; background: #e0e0e0; border-radius: 2px;">
                        <div style="height: 100%; width: 60%; background: #2196F3; border-radius: 2px; transition: width 0.3s;"></div>
                    </div>
                </div>
            </div>
            <div class="modal-body">
                <div style="font-size: 18px; color: #550000; margin-top: 12px; margin-bottom: 16px; text-align: left; font-weight: 700;">
                    3. What is your level of musical experience?
                </div>

                <div style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px;">
                    <label class="radio-choice">
                        <input type="radio" name="musicalExperienceLevel" value="1">
                        <div><strong>None:</strong> <span style="color: #666; font-size: 0.92em;">No musical training or experience</span></div>
                    </label>
                    <label class="radio-choice">
                        <input type="radio" name="musicalExperienceLevel" value="2">
                        <div><strong>Minimal:</strong> <span style="color: #666; font-size: 0.92em;">Some informal exposure (e.g., basic music classes in school)</span></div>
                    </label>
                    <label class="radio-choice">
                        <input type="radio" name="musicalExperienceLevel" value="3">
                        <div><strong>Some:</strong> <span style="color: #666; font-size: 0.92em;">1–3 years of musical training or playing an instrument</span></div>
                    </label>
                    <label class="radio-choice">
                        <input type="radio" name="musicalExperienceLevel" value="4">
                        <div><strong>Considerable:</strong> <span style="color: #666; font-size: 0.92em;">4+ years of training, active musician or regular performer</span></div>
                    </label>
                    <label class="radio-choice">
                        <input type="radio" name="musicalExperienceLevel" value="5">
                        <div><strong>Extensive:</strong> <span style="color: #666; font-size: 0.92em;">Professional musician, music degree, or lifelong serious practice</span></div>
                    </label>
                </div>

                <div style="text-align: center;">
                    <div style="display: inline-flex; gap: 12px; align-items: center;">
                        <button type="button" class="modal-back modal-submit" style="background: #e0e0e0; color: #555; box-shadow: none; text-shadow: none; width: auto; min-width: 100px;">← Back</button>
                        <button type="button" class="modal-submit" style="width: auto; min-width: 140px;" disabled>Next →</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    return modal;
}

export function createFeedbackQuestionModal() {
    const modal = document.createElement('div');
    modal.id = 'feedbackQuestionModal';
    modal.className = 'modal-window';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 750px;">
            <div class="modal-header">
                <h3 class="modal-title">📋 Questionnaire</h3>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-size: 13px; color: #999; font-weight: 500; white-space: nowrap;">4 / 5</span>
                    <div style="width: 120px; height: 4px; background: #e0e0e0; border-radius: 2px;">
                        <div style="height: 100%; width: 80%; background: #2196F3; border-radius: 2px; transition: width 0.3s;"></div>
                    </div>
                </div>
            </div>
            <div class="modal-body">
                <div style="font-size: 18px; color: #550000; margin-top: 12px; margin-bottom: 16px; text-align: left; font-weight: 700;">
                    4. Do you have any additional feedback you'd like to share?
                </div>

                <textarea id="feedbackText" placeholder="Type your response here (optional)..." style="width: 100%; min-height: 200px; padding: 14px; font-size: 15px; font-family: inherit; border: 1px solid #ddd; border-radius: 8px; resize: vertical; box-sizing: border-box; line-height: 1.5; color: #333; transition: border-color 0.15s;" onfocus="this.style.borderColor='#007bff'" onblur="this.style.borderColor='#ddd'"></textarea>

                <div style="text-align: center;">
                    <div style="display: inline-flex; gap: 12px; align-items: center;">
                        <button type="button" class="modal-back modal-submit" style="background: #e0e0e0; color: #555; box-shadow: none; text-shadow: none; width: auto; min-width: 100px;">← Back</button>
                        <button type="button" class="modal-skip modal-submit" style="background: #f5f5f5; color: #888; box-shadow: none; text-shadow: none; width: auto; min-width: 100px;" id="feedbackSkipBtn">Skip</button>
                        <button type="button" class="modal-submit" style="width: auto; min-width: 140px;" id="feedbackSubmitBtn">Next →</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    return modal;
}

export function createReferralQuestionModal() {
    const modal = document.createElement('div');
    modal.id = 'referralQuestionModal';
    modal.className = 'modal-window';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 750px;">
            <div class="modal-header">
                <h3 class="modal-title">📋 Questionnaire</h3>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-size: 13px; color: #999; font-weight: 500; white-space: nowrap;">5 / 5</span>
                    <div style="width: 120px; height: 4px; background: #e0e0e0; border-radius: 2px;">
                        <div style="height: 100%; width: 100%; background: #2196F3; border-radius: 2px; transition: width 0.3s;"></div>
                    </div>
                </div>
            </div>
            <div class="modal-body">
                <div style="font-size: 18px; color: #550000; margin-top: 12px; margin-bottom: 16px; text-align: left; font-weight: 700;">
                    5. How did you learn about this experiment?
                </div>

                <textarea id="referralText" placeholder="Type your response here (optional)..." style="width: 100%; min-height: 200px; padding: 14px; font-size: 15px; font-family: inherit; border: 1px solid #ddd; border-radius: 8px; resize: vertical; box-sizing: border-box; line-height: 1.5; color: #333; transition: border-color 0.15s;" onfocus="this.style.borderColor='#007bff'" onblur="this.style.borderColor='#ddd'"></textarea>

                <div style="text-align: center;">
                    <div style="display: inline-flex; gap: 12px; align-items: center;">
                        <button type="button" class="modal-back modal-submit" style="background: #e0e0e0; color: #555; box-shadow: none; text-shadow: none; width: auto; min-width: 100px;">← Back</button>
                        <button type="button" class="modal-submit" style="width: auto; min-width: 140px;" id="referralSubmitBtn">✓ Submit</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    return modal;
}

// Initialize and inject modals into the page
export async function initializeModals() {
    // 🔥 FIX: NEVER reinitialize while modals are already initialized!
    // Modals are stateful actors - destroying them mid-workflow breaks promise chains!
    if (modalsInitialized) {
        console.warn('⚠️ Modals already initialized - skipping reinitialization');
        return; // Just bail! Don't destroy and recreate!
    }
    
    // Append modals to the permanent overlay instead of body
    const overlay = document.getElementById('permanentOverlay');

    // Shared modals (all modes)
    overlay.appendChild(createWelcomeModal());
    overlay.appendChild(createParticipantModal());
    overlay.appendChild(createAboutModal());
    overlay.appendChild(createParticipantInfoModal());

    // EMIC study modals
    if (isEmicStudyMode()) {
        overlay.appendChild(createEmicAboutModal());
        overlay.appendChild(createBackgroundQuestionModal());
        overlay.appendChild(createDataAnalysisQuestionModal());
        overlay.appendChild(createMusicalExperienceQuestionModal());
        overlay.appendChild(createFeedbackQuestionModal());
        overlay.appendChild(createReferralQuestionModal());
    }

    // Pre-populate participant ID from URL (Qualtrics) or localStorage
    // BUT NOT in STUDY_CLEAN mode (always start fresh)
    const storedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('selectedMode') : null;
    const isStudyClean = storedMode === 'study_clean';
    
    // Check URL first (Qualtrics ResponseID), then localStorage
    let savedParticipantId = null;
    if (!isStudyClean) {
        // Try to get from URL (Qualtrics redirect)
        try {
            const { getParticipantIdFromURL, storeParticipantId } = await import('./participant-id.js');
            const urlId = getParticipantIdFromURL();
            if (urlId) {
                savedParticipantId = urlId;
                // Store it for future use
                storeParticipantId(urlId);
                if (window.pm?.init) console.log('🔗 Pre-populated participant ID from URL:', urlId);
            } else {
                // Fall back to localStorage
                savedParticipantId = localStorage.getItem('participantId');
                if (savedParticipantId) {
                    if (window.pm?.init) console.log('💾 Pre-populated participant ID from localStorage:', savedParticipantId);
                }
            }
        } catch (error) {
            // If import fails, fall back to localStorage
            savedParticipantId = localStorage.getItem('participantId');
            if (savedParticipantId) {
                if (window.pm?.init) console.log('💾 Pre-populated participant ID from localStorage:', savedParticipantId);
            }
        }
    } else {
        if (window.pm?.init) console.log('🧹 Study Clean Mode: Not pre-populating participant ID');
    }
    
    const participantIdInput = document.getElementById('participantId');
    const participantSubmitBtn = document.querySelector('#participantModal .modal-submit');
    
    if (participantIdInput) {
        participantIdInput.value = savedParticipantId || '';
    }
    
    // Update button state based on whether there's a saved value
    if (participantSubmitBtn) {
        const hasValue = participantIdInput && participantIdInput.value.trim().length > 0;
        participantSubmitBtn.disabled = !hasValue;
    }
    
    modalsInitialized = true;
    // Only log in dev/personal modes, not study mode
    if (!isStudyMode()) {
        console.log('📋 Modals initialized and injected into DOM');
    }
}

