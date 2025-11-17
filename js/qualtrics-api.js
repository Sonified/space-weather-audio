/**
 * Qualtrics API Integration
 * Handles submission of survey responses to Qualtrics API
 */

// Qualtrics API Configuration
const QUALTRICS_CONFIG = {
    BASE_URL: "https://oregon.yul1.qualtrics.com/API/v3",
    SURVEY_ID: "SV_bNni117IsBWNZWu",
    API_TOKEN: "FcoNLQoHtQVRAoUdIfqexMjIQgC3qqgut9Yg89Xo"
};

// Question ID mappings based on survey structure
const QUESTION_IDS = {
    // Pre-session PANAS (QID5)
    PRE_CALM: "QID5_1",
    PRE_ENERGIZED: "QID5_2", 
    PRE_CONNECTED: "QID5_3",
    PRE_NERVOUS: "QID5_4",
    PRE_FOCUSED: "QID5_5",
    PRE_WONDER: "QID5_6",
    
    // Post-session PANAS (QID12)
    POST_CALM: "QID12_1",
    POST_ENERGIZED: "QID12_2",
    POST_CONNECTED: "QID12_3", 
    POST_NERVOUS: "QID12_4",
    POST_FOCUSED: "QID12_5",
    POST_WONDER: "QID12_6",
    
    // AWE-SF Scale (QID13) - 13 items
    AWE_SLOW_DOWN: "QID13_1",
    AWE_REDUCED_SELF: "QID13_2",
    AWE_CHILLS: "QID13_3",
    AWE_ONENESS: "QID13_4",
    AWE_GRAND: "QID13_5",
    AWE_DIMINISHED_SELF: "QID13_6",
    AWE_TIME_SLOWING: "QID13_7",
    AWE_CONNECTED: "QID13_8",
    AWE_SMALL: "QID13_9",
    AWE_VASTNESS: "QID13_10",
    AWE_CHALLENGED: "QID13_11",
    AWE_SELF_SHRINK: "QID13_12",
    
    // Activity Level (QID15) - 5-point scale
    ACTIVITY_LEVEL: "QID15_1",
    
    // JSON dump field (QID11) - for storing event data
    JSON_DUMP: "QID11"
};

/**
 * Submit combined survey responses to Qualtrics API (all surveys in one submission)
 * @param {Object} combinedResponses - Object containing pre, post, and awesf survey data
 * @param {string} participantId - Optional participant ID from URL parameter
 * @returns {Promise<Object>} - Response from Qualtrics API
 */
