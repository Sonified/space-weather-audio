/**
 * Share Modal
 * UI for sharing space weather analysis sessions
 */

import * as ShareAPI from './share-api.js';
import * as State from './audio-state.js';
import { getRegions } from './region-tracker.js';
import { zoomState } from './zoom-state.js';
import { getParticipantId } from './qualtrics-api.js';
import { getCurrentColormap } from './colormaps.js';
import { updateDatasetOptions } from './ui-controls.js';

let shareModal = null;
let isSharing = false;
let currentSessionId = null;  // Track the current session ID
let slugCheckTimeout = null;  // Debounce for slug availability check
let capturedThumbnailDataUrl = null;  // Store captured thumbnail for upload

// Word lists for generating share slugs
const ADJECTIVES = [
    'awesome', 'amazing', 'incredible', 'remarkable', 'astounding',
    'spectacular', 'phenomenal', 'extraordinary', 'magnificent', 'brilliant',
    'stunning', 'fantastic', 'marvelous', 'wonderful', 'outstanding',
    'exceptional', 'impressive', 'sensational', 'striking', 'sublime',
    'superb', 'glorious', 'epic', 'legendary', 'majestic',
    'miraculous', 'astonishing', 'dazzling', 'splendid', 'grand',
    'noble', 'radiant', 'luminous', 'transcendent', 'profound',
    'powerful', 'captivating', 'enchanting', 'mesmerizing',
    'wondrous', 'vivid', 'vibrant'
];

const NOUNS = [
    'feature', 'region', 'observation', 'finding', 'discovery',
    'event', 'phenomenon', 'activity', 'analysis', 'structure',
    'detection', 'signature', 'occurrence', 'segment', 'insight',
    'moment', 'example', 'highlight', 'selection'
];

// Awkward pairings to avoid (adjective -> noun)
const BAD_PAIRINGS = {
    'phenomenal': ['phenomenon']
};

// localStorage keys for tracking used words
const USED_ADJ_KEY = 'space_weather_used_adjectives';
const USED_NOUN_KEY = 'space_weather_used_nouns';

/**
 * Get remaining (unused) words from a list
 * @param {string[]} fullList - The complete word list
 * @param {string} storageKey - localStorage key for tracking used words
 * @returns {string[]} Array of unused words
 */
function getRemainingWords(fullList, storageKey) {
    try {
        const used = JSON.parse(localStorage.getItem(storageKey) || '[]');
        const remaining = fullList.filter(word => !used.includes(word));
        // If all words used, reset and return full list
        if (remaining.length === 0) {
            localStorage.removeItem(storageKey);
            return [...fullList];
        }
        return remaining;
    } catch (e) {
        return [...fullList];
    }
}

/**
 * Mark a word as used
 * @param {string} word - The word to mark as used
 * @param {string} storageKey - localStorage key for tracking used words
 */
function markWordUsed(word, storageKey) {
    try {
        const used = JSON.parse(localStorage.getItem(storageKey) || '[]');
        used.push(word);
        localStorage.setItem(storageKey, JSON.stringify(used));
    } catch (e) {
        // Ignore storage errors
    }
}

/**
 * Pick a random adjective-noun pair, avoiding bad pairings
 * Uses localStorage to cycle through all words before repeating
 */
function pickAdjectiveNoun() {
    let adjective, noun;
    let attempts = 0;

    // Get remaining pools
    let remainingAdj = getRemainingWords(ADJECTIVES, USED_ADJ_KEY);
    let remainingNoun = getRemainingWords(NOUNS, USED_NOUN_KEY);

    do {
        adjective = remainingAdj[Math.floor(Math.random() * remainingAdj.length)];
        noun = remainingNoun[Math.floor(Math.random() * remainingNoun.length)];
        attempts++;

        // If we hit a bad pairing, try removing that adjective from consideration
        if (BAD_PAIRINGS[adjective]?.includes(noun) && attempts < 10) {
            remainingAdj = remainingAdj.filter(a => a !== adjective);
            if (remainingAdj.length === 0) remainingAdj = getRemainingWords(ADJECTIVES, USED_ADJ_KEY);
        }
    } while (BAD_PAIRINGS[adjective]?.includes(noun) && attempts < 10);

    // Mark these words as used
    markWordUsed(adjective, USED_ADJ_KEY);
    markWordUsed(noun, USED_NOUN_KEY);

    return { adjective, noun };
}

