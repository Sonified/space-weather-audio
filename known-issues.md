# Known Issues

## Spectrogram: not time-aligned with time series waveform

The spectrogram rendering does not align temporally with the time series waveform display.

---

## Resolved

### Waveform: visible jump at spp=256 transition (FIXED)

The waveform shader uses two paths — raw sample scanning when zoomed in (spp <= 256) and pre-computed mip bins when zoomed out (spp > 256). At the transition point, the waveform visibly jumped in thickness.

**Root cause**: `ceil` on bin end boundaries caused pixels straddling a bin boundary to read 2 bins (512 samples) instead of 1, inflating the min/max range.

**Fix**: Replaced `ceil` with `round` (`floor(x + 0.5)`) for bin range calculation in both `main-window-renderer.js` and `minimap-window-renderer.js`. Bins are only included when the pixel overlaps them by half or more. Peaks that fall on a boundary shift to the pixel with greater overlap, which is more spatially accurate.
