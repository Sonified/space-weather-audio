# Study Config Schema Audit: Round-Trip Fidelity

**Date:** 2026-03-07
**Files examined:**
- `/studies/emic-pilot.json` (the canonical config)
- `/study-builder.html` — `loadConfigIntoBuilder()` (line 1129) and `collectStudyConfig()` (line 1744)

---

## 1. Top-Level Metadata Fields

| JSON Field | `loadConfigIntoBuilder` | `collectStudyConfig` | Round-trip | Notes |
|---|---|---|---|---|
| `name` | `#studyNameInput.value` | `#studyNameInput.value` | **Lossless** | |
| `slug` | `#slugValue.textContent` | `#slugValue.textContent` | **Lossless** | |
| `version` | Stored in `_loadedMeta` | Spread back via `..._loadedMeta` | **Lossless** | Not editable in UI, preserved via passthrough |
| `createdAt` | Stored in `_loadedMeta` | Spread back via `..._loadedMeta` | **Lossless** | Same passthrough pattern |
| `author` | Stored in `_loadedMeta` | Spread back via `..._loadedMeta` | **Lossless** | Same passthrough pattern |
| `contactEmail` | Stored in `_loadedMeta` | Spread back via `..._loadedMeta` | **Lossless** | Same passthrough pattern |
| `adminKey` | `#adminKeyInput.value` | `#adminKeyInput.value` | **Lossless** | |
| `updatedAt` | N/A (not in JSON) | **Added** on every collect | **Phantom** | `collectStudyConfig` always writes `updatedAt: new Date().toISOString()`. Not a bug — intentional metadata enrichment. |

---

## 2. Registration Step Fields

| JSON Field | `loadConfigIntoBuilder` | `collectStudyConfig` | Round-trip | Notes |
|---|---|---|---|---|
| `type` | `card.dataset.type` | Read from `card.dataset.type` | **Lossless** | |
| `idMethod` | Pill selection: `"manual"` → "Manual Entry" active | Pill `.active` text → `auto_generate` or `manual` | **Lossless** | Mapping: `includes('auto')` in both directions |
| `idPrefix` | `.reg-id-prefix.value` | `.reg-id-prefix.value` | **Lossless** | |
| `idPlaceholder` | `.reg-id-placeholder.value` | `.reg-id-placeholder.value` | **Lossless** | |
| `collectEmail` | **NOT LOADED** | **NOT COLLECTED** | **MISSING/LOST** | JSON has `collectEmail: false` but builder has no UI element for it. Field is silently dropped on load and not re-emitted. |
| `showConsent` | **NOT LOADED** | **NOT COLLECTED** | **MISSING/LOST** | JSON has `showConsent: false` but builder has no UI element for it. Field is silently dropped on load and not re-emitted. |
| `regTitle` | `.reg-title-input.value` (via `buildRegistrationCard`) | `.reg-title-input.value` | **Phantom (net-new)** | Not in the JSON. Builder adds it with default `"Welcome"`. After round-trip, registration step gains `regTitle: "Welcome"`. |
| `regBodyHtml` | `.reg-body-html-input.innerHTML` | `.reg-body-html-input.innerHTML` | **Phantom (net-new)** | Not in the JSON. Builder adds default HTML. After round-trip, step gains `regBodyHtml`. |
| `regButtonLabel` | `.reg-button-label-input.value` | `.reg-button-label-input.value` | **Phantom (net-new)** | Not in JSON. Default `"Confirm"` added. |
| `modalWidth` | `.modal-width-input.value` | `.modal-width-input.value` (only if non-empty) | **Phantom (net-new)** | Not in JSON. Default `"480px"` used in builder, emitted on collect. |
| `modalHeight` | `.modal-height-input.value` | `.modal-height-input.value` (only if non-empty) | **Phantom (conditional)** | Default `"auto"` — not emitted if value is empty string. |
| `titleFontSize` | `buildFontStyleControls('title', step, ...)` | `collectFontStyleSettings(card, step, 'title')` | **Phantom (net-new)** | Not in JSON. Builder creates with default `"20px"`, always collected. |
| `titleFontColor` | Same | Same | **Phantom (net-new)** | Default `"#550000"` |
| `titleFontBold` | Same | Same | **Phantom (net-new)** | Default `true` |
| `bodyFontSize` | `buildFontStyleControls('body', step, ...)` | `collectFontStyleSettings(card, step, 'body')` | **Phantom (net-new)** | Default `"16px"` |
| `bodyFontColor` | Same | Same | **Phantom (net-new)** | Default `"#333333"` |
| `bodyFontBold` | Same | Same | **Phantom (net-new)** | Default `false` |
| `titleUnderline` | `buildTitleUnderlineControls(step)` | `collectUnderlineSettings(card, step)` | **Phantom (net-new)** | Default `true` (builder default: `step.titleUnderline !== false`) |
| `titleUnderlineSize` | Same | Same | **Phantom (net-new)** | Default `"2px"` |
| `titleUnderlineColor` | Same | Same | **Phantom (net-new)** | Default `"#c86464"` |