/**
 * Capture the spectrogram canvas as an optimized thumbnail image
 * Combines main spectrogram with axis labels, resizes for efficient transfer
 * Target: ~50-150KB JPEG instead of multi-MB PNG
 * @returns {string|null} Data URL of the thumbnail JPEG, or null if capture fails
 */
function captureSpectrogramThumbnail() {
    const spectrogramCanvas = document.getElementById('spectrogram');
    const axisCanvas = document.getElementById('spectrogram-axis');

    if (!spectrogramCanvas) {
        console.warn('Spectrogram canvas not found');
        return null;
    }

    try {
        // Calculate source dimensions
        const axisWidth = axisCanvas ? axisCanvas.width : 0;
        const sourceWidth = spectrogramCanvas.width + axisWidth;
        const sourceHeight = spectrogramCanvas.height;

        // Target width for social media previews
        // 1200px is the recommended OG image width for Twitter/Facebook
        const targetWidth = 1200;
        const scale = targetWidth / sourceWidth;
        const targetHeight = Math.round(sourceHeight * scale);

        // Create combined canvas at reduced size
        const thumbnailCanvas = document.createElement('canvas');
        const ctx = thumbnailCanvas.getContext('2d');
        thumbnailCanvas.width = targetWidth;
        thumbnailCanvas.height = targetHeight;

        // Enable image smoothing for better downscaling
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        // Fill background (dark theme)
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, targetWidth, targetHeight);

        // Draw main spectrogram on the left
        const scaledAxisWidth = axisCanvas ? Math.round(axisWidth * scale) : 0;
        const spectrogramW = targetWidth - scaledAxisWidth;
        ctx.drawImage(spectrogramCanvas, 0, 0, spectrogramW, targetHeight);

        // Draw feature boxes overlay (if any boxes are drawn)
        const overlayCanvas = document.getElementById('spectrogram-selection-overlay');
        if (overlayCanvas) {
            ctx.drawImage(overlayCanvas, 0, 0, spectrogramW, targetHeight);
        }

        // Draw axis on the right side
        if (axisCanvas) {
            ctx.drawImage(axisCanvas, spectrogramW, 0, scaledAxisWidth, targetHeight);
        }

        // Convert to JPEG at 70% quality - great for social media, small file size
        // Spectrograms are gradient-heavy, JPEG handles them well
        const dataUrl = thumbnailCanvas.toDataURL('image/jpeg', 0.70);

        // Log the approximate size for debugging
        const approxSizeKB = Math.round((dataUrl.length * 0.75) / 1024);
        console.log(`Thumbnail captured: ${targetWidth}x${targetHeight}, ~${approxSizeKB}KB`);

        return dataUrl;
    } catch (error) {
        console.error('Failed to capture spectrogram thumbnail:', error);
        return null;
    }
}

/**
 * Display thumbnail preview in the share modal
 */
function updateThumbnailPreview() {
    const thumbnailCanvas = document.getElementById('shareThumbnail');
    if (!thumbnailCanvas) return;

    capturedThumbnailDataUrl = captureSpectrogramThumbnail();

    if (capturedThumbnailDataUrl) {
        const img = new Image();
        img.onload = () => {
            // Size the canvas to match aspect ratio
            const aspectRatio = img.width / img.height;
            const displayWidth = 652;  // Modal content width minus padding
            const displayHeight = displayWidth / aspectRatio;

            thumbnailCanvas.width = img.width;
            thumbnailCanvas.height = img.height;
            thumbnailCanvas.style.height = `${displayHeight}px`;

            const ctx = thumbnailCanvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
        };
        img.src = capturedThumbnailDataUrl;
    }
}

