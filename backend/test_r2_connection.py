#!/usr/bin/env python3
"""
Test script to verify R2 storage connection
"""
import boto3
import os
from botocore.exceptions import ClientError

def test_r2_connection():
    """Test connection to Cloudflare R2 storage"""
    
    # You'll need to set these environment variables or replace with your actual credentials
    # Get them from: https://dash.cloudflare.com/ > R2 > Overview (Account ID is in the URL)
    ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID', '66f906f29f28b08ae9c80d4f36e25c7a')
    ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID', '9e1cf6c395172f108c2150c52878859f')
    SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY', '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec')
    BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'hearts-data-cache')  # Your bucket name
    
    # Cloudflare R2 endpoint format
    endpoint_url = f'https://{ACCOUNT_ID}.r2.cloudflarestorage.com'
    
    print("🔗 Testing R2 Connection...")
    print(f"   Endpoint: {endpoint_url}")
    print(f"   Bucket: {BUCKET_NAME}")
    print()
    
    try:
        # Create S3 client configured for R2
        s3_client = boto3.client(
            's3',
            endpoint_url=endpoint_url,
            aws_access_key_id=ACCESS_KEY_ID,
            aws_secret_access_key=SECRET_ACCESS_KEY,
            region_name='auto'  # R2 uses 'auto' for region
        )
        
        # Test 1: List objects in bucket (skip bucket listing - requires admin permissions)
        print(f"✅ Test 1: Listing objects in bucket '{BUCKET_NAME}'...")
        print(f"   (Note: Skipping bucket listing - Object Read & Write token doesn't need admin permissions)")
        print()
        response = s3_client.list_objects_v2(Bucket=BUCKET_NAME, MaxKeys=10)
        
        if 'Contents' in response:
            print(f"   Found {response['KeyCount']} object(s) (showing first 10):")
            for obj in response.get('Contents', [])[:10]:
                size_mb = obj['Size'] / (1024 * 1024)
                print(f"     - {obj['Key']} ({size_mb:.2f} MB)")
        else:
            print(f"   Bucket is empty or no objects found")
        print()
        
        # Test 2: Try to download a specific file (if it exists)
        print("✅ Test 2: Testing file download (if available)...")
        test_key = 'test.txt'  # Replace with an actual file key if you have one
        try:
            response = s3_client.get_object(Bucket=BUCKET_NAME, Key=test_key)
            content = response['Body'].read()
            print(f"   ✓ Successfully downloaded '{test_key}' ({len(content)} bytes)")
        except ClientError as e:
            if e.response['Error']['Code'] == 'NoSuchKey':
                print(f"   ⚠️  File '{test_key}' not found (this is OK if you haven't uploaded it yet)")
            else:
                raise
        print()
        
        print("=" * 60)
        print("🎉 R2 CONNECTION SUCCESSFUL!")
        print("=" * 60)
        return True
        
    except ClientError as e:
        error_code = e.response['Error']['Code']
        error_message = e.response['Error']['Message']
        print(f"❌ Error: {error_code} - {error_message}")
        print()
        print("Common issues:")
        print("  - Check your Account ID, Access Key, and Secret Key")
        print("  - Verify the bucket name is correct")
        print("  - Make sure your R2 API token has the right permissions")
        return False
    
    except Exception as e:
        print(f"❌ Unexpected error: {e}")
        return False


if __name__ == '__main__':
    print()
    print("=" * 60)
    print("CLOUDFLARE R2 CONNECTION TEST")
    print("=" * 60)
    print()
    print("To use this script, set these environment variables:")
    print("  export R2_ACCOUNT_ID='your_account_id'")
    print("  export R2_ACCESS_KEY_ID='your_access_key'")
    print("  export R2_SECRET_ACCESS_KEY='your_secret_key'")
    print("  export R2_BUCKET_NAME='your_bucket_name'")
    print()
    print("Or edit the script to hardcode them temporarily.")
    print()
    
    success = test_r2_connection()
    
    if success:
        print()
        print("Next steps:")
        print("  1. ✅ R2 connection works!")
        print("  2. Upload some zarr files to test with")
        print("  3. Integrate R2 into your Flask backend")
    else:
        print()
        print("Fix the connection issues above, then try again.")

