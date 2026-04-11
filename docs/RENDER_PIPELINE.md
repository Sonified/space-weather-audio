# Spectrogram Render Pipeline

How the main window draws spectrograms, waveforms, and overlays. Read this BEFORE adding any new visual to the spectrogram canvas.

## Stack

- **Three.js WebGPU backend** — `WebGPURenderer`, NOT WebGL.
- **TSL (Three Shading Language)** — node-graph shaders, NOT GLSL/WGSL handwritten.
- **One scene, one orthographic camera, many meshes** layered via `renderOrder`.

The renderer is in `js/main-window-renderer.js`. Pyramid tile management is in `js/spectrogram-pyramid.js`.

## Core invariants

### 1. WebGPU requires `MeshBasicNodeMaterial`, NOT `MeshBasicMaterial`

Vanilla `MeshBasicMaterial` will silently render nothing in the WebGPU backend. Three.js doesn't error — the mesh just doesn't draw. If you add a new mesh and see no output, check the material type first.

```js
// ❌ Doesn't render in WebGPU
const mat = new THREE.MeshBasicMaterial({ color: 0xff0000 });

// ✅ Works in WebGPU
const mat = new THREE.MeshBasicNodeMaterial();
mat.colorNode = vec4(float(1.0), float(0.0), float(0.0), float(1.0));
```

Color is set via `colorNode` (a TSL node), not the `color` property.

### 2. The orthographic camera is in **world space (seconds)**, not UV space

`initThreeScene()` creates the camera as `OrthographicCamera(0, 1, 1, 0, 0, 10)`, but during rendering the bounds get **mutated** to seconds:

```js
camera.left = startSec;   // e.g. 0
camera.right = endSec;    // e.g. 17851 (5 hours)
camera.updateProjectionMatrix();
```

So all meshes must be positioned in **seconds**, not (0..1) UV. There's a helper:

```js
positionMeshWorldSpace(myMesh, startSec, endSec);
```

This sets `position.x = (start+end)/2` and `scale.x = (end-start)/2` so a `PlaneGeometry(2,2)` covers the desired time range.

If you put a mesh at default `(0,0,0)` with no scale, it'll sit invisibly at the origin in seconds-space (off-screen).

### 3. The frequency Y axis goes through `buildFreqRemapNodes()`

The Y axis maps frequency bins to screen pixels using **linear, sqrt, or log** scales (user-selectable). All mesh shaders share the same remap function so they stay aligned:

```js
const { texU, texV, effectiveY } = buildFreqRemapNodes();
const uv = vec2(texU, texV);
const sample = tslTexture(myTexture, uv);
```

`effectiveY > 1.0` means "above the visible frequency range" — most shaders use this to clip:

```js
material.colorNode = select(
    effectiveY.greaterThan(1.0), bgColor,
    visibleColor
);
```

### 4. `renderFrame()` has a `renderPending` guard that can get stuck

```js
async function renderFrame() {
    if (renderPending) return;  // ← if a previous render threw, this stays true forever
    renderPending = true;
    try {
        // ...
        await threeRenderer.renderAsync(scene, camera);
    } finally {
        renderPending = false;
    }
}
```

If something forced an early return after `renderPending = true` (without going through `finally`), subsequent calls return silently. When debugging "why isn't my mesh updating," check this flag. From outside the renderer, you can force a render by calling `renderFrame()` after resetting `renderPending = false`.

### 5. The main render function lives inside a `console.groupCollapsed`

`renderCompleteSpectrogram()` opens `console.groupCollapsed('[RENDER] Three.js Spectrogram')` early on and doesn't close it until much later. Anything `console.log`'d during init or sub-routines ends up **inside that collapsed group** in the browser console.

If you can't find your debug log, it's probably hiding inside `[RENDER]`. Use `console.warn` to escape, or expand the group manually.

### 6. Tile pyramid: the spectrogram is built from many tile meshes, not one

The base spectrogram is divided into **tiles** (e.g., 60-min each), each with its own `MeshBasicNodeMaterial` and texture. There are 32 tile mesh slots created upfront in `initThreeScene()`. The pyramid system (`spectrogram-pyramid.js`) decides which tiles are visible at the current zoom level and assigns textures to slots.

The MAIN `mesh` (full-resolution placeholder) is hidden when tiles cover the view (`tilesFullyCover = true` or `pyramidOnlyMode`).

### 7. `initThreeScene()` is idempotent

```js
async function initThreeScene() {
    if (material) return;  // Already initialized
    // ...
}
```

Subsequent calls return early. After data fetch, `cleanupThreeScene()` nulls `material`, then init can run again. **If you add new module-level state to init, you must also null it in `cleanupThreeScene()`** or it'll point to stale objects across data fetches.

## How to add a new visual layer

The "right way" to add an overlay (e.g., the de-tone mask):

1. **Inside `initThreeScene()`**, create your material as `MeshBasicNodeMaterial`
2. Sample any textures via `tslTexture(myDataTex, uv)` where `uv` comes from `buildFreqRemapNodes()` (so it auto-aligns with the spectrogram's freq scale)
3. Use a TSL `colorNode` for output
4. Add the mesh to the scene with a high `renderOrder` if you want it on top
5. **Position it in world space** per-frame inside `renderFrame()` using `positionMeshWorldSpace(myMesh, camera.left, camera.right)`
6. Export functions to update uniforms / textures from outside the renderer

For blending modes (subtractive darkening etc.):

```js
mat.transparent = true;
mat.blending = THREE.CustomBlending;
mat.blendSrc = THREE.ZeroFactor;
mat.blendDst = THREE.OneMinusSrcAlphaFactor;
mat.blendEquation = THREE.AddEquation;
// → result = dst * (1 - src.a)
```

## Reference: working examples in the codebase

- **Main spectrogram material**: `js/main-window-renderer.js` line ~543 — TSL colormap pipeline
- **Tile materials (32×)**: `js/main-window-renderer.js` line ~796 — Uint8 textures, gain/contrast
- **Waveform material**: same file, search for `waveformMaterial` — shows uniform-driven shape rendering
- **De-tone mask overlay**: same file, search for `detoneMaskMesh` — overlay with subtractive blending
- **Frequency remap helper**: `buildFreqRemapNodes()` — linear/sqrt/log Y axis

## Lessons learned the hard way

These all happened during the de-tone mask integration. Don't repeat them:

1. **Tried `MeshBasicMaterial` first** — silently renders nothing in WebGPU. Use `MeshBasicNodeMaterial`.
2. **Positioned mesh at (0.5, 0.5) in UV space** — but the camera is in seconds. Mesh was a tiny dot at the origin, off-screen.
3. **Called `renderFrame()` after toggle** — but `renderPending` was stuck `true` from a previous render that threw. Had to clear the flag or call `renderAsync` directly.
4. **Logged debug messages with `console.log`** — they disappeared inside `console.groupCollapsed('[RENDER]')`. Used `console.warn` to escape.
5. **Expected init logs to fire on every data fetch** — `initThreeScene()` is idempotent, so logs only fire on the FIRST call after page load.

## TL;DR for adding visuals

> WebGPU + TSL nodes + world-space camera in seconds + shared frequency remap + render via `renderFrame()` (clear `renderPending` if needed). Position meshes with `positionMeshWorldSpace()`. Test with a `MeshBasicNodeMaterial` and a hard-coded `vec4` color first before adding texture sampling.