/**
 * Format date as YYYYMMDD-HHMM (URL-safe)
 */
function formatDateCompact(date) {
    if (!date) return null;
    const d = new Date(date);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const hours = String(d.getUTCHours()).padStart(2, '0');
    const mins = String(d.getUTCMinutes()).padStart(2, '0');
    return `${year}${month}${day}-${hours}${mins}`;
}

/**
 * Generate a default share slug
 * Format: username-adjective-noun-spacecraft-YYYYMMDD-HHMM-to-YYYYMMDD-HHMM
 */
function generateDefaultSlug() {
    const username = getParticipantId() || 'user';
    const { adjective, noun } = pickAdjectiveNoun();
    const spacecraft = (State.currentMetadata?.spacecraft || 'data').toLowerCase();

    // Sanitize username for slug (lowercase, alphanumeric + hyphens only)
    const cleanUsername = username.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 15);
    const cleanSpacecraft = spacecraft.replace(/[^a-z0-9-]/g, '').slice(0, 10);

    // Get date range if available
    const startDate = formatDateCompact(State.dataStartTime);
    const endDate = formatDateCompact(State.dataEndTime);

    if (startDate && endDate) {
        return `${cleanUsername}-${adjective}-${noun}-${cleanSpacecraft}-${startDate}-to-${endDate}`;
    } else {
        // Fallback to year if no date range
        const year = new Date().getFullYear();
        return `${cleanUsername}-${adjective}-${noun}-${cleanSpacecraft}-${year}`;
    }
}

/**
 * Create the share modal DOM element
 */
