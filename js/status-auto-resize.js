/**
 * status-auto-resize.js
 * Automatically shrinks status text font size when it overflows
 */

/**
 * Check if text is overflowing and shrink font size if needed
 * @param {HTMLElement} element - The status element to check
 */
export function autoResizeStatusText(element) {
    if (!element) return;
    
    // Reset to max font size to start
    let fontSize = 16;
    element.style.fontSize = `${fontSize}px`;
    
    // Check if text is overflowing (scrollWidth > clientWidth)
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
    
    // Use MutationObserver to detect text changes
    const observer = new MutationObserver(() => {
        autoResizeStatusText(statusEl);
    });
    
    observer.observe(statusEl, {
        childList: true,
        subtree: true,
        characterData: true
    });
    
    // Also handle window resize
    window.addEventListener('resize', () => {
        autoResizeStatusText(statusEl);
    });
    
    console.log('✅ Status auto-resize enabled');
}

