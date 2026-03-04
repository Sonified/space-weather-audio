# backend/main.py - FUNCTION AUDIT

## 🎯 AUDIT GOAL
Identify which functions are relics from deprecated zarr/xarray/numcodecs compression experiments vs. which are needed for production.

---

## ✅ KEEP - Core Functions (Used by Production)

### 1. `add_cors_headers(response)`
- **Purpose**: CORS middleware for all responses
- **Used by**: All endpoints
- **Status**: ✅ **KEEP** - Essential for browser access

### 2. `load_volcano_stations()`
- **Purpose**: Loads volcano configs from JSON
- **Used by**: VOLCANOES dict initialization
- **Status**: ✅ **KEEP** - Core configuration loading

---

## 🔥 DELETE ENTIRELY - Zarr/Blosc/Old Compression Relics

### 3. `generate_cache_key(volcano, hours_ago, duration_hours)`
- **Purpose**: Creates SHA256 hash for old cache system
- **Uses**: Hash-based keys like `a3f8d92e4b1c6f0a`
- **Called by**: `ensure_cached_in_r2()`, `/api/stream`, old endpoints
- **Status**: ❌ **DELETE** - Old cache architecture, not used in production

### 4. `r2_key(cache_key, compression, storage, ext)`
- **Purpose**: Builds R2 paths for old cache: `cache/{compression}/{storage}/{hash}`
- **Used by**: `ensure_cached_in_r2()`, `stream_variant_from_r2()`
- **Status**: ❌ **DELETE** - Old cache path format

### 5. `list_zarr_chunk_keys(prefix)`
- **Purpose**: Lists zarr chunks from R2, filters `.zarray`, `.zattrs`, `.zgroup`
- **Used by**: `stream_variant_from_r2()` for zarr storage
- **Status**: ❌ **DELETE** - Zarr-specific, not used in production

### 6. `ensure_cached_in_r2(volcano, hours_ago, duration_hours, ...)`
- **Purpose**: Fetches from IRIS, creates 6 variants (int16/raw, int16/zarr, gzip/raw, gzip/zarr, blosc/raw, blosc/zarr)
- **Uses**: `Blosc`, `Zlib`, `zarr.open()` - all removed packages!
- **Called by**: Only `/api/stream/<volcano>/<int:hours>`
- **Lines**: 186-260 have zarr/blosc code that won't work without imports
- **Status**: ❌ **DELETE** - Generates deprecated cache formats

### 7. `stream_variant_from_r2(cache_key, storage, compression)`
- **Purpose**: Streams old cache variants (zarr or raw with gzip/blosc)
- **Used by**: `/api/stream/<volcano>/<int:hours>`
- **Status**: ❌ **DELETE** - Reads deprecated cache formats

---

## ❌ DELETE ENDPOINTS - Not Used by index.html

### 8. `@app.route('/')` → `home()`
- **Purpose**: Returns "Volcano Audio API - Ready"
- **Status**: ⚠️ **KEEP** - Harmless health check (but unused)

### 9. `@app.route('/api/stations/<volcano>')` → `get_stations(volcano)`
- **Purpose**: Returns available stations for a volcano within MAX_RADIUS_KM
- **Called by**: Nothing in production
- **Status**: ❌ **DELETE** - Unused endpoint

### 10. `@app.route('/api/test/<volcano>')` → `test_data(volcano)`
- **Purpose**: Test endpoint to check IRIS data availability
- **Called by**: Nothing
- **Status**: ❌ **DELETE** - Test endpoint

### 11. `@app.route('/api/audio/<volcano>/<int:hours>')` → `get_audio(volcano, hours)`
- **Purpose**: Returns WAV file (old audio endpoint)
- **Called by**: Nothing (index.html uses `/api/stream-audio`)
- **Status**: ❌ **DELETE** - Legacy audio endpoint

### 12. `@app.route('/api/zarr/<volcano>/<int:hours>')` → `get_zarr(volcano, hours)`
- **Purpose**: Returns zarr-compressed data as ZIP
- **Uses**: `xarray`, `zarr`, `numcodecs` (all removed!)
- **Lines 686-693**: Imports Blosc/Zstd/Zlib - will crash!
- **Called by**: Nothing
- **Status**: ❌ **DELETE** - Broken without removed imports

### 13. `@app.route('/api/stream/<volcano>/<int:hours>')` → `stream_zarr(volcano, hours)`
- **Purpose**: Streams zarr/gzip/blosc variants from old cache
- **Calls**: `ensure_cached_in_r2()`, `stream_variant_from_r2()`
- **Called by**: Nothing
- **Status**: ❌ **DELETE** - Uses deprecated cache system

