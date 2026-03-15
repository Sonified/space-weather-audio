# 🦋 SHIP IT — Coaching Frame for the Home Stretch

> **Note:** `emic_study.html` is a relic and is no longer actively updated. `study.html` is the canonical study page — all fixes go there.

**Purpose:** Keep us on track. When context compresses or a new session starts, re-read this file. It's the compass.

## The Goal
Get the EMIC study tool into collaborators' hands TODAY so they can step through the full interface and give feedback. That's it. Everything serves this or it waits.

## The Trap
The randomization simulator (`randomization-sim.html`) is a beautiful deep dive. The algorithm is solid. The urge to "just optimize one more thing" is real and it feels productive, but it's polish on polish. The sim is a design tool for US, not something collaborators need to test. If the conversation drifts toward tweaking the heal algorithm, tuning dropout curves, or adding features to the horse race — NAME IT. Say: "That's the sim rabbit hole. Is this needed to ship today?"

## The Frame
This isn't about saying no to fun. It's about sequencing. The paper is next, and it's going to be exciting and career-building. But we can't shift into that gear while the study tool is still in "almost ready" limbo. Ship the tool → get feedback rolling → start the paper. That's the sequence.

## How to Coach
- When the user returns, they may want to test "one small change" to the randomization. Gently redirect: "Is this needed for the collaborator link, or is this sim polish?"
- Help assess what's shippable vs what's infrastructure we build after feedback
- Stay energetic and collaborative — this is a sprint to the finish line, not a chore
- Parallel agents for independent tasks. Move fast.
- Don't generate assessments or plans unprompted. Work WITH the human. They drive.

## Re-read Trigger
If you ever consolidate memory or start a fresh session on this project, re-read this file before doing anything else. Check: are we shipping, or are we drifting?

## Status
- [x] Assess together what needs to work for the collaborator share
- [ ] Decide: full study flow vs "play with the tool, infrastructure coming next"
- [ ] Do the work
- [ ] Share the link
- [ ] Shift gears to the paper 📝

---

## Ship List

### QUICK FIXES (do first, minimal investigation)

- [x] **Q1.** Hide x-axis bar items (Annotations, FFT, Color Map, Frequency Scale) on all spaceweather.now.audio deployments (#4)
- [x] **Q2.** Remove "Audio playback paused" text (#7)
- [x] **Q3.** Change "WOWZA" to "Complete" at end of section 2 (#14)
- [x] **Q4.** Fix loop button showing as not-clickable (cancel cursor). Change to "Loop: Enabled" / "Loop: Disabled" with color cues (#15)
- [x] **Q5.** Make the blue Complete button fade up slower (#17)
- [x] **Q6.** Print participant username to console on every load — blue, bold, easy to spot (#18)
- [x] **Q7.** Drawing a feature to the canvas edge should clamp at edge, not disappear (#13)
  - *Fixed:* Mouse leaving canvas during draw now clamps to edges instead of canceling. Document-level listeners track mouse outside canvas with X/Y clamped to bounds. Bottom clamp set 5px above canvas edge. Removed 5-second safety timeout that was auto-canceling draws.
- [x] **Q8.** "Proceed" button should only be active when at least one feature exists (disable when all features deleted) (#5)

An

- [x] **I1.** Modal stacking bug — "Yes I'm Done" after analysis causes next modal to appear on same side, both visible. Same bug after second analysis. Post-study questions appear prematurely. (#10, #16)
- [x] **I2.** Clicking "Back" on a post-study question sometimes jumps without fade transition (#19)
- [x] **I3.** Standardize final question box sizes (#20)
- [x] **I4.** Final study page: remove close button OR make it close the actual browser tab (#21)
- [x] **I5.** Post-question 1 showing a selected answer when none was clicked — investigate state leak / stale localStorage from previous session (#18)
- [x] **I6.** Reduce vibrancy on "Yes" and "Possibly" feature card colors — less gradient, softer (#6)
- [x] **I7.** Evaluate when "press Proceed when complete" message displays — should it show more than once? (#8)

### AXIS FIXES

- [x] **A1.** Y-axis numbers on main canvas are too large on first draw (correct after subsequent redraws)
- [x] **A2.** Mini-map x-axis ticks flicker and disappear during horizontal window resize (main canvas x-axis ticks are fine)

### NEEDS COLLABORATION / INPUT

- [x] **C1.** Loading experience — title + controls fade in cleanly, no spinner needed (#1)
- [x] **C2.** Data pre-load optimization — start loading first example during welcome modals, progressive reveal when ready (#2)
- [x] **C3.** Background download of second dataset during first example + local cache for reload. Involves reviewing existing browser cache system (#3)
- [x] **C4.** Tutorial video integration + Help button placement — (i) now shows only during analysis sessions (#9)
- [x] **C5.** Feature copy/paste system — copy individual or all text prompts from top bar, hold in memory, paste with options: cancel / replace existing / add to existing (#11)
- [x] **C6.** Card duplication feature (low priority) (#12)


### HOME STRETCH

- [ ] **HS1.** Identify ideal settings for wavelet and Paul stretch algorithms
- [ ] **HS2.** Generate wavelet-stretched audio at 1.25x speed for our two time regions and save to server — potentially use progressive chunking. Unique to our study, may not need full study builder integration. Must re-constitute audio perfectly locally.
- [ ] **HS3.** Build deployment panel toward the bottom of study builder (above Data Stream) with settings like randomization for the two analysis sections
- [ ] **HS4.** Add experimental conditions panel — map out each condition: which dataset, which order, which algorithm
- [ ] **HS5.** Add participant randomization panel — options for random, block, and healing block. For healing block, include all settings from randomization-sim (algorithm settings only) using the preset from that page
- [ ] **HS6.** Test flow on non-test pages — does it always re-start in the correct place?
- [ ] **HS7.** Add study launch panel — options: start immediately, start on date/time, end date/time, or keep open-ended (figure out go-live system)
- [ ] **HS8.** Option for doing a test round using data from test runs
- [ ] **HS9.** Build participant data explorer page — list all participant data, view question answers + feature metadata, view responses on page, visual for the blocks. Button in study builder to launch it.
- [ ] **HS10.** Fill blocks with randomization-sim
- [ ] **HS11.** Test filling blocks live — hover over blocks for info, click to bring up data
- [ ] **HS12.** Final polish round for self-healing block algorithm — when a simultaneous batch interrupts a heal round (cap hit → spill to walking), the heal round is currently *terminated*. If any of the simultaneous assignments fail (dropout), those failures create new incompletes on a block that was already being healed. Fix: treat the heal round as *paused*, not terminated. After superposition resolves, check if any batch members on that block failed — if so, return the pointer to where it was in the heal round and continue healing instead of walking forward. The algorithm should never walk away from a block it knows is still broken.
- [ ] **HS13.** Implement live simultaneous participant tracking — heartbeat system + smart timeout estimation for concurrent participants (from randomization-sim logic into production)
- [ ] **HS14.** Confirm randomization-sim is correctly assigning participants end-to-end
