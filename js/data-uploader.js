/**
 * Data Uploader
 * Uploads EMIC study data to R2 via Cloudflare Worker API
 */

/**
 * Upload submission data to the EMIC R2 endpoint (emic-data bucket).
 * Endpoint: POST /api/emic/participants/{id}/submit
 * Used by both real study submissions (ui-controls.js) and simulate flow.
 * @param {string} participantId - The participant ID
 * @param {Object} submissionData - The submission payload
 * @returns {Promise<Object>} - Upload result
 */
export async function uploadEmicSubmission(participantId, submissionData) {
    if (!participantId) {
        console.warn('⚠️ EMIC upload: missing participantId');
        return { status: 'skipped', reason: 'no_participant_id' };
    }

    // Use current origin on production, otherwise hit production API directly (Worker handles CORS)
    const apiBase = window.location.hostname === 'spaceweather.now.audio'
        ? window.location.origin
        : 'https://spaceweather.now.audio';
    const endpoint = `${apiBase}/api/emic/participants/${encodeURIComponent(participantId)}/submit`;

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...submissionData,
                isSimulation: submissionData.isSimulation ?? false,
            }),
        });

        const result = await response.json();

        if (response.ok) {
            console.log('✅ EMIC submission uploaded to R2:', result);
            return { status: 'success', ...result };
        } else {
            console.error('❌ EMIC upload failed:', result);
            return { status: 'failed', error: result.error };
        }
    } catch (error) {
        console.error('❌ EMIC upload error (server may be unreachable):', error);
        return { status: 'failed', error: error.message };
    }
}

/**
 * Progressive sync: upload a snapshot of current participant state at each milestone.
 * Fire-and-forget — never blocks the participant's flow.
 * Each call creates a new timestamped file on the server, so the full timeline is preserved.
 * @param {string} participantId
 * @param {string} milestone - e.g. 'registered', 'welcome_closed', 'analysis_complete', 'questionnaire_background'
 */
export async function syncEmicProgress(participantId, milestone) {
    if (!participantId) return;
    try {
        const { getStandaloneFeatures } = await import('./feature-tracker.js');
        const { EMIC_FLAGS, getEmicFlag, getEmicFlagNumber } = await import('./emic-study-flags.js');

        const standalone = getStandaloneFeatures();
        const features = standalone.map((feat, i) => ({
            index: i,
            timeRange: { start: feat.startTime || '', end: feat.endTime || '' },
            freqRange: { low: feat.lowFreq || '', high: feat.highFreq || '' },
            notes: feat.notes || null,
            speedFactor: feat.speedFactor ?? null,
            drawnAt: feat.createdAt || ''
        }));

        const flags = {
            registered: getEmicFlag(EMIC_FLAGS.HAS_REGISTERED),
            closedWelcome: getEmicFlag(EMIC_FLAGS.HAS_CLOSED_WELCOME),
            featureCount: getEmicFlagNumber(EMIC_FLAGS.ACTIVE_FEATURE_COUNT),
            completedAnalysis: getEmicFlag(EMIC_FLAGS.HAS_COMPLETED_ANALYSIS),
            answered1Background: getEmicFlag(EMIC_FLAGS.ANSWERED_1_BACKGROUND),
            answered2DataAnalysis: getEmicFlag(EMIC_FLAGS.ANSWERED_2_DATA_ANALYSIS),
            answered3Musical: getEmicFlag(EMIC_FLAGS.ANSWERED_3_MUSICAL),
            answered4Feedback: getEmicFlag(EMIC_FLAGS.ANSWERED_4_FEEDBACK),
            answered5Learned: getEmicFlag(EMIC_FLAGS.ANSWERED_5_LEARNED),
        };

        await uploadEmicSubmission(participantId, {
            participantId,
            milestone,
            features,
            featureCount: features.length,
            flags,
            syncedAt: new Date().toISOString(),
            isProgressSync: true,
        });
        console.log(`📡 EMIC progress synced: ${milestone} (${features.length} features)`);
    } catch (e) {
        console.warn(`📡 EMIC progress sync failed (${milestone}):`, e.message);
    }
}

