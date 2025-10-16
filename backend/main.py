from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
from obspy.clients.fdsn import Client
from obspy import UTCDateTime
import numpy as np
from scipy.io import wavfile
import os

app = Flask(__name__)
CORS(app)

VOLCANOES = {
    'kilauea': {'network': 'HV', 'station': 'HLPD', 'channel': 'HHZ'},  # 0.2 min latency
    'spurr': {'network': 'AV', 'station': 'SPCN', 'channel': 'BHZ'},     # -0.2 min latency  
    'shishaldin': {'network': 'AV', 'station': 'SSLS', 'channel': 'HHZ'}
}

LOCATION_FALLBACKS = ["", "01", "00", "10", "--"]

@app.route('/')
def home():
    return "Volcano Audio API - Ready"

@app.route('/api/test/<volcano>')
def test_data(volcano):
    """Test endpoint to check if data is available without generating audio"""
    try:
        if volcano.lower() not in VOLCANOES:
            return jsonify({'error': f'Unknown volcano: {volcano}'}), 404
            
        config = VOLCANOES[volcano.lower()]
        end = UTCDateTime.now()
        start = end - 3600  # Just check last hour
        
        client = Client("IRIS")
        
        # Try location fallbacks
        for loc in LOCATION_FALLBACKS:
            try:
                stream = client.get_waveforms(
                    network=config['network'],
                    station=config['station'],
                    location=loc,
                    channel=config['channel'],
                    starttime=start,
                    endtime=end
                )
                if stream and len(stream) > 0:
                    return jsonify({
                        'available': True,
                        'network': config['network'],
                        'station': config['station'],
                        'location': loc,
                        'channel': config['channel'],
                        'sample_rate': stream[0].stats.sampling_rate,
                        'points': stream[0].stats.npts
                    })
            except Exception:
                continue
        
        return jsonify({'available': False, 'error': 'No data found for any location code'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/audio/<volcano>/<int:hours>')
def get_audio(volcano, hours):
    try:
        if volcano.lower() not in VOLCANOES:
            return jsonify({'error': f'Unknown volcano: {volcano}'}), 404
            
        config = VOLCANOES[volcano.lower()]
        end = UTCDateTime.now()
        start = end - (hours * 3600)
        
        client = Client("IRIS")
        
        # Try multiple location codes with fallback
        stream = None
        successful_location = None
        for loc in LOCATION_FALLBACKS:
            try:
                stream = client.get_waveforms(
                    network=config['network'],
                    station=config['station'],
                    location=loc,
                    channel=config['channel'],
                    starttime=start,
                    endtime=end
                )
                if stream and len(stream) > 0:
                    successful_location = loc
                    break
            except Exception as e:
                continue
        
        if not stream or len(stream) == 0:
            return jsonify({'error': 'No data available for the specified time range'}), 404
        
        stream.merge(fill_value=0)
        trace = stream[0]
        
        speedup = 200
        original_rate = trace.stats.sampling_rate
        audio_rate = int(original_rate * speedup)
        
        # Avoid division by zero
        max_val = np.max(np.abs(trace.data))
        if max_val == 0:
            return jsonify({'error': 'Data contains only zeros'}), 500
            
        audio = np.int16(trace.data / max_val * 32767)
        
        filename = f"{volcano}_{hours}h.wav"
        filepath = f"/tmp/{filename}"
        wavfile.write(filepath, audio_rate, audio)
        
        return send_file(filepath, mimetype='audio/wav', as_attachment=True, download_name=filename)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)