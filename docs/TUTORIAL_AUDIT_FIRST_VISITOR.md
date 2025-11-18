# Tutorial & Study Workflow Audit - First Visitor Experience

## Executive Summary

This document traces the complete promise chain and logical flow for a **first-time visitor** from page load to study completion, identifying potential breakpoints and issues.

---

## 🎯 Complete Flow Trace: First-Time Visitor

### Phase 1: Page Load & Initialization

**Entry Point:** `main.js` → `initializeStudyMode()`

1. **Page loads** → `main.js` executes
2. **Mode initialization** → `initializeMasterMode()` sets mode to `STUDY` or `STUDY_CLEAN`
3. **Study mode init** → `initializeStudyMode()` called
4. **Workflow start** → `startStudyWorkflow()` from `study-workflow.js`

**✅ Status:** No breakpoints identified

---

### Phase 2: Modal Sequence (First Visit Ever)

**Flow:** `startStudyWorkflow()` → Modal chain

#### Step 1: Participant Setup Modal
- **Trigger:** `openParticipantModal()` called immediately
- **User Action:** Enters participant ID, clicks submit
- **Next:** Modal closes → `markParticipantSetupAsSeen()` → Opens Welcome modal

**⚠️ Potential Breakpoint:** 
- If user closes modal without submitting → **STUCK** (modal prevents closing in study mode)
- **Mitigation:** Modal has click-outside prevention in study mode ✅

#### Step 2: Welcome Modal
- **Trigger:** Opened by participant modal submit handler
- **User Action:** Clicks "Begin" button
- **Next:** Modal closes → `markWelcomeAsSeen()` → Opens Pre-Survey modal

**⚠️ Potential Breakpoint:**
- Same as above - modal prevents closing without action ✅

#### Step 3: Pre-Survey Modal
- **Trigger:** Opened by welcome modal submit handler
- **User Action:** Completes survey, clicks submit
- **Next:** Modal closes → Opens Tutorial Intro modal

**⚠️ Potential Breakpoint:**
- Survey validation could block submission
- **Mitigation:** Need to verify survey validation logic

#### Step 4: Tutorial Intro Modal
- **Trigger:** Opened by pre-survey submit handler
- **User Action:** Clicks "Begin Tutorial" button
- **Next:** Modal closes → **Tutorial starts** (`runInitialTutorial()`)

**✅ Status:** Modal chain appears solid

---

### Phase 3: Tutorial Initialization

**Entry Point:** `tutorial-coordinator.js` → `runInitialTutorial()`

```javascript
runInitialTutorial() {
  1. Disable frequency scale dropdown ✅
  2. Disable Begin Analysis button (hard disable) ✅
  3. Enable region creation ✅
  4. Call showInitialFetchTutorial() → waits for data fetch
  5. After data fetch → call runMainTutorial()
}
```

**⚠️ Critical Breakpoint #1: Data Fetch Wait**

`showInitialFetchTutorial()`:
- Shows message: "Select a volcano and click Fetch Data"
- Sets up Enter key handler to trigger fetch
- **Waits indefinitely** for `State.completeSamplesArray` to have data
- Can be skipped with Enter key (sets tutorial phase for skipping)

**Potential Issues:**
1. If user never clicks "Fetch Data" → **STUCK** (but Enter key can skip)
2. If data fetch fails → **STUCK** (no error handling visible)
3. If `completeSamplesArray` never populates → **STUCK**

**Mitigation:** Enter key skip exists ✅

---

### Phase 4: Main Tutorial Sequence

**Entry Point:** `runMainTutorial()` - Sequential async/await chain

#### Tutorial Step 1: Well Done Message
```javascript
await showWellDoneMessage(); // 2s wait
```
- Shows "Success!" message
- 2 second skippable wait
- **✅ No breakpoints**

#### Tutorial Step 2: Volume Slider Tutorial
```javascript
await showVolumeSliderTutorial(); // 5s wait
```
- Adds glow to volume slider
- Shows message about volume
- 5 second skippable wait
- **✅ No breakpoints**

#### Tutorial Step 3: Volcano Message
```javascript
await showVolcanoMessage(); // 5s wait
```
- Shows volcano-specific message
- 5 second skippable wait
- **✅ No breakpoints**

#### Tutorial Step 4: Station Metadata Message
```javascript
await showStationMetadataMessage(); // 7s wait
```
- Shows station distance/component info
- 7 second skippable wait
- **⚠️ Potential Breakpoint:** If no station selected, function returns early (skips)
- **Impact:** Minor - tutorial continues

