/**
 * Data Viewer Module
 * Fetches and displays participant session data from the Cloudflare Worker API.
 * Only available on localhost (dev mode).
 */

const API_BASE = 'https://spaceweather.now.audio';

let currentUsers = [];
let currentSessions = [];

/**
 * Initialize the data viewer — wire up dropdown listeners
 */
export function initDataViewer() {
    const userSelect = document.getElementById('dvUserSelect');
    const sessionSelect = document.getElementById('dvSessionSelect');

    if (!userSelect || !sessionSelect) return;

    userSelect.addEventListener('change', () => {
        const username = userSelect.value;
        if (username) {
            fetchSessions(username);
        } else {
            sessionSelect.innerHTML = '<option value="">-- select session --</option>';
            clearDataDisplay();
        }
    });

    sessionSelect.addEventListener('change', () => {
        const username = document.getElementById('dvUserSelect').value;
        const sessionId = sessionSelect.value;
        if (username && sessionId) {
            fetchSessionData(username, sessionId);
        } else {
            clearDataDisplay();
        }
    });
}

/**
 * Fetch all registered usernames and populate the user dropdown
 */
export async function fetchUsers() {
    const userSelect = document.getElementById('dvUserSelect');
    if (!userSelect) return;

    userSelect.innerHTML = '<option value="">Loading users...</option>';
    clearDataDisplay();

    try {
        const res = await fetch(`${API_BASE}/api/usernames`);
        const data = await res.json();

        if (!data.success || !data.usernames?.length) {
            userSelect.innerHTML = '<option value="">No users found</option>';
            return;
        }

        currentUsers = data.usernames;
        userSelect.innerHTML = '<option value="">-- select user --</option>';
        for (const u of currentUsers) {
            const opt = document.createElement('option');
            opt.value = u.username;
            const active = u.active_today ? ' (active today)' : '';
            const sessions = u.login_count ? ` [${u.login_count} logins]` : '';
            opt.textContent = `${u.username}${active}${sessions}`;
            userSelect.appendChild(opt);
        }

        setStatusText(`${currentUsers.length} registered users loaded`);
    } catch (err) {
        console.error('Data Viewer: failed to fetch users', err);
        userSelect.innerHTML = '<option value="">Error loading users</option>';
        setStatusText(`Failed to fetch users: ${err.message}`, '#f66');
    }
}

/**
 * Fetch sessions for a given user and populate the session dropdown
 */
async function fetchSessions(username) {
    const sessionSelect = document.getElementById('dvSessionSelect');
    if (!sessionSelect) return;

    sessionSelect.innerHTML = '<option value="">Loading sessions...</option>';

    try {
        const res = await fetch(`${API_BASE}/api/users/${encodeURIComponent(username)}/sessions`);
        const data = await res.json();

        if (!data.success || !data.sessions?.length) {
            sessionSelect.innerHTML = '<option value="">No sessions found</option>';
            setStatusText(`No sessions for ${username}`);
            return;
        }

        currentSessions = data.sessions;
        sessionSelect.innerHTML = '<option value="">-- select session --</option>';
        for (const s of currentSessions) {
            const opt = document.createElement('option');
            opt.value = s.session_id;
            const date = s.updated_at ? new Date(s.updated_at).toLocaleDateString() : '?';
            const regions = s.region_count || 0;
            const sc = s.spacecraft || '';
            opt.textContent = `${date} — ${sc} — ${regions} region${regions !== 1 ? 's' : ''} (${s.session_id})`;
            sessionSelect.appendChild(opt);
        }

        setStatusText(`${currentSessions.length} session(s) for ${username}`);
    } catch (err) {
        console.error('Data Viewer: failed to fetch sessions', err);
        sessionSelect.innerHTML = '<option value="">Error loading sessions</option>';
    }
}

/**
 * Fetch full session data and render the regions/features
 */
async function fetchSessionData(username, sessionId) {
    const display = document.getElementById('dvDataDisplay');
    if (!display) return;

    display.innerHTML = '<p style="color:#aaa; font-style:italic;">Loading session data...</p>';

    try {
        const res = await fetch(
            `${API_BASE}/api/users/${encodeURIComponent(username)}/sessions/${encodeURIComponent(sessionId)}`
        );
        const data = await res.json();

        if (!data.success || !data.session) {
            display.innerHTML = '<p style="color:#f66;">Session data not found</p>';
            return;
        }

        renderSessionData(data.session, display);
    } catch (err) {
        console.error('Data Viewer: failed to fetch session data', err);
        display.innerHTML = `<p style="color:#f66;">Error: ${err.message}</p>`;
    }
}

