// ========== PROGRESSIVE CHUNK BATCHING ALGORITHM ==========
// Validated with 10,000+ test cases in tests/test_progressive_batching_simulation.py

// Calculate which chunks are needed using progressive algorithm
function calculateChunksNeededMultiDay(startTime, endTime, allDayMetadata) {
    const chunks = [];
    
    // Helper to format time as HH:MM:SS
    const formatTime = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
    
    // Helper to find chunk in metadata
    const findChunk = (date, time, type) => {
        const dayMeta = allDayMetadata.find(m => m && m.date === date);
        if (!dayMeta || !dayMeta.chunks[type]) return null;
        return dayMeta.chunks[type].find(c => c.start === time);
    };
    
    // Helper to check alignment
    const isHourAligned = (minute) => minute === 0;
    const is6hAligned = (hour, minute) => hour % 6 === 0 && minute === 0;
    
    // Start from rounded 10m boundary
    let currentTime = new Date(startTime);
    currentTime.setUTCMinutes(Math.floor(currentTime.getUTCMinutes() / 10) * 10, 0, 0);
    
    let minutesElapsed = 0;
    let hasUsed1h = false;
    
    while (currentTime < endTime) {
        const currentDate = currentTime.toISOString().split('T')[0];
        const currentHour = currentTime.getUTCHours();
        const currentMinute = currentTime.getUTCMinutes();
        const timeStr = formatTime(currentHour, currentMinute);
        const remainingMinutes = (endTime - currentTime) / 1000 / 60;
        
        // FIRST 60 MINUTES: MUST use 10m chunks
        if (minutesElapsed < 60) {
            const chunkData = findChunk(currentDate, timeStr, '10m');
            if (chunkData) {
                chunks.push({
                    type: '10m',
                    start: chunkData.start,
                    end: chunkData.end,
                    min: chunkData.min,
                    max: chunkData.max,
                    samples: chunkData.samples,
                    date: currentDate
                });
                console.log(`✅ Found 10m chunk: ${currentDate} ${timeStr} (${chunkData.samples.toLocaleString()} samples)`);
            } else {
                console.warn(`⚠️ MISSING 10m chunk: ${currentDate} ${timeStr} - chunk not found in metadata!`);
            }
            currentTime.setUTCMinutes(currentTime.getUTCMinutes() + 10);
            minutesElapsed += 10;
            continue;
        }
        
        // AFTER 60 MINUTES: Use LARGEST chunk available at this boundary
        // Priority: 6h > 1h > 10m
        
        // Try 6h chunk (must have used 1h first, be at 6h boundary, have enough time)
        if (hasUsed1h && is6hAligned(currentHour, currentMinute) && remainingMinutes >= 360) {
            const chunkData = findChunk(currentDate, timeStr, '6h');
            if (chunkData) {
                chunks.push({
                    type: '6h',
                    start: chunkData.start,
                    end: chunkData.end,
                    min: chunkData.min,
                    max: chunkData.max,
                    samples: chunkData.samples,
                    date: currentDate
                });
                currentTime.setUTCHours(currentTime.getUTCHours() + 6);
                minutesElapsed += 360;
                continue;
            }
        }
        
        // Try 1h chunk (at hour boundary, have enough time)
        if (isHourAligned(currentMinute) && remainingMinutes >= 60) {
            const chunkData = findChunk(currentDate, timeStr, '1h');
            if (chunkData) {
                chunks.push({
                    type: '1h',
                    start: chunkData.start,
                    end: chunkData.end,
                    min: chunkData.min,
                    max: chunkData.max,
                    samples: chunkData.samples,
                    date: currentDate
                });
                currentTime.setUTCHours(currentTime.getUTCHours() + 1);
                minutesElapsed += 60;
                hasUsed1h = true; // Mark that we've used a 1h chunk
                continue;
            }
        }
        
        // Use 10m chunk
        const chunkData = findChunk(currentDate, timeStr, '10m');
        if (chunkData) {
            chunks.push({
                type: '10m',
                start: chunkData.start,
                end: chunkData.end,
                min: chunkData.min,
                max: chunkData.max,
                samples: chunkData.samples,
                date: currentDate
            });
            console.log(`✅ Found 10m chunk: ${currentDate} ${timeStr} (${chunkData.samples.toLocaleString()} samples)`);
        } else {
            console.warn(`⚠️ MISSING 10m chunk: ${currentDate} ${timeStr} - chunk not found in metadata!`);
        }
        currentTime.setUTCMinutes(currentTime.getUTCMinutes() + 10);
        minutesElapsed += 10;
    }
    
    return chunks;
}