export async function submitCombinedSurveyResponse(combinedResponses, participantId = null) {
    const url = `${QUALTRICS_CONFIG.BASE_URL}/surveys/${QUALTRICS_CONFIG.SURVEY_ID}/responses`;
    
    // Build the values object for Qualtrics API
    const values = {};
    
    // Helper function to convert string values to numbers for Qualtrics API
    const toNumber = (value) => {
        if (value === null || value === undefined) return null;
        const num = parseInt(value, 10);
        return isNaN(num) ? null : num;
    };
    
    // Combine all survey types into one submission
    // Pre-session PANAS
    if (combinedResponses.pre) {
        const pre = combinedResponses.pre;
        console.log('📋 Including Pre-survey data in submission:', pre);
        if (pre.calm) values[QUESTION_IDS.PRE_CALM] = toNumber(pre.calm);
        if (pre.energized) values[QUESTION_IDS.PRE_ENERGIZED] = toNumber(pre.energized);
        if (pre.connected) values[QUESTION_IDS.PRE_CONNECTED] = toNumber(pre.connected);
        if (pre.nervous) values[QUESTION_IDS.PRE_NERVOUS] = toNumber(pre.nervous);
        if (pre.focused) values[QUESTION_IDS.PRE_FOCUSED] = toNumber(pre.focused);
        if (pre.wonder) values[QUESTION_IDS.PRE_WONDER] = toNumber(pre.wonder);
        console.log(`✅ Pre-survey values added: ${Object.keys(values).filter(k => k.startsWith('QID5')).length} fields`);
    } else {
        console.warn('⚠️ Pre-survey data not found in combinedResponses - skipping pre-survey submission');
    }
    
    // Post-session PANAS
    if (combinedResponses.post) {
        const post = combinedResponses.post;
        if (post.calm) values[QUESTION_IDS.POST_CALM] = toNumber(post.calm);
        if (post.energized) values[QUESTION_IDS.POST_ENERGIZED] = toNumber(post.energized);
        if (post.connected) values[QUESTION_IDS.POST_CONNECTED] = toNumber(post.connected);
        if (post.nervous) values[QUESTION_IDS.POST_NERVOUS] = toNumber(post.nervous);
        if (post.focused) values[QUESTION_IDS.POST_FOCUSED] = toNumber(post.focused);
        if (post.wonder) values[QUESTION_IDS.POST_WONDER] = toNumber(post.wonder);
    }
    
    // AWE-SF Scale
    if (combinedResponses.awesf) {
        const awesf = combinedResponses.awesf;
        if (awesf.slowDown) values[QUESTION_IDS.AWE_SLOW_DOWN] = toNumber(awesf.slowDown);
        if (awesf.reducedSelf) values[QUESTION_IDS.AWE_REDUCED_SELF] = toNumber(awesf.reducedSelf);
        if (awesf.chills) values[QUESTION_IDS.AWE_CHILLS] = toNumber(awesf.chills);
        if (awesf.oneness) values[QUESTION_IDS.AWE_ONENESS] = toNumber(awesf.oneness);
        if (awesf.grand) values[QUESTION_IDS.AWE_GRAND] = toNumber(awesf.grand);
        if (awesf.diminishedSelf) values[QUESTION_IDS.AWE_DIMINISHED_SELF] = toNumber(awesf.diminishedSelf);
        if (awesf.timeSlowing) values[QUESTION_IDS.AWE_TIME_SLOWING] = toNumber(awesf.timeSlowing);
        if (awesf.awesfConnected) values[QUESTION_IDS.AWE_CONNECTED] = toNumber(awesf.awesfConnected);
        if (awesf.small) values[QUESTION_IDS.AWE_SMALL] = toNumber(awesf.small);
        if (awesf.vastness) values[QUESTION_IDS.AWE_VASTNESS] = toNumber(awesf.vastness);
        if (awesf.challenged) values[QUESTION_IDS.AWE_CHALLENGED] = toNumber(awesf.challenged);
        if (awesf.selfShrink) values[QUESTION_IDS.AWE_SELF_SHRINK] = toNumber(awesf.selfShrink);
    }
    
    // Activity Level (5-point scale)
    // Map UI values (1-5) to Qualtrics choice IDs (2, 7, 8, 9, 10)
    if (combinedResponses.activityLevel) {
        const activityLevel = combinedResponses.activityLevel;
        if (activityLevel.activityLevel) {
            const uiValue = parseInt(activityLevel.activityLevel, 10);
            const qualtricsChoiceMap = {
                1: 2,   // UI 1 → Qualtrics 2 (Very low / Not active)
                2: 7,   // UI 2 → Qualtrics 7 (Low / Moderately active)
                3: 8,   // UI 3 → Qualtrics 8 (Somewhat low / Active)
                4: 9,   // UI 4 → Qualtrics 9 (Moderate / Very Active)
                5: 10   // UI 5 → Qualtrics 10 (Somewhat high / Extremely Active)
            };
            const qualtricsValue = qualtricsChoiceMap[uiValue];
            if (qualtricsValue) {
                values[QUESTION_IDS.ACTIVITY_LEVEL] = qualtricsValue;
            }
        }
    }
    
    // Format volcano name for QID8 (Event tracking - Volcano column)
    // Format: Kilauea, MaunaLoa, GreatSitkin, Shishaldin, Spurr
    function formatVolcanoName(volcanoValue) {
        const volcanoMap = {
            'kilauea': 'Kilauea',
            'maunaloa': 'MaunaLoa',
            'greatsitkin': 'GreatSitkin',
            'shishaldin': 'Shishaldin',
            'spurr': 'Spurr'
        };
        // Handle case-insensitive lookup
        const lowerVolcano = (volcanoValue || '').toLowerCase();
        return volcanoMap[lowerVolcano] || volcanoValue;
    }
    
    // Submit features/events to QID8 matrix question
    // QID8 structure: Each feature becomes a row (subquestion), with columns:
    // Choice 1: Event Start Time (_N_1_TEXT)
    // Choice 2: Event End Time (_N_2_TEXT)
    // Choice 4: Volcano (_N_4_TEXT)
    // Choice 5: Frequency Min (_N_5_TEXT)
    // Choice 6: Frequency Max (_N_6_TEXT)
    // Choice 7: Notes (_N_7_TEXT)
    // Choice 8: Region number (_N_8_TEXT)
    if (combinedResponses.jsonDump && combinedResponses.jsonDump.regions) {
        const regions = combinedResponses.jsonDump.regions;
        let featureRowIndex = 1; // QID8 subquestions start at 1
        
        // Get volcano from first region or UI
        let volcanoName = null;
        try {
            const volcanoSelect = document.getElementById('volcano');
            if (volcanoSelect && volcanoSelect.value) {
                volcanoName = formatVolcanoName(volcanoSelect.value);
            }
        } catch (error) {
            console.warn('⚠️ Could not get volcano selection for QID8:', error);
        }
        
        regions.forEach((region) => {
            const regionNumber = region.regionNumber || null;
            const regionStartTime = region.regionStartTime || null;
            const regionEndTime = region.regionEndTime || null;
            
            // Submit each feature in this region as a row in QID8
            if (region.features && region.features.length > 0) {
                region.features.forEach((feature) => {
                    // QID8 matrix format: _{subquestion}_{choice}_TEXT
                    const rowPrefix = `_${featureRowIndex}`;
                    
                    // Event Start Time (Choice 1) - Feature start time in UTC ISO format
                    if (feature.featureStartTime) {
                        values[`${rowPrefix}_1_TEXT`] = feature.featureStartTime;
                    }
                    
                    // Event End Time (Choice 2) - Feature end time in UTC ISO format
                    if (feature.featureEndTime) {
                        values[`${rowPrefix}_2_TEXT`] = feature.featureEndTime;
                    }
                    
                    // Volcano (Choice 4) - Use volcano from region or UI
                    if (volcanoName) {
                        values[`${rowPrefix}_4_TEXT`] = volcanoName;
                    }
                    
                    // Frequency Min (Choice 5)
                    if (feature.lowFreq !== null && feature.lowFreq !== undefined) {
                        values[`${rowPrefix}_5_TEXT`] = String(feature.lowFreq);
                    }
                    
                    // Frequency Max (Choice 6)
                    if (feature.highFreq !== null && feature.highFreq !== undefined) {
                        values[`${rowPrefix}_6_TEXT`] = String(feature.highFreq);
                    }
                    
                    // Notes (Choice 7)
                    if (feature.notes) {
                        values[`${rowPrefix}_7_TEXT`] = feature.notes;
                    }
                    
                    // Region number (Choice 8)
                    if (regionNumber !== null) {
                        values[`${rowPrefix}_8_TEXT`] = String(regionNumber);
                    }
                    
                    featureRowIndex++;
                });
            }
        });
        
        if (featureRowIndex > 1) {
            console.log(`📊 Submitted ${featureRowIndex - 1} feature(s) to QID8 matrix`);
        }
    }
    
    // Initialize embedded data object (will be added to values, not separate)
    const embeddedData = {};
    
    // Add participant ID as embedded data if provided
    if (participantId) {
        embeddedData.ParticipantID = participantId;
        // Add to values object (embedded data fields go in values when creating responses)
        values.ParticipantID = participantId;
    }
    
    // Add timing data as embedded data (more reliable than text entry field)
    // Embedded data fields are returned by the API, text entry fields often are not
    // IMPORTANT: When creating responses via API, embedded data fields must be in the values object
    if (combinedResponses.jsonDump) {
        const jsonDumpString = JSON.stringify(combinedResponses.jsonDump);
        embeddedData.SessionTracking = jsonDumpString;
        // Add to values object (embedded data fields go in values when creating responses)
        values.SessionTracking = jsonDumpString;
        console.log('📋 SessionTracking being sent to Qualtrics as embedded data:', {
            fieldName: 'SessionTracking',
            length: jsonDumpString.length,
            preview: jsonDumpString.substring(0, 200) + '...',
            inValues: 'SessionTracking' in values
        });
        
        // Also keep QID11 for backwards compatibility (if it exists in survey)
        // But embedded data is the primary method now
        // TODO: Remove QID11 once embedded data fields are confirmed working
        values[QUESTION_IDS.JSON_DUMP] = jsonDumpString;
    } else {
        console.warn('⚠️ No JSON dump provided in combinedResponses');
    }
    
    // Add interface interaction data as embedded data (future use)
    // This will store all JSON data about participant interactions with the interface
    if (combinedResponses.jsonData) {
        const jsonDataString = JSON.stringify(combinedResponses.jsonData);
        embeddedData.JSON_data = jsonDataString;
        // Add to values object (embedded data fields go in values when creating responses)
        values.JSON_data = jsonDataString;
        console.log('📋 JSON_data being sent to Qualtrics as embedded data:', {
            fieldName: 'JSON_data',
            length: jsonDataString.length,
            preview: jsonDataString.substring(0, 200) + '...',
            inValues: 'JSON_data' in values
        });
    }
    
    // Build the request payload
    // NOTE: When creating responses, embedded data fields go in the values object, not a separate embeddedData key
    const payload = {
        values: values
    };
    
    // Log what embedded data we're sending
    if (Object.keys(embeddedData).length > 0) {
        console.log('📦 Embedded data being sent in values object:', {
            fields: Object.keys(embeddedData),
            allValuesKeys: Object.keys(values).filter(k => k === 'SessionTracking' || k === 'JSON_data' || k === 'ParticipantID')
        });
    }
    
    try {
        console.log('📤 Submitting combined responses to Qualtrics API:', {
            url,
            participantId: participantId || 'none',
            valuesCount: Object.keys(values).length,
            hasPre: !!combinedResponses.pre,
            hasPost: !!combinedResponses.post,
            hasAwesf: !!combinedResponses.awesf,
            hasJsonDump: !!values[QUESTION_IDS.JSON_DUMP],
            allFieldIds: Object.keys(values)
        });
        
        // Log the full payload to verify JSON dump is included
        if (payload.values[QUESTION_IDS.JSON_DUMP]) {
            console.log('📦 JSON Dump in payload:', {
                fieldId: QUESTION_IDS.JSON_DUMP,
                length: payload.values[QUESTION_IDS.JSON_DUMP].length,
                preview: payload.values[QUESTION_IDS.JSON_DUMP].substring(0, 150) + '...'
            });
        } else {
            console.warn('⚠️ JSON Dump NOT in payload values!');
        }
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'X-API-TOKEN': QUALTRICS_CONFIG.API_TOKEN,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            mode: 'cors'
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            let errorMessage = `Qualtrics API error: ${response.status} - ${errorText}`;
            
            // Try to parse error for better error messages
            try {
                const errorJson = JSON.parse(errorText);
                if (errorJson.meta?.error?.errorMessage) {
                    errorMessage = `Qualtrics API error: ${errorJson.meta.error.errorMessage}`;
                }
            } catch (e) {
                // Use the original error message if parsing fails
            }
            
            throw new Error(errorMessage);
        }
        
        const result = await response.json();
        console.log('✅ Qualtrics submission successful:', result);
        
        // Log the response ID if available
        if (result.result && result.result.responseId) {
            console.log('📋 Response ID:', result.result.responseId);
        }
        
        return result;
        
    } catch (error) {
        console.error('❌ Error submitting to Qualtrics:', error);
        throw error;
    }
}

