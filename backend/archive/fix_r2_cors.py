"""
Fix R2 CORS settings to allow direct browser access
"""
import boto3
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

s3_client = boto3.client(
    's3',
    endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    region_name='auto'
)

# Add CORS rules
cors_config = {
    'CORSRules': [
        {
            'AllowedOrigins': ['*'],  # Allow all origins (or specify your domain)
            'AllowedMethods': ['GET', 'HEAD'],
            'AllowedHeaders': ['*'],
            'ExposeHeaders': ['ETag', 'Content-Length'],
            'MaxAgeSeconds': 3600
        }
    ]
}

print(f"🔧 Adding CORS rules to {R2_BUCKET_NAME}...")
s3_client.put_bucket_cors(
    Bucket=R2_BUCKET_NAME,
    CORSConfiguration=cors_config
)

print("✅ CORS rules added!")
print("\nCORS Configuration:")
print("  Allowed Origins: *")
print("  Allowed Methods: GET, HEAD")
print("  Max Age: 3600 seconds")
print("\n🎉 Direct R2 access should now work!")