// Create progressive download batches
function createDownloadBatches(chunks) {
    if (chunks.length === 0) return [];
    
    const batches = [];
    let currentType = null;
    let batchSize = 1; // Start at 1 for each type
    let remainingInType = [];
    let chunksOfTypeProcessed = 0; // Track chunks processed in current type
    
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        
        // Type change → flush and reset
        if (chunk.type !== currentType) {
            // Flush any remaining from previous type
            if (remainingInType.length > 0) {
                batches.push([...remainingInType]);
                remainingInType = [];
            }
            
            currentType = chunk.type;
            batchSize = 1; // RESET to 1
            chunksOfTypeProcessed = 0; // RESET counter
        }
        
        remainingInType.push(i);
        
        // 🎯 SPECIAL: First 3 ten-minute chunks download individually for runway
        const isFirst3TenMinute = (currentType === '10m' && chunksOfTypeProcessed < 3);
        
        if (isFirst3TenMinute) {
            // Always flush after 1 chunk for first 3 ten-minute chunks
            batches.push([...remainingInType]);
            remainingInType = [];
            chunksOfTypeProcessed++;
            // Keep batchSize = 1 for first 3
        } else {
            // Normal batching logic
            if (remainingInType.length === batchSize) {
                batches.push([...remainingInType]);
                remainingInType = [];
                chunksOfTypeProcessed += batchSize;
                
                // Increment batch size for next batch (with cap for 6h)
                if (currentType === '6h') {
                    batchSize = Math.min(batchSize + 1, 4); // CAP at 4 for 6h chunks
                } else {
                    batchSize++; // No cap for 10m and 1h
                }
            }
        }
    }
    
    // Flush any remaining chunks
    if (remainingInType.length > 0) {
        batches.push(remainingInType);
    }
    
    return batches;
}