function createShareModal() {
    const modal = document.createElement('div');
    modal.id = 'shareModal';
    modal.style.cssText = 'display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 10000; align-items: center; justify-content: center;';
    modal.innerHTML = `
        <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #1a1a2e 100%); border-radius: 16px; width: 700px; max-width: 90vw; box-shadow: 0 20px 60px rgba(102, 126, 234, 0.3), 0 0 40px rgba(118, 75, 162, 0.2); border: 1px solid rgba(102, 126, 234, 0.3);">
            <div style="padding: 20px 24px; border-bottom: 1px solid rgba(102, 126, 234, 0.2); display: flex; justify-content: space-between; align-items: center;">
                <h3 style="margin: 0; color: #fff; font-size: 20px; font-weight: 600; display: flex; align-items: center; gap: 10px;">
                    <span style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Share Analysis</span>
                </h3>
                <button type="button" id="closeShareModal" style="width: 32px; height: 32px; background: rgba(255,255,255,0.1); border: none; border-radius: 50%; font-size: 20px; cursor: pointer; color: #888; display: flex; align-items: center; justify-content: center; transition: background 0.2s;">&times;</button>
            </div>
            <div id="shareModalBody" style="padding: 24px;">
                <!-- Form View -->
                <div id="shareFormView">
                    <!-- Thumbnail Preview -->
                    <div style="margin-bottom: 20px;">
                        <label style="display: block; margin-bottom: 10px; font-weight: 600; color: #ccc; font-size: 14px;">Preview Thumbnail</label>
                        <div id="thumbnailPreview" style="background: rgba(0,0,0,0.3); border-radius: 10px; overflow: hidden; border: 1px solid rgba(102, 126, 234, 0.2);">
                            <canvas id="shareThumbnail" style="width: 100%; display: block;"></canvas>
                        </div>
                        <div style="margin-top: 6px; font-size: 12px; color: #666;">This image will appear when sharing on social media</div>
                    </div>

                    <!-- Title Input -->
                    <div style="margin-bottom: 16px;">
                        <label for="shareTitle" style="display: block; margin-bottom: 8px; font-weight: 600; color: #ccc; font-size: 14px;">Title</label>
                        <input type="text" id="shareTitle" placeholder="My amazing discovery" style="width: 100%; padding: 12px 14px; font-size: 14px; border: 2px solid rgba(102, 126, 234, 0.3); border-radius: 10px; background: rgba(255,255,255,0.05); box-sizing: border-box; color: #fff; outline: none;" maxlength="100">
                    </div>

                    <!-- Description Input -->
                    <div style="margin-bottom: 20px;">
                        <label for="shareDescription" style="display: block; margin-bottom: 8px; font-weight: 600; color: #ccc; font-size: 14px;">Description <span style="color: #666; font-weight: normal;">(optional)</span></label>
                        <textarea id="shareDescription" placeholder="What makes this interesting?" style="width: 100%; padding: 12px 14px; font-size: 14px; border: 2px solid rgba(102, 126, 234, 0.3); border-radius: 10px; background: rgba(255,255,255,0.05); box-sizing: border-box; color: #fff; outline: none; resize: vertical; min-height: 60px;" maxlength="300"></textarea>
                    </div>

                    <!-- Share Link -->
                    <div style="margin-bottom: 20px;">
                        <label for="shareSlug" style="display: block; margin-bottom: 8px; font-weight: 600; color: #ccc; font-size: 14px;">Share Link</label>
                        <div style="display: flex; align-items: center; background: rgba(255,255,255,0.05); border: 2px solid rgba(102, 126, 234, 0.3); border-radius: 10px; overflow: hidden;">
                            <span style="padding: 12px 14px; color: #888; font-size: 12px; white-space: nowrap; background: rgba(0,0,0,0.2);">spaceweather.now.audio/?share=</span>
                            <input type="text" id="shareSlug" placeholder="my-share-name" style="flex: 1; padding: 12px 14px; font-size: 14px; border: none; background: transparent; box-sizing: border-box; min-width: 0; color: #fff; outline: none;">
                        </div>
                        <div id="slugStatus" style="margin-top: 6px; font-size: 12px; min-height: 18px;"></div>
                    </div>

                    <div style="display: flex; gap: 12px; justify-content: flex-end;">
                        <button type="button" id="cancelShareBtn" style="padding: 12px 28px; font-size: 14px; background: rgba(255,255,255,0.1); color: #ccc; border: 1px solid rgba(255,255,255,0.2); border-radius: 8px; cursor: pointer; font-weight: 500;">Cancel</button>
                        <button type="button" id="createShareBtn" style="padding: 12px 28px; font-size: 14px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);">Create Share Link</button>
                    </div>
                </div>

                <!-- Success View -->
                <div id="shareSuccessView" style="display: none; text-align: center; padding: 10px 0;">
                    <div style="font-size: 32px; margin-bottom: 8px;">✅</div>
                    <h4 style="color: #fff; margin-bottom: 14px; font-size: 18px;">Share Link Created!</h4>
                    <div style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 10px; margin-bottom: 14px; border: 1px solid rgba(102, 126, 234, 0.3);">
                        <input type="text" id="shareUrlInput" readonly style="width: 100%; padding: 10px; font-size: 13px; border: none; border-radius: 8px; text-align: center; box-sizing: border-box; background: rgba(0,0,0,0.3); color: #fff;">
                    </div>
                    <div style="display: flex; gap: 12px; justify-content: center;">
                        <button type="button" id="copyShareUrlBtn" style="padding: 10px 22px; font-size: 14px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);">📋 Copy Link</button>
                        <button type="button" id="doneShareBtn" style="padding: 10px 22px; font-size: 14px; background: rgba(255,255,255,0.1); color: #ccc; border: 1px solid rgba(255,255,255,0.2); border-radius: 8px; cursor: pointer; font-weight: 500;">Done</button>
                    </div>
                    <p id="shareExpiry" style="margin-top: 12px; color: #888; font-size: 12px;"></p>
                </div>

                <!-- Error View -->
                <div id="shareErrorView" style="display: none; text-align: center;">
                    <div style="font-size: 48px; margin-bottom: 15px;">❌</div>
                    <h4 style="color: #dc3545; margin-bottom: 10px;">Share Failed</h4>
                    <p id="shareErrorMessage" style="color: #666; margin-bottom: 20px;"></p>
                    <button type="button" id="retryShareBtn" style="padding: 12px 24px; font-size: 14px; background: #007bff; color: white; border: none; border-radius: 8px; cursor: pointer;">Try Again</button>
                </div>

                <!-- Loading View -->
                <div id="shareLoadingView" style="display: none; text-align: center; padding: 40px 0;">
                    <div class="share-spinner"></div>
                    <p id="shareLoadingText" style="color: #666;">Creating share link...</p>
                </div>
            </div>
        </div>
    `;

    // Add spinner styles
    const style = document.createElement('style');
    style.textContent = `
        .share-spinner {
            width: 40px;
            height: 40px;
            margin: 0 auto 20px auto;
            border: 4px solid rgba(102, 126, 234, 0.2);
            border-top-color: #667eea;
            border-radius: 50%;
            animation: share-spin 1s ease-in-out infinite, share-glow 2s ease-in-out infinite;
        }
        @keyframes share-spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        @keyframes share-glow {
            0%, 100% {
                box-shadow: 0 0 5px rgba(102, 126, 234, 0.3);
                border-top-color: #667eea;
            }
            50% {
                box-shadow: 0 0 20px rgba(102, 126, 234, 0.8), 0 0 30px rgba(118, 75, 162, 0.4);
                border-top-color: #764ba2;
            }
        }
    `;
    document.head.appendChild(style);

    return modal;
}

