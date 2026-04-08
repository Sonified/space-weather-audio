// settings-drawer.js — Settings drawer and gear popover HTML injection

/**
 * SHARED ADVANCED CONTROLS: Gear popovers, settings drawer, localStorage persistence.
 * Called from both EMIC Study and Space Weather Portal modes.
 */
export function injectSettingsDrawer() {
    // Skip if already injected
    if (document.getElementById('settingsDrawer')) return;

    // Hamburger button (fixed, top-left)
    const hamburger = document.createElement('div');
    hamburger.id = 'hamburgerBtn';
    hamburger.className = 'hamburger-btn';
    hamburger.title = 'Settings drawer';
    hamburger.innerHTML = '&#9776;';
    document.body.appendChild(hamburger);

    // Settings drawer
    const drawer = document.createElement('div');
    drawer.id = 'settingsDrawer';
    drawer.className = 'settings-drawer';
    drawer.innerHTML = `
        <div class="drawer-header">
            <span class="drawer-title">Master Settings</span>
            <span id="drawerClose" class="drawer-close" title="Close">&times;</span>
        </div>
        <div class="drawer-section">
            <div class="drawer-section-title">Session</div>
            <div class="drawer-row">
                <label for="participantIdMode" class="drawer-label">ID Mode</label>
                <select id="participantIdMode" class="drawer-input" style="width: 100px; text-align: left;">
                    <option value="manual" selected>Manual</option>
                    <option value="auto">Auto</option>
                </select>
            </div>
            <div class="drawer-row">
                <label for="pidCornerDisplay" class="drawer-label">ID in Corner</label>
                <select id="pidCornerDisplay" class="drawer-input" style="width: 100px; text-align: left;">
                    <option value="show" selected>Show</option>
                    <option value="hide">Hide</option>
                </select>
            </div>
            <div class="drawer-row">
                <label for="skipLoginWelcome" class="drawer-label">Skip Login & Welcome</label>
                <input type="checkbox" id="skipLoginWelcome" class="drawer-checkbox">
            </div>
        </div>
        <div class="drawer-section">
            <div class="drawer-section-title">Data Loading</div>
            <div class="drawer-row">
                <label for="dataSource" class="drawer-label">Source</label>
                <select id="dataSource" class="drawer-input" style="width: 150px; text-align: left;">
                    <option value="cdaweb" selected>GOES CDAWeb</option>
                    <option value="cloudflare">GOES Cloudflare</option>
                </select>
            </div>
            <div class="drawer-row" style="margin-top: 6px;">
                <label class="drawer-label" style="display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="drawerBypassCache" style="width: 16px; height: 16px; cursor: pointer;">
                    Do not use cache
                </label>
            </div>
            <div class="drawer-row" style="margin-top: 6px;">
                <label class="drawer-label" style="display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="silentDownload" style="width: 16px; height: 16px; cursor: pointer;">
                    Silent download
                </label>
            </div>
            <div class="drawer-row" style="margin-top: 6px;">
                <label class="drawer-label" style="display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="autoDownload" style="width: 16px; height: 16px; cursor: pointer;">
                    Auto download
                </label>
            </div>
            <div class="drawer-row" style="margin-top: 6px;">
                <label class="drawer-label" style="display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="autoPlay" style="width: 16px; height: 16px; cursor: pointer;">
                    Auto play
                </label>
            </div>
            <div class="drawer-row" style="margin-top: 6px;">
                <label for="dataRendering" class="drawer-label">Rendering</label>
                <select id="dataRendering" class="drawer-input" style="width: 130px; text-align: left;">
                    <option value="progressive" selected>Progressive</option>
                    <option value="onComplete">On Complete</option>
                    <option value="triggered">Triggered</option>
                </select>
            </div>
        </div>
        <div class="drawer-section">
            <div class="drawer-section-title">Feature Boxes</div>
            <div class="drawer-row">
                <label for="featureBoxesVisible" class="drawer-label">Show Boxes</label>
                <input type="checkbox" id="featureBoxesVisible" class="drawer-checkbox" checked>
            </div>
        </div>
        <div class="drawer-section">
            <div class="drawer-section-title">Feature Box Annotations</div>
            <div class="drawer-row">
                <label for="annotationAlignment" class="drawer-label">Align</label>
                <select id="annotationAlignment" class="drawer-input" style="width: 100px; text-align: left;">
                    <option value="center" selected>Center</option>
                    <option value="left">Left</option>
                </select>
            </div>
            <div class="drawer-row">
                <label for="annotationWidth" class="drawer-label">Width</label>
                <div class="drawer-spinner">
                    <button class="spinner-btn spinner-dec" data-for="annotationWidth">−</button>
                    <input type="text" id="annotationWidth" class="spinner-value" inputmode="numeric" data-min="100" data-max="800" data-step="25">
                    <button class="spinner-btn spinner-inc" data-for="annotationWidth">+</button>
                </div>
            </div>
            <div class="drawer-row">
                <label for="annotationFontSize" class="drawer-label">Font Size</label>
                <div class="drawer-spinner">
                    <button class="spinner-btn spinner-dec" data-for="annotationFontSize">−</button>
                    <input type="text" id="annotationFontSize" class="spinner-value" inputmode="numeric" data-min="8" data-max="28" data-step="1">
                    <button class="spinner-btn spinner-inc" data-for="annotationFontSize">+</button>
                </div>
            </div>
        </div>
        <div class="drawer-section">
            <div class="drawer-section-title">Display on Load</div>
            <div class="drawer-row">
                <label for="displayOnLoad" class="drawer-label">Initial View</label>
                <select id="displayOnLoad" class="drawer-input" style="width: 130px; text-align: left;">
                    <option value="all" selected>All Data</option>
                    <option value="beginning">Start at Beginning</option>
                </select>
            </div>
            <div id="initialHoursRow" class="drawer-row" style="display: none;">
                <label for="initialHours" class="drawer-label">Show first</label>
                <select id="initialHours" class="drawer-input" style="width: 70px; text-align: left;">
                    ${Array.from({length: 24}, (_, i) => i + 1).map(h =>
                        `<option value="${h}"${h === 12 ? ' selected' : ''}>${h}h</option>`
                    ).join('')}
                </select>
            </div>
        </div>
        <div class="drawer-section">
            <div class="drawer-section-title">Layout</div>
            <div class="drawer-row">
                <label for="minUIWidth" class="drawer-label">Min Width (px)</label>
                <div class="drawer-spinner">
                    <button class="spinner-btn spinner-dec" data-for="minUIWidth">−</button>
                    <input type="text" id="minUIWidth" class="spinner-value" inputmode="numeric" data-min="0" data-max="3000" data-step="50">
                    <button class="spinner-btn spinner-inc" data-for="minUIWidth">+</button>
                </div>
            </div>
        </div>
        <div class="drawer-section">
            <div class="drawer-section-title">Panel Heights (px)</div>
            <div class="drawer-row">
                <label for="heightMinimap" class="drawer-label">Minimap</label>
                <div class="drawer-spinner">
                    <button class="spinner-btn spinner-dec" data-for="heightMinimap">−</button>
                    <input type="text" id="heightMinimap" class="spinner-value" inputmode="numeric" data-min="50" data-max="400" data-step="1">
                    <button class="spinner-btn spinner-inc" data-for="heightMinimap">+</button>
                </div>
            </div>
            <div class="drawer-row">
                <label for="heightSpectrogram" class="drawer-label">Spectrogram</label>
                <div class="drawer-spinner">
                    <button class="spinner-btn spinner-dec" data-for="heightSpectrogram">−</button>
                    <input type="text" id="heightSpectrogram" class="spinner-value" inputmode="numeric" data-min="200" data-max="1200" data-step="1">
                    <button class="spinner-btn spinner-inc" data-for="heightSpectrogram">+</button>
                </div>
            </div>
        </div>
        <div class="drawer-section">
            <div class="drawer-section-title">Audio Quality</div>
            <div class="drawer-row">
                <label for="audioQuality" class="drawer-label">Sample format</label>
                <select id="audioQuality" class="drawer-input" style="width: 100px; text-align: left;">
                    <option value="16">16 Bit</option>
                    <option value="32">32 Bit</option>
                </select>
            </div>
        </div>
        <div class="drawer-section">
            <div class="drawer-section-title">Tile Compression</div>
            <div class="drawer-row">
                <label for="tileCompression" class="drawer-label">Format</label>
                <select id="tileCompression" class="drawer-input" style="width: 100px; text-align: left;">
                    <option value="uint8">Uint8</option>
                    <option value="bc4">BC4</option>
                </select>
            </div>
        </div>
        <div class="drawer-section">
            <div class="drawer-section-title">FFT Tile Edge Mode</div>
            <div class="drawer-row">
                <label for="tileEdgeMode" class="drawer-label">Stitching</label>
                <select id="tileEdgeMode" class="drawer-input" style="width: 130px; text-align: left;">
                    <option value="standard" selected>Standard</option>
                    <option value="crossfade" disabled>Crossfade (coming soon)</option>
                </select>
            </div>
            <div class="drawer-row">
                <label for="tileChunkSize" class="drawer-label">Chunk size</label>
                <select id="tileChunkSize" class="drawer-input" style="width: 130px; text-align: left;">
                    ${(() => {
                        const def = window.__DEFAULT_TILE_CHUNK || 'adaptive';
                        const opts = [`<option value="adaptive"${def === 'adaptive' ? ' selected' : ''}>Adaptive</option>`];
                        for (const m of [1,2,5,10,15,20,25,30,35,40,45,50,55]) {
                            opts.push(`<option value="${m * 60}"${def === String(m * 60) ? ' selected' : ''}>${m} min</option>`);
                        }
                        for (const h of [1,2,3,4,5,6,12]) {
                            const s = h * 3600;
                            opts.push(`<option value="${s}"${def === String(s) ? ' selected' : ''}>${h} hr</option>`);
                        }
                        const dayS = 86400;
                        opts.push(`<option value="${dayS}"${def === String(dayS) ? ' selected' : ''}>1 day</option>`);
                        return opts.join('');
                    })()}
                </select>
            </div>
        </div>
        <div class="drawer-section">
            <div class="drawer-section-title">Zoom Out Mode</div>
            <div class="drawer-row">
                <label for="mainWindowZoomOut" class="drawer-label">Reduction</label>
                <select id="mainWindowZoomOut" class="drawer-input" style="width: 120px; text-align: left;">
                    <option value="average" selected>Show Average</option>
                    <option value="balanced">Balanced</option>
                    <option value="peak">Show Peak</option>
                </select>
            </div>
            <div class="drawer-row">
                <label for="levelTransition" class="drawer-label">Transition</label>
                <select id="levelTransition" class="drawer-input" style="width: 120px; text-align: left;">
                    <option value="stepped">Stepped</option>
                    <option value="crossfade" selected>Crossfade</option>
                </select>
            </div>
            <div id="crossfadePowerRow" style="display: none; flex-direction: column; gap: 10px; padding: 4px 0;">
                <span class="drawer-label">Blend curve:</span>
                <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="font-size: 12px; color: #999; white-space: nowrap; line-height: 1;">smooth</span>
                    <input type="range" id="crossfadePower" class="drawer-input" min="0.5" max="6" step="0.5" value="1" style="width: 80px; flex: none; margin: 0; padding: 0;">
                    <span style="font-size: 12px; color: #999; white-space: nowrap; line-height: 1;">sharp</span>
                    <span id="crossfadePowerLabel" style="font-size: 11px; color: #888; margin-left: 2px; min-width: 24px;">2.0</span>
                </div>
            </div>
        </div>
        <div class="drawer-section">
            <div class="drawer-section-title">Render Order</div>
            <div class="drawer-row">
                <label for="renderOrder" class="drawer-label">Pipeline</label>
                <select id="renderOrder" class="drawer-input" style="width: 120px; text-align: left;">
                    <option value="all-then-pyramid">All → Pyramid</option>
                    <option value="pyramid-only" selected>Pyramid Only</option>
                </select>
            </div>
        </div>
        <div class="drawer-section">
            <div class="drawer-section-title">Waveform Zoom</div>
            <div class="drawer-row">
                <label for="catmullMode" class="drawer-label">Zoomed-in style</label>
                <select id="catmullMode" class="drawer-input" style="width: 110px; text-align: left;">
                    <option value="default" selected>Rounded bins</option>
                    <option value="smooth">Smooth curve</option>
                </select>
            </div>
            <div id="catmullSubControls" style="display: none;">
                <div class="drawer-row">
                    <label for="catmullThreshold" class="drawer-label">Transition (spp)</label>
                    <select id="catmullThreshold" class="drawer-input" style="width: 70px; text-align: left;">
                        <option value="1">1</option>
                        <option value="2">2</option>
                        <option value="4">4</option>
                        <option value="8">8</option>
                        <option value="16">16</option>
                        <option value="32">32</option>
                        <option value="64">64</option>
                        <option value="128" selected>128</option>
                        <option value="256">256</option>
                    </select>
                </div>
                <div class="drawer-row drawer-slider-row">
                    <label for="catmullCore" class="drawer-label" style="flex: 0 0 62px;">Thickness</label>
                    <input type="range" id="catmullCore" min="0.01" max="1.0" step="0.01" value="1.0" style="flex: 1;">
                    <span id="catmullCoreLabel" class="drawer-slider-value">1.00</span>
                </div>
                <div class="drawer-row drawer-slider-row">
                    <label for="catmullFeather" class="drawer-label" style="flex: 0 0 62px;">Feather</label>
                    <input type="range" id="catmullFeather" min="0.1" max="5.0" step="0.1" value="1.0" style="flex: 1;">
                    <span id="catmullFeatherLabel" class="drawer-slider-value">1.0</span>
                </div>
            </div>
            <div class="drawer-row">
                <label for="waveformPanMode" class="drawer-label">Pan rendering</label>
                <select id="waveformPanMode" class="drawer-input" style="width: 120px; text-align: left;">
                    <option value="smartFreeze" selected>Smart Freeze</option>
                    <option value="alwaysCompute">Always Compute</option>
                </select>
            </div>
        </div>
        <div class="drawer-section">
            <div class="drawer-section-title">Arrow Key Navigation</div>
            <div class="drawer-row">
                <label for="arrowZoomStep" class="drawer-label">Zoom Step</label>
                <select id="arrowZoomStep" class="drawer-input" style="width: 70px; text-align: left;">
                    <option value="5">5%</option>
                    <option value="10">10%</option>
                    <option value="15" selected>15%</option>
                    <option value="20">20%</option>
                    <option value="25">25%</option>
                    <option value="30">30%</option>
                </select>
            </div>
            <div class="drawer-row">
                <label for="arrowPanStep" class="drawer-label">Pan Step</label>
                <select id="arrowPanStep" class="drawer-input" style="width: 70px; text-align: left;">
                    <option value="5">5%</option>
                    <option value="10" selected>10%</option>
                    <option value="15">15%</option>
                    <option value="20">20%</option>
                    <option value="25">25%</option>
                    <option value="30">30%</option>
                </select>
            </div>
        </div>
        <div class="drawer-section">
            <div class="drawer-section-title">X-Axis Ticks</div>
            <div style="display: flex; flex-direction: column; gap: 18px; padding: 8px 0;">
                <div>
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                        <span class="drawer-label" style="min-width: 72px;">Zoom fade:</span>
                        <select id="tickZoomFadeMode" class="drawer-input" style="width: 100px; text-align: left;">
                            <option value="time" selected>Time</option>
                            <option value="spatial">Spatial</option>
                        </select>
                    </div>
                </div>
                <div id="tickZoomTimeControls">
                <div>
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                        <span class="drawer-label" style="min-width: 56px;">Fade in:</span>
                        <select id="tickFadeInCurve" class="drawer-input" style="width: 100px; text-align: left;">
                            <option value="linear">Linear</option>
                            <option value="easeIn">Ease In</option>
                            <option value="easeOut" selected>Ease Out</option>
                            <option value="easeInOut">Ease In-Out</option>
                        </select>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px; margin-top: 8px;">
                        <span style="font-size: 12px; color: #999; white-space: nowrap; line-height: 1;">0s</span>
                        <input type="range" id="tickFadeInTime" class="drawer-input" min="0" max="2" step="0.05" value="0.9" style="flex: 1; margin: 0; padding: 0;">
                        <span style="font-size: 12px; color: #999; white-space: nowrap; line-height: 1;">2s</span>
                        <span id="tickFadeInLabel" style="font-size: 11px; color: #888; min-width: 32px;">0.90s</span>
                    </div>
                </div>
                <div>
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                        <span class="drawer-label" style="min-width: 56px;">Fade out:</span>
                        <select id="tickFadeOutCurve" class="drawer-input" style="width: 100px; text-align: left;">
                            <option value="linear">Linear</option>
                            <option value="easeIn">Ease In</option>
                            <option value="easeOut" selected>Ease Out</option>
                            <option value="easeInOut">Ease In-Out</option>
                        </select>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px; margin-top: 8px;">
                        <span style="font-size: 12px; color: #999; white-space: nowrap; line-height: 1;">0s</span>
                        <input type="range" id="tickFadeOutTime" class="drawer-input" min="0" max="2" step="0.05" value="0.3" style="flex: 1; margin: 0; padding: 0;">
                        <span style="font-size: 12px; color: #999; white-space: nowrap; line-height: 1;">2s</span>
                        <span id="tickFadeOutLabel" style="font-size: 11px; color: #888; min-width: 32px;">0.30s</span>
                    </div>
                </div>
                </div>
                <div id="tickZoomSpatialControls" style="display: none;">
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                        <span class="drawer-label" style="min-width: 56px;">Curve:</span>
                        <select id="tickZoomSpatialCurve" class="drawer-input" style="width: 100px; text-align: left;">
                            <option value="linear">Linear</option>
                            <option value="easeIn">Ease In</option>
                            <option value="easeOut" selected>Ease Out</option>
                            <option value="easeInOut">Ease In-Out</option>
                        </select>
                    </div>
                    <div style="margin-top: 8px;">
                        <span class="drawer-label" style="font-size: 11px; margin-bottom: 6px; display: block;">Width</span>
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <span style="font-size: 12px; color: #999; white-space: nowrap; line-height: 1;">sharp</span>
                            <input type="range" id="tickZoomSpatialWidth" class="drawer-input" min="0" max="2" step="0.05" value="0.5" style="flex: 1; margin: 0; padding: 0;">
                            <span style="font-size: 12px; color: #999; white-space: nowrap; line-height: 1;">wide</span>
                            <span id="tickZoomSpatialWidthLabel" style="font-size: 11px; color: #888; min-width: 32px;">0.50</span>
                        </div>
                    </div>
                </div>
                <div>
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                        <span class="drawer-label" style="min-width: 72px;">Edge fade:</span>
                        <select id="tickEdgeFadeMode" class="drawer-input" style="width: 100px; text-align: left;">
                            <option value="spatial" selected>Spatial</option>
                            <option value="time">Time</option>
                            <option value="none">None</option>
                        </select>
                    </div>
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px;">
                        <span class="drawer-label" style="min-width: 56px;">Curve:</span>
                        <select id="tickEdgeFadeCurve" class="drawer-input" style="width: 100px; text-align: left;">
                            <option value="linear">Linear</option>
                            <option value="easeIn">Ease In</option>
                            <option value="easeOut" selected>Ease Out</option>
                            <option value="easeInOut">Ease In-Out</option>
                        </select>
                    </div>
                </div>
                <!-- Spatial mode: width slider -->
                <div id="tickEdgeSpatialControls">
                    <span class="drawer-label" style="font-size: 11px; margin-bottom: 6px; display: block;">Width</span>
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span style="font-size: 12px; color: #999; white-space: nowrap; line-height: 1;">0</span>
                        <input type="range" id="tickEdgeSpatialWidth" class="drawer-input" min="0" max="1" step="0.05" value="0.6" style="flex: 1; margin: 0; padding: 0;">
                        <span style="font-size: 12px; color: #999; white-space: nowrap; line-height: 1;">wide</span>
                        <span id="tickEdgeSpatialWidthLabel" style="font-size: 11px; color: #888; min-width: 32px;">0.60</span>
                    </div>
                </div>
                <!-- Time mode: separate in/out sliders -->
                <div id="tickEdgeTimeControls" style="display: none;">
                    <div style="display: flex; flex-direction: column; gap: 16px;">
                        <div>
                            <span class="drawer-label" style="font-size: 11px; margin-bottom: 6px; display: block;">In</span>
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <span style="font-size: 12px; color: #999; white-space: nowrap; line-height: 1;">0s</span>
                                <input type="range" id="tickEdgeTimeIn" class="drawer-input" min="0" max="1" step="0.05" value="0" style="flex: 1; margin: 0; padding: 0;">
                                <span style="font-size: 12px; color: #999; white-space: nowrap; line-height: 1;">1s</span>
                                <span id="tickEdgeTimeInLabel" style="font-size: 11px; color: #888; min-width: 32px;">0.00s</span>
                            </div>
                        </div>
                        <div>
                            <span class="drawer-label" style="font-size: 11px; margin-bottom: 6px; display: block;">Out</span>
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <span style="font-size: 12px; color: #999; white-space: nowrap; line-height: 1;">0s</span>
                                <input type="range" id="tickEdgeTimeOut" class="drawer-input" min="0" max="1" step="0.05" value="0.2" style="flex: 1; margin: 0; padding: 0;">
                                <span style="font-size: 12px; color: #999; white-space: nowrap; line-height: 1;">1s</span>
                                <span id="tickEdgeTimeOutLabel" style="font-size: 11px; color: #888; min-width: 32px;">0.20s</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <div class="drawer-section">
            <div class="drawer-section-title">Feature Box Playback</div>
            <div class="drawer-row">
                <label for="featurePlaybackMode" class="drawer-label">At page edge</label>
                <select id="featurePlaybackMode" class="drawer-input" style="width: 105px; text-align: left;">
                    <option value="continue" selected>No change</option>
                    <option value="stop">Stop audio</option>
                    <option value="clamp">Clamp view</option>
                </select>
            </div>
        </div>
        <div class="drawer-section">
            <div class="drawer-section-title">Page Scroll</div>
            <div class="drawer-row" style="margin-top: 6px;">
                <label class="drawer-label" style="display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="lockPageScroll" style="width: 16px; height: 16px; cursor: pointer;">
                    Lock page scroll
                </label>
            </div>
        </div>
        <div class="drawer-section">
            <div class="drawer-section-title">Prints</div>
            <div class="drawer-row" style="margin-top: 6px;">
                <label class="drawer-label" style="display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="printInit" style="width: 16px; height: 16px; cursor: pointer;">
                    Initialization
                </label>
            </div>
            <div class="drawer-row" style="margin-top: 4px;">
                <label class="drawer-label" style="display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="printGPU" style="width: 16px; height: 16px; cursor: pointer;">
                    Rendering
                </label>
            </div>
            <div class="drawer-row" style="margin-top: 4px;">
                <label class="drawer-label" style="display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="printMemory" style="width: 16px; height: 16px; cursor: pointer;">
                    Memory
                </label>
            </div>
            <div class="drawer-row" style="margin-top: 4px;">
                <label class="drawer-label" style="display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="printAudio" style="width: 16px; height: 16px; cursor: pointer;">
                    Audio
                </label>
            </div>
            <div class="drawer-row" style="margin-top: 4px;">
                <label class="drawer-label" style="display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="printStudy" style="width: 16px; height: 16px; cursor: pointer;">
                    Study Flow
                </label>
            </div>
            <div class="drawer-row" style="margin-top: 4px;">
                <label class="drawer-label" style="display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="printFeatures" style="width: 16px; height: 16px; cursor: pointer;">
                    Features
                </label>
            </div>
            <div class="drawer-row" style="margin-top: 4px;">
                <label class="drawer-label" style="display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="printData" style="width: 16px; height: 16px; cursor: pointer;">
                    Data
                </label>
            </div>
            <div class="drawer-row" style="margin-top: 4px;">
                <label class="drawer-label" style="display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="printD1" style="width: 16px; height: 16px; cursor: pointer;">
                    D1
                </label>
            </div>
            <div class="drawer-row" style="margin-top: 4px;">
                <label class="drawer-label" style="display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="printInteraction" style="width: 16px; height: 16px; cursor: pointer;">
                    Interaction
                </label>
            </div>
        </div>
    `;
    document.body.appendChild(drawer);
}