### 14. `@app.route('/test_iris_to_r2')` → `test_iris_to_r2()`
- **Purpose**: Test endpoint for IRIS → R2 pipeline
- **Called by**: Nothing
- **Status**: ❌ **DELETE** - Test endpoint

### 15. `@app.route('/api/local-files')` → `list_local_files()`
- **Purpose**: Lists local mseed files from `../mseed_files/`
- **Called by**: Nothing
- **Status**: ❌ **DELETE** - Local dev helper

### 16. `@app.route('/api/local-file')` → `serve_local_file()`
- **Purpose**: Serves local mseed file as int16
- **Called by**: Nothing
- **Status**: ❌ **DELETE** - Local dev helper

---

## 🤔 EVALUATE - Potentially Useful (But Need Refactoring)

### 17. `@app.route('/api/request')` → `handle_request()`
- **Purpose**: IRIS → Process → Chunk → Compress (zstd) → Upload to R2
- **Path format**: `data/{year}/{month}/{network}/kilauea/{station}/{loc}/{channel}/`
- **Chunking**: 1-min (6x), 6-min (4x), 30-min (1x)
- **Uses**: `zstd` (good!), uploads to R2
- **Called by**: Possibly R2 Worker (need to check)
- **Status**: ⚠️ **EVALUATE** - Might be used by worker, uses correct zstd compression

### 18. `@app.route('/api/request-stream')` → `handle_request_stream()`
- **Purpose**: Same as `/api/request` but with SSE progress events
- **Uses**: `zstd` (good!), sends real-time progress
- **Called by**: Possibly R2 Worker (need to check)
- **Status**: ⚠️ **EVALUATE** - SSE streaming version, uses correct zstd

---

## 📊 DEPENDENCY TREE

```
DEPRECATED CHAIN:
/api/stream/<volcano>/<int:hours> (DELETE)
  └─> ensure_cached_in_r2() (DELETE)
       ├─> generate_cache_key() (DELETE)
       ├─> r2_key() (DELETE)
       └─> build_and_upload_zarr() (DELETE - uses zarr/Blosc/Zlib)
  └─> stream_variant_from_r2() (DELETE)
       ├─> r2_key() (DELETE)
       └─> list_zarr_chunk_keys() (DELETE)

/api/zarr/<volcano>/<int:hours> (DELETE)
  └─> Uses xarray, zarr, numcodecs directly (BROKEN)

POTENTIALLY USEFUL:
/api/request (EVALUATE)
  └─> Uses zstd compression ✅
  └─> Uploads to R2 with path: data/{year}/{month}/... ✅

/api/request-stream (EVALUATE)
  └─> Same as /api/request but SSE streaming ✅
```

---

## 🎯 FINAL REFACTORING PLAN

### ❌ DELETE (13 items total)

**Helper Functions (5):**
1. ❌ `generate_cache_key()` - Lines ~54-57 - Old hash-based cache
2. ❌ `r2_key()` - Lines ~59-60 - Old cache path builder  
3. ❌ `list_zarr_chunk_keys()` - Lines ~62-91 - Zarr-specific listing
4. ❌ `ensure_cached_in_r2()` - Lines ~93-260 - Creates zarr/blosc variants (BROKEN)
5. ❌ `stream_variant_from_r2()` - Lines ~262-307 - Reads zarr/blosc variants

**Endpoints (8):**
6. ❌ `/api/stations/<volcano>` → `get_stations()` - Lines ~388-464 - Unused
7. ❌ `/api/test/<volcano>` → `test_data()` - Lines ~467-508 - Test endpoint
8. ❌ `/api/audio/<volcano>/<int:hours>` → `get_audio()` - Lines ~511-566 - Legacy WAV
9. ❌ `/api/zarr/<volcano>/<int:hours>` → `get_zarr()` - Lines ~568-741 - BROKEN (uses removed imports)
10. ❌ `/api/stream/<volcano>/<int:hours>` → `stream_zarr()` - Lines ~743-838 - Deprecated cache
11. ❌ `/test_iris_to_r2` → `test_iris_to_r2()` - Lines ~843-955 - Test endpoint
12. ❌ `/api/local-files` → `list_local_files()` - Lines ~957-973 - Local dev
13. ❌ `/api/local-file` → `serve_local_file()` - Lines ~975-1027 - Local dev

### ✅ KEEP (7 items)