/**
 * Show a specific view in the modal
 */
function showView(viewId) {
    const views = ['shareFormView', 'shareSuccessView', 'shareErrorView', 'shareLoadingView'];
    views.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = id === viewId ? 'block' : 'none';
    });
}

/**
 * Check slug availability with debounce
 */
async function checkSlugAvailability(slug) {
    const statusEl = document.getElementById('slugStatus');
    const createBtn = document.getElementById('createShareBtn');

    if (!slug || slug.length < 3) {
        statusEl.innerHTML = '<span style="color: #666;">Enter at least 3 characters</span>';
        createBtn.disabled = true;
        return;
    }

    statusEl.innerHTML = '<span style="color: #666;">Checking availability...</span>';

    try {
        const result = await ShareAPI.checkShareAvailable(slug);

        if (result.available) {
            statusEl.innerHTML = '<span style="color: #28a745;">Available!</span>';
            createBtn.disabled = false;
        } else if (result.error) {
            statusEl.innerHTML = `<span style="color: #dc3545;">${result.error}</span>`;
            createBtn.disabled = true;
        } else {
            statusEl.innerHTML = '<span style="color: #dc3545;">This name is already taken</span>';
            createBtn.disabled = true;
        }
    } catch (error) {
        statusEl.innerHTML = '<span style="color: #dc3545;">Error checking availability</span>';
        createBtn.disabled = true;
    }
}

/**
 * Handle slug input changes with debounce
 */
function handleSlugInput(e) {
    const slug = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    e.target.value = slug;  // Auto-correct input

    // Clear previous timeout
    if (slugCheckTimeout) {
        clearTimeout(slugCheckTimeout);
    }

    // Debounce the availability check
    slugCheckTimeout = setTimeout(() => {
        checkSlugAvailability(slug);
    }, 300);
}

/**
 * Initialize the share modal (call once on app init)
 */
