# Space Weather Audio

NASA space weather sonification tool. EMIC Wave Analysis Study.

No bundler — vanilla ES6 modules, Three.js via CDN. Two entry points: `study.html` (study), `index.html` (portal). `emic_study.html` is just a redirect stub — `study.html` is canonical. State centralized in `audio-state.js`. Three.js WebGPU with TSL (not GLSL), import from `three/webgpu` only.

Domain: `https://spaceweather.now.audio` (static + API, no separate API subdomain). Deploy: `cd cloudflare-worker && npx wrangler@4 deploy` (v4 not v3).

See `ARCHITECTURE.md` for API routes, file table, D1 schema, gotchas, and worker details.
See `docs/RENDER_PIPELINE.md` BEFORE touching any spectrogram visual — Three.js WebGPU + TSL has specific gotchas (NodeMaterial required, world-space camera in seconds, console group hiding logs, etc.).

Never include AI attribution in commits. Parallel agents for multi-file tasks.
