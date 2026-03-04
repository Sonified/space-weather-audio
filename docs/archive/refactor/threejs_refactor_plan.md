# Volcano Audio: Three.js Spectrogram Renderer Migration

## Project Context

This is a seismic/infrasound audio visualization application with a professional-grade audio engine built on AudioWorklet. The audio side is Ferrari-level: sample-accurate processing, circular buffers aligned to 128-sample render quanta, crossfade state machines, and zero main thread blocking.

The visual side currently uses 2D canvas with ~3,000 lines of manual compositing code (`spectrogram-complete-renderer.js` + `spectrogram-canvas-state.js`). After extensive refactoring attempts, it remains fragile with persistent glitches. The architecture manually emulates GPU operations (stretching, alpha blending, compositing) on the CPU.

## The Goal

Migrate the spectrogram renderer to Three.js to achieve:

1. **Architectural parity with audio side** - GPU-based rendering that matches AudioWorklet quality

2. **Eliminate complexity** - Replace ~3,000 lines of manual canvas management with ~600-800 lines of declarative scene graph code

3. **Stop fighting glitches** - Let the GPU handle transforms, compositing, and blending

4. **Maintain all features** - Playback rate stretching, frequency scale transforms, zoom transitions, HQ overlay fades

## Current System Architecture

### Audio Layer (Keep - It's Perfect)

- **AudioWorklet**: `audio-worklet.js` (1,046 lines) - Sample-accurate playback with circular buffer

- Processes in 128-sample chunks, perfectly aligned

- Crossfade state machine for seamless loops

- Variable speed with interpolation

- High-pass filtering, anti-aliasing

### Visual Layer (Replace This)

**Current 2D Canvas System:**

- `spectrogram-complete-renderer.js` (2,574 lines) - Main renderer with manual canvas operations

- `spectrogram-canvas-state.js` (366 lines) - Canvas state management (fullView/region canvases)

- `spectrogram-renderer.js` (1,232 lines) - UI layer, frequency selection

- Manual temp canvas creation/destruction for every transform

- CPU-based stretching, compositing, alpha blending

**Key Operations That Need GPU:**

1. **Playback rate stretching** - Vertical scale of spectrogram (1x to 15x)

2. **Frequency scale transforms** - Linear/sqrt/logarithmic Y-axis mapping

3. **Zoom transitions** - Smooth geometric interpolation between views

4. **HQ overlay fade** - High-quality render crossfade over elastic friend

5. **Region sliding** - Zoom out with region shrinking/sliding away

6. **Horizontal slicing** - Extract time range from full dataset

## Technical Requirements

### Core Functionality

1. **Data Upload** - FFT magnitude data uploaded to GPU texture once

2. **Time Range Rendering** - Render any time slice without re-uploading data

3. **Playback Rate Stretch** - Real-time vertical stretching (shader uniform or mesh.scale.y)

4. **Frequency Scale** - Fragment shader applies linear/sqrt/log transform

5. **Colorization** - HSL to RGB conversion in fragment shader (hue based on magnitude)

6. **Zoom/Pan** - Camera or UV coordinate adjustment for navigation

### Transition System

1. **Elastic Friend** - Full dataset view that animates during zoom transitions

2. **Region Mesh** - Zoomed view that slides/scales during transitions

3. **HQ Overlay** - High-quality render that fades in when ready

4. **Scene Graph Compositing** - Multiple meshes compose automatically

### Integration Points

1. **Audio State** - Read from `audio-state.js` (playback rate, position, etc.)

2. **Zoom State** - Read from `zoom-state.js` (current view, transitions)

3. **Region Tracker** - Interface with `region-tracker.js` for user selections

4. **Time Axis** - Coordinate with `waveform-x-axis-renderer.js` for time labels

## Implementation Strategy

### Phase 1: Proof of Concept (Core Confidence)

**Test 1: Static Render**

- Create `SpectrogramThreeJSRenderer` class

- Upload magnitude data as GPU texture (DataTexture or Float32Array)

- Write basic fragment shader for HSL colorization

- Render static spectrogram at 1x playback rate

- **Success criteria**: See colored spectrogram matching current 2D canvas output

**Test 2: Multiple Independent Views**

- Instantiate two renderer instances

- Both reference same underlying data (texture sharing if possible)

- Render different time ranges simultaneously

- **Success criteria**: Two views with zero data duplication, both responsive

**Test 3: Smooth Animation**

- Implement continuous pan using requestAnimationFrame

- Update time range each frame (shift view window)

- **Success criteria**: Buttery smooth 60fps pan with no stuttering

**Test 4: Opacity Fade**

- Create two meshes in same scene with same data

- Animate opacity from 0→1 while other goes 1→0

- **Success criteria**: Smooth GPU-accelerated crossfade between views

### Phase 2: Feature Parity

**Playback Rate Stretching**

- Add `uPlaybackRate` uniform to shader OR use `mesh.scale.y`

- Vertical stretch from 1x to 15x

- Extract correct portion from texture (bottom-aligned)

- **Integration**: Read `State.currentPlaybackRate`, update on change

**Frequency Scale Transforms**

- Implement three modes in fragment shader: linear, sqrt, logarithmic

- Transform Y coordinate before texture sampling

- Apply Nyquist frequency mapping from original sample rate

- **Integration**: Read `State.frequencyScale`, update shader uniform

**Zoom/Pan System**

- Implement time-based navigation (horizontal axis)

- Calculate UV offsets/scales for texture sampling

- Smooth interpolation between zoom levels

- **Integration**: Read from `zoomState.getRegionRange()` or full view bounds

**Frequency Axis Integration**

- Render frequency labels as Three.js text or sprites

- Position dynamically based on current zoom/stretch

- Update when frequency scale changes

