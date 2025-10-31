# SeedLink Real-Time Audification - Current Status

## Current State: NOT WORKING - Clicking Audio

### What We Tried
- Connected to IRIS SeedLink for live seismic data from HV.NPOC.HHZ (Kīlauea)
- Receives ~400-500 samples at 100 Hz every ~5 seconds
- High-pass filter (0.1 Hz cutoff) to remove DC drift
- Adaptive normalization
- Upsample from 100 Hz to 8 kHz (for audio hardware)
- Real-time playback (no speedup)

### The Problem
**Audio is just clicking, not smooth playback.**

### ROOT CAUSE IDENTIFIED
**SeedLink delivers packets in BURSTS, not real-time streams.**

From diagnostics:
- **Sample Deficit:** 107,276 (consuming faster than receiving)
- **Effective Sample Rate:** 144 Hz (should be 100 Hz)
- **Avg Inter-Packet Time:** 2.86s (irregular)
- **Last 5 Packet Gaps:** 0.0s, 0.0s, 0.0s, 0.0s, 0.0s (BURST delivery!)
- **Audio Underruns:** 595+ (constant buffer starvation)

**What's happening:**
1. SeedLink sends multiple packets simultaneously in a burst
2. Buffer fills quickly with upsampled audio
3. Audio plays continuously at 8 kHz
4. Buffer drains completely before next burst arrives
5. Underruns create silence/clicks between bursts

**The math:**
- 409 samples @ 100 Hz → 32,720 audio samples @ 8 kHz
- That's 4.09 seconds of audio per packet
- But packets arrive in bursts with long gaps between
- Audio consumes smoothly, data arrives in chunks = CLICKING

### What We Need Before This Works
- [ ] Detailed packet arrival timestamps (measure actual time between packets)
- [ ] Historical log of samples received vs samples consumed
- [ ] Buffer level over time (should stay relatively stable)
- [ ] Verify no gaps/overlaps in packet timestamps from IRIS
- [ ] Verify audio callback is consuming sequentially from buffer
- [ ] May need to handle the ~1 second gap between packets differently

### Audio Model
Yes - we're assigning amplitude values sequentially to an audio stream. The audio pointer is driven by the sounddevice callback consuming from our buffer at 8000 samples/second. We append each packet to the buffer sequentially, so they should stitch together in time order.

### Why This Approach Won't Work:
SeedLink is designed for **data collection**, not **real-time playback**. It delivers data "as fast as possible" to catch up to real-time, which means:
- Historical data comes in bursts
- Even "live" data has network jitter and buffering
- No guarantee of smooth, evenly-spaced packet delivery

### Alternative Approaches to Consider:
1. **Accept non-real-time:** Buffer 30-60 seconds before starting playback (essentially a delay)
2. **Different protocol:** Use WebSocket-based streaming if IRIS offers it
3. **Local recording first:** Record to disk, then play back smoothly
4. **Haptic device only:** Since haptics are tactile, bursts might be acceptable (no audio perception issues)
5. **Client-side rate limiting:** Add artificial delays to smooth out bursts (but defeats real-time purpose)

## Update: IT WORKS! (2025-10-30 Evening)

### Solution Found
**The key insight:** Don't try to maintain real-time sync with packet arrival. Just accumulate seismic samples in a buffer and step through them at the playback rate.

**What we changed:**
1. Store raw seismic samples (100 Hz) in a simple list
2. Audio callback steps through buffer at controlled rate (100 Hz worth of data, output at 44.1 kHz)
3. Linear interpolation between samples for smooth audio
4. Auto-trim old data behind playback position
5. Real-time amplitude tracking from current playback position

**Result:** Smooth, continuous audio with no clicks! 🎵

### The Architecture That Works
```
IRIS SeedLink → Accumulate samples in list → Audio callback interpolates at 100 Hz rate → 44.1 kHz output
                                              ↓
                                        Live amplitude monitoring
```

**Buffer management:**
- New data appends to end of list
- Playback position advances smoothly
- Old data behind playback auto-trims (keeps 10 seconds buffer)
- No index jumping or circular buffer issues

## PLANNED EVENT: Live Vibrotactile Experience (Sunday)

### The Vision
People will experience Mt. Kīlauea through a **vibrotactile table** that combines:

1. **Historical playback:** 24-hour audified seismic data from R2 cache
2. **Real-time modulation:** Current amplitude from SeedLink (scaled 0-1) **multiplies** historical signal
3. **Visual feedback:** 
   - Spectrogram display
   - Live amplitude monitor (the moving horizontal line)
4. **Haptic output:** Modulated signal sent to vibrotactile table

### How It Works
- Historical data plays continuously (from your R2/processing pipeline)
- Real-time SeedLink amplitude acts as a **gain multiplier**
- When volcano is **quiet now** → gentle historical playback
- When volcano is **rumbling now** → amplified historical playback
- People **feel** the volcano's current mood affecting its recent history!

### Technical Components Needed
- [x] SeedLink real-time streaming (working!)
- [x] Live amplitude monitoring (working!)
- [x] R2 cached historical data (existing pipeline)
- [ ] API endpoint: current amplitude scaled 0-1
- [ ] Multiply historical stream by live amplitude
- [ ] Route to vibrotactile table output
- [ ] Dashboard: spectrogram + live amplitude display

**This is going to be INCREDIBLE.** 🌋✨

## Date Attempted
2025-10-30

