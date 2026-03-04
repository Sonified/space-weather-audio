# TODO (Deprecated)

> **This list is deprecated and no longer relevant to the current project direction.**

---

<details>
<summary>Archived items (click to expand)</summary>

- Set up a function that can back-fill 24 hours of data for a given station (in the correct format)
- Implement an intelligent visual and auditory normalization such that extreme outliers won't cause the entire signal for a day to be very quiet
- Explore de-trending prior to audification
- Add y-axis ticks for the waveform
- Add x-axis ticks for tracking time on both spectrogram and waveform
- Implement the system for marking regions of interest
- Build the flow for participants arriving on the page
- Test the whole pipeline with the Qualtrics back end
- (Low priority) Waveform: switch from bin-rounded rectangles to a smooth drawn line when zoomed in far enough to avoid jagged appearance. Attempted Catmull-Rom cubic spline in TSL fragment shader — the solution is inadequate. The opt-in hamburger menu toggle exists but the visual quality isn't there yet.

### Previously Completed
- ✅ Circular buffer for AudioWorklet (got it working, sticking with circular buffer)
- ✅ Y-axis ticks for spectrogram (frequency axis with Hz labels)

</details>
