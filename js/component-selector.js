/**
 * component-selector.js
 * Handles switching between CDAWeb audio components (br, bt, bn)
 */

import * as State from './audio-state.js';

// Store all component URLs
let allComponentUrls = [];
let currentComponentIndex = 0;

const componentLabels = [
    'br (Radial)',
    'bt (Tangential)',
    'bn (Normal)'
];

/**
 * Initialize component selector with file URLs from CDAWeb
 * @param {Array<string>} fileUrls - Array of WAV file URLs
 */
export function initializeComponentSelector(fileUrls) {
    allComponentUrls = fileUrls || [];
    currentComponentIndex = 0;
    
    const container = document.getElementById('componentSelectorContainer');
    const selector = document.getElementById('componentSelector');
    
    if (!container || !selector) {
        console.warn('Component selector elements not found');
        return;
    }
    
    // Show selector only if we have multiple components
    if (allComponentUrls.length > 1) {
        // Update selector options based on actual number of files
        selector.innerHTML = '';
        for (let i = 0; i < allComponentUrls.length; i++) {
            const option = document.createElement('option');
            option.value = i;
            option.textContent = componentLabels[i] || `Component ${i + 1}`;
            selector.appendChild(option);
        }
        
        selector.value = currentComponentIndex;
        container.style.display = 'flex';
        
        console.log(`📊 Component selector initialized with ${allComponentUrls.length} components`);
    } else {
        container.style.display = 'none';
    }
}

/**
 * Hide the component selector
 */
export function hideComponentSelector() {
    const container = document.getElementById('componentSelectorContainer');
    if (container) {
        container.style.display = 'none';
    }
    allComponentUrls = [];
    currentComponentIndex = 0;
}

/**
 * Switch to a different component
 * @param {number} componentIndex - Index of the component to switch to
 */
async function switchComponent(componentIndex) {
    if (componentIndex < 0 || componentIndex >= allComponentUrls.length) {
        console.warn(`Invalid component index: ${componentIndex}`);
        return;
    }
    
    if (componentIndex === currentComponentIndex) {
        return; // Already on this component
    }
    
    const newUrl = allComponentUrls[componentIndex];
    console.log(`🔄 Switching to component ${componentIndex}: ${componentLabels[componentIndex]}`);
    console.log(`   📍 Time range and regions will be preserved (same time period, different vector component)`);
    
    try {
        // Pause playback during switch
        const wasPlaying = State.playbackState === 'playing';
        const currentPosition = State.currentAudioPosition;
        
        // Fetch and decode the new component's WAV file
        const response = await fetch(newUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch component ${componentIndex}`);
        }
        
        const wavBlob = await response.blob();
        
        // Decode the WAV file
        const offlineContext = new (window.AudioContext || window.webkitAudioContext)();
        const arrayBuffer = await wavBlob.arrayBuffer();
        const audioBuffer = await offlineContext.decodeAudioData(arrayBuffer);
        await offlineContext.close();
        
        // Extract samples
        const samples = audioBuffer.getChannelData(0);
        
        console.log(`   📊 Loaded ${samples.length.toLocaleString()} samples for ${componentLabels[componentIndex]}`);
        
        // Update state with new samples (KEEP time range and regions intact!)
        State.setCompleteSamplesArray(samples);
        
        // NOTE: We do NOT update dataStartTime, dataEndTime, or clear regions
        // Those represent the SAME time period across all components
        
        // Send to waveform worker
        if (State.waveformWorker) {
            State.waveformWorker.postMessage({
                type: 'add-samples',
                samples: samples,
                rawSamples: samples
            });
        }
        
        // Send to AudioWorklet
        if (State.workletNode) {
            // Clear existing buffer first
            State.workletNode.port.postMessage({ type: 'clear-buffer' });
            
            // Send new samples in chunks
            const CHUNK_SIZE = 1024;
            for (let i = 0; i < samples.length; i += CHUNK_SIZE) {
                const chunkSize = Math.min(CHUNK_SIZE, samples.length - i);
                const chunk = samples.slice(i, i + chunkSize);
                
                State.workletNode.port.postMessage({
                    type: 'audio-data',
                    data: chunk,
                    autoResume: false
                });
            }
            
            // Send data-complete
            State.workletNode.port.postMessage({
                type: 'data-complete',
                totalSamples: samples.length,
                sampleRate: State.currentMetadata?.original_sample_rate || 100
            });
        }
        
        // Redraw waveform (new signal, same time axis)
        const { drawWaveform } = await import('./waveform-renderer.js');
        drawWaveform();
        
        // Redraw spectrogram (new signal, same time axis)
        const { renderCompleteSpectrogram } = await import('./spectrogram-complete-renderer.js');
        await renderCompleteSpectrogram();
        
        // Restore playback position
        if (wasPlaying) {
            // Resume playback at the same position
            State.workletNode.port.postMessage({
                type: 'seek',
                position: currentPosition
            });
            State.workletNode.port.postMessage({ type: 'play' });
        }
        
        currentComponentIndex = componentIndex;
        console.log(`✅ Component switched to ${componentLabels[componentIndex]}`);
        console.log(`   ✅ Regions and time range preserved`);
        
    } catch (error) {
        console.error(`❌ Failed to switch component:`, error);
    }
}

/**
 * Set up event listener for component selector
 */
export function setupComponentSelectorListener() {
    const selector = document.getElementById('componentSelector');
    
    if (!selector) {
        console.warn('Component selector not found');
        return;
    }
    
    selector.addEventListener('change', (e) => {
        const newIndex = parseInt(e.target.value);
        switchComponent(newIndex);
    });
    
    console.log('📊 Component selector listener attached');
}

