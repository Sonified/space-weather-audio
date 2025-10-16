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
    'kilauea': {'network': 'HV', 'station': 'UWEV', 'channel': 'HHZ'},
    'spurr': {'network': 'AV', 'station': 'BGL', 'channel': 'HHZ'},
    'shishaldin': {'network': 'AV', 'station': 'SSLS', 'channel': 'HHZ'}
}

@app.route('/')
def home():
    return "Volcano Audio API - Ready"

@app.route('/api/audio/<volcano>/<int:hours>')
def get_audio(volcano, hours):
    try:
        config = VOLCANOES[volcano.lower()]
        end = UTCDateTime.now()
        start = end - (hours * 3600)
        
        client = Client("IRIS")
        stream = client.get_waveforms(
            network=config['network'],
            station=config['station'],
            location="*",
            channel=config['channel'],
            starttime=start,
            endtime=end
        )
        
        stream.merge(fill_value=0)
        trace = stream[0]
        
        speedup = 200
        original_rate = trace.stats.sampling_rate
        audio_rate = int(original_rate * speedup)
        
        audio = np.int16(trace.data / np.max(np.abs(trace.data)) * 32767)
        
        filename = f"{volcano}_{hours}h.wav"
        filepath = f"/tmp/{filename}"
        wavfile.write(filepath, audio_rate, audio)
        
        return send_file(filepath, mimetype='audio/wav')
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)