#!/usr/bin/env python3
"""
Quick test server for CDASWS audio file creation
Creates audio files from PSP FIELDS magnetometer data and serves them
"""

from flask import Flask, request, jsonify, send_file, send_from_directory
from flask_cors import CORS
from cdasws import CdasWs
import requests
import tempfile
import os
from datetime import datetime, timedelta

app = Flask(__name__)
CORS(app)

cdas = CdasWs()

# Default parameters
DEFAULT_START_TIME = '2025-07-31T22:00:00Z'
DEFAULT_DURATION_MINUTES = 10
DATASET = 'PSP_FLD_L2_MAG_RTN'
VARIABLE = 'psp_fld_l2_mag_RTN'

@app.route('/')
def index():
    """Serve the HTML interface"""
    return send_from_directory('.', 'test_cdasws_player.html')

@app.route('/api/create-audio', methods=['POST'])
def create_audio():
    """
    Create audio file from CDASWS API
    
    Request JSON:
    {
        "start_time": "2025-07-31T22:00:00Z",  # optional, defaults to preset
        "duration_minutes": 10                  # optional, defaults to 10
    }
    """
    try:
        data = request.get_json() or {}
        start_time = data.get('start_time', DEFAULT_START_TIME)
        duration_minutes = int(data.get('duration_minutes', DEFAULT_DURATION_MINUTES))
        
        # Calculate end time
        start_dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
        end_dt = start_dt + timedelta(minutes=duration_minutes)
        end_time = end_dt.strftime('%Y-%m-%dT%H:%M:%SZ')
        
        print(f"🎵 Creating audio: {start_time} to {end_time} ({duration_minutes} minutes)")
        
        # Call CDASWS API
        status, result = cdas.get_audio(
            DATASET,
            [VARIABLE],
            start_time,
            end_time
        )
        
        if status != 200:
            return jsonify({
                'error': f'CDASWS API error: {result}',
                'status': status
            }), 400
        
        if not result or 'FileDescription' not in result or len(result['FileDescription']) == 0:
            return jsonify({
                'error': 'No audio file created',
                'status': status
            }), 400
        
        audio_url = result['FileDescription'][0]['Name']
        file_info = result['FileDescription'][0]
        
        # Download the audio file to temp location
        print(f"📥 Downloading audio from: {audio_url}")
        response = requests.get(audio_url, timeout=30)
        
        if response.status_code != 200:
            return jsonify({
                'error': f'Failed to download audio: HTTP {response.status_code}'
            }), 500
        
        # Save to temp file
        temp_dir = tempfile.gettempdir()
        temp_filename = f'psp_mag_{start_time.replace(":", "-")}_{duration_minutes}min.wav'
        temp_path = os.path.join(temp_dir, temp_filename)
        
        with open(temp_path, 'wb') as f:
            f.write(response.content)
        
        print(f"✅ Audio saved: {temp_path} ({len(response.content):,} bytes)")
        
        return jsonify({
            'success': True,
            'audio_url': f'/api/audio-file/{temp_filename}',
            'file_info': {
                'size': file_info['Length'],
                'format': file_info['MimeType'],
                'start_time': file_info['StartTime'],
                'end_time': file_info['EndTime']
            },
            'parameters': {
                'start_time': start_time,
                'end_time': end_time,
                'duration_minutes': duration_minutes
            }
        })
        
    except Exception as e:
        import traceback
        error_msg = str(e)
        traceback.print_exc()
        return jsonify({
            'error': f'Server error: {error_msg}'
        }), 500

@app.route('/api/audio-file/<filename>')
def serve_audio(filename):
    """Serve the audio file"""
    temp_dir = tempfile.gettempdir()
    file_path = os.path.join(temp_dir, filename)
    
    if not os.path.exists(file_path):
        return jsonify({'error': 'File not found'}), 404
    
    return send_file(file_path, mimetype='audio/wav')

if __name__ == '__main__':
    print("🚀 Starting CDASWS Audio Server...")
    print(f"📊 Dataset: {DATASET}")
    print(f"📊 Variable: {VARIABLE}")
    print(f"⏰ Default start: {DEFAULT_START_TIME}")
    print(f"⏰ Default duration: {DEFAULT_DURATION_MINUTES} minutes")
    print(f"\n🌐 Server running at: http://localhost:5006")
    print(f"📱 Open browser to: http://localhost:5006")
    app.run(host='0.0.0.0', port=5006, debug=True)

