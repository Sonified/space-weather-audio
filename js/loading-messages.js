// ========== LOADING MESSAGES ==========
// Staged messages shown while waiting for CDAWeb to generate audio files.
// Three tiers: default (0-10s), facts (10s-60s), patience (60s+).
// Spacecraft-specific facts shown when that spacecraft is selected.

// ===== DEFAULT (0-10s) =====
export const DEFAULT_MESSAGE = 'CDAWeb is now preparing your audio files...';

// ===== FACTS (10s-60s, rotate every ~5s) =====
export const GENERAL_FACTS = [
    'Longer time ranges take longer to process...',
    'Each data point becomes a sample in your audio file...',
    'Use the Component dropdown to switch between magnetic field axes...',
    'Spacecraft magnetometers sample the field up to 128 times per second...',
    'High sample rates map hours of data into seconds of sound...',
    'Magnetic field strength is measured in nanotesla...',
    'Look for rising tones in the spectrogram...',
    'Audification preserves the relative timing of the original data...',
    'Your files are being built on NASA servers in Greenbelt, MD...',
    'One WAV file is generated per magnetic field component...',
    'The human ear can hear roughly 20 Hz to 20,000 Hz...',
    'Audification maps data samples directly to audio samples...',
    'The frequency you hear maps to the original oscillation frequency...',
    'The CDAWeb server is located at NASA Goddard Space Flight Center...',
    'Longer durations mean more samples to pack into your file...',
    'Three components: radial, tangential, and normal...',
    'The spectrogram shows frequency content over time...',
    'Tip: Try the Isolate button on the feature information box...',
    'Tip: You can save notes by clicking a feature and adding a note...',
    'Tip: You can navigate by zooming and scrolling or using the arrow keys...',
    'At 44,100 samples/sec, a million data points play in about 23 seconds...',
];

// ===== SPACECRAFT-SPECIFIC FACTS =====

export const PSP_FACTS = [
    'Parker Solar Probe launched August 12, 2018 from Cape Canaveral...',
    'First spacecraft named after a living person: Eugene Parker...',
    'The heat shield is 4.5 inches thick, sun-facing side hits 2,500°F...',
    'At closest approach, PSP flies within 3.8 million miles of the sun...',
    'In 2024 it exceeded 430,000 mph, the fastest human-made object ever...',
    'PSP uses seven Venus gravity assists to tighten its orbit...',
    'Carries four instrument suites: FIELDS, WISPR, SWEAP, and IS⊙IS...',
    'WISPR captured the first images from inside the sun\'s corona...',
    'In 2019 PSP discovered magnetic field reversals nicknamed "switchbacks"...',
    'PSP operates autonomously during solar encounters...',
    'Solar panels retract behind the heat shield during close approaches...',
    'The SWEAP Solar Probe Cup is exposed to full sunlight during encounters...',
    'Eugene Parker watched the launch at 91 and passed away in 2022...',
    'PSP helped locate the Alfvén critical surface, 8 to 13 million miles out...',
    'In December 2024 it briefly entered the sun\'s outer corona...',
    'The mission was conceived in the 1950s, had to wait for heat shield tech...',
    'PSP\'s orbit period at its tightest is about 88 days...',
    'The heat shield is carbon composite foam coated with white ceramic paint...',
    'PSP confirmed solar wind turns turbulent closer to the sun than expected...',
    'The mission is completing 24 orbits of the sun...',
];

export const WIND_FACTS = [
    'WIND launched November 1, 1994 aboard a Delta II rocket...',
    'Orbits the L1 Lagrange point, 1.5 million km sunward of Earth...',
    'Over 31 years of continuous data, one of NASA\'s longest missions...',
    'The MFI magnetometer samples at up to 44 times per second...',
    'Two fluxgate magnetometers sit on a 12-meter boom to reduce interference...',
    'First spacecraft in the Global Geospace Science program...',
    'At L1, WIND detects disturbances 30 to 60 minutes before they hit Earth...',
    'WIND carries eight instruments across plasma, particles, and fields...',
    'Completed double lunar swingbys before settling into L1 orbit in 2004...',
    'WAVES detects radio emissions from solar flares, CMEs, and Jupiter...',
    'WIND data has contributed to over 5,000 peer-reviewed publications...',
    'Works alongside ACE and DSCOVR at L1 as a solar wind monitor fleet...',
    'Spin-stabilized at about 20 revolutions per minute...',
    'WIND helped confirm magnetic reconnection can happen far from Earth...',
    'Weighs about 1,250 kg and measures 2.4 meters across...',
    'Originally designed for three years, it has outlived its mission by 10x...',
    'WIND acts as an early warning station for space weather...',
    'The SWE instrument measures solar wind speed, density, and temperature...',
    'The 3DP analyzer measures electron and ion distributions...',
    'The SMS instrument revealed how the corona feeds the solar wind...',
];

