# 🛠️ Volcano Audio - Developer Guide

**Last Updated:** 2025-10-25  
**Purpose:** Backend setup, R2 uploads, testing, and debugging reference

---

## 📋 Table of Contents

1. [Quick Start](#quick-start)
2. [Backend Setup](#backend-setup)
3. [R2 Storage](#r2-storage)
4. [Running Tests](#running-tests)
5. [Debugging Tips](#debugging-tips)
6. [Common Issues](#common-issues)

---

## 🚀 Quick Start

### Prerequisites
- Python 3.8+ installed
- Git cloned repository
- Terminal/command line access

### Get Running in 3 Commands
```bash
cd backend
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
python main.py
```

Backend now running at: **http://localhost:5001**

---

## 🖥️ Backend Setup

### 1. Create Virtual Environment
```bash
cd backend
python -m venv venv
```

### 2. Activate Virtual Environment

**macOS/Linux:**
```bash
source venv/bin/activate
```

**Windows:**
```bash
venv\Scripts\activate
```

### 3. Install Dependencies
```bash
pip install -r requirements.txt
```

**Key packages:**
- `Flask` - Web server
- `flask-cors` - CORS support
- `ObsPy` - Seismic data processing
- `boto3` - AWS/R2 SDK
- `numcodecs` - Blosc compression
- `scipy` - Signal processing
- `xarray` - Array data handling

### 4. Start Backend
```bash
python main.py
```

**Console output:**
```
 * Running on http://127.0.0.1:5001
 * Running on http://192.168.1.X:5001
```

### 5. Test Backend
Open browser to: http://localhost:5001/api/stations/kilauea

Should return JSON with available stations.

---

## ☁️ R2 Storage

### Setup Credentials

**Location:** `backend/upload_to_r2.py` (lines 10-14)

```python
# R2 Configuration
ACCOUNT_ID = 'YOUR_ACCOUNT_ID'
ACCESS_KEY_ID = 'YOUR_ACCESS_KEY'
SECRET_ACCESS_KEY = 'YOUR_SECRET_KEY'
BUCKET_NAME = 'hearts-data-cache'
```

**⚠️ SECURITY NOTE:** These credentials should be in `.env` file (not committed to Git). For now, they're hardcoded for development.

### Upload Files to R2

**Basic upload:**
```bash
python backend/upload_to_r2.py
```

**Programmatic upload:**
```python
from backend.upload_to_r2 import upload_zarr_to_r2

# Upload a local zarr file
upload_zarr_to_r2(
    local_zarr_path='path/to/data.zarr',
    r2_key_prefix='kilauea/2025-10-25/'
)
```

### R2 File Structure

**Production hierarchy:**
```
/data/
  └─ {YEAR}/              # e.g., 2025
      └─ {MONTH}/         # e.g., 10 (zero-padded)
          └─ {NETWORK}/   # e.g., HV
              └─ {VOLCANO}/       # e.g., kilauea
                  └─ {STATION}/   # e.g., NPOC
                      └─ {LOCATION}/  # e.g., 01
                          └─ {CHANNEL}/   # e.g., HHZ
                              ├─ 2025-10-23.blosc
                              └─ 2025-10-23.json
```

**Example path:**
```
/data/2025/10/HV/kilauea/NPOC/01/HHZ/2025-10-23.blosc
/data/2025/10/HV/kilauea/NPOC/01/HHZ/2025-10-23.json
```

### List R2 Contents
```python
from backend.upload_to_r2 import list_r2_contents

list_r2_contents(prefix='data/2025/10/')
```

---

## 🧪 Running Tests

### Compression Benchmarks
```bash
python tests/test_zstd_levels_int32.py
```

**Output:** Compression ratios, times for Zstd levels 1-10

### Int16 vs Int32 File Sizes
```bash
python tests/test_int16_vs_int32_file_sizes.py
```

**Output:** Size comparison for normalized int16 vs raw int32

### Blosc Compression Levels
```bash
python tests/test_blosc_compression_levels.py
```

**Output:** Blosc (zstd) compression performance at various levels

### Test IRIS Connection
```bash
python tests/test_iris_connection.py
```

**Output:** Verifies connection to IRIS servers and data availability

### Test R2 Connection
```bash
python backend/test_r2_connection.py
```

**Output:** Confirms R2 credentials work and bucket is accessible

---

## 🐛 Debugging Tips

### Backend Not Starting?

**Check port 5001 is free:**
```bash
lsof -i :5001
```

**Kill process using port:**
```bash
kill -9 <PID>
```

**Use different port:**
```python
# In backend/main.py, change:
app.run(host='0.0.0.0', port=5001)  # Change to port=5002
```

### CORS Errors in Browser?

**Symptom:** Browser console shows:
```
Access to fetch at 'http://localhost:5001/...' from origin 'null' has been blocked by CORS policy
```

**Fix:** Backend already has CORS enabled. Check:
1. Backend is running (http://localhost:5001)
2. Correct URL in frontend code
3. Browser isn't blocking localhost

### ObsPy Not Finding Data?

**Common causes:**
1. Time range too recent (IRIS has ~10-15 min latency)
2. Station/channel doesn't exist
3. Network issue

**Test with known-good request:**
```python
from obspy import UTCDateTime
from obspy.clients.fdsn import Client

client = Client("IRIS")
st = client.get_waveforms(
    "HV", "NPOC", "01", "HHZ",
    UTCDateTime("2025-10-20T00:00:00"),
    UTCDateTime("2025-10-20T01:00:00")
)
print(st)  # Should show waveform data
```

### R2 Upload Failing?

**Check credentials:**
```python
import boto3

s3_client = boto3.client(
    's3',
    endpoint_url='https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com',
    aws_access_key_id='YOUR_ACCESS_KEY',
    aws_secret_access_key='YOUR_SECRET_KEY'
)

# Test connection
response = s3_client.list_buckets()
print(response)  # Should list buckets
```

**Common errors:**
- `InvalidAccessKeyId` - Wrong access key
- `SignatureDoesNotMatch` - Wrong secret key
- `NoSuchBucket` - Bucket name typo

### Compression Tests Failing?

**Ensure test data exists:**
```bash
ls tests/cache_user_latency/
# Should show: int16/, int32/, zarr/ directories
```

**Regenerate test data if missing:**
```bash
python tests/generate_test_data.py
```

---

## ⚡ Common Issues

### Issue: `ModuleNotFoundError: No module named 'obspy'`

**Solution:**
```bash
source venv/bin/activate  # Activate venv first!
pip install -r requirements.txt
```

### Issue: Slow IRIS fetches

**Cause:** Fetching too much data or IRIS is slow

**Solutions:**
1. Reduce time range (fetch 1 hour instead of 24)
2. Use historical data (48+ hours ago)
3. Check IRIS status: http://service.iris.edu/

### Issue: Memory errors with large files

**Symptom:** Python crashes with `MemoryError`

**Solution:**
- Process in smaller chunks
- Use zarr for chunked processing
- Increase system RAM or use swap

### Issue: Frontend can't reach backend

**Check:**
1. Backend running? (http://localhost:5001)
2. Correct URL in HTML? (`http://localhost:5001/api/...`)
3. Browser console for errors

**Test backend directly:**
```bash
curl http://localhost:5001/api/stations/kilauea
```

---

## 📊 Performance Tips

### Speed Up Development

1. **Use cached data** - Don't fetch from IRIS repeatedly
2. **Test with small files first** - 1 hour before 24 hours
3. **Profile slow code** - Use `cProfile`:
   ```bash
   python -m cProfile -s cumulative your_script.py
   ```

### Optimize Compression

**Findings from testing:**
- **Zstd level 3** - Best balance (88ms compress, 22ms decompress)
- **Blosc level 5** - Fastest but requires multi-threading
- **Gzip** - Avoid (10x slower than Zstd)

### Reduce File Sizes

1. **Use int16 if possible** - 50% smaller than int32
2. **Compress with Zstd-3** - 30% smaller than raw int16
3. **Remove unnecessary metadata** - Keep JSON minimal

---

## 🔗 External Resources

- **IRIS Documentation:** https://service.iris.edu/irisws/timeseries/docs/1/
- **ObsPy Tutorial:** https://docs.obspy.org/
- **Cloudflare R2 Docs:** https://developers.cloudflare.com/r2/
- **Web Audio API:** https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API

---

## 📝 Notes

- Always activate virtual environment before running Python scripts
- R2 credentials should eventually move to `.env` file
- Test files in `tests/` directory use real IRIS data (may be slow)
- Captain's logs in `docs/captains_logs/` have daily progress notes

---

**Need more help?** Check `dashboard.html` for quick links or ask in chat!








