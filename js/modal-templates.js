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
                <p style="margin-bottom: 20px; color: #333; font-size: 16px; font-weight: bold;">Enter your participant ID number to begin:</p>
                <div class="modal-form-group">
                    <label for="participantId" style="display: none;">Participant ID/Number:</label>
                    <input type="text" id="participantId" placeholder="Enter participant identifier">
                </div>
                <button type="button" class="modal-submit" disabled>✓ Confirm</button>
                <p style="margin-top: 18px; margin-bottom: 0; color: #555; font-size: 14px; text-align: center;">Not look right? Email: leif@uoregon.edu</p>
            </div>
        </div>
    `;
    return modal;
}

function createMoodSurveyModal(surveyType, surveyId, title) {
    const prefix = surveyType === 'pre' ? 'pre' : 'post';
    const modal = document.createElement('div');
    modal.id = surveyId;
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3 class="modal-title">${title}</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="mood-survey-intro">Right now, I feel:</div>
                
                <!-- Quick-fill buttons -->
                <div class="quick-fill-buttons" style="display: flex; gap: 8px; margin-bottom: 15px; padding: 10px; background: rgba(0, 0, 0, 0.05); border-radius: 6px; justify-content: center; flex-wrap: wrap;">
                    <span style="font-weight: 600; color: #555; margin-right: 8px; align-self: center;">Quick fill:</span>
                    <button type="button" class="quick-fill-btn" data-value="1" data-survey="${surveyId}" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 2px solid #4CAF50; background: white; color: #4CAF50; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#e8f5e9'" onmouseout="this.style.background='white'">1</button>
                    <button type="button" class="quick-fill-btn" data-value="2" data-survey="${surveyId}" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 2px solid #4CAF50; background: white; color: #4CAF50; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#e8f5e9'" onmouseout="this.style.background='white'">2</button>
                    <button type="button" class="quick-fill-btn" data-value="3" data-survey="${surveyId}" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 2px solid #4CAF50; background: white; color: #4CAF50; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#e8f5e9'" onmouseout="this.style.background='white'">3</button>
                    <button type="button" class="quick-fill-btn" data-value="4" data-survey="${surveyId}" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 2px solid #4CAF50; background: white; color: #4CAF50; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#e8f5e9'" onmouseout="this.style.background='white'">4</button>
                    <button type="button" class="quick-fill-btn" data-value="5" data-survey="${surveyId}" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 2px solid #4CAF50; background: white; color: #4CAF50; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#e8f5e9'" onmouseout="this.style.background='white'">5</button>
                </div>
                
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
                            <input type="radio" name="${prefix}Calm" id="${prefix}Calm1" value="1">
                            <label for="${prefix}Calm1">1</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Calm" id="${prefix}Calm2" value="2">
                            <label for="${prefix}Calm2">2</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Calm" id="${prefix}Calm3" value="3">
                            <label for="${prefix}Calm3">3</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Calm" id="${prefix}Calm4" value="4">
                            <label for="${prefix}Calm4">4</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Calm" id="${prefix}Calm5" value="5">
                            <label for="${prefix}Calm5">5</label>
                        </div>
                    </div>
                </div>
                
                <!-- Energized -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">Energized</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Energized" id="${prefix}Energized1" value="1">
                            <label for="${prefix}Energized1">1</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Energized" id="${prefix}Energized2" value="2">
                            <label for="${prefix}Energized2">2</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Energized" id="${prefix}Energized3" value="3">
                            <label for="${prefix}Energized3">3</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Energized" id="${prefix}Energized4" value="4">
                            <label for="${prefix}Energized4">4</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Energized" id="${prefix}Energized5" value="5">
                            <label for="${prefix}Energized5">5</label>
                        </div>
                    </div>
                </div>
                
                <!-- Nervous -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">Nervous</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Nervous" id="${prefix}Nervous1" value="1">
                            <label for="${prefix}Nervous1">1</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Nervous" id="${prefix}Nervous2" value="2">
                            <label for="${prefix}Nervous2">2</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Nervous" id="${prefix}Nervous3" value="3">
                            <label for="${prefix}Nervous3">3</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Nervous" id="${prefix}Nervous4" value="4">
                            <label for="${prefix}Nervous4">4</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Nervous" id="${prefix}Nervous5" value="5">
                            <label for="${prefix}Nervous5">5</label>
                        </div>
                    </div>
                </div>
                
                <!-- Focused -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">Focused</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Focused" id="${prefix}Focused1" value="1">
                            <label for="${prefix}Focused1">1</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Focused" id="${prefix}Focused2" value="2">
                            <label for="${prefix}Focused2">2</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Focused" id="${prefix}Focused3" value="3">
                            <label for="${prefix}Focused3">3</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Focused" id="${prefix}Focused4" value="4">
                            <label for="${prefix}Focused4">4</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Focused" id="${prefix}Focused5" value="5">
                            <label for="${prefix}Focused5">5</label>
                        </div>
                    </div>
                </div>
                
                <!-- Connected to nature -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">Connected to nature</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Connected" id="${prefix}Connected1" value="1">
                            <label for="${prefix}Connected1">1</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Connected" id="${prefix}Connected2" value="2">
                            <label for="${prefix}Connected2">2</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Connected" id="${prefix}Connected3" value="3">
                            <label for="${prefix}Connected3">3</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Connected" id="${prefix}Connected4" value="4">
                            <label for="${prefix}Connected4">4</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Connected" id="${prefix}Connected5" value="5">
                            <label for="${prefix}Connected5">5</label>
                        </div>
                    </div>
                </div>
                
                <!-- A sense of wonder -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">A sense of wonder</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Wonder" id="${prefix}Wonder1" value="1">
                            <label for="${prefix}Wonder1">1</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Wonder" id="${prefix}Wonder2" value="2">
                            <label for="${prefix}Wonder2">2</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Wonder" id="${prefix}Wonder3" value="3">
                            <label for="${prefix}Wonder3">3</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Wonder" id="${prefix}Wonder4" value="4">
                            <label for="${prefix}Wonder4">4</label>
                        </div>
                        <div class="mood-scale-option">
                            <input type="radio" name="${prefix}Wonder" id="${prefix}Wonder5" value="5">
                            <label for="${prefix}Wonder5">5</label>
                        </div>
                    </div>
                </div>
                </div>
                
                <button type="button" class="modal-submit" disabled>✓ Next</button>
            </div>
        </div>
    `;
    return modal;
}

