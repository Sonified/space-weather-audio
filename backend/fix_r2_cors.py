"""
Fix R2 CORS settings to allow direct browser access
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