export const MMS_FACTS = [
    'MMS launched March 12, 2015, all four spacecraft deployed in 5 minutes...',
    'Four spacecraft fly in a pyramid formation to map reconnection in 3D...',
    'Magnetic reconnection: field lines snap and reconnect, releasing energy...',
    'The four spacecraft have flown as close as 7.2 km apart, a record...',
    'Each spacecraft spins at about 3 revolutions per minute...',
    'MMS plasma instruments sample 30 times/sec, 100x faster than before...',
    'MMS orbits Earth in a highly elliptical path, from 1.2 to 25 Earth radii...',
    'Each spacecraft carries 25 sensors, 100 total across the constellation...',
    'First mission to directly observe magnetic reconnection...',
    'MMS uses GPS at record altitudes, above the GPS constellation itself...',
    'Formation size adjusts from 7 km to 400 km depending on the target...',
    'MMS found reconnection works in turbulent conditions, not just calm ones...',
    'Electrons energize first during reconnection, in a region just km wide...',
    'Managed by NASA Goddard in Greenbelt, Maryland...',
    'Each spacecraft is octagonal, 3.5 meters across, about 1,360 kg fueled...',
    'On the nightside phase, MMS extends to 152,000 km into the magnetotail...',
    'The HPCA can distinguish hydrogen, helium, and oxygen ions near Earth...',
    'Reconnection studied by MMS is the same process that powers solar flares...',
    'Navigation accuracy within 100 meters at tens of thousands of km...',
    'Approved for multiple extensions beyond its original two-year mission...',
];

export const THEMIS_FACTS = [
    'THEMIS launched all five satellites on one rocket, February 17, 2007...',
    'Named after the Greek goddess of justice and order...',
    'The five probes line up along the magnetotail every four days...',
    'Two probes were redirected to the Moon in 2011, renamed ARTEMIS...',
    'THEMIS proved reconnection in the magnetotail triggers substorms...',
    'Each probe carries a fluxgate magnetometer (FGM) for steady fields...',
    'The search coil magnetometer (SCM) detects rapidly fluctuating fields...',
    'Orbits range from 1.2 to 30 Earth radii across the magnetosphere...',
    'First mission to use five satellites to pinpoint where substorms begin...',
    'A substorm can release as much energy as a magnitude 5.5 earthquake...',
    'Substorms begin about 80,000 miles out, a third of the way to the Moon...',
    'ARTEMIS probes were the first to orbit the Earth-Moon Lagrange points...',
    '20 ground stations across Canada photograph the aurora every 3 seconds...',
    'The entire constellation was built and launched for roughly $200 million...',
    'THEMIS revealed giant magnetic flux ropes in the outer magnetosphere...',
    'The search coil magnetometers detect waves up to 4 kHz...',
    'Principal investigator Vassilis Angelopoulos at UCLA designed THEMIS...',
    'ARTEMIS found the lunar surface becomes electrically charged...',
    'Nearly two decades after launch, all five probes still return data...',
    'THEMIS settled the decades-old debate on what triggers substorms...',
];

export const SOLO_FACTS = [
    'Solar Orbiter launched February 10, 2020 from Cape Canaveral...',
    'A joint ESA and NASA mission to study the Sun up close...',
    'At closest approach, Solar Orbiter passes closer to the Sun than Mercury...',
    'The heat shield is titanium and withstands temperatures over 500°C...',
    'Carries 10 instruments, both telescopes and in-situ particle detectors...',
    'The MAG instrument uses two sensors on a 4.4-meter boom...',
    'Venus gravity assists tilt the orbit for polar views of the Sun...',
    'Will provide the first-ever images of the Sun\'s north and south poles...',
    'Unlike PSP, Solar Orbiter carries cameras that can photograph the Sun...',
    'PSP flies closer but can\'t image the Sun, Solar Orbiter can...',
    'The EUI camera captured the highest-resolution images of the Sun ever...',
    'Discovered miniature solar flares dubbed "campfires" on first close pass...',
    'The heat shield coating, SolarBlack, is made from charred bone powder...',
    'Weeks near the Sun gathering data, months farther away transmitting...',
    'Completed its first Venus gravity assist just 10 months after launch...',
    'The EPD measures ions and electrons accelerated by solar flares and CMEs...',
    'Mission planned to last until at least 2030...',
    'The Solar Wind Analyser identifies individual ions from the Sun...',
    'Orbital inclination will reach over 33 degrees for polar views...',
    'Combined with PSP, scientists can trace solar wind from source to Earth...',
];