---

## 3. Modal Step Fields (Informational)

| JSON Field | `loadConfigIntoBuilder` | `collectStudyConfig` | Round-trip | Notes |
|---|---|---|---|---|
| `type` | `card.dataset.type = 'modal'` | Read from `card.dataset.type` | **Lossless** | |
| `contentType` | Pill selection (Informational/Questions) | Pill `.active` text → lowercase | **Lossless** | |
| `title` | First `.field-input` in card | First `.field-input` (non-date) in card | **Lossless** | |
| `bodyHtml` | `.rich-editable.innerHTML` | `.body-html-input.innerHTML` | **Lossless** | Note: `contenteditable` may normalize HTML (browser-dependent whitespace, tag casing). |
| `dismissLabel` | `.dismiss-label-input.value` | `.dismiss-label-input.value` | **Lossless** | |
| `skippable` | Toggle `.on` class | Last toggle in card `.on` check | **Lossless** | |
| `modalWidth` | `.modal-width-input.value` | `.modal-width-input.value` | **Phantom (net-new)** | Not in JSON. Default `"460px"` for info, `"720px"` for questions. |
| `modalHeight` | `.modal-height-input.value` | `.modal-height-input.value` | **Phantom (conditional)** | Default `"auto"`, only emitted if non-empty. |
| `titleFontSize` | via `buildFontStyleControls` | via `collectFontStyleSettings` | **Phantom (net-new)** | Default `"20px"` |
| `titleFontColor` | Same | Same | **Phantom (net-new)** | Default `"#550000"` |
| `titleFontBold` | Same | Same | **Phantom (net-new)** | Default `true` |
| `bodyFontSize` | Same | Same | **Phantom (net-new)** | Default `"16px"` |
| `bodyFontColor` | Same | Same | **Phantom (net-new)** | Default `"#333333"` |
| `bodyFontBold` | Same | Same | **Phantom (net-new)** | Default `false` |
| `titleUnderline` | via `buildTitleUnderlineControls` | via `collectUnderlineSettings` | **Phantom (net-new)** | Default `true` |
| `titleUnderlineSize` | Same | Same | **Phantom (net-new)** | Default `"2px"` |
| `titleUnderlineColor` | Same | Same | **Phantom (net-new)** | Default `"#c86464"` |

---

## 4. Modal Step Fields (Questions)

