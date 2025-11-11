// Modal HTML templates as ES6 template literals

export function createParticipantModal() {
    const modal = document.createElement('div');
    modal.id = 'participantModal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3 class="modal-title">Welcome</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <p style="margin-bottom: 20px; color: #333; font-size: 16px;">Enter your participant ID number to begin:</p>
                <div class="modal-form-group">
                    <label for="participantId" style="display: none;">Participant ID/Number:</label>
                    <input type="text" id="participantId" placeholder="Enter participant identifier">
                </div>
                <button type="button" class="modal-submit">✓ Start Session</button>
            </div>
        </div>
    `;
    return modal;
}

export function createSurveyModal() {
    const modal = document.createElement('div');
    modal.id = 'prePostSurveyModal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3 class="modal-title">📊 Pre/Post Survey</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="mood-survey-intro">Right now, I feel:</div>
                
                <!-- Scale header labels -->
                <div class="survey-scale-labels">
                    <div></div>
                    <div class="survey-scale-labels-grid">
                        <span>Not at all</span>
                        <span>A lit&shy;tle</span>
                        <span>Mod&shy;er&shy;ate</span>
                        <span>Quite a bit</span>
                        <span>Very much</span>
                    </div>
                </div>
                
                <div class="mood-scale-container">
                <!-- Calm -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">Calm</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option">
                            <input type="radio" name="calm" id="calm1" value="1">
                            <label for="calm1">1</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="calm" id="calm2" value="2">
                            <label for="calm2">2</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="calm" id="calm3" value="3">
                            <label for="calm3">3</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="calm" id="calm4" value="4">
                            <label for="calm4">4</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="calm" id="calm5" value="5">
                            <label for="calm5">5</label>
                        </div>
                    </div>
                </div>
                
                <!-- Energized -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">Energized</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option">
                            <input type="radio" name="energized" id="energized1" value="1">
                            <label for="energized1">1</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="energized" id="energized2" value="2">
                            <label for="energized2">2</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="energized" id="energized3" value="3">
                            <label for="energized3">3</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="energized" id="energized4" value="4">
                            <label for="energized4">4</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="energized" id="energized5" value="5">
                            <label for="energized5">5</label>
                        </div>
                    </div>
                </div>
                
                <!-- Connected -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">Connected</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option">
                            <input type="radio" name="connected" id="connected1" value="1">
                            <label for="connected1">1</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="connected" id="connected2" value="2">
                            <label for="connected2">2</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="connected" id="connected3" value="3">
                            <label for="connected3">3</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="connected" id="connected4" value="4">
                            <label for="connected4">4</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="connected" id="connected5" value="5">
                            <label for="connected5">5</label>
                        </div>
                    </div>
                </div>
                
                <!-- Stressed -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">Stressed</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option">
                            <input type="radio" name="stressed" id="stressed1" value="1">
                            <label for="stressed1">1</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="stressed" id="stressed2" value="2">
                            <label for="stressed2">2</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="stressed" id="stressed3" value="3">
                            <label for="stressed3">3</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="stressed" id="stressed4" value="4">
                            <label for="stressed4">4</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="stressed" id="stressed5" value="5">
                            <label for="stressed5">5</label>
                        </div>
                    </div>
                </div>
                
                <!-- Focused -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">Focused</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option">
                            <input type="radio" name="focused" id="focused1" value="1">
                            <label for="focused1">1</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="focused" id="focused2" value="2">
                            <label for="focused2">2</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="focused" id="focused3" value="3">
                            <label for="focused3">3</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="focused" id="focused4" value="4">
                            <label for="focused4">4</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="focused" id="focused5" value="5">
                            <label for="focused5">5</label>
                        </div>
                    </div>
                </div>
                
                <!-- Sense of Wonder -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">Sense of Wonder</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option">
                            <input type="radio" name="wonder" id="wonder1" value="1">
                            <label for="wonder1">1</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="wonder" id="wonder2" value="2">
                            <label for="wonder2">2</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="wonder" id="wonder3" value="3">
                            <label for="wonder3">3</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="wonder" id="wonder4" value="4">
                            <label for="wonder4">4</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="wonder" id="wonder5" value="5">
                            <label for="wonder5">5</label>
                        </div>
                    </div>
                </div>
                </div>
                
                <button type="button" class="modal-submit">✓ Submit Survey</button>
            </div>
        </div>
    `;
    return modal;
}

// Initialize and inject modals into the page
export function initializeModals() {
    const participantModal = createParticipantModal();
    const surveyModal = createSurveyModal();
    
    document.body.appendChild(participantModal);
    document.body.appendChild(surveyModal);
    
    console.log('📋 Modals initialized and injected into DOM');
}

