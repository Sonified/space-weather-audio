// ========== CHUNK URL UTILITIES ==========
// Shared logic for computing chunk URLs from study step config.
// Used by both goes-cloudflare-fetcher.js and background-preloader.js.

const WORKER_BASE = 'https://spaceweather.now.audio/emic';
const INSTRUMENT_SAMPLE_RATE = 10; // Hz — GOES mag high-res cadence

const DATASET_TO_SATELLITE = {
    'DN_MAGN-L2-HIRES_G16': 'GOES-16',
    'DN_MAGN-L2-HIRES_G19': 'GOES-19',
};

const COMPONENT_MAP = ['bx', 'by', 'bz'];

// Spacecraft config name → internal mapping
const SPACECRAFT_MAP = {
    'GOES-16': { spacecraft: 'GOES', dataset: 'DN_MAGN-L2-HIRES_G16' },
    'GOES-17': { spacecraft: 'GOES', dataset: 'DN_MAGN-L2-HIRES_G17' },
    'GOES-18': { spacecraft: 'GOES', dataset: 'DN_MAGN-L2-HIRES_G18' },
    'GOES-19': { spacecraft: 'GOES', dataset: 'DN_MAGN-L2-HIRES_G19' },
};

/**
 * Fetch metadata.json for each day in range, for a given component.
 * @returns {Promise<Object[]>} Array of metadata objects (null for missing days)
 */
export async function fetchAllDayMetadata(startTimeISO, endTimeISO, satellite, component, signal) {
    const days = [];
    const current = new Date(startTimeISO);
    const end = new Date(endTimeISO);

    while (current < end) {
        days.push(current.toISOString().split('T')[0]);
        current.setUTCDate(current.getUTCDate() + 1);
    }

    const results = await Promise.all(days.map(async (dateStr) => {
        const [year, month, day] = dateStr.split('-');
        const url = `${WORKER_BASE}/data/${year}/${month}/${day}/${satellite}/mag/${component}/metadata.json`;
        try {
            const resp = await fetch(url, { signal });
            if (!resp.ok) return null;
            return await resp.json();
        } catch (e) {
            return null;
        }
    }));

    return results;
}

/**
 * Build chunk schedule (same algorithm as goes-cloudflare-fetcher.js).
 * Returns array of { type, date, startTime, samples, url, isMissing }.
 */
export function buildChunkSchedule(startTime, endTime, allDayMetadata, satellite, component) {
    const chunks = [];
    let currentTime = new Date(startTime);

    function findChunk(dateStr, chunkType, startTimeStr) {
        const dayMeta = allDayMetadata.find(m => m && m.date === dateStr);
        if (!dayMeta || !dayMeta.chunks[chunkType]) return null;
        return dayMeta.chunks[chunkType].find(c => c.start === startTimeStr);
    }

    function buildUrl(dateStr, chunkType, filename) {
        const [year, month, day] = dateStr.split('-');
        return `${WORKER_BASE}/data/${year}/${month}/${day}/${satellite}/mag/${component}/${chunkType}/${filename}`;
    }

    let minutesElapsed = 0;

    while (currentTime < endTime) {
        const dateStr = currentTime.toISOString().split('T')[0];
        const hour = currentTime.getUTCHours();
        const minute = currentTime.getUTCMinutes();
        const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
        const remainingMinutes = (endTime - currentTime) / 1000 / 60;

        let chunkType, chunkDurationMinutes;

        if (minutesElapsed < 120) {
            chunkType = '15m';
            chunkDurationMinutes = 15;
        } else if (minutesElapsed < 360) {
            if (minute === 0 && remainingMinutes >= 60) {
                chunkType = '1h';
                chunkDurationMinutes = 60;
            } else {
                chunkType = '15m';
                chunkDurationMinutes = 15;
            }
        } else if (minutesElapsed < 1440) {
            if (hour % 6 === 0 && minute === 0 && remainingMinutes >= 360) {
                chunkType = '6h';
                chunkDurationMinutes = 360;
            } else if (minute === 0 && remainingMinutes >= 60) {
                chunkType = '1h';
                chunkDurationMinutes = 60;
            } else {
                chunkType = '15m';
                chunkDurationMinutes = 15;
            }
        } else {
            if (hour === 0 && minute === 0 && remainingMinutes >= 1440) {
                chunkType = '24h';
                chunkDurationMinutes = 1440;
            } else if (hour % 6 === 0 && minute === 0 && remainingMinutes >= 360) {
                chunkType = '6h';
                chunkDurationMinutes = 360;
            } else if (minute === 0 && remainingMinutes >= 60) {
                chunkType = '1h';
                chunkDurationMinutes = 60;
            } else {
                chunkType = '15m';
                chunkDurationMinutes = 15;
            }
        }

        const chunkMeta = findChunk(dateStr, chunkType, timeStr);
        if (chunkMeta) {
            chunks.push({
                type: chunkType,
                date: dateStr,
                startTime: timeStr,
                samples: chunkMeta.samples,
                min: chunkMeta.min,
                max: chunkMeta.max,
                url: buildUrl(dateStr, chunkType, chunkMeta.filename),
                isMissing: false,
            });
        } else {
            const expectedSamples = chunkDurationMinutes * 60 * INSTRUMENT_SAMPLE_RATE;
            chunks.push({
                type: chunkType,
                date: dateStr,
                startTime: timeStr,
                samples: expectedSamples,
                min: 0,
                max: 0,
                url: null,
                isMissing: true,
            });
        }

        currentTime = new Date(currentTime.getTime() + chunkDurationMinutes * 60 * 1000);
        minutesElapsed += chunkDurationMinutes;
    }

    return chunks;
}

/**
 * Resolve a study step config into { satellite, component, startTimeISO, endTimeISO }.
 */
export function resolveStepParams(step) {
    const mapped = SPACECRAFT_MAP[step.spacecraft] || { spacecraft: 'GOES', dataset: 'DN_MAGN-L2-HIRES_G16' };
    const dataset = mapped.dataset;
    const satellite = DATASET_TO_SATELLITE[dataset] || 'GOES-16';

    // Component: default to bx (index 0)
    const component = COMPONENT_MAP[step.componentIndex || 0] || 'bx';

    const startTimeISO = step.startTime || (step.startDate ? step.startDate + 'T00:00:00.000Z' : null);
    const endTimeISO = step.endTime || (step.endDate ? step.endDate + 'T00:00:00.000Z' : null);

    return { satellite, component, dataset, startTimeISO, endTimeISO };
}

// Re-export constants so the fetcher can import them instead of redefining
export { WORKER_BASE, INSTRUMENT_SAMPLE_RATE, DATASET_TO_SATELLITE, COMPONENT_MAP };
