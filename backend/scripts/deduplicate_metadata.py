#!/usr/bin/env python3
"""
Metadata Deduplication Script

Scans all metadata files in R2 and removes duplicate chunk entries.
Keeps the first occurrence of each duplicate (based on 'start' time).

Usage:
    python3 deduplicate_metadata.py                    # Dry run (shows what would be fixed)
    python3 deduplicate_metadata.py --fix              # Actually fix the duplicates
    python3 deduplicate_metadata.py --fix --verbose    # Fix with detailed output
"""

import os
import sys
import json
import boto3
from datetime import datetime, timezone
from pathlib import Path
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

def get_s3_client():
    """Get S3 client for R2"""
    return boto3.client(
        's3',
        endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name='auto'
    )

def deduplicate_chunks(chunks):
    """
    Remove duplicate chunks (keeping first occurrence).
    Returns (deduplicated_chunks, duplicate_count)
    """
    seen_starts = set()
    deduplicated = []
    duplicate_count = 0
    
    for chunk in chunks:
        start_time = chunk.get('start')
        if start_time not in seen_starts:
            deduplicated.append(chunk)
            seen_starts.add(start_time)
        else:
            duplicate_count += 1
    
    # Sort chronologically
    deduplicated.sort(key=lambda c: c['start'])
    
    return deduplicated, duplicate_count

def process_metadata_file(s3_client, metadata_key, fix=False, verbose=False):
    """
    Process a single metadata file.
    Returns dict with stats about what was found/fixed.
    """
    try:
        # Load metadata
        response = s3_client.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_key)
        metadata = json.loads(response['Body'].read().decode('utf-8'))
        
        total_duplicates = 0
        changes_by_type = {}
        
        # Process each chunk type
        for chunk_type in ['10m', '1h', '6h']:
            original_chunks = metadata['chunks'].get(chunk_type, [])
            original_count = len(original_chunks)
            
            deduplicated_chunks, duplicate_count = deduplicate_chunks(original_chunks)
            
            if duplicate_count > 0:
                total_duplicates += duplicate_count
                changes_by_type[chunk_type] = {
                    'original': original_count,
                    'deduplicated': len(deduplicated_chunks),
                    'removed': duplicate_count
                }
                
                # Update metadata
                metadata['chunks'][chunk_type] = deduplicated_chunks
        
        # Upload fixed metadata if requested
        if total_duplicates > 0 and fix:
            s3_client.put_object(
                Bucket=R2_BUCKET_NAME,
                Key=metadata_key,
                Body=json.dumps(metadata, indent=2).encode('utf-8'),
                ContentType='application/json'
            )
        
        return {
            'key': metadata_key,
            'station': f"{metadata.get('network', '?')}.{metadata.get('station', '?')}.{metadata.get('location', '--')}.{metadata.get('channel', '?')}",
            'date': metadata.get('date', '?'),
            'total_duplicates': total_duplicates,
            'changes': changes_by_type,
            'fixed': fix
        }
    
    except Exception as e:
        return {
            'key': metadata_key,
            'error': str(e)
        }

def main():
    """Main entry point"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Deduplicate metadata files in R2')
    parser.add_argument('--fix', action='store_true', help='Actually fix the duplicates (default: dry run)')
    parser.add_argument('--verbose', action='store_true', help='Show detailed output for each file')
    parser.add_argument('--date', help='Only process files from specific date (YYYY-MM-DD)')
    parser.add_argument('--station', help='Only process specific station (e.g., HV.OBL.--.HHZ)')
    
    args = parser.parse_args()
    
    # Print header
    mode = "FIX MODE" if args.fix else "DRY RUN (use --fix to actually fix)"
    print("=" * 70)
    print(f"  METADATA DEDUPLICATION - {mode}")
    print("=" * 70)
    print()
    
    # Initialize R2 client
    s3 = get_s3_client()
    
    # List all metadata files
    print("📁 Scanning R2 for metadata files...")
    paginator = s3.get_paginator('list_objects_v2')
    pages = paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix='data/')
    
    metadata_files = []
    for page in pages:
        if 'Contents' not in page:
            continue
        
        for obj in page['Contents']:
            key = obj['Key']
            if key.endswith('.json'):
                # Apply filters if specified
                if args.date and args.date not in key:
                    continue
                if args.station:
                    # Convert station format: HV.OBL.--.HHZ -> HV_OBL_--_HHZ
                    station_parts = args.station.split('.')
                    if len(station_parts) == 4:
                        station_str = '_'.join(station_parts)
                        if station_str not in key:
                            continue
                
                metadata_files.append(key)
    
    print(f"   Found {len(metadata_files)} metadata files")
    print()
    
    # Process each file
    total_files_processed = 0
    total_files_with_duplicates = 0
    total_duplicates_found = 0
    total_duplicates_fixed = 0
    errors = []
    
    for i, metadata_key in enumerate(metadata_files, 1):
        result = process_metadata_file(s3, metadata_key, fix=args.fix, verbose=args.verbose)
        
        if 'error' in result:
            errors.append(result)
            if args.verbose:
                print(f"[{i}/{len(metadata_files)}] ❌ ERROR: {result['key']}")
                print(f"   Error: {result['error']}")
                print()
        else:
            total_files_processed += 1
            duplicates = result['total_duplicates']
            
            if duplicates > 0:
                total_files_with_duplicates += 1
                total_duplicates_found += duplicates
                if args.fix:
                    total_duplicates_fixed += duplicates
                
                # Show file with duplicates
                status = "✅ FIXED" if args.fix else "⚠️  FOUND"
                print(f"[{i}/{len(metadata_files)}] {status}: {result['station']} ({result['date']})")
                print(f"   File: {result['key']}")
                for chunk_type, changes in result['changes'].items():
                    print(f"   {chunk_type}: {changes['original']} → {changes['deduplicated']} ({changes['removed']} duplicates removed)")
                print()
            elif args.verbose:
                print(f"[{i}/{len(metadata_files)}] ✓ OK: {result['station']} ({result['date']}) - No duplicates")
    
    # Print summary
    print()
    print("=" * 70)
    print("  SUMMARY")
    print("=" * 70)
    print(f"Files processed: {total_files_processed}")
    print(f"Files with duplicates: {total_files_with_duplicates}")
    print(f"Total duplicates found: {total_duplicates_found}")
    if args.fix:
        print(f"Total duplicates removed: {total_duplicates_fixed}")
    else:
        print()
        print("🔍 This was a DRY RUN - no changes were made")
        print("   Run with --fix to actually remove duplicates")
    
    if errors:
        print()
        print(f"❌ Errors: {len(errors)}")
        for error in errors:
            print(f"   {error['key']}: {error['error']}")
    
    print()
    print("=" * 70)

if __name__ == "__main__":
    main()

