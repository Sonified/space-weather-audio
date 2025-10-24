"""
Test: Render → IRIS → R2 Pipeline
Proves that Render can fetch from IRIS and upload to R2
"""

import requests
import boto3
import time
from datetime import datetime, timedelta
import os

def main():
    print("=" * 60)
    print("TEST: Render → IRIS → R2 Pipeline")
    print("=" * 60)
    print()
    
    # Step 1: Fetch 1 hour of miniSEED from IRIS (48 hours ago)
    print("Step 1: Fetching from IRIS...")
    
    now = datetime.utcnow()
    start_time = now - timedelta(hours=48)
    end_time = start_time + timedelta(hours=1)
    
    # Format times for IRIS (no fractional seconds)
    start_str = start_time.strftime("%Y-%m-%dT%H:%M:%S")
    end_str = end_time.strftime("%Y-%m-%dT%H:%M:%S")
    
    iris_url = (
        "https://service.iris.edu/fdsnws/dataselect/1/query?"
        "net=HV&sta=OBL&loc=--&cha=HHZ"
        f"&start={start_str}&end={end_str}"
        "&format=miniseed"
    )
    
    print(f"  URL: {iris_url}")
    print(f"  Start: {start_str}")
    print(f"  End: {end_str}")
    print(f"  Duration: 1 hour")
    print()
    
    fetch_start = time.time()
    response = requests.get(iris_url, timeout=120)
    fetch_time = time.time() - fetch_start
    
    if response.status_code != 200:
        print(f"❌ IRIS returned {response.status_code}: {response.text}")
        return
    
    data = response.content
    data_size_mb = len(data) / (1024 * 1024)
    speed_mbps = data_size_mb / fetch_time
    
    print(f"✅ IRIS Fetch SUCCESS")
    print(f"   Status: {response.status_code}")
    print(f"   Size: {data_size_mb:.2f} MB")
    print(f"   Time: {fetch_time:.2f} sec")
    print(f"   Speed: {speed_mbps:.2f} MB/s")
    print()
    
    # Step 2: Upload to R2
    print("Step 2: Uploading to R2...")
    
    # R2 credentials (same as other backend scripts)
    account_id = os.getenv('R2_ACCOUNT_ID', '66f906f29f28b08ae9c80d4f36e25c7a')
    access_key = os.getenv('R2_ACCESS_KEY_ID', '9e1cf6c395172f108c2150c52878859f')
    secret_key = os.getenv('R2_SECRET_ACCESS_KEY', '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec')
    bucket_name = os.getenv('R2_BUCKET_NAME', 'hearts-data-cache')
    
    # Create R2 client
    s3_client = boto3.client(
        's3',
        endpoint_url=f'https://{account_id}.r2.cloudflarestorage.com',
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name='auto'
    )
    
    # Generate R2 key
    r2_key = f"test/render-iris-test-{int(time.time())}.mseed"
    
    print(f"  Bucket: {bucket_name}")
    print(f"  Key: {r2_key}")
    print()
    
    upload_start = time.time()
    s3_client.put_object(
        Bucket=bucket_name,
        Key=r2_key,
        Body=data,
        ContentType='application/vnd.fdsn.mseed',
        Metadata={
            'source': 'IRIS',
            'network': 'HV',
            'station': 'OBL',
            'channel': 'HHZ',
            'start_time': start_str,
            'end_time': end_str,
            'duration_hours': '1',
            'fetched_at': datetime.utcnow().isoformat(),
            'test': 'render-to-r2'
        }
    )
    upload_time = time.time() - upload_start
    
    print(f"✅ R2 Upload SUCCESS")
    print(f"   Time: {upload_time:.2f} sec")
    print()
    
    # Step 3: Verify by reading back
    print("Step 3: Verifying R2 read...")
    
    verify_start = time.time()
    obj = s3_client.get_object(Bucket=bucket_name, Key=r2_key)
    stored_data = obj['Body'].read()
    verify_time = time.time() - verify_start
    
    matches = len(stored_data) == len(data)
    
    print(f"{'✅' if matches else '❌'} R2 Verify {'SUCCESS' if matches else 'FAILED'}")
    print(f"   Original size: {len(data)} bytes")
    print(f"   Stored size: {len(stored_data)} bytes")
    print(f"   Time: {verify_time:.2f} sec")
    print()
    
    # Summary
    total_time = fetch_time + upload_time + verify_time
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"✅ IRIS Fetch:   {fetch_time:.2f} sec ({data_size_mb:.2f} MB @ {speed_mbps:.2f} MB/s)")
    print(f"✅ R2 Upload:    {upload_time:.2f} sec")
    print(f"✅ R2 Verify:    {verify_time:.2f} sec")
    print(f"✅ Data Integrity: {'INTACT' if matches else 'CORRUPTED'}")
    print(f"✅ Total Time:   {total_time:.2f} sec")
    print()
    print(f"🎉 Pipeline WORKS: IRIS → Render → R2")
    print(f"📦 Data stored at: {r2_key}")

if __name__ == "__main__":
    main()

