/**
 * Colormap definitions for spectrogram visualization
 * Each colormap is a function that takes a normalized value (0-1) and returns [r, g, b]
 */

// Current colormap selection
let currentColormap = 'inferno';

// Pre-computed LUT for performance (256 levels * 3 channels)
let colorLUT = null;

/**
 * Colormap definitions
 * Each function takes t (0-1) and returns [r, g, b] (0-255)
 */
const colormaps = {
    // Inferno: Black → Purple → Red → Orange → Yellow (matplotlib classic)
    inferno: (t) => {
        if (t < 0.15) {
            // Black to dark purple (15% black zone)
            const s = t / 0.15;
            return [Math.round(s * 80), 0, Math.round(s * 100)];
        } else if (t < 0.43) {
            // Dark purple to red-purple
            const s = (t - 0.15) / 0.28;
            return [Math.round(80 + s * 140), Math.round(s * 40), Math.round(100 - s * 50)];
        } else if (t < 0.71) {
            // Red-purple to orange
            const s = (t - 0.43) / 0.28;
            return [Math.round(220 + s * 35), Math.round(40 + s * 100), Math.round(50 - s * 50)];
        } else {
            // Orange to yellow
            const s = (t - 0.71) / 0.29;
            return [255, Math.round(140 + s * 100), Math.round(s * 80)];
        }
    },

    // Solar: Black → Red → Orange → Yellow (space weather themed)
    solar: (t) => {
        const hue = t * 60; // 0-60 degrees (red to yellow)
        const saturation = 100;
        const lightness = 8 + (t * 62); // 8-70% (dark start but preserves detail)
        return hslToRgb(hue, saturation, lightness);
    },

    // Aurora: Black → Deep Purple → Magenta → Pink → White (aurora borealis vibes)
    aurora: (t) => {
        if (t < 0.15) {
            // Black to deep purple (15% black zone)
            const s = t / 0.15;
            return [Math.round(s * 75), 0, Math.round(s * 130)];
        } else if (t < 0.43) {
            // Deep purple to magenta
            const s = (t - 0.15) / 0.28;
            return [Math.round(75 + s * 180), Math.round(s * 50), Math.round(130 + s * 75)];
        } else if (t < 0.71) {
            // Magenta to pink/light magenta
            const s = (t - 0.43) / 0.28;
            return [255, Math.round(50 + s * 130), Math.round(205 + s * 50)];
        } else {
            // Pink to white
            const s = (t - 0.71) / 0.29;
            return [255, Math.round(180 + s * 75), 255];
        }
    },

    // Turbo: Google's perceptually-uniform rainbow (colorblind-friendly)
    // Attempt at approximating the turbo colormap
    turbo: (t) => {
        // Attempt at approximating turbo colormap using polynomial approximation
        const r = Math.max(0, Math.min(255, Math.round(
            34.61 + t * (1172.33 + t * (-10793.56 + t * (33300.12 + t * (-38394.49 + t * 14825.05))))
        )));
        const g = Math.max(0, Math.min(255, Math.round(
            23.31 + t * (557.33 + t * (1225.33 + t * (-8574.96 + t * (12155.29 + t * -5765.72))))
        )));
        const b = Math.max(0, Math.min(255, Math.round(
            27.2 + t * (3211.1 + t * (-15327.97 + t * (27814 + t * (-22569.18 + t * 6838.66))))
        )));
        return [r, g, b];
    },

    // Viridis: Black → Purple → Teal → Yellow (colorblind-safe, darkened start)
    viridis: (t) => {
        // Attempt at approximating viridis colormap
        const r = Math.max(0, Math.min(255, Math.round(
            68.19 + t * (-128.55 + t * (564.18 + t * (-524.76 + t * 276.58)))
        )));
        const g = Math.max(0, Math.min(255, Math.round(
            1.99 + t * (259.75 + t * (-138.47 + t * (187.77 + t * -55.14)))
        )));
        const b = Math.max(0, Math.min(255, Math.round(
            84.04 + t * (107.26 + t * (-695.01 + t * (1116.72 + t * -548.89)))
        )));
        // Darken the low end for waveform background (fade from black)
        const darkness = Math.min(1, t * 6.67); // 0-0.15 range fades from black (15% black zone)
        return [Math.round(r * darkness), Math.round(g * darkness), Math.round(b * darkness)];
    },

    // Jet: Classic rainbow (not colorblind-friendly but familiar)
    jet: (t) => {
        let r, g, b;
        if (t < 0.125) {
            r = 0;
            g = 0;
            b = 128 + t * 4 * 127;
        } else if (t < 0.375) {
            r = 0;
            g = (t - 0.125) * 4 * 255;
            b = 255;
        } else if (t < 0.625) {
            r = (t - 0.375) * 4 * 255;
            g = 255;
            b = 255 - (t - 0.375) * 4 * 255;
        } else if (t < 0.875) {
            r = 255;
            g = 255 - (t - 0.625) * 4 * 255;
            b = 0;
        } else {
            r = 255 - (t - 0.875) * 4 * 127;
            g = 0;
            b = 0;
        }
        // Darken the low end for waveform background (15% black zone)
        const darkness = Math.min(1, t * 6.67);
        return [Math.round(r * darkness), Math.round(g * darkness), Math.round(b * darkness)];
    },

    // Plasma: Black → Teal → Electric Blue → Cyan → White (plasma/electric vibes)
    plasma: (t) => {
        if (t < 0.15) {
            // Black to dark teal (15% black zone)
            const s = t / 0.15;
            return [0, Math.round(s * 80), Math.round(s * 100)];
        } else if (t < 0.43) {
            // Dark teal to electric blue
            const s = (t - 0.15) / 0.28;
            return [0, Math.round(80 + s * 70), Math.round(100 + s * 155)];
        } else if (t < 0.71) {
            // Electric blue to cyan
            const s = (t - 0.43) / 0.28;
            return [Math.round(s * 100), Math.round(150 + s * 105), 255];
        } else {
            // Cyan to white
            const s = (t - 0.71) / 0.29;
            return [Math.round(100 + s * 155), 255, 255];
        }
    }
};

