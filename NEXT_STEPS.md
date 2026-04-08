# Next Steps

## D1 Gap Catalog Upload

Upload local gap catalog JSONs (tools/gap_catalog/*.json) to Cloudflare D1 so the app can query intervals by dataset + time range instead of shipping full catalog files.

- **Decision needed**: Use existing `study-db` or create a new D1 database (`gap-catalog-db`)?
  - Same DB is simpler (one binding), separate DB keeps study vs. catalog concerns clean
  - Create with: `cd cloudflare-worker && npx wrangler@4 d1 create gap-catalog-db`
- **Migration**: `0011_gap_catalog.sql` already written — creates `intervals` table with index on `(dataset_id, start_iso, end_iso)`
- **Upload script**: Python script to read each catalog JSON and batch-insert rows via `wrangler d1 execute`
  - ~111,559 intervals across 47 catalogs currently on disk (will grow as MMS2-4 finish)
  - MMS1 FGM Burst alone is 92,691 rows
- **API endpoint**: `/api/gaps?dataset=MMS1_FGM_BRST_L2&start=2020-01-01&end=2020-01-02`
  - Returns just the intervals in the requested time range
- **Re-upload as sharpening completes**: Run upload script again after each burst dataset finishes

## D1 Keep-Alive (Cron Trigger)

Cloudflare Worker cold starts take ~1.15s. Add a cron trigger to ping the worker every 30s so it stays warm.

- Add to `wrangler.toml`:
  ```toml
  [triggers]
  crons = ["* * * * *"]  # every minute (minimum cron resolution)
  ```
  Note: Cloudflare cron minimum is 1 minute, not 30s. 1,440 invocations/day = 1.4% of free tier.
- Add a handler in the worker for the `scheduled` event that does a lightweight D1 query to keep the connection warm
- Cost: zero (well within free tier)