**Core Functions (2):**
1. ✅ `add_cors_headers()` - Lines ~24-33 - Essential CORS middleware
2. ✅ `load_volcano_stations()` - Lines ~309-382 - Config loading

**Health Check (1):**
3. ✅ `@app.route('/')` → `home()` - Lines ~384-386 - Health check

**Production Endpoints - Used by R2 Worker (2):**
4. ✅ `/api/request` → `handle_request()` - Lines ~1029-1230 - R2 Worker uses this!
5. ✅ `/api/request-stream` → `handle_request_stream()` - Lines ~1232-end - R2 Worker uses this!

**Already Separate (2):**
6. ✅ `/api/stream-audio` - In `audio_stream.py` blueprint (already clean!)
7. ✅ Audio streaming blueprint registration - Line ~23-24

---

## 🔍 INVESTIGATION COMPLETE

1. **✅ CONFIRMED**: R2 Worker calls both `/api/request` and `/api/request-stream`
   - `cloudflare-worker/src/index.js:650` → `/api/request-stream` (SSE streaming)
   - `cloudflare-worker/src/index.js:772` → `/api/request` (non-SSE fallback)

2. **Check if index.html calls anything besides `/api/stream-audio`**
   - Already confirmed: Only `/api/stream-audio` ✅

3. **After deletions, main.py should ONLY have**:
   - CORS middleware
   - Config loading
   - Audio streaming blueprint registration  
   - Maybe `/api/request` endpoints (if worker uses them)

---

## 📦 CURRENT PRODUCTION STACK

**What index.html ACTUALLY uses:**
- `index.html` → `/api/stream-audio` (from `audio_stream.py` blueprint)
  - Uses: flask, numpy, scipy, obspy, zstandard
  - No zarr, no xarray, no numcodecs, no blosc ✅

**What collector ACTUALLY uses:**
- `collector_loop.py` → R2 uploads/reads via boto3
  - Uses: flask, obspy, requests, boto3, pytz, zstandard
  - No zarr, no xarray, no numcodecs, no s3fs ✅

---

---

## 🚀 DELETION ACTION PLAN

### Step 1: Delete Helper Functions (Lines 54-307)
Delete these 5 functions entirely:
- `generate_cache_key()` 
- `r2_key()`
- `list_zarr_chunk_keys()`
- `ensure_cached_in_r2()` (BIG deletion - 168 lines!)
- `stream_variant_from_r2()`

### Step 2: Delete Unused Endpoints (8 endpoints)
Delete these endpoint functions:
- `/api/stations/<volcano>` → `get_stations()`
- `/api/test/<volcano>` → `test_data()`
- `/api/audio/<volcano>/<int:hours>` → `get_audio()`
- `/api/zarr/<volcano>/<int:hours>` → `get_zarr()` (BROKEN)
- `/api/stream/<volcano>/<int:hours>` → `stream_zarr()`
- `/test_iris_to_r2` → `test_iris_to_r2()`
- `/api/local-files` → `list_local_files()`
- `/api/local-file` → `serve_local_file()`

### Step 3: Clean Up Constants
Delete these constants (if they exist):
- `PROGRESSIVE_CHUNK_SIZES_KB`
- `REMAINING_CHUNK_KB`
- `LOCATION_FALLBACKS` (if only used by deleted endpoints)
- `VOLCANOES` dict (if only loaded by deleted endpoints)

### Step 4: Final File Structure
After cleanup, `backend/main.py` should have ONLY:
- Imports (flask, boto3, etc.)
- Constants (R2 config, MAX_RADIUS_KM if needed)
- `load_volcano_stations()` function
- CORS middleware (`add_cors_headers`)
- Blueprint registration (audio_stream_bp)
- `/` health check endpoint
- `/api/request` endpoint
- `/api/request-stream` endpoint
- `if __name__ == '__main__'` block

**Estimated lines after cleanup: ~600 lines** (down from ~1450 lines = 59% reduction!)

---

## 💡 SIMPLIFIED FUTURE ARCHITECTURE

After cleanup, `backend/main.py` should be:
```python
from flask import Flask
from audio_stream import audio_stream_bp

app = Flask(__name__)
app.register_blueprint(audio_stream_bp)

# CORS middleware
@app.after_request
def add_cors_headers(response):
    # ... CORS headers ...
    return response

# Health check
@app.route('/')
def home():
    return "Volcano Audio API - Ready"

# Only keep if worker uses them:
# @app.route('/api/request') or @app.route('/api/request-stream')

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', 5001)))
```

**That's it!** All the real work happens in `audio_stream.py` (already working) ✅

