// gpu-detection.js -- WebGPU capability detection

/**
 * Detect GPU/WebGPU capabilities and store the result on window.__gpuCapability.
 * Kicked off non-blocking at init; spectrogram can await the result before rendering.
 */

let _gpuPromise = null;

/**
 * Start GPU detection. Safe to call multiple times — only runs once.
 * Returns a promise that resolves when detection is complete.
 */
export function detectGPUCapability() {
    if (!_gpuPromise) {
        _gpuPromise = _detect();
    }
    return _gpuPromise;
}

/**
 * Wait for GPU detection to finish, with a timeout fallback.
 * If detection takes longer than `timeoutMs`, resolves with CPU-fallback defaults.
 * Call this from spectrogram-pyramid before choosing compute backend.
 */
export function waitForGPUDetection(timeoutMs = 5000) {
    if (window.__gpuCapability) return Promise.resolve(window.__gpuCapability);
    if (!_gpuPromise) detectGPUCapability();

    return Promise.race([
        _gpuPromise.then(() => window.__gpuCapability),
        new Promise(resolve => setTimeout(() => {
            if (!window.__gpuCapability) {
                console.warn(`⚠️ GPU detection timed out after ${timeoutMs}ms — falling back to CPU`);
                window.__gpuCapability = { useGPU: false, vendor: 'none', timedOut: true };
            }
            resolve(window.__gpuCapability);
        }, timeoutMs))
    ]);
}

async function _detect() {
    try {
        const ram = navigator.deviceMemory || 'unknown';
        const cores = navigator.hardwareConcurrency || 'unknown';

        if (navigator.gpu) {
            const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
            if (adapter) {
                const info = adapter.info || {};
                const vendor = info.vendor || 'unknown';
                const arch = info.architecture || '';
                const maxBuf = adapter.limits.maxBufferSize;
                const maxBufMB = (maxBuf / (1024 * 1024)).toFixed(0);
                const integrated = vendor.toLowerCase().includes('intel') && !arch.toLowerCase().includes('arc');

                // Decision: GPU path if maxBufferSize >= 512MB and not low-RAM integrated
                const useGPU = maxBuf >= 512 * 1024 * 1024 && !(integrated && ram < 8);

                const tier = useGPU ? '🟢 GPU' : '🟡 CPU (GPU available but constrained)';
                if (window.pm?.rendering) {
                    console.log(
                        `%c⚡ ${tier} | ${vendor} ${arch} | maxBuffer: ${maxBufMB}MB | RAM: ${ram}GB | cores: ${cores}`,
                        'color: #4CAF50; font-weight: bold; font-size: 13px'
                    );
                    console.log(
                        `%c   Render: WebGPU + Three.js TSL | Compute: ${useGPU ? 'GPU zero-copy' : 'CPU worker pool'}`,
                        'color: #90CAF9'
                    );
                }

                // Store decision for pyramid/renderer to read
                window.__gpuCapability = { useGPU, vendor, arch, maxBufMB: +maxBufMB, ram, integrated };
            } else {
                console.log(`%c⚪ CPU-only | No WebGPU adapter | RAM: ${ram}GB | cores: ${cores}`, 'color: #FFC107; font-weight: bold; font-size: 13px');
                console.log(`%c   Render: WebGPU (Three.js fallback) | Compute: CPU worker pool`, 'color: #90CAF9');
                window.__gpuCapability = { useGPU: false, vendor: 'none', ram };
            }
        } else {
            console.log(`%c⚪ CPU-only | WebGPU not available | RAM: ${ram}GB | cores: ${cores}`, 'color: #FFC107; font-weight: bold; font-size: 13px');
            console.log(`%c   Render: Canvas 2D fallback | Compute: CPU worker pool`, 'color: #90CAF9');
            window.__gpuCapability = { useGPU: false, vendor: 'none', ram };
        }
    } catch (e) {
        console.warn('GPU capability detection failed:', e.message);
        window.__gpuCapability = { useGPU: false, vendor: 'none' };
    }
}