/**
 * Render session data (regions + features) into the display area
 */
function renderSessionData(session, container) {
    const regions = session.regions || [];

    let html = `
        <div style="margin-bottom: 10px; padding: 8px 12px; background: rgba(60,60,90,0.5); border-radius: 6px; font-size: 13px;">
            <strong>Session:</strong> ${esc(session.session_id)}<br>
            <strong>User:</strong> ${esc(session.username || '?')}<br>
            <strong>Spacecraft:</strong> ${esc(session.spacecraft || '?')} &nbsp;|&nbsp;
            <strong>Dataset:</strong> ${esc(session.data_type || '?')}<br>
            <strong>Time Range:</strong> ${formatTimeRange(session.time_range)}<br>
            <strong>Created:</strong> ${formatDate(session.created_at)} &nbsp;|&nbsp;
            <strong>Updated:</strong> ${formatDate(session.updated_at)}<br>
            <strong>Regions:</strong> ${regions.length}
        </div>
    `;

    if (regions.length === 0) {
        html += '<p style="color:#aaa; font-style:italic;">No regions/markings in this session</p>';
    } else {
        for (const region of regions) {
            const features = region.features || [];
            html += `
                <div style="margin-bottom: 8px; padding: 8px 12px; background: rgba(80,70,50,0.4); border-left: 3px solid #e8a040; border-radius: 4px; font-size: 13px;">
                    <strong>Region ${region.regionNumber || '?'}</strong><br>
                    <span style="color:#ccc;">Start:</span> ${formatDate(region.regionStartTime)}
                    &nbsp;→&nbsp;
                    <span style="color:#ccc;">End:</span> ${formatDate(region.regionEndTime)}
            `;

            if (features.length === 0) {
                html += '<br><em style="color:#888;">No features</em>';
            } else {
                html += `<br><span style="color:#ccc;">${features.length} feature(s):</span>`;
                html += '<div style="margin-top: 4px; margin-left: 12px;">';
                for (const f of features) {
                    const type = f.type || '?';
                    const rep = f.repetition === 'yes' ? 'repeating' : 'unique';
                    const freq = (f.lowFreq != null && f.highFreq != null)
                        ? `${f.lowFreq}–${f.highFreq} Hz`
                        : '?';
                    const speed = f.speedFactor ? `@${f.speedFactor}x` : '';
                    const notes = f.notes ? ` — "${esc(f.notes)}"` : '';
                    const fTime = (f.featureStartTime && f.featureEndTime)
                        ? `${formatDate(f.featureStartTime)} → ${formatDate(f.featureEndTime)}`
                        : '';

                    html += `
                        <div style="margin-bottom: 4px; padding: 4px 8px; background: rgba(100,100,130,0.3); border-radius: 3px;">
                            <strong style="color:${type === 'impulsive' ? '#f8a' : '#8af'};">${esc(type)}</strong>
                            (${rep}) &nbsp;|&nbsp; ${freq} ${speed}
                            ${fTime ? `<br><span style="color:#aaa; font-size: 12px;">${fTime}</span>` : ''}
                            ${notes ? `<br><span style="color:#dda; font-size: 12px;">${notes}</span>` : ''}
                        </div>
                    `;
                }
                html += '</div>';
            }
            html += '</div>';
        }
    }

    // Also show raw JSON in a collapsible section
    html += `
        <details style="margin-top: 10px;">
            <summary style="cursor: pointer; color: #8af; font-size: 13px;">Raw JSON</summary>
            <pre style="max-height: 400px; overflow: auto; padding: 8px; background: rgba(0,0,0,0.4); border-radius: 4px; font-size: 11px; color: #ccc; white-space: pre-wrap; word-break: break-all;">${esc(JSON.stringify(session, null, 2))}</pre>
        </details>
    `;

    container.innerHTML = html;
}

function clearDataDisplay() {
    const display = document.getElementById('dvDataDisplay');
    if (display) display.innerHTML = '';
    setStatusText('');
}

function setStatusText(text, color = '#aaa') {
    const el = document.getElementById('dvStatusText');
    if (el) {
        el.textContent = text;
        el.style.color = color;
    }
}

function formatDate(iso) {
    if (!iso) return '?';
    try {
        const d = new Date(iso);
        return d.toLocaleString();
    } catch {
        return iso;
    }
}

function formatTimeRange(tr) {
    if (!tr) return '?';
    const start = tr.start ? new Date(tr.start).toLocaleDateString() : '?';
    const end = tr.end ? new Date(tr.end).toLocaleDateString() : '?';
    return `${start} → ${end}`;
}

function esc(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
