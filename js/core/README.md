# Core System Architecture

## 🔥 Two-Tier Beta-Proof Architecture

This directory contains the **core system** - bulletproof code that always loads and works, even when the main application breaks.

## Why This Exists

**Beta testing = bugs will happen.** When syntax errors or runtime crashes occur in the main app:
- ❌ Without core: White screen of death
- ✅ With core: "Interface overheated" + flame effect + error reporting

## Architecture

```
index.html
├── CORE (loads first) ← THIS DIRECTORY
│   ├── flame-engine.js     # Pink noise + oscilloscope flames
│   └── error-system.js     # Error detection + reporting
│
└── APP (loads second) ← Might break during beta
    └── main.js → everything else
```

## Files

### `oscilloscope-renderer.js`
**Pure canvas rendering - the flames themselves**
- Real-time waveform visualization
- Canvas-based flame effect
- Panel glow effects (fire-like intensity)
- Zero dependencies, pure rendering
- ~380 lines of bulletproof rendering code

**Key functions:**
```javascript
initOscilloscope()           // Initialize canvas + rendering loop
addOscilloscopeData(samples) // Feed audio samples
setErrorMode(enabled)        // Dial flames way up
```

### `flame-engine.js`
**Pink noise generator + oscilloscope driver**
- Generates pink noise using Web Audio API
- Imports oscilloscope directly (core → core)
- Feeds pink noise to oscilloscope
- Manages overheat mode state

**Key function:**
```javascript
enterOverheatMode() // Cranks flames to max
```

### `error-system.js`
**Catches errors before they kill the app**
- Captures console logs
- Detects critical errors (SyntaxError, TypeError, etc.)
- Shows "overheated" message
- Submits error reports to backend
- Disables broken UI buttons

**Key function:**
```javascript
handleCriticalError(message, details) // Triggers overheat mode
```

## How It Works

### 1. Core Loads First (index.html)
```html
<!-- CORE: Always works -->
<script type="module">
  import { initFlameEngine } from './js/core/flame-engine.js';
  import { initErrorSystem } from './js/core/error-system.js';
  
  const flame = initFlameEngine();
  const errorSystem = initErrorSystem(flame);
  
  window.enterOverheatMode = () => flame.enterOverheatMode();
</script>

<!-- APP: Might break -->
<script type="module" src="js/main.js"></script>
```

### 2. Error Occurs in App Layer
```javascript
// In tutorial-sequence.js (line 343)
const sliderValueToSpeed = ... // OOPS: Duplicate declaration!
```

### 3. Core Catches It
```javascript
// error-system.js
window.onerror = (message, source, lineno, colno, error) => {
  if (isCriticalError(error)) {
    handleCriticalError(message, {...});
    // → Shows "overheated" message
    // → Triggers flame engine
    // → Reports to backend
  }
};
```

### 4. User Sees Beautiful Failure 🔥
- Background warms to red gradient ✅
- **Oscilloscope flames KEEP BLAZING** ✅ (core is immortal!)
- Panel glow intensifies ✅
- Status: "The interface has overheated..." ✅
- Error reported automatically ✅
- UI buttons disabled ✅

**The flames survive because oscilloscope is in core!**

## Integration with App Layer

### Oscilloscope Renderer
**NOW IN CORE!** 🔥
```javascript
// flame-engine.js imports directly:
import { initOscilloscope, addOscilloscopeData, setErrorMode } from './oscilloscope-renderer.js';

// No window globals needed - core imports core!
```

The app layer (`js/oscilloscope-renderer.js`) still exists for normal playback, but core has its own copy that always works.

### Qualtrics API
```javascript
// qualtrics-api.js exposes globally:
window.qualtricsAPI = {
  getParticipantId: () => {...}
};
```

Core error-system accesses this (fails gracefully if unavailable).

## Testing

### Test Overheat Mode
Open console and run:
```javascript
window.enterOverheatMode()
// → Background warms, flames crank up

window.exitOverheatMode()
// → Returns to normal
```

### Simulate Syntax Error
Add a duplicate declaration anywhere in the app layer:
```javascript
// In any app file (tutorial-sequence.js, main.js, etc.)
const test = 1;
const test = 2; // Syntax error!
```

Reload → Core catches it → Overheat mode activates

## Rules for Core Files

✅ **DO:**
- Keep code simple and standalone
- Use pure Web Audio API, no dependencies
- Fail gracefully (try/catch everything)
- Log errors but keep running
- Core can import other core files (`./` within core/)
- Check DOM elements exist before accessing

❌ **DON'T:**
- Import from app layer (`../` files outside core/)
- Depend on app state or modules
- Use complex logic that might break
- Assume DOM elements exist without checking

## Maintenance

**Core code should be rock solid:**
- ~680 lines total (oscilloscope-renderer.js + flame-engine.js + error-system.js)
- Zero dependencies on app code
- Oscilloscope is pure canvas rendering (can't break)
- Heavily tested before deployment
- Changes reviewed carefully

**If you modify core:**
1. Test overheat mode manually (`window.enterOverheatMode()`)
2. Verify flames appear (oscilloscope canvas should show waveforms)
3. Simulate errors in app layer (add syntax error)
4. Verify flames KEEP BLAZING even when app crashes 🔥
5. Check console for core errors (there shouldn't be any!)
6. Verify error reporting works

## Benefits for Beta

✅ Errors don't kill the interface  
✅ Users see "overheated" (fits volcano theme)  
✅ Error reports still submit  
✅ Participant ID preserved  
✅ Better UX than white screen  
✅ You get full error logs

## Debugging

### Check Core Loaded
```javascript
console.log(window.enterOverheatMode); // Should be function
console.log(window.coreErrorSystem); // Should be object
```

### Check App Integration
```javascript
console.log(window.oscilloscopeRenderer); // Should have setErrorMode
console.log(window.qualtricsAPI); // Should have getParticipantId
```

### Force Error Report
```javascript
window.coreErrorSystem.reportError('Test error', {
  source: 'manual-test',
  lineno: 0,
  colno: 0
});
```

---

**Built for beta testing where bugs are expected and beautiful failure modes matter.** 🌋🔥