#### Tutorial Step 5: Pause Button Tutorial
```javascript
await runPauseButtonTutorial(); // User interaction required
```
- Wraps `startPauseButtonTutorial()` in promise
- Waits for user to pause playback
- Waits for user to resume playback
- **⚠️ Critical Breakpoint #2:** If playback never starts → **STUCK**
- **Mitigation:** Enter key can skip ✅

**Flow:**
1. Shows "Press space bar or pause button" message
2. After 4s, appends "Try it now" if still playing
3. Waits for `PlaybackState.PAUSED`
4. Shows "Now press again to start again"
5. Waits for `PlaybackState.PLAYING`
6. Shows "Great!"

**Potential Issues:**
- If audio never starts playing → pause detection never triggers
- If user pauses but never resumes → **STUCK** (but Enter can skip)

#### Tutorial Step 6: Spectrogram Explanation
```javascript
await showSpectrogramExplanation(); // Multiple timed waits
```
- Multiple messages with skippable waits
- Total ~28 seconds of waits
- **✅ No breakpoints** (all skippable)

#### Tutorial Step 7: Speed Slider Tutorial
```javascript
await runSpeedSliderTutorial(); // Complex user interaction
```
- **⚠️ Critical Breakpoint #3:** Complex interaction chain

**Flow:**
1. Shows "Drag the playback speed slider" message
2. Waits for slider interaction (detects when user starts dragging)
3. Waits for direction detection (faster/slower)
4. Shows frequency message based on direction
5. Waits 4s, then shows "try other way"
6. Waits for threshold cross (crossing 1x speed going other direction)
   - **10 second timeout** if they don't cross
7. Shows "Great!"
8. Waits 2s, shows opposite direction message
9. Waits 6s, removes glow, adds glow to speed label
10. Shows "Click on GLOWING text to reset"
11. Waits for click on speed label
12. Resets speed, shows "The playback speed has been reset"
13. Waits 2s

**Potential Issues:**
- If user never interacts with slider → **STUCK** (but Enter can skip)
- If direction detection fails → **STUCK** (but Enter can skip)
- If threshold cross detection fails → **STUCK** (10s timeout helps)
- If user never clicks speed label → **STUCK** (but Enter can skip)

**Mitigation:** Enter key skip exists ✅

#### Tutorial Step 8: Selection Tutorial
```javascript
await runSelectionTutorial(); // User interaction required
```
- **⚠️ Critical Breakpoint #4:** Multiple user interactions

**Flow:**
1. Sets up `waitForWaveformClick()` promise FIRST (before showing message)
2. Calls `enableWaveformTutorial()` - shows message and enables clicks
3. Waits for waveform click
4. Waits 5s after click
5. Shows "Now click and DRAG and RELEASE to make a selection"
6. Sets up `waitForSelection()` promise
7. Races between 10s timeout and selection completion
8. If timeout wins AND no selection → appends "Just click and draaaaag"
9. Waits for selection to complete

**Potential Issues:**
- If user never clicks waveform → **STUCK** (but Enter can skip)
- If user clicks but never drags → **STUCK** (10s timeout helps, then Enter can skip)
- Race condition: If selection happens during 5s wait → handled ✅

**Mitigation:** Enter key skip exists ✅

#### Tutorial Step 9: Region Introduction
```javascript
await runRegionIntroduction(); // User interaction required
```
- **⚠️ Critical Breakpoint #5:** Region creation required

**Flow:**
1. Checks if region already exists → if yes, skips message
2. Shows "Click Add Region or type (R) to create a new region"
3. Waits for `waitForRegionCreation()` (R key or Add Region button)
4. Shows "You just created your first region!"
5. Waits 2s
6. Disables all region buttons
7. Adds glow to regions panel
8. Shows "When a new region is created, it gets added down below"
9. Waits 6s
10. Removes glow, enables play button for region 1
11. Shows "Press the red play button for region 1"
12. Waits for `waitForRegionPlayClick()`
13. Waits 2s

**Potential Issues:**
- If user never creates region → **STUCK** (but Enter can skip)
- If user never clicks play button → **STUCK** (but Enter can skip)
- **Region creation must be enabled** - checked at start ✅

**Mitigation:** Enter key skip exists ✅

#### Tutorial Step 10: Region Zooming Tutorial
```javascript
await runRegionZoomingTutorial(); // User interaction required
```
- **⚠️ Critical Breakpoint #6:** Multiple interactions

