"""
Quick test: Generate presigned R2 URL for direct access testing
Run: python test_r2_presigned.py
"""
import boto3
import os

# Load environment variables from .env file
from dotenv import load_dotenv
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

s3_client = boto3.client(
    's3',
    endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    region_name='auto'
)

# Generate presigned URL (valid for 1 hour)
cache_key = 'a3a4bd3499c23245'  # Your cached Kilauea data
r2_key = f'cache/int16/raw/{cache_key}.bin'

presigned_url = s3_client.generate_presigned_url(
    'get_object',
    Params={'Bucket': R2_BUCKET_NAME, 'Key': r2_key},
    ExpiresIn=3600
)

print("🔗 Presigned R2 URL (valid for 1 hour):")
print(presigned_url)
print("\n📝 Copy this URL into test_direct_r2.html (line 20)")

