/**
 * Qualtrics API Integration
 * Handles submission of survey responses to Qualtrics API
 */

// Load survey configuration from config.json
let SURVEY_CONFIG = null;

async function loadSurveyConfig() {
    if (SURVEY_CONFIG) return SURVEY_CONFIG;
    
    try {
        const response = await fetch('./js/surveys/config.json');
        SURVEY_CONFIG = await response.json();
        return SURVEY_CONFIG;
    } catch (error) {
        console.error('❌ Failed to load survey config, using fallback:', error);
        // Fallback to hardcoded values if config fails to load
        SURVEY_CONFIG = {
            qualtrics: {
                baseUrl: "https://oregon.yul1.qualtrics.com/API/v3",
                surveyId: "SV_bNni117IsBWNZWu",
                apiToken: "FcoNLQoHtQVRAoUdIfqexMjIQgC3qqgut9Yg89Xo"
            },
            questionIds: {
                pre: { fields: { calm: "QID5_1", energized: "QID5_2", connected: "QID5_3", nervous: "QID5_4", focused: "QID5_5", wonder: "QID5_6" } },
                post: { fields: { calm: "QID12_1", energized: "QID12_2", connected: "QID12_3", nervous: "QID12_4", focused: "QID12_5", wonder: "QID12_6" } },
                awesf: { fields: { slowDown: "QID13_1", reducedSelf: "QID13_2", chills: "QID13_3", oneness: "QID13_4", grand: "QID13_5", diminishedSelf: "QID13_6", timeSlowing: "QID13_7", awesfConnected: "QID13_8", small: "QID13_9", vastness: "QID13_10", challenged: "QID13_11", selfShrink: "QID13_12" } },
                activityLevel: { field: "QID15_1" },
                jsonDump: { qid: "QID11" }
            },
            choiceMappings: {
                activityLevel: { uiToQualtrics: { "1": 2, "2": 7, "3": 8, "4": 9, "5": 10 } }
            }
        };
        return SURVEY_CONFIG;
    }
}

// Legacy constants for backwards compatibility (derived from config)
let QUALTRICS_CONFIG = null;
let QUESTION_IDS = null;

async function getQualtricsConfig() {
    const config = await loadSurveyConfig();
    if (!QUALTRICS_CONFIG) {
        QUALTRICS_CONFIG = {
            BASE_URL: config.qualtrics.baseUrl,
            SURVEY_ID: config.qualtrics.surveyId,
            API_TOKEN: config.qualtrics.apiToken
        };
    }
    return QUALTRICS_CONFIG;
}

async function getQuestionIds() {
    const config = await loadSurveyConfig();
    if (!QUESTION_IDS) {
        const qids = config.questionIds;
        QUESTION_IDS = {
            // Pre-session PANAS
            PRE_CALM: qids.pre.fields.calm,
            PRE_ENERGIZED: qids.pre.fields.energized,
            PRE_CONNECTED: qids.pre.fields.connected,
            PRE_NERVOUS: qids.pre.fields.nervous,
            PRE_FOCUSED: qids.pre.fields.focused,
            PRE_WONDER: qids.pre.fields.wonder,
            
            // Post-session PANAS
            POST_CALM: qids.post.fields.calm,
            POST_ENERGIZED: qids.post.fields.energized,
            POST_CONNECTED: qids.post.fields.connected,
            POST_NERVOUS: qids.post.fields.nervous,
            POST_FOCUSED: qids.post.fields.focused,
            POST_WONDER: qids.post.fields.wonder,
            
            // AWE-SF Scale
            AWE_SLOW_DOWN: qids.awesf.fields.slowDown,
            AWE_REDUCED_SELF: qids.awesf.fields.reducedSelf,
            AWE_CHILLS: qids.awesf.fields.chills,
            AWE_ONENESS: qids.awesf.fields.oneness,
            AWE_GRAND: qids.awesf.fields.grand,
            AWE_DIMINISHED_SELF: qids.awesf.fields.diminishedSelf,
            AWE_TIME_SLOWING: qids.awesf.fields.timeSlowing,
            AWE_CONNECTED: qids.awesf.fields.awesfConnected,
            AWE_SMALL: qids.awesf.fields.small,
            AWE_VASTNESS: qids.awesf.fields.vastness,
            AWE_CHALLENGED: qids.awesf.fields.challenged,
            AWE_SELF_SHRINK: qids.awesf.fields.selfShrink,
            
            // Activity Level
            ACTIVITY_LEVEL: qids.activityLevel.field,
            
            // JSON dump field
            JSON_DUMP: qids.jsonDump.qid
        };
    }
    return QUESTION_IDS;
}

