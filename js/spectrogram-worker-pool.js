/**
 * spectrogram-worker-pool.js
 * Worker pool manager for parallel FFT computation across multiple CPU cores
 * MAX PERFORMANCE MODE 🔥
 */

import { isStudyMode } from './master-modes.js';

export class SpectrogramWorkerPool {
    constructor(numWorkers = null) {
        // Use all available CPU cores (minus 1 to leave room for main thread)
        this.numWorkers = numWorkers || Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
        this.workers = [];
        this.availableWorkers = [];
        this.taskQueue = [];
        this.initialized = false;
        
        // Only log in dev/personal modes, not study mode
        if (!isStudyMode()) {
            console.log(`🏭 Creating worker pool with ${this.numWorkers} workers (${navigator.hardwareConcurrency} CPU cores detected)`);
        }
    }
    
    /**
     * Initialize all workers in the pool
     */
    async initialize() {
        if (this.initialized) return;
        
        const initPromises = [];
        
        for (let i = 0; i < this.numWorkers; i++) {
            const worker = new Worker('workers/spectrogram-worker.js');
            
            // Wait for worker to be ready
            const readyPromise = new Promise((resolve) => {
                const handler = (e) => {
                    if (e.data.type === 'ready') {
                        worker.removeEventListener('message', handler);
                        resolve();
                    }
                };
                worker.addEventListener('message', handler);
            });
            
            initPromises.push(readyPromise);
            
            this.workers.push({
                worker: worker,
                id: i,
                busy: false
            });
            this.availableWorkers.push(i);
        }
        
        await Promise.all(initPromises);
        this.initialized = true;
        
        // Only log in dev/personal modes, not study mode
        if (!isStudyMode()) {
            console.log(`✅ Worker pool initialized with ${this.numWorkers} workers`);
        }
    }
    
    /**
     * Process all batches in parallel across worker pool
     * Returns results as they complete
     */
    async processBatches(audioData, batches, fftSize, hopSize, window, onBatchComplete) {
        if (!this.initialized) {
            await this.initialize();
        }
        
        const totalBatches = batches.length;
        const completionTracker = { completed: 0 }; // Shared object for tracking
        
        // console.log(`📦 Distributing ${totalBatches} batches across ${this.numWorkers} workers`);
        
        // Create promises for all batches
        const batchPromises = batches.map((batch, batchIndex) => {
            return new Promise((resolve) => {
                const taskData = {
                    batch,
                    batchIndex,
                    resolve,
                    audioData,
                    fftSize,
                    hopSize,
                    window,
                    completionTracker,
                    totalBatches,
                    onBatchComplete
                };
                
                // Try to assign immediately or queue
                if (this.availableWorkers.length > 0) {
                    this.assignBatchToWorker(taskData);
                } else {
                    this.taskQueue.push(taskData);
                }
            });
        });
        
        // Wait for all batches to complete
        const allResults = await Promise.all(batchPromises);
        
        // console.log(`✅ All ${totalBatches} batches completed across ${this.numWorkers} workers`);
        
        return allResults;
    }
    
    /**
     * Helper to assign a batch task to a worker
     */
    assignBatchToWorker(taskData) {
        if (this.availableWorkers.length === 0) {
            this.taskQueue.push(taskData);
            return;
        }
        
        const workerIndex = this.availableWorkers.shift();
        const workerObj = this.workers[workerIndex];
        workerObj.busy = true;
        
        const handler = (e) => {
            if (e.data.type === 'batch-complete' && e.data.batchStart === taskData.batch.start) {
                workerObj.worker.removeEventListener('message', handler);
                
                // Mark worker as available
                workerObj.busy = false;
                this.availableWorkers.push(workerIndex);
                
                // Update completion tracking
                taskData.completionTracker.completed++;
                const progress = (taskData.completionTracker.completed / taskData.totalBatches * 100).toFixed(0);
                
                // Callback with results
                if (taskData.onBatchComplete) {
                    taskData.onBatchComplete(e.data.results, progress, workerIndex);
                }
                
                // Resolve promise
                taskData.resolve(e.data.results);
                
                // Process next queued task if any
                if (this.taskQueue.length > 0) {
                    const nextTask = this.taskQueue.shift();
                    this.assignBatchToWorker(nextTask);
                }
            }
        };
        
        workerObj.worker.addEventListener('message', handler);
        
        // Send batch to worker with TRANSFERABLE OBJECTS (zero-copy!)
        // Extract just the slice we need for this batch to minimize memory
        const startIdx = taskData.batch.start * taskData.hopSize;
        const endIdx = (taskData.batch.end - 1) * taskData.hopSize + taskData.fftSize;
        const batchAudioData = taskData.audioData.slice(startIdx, Math.min(endIdx, taskData.audioData.length));
        
        workerObj.worker.postMessage({
            type: 'compute-batch',
            audioData: batchAudioData,
            batchStart: taskData.batch.start,
            batchEnd: taskData.batch.end,
            fftSize: taskData.fftSize,
            hopSize: taskData.hopSize,
            window: taskData.window
        }, [batchAudioData.buffer]); // TRANSFER ownership - zero-copy!
    }
    
    /**
     * Terminate all workers in the pool and free memory
     */
    terminate() {
        // Only log in dev/personal modes, not study mode
        if (!isStudyMode()) {
            console.log(`🏭 Terminating worker pool (${this.numWorkers} workers)...`);
        }
        
        // 🔥 FIX: Reject any pending promises in taskQueue to break closure chains
        // This prevents handlers from retaining references after termination
        for (const taskData of this.taskQueue) {
            if (taskData.resolve) {
                // Reject with a cancellation error to break the promise chain
                taskData.resolve(null); // Resolve with null to indicate cancellation
            }
        }
        
        // 🔥 FIX: Remove all event listeners from workers before terminating
        // This ensures handlers are cleaned up even if batches are in progress
        for (const workerObj of this.workers) {
            // Clone the worker's event listeners list (if accessible) or just clear onmessage
            // Note: We can't directly access addEventListener handlers, but terminating
            // the worker will clean them up. We clear onmessage as a safety measure.
            workerObj.worker.onmessage = null;  // Break closure chain
            workerObj.worker.terminate();
        }
        
        this.workers = [];
        this.availableWorkers = [];
        this.taskQueue = [];
        this.initialized = false;
        
        // Force garbage collection hint (only available in special browser modes)
        if (typeof window !== 'undefined' && window.gc) {
            window.gc();
        }
        
        // Only log in dev/personal modes, not study mode
        if (!isStudyMode()) {
            console.log(`✅ Worker pool terminated and memory freed`);
        }
    }
    
    /**
     * Cleanup after rendering (call this when done!)
     */
    async cleanup() {
        // Only log in dev/personal modes, not study mode
        if (!isStudyMode()) {
            console.log(`🧹 Cleaning up worker pool...`);
        }
        this.terminate();
    }
    
    /**
     * Get pool statistics
     */
    getStats() {
        return {
            totalWorkers: this.numWorkers,
            busyWorkers: this.workers.filter(w => w.busy).length,
            availableWorkers: this.availableWorkers.length,
            queuedTasks: this.taskQueue.length,
            initialized: this.initialized
        };
    }
}
