# HS23 & HS16 — Data Viewer Response Rendering & Score Matching

## HS23: `[object Object]` Bug in Data Viewer

### Root Cause

The bug is a **data shape mismatch** between how responses are stored and how `formatResponseValue()` tries to render them.

**How responses are stored (D1):**

When a survey answer is saved via `saveSurveyAnswer()` in `js/d1-sync.js:256`, it wraps the answer in an envelope:

```js
saveResponse(type, {
    questionId,           // e.g. "experience_rating"
    question: questionText,
    questionType,         // "radio", "likert", etc.
    answer,               // the actual answer (varies by type)
    answered_at: "..."
});
```

The worker (`cloudflare-worker/src/index.js:1102`) stores this with:
```sql
UPDATE participants SET responses = json_set(responses, '$.questionId', json(envelope))
```

So `responses.experience_rating` = the **entire envelope object**, not the answer itself.

**Answer formats by question type** (set in `js/study-flow.js:2347-2365`):
- **Radio:** `answer = { value: "2", label: "Somewhat helpful" }`
- **Likert:** `answer = { "Row label 1": "3", "Row label 2": "5", ... }`
- **Free text:** `answer = "some text string"`

**What `formatResponseValue()` receives** (`data-viewer.html:1324`):

It receives the **envelope** object: `{ questionId, question, questionType, answer, answered_at }`.

The function checks:
1. `v.value != null && v.label` → ❌ envelope has no `.value` or `.label` at top level
2. `v.label` → ❌ no `.label`
3. `v.value != null` → ❌ no `.value`
4. `v.answer != null` → ✅ hits this: `return String(v.answer)`

For radio answers, `v.answer` = `{ value, label }`, so `String({ value, label })` = **`[object Object]`**.

For likert answers, `v.answer` = `{ "row1": "3", "row2": "5" }`, same result.

For free text, `v.answer` = a string, so it works fine (but still loses the question text context).

### Fix Location

**File:** `data-viewer.html`  
**Function:** `formatResponseValue()` at **line 1324**

### Proposed Fix

Replace the `formatResponseValue` function:

```js
function formatResponseValue(v) {
    if (v == null) return '—';
    if (typeof v === 'string') return v || '—';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return v.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(', ');
    if (typeof v === 'object') {
        // Response envelope from d1-sync: { questionId, question, questionType, answer, answered_at }
        if ('answer' in v && ('questionId' in v || 'questionType' in v)) {
            const a = v.answer;
            if (a == null) return '—';
            if (typeof a === 'string') return a || '—';
            if (typeof a === 'number') return String(a);
            // Radio: { value, label }
            if (a.value != null && a.label) return `${a.value} - ${a.label}`;
            if (a.label) return String(a.label);
            if (a.value != null) return String(a.value);
            // Likert: { "Row label": "column_value", ... }
            if (typeof a === 'object' && !Array.isArray(a)) {
                const entries = Object.entries(a).filter(([,val]) => val != null && val !== '');
                return entries.map(([k, val]) => `${k}: ${val}`).join(', ');
            }
            return String(a);
        }
        // Direct radio answer (legacy): { value, label }
        if (v.value != null && v.label) return `${v.value} - ${v.label}`;
        if (v.label) return String(v.label);
        if (v.value != null) return String(v.value);
        // Summarize object
        const entries = Object.entries(v).filter(([,val]) => val != null && val !== '');
        if (entries.length <= 3) return entries.map(([k,val]) => `${k}: ${truncate(String(val), 20)}`).join(', ');
        return entries.slice(0, 3).map(([k,val]) => `${k}: ${truncate(String(val), 20)}`).join(', ') + ' …';
    }
    return String(v);
}
```

Also, consider updating the `formatResponseKey` function to use the `question` field from the envelope for a better label:

In the `renderDetailRow` function (line ~1517), update the response rendering:
```js
${qaKeys.map(k => {
    const resp = responses[k];
    // Use stored question text if available
    const label = (resp && typeof resp === 'object' && resp.question) 
        ? resp.question 
        : formatResponseKey(k);
    return `<span class="q">${escHtml(label)}:</span><span class="a">${escHtml(truncate(formatResponseValue(resp), 80))}</span>`;
}).join('')}
```

### Complexity: ~30 min

Simple function replacement. The existing code structure is correct — just needs to unwrap the envelope before rendering.

---

## HS16: Score Matching (Participant × Processing Type × Time Period × Order)

### Available Data

**Per participant (D1 `participants` table):**
- `participant_id` — unique ID
- `assigned_condition` — integer (0-based condition index)
- `assigned_block` — block number
- `assignment_mode` — "walk" or "heal"
- `responses` — JSON containing `analysis_session` key

**The `analysis_session` response** (saved in `js/study-flow.js:1998`):
```js
saveResponse('analysis_session', {
    spacecraft, processing, session, startDate, endDate, dataset, ...
});
```

This stores the data config for each analysis section the participant experienced, including:
- **`processing`** — stretch algorithm / processing type
- **`spacecraft`** — data source
- **`startDate` / `endDate`** — time period
- **`session`** — analysis session number (1 or 2, i.e., order)

**Study config** (stored in `studies.config` JSON):
- `conditions` array — maps condition index to specific configurations
- Each condition defines which processing/dataset/order combo applies

**Features (D1 `features` table):**
- `analysis_session` — integer (1 or 2)
- `confidence` — "confirmed", "possibly", "unconfirmed"
- Per-feature metadata (time range, freq range, notes)

### What "Audio Score" Means

The participant's score = their feature annotations. The number of confirmed/possible features they identified, plus any questionnaire responses about the audio experience.

### Proposed Approach for Score Matching

The data is already linked — each participant has:
1. `assigned_condition` → maps to study config conditions (which define processing type)
2. `responses.analysis_session` → contains processing type, time period per session
3. Features → linked by `participant_id` + `analysis_session` (order = 1 or 2)

To build the matching table:

```js
// For each participant:
const condition = participant.assigned_condition;
const analysisInfo = responses.analysis_session; // { processing, startDate, endDate, session }
const features = await fetchFeatures(participant.participant_id);

// Group features by analysis_session (1 or 2)
const session1Features = features.filter(f => f.analysis_session === 1);
const session2Features = features.filter(f => f.analysis_session === 2);

// Result row:
{
    participant_id,
    condition,
    session_1: { processing: analysisInfo.processing, timeRange: '...', featureCount: session1Features.length, order: 1 },
    session_2: { processing: '...', timeRange: '...', featureCount: session2Features.length, order: 2 },
}
```

**Key gap:** The `analysis_session` response currently saves info for each analysis phase, but the response key format needs checking — it may save both sessions under the same key (overwriting) or use indexed keys. Check by examining actual stored data with:
```bash
curl -s "https://spaceweather.now.audio/api/study/SLUG/participants" | python3 -c "import sys,json; d=json.load(sys.stdin); [print(json.dumps(json.loads(p['responses']),indent=2)) for p in d['participants'][:2]]"
```

### Where to Implement

This is a data-viewer feature. Add a new export/view in `data-viewer.html` that:
1. For each participant, reads `assigned_condition` + `responses.analysis_session` + feature counts per session
2. Renders a summary table or exports CSV with columns: participant_id, condition, processing_type, time_period, order, feature_count, questionnaire_scores

### Complexity: ~1-2 hrs

Mostly data wrangling in the viewer. The data exists; it just needs to be assembled and presented.
