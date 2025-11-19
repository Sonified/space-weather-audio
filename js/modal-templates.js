// Modal HTML templates as ES6 template literals

import { isStudyMode } from './master-modes.js';

// 🔥 FIX: Track if modals have been initialized to prevent duplicate initialization
let modalsInitialized = false;

export function createWelcomeModal() {
    const modal = document.createElement('div');
    modal.id = 'welcomeModal';
    modal.className = 'modal-window';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3 class="modal-title">🌋 Welcome!</h3>
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

export function createEndModal() {
    const modal = document.createElement('div');
    modal.id = 'endModal';
    modal.className = 'modal-window';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content" style="animation: fadeInModal 0.3s ease-in; max-width: 650px; border: 2px solid #8B4513; box-shadow: 0 0 20px rgba(139, 69, 19, 0.15), 0 10px 40px rgba(0, 0, 0, 0.3); background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(139, 69, 19, 0.03) 2px, rgba(139, 69, 19, 0.03) 4px), repeating-linear-gradient(90deg, transparent, transparent 2px, rgba(139, 69, 19, 0.03) 2px, rgba(139, 69, 19, 0.03) 4px), linear-gradient(to bottom, rgba(255, 250, 240, 0.05) 0%, rgba(255, 255, 255, 1) 100%), white; position: relative; overflow: hidden;">
            <!-- Watermark -->
            <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 200px; opacity: 0.04; pointer-events: none; mix-blend-mode: multiply; z-index: 0;">
                🌋
            </div>
            
            <!-- Formal Header -->
            <div style="text-align: center; padding: 30px 20px 15px 20px; position: relative; z-index: 1;">
                <h3 style="font-size: 32px; font-weight: 600; color: #550000; margin: 0 0 15px 0; letter-spacing: 1px;">
                    <span style="font-size: 38px;">🌋</span> Session Completed
                </h3>
                <!-- Elegant divider line -->
                <div style="width: 200px; height: 2px; margin: 0 auto; background: linear-gradient(90deg, rgba(139, 69, 19, 0) 0%, rgba(139, 69, 19, 0.8) 50%, rgba(139, 69, 19, 0) 100%); box-shadow: 0 1px 3px rgba(139, 69, 19, 0.2);"></div>
            </div>
            
            <div style="padding: 0 20px; position: relative; z-index: 1;">
                <!-- Submission Time Card -->
                <div style="background: linear-gradient(to bottom, rgba(255, 255, 255, 1) 0%, rgba(250, 248, 246, 1) 100%); padding: 18px; border-radius: 8px; margin: 15px 0 12px 0; border: 1px solid #d0d0d0; box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 3px rgba(0, 0, 0, 0.08);">
                    <p style="margin: 0; color: #550000; font-size: 16px; line-height: 1.5; text-align: center; font-weight: 500;">
                        Submitted on <strong><span id="submissionDate" style="color: #550000;">--</span></strong> at <strong><span id="submissionTime" style="color: #550000;">--</span></strong>
                    </p>
                    <p style="margin: 12px 0 0 0; color: #550000; font-size: 16px; line-height: 1.5; text-align: center; font-weight: 500;">
                        Participant ID: <span id="submissionParticipantId" style="display: inline-block; background: #0056b3; color: white; padding: 5px 14px; border-radius: 20px; font-weight: 600; font-size: 15px;">--</span>
                    </p>
                </div>
                
                <!-- Study Progress Card -->
                <div style="background: linear-gradient(to bottom, rgba(255, 255, 255, 1) 0%, rgba(250, 248, 246, 1) 100%); padding: 20px; border-radius: 8px; margin-bottom: 12px; border: 1px solid #d0d0d0; box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 3px rgba(0, 0, 0, 0.08);">
                    <p style="margin: 0 0 15px 0; color: #550000; font-size: 18px; line-height: 1.4; text-align: center; font-weight: 600;">
                        Study Progress
                    </p>
                    
                    <!-- Overall Progress Percentage -->
                    <p style="margin: 0 0 12px 0; text-align: center; color: #0056b3; font-size: 22px; font-weight: 600;">
                        <span id="overallProgressPercent">0%</span> Complete
                    </p>
                    
                    <!-- Visual Session Tracker -->
                    <div style="display: flex; justify-content: center; gap: 20px; margin-bottom: 20px;">
                        <!-- Week 1 -->
                        <div style="text-align: center;">
                            <p style="margin: 0 0 8px 0; color: #550000; font-size: 14px; font-weight: 600;">Week 1</p>
                            <div style="display: flex; gap: 6px;">
                                <div id="week1session1" style="width: 30px; height: 30px; border: 2px solid #0056b3; border-radius: 4px; background: #e9ecef;"></div>
                                <div id="week1session2" style="width: 30px; height: 30px; border: 2px solid #0056b3; border-radius: 4px; background: #e9ecef;"></div>
                            </div>
                        </div>
                        
                        <!-- Week 2 -->
                        <div style="text-align: center;">
                            <p style="margin: 0 0 8px 0; color: #550000; font-size: 14px; font-weight: 600;">Week 2</p>
                            <div style="display: flex; gap: 6px;">
                                <div id="week2session1" style="width: 30px; height: 30px; border: 2px solid #0056b3; border-radius: 4px; background: #e9ecef;"></div>
                                <div id="week2session2" style="width: 30px; height: 30px; border: 2px solid #0056b3; border-radius: 4px; background: #e9ecef;"></div>
                            </div>
                        </div>
                        
                        <!-- Week 3 -->
                        <div style="text-align: center;">
                            <p style="margin: 0 0 8px 0; color: #550000; font-size: 14px; font-weight: 600;">Week 3</p>
                            <div style="display: flex; gap: 6px;">
                                <div id="week3session1" style="width: 30px; height: 30px; border: 2px solid #0056b3; border-radius: 4px; background: #e9ecef;"></div>
                                <div id="week3session2" style="width: 30px; height: 30px; border: 2px solid #0056b3; border-radius: 4px; background: #e9ecef;"></div>
                            </div>
                        </div>
                    </div>
                    
                </div>
                
                <!-- Cumulative Stats Card -->
                <div id="cumulativeStatsCard" style="background: linear-gradient(to bottom, rgba(255, 255, 255, 1) 0%, rgba(250, 248, 246, 1) 100%); padding: 18px; border-radius: 8px; margin-bottom: 12px; border: 1px solid #d0d0d0; box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 3px rgba(0, 0, 0, 0.08);">
                    <p style="margin: 0 0 8px 0; color: #550000; font-size: 16px; line-height: 1.5; text-align: center; font-weight: 600;">
                        Cumulative Data Summary
                    </p>
                    <p style="margin: 0; color: #550000; font-size: 15px; line-height: 1.5; text-align: center; font-weight: 500;">
                        Total identified: <strong><span id="cumulativeRegions" style="color: #0056b3;">0</span> <span id="cumulativeRegionWord">regions</span></strong>, <strong><span id="cumulativeFeatures" style="color: #0056b3;">0</span> <span id="cumulativeFeatureWord">features</span></strong>
                    </p>
                </div>
                
                <!-- Requirements Notice -->
                <p style="margin-bottom: 20px; color: #550000; font-size: 15px; line-height: 1.5; text-align: center; padding: 0 10px; font-weight: 500;">
                    All participants are required to complete two sessions per week.
                </p>
                
                <!-- Next Steps -->
                <div style="text-align: center; margin-bottom: 20px; padding: 15px; background: linear-gradient(to bottom, rgba(255, 255, 255, 1) 0%, rgba(250, 248, 246, 1) 100%); border-radius: 8px; border: 1px solid #d0d0d0; box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 3px rgba(0, 0, 0, 0.08);">
                    <p style="margin: 0 0 8px 0; color: #550000; font-size: 17px; line-height: 1.4; font-weight: 600;">
                        Next Steps
                    </p>
                    <p style="margin: 0; color: #550000; font-size: 15px; line-height: 1.5; font-weight: 500;">
                        Your data has been recorded. You may now close this window.
                    </p>
                </div>
                
                <!-- Close Button -->
                <div style="text-align: center; margin-top: 25px; padding-bottom: 10px;">
                    <button onclick="window.close();" style="background: #0056b3; color: white; border: 2px solid #003d82; padding: 12px 36px; font-size: 16px; font-weight: 600; border-radius: 6px; cursor: pointer; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15); transition: all 0.2s; letter-spacing: 0.5px;" onmouseover="this.style.background='#003d82'; this.style.boxShadow='0 3px 8px rgba(0, 0, 0, 0.2)';" onmouseout="this.style.background='#0056b3'; this.style.boxShadow='0 2px 6px rgba(0, 0, 0, 0.15)';">
                        Close Window
                    </button>
                </div>
            </div>
        </div>
        
        <style>
            @keyframes fadeInModal {
                from {
                    opacity: 0;
                    transform: translateY(-10px);
                }
                to {
                    opacity: 1;
                    transform: translateY(0);
                }
            }
        </style>
    `;
    return modal;
}

export function createWelcomeBackModal() {
    const modal = document.createElement('div');
    modal.id = 'welcomeBackModal';
    modal.className = 'modal-window';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3 class="modal-title" style="color: #550000;">🌋 Welcome back!</h3>
            </div>
            <div class="modal-body">
                <p style="margin-bottom: 30px; color: #550000; font-size: 18px; line-height: 1.6; text-align: center;">
                    Are you ready to begin? Your session should be completed in one sitting. Please use high-quality speakers or headphones.
                </p>
                <div style="display: flex; justify-content: center;">
                    <button type="button" class="modal-submit" style="padding: 10px 16px; font-size: 16px; font-weight: 600; background: #007bff; border: 2px solid #007bff; color: white; border-radius: 6px; cursor: pointer; transition: all 0.2s; width: 220px;">Start Now</button>
                </div>
            </div>
        </div>
    `;
    return modal;
}

export function createBeginAnalysisModal() {
    const modal = document.createElement('div');
    modal.id = 'beginAnalysisModal';
    modal.className = 'modal-window';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3 class="modal-title">🌋 Ready to begin?</h3>
            </div>
            <div class="modal-body">
                <p style="margin-bottom: 30px; color: #550000; font-size: 18px; line-height: 1.6; text-align: center;">
                    You won't be able to switch volcanoes after this. Your session should be completed in one sitting. Please use high-quality speakers or headphones.
                </p>
                <div style="display: flex; flex-direction: column; gap: 15px; align-items: center;">
                    <button type="button" class="modal-submit" style="padding: 10px 16px; font-size: 16px; font-weight: 600; background: #007bff; border: 2px solid #007bff; color: white; border-radius: 6px; cursor: pointer; transition: all 0.2s; width: 220px;">Begin Analysis</button>
                    <button type="button" class="modal-cancel" style="padding: 10px 16px; font-size: 16px; font-weight: 600; background: #6c757d; border: 2px solid #6c757d; color: white; border-radius: 6px; cursor: pointer; transition: all 0.2s; width: 220px;">Cancel</button>
                </div>
            </div>
        </div>
    `;
    return modal;
}

export function createCompleteConfirmationModal() {
    const modal = document.createElement('div');
    modal.id = 'completeConfirmationModal';
    modal.className = 'modal-window';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 500px;">
            <div class="modal-header">
                <h3 class="modal-title">🌋 All Done?</h3>
            </div>
            <div class="modal-body">
                <p style="margin-bottom: 20px; color: #550000; font-size: 18px; line-height: 1.6; text-align: center;">
                    You have identified <strong><span id="completeRegionCount" style="color: #0056b3;">0</span> <span id="completeRegionWord">regions</span></strong> with a total of <strong><span id="completeFeatureCount" style="color: #0056b3;">0</span> <span id="completeFeatureWord">features</span></strong>.
                </p>
                <p style="margin-bottom: 30px; color: #550000; font-size: 18px; line-height: 1.6; text-align: center;">
                    Once you continue, you won't be able to add more regions. You'll complete a brief post-survey to finish your session.
                </p>
                <div style="display: flex; flex-direction: column; gap: 15px; align-items: center;">
                    <button type="button" class="modal-submit" style="padding: 10px 16px; font-size: 16px; font-weight: 600; background: #28a745; border: 2px solid #28a745; color: white; border-radius: 6px; cursor: pointer; transition: all 0.2s; width: 180px;">Yes, I'm Done</button>
                    <button type="button" class="modal-cancel" style="padding: 10px 16px; font-size: 16px; font-weight: 600; background: #cc3333; border: 2px solid #cc3333; color: white; border-radius: 6px; cursor: pointer; transition: all 0.2s; width: 180px;">Not yet</button>
                </div>
            </div>
        </div>
    `;
    return modal;
}

export function createTutorialIntroModal() {
    const modal = document.createElement('div');
    modal.id = 'tutorialIntroModal';
    modal.className = 'modal-window';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 600px;">
            <div class="modal-header">
                <h3 class="modal-title">🌋 Tutorial Introduction</h3>
            </div>
            <div class="modal-body">
                <p style="margin-bottom: 20px; color: #333; font-size: 22px; line-height: 1.6; text-align: center;">
                    We will begin with a brief tutorial to provide an introduction to the interface.
                </p>
                <p style="margin-bottom: 30px; color: #555; font-size: 20px; font-weight: bold; line-height: 1.6; text-align: center;">
                    It will take approximately 5 minutes to complete.
                </p>
                <div style="display: flex; flex-direction: column; gap: 15px; align-items: center;">
                    <button type="button" class="modal-submit" style="padding: 10px 16px; font-size: 16px; font-weight: 600; background: #c62828; border: 2px solid #c62828; color: white; border-radius: 6px; cursor: pointer; transition: all 0.2s; width: 280px;">Begin Tutorial</button>
                    <a href="#" id="tutorialSkipLink" style="display: none; color: #666; font-size: 16px; text-decoration: underline; cursor: pointer; margin-top: 5px;">Skip</a>
                </div>
            </div>
        </div>
    `;
    return modal;
}

export function createTutorialRevisitModal() {
    const modal = document.createElement('div');
    modal.id = 'tutorialRevisitModal';
    modal.className = 'modal-window';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 500px;">
            <div class="modal-header">
                <h3 class="modal-title" id="tutorialRevisitTitle">🌋 Revisit Tutorial</h3>
            </div>
            <div class="modal-body">
                <p id="tutorialRevisitSubtext" style="margin-bottom: 30px; color: #550000; font-size: 22px; font-weight: bold; line-height: 1.6; text-align: center;">
                    Would you like to revisit the tutorial?
                </p>
                <div style="display: flex; flex-direction: column; gap: 15px; align-items: center; justify-content: center;">
                    <button type="button" class="modal-submit" id="tutorialRevisitBtn1" style="padding: 8px 16px; font-size: 16px; font-weight: 600; background: #007bff; border: 2px solid #007bff; color: white; border-radius: 6px; cursor: pointer; transition: all 0.2s; width: 200px;">Yes</button>
                    <button type="button" class="modal-cancel" id="tutorialRevisitBtn2" style="padding: 10px 16px; font-size: 16px; font-weight: 600; background: #6c757d; border: 2px solid #6c757d; color: white; border-radius: 6px; cursor: pointer; transition: all 0.2s; width: 200px;">Cancel</button>
                    <button type="button" class="modal-exit" id="tutorialRevisitBtn3" style="display: none; padding: 10px 16px; font-size: 16px; font-weight: 600; background: #dc3545; border: 2px solid #dc3545; color: white; border-radius: 6px; cursor: pointer; transition: all 0.2s; width: 200px;">Exit</button>
                </div>
            </div>
        </div>
    `;
    return modal;
}

export function createMissingStudyIdModal() {
    const modal = document.createElement('div');
    modal.id = 'missingStudyIdModal';
    modal.className = 'modal-window';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3 class="modal-title">🌋 Study ID Required</h3>
            </div>
            <div class="modal-body">
                <p style="margin-bottom: 20px; color: #550000; font-size: 18px; line-height: 1.6; text-align: center;">
                    Your study ID has not been associated with this computer.
                </p>
                <p style="margin-bottom: 20px; color: #550000; font-size: 16px; line-height: 1.6; text-align: center;">
                    In order for your data to be accepted, you will need to enter your study ID or reach out for assistance.
                </p>
                <div style="background: #fff3cd; padding: 15px; border-radius: 6px; margin-bottom: 20px; border-left: 4px solid #ffc107;">
                    <p style="margin-bottom: 10px; color: #856404; font-size: 15px; line-height: 1.6; font-weight: 600;">
                        Need Help?
                    </p>
                    <p style="margin-bottom: 0; color: #856404; font-size: 15px; line-height: 1.6;">
                        Contact <a href="mailto:leif@uoregon.edu" style="color: #007bff; text-decoration: none; font-weight: 600;">leif@uoregon.edu</a> for assistance.
                    </p>
                </div>
                <div style="display: flex; gap: 15px; justify-content: center;">
                    <button type="button" class="modal-submit" style="padding: 12px 24px; font-size: 16px; font-weight: 600; background: #007bff; border: 2px solid #007bff; color: white; border-radius: 6px; cursor: pointer; transition: all 0.2s;">Enter Study ID</button>
                </div>
            </div>
        </div>
    `;
    return modal;
}

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
                <p style="margin-bottom: 20px; color: #550000; font-size: 16px; font-weight: bold;">Enter your participant ID number to begin:</p>
                <div class="modal-form-group">
                    <label for="participantId" style="display: none;">Participant ID/Number:</label>
                    <input type="text" id="participantId" placeholder="Enter participant identifier" style="font-size: 18px;">
                </div>
                <button type="button" class="modal-submit" disabled>✓ Confirm</button>
                <p style="margin-top: 18px; margin-bottom: 0; color: #555; font-size: 18px; text-align: center;">Not look right? Email: leif@uoregon.edu</p>
            </div>
        </div>
    `;
    return modal;
}

function createMoodSurveyModal(surveyType, surveyId, title) {
    const prefix = surveyType === 'pre' ? 'pre' : 'post';
    const modal = document.createElement('div');
    modal.id = surveyId;
    modal.className = 'modal-window';
    modal.style.display = 'none';
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
                    <span style="font-weight: 600; color: #550000; margin-right: 8px; align-self: center;">Quick fill:</span>
                    <button type="button" class="quick-fill-btn" data-value="1" data-survey="${surveyId}" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 1px solid #999; background: white; color: #666; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='white'">1</button>
                    <button type="button" class="quick-fill-btn" data-value="2" data-survey="${surveyId}" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 1px solid #999; background: white; color: #666; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='white'">2</button>
                    <button type="button" class="quick-fill-btn" data-value="3" data-survey="${surveyId}" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 1px solid #999; background: white; color: #666; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='white'">3</button>
                    <button type="button" class="quick-fill-btn" data-value="4" data-survey="${surveyId}" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 1px solid #999; background: white; color: #666; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='white'">4</button>
                    <button type="button" class="quick-fill-btn" data-value="5" data-survey="${surveyId}" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 1px solid #999; background: white; color: #666; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='white'">5</button>
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
                
                <div style="display: flex; justify-content: center; margin-top: 20px;">
                    <button type="button" class="modal-submit" disabled style="padding: 10px 16px; font-size: 16px; font-weight: 600; background: #007bff; border: 2px solid #007bff; color: white; border-radius: 6px; cursor: pointer; transition: all 0.2s; width: 220px;">✓ Next</button>
                </div>
            </div>
        </div>
    `;
    return modal;
}

export function createPreSurveyModal() {
    return createMoodSurveyModal('pre', 'preSurveyModal', '🌋 Pre-Survey');
}

export function createPostSurveyModal() {
    return createMoodSurveyModal('post', 'postSurveyModal', '🌋 Post-Survey');
}

export function createActivityLevelModal() {
    const modal = document.createElement('div');
    modal.id = 'activityLevelModal';
    modal.className = 'modal-window activity-level-modal';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3 class="modal-title">🌋 Activity Level Assessment</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <!-- Question -->
                <div style="font-size: 18px; color: #550000; margin-bottom: 30px; text-align: center; font-weight: normal;">
                    Based on your current knowledge and previous interactions with audified seismic data, during the last 24 hours what is the level of activity displayed here?
                </div>
                
                <!-- Scale header labels -->
                <div class="survey-scale-labels">
                    <div></div>
                    <div class="survey-scale-labels-grid">
                        <span>Not active</span>
                        <span>Moderately active</span>
                        <span>Active</span>
                        <span>Very Active</span>
                        <span>Extremely Active</span>
                    </div>
                </div>
                
                <div class="mood-scale-container">
                <!-- Activity Level -->
                <div class="mood-scale-item">
                    <div class="mood-scale-label"></div>
                    <div class="mood-scale-options">
                        <div class="mood-scale-option"><input type="radio" name="activityLevel" id="activityLevel1" value="1"><label for="activityLevel1">1</label></div>
                        <div class="mood-scale-option"><input type="radio" name="activityLevel" id="activityLevel2" value="2"><label for="activityLevel2">2</label></div>
                        <div class="mood-scale-option"><input type="radio" name="activityLevel" id="activityLevel3" value="3"><label for="activityLevel3">3</label></div>
                        <div class="mood-scale-option"><input type="radio" name="activityLevel" id="activityLevel4" value="4"><label for="activityLevel4">4</label></div>
                        <div class="mood-scale-option"><input type="radio" name="activityLevel" id="activityLevel5" value="5"><label for="activityLevel5">5</label></div>
                    </div>
                </div>
                </div>
                
                <button type="button" class="modal-submit" disabled>✓ Next</button>
            </div>
        </div>
    `;
    return modal;
}

export function createAwesfModal() {
    const modal = document.createElement('div');
    modal.id = 'awesfModal';
    modal.className = 'modal-window awesf-modal';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3 class="modal-title">🌋 Please take a moment to reflect on your experience</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <!-- Quick-fill buttons -->
                <div class="quick-fill-buttons" style="display: flex; gap: 8px; margin-bottom: 15px; padding: 10px; background: rgba(0, 0, 0, 0.05); border-radius: 6px; justify-content: center; flex-wrap: wrap;">
                    <span style="font-weight: 600; color: #550000; margin-right: 8px; align-self: center;">Quick fill:</span>
                    <button type="button" class="quick-fill-btn" data-value="1" data-survey="awesfModal" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 1px solid #999; background: white; color: #666; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='white'">1</button>
                    <button type="button" class="quick-fill-btn" data-value="2" data-survey="awesfModal" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 1px solid #999; background: white; color: #666; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='white'">2</button>
                    <button type="button" class="quick-fill-btn" data-value="3" data-survey="awesfModal" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 1px solid #999; background: white; color: #666; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='white'">3</button>
                    <button type="button" class="quick-fill-btn" data-value="4" data-survey="awesfModal" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 1px solid #999; background: white; color: #666; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='white'">4</button>
                    <button type="button" class="quick-fill-btn" data-value="5" data-survey="awesfModal" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 1px solid #999; background: white; color: #666; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='white'">5</button>
                    <button type="button" class="quick-fill-btn" data-value="6" data-survey="awesfModal" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 1px solid #999; background: white; color: #666; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='white'">6</button>
                    <button type="button" class="quick-fill-btn" data-value="7" data-survey="awesfModal" style="padding: 8px 16px; font-size: 14px; font-weight: 600; border: 1px solid #999; background: white; color: #666; border-radius: 4px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='white'">7</button>
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
export async function initializeModals() {
    // 🔥 FIX: NEVER reinitialize while modals are already initialized!
    // Modals are stateful actors - destroying them mid-workflow breaks promise chains!
    if (modalsInitialized) {
        console.warn('⚠️ Modals already initialized - skipping reinitialization');
        return; // Just bail! Don't destroy and recreate!
    }
    
    const welcomeModal = createWelcomeModal();
    const participantModal = createParticipantModal();
    const preSurveyModal = createPreSurveyModal();
    const postSurveyModal = createPostSurveyModal();
    const activityLevelModal = createActivityLevelModal();
    const awesfModal = createAwesfModal();
    const endModal = createEndModal();
    const beginAnalysisModal = createBeginAnalysisModal();
    const missingStudyIdModal = createMissingStudyIdModal();
    const completeConfirmationModal = createCompleteConfirmationModal();
    const tutorialIntroModal = createTutorialIntroModal();
    const tutorialRevisitModal = createTutorialRevisitModal();
    const welcomeBackModal = createWelcomeBackModal();
    
    // Append modals to the permanent overlay instead of body
    const overlay = document.getElementById('permanentOverlay');
    overlay.appendChild(welcomeModal);
    overlay.appendChild(participantModal);
    overlay.appendChild(preSurveyModal);
    overlay.appendChild(postSurveyModal);
    overlay.appendChild(activityLevelModal);
    overlay.appendChild(awesfModal);
    overlay.appendChild(endModal);
    overlay.appendChild(beginAnalysisModal);
    overlay.appendChild(missingStudyIdModal);
    overlay.appendChild(completeConfirmationModal);
    overlay.appendChild(tutorialIntroModal);
    overlay.appendChild(tutorialRevisitModal);
    overlay.appendChild(welcomeBackModal);
    
    // Pre-populate participant ID from URL (Qualtrics) or localStorage
    // BUT NOT in STUDY_CLEAN mode (always start fresh)
    const storedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('selectedMode') : null;
    const isStudyClean = storedMode === 'study_clean';
    
    // Check URL first (Qualtrics ResponseID), then localStorage
    let savedParticipantId = null;
    if (!isStudyClean) {
        // Try to get from URL (Qualtrics redirect)
        try {
            const { getParticipantIdFromURL } = await import('./qualtrics-api.js');
            const urlId = getParticipantIdFromURL();
            if (urlId) {
                savedParticipantId = urlId;
                // Store it for future use
                const { storeParticipantId } = await import('./qualtrics-api.js');
                storeParticipantId(urlId);
                console.log('🔗 Pre-populated participant ID from Qualtrics URL:', urlId);
            } else {
                // Fall back to localStorage
                savedParticipantId = localStorage.getItem('participantId');
                if (savedParticipantId) {
                    console.log('💾 Pre-populated participant ID from localStorage:', savedParticipantId);
                }
            }
        } catch (error) {
            // If import fails, fall back to localStorage
            savedParticipantId = localStorage.getItem('participantId');
            if (savedParticipantId) {
                console.log('💾 Pre-populated participant ID from localStorage:', savedParticipantId);
            }
        }
    } else {
        console.log('🧹 Study Clean Mode: Not pre-populating participant ID');
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