// ===== MODE 1: CDN DIRECT STREAMING (7.8x faster than worker!) =====
async function fetchFromR2Worker(stationData, startTime, estimatedEndTime, duration, highpassFreq, realisticChunkPromise, firstChunkStart) {
    const formatTime = (date) => {
        return date.toISOString().slice(0, 19);
    };
    
    // CDN URL (direct R2 access via Cloudflare CDN - 7.8x faster than worker!)
    const CDN_BASE_URL = 'https://cdn.now.audio/data';
    
    // Check if cache bypass is enabled
    const bypassCache = document.getElementById('bypassCache').checked;
    const cacheBuster = bypassCache ? `?t=${Date.now()}` : '';
    
    // Get high-pass filter setting from UI (same as Railway)
    const highpassValue = highpassFreq === 'none' ? 0 : parseFloat(highpassFreq);
    
    const durationMinutes = duration * 60; // Convert hours to minutes
    
    const logTime = () => `[${Math.round(performance.now() - window.streamingStartTime)}ms]`;
    console.log(`📡 ${logTime()} Fetching from CDN (direct):`, {
        network: stationData.network,
        station: stationData.station,
        location: stationData.location || '--',
        channel: stationData.channel,
        start_time: startTime.toISOString(),
        duration_minutes: durationMinutes
    });
        
        // STEP 1: Fetch metadata (realistic chunk already running!)
        console.log(`📋 ${logTime()} Fetching metadata from CDN...`);
        
        // Map station codes to volcano names for CDN URL
        const volcanoMap = {
            'kilauea': 'kilauea',
            'maunaloa': 'maunaloa',
            'greatsitkin': 'greatsitkin',
            'shishaldin': 'shishaldin',
            'spurr': 'spurr'
        };
        const volcanoName = volcanoMap[document.getElementById('volcano').value] || 'kilauea';
        
        // Determine which days we need (request might span midnight UTC!)
        const startDate = startTime.toISOString().split('T')[0]; // YYYY-MM-DD
        const endDate = estimatedEndTime.toISOString().split('T')[0];
        const daysNeeded = [];
        
        // Generate list of dates between start and end
        let currentDate = new Date(startTime);
        currentDate.setUTCHours(0, 0, 0, 0); // Start of day
        
        while (currentDate <= estimatedEndTime) {
            daysNeeded.push(currentDate.toISOString().split('T')[0]);
            currentDate.setUTCDate(currentDate.getUTCDate() + 1); // Next day
        }
        
        console.log(`📋 ${logTime()} Days needed: ${daysNeeded.join(', ')}`);
        
        // Helper to build CDN chunk URL (NEW format: no sample rate)
        function buildChunkUrl(date, startTime, endTime, chunkType) {
            const location = stationData.location || '--';
            const [year, month, day] = date.split('-');
            const datePath = `${year}/${month}/${day}`;
            const startFormatted = startTime.replace(/:/g, '-');
            const endFormatted = endTime.replace(/:/g, '-');
            const filename = `${stationData.network}_${stationData.station}_${location}_${stationData.channel}_${chunkType}_${date}-${startFormatted}_to_${date}-${endFormatted}.bin.zst`;
            return `${CDN_BASE_URL}/${datePath}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/${chunkType}/${filename}`;
        }
        
        // Fetch metadata (in parallel with realistic chunk that's already running!)
        // Try NEW format first (no sample rate), fallback to OLD format (with sample rate)
        const metadataPromises = daysNeeded.map(async (date) => {
            const [year, month, day] = date.split('-');
            const datePath = `${year}/${month}/${day}`;
            const location = stationData.location || '--';
            
            // NEW format (without sample rate)
            const newMetadataUrl = `${CDN_BASE_URL}/${datePath}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/${stationData.network}_${stationData.station}_${location}_${stationData.channel}_${date}.json${cacheBuster}`;
            
            let response = await fetch(newMetadataUrl);
            
            // If NEW format not found, try OLD format (with sample rate)
            if (!response.ok) {
                const oldMetadataUrl = `${CDN_BASE_URL}/${datePath}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/${stationData.network}_${stationData.station}_${location}_${stationData.channel}_${Math.round(stationData.sample_rate || 100)}Hz_${date}.json${cacheBuster}`;
                response = await fetch(oldMetadataUrl);
                
                if (!response.ok) {
                    console.warn(`⚠️ Metadata for ${date} not found in NEW or OLD format (${response.status})`);
                    return null;
                }
                console.log(`📋 Using OLD format metadata for ${date} (will auto-migrate on next collection)`);
            }
            
            return response.json();
        });
        
        // WAIT FOR BOTH: metadata + realistic chunk (passed in as promise)
        const [allDayMetadata, realisticFirstChunk] = await Promise.all([
            Promise.all(metadataPromises),
            realisticChunkPromise
        ]);
        
        const validMetadata = allDayMetadata.filter(m => m !== null);
        console.log(`📋 ${logTime()} Metadata + realistic chunk complete (${validMetadata.length}/${daysNeeded.length} days)`);
        
        // Use our calculated estimatedEndTime as THE TRUTH
        // Metadata is only for min/max normalization, not for determining time range!
        const endTime = estimatedEndTime;
        const adjustedStartTime = startTime;
        
        console.log(`✅ ${logTime()} Using calculated time range: ${adjustedStartTime.toISOString()} to ${endTime.toISOString()}`);
        
        // Log most recent chunk in metadata for debugging
        let actualMostRecentChunk = null;
        for (const dayMeta of validMetadata) {
            if (dayMeta.chunks['10m']) {
                for (const chunk of dayMeta.chunks['10m']) {
                    const chunkTime = new Date(`${dayMeta.date}T${chunk.start}Z`);
                    if (!actualMostRecentChunk || chunkTime > actualMostRecentChunk.time) {
                        actualMostRecentChunk = { time: chunkTime, chunk: chunk, date: dayMeta.date };
                    }
                }
            }
        }
        if (actualMostRecentChunk) {
            console.log(`📋 ${logTime()} Most recent chunk in metadata: ${actualMostRecentChunk.date} ${actualMostRecentChunk.chunk.start}`);
        }
        
        // Calculate which chunks we need across all days
        const chunksNeeded = calculateChunksNeededMultiDay(adjustedStartTime, endTime, validMetadata);
        console.log(`📋 ${logTime()} Calculated chunks needed: ${chunksNeeded.length} chunks`);
        console.log(`📋 ${logTime()} Chunk types: ${chunksNeeded.map(c => c.type).join(', ')}`);
        
        if (chunksNeeded.length === 0) {
            throw new Error('No data available for this time range!');
        }
        
        // Calculate total samples from duration and sample rate (MUCH simpler!)
        const firstDayMeta = validMetadata[0];
        if (!firstDayMeta.sample_rate) {
            throw new Error('Metadata file missing sample_rate!');
        }
        const sampleRate = firstDayMeta.sample_rate; // From CDN metadata file (e.g., 100 Hz for HV.OBL)
        const durationSeconds = (endTime - adjustedStartTime) / 1000; // Convert ms to seconds
        const totalSamples = Math.floor(durationSeconds * sampleRate); // Use actual sample rate!
        console.log(`📊 ${logTime()} Total samples: ${totalSamples.toLocaleString()} (${durationSeconds.toFixed(1)}s × ${sampleRate} Hz)`);
        
        // Calculate global min/max from all chunks we're fetching
        let normMin = Infinity;
        let normMax = -Infinity;
        for (const chunk of chunksNeeded) {
            if (chunk.min < normMin) normMin = chunk.min;
            if (chunk.max > normMax) normMax = chunk.max;
        }
        
        console.log(`📊 ${logTime()} Normalization range: ${normMin} to ${normMax}`);
        
        // Store metadata for duration calculation
        currentMetadata = {
            original_sample_rate: firstDayMeta.sample_rate,
            npts: totalSamples
        };
        
        const chunksToFetch = chunksNeeded; // Use our calculated chunks!
        
        console.log(`🚀 ${logTime()} Starting CDN DIRECT streaming (${chunksToFetch.length} chunks)...`);
        
        // 🎯 USE WORKER CREATED AT START OF startStreaming()
        const worker = window.audioWorker;
        
        // Track chunks and state
        const processedChunks = [];
        let chunksReceived = 0;
        let firstChunkSent = false;
        let ttfaTime = null;
        const progressiveT0 = performance.now();
        let totalBytesDownloaded = 0;
        let realisticChunkIndex = null; // Track which chunk the realistic fetch got
        let completionHandled = false; // Prevent multiple completion checks
        
        // 🚀 Match realistic chunk to actual chunks needed!
        if (realisticFirstChunk) {
            // Extract the actual chunk time from the realistic result
            const realisticChunkTime = realisticFirstChunk.time; // HH:MM:SS from successful fetch
            const realisticChunkDate = realisticFirstChunk.date; // YYYY-MM-DD from successful fetch
            const realisticCompressed = realisticFirstChunk.compressed; // The actual data
            
            // Find which chunk index this corresponds to in chunksNeeded
            const matchIndex = chunksToFetch.findIndex(chunk => 
                chunk.date === realisticChunkDate && chunk.start === realisticChunkTime
            );
            
            if (matchIndex >= 0) {
                console.log(`⚡ ${logTime()} Realistic chunk matched chunk ${matchIndex}! (${realisticChunkDate} ${realisticChunkTime})`);
                realisticChunkIndex = matchIndex;
                
                // Send it to worker with correct index
                worker.postMessage({
                    type: 'process-chunk',
                    compressed: realisticCompressed,
                    normMin: normMin,
                    normMax: normMax,
                    chunkIndex: matchIndex
                }, [realisticCompressed]);
                
                console.log(`📥 ${logTime()} Sent realistic chunk ${matchIndex} to worker`);
            } else {
                console.log(`⚠️ ${logTime()} Realistic chunk (${realisticChunkDate} ${realisticChunkTime}) not in chunks needed - discarding`);
                realisticChunkIndex = null;
            }
        } else {
            console.log(`⚠️ ${logTime()} Realistic chunk failed - will fetch all chunks normally`);
        }
        
        // Initialize arrays
        allReceivedData = [];
        
        // Promise to wait for first chunk to be processed
        let firstChunkProcessedResolve = null;
        const firstChunkProcessed = new Promise(resolve => {
            firstChunkProcessedResolve = resolve;
        });
        
        // Track next chunk to send (to maintain order)
        let nextChunkToSend = 0;
        
        // Helper to send chunks to worklet in order
        function sendChunksInOrder() {
            // Send all sequential chunks that are ready
            while (processedChunks[nextChunkToSend]) {
                const { samples } = processedChunks[nextChunkToSend];
                const currentChunkIndex = nextChunkToSend;
                
                // 🎯 SEND TO WORKLET IN ORDER
                const WORKLET_CHUNK_SIZE = 1024;
                for (let i = 0; i < samples.length; i += WORKLET_CHUNK_SIZE) {
                    const size = Math.min(WORKLET_CHUNK_SIZE, samples.length - i);
                    const workletChunk = samples.slice(i, i + size);
                    
                    workletNode.port.postMessage({
                        type: 'audio-data',
                        data: workletChunk
                    });
                    
                    allReceivedData.push(workletChunk);
                    
                    // 🎯 FIRST CHUNK (chunk 0) = START FADE-IN
                    // Only start playback when chunk 0 is ready!
                    if (!firstChunkSent && i === 0 && currentChunkIndex === 0) {
                        firstChunkSent = true;
                        ttfaTime = performance.now() - progressiveT0;
                        console.log(`⚡ FIRST CHUNK SENT in ${ttfaTime.toFixed(0)}ms - starting playback!`);
                        
                        // 🎯 FORCE IMMEDIATE PLAYBACK
                        workletNode.port.postMessage({
                            type: 'start-immediately'
                        });
                        console.log(`🚀 Sent 'start-immediately' to worklet`);
                        
                        // 🎯 RESOLVE PROMISE - fetch loop can now continue to chunk 2!
                        if (firstChunkProcessedResolve) {
                            firstChunkProcessedResolve();
                            console.log(`✅ First chunk processed and sent - allowing fetch of chunk 2+`);
                        }
                        
                        if (gainNode && audioContext) {
                            const targetVolume = parseFloat(document.getElementById('volumeSlider').value) / 100;
                            gainNode.gain.cancelScheduledValues(audioContext.currentTime);
                            gainNode.gain.setValueAtTime(0.0001, audioContext.currentTime);
                            gainNode.gain.exponentialRampToValueAtTime(
                                Math.max(0.01, targetVolume), 
                                audioContext.currentTime + 0.05
                            );
                            console.log(`🔊 Fade-in scheduled: 0.0001 → ${targetVolume.toFixed(2)} over 50ms`);
                        }
                        
                        startPositionTracking();
                        currentAudioPosition = 0;
                        lastWorkletPosition = 0;
                        lastWorkletUpdateTime = audioContext.currentTime;
                        lastUpdateTime = audioContext.currentTime;
                        
                        // Start playback indicator (will draw when waveform is ready)
                        requestAnimationFrame(updatePlaybackIndicator);
                    }
                }
                
                nextChunkToSend++;
            }
        }
        
        // Track which chunks to send to waveform worker in order
        let nextWaveformChunk = 0;
        
        // 🎯 WORKER MESSAGE HANDLER (runs on main thread, but doesn't block!)
        worker.onmessage = (e) => {
            if (e.data.type === 'chunk-ready') {
                const { chunkIndex, samples, rawSamples, sampleCount } = e.data;
                
                chunksReceived++;
                processedChunks[chunkIndex] = { samples, rawSamples };
                
                // 🔍 DEBUG: Log each chunk's sample count
                const chunkInfo = chunksToFetch[chunkIndex];
                console.log(`📊 ${logTime()} Chunk ${chunkIndex} (${chunkInfo?.date} ${chunkInfo?.start}): ${samples.length.toLocaleString()} samples (total received: ${chunksReceived}/${chunksToFetch.length})`);
                
                // 🎨 PROGRESSIVE WAVEFORM: Send chunks to waveform worker IN ORDER (left to right temporally)
                // Send all consecutive chunks that are ready, starting from nextWaveformChunk
                while (nextWaveformChunk < chunksToFetch.length && processedChunks[nextWaveformChunk]) {
                    const chunk = processedChunks[nextWaveformChunk];
                    waveformWorker.postMessage({
                        type: 'add-samples',
                        samples: chunk.samples,
                        rawSamples: chunk.rawSamples
                    });
                    nextWaveformChunk++;
                    
                    // Trigger progressive waveform draw every 3 chunks (or first/last)
                    if (nextWaveformChunk === 1 || nextWaveformChunk === chunksToFetch.length || nextWaveformChunk % 3 === 0) {
                        const canvas = document.getElementById('waveform');
                        const width = canvas.offsetWidth * window.devicePixelRatio;
                        const height = canvas.offsetHeight * window.devicePixelRatio;
                        
                        // For first draw, set duration
                        if (nextWaveformChunk === 1) {
                            totalAudioDuration = totalSamples / 44100;
                        }
                        
                        waveformWorker.postMessage({
                            type: 'build-waveform',
                            canvasWidth: width,
                            canvasHeight: height,
                            removeDC: false,  // No DC removal until complete
                            alpha: 0.995,
                            totalExpectedSamples: totalSamples  // For progressive left-to-right filling
                        });
                        
                        console.log(`🎨 Progressive waveform: ${nextWaveformChunk}/${chunksToFetch.length} chunks sent to worker (${(nextWaveformChunk/chunksToFetch.length*100).toFixed(0)}%)`);
                    }
                }
                
                // Send chunks in order (holds chunks until previous ones are ready)
                const beforeSend = nextChunkToSend;
                sendChunksInOrder();
                const afterSend = nextChunkToSend;
                
                if (afterSend > beforeSend) {
                    console.log(`📤 Sent chunks ${beforeSend}-${afterSend-1} to worklet (in order)`);
                } else if (chunkIndex > nextChunkToSend - 1) {
                    console.log(`⏸️ Holding chunk ${chunkIndex} (waiting for chunk ${nextChunkToSend})`);
                }
                
                // 🎯 ALL CHUNKS RECEIVED = SIGNAL COMPLETE
                // CRITICAL: Check that ALL chunks are actually in processedChunks on EVERY message
                // This prevents race conditions and handles cases where chunksReceived exceeds expected count
                const allChunksPresent = chunksToFetch.every((_, idx) => processedChunks[idx] !== undefined);
                
                // 🔍 DEBUG: Log completion check status
                if (chunksReceived >= chunksToFetch.length) {
                    const missingChunks = [];
                    for (let i = 0; i < chunksToFetch.length; i++) {
                        if (!processedChunks[i]) {
                            missingChunks.push(i);
                        }
                    }
                    console.log(`🔍 ${logTime()} Completion check: allChunksPresent=${allChunksPresent}, isFetchingNewData=${isFetchingNewData}, completionHandled=${completionHandled}, missingChunks=[${missingChunks.join(', ')}]`);
                }
                
                // Only check for completion if all chunks are present (regardless of chunksReceived count)
                // This handles race conditions where chunksReceived might exceed chunksToFetch.length
                // Also prevent multiple completion checks with completionHandled flag
                // NOTE: Removed !isFetchingNewData check - it was preventing completion (catch-22)
                if (allChunksPresent && !completionHandled) {
                    completionHandled = true; // Mark as handled immediately to prevent race conditions
                    const totalTime = performance.now() - progressiveT0;
                    console.log(`✅ All ${chunksToFetch.length} chunks processed in ${totalTime.toFixed(0)}ms total`);
                    
                    // 🔍 DEBUG: Calculate actual total samples from processed chunks
                    let actualTotalSamples = 0;
                    const chunkSampleCounts = [];
                    for (let i = 0; i < processedChunks.length; i++) {
                        if (processedChunks[i]) {
                            const count = processedChunks[i].samples.length;
                            actualTotalSamples += count;
                            chunkSampleCounts.push(`chunk ${i}: ${count.toLocaleString()}`);
                        } else {
                            chunkSampleCounts.push(`chunk ${i}: MISSING`);
                        }
                    }
                    console.log(`📊 ${logTime()} Actual samples per chunk: ${chunkSampleCounts.join(', ')}`);
                    console.log(`📊 ${logTime()} Total actual samples: ${actualTotalSamples.toLocaleString()} (expected: ${totalSamples.toLocaleString()})`);
                    
                    // Signal worklet
                    const totalWorkletSamples = allReceivedData.reduce((sum, chunk) => sum + chunk.length, 0);
                    console.log(`📊 ${logTime()} Total worklet samples: ${totalWorkletSamples.toLocaleString()} (from allReceivedData)`);
                    workletNode.port.postMessage({
                        type: 'data-complete',
                        totalSamples: totalWorkletSamples
                    });
                    
                    // Terminate worker (we're done!)
                    worker.terminate();
                    console.log('🏭 Worker terminated');
                    
                    // Update download size
                    document.getElementById('downloadSize').textContent = `${(totalBytesDownloaded / 1024 / 1024).toFixed(2)} MB`;
                    
                    // 🎯 FINAL WAVEFORM WITH DC REMOVAL (crossfade to pink)
                    requestIdleCallback(() => {
                        buildCompleteWaveform(processedChunks, chunksToFetch, normMin, normMax, totalSamples);
                    }, { timeout: 2000 });
                    
                    console.log(`🎨 All chunks complete - will build final detrended waveform`);
                    
                    // Update UI
                    updatePlaybackSpeed();
                    updatePlaybackDuration();
                    isFetchingNewData = false;
                    
                    if (loadingInterval) {
                        clearInterval(loadingInterval);
                        loadingInterval = null;
                    }
                    
                    document.getElementById('playPauseBtn').disabled = false;
                    document.getElementById('playPauseBtn').textContent = '⏸️ Pause';
                    document.getElementById('playPauseBtn').classList.add('pause-active');
                    document.getElementById('loopBtn').disabled = false;
                    document.getElementById('status').className = 'status success';
                    document.getElementById('status').textContent = '✅ Playing! (Worker-accelerated)';
                }
            }
        };
        
        // Helper function to build complete waveform (called in idle callback)
        function buildCompleteWaveform(processedChunks, chunksToFetch, normMin, normMax, totalSamples) {
            console.log('🎨 Building complete waveform...');
            const t0 = performance.now();
            
            // Stitch all chunks together
            let totalLength = 0;
            for (let i = 0; i < processedChunks.length; i++) {
                if (processedChunks[i]) {
                    totalLength += processedChunks[i].samples.length;
                }
            }
            
            const stitchedFloat32 = new Float32Array(totalLength);
            const stitchedRaw = new Float32Array(totalLength);
            
            let offset = 0;
            for (let i = 0; i < processedChunks.length; i++) {
                if (processedChunks[i]) {
                    const { samples, rawSamples } = processedChunks[i];
                    stitchedFloat32.set(samples, offset);
                    stitchedRaw.set(rawSamples, offset);
                    offset += samples.length;
                }
            }
            
            // Store for waveform drawing
            completeSamplesArray = stitchedFloat32;
            window.rawWaveformData = stitchedRaw;
            
            // Update UI metrics
            document.getElementById('sampleCount').textContent = stitchedFloat32.length.toLocaleString();
            totalAudioDuration = stitchedFloat32.length / 44100;
            
            // 🎨 DON'T re-send samples - worker already has them!
            // Just trigger final waveform build with DC removal
            drawWaveform();
            
            const stitchTime = performance.now() - t0;
            console.log(`✅ Samples stitched in ${stitchTime.toFixed(0)}ms, triggering final detrended waveform`);
        }
        
        // ========== PROGRESSIVE BATCH DOWNLOADING ==========
        // Create download batches using our validated algorithm
        const downloadBatches = createDownloadBatches(chunksToFetch);
        
        // Log chunk breakdown
        const typeCount = chunksToFetch.reduce((acc, c) => {
            acc[c.type] = (acc[c.type] || 0) + 1;
            return acc;
        }, {});
        console.log(`📋 ${logTime()} Progressive chunks: ${chunksToFetch.length} total`);
        console.log(`📋 ${logTime()} Breakdown: ${Object.entries(typeCount).map(([t, c]) => `${c}×${t}`).join(', ')}`);
        
        // Show batch plan
        const batchPlan = downloadBatches.map((batch, i) => {
            const type = chunksToFetch[batch[0]].type;
            return batch.length === 1 ? `1×${type}` : `${batch.length}×${type}`;
        }).join(' → ');
        console.log(`🚀 ${logTime()} Download plan: ${batchPlan}`);
        console.log(`📦 ${logTime()} Total batches: ${downloadBatches.length}`);
        
        // Fetch function - DIRECT FROM CDN
        async function fetchChunk(chunkData) {
            const { chunk, index } = chunkData;
            
            // Build CDN URL
            const location = stationData.location || '--';
            const sampleRate = Math.round(stationData.sample_rate || 100);
            
            // Convert YYYY-MM-DD to YYYY/MM/DD for CDN path
            const [year, month, day] = chunk.date.split('-');
            const datePath = `${year}/${month}/${day}`;
            
            // Convert start/end times to filename format
            const startFormatted = chunk.start.replace(/:/g, '-');
            const endFormatted = chunk.end.replace(/:/g, '-');
            
            // Try NEW format first (no sample rate), fallback to OLD format (with sample rate)
            const newFilename = `${stationData.network}_${stationData.station}_${location}_${stationData.channel}_${chunk.type}_${chunk.date}-${startFormatted}_to_${chunk.date}-${endFormatted}.bin.zst`;
            const newChunkUrl = `${CDN_BASE_URL}/${datePath}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/${chunk.type}/${newFilename}${cacheBuster}`;
            
            let response = await fetch(newChunkUrl);
            
            // If NEW format not found, try OLD format (with sample rate)
            if (!response.ok) {
                const oldFilename = `${stationData.network}_${stationData.station}_${location}_${stationData.channel}_${sampleRate}Hz_${chunk.type}_${chunk.date}-${startFormatted}_to_${chunk.date}-${endFormatted}.bin.zst`;
                const oldChunkUrl = `${CDN_BASE_URL}/${datePath}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/${chunk.type}/${oldFilename}${cacheBuster}`;
                
                response = await fetch(oldChunkUrl);
                
                if (!response.ok) {
                    throw new Error(`Chunk ${index + 1} fetch failed in both NEW and OLD formats: ${response.status}`);
                }
            }
            
            const compressed = await response.arrayBuffer();
            const chunkSize = compressed.byteLength;
            totalBytesDownloaded += chunkSize;
            
            return { compressed, chunkSize, index };
        }
        
        let chunksDownloaded = 0;
        
        // Helper to send chunk to worker
        const sendToWorker = (result) => {
            const { compressed, chunkSize, index } = result;
            chunksDownloaded++;
            
            worker.postMessage({
                type: 'process-chunk',
                compressed: compressed,
                normMin: normMin,
                normMax: normMax,
                chunkIndex: index
            }, [compressed]);
            
            const chunkType = chunksToFetch[index].type;
            console.log(`📥 ${logTime()} Downloaded chunk ${index + 1}/${chunksToFetch.length} (${chunkType}) - ${(chunkSize / 1024).toFixed(1)} KB (${chunksDownloaded}/${chunksToFetch.length})`);
        };
        
        // Execute batches sequentially, chunks within batch in parallel
        for (let batchIdx = 0; batchIdx < downloadBatches.length; batchIdx++) {
            const batchIndices = downloadBatches[batchIdx];
            const chunkType = chunksToFetch[batchIndices[0]].type;
            const batchLabel = batchIndices.length === 1 ? 
                `1×${chunkType} alone` : 
                `${batchIndices.length}×${chunkType} parallel`;
            
            console.log(`📦 ${logTime()} Batch ${batchIdx + 1}/${downloadBatches.length}: ${batchLabel} (chunks ${batchIndices.map(i => i + 1).join(', ')})`);
            
            // Download all chunks in this batch IN PARALLEL
            const batchPromises = batchIndices.map(idx => 
                fetchChunk({ chunk: chunksToFetch[idx], index: idx })
            );
            const batchResults = await Promise.all(batchPromises);
            
            // Send to worker
            batchResults.forEach(sendToWorker);
            
            // Wait for first batch (chunk 0) to be processed before continuing
            if (batchIdx === 0) {
                console.log(`⏳ ${logTime()} Waiting for chunk 0 to process...`);
                await firstChunkProcessed;
                console.log(`✅ ${logTime()} Chunk 0 ready - AUDIO PLAYING! Continuing with next batches...`);
            }
        }
        
        console.log(`📡 ${logTime()} All ${chunksToFetch.length} chunks downloaded and sent to worker`);
        
        // Worker will handle:
        // 1. Decompression (off main thread)
        // 2. Normalization (off main thread)
        // 3. Sending to AudioWorklet (with immediate fade-in)
        // 4. Building waveform (in idle callback)
        // All UI updates happen in worker.onmessage handler above!
        
}