export function injectGearPopovers() {
    // Nav Bar gear
    const navGear = document.getElementById('navBarGear');
    if (navGear && !navGear.querySelector('.gear-btn')) {
        navGear.innerHTML = `
            <span class="gear-btn" role="button" aria-label="Navigation bar settings">&#9881;</span>
            <div class="gear-popover" id="navBarPopover">
                <div class="gear-popover-title">Navigation Bar</div>
                <div class="gear-popover-row">
                    <span class="gear-label">Show:</span>
                    <select id="miniMapView" class="gear-select">
                        <option value="spectrogram" selected>Spectrogram</option>
                        <option value="both">Combination</option>
                        <option value="linePlot">Line Plot</option>
                    </select>
                </div>
                <div class="gear-popover-row">
                    <span class="gear-label">Mode:</span>
                    <select id="viewingMode" class="gear-select">
                        <option value="full">Region Creation</option>
                        <option value="pageTurn" selected>Windowed Page Turn</option>
                        <option value="scroll">Windowed Scroll</option>
                        <option value="static">Windowed Static</option>
                    </select>
                </div>
                <div class="gear-popover-row">
                    <span class="gear-label">Click:</span>
                    <select id="navBarClick" class="gear-select">
                        <option value="moveWindow" selected>Move window</option>
                        <option value="moveAndPlay">Move & play</option>
                    </select>
                </div>
                <div class="gear-popover-row">
                    <span class="gear-label">Markers:</span>
                    <select id="navBarMarkers" class="gear-select">
                        <option value="daily" selected>Daily</option>
                        <option value="none">None</option>
                    </select>
                </div>
                <div class="gear-popover-row">
                    <span class="gear-label">Feat Boxes:</span>
                    <select id="navBarFeatureBoxes" class="gear-select">
                        <option value="show" selected>Show</option>
                        <option value="hide">Hide</option>
                    </select>
                </div>
                <div class="gear-popover-title">Zoom</div>
                <div class="gear-popover-row">
                    <span class="gear-label">Zoom:</span>
                    <select id="navBarScroll" class="gear-select">
                        <option value="zoom" selected>Zoom</option>
                        <option value="none">No action</option>
                    </select>
                </div>
                <div class="gear-popover-row">
                    <span class="gear-label">Sens:</span>
                    <select id="navBarVSens" class="gear-select" data-paired="navBarScroll">
                        <option value="25">25%</option>
                        <option value="50">50%</option>
                        <option value="75">75%</option>
                        <option value="100" selected>100%</option>
                        <option value="150">150%</option>
                        <option value="200">200%</option>
                    </select>
                </div>
                <div class="gear-popover-title">Scroll</div>
                <div class="gear-popover-row">
                    <span class="gear-label">Scroll:</span>
                    <select id="navBarHScroll" class="gear-select">
                        <option value="pan" selected>Pan</option>
                        <option value="none">No action</option>
                    </select>
                </div>
                <div class="gear-popover-row">
                    <span class="gear-label">Sens:</span>
                    <select id="navBarHSens" class="gear-select" data-paired="navBarHScroll">
                        <option value="10">10%</option>
                        <option value="25">25%</option>
                        <option value="50">50%</option>
                        <option value="75">75%</option>
                        <option value="100" selected>100%</option>
                        <option value="150">150%</option>
                        <option value="200">200%</option>
                    </select>
                </div>
            </div>
        `;
    }

    // Main Window gear
    const mainGear = document.getElementById('mainWindowGear');
    if (mainGear && !mainGear.querySelector('.gear-btn')) {
        mainGear.innerHTML = `
            <span class="gear-btn" role="button" aria-label="Main window settings">&#9881;</span>
            <div class="gear-popover" id="mainWindowPopover">
                <div class="gear-popover-title">Main Window</div>
                <div class="gear-popover-row">
                    <span class="gear-label">Show:</span>
                    <select id="mainWindowView" class="gear-select">
                        <option value="spectrogram" selected>Spectrogram</option>
                        <option value="both">Combination</option>
                        <option value="timeSeries">Time Series</option>
                    </select>
                </div>
                <div class="gear-popover-row">
                    <span class="gear-label">Mode:</span>
                    <select id="mainWindowMode" class="gear-select">
                        <option value="full">Region Creation</option>
                        <option value="pageTurn" selected>Windowed Page Turn</option>
                        <option value="scroll">Windowed Scroll</option>
                        <option value="static">Windowed Static</option>
                    </select>
                </div>
                <div class="gear-popover-row">
                    <span class="gear-label">Click:</span>
                    <select id="mainWindowClick" class="gear-select">
                        <option value="noAction" selected>No action</option>
                        <option value="playAudio">Play audio</option>
                    </select>
                </div>
                <div class="gear-popover-row">
                    <span class="gear-label">Release:</span>
                    <select id="mainWindowRelease" class="gear-select">
                        <option value="playAudio" selected>Play audio</option>
                        <option value="noAction">No action</option>
                    </select>
                </div>
                <div class="gear-popover-row">
                    <span class="gear-label">Drag:</span>
                    <select id="mainWindowDrag" class="gear-select">
                        <option value="drawFeature" selected>Draw feature</option>
                        <option value="noAction">No action</option>
                    </select>
                </div>
                <div class="gear-popover-row">
                    <span class="gear-label">Markers:</span>
                    <select id="mainWindowMarkers" class="gear-select">
                        <option value="daily" selected>Daily</option>
                        <option value="none">None</option>
                    </select>
                </div>
                <div class="gear-popover-row">
                    <span class="gear-label">X-Axis:</span>
                    <select id="mainWindowXAxis" class="gear-select">
                        <option value="show" selected>Show Ticks</option>
                        <option value="hide">Hide Ticks</option>
                    </select>
                </div>
                <div class="gear-popover-row">
                    <span class="gear-label">Shader:</span>
                    <select id="mainWindowBoxFilter" class="gear-select">
                        <option value="linear" selected>Linear</option>
                        <option value="box">Box</option>
                        <option value="nearest">Nearest</option>
                    </select>
                </div>
                <div class="gear-popover-title">Zoom</div>
                <div class="gear-popover-row">
                    <span class="gear-label">Zoom:</span>
                    <select id="mainWindowScroll" class="gear-select">
                        <option value="zoom" selected>Zoom</option>
                        <option value="none">No action</option>
                    </select>
                </div>
                <div class="gear-popover-row">
                    <span class="gear-label">Sens:</span>
                    <select id="mainWindowVSens" class="gear-select" data-paired="mainWindowScroll">
                        <option value="25">25%</option>
                        <option value="50">50%</option>
                        <option value="75">75%</option>
                        <option value="100" selected>100%</option>
                        <option value="150">150%</option>
                        <option value="200">200%</option>
                    </select>
                </div>
                <div class="gear-popover-title">Scroll</div>
                <div class="gear-popover-row">
                    <span class="gear-label">Scroll:</span>
                    <select id="mainWindowHScroll" class="gear-select">
                        <option value="pan" selected>Pan</option>
                        <option value="none">No action</option>
                    </select>
                </div>
                <div class="gear-popover-row">
                    <span class="gear-label">Sens:</span>
                    <select id="mainWindowHSens" class="gear-select" data-paired="mainWindowHScroll">
                        <option value="10">10%</option>
                        <option value="25">25%</option>
                        <option value="50">50%</option>
                        <option value="75">75%</option>
                        <option value="100" selected>100%</option>
                        <option value="150">150%</option>
                        <option value="200">200%</option>
                    </select>
                </div>
                <div class="gear-popover-title">Feature Numbers</div>
                <div class="gear-popover-row">
                    <span class="gear-label">Color:</span>
                    <select id="mainWindowNumbers" class="gear-select">
                        <option value="hide">Hide</option>
                        <option value="white" selected>White</option>
                        <option value="black">Black</option>
                        <option value="red">Red</option>
                        <option value="outline">Outline</option>
                    </select>
                </div>
                <div class="gear-popover-row">
                    <span class="gear-label">Location:</span>
                    <select id="mainWindowNumbersLoc" class="gear-select">
                        <option value="above">Above box</option>
                        <option value="inside" selected>Inside box</option>
                    </select>
                </div>
                <div class="gear-popover-row">
                    <span class="gear-label">Weight:</span>
                    <select id="mainWindowNumbersWeight" class="gear-select">
                        <option value="normal" selected>Normal</option>
                        <option value="500">Medium</option>
                        <option value="bold">Bold</option>
                    </select>
                </div>
                <div class="gear-popover-row">
                    <span class="gear-label">Size:</span>
                    <select id="mainWindowNumbersSize" class="gear-select">
                        <option value="8">8px</option>
                        <option value="9">9px</option>
                        <option value="10">10px</option>
                        <option value="11">11px</option>
                        <option value="12">12px</option>
                        <option value="13" selected>13px</option>
                        <option value="14">14px</option>
                        <option value="15">15px</option>
                        <option value="16">16px</option>
                        <option value="17">17px</option>
                        <option value="18">18px</option>
                        <option value="19">19px</option>
                        <option value="20">20px</option>
                    </select>
                </div>
                <div class="gear-popover-row">
                    <span class="gear-label">Shadow:</span>
                    <select id="mainWindowNumbersShadow" class="gear-select">
                        <option value="on" selected>On</option>
                        <option value="off">Off</option>
                    </select>
                </div>
            </div>
        `;
    }
}
