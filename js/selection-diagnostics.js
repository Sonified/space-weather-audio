/**
 * selection-diagnostics.js
 * Comprehensive diagnostic tool for tracking and validating waveform selections
 * across all coordinate systems: pixels, percentages, samples, times, and timestamps
 */

import * as State from './audio-state.js';

const SAMPLE_RATE = 44100; // Hz
const ENABLE_DIAGNOSTICS = false; // Set to true to enable detailed selection diagnostics logging

/**
 * Convert pixel X coordinate to all other coordinate systems
 */
export function pixelToAllCoordinates(pixelX, canvasWidth) {
    if (!State.completeSamplesArray || !State.totalAudioDuration || !State.dataStartTime || !State.dataEndTime) {
        console.warn('⚠️ Cannot convert coordinates - missing data');
        return null;
    }
    
    const totalSamples = State.completeSamplesArray.length;
    const dataStartMs = State.dataStartTime.getTime();
    const dataEndMs = State.dataEndTime.getTime();
    const totalDurationMs = dataEndMs - dataStartMs;
    
    // 1. Pixel → Progress (0-1)
    const progress = pixelX / canvasWidth;
    const progressPercent = progress * 100;
    
    // 2. Progress → Audio time (seconds from start of audio)
    const audioTime = progress * State.totalAudioDuration;
    
    // 3. Audio time → Sample index
    const sampleIndex = Math.floor(audioTime * SAMPLE_RATE);
    const samplePercent = (sampleIndex / totalSamples) * 100;
    
    // 4. Progress → Real timestamp
    const realTimeMs = dataStartMs + (progress * totalDurationMs);
    const realTimestamp = new Date(realTimeMs);
    const realTimePercent = ((realTimeMs - dataStartMs) / totalDurationMs) * 100;
    
    return {
        // Raw values
        pixelX,
        canvasWidth,
        progress,
        progressPercent,
        audioTime,
        sampleIndex,
        totalSamples,
        samplePercent,
        realTimestamp,
        realTimeMs,
        dataStartMs,
        dataEndMs,
        totalDurationMs,
        realTimePercent,
        
        // Validation: all percentages should match
        percentagesMatch: Math.abs(progressPercent - samplePercent) < 0.01 && 
                          Math.abs(progressPercent - realTimePercent) < 0.01
    };
}

/**
 * Print comprehensive diagnostic information for a selection
 */