export function createPreSurveyModal() {
    return createMoodSurveyModal('pre', 'preSurveyModal', '📊 Pre-Survey');
}

export function createPostSurveyModal() {
    return createMoodSurveyModal('post', 'postSurveyModal', '📊 Post-Survey');
}

export function createAwesfModal() {
    const modal = document.createElement('div');
    modal.id = 'awesfModal';
    modal.className = 'modal-overlay awesf-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3 class="modal-title">Please take a moment to reflect on your experience</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <!-- Quick-fill buttons -->
                <div class="quick-fill-buttons" style="display: flex; gap: 8px; margin-bottom: 15px; padding: 10px; background: rgba(0, 0, 0, 0.05); border-radius: 6px; justify-content: center; flex-wrap: wrap;">
                    <span style="font-weight: 600; color: #555; margin-right: 8px; align-self: center;">Quick fill:</span>
                    <button type="button" class="quick-fill-btn" data-value="1" data-survey="awesfModal" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 2px solid #4CAF50; background: white; color: #4CAF50; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#e8f5e9'" onmouseout="this.style.background='white'">1</button>
                    <button type="button" class="quick-fill-btn" data-value="2" data-survey="awesfModal" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 2px solid #4CAF50; background: white; color: #4CAF50; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#e8f5e9'" onmouseout="this.style.background='white'">2</button>
                    <button type="button" class="quick-fill-btn" data-value="3" data-survey="awesfModal" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 2px solid #4CAF50; background: white; color: #4CAF50; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#e8f5e9'" onmouseout="this.style.background='white'">3</button>
                    <button type="button" class="quick-fill-btn" data-value="4" data-survey="awesfModal" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 2px solid #4CAF50; background: white; color: #4CAF50; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#e8f5e9'" onmouseout="this.style.background='white'">4</button>
                    <button type="button" class="quick-fill-btn" data-value="5" data-survey="awesfModal" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 2px solid #4CAF50; background: white; color: #4CAF50; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#e8f5e9'" onmouseout="this.style.background='white'">5</button>
                    <button type="button" class="quick-fill-btn" data-value="6" data-survey="awesfModal" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 2px solid #4CAF50; background: white; color: #4CAF50; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#e8f5e9'" onmouseout="this.style.background='white'">6</button>
                    <button type="button" class="quick-fill-btn" data-value="7" data-survey="awesfModal" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 2px solid #4CAF50; background: white; color: #4CAF50; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#e8f5e9'" onmouseout="this.style.background='white'">7</button>
                </div>
                
                <!-- Scale header labels -->
                <div class="survey-scale-labels">
                    <div></div>
                    <div class="survey-scale-labels-grid">
                        <span>Strongly Disagree</span>
                        <span>Moderately Disagree</span>
                        <span>Somewhat Disagree</span>
                        <span>Neutral</span>
                        <span>Somewhat Agree</span>
                        <span>Moderately Agree</span>
                        <span>Strongly<br>Agree</span>
                    </div>
                </div>
                
                <div class="mood-scale-container">
                <!-- I sensed things momentarily slow down -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">I sensed things momentarily slow down</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option"><input type="radio" name="slowDown" id="slowDown1" value="1"><label for="slowDown1">1</label></div>
                        <div class="mood-scale-option"><input type="radio" name="slowDown" id="slowDown2" value="2"><label for="slowDown2">2</label></div>
                        <div class="mood-scale-option"><input type="radio" name="slowDown" id="slowDown3" value="3"><label for="slowDown3">3</label></div>
                        <div class="mood-scale-option"><input type="radio" name="slowDown" id="slowDown4" value="4"><label for="slowDown4">4</label></div>
                        <div class="mood-scale-option"><input type="radio" name="slowDown" id="slowDown5" value="5"><label for="slowDown5">5</label></div>
                        <div class="mood-scale-option"><input type="radio" name="slowDown" id="slowDown6" value="6"><label for="slowDown6">6</label></div>
                        <div class="mood-scale-option"><input type="radio" name="slowDown" id="slowDown7" value="7"><label for="slowDown7">7</label></div>
                    </div>
                </div>
                
                <!-- I experienced a reduced sense of self -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">I experienced a reduced sense of self</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option"><input type="radio" name="reducedSelf" id="reducedSelf1" value="1"><label for="reducedSelf1">1</label></div>
                        <div class="mood-scale-option"><input type="radio" name="reducedSelf" id="reducedSelf2" value="2"><label for="reducedSelf2">2</label></div>
                        <div class="mood-scale-option"><input type="radio" name="reducedSelf" id="reducedSelf3" value="3"><label for="reducedSelf3">3</label></div>
                        <div class="mood-scale-option"><input type="radio" name="reducedSelf" id="reducedSelf4" value="4"><label for="reducedSelf4">4</label></div>
                        <div class="mood-scale-option"><input type="radio" name="reducedSelf" id="reducedSelf5" value="5"><label for="reducedSelf5">5</label></div>
                        <div class="mood-scale-option"><input type="radio" name="reducedSelf" id="reducedSelf6" value="6"><label for="reducedSelf6">6</label></div>
                        <div class="mood-scale-option"><input type="radio" name="reducedSelf" id="reducedSelf7" value="7"><label for="reducedSelf7">7</label></div>
                    </div>
                </div>
                
                <!-- I had chills -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">I had chills</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option"><input type="radio" name="chills" id="chills1" value="1"><label for="chills1">1</label></div>
                        <div class="mood-scale-option"><input type="radio" name="chills" id="chills2" value="2"><label for="chills2">2</label></div>
                        <div class="mood-scale-option"><input type="radio" name="chills" id="chills3" value="3"><label for="chills3">3</label></div>
                        <div class="mood-scale-option"><input type="radio" name="chills" id="chills4" value="4"><label for="chills4">4</label></div>
                        <div class="mood-scale-option"><input type="radio" name="chills" id="chills5" value="5"><label for="chills5">5</label></div>
                        <div class="mood-scale-option"><input type="radio" name="chills" id="chills6" value="6"><label for="chills6">6</label></div>
                        <div class="mood-scale-option"><input type="radio" name="chills" id="chills7" value="7"><label for="chills7">7</label></div>
                    </div>
                </div>
                
                <!-- I experienced a sense of oneness with all things -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">I experienced a sense of oneness with all things</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option"><input type="radio" name="oneness" id="oneness1" value="1"><label for="oneness1">1</label></div>
                        <div class="mood-scale-option"><input type="radio" name="oneness" id="oneness2" value="2"><label for="oneness2">2</label></div>
                        <div class="mood-scale-option"><input type="radio" name="oneness" id="oneness3" value="3"><label for="oneness3">3</label></div>
                        <div class="mood-scale-option"><input type="radio" name="oneness" id="oneness4" value="4"><label for="oneness4">4</label></div>
                        <div class="mood-scale-option"><input type="radio" name="oneness" id="oneness5" value="5"><label for="oneness5">5</label></div>
                        <div class="mood-scale-option"><input type="radio" name="oneness" id="oneness6" value="6"><label for="oneness6">6</label></div>
                        <div class="mood-scale-option"><input type="radio" name="oneness" id="oneness7" value="7"><label for="oneness7">7</label></div>
                    </div>
                </div>
                
                <!-- I felt that I was in the presence of something grand -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">I felt that I was in the presence of something grand</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option"><input type="radio" name="grand" id="grand1" value="1"><label for="grand1">1</label></div>
                        <div class="mood-scale-option"><input type="radio" name="grand" id="grand2" value="2"><label for="grand2">2</label></div>
                        <div class="mood-scale-option"><input type="radio" name="grand" id="grand3" value="3"><label for="grand3">3</label></div>
                        <div class="mood-scale-option"><input type="radio" name="grand" id="grand4" value="4"><label for="grand4">4</label></div>
                        <div class="mood-scale-option"><input type="radio" name="grand" id="grand5" value="5"><label for="grand5">5</label></div>
                        <div class="mood-scale-option"><input type="radio" name="grand" id="grand6" value="6"><label for="grand6">6</label></div>
                        <div class="mood-scale-option"><input type="radio" name="grand" id="grand7" value="7"><label for="grand7">7</label></div>
                    </div>
                </div>
                
                <!-- I felt that my sense of self was diminished -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">I felt that my sense of self was diminished</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option"><input type="radio" name="diminishedSelf" id="diminishedSelf1" value="1"><label for="diminishedSelf1">1</label></div>
                        <div class="mood-scale-option"><input type="radio" name="diminishedSelf" id="diminishedSelf2" value="2"><label for="diminishedSelf2">2</label></div>
                        <div class="mood-scale-option"><input type="radio" name="diminishedSelf" id="diminishedSelf3" value="3"><label for="diminishedSelf3">3</label></div>
                        <div class="mood-scale-option"><input type="radio" name="diminishedSelf" id="diminishedSelf4" value="4"><label for="diminishedSelf4">4</label></div>
                        <div class="mood-scale-option"><input type="radio" name="diminishedSelf" id="diminishedSelf5" value="5"><label for="diminishedSelf5">5</label></div>
                        <div class="mood-scale-option"><input type="radio" name="diminishedSelf" id="diminishedSelf6" value="6"><label for="diminishedSelf6">6</label></div>
                        <div class="mood-scale-option"><input type="radio" name="diminishedSelf" id="diminishedSelf7" value="7"><label for="diminishedSelf7">7</label></div>
                    </div>
                </div>
                
                <!-- I noticed time slowing -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">I noticed time slowing</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option"><input type="radio" name="timeSlowing" id="timeSlowing1" value="1"><label for="timeSlowing1">1</label></div>
                        <div class="mood-scale-option"><input type="radio" name="timeSlowing" id="timeSlowing2" value="2"><label for="timeSlowing2">2</label></div>
                        <div class="mood-scale-option"><input type="radio" name="timeSlowing" id="timeSlowing3" value="3"><label for="timeSlowing3">3</label></div>
                        <div class="mood-scale-option"><input type="radio" name="timeSlowing" id="timeSlowing4" value="4"><label for="timeSlowing4">4</label></div>
                        <div class="mood-scale-option"><input type="radio" name="timeSlowing" id="timeSlowing5" value="5"><label for="timeSlowing5">5</label></div>
                        <div class="mood-scale-option"><input type="radio" name="timeSlowing" id="timeSlowing6" value="6"><label for="timeSlowing6">6</label></div>
                        <div class="mood-scale-option"><input type="radio" name="timeSlowing" id="timeSlowing7" value="7"><label for="timeSlowing7">7</label></div>
                    </div>
                </div>
                
                <!-- I had the sense of being connected to everything -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">I had the sense of being connected to everything</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option"><input type="radio" name="awesfConnected" id="awesfConnected1" value="1"><label for="awesfConnected1">1</label></div>
                        <div class="mood-scale-option"><input type="radio" name="awesfConnected" id="awesfConnected2" value="2"><label for="awesfConnected2">2</label></div>
                        <div class="mood-scale-option"><input type="radio" name="awesfConnected" id="awesfConnected3" value="3"><label for="awesfConnected3">3</label></div>
                        <div class="mood-scale-option"><input type="radio" name="awesfConnected" id="awesfConnected4" value="4"><label for="awesfConnected4">4</label></div>
                        <div class="mood-scale-option"><input type="radio" name="awesfConnected" id="awesfConnected5" value="5"><label for="awesfConnected5">5</label></div>
                        <div class="mood-scale-option"><input type="radio" name="awesfConnected" id="awesfConnected6" value="6"><label for="awesfConnected6">6</label></div>
                        <div class="mood-scale-option"><input type="radio" name="awesfConnected" id="awesfConnected7" value="7"><label for="awesfConnected7">7</label></div>
                    </div>
                </div>
                
                <!-- I felt small compared to everything else -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">I felt small compared to everything else</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option"><input type="radio" name="small" id="small1" value="1"><label for="small1">1</label></div>
                        <div class="mood-scale-option"><input type="radio" name="small" id="small2" value="2"><label for="small2">2</label></div>
                        <div class="mood-scale-option"><input type="radio" name="small" id="small3" value="3"><label for="small3">3</label></div>
                        <div class="mood-scale-option"><input type="radio" name="small" id="small4" value="4"><label for="small4">4</label></div>
                        <div class="mood-scale-option"><input type="radio" name="small" id="small5" value="5"><label for="small5">5</label></div>
                        <div class="mood-scale-option"><input type="radio" name="small" id="small6" value="6"><label for="small6">6</label></div>
                        <div class="mood-scale-option"><input type="radio" name="small" id="small7" value="7"><label for="small7">7</label></div>
                    </div>
                </div>
                
                <!-- I perceived vastness -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">I perceived vastness</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option"><input type="radio" name="vastness" id="vastness1" value="1"><label for="vastness1">1</label></div>
                        <div class="mood-scale-option"><input type="radio" name="vastness" id="vastness2" value="2"><label for="vastness2">2</label></div>
                        <div class="mood-scale-option"><input type="radio" name="vastness" id="vastness3" value="3"><label for="vastness3">3</label></div>
                        <div class="mood-scale-option"><input type="radio" name="vastness" id="vastness4" value="4"><label for="vastness4">4</label></div>
                        <div class="mood-scale-option"><input type="radio" name="vastness" id="vastness5" value="5"><label for="vastness5">5</label></div>
                        <div class="mood-scale-option"><input type="radio" name="vastness" id="vastness6" value="6"><label for="vastness6">6</label></div>
                        <div class="mood-scale-option"><input type="radio" name="vastness" id="vastness7" value="7"><label for="vastness7">7</label></div>
                    </div>
                </div>
                
                <!-- I felt challenged to understand the experience -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">I felt challenged to understand the experience</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option"><input type="radio" name="challenged" id="challenged1" value="1"><label for="challenged1">1</label></div>
                        <div class="mood-scale-option"><input type="radio" name="challenged" id="challenged2" value="2"><label for="challenged2">2</label></div>
                        <div class="mood-scale-option"><input type="radio" name="challenged" id="challenged3" value="3"><label for="challenged3">3</label></div>
                        <div class="mood-scale-option"><input type="radio" name="challenged" id="challenged4" value="4"><label for="challenged4">4</label></div>
                        <div class="mood-scale-option"><input type="radio" name="challenged" id="challenged5" value="5"><label for="challenged5">5</label></div>
                        <div class="mood-scale-option"><input type="radio" name="challenged" id="challenged6" value="6"><label for="challenged6">6</label></div>
                        <div class="mood-scale-option"><input type="radio" name="challenged" id="challenged7" value="7"><label for="challenged7">7</label></div>
                    </div>
                </div>
                
                <!-- I felt my sense of self shrink -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label">I felt my sense of self shrink</div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option"><input type="radio" name="selfShrink" id="selfShrink1" value="1"><label for="selfShrink1">1</label></div>
                        <div class="mood-scale-option"><input type="radio" name="selfShrink" id="selfShrink2" value="2"><label for="selfShrink2">2</label></div>
                        <div class="mood-scale-option"><input type="radio" name="selfShrink" id="selfShrink3" value="3"><label for="selfShrink3">3</label></div>
                        <div class="mood-scale-option"><input type="radio" name="selfShrink" id="selfShrink4" value="4"><label for="selfShrink4">4</label></div>
                        <div class="mood-scale-option"><input type="radio" name="selfShrink" id="selfShrink5" value="5"><label for="selfShrink5">5</label></div>
                        <div class="mood-scale-option"><input type="radio" name="selfShrink" id="selfShrink6" value="6"><label for="selfShrink6">6</label></div>
                        <div class="mood-scale-option"><input type="radio" name="selfShrink" id="selfShrink7" value="7"><label for="selfShrink7">7</label></div>
                    </div>
                </div>
                </div>
                
                <button type="button" class="modal-submit" disabled>✓ Next</button>
            </div>
        </div>
    `;
    return modal;
}

// Initialize and inject modals into the page
export function initializeModals() {
    const participantModal = createParticipantModal();
    const preSurveyModal = createPreSurveyModal();
    const postSurveyModal = createPostSurveyModal();
    const awesfModal = createAwesfModal();
    
    document.body.appendChild(participantModal);
    document.body.appendChild(preSurveyModal);
    document.body.appendChild(postSurveyModal);
    document.body.appendChild(awesfModal);
    
    // Pre-populate participant ID from localStorage if available
    const savedParticipantId = localStorage.getItem('participantId');
    const participantIdInput = document.getElementById('participantId');
    const participantSubmitBtn = document.querySelector('#participantModal .modal-submit');
    
    if (participantIdInput) {
        participantIdInput.value = savedParticipantId || '';
    }
    
    // Update button state based on whether there's a saved value
    if (participantSubmitBtn) {
        const hasValue = participantIdInput && participantIdInput.value.trim().length > 0;
        participantSubmitBtn.disabled = !hasValue;
        if (savedParticipantId) {
            console.log('💾 Pre-populated participant ID from localStorage:', savedParticipantId);
        }
    }
    
    console.log('📋 Modals initialized and injected into DOM');
}

