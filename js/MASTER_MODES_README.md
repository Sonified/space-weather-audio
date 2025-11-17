# Master Modes - Quick Guide

## How to Switch Modes

### Option 1: Use the Dropdown (Recommended)
Just use the **Mode:** dropdown in the upper-left corner!
- Your selection **persists across sessions** (saved to localStorage)
- No need to edit code
- Instant switching

### Option 2: Edit Code (For Default Mode)
Open `js/master-modes.js` and change the DEFAULT_MODE:

```javascript
const DEFAULT_MODE = AppMode.DEV;  // Change to PERSONAL, DEV, or STUDY
```

**Note**: Once you use the dropdown, it overrides the code default until you clear localStorage.

## The Three Modes

### 👤 Personal Mode
```javascript
export const CURRENT_MODE = AppMode.PERSONAL;
```
- **Skips tutorial** - Dive right in
- **No surveys** - Just explore
- **Admin features enabled** - All tools available

### 🔧 Dev Mode (Current Default)
```javascript
export const CURRENT_MODE = AppMode.DEV;
```
- **Full tutorial** - Test tutorial system
- **No surveys** - Focus on development
- **Admin features enabled** - Testing tools available

### 🎓 Study Mode (For Research)
```javascript
export const CURRENT_MODE = AppMode.STUDY;
```
- **Pre-surveys** → **Tutorial** → **Analysis** → **Post-surveys** → **Submit to Qualtrics**
- Full research workflow in one flow
- Clean participant experience

## What's Already Integrated

✅ **Personal Mode** - Works now! Just change the mode and refresh.
✅ **Dev Mode** - This is your current workflow.
✅ **Study Mode** - Fully wired up! Ready to test.

## Study Mode - Full Research Workflow

Study Mode orchestrates the complete research workflow automatically:

### 📋 Workflow Sequence

**On First Visit:**
1. ✅ Participant Setup → 2. ✅ Pre-Survey → 3. ✅ Tutorial → 4. [Explore Data] → 5. Activity Level → 6. AWE-SF → 7. Post-Survey → 8. Submit to Qualtrics

**On Subsequent Visits (Same Week):**
1. ~~Participant Setup~~ (skipped) → 2. ✅ Pre-Survey → 3. ~~Tutorial~~ (skipped) → 4. [Explore Data] → 5. Activity Level → 6. ~~AWE-SF~~ (skipped) → 7. Post-Survey → 8. Submit

**On Subsequent Visits (New Week):**
1. ~~Participant Setup~~ (skipped) → 2. ✅ Pre-Survey → 3. ~~Tutorial~~ (skipped) → 4. [Explore Data] → 5. Activity Level → 6. ✅ AWE-SF (back!) → 7. Post-Survey → 8. Submit

### 🎯 What Shows When

- **Participant Setup**: First time only (persistent flag)
- **Pre-Survey**: Every session
- **Tutorial**: First time only (persistent flag)  
- **Activity Level**: Every session (after clicking Submit)
- **AWE-SF**: First time each week (weekly flag)
- **Post-Survey**: Every session (after Activity Level/AWE-SF)
- **Qualtrics Submit**: Automatic after all surveys complete

### 🧪 Testing Study Mode

1. Set mode to `AppMode.STUDY` in `master-modes.js`
2. Refresh page
3. You'll see the full workflow!
4. To test again: Open console, type `resetStudyFlags()`, then refresh

```javascript
// In browser console - resets all flags to test first-time experience
resetStudyFlags();
```

## Quick Testing

### Personal Mode
1. Set mode to `AppMode.PERSONAL` in `master-modes.js`
2. Refresh page
3. You should see: `👤 Personal Mode: Tutorial skipped, app ready!`
4. No tutorial, dive right in!

### Dev Mode (Current)
1. Set mode to `AppMode.DEV` in `master-modes.js`
2. Refresh page
3. Tutorial runs normally

### Study Mode
1. Set mode to `AppMode.STUDY` in `master-modes.js`
2. Open console, type `resetStudyFlags()` to test first-time experience
3. Refresh page
4. Full workflow runs!

## Persistence

Your mode selection is saved to `localStorage` and persists:
- ✅ Across page reloads
- ✅ Across browser sessions
- ✅ Until you change it via dropdown

To reset to code default:
```javascript
// In browser console:
localStorage.removeItem('selectedMode');
// Then refresh page
```

## Console Output

When page loads, you'll see:
```
═══════════════════════════════════════════════════════════
🎯 App Mode: PERSONAL MODE
📝 Direct app access without tutorial or surveys
───────────────────────────────────────────────────────────
Tutorial: ❌ Disabled
Pre-Surveys: ❌ Disabled
Post-Surveys: ❌ Disabled
Qualtrics: ❌ Not Required
Admin Features: ✅ Enabled
═══════════════════════════════════════════════════════════
```

This tells you exactly what's enabled in the current mode.

