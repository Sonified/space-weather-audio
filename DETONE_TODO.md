# De-Tone Implementation TODO

## Current state
Offline pre-processing: detect tones → WASM notch filter full buffer → swap-buffer crossfade. Works well. Toggle = swap between clean/raw buffer.

## Tasks

### 1. Visual mask on spectrogram (in progress)
Show the user WHERE the de-tone is cutting. Should apply to the "basic material" so it zooms/pans naturally with the spectrogram.
- [ ] Build mask texture from the detected tone table
- [ ] Same coordinate space as spectrogram (freq bins × time frames)
- [ ] Sample in display shader / overlay with correct dimming
- [ ] Toggle with de-tone on/off
- [ ] Works at all zoom levels

### 2. Auto-reprocess on component switch
When user switches Br → Bt → Bn, if de-tone is on, automatically:
- [ ] Run detection on new component
- [ ] Generate new cleaned buffer
- [ ] Swap to cleaned buffer (crossfade)

### 3. Auto-reprocess on new data load
When user fetches new time range, if de-tone was on:
- [ ] Detect + filter new audio automatically
- [ ] Apply to playback

### 4. Processing indicator
User feedback while detection + WASM filter runs (~1.5s total).
- [ ] Spinner or pulse animation on de-tone toggle
- [ ] Disable toggle during processing
- [ ] Clear indicator when complete

### 5. Persistence across sessions (nice-to-have)
- [ ] Remember de-tone on/off in localStorage
- [ ] Apply automatically on page load if it was on

### 6. Cleanup / polish
- [ ] Handle edge case where user toggles off during processing
- [ ] Handle case where detection finds zero tones (don't swap buffers)
- [ ] Verify swap-buffer crossfade timing is smooth
