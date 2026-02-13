/**
 * status-auto-resize.js
 * Automatically shrinks status text font size when it overflows
 */

let statusObserver = null;
let statusResizeHandler = null;

/**
 * Check if text is overflowing and shrink font size if needed
 * @param {HTMLElement} element - The status element to check
 */
export function autoResizeStatusText(element) {
    if (!element) return;

    // Skip resize during loading animation — text is just dots changing,
    // no need to recalculate font size every 500ms
    if (element.classList.contains('loading')) return;

    // Check if text fits at current size before resetting
    const currentSize = parseFloat(element.style.fontSize) || 16;
    if (element.scrollWidth <= element.clientWidth && currentSize === 16) return;

    // Try growing back to max first
    let fontSize = 16;
    element.style.fontSize = `${fontSize}px`;

    // Shrink only if overflowing
    while (element.scrollWidth > element.clientWidth && fontSize > 10) {
        fontSize -= 0.5;
        element.style.fontSize = `${fontSize}px`;
    }

    // If still overflowing at minimum, allow ellipsis
    if (element.scrollWidth > element.clientWidth) {
        element.style.textOverflow = 'ellipsis';
    }
}

/**
 * Setup auto-resize observer for status element
 */
export function setupStatusAutoResize() {
    const statusEl = document.getElementById('status');
    if (!statusEl) return;

    // Clean up previous observers if any
    cleanupStatusAutoResize();

    // Use MutationObserver to detect text changes
    statusObserver = new MutationObserver(() => {
        autoResizeStatusText(statusEl);
    });

    statusObserver.observe(statusEl, {
        childList: true,
        subtree: true,
        characterData: true
    });

    // Also handle window resize
    statusResizeHandler = () => autoResizeStatusText(statusEl);
    window.addEventListener('resize', statusResizeHandler);

    console.log('✅ Status auto-resize enabled');
}

/**
 * Disconnect observer and remove resize listener
 */
export function cleanupStatusAutoResize() {
    if (statusObserver) {
        statusObserver.disconnect();
        statusObserver = null;
    }
    if (statusResizeHandler) {
        window.removeEventListener('resize', statusResizeHandler);
        statusResizeHandler = null;
    }
}
