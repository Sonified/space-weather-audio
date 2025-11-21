# UX Status Data Structure

This is what we're collecting about each user session. Plain and simple.

---

## The 9 Core Workflow Flags

These live in localStorage and drive the app's state machine. They're the master controls from `user_metadata_config.html`.

- **👤 ONBOARDING**

  - `study_has_seen_participant_setup` - Has user completed participant ID setup? (once ever)
  - `study_has_seen_welcome` - Has user seen welcome modal? (once ever)
  - `study_tutorial_in_progress` - User clicked "Begin Tutorial" but hasn't finished
  - `study_tutorial_completed` - Tutorial fully completed (Begin Analysis clicked)
- **⚡ CURRENT SESSION**

  - `study_has_seen_welcome_back` - Has user seen "welcome back" this session?
  - `study_pre_survey_completion_date` - Date when pre-survey was completed (YYYY-MM-DD)
  - `study_begin_analysis_clicked_this_session` - User clicked "Begin Analysis" this session (clears each session)
- **📅 SESSION COMPLETION**

  - `study_session_completion_tracker` - Which specific sessions are complete:
    - week1: [session1 done?, session2 done?]
    - week2: [session1 done?, session2 done?]
    - week3: [session1 done?, session2 done?]
- **⏰ SESSION TIMEOUT**

  - `study_session_timed_out` - Did this session end due to 20 minutes of inactivity? (triggers auto-submit and redirect)

---

## Session Sections

- **PRE-STUDY** - Surveys before the user starts analyzing

  - PRE-SURVEY
    - `shown` - When did the survey appear? (timestamp)
    - `started` - When did they start filling it out? (timestamp)
    - `completed` - When did they finish it? (timestamp)
    - `duration` - How long did it take? (milliseconds)
    - `status` - What's the status? (not-started, in-progress, completed, skipped)
- **TUTORIAL (W1S1 ONLY)** - Complete onboarding experience for first-time users

  - TUTORIAL MODAL

    - `tutorialModalShown` - Each time the modal is shown (can be reopened, array of timestamps)
    - `tutorialBeginClicked` - When did they click "Begin Analysis"? (timestamp)

  - TUTORIAL PROGRESS (timestamps = completed, null = not done)

    - `playback_started` - Started playing audio
    - `volume_clicked` - Clicked the volume knob after being prompted
    - `playback_stopped` - Stopped audio (space or stop button)
    - `speed_slider_clicked` - Clicked the speed slider
    - `waveform_clicked` - Clicked on the waveform
    - `waveform_clicked_and_dragged` - Clicked and dragged on waveform
    - `region_created` - Drew their first region
    - `enabled_loop` - Enabled loop playback
    - `frequency_scale_clicked` - Clicked frequency scale
    - `frequency_scale_selected` - Changed frequency scale (any time they change it)
    - `feature_created` - Created/tagged their first feature
    - `zoomed_back_out` - Zoomed back out after being prompted
    - `second_feature_created` - Created a second feature
    - `used_number_to_switch_features` - Used number key to switch between features

  - FIRST ANALYSIS (out of guided section, doing real work)

    - `volcano_selected` - Which volcano did they pick? (volcano name, timestamp)
    - `region_created` - They drew a region (region ID, timestamp)
    - `feature_identified` - They tagged a feature (feature ID, feature type, timestamp)
  
  - TUTORIAL COMPLETE

    - `tutorialCompleted` - When did they complete ALL of W1S1 including surveys? (timestamp)
    - `tutorialDuration` - How long did the whole tutorial take? (milliseconds)

- **EXPLORATION (W1S2+ ONLY)** - Returning users exploring the interface before analysis

  - `volcano_changed` - They switched to a different volcano (which one?, when?)
  - `data_fetched` - They started playing audio (when?)

- **ANALYSIS SESSION (ALL SESSIONS)** - The actual work - creating regions and

  - VOLCANO SELECTION

    - `selectedVolcano` - Which volcano are they analyzing?

  - REGIONS & FEATURES
    - `region_created` - They drew a region (timestamp)
    - 'zoomed_to_region' - which number? Record number and timestamp
    - 'zoomed_out' - zoomed back out to the full waveform. 
    - `feature_identified` - They tagged a feature (include all the metadata associated with this feature)

    -Note: each time the playback speed changes we want to record that, but not a float as it's dragged, that would spam, just the final speed they end up on after dragging or clicking to a new spot, so record on mouse up. 

