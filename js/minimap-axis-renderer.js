/**
 * minimap-axis-renderer.js
 * Y-axis rendering for minimap showing amplitude values
 */
import * as State from './audio-state.js';

/**
 * Draw amplitude axis for minimap
 * Shows: -0.5, -0, 0.5 at appropriate Y positions
 */
export function drawMinimapAxis() {
    const canvas = document.getElementById('minimap-axis');
    if (!canvas) return;

    // Don't draw until data has loaded
    if (!State.originalDataFrequencyRange) return;

    const minimapCanvas = document.getElementById('minimap');
    if (!minimapCanvas) return;

    // Use display height (offsetHeight) not internal canvas height (which may be scaled by devicePixelRatio)
    const displayHeight = minimapCanvas.offsetHeight;
    const devicePixelRatio = window.devicePixelRatio || 1;
    
    // Only resize if dimensions changed (resizing clears the canvas, may cause flicker)
    if (canvas.width !== 60 || canvas.height !== displayHeight) {
        canvas.width = 60;
        canvas.height = displayHeight;
    }
    
    const ctx = canvas.getContext('2d');
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;
    
    // Clear canvas (transparent background)
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    
    // Get CSS variables for styling
    const rootStyles = getComputedStyle(document.body);
    const fontSize = rootStyles.getPropertyValue('--axis-label-font-size').trim() || '14px';
    const labelColor = rootStyles.getPropertyValue('--axis-label-color').trim() || '#ddd';
    const tickColor = rootStyles.getPropertyValue('--axis-tick-color').trim() || '#888';
    
    // Setup text styling - disable shadows/outlines
    ctx.font = `${fontSize} Arial, sans-serif`;
    ctx.fillStyle = labelColor;
    ctx.strokeStyle = tickColor;
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
 * Position the minimap axis canvas to the right of the minimap
 * Optimized: Only updates position, doesn't redraw
 */
export function positionMinimapAxisCanvas() {
    const minimapCanvas = document.getElementById('minimap');
    const axisCanvas = document.getElementById('minimap-axis');
    const panel = minimapCanvas?.closest('.panel');

    if (!minimapCanvas || !axisCanvas || !panel) return;

    // Use getBoundingClientRect only once and cache values
    const minimapRect = minimapCanvas.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();

    // Calculate position: right edge of minimap, aligned with top
    const rightEdge = minimapRect.right - panelRect.left;
    const topEdge = minimapRect.top - panelRect.top;
    
    // Batch style updates to minimize reflows
    // Show the canvas after positioning to prevent flash
    axisCanvas.style.cssText = `
        position: absolute;
        left: ${rightEdge}px;
        top: ${topEdge}px;
        width: 60px;
        height: ${minimapRect.height}px;
        opacity: 1;
        visibility: visible;
    `;
}

/**
 * Resize minimap axis canvas to match minimap height
 * CRITICAL: Set width to 60px to match display width - ticks must stay OUTSIDE minimap
 */
export function resizeMinimapAxisCanvas() {
    const minimapCanvas = document.getElementById('minimap');
    const axisCanvas = document.getElementById('minimap-axis');

    if (!minimapCanvas || !axisCanvas) return;

    // Only resize if dimensions changed (resizing clears the canvas, may cause flicker)
    const newHeight = minimapCanvas.offsetHeight;
    if (axisCanvas.width !== 60 || axisCanvas.height !== newHeight) {
        axisCanvas.width = 60;
        axisCanvas.height = newHeight;
    }
    
    // Reposition and redraw after resize
    positionMinimapAxisCanvas();
    drawMinimapAxis();
}

