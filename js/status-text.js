/**
 * status-text.js
 * Typing animation and status bar utilities.
 * Extracted from tutorial-effects.js — the only parts we actually use.
 */

let activeTypingTimeout = null;
let activePulseTimeout = null;
let activeTypingText = null;
let activeTypingElement = null;
let activeTypingBaseText = null;
let clickHandlerAttached = false;

/**
 * Pulse the period at the end of text (blink on/off)
 */
function pulsePeriod(element, baseText, pulseCount = 5) {
    let currentPulse = 0;
    let showingPeriod = false;

    activeTypingElement = element;
    activeTypingBaseText = baseText;

    const pulse = () => {
        if (currentPulse < pulseCount) {
            showingPeriod = !showingPeriod;
            element.textContent = baseText + (showingPeriod ? '.' : '');
            currentPulse++;
            activePulseTimeout = setTimeout(pulse, 300);
        } else {
            element.textContent = baseText + '.';
            activePulseTimeout = null;
            activeTypingElement = null;
            activeTypingBaseText = null;
        }
    };

    activePulseTimeout = setTimeout(pulse, 200);
}

/**
 * Type out text with human-like jitter and delay.
 * After completion, pulses the trailing period if present.
 */
export function typeText(element, text, baseDelay = 30, jitterRange = 15) {
    if (!element) return;

    if (activeTypingTimeout) { clearTimeout(activeTypingTimeout); activeTypingTimeout = null; }
    if (activePulseTimeout) { clearTimeout(activePulseTimeout); activePulseTimeout = null; }

    element.textContent = '';

    const hasPeriod = text.endsWith('.');
    const textWithoutPeriod = hasPeriod ? text.slice(0, -1) : text;

    activeTypingText = text;
    activeTypingElement = element;
    activeTypingBaseText = textWithoutPeriod;

    const textArray = Array.from(text);
    let index = 0;
    const typeNextChar = () => {
        if (index < textArray.length) {
            element.textContent += textArray[index];
            index++;
            const jitter = (Math.random() - 0.5) * 2 * jitterRange;
            const delay = Math.max(10, baseDelay + jitter);
            activeTypingTimeout = setTimeout(typeNextChar, delay);
        } else if (hasPeriod) {
            activeTypingTimeout = null;
            activeTypingText = null;
            pulsePeriod(element, textWithoutPeriod, 5);
        } else {
            activeTypingTimeout = null;
            activeTypingText = null;
            activeTypingElement = null;
            activeTypingBaseText = null;
        }
    };

    typeNextChar();
}

/**
 * Cancel any active typing or pulse animation.
 */
export function cancelTyping() {
    if (activeTypingTimeout) { clearTimeout(activeTypingTimeout); activeTypingTimeout = null; }
    if (activePulseTimeout) { clearTimeout(activePulseTimeout); activePulseTimeout = null; }
    activeTypingText = null;
    activeTypingElement = null;
    activeTypingBaseText = null;
}

/**
 * Attach click-to-copy handler on the status element (once).
 */
function attachStatusClickHandler() {
    if (clickHandlerAttached) return;
    const statusEl = document.getElementById('status');
    if (statusEl) {
        statusEl.style.cursor = 'pointer';
        statusEl.title = 'Click to copy status message';
        statusEl.addEventListener('click', async () => {
            const textToCopy = statusEl.textContent.trim();
            if (textToCopy && textToCopy !== '✓ Copied!') {
                try {
                    await navigator.clipboard.writeText(textToCopy);
                    const originalText = textToCopy;
                    statusEl.textContent = '✓ Copied!';
                    setTimeout(() => { statusEl.textContent = originalText; }, 1000);
                } catch (err) {
                    console.error('Failed to copy:', err);
                }
            }
        });
        clickHandlerAttached = true;
    }
}

/**
 * Set status bar text with typing animation.
 */
export function setStatusText(text, className = 'status info') {
    const statusEl = document.getElementById('status');
    if (statusEl) {
        const currentTextAlign = statusEl.style.textAlign;
        const preserveTextAlign = currentTextAlign === 'center' || currentTextAlign === 'right';

        statusEl.className = className;
        attachStatusClickHandler();

        if (!text || text.trim() === '') {
            statusEl.textContent = '';
            return;
        }

        typeText(statusEl, text, 20, 10);

        if (preserveTextAlign) {
            setTimeout(() => { statusEl.style.textAlign = currentTextAlign; }, 50);
        }
    }
}