/**
 * Submit combined survey responses to Qualtrics API (all surveys in one submission)
 * @param {Object} combinedResponses - Object containing pre, post, and awesf survey data
 * @param {string} participantId - Optional participant ID from URL parameter
 * @returns {Promise<Object>} - Response from Qualtrics API
 */
export async function submitCombinedSurveyResponse(combinedResponses, participantId = null) {
    // Load config and get question IDs
    const config = await loadSurveyConfig();
    const qids = await getQuestionIds();
    const qualConfig = await getQualtricsConfig();
    
    const url = `${qualConfig.BASE_URL}/surveys/${qualConfig.SURVEY_ID}/responses`;
    
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
        const preFields = config.questionIds.pre.fields;
        console.log('📋 Including Pre-survey data in submission:', pre);
        if (pre.calm) values[preFields.calm] = toNumber(pre.calm);
        if (pre.energized) values[preFields.energized] = toNumber(pre.energized);
        if (pre.connected) values[preFields.connected] = toNumber(pre.connected);
        if (pre.nervous) values[preFields.nervous] = toNumber(pre.nervous);
        if (pre.focused) values[preFields.focused] = toNumber(pre.focused);
        if (pre.wonder) values[preFields.wonder] = toNumber(pre.wonder);
        console.log(`✅ Pre-survey values added: ${Object.keys(values).filter(k => k.startsWith(config.questionIds.pre.qid)).length} fields`);
    } else {
        console.warn('⚠️ Pre-survey data not found in combinedResponses - skipping pre-survey submission');
    }
    
    // Post-session PANAS
    if (combinedResponses.post) {
        const post = combinedResponses.post;
        const postFields = config.questionIds.post.fields;
        if (post.calm) values[postFields.calm] = toNumber(post.calm);
        if (post.energized) values[postFields.energized] = toNumber(post.energized);
        if (post.connected) values[postFields.connected] = toNumber(post.connected);
        if (post.nervous) values[postFields.nervous] = toNumber(post.nervous);
        if (post.focused) values[postFields.focused] = toNumber(post.focused);
        if (post.wonder) values[postFields.wonder] = toNumber(post.wonder);
    }
    
    // AWE-SF Scale
    if (combinedResponses.awesf) {
        const awesf = combinedResponses.awesf;
        const awesfFields = config.questionIds.awesf.fields;
        if (awesf.slowDown) values[awesfFields.slowDown] = toNumber(awesf.slowDown);
        if (awesf.reducedSelf) values[awesfFields.reducedSelf] = toNumber(awesf.reducedSelf);
        if (awesf.chills) values[awesfFields.chills] = toNumber(awesf.chills);
        if (awesf.oneness) values[awesfFields.oneness] = toNumber(awesf.oneness);
        if (awesf.grand) values[awesfFields.grand] = toNumber(awesf.grand);
        if (awesf.diminishedSelf) values[awesfFields.diminishedSelf] = toNumber(awesf.diminishedSelf);
        if (awesf.timeSlowing) values[awesfFields.timeSlowing] = toNumber(awesf.timeSlowing);
        if (awesf.awesfConnected) values[awesfFields.awesfConnected] = toNumber(awesf.awesfConnected);
        if (awesf.small) values[awesfFields.small] = toNumber(awesf.small);
        if (awesf.vastness) values[awesfFields.vastness] = toNumber(awesf.vastness);
        if (awesf.challenged) values[awesfFields.challenged] = toNumber(awesf.challenged);
        if (awesf.selfShrink) values[awesfFields.selfShrink] = toNumber(awesf.selfShrink);
    }
    
    // Activity Level (5-point scale)
    // Map UI values (1-5) to Qualtrics choice IDs using config
    if (combinedResponses.activityLevel) {
        const activityLevel = combinedResponses.activityLevel;
        if (activityLevel.activityLevel) {
            const uiValue = parseInt(activityLevel.activityLevel, 10);
            const qualtricsChoiceMap = config.choiceMappings.activityLevel.uiToQualtrics;
            const qualtricsValue = qualtricsChoiceMap[String(uiValue)];
            if (qualtricsValue) {
                values[config.questionIds.activityLevel.field] = qualtricsValue;
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
    // Choice 1: Feature Start Time (_N_1_TEXT)
    // Choice 2: Feature End Time (_N_2_TEXT)
    // Choice 3: Speed factor (_N_3_TEXT)
    // Choice 4: Volcano (_N_4_TEXT)
    // Choice 5: Frequency Min (_N_5_TEXT)
    // Choice 6: Frequency Max (_N_6_TEXT)
    // Choice 7: Notes (_N_7_TEXT)
    // Choice 8: Region number (_N_8_TEXT)
    // Choice 9: Impulsive or continuous (_N_9_TEXT)
    // Choice 10: Number of events in selected region (_N_10_TEXT)
    // Choice 11: Unique in 24 hour period? (_N_11_TEXT)
    // Choice 12: Region Start Time (_N_12_TEXT)
    // Choice 13: Region End Time (_N_13_TEXT)
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
                    
                    // Choice 1: Feature Start Time - Feature start time in UTC ISO format
                    if (feature.featureStartTime) {
                        values[`${rowPrefix}_1_TEXT`] = feature.featureStartTime;
                    }
                    
                    // Choice 2: Feature End Time - Feature end time in UTC ISO format
                    if (feature.featureEndTime) {
                        values[`${rowPrefix}_2_TEXT`] = feature.featureEndTime;
                    }
                    
                    // Choice 3: Speed factor - Playback speed when feature was created
                    if (feature.speedFactor !== null && feature.speedFactor !== undefined) {
                        values[`${rowPrefix}_3_TEXT`] = String(feature.speedFactor);
                    }
                    
                    // Choice 4: Volcano - Use volcano from region or UI
                    if (volcanoName) {
                        values[`${rowPrefix}_4_TEXT`] = volcanoName;
                    }
                    
                    // Choice 5: Frequency Min
                    if (feature.lowFreq !== null && feature.lowFreq !== undefined) {
                        values[`${rowPrefix}_5_TEXT`] = String(feature.lowFreq);
                    }
                    
                    // Choice 6: Frequency Max
                    if (feature.highFreq !== null && feature.highFreq !== undefined) {
                        values[`${rowPrefix}_6_TEXT`] = String(feature.highFreq);
                    }
                    
                    // Choice 7: Notes
                    if (feature.notes) {
                        values[`${rowPrefix}_7_TEXT`] = feature.notes;
                    }
                    
                    // Choice 8: Region number
                    if (regionNumber !== null) {
                        values[`${rowPrefix}_8_TEXT`] = String(regionNumber);
                    }
                    
                    // Choice 9: Impulsive or continuous (type)
                    if (feature.type) {
                        values[`${rowPrefix}_9_TEXT`] = feature.type;
                    }
                    
                    // Choice 10: Number of events in selected region
                    if (feature.numberOfEvents !== null && feature.numberOfEvents !== undefined) {
                        values[`${rowPrefix}_10_TEXT`] = String(feature.numberOfEvents);
                    }
                    
                    // Choice 11: Unique in 24 hour period? (repetition)
                    if (feature.repetition) {
                        values[`${rowPrefix}_11_TEXT`] = feature.repetition;
                    }
                    
                    // Choice 12: Region Start Time
                    if (regionStartTime) {
                        values[`${rowPrefix}_12_TEXT`] = regionStartTime;
                    }
                    
                    // Choice 13: Region End Time
                    if (regionEndTime) {
                        values[`${rowPrefix}_13_TEXT`] = regionEndTime;
                    }
                    
                    featureRowIndex++;
                });
            }
        });
        
        if (featureRowIndex > 1) {
            console.log(`📊 Submitted ${featureRowIndex - 1} feature(s) to QID8 matrix with all 13 fields`);
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
        
        // NOTE: We do NOT send to QID11 anymore - embedded data is reliable, text fields are not
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
            hasSessionTracking: !!values.SessionTracking,
            allFieldIds: Object.keys(values)
        });
        
        // Log the full payload to verify SessionTracking embedded data is included
        if (payload.values.SessionTracking) {
            console.log('📦 SessionTracking (embedded data) in payload:', {
                fieldName: 'SessionTracking',
                length: payload.values.SessionTracking.length,
                preview: payload.values.SessionTracking.substring(0, 150) + '...'
            });
        } else {
            console.warn('⚠️ SessionTracking embedded data NOT in payload values!');
        }
        
        const qualConfig = await getQualtricsConfig();
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'X-API-TOKEN': qualConfig.API_TOKEN,
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
    
    const qualConfig = await getQualtricsConfig();
    const url = `${qualConfig.BASE_URL}/surveys/${qualConfig.SURVEY_ID}/responses/${responseId}`;
    
    try {
        console.log('📥 Retrieving response from Qualtrics API:', {
            url,
            responseId
        });
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'X-API-TOKEN': qualConfig.API_TOKEN,
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
    const config = await loadSurveyConfig();
    const qualConfig = await getQualtricsConfig();
    const url = `${qualConfig.BASE_URL}/surveys/${qualConfig.SURVEY_ID}/responses`;
    
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
        const preFields = config.questionIds.pre.fields;
        if (responseData.calm) values[preFields.calm] = toNumber(responseData.calm);
        if (responseData.energized) values[preFields.energized] = toNumber(responseData.energized);
        if (responseData.connected) values[preFields.connected] = toNumber(responseData.connected);
        if (responseData.nervous) values[preFields.nervous] = toNumber(responseData.nervous);
        if (responseData.focused) values[preFields.focused] = toNumber(responseData.focused);
        if (responseData.wonder) values[preFields.wonder] = toNumber(responseData.wonder);
    } else if (responseData.surveyType === 'post') {
        // Post-session PANAS - convert strings to numbers
        const postFields = config.questionIds.post.fields;
        if (responseData.calm) values[postFields.calm] = toNumber(responseData.calm);
        if (responseData.energized) values[postFields.energized] = toNumber(responseData.energized);
        if (responseData.connected) values[postFields.connected] = toNumber(responseData.connected);
        if (responseData.nervous) values[postFields.nervous] = toNumber(responseData.nervous);
        if (responseData.focused) values[postFields.focused] = toNumber(responseData.focused);
        if (responseData.wonder) values[postFields.wonder] = toNumber(responseData.wonder);
    } else if (responseData.surveyType === 'awesf') {
        // AWE-SF Scale - convert strings to numbers
        const awesfFields = config.questionIds.awesf.fields;
        if (responseData.slowDown) values[awesfFields.slowDown] = toNumber(responseData.slowDown);
        if (responseData.reducedSelf) values[awesfFields.reducedSelf] = toNumber(responseData.reducedSelf);
        if (responseData.chills) values[awesfFields.chills] = toNumber(responseData.chills);
        if (responseData.oneness) values[awesfFields.oneness] = toNumber(responseData.oneness);
        if (responseData.grand) values[awesfFields.grand] = toNumber(responseData.grand);
        if (responseData.diminishedSelf) values[awesfFields.diminishedSelf] = toNumber(responseData.diminishedSelf);
        if (responseData.timeSlowing) values[awesfFields.timeSlowing] = toNumber(responseData.timeSlowing);
        if (responseData.awesfConnected) values[awesfFields.awesfConnected] = toNumber(responseData.awesfConnected);
        if (responseData.small) values[awesfFields.small] = toNumber(responseData.small);
        if (responseData.vastness) values[awesfFields.vastness] = toNumber(responseData.vastness);
        if (responseData.challenged) values[awesfFields.challenged] = toNumber(responseData.challenged);
        if (responseData.selfShrink) values[awesfFields.selfShrink] = toNumber(responseData.selfShrink);
    }
    
    // Add JSON dump if provided (for event data)
    if (responseData.jsonDump) {
        values[config.questionIds.jsonDump.qid] = JSON.stringify(responseData.jsonDump);
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
                'X-API-TOKEN': qualConfig.API_TOKEN,
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

