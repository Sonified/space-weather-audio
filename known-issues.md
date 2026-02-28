# Known Issues

## Waveform: visible jump at spp=256 transition

The waveform shader uses two paths — raw sample scanning when zoomed in (spp <= 256) and pre-computed mip bins when zoomed out (spp > 256). At the transition point, the waveform visibly "jumps" in thickness.

The original WebGL GLSL shader had the same two-branch logic and did NOT have this jump. The current WebGPU TSL translation does. Root cause is unknown.