| JSON Field | `loadConfigIntoBuilder` | `collectStudyConfig` | Round-trip | Notes |
|---|---|---|---|---|
| `questions[].id` | `data-question-id` attribute | Read from `q.dataset.questionId` | **Lossless** | Falls back to `q${qi+1}` if missing |
| `questions[].text` | `.q-text` span textContent | `.q-text` span textContent | **Lossless** | |
| `questions[].type` | `.q-type` span display text | `.q-type` text → lowercase, `'free text'` → `'freetext'` | **Lossless** | |
| `questions[].inputName` | `data-input-name` attribute | Read from `q.dataset.inputName` | **Lossless** | Stored as data attribute, faithfully round-tripped |
| `questions[].subtitle` | `data-subtitle` attribute | Read from `q.dataset.subtitle` | **Lossless** | Stored as data attribute |
| `questions[].placeholder` | `data-placeholder` attribute | Read from `q.dataset.placeholder` | **Lossless** | Stored as data attribute |
| `questions[].required` | `data-required` attribute | `q.dataset.required === 'true'` | **Lossy (minor)** | `false` → string `"false"` in DOM → read back as `false`. Works correctly. But `undefined` (field absent) → attribute not set → `q.dataset.required` is `undefined` → field not emitted. So missing `required` stays missing. Lossless in practice. |
| `questions[].options` | `data-options` (JSON string) + inline `.opt-row` editor | Reads from inline `.opt-row` editor first, falls back to `data-options` | **LOSSY** | See Bug #1 below |
| `questions[].options[].value` | Stored in `data-options` JSON, **NOT** rendered in inline editor | **NOT COLLECTED** from inline editor | **LOST** | See Bug #1 below |
| `questions[].options[].label` | Rendered in `.opt-label-input` | Read from `.opt-label-input` | **Lossless** | |
| `questions[].options[].description` | Rendered in `.opt-desc-input` (contenteditable) | Read from `.opt-desc-input.innerHTML` | **Lossless** | Subject to browser HTML normalization |
| `dismissLabel` (questions modal) | `.dismiss-label-input.value` | `.dismiss-label-input.value` | **Lossless** | Default "Submit" |

---

## 5. Analysis Step Fields

| JSON Field | `loadConfigIntoBuilder` | `collectStudyConfig` | Round-trip | Notes |
|---|---|---|---|---|
| `type` | `card.dataset.type = 'analysis'` | Read from `card.dataset.type` | **Lossless** | |
| `title` | `.analysis-title-input.value` | `.analysis-title-input.value` | **Lossless** | |
| `spacecraft` | First `<select>` in `.analysis-grid` | `selects[0].value` | **Lossless** | |
| `dataset` | Second `<select>` | `selects[1].value` | **Lossless** | |
| `startDate` | Loaded via `toLocalDatetime(step.startTime \|\| step.startDate)` into `.analysis-start` | Collected as `step.startTime = toISOTime(...)` | **LOSSY (key rename)** | See Bug #2. JSON has `startDate: "2022-08-17"`, builder reads it, but **emits** `startTime: "2022-08-17T00:00:00Z"`. Field name changes AND format changes. |
| `endDate` | Same pattern → `.analysis-end` | Collected as `step.endTime` | **LOSSY (key rename)** | Same issue: `endDate` → `endTime`, date-only → datetime with `T00:00:00Z` appended. |
| `dataSource` | Pill selection: `includes('cdaweb')` → CDAWeb, else R2 | Pill text → `'cdaweb'` or `'cloudflare_r2'` | **Lossless** | |
| `playbackSpeed` | Third `<select>` | `selects[2].value` | **Lossless** | |
| `dataPreload` | `buildDataPreloadOptions(step.dataPreload)` → `<select>` | `.data-preload-select.value` | **LOSSY (conditional)** | See Bug #3. Value `"step:2"` is loaded correctly only if the step cards exist in DOM at build time. But `collectStudyConfig` only emits `dataPreload` if value !== `'onEnter'`. So value `"step:2"` survives if DOM is built in order. |
| `allowFeatureDrawing` | Toggle `.on` class | `toggles[0].classList.contains('on')` | **Lossless** | |
| `showSpectrogram` | Toggle `.on` class | `toggles[1].classList.contains('on')` | **Lossless** | |
| `allowStretch` | Toggle `.on` class | `toggles[2].classList.contains('on')` | **Lossless** | |
| `requireMinFeatures` | Toggle `.on` class | `toggles[3].classList.contains('on')` | **Lossless** | |
| `confirmCompletion.enabled` | Toggle `.on` class | `toggles[4].classList.contains('on')` | **Lossless** | |
| `confirmCompletion.title` | `.confirm-title-input.value` | `.confirm-title-input.value` | **LOSSY (conditional)** | See Bug #4. Confirmation sub-fields are only rendered in HTML when `confirm.enabled` is truthy. If disabled, the inputs don't exist in DOM and custom values are lost. |
| `confirmCompletion.message` | `.confirm-message-input.value` | `.confirm-message-input.value` | **LOSSY (conditional)** | Same as above |
| `confirmCompletion.confirmLabel` | `.confirm-label-input.value` | `.confirm-label-input.value` | **LOSSY (conditional)** | Same as above |
| `confirmCompletion.cancelLabel` | `.cancel-label-input.value` | `.cancel-label-input.value` | **LOSSY (conditional)** | Same as above |
| `prompts[]` | `buildPromptsSection(step.prompts)` → `.prompt-entry` elements | Read from `.prompt-entry` elements | **Lossless** | Each prompt's trigger, delay, text, effect, speed are all preserved |
| `prompts[].trigger` | `<select>.prompt-trigger` | `.prompt-trigger.value` | **Lossless** | |
| `prompts[].delay` | `<input>.prompt-delay` | `.prompt-delay.value` (parseInt) | **Lossless** | |
| `prompts[].text` | `<input>.prompt-text` | `.prompt-text.value` | **Lossless** | Empty-text prompts are **dropped** on collect (the `if (text.trim())` guard) |
| `prompts[].effect` | `<select>.prompt-effect` | `.prompt-effect.value` | **Lossless** | |
| `prompts[].speed` | `<select>.prompt-speed` | `.prompt-speed.value` | **Lossless** | |

