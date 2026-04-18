# OpenUSD + WebGPU: Research & Landscape

*April 17, 2026*

## What is OpenUSD?

Pixar's Universal Scene Description -- open-sourced 2016, now governed by the Alliance for OpenUSD (AOUSD: Pixar, Apple, Adobe, Autodesk, NVIDIA). A scene description system for composing and reading 3D data. Originally built for film pipelines, now being pushed as the universal 3D interchange format.

**Core strengths:**
- Composable scene hierarchy (prims, properties, layers)
- Time-sampled attributes (every value can vary per-frame natively)
- Binary crate format (.usdc) designed for memory-mapped, GPU-friendly access
- Typed flat arrays (positions, normals, indices) map naturally to GPU buffers
- First-class instancing with per-instance overrides
- MaterialX integration (node-graph materials, compilable to shader code)

**File formats:**
- `.usda` -- human-readable ASCII
- `.usdc` -- binary crate format (LZ4 compressed, fast, compact)
- `.usdz` -- zip archive (usdc + textures, Apple AR delivery format)

---

## The Gap: USD + WebGPU

**Nobody has shipped a production USD-to-WebGPU pipeline.** Every existing browser USD viewer renders via Three.js/WebGL. Autodesk has an in-progress Hydra Storm WebGPU backend (presented at Khronos meetups 2023-2024) but nothing public/usable.

This is the open lane.

---

## What Exists Today (Browser USD Parsers)

### 1. Official OpenUSD WASM (Pixar, v26.03 -- March 2026)
- **Repo:** https://github.com/PixarAnimationStudios/OpenUSD
- **What:** C++ core compiled to WASM via Emscripten. Full composition engine.
- **Status:** ACTIVE. Brand new official support in v26.03.
- **Catches:** No renderer included (Imaging/Hydra disabled in WASM builds). Heavy. Requires oneTBB for WASM. This gives you the scene graph, not pixels.
- **Use case:** When you need full-fidelity USD composition in the browser and will bring your own renderer.

### 2. TinyUSDZ (lighttransport)
- **Repo:** https://github.com/lighttransport/tinyusdz
- **What:** Dependency-free C++14 USD parser. Compiles to WASM via Emscripten.
- **Status:** ACTIVE. 701 stars, v0.9.1 (Nov 2025), 2,564 commits. Being proposed as basis for Three.js `TinyUSDZLoader`.
- **WASM size:** ~600KB compressed.
- **Catches:** Files >5MB can fail. No MaterialX, no subdivision surfaces, composition is experimental.
- **Includes:** "Tydra" framework for converting USD to renderer-friendly formats (OpenGL/Vulkan vertex buffers).
- **Use case:** Lightweight browser parsing where full composition isn't critical.

### 3. mxpv/openusd (Pure Rust)
- **Repo:** https://github.com/mxpv/openusd
- **What:** Native Rust USD implementation. No C++ dependencies whatsoever.
- **Status:** ACTIVE. v0.3.0 (April 2026), 95 stars. Passes all 276 AOUSD composition compliance tests.
- **Formats:** USDA, USDC, USDZ with automatic format detection.
- **Composition:** Full LIVRPS (sublayers, inherits, variants, references, payloads, specializes).
- **WASM:** Not explicitly documented but dependency chain (serde, lz4_flex, logos, zip) is all pure Rust -- should compile to `wasm32-unknown-unknown` cleanly.
- **Use case:** THE interesting piece for a WebGPU bridge. Pure Rust = clean WASM target, small binary, no Emscripten overhead.

### 4. Cinevva usdjs (Pure TypeScript)
- **Repo:** https://github.com/cinevva-engine/usdjs
- **What:** Reference-quality USD implementation in pure TypeScript. No WASM needed.
- **Status:** EXPERIMENTAL. Low community traction. API unstable pre-1.0.
- **Formats:** USDA, USDC, USDZ.
- **Composition:** Sublayers, references, payloads, variants, inherits. Missing specializes and relocates.
- **Performance:** Corpus-tested against real USD files from Pixar, NVIDIA, Apple.
- **Use case:** Zero-dependency browser option. Good for prototyping. Unproven at scale.

### 5. Needle USD Viewer (Three.js)
- **Repo:** https://github.com/needle-tools/usd-viewer
- **Demo:** https://usd-viewer.needle.tools/
- **What:** Full USD WASM build + Three.js Hydra render delegate. Most complete "drop a file and see it" solution.
- **Status:** ACTIVE. 152 stars. Picked up from Autodesk's abandoned Three.js approach.
- **Size:** ~8.7MB WASM (2MB gzipped).
- **Catches:** WebGL only. Requires SharedArrayBuffer (COOP/COEP headers). Missing MaterialX, point instancing, LightsAPI.
- **Use case:** Best existing turnkey viewer, but WebGL-bound.

