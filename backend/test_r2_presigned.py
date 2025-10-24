"""
Quick test: Generate presigned R2 URL for direct access testing
Run: python test_r2_presigned.py
"""
import boto3
import os

# R2 credentials
R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID', '66f906f29f28b08ae9c80d4f36e25c7a')
R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID', '9e1cf6c395172f108c2150c52878859f')
R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY', '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec')
R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'hearts-data-cache')

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