**Flow:**
1. Adds loading indicator
2. Shows "Click the magnifier 🔍 to ZOOM IN"
3. Enables zoom button for region 1
4. Waits for `waitForRegionZoom()` (ESC or zoom button)
5. Removes loading indicator
6. Waits 1s, shows "The spectrogram now shows more detail"
7. Waits 6s
8. Enables loop button
9. Adds glow to loop button
10. Shows "This is the loop button"
11. Waits 3s OR if clicked early, skips to "Loop is now enabled"
12. Shows "Try clicking it now to enable looping"
13. Waits for `waitForLoopButtonClick()`
14. Waits 1s, shows "Loop is now enabled"
15. Waits 2s
16. Removes glow
17. Shows "Press the (space bar) to play this region from the beginning"
18. Waits for `waitForRegionPlayOrResume()` (spacebar, resume button, or region play)
19. Shows "Feel free to play and pause as you wish"
20. Waits 4s

**Potential Issues:**
- If user never zooms → **STUCK** (but Enter can skip)
- If user never clicks loop → **STUCK** (but Enter can skip)
- If user never plays region → **STUCK** (but Enter can skip)

**Mitigation:** Enter key skip exists ✅

#### Tutorial Step 11: Frequency Scale Tutorial
```javascript
await runFrequencyScaleTutorial(); // User interaction required
```
- **⚠️ Critical Breakpoint #7:** Multiple interactions

**Flow:**
1. Enables frequency scale dropdown
2. Adds glow
3. Waits 2s
4. Shows "Changing the frequency scaling..."
5. Waits 5s
6. Shows "Try changing to another frequency scale"
7. Waits for `waitForFrequencyScaleClick()` (dropdown click)
8. Removes glow
9. Waits for `waitForFrequencyScaleChange()` (dropdown change)
10. Waits 1s, shows "Great!"
11. Waits 2s
12. Shows "You can also press (C) (V) and (B)..."
13. Waits for `waitForFrequencyScaleKeys()` (2 key presses OR 8s timeout)
14. Waits 2s
15. Shows "Pick a scaling that works well"
16. Waits 6s
17. **Calls `runFeatureSelectionTutorial()`** (continues chain)

**Potential Issues:**
- If user never clicks dropdown → **STUCK** (but Enter can skip)
- If user never changes scale → **STUCK** (but Enter can skip)
- If user never presses keys → **STUCK** (8s timeout helps, then Enter can skip)

**Mitigation:** Enter key skip exists ✅

#### Tutorial Step 12: Feature Selection Tutorial
```javascript
await runFeatureSelectionTutorial(); // Complex interaction chain
```
- **⚠️ Critical Breakpoint #8:** Most complex section

**Prerequisites:**
- Must be zoomed into a region ✅
- Must have active region ✅
- Must have at least one feature ✅

**Flow:**
1. Checks if zoomed in → if not, warns and returns
2. Gets active region index → if null, warns and returns
3. Gets region features → if none, warns and returns
4. Disables add feature button
5. Shows "Have a look and listen around this region..."
6. Waits 8s
7. Shows "Click anywhere on the waveform and create new selections"
8. Waits 5s
9. Shows "Feel free to change the playback speed!"
10. Waits 10s
11. Shows "Once you've found something interesting..."
12. Waits 3s
13. Enables select feature button (makes it red/active)
14. Starts frequency selection mode
15. Adds spectrogram glow
16. Shows "Click and drag on the spectrogram to create a box"
17. Sets up 15s timeout for "Click and drag" append message
18. Waits for `waitForFeatureSelection()` (box drawn on spectrogram)
19. Removes glow
20. Shows "You've identified a feature!"
21. Waits 3s
22. Shows "Add any notes in the description box..."
23. Waits 8s
24. Shows "There are no right or wrong answers..."
25. Waits 8s
26. Shows "You can start typing now..."
27. Waits 4s
28. Shows "When you are done, you can hit enter/return"
29. Sets up listener to switch message when typing starts
30. Waits 10s
31. Waits for `waitForFeatureDescription()` (change/blur event OR 10s timeout)
32. Waits 1s
33. Adds glow to repetition dropdown
34. Shows "Click the drop down menu on the far left..."
35. Races between `waitForRepetitionDropdown()` and 15s timeout
36. If clicked, waits 5s
37. Removes repetition glow
38. Adds glow to type dropdown
39. Shows "Impulsive events are short..."
40. Races between `waitForTypeDropdown()` and 15s timeout
41. If clicked, waits 5s
42. Removes type glow
43. Adds glow to select feature button
44. Shows "Click this box to re-do your selection"
45. Waits 9s
46. Removes select feature glow
47. Enables add feature button
48. Waits 100ms
49. Adds glow to add feature button
50. Shows "Click the green circle 🟢..."
51. Waits for `waitForAddFeatureButtonClick()`
52. Removes glow
53. Shows "Great! There's no need to select another feature now"
54. Waits 4s
55. **Calls `runZoomOutTutorial()`** (continues chain)

