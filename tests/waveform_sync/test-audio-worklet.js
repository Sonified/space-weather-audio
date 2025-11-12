// Simplified AudioWorklet for testing sync
// Stripped down version - just circular buffer playback, no filters

class TestAudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buffer = new Float32Array(44100 * 60); // 1 minute buffer
        this.writeIndex = 0;
        this.readIndex = 0;
        this.samplesInBuffer = 0;
        this.isPlaying = false;
        this.totalSamplesConsumed = 0;
        this.totalSamples = 0;
        this.dataComplete = false;
        this.finishedSent = false;
        
        this.positionUpdateInterval = 0.1; // Update position every 100ms
        this.samplesSinceLastUpdate = 0;
        
        this.port.onmessage = (e) => this.handleMessage(e.data);
    }
    
    handleMessage(data) {
        const { type } = data;
        
        if (type === 'audio-data') {
            // Write samples to circular buffer
            const samples = data.data;
            for (let i = 0; i < samples.length; i++) {
                this.buffer[this.writeIndex] = samples[i];
                this.writeIndex = (this.writeIndex + 1) % this.buffer.length;
                this.samplesInBuffer++;
            }
        } else if (type === 'play') {
            this.isPlaying = true;
        } else if (type === 'pause') {
            this.isPlaying = false;
        } else if (type === 'data-complete') {
            this.dataComplete = true;
            this.totalSamples = data.totalSamples;
            console.log(`✅ Data complete: ${this.totalSamples.toLocaleString()} samples`);
        } else if (type === 'clear-buffer') {
            // Clear circular buffer for seeking
            this.writeIndex = 0;
            this.readIndex = 0;
            this.samplesInBuffer = 0;
            this.totalSamplesConsumed = data.samplePosition || 0;
            this.finishedSent = false; // Reset so we can finish again after seeking
            console.log(`🔄 Buffer cleared, position set to ${this.totalSamplesConsumed.toLocaleString()} samples`);
            this.port.postMessage({
                type: 'position',
                samplePosition: this.totalSamplesConsumed,
                positionSeconds: this.totalSamplesConsumed / 44100
            });
        }
    }
    
    process(inputs, outputs, parameters) {
        const output = outputs[0];
        const channel = output[0];
        
        if (!this.isPlaying) {
            return true;
        }
        
        // Read from buffer
        for (let i = 0; i < channel.length; i++) {
            if (this.samplesInBuffer > 0) {
                channel[i] = this.buffer[this.readIndex];
                this.readIndex = (this.readIndex + 1) % this.buffer.length;
                this.samplesInBuffer--;
                this.totalSamplesConsumed++;
            } else {
                channel[i] = 0;
                // Check if finished
                if (this.dataComplete && this.totalSamplesConsumed >= this.totalSamples && !this.finishedSent) {
                    this.isPlaying = false;
                    this.finishedSent = true;
                    this.port.postMessage({ 
                        type: 'finished',
                        totalSamples: this.totalSamplesConsumed
                    });
                    console.log(`🏁 Playback finished at ${this.totalSamplesConsumed.toLocaleString()} samples`);
                }
            }
        }
        
        // Update position
        this.samplesSinceLastUpdate += channel.length;
        if (this.samplesSinceLastUpdate >= this.positionUpdateInterval * 44100) {
            this.port.postMessage({
                type: 'position',
                samplePosition: this.totalSamplesConsumed,
                positionSeconds: this.totalSamplesConsumed / 44100
            });
            this.samplesSinceLastUpdate = 0;
        }
        
        return true;
    }
}

registerProcessor('test-audio-processor', TestAudioProcessor);

