"""
AUDIO STREAMING ENDPOINT
Separate from chunk creation pipeline - purely for browser audio playback

Flow:
1. Fetch miniSEED from IRIS
2. Decode with ObsPy (handles STEIM2 automatically)
3. Apply high-pass filter
4. Normalize
5. Compress with zstd
6. Send to browser
"""

from flask import Blueprint, request, jsonify, Response, make_response
import numpy as np
from obspy import UTCDateTime
from obspy.clients.fdsn import Client
from scipy import signal
import zstandard as zstd
import struct
import logging

audio_stream_bp = Blueprint('audio_stream', __name__)

def highpass_filter(data, sample_rate, cutoff_hz=0.5, order=4):
    """Apply high-pass Butterworth filter"""
    nyquist = sample_rate / 2
    normalized_cutoff = cutoff_hz / nyquist
    b, a = signal.butter(order, normalized_cutoff, btype='high', analog=False)
    filtered = signal.filtfilt(b, a, data)
    return filtered

def normalize_audio(data, output_format='float32'):
    """
    Normalize data to appropriate range for audio playback.
    Optimized to use float32 instead of float64 to save memory.
    
    Args:
        data: Input data array (already float32 from caller)
        output_format: 'int16', 'int32', or 'float32'
    
    Returns:
        Normalized data in appropriate range:
        - int16: [-32768, 32767]
        - int32: [-2147483648, 2147483647]  
        - float32: [-1.0, 1.0] (for Web Audio API)
    """
    # Data is already float32 from caller, no need to convert
    max_val = np.abs(data).max()
    
    if max_val == 0:
        return data  # Already float32
    
    if output_format == 'int16':
        # Normalize to int16 range (use float32 for computation, then convert)
        max_range = 32767
        normalized = (data / max_val) * max_range
        return normalized.astype(np.int16)
    elif output_format == 'int32':
        # Normalize to int32 range (use float32 for computation, then convert)
        max_range = 2147483647
        normalized = (data / max_val) * max_range
        return normalized.astype(np.int32)
    else:  # float32
        # Normalize to [-1.0, 1.0] for Web Audio API (in-place if possible)
        normalized = data / max_val
        return normalized.astype(np.float32)