### 6. three-usdz-loader (Community)
- **Repo:** https://github.com/ponahoum/three-usdz-loader
- **npm:** `three-usdz-loader` (v1.0.9)
- **Status:** MINIMALLY MAINTAINED. No commits since July 2024. 177 stars.

---

## Other Relevant Projects

### Mechaverse
- **Repo:** https://github.com/jurmy24/mechaverse
- **What:** Browser-based 3D viewer for robot models (URDF/MJCF/USD). Next.js + Three.js + MuJoCo WASM.
- **Demo:** https://render.mechaverse.dev
- **USD approach:** Integrates Needle's usd-viewer for OpenUSD support.
- **Rendering:** Three.js (WebGL), not WebGPU.
- **Status:** Work in progress. Interesting as a reference for how someone integrated USD viewing into a larger web app.

### Autodesk WebGPU Branch
- **Repo:** https://github.com/autodesk-forks/USD (branch `adsk/feature/webgpu`)
- **Proposal:** https://github.com/PixarAnimationStudios/OpenUSD-proposals/pull/14
- **What:** Porting Hydra Storm renderer to WebGPU. Mesh batching, UsdPreviewSurface, compute kernels.
- **Status:** IN PROGRESS. Presented at Khronos meetups. No public demo, no shipped product.

### NVIDIA Omniverse Web
- **What:** Server-side USD rendering streamed via WebRTC to browser. Not client-side at all.
- **Verdict:** Different architecture entirely. Not relevant to client-side WebGPU.

---

## The Rust-to-WASM-to-WebGPU Opportunity

The `mxpv/openusd` Rust crate is the most compelling building block for a USD-to-WebGPU bridge:

**Why Rust:**
- Pure Rust, zero C++ dependencies = clean `wasm32-unknown-unknown` compilation
- No Emscripten overhead (smaller binary, no JS glue code)
- Full composition compliance (all 276 AOUSD tests passing)
- Rust's memory model maps well to structured GPU buffer layouts
- Active development (v0.3.0, April 2026)

**What a bridge would look like:**
```
.usdc/.usda/.usdz file
    --> Rust/WASM parser (mxpv/openusd)
    --> Extract typed geometry buffers + scene graph
    --> Expose flat arrays to JS via WASM memory
    --> JS hands ArrayBuffers directly to WebGPU
    --> WebGPU renders
```

**What this is NOT:**
- Not a port of Hydra (Pixar's render architecture) -- that's Autodesk's multi-year project
- Not a full USD runtime -- just parse, extract geometry, hand to GPU
- The renderer is your own WebGPU pipeline (or Three.js WebGPU, Babylon, etc.)

**Key technical questions to validate:**
1. Does `mxpv/openusd` actually compile to WASM? (Deps look clean but untested)
2. What's the WASM binary size?
3. How do you efficiently pass geometry buffers from WASM to JS without copying?
4. What subset of USD schemas matter for a first pass? (UsdGeom meshes, transforms, basic materials)

---

## Alternative: Pure TypeScript Path

The Cinevva `usdjs` is worth watching. If it matures:
- Zero build complexity (no WASM, no Rust toolchain)
- Direct JS object access (no WASM bridge overhead)
- Easier to debug and extend
- Trade-off: likely slower parsing for large files vs. WASM

---

## WebGPU Benefits for USD (Why This Pairing Matters)

1. **Buffer-native data flow.** USDC stores flat typed arrays. WebGPU wants flat typed arrays. Minimal transform between file and GPU.
2. **Compute shaders.** USD can describe point clouds, volumes, curves -- primitives that benefit from GPU compute, not just rasterization.
3. **Instancing.** USD's first-class instancing maps directly to WebGPU indirect draw + instance buffers.
4. **MaterialX to WGSL.** MaterialX node graphs can be compiled to WGSL shaders. Procedural materials without texture bandwidth.
5. **Time-sampled playback.** USD's per-attribute time samples + WebGPU compute = GPU-driven animation without CPU round-trips.

---

## Summary: State of Play

| | Parser | Renderer | WebGPU | Production-Ready |
|---|---|---|---|---|
| OpenUSD WASM | Full | None | No | Infra only |
| TinyUSDZ | Good | Tydra (GL/Vulkan adaptor) | No | Getting there |
| mxpv/openusd (Rust) | Full | None | Possible via WASM | API unstable |
| Cinevva usdjs (TS) | Good | None | Possible directly | Early |
| Needle viewer | Full (via USD WASM) | Three.js/WebGL | No | Best available |
| Autodesk WebGPU | Full | Hydra Storm WebGPU | YES | Not shipped |

**The gap:** A lightweight, browser-native USD parser that hands geometry directly to WebGPU. Nobody has built it. The pieces exist (Rust parser, WebGPU maturity, WASM tooling) but nobody has connected them.
