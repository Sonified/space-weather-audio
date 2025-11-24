# Captain's Log - 2025-11-24

## v1.0 - Solar Portal Mode & UI Updates

### New Features
**Solar Portal Mode**
- Created new "Solar Portal" mode (☀️) with unique configuration:
  - Shows participant setup modal on first visit only
  - Permanently hides Begin Analysis button
  - Hides simulate panel at bottom
  - Enables all features (like personal mode)
  - No other study modals appear
- Added Solar Portal to mode selector dropdown
- Updated `updateCompleteButtonState()` to respect Solar Portal mode (keeps Begin Analysis hidden)
- Updated simulate panel visibility logic to hide in Solar Portal mode

### UI Improvements
- Changed "Participant ID" label to "User ID" in upper right corner
- Set simulate panel to `display: none` by default to prevent flash on load

### Default Mode Changes
- Changed default mode from DEV to PERSONAL
- Updated HTML dropdown to default to Personal mode
- Updated `DEFAULT_MODE` in `master-modes.js` to `AppMode.PERSONAL`
- Production environment now defaults to PERSONAL mode (was PRODUCTION)

### Files Modified
- `js/master-modes.js` - Added SOLAR_PORTAL mode, updated defaults
- `js/main.js` - Added `initializeSolarPortalMode()` function, updated mode initialization
- `js/region-tracker.js` - Updated `updateCompleteButtonState()` to respect Solar Portal mode
- `index.html` - Added Solar Portal to dropdown, changed Participant ID to User ID, set simulate panel default hidden