**Potential Issues:**
- If not zoomed in → **BREAKS** (returns early, tutorial stops)
- If no active region → **BREAKS** (returns early, tutorial stops)
- If no features → **BREAKS** (returns early, tutorial stops)
- If user never draws box → **STUCK** (but Enter can skip)
- If user never types description → **STUCK** (10s timeout helps, then Enter can skip)
- If user never clicks repetition dropdown → **STUCK** (15s timeout helps, then Enter can skip)
- If user never clicks type dropdown → **STUCK** (15s timeout helps, then Enter can skip)
- If user never clicks add feature button → **STUCK** (but Enter can skip)

**⚠️ CRITICAL:** If prerequisites not met, tutorial **STOPS** (no error recovery)

**Mitigation:** Enter key skip exists for waits ✅, but **no recovery** if prerequisites fail

#### Tutorial Step 13: Zoom Out Tutorial
```javascript
await runZoomOutTutorial(); // User interaction required
```
- **Prerequisites:** Must be zoomed into a region ✅

**Flow:**
1. Checks if zoomed in → if not, warns and returns
2. Shows "Let's return to the full-day view by pressing ESC..."
3. Waits for `waitForZoomOut()` (ESC or return arrow)
4. Enables all region buttons
5. Waits 2s
6. Shows "Those are the basics!"
7. Waits 2s
8. Shows "Using hotkeys will help you move around quickly!"
9. Waits 5s
10. **Calls `runSecondRegionTutorial()`** (continues chain)

**Potential Issues:**
- If not zoomed in → **BREAKS** (returns early, tutorial stops)
- If user never zooms out → **STUCK** (but Enter can skip)

**⚠️ CRITICAL:** If not zoomed in, tutorial **STOPS**

#### Tutorial Step 14: Second Region Tutorial
```javascript
await runSecondRegionTutorial(); // User interaction required
```
- **Flow:**
1. Shows "Click and drag and let's create a new region"
2. Waits for `waitForRegionCreation()`
3. Shows "Great!"
4. Waits 2s
5. Gets second region index (should be 1)
6. Shows "To zoom in on this second region, just press (2)"
7. Waits for `waitForNumberKeyPress('2')` (to zoom)
8. Waits 1s
9. Shows "Now press 2 again to play this region"
10. Waits for `waitForNumberKeyPress('2')` (to play)
11. Shows "Excellent! Now press 1 to jump to our first region"
12. Waits for `waitForNumberKeyPress('1')` (to jump)
13. Waits 1s
14. Shows "And now press 1 to play back this region"
15. Waits for `waitForNumberKeyPress('1')` (to play)
16. Waits 2s
17. Shows "Great! Now hit escape to jump back to the main screen"
18. Waits for `waitForZoomOut()` (ESC)
19. Waits 1s
20. Shows "This Tutorial is now complete! Continue your analysis..."
21. **Enables all features** (`enableAllTutorialRestrictedFeatures()`)
22. Waits 5s
23. Shows "Have fun exploring! There's no minimum or maximum..."
24. Waits 5s

**Potential Issues:**
- If user never creates second region → **STUCK** (but Enter can skip)
- If user never presses 2 → **STUCK** (but Enter can skip)
- If user never presses 1 → **STUCK** (but Enter can skip)
- If user never presses ESC → **STUCK** (but Enter can skip)

**Mitigation:** Enter key skip exists ✅

#### Tutorial Step 15: Begin Analysis Tutorial
```javascript
await runBeginAnalysisTutorial(); // Final step - transitions to analysis
```
- **Flow:**
1. Shows "For your weekly sessions you will begin by selecting one volcano..."
2. Waits 6s
3. Sets status text align to center
4. Shows "Click Begin Analysis now to end the tutorial ↘️"
5. Waits 2.5s
6. Fades in Begin Analysis button (sets display, enables, sets opacity)
7. Waits for `waitForBeginAnalysisClick()`
8. Resets text alignment
9. **Tutorial complete** - user transitions to analysis mode