export const GOES_FACTS = [
    'GOES orbits at exactly 35,786 km, appearing to hover over one spot...',
    'GOES-16 launched November 19, 2016 and became GOES-East in December 2017...',
    'GOES-18 launched March 2022 and took over as GOES-West in January 2023...',
    'The magnetometer boom extends 8 meters from the spacecraft body...',
    'GOES detects geomagnetic storms that can induce currents in power grids...',
    'At geostationary altitude, GOES travels about 11,000 km/h...',
    'The imager scans the full Western Hemisphere every 10 minutes...',
    'GOES-16 and GOES-18 together cover from west Africa to New Zealand...',
    'GOES was the first to detect lightning continuously from orbit...',
    'GOES magnetometer data helps identify waves that energize electrons...',
    'Geostationary orbit is called a Clarke orbit, after Arthur C. Clarke...',
    'GOES carries solar UV and X-ray sensors to monitor solar flares...',
    'NOAA uses real-time GOES magnetometer readings for storm warnings...',
    'GOES-R series satellites have a designed mission life of 15 years...',
    'GOES-16 sits at 75.2°W over the equator, roughly above the Amazon River...',
    'GOES-18 is stationed at 137.2°W over the eastern Pacific...',
    'During strong storms, the magnetopause can compress past GOES orbit...',
    'GOES relays distress signals for the Search and Rescue SARSAT system...',
    'The GOES-R program has four satellites providing coverage into the 2030s...',
    'GOES measures magnetic field fluctuations in the outer magnetosphere...',
];

// ===== PATIENCE (30s+) =====
export const PATIENCE_MESSAGES = [
    'Still waiting on CDAWeb... thanks for your patience...',
    'This is taking longer than usual, hang tight...',
    'CDAWeb is still working on it...',
    'Still here, still waiting...',
    'The data is worth the wait...',
    'Still cooking... space weather takes time...',
    'CDAWeb is really taking its time with this one...',
    'Your audio is being lovingly crafted by NASA...',
    'If it helps, the data travels at the speed of bureaucracy...',
    'Still going... must be a big dataset...',
    'Almost certainly maybe nearly done...',
    'This wait brought to you by: decades of magnetometer data...',
    'Still pending... good things come to those who wait...',
    'CDAWeb is doing its best, we respect the process...',
    'Somewhere in Greenbelt, MD a server is working hard for you...',
    'NASA servers: fast at rockets, thoughtful with data...',
    'Try adjusting the playback speed while you wait...',
    'We promise we didn\'t forget about you...',
    'The longer the wait, the more data you\'re getting...',
    'Fun fact: you\'ve been waiting longer than a substorm takes to trigger...',
];

// Map spacecraft dropdown values to their fact arrays
const SPACECRAFT_FACTS = {
    PSP: PSP_FACTS,
    Wind: WIND_FACTS,
    MMS: MMS_FACTS,
    THEMIS: THEMIS_FACTS,
    SolO: SOLO_FACTS,
    GOES: GOES_FACTS,
};

const SPACECRAFT_LABELS = {
    PSP: 'Parker Solar Probe',
    Wind: 'WIND',
    MMS: 'MMS',
    THEMIS: 'THEMIS',
    SolO: 'Solar Orbiter',
    GOES: 'GOES',
};

function formatSpacecraftFact(spacecraft, fact) {
    if (!fact) return fact;

    const label = SPACECRAFT_LABELS[spacecraft] || spacecraft;
    const missionAliases = {
        PSP: ['Parker Solar Probe', 'PSP'],
        Wind: ['WIND', 'Wind'],
        MMS: ['MMS'],
        THEMIS: ['THEMIS'],
        SolO: ['Solar Orbiter'],
        GOES: ['GOES'],
    };

    const alreadyNamesMission = (missionAliases[spacecraft] || []).some((alias) => fact.includes(alias));
    return alreadyNamesMission ? fact : `${label}: ${fact}`;
}