@audio_stream_bp.route('/api/stream-audio', methods=['POST'])
def stream_audio():
    """
    Fetch, process, compress, and stream audio data for browser playback
    
    Request JSON:
    {
        "network": "HV",
        "station": "NPOC", 
        "location": "",
        "channel": "HHZ",
        "starttime": "2025-01-01T00:00:00",
        "duration": 3600,  // seconds
        "speedup": 200,    // optional, for metadata
        "highpass_hz": 0.5,  // optional, set to 0 or false to disable
        "normalize": true,   // optional, set to false to disable
        "send_raw": false    // optional, set to true to send int32 instead of float32
    }
    
    Response: zstd-compressed binary blob
    Format: [metadata_json_length (4 bytes)] [metadata_json] [float32 or int32 samples]
    """
    try:
        data = request.get_json()
        
        network = data.get('network', 'HV')
        station = data.get('station', 'NPOC')
        location = data.get('location', '')
        channel = data.get('channel', 'HHZ')
        starttime_str = data.get('starttime')
        duration = data.get('duration', 3600)
        speedup = data.get('speedup', 200)
        highpass_hz = data.get('highpass_hz', 0.5)
        normalize = data.get('normalize', True)
        send_raw = data.get('send_raw', False)
        bypass_compression = data.get('bypass_compression', False)
        
        if not starttime_str:
            response = make_response(jsonify({'error': 'starttime is required'}), 400)
            response.headers['Access-Control-Allow-Origin'] = '*'
            return response
        
        logging.info(f"[Audio Stream] 📥 {network}.{station}.{location}.{channel} @ {starttime_str} for {duration}s")
        
        # STEP 1: Fetch from IRIS
        starttime = UTCDateTime(starttime_str)
        endtime = starttime + duration
        
        logging.info(f"[Audio Stream] 📤 Fetching from IRIS...")
        client = Client("IRIS")
        
        # Special handling for 24-hour requests: split into two 12-hour requests
        TWELVE_HOURS = 43200  # seconds
        TWENTY_FOUR_HOURS = 86400  # seconds
        
        st = None
        last_error = None
        
        if duration >= TWENTY_FOUR_HOURS:
            # Split 24-hour request into two 12-hour requests
            logging.info(f"[Audio Stream] 🔀 Splitting 24-hour request into two 12-hour requests...")
            
            st_first = None
            st_second = None
            
            # Fetch first 12 hours
            logging.info(f"[Audio Stream] 📤 Fetching first 12 hours...")
            try:
                st_first = client.get_waveforms(
                    network=network,
                    station=station,
                    location=location,
                    channel=channel,
                    starttime=starttime,
                    endtime=starttime + TWELVE_HOURS
                )
                if st_first and len(st_first) > 0:
                    logging.info(f"[Audio Stream] ✅ Got {len(st_first)} traces for first 12 hours")
                else:
                    logging.warning(f"[Audio Stream] IRIS returned empty stream for first 12 hours")
                    st_first = None
            except Exception as e:
                last_error = str(e)
                logging.warning(f"[Audio Stream] IRIS failed for first 12 hours: {e}")
                st_first = None
            
            # Fetch second 12 hours
            logging.info(f"[Audio Stream] 📤 Fetching second 12 hours...")
            try:
                st_second = client.get_waveforms(
                    network=network,
                    station=station,
                    location=location,
                    channel=channel,
                    starttime=starttime + TWELVE_HOURS,
                    endtime=starttime + TWENTY_FOUR_HOURS
                )
                if st_second and len(st_second) > 0:
                    logging.info(f"[Audio Stream] ✅ Got {len(st_second)} traces for second 12 hours")
                else:
                    logging.warning(f"[Audio Stream] IRIS returned empty stream for second 12 hours")
                    st_second = None
            except Exception as e:
                last_error = str(e) if not last_error else last_error
                logging.warning(f"[Audio Stream] IRIS failed for second 12 hours: {e}")
                st_second = None
            
            # Combine the two streams
            if st_first and len(st_first) > 0:
                if st_second and len(st_second) > 0:
                    # Both succeeded - combine them
                    st = st_first + st_second
                    logging.info(f"[Audio Stream] ✅ Combined both 12-hour segments: {len(st)} traces")
                else:
                    # Only first succeeded - use it (partial data)
                    st = st_first
                    logging.warning(f"[Audio Stream] ⚠️ Only first 12 hours available, using partial data")
            elif st_second and len(st_second) > 0:
                # Only second succeeded - use it (partial data)
                st = st_second
                logging.warning(f"[Audio Stream] ⚠️ Only second 12 hours available, using partial data")
            else:
                # Both failed
                st = None
                logging.error(f"[Audio Stream] ❌ Both 12-hour segments failed")
        else:
            # Normal single request (not 24 hours)
            # Retry with progressively shorter durations
            attempt_duration = duration
            while attempt_duration >= 60:
                try:
                    st = client.get_waveforms(
                        network=network,
                        station=station,
                        location=location,
                        channel=channel,
                        starttime=starttime,
                        endtime=starttime + attempt_duration
                    )
                    if st and len(st) > 0:
                        logging.info(f"[Audio Stream] ✅ Got {len(st)} traces for {attempt_duration}s")
                        break
                    else:
                        logging.warning(f"[Audio Stream] IRIS returned empty stream for {attempt_duration}s")
                        st = None
                except Exception as e:
                    last_error = str(e)
                    logging.warning(f"[Audio Stream] IRIS failed for {attempt_duration}s: {e}")
                    st = None
                attempt_duration = attempt_duration // 2
        
        if not st or len(st) == 0:
            error_msg = f'No data available from IRIS for {network}.{station}.{location or "--"}.{channel}'
            if last_error and 'No data available' in last_error:
                error_msg += ' (station may be inactive or no data for requested time range)'
            response = make_response(jsonify({
                'error': error_msg,
                'network': network,
                'station': station,
                'location': location,
                'channel': channel,
                'details': last_error
            }), 404)
            response.headers['Access-Control-Allow-Origin'] = '*'
            return response
        
        # STEP 2: Merge traces
        logging.info(f"[Audio Stream] 🔧 Merging traces...")
        st.merge(method=1, fill_value='interpolate')
        
        if len(st) == 0:
            response = make_response(jsonify({
                'error': f'No data available after merge for {network}.{station}.{location or "--"}.{channel}',
                'network': network,
                'station': station,
                'location': location,
                'channel': channel
            }), 404)
            response.headers['Access-Control-Allow-Origin'] = '*'
            return response
        
        trace = st[0]
        
        # STEP 3: Extract samples (ObsPy already decoded miniSEED!)
        # ObsPy gives us the raw decoded samples - NO processing yet
        samples = trace.data
        sample_rate = float(trace.stats.sampling_rate)
        
        logging.info(f"[Audio Stream] 📊 Got {len(samples)} samples @ {sample_rate} Hz (via ObsPy)")
        logging.info(f"[Audio Stream] 📊 Original range: [{samples.min():.0f}, {samples.max():.0f}]")
        logging.info(f"[Audio Stream] 📊 Original dtype: {samples.dtype}")
        
        # STEP 4: Optional High-pass filter
        # Use float32 instead of float64 to save memory (sufficient precision for audio)
        if highpass_hz and highpass_hz > 0:
            logging.info(f"[Audio Stream] 🎛️  Applying {highpass_hz} Hz high-pass filter...")
            # Convert to float32 in-place to save memory (instead of float64)
            samples_float = samples.astype(np.float32, copy=False)
            del samples  # Free original int32 array immediately
            filtered = highpass_filter(samples_float, sample_rate, cutoff_hz=highpass_hz)
            del samples_float  # Free intermediate array
            logging.info(f"[Audio Stream] 📊 After filter: [{filtered.min():.0f}, {filtered.max():.0f}]")
        else:
            logging.info(f"[Audio Stream] ⏭️  Skipping high-pass filter")
            # Convert directly to float32 (not float64) to save memory
            filtered = samples.astype(np.float32, copy=False)
            del samples  # Free original array
        
        # STEP 5: Optional Normalize
        if normalize:
            logging.info(f"[Audio Stream] 📏 Normalizing...")
            # Determine output format based on send_raw flag
            output_format = 'int32' if send_raw else 'float32'
            processed = normalize_audio(filtered, output_format=output_format)
            del filtered  # Free filtered array immediately after normalization
            if send_raw:
                logging.info(f"[Audio Stream] 📊 After normalize (int32): [{processed.min()}, {processed.max()}]")
            else:
                logging.info(f"[Audio Stream] 📊 After normalize (float32): [{processed.min():.3f}, {processed.max():.3f}]")
        else:
            logging.info(f"[Audio Stream] ⏭️  Skipping normalization")
            processed = filtered
        
        # STEP 6: Prepare metadata (store len before deleting processed)
        npts = len(processed)
        metadata = {
            'network': network,
            'station': station,
            'location': location,
            'channel': channel,
            'starttime': str(trace.stats.starttime),
            'endtime': str(trace.stats.endtime),
            'original_sample_rate': sample_rate,
            'npts': npts,
            'duration_seconds': npts / sample_rate,
            'speedup': speedup,
            'highpass_hz': highpass_hz if highpass_hz else 0,
            'normalized': normalize,
            'format': 'int32' if send_raw else 'float32',
            'compressed': 'none' if bypass_compression else 'zstd',
            'obspy_decoder': True  # Confirms ObsPy did the miniSEED decoding
        }
        
        import json
        metadata_json = json.dumps(metadata).encode('utf-8')
        metadata_length = len(metadata_json)
        
        # STEP 7: Convert to appropriate format and create binary blob
        if send_raw:
            # Send as int32 (already normalized to int32 range if normalize=True)
            if normalize:
                # Already int32 from normalize_audio
                samples_bytes = processed.tobytes()
            else:
                # Not normalized, convert to int32 raw counts
                int32_samples = processed.astype(np.int32)
                samples_bytes = int32_samples.tobytes()
            logging.info(f"[Audio Stream] 📦 Sending as int32")
        else:
            # Send as float32 (already normalized to [-1.0, 1.0] if normalize=True)
            if normalize:
                # Already float32 from normalize_audio
                samples_bytes = processed.tobytes()
            else:
                # Not normalized, convert to float32
                float32_samples = processed.astype(np.float32)
                samples_bytes = float32_samples.tobytes()
            logging.info(f"[Audio Stream] 📦 Sending as float32")
        
        # Combine: [metadata_length (4 bytes)] [metadata_json] [samples]
        uncompressed_blob = (
            struct.pack('<I', metadata_length) +  # Little-endian uint32
            metadata_json +
            samples_bytes
        )
        
        # Free processed array and samples_bytes immediately after creating blob
        del processed
        del samples_bytes
        
        logging.info(f"[Audio Stream] 📦 Uncompressed size: {len(uncompressed_blob):,} bytes")
        
        # STEP 8: Optionally compress with zstd
        if bypass_compression:
            logging.info(f"[Audio Stream] ⏭️  Bypassing compression (debug mode)")
            final_blob = uncompressed_blob
            headers = {
                'Content-Type': 'application/octet-stream',
                'X-Original-Size': str(len(uncompressed_blob)),
                'X-Compression': 'none',
                'X-Sample-Rate': str(sample_rate),
                'X-Sample-Count': str(npts),
                'X-Format': metadata['format'],
                'X-Highpass': str(highpass_hz if highpass_hz else 0),
                'X-Normalized': str(normalize),
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Expose-Headers': 'X-Original-Size,X-Compression,X-Sample-Rate,X-Sample-Count,X-Format,X-Highpass,X-Normalized'
            }
        else:
            logging.info(f"[Audio Stream] 🗜️  Compressing with zstd...")
            import zstandard as zstd
            compressor = zstd.ZstdCompressor(level=3)
            original_size = len(uncompressed_blob)  # Store size before compression
            compressed_blob = compressor.compress(uncompressed_blob)
            
            # Free uncompressed blob immediately after compression to save memory
            del uncompressed_blob
            
            compression_ratio = original_size / len(compressed_blob)
            logging.info(f"[Audio Stream] ✅ Compressed: {len(compressed_blob):,} bytes ({compression_ratio:.1f}x)")
            final_blob = compressed_blob
            headers = {
                'Content-Type': 'application/octet-stream',
                'X-Original-Size': str(original_size),
                'X-Compressed-Size': str(len(compressed_blob)),
                'X-Compression': 'zstd',
                'X-Sample-Rate': str(sample_rate),
                'X-Sample-Count': str(npts),
                'X-Format': metadata['format'],
                'X-Highpass': str(highpass_hz if highpass_hz else 0),
                'X-Normalized': str(normalize),
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Expose-Headers': 'X-Original-Size,X-Compressed-Size,X-Compression,X-Sample-Rate,X-Sample-Count,X-Format,X-Highpass,X-Normalized'
            }
        
        # STEP 9: Send to browser
        # Note: Don't set Content-Encoding header - we're sending raw compressed bytes
        # The client will decompress explicitly (if not bypassed)
        return Response(
            final_blob,
            mimetype='application/octet-stream',
            headers=headers
        )
        
    except Exception as e:
        logging.error(f"[Audio Stream] ❌ Error: {e}")
        import traceback
        traceback.print_exc()
        response = make_response(jsonify({'error': str(e)}), 500)
        response.headers['Access-Control-Allow-Origin'] = '*'
        return response

@audio_stream_bp.route('/api/stream-audio', methods=['OPTIONS'])
def handle_options():
    """Handle OPTIONS preflight - headers added by after_request hook"""
    return '', 204