**Potential Issues:**
- If Begin Analysis button not found → **STUCK** (but Enter can skip)
- If user never clicks button → **STUCK** (but Enter can skip)

**⚠️ CRITICAL:** After this step, `beginAnalysisConfirmed` event fires, which:
- Disables volcano switching ✅
- Enables region creation ✅
- Transforms Begin Analysis button to Complete button ✅

**Mitigation:** Enter key skip exists ✅

---

## 🔍 Promise Chain Analysis

### Overall Structure

The tutorial uses a **linear async/await chain** in `runMainTutorial()`:

```javascript
await showWellDoneMessage();
await showVolumeSliderTutorial();
await showVolcanoMessage();
await showStationMetadataMessage();
await runPauseButtonTutorial();
await showSpectrogramExplanation();
await runSpeedSliderTutorial();
await runSelectionTutorial();
await runRegionIntroduction();
await runRegionZoomingTutorial();
await runFrequencyScaleTutorial(); // → calls runFeatureSelectionTutorial()
await runBeginAnalysisTutorial();
```

**✅ Strengths:**
- Clean, linear flow
- Easy to reorder sections
- Each section is independent

**⚠️ Weaknesses:**
- No error recovery if a section fails
- No way to resume from a specific point
- If any section throws unhandled error → **ENTIRE TUTORIAL STOPS**

### Promise Resolution Mechanisms

Each user interaction uses a promise pattern:

1. **State-based promises:** Set flags in `State`, resolve when action detected
2. **Event listeners:** Attach listeners, resolve on event
3. **Polling:** Check state periodically, resolve when condition met
4. **Timeouts:** Race promises with timeouts for user guidance

**✅ Strengths:**
- Enter key skip exists for most waits
- Timeouts prevent infinite waits
- Multiple resolution paths (e.g., spacebar OR resume button OR region play)

**⚠️ Weaknesses:**
- Some promises have no timeout (e.g., `waitForDataFetch()`)
- Error handling inconsistent
- If state flags get stuck → **STUCK**

---

## 🚨 Critical Breakpoints Summary

### Total Breakpoints Identified: 8

1. **Data Fetch Wait** (`showInitialFetchTutorial`)
   - **Risk:** Medium
   - **Mitigation:** Enter key skip ✅
   - **Issue:** No error handling if fetch fails

2. **Pause Button Tutorial** (`runPauseButtonTutorial`)
   - **Risk:** Medium
   - **Mitigation:** Enter key skip ✅
   - **Issue:** Requires playback to be active

3. **Speed Slider Tutorial** (`runSpeedSliderTutorial`)
   - **Risk:** Medium
   - **Mitigation:** Enter key skip ✅, 10s timeout ✅
   - **Issue:** Complex interaction chain

4. **Selection Tutorial** (`runSelectionTutorial`)
   - **Risk:** Medium
   - **Mitigation:** Enter key skip ✅, 10s timeout ✅
   - **Issue:** Requires waveform interaction

5. **Region Introduction** (`runRegionIntroduction`)
   - **Risk:** Medium
   - **Mitigation:** Enter key skip ✅
   - **Issue:** Requires region creation

6. **Region Zooming Tutorial** (`runRegionZoomingTutorial`)
   - **Risk:** Medium
   - **Mitigation:** Enter key skip ✅
   - **Issue:** Multiple interactions required

7. **Frequency Scale Tutorial** (`runFrequencyScaleTutorial`)
   - **Risk:** Medium
   - **Mitigation:** Enter key skip ✅, 8s timeout ✅
   - **Issue:** Multiple interactions required

8. **Feature Selection Tutorial** (`runFeatureSelectionTutorial`)
   - **Risk:** **HIGH** ⚠️
   - **Mitigation:** Enter key skip ✅, timeouts ✅
   - **Issue:** **PREREQUISITES MUST BE MET** - if not, tutorial **STOPS**
   - **Prerequisites:**
     - Must be zoomed into a region
     - Must have active region
     - Must have at least one feature

### Additional Breakpoints

9. **Zoom Out Tutorial** (`runZoomOutTutorial`)
   - **Risk:** **HIGH** ⚠️
   - **Issue:** **PREREQUISITE MUST BE MET** - if not zoomed in, tutorial **STOPS**

---

## ✅ What Works Well

