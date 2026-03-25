# HS3.2 — Verify Correct Analysis Order Based on Condition

> **SHIP_IT.md:** Double ensure analysis tasks appear in correct order based on condition, and correct stretch mode

---

## Context: Existing Pipeline

The condition assignment system works:
- `assignCondition()` in `study-flow.js` handles server-side assignment
- `_assignedProcessing` applied per step from condition config
- Steps are reordered based on condition's presentation order
- `PROCESSING_MAP` (line 158): `{ resample: 'resample', paulStretch: 'paul', wavelet: 'wavelet' }`

### How Condition Order Works
- Each condition in the study config defines a presentation order (e.g., `[0, 1]` or `[1, 0]`)
- `study-flow.js` swaps analysis steps based on this order at line ~302
- `step1._assignedProcessing` and `step2._assignedProcessing` are set from the condition config

## What This Task Is

This is a **manual verification task**, not a code task. Need to:

1. Start a test session with multiple conditions defined
2. Run through as different participants, verifying:
   - Condition 0: analysis steps in order [A, B] with correct processing
   - Condition 1: analysis steps in order [B, A] with correct processing
3. Check console logs for `[ASSIGN]` messages confirming condition + order
4. Verify `window.__currentAnalysisSession` is correct (1 or 2)
5. Verify `switchStretchAlgorithm()` is called with the right algorithm for each step

## How to Test

```bash
# Open with test mode + reset for fresh participant each time
# Tab 1: study.html?study=SLUG&mode=test&reset
# Tab 2: study.html?study=SLUG&mode=test&reset
# Tab 3: study.html?study=SLUG&mode=test&reset
# Each should get different conditions via block assignment
```

Check in console:
- `[ASSIGN] ✅ Condition #N` — which condition?
- Processing algorithm applied per step
- Step order matches condition definition

## Complexity

~30 min of manual testing with different conditions.