/**
 * Retrieve a submitted survey response from Qualtrics API
 * @param {string} responseId - The response ID from the submission
 * @returns {Promise<Object>} - The response data from Qualtrics
 */
export async function getSurveyResponse(responseId) {
    if (!responseId) {
        throw new Error('Response ID is required');
    }
    
    const url = `${QUALTRICS_CONFIG.BASE_URL}/surveys/${QUALTRICS_CONFIG.SURVEY_ID}/responses/${responseId}`;
    
    try {
        console.log('📥 Retrieving response from Qualtrics API:', {
            url,
            responseId
        });
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'X-API-TOKEN': QUALTRICS_CONFIG.API_TOKEN,
                'Content-Type': 'application/json'
            },
            mode: 'cors'
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            let errorMessage = `Qualtrics API error: ${response.status} - ${errorText}`;
            
            // Try to parse error for better error messages
            try {
                const errorJson = JSON.parse(errorText);
                if (errorJson.meta?.error?.errorMessage) {
                    errorMessage = `Qualtrics API error: ${errorJson.meta.error.errorMessage}`;
                }
            } catch (e) {
                // Use the original error message if parsing fails
            }
            
            throw new Error(errorMessage);
        }
        
        const result = await response.json();
        console.log('✅ Qualtrics response retrieved:', result);
        return result;
        
    } catch (error) {
        console.error('❌ Error retrieving response from Qualtrics:', error);
        throw error;
    }
}

