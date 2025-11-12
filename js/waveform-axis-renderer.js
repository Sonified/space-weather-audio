/**
 * waveform-axis-renderer.js
 * Y-axis rendering for waveform showing amplitude values
 */

/**
 * Draw amplitude axis for waveform
 * Shows: -0.5, -0, 0.5 at appropriate Y positions
 */
export function drawWaveformAxis() {
    const canvas = document.getElementById('waveform-axis');
    if (!canvas) return;
    
    const waveformCanvas = document.getElementById('waveform');
    if (!waveformCanvas) return;
    
    // Use display height (offsetHeight) not internal canvas height (which may be scaled by devicePixelRatio)
    const displayHeight = waveformCanvas.offsetHeight;
    const devicePixelRatio = window.devicePixelRatio || 1;
    
    // Set internal canvas resolution to match display size (no devicePixelRatio scaling for axis)
    canvas.width = 60;
    canvas.height = displayHeight;
    
    const ctx = canvas.getContext('2d');
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;
    
    // Clear canvas (transparent background)
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    
    // Setup text styling - disable shadows/outlines
    ctx.font = '16px Arial, sans-serif';
    ctx.fillStyle = '#ddd';
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    // Disable any shadow effects
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    
    // Waveform is normalized to [-1, 1] range
    // Y positions: top = +1, middle = 0, bottom = -1
    // We want to show: 0.5 (top quarter), 0 (middle), -0.5 (bottom quarter)
    
    const middleY = canvasHeight / 2;      // 0 (center line)
    const topQuarterY = canvasHeight / 4;   // 0.5 (above center)
    const bottomQuarterY = (3 * canvasHeight) / 4; // -0.5 (below center)
    
    // Draw tick at middle (0)
    ctx.beginPath();
    ctx.moveTo(0, middleY);
    ctx.lineTo(5, middleY);
    ctx.stroke();
    ctx.fillText('0', 8, middleY);
    
    // Draw tick at top quarter (0.5)
    ctx.beginPath();
    ctx.moveTo(0, topQuarterY);
    ctx.lineTo(5, topQuarterY);
    ctx.stroke();
    ctx.fillText('0.5', 8, topQuarterY);
    
    // Draw tick at bottom quarter (-0.5)
    ctx.beginPath();
    ctx.moveTo(0, bottomQuarterY);
    ctx.lineTo(5, bottomQuarterY);
    ctx.stroke();
    ctx.fillText('-0.5', 8, bottomQuarterY);
}

/**
 * Position the waveform axis canvas to the right of the waveform
 * Optimized: Only updates position, doesn't redraw
 */
export function positionWaveformAxisCanvas() {
    const waveformCanvas = document.getElementById('waveform');
    const axisCanvas = document.getElementById('waveform-axis');
    const panel = waveformCanvas?.closest('.panel');
    
    if (!waveformCanvas || !axisCanvas || !panel) return;
    
    // Use getBoundingClientRect only once and cache values
    const waveformRect = waveformCanvas.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    
    // Calculate position: right edge of waveform, aligned with top
    const rightEdge = waveformRect.right - panelRect.left;
    const topEdge = waveformRect.top - panelRect.top;
    
    // Batch style updates to minimize reflows
    axisCanvas.style.cssText = `
        position: absolute;
        left: ${rightEdge}px;
        top: ${topEdge}px;
        width: 60px;
        height: ${waveformRect.height}px;
    `;
}

/**
 * Resize waveform axis canvas to match waveform height
 * CRITICAL: Set width to 60px to match display width - ticks must stay OUTSIDE waveform
 */
export function resizeWaveformAxisCanvas() {
    const waveformCanvas = document.getElementById('waveform');
    const axisCanvas = document.getElementById('waveform-axis');
    
    if (!waveformCanvas || !axisCanvas) return;
    
    // CRITICAL: Set width to match display width (60px) - prevents ticks from encroaching
    axisCanvas.width = 60;
    
    // Match height to waveform DISPLAY height (not internal canvas height which may be scaled)
    axisCanvas.height = waveformCanvas.offsetHeight;
    
    // Reposition and redraw after resize
    positionWaveformAxisCanvas();
    drawWaveformAxis();
}

