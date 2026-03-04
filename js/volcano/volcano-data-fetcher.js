
// ╔═══════════════════════════════════════════════════════════════════════════════╗
// ║  🚫🚫🚫 INACTIVE PATH - DO NOT MODIFY 🚫🚫🚫                                   ║
// ║  This function is NOT used by the current application.                        ║
// ║  It was for streaming infrasound data from R2/CDN.                            ║
// ║  The ACTIVE path is fetchAndLoadCDAWebData() and fetchCDAWebAudio() above.    ║
// ╚═══════════════════════════════════════════════════════════════════════════════╝
// ===== MODE 1: CDN DIRECT STREAMING (7.8x faster than worker!) =====
export async function fetchFromR2Worker(stationData, startTime, estimatedEndTime, duration, highpassFreq, realisticChunkPromise, firstChunkStart) {
    const formatTime = (date) => {
        return date.toISOString().slice(0, 19);
    };
    
    // CDN URL (direct R2 access via Cloudflare CDN - 7.8x faster than worker!)
    const CDN_BASE_URL = 'https://cdn.now.audio/data';
    
    // Check if cache bypass is enabled (either the CDN checkbox or the drawer checkbox)
    const bypassCache = document.getElementById('bypassCache')?.checked || document.getElementById('drawerBypassCache')?.checked;
    const cacheBuster = bypassCache ? `?t=${Date.now()}` : '';
    
    // Get high-pass filter setting from UI (same as Railway)
    const highpassValue = highpassFreq === 'none' ? 0 : parseFloat(highpassFreq);
    
    const durationMinutes = duration * 60; // Convert hours to minutes
    
    const logTime = () => `[${Math.round(performance.now() - window.streamingStartTime)}ms]`;
    // Only log in dev/personal modes, not study mode
    if (!isStudyMode()) {
        console.log(`📡 ${logTime()} Fetching from CDN (direct):`, {
            network: stationData.network,
            station: stationData.station,
            location: stationData.location || '--',
            channel: stationData.channel,
            start_time: startTime.toISOString(),
            duration_minutes: durationMinutes
        });
    }
        
        // STEP 1: Fetch metadata (realistic chunk already running!)
        if (!isStudyMode()) {
            console.log(`📋 ${logTime()} Fetching metadata from CDN...`);
        }
        
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
        
        // Check if we're too close to UTC midnight for today's metadata to exist
        const now = new Date();
        const todayUTC = now.toISOString().split('T')[0];
        const minutesSinceMidnight = now.getUTCHours() * 60 + now.getUTCMinutes();
        
        // If the most recent day is today AND we're within 12 minutes of midnight, remove it
        // (Collector needs time to generate daily metadata file)
        if (daysNeeded.length > 1 && daysNeeded[daysNeeded.length - 1] === todayUTC && minutesSinceMidnight < 12) {
            daysNeeded.pop();
            console.log(`🌙 ${logTime()} UTC midnight grace period! Only ${minutesSinceMidnight} min since midnight - skipping today's metadata (${todayUTC}) to avoid 404s. Collector needs time to wake up! 😊`);
        }
        
        if (!isStudyMode()) {
            console.log(`📋 ${logTime()} Days needed: ${daysNeeded.join(', ')}`);
        }
        
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
        if (DEBUG_CHUNKS) console.log(`📋 ${logTime()} Metadata + realistic chunk complete (${validMetadata.length}/${daysNeeded.length} days)`);
        
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
            if (DEBUG_CHUNKS) console.log(`📋 ${logTime()} Most recent chunk in metadata: ${actualMostRecentChunk.date} ${actualMostRecentChunk.chunk.start}`);
        }
        
        // Calculate which chunks we need across all days
        const chunksNeeded = calculateChunksNeededMultiDay(adjustedStartTime, endTime, validMetadata);
        if (DEBUG_CHUNKS) console.log(`📋 ${logTime()} Calculated chunks needed: ${chunksNeeded.length} chunks`);
        if (DEBUG_CHUNKS) console.log(`📋 ${logTime()} Chunk types: ${chunksNeeded.map(c => c.type).join(', ')}`);
        
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
        
        // Update sample count UI early (will update with actual count at completion)
        document.getElementById('sampleCount').textContent = totalSamples.toLocaleString();
        
        // Calculate global min/max from all chunks we're fetching
        let normMin = Infinity;
        let normMax = -Infinity;
        for (const chunk of chunksNeeded) {
            if (chunk.min < normMin) normMin = chunk.min;
            if (chunk.max > normMax) normMax = chunk.max;
        }
        
        if (window.pm?.data) console.log(`📊 ${logTime()} Normalization range: ${normMin} to ${normMax}`);
        
        // Store metadata for duration calculation
        State.setCurrentMetadata({
            original_sample_rate: firstDayMeta.sample_rate,
            npts: totalSamples
        });
        
        // Store start/end times for x-axis rendering
        State.setDataStartTime(adjustedStartTime);
        State.setDataEndTime(endTime);
        
        // 🔥 Load saved regions now that time range is known
        loadRegionsAfterDataFetch();
        
        // Draw frequency axis with new metadata
        positionAxisCanvas();
        initializeAxisPlaybackRate();
        
        // Draw x-axis with new time data
        positionWaveformXAxisCanvas();
        drawWaveformXAxis();
        positionSpectrogramXAxisCanvas();
        drawSpectrogramXAxis();
        positionWaveformDateCanvas();
        drawWaveformDate();
        
        // 🎯 Set totalAudioDuration early so red scan line appears immediately
        // (This is the EXPECTED duration - we'll update with actual samples at completion)
        // 👑 CRITICAL: Use original sample rate from metadata, NOT AudioContext rate!
        const originalSampleRate = State.currentMetadata?.original_sample_rate || 50;
        const expectedDuration = totalSamples / originalSampleRate;
        State.setTotalAudioDuration(expectedDuration);
        if (window.pm?.data) console.log(`📊 ${logTime()} Set EXPECTED totalAudioDuration: ${expectedDuration.toFixed(2)}s (will update with actual at completion)`);
        
        const chunksToFetch = chunksNeeded; // Use our calculated chunks!
        
        if (DEBUG_CHUNKS) console.log(`🚀 ${logTime()} Starting CDN DIRECT streaming (${chunksToFetch.length} chunks)...`);
        
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
                if (DEBUG_CHUNKS) console.log(`⚡ ${logTime()} Realistic chunk matched chunk ${matchIndex}! (${realisticChunkDate} ${realisticChunkTime})`);
                realisticChunkIndex = matchIndex;
                
                // Send it to worker with correct index
                worker.postMessage({
                    type: 'process-chunk',
                    compressed: realisticCompressed,
                    normMin: normMin,
                    normMax: normMax,
                    chunkIndex: matchIndex
                }, [realisticCompressed]);
                
                if (DEBUG_CHUNKS) console.log(`📥 ${logTime()} Sent realistic chunk ${matchIndex} to worker`);
            } else {
                console.log(`⚠️ ${logTime()} Realistic chunk (${realisticChunkDate} ${realisticChunkTime}) not in chunks needed - discarding`);
                realisticChunkIndex = null;
            }
        } else {
            console.log(`⚠️ ${logTime()} Realistic chunk failed - will fetch all chunks normally`);
        }
        
        // Initialize arrays
        State.setAllReceivedData([]);
        
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
                let { samples } = processedChunks[nextChunkToSend];
                const currentChunkIndex = nextChunkToSend;
                const currentChunkInfo = chunksToFetch[currentChunkIndex];
                
                // 🎵 SMOOTH BOUNDARIES: If this or adjacent chunks are missing, apply linear interpolation
                // This eliminates clicks when transitioning between real data and silence
                const SMOOTH_SAMPLES = 1000; // ~23ms at 44.1kHz = 1000 samples
                
                // Check if current chunk is missing
                const isMissing = currentChunkInfo?.isMissing || false;
                
                // Check if next chunk is missing (to smooth END of current real chunk)
                const nextChunkInfo = chunksToFetch[nextChunkToSend + 1];
                const nextIsMissing = nextChunkInfo?.isMissing || false;
                
                // Copy samples so we don't modify the original
                samples = new Float32Array(samples);
                
                // SMOOTH START: Transition from previous chunk into this missing chunk
                if (isMissing && nextChunkToSend > 0 && processedChunks[nextChunkToSend - 1]) {
                    const prevSamples = processedChunks[nextChunkToSend - 1].samples;
                    if (prevSamples && prevSamples.length > 0) {
                        const prevValue = prevSamples[prevSamples.length - 1];
                        const targetValue = 0; // Current chunk is silent
                        const smoothLength = Math.min(SMOOTH_SAMPLES, samples.length);
                        
                        for (let i = 0; i < smoothLength; i++) {
                            const alpha = i / smoothLength; // 0 to 1
                            samples[i] = prevValue * (1 - alpha) + targetValue * alpha;
                        }
                    }
                }
                
                // SMOOTH END: Transition from this real chunk into next missing chunk
                if (!isMissing && nextIsMissing) {
                    const smoothLength = Math.min(SMOOTH_SAMPLES, samples.length);
                    const startIdx = samples.length - smoothLength;
                    const startValue = samples[startIdx];
                    const targetValue = 0; // Next chunk is silent
                    
                    for (let i = 0; i < smoothLength; i++) {
                        const alpha = i / smoothLength; // 0 to 1
                        samples[startIdx + i] = startValue * (1 - alpha) + targetValue * alpha;
                    }
                }
                
                // 🎯 SEND TO WORKLET IN ORDER
                const WORKLET_CHUNK_SIZE = 1024;
                for (let i = 0; i < samples.length; i += WORKLET_CHUNK_SIZE) {
                    const size = Math.min(WORKLET_CHUNK_SIZE, samples.length - i);
                    // 🔥 FIX: Copy slice to new ArrayBuffer instead of sharing buffer
                    // This allows GC of individual chunks independently
                    const slice = samples.slice(i, i + size);
                    const workletChunk = new Float32Array(slice); // Copy to new ArrayBuffer
                    
                    State.workletNode.port.postMessage({
                        type: 'audio-data',
                        data: workletChunk,
                        autoResume: State.playbackState === PlaybackState.PLAYING,
                    });
                    
                    State.allReceivedData.push(workletChunk);
                    
                    // 🎯 FIRST CHUNK (chunk 0) = START FADE-IN
                    // Only start playback when chunk 0 is ready!
                    if (!firstChunkSent && i === 0 && currentChunkIndex === 0) {
                        firstChunkSent = true;
                        ttfaTime = performance.now() - progressiveT0;
                        if (DEBUG_CHUNKS) console.log(`⚡ FIRST CHUNK SENT in ${ttfaTime.toFixed(0)}ms - starting playback!`);
                        
                        // Check if this is a shared session - don't auto-play
                        const isSharedSession = sessionStorage.getItem('isSharedSession') === 'true';
                        const autoPlayEnabled = !isSharedSession && document.getElementById('autoPlay')?.checked;

                        if (autoPlayEnabled) {
                            // 🎯 FORCE IMMEDIATE PLAYBACK
                            State.workletNode.port.postMessage({
                                type: 'start-immediately'
                            });
                            // console.log(`🚀 Sent 'start-immediately' to worklet`);

                            // Update playback state
                            State.setPlaybackState(PlaybackState.PLAYING);

                            if (State.gainNode && State.audioContext) {
                                const targetVolume = parseFloat(document.getElementById('volumeSlider').value) / 100;
                                State.gainNode.gain.cancelScheduledValues(State.audioContext.currentTime);
                                State.gainNode.gain.setValueAtTime(0.0001, State.audioContext.currentTime);
                                State.gainNode.gain.exponentialRampToValueAtTime(
                                    Math.max(0.01, targetVolume),
                                    State.audioContext.currentTime + 0.05
                                );
                                console.log(`🔊 Fade-in scheduled: 0.0001 → ${targetVolume.toFixed(2)} over 50ms`);
                            }

                            State.setCurrentAudioPosition(0);
                            State.setLastWorkletPosition(0);
                            State.setLastWorkletUpdateTime(State.audioContext.currentTime);
                            State.setLastUpdateTime(State.audioContext.currentTime);

                            // Enable play button immediately when playback starts
                            const playPauseBtn = document.getElementById('playPauseBtn');
                            playPauseBtn.disabled = false;
                            playPauseBtn.textContent = '⏸️ Pause';
                            playPauseBtn.classList.remove('play-active', 'pulse-play', 'pulse-resume', 'pulse-attention');
                            playPauseBtn.classList.add('pause-active');

                            // Update status (removed "Playing..." message per user request)

                            // Start playback indicator (will draw when waveform is ready)
                            startPlaybackIndicator();
                        } else {
                            if (isSharedSession) {
                                console.log(`🔗 Shared session loaded - waiting for user to click Play`);
                            } else {
                                console.log(`⏸️ Auto Play disabled - waiting for user to click Play`);
                            }
                            // Don't start playback, but keep state ready
                            State.setPlaybackState(PlaybackState.STOPPED);
                            // Enable play button so user can start playback
                            const playPauseBtn = document.getElementById('playPauseBtn');
                            playPauseBtn.disabled = false;
                            playPauseBtn.textContent = '▶️ Play';
                            playPauseBtn.classList.remove('pause-active');
                            playPauseBtn.classList.add('play-active');

                            // Add pulse animation for shared sessions
                            if (isSharedSession) {
                                playPauseBtn.classList.add('pulse-attention');
                                const status = document.getElementById('status');
                                if (status) {
                                    status.textContent = '🎧 Ready! Click Play or press Space Bar to start playback';
                                    status.className = 'status info';
                                }
                            }
                        }
                        
                        // 🎯 RESOLVE PROMISE - fetch loop can now continue to chunk 2!
                        if (firstChunkProcessedResolve) {
                            firstChunkProcessedResolve();
                            if (DEBUG_CHUNKS) console.log(`✅ First chunk processed and sent - allowing fetch of chunk 2+`);
                        }
                    }
                }
                
                nextChunkToSend++;
            }
            
            // 🧹 PROGRESSIVE MEMORY CLEANUP: Free chunks that have been sent to both worklet AND waveform worker
            // Clear from the oldest sent chunk up to the current send position
            // This frees memory progressively as chunks are processed
            for (let i = 0; i < nextChunkToSend; i++) {
                if (processedChunks[i] && processedChunks[i].samples !== null) {
                    // Only clear if this chunk has also been sent to waveform worker
                    if (i < nextWaveformChunk) {
                        // 🔥 FIX: Explicitly null out ArrayBuffer references to allow GC
                        // The samples Float32Array holds a reference to its ArrayBuffer
                        // Setting samples to null breaks the reference chain
                        processedChunks[i].samples = null; // Free main thread memory (rawSamples kept for final waveform)
                        // Note: rawSamples is kept for final waveform build, will be cleared later
                        if (DEBUG_CHUNKS && i % 10 === 0) console.log(`🧹 Freed chunk ${i} samples from main thread memory`);
                    }
                }
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
                if (DEBUG_CHUNKS) console.log(`📊 ${logTime()} Chunk ${chunkIndex} (${chunkInfo?.date} ${chunkInfo?.start}): ${samples.length.toLocaleString()} samples (total received: ${chunksReceived}/${chunksToFetch.length})`);
                
                // 🎨 PROGRESSIVE WAVEFORM: Send chunks to waveform worker IN ORDER (left to right temporally)
                // Send all consecutive chunks that are ready, starting from nextWaveformChunk
                while (nextWaveformChunk < chunksToFetch.length && processedChunks[nextWaveformChunk]) {
                    const chunk = processedChunks[nextWaveformChunk];
                    State.waveformWorker.postMessage({
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
                        
                        // Duration will be set once all chunks are complete (line 607-608)
                        // Don't set it early with estimated value - causes mismatch during progressive loading
                        
                        const removeDC = document.getElementById('removeDCOffset').checked;
                        const filterSlider = document.getElementById('waveformFilterSlider');
                        const filterAlpha = 0.95 + (parseInt(filterSlider.value) / 100) * (0.9999 - 0.95);

                        State.waveformWorker.postMessage({
                            type: 'build-waveform',
                            canvasWidth: width,
                            canvasHeight: height,
                            removeDC: removeDC,
                            alpha: filterAlpha,
                            totalExpectedSamples: totalSamples  // For progressive left-to-right filling
                        });
                        
                        if (DEBUG_CHUNKS) console.log(`🎨 Progressive waveform: ${nextWaveformChunk}/${chunksToFetch.length} chunks sent to worker (${(nextWaveformChunk/chunksToFetch.length*100).toFixed(0)}%)`);
                    }
                }
                
                // Send chunks in order (holds chunks until previous ones are ready)
                const beforeSend = nextChunkToSend;
                sendChunksInOrder();
                const afterSend = nextChunkToSend;
                
                if (DEBUG_CHUNKS) {
                    if (afterSend > beforeSend) {
                        console.log(`📤 Sent chunks ${beforeSend}-${afterSend-1} to worklet (in order)`);
                    } else if (chunkIndex > nextChunkToSend - 1) {
                        console.log(`⏸️ Holding chunk ${chunkIndex} (waiting for chunk ${nextChunkToSend})`);
                    }
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
                    if (DEBUG_CHUNKS) console.log(`🔍 ${logTime()} Completion check: allChunksPresent=${allChunksPresent}, isFetchingNewData=${State.isFetchingNewData}, completionHandled=${completionHandled}, missingChunks=[${missingChunks.join(', ')}]`);
                }
                
                // Only check for completion if all chunks are present (regardless of chunksReceived count)
                // This handles race conditions where chunksReceived might exceed chunksToFetch.length
                // Also prevent multiple completion checks with completionHandled flag
                // NOTE: Removed !isFetchingNewData check - it was preventing completion (catch-22)
                if (allChunksPresent && !completionHandled) {
                    completionHandled = true; // Mark as handled immediately to prevent race conditions
                    const totalTime = performance.now() - progressiveT0;
                    if (window.pm?.data) console.log(`✅ All ${chunksToFetch.length} chunks processed in ${totalTime.toFixed(0)}ms total`);
                    
                    // 🔍 DEBUG: Calculate actual total samples from processed chunks
                    // Note: Some chunks may have samples=null due to progressive memory cleanup
                    let actualTotalSamples = 0;
                    const chunkSampleCounts = [];
                    for (let i = 0; i < processedChunks.length; i++) {
                        if (processedChunks[i]) {
                            // Check if samples still exist (not freed by progressive cleanup)
                            if (processedChunks[i].samples) {
                                const count = processedChunks[i].samples.length;
                                actualTotalSamples += count;
                                chunkSampleCounts.push(`chunk ${i}: ${count.toLocaleString()}`);
                            } else {
                                chunkSampleCounts.push(`chunk ${i}: freed`);
                            }
                        } else {
                            chunkSampleCounts.push(`chunk ${i}: MISSING`);
                        }
                    }
                    if (DEBUG_CHUNKS) console.log(`📊 ${logTime()} Chunk sample counts: ${chunkSampleCounts.join(', ')}`);
                    if (DEBUG_CHUNKS && actualTotalSamples > 0) console.log(`📊 ${logTime()} Actual samples from non-freed chunks: ${actualTotalSamples.toLocaleString()}`);
                    
                    // Calculate total from worklet data (most reliable - includes all chunks)
                    const totalWorkletSamples = State.allReceivedData.reduce((sum, chunk) => sum + chunk.length, 0);
                    if (window.pm?.data) console.log(`📊 ${logTime()} Total worklet samples: ${totalWorkletSamples.toLocaleString()} (from allReceivedData)`);
                    
                    // 🎯 UPDATE: Use ACTUAL sample count for duration (refining expected duration)
                    // 👑 CRITICAL: Use original sample rate from metadata, NOT AudioContext rate!
                    const originalSampleRate = State.currentMetadata?.original_sample_rate || 50;
                    State.setTotalAudioDuration(totalWorkletSamples / originalSampleRate);
                    document.getElementById('sampleCount').textContent = totalWorkletSamples.toLocaleString(); // Update with actual
                    if (window.pm?.data) console.log(`📊 ${logTime()} Updated totalAudioDuration to ${(totalWorkletSamples / originalSampleRate).toFixed(2)}s (actual samples: ${totalWorkletSamples.toLocaleString()}, expected: ${totalSamples.toLocaleString()})`);
                    
                    // 🏛️ Initialize zoom state with total sample count
                    zoomState.initialize(totalWorkletSamples);
                    
                    // 🎯 CRITICAL FIX: Wait for worklet to confirm it has buffered all samples
                    // Set up one-time listener for buffer confirmation
                    const bufferStatusHandler = (event) => {
                        if (event.data.type === 'buffer-status') {
                            const { samplesInBuffer, totalSamplesWritten } = event.data;
                            console.log(`📊 ${logTime()} Worklet buffer status: ${totalSamplesWritten.toLocaleString()} written, ${samplesInBuffer.toLocaleString()} buffered (expecting ${totalWorkletSamples.toLocaleString()} total)`);
                            
                            if (totalSamplesWritten >= totalWorkletSamples) {
                                // All samples buffered! Now send data-complete
                                console.log(`✅ ${logTime()} Worklet confirmed all samples buffered - sending data-complete`);
                                
                                // 🔥 KILL THE LOADING ANIMATION IMMEDIATELY - all samples received!
                                if (State.loadingInterval) {
                                    clearInterval(State.loadingInterval);
                                    State.setLoadingInterval(null);
                                }
                                
                                State.workletNode.port.postMessage({
                                    type: 'data-complete',
                                    totalSamples: totalWorkletSamples,
                                    sampleRate: originalSampleRate  // 🔥 CRITICAL: Send actual sample rate (50 Hz), not 44100!
                                });
                                
                                // Remove this handler
                                if (State.workletNode && State.workletBufferStatusHandler) {
                                    State.workletNode.port.removeEventListener('message', State.workletBufferStatusHandler);
                                    State.setWorkletBufferStatusHandler(null);
                                }
                                
                                // 🔥 FIX: Clear processedChunks array to release Float32Array and ArrayBuffer references
                                // This prevents the worker closure from retaining old audio data
                                // Explicitly null out each ArrayBuffer reference to allow GC
                                for (let i = 0; i < processedChunks.length; i++) {
                                    if (processedChunks[i]) {
                                        // Null out Float32Array references (which hold ArrayBuffer references)
                                        processedChunks[i].samples = null;
                                        processedChunks[i].rawSamples = null;
                                        // Clear the object itself
                                        processedChunks[i] = null;
                                    }
                                }
                                // 🔥 FIX: Clear the array length after nulling all elements
                                // Setting length to 0 helps GC reclaim the array structure
                                processedChunks.length = 0;
                                
                                // Terminate worker (we're done!)
                                worker.onmessage = null;  // Break closure chain
                                worker.terminate();
                                window.audioWorker = null; // 🧹 Clear global reference for GC
                                console.log('🏭 Worker terminated and cleared');
                                
                                // Update download size
                                document.getElementById('downloadSize').textContent = `${(totalBytesDownloaded / 1024 / 1024).toFixed(2)} MB`;
                                
                                // 🎯 FINAL WAVEFORM WITH DC REMOVAL (run in worker - no main thread blocking!)
                                // The waveform worker already has all samples accumulated progressively
                                // Just tell it to rebuild with DC removal OFF-THREAD
                                console.log(`🎨 ${logTime()} Requesting final detrended waveform (worker has all ${totalWorkletSamples.toLocaleString()} samples)`);
                                
                                const canvas = document.getElementById('waveform');
                                const removeDC = document.getElementById('removeDCOffset').checked;
                                const slider = document.getElementById('waveformFilterSlider');
                                const alpha = 0.9 + (parseInt(slider.value) / 1000); // 0.9 to 0.999
                                
                                State.waveformWorker.postMessage({
                                    type: 'build-waveform',
                                    canvasWidth: canvas.offsetWidth * window.devicePixelRatio,
                                    canvasHeight: canvas.offsetHeight * window.devicePixelRatio,
                                    removeDC: removeDC,  // Apply DC removal for final waveform
                                    alpha: alpha,
                                    isComplete: true,    // Flag this as the final complete waveform
                                    totalExpectedSamples: totalWorkletSamples
                                });
                                
                                console.log(`🎨 ${logTime()} Final waveform build requested (off-thread, won't block audio!)`);
                                
                                // Stitch samples for download button (lightweight operation)
                                const stitched = new Float32Array(totalWorkletSamples);
                                let offset = 0;
                                const chunkCount = State.allReceivedData.length;
                                for (const chunk of State.allReceivedData) {
                                    stitched.set(chunk, offset);
                                    offset += chunk.length;
                                }
                                State.setCompleteSamplesArray(stitched);
                                console.log(`📦 ${logTime()} Stitched ${chunkCount} chunks into completeSamplesArray for download`);
                                
                                // 🔥 FIX: Clear allReceivedData after stitching to free 3,685+ Float32Array chunks and their ArrayBuffers
                                // This breaks the closure chain: RAF callback → State → allReceivedData → chunks → ArrayBuffers
                                // Explicitly null out each chunk's ArrayBuffer reference before clearing
                                if (State.allReceivedData && State.allReceivedData.length > 0) {
                                    for (let i = 0; i < State.allReceivedData.length; i++) {
                                        State.allReceivedData[i] = null; // Break ArrayBuffer reference
                                    }
                                }
                                State.setAllReceivedData([]);
                                console.log(`🧹 ${logTime()} Cleared allReceivedData (${chunkCount} chunks) - ArrayBuffers freed`);
                                
                                updateCompleteButtonState();
                                
                                // 🎨 Render complete spectrogram now that all data is ready
                                console.log(`🎨 ${logTime()} Triggering complete spectrogram rendering...`);
                                startCompleteVisualization().catch(err => {
                                    console.error('❌ Error rendering complete spectrogram:', err);
                                });
                                
                                // Update UI
                                updatePlaybackSpeed();
                                updatePlaybackDuration();
                                State.setIsFetchingNewData(false);
                                
                                // Set completion message
                                const statusEl = document.getElementById('status');
                                if (statusEl) {
                                    statusEl.classList.remove('loading');
                                }
                                
                                // Only update button if it's still disabled (wasn't enabled when playback started)
                                const playPauseBtn = document.getElementById('playPauseBtn');
                                if (playPauseBtn && playPauseBtn.disabled) {
                                    playPauseBtn.disabled = false;
                                    const autoPlayEnabled = document.getElementById('autoPlay')?.checked;
                                    if (autoPlayEnabled && State.playbackState === PlaybackState.PLAYING) {
                                        // Auto play is on and playback is active - show Pause button
                                        playPauseBtn.textContent = '⏸️ Pause';
                                        playPauseBtn.classList.remove('play-active');
                                        playPauseBtn.classList.add('pause-active');
                                        // Status message removed per user request - no "Playing..." message
                                        if (statusEl) {
                                            statusEl.classList.remove('loading');
                                            statusEl.textContent = ''; // Clear status when playing
                                        }
                                    } else {
                                        // Auto play is off or playback not started - show Play button
                                        playPauseBtn.textContent = '▶️ Play';
                                        playPauseBtn.classList.remove('pause-active');
                                        playPauseBtn.classList.add('play-active');
                                        // Message will be shown after tutorial overlay appears
                                    }
                                } else {
                                    // Button already enabled - just update status if needed
                                    if (State.playbackState === PlaybackState.PLAYING) {
                                        // Status message removed per user request - no "Playing..." message
                                        if (statusEl) {
                                            statusEl.classList.remove('loading');
                                            statusEl.textContent = ''; // Clear status when playing
                                        }
                                    }
                                    // Message will be shown after tutorial overlay appears if not playing
                                }
                                // Enable loop button (no tutorial gates in EMIC)
                                const loopBtn = document.getElementById('loopBtn');
                                if (loopBtn) {
                                    loopBtn.disabled = false;
                                }
                                document.getElementById('downloadBtn').disabled = false;
                            } else {
                                // Not all samples written yet - wait a bit and check again
                                console.log(`⏳ ${logTime()} Waiting for more samples (${totalSamplesWritten}/${totalWorkletSamples})...`);
                                setTimeout(() => {
                                    State.workletNode.port.postMessage({ type: 'get-buffer-status' });
                                }, 50);
                            }
                        }
                    };
                    
                    // 🔥 FIX: Store handler reference so it can be removed during cleanup
                    State.setWorkletBufferStatusHandler(bufferStatusHandler);
                    State.workletNode.port.addEventListener('message', bufferStatusHandler);
                    
                    // Request initial buffer status
                    console.log(`🔍 ${logTime()} Requesting worklet buffer status...`);
                    State.workletNode.port.postMessage({ type: 'get-buffer-status' });
                }
            }
        };
        
        // Helper function to build complete waveform (called in idle callback)
        function buildCompleteWaveform(processedChunks, chunksToFetch, normMin, normMax, totalSamples) {
            console.log('🎨 Building complete waveform...');
            const t0 = performance.now();
            
            // Stitch all chunks together
            // Note: Some chunks may have samples=null due to progressive memory cleanup
            let totalLength = 0;
            for (let i = 0; i < processedChunks.length; i++) {
                if (processedChunks[i] && processedChunks[i].samples) {
                    totalLength += processedChunks[i].samples.length;
                }
            }
            
            const stitchedFloat32 = new Float32Array(totalLength);
            const stitchedRaw = new Float32Array(totalLength);
            
            let offset = 0;
            for (let i = 0; i < processedChunks.length; i++) {
                if (processedChunks[i] && processedChunks[i].samples) {
                    const { samples, rawSamples } = processedChunks[i];
                    stitchedFloat32.set(samples, offset);
                    stitchedRaw.set(rawSamples, offset);
                    offset += samples.length;
                }
            }
            
            // Store for waveform drawing
            State.setCompleteSamplesArray(stitchedFloat32);
            window.rawWaveformData = stitchedRaw;
            
            updateCompleteButtonState();
            
            // 🔥 FIX: Clear allReceivedData after stitching to free Float32Array chunks and their ArrayBuffers
            // This breaks the closure chain: RAF callback → State → allReceivedData → chunks → ArrayBuffers
            // Explicitly null out each chunk's ArrayBuffer reference before clearing
            if (State.allReceivedData && State.allReceivedData.length > 0) {
                for (let i = 0; i < State.allReceivedData.length; i++) {
                    State.allReceivedData[i] = null; // Break ArrayBuffer reference
                }
            }
            State.setAllReceivedData([]);
            
            // Update UI metrics
            document.getElementById('sampleCount').textContent = stitchedFloat32.length.toLocaleString();
            // 👑 CRITICAL: Use original sample rate from metadata, NOT AudioContext rate!
            const originalSampleRate = State.currentMetadata?.original_sample_rate || 50;
            State.setTotalAudioDuration(stitchedFloat32.length / originalSampleRate);
            
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
        if (DEBUG_CHUNKS) console.log(`📋 ${logTime()} Progressive chunks: ${chunksToFetch.length} total`);
        if (DEBUG_CHUNKS) console.log(`📋 ${logTime()} Breakdown: ${Object.entries(typeCount).map(([t, c]) => `${c}×${t}`).join(', ')}`);
        
        // Show batch plan
        const batchPlan = downloadBatches.map((batch, i) => {
            const type = chunksToFetch[batch[0]].type;
            return batch.length === 1 ? `1×${type}` : `${batch.length}×${type}`;
        }).join(' → ');
        if (DEBUG_CHUNKS) {
            console.log(`🚀 ${logTime()} Download plan: ${batchPlan}`);
            console.log(`📦 ${logTime()} Total batches: ${downloadBatches.length}`);
        }
        
        // Fetch function - DIRECT FROM CDN
        async function fetchChunk(chunkData) {
            const { chunk, index } = chunkData;
            
            // Build CDN URL
            const location = stationData.location || '--';
            const sampleRate = Math.round(stationData.sample_rate || 100);
            
            // Convert YYYY-MM-DD to YYYY/MM/DD for CDN path
            const [year, month, day] = chunk.date.split('-');
            const datePath = `${year}/${month}/${day}`;
            
            // Calculate NEW format end date (might be next day if chunk crosses midnight)
            const startDateTime = new Date(`${chunk.date}T${chunk.start}Z`);
            const chunkDurationMinutes = {
                '10m': 10,
                '1h': 60,
                '6h': 360
            }[chunk.type];
            const endDateTime = new Date(startDateTime.getTime() + chunkDurationMinutes * 60 * 1000);
            const endDate = endDateTime.toISOString().split('T')[0]; // YYYY-MM-DD
            
            // Check if chunk crosses midnight
            const crossesMidnight = chunk.date !== endDate;
            
            // If crossing midnight, also prepare end date path
            let endDatePath = null;
            if (crossesMidnight) {
                const [endYear, endMonth, endDay] = endDate.split('-');
                endDatePath = `${endYear}/${endMonth}/${endDay}`;
            }
            
            // Calculate OLD format end date/time (1 second before, for :59 suffix)
            const oldEndDateTime = new Date(startDateTime.getTime() + chunkDurationMinutes * 60 * 1000 - 1000);
            const oldEndDate = oldEndDateTime.toISOString().split('T')[0]; // YYYY-MM-DD
            const oldEndTime = oldEndDateTime.toISOString().split('T')[1].substring(0, 8); // HH:MM:SS
            
            // Convert start/end times to filename format
            const startFormatted = chunk.start.replace(/:/g, '-');
            // Use calculated endDateTime instead of chunk.end (handles midnight crossing correctly)
            const endTime = endDateTime.toISOString().split('T')[1].substring(0, 8); // HH:MM:SS
            const endFormatted = endTime.replace(/:/g, '-');
            const oldEndFormatted = oldEndTime.replace(/:/g, '-');
            
            // Try NEW format first (no sample rate, :00 ending)
            const newFilename = `${stationData.network}_${stationData.station}_${location}_${stationData.channel}_${chunk.type}_${chunk.date}-${startFormatted}_to_${endDate}-${endFormatted}.bin.zst`;
            
            // Try start date path first
            let newChunkUrl = `${CDN_BASE_URL}/${datePath}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/${chunk.type}/${newFilename}${cacheBuster}`;
            let response = await fetch(newChunkUrl);
            
            // If not found and crosses midnight, try end date path
            if (!response.ok && crossesMidnight && endDatePath) {
                newChunkUrl = `${CDN_BASE_URL}/${endDatePath}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/${chunk.type}/${newFilename}${cacheBuster}`;
                response = await fetch(newChunkUrl);
            }
            
            // If NEW format with :00 ending not found, try NEW format with :59 ending (hybrid format - some stations use this)
            if (!response.ok) {
                const hybridFilename = `${stationData.network}_${stationData.station}_${location}_${stationData.channel}_${chunk.type}_${chunk.date}-${startFormatted}_to_${oldEndDate}-${oldEndFormatted}.bin.zst`;
                
                // Try start date path first
                let hybridChunkUrl = `${CDN_BASE_URL}/${datePath}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/${chunk.type}/${hybridFilename}${cacheBuster}`;
                response = await fetch(hybridChunkUrl);
                
                // If not found and crosses midnight, try end date path
                if (!response.ok && crossesMidnight && endDatePath) {
                    hybridChunkUrl = `${CDN_BASE_URL}/${endDatePath}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/${chunk.type}/${hybridFilename}${cacheBuster}`;
                    response = await fetch(hybridChunkUrl);
                }
            }
            
            // If NEW format (both variants) not found, try OLD format (with sample rate + :59 end time)
            if (!response.ok) {
                const oldFilename = `${stationData.network}_${stationData.station}_${location}_${stationData.channel}_${sampleRate}Hz_${chunk.type}_${chunk.date}-${startFormatted}_to_${oldEndDate}-${oldEndFormatted}.bin.zst`;
                
                // Try start date path first
                let oldChunkUrl = `${CDN_BASE_URL}/${datePath}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/${chunk.type}/${oldFilename}${cacheBuster}`;
                response = await fetch(oldChunkUrl);
                
                // If not found and crosses midnight, try end date path
                if (!response.ok && crossesMidnight && endDatePath) {
                    oldChunkUrl = `${CDN_BASE_URL}/${endDatePath}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/${chunk.type}/${oldFilename}${cacheBuster}`;
                    response = await fetch(oldChunkUrl);
                }
                
                if (!response.ok) {
                    throw new Error(`Chunk ${index + 1} fetch failed in NEW format (:00), NEW format (:59), and OLD format (tried start date path${crossesMidnight ? ' and end date path' : ''}): ${response.status}`);
                }
            }
            
            const compressed = await response.arrayBuffer();
            const chunkSize = compressed.byteLength;
            totalBytesDownloaded += chunkSize;
            
            // Update download size display incrementally as each chunk arrives
            document.getElementById('downloadSize').textContent = `${(totalBytesDownloaded / 1024 / 1024).toFixed(2)} MB`;
            
            return { compressed, chunkSize, index };
        }
        
        let chunksDownloaded = 0;
        
        // Helper to send chunk to worker
        const sendToWorker = (result) => {
            const { compressed, chunkSize, index, isMissing, expectedSamples } = result;
            chunksDownloaded++;
            
            // 🆕 Handle missing chunks - send flag to worker to generate zeros
            if (isMissing) {
                worker.postMessage({
                    type: 'process-chunk',
                    compressed: null,
                    normMin: normMin,
                    normMax: normMax,
                    chunkIndex: index,
                    isMissing: true,
                    expectedSamples: expectedSamples
                });
                
                const chunkType = chunksToFetch[index].type;
                if (DEBUG_CHUNKS) console.log(`🔇 ${logTime()} Generated silence for chunk ${index + 1}/${chunksToFetch.length} (${chunkType}) - ${expectedSamples.toLocaleString()} samples (${chunksDownloaded}/${chunksToFetch.length})`);
            } else {
                worker.postMessage({
                    type: 'process-chunk',
                    compressed: compressed,
                    normMin: normMin,
                    normMax: normMax,
                    chunkIndex: index
                }, [compressed]);
                
                const chunkType = chunksToFetch[index].type;
                if (DEBUG_CHUNKS) console.log(`📥 ${logTime()} Downloaded chunk ${index + 1}/${chunksToFetch.length} (${chunkType}) - ${(chunkSize / 1024).toFixed(1)} KB (${chunksDownloaded}/${chunksToFetch.length})`);
            }
        };
        
        // Execute batches sequentially, chunks within batch in parallel
        for (let batchIdx = 0; batchIdx < downloadBatches.length; batchIdx++) {
            const batchIndices = downloadBatches[batchIdx];
            const chunkType = chunksToFetch[batchIndices[0]].type;
            const batchLabel = batchIndices.length === 1 ? 
                `1×${chunkType} alone` : 
                `${batchIndices.length}×${chunkType} parallel`;
            
            if (DEBUG_CHUNKS) console.log(`📦 ${logTime()} Batch ${batchIdx + 1}/${downloadBatches.length}: ${batchLabel} (chunks ${batchIndices.map(i => i + 1).join(', ')})`);
            
            // Download all chunks in this batch IN PARALLEL (or generate zeros for missing)
            const batchPromises = batchIndices.map(idx => {
                const chunk = chunksToFetch[idx];
                
                // 🆕 Check if chunk is missing - generate zeros instead of fetching
                if (chunk.isMissing) {
                    return Promise.resolve({
                        compressed: null,
                        chunkSize: 0,
                        index: idx,
                        isMissing: true,
                        expectedSamples: chunk.samples
                    });
                }
                
                // Normal fetch for existing chunks
                return fetchChunk({ chunk: chunk, index: idx });
            });
            const batchResults = await Promise.all(batchPromises);
            
            // Send to worker
            batchResults.forEach(sendToWorker);
            
            // Wait for first batch (chunk 0) to be processed before continuing
            if (batchIdx === 0) {
                if (DEBUG_CHUNKS) console.log(`⏳ ${logTime()} Waiting for chunk 0 to process...`);
                await firstChunkProcessed;
                if (DEBUG_CHUNKS) console.log(`✅ ${logTime()} Chunk 0 ready - AUDIO PLAYING! Continuing with next batches...`);
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

// ╔═══════════════════════════════════════════════════════════════════════════════╗
// ║  🚫🚫🚫 INACTIVE PATH - COMPLETELY COMMENTED OUT 🚫🚫🚫                        ║
// ║  This entire function is disabled and not used.                               ║
// ║  The ACTIVE path is fetchAndLoadCDAWebData() and fetchCDAWebAudio() above.    ║
// ╚═══════════════════════════════════════════════════════════════════════════════╝
// ===== MODE 2: RAILWAY BACKEND (ORIGINAL PATH) =====
// ⚠️ DEPRECATED CODE - DO NOT UPDATE EVER. DO NOT TOUCH THIS CODE.
// This code path is deprecated and should not be modified.
// 🚫 COMMENTED OUT - Railway fetch path disabled
/* export async function fetchFromRailway(stationData, startTime, duration, highpassFreq, enableNormalize) {
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
        // 🔥 FIX: Use local reference to avoid potential closure retention
        // fzstd is a global library, but using a local const helps ensure no closure capture
        const decompressFn = fzstd.decompress;
        decompressed = decompressFn(new Uint8Array(receivedBlob));
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
    State.setCurrentMetadata(metadata);
    
    // Calculate and store start/end times for x-axis rendering
    const endTime = new Date(startTime.getTime() + duration * 3600 * 1000);
    State.setDataStartTime(startTime);
    State.setDataEndTime(endTime);
    
    // 🔥 Load saved regions now that time range is known
    loadRegionsAfterDataFetch();
    
    // Draw frequency axis with new metadata
    positionAxisCanvas();
    initializeAxisPlaybackRate();
    
    // Draw x-axis with new time data
    positionWaveformXAxisCanvas();
    drawWaveformXAxis();
    positionSpectrogramXAxisCanvas();
    drawSpectrogramXAxis();
    positionWaveformDateCanvas();
    drawWaveformDate();
    
    // Extract samples
    const samplesOffset = 4 + metadataLength;
    const samplesBytes = decompressed.slice(samplesOffset);
    let samples = new Float32Array(samplesBytes.buffer, samplesBytes.byteOffset, samplesBytes.length / 4);
    
    // 🔥 FIX: Explicitly null out decompressed to allow GC of original buffer
    // The Float32Array we created above shares the buffer, but we've copied what we need
    decompressed = null;
    
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
    State.setCompleteSamplesArray(samples);
    
    // Enable Begin Analysis/Complete button after data download completes (skip during tutorial)
    if (!isTutorialActive()) {
        updateCompleteButtonState(); // Handles both "Begin Analysis" and "Complete" modes
    }
    
    // Send samples to waveform worker BEFORE building waveform
    State.waveformWorker.postMessage({
        type: 'add-samples',
        samples: samples,
        rawSamples: rawSamples
    });
    
    // Send to AudioWorklet in chunks
    console.log('🎵 Sending to AudioWorklet in 1024-sample chunks...');
    const WORKLET_CHUNK_SIZE = 1024;
    State.setAllReceivedData([]);
    
    for (let i = 0; i < samples.length; i += WORKLET_CHUNK_SIZE) {
        const chunkSize = Math.min(WORKLET_CHUNK_SIZE, samples.length - i);
        // 🔥 FIX: Copy slice to new ArrayBuffer instead of sharing buffer
        // This allows GC of individual chunks independently
        const slice = samples.slice(i, i + chunkSize);
        const chunk = new Float32Array(slice); // Copy to new ArrayBuffer
        
        State.workletNode.port.postMessage({
            type: 'audio-data',
            data: chunk,
            autoResume: State.playbackState === PlaybackState.PLAYING,
        });
        
        State.allReceivedData.push(chunk);
    }
    
    // Draw complete waveform
    drawWaveform();
    
    console.log(`✅ Sent ${State.allReceivedData.length} chunks to AudioWorklet`);
    
    // Check if this is a shared session - don't auto-play
    const isSharedSession = sessionStorage.getItem('isSharedSession') === 'true';
    const autoPlayEnabled = !isSharedSession && document.getElementById('autoPlay')?.checked;

    if (autoPlayEnabled) {
        // 🎯 FORCE IMMEDIATE PLAYBACK
        State.workletNode.port.postMessage({
            type: 'start-immediately'
        });
        console.log(`🚀 Sent 'start-immediately' to worklet`);

        // Fade-in audio
        if (State.gainNode && State.audioContext) {
            const targetVolume = parseFloat(document.getElementById('volumeSlider').value) / 100;
            State.gainNode.gain.cancelScheduledValues(State.audioContext.currentTime);
            State.gainNode.gain.setValueAtTime(0.0001, State.audioContext.currentTime);
            State.gainNode.gain.exponentialRampToValueAtTime(
                Math.max(0.01, targetVolume),
                State.audioContext.currentTime + 0.05
            );
            console.log(`🔊 Fade-in scheduled: 0.0001 → ${targetVolume.toFixed(2)} over 50ms`);
        }

        // Reset position tracking
        State.setCurrentAudioPosition(0);
        State.setLastWorkletPosition(0);
        State.setLastWorkletUpdateTime(State.audioContext.currentTime);
        State.setLastUpdateTime(State.audioContext.currentTime);

        // Enable play button immediately when playback starts
        const playPauseBtn = document.getElementById('playPauseBtn');
        playPauseBtn.disabled = false;
        playPauseBtn.textContent = '⏸️ Pause';
        playPauseBtn.classList.remove('play-active', 'secondary', 'pulse-attention');
        playPauseBtn.classList.add('pause-active');

        // Start playback indicator
        startPlaybackIndicator();
    } else {
        if (isSharedSession) {
            console.log(`🔗 Shared session loaded - waiting for user to click Play`);
        } else {
            console.log(`⏸️ Auto Play disabled - waiting for user to click Play`);
        }
        // Don't start playback, but keep state ready
        State.setPlaybackState(PlaybackState.STOPPED);
        // Enable play button so user can start playback
        const playPauseBtn = document.getElementById('playPauseBtn');
        playPauseBtn.disabled = false;
        playPauseBtn.textContent = '▶️ Play';
        playPauseBtn.classList.remove('pause-active', 'secondary');
        playPauseBtn.classList.add('play-active');

        // Add pulse animation for shared sessions
        if (isSharedSession) {
            playPauseBtn.classList.add('pulse-attention');
            const status = document.getElementById('status');
            if (status) {
                status.textContent = '🎧 Ready! Click Play or press Space Bar to start playback';
                status.className = 'status info';
            }
        }
    }
    
    // 🎯 CRITICAL FIX: Wait for worklet to confirm it has buffered all samples (Railway path)
    const totalRailwaySamples = samples.length;
    
    // 🏛️ Initialize zoom state with total sample count (Railway path)
    zoomState.initialize(totalRailwaySamples);
    
    const railwayBufferStatusHandler = (event) => {
        if (event.data.type === 'buffer-status') {
            const { samplesInBuffer, totalSamplesWritten } = event.data;
            console.log(`📊 [Railway] Worklet buffer status: ${totalSamplesWritten.toLocaleString()} written, ${samplesInBuffer.toLocaleString()} buffered (expecting ${totalRailwaySamples.toLocaleString()} total)`);
            
            if (totalSamplesWritten >= totalRailwaySamples) {
                // All samples buffered! Now send data-complete
                console.log(`✅ [Railway] Worklet confirmed all samples buffered - sending data-complete`);
                
                // 🔥 KILL THE LOADING ANIMATION IMMEDIATELY - all samples received!
                if (State.loadingInterval) {
                    clearInterval(State.loadingInterval);
                    State.setLoadingInterval(null);
                }
                
                const railwaySampleRate = State.currentMetadata?.original_sample_rate || 50;
                State.workletNode.port.postMessage({ 
                    type: 'data-complete',
                    totalSamples: totalRailwaySamples,
                    sampleRate: railwaySampleRate  // 🔥 CRITICAL: Send actual sample rate (50 Hz), not 44100!
                });
                
                // Remove this handler
                if (State.workletNode && State.workletRailwayBufferStatusHandler) {
                    State.workletNode.port.removeEventListener('message', State.workletRailwayBufferStatusHandler);
                    State.setWorkletRailwayBufferStatusHandler(null);
                }
                
                // Set playback speed
                updatePlaybackSpeed();
                
                // Set anti-aliasing filter
                if (State.workletNode) {
                    State.workletNode.port.postMessage({
                        type: 'set-anti-aliasing',
                        enabled: true  // Always enabled
                    });
                }
                
                // Update playback duration
                updatePlaybackDuration();
                
                // Enable volume slider if tutorial is in progress (speed gets enabled during speed tutorial step)
                (async () => {
                    const { isTutorialInProgress } = await import('./study-workflow.js');
                    if (isTutorialInProgress()) {
                        const volumeSlider = document.getElementById('volumeSlider');
                        const volumeLabel = document.getElementById('volumeLabel');
                        if (volumeSlider) volumeSlider.disabled = false;
                        if (volumeLabel) volumeLabel.style.opacity = '1';
                        console.log('🔓 Volume slider ENABLED after fetch (tutorial in progress)');
                    }
                })();
                
                // Note: Features are enabled by default - only tutorial disables them
                // Tutorial is now managed by runInitialTutorial() which waits for data to be fetched
                // No need to call runMainTutorial() here - it will be called automatically
                setTimeout(() => {
                    const statusEl = document.getElementById('status');
                    if (statusEl) {
                        statusEl.classList.remove('loading');
                        statusEl.className = 'status success';
                    }
                }, 200);
            } else {
                // Not all samples written yet - wait a bit and check again
                console.log(`⏳ [Railway] Waiting for more samples (${totalSamplesWritten}/${totalRailwaySamples})...`);
                setTimeout(() => {
                    State.workletNode.port.postMessage({ type: 'get-buffer-status' });
                }, 50);
            }
        }
    };
    
    // 🔥 FIX: Store handler reference so it can be removed during cleanup
    State.setWorkletRailwayBufferStatusHandler(railwayBufferStatusHandler);
    State.workletNode.port.addEventListener('message', railwayBufferStatusHandler);
    
    // Request initial buffer status
    console.log(`🔍 [Railway] Requesting worklet buffer status...`);
    State.workletNode.port.postMessage({ type: 'get-buffer-status' });
    
    // Clear fetching flag
    State.setIsFetchingNewData(false);
    
    // Stop loading animation and immediately set completion message (no gap!)
    const statusEl = document.getElementById('status');
    if (State.loadingInterval) {
        clearInterval(State.loadingInterval);
        State.setLoadingInterval(null);
    }
    
    // Check if this is a shared session - don't overwrite the "Ready! Click Play..." status
    const isSharedSession = sessionStorage.getItem('isSharedSession') === 'true';

    // Only update button if it's still disabled (wasn't enabled when playback started)
    const playPauseBtn = document.getElementById('playPauseBtn');
    if (playPauseBtn.disabled) {
        playPauseBtn.disabled = false;
        const autoPlayEnabled = document.getElementById('autoPlay')?.checked;
        if (autoPlayEnabled && State.playbackState === PlaybackState.PLAYING) {
            // Auto play is on and playback is active - show Pause button
            playPauseBtn.textContent = '⏸️ Pause';
            playPauseBtn.classList.remove('play-active', 'secondary');
            playPauseBtn.classList.add('pause-active');
            if (statusEl) {
                statusEl.classList.remove('loading');
                statusEl.textContent = ''; // Clear status when playing - no "Playing..." message
            }
        } else {
            // Auto play is off or playback not started - show Play button
            playPauseBtn.textContent = '▶️ Play';
            playPauseBtn.classList.remove('pause-active', 'secondary');
            playPauseBtn.classList.add('play-active');
            if (statusEl && !isSharedSession) {
                // Only show default status for non-shared sessions
                // Shared sessions already have "Ready! Click Play..." status set
                statusEl.classList.remove('loading');
                statusEl.className = 'status success';
                setStatusText('👇 Click on the waveform below to move the playhead.', 'status success');
            }
        }
    } else {
        // Button already enabled - just update status if needed
        if (State.playbackState === PlaybackState.PLAYING) {
            if (statusEl) {
                statusEl.classList.remove('loading');
                statusEl.textContent = ''; // Clear status when playing - no "Playing..." message
            }
        } else {
            if (statusEl && !isSharedSession) {
                // Only show default status for non-shared sessions
                statusEl.classList.remove('loading');
                statusEl.className = 'status success';
                setStatusText('👇 Click on the waveform below to move the playhead.', 'status success');
            }
        }
    }
    document.getElementById('downloadBtn').disabled = false;
    
    // Enable loop button if tutorial is skipped (Personal mode or Study mode after first session)
    Promise.all([
        import('./master-modes.js'),
        import('./volcano/study-workflow.js')
    ]).then(([{ shouldSkipTutorial, isStudyMode }, { isTutorialCompleted }]) => {
        const loopBtn = document.getElementById('loopBtn');
        if (loopBtn) {
            if (shouldSkipTutorial()) {
                // Personal mode - enable immediately
                loopBtn.disabled = false;
            } else if (isStudyMode()) {
                // Study mode - check if tutorial already seen
                if (isTutorialCompleted()) {
                    loopBtn.disabled = false;
                }
                // If not seen, tutorial will enable it
            } else {
                // Dev mode - tutorial will enable it
            }
        }
    });
    
    console.log('✅ Streaming complete from Railway backend');
} */

