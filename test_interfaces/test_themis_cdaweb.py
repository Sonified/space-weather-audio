#!/usr/bin/env python3
"""
Test script for THEMIS SCM data via CDAWeb audio API
Validates that we can fetch audio files from all 5 THEMIS spacecraft
"""

import requests
import json
from datetime import datetime

CDASWS_BASE_URL = 'https://cdaweb.gsfc.nasa.gov/WS/cdasr/1'
DATAVIEW = 'sp_phys'

# THEMIS SCM datasets and their variables
THEMIS_DATASETS = {
    'THA_L2_SCM': {'var': 'tha_scf_gse', 'name': 'THEMIS-A'},
    'THB_L2_SCM': {'var': 'thb_scf_gse', 'name': 'THEMIS-B'},
    'THC_L2_SCM': {'var': 'thc_scf_gse', 'name': 'THEMIS-C'},
    'THD_L2_SCM': {'var': 'thd_scf_gse', 'name': 'THEMIS-D'},
    'THE_L2_SCM': {'var': 'the_scf_gse', 'name': 'THEMIS-E'},
}

def test_themis_audio(dataset, variable, start_time, end_time):
    """
    Test fetching audio from a THEMIS dataset
    Returns dict with success status and details
    """
    # Convert to basic ISO 8601 format (no dashes, no colons)
    start_basic = start_time.replace('-', '').replace(':', '')
    end_basic = end_time.replace('-', '').replace(':', '')

    url = f"{CDASWS_BASE_URL}/dataviews/{DATAVIEW}/datasets/{dataset}/data/{start_basic},{end_basic}/{variable}?format=audio"

    print(f"\n{'='*60}")
    print(f"Testing: {dataset} ({THEMIS_DATASETS[dataset]['name']})")
    print(f"Variable: {variable}")
    print(f"Time range: {start_time} to {end_time}")
    print(f"URL: {url}")

    try:
        response = requests.get(url, headers={'Accept': 'application/json'}, timeout=60)

        if response.status_code != 200:
            print(f"❌ HTTP Error: {response.status_code}")
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
            print(f"❌ Failed: {error_msg}")
            return {'success': False, 'error': error_msg}

        files = data['FileDescription']
        print(f"✅ Success! Got {len(files)} audio file(s)")

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
        print(f"❌ Timeout after 60 seconds")
        return {'success': False, 'error': 'Timeout'}
    except Exception as e:
        print(f"❌ Error: {str(e)}")
        return {'success': False, 'error': str(e)}


def main():
    print("🛰️ THEMIS SCM CDAWeb Audio API Test")
    print("="*60)

    # Test parameters - 6 hour window on a date with good coverage
    # Using Nov 2023 which should have data for B, C, D
    # Using 2020 for A (which has older coverage)

    test_cases = [
        # THB, THC, THD - use recent date (Nov 2023)
        ('THB_L2_SCM', '2023-11-15T00:00:00Z', '2023-11-15T06:00:00Z'),
        ('THC_L2_SCM', '2023-11-15T00:00:00Z', '2023-11-15T06:00:00Z'),
        ('THD_L2_SCM', '2023-11-15T00:00:00Z', '2023-11-15T06:00:00Z'),
        # THA - try 2020 (has coverage until Jan 2025)
        ('THA_L2_SCM', '2020-06-15T00:00:00Z', '2020-06-15T06:00:00Z'),
        # THE - try 2022 (coverage ended Apr 2023)
        ('THE_L2_SCM', '2022-06-15T00:00:00Z', '2022-06-15T06:00:00Z'),
    ]

    results = {}

    for dataset, start, end in test_cases:
        var = THEMIS_DATASETS[dataset]['var']
        result = test_themis_audio(dataset, var, start, end)
        results[dataset] = result

    # Summary
    print("\n" + "="*60)
    print("📊 SUMMARY")
    print("="*60)

    for dataset, result in results.items():
        name = THEMIS_DATASETS[dataset]['name']
        if result['success']:
            print(f"✅ {name} ({dataset}): {result['file_count']} files")
        else:
            print(f"❌ {name} ({dataset}): {result['error']}")

    # Test downloading an actual file
    print("\n" + "="*60)
    print("🎵 Testing actual WAV download...")
    print("="*60)

    # Find first successful result with files
    for dataset, result in results.items():
        if result['success'] and result.get('files'):
            first_file = result['files'][0]
            wav_url = first_file['Name']
            print(f"Downloading: {wav_url}")

            try:
                wav_response = requests.get(wav_url, timeout=30)
                if wav_response.status_code == 200:
                    size_kb = len(wav_response.content) / 1024
                    print(f"✅ Downloaded {size_kb:.1f} KB")

                    # Check WAV header
                    header = wav_response.content[:4]
                    if header == b'RIFF':
                        print("✅ Valid WAV file (RIFF header detected)")
                    else:
                        print(f"⚠️ Unexpected header: {header}")
                else:
                    print(f"❌ Download failed: HTTP {wav_response.status_code}")
            except Exception as e:
                print(f"❌ Download error: {e}")
            break


if __name__ == '__main__':
    main()
