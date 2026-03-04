// audio-download.js -- Audio download, recording, and component ZIP export handlers

import * as State from './audio-state.js';
import { createWAVBlob } from './wav-recording.js';

/**
 * Wire up all audio download/recording button handlers:
 *   - downloadAudioBtn: single-component WAV download
 *   - recordAudioBtn: live ScriptProcessorNode WAV recording
 *   - downloadAllComponentsBtn: ZIP of all components via JSZip
 */
export function setupAudioDownloadHandlers() {

    // --- Single-component WAV download ---
    const downloadAudioBtn = document.getElementById('downloadAudioBtn');
    if (downloadAudioBtn) {
        downloadAudioBtn.addEventListener('click', async () => {
            // Get current metadata
            if (!State.currentMetadata || State.getCompleteSamplesLength() === 0) {
                alert('No audio data loaded. Please fetch data first.');
                return;
            }

            const metadata = State.currentMetadata;
            const samples = State.completeSamplesArray || State.getCompleteSamplesArray();

            // Create filename from metadata (include component if known)
            const spacecraft = metadata.spacecraft || 'PSP';
            const dataset = metadata.dataset || 'MAG';
            const startTime = State.dataStartTime?.toISOString().replace(/:/g, '-').replace(/\./g, '-') || 'unknown';
            const endTime = State.dataEndTime?.toISOString().replace(/:/g, '-').replace(/\./g, '-') || 'unknown';

            // Get current component from selector if available
            const componentSelector = document.getElementById('componentSelector');
            const componentLabel = componentSelector && componentSelector.selectedIndex >= 0
                ? componentSelector.options[componentSelector.selectedIndex].text.split(' ')[0] // Get "br" from "br (Radial)"
                : 'audio';

            const filename = `${spacecraft}_${dataset}_${componentLabel}_${startTime}_${endTime}.wav`;

            // completeSamplesArray is at 44100 Hz (AudioContext's native sample rate)
            const sampleRate = 44100;
            console.log(`📥 Downloading audio: ${filename}`);
            console.log(`   Samples: ${samples.length.toLocaleString()}, Sample rate: ${sampleRate} Hz`);

            // Create WAV file at 44.1kHz (our resampled playback version)
            const wavBlob = createWAVBlob(samples, sampleRate);

            // Trigger download
            const url = URL.createObjectURL(wavBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            console.log(`✅ Downloaded: ${filename} (${(wavBlob.size / 1024 / 1024).toFixed(2)} MB)`);
        });
    }

    // --- Live audio recording (ScriptProcessorNode → WAV) ---
    const recordAudioBtn = document.getElementById('recordAudioBtn');
    if (recordAudioBtn) {
        let isRecording = false;
        let recordedSamples = [];
        let recordingStartTime = null;
        let recorderNode = null;

        recordAudioBtn.addEventListener('click', async () => {
            if (!State.audioContext || !State.gainNode) {
                alert('No audio context available. Please load audio data first.');
                return;
            }

            // Toggle recording state
            if (isRecording) {
                // Stop recording
                isRecording = false;

                // Disconnect and clean up recorder node
                if (recorderNode) {
                    State.gainNode.disconnect(recorderNode);
                    recorderNode.disconnect();
                    recorderNode = null;
                }

                recordAudioBtn.textContent = '🔴 Begin Recording';
                recordAudioBtn.style.background = 'linear-gradient(135deg, #e74c3c 0%, #c0392b 100%)';
                recordAudioBtn.style.animation = 'none';
                console.log(`⏹️ Recording stopped: ${recordedSamples.length.toLocaleString()} samples captured`);

                // Convert recorded samples to Float32Array
                const samples = new Float32Array(recordedSamples);
                recordedSamples = []; // Clear memory

                // Generate filename with spacecraft and timestamp
                const spacecraft = document.getElementById('spacecraft')?.value || 'audio';
                const timestamp = recordingStartTime.toISOString()
                    .replace(/:/g, '-')
                    .replace(/\./g, '-')
                    .slice(0, 19); // YYYY-MM-DDTHH-MM-SS
                const filename = `${spacecraft}_recording_${timestamp}.wav`;

                // Create WAV file at 44.1kHz
                const wavBlob = createWAVBlob(samples, 44100);

                // Trigger download
                const url = URL.createObjectURL(wavBlob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                console.log(`✅ Recording saved: ${filename} (${(wavBlob.size / 1024 / 1024).toFixed(2)} MB)`);
            } else {
                // Start recording
                recordedSamples = [];
                recordingStartTime = new Date();
                isRecording = true;

                // Create a ScriptProcessorNode to capture raw audio samples
                // Note: ScriptProcessorNode is deprecated but widely supported
                // AudioWorklet would be cleaner but requires more setup
                const bufferSize = 4096;
                recorderNode = State.audioContext.createScriptProcessor(bufferSize, 1, 1);

                recorderNode.onaudioprocess = (e) => {
                    if (!isRecording) return;
                    const inputData = e.inputBuffer.getChannelData(0);
                    // Copy samples to our recording buffer
                    for (let i = 0; i < inputData.length; i++) {
                        recordedSamples.push(inputData[i]);
                    }
                };

                // Connect: gain -> recorder -> destination (pass-through)
                State.gainNode.connect(recorderNode);
                recorderNode.connect(State.audioContext.destination);

                recordAudioBtn.textContent = '⏹️ Stop Recording';
                recordAudioBtn.style.background = 'linear-gradient(135deg, #c0392b 0%, #922b21 100%)';
                recordAudioBtn.style.animation = 'recording-pulse 1s ease-in-out infinite';
                console.log('🔴 Recording started (WAV format)');
            }
        });
    }

    // --- Download ALL components as ZIP ---
    const downloadAllBtn = document.getElementById('downloadAllComponentsBtn');
    if (downloadAllBtn) {
        downloadAllBtn.addEventListener('click', async () => {
            const { getAllComponentBlobs, getComponentLabels, getCurrentDataIdentifiers, getComponentCount } = await import('./component-selector.js');

            const componentCount = getComponentCount();
            if (componentCount < 2) {
                alert('Only one component available. Use "Download Audio" instead.');
                return;
            }

            const allBlobs = await getAllComponentBlobs();
            if (!allBlobs || allBlobs.length === 0) {
                alert('Component data not yet loaded. Please wait for all components to download.');
                return;
            }

            // Show loading state
            const originalText = downloadAllBtn.textContent;
            downloadAllBtn.textContent = '⏳ Creating ZIP...';
            downloadAllBtn.disabled = true;

            try {
                const labels = getComponentLabels();
                const ids = getCurrentDataIdentifiers();
                const startTimeStr = ids.startTime?.replace(/:/g, '-').replace(/\./g, '-') || 'unknown';
                const endTimeStr = ids.endTime?.replace(/:/g, '-').replace(/\./g, '-') || 'unknown';
                const baseFilename = `${ids.spacecraft}_${ids.dataset}_${startTimeStr}_${endTimeStr}`;

                console.log(`📦 Creating ZIP with ${allBlobs.length} components...`);

                // Create ZIP file
                const zip = new JSZip();

                for (let i = 0; i < allBlobs.length; i++) {
                    const blob = allBlobs[i];
                    const label = labels[i]?.split(' ')[0] || `component${i}`; // Get "br" from "br (Radial)"
                    const filename = `${baseFilename}_${label}.wav`;
                    zip.file(filename, blob);
                    console.log(`   Added: ${filename} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
                }

                // Generate the ZIP blob
                const zipBlob = await zip.generateAsync({
                    type: 'blob',
                    compression: 'DEFLATE',
                    compressionOptions: { level: 6 }
                });

                // Trigger download
                const url = URL.createObjectURL(zipBlob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${baseFilename}_all_components.zip`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                console.log(`✅ Downloaded: ${baseFilename}_all_components.zip (${(zipBlob.size / 1024 / 1024).toFixed(2)} MB)`);
            } catch (err) {
                console.error('❌ Failed to create ZIP:', err);
                alert('Failed to create ZIP file. See console for details.');
            } finally {
                downloadAllBtn.textContent = originalText;
                downloadAllBtn.disabled = false;
            }
        });
    }
}