---

## 6. App Settings Coverage

The `APP_SETTINGS_BUILDER_MAP` maps 76 element IDs to `appSettings` paths. Comparing against the JSON:

| JSON `appSettings` path | In `APP_SETTINGS_BUILDER_MAP`? | Status |
|---|---|---|
| `session.idMode` | `as_idMode` | **Covered** |
| `session.showIdCorner` | `as_showIdCorner` | **Covered** |
| `session.skipLoginWelcome` | `as_skipLoginWelcome` | **Covered** |
| `dataLoading.source` | `as_source` | **Covered** |
| `dataLoading.bypassCache` | `as_bypassCache` | **Covered** |
| `dataLoading.silentDownload` | `as_silentDownload` | **Covered** |
| `dataLoading.autoDownload` | `as_autoDownload` | **Covered** |
| `dataLoading.autoPlay` | `as_autoPlay` | **Covered** |
| `dataLoading.rendering` | `as_rendering` | **Covered** |
| `featureBoxes.visible` | `as_visible` | **Covered** |
| `featureBoxes.annotationAlignment` | `as_annotationAlignment` | **Covered** |
| `featureBoxes.annotationWidth` | `as_annotationWidth` | **Covered** |
| `featureBoxes.annotationFontSize` | `as_annotationFontSize` | **Covered** |
| `display.displayOnLoad` | `as_displayOnLoad` | **Covered** |
| `display.initialHours` | `as_initialHours` | **Covered** |
| `display.minUIWidth` | `as_minUIWidth` | **Covered** |
| `display.heightMinimap` | `as_heightMinimap` | **Covered** |
| `display.heightSpectrogram` | `as_heightSpectrogram` | **Covered** |
| `audio.quality` | `as_quality` | **Covered** |
| `rendering.tileCompression` | `as_tileCompression` | **Covered** |
| `rendering.tileEdgeMode` | `as_tileEdgeMode` | **Covered** |
| `rendering.tileChunkSize` | `as_tileChunkSize` | **Covered** |
| `rendering.zoomOutMode` | `as_zoomOutMode` | **Covered** |
| `rendering.levelTransition` | `as_levelTransition` | **Covered** |
| `rendering.crossfadePower` | `as_crossfadePower` | **Covered** |
| `rendering.renderOrder` | `as_renderOrder` | **Covered** |
| `rendering.waveformPanMode` | `as_waveformPanMode` | **Covered** |
| `waveformZoom.catmullMode` | `as_catmullMode` | **Covered** |
| `waveformZoom.catmullThreshold` | `as_catmullThreshold` | **Covered** |
| `waveformZoom.catmullCore` | `as_catmullCore` | **Covered** |
| `waveformZoom.catmullFeather` | `as_catmullFeather` | **Covered** |
| `navigation.arrowZoomStep` | `as_arrowZoomStep` | **Covered** |
| `navigation.arrowPanStep` | `as_arrowPanStep` | **Covered** |
| `xAxisTicks.zoomFadeMode` | `as_zoomFadeMode` | **Covered** |
| `xAxisTicks.fadeInCurve` | `as_fadeInCurve` | **Covered** |
| `xAxisTicks.fadeInTime` | `as_fadeInTime` | **Covered** |
| `xAxisTicks.fadeOutCurve` | `as_fadeOutCurve` | **Covered** |
| `xAxisTicks.fadeOutTime` | `as_fadeOutTime` | **Covered** |
| `xAxisTicks.zoomSpatialCurve` | `as_zoomSpatialCurve` | **Covered** |
| `xAxisTicks.zoomSpatialWidth` | `as_zoomSpatialWidth` | **Covered** |
| `xAxisTicks.edgeFadeMode` | `as_edgeFadeMode` | **Covered** |
| `xAxisTicks.edgeFadeCurve` | `as_edgeFadeCurve` | **Covered** |
| `xAxisTicks.edgeSpatialWidth` | `as_edgeSpatialWidth` | **Covered** |
| `xAxisTicks.edgeTimeIn` | `as_edgeTimeIn` | **Covered** |
| `xAxisTicks.edgeTimeOut` | `as_edgeTimeOut` | **Covered** |
| `featurePlayback.mode` | `as_featurePlaybackMode` | **Covered** |
| `pageScroll.lock` | `as_lockPageScroll` | **Covered** |
| `navBar.view` | `as_navView` | **Covered** |
| `navBar.viewingMode` | `as_navViewingMode` | **Covered** |
| `navBar.click` | `as_navClick` | **Covered** |
| `navBar.markers` | `as_navMarkers` | **Covered** |
| `navBar.featureBoxes` | `as_navFeatureBoxes` | **Covered** |
| `navBar.vScroll` | `as_navVScroll` | **Covered** |
| `navBar.vSens` | `as_navVSens` | **Covered** |
| `navBar.hScroll` | `as_navHScroll` | **Covered** |
| `navBar.hSens` | `as_navHSens` | **Covered** |
| `mainWindow.view` | `as_mainView` | **Covered** |
| `mainWindow.mode` | `as_mainMode` | **Covered** |
| `mainWindow.click` | `as_mainClick` | **Covered** |
| `mainWindow.release` | `as_mainRelease` | **Covered** |
| `mainWindow.drag` | `as_mainDrag` | **Covered** |
| `mainWindow.markers` | `as_mainMarkers` | **Covered** |
| `mainWindow.xAxis` | `as_mainXAxis` | **Covered** |
| `mainWindow.boxFilter` | `as_mainBoxFilter` | **Covered** |
| `mainWindow.numbers` | `as_mainNumbers` | **Covered** |
| `mainWindow.numbersLoc` | `as_mainNumbersLoc` | **Covered** |
| `mainWindow.numbersWeight` | `as_mainNumbersWeight` | **Covered** |
| `mainWindow.numbersSize` | `as_mainNumbersSize` | **Covered** |
| `mainWindow.numbersShadow` | `as_mainNumbersShadow` | **Covered** |
| `mainWindow.vScroll` | `as_mainVScroll` | **Covered** |
| `mainWindow.vSens` | `as_mainVSens` | **Covered** |
| `mainWindow.hScroll` | `as_mainHScroll` | **Covered** |
| `mainWindow.hSens` | `as_mainHSens` | **Covered** |
| `debug.printInit` | `as_printInit` | **Covered** |
| `debug.printGPU` | `as_printGPU` | **Covered** |
| `debug.printMemory` | `as_printMemory` | **Covered** |
| `debug.printAudio` | `as_printAudio` | **Covered** |
| `debug.printStudy` | `as_printStudy` | **Covered** |
| `debug.printFeatures` | `as_printFeatures` | **Covered** |
| `debug.printData` | `as_printData` | **Covered** |
| `debug.printInteraction` | `as_printInteraction` | **Covered** |