1. **Enter Key Skip:** Almost all waits can be skipped with Enter key
2. **Timeouts:** Most user interactions have timeouts
3. **Multiple Resolution Paths:** Many actions can be completed multiple ways
4. **State Checks:** Tutorial checks if user already completed actions
5. **Linear Flow:** Easy to follow and debug

---

## ⚠️ Potential Issues

### Issue 1: Prerequisite Failures
**Problem:** `runFeatureSelectionTutorial()` and `runZoomOutTutorial()` return early if prerequisites not met, **stopping the tutorial**.

**Impact:** User gets stuck, no error message, no recovery path.

**Recommendation:** Add error recovery or ensure prerequisites are always met before calling these functions.

### Issue 2: No Error Handling
**Problem:** If any tutorial section throws an unhandled error, the entire tutorial stops.

**Impact:** User gets stuck with no indication of what went wrong.

**Recommendation:** Add try/catch blocks with error recovery.

### Issue 3: State Flag Stuck
**Problem:** If a state flag (e.g., `waitingForRegionCreation`) gets stuck `true`, the promise never resolves.

**Impact:** User gets stuck waiting for an action that can't complete.

**Recommendation:** Add cleanup/reset mechanisms for state flags.

### Issue 4: Data Fetch Failure
**Problem:** `waitForDataFetch()` has no error handling if fetch fails.

**Impact:** User gets stuck waiting for data that never arrives.

**Recommendation:** Add timeout and error handling to data fetch wait.

### Issue 5: Begin Analysis Button State
**Problem:** Begin Analysis button is hard-disabled at tutorial start, but enabled during `runBeginAnalysisTutorial()`. If button not found or state inconsistent, user stuck.

**Impact:** User can't complete tutorial.

**Recommendation:** Add checks and fallbacks for button state.

---

## 🎯 Recommendations

### High Priority

1. **Add error recovery for prerequisite failures**
   - Check prerequisites before calling `runFeatureSelectionTutorial()` and `runZoomOutTutorial()`
   - Add fallback messages if prerequisites not met
   - Or ensure prerequisites are always met before calling

2. **Add try/catch error handling**
   - Wrap each tutorial section in try/catch
   - Log errors and provide user feedback
   - Allow tutorial to continue or skip problematic sections

3. **Add timeout to data fetch wait**
   - Add maximum wait time (e.g., 60 seconds)
   - Show error message if timeout reached
   - Allow user to skip and continue

### Medium Priority

4. **Add state flag cleanup**
   - Reset all state flags at tutorial start
   - Add cleanup function called on tutorial end/error
   - Prevent stuck flags

5. **Add button state validation**
   - Check if Begin Analysis button exists before using
   - Validate button state before enabling/disabling
   - Add fallback if button not found

### Low Priority

6. **Add progress indicator**
   - Show tutorial progress (e.g., "Step 5 of 15")
   - Help users understand how much is left

7. **Add tutorial resume capability**
   - Allow users to resume from last completed step
   - Store progress in localStorage

---

## 📊 Overall Assessment

### Will It Work for a First-Time Visitor?

**YES, with caveats:**

✅ **Strengths:**
- Comprehensive tutorial covering all features
- Enter key skip provides escape hatch
- Timeouts prevent infinite waits
- Multiple resolution paths for actions

⚠️ **Weaknesses:**
- Prerequisite failures can stop tutorial
- No error recovery
- Complex interaction chains may confuse users
- No progress indication

### Breakpoint Risk Level: **MEDIUM**

Most breakpoints have mitigations (Enter key skip, timeouts), but **prerequisite failures** are a **HIGH RISK** issue that could stop the tutorial entirely.

---

## 🔧 Testing Recommendations

1. **Test prerequisite failures:**
   - Start tutorial without zooming into region
   - Start tutorial without creating region
   - Verify tutorial handles gracefully

2. **Test error scenarios:**
   - Simulate data fetch failure
   - Simulate state flag stuck
   - Verify error handling works

3. **Test user skipping:**
   - Skip every step with Enter key
   - Verify tutorial completes successfully
   - Verify all features enabled at end

4. **Test edge cases:**
   - User completes actions before tutorial asks
   - User closes browser mid-tutorial
   - User refreshes page mid-tutorial

---

## 📝 Conclusion

The tutorial system is **well-designed** with good escape hatches (Enter key skip, timeouts), but has **critical weaknesses** around prerequisite handling and error recovery. For a first-time visitor, the tutorial **should work** in most cases, but **may break** if prerequisites aren't met or errors occur.

**Recommendation:** Address prerequisite failures and add error handling before production deployment.