// ===== MODE 2: RAILWAY BACKEND (ORIGINAL PATH) =====
async function fetchFromRailway(stationData, startTime, duration, highpassFreq, enableNormalize) {
    const formatTime = (date) => {
        return date.toISOString().slice(0, 19);
    };
    
    // Request data from backend (backend will apply high-pass filter)
    const highpassValue = highpassFreq === 'none' ? 0 : parseFloat(highpassFreq);
    const requestBody = {
        network: stationData.network,
        station: stationData.station,
        location: stationData.location || '',
        channel: stationData.channel,
        starttime: formatTime(startTime),
        duration: duration * 3600,
        highpass_hz: highpassValue,  // Backend will apply high-pass filter
        normalize: false,  // NO server-side normalization (done in browser)
        send_raw: false  // Send float32
    };
    
    console.log('📡 Requesting from Railway:', requestBody);
    
    // Determine backend URL (unified collector service has both scheduled collection + on-demand streaming)
    const backendUrl = 'https://volcano-audio-collector-production.up.railway.app/api/stream-audio';
    console.log(`🌐 Using Railway backend: ${backendUrl}`);
    
    const response = await fetch(backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        mode: 'cors',
        credentials: 'omit'
    });
    
    console.log('✅ Fetch succeeded, response:', response);
    
    if (!response.ok) {
        let errorMsg = `HTTP ${response.status}`;
        try {
            const errorData = await response.json();
            if (errorData.error) {
                errorMsg = errorData.error;
            }
        } catch (e) {
            errorMsg = response.statusText || `HTTP ${response.status}`;
        }
        throw new Error(errorMsg);
    }
    
    // Get response
    const receivedBlob = await response.arrayBuffer();
    const downloadSize = (receivedBlob.byteLength / 1024 / 1024).toFixed(2);
    document.getElementById('downloadSize').textContent = `${downloadSize} MB`;
    console.log(`📦 Received: ${downloadSize} MB`);
    
    // Decompress if needed
    let decompressed;
    const compression = response.headers.get('X-Compression');
    if (compression === 'zstd') {
        console.log('🗜️ Decompressing with zstd...');
        decompressed = fzstd.decompress(new Uint8Array(receivedBlob));
        console.log(`✅ Decompressed: ${(decompressed.length / 1024 / 1024).toFixed(2)} MB`);
    } else {
        console.log('⏭️ No compression');
        decompressed = new Uint8Array(receivedBlob);
    }
    
    // Parse: [metadata_length (4 bytes)] [metadata_json] [float32_samples]
    const view = new DataView(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
    const metadataLength = view.getUint32(0, true);
    const metadataBytes = decompressed.slice(4, 4 + metadataLength);
    const metadataJson = new TextDecoder().decode(metadataBytes);
    const metadata = JSON.parse(metadataJson);
    
    console.log('📋 Metadata:', metadata);
    
    // Store metadata for duration calculation
    currentMetadata = metadata;
    
    // Extract samples
    const samplesOffset = 4 + metadataLength;
    const samplesBytes = decompressed.slice(samplesOffset);
    let samples = new Float32Array(samplesBytes.buffer, samplesBytes.byteOffset, samplesBytes.length / 4);
    
    console.log(`✅ Got ${samples.length.toLocaleString()} samples @ ${metadata.original_sample_rate} Hz`);
    
    // Calculate min/max
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < samples.length; i++) {
        if (samples[i] < min) min = samples[i];
        if (samples[i] > max) max = samples[i];
    }
    console.log(`🔍 Sample range: [${min.toFixed(3)}, ${max.toFixed(3)}]`);
    document.getElementById('sampleCount').textContent = samples.length.toLocaleString();
    
    // Keep raw samples for waveform drift removal
    const rawSamples = new Float32Array(samples);
    
    // Normalize if enabled
    if (enableNormalize) {
        console.log('📏 Normalizing...');
        samples = normalize(samples);
    }
    
    // Store complete samples array for waveform drawing
    completeSamplesArray = samples;
    
    // Send samples to waveform worker BEFORE building waveform
    waveformWorker.postMessage({
        type: 'add-samples',
        samples: samples,
        rawSamples: rawSamples
    });
    
    // Send to AudioWorklet in chunks
    console.log('🎵 Sending to AudioWorklet in 1024-sample chunks...');
    const WORKLET_CHUNK_SIZE = 1024;
    allReceivedData = [];
    
    for (let i = 0; i < samples.length; i += WORKLET_CHUNK_SIZE) {
        const chunkSize = Math.min(WORKLET_CHUNK_SIZE, samples.length - i);
        const chunk = samples.slice(i, i + chunkSize);
        
        workletNode.port.postMessage({
            type: 'audio-data',
            data: chunk
        });
        
        allReceivedData.push(chunk);
    }
    
    // Draw complete waveform
    drawWaveform();
    
    console.log(`✅ Sent ${allReceivedData.length} chunks to AudioWorklet`);
    
    // 🎯 FORCE IMMEDIATE PLAYBACK
    workletNode.port.postMessage({
        type: 'start-immediately'
    });
    console.log(`🚀 Sent 'start-immediately' to worklet`);
    
    // Fade-in audio
    if (gainNode && audioContext) {
        const targetVolume = parseFloat(document.getElementById('volumeSlider').value) / 100;
        gainNode.gain.cancelScheduledValues(audioContext.currentTime);
        gainNode.gain.setValueAtTime(0.0001, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(
            Math.max(0.01, targetVolume), 
            audioContext.currentTime + 0.05
        );
        console.log(`🔊 Fade-in scheduled: 0.0001 → ${targetVolume.toFixed(2)} over 50ms`);
    }
    
    // Start position tracking
    startPositionTracking();
    currentAudioPosition = 0;
    lastWorkletPosition = 0;
    lastWorkletUpdateTime = audioContext.currentTime;
    lastUpdateTime = audioContext.currentTime;
    
    // Start playback indicator
    requestAnimationFrame(updatePlaybackIndicator);
    
    // Signal that all data has been sent
    workletNode.port.postMessage({ type: 'data-complete' });
    
    // Set playback speed
    updatePlaybackSpeed();
    
    // Set anti-aliasing filter
    if (workletNode) {
        workletNode.port.postMessage({
            type: 'set-anti-aliasing',
            enabled: antiAliasingEnabled
        });
    }
    
    // Update playback duration
    updatePlaybackDuration();
    
    // Clear fetching flag
    isFetchingNewData = false;
    
    // Stop loading animation
    if (loadingInterval) {
        clearInterval(loadingInterval);
        loadingInterval = null;
    }
    
    // Re-enable playback controls
    const playPauseBtn = document.getElementById('playPauseBtn');
    playPauseBtn.disabled = false;
    playPauseBtn.textContent = '⏸️ Pause';
    playPauseBtn.classList.remove('play-active', 'secondary');
    playPauseBtn.classList.add('pause-active');
    
    document.getElementById('loopBtn').disabled = false;
    
    document.getElementById('status').className = 'status success';
    document.getElementById('status').textContent = '✅ Playing! (Railway backend)';
    console.log('✅ Streaming complete from Railway backend');
}

