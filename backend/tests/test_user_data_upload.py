#!/usr/bin/env python3
"""
Integration test for user data upload to R2
Tests the actual /api/upload-user-data endpoint

Run with:
    cd backend
    python tests/test_user_data_upload.py

Requirements:
    - Local collector must be running (./start_local_collector.sh)
    - Or test against production endpoint
"""

import requests
import json
import sys
from datetime import datetime
from pathlib import Path

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent.parent))

# Test configuration
USE_LOCAL = True  # Set to False to test production
LOCAL_URL = 'http://localhost:5005'
PRODUCTION_URL = 'https://volcano-audio-collector-production.up.railway.app'

BASE_URL = LOCAL_URL if USE_LOCAL else PRODUCTION_URL
UPLOAD_ENDPOINT = f'{BASE_URL}/api/upload-user-data'

# Test participant ID
TEST_PARTICIPANT_ID = f'TEST_{datetime.now().strftime("%Y%m%d_%H%M%S")}'

def print_section(title):
    """Print a formatted section header"""
    print(f"\n{'='*70}")
    print(f"  {title}")
    print(f"{'='*70}\n")

def test_upload_status_only():
    """Test uploading just status data (no submission)"""
    print_section("Test 1: Upload Status Only")
    
    payload = {
        'participantId': TEST_PARTICIPANT_ID,
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'uploadType': 'status',
        
        # Study progress
        'hasSeenParticipantSetup': True,
        'hasSeenWelcome': True,
        'hasSeenTutorial': False,
        'tutorialCompleted': False,
        
        # Session tracking
        'weeklySessionCount': 1,
        'weekStartDate': '2025-11-17',
        'lastAwesfDate': None,
        'totalSessionsStarted': 1,
        'totalSessionsCompleted': 0,
        'totalSessionTime': 0,
        'totalSessionTimeHours': 0.0,
        
        # Session history
        'sessionHistory': [],
        'currentSessionStart': datetime.utcnow().isoformat() + 'Z',
        
        # Preferences
        'selectedVolcano': 'Okmok',
        'selectedMode': 'study'
    }
    
    print("📤 Sending status-only upload...")
    print(f"   Participant ID: {TEST_PARTICIPANT_ID}")
    print(f"   Endpoint: {UPLOAD_ENDPOINT}")
    
    try:
        response = requests.post(
            UPLOAD_ENDPOINT,
            json=payload,
            headers={'Content-Type': 'application/json'},
            timeout=10
        )
        
        print(f"\n✅ Response Status: {response.status_code}")
        
        if response.status_code == 200:
            result = response.json()
            print(f"✅ Upload successful!")
            print(f"   Files uploaded: {len(result.get('filesUploaded', []))}")
            for file in result.get('filesUploaded', []):
                print(f"      - {file}")
            return True
        else:
            print(f"❌ Upload failed: {response.text}")
            return False
            
    except Exception as e:
        print(f"❌ Error: {e}")
        return False