// Display names for the UI
export const colormapNames = {
    inferno: 'Inferno',
    solar: 'Solar',
    aurora: 'Aurora',
    jet: 'Jet',
    plasma: 'Plasma',
    turbo: 'Turbo',
    viridis: 'Viridis'
};

// Accent colors for each colormap (used for UI borders/glows)
const colormapAccents = {
    solar:   { color: '#ff6b35', rgb: '255, 107, 53', bg: 'linear-gradient(135deg, #1a1410, #0a0503)' },
    turbo:   { color: '#23a6d5', rgb: '35, 166, 213', bg: 'linear-gradient(135deg, #0f1a1f, #050a0d)' },
    viridis: { color: '#21918c', rgb: '33, 145, 140', bg: 'linear-gradient(135deg, #151a22, #080a10)' },
    jet:     { color: '#5dadec', rgb: '93, 173, 236', bg: 'linear-gradient(135deg, #141828, #080a14)' },
    aurora:  { color: '#9b4dca', rgb: '155, 77, 202', bg: 'linear-gradient(135deg, #1e1b2e, #0a0814)' },
    plasma:  { color: '#22d3ee', rgb: '34, 211, 238', bg: 'linear-gradient(135deg, #12181f, #08090c)' },
    inferno: { color: '#808080', rgb: '128, 128, 128', bg: 'linear-gradient(135deg, #1a1f35, #0a0e1a)' }
};

/**
 * Update CSS custom properties to match current colormap
 */
export function updateAccentColors() {
    const accent = colormapAccents[currentColormap] || colormapAccents.inferno;
    const root = document.documentElement;

    root.style.setProperty('--accent-color', accent.color);
    root.style.setProperty('--accent-rgb', accent.rgb);
    root.style.setProperty('--accent-glow', `rgba(${accent.rgb}, 0.25)`);
    root.style.setProperty('--accent-border', `rgba(${accent.rgb}, 0.2)`);
    root.style.setProperty('--accent-soft', `rgba(${accent.rgb}, 0.12)`);
    root.style.setProperty('--accent-bg', accent.bg);
}

/**
 * HSL to RGB conversion helper
 */
function hslToRgb(h, s, l) {
    h = h / 360;
    s = s / 100;
    l = l / 100;

    let r, g, b;

    if (s === 0) {
        r = g = b = l;
    } else {
        const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1/6) return p + (q - p) * 6 * t;
            if (t < 1/2) return q;
            if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
        };

        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
    }

    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * Build the color lookup table for the current colormap
 */
export function buildColorLUT() {
    colorLUT = new Uint8ClampedArray(256 * 3);
    const colormapFn = colormaps[currentColormap] || colormaps.solar;

    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        const rgb = colormapFn(t);
        colorLUT[i * 3] = rgb[0];
        colorLUT[i * 3 + 1] = rgb[1];
        colorLUT[i * 3 + 2] = rgb[2];
    }

    console.log(`🎨 Built color LUT for colormap: ${currentColormap}`);
    return colorLUT;
}

/**
 * Get the current color LUT (builds if needed)
 */
export function getColorLUT() {
    if (colorLUT === null) {
        buildColorLUT();
    }
    return colorLUT;
}

/**
 * Set the current colormap and rebuild the LUT
 */
export function setColormap(name) {
    if (colormaps[name]) {
        currentColormap = name;
        buildColorLUT();
        return true;
    }
    console.warn(`Unknown colormap: ${name}`);
    return false;
}

/**
 * Get the current colormap name
 */
export function getCurrentColormap() {
    return currentColormap;
}

/**
 * Get list of available colormap names
 */
export function getAvailableColormaps() {
    return Object.keys(colormaps);
}

// Initialize LUT on module load
buildColorLUT();
