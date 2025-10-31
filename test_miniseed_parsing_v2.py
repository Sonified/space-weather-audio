#!/usr/bin/env python3
"""
Test miniSEED parsing - compare custom parser with ObsPy
"""

import struct
import requests
from datetime import datetime, timedelta
from pathlib import Path
import numpy as np
from obspy import read
import bisect

def test_parse_miniseed():
    """Download and test miniSEED parsing against ObsPy"""
    
    # IRIS FDSN web service URL
    url = "https://service.iris.edu/fdsnws/dataselect/1/query"
    
    # Request parameters - 1 hour of data
    network = "HV"
    station = "UWE"
    location = "--"
    channel = "HHZ"
    
    # Get current time and 1 hour ago
    end_time = datetime.utcnow()
    start_time = end_time - timedelta(hours=1)
    
    start_str = start_time.strftime("%Y-%m-%dT%H:%M:%S")
    end_str = end_time.strftime("%Y-%m-%dT%H:%M:%S")
    
    params = {
        'net': network,
        'sta': station,
        'loc': location,
        'cha': channel,
        'start': start_str,
        'end': end_str,
        'format': 'miniseed',
        'nodata': 404
    }
    
    # Check if we already have cached data
    test_file = Path("test_miniseed.mseed")
    
    if test_file.exists():
        print(f"📂 Using cached miniSEED file: {test_file}")
        print(f"   File size: {test_file.stat().st_size} bytes")
    else:
        print(f"📡 Downloading miniSEED from IRIS...")
        print(f"   Network: {network}, Station: {station}, Location: {location}, Channel: {channel}")
        print(f"   Time: {start_str} to {end_str} UTC")
        
        try:
            response = requests.get(url, params=params, timeout=30)
            
            if response.status_code == 204:
                print("❌ IRIS returned 204 (no data)")
                return
            
            response.raise_for_status()
            
            print(f"✅ Downloaded {len(response.content)} bytes")
            
            # Save to file for inspection
            with open(test_file, 'wb') as f:
                f.write(response.content)
            print(f"💾 Saved to {test_file}")
        except Exception as e:
            print(f"❌ Error downloading: {e}")
            return
    
    # Load the file
    with open(test_file, 'rb') as f:
        data = f.read()
    file_size = len(data)
    
    print(f"\n🔬 Raw miniSEED Binary Inspection:")
    print(f"   File size: {file_size} bytes")
    
    # Detect record size (typically 512 bytes)
    detected_size = 512
    
    # Parse all records with timestamps
    print(f"\n🔧 Parsing all records with custom parser...")
    records_with_time = []
    
    for record_idx in range(file_size // detected_size):
        offset = record_idx * detected_size
        if offset + 64 > file_size:
            break
        
        record = data[offset:offset + detected_size]
        
        # Check indicator
        if len(record) < 7:
            continue
        indicator = chr(record[6])
        if indicator not in ['D', 'R', 'Q', 'M']:
            continue
        
        # Check encoding
        if len(record) < 40:
            continue
        encoding = record[39]
        if encoding > 11:
            continue
        
        # Get header info
        byte_order = record[42]
        is_big_endian = byte_order == 0
        
        # Data offset
        data_offset_val = struct.unpack('>H', record[43:45])[0]
        if data_offset_val == 0 or data_offset_val < 48:
            data_offset_val = 48
        
        num_samples = struct.unpack('>H', record[40:42])[0]
        
        # If num_samples is 0, calculate from data length
        if num_samples == 0:
            data_length = detected_size - data_offset_val
            if encoding == 1:  # int16
                num_samples = data_length // 2
            elif encoding == 2:  # int24
                num_samples = data_length // 3
            elif encoding == 3:  # int32
                num_samples = data_length // 4
            else:
                continue
        
        # Extract data section
        data_start = offset + data_offset_val
        data_end = offset + detected_size
        if data_end > file_size:
            data_end = file_size
        
        data_section = data[data_start:data_end]
        
        # Decompress based on encoding (using EXACT logic from test_streaming.html)
        samples = []
        if encoding == 2:  # int24
            num_bytes = len(data_section)
            num_complete = num_bytes // 3
            for i in range(min(num_complete, num_samples)):
                byte_idx = i * 3
                if byte_idx + 3 <= len(data_section):
                    if is_big_endian:
                        b1 = data_section[byte_idx]
                        b2 = data_section[byte_idx + 1]
                        b3 = data_section[byte_idx + 2]
                        # Match JavaScript: (b1 << 24 | b2 << 16 | b3 << 8) >> 8
                        value = (b1 << 24 | b2 << 16 | b3 << 8) >> 8
                    else:
                        b1 = data_section[byte_idx]
                        b2 = data_section[byte_idx + 1]
                        b3 = data_section[byte_idx + 2]
                        value = (b3 << 24 | b2 << 16 | b1 << 8) >> 8
                    samples.append(value)
                    
                    # Debug first few samples from first record
                    if i < 5 and record_idx == 0:
                        print(f"      Record 0, Sample {i}: bytes=[0x{b1:02x} 0x{b2:02x} 0x{b3:02x}], value={value}")
        elif encoding == 3:  # int32
            num_bytes = len(data_section)
            num_complete = num_bytes // 4
            for i in range(min(num_complete, num_samples)):
                byte_idx = i * 4
                if byte_idx + 4 <= len(data_section):
                    if is_big_endian:
                        value = struct.unpack('>i', data_section[byte_idx:byte_idx+4])[0]
                    else:
                        value = struct.unpack('<i', data_section[byte_idx:byte_idx+4])[0]
                    samples.append(value)
        elif encoding == 1:  # int16
            num_bytes = len(data_section)
            num_complete = num_bytes // 2
            for i in range(min(num_complete, num_samples)):
                byte_idx = i * 2
                if byte_idx + 2 <= len(data_section):
                    if is_big_endian:
                        value = struct.unpack('>h', data_section[byte_idx:byte_idx+2])[0]
                    else:
                        value = struct.unpack('<h', data_section[byte_idx:byte_idx+2])[0]
                    samples.append(value)
        
        if len(samples) == 0:
            continue
        
        # Parse time
        year = struct.unpack('>H', record[20:22])[0]
        day_of_year = struct.unpack('>H', record[22:24])[0]
        hour = record[24]
        minute = record[25]
        second = record[26]
        tenth_milli = record[27]
        
        # Convert to datetime
        start_of_year = datetime(year, 1, 1)
        start_datetime = start_of_year + timedelta(days=day_of_year - 1, hours=hour, minutes=minute, seconds=second, milliseconds=tenth_milli / 10.0)
        
        # Calculate sample rate
        factor = struct.unpack('>h', record[30:32])[0]
        mult = struct.unpack('>h', record[32:34])[0]
        if factor > 0 and mult > 0:
            sample_rate = float(factor * mult)
        elif factor > 0 and mult < 0:
            sample_rate = -float(factor) / float(mult)
        elif factor < 0 and mult > 0:
            sample_rate = -float(mult) / float(factor)
        else:
            sample_rate = 1.0
        
        records_with_time.append({
            'start_time': start_datetime,
            'sample_rate': sample_rate,
            'samples': samples,
            'encoding': encoding
        })
    
    print(f"   Parsed {len(records_with_time)} records with timestamps")
    print(f"   First 10 samples: {records_with_time[0]['samples'][:10] if records_with_time else 'N/A'}")
    
    # Read with ObsPy (ground truth)
    print(f"\n📚 Reading with ObsPy (ground truth)...")
    try:
        st = read(str(test_file))
        tr_obspy = st[0]
        
        obspy_samples = tr_obspy.data
        obspy_start = tr_obspy.stats.starttime
        obspy_srate = tr_obspy.stats.sampling_rate
        
        print(f"   ObsPy: {len(obspy_samples)} samples @ {obspy_srate} Hz")
        print(f"   Start: {obspy_start}")
        print(f"   Sample range: [{obspy_samples.min()}, {obspy_samples.max()}]")
        print(f"   First 10: {obspy_samples[:10]}")
        print(f"   Last 10: {obspy_samples[-10:]}")
        
        # Build time series from custom parser
        print(f"\n📊 Building continuous time series...")
        
        # Sort by start time
        records_with_time.sort(key=lambda r: r['start_time'])
        
        # Create time series - use exact timestamps from each record
        time_series_pairs = []
        
        for rec in records_with_time:
            start = rec['start_time']
            srate = rec['sample_rate']
            samples = rec['samples']
            
            # Calculate exact timestamps using the record's actual sample rate
            for i, sample in enumerate(samples):
                exact_timestamp = start + timedelta(seconds=i / srate)
                time_series_pairs.append((exact_timestamp, sample))
        
        # Sort by timestamp
        time_series_pairs.sort(key=lambda x: x[0])
        
        # De-duplicate: if two samples have same timestamp (within microsecond), keep first
        deduped_timestamps = []
        deduped_samples = []
        last_ts = None
        
        for ts, samp in time_series_pairs:
            # Round to 100 microsecond precision for comparison
            ts_rounded = ts.replace(microsecond=(ts.microsecond // 100) * 100)
            if last_ts is None or ts_rounded != last_ts:
                deduped_timestamps.append(ts)
                deduped_samples.append(samp)
                last_ts = ts_rounded
        
        print(f"   After de-duplication: {len(deduped_samples)} samples (from {len(time_series_pairs)} total)")
        print(f"   Time range: {deduped_timestamps[0]} to {deduped_timestamps[-1]}")
        
        # Convert to numpy array for comparison
        custom_array = np.array(deduped_samples, dtype=np.int32)
        
        # Compare with ObsPy
        print(f"\n🔬 Comparing with ObsPy...")
        
        # Convert ObsPy timestamps
        obspy_start_dt = obspy_start.datetime
        obspy_end_dt = obspy_start_dt + timedelta(seconds=(len(obspy_samples) - 1) / obspy_srate)
        
        custom_start = deduped_timestamps[0]
        custom_end = deduped_timestamps[-1]
        
        print(f"   Custom range: {custom_start} to {custom_end}")
        print(f"   ObsPy range: {obspy_start_dt} to {obspy_end_dt}")
        
        # Find overlap period
        overlap_start = max(custom_start, obspy_start_dt)
        overlap_end = min(custom_end, obspy_end_dt)
        
        print(f"   Overlap: {overlap_start} to {overlap_end}")
        
        # Match timestamps with binary search
        print(f"   Matching timestamps (this may take a moment)...")
        
        # Create ObsPy timestamp array for binary search
        obspy_timestamps = [obspy_start_dt + timedelta(seconds=i / obspy_srate) for i in range(len(obspy_samples))]
        obspy_ts_rounded = [ts.replace(microsecond=(ts.microsecond // 1000) * 1000) for ts in obspy_timestamps]
        
        matched_custom = []
        matched_obspy = []
        
        for i, custom_ts in enumerate(deduped_timestamps):
            if i % 50000 == 0 and i > 0:
                print(f"      Processed {i}/{len(deduped_timestamps)} samples...")
            
            # Round to millisecond precision
            custom_ts_rounded = custom_ts.replace(microsecond=(custom_ts.microsecond // 1000) * 1000)
            
            # Binary search for matching timestamp
            idx = bisect.bisect_left(obspy_ts_rounded, custom_ts_rounded)
            
            if idx < len(obspy_ts_rounded) and obspy_ts_rounded[idx] == custom_ts_rounded:
                matched_custom.append(deduped_samples[i])
                matched_obspy.append(int(obspy_samples[idx]))
        
        print(f"   Matched samples: {len(matched_custom)}")
        
        if len(matched_custom) == 0:
            print("   ⚠️  No matching timestamps found!")
            return
        
        # Convert to numpy arrays
        matched_custom = np.array(matched_custom, dtype=np.int32)
        matched_obspy = np.array(matched_obspy, dtype=np.int32)
        
        # Compare
        exact_matches = np.sum(matched_custom == matched_obspy)
        mismatches = len(matched_custom) - exact_matches
        
        print(f"\n✅ Sample Comparison:")
        print(f"   Total samples compared: {len(matched_custom)}")
        print(f"   Exact matches: {exact_matches} ({100*exact_matches/len(matched_custom):.2f}%)")
        print(f"   Mismatches: {mismatches}")
        
        if mismatches > 0:
            print(f"\n   First 10 mismatches:")
            mismatch_indices = np.where(matched_custom != matched_obspy)[0][:10]
            for idx in mismatch_indices:
                print(f"      Index {idx}: Custom={matched_custom[idx]}, ObsPy={matched_obspy[idx]}, Diff={matched_custom[idx]-matched_obspy[idx]}")
            
            differences = matched_custom - matched_obspy
            print(f"\n   Statistics:")
            print(f"      Mean difference: {np.mean(differences):.2f}")
            print(f"      Std difference: {np.std(differences):.2f}")
            print(f"      Max difference: {np.max(differences)}")
            print(f"      Min difference: {np.min(differences)}")
        
        print(f"\n✅ Test complete!")
        
    except Exception as e:
        print(f"   ⚠️  ObsPy comparison failed: {e}")
        import traceback
        traceback.print_exc()

if __name__ == '__main__':
    test_parse_miniseed()


