#!/usr/bin/env python3
"""
Test script for Solar Orbiter MAG data via CDAWeb audio API
Validates that we can fetch audio files from Solar Orbiter magnetometer
"""

import requests
import json
from datetime import datetime

CDASWS_BASE_URL = 'https://cdaweb.gsfc.nasa.gov/WS/cdasr/1'
DATAVIEW = 'sp_phys'

# Solar Orbiter MAG datasets
SOLO_DATASETS = {
    'SOLO_L2_MAG-RTN-BURST': {'name': 'Solar Orbiter MAG Burst Mode'},
    'SOLO_L2_MAG-RTN-NORMAL': {'name': 'Solar Orbiter MAG Normal Mode'},
}


def get_dataset_variables(dataset):
    """
    Get available variables for a dataset
    """
    url = f"{CDASWS_BASE_URL}/dataviews/{DATAVIEW}/datasets/{dataset}/variables"

    print(f"\nFetching variables for {dataset}...")
    print(f"URL: {url}")

    try:
        response = requests.get(url, headers={'Accept': 'application/json'}, timeout=30)

        if response.status_code != 200:
            print(f"HTTP Error: {response.status_code}")
            return None

        data = response.json()

        if 'VariableDescription' not in data:
            print("No VariableDescription in response")
            print(f"Response: {json.dumps(data, indent=2)[:500]}")
            return None

        variables = data['VariableDescription']
        print(f"Found {len(variables)} variables:")

        # Print all variables with their details
        for var in variables:
            name = var.get('Name', 'N/A')
            short_desc = var.get('ShortDescription', '')
            long_desc = var.get('LongDescription', '')
            print(f"  - {name}")
            if short_desc:
                print(f"      Short: {short_desc}")
            if long_desc and long_desc != short_desc:
                print(f"      Long: {long_desc[:100]}...")

        return variables

    except Exception as e:
        print(f"Error: {e}")
        return None


def test_solo_audio(dataset, variable, start_time, end_time):
    """
    Test fetching audio from a Solar Orbiter dataset
    Returns dict with success status and details
    """
    # Convert to basic ISO 8601 format (no dashes, no colons)
    start_basic = start_time.replace('-', '').replace(':', '')
    end_basic = end_time.replace('-', '').replace(':', '')

    url = f"{CDASWS_BASE_URL}/dataviews/{DATAVIEW}/datasets/{dataset}/data/{start_basic},{end_basic}/{variable}?format=audio"

    print(f"\n{'='*60}")
    print(f"Testing: {dataset}")
    print(f"Variable: {variable}")
    print(f"Time range: {start_time} to {end_time}")
    print(f"URL: {url}")

    try:
        response = requests.get(url, headers={'Accept': 'application/json'}, timeout=60)

        if response.status_code != 200:
            print(f"HTTP Error: {response.status_code}")
            return {'success': False, 'error': f'HTTP {response.status_code}'}

        data = response.json()

        # Check for FileDescription array
        if 'FileDescription' not in data or len(data['FileDescription']) == 0:
            # Check for error status
            status_msgs = []
            if 'Status' in data:
                statuses = data['Status'] if isinstance(data['Status'], list) else [data['Status']]
                for s in statuses:
                    if 'Message' in s:
                        status_msgs.append(s['Message'])

            error_msg = '; '.join(status_msgs) if status_msgs else 'No audio files returned'
            print(f"Failed: {error_msg}")
            return {'success': False, 'error': error_msg}

        files = data['FileDescription']
        print(f"Success! Got {len(files)} audio file(s)")

        for i, f in enumerate(files):
            size_kb = f.get('Length', 0) / 1024
            print(f"   [{i}] {f.get('Name', 'N/A')}")
            print(f"       Size: {size_kb:.1f} KB, Type: {f.get('MimeType', 'N/A')}")

        return {
            'success': True,
            'file_count': len(files),
            'files': files
        }

    except requests.exceptions.Timeout:
        print(f"Timeout after 60 seconds")
        return {'success': False, 'error': 'Timeout'}
    except Exception as e:
        print(f"Error: {str(e)}")
        return {'success': False, 'error': str(e)}


def main():
    print("Solar Orbiter MAG CDAWeb API Test")
    print("="*60)

    # Step 1: Get available variables for each dataset
    print("\n" + "="*60)
    print("STEP 1: Discovering available variables")
    print("="*60)

    dataset_vars = {}
    for dataset in SOLO_DATASETS:
        vars = get_dataset_variables(dataset)
        if vars:
            dataset_vars[dataset] = vars

    # Step 2: Try to get audio for the B_RTN vector field
    # Based on typical naming, the magnetic field vector is likely B_RTN
    print("\n" + "="*60)
    print("STEP 2: Testing audio API access")
    print("="*60)

    # Test parameters - using a date in the middle of the available range
    # Available: 2020/04/15 - 2025/07/31
    test_cases = [
        # Try Normal mode first (more continuous data expected)
        ('SOLO_L2_MAG-RTN-NORMAL', 'B_RTN', '2023-06-15T00:00:00Z', '2023-06-15T06:00:00Z'),
        # Then try Burst mode
        ('SOLO_L2_MAG-RTN-BURST', 'B_RTN', '2023-06-15T00:00:00Z', '2023-06-15T06:00:00Z'),
    ]

    results = {}

    for dataset, var, start, end in test_cases:
        result = test_solo_audio(dataset, var, start, end)
        results[f"{dataset}:{var}"] = result

    # Summary
    print("\n" + "="*60)
    print("SUMMARY")
    print("="*60)

    for key, result in results.items():
        if result['success']:
            print(f"OK {key}: {result['file_count']} files")
        else:
            print(f"FAIL {key}: {result['error']}")

    # Test downloading an actual file if any succeeded
    for key, result in results.items():
        if result['success'] and result.get('files'):
            print("\n" + "="*60)
            print("Testing actual WAV download...")
            print("="*60)

            first_file = result['files'][0]
            wav_url = first_file['Name']
            print(f"Downloading: {wav_url}")

            try:
                wav_response = requests.get(wav_url, timeout=30)
                if wav_response.status_code == 200:
                    size_kb = len(wav_response.content) / 1024
                    print(f"Downloaded {size_kb:.1f} KB")

                    # Check WAV header
                    header = wav_response.content[:4]
                    if header == b'RIFF':
                        print("Valid WAV file (RIFF header detected)")
                    else:
                        print(f"Unexpected header: {header}")
                else:
                    print(f"Download failed: HTTP {wav_response.status_code}")
            except Exception as e:
                print(f"Download error: {e}")
            break


if __name__ == '__main__':
    main()
