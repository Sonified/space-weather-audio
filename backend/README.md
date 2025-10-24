# Volcano Audio Backend

Python/FastAPI backend for fetching, caching, and serving seismic audio data.

## Deployment

**Production URL**: https://volcano-audio.onrender.com

- **Platform**: Render.com
- **Auto-deploys**: From `main` branch on GitHub push
- **Directory**: `/backend`

## Endpoints

### Health Check
```bash
curl https://volcano-audio.onrender.com/
# Returns: "Volcano Audio API - Ready"
```

### Progressive Streaming Test
```bash
curl "https://volcano-audio.onrender.com/progressive_test?volcano=kilauea&hours_ago=12&duration_hours=4"
```

### Main Audio Endpoint
```bash
curl "https://volcano-audio.onrender.com/audio/{volcano}/{duration_hours}?hours_ago={hours_ago}"
```

## Running Tests

### Test IRIS → Render → R2 Pipeline
```bash
# SSH to Render or use Render Shell:
cd /opt/render/project/src/backend
python test_render_iris_to_r2.py
```

Or trigger via API (once deployed):
```bash
curl https://volcano-audio.onrender.com/test_iris_to_r2
```

## Environment Variables

Set in Render dashboard:

```bash
R2_ACCOUNT_ID=66f906f29f28b08ae9c80d4f36e25c7a
R2_ACCESS_KEY_ID=9e1cf6c395172f108c2150c52878859f
R2_SECRET_ACCESS_KEY=93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec
R2_BUCKET_NAME=hearts-data-cache
```

## Architecture

```
IRIS (seismic data)
    ↓ fetch miniSEED
Render Backend (this service)
    ↓ process & cache
Cloudflare R2 (object storage)
    ↓ serve cached data
Cloudflare Workers (edge compute)
    ↓ stream to users
Web Browser
```

## Local Development

```bash
# Install dependencies
pip install -r requirements.txt

# Run locally
cd backend
uvicorn main:app --reload --port 8000

# Test locally
curl http://localhost:8000/
```

## Dependencies

- **FastAPI**: Web framework
- **ObsPy**: Seismic data processing
- **boto3**: R2/S3 client
- **numpy/scipy**: Signal processing
- **blosc2**: Compression

See `requirements.txt` for full list.

## Files

- `main.py` - Main FastAPI application
- `progressive_test_endpoint.py` - Progressive streaming endpoint
- `test_render_iris_to_r2.py` - Test IRIS → R2 pipeline
- `test_r2_*.py` - R2 connection tests
- `upload_to_r2.py` - Manual R2 upload utility

## Notes

- **IRIS API**: Public, no authentication required
- **R2 Storage**: ~500GB free tier, ideal for caching
- **Render Free Tier**: Service sleeps after 15 min inactivity (cold start ~30s)
- **Cold Start**: First request after sleep takes longer