export function initShareModal() {
    if (shareModal) return;

    shareModal = createShareModal();
    document.body.appendChild(shareModal);

    // Event listeners
    document.getElementById('closeShareModal').addEventListener('click', closeShareModal);
    document.getElementById('cancelShareBtn').addEventListener('click', closeShareModal);
    document.getElementById('createShareBtn').addEventListener('click', handleCreateShare);
    document.getElementById('copyShareUrlBtn').addEventListener('click', handleCopyUrl);
    document.getElementById('doneShareBtn').addEventListener('click', closeShareModal);
    document.getElementById('retryShareBtn').addEventListener('click', () => showView('shareFormView'));

    // Slug input handler
    document.getElementById('shareSlug').addEventListener('input', handleSlugInput);

    // Close on backdrop click (only if mousedown also started on backdrop)
    let mouseDownOnBackdrop = false;
    shareModal.addEventListener('mousedown', (e) => {
        mouseDownOnBackdrop = (e.target === shareModal);
    });
    shareModal.addEventListener('click', (e) => {
        if (e.target === shareModal && mouseDownOnBackdrop) closeShareModal();
        mouseDownOnBackdrop = false;
    });

    // Close on escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && shareModal.style.display !== 'none') {
            closeShareModal();
        }
    });
}

/**
 * Open the share modal
 */
export function openShareModal() {
    if (!shareModal) initShareModal();

    // Reset to form view
    showView('shareFormView');

    // Capture spectrogram thumbnail
    updateThumbnailPreview();

    // Pre-populate info
    const spacecraft = State.currentMetadata?.spacecraft || document.getElementById('spacecraft')?.value || 'Unknown';

    // Generate engaging default title
    const defaultTitle = `Listen to these sounds from space!`;
    document.getElementById('shareTitle').value = defaultTitle;

    // Generate engaging default description
    const dataType = State.currentMetadata?.dataset || document.getElementById('dataType')?.value || '';
    const startStr = State.dataStartTime ? State.dataStartTime.toISOString().slice(0, 10) : '';
    const endStr = State.dataEndTime ? State.dataEndTime.toISOString().slice(0, 10) : '';

    let defaultDescription = `Check out this feature I identified in ${spacecraft}`;
    if (dataType) {
        defaultDescription += ` ${dataType}`;
    }
    defaultDescription += ` data`;
    if (startStr && endStr) {
        defaultDescription += ` from ${startStr} to ${endStr}`;
    }
    defaultDescription += `. I think you'll find it interesting!`;
    document.getElementById('shareDescription').value = defaultDescription;

    // Generate and set default slug
    const defaultSlug = generateDefaultSlug();
    document.getElementById('shareSlug').value = defaultSlug;
    document.getElementById('createShareBtn').disabled = true;

    // Check availability of default slug
    checkSlugAvailability(defaultSlug);

    // Show modal
    shareModal.style.display = 'flex';
}

/**
 * Close the share modal
 */
export function closeShareModal() {
    if (shareModal) {
        shareModal.style.display = 'none';
    }
}

/**
 * Gather session data for saving
 */
function gatherSessionData() {
    const regions = getRegions();
    const spacecraft = State.currentMetadata?.spacecraft || document.getElementById('spacecraft')?.value;
    const dataType = State.currentMetadata?.dataset || document.getElementById('dataType')?.value;

    // Debug: log what features we're capturing
    console.log('🔗 Gathering session data...');
    console.log(`🔗   ${regions.length} region(s) found`);
    regions.forEach((r, i) => {
        const featureCount = r.features?.length || 0;
        console.log(`🔗   Region ${i + 1} (id=${r.id}): ${featureCount} feature(s), featureCount=${r.featureCount}`);
        if (r.features && r.features.length > 0) {
            r.features.forEach((f, j) => {
                console.log(`🔗     Feature ${j + 1}: type=${f.type}, notes="${f.notes?.slice(0, 30) || ''}..."`);
            });
        }
    });

    return {
        session_id: currentSessionId,  // Re-use if we have one
        spacecraft,
        data_type: dataType,
        time_range: {
            start: State.dataStartTime?.toISOString(),
            end: State.dataEndTime?.toISOString()
        },
        regions: regions.map(r => ({
            id: r.id,
            startTime: r.startTime,
            stopTime: r.stopTime,
            minFrequency: r.minFrequency,
            maxFrequency: r.maxFrequency,
            label: r.label,
            color: r.color,
            featureCount: r.featureCount || 1,
            features: r.features || [],
            expanded: r.expanded || false
        })),
        view_settings: {
            frequency_scale: State.frequencyScale,
            colormap: getCurrentColormap(),
            fft_size: State.fftSize,
            zoom: zoomState.mode === 'region' ? {
                mode: 'region',
                region_id: zoomState.activeRegionId,
                start_time: zoomState.currentViewStartTime?.toISOString(),
                end_time: zoomState.currentViewEndTime?.toISOString()
            } : null
        }
    };
}

