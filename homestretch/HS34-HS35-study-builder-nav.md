# HS34 & HS35 — Study Builder Navigation Investigation

## Current Top Panel Layout (Lines 1630–1700)

The header panel (`.header-panel`) contains:
1. **Study Name** input (`#studyNameInput`) — line 1639
2. **URL Tag** input (`#urlTagInput`) — line 1646
3. **Live/Local URL** previews with copy/open buttons — lines 1651–1675
4. **Admin Key** input — line 1678
5. **Actions row** (`.header-actions`) — lines 1693–1700:
   - `#studyPicker` — a `<select>` dropdown (hidden by default, shown when studies exist in IndexedDB)
   - **File** dropdown menu (Load JSON, Load from server, Save JSON, Save as NEW, Save to server, Save as NEW to server)
   - Copy Study JSON button
   - Preview button
   - Data Viewer button
   - Save indicator

## How Studies Are Identified & Loaded

### Identification
- **Slug** (URL tag): the primary identifier, derived from study name via `nameToSlug()` (line 4757) — lowercase alphanumeric + hyphens, max 60 chars
- Used as: D1 primary key (`studies.id`), IndexedDB keyPath (`slug`), URL parameter (`?s=slug`)
- Config JSON stored with `slug` property inside the config object itself

### Loading Flow (lines 2459–2490)
1. **Synchronous restore**: `localStorage.getItem('study_builder_config')` parsed immediately before first paint — sets name/slug fields
2. **Study picker**: `localStorage.getItem('study_builder_picker')` restored synchronously to populate the dropdown
3. **Full init**: `window._pendingConfig` loaded via `loadConfigIntoBuilder()` once all functions are defined
4. **Fallback**: IndexedDB checked if localStorage empty (line 4921+)

### Saving Flow (`saveDraft()`, line 4570)
1. `collectStudyConfig()` gathers all UI state into a config object
2. Saves to **localStorage** (`study_builder_config` key — single study only)
3. Saves to **IndexedDB** (keyed by slug — multiple studies)
4. Saves to **D1** via `PUT /api/study/{slug}/config` (fire-and-forget)
5. Calls `refreshStudyPicker()` to update the dropdown

### Study Picker (`#studyPicker`, line 1679)
- A `<select>` element populated from IndexedDB via `indexdbList()` (line 4548)
- `switchStudy(slug)` loads from IndexedDB → `loadConfigIntoBuilder()` (line 7163)
- Cached in localStorage as `study_builder_picker` for instant restore

## API Endpoints (cloudflare-worker/src/index.js)

### Existing
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/studies` | GET | List all studies (id, name, updated_at, participant_count) — line 610 |
| `/api/study/:id/config` | GET | Load study config |
| `/api/study/:id/config` | PUT | Save/create study config |
| `/api/study/:id/snapshot` | POST | Save frozen config snapshot to R2 |
| `/api/study/:id/snapshot` | GET | List all snapshots |
| `/api/study/:id/sessions` | GET | List all sessions for a study |

### Missing for HS34/HS35
- **No clone endpoint** — would need `POST /api/study/:id/clone` (or just client-side: GET config → change slug → PUT new)
- **No template CRUD** — no template table, no endpoints
- **`GET /api/studies`** already exists and is sufficient for a "recently viewed" list from server

## Study Config Structure

The config object (from `collectStudyConfig()`, line 4264) contains:
```js
{
  slug: "emic-pilot",
  name: "EMIC Wave Study",
  steps: [...],           // array of step objects (info, question, analysis, registration)
  conditions: [...],      // experimental conditions
  randomization: {...},   // assignment method, healing block settings
  returningParticipant: {...},
  appSettings: {...},     // playback, feature drawing, UI settings
  updatedAt: "ISO string"
}
```

## Proposed Design: HS34 — Recently Viewed Dropdown

### Data Source: Hybrid (localStorage + API)
- **Primary**: IndexedDB already stores all studies the builder has touched — `indexdbList()` returns them all
- **Supplement**: `GET /api/studies` returns server-side list with participant counts
- **History tracking**: Add a `localStorage` key `study_builder_history` — array of `{slug, name, lastOpened: timestamp}`, capped at 20 entries. Updated on every `loadConfigIntoBuilder()` call.

### UI Design
**Replace the current `<select>` (`#studyPicker`) with a styled dropdown button:**

```
[📂 Recent Studies ▾]
```

Dropdown shows:
- Recent studies sorted by last-opened time
- Each row: study name, slug (muted), relative time ("2h ago"), participant count badge
- Current study highlighted
- Click to switch
- Footer: "Load from server..." link (for studies not in local history)