**Result: All 76 appSettings paths in the JSON are covered by `APP_SETTINGS_BUILDER_MAP`. No gaps.**

---

## 7. Font Style Fields (titleFontSize, bodyFontColor, etc.)

These fields are **NOT in the JSON** (`emic-pilot.json`). However, the builder:

1. `buildRegistrationCard`, `buildModalCard` both call `buildFontStyleControls()` which renders selects/inputs with default values.
2. `collectStudyConfig` always calls `collectFontStyleSettings()` and `collectUnderlineSettings()`, which unconditionally write these fields into the step object.

**Result:** After one load-save round-trip, every registration and modal step gains 9 new fields:
- `titleFontSize`, `titleFontColor`, `titleFontBold`
- `bodyFontSize`, `bodyFontColor`, `bodyFontBold`
- `titleUnderline`, `titleUnderlineSize`, `titleUnderlineColor`

This is schema inflation, not data loss. The values are the builder's defaults. It is harmless if the consumer ignores unknown fields, but it pollutes the JSON.

---

## 8. Bugs (Data Lost or Changed on Round-Trip)

### Bug #1: `options[].value` dropped on round-trip (CRITICAL)

**Location:** `collectStudyConfig()` lines 1798-1805, `buildModalCard()` lines 1422-1432

**Problem:** Radio question options in the JSON have three fields: `value`, `label`, `description`. The inline `.opt-row` editor only renders `label` and `description` inputs. When collecting, if the inline editor exists (which it always does for radio questions), the code reads from `.opt-label-input` and `.opt-desc-input` — but there is no input for `value`. The `value` field is simply not emitted.

