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
    
    // JSON dump field (QID11) - for storing event data
    JSON_DUMP: "QID11"
};

/**
 * Submit a survey response to Qualtrics API
 * @param {Object} responseData - The survey response data
 * @param {string} participantId - Optional participant ID from URL parameter
 * @returns {Promise<Object>} - Response from Qualtrics API
 */
export async function submitSurveyResponse(responseData, participantId = null) {
    const url = `${QUALTRICS_CONFIG.BASE_URL}/surveys/${QUALTRICS_CONFIG.SURVEY_ID}/responses`;
    
    // Build the values object for Qualtrics API
    const values = {};
    
    // Map survey data to Qualtrics question IDs
    if (responseData.surveyType === 'pre') {
        // Pre-session PANAS
        if (responseData.calm) values[QUESTION_IDS.PRE_CALM] = responseData.calm;
        if (responseData.energized) values[QUESTION_IDS.PRE_ENERGIZED] = responseData.energized;
        if (responseData.connected) values[QUESTION_IDS.PRE_CONNECTED] = responseData.connected;
        if (responseData.nervous) values[QUESTION_IDS.PRE_NERVOUS] = responseData.nervous;
        if (responseData.focused) values[QUESTION_IDS.PRE_FOCUSED] = responseData.focused;
        if (responseData.wonder) values[QUESTION_IDS.PRE_WONDER] = responseData.wonder;
    } else if (responseData.surveyType === 'post') {
        // Post-session PANAS
        if (responseData.calm) values[QUESTION_IDS.POST_CALM] = responseData.calm;
        if (responseData.energized) values[QUESTION_IDS.POST_ENERGIZED] = responseData.energized;
        if (responseData.connected) values[QUESTION_IDS.POST_CONNECTED] = responseData.connected;
        if (responseData.nervous) values[QUESTION_IDS.POST_NERVOUS] = responseData.nervous;
        if (responseData.focused) values[QUESTION_IDS.POST_FOCUSED] = responseData.focused;
        if (responseData.wonder) values[QUESTION_IDS.POST_WONDER] = responseData.wonder;
    } else if (responseData.surveyType === 'awesf') {
        // AWE-SF Scale
        if (responseData.slowDown) values[QUESTION_IDS.AWE_SLOW_DOWN] = responseData.slowDown;
        if (responseData.reducedSelf) values[QUESTION_IDS.AWE_REDUCED_SELF] = responseData.reducedSelf;
        if (responseData.chills) values[QUESTION_IDS.AWE_CHILLS] = responseData.chills;
        if (responseData.oneness) values[QUESTION_IDS.AWE_ONENESS] = responseData.oneness;
        if (responseData.grand) values[QUESTION_IDS.AWE_GRAND] = responseData.grand;
        if (responseData.diminishedSelf) values[QUESTION_IDS.AWE_DIMINISHED_SELF] = responseData.diminishedSelf;
        if (responseData.timeSlowing) values[QUESTION_IDS.AWE_TIME_SLOWING] = responseData.timeSlowing;
        if (responseData.awesfConnected) values[QUESTION_IDS.AWE_CONNECTED] = responseData.awesfConnected;
        if (responseData.small) values[QUESTION_IDS.AWE_SMALL] = responseData.small;
        if (responseData.vastness) values[QUESTION_IDS.AWE_VASTNESS] = responseData.vastness;
        if (responseData.challenged) values[QUESTION_IDS.AWE_CHALLENGED] = responseData.challenged;
        if (responseData.selfShrink) values[QUESTION_IDS.AWE_SELF_SHRINK] = responseData.selfShrink;
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
    
    // Fall back to localStorage
    const storedId = localStorage.getItem('participantId');
    return storedId || null;
}