### Implementation
- Extend `loadConfigIntoBuilder()` to push to history array in localStorage
- New `renderRecentDropdown()` function
- Reuse existing `.file-menu` / `.dropdown-item` styling patterns (already established in File menu)
- ~150 lines of JS, ~30 lines of CSS

### Complexity: **Low-Medium** (~2-3 hours)
The study picker already exists; this is upgrading it from a `<select>` to a richer dropdown with history tracking.

## Proposed Design: HS35 — New Study Flow

### UI: Dropdown Menu (not modal)
A new button in the header actions row:

```
[+ New Study ▾]
```

Dropdown with three options:

#### 1. Start Fresh
- Clears all fields, generates blank config
- Prompts for study name (inline in dropdown or small modal)
- Generates slug from name
- Calls `loadConfigIntoBuilder(blankConfig)`

#### 2. Clone This Study
- Calls `collectStudyConfig()` to get current config
- Deep copies the config: `JSON.parse(JSON.stringify(config))`
- Prompts for new name (pre-filled: "{current name} (copy)")
- Generates new slug from new name
- Resets runtime state:
  - `updatedAt` → now
  - No active sessions (test/live state is localStorage, not in config)
  - Participant data is separate (tied to study ID in D1) — nothing to reset
  - Snapshots are per-study — nothing carries over
- Calls `loadConfigIntoBuilder(clonedConfig)` then `saveDraft()`

#### 3. Begin From Template
- **New concept** — templates are just study configs with a `isTemplate: true` flag or stored in a separate IndexedDB store / localStorage key
- Shows a sub-menu or small modal listing available templates
- Each template: name, description, step count
- Selecting one loads the template config, prompts for new name/slug

### What "Clone" Means Technically
```js
function cloneStudy() {
  const config = collectStudyConfig();
  const clone = JSON.parse(JSON.stringify(config));
  const newName = prompt('New study name:', config.name + ' (copy)');
  if (!newName) return;
  clone.name = newName;
  clone.slug = nameToSlug(newName);
  clone.updatedAt = new Date().toISOString();
  // No need to reset anything else — participant data, sessions, snapshots
  // are all keyed by study slug in D1 and won't exist for the new slug
  loadConfigIntoBuilder(clone);
  saveDraft();
}
```

Note: `saveAsToServer()` (line 2568) already does almost exactly this! It prompts for a new name, changes slug, and saves. The "Clone" option is essentially the same flow with better UX framing.

### Template System Requirements

**Storage options (simplest first):**
1. **localStorage/IndexedDB with flag** — templates are configs with `isTemplate: true`. Stored in same IndexedDB store. `indexdbList()` filters by flag. Zero backend changes.
2. **Separate IndexedDB store** — `StudyBuilderDB.templates`. Clean separation.
3. **D1 table** — `study_templates` table. Shared across devices. Needs migration + endpoints.

**Recommendation:** Option 1 for MVP. Add a "Save as Template" option to the File menu. Templates are local-only initially; can add server sync later.

**Required:**
- "Save as Template" action (adds `isTemplate: true, templateName, templateDescription` to config, saves to IndexedDB)
- Template listing function (filter IndexedDB by `isTemplate`)
- Template picker UI (list in the "Begin From Template" sub-menu)
- ~100 lines JS, ~20 lines CSS

### Complexity Estimates

| Item | Effort | Notes |
|------|--------|-------|
| HS34: Recent studies dropdown | **2-3 hours** | Upgrade existing picker, add history tracking |
| HS35: New Study button + Start Fresh | **1 hour** | Simple — clear fields, prompt name |
| HS35: Clone This Study | **30 min** | `saveAsToServer()` already does 90% of this |
| HS35: Begin From Template (MVP) | **2-3 hours** | New concept, needs save/list/pick UI |
| **Total** | **~6-7 hours** | |

## Existing Patterns to Reuse

- **Dropdown menus**: `.file-menu` / `.dropdown-item` pattern (line ~95-105 CSS, File menu JS)
- **Buttons**: `.btn` class with icons
- **Tooltips**: `data-tip` attribute pattern on buttons
- **Study switching**: `switchStudy()` and `loadConfigIntoBuilder()` already handle full config swap
- **Save-as flow**: `saveAsToServer()` already prompts for name, generates slug, saves

## Summary

Both HS34 and HS35 are well-supported by existing infrastructure. The study picker, IndexedDB storage, `GET /api/studies` endpoint, and save-as flow provide most of the building blocks. The main new work is:

1. **HS34**: Replace `<select>` with a styled dropdown, add localStorage history tracking
2. **HS35**: Add "New Study" dropdown button with three options; template system is the only genuinely new concept (but MVP is ~100 lines using IndexedDB flags)
