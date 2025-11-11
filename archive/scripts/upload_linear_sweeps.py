#!/usr/bin/env python3
"""
Upload linear sweep test files to R2
"""

import boto3
from botocore.config import Config
import os

# R2 configuration (from backend/main.py)
R2_ACCOUNT_ID = '66f906f29f28b08ae9c80d4f36e25c7a'
R2_ACCESS_KEY_ID = '9e1cf6c395172f108c2150c52878859f'
R2_SECRET_ACCESS_KEY = '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec'
R2_BUCKET_NAME = 'hearts-data-cache'

endpoint_url = f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com'

s3 = boto3.client(
    's3',
    endpoint_url=endpoint_url,
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    region_name='auto'
)

sizes = ['small', 'medium', 'large']

for size in sizes:
    filename = f"test/linear_sweep_{size}.bin.gz"
    r2_key = f"test/linear_sweep_{size}.bin.gz"
    
    print(f"Uploading {filename} → {r2_key}...")
    
    with open(filename, 'rb') as f:
        s3.upload_fileobj(f, R2_BUCKET_NAME, r2_key)
    
    print(f"✅ Uploaded: {r2_key}")

print("\n✅ All linear sweep files uploaded to R2!")