**Impact:** After round-trip:
```json
// BEFORE
{ "value": "1", "label": "None", "description": "No prior background" }
// AFTER
{ "label": "None", "description": "No prior background" }
```

All `value` fields on all radio options across all questions are permanently lost. The fallback path (reading from `data-options`) would preserve them, but it is never reached because the inline editor always exists.

**Fix:** Either add a hidden input for `value` in each `.opt-row`, or merge the collected `label`/`description` with the original `value` from `data-options`.

---

### Bug #2: `startDate`/`endDate` renamed to `startTime`/`endTime` (MODERATE)

**Location:** `collectStudyConfig()` lines 1841-1844, `buildAnalysisCard()` lines 1538-1542

**Problem:** The JSON uses `startDate` and `endDate`. The builder's `buildAnalysisCard` correctly reads them (with fallback: `step.startTime || step.startDate`). But `collectStudyConfig` always writes `startTime` and `endTime`, never `startDate`/`endDate`.

Additionally, the date-only format `"2022-08-17"` becomes `"2022-08-17T00:00:00Z"` through `toLocalDatetime()` + `toISOTime()`.

**Impact:** After round-trip, the keys change and the format changes:
```json
// BEFORE
"startDate": "2022-08-17", "endDate": "2022-08-20"
// AFTER
"startTime": "2022-08-17T00:00:00Z", "endTime": "2022-08-20T00:00:00Z"
```

This is a **key rename**. If the consumer expects `startDate`/`endDate`, it will break.

**Fix:** Decide on one canonical key name. Either always emit `startDate`/`endDate`, or update the JSON schema and all consumers to use `startTime`/`endTime`. The `toISOTime` Z-suffix addition is also questionable since these are dates without timezone intent.

---

### Bug #3: `collectEmail` and `showConsent` silently dropped (MODERATE)

**Location:** `buildRegistrationCard()` (line 1282), `collectStudyConfig()` registration block (line 1752)

**Problem:** The JSON has `collectEmail: false` and `showConsent: false` on the registration step. The builder has no UI for these fields. They are not stored in any data attribute or hidden input. They are not in `_loadedMeta` (that only captures top-level keys, not step-level keys). They are simply lost.

**Impact:** After round-trip, both fields disappear from the registration step. If the consumer defaults `collectEmail` or `showConsent` to `true` when absent, behavior changes silently.

**Fix:** Either add toggle UI for these fields, or store them as `data-*` attributes on the registration card and echo them back in `collectStudyConfig`.

---

### Bug #4: `confirmCompletion` sub-fields lost when disabled (MINOR)

**Location:** `buildAnalysisCard()` lines 1584-1603

**Problem:** The confirmation dialog sub-fields (title, message, confirmLabel, cancelLabel) are only rendered into the DOM when `confirm.enabled` is truthy. If a user loads a config with `confirmCompletion.enabled: true` and custom text, then toggles the confirmation OFF and back ON, the custom text is gone — replaced by defaults.