export function printSelectionDiagnostics(startPixelX, endPixelX, canvasWidth) {
    if (!ENABLE_DIAGNOSTICS) return; // Skip if disabled
    
    console.log('\n' + '='.repeat(80));
    console.log('🔍 SELECTION DIAGNOSTICS');
    console.log('='.repeat(80));
    
    // Convert both endpoints
    const start = pixelToAllCoordinates(startPixelX, canvasWidth);
    const end = pixelToAllCoordinates(endPixelX, canvasWidth);
    
    if (!start || !end) {
        console.error('❌ Cannot generate diagnostics - missing data');
        return;
    }
    
    // Print canvas/pixel information
    console.log('\n📐 CANVAS & PIXELS (Window Units)');
    console.log(`   Canvas Width:    ${canvasWidth.toFixed(2)} px`);
    console.log(`   Start Pixel:     ${startPixelX.toFixed(2)} px`);
    console.log(`   End Pixel:       ${endPixelX.toFixed(2)} px`);
    console.log(`   Selection Width: ${Math.abs(endPixelX - startPixelX).toFixed(2)} px`);
    
    // Print progress percentages
    console.log('\n📊 PROGRESS (Percentage through waveform)');
    console.log(`   Start:    ${start.progressPercent.toFixed(4)}%`);
    console.log(`   End:      ${end.progressPercent.toFixed(4)}%`);
    console.log(`   Duration: ${(end.progressPercent - start.progressPercent).toFixed(4)}%`);
    
    // Print audio time (seconds)
    console.log('\n⏱️  AUDIO TIME (Playback seconds)');
    console.log(`   Total Duration:      ${State.totalAudioDuration.toFixed(4)} s`);
    console.log(`   Start Time:          ${start.audioTime.toFixed(4)} s`);
    console.log(`   End Time:            ${end.audioTime.toFixed(4)} s`);
    console.log(`   Selection Duration:  ${(end.audioTime - start.audioTime).toFixed(4)} s`);
    console.log(`   Start %:             ${(start.audioTime / State.totalAudioDuration * 100).toFixed(4)}%`);
    console.log(`   End %:               ${(end.audioTime / State.totalAudioDuration * 100).toFixed(4)}%`);
    
    // Print sample indices
    console.log('\n🎵 SAMPLES (Audio buffer indices @ 44100 Hz)');
    console.log(`   Total Samples:       ${start.totalSamples.toLocaleString()} samples`);
    console.log(`   Start Sample:        ${start.sampleIndex.toLocaleString()}`);
    console.log(`   End Sample:          ${end.sampleIndex.toLocaleString()}`);
    console.log(`   Selection Samples:   ${(end.sampleIndex - start.sampleIndex).toLocaleString()}`);
    console.log(`   Start %:             ${start.samplePercent.toFixed(4)}%`);
    console.log(`   End %:               ${end.samplePercent.toFixed(4)}%`);
    
    // Print real timestamps
    console.log('\n🌐 REAL TIMESTAMPS (UTC)');
    console.log(`   Dataset Start:       ${State.dataStartTime.toISOString()}`);
    console.log(`   Dataset End:         ${State.dataEndTime.toISOString()}`);
    console.log(`   Dataset Duration:    ${(start.totalDurationMs / 1000).toFixed(2)} s`);
    console.log(`   Selection Start:     ${start.realTimestamp.toISOString()}`);
    console.log(`   Selection End:       ${end.realTimestamp.toISOString()}`);
    console.log(`   Selection Duration:  ${((end.realTimeMs - start.realTimeMs) / 1000).toFixed(4)} s`);
    console.log(`   Start %:             ${start.realTimePercent.toFixed(4)}%`);
    console.log(`   End %:               ${end.realTimePercent.toFixed(4)}%`);
    
    // Validation
    console.log('\n✅ VALIDATION (All percentages should match)');
    console.log(`   Progress %:    ${start.progressPercent.toFixed(4)}% → ${end.progressPercent.toFixed(4)}%`);
    console.log(`   Sample %:      ${start.samplePercent.toFixed(4)}% → ${end.samplePercent.toFixed(4)}%`);
    console.log(`   Real Time %:   ${start.realTimePercent.toFixed(4)}% → ${end.realTimePercent.toFixed(4)}%`);
    
    const startMatch = Math.abs(start.progressPercent - start.samplePercent) < 0.01 && 
                       Math.abs(start.progressPercent - start.realTimePercent) < 0.01;
    const endMatch = Math.abs(end.progressPercent - end.samplePercent) < 0.01 && 
                     Math.abs(end.progressPercent - end.realTimePercent) < 0.01;
    
    if (startMatch && endMatch) {
        console.log(`   ✅ ALL COORDINATE SYSTEMS MATCH!`);
    } else {
        console.log(`   ❌ MISMATCH DETECTED!`);
        if (!startMatch) {
            console.log(`      Start point mismatch: progress=${start.progressPercent.toFixed(4)}%, sample=${start.samplePercent.toFixed(4)}%, time=${start.realTimePercent.toFixed(4)}%`);
        }
        if (!endMatch) {
            console.log(`      End point mismatch: progress=${end.progressPercent.toFixed(4)}%, sample=${end.samplePercent.toFixed(4)}%, time=${end.realTimePercent.toFixed(4)}%`);
        }
    }
    
    console.log('='.repeat(80) + '\n');
    
    return { start, end, valid: startMatch && endMatch };
}

/**
 * Print diagnostics for current selection (if any)
 */
export function printCurrentSelection() {
    if (State.selectionStart === null || State.selectionEnd === null) {
        console.log('ℹ️  No active selection');
        return;
    }
    
    const canvas = document.getElementById('waveform');
    if (!canvas) {
        console.error('❌ Cannot find waveform canvas');
        return;
    }
    
    const canvasWidth = canvas.offsetWidth;
    
    // Convert time selections back to pixels for diagnostics
    const startProgress = State.selectionStart / State.totalAudioDuration;
    const endProgress = State.selectionEnd / State.totalAudioDuration;
    const startPixelX = startProgress * canvasWidth;
    const endPixelX = endProgress * canvasWidth;
    
    printSelectionDiagnostics(startPixelX, endPixelX, canvasWidth);
}

/**
 * Test function to print diagnostics at a specific percentage through the audio
 */
export function testAtPercentage(percent) {
    const canvas = document.getElementById('waveform');
    if (!canvas) {
        console.error('❌ Cannot find waveform canvas');
        return;
    }
    
    const canvasWidth = canvas.offsetWidth;
    const pixelX = (percent / 100) * canvasWidth;
    
    console.log(`\n🧪 Testing at ${percent}% through audio (${pixelX.toFixed(2)} px)`);
    const coords = pixelToAllCoordinates(pixelX, canvasWidth);
    
    if (coords) {
        console.log(`   Audio Time:   ${coords.audioTime.toFixed(4)} s`);
        console.log(`   Sample Index: ${coords.sampleIndex.toLocaleString()}`);
        console.log(`   Timestamp:    ${coords.realTimestamp.toISOString()}`);
        console.log(`   Valid:        ${coords.percentagesMatch ? '✅' : '❌'}`);
    }
}

/**
 * Export function for console access
 */
export function enableDiagnostics() {
    window.printSelectionDiagnostics = printSelectionDiagnostics;
    window.printCurrentSelection = printCurrentSelection;
    window.testAtPercentage = testAtPercentage;
    console.log('✅ Selection diagnostics enabled');
    console.log('   Use: window.printCurrentSelection() - Print diagnostics for active selection');
    console.log('   Use: window.testAtPercentage(50) - Test coordinates at specific percentage');
}

