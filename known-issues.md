# Known Issues

## Spectrogram: not time-aligned with time series waveform

The spectrogram rendering does not align temporally with the time series waveform display.

## Spectrogram: tile edges no longer properly aligned

Edges of spectrogram tiles are not aligning correctly, causing visible seams or discontinuities.

## CustomSelect: layout jiggle on page load (FOUC)

When the page loads, native `<select>` elements render first, then `upgradeAllSelects()` swaps each one into a `CustomSelect` wrapper. Despite matching the native select's dimensions (`appearance: none`, `height: 28px`, SVG arrow) and using a single-mutation DOM swap (`insertBefore` with pre-assembled wrapper), there is still a visible jiggle — labels like "Component:" and the de-trend checkbox shift vertically during the upgrade.

**Root cause**: The CustomSelect swap involves removing the native select from the flow and inserting a wrapper div + trigger button in its place. Even as a single DOM mutation, the browser re-computes flex layout for the row, and subtle differences (inline-block wrapper vs replaced element select, button baseline vs select baseline) cause a 1-2px vertical shift.

**Attempted fixes that did not resolve**:
- Matching native `select` height/padding/font/arrow to `.csel-trigger` exactly
- `appearance: none` + custom SVG arrow on native select
- `min-height` on the parent flex container
- Single-mutation DOM swap (build wrapper off-DOM, `insertBefore` once)

**Possible future approaches**:
- Render CustomSelect server-side / in HTML (no JS swap at all)
- Use CSS `contain: layout` on the parent row to prevent reflow propagation
- Hide the entire controls bar until `upgradeAllSelects()` completes, then fade in

---

## Resolved

### Waveform: visible jump at spp=256 transition (FIXED)

The waveform shader uses two paths — raw sample scanning when zoomed in (spp <= 256) and pre-computed mip bins when zoomed out (spp > 256). At the transition point, the waveform visibly jumped in thickness.

**Root cause**: `ceil` on bin end boundaries caused pixels straddling a bin boundary to read 2 bins (512 samples) instead of 1, inflating the min/max range.

**Fix**: Replaced `ceil` with `round` (`floor(x + 0.5)`) for bin range calculation in both `main-window-renderer.js` and `minimap-window-renderer.js`. Bins are only included when the pixel overlaps them by half or more. Peaks that fall on a boundary shift to the pixel with greater overlap, which is more spatially accurate.