This is a minor UX issue. It does NOT affect JSON round-trip when the toggle state matches, only when the toggle is cycled within the builder session.

**Fix:** Always render the sub-fields (hidden when disabled) so values survive toggle cycling.

---

### Bug #5: `dataPreload` value `"step:2"` depends on DOM build order (MINOR)

**Location:** `buildDataPreloadOptions()` line 1489, `buildAnalysisCard()` line 1560

**Problem:** `buildDataPreloadOptions` dynamically builds `<option>` elements from existing `.step-card` elements in the DOM. During `loadConfigIntoBuilder`, steps are built sequentially. When the analysis step (step index 3) is being built, steps 0-2 already exist in the DOM. So `"step:2"` (referring to step index 2, the second modal) will have a matching `<option>` and will be selected correctly.

However, if step order changes (drag reorder), the `dataPreload` value refers to a stale step index. The `<select>` is not rebuilt on reorder.

**Impact:** Correct on initial load, but stale after drag-reorder.

**Fix:** Rebuild the `dataPreload` select options after any step reorder or deletion.

---

## 9. Phantom Fields (Builder writes, not in JSON)

These fields are emitted by `collectStudyConfig` but do not exist in `emic-pilot.json`:

| Field | Step Type | Source | Notes |
|---|---|---|---|
| `updatedAt` | Top-level | `new Date().toISOString()` | Intentional — timestamps the save |
| `regTitle` | Registration | `.reg-title-input` default `"Welcome"` | Builder-only field |
| `regBodyHtml` | Registration | `.reg-body-html-input` default HTML | Builder-only field |
| `regButtonLabel` | Registration | `.reg-button-label-input` default `"Confirm"` | Builder-only field |
| `modalWidth` | Registration, Modal | `.modal-width-input` default `"480px"` / `"460px"` / `"720px"` | Builder-only field |
| `modalHeight` | Registration, Modal | `.modal-height-input` (only if non-empty) | Builder-only field |
| `titleFontSize` | Registration, Modal | `collectFontStyleSettings` default `"20px"` | Builder-only styling |
| `titleFontColor` | Registration, Modal | Same, default `"#550000"` | Builder-only styling |
| `titleFontBold` | Registration, Modal | Same, default `true` | Builder-only styling |
| `bodyFontSize` | Registration, Modal | Same, default `"16px"` | Builder-only styling |
| `bodyFontColor` | Registration, Modal | Same, default `"#333333"` | Builder-only styling |
| `bodyFontBold` | Registration, Modal | Same, default `false` | Builder-only styling |
| `titleUnderline` | Registration, Modal | `collectUnderlineSettings` default `true` | Builder-only styling |
| `titleUnderlineSize` | Registration, Modal | Same, default `"2px"` | Builder-only styling |
| `titleUnderlineColor` | Registration, Modal | Same, default `"#c86464"` | Builder-only styling |

---

## 10. Recommendations

### Critical (fix before production use)

1. **Preserve `options[].value`** — Add a hidden `data-value` attribute to each `.opt-row`, or merge collected label/description with the original value from `data-options`. Without this, radio button responses in the study lose their numeric coding scheme.

2. **Normalize date field names** — Pick `startDate`/`endDate` or `startTime`/`endTime` and use it everywhere. Update both `buildAnalysisCard` and `collectStudyConfig` to agree. If using datetime, consider whether appending `T00:00:00Z` is desirable for date-only inputs.

3. **Preserve `collectEmail` and `showConsent`** — At minimum, store as data attributes on the registration card and echo them back. Better: add toggle UI so these become intentional choices.

### Moderate

4. **Rebuild `dataPreload` options on step reorder** — After drag-reorder or step deletion, re-render the `dataPreload` select to reflect the new step order and indices.

5. **Only emit font/underline fields if they differ from defaults** — Reduces schema inflation. Check if value matches the default before adding to the step object.

### Minor

6. **Always render confirmation sub-fields** (hidden when disabled) so values survive toggle cycling within a builder session.

7. **Consider omitting `modalWidth`/`modalHeight` when they equal the default** to keep the JSON clean.
