/**
 * d1-test-harness.js — End-to-end test for D1 study API
 *
 * Browser: window.runD1Test()
 * Node:    node js/d1-test-harness.js
 */

const IS_NODE = typeof window === 'undefined';
const API_BASE = 'https://spaceweather.now.audio';
const STUDY_ID = 'emic-pilot';

// ── Helpers ──────────────────────────────────────────────────────────────────

function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

async function post(path, body) {
    const resp = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: resp.status, data: await resp.json() };
}

async function get(path) {
    const resp = await fetch(`${API_BASE}${path}`);
    return { status: resp.status, data: await resp.json() };
}

function ok(label, ms) { console.log(`  ✅ ${label} (${ms}ms)`); }
function fail(label, err) { console.log(`  ❌ ${label}: ${err}`); }

async function timed(label, fn) {
    const t0 = Date.now();
    try {
        const result = await fn();
        ok(label, Date.now() - t0);
        return result;
    } catch (e) {
        fail(label, e.message);
        return null;
    }
}

// ── Test Scenarios ───────────────────────────────────────────────────────────

async function runD1Test() {
    const pid = `test_participant_${Date.now()}`;
    let expectedResponses = 0;
    const t0 = Date.now();

    console.log(`\n🧪 D1 Test Harness — participant: ${pid}`);
    console.log('═'.repeat(55));

    // 1. Register participant
    console.log('\n📋 Step 1: Register participant');
    await timed('Register', async () => {
        const r = await post(`/api/study/${STUDY_ID}/participants`, { id: pid });
        if (!r.data.success) throw new Error(JSON.stringify(r.data));
    });

    // 2. Pre-survey (5 questions)
    console.log('\n📝 Step 2: Pre-survey (5 questions)');
    const preSurveyAnswers = [
        { questionId: 'background_music', answer: 4 },
        { questionId: 'background_science', answer: 2 },
        { questionId: 'data_analysis_exp', answer: 'Some experience with Excel and basic statistics' },
        { questionId: 'audio_analysis_exp', answer: 1 },
        { questionId: 'expectations', answer: 'I expect to learn how sonification can reveal patterns in space weather data' },
    ];
    for (const q of preSurveyAnswers) {
        await timed(`Pre-survey: ${q.questionId}`, () =>
            post(`/api/study/${STUDY_ID}/responses`, {
                id: uuid(), participant_id: pid, type: 'pre_survey',
                data: { questionId: q.questionId, answer: q.answer },
            })
        );
        expectedResponses++;
    }

    // 3. Draw 3 features
    console.log('\n🎨 Step 3: Draw 3 features');
    const features = [
        { type: 'emic_wave', lowFreq: 0.5, highFreq: 2.1, startTime: '2022-01-15T03:00:00Z', endTime: '2022-01-15T05:30:00Z', notes: 'Clear EMIC signature', speedFactor: 120 },
        { type: 'noise', lowFreq: 0.0, highFreq: 5.0, startTime: '2022-01-15T08:00:00Z', endTime: '2022-01-15T09:00:00Z', notes: 'Broadband noise burst', speedFactor: 60 },
        { type: 'pulsation', lowFreq: 1.2, highFreq: 3.8, startTime: '2022-01-15T12:00:00Z', endTime: '2022-01-15T14:00:00Z', notes: 'Pc1-2 pulsation', speedFactor: 90 },
    ];
    for (const f of features) {
        await timed(`Feature: ${f.type}`, () =>
            post(`/api/study/${STUDY_ID}/responses`, {
                id: uuid(), participant_id: pid, type: 'feature', data: f,
            })
        );
        expectedResponses++;
    }

    // 4. Update/resize one feature
    console.log('\n✏️  Step 4: Update feature');
    await timed('Feature update', () =>
        post(`/api/study/${STUDY_ID}/responses`, {
            id: uuid(), participant_id: pid, type: 'feature_update',
            data: { ...features[0], highFreq: 2.5, notes: 'Extended frequency range after re-listen' },
        })
    );
    expectedResponses++;

    // 5. Playback event
    console.log('\n🔊 Step 5: Playback event');
    await timed('Playback event', () =>
        post(`/api/study/${STUDY_ID}/responses`, {
            id: uuid(), participant_id: pid, type: 'playback_event',
            data: { action: 'play', startTime: '2022-01-15T03:00:00Z', duration: 45, speedFactor: 120 },
        })
    );
    expectedResponses++;

    // 6. Post-survey (5 questions)
    console.log('\n📝 Step 6: Post-survey (5 questions)');
    const postSurveyAnswers = [
        { questionId: 'difficulty', answer: 3 },
        { questionId: 'audio_helpful', answer: 5 },
        { questionId: 'patterns_noticed', answer: 'The EMIC waves were much clearer in the sonification than the spectrogram alone' },
        { questionId: 'improvements', answer: 'Would be nice to have A/B comparison with raw audio' },
        { questionId: 'recommend', answer: 4 },
    ];
    for (const q of postSurveyAnswers) {
        await timed(`Post-survey: ${q.questionId}`, () =>
            post(`/api/study/${STUDY_ID}/responses`, {
                id: uuid(), participant_id: pid, type: 'post_survey',
                data: { questionId: q.questionId, answer: q.answer },
            })
        );
        expectedResponses++;
    }

    // 7. Mark complete
    console.log('\n🏁 Step 7: Mark complete');
    await timed('Mark complete', () =>
        post(`/api/study/${STUDY_ID}/responses`, {
            id: uuid(), participant_id: pid, type: 'milestone',
            data: { event: 'completed', completedAt: new Date().toISOString() },
        })
    );
    expectedResponses++;

    // 8. Verify
    console.log('\n🔍 Step 8: Verify responses');
    await timed('Query & verify', async () => {
        const r = await get(`/api/study/${STUDY_ID}/responses?participant_id=${encodeURIComponent(pid)}&limit=100`);
        const count = r.data.responses?.length || 0;
        if (count === expectedResponses) {
            console.log(`    📊 Expected ${expectedResponses}, got ${count} — MATCH ✅`);
        } else {
            console.log(`    📊 Expected ${expectedResponses}, got ${count} — MISMATCH ❌`);
        }
    });

    const totalMs = Date.now() - t0;
    console.log('\n═'.repeat(55));
    console.log(`🏆 Total: ${totalMs}ms | ${expectedResponses} responses saved`);
    console.log(`🧹 Test participant: ${pid}\n`);

    return { pid, expectedResponses, totalMs };
}

// ── Entry points ─────────────────────────────────────────────────────────────

if (IS_NODE) {
    runD1Test().then(r => {
        process.exit(r ? 0 : 1);
    }).catch(e => {
        console.error('💥 Test failed:', e);
        process.exit(1);
    });
} else {
    window.runD1Test = runD1Test;
    console.log('🧪 D1 test harness loaded. Run: window.runD1Test()');
}