/**
 * Handle creating a new share
 */
async function handleCreateShare() {
    if (isSharing) return;
    isSharing = true;

    const loadingText = document.getElementById('shareLoadingText');
    showView('shareLoadingView');

    try {
        const username = getParticipantId();
        if (!username) {
            throw new Error('Please set your username first (click your name in the header)');
        }

        const shareSlug = document.getElementById('shareSlug').value.trim();
        if (!shareSlug) {
            throw new Error('Please enter a share link name');
        }

        // Get title and description from inputs
        const title = document.getElementById('shareTitle').value.trim() || 'Space Weather Analysis';
        const description = document.getElementById('shareDescription').value.trim();

        // Step 1: Save session to R2
        loadingText.textContent = 'Saving session...';
        const sessionData = gatherSessionData();
        const saveResult = await ShareAPI.saveSession(username, sessionData);
        currentSessionId = saveResult.session_id;
        console.log('Session saved:', saveResult);

        // Step 2: Create share link with thumbnail
        loadingText.textContent = 'Creating share link...';
        const shareResult = await ShareAPI.createShare(username, currentSessionId, {
            title,
            description,
            share_id: shareSlug,
            thumbnail: capturedThumbnailDataUrl  // Include the captured thumbnail
        });

        // Show success view
        document.getElementById('shareUrlInput').value = shareResult.share_url;

        // Share links are permanent
        document.getElementById('shareExpiry').textContent = `This link never expires`;

        showView('shareSuccessView');
        console.log('Share created:', shareResult);

    } catch (error) {
        console.error('Share error:', error);
        document.getElementById('shareErrorMessage').textContent = error.message;
        showView('shareErrorView');
    } finally {
        isSharing = false;
    }
}

/**
 * Handle copying share URL to clipboard
 */
async function handleCopyUrl() {
    const urlInput = document.getElementById('shareUrlInput');
    const copyBtn = document.getElementById('copyShareUrlBtn');

    try {
        await navigator.clipboard.writeText(urlInput.value);
        copyBtn.textContent = '✓ Copied!';
        copyBtn.style.background = '#28a745';

        setTimeout(() => {
            copyBtn.textContent = '📋 Copy Link';
        }, 2000);
    } catch (error) {
        // Fallback for older browsers
        urlInput.select();
        document.execCommand('copy');
        copyBtn.textContent = '✓ Copied!';

        setTimeout(() => {
            copyBtn.textContent = '📋 Copy Link';
        }, 2000);
    }
}

/**
 * Check URL for shared session and load it
 * @returns {Promise<Object|null>} Share data if found, null otherwise
 */
export async function checkAndLoadSharedSession() {
    const shareId = ShareAPI.getShareIdFromUrl();
    if (!shareId) return null;

    // 🔗 SET THIS IMMEDIATELY - before any async work or timeouts can fire!
    sessionStorage.setItem('isSharedSession', 'true');
    console.log('🔗🔗🔗 [SHARE-MODAL] SET isSharedSession=true IMMEDIATELY (share ID found)');

    console.log('🔗 Found share ID in URL:', shareId);
    console.log('🔗 Current URL:', window.location.href);

    try {
        const shareData = await ShareAPI.getShare(shareId);
        console.log('Loaded shared session:', shareData);

        // Track as recently viewed
        ShareAPI.addToRecentShares({
            share_id: shareId,
            title: shareData.metadata.title,
            spacecraft: shareData.metadata.spacecraft
        });

        return shareData;
    } catch (error) {
        console.error('Failed to load shared session:', error);
        alert(`Failed to load shared session: ${error.message}`);
        return null;
    }
}

