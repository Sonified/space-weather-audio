# Captain's Log - October 31, 2025

## AudioWorklet Fade Improvements & Loop Fixes

Major improvements to `Simple_IRIS_Data_Audification.html` audio playback system:

### Changes Made:

1. **Exponential Ramps for Natural Fades**
   - Switched from linear to exponential ramps for pause/resume/start/stop
   - Exponential ramps match human loudness perception (logarithmic)
   - Use near-zero (0.0001) instead of exact zero (exponential can't hit 0)
   - Linear ramps kept for volume slider (direct user control)

2. **Proper Worklet Lifecycle Management**
   - Worklet now NEVER returns `false` (stays alive for looping)
   - Added `finishSent` flag to prevent duplicate 'finished' messages
   - Added `hasStarted` check before sending 'finished' (prevents premature finish on fresh worklet)
   - Reset handler properly restores state for looping

3. **Speed Preservation**
   - Playback speed now preserved on loop restart
   - Speed restored after reset command during loops
   - Speed restored after manual replay

4. **Hybrid Pause/Resume Approach**
   - Gain node handles smooth fades (keeps audio thread alive)
   - Worklet pause/resume stops/starts consuming samples
   - AudioContext never suspended (avoids clicks from thread restart)

5. **Early Loop Detection**
   - Worklet warns main thread ~100ms before end
   - Enables future gapless loop optimization

### Key Learnings:

- **Best Practice**: Never return `false` from AudioWorklet if you want looping capability
- **Best Practice**: Use exponential ramps for perceived loudness changes, linear for direct control
- **Best Practice**: Keep AudioContext running, use gain nodes for fades
- **Bug**: Calling `reset` on fresh worklet sets `hasStarted=true` causing immediate finish

### Version
v1.23 - Commit: "v1.23 Fix: AudioWorklet fade improvements - exponential ramps for pause/resume, proper worklet lifecycle management for looping, speed preservation on restart"

---

## Backend Selection & Cleanup Improvements

### Changes Made:

1. **Local Server Checkbox**
   - Added checkbox to switch between localhost:5005 and Render.com backend
   - Default unchecked (uses Render.com production backend)
   - Status message shows which backend is being used
   - Console logs backend URL for debugging

2. **Cleanup on New Data Fetch**
   - When fetching new data while old data is playing, properly stops old playback
   - Fades out current audio smoothly (50ms exponential ramp)
   - Disconnects old worklet and gain nodes
   - Clears old data buffer
   - Resets playback state for fresh start
   - Prevents audio overlap/corruption

3. **UI Improvements**
   - Removed "Visualizations" header for cleaner layout
   - Improved status messages to show backend type

### Key Learnings:

- **Best Practice**: Always clean up old audio nodes before creating new ones
- **Best Practice**: Fade out before disconnecting to prevent clicks
- **User Experience**: Clear status messages help debug backend connectivity issues

### Version
v1.24 - Commit: "v1.24 Feature: Added Local Server checkbox for backend selection, improved cleanup on new data fetch, removed Visualizations header"

---

