#!/usr/bin/env python3
"""
Upload linear sweep test files to R2
"""

import boto3
from botocore.config import Config
import os
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# R2 Configuration - loaded from .env file (local) or Railway dashboard (production)
R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID')
R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID')
R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY')
R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME')

# Validate that all R2 credentials are present
if not all([R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME]):
    missing = []
    if not R2_ACCOUNT_ID: missing.append('R2_ACCOUNT_ID')
    if not R2_ACCESS_KEY_ID: missing.append('R2_ACCESS_KEY_ID')
    if not R2_SECRET_ACCESS_KEY: missing.append('R2_SECRET_ACCESS_KEY')
    if not R2_BUCKET_NAME: missing.append('R2_BUCKET_NAME')
    raise ValueError(f"Missing required R2 environment variables: {', '.join(missing)}")

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