- **POST-STUDY** - Surveys after the user completes their analysis

  - ACTIVITY LEVEL SURVEY

    - `shown` - When did the survey appear? (timestamp)
    - `started` - When did they start filling it out? (timestamp)
    - `completed` - When did they finish it? (timestamp)
    - `duration` - How long did it take? (milliseconds)
    - `status` - What's the status? (not-started, in-progress, completed, skipped)
  - AWE-SF SURVEY (first session of each week only)

    - `shown` - When did the survey appear? (timestamp)
    - `started` - When did they start filling it out? (timestamp)
    - `completed` - When did they finish it? (timestamp)
    - `duration` - How long did it take? (milliseconds)
    - `status` - What's the status? (not-started, in-progress, completed, skipped)
  - POST SURVEY

    - `shown` - When did the survey appear? (timestamp)
    - `started` - When did they start filling it out? (timestamp)
    - `completed` - When did they finish it? (timestamp)
    - `duration` - How long did it take? (milliseconds)
    - `status` - What's the status? (not-started, in-progress, completed, skipped)

---

## Session Context

- **METADATA**

  - `participantId` - Their Qualtrics ID (R_xxx)
  - `sessionId` - Unique ID for this session
  - `version` - Version of the ux-status system
  - `generatedAt` - When this data was created
- **WHO THEY ARE**

  - `isFirstVisitEver` - Is this W1S1? (their very first time)
  - `isReturningUser` - Have they completed W1S1 already?
  - `sessionNumber` - How many total sessions have they started? (counts up forever)
  - `weekNumber` - What week is this? (1, 2, or 3)
  - `sessionCountThisWeek` - How many sessions have they done this week?
- **SESSION TRACKING**

  - `weekStartDate` - When did this week start? (YYYY-MM-DD)
  - `previousSessionsCompleted` - Which sessions are done? (week1: [bool, bool], week2: [bool, bool], week3: [bool, bool])
- **CUMULATIVE STATS (ALL TIME)**

  - `totalSessionsStarted` - Total sessions they've ever started
  - `totalSessionsCompleted` - Total sessions they've ever completed
  - `totalSessionTime` - Total time in milliseconds across all sessions
  - `totalRegionsIdentified` - Total regions they've drawn (all time)
  - `totalFeaturesIdentified` - Total features they've tagged (all time)
- **USER PREFERENCES**

  - `selectedVolcano` - Which volcano do they currently have selected?
  - `selectedMode` - What mode are they in? (study/explore)
- **SESSION TIMING**

  - `sessionStarted` - When did this session start? (timestamp)
  - `sessionEnded` - When did this session end? (timestamp, null if ongoing)

---

## Session Activity

- **IDLE PERIODS** - For each time they go idle:

  - `idleStarted` - When did they stop interacting? (timestamp)
  - `idleDurationSeconds` - How many seconds were they idle?
  - `userReturned` - Did they come back? (true/false)
  - `returnedAt` - When did they come back? (timestamp)
  - `sessionTimedOut` - Did it hit 20 minutes and timeout? (true/false)
  - `autoSubmitted` - Did we auto-submit their data? (true/false)
- **VISIBILITY CHANGES** - For each time they tab away:

  - `state` - Did they tab away (hidden) or come back (visible)?
  - `timestamp` - When did this happen?

---

## Environment

- `pageLoaded` - When did the page load? (timestamp)
- `userAgent` - What browser/OS are they using?
- `screenResolution` - What's their screen size? (e.g., 1920x1080)
- `browserLanguage` - What language is their browser set to?
- `timezone` - What timezone are they in?

---

## Errors

For each error that happens:

- `timestamp` - When did it happen?
- `errorType` - What kind? (critical, metadata_mismatch)
- `errorMessage` - What was the error?
- `severity` - How bad? (critical, warning, info)
- `details` - Any extra info (stack traces, etc.)
- `consoleLogs` - Recent console output for context

---

## Data Upload

- `submitToQualtrics` - Should this data go to Qualtrics?
- `submitToR2` - Should this data go to R2?