- **Integration**: Coordinate with `spectrogram-axis-renderer.js` or replace it

### Phase 3: Transitions & Polish

**Elastic Friend Pattern**

- Full dataset mesh (always present)

- Animates position/scale during zoom transitions

- Provides smooth geometric interpolation

- **Mechanism**: Interpolated position from `getInterpolatedTimeRange()`

**Region Sliding (Zoom Out)**

- Region mesh slides from center to target position

- Shrinks horizontally as viewport expands

- Full view mesh visible in gaps (left/right edges)

- **Mechanism**: Calculate position in interpolated viewport, composite via scene graph

**HQ Overlay Fade (Zoom In)**

- Second mesh with higher-resolution data

- Fades in during second half of transition (50%-90%)

- Skip fade if old region still visible (region-to-region)

- **Mechanism**: Opacity animation based on transition progress

**Feature Selection Boxes**

- Render as colored quads in scene

- Position based on time/frequency coordinates

- Scale/move with zoom transitions

- **Integration**: Read from `region-tracker.js` getCurrentRegions()

## Technical Specifications

### Shader Requirements

**Fragment Shader Must Handle:**

- Magnitude texture sampling (R or RGBA format)

- Frequency scale transform (Y coordinate remapping)

- HSL to RGB colorization (hue 0-60 based on magnitude)

- Playback rate consideration (if not using mesh.scale.y)

**Vertex Shader Must Handle:**

- Standard MVP transformation

- UV coordinate pass-through

- Optional: UV offset/scale for zoom

### Texture Format

- **Input**: FFT magnitude data (Float32Array or Uint8Array)

- **Dimensions**: Width = time samples, Height = frequency bins

- **Format**: THREE.RGBAFormat or THREE.RedFormat (magnitude only)

- **Type**: THREE.FloatType or THREE.UnsignedByteType

- **Wrapping**: CLAMP_TO_EDGE (no repeat)

### Scene Structure

```
Scene
├── Camera (OrthographicCamera for 2D)
├── FullView Mesh (elastic friend)
├── Region Mesh (zoomed view, conditional)
├── HQ Overlay Mesh (high-res, conditional)
└── Feature Box Meshes (selection indicators)
```

### Memory Management

- Dispose textures when switching datasets

- Dispose geometries/materials on cleanup

- Monitor GPU memory usage

- Implement texture pooling if needed

## Integration Notes

### State Dependencies

- `audio-state.js` - Playback rate, position, frequency scale

- `zoom-state.js` - Current view mode, region bounds, transition state

- `waveform-x-axis-renderer.js` - Time range interpolation, transition progress

- `region-tracker.js` - User selections, feature data

### Event Handlers to Maintain

- Frequency scale change → Update shader uniform

- Playback rate change → Update mesh scale or uniform

- Zoom initiated → Start transition animation

- Region selected → Switch active mesh

- Data loaded → Upload texture

### Coordinate Systems

- **Time**: Seconds relative to dataset start (Date objects available)

- **Frequency**: Hz mapped to [0, nyquist] where nyquist = sampleRate / 2

- **Canvas**: Device pixels (match existing canvas dimensions)

- **WebGL**: Normalized Device Coordinates [-1, 1]

## Success Criteria

**Phase 1 Complete When:**

- Static spectrogram renders correctly

- Multiple views work independently

- Smooth 60fps animation achieved

- Fade transitions are smooth

**Phase 2 Complete When:**

- All playback rates work (1x - 15x)

- All frequency scales work (linear/sqrt/log)

- Zoom/pan matches current behavior

- Frequency axis updates correctly

**Phase 3 Complete When:**

- Zoom transitions are smooth and glitch-free

- HQ overlay fades in correctly

- Region sliding works (zoom out)

- Feature boxes render and track correctly

- No visible artifacts or performance issues

## Migration Path

1. **Start fresh** - New `spectrogram-threejs-renderer.js`, don't modify existing 2D code

2. **Test in parallel** - Keep old renderer working while building new one

3. **Incremental replacement** - Switch one feature at a time

4. **Delete old code** - Once all tests pass, remove 2D canvas system

5. **Cleanup** - Remove unused dependencies, simplify state management

## Notes for Implementation

- Three.js is chosen over raw WebGL due to better error handling and faster development

- Fragment shaders provide same GPU power as raw WebGL

- Scene graph handles compositing automatically (no manual alpha blending)

- Texture uploads happen once, not per frame (critical for performance)

- Existing canvas-state.js concepts (fullView/region) map to scene graph meshes

- Testing philosophy: Build confidence with simple tests before complex features

- The goal is NOT to replicate every line of current code - simplify where possible

## Questions to Resolve During Implementation

1. Texture format - Float32 vs Uint8? RGBA vs single channel?

2. Stretch mechanism - mesh.scale.y vs shader uniform? (Test both)

3. Zoom approach - Camera movement vs UV offset? (Likely UV for precision)

4. HQ overlay - Separate scene vs opacity animation? (Likely same scene)

5. Axis rendering - Three.js text/lines vs keep existing 2D canvas? (Evaluate)

## Reference: Current Pain Points Being Solved

- **Temp canvas hell** - Created/destroyed constantly, memory leaks possible

- **Manual compositing** - CPU draws elastic friend edges, region center, overlays

- **State synchronization** - fullView/region canvases must stay in sync

- **Frequency scale validation** - Defensive checks everywhere, still glitches

- **Complex coordinate math** - Manual interpolation for every transition frame

- **Smart render bounds** - 100+ lines tracking overlay positions

All of the above complexity **disappears** with Three.js scene graph.

---

**Approach this incrementally. Build confidence through simple tests. Let the GPU do what GPUs do best. Match the architectural quality of the audio side.**