/**
 * Apply shared session data to the app
 * @param {Object} shareData - The share data from the API
 */
export function applySharedSession(shareData) {
    const { session, metadata } = shareData;

    // Set spacecraft and data type
    const spacecraftSelect = document.getElementById('spacecraft');
    const dataTypeSelect = document.getElementById('dataType');

    if (spacecraftSelect && session.spacecraft) {
        spacecraftSelect.value = session.spacecraft;
        // Directly update dataset options (event listener may not be attached yet)
        updateDatasetOptions();
    }

    // Set time range
    if (session.time_range?.start && session.time_range?.end) {
        const startDate = new Date(session.time_range.start);
        const endDate = new Date(session.time_range.end);

        document.getElementById('startDate').value = startDate.toISOString().slice(0, 10);
        document.getElementById('startTime').value = startDate.toISOString().slice(11, 23);
        document.getElementById('endDate').value = endDate.toISOString().slice(0, 10);
        document.getElementById('endTime').value = endDate.toISOString().slice(11, 23);
    }

    // Set data type (options are already populated by updateDatasetOptions above)
    if (dataTypeSelect && session.data_type) {
        dataTypeSelect.value = session.data_type;
    }

    // Note: isSharedSession was already set in checkAndLoadSharedSession() before any async work

    // Store regions to be applied after data loads
    if (session.regions && session.regions.length > 0) {
        console.log('🔗 Storing', session.regions.length, 'regions to sessionStorage');
        // Log feature counts for debugging
        session.regions.forEach((r, i) => {
            const featureCount = r.features?.length || 0;
            console.log(`🔗   Region ${i + 1}: ${featureCount} feature(s)`);
        });
        sessionStorage.setItem('pendingSharedRegions', JSON.stringify(session.regions));
    }

    // Store view settings
    if (session.view_settings) {
        sessionStorage.setItem('pendingSharedViewSettings', JSON.stringify(session.view_settings));
    }

    // Show notification
    const title = metadata.title || 'Shared Analysis';
    const status = document.getElementById('status');
    if (status) {
        status.textContent = `Loading shared analysis: "${title}"`;
        status.className = 'status info';
    }

    return {
        shouldFetch: true,
        session
    };
}

/**
 * Save current session to R2 (can be called when regions change)
 * @param {boolean} silent - If true, don't show errors to user
 */
export async function saveCurrentSession(silent = true) {
    const username = getParticipantId();
    if (!username) {
        if (!silent) console.warn('No username set, cannot save session');
        return null;
    }

    const regions = getRegions();
    if (regions.length === 0) {
        // Don't save empty sessions
        return null;
    }

    try {
        const sessionData = gatherSessionData();
        const result = await ShareAPI.saveSession(username, sessionData);
        currentSessionId = result.session_id;
        console.log('Session auto-saved:', result.session_id);
        return result;
    } catch (error) {
        if (!silent) {
            console.error('Failed to save session:', error);
        }
        return null;
    }
}

/**
 * Enable/disable the share button based on data availability
 */
export function updateShareButtonState() {
    const shareBtn = document.getElementById('shareBtn');
    if (!shareBtn) {
        console.log('🔗 Share button not found');
        return;
    }

    // Enable if we have loaded data
    const hasData = State.completeSamplesArray && State.completeSamplesArray.length > 0;
    // console.log('🔗 Share button state:', { hasData, length: State.completeSamplesArray?.length, disabled: !hasData });
    shareBtn.disabled = !hasData;
}

export default {
    initShareModal,
    openShareModal,
    closeShareModal,
    checkAndLoadSharedSession,
    applySharedSession,
    saveCurrentSession,
    updateShareButtonState
};
