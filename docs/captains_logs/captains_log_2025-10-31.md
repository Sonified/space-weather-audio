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

## Duration & Error Handling Improvements

### Changes Made:

1. **24-Hour Duration Option**
   - Added 24-hour option to duration dropdown
   - Users can now fetch up to 24 hours of seismic/infrasound data

2. **Improved Error Handling for Inactive Stations**
   - Backend now returns 404 (Not Found) instead of 500 for stations with no data
   - Properly handles IRIS HTTP 204 responses (No data available)
   - Returns detailed error messages including station/channel info
   - Tracks last error message for better debugging

3. **Better Frontend Error Display**
   - Frontend now parses JSON error responses from backend
   - Displays specific error messages instead of generic HTTP status codes
   - Shows helpful messages like "station may be inactive or no data for requested time range"

4. **Debug Logging**
   - Added console logging for station filtering to help debug infrasound station issues
   - Identified that Kilauea infrasound stations (MENE1-5) are inactive in IRIS

### Key Learnings:

- **IRIS HTTP 204**: ObsPy raises exceptions when IRIS returns HTTP 204 (No data available)
- **Station Status**: Some stations in EMBEDDED_STATIONS may be inactive/decommissioned
- **Error Codes**: Use 404 for "resource not found" (inactive station) vs 500 for server errors
- **User Experience**: Specific error messages help users understand why data fetch failed

### Version
v1.25 - Commit: "v1.25 Feature: Added 24-hour duration option, improved error handling for inactive stations (404 instead of 500), better frontend error messages"

---

## CORS Fix for Render.com Backend

### Changes Made:

1. **Fixed CORS Headers on Error Responses**
   - All error responses (400, 404, 500) now include `Access-Control-Allow-Origin: *` header
   - Used `make_response()` to explicitly add CORS headers to error JSON responses
   - Prevents CORS errors when frontend fetches from Render.com backend

2. **Explicit Flask-CORS Configuration**
   - Updated `main.py` to explicitly set `origins='*'` for Flask-CORS
   - Added all custom headers to `expose_headers` list
   - Explicitly allowed `POST` and `OPTIONS` methods
   - Added `Content-Type` to allowed headers

### Problem:
- Frontend getting CORS errors when fetching 24-hour data from Render.com
- Error: "No 'Access-Control-Allow-Origin' header is present on the requested resource"
- Error responses (404, 500) weren't including CORS headers
- Flask-CORS config might not have been explicit enough

### Solution:
- All error responses now use `make_response()` with explicit CORS headers
- Main Flask app CORS config now explicitly allows all origins and methods
- Both success and error responses now properly handle CORS

### Key Learnings:

- **Error Responses Need CORS Too**: Even error responses must include CORS headers for browsers to read them
- **Explicit Configuration**: When using Flask-CORS, explicitly set `origins='*'` to ensure all origins are allowed
- **make_response()**: Use `make_response()` instead of returning tuples when you need to add custom headers

### Version
v1.26 - Commit: "v1.26 Fix: Added CORS headers to all error responses and explicitly configured Flask-CORS for Render.com backend"

---

## Memory Optimizations & Bug Fixes

### Changes Made:

1. **Memory Optimizations for 24-Hour Files**
   - Changed from float64 to float32 for intermediate arrays (50% memory savings)
   - Added explicit `del` statements to free arrays immediately after use
   - Optimized `normalize_audio()` to work with float32 input (no conversion to float64)
   - Frees `samples`, `filtered`, `processed`, `samples_bytes`, and `uncompressed_blob` immediately after use
   - Should keep 24-hour files under Render.com's 512MB limit

2. **Dynamic Buffer Expansion**
   - AudioWorklet buffer now expands dynamically instead of capping at 60 seconds
   - Buffer grows as needed (doubles when full) to handle hours of audio
   - Handles circular buffer wrap-around when copying during expansion
   - Added `dataLoadingComplete` flag to track when all data has been sent
   - Only reports "finished" when buffer is empty AND all data has been loaded

3. **Fixed Stale "Finished" Messages**
   - Added `isFetchingNewData` flag to ignore "finished" messages from old worklets
   - Clears old worklet's `onmessage` handler before disconnecting
   - Prevents "playback finished" message appearing after switching stations

4. **Removed Conflicting OPTIONS Handler**
   - Deleted manual OPTIONS handler from `audio_stream.py`
   - Flask-CORS now handles OPTIONS preflight automatically
   - Removes conflict between manual handler and Flask-CORS

5. **Fixed Template Literal Syntax Error**
   - Fixed template literal inside template literal in AudioWorklet code
   - Changed to string concatenation to avoid syntax conflict

### Problem:
- 24-hour files causing "Ran out of memory (used over 512MB)" on Render.com
- Long audio files getting truncated at 60 seconds (buffer overflow)
- False "playback finished" messages when switching stations
- CORS issues with conflicting OPTIONS handlers

### Solution:
- Use float32 instead of float64 (sufficient precision for audio, halves memory)
- Explicitly free arrays after use to reduce peak memory
- Dynamic buffer expansion to handle any length audio
- Flag-based message filtering to ignore stale worklet messages
- Let Flask-CORS handle OPTIONS automatically

### Key Learnings:

- **Memory Management**: Explicit `del` statements help Python free memory sooner
- **Float32 vs Float64**: Float32 is sufficient for audio processing, saves 50% memory
- **Dynamic Buffers**: Expanding buffers is better than fixed-size limits
- **Message Queuing**: Old AudioWorklet messages can be queued, need to clear handlers
- **Flask-CORS**: Manual OPTIONS handlers conflict with Flask-CORS's automatic handling

### Version
v1.27 - Commit: "v1.27 Fix: Memory optimizations for 24-hour files (float32, explicit cleanup), dynamic buffer expansion, fixed stale finished messages, removed conflicting OPTIONS handler"

---