/**
 * Submit a survey response to Qualtrics API (legacy function for single survey submission)
 * @param {Object} responseData - The survey response data
 * @param {string} participantId - Optional participant ID from URL parameter
 * @returns {Promise<Object>} - Response from Qualtrics API
 * @deprecated Use submitCombinedSurveyResponse instead for proper Qualtrics API usage
 */
export async function submitSurveyResponse(responseData, participantId = null) {
    const url = `${QUALTRICS_CONFIG.BASE_URL}/surveys/${QUALTRICS_CONFIG.SURVEY_ID}/responses`;
    
    // Build the values object for Qualtrics API
    const values = {};
    
    // Helper function to convert string values to numbers for Qualtrics API
    const toNumber = (value) => {
        if (value === null || value === undefined) return null;
        const num = parseInt(value, 10);
        return isNaN(num) ? null : num;
    };
    
    // Map survey data to Qualtrics question IDs
    if (responseData.surveyType === 'pre') {
        // Pre-session PANAS - convert strings to numbers
        if (responseData.calm) values[QUESTION_IDS.PRE_CALM] = toNumber(responseData.calm);
        if (responseData.energized) values[QUESTION_IDS.PRE_ENERGIZED] = toNumber(responseData.energized);
        if (responseData.connected) values[QUESTION_IDS.PRE_CONNECTED] = toNumber(responseData.connected);
        if (responseData.nervous) values[QUESTION_IDS.PRE_NERVOUS] = toNumber(responseData.nervous);
        if (responseData.focused) values[QUESTION_IDS.PRE_FOCUSED] = toNumber(responseData.focused);
        if (responseData.wonder) values[QUESTION_IDS.PRE_WONDER] = toNumber(responseData.wonder);
    } else if (responseData.surveyType === 'post') {
        // Post-session PANAS - convert strings to numbers
        if (responseData.calm) values[QUESTION_IDS.POST_CALM] = toNumber(responseData.calm);
        if (responseData.energized) values[QUESTION_IDS.POST_ENERGIZED] = toNumber(responseData.energized);
        if (responseData.connected) values[QUESTION_IDS.POST_CONNECTED] = toNumber(responseData.connected);
        if (responseData.nervous) values[QUESTION_IDS.POST_NERVOUS] = toNumber(responseData.nervous);
        if (responseData.focused) values[QUESTION_IDS.POST_FOCUSED] = toNumber(responseData.focused);
        if (responseData.wonder) values[QUESTION_IDS.POST_WONDER] = toNumber(responseData.wonder);
    } else if (responseData.surveyType === 'awesf') {
        // AWE-SF Scale - convert strings to numbers
        if (responseData.slowDown) values[QUESTION_IDS.AWE_SLOW_DOWN] = toNumber(responseData.slowDown);
        if (responseData.reducedSelf) values[QUESTION_IDS.AWE_REDUCED_SELF] = toNumber(responseData.reducedSelf);
        if (responseData.chills) values[QUESTION_IDS.AWE_CHILLS] = toNumber(responseData.chills);
        if (responseData.oneness) values[QUESTION_IDS.AWE_ONENESS] = toNumber(responseData.oneness);
        if (responseData.grand) values[QUESTION_IDS.AWE_GRAND] = toNumber(responseData.grand);
        if (responseData.diminishedSelf) values[QUESTION_IDS.AWE_DIMINISHED_SELF] = toNumber(responseData.diminishedSelf);
        if (responseData.timeSlowing) values[QUESTION_IDS.AWE_TIME_SLOWING] = toNumber(responseData.timeSlowing);
        if (responseData.awesfConnected) values[QUESTION_IDS.AWE_CONNECTED] = toNumber(responseData.awesfConnected);
        if (responseData.small) values[QUESTION_IDS.AWE_SMALL] = toNumber(responseData.small);
        if (responseData.vastness) values[QUESTION_IDS.AWE_VASTNESS] = toNumber(responseData.vastness);
        if (responseData.challenged) values[QUESTION_IDS.AWE_CHALLENGED] = toNumber(responseData.challenged);
        if (responseData.selfShrink) values[QUESTION_IDS.AWE_SELF_SHRINK] = toNumber(responseData.selfShrink);
    }
    
    // Add JSON dump if provided (for event data)
    if (responseData.jsonDump) {
        values[QUESTION_IDS.JSON_DUMP] = JSON.stringify(responseData.jsonDump);
    }
    
    // Build the request payload
    // Qualtrics API format: embedded data is passed as a separate top-level key
    const payload = {
        values: values
    };
    
    // Add embedded data if participant ID is provided
    // Note: Embedded data field "ParticipantID" must be configured in Qualtrics Survey Flow first
    if (participantId) {
        // Qualtrics API expects embedded data as a separate top-level object
        payload.embeddedData = {
            ParticipantID: participantId
        };
    }
    
    try {
        console.log('📤 Submitting to Qualtrics API:', {
            url,
            surveyType: responseData.surveyType,
            participantId: participantId || 'none',
            valuesCount: Object.keys(values).length
        });
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'X-API-TOKEN': QUALTRICS_CONFIG.API_TOKEN,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            mode: 'cors'
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Qualtrics API error: ${response.status} - ${errorText}`);
        }
        
        const result = await response.json();
        console.log('✅ Qualtrics submission successful:', result);
        return result;
        
    } catch (error) {
        console.error('❌ Error submitting to Qualtrics:', error);
        throw error;
    }
}

/**
 * Parse participant ID from URL parameters
 * Qualtrics typically uses ResponseID in redirect URLs: ?ResponseID=${e://Field/ResponseID}
 * Also supports common parameter names: ParticipantID, participantId, participant_id, id, pid
 * @returns {string|null} - Participant ID if found, null otherwise
 */
export function getParticipantIdFromURL() {
    const params = new URLSearchParams(window.location.search);
    
    // Try parameter names in order of likelihood
    // ResponseID is Qualtrics' standard field name for redirects
    const paramNames = ['ResponseID', 'responseId', 'ParticipantID', 'participantId', 'participant_id', 'id', 'pid'];
    
    for (const paramName of paramNames) {
        const value = params.get(paramName);
        if (value && value.trim()) {
            return value.trim();
        }
    }
    
    return null;
}

/**
 * Store participant ID in localStorage
 * @param {string} participantId - The participant ID to store
 */
export function storeParticipantId(participantId) {
    if (participantId && participantId.trim()) {
        localStorage.setItem('participantId', participantId.trim());
        console.log('💾 Stored participant ID:', participantId.trim());
    }
}

/**
 * Get participant ID from localStorage or URL
 * Checks URL first, then falls back to localStorage
 * @returns {string|null} - Participant ID if found, null otherwise
 */
export function getParticipantId() {
    // First check URL parameters (takes precedence)
    const urlId = getParticipantIdFromURL();
    if (urlId) {
        // Store it for future use
        storeParticipantId(urlId);
        return urlId;
    }
    
    // 🔥 REMOVED: STUDY_CLEAN mode check here
    // We already clear participant ID at the START of startStudyWorkflow()
    // This check was preventing IDs entered during the current session from being found!
    // STUDY_CLEAN mode should clear at workflow start, but allow IDs entered during that session.
    
    // Fall back to localStorage
    const storedId = localStorage.getItem('participantId');
    return storedId || null;
}