// ===== TIMER LOGIC =====

let activeTimer = null;
const shown = new Set(); // track shown messages to avoid repeats within a session

function setLoadingStatus(statusEl, message) {
    let textEl = statusEl.querySelector('.status-message');
    if (!textEl) {
        statusEl.textContent = '';
        textEl = document.createElement('span');
        textEl.className = 'status-message';
        statusEl.appendChild(textEl);
    }
    textEl.textContent = message;
}

function pickRandom(arr) {
    // Try to pick one we haven't shown yet
    const unseen = arr.filter((_, i) => !shown.has(arr[i]));
    const pool = unseen.length > 0 ? unseen : arr;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    shown.add(pick);
    return pick;
}

/**
 * Determine patience chance based on elapsed time.
 * 30-50s: 1/4, 50-70s: 1/3, 70s+: 1/2
 */
function patienceChance(elapsed) {
    if (elapsed < 30000) return 0;
    if (elapsed < 50000) return 0.25;
    if (elapsed < 70000) return 0.33;
    return 0.5;
}

let firstPatienceFired = false;

function showNextMessage(statusEl, spacecraft, startTime) {
    const elapsed = Date.now() - startTime;
    const specific = SPACECRAFT_FACTS[spacecraft] || [];

    let message;

    // Easter egg: 1/50 chance, fire the flame engine for a few seconds
    if (elapsed >= 30000 && Math.random() < 0.02) {
        message = 'Check this out...';
        setLoadingStatus(statusEl, message);
        import('./core/flame-engine.js').then(({ enterOverheatMode, exitOverheatMode }) => {
            enterOverheatMode();
            setTimeout(() => exitOverheatMode(), 4000);
        }).catch(() => {});
        activeTimer = setTimeout(() => showNextMessage(statusEl, spacecraft, startTime), 4000);
        return;
    }

    // At exactly 30s, first patience message is guaranteed
    if (!firstPatienceFired && elapsed >= 30000 && PATIENCE_MESSAGES.length > 0) {
        firstPatienceFired = true;
        message = pickRandom(PATIENCE_MESSAGES);
    } else if (Math.random() < patienceChance(elapsed) && PATIENCE_MESSAGES.length > 0) {
        message = pickRandom(PATIENCE_MESSAGES);
    } else if (specific.length > 0 && Math.random() < 0.5) {
        message = formatSpacecraftFact(spacecraft, pickRandom(specific));
    } else {
        message = pickRandom(GENERAL_FACTS);
    }

    setLoadingStatus(statusEl, message);
    scheduleNext(statusEl, spacecraft, startTime);
}

function scheduleNext(statusEl, spacecraft, startTime) {
    const delay = 7000 + Math.random() * 5000; // 7-12 seconds
    activeTimer = setTimeout(() => showNextMessage(statusEl, spacecraft, startTime), delay);
}

/**
 * Start the loading message rotation.
 * 0-5s: default message, 5-30s: facts, 30s+: patience mixed in.
 * @param {string} spacecraft - Spacecraft dropdown value (e.g. 'PSP', 'Wind'; displayed as 'WIND')
 */
export function startLoadingMessages(spacecraft) {
    stopLoadingMessages();
    firstPatienceFired = false;
    const statusEl = document.getElementById('status');
    if (!statusEl) return;

    setLoadingStatus(statusEl, DEFAULT_MESSAGE);
    statusEl.className = 'status loading';
    const startTime = Date.now();

    // After 5s, begin rotating facts
    activeTimer = setTimeout(() => {
        const specific = SPACECRAFT_FACTS[spacecraft] || [];
        const message = specific.length > 0
            ? formatSpacecraftFact(spacecraft, pickRandom(specific))
            : pickRandom(GENERAL_FACTS);
        setLoadingStatus(statusEl, message);
        scheduleNext(statusEl, spacecraft, startTime);
    }, 5000);
}

/**
 * Stop the loading message rotation.
 */
export function stopLoadingMessages() {
    if (activeTimer) {
        clearTimeout(activeTimer);
        activeTimer = null;
    }
}