def test_upload_with_submission():
    """Test uploading status + submission data"""
    print_section("Test 2: Upload Status + Submission Data")
    
    # Mock submission data (jsonDump from Qualtrics)
    submission_data = {
        'sessionId': 'test-session-123',
        'participantId': TEST_PARTICIPANT_ID,
        'sessionStarted': '2025-11-19T14:00:00.000Z',
        'sessionEnded': '2025-11-19T15:30:00.000Z',
        'sessionDurationMs': 5400000,
        'completedAllSurveys': True,
        'submittedToQualtrics': True,
        'sessionTimedOut': False,
        'weeklySessionCount': 1,
        'globalStats': {
            'totalSessionsStarted': 1,
            'totalSessionsCompleted': 1,
            'totalSessionTimeMs': 5400000,
            'totalSessionTimeHours': 1.5
        },
        'regions': [
            {
                'regionId': 'region-1',
                'startTime': 100.5,
                'endTime': 200.3,
                'description': 'Interesting seismic event',
                'features': [
                    {
                        'featureNumber': 1,
                        'featureType': 'Tremor',
                        'featureRepetition': 'Singular',
                        'featureStartTime': 110.2,
                        'featureEndTime': 120.5,
                        'featureNotes': 'Test feature',
                        'frequency': 'Low'
                    }
                ]
            }
        ]
    }
    
    payload = {
        'participantId': TEST_PARTICIPANT_ID,
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'uploadType': 'submission',
        'submissionData': submission_data,
        
        # Study progress
        'hasSeenParticipantSetup': True,
        'hasSeenWelcome': True,
        'hasSeenTutorial': True,
        'tutorialCompleted': True,
        
        # Session tracking
        'weeklySessionCount': 1,
        'weekStartDate': '2025-11-17',
        'totalSessionsStarted': 1,
        'totalSessionsCompleted': 1,
        'totalSessionTime': 5400000,
        'totalSessionTimeHours': 1.5,
        
        # Session history
        'sessionHistory': [
            {
                'startTime': '2025-11-19T14:00:00.000Z',
                'endTime': '2025-11-19T15:30:00.000Z',
                'duration': 5400000,
                'completedAllSurveys': True,
                'submittedToQualtrics': True
            }
        ],
        
        # Preferences
        'selectedVolcano': 'Okmok',
        'selectedMode': 'study'
    }
    
    print("📤 Sending submission upload...")
    print(f"   Participant ID: {TEST_PARTICIPANT_ID}")
    print(f"   Endpoint: {UPLOAD_ENDPOINT}")
    print(f"   Regions: {len(submission_data['regions'])}")
    print(f"   Features: {len(submission_data['regions'][0]['features'])}")
    
    try:
        response = requests.post(
            UPLOAD_ENDPOINT,
            json=payload,
            headers={'Content-Type': 'application/json'},
            timeout=10
        )
        
        print(f"\n✅ Response Status: {response.status_code}")
        
        if response.status_code == 200:
            result = response.json()
            print(f"✅ Upload successful!")
            print(f"   Files uploaded: {len(result.get('filesUploaded', []))}")
            for file in result.get('filesUploaded', []):
                print(f"      - {file}")
            
            # Verify both files were created
            files = result.get('filesUploaded', [])
            has_status = any('user-status/status.json' in f for f in files)
            has_submission = any('submissions/' in f and '_Complete_' in f for f in files)
            
            if has_status and has_submission:
                print(f"\n✅ Both files created:")
                print(f"   ✓ user-status/status.json")
                print(f"   ✓ submissions/{TEST_PARTICIPANT_ID}_Complete_*.json")
                return True
            else:
                print(f"\n⚠️  Missing files:")
                if not has_status:
                    print(f"   ✗ user-status/status.json")
                if not has_submission:
                    print(f"   ✗ submissions file")
                return False
        else:
            print(f"❌ Upload failed: {response.text}")
            return False
            
    except Exception as e:
        print(f"❌ Error: {e}")
        return False

def test_missing_participant_id():
    """Test error handling when participantId is missing"""
    print_section("Test 3: Error Handling - Missing Participant ID")
    
    payload = {
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'uploadType': 'status'
        # Missing participantId
    }
    
    print("📤 Sending request without participantId...")
    
    try:
        response = requests.post(
            UPLOAD_ENDPOINT,
            json=payload,
            headers={'Content-Type': 'application/json'},
            timeout=10
        )
        
        print(f"✅ Response Status: {response.status_code}")
        
        if response.status_code == 400:
            print(f"✅ Correctly rejected with 400 Bad Request")
            print(f"   Error: {response.json().get('error')}")
            return True
        else:
            print(f"⚠️  Expected 400, got {response.status_code}")
            return False
            
    except Exception as e:
        print(f"❌ Error: {e}")
        return False

