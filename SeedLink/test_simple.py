"""
Simplified test version without Flask dashboard
Just pure audio streaming for quick testing
"""

import numpy as np
import sounddevice as sd
from obspy.clients.seedlink import EasySeedLinkClient
from scipy import signal
from collections import deque

class SimpleAudifier(EasySeedLinkClient):
    def __init__(self, sample_rate=44100, gain=3.0):
        super().__init__('rtserve.iris.washington.edu:18000')
        self.audio_sample_rate = sample_rate
        self.seismic_sample_rate = 100  # HHZ channels are 100 Hz
        self.buffer = deque(maxlen=sample_rate * 2)  # 2-second buffer
        self.gain = gain
        
        # High-pass filter (remove DC offset and low freq noise)
        self.sos = signal.butter(4, 0.1, 'hp', fs=self.seismic_sample_rate, output='sos')
        self.zi = signal.sosfilt_zi(self.sos)
        
        # Normalization (adaptive)
        self.running_max = 1000  # Will adapt based on data
        self.packet_count = 0
        
        # Start audio stream
        self.audio_stream = sd.OutputStream(
            samplerate=self.audio_sample_rate,
            channels=1,
            callback=self.audio_callback,
            blocksize=1024
        )
        self.audio_stream.start()
        print("🔊 Audio stream started")
        print("⏳ Waiting for seismic data...")
        print("-" * 50)
    
    def on_data(self, trace):
        """Called when new seismic data arrives"""
        
        # Get raw samples
        samples = trace.data.astype(np.float32)
        
        # 1. High-pass filter (remove drift)
        filtered, self.zi = signal.sosfilt(self.sos, samples, zi=self.zi)
        
        # 2. Adaptive normalization
        current_max = np.abs(filtered).max()
        if current_max > 0:
            self.running_max = 0.9 * self.running_max + 0.1 * current_max
        normalized = filtered / (self.running_max * 2)
        
        # 3. Resample to audio rate
        num_output_samples = int(len(normalized) * self.audio_sample_rate / self.seismic_sample_rate)
        resampled = signal.resample(normalized, num_output_samples)
        
        # 4. Apply gain
        amplified = np.clip(resampled * self.gain, -1.0, 1.0)
        
        # 5. Add to buffer
        self.buffer.extend(amplified)
        
        # Simple console output
        self.packet_count += 1
        bar_length = int((current_max / self.running_max) * 40)
        bar = "█" * bar_length + "░" * (40 - bar_length)
        print(f"📦 Packet {self.packet_count:04d} | Buffer: {len(self.buffer):6d} | {bar} {current_max:8.1f}")
    
    def audio_callback(self, outdata, frames, time, status):
        """Called by sounddevice when audio buffer needs filling"""
        if status:
            print(f"⚠️  {status}")
        
        available = len(self.buffer)
        if available >= frames:
            data = [self.buffer.popleft() for _ in range(frames)]
            outdata[:] = np.array(data).reshape(-1, 1)
        else:
            outdata[:] = np.zeros((frames, 1))
    
    def run_audification(self, network, station, channel='HHZ'):
        """Start streaming and audifying"""
        print(f"🌋 Connecting to {network}.{station}..{channel}")
        self.select_stream(network, station, channel)
        self.run()

if __name__ == "__main__":
    print("\n" + "="*50)
    print("🌋 SEEDLINK REAL-TIME AUDIFICATION TEST")
    print("="*50 + "\n")
    
    # Create audifier with 3x gain (adjust if too loud/quiet)
    audifier = SimpleAudifier(sample_rate=44100, gain=3.0)
    
    # Choose a station (uncomment one):
    
    # Active volcano - Kīlauea:
    network, station, channel = 'HV', 'NPOC', 'HHZ'
    
    # Mauna Loa:
    # network, station, channel = 'HV', 'DEVL', 'HHZ'
    
    # Mt. Spurr, Alaska:
    # network, station, channel = 'AV', 'SPNW', 'BHZ'
    
    # Quiet reference (for testing):
    # network, station, channel = 'IU', 'ANMO', 'BHZ'
    
    try:
        audifier.run_audification(network, station, channel)
    except KeyboardInterrupt:
        print("\n\n🛑 Stopping...")
        audifier.audio_stream.stop()
        print("✅ Done!")

