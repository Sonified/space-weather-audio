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
        
        const expectedResponseType = taskData.isUint8 ? 'batch-uint8-complete' : 'batch-complete';
        
        const handler = (e) => {
            if (e.data.type === expectedResponseType && e.data.batchStart === taskData.batch.start) {
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

                // Break closure chain — release references to large data
                taskData.audioData = null;
                taskData.resolve = null;
                taskData.onBatchComplete = null;
                taskData.window = null;
                taskData.completionTracker = null;

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
        
        const messageType = taskData.isUint8 ? 'compute-batch-uint8' : 'compute-batch';
        const msg = {
            type: messageType,
            audioData: batchAudioData,
            batchStart: taskData.batch.start,
            batchEnd: taskData.batch.end,
            fftSize: taskData.fftSize,
            hopSize: taskData.hopSize,
            window: taskData.window
        };
        if (taskData.isUint8) {
            msg.dbFloor = taskData.dbFloor;
            msg.dbRange = taskData.dbRange;
        }
        workerObj.worker.postMessage(msg, [batchAudioData.buffer]); // TRANSFER ownership - zero-copy!
    }
    
    /**
     * Process all batches in parallel, returning Uint8 normalized dB data.
     * Same interface as processBatches() but with dbFloor/dbRange parameters.
     */
    async processBatchesUint8(audioData, batches, fftSize, hopSize, window, onBatchComplete, dbFloor = -100, dbRange = 100) {
        if (!this.initialized) {
            await this.initialize();
        }
        
        const totalBatches = batches.length;
        const completionTracker = { completed: 0 };
        
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
                    onBatchComplete,
                    dbFloor,
                    dbRange,
                    isUint8: true
                };
                
                if (this.availableWorkers.length > 0) {
                    this.assignBatchToWorker(taskData);
                } else {
                    this.taskQueue.push(taskData);
                }
            });
        });
        
        const allResults = await Promise.all(batchPromises);
        return allResults;
    }
    
    /**
     * Process whole tiles in parallel — one tile per worker, work-stealing.
     * Each tile is computed entirely within a single worker (all FFT columns).
     *
     * @param {Array} tiles - Array of { audioData, fftSize, hopSize, numTimeSlices, hannWindow, dbFloor, dbRange, tileIndex }
     * @param {Function} onTileComplete - Callback(tileIndex, magnitudeData, width, height) called as each tile finishes
     * @param {AbortSignal} signal - Optional abort signal
     * @returns {Promise} Resolves when all tiles are complete or aborted
     */
    async processTiles(tiles, onTileComplete, signal = null) {
        if (!this.initialized) {
            await this.initialize();
        }

        if (tiles.length === 0) return;

        const pending = [...tiles]; // queue of tiles to assign
        let completed = 0;
        const total = tiles.length;

        return new Promise((resolveAll) => {
            const assignNext = (workerIndex) => {
                if (signal?.aborted) return;
                if (pending.length === 0) return;

                const tile = pending.shift();
                const workerObj = this.workers[workerIndex];
                workerObj.busy = true;

                const handler = (e) => {
                    if (e.data.type === 'tile-complete' && e.data.tileIndex === tile.tileIndex) {
                        workerObj.worker.removeEventListener('message', handler);
                        workerObj.busy = false;

                        if (!signal?.aborted) {
                            onTileComplete(e.data.tileIndex, e.data.magnitudeData, e.data.width, e.data.height);
                        }

                        completed++;
                        if (completed === total || signal?.aborted) {
                            resolveAll();
                        } else {
                            // Work-stealing: this worker grabs the next pending tile
                            assignNext(workerIndex);
                        }
                    }
                };

                workerObj.worker.addEventListener('message', handler);

                // Transfer audioData buffer to worker (zero-copy)
                workerObj.worker.postMessage({
                    type: 'compute-tile',
                    audioData: tile.audioData,
                    fftSize: tile.fftSize,
                    hopSize: tile.hopSize,
                    numTimeSlices: tile.numTimeSlices,
                    window: tile.hannWindow,
                    dbFloor: tile.dbFloor,
                    dbRange: tile.dbRange,
                    tileIndex: tile.tileIndex,
                }, [tile.audioData.buffer]);
            };

            // Seed: assign one tile to each available worker
            const initialWorkers = Math.min(this.numWorkers, pending.length);
            for (let i = 0; i < initialWorkers; i++) {
                assignNext(i);
            }
        });
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