def verify_r2_files():
    """Attempt to verify files exist in R2 (requires boto3 and credentials)"""
    print_section("Test 4: Verify Files in R2")
    
    try:
        import boto3
        import os
        from dotenv import load_dotenv
        
        # Load .env
        env_path = Path(__file__).parent.parent / '.env'
        load_dotenv(env_path)
        
        # Get R2 credentials
        R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID')
        R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID')
        R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY')
        R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME')
        
        if not all([R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME]):
            print("⚠️  R2 credentials not found - skipping R2 verification")
            return None
        
        # Create S3 client
        s3 = boto3.client(
            's3',
            endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
            aws_access_key_id=R2_ACCESS_KEY_ID,
            aws_secret_access_key=R2_SECRET_ACCESS_KEY,
            region_name='auto'
        )
        
        print(f"🔍 Checking R2 bucket for participant: {TEST_PARTICIPANT_ID}")
        
        # List files for test participant
        prefix = f'volcano-audio-anonymized-data/participants/{TEST_PARTICIPANT_ID}/'
        response = s3.list_objects_v2(
            Bucket=R2_BUCKET_NAME,
            Prefix=prefix
        )
        
        if 'Contents' in response:
            print(f"✅ Found {len(response['Contents'])} file(s) in R2:")
            for obj in response['Contents']:
                key = obj['Key']
                size = obj['Size']
                print(f"   - {key} ({size} bytes)")
            return True
        else:
            print(f"⚠️  No files found for {TEST_PARTICIPANT_ID}")
            return False
            
    except ImportError:
        print("⚠️  boto3 not available - skipping R2 verification")
        return None
    except Exception as e:
        print(f"⚠️  Could not verify R2 files: {e}")
        return None

def main():
    """Run all tests"""
    print("\n" + "="*70)
    print("  USER DATA UPLOAD TO R2 - INTEGRATION TEST")
    print("="*70)
    print(f"\n📍 Testing against: {BASE_URL}")
    print(f"🆔 Test Participant ID: {TEST_PARTICIPANT_ID}")
    
    # Check if server is accessible
    try:
        health_response = requests.get(f'{BASE_URL}/health', timeout=5)
        if health_response.status_code == 200:
            health = health_response.json()
            print(f"✅ Server is healthy")
            print(f"   Version: {health.get('version', 'unknown')}")
            print(f"   Uptime: {health.get('uptime_seconds', 0):.1f}s")
        else:
            print(f"⚠️  Server returned {health_response.status_code}")
    except Exception as e:
        print(f"❌ Cannot connect to server: {e}")
        print(f"\n💡 Make sure the collector is running:")
        print(f"   cd backend && ./start_local_collector.sh")
        return
    
    # Run tests
    results = []
    
    results.append(('Upload Status Only', test_upload_status_only()))
    results.append(('Upload with Submission', test_upload_with_submission()))
    results.append(('Error Handling', test_missing_participant_id()))
    
    r2_result = verify_r2_files()
    if r2_result is not None:
        results.append(('Verify R2 Files', r2_result))
    
    # Summary
    print_section("Test Summary")
    
    passed = sum(1 for _, result in results if result)
    total = len(results)
    
    for test_name, result in results:
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{status} - {test_name}")
    
    print(f"\n{'='*70}")
    print(f"  {passed}/{total} tests passed")
    print(f"{'='*70}\n")
    
    if passed == total:
        print("🎉 All tests passed!")
        print(f"\n📂 Check R2 bucket for files:")
        print(f"   volcano-audio-anonymized-data/participants/{TEST_PARTICIPANT_ID}/")
        print(f"      ├── user-status/status.json")
        print(f"      └── submissions/{TEST_PARTICIPANT_ID}_Complete_*.json")
    else:
        print("⚠️  Some tests failed - check output above")
        sys.exit(1)

if __name__ == '__main__':
    main()

