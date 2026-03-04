// gpu-detection.js -- WebGPU capability detection

/**
 * Detect GPU/WebGPU capabilities and store the result on window.__gpuCapability.
 * Called early in initializeMainApp() so the correct render/compute path is chosen.
 */
export async function detectGPUCapability() {
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
                if (window.pm?.gpu) {
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
