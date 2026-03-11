/**
 * Space Weather Audification Portal - Cloudflare Worker API
 * Handles user sessions and sharing via R2 storage
 *
 * R2 Structure:
 *   users/{username}/sessions/{session_id}.json
 *   shares/{share_id}.json
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Helper: JSON response
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// Helper: Sanitize username for R2 paths
// NOTE: Strips characters outside [a-zA-Z0-9_-] and truncates to 64 chars.
// This means participant IDs with dots, spaces, etc. will be silently modified.
// Acceptable for current use — all IDs are alphanumeric + underscore.
function sanitizeUsername(username) {
  return username.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

// Helper: Generate session ID
function generateSessionId() {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:]/g, '').split('.')[0];
  const random = Math.random().toString(36).slice(2, 10);
  return `${timestamp}_${random}`;
}

// Helper: Generate share ID
function generateShareId() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.random().toString(36).slice(2, 10);
  return `${date}_${random}`;
}

// R2 key helpers
const getSessionKey = (username, sessionId) =>
  `users/${sanitizeUsername(username)}/sessions/${sessionId}.json`;

const getShareKey = (shareId) =>
  `shares/${shareId}.json`;

const getUsernameKey = (username) =>
  `usernames/${sanitizeUsername(username).toLowerCase()}.json`;

const getThumbnailKey = (shareId) =>
  `thumbnails/${shareId}.jpg`;

// Helper: Generate Open Graph HTML for share links
function generateOgHtml(shareMeta, frontendUrl, shareId, hasThumbnail = false) {
  const title = shareMeta.title || 'Space Weather Analysis';
  const description = shareMeta.description || buildDefaultDescription(shareMeta);
  const shareUrl = `${frontendUrl}/?share=${shareId}`;
  const thumbnailUrl = hasThumbnail
    ? `${frontendUrl}/api/share/${shareId}/thumbnail.jpg`
    : `${frontendUrl}/images/og-default.jpg`;  // Fallback image

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)} - Space Weather Audio</title>
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${shareUrl}">
  <meta property="og:site_name" content="Space Weather Audio">
  <meta property="og:image" content="${thumbnailUrl}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="429">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${thumbnailUrl}">
  <meta http-equiv="refresh" content="0;url=${shareUrl}">
</head>
<body>
  <p>Redirecting to <a href="${shareUrl}">${escapeHtml(title)}</a>...</p>
</body>
</html>`;
}

// Helper: Build default description from share metadata
function buildDefaultDescription(shareMeta) {
  const spacecraft = shareMeta.spacecraft || 'Unknown';
  const regionCount = shareMeta.region_count || 0;
  const timeRange = shareMeta.time_range;

  let description = `${spacecraft} space weather data`;
  if (timeRange?.start && timeRange?.end) {
    const start = timeRange.start.slice(0, 10);
    const end = timeRange.end.slice(0, 10);
    description += ` from ${start} to ${end}`;
  }
  if (regionCount > 0) {
    description += ` with ${regionCount} identified region${regionCount > 1 ? 's' : ''}`;
  }
  return description;
}

// Helper: Escape HTML entities for safe embedding
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// =============================================================================
// Route Handler
// =============================================================================

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const frontendUrl = env.FRONTEND_URL || 'https://spaceweather.now.audio';

    try {
      // =======================================================================
      // Thumbnail Route: /api/share/:shareId/thumbnail.jpg
      // Serves the captured spectrogram image for OG previews
      // =======================================================================
      const thumbnailMatch = path.match(/^\/api\/share\/([^/]+)\/thumbnail\.jpg$/);
      if (thumbnailMatch && request.method === 'GET') {
        const thumbShareId = thumbnailMatch[1];
        const thumbnailObj = await env.BUCKET.get(getThumbnailKey(thumbShareId));

        if (thumbnailObj) {
          return new Response(thumbnailObj.body, {
            headers: {
              'Content-Type': 'image/jpeg',
              'Cache-Control': 'public, max-age=604800',  // Cache for 7 days (images don't change)
              ...CORS_HEADERS,
            },
          });
        }
        // Return 404 if no thumbnail
        return new Response('Thumbnail not found', { status: 404 });
      }

      // =======================================================================
      // Open Graph Preview for Share Links
      // Only serve OG HTML to social media crawlers, not regular browsers
      // =======================================================================
      const shareId = url.searchParams.get('share');
      if (shareId && (path === '/' || path === '')) {
        const userAgent = request.headers.get('User-Agent') || '';
        const isCrawler = /facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|TelegramBot|WhatsApp|Discordbot|Pinterest|Googlebot/i.test(userAgent);

        // Only serve OG HTML to crawlers, let browsers through to frontend
        if (isCrawler) {
          const shareObj = await env.BUCKET.get(getShareKey(shareId));
          if (shareObj) {
            const shareMeta = await shareObj.json();
            const hasThumbnail = shareMeta.has_thumbnail || false;
            const html = generateOgHtml(shareMeta, frontendUrl, shareId, hasThumbnail);
            return new Response(html, {
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
            });
          }
        }
        // For regular browsers or if share not found, let request pass through
        // (will be handled by GitHub Pages frontend)
      }

      // Health check
      if (path === '/health') {
        return json({ status: 'healthy', service: 'space-weather-audio-api' });
      }

      // Status
      if (path === '/status') {
        return json({
          status: 'operational',
          service: 'space-weather-audio-api',
          r2_bucket: 'space-weather-audio',
          timestamp: new Date().toISOString(),
        });
      }

      // =======================================================================
      // Session Routes: /api/users/:username/sessions
      // =======================================================================

      const sessionMatch = path.match(/^\/api\/users\/([^/]+)\/sessions\/?([^/]*)?$/);
      if (sessionMatch) {
        const username = decodeURIComponent(sessionMatch[1]);
        const sessionId = sessionMatch[2] || null;

        // POST /api/users/:username/sessions - Save session
        if (request.method === 'POST' && !sessionId) {
          return await saveSession(request, env, username);
        }

        // GET /api/users/:username/sessions - List sessions
        if (request.method === 'GET' && !sessionId) {
          return await listSessions(env, username);
        }

        // GET /api/users/:username/sessions/:sessionId - Get session
        if (request.method === 'GET' && sessionId) {
          return await getSession(env, username, sessionId);
        }

        // DELETE /api/users/:username/sessions/:sessionId - Delete session
        if (request.method === 'DELETE' && sessionId) {
          return await deleteSession(env, username, sessionId);
        }
      }

      // =======================================================================
      // Share Routes: /api/share
      // =======================================================================

      // POST /api/share - Create share
      if (path === '/api/share' && request.method === 'POST') {
        return await createShare(request, env);
      }

      // GET /api/share/:shareId/available - Check if share ID is available
      const availableMatch = path.match(/^\/api\/share\/([^/]+)\/available$/);
      if (availableMatch && request.method === 'GET') {
        return await checkShareAvailable(env, availableMatch[1]);
      }

      // GET /api/share/:shareId - Get share
      const shareMatch = path.match(/^\/api\/share\/([^/]+)$/);
      if (shareMatch && request.method === 'GET') {
        return await getShare(env, shareMatch[1]);
      }

      // POST /api/share/:shareId/clone - Clone share to user
      const cloneMatch = path.match(/^\/api\/share\/([^/]+)\/clone$/);
      if (cloneMatch && request.method === 'POST') {
        return await cloneShare(request, env, cloneMatch[1]);
      }

      // =======================================================================
      // Username Routes: /api/username
      // =======================================================================

      // GET /api/usernames - List all registered usernames
      if (path === '/api/usernames' && request.method === 'GET') {
        return await listUsernames(env);
      }

      // GET /api/username/:username/available - Check if username is available
      const usernameAvailableMatch = path.match(/^\/api\/username\/([^/]+)\/available$/);
      if (usernameAvailableMatch && request.method === 'GET') {
        return await checkUsernameAvailable(env, decodeURIComponent(usernameAvailableMatch[1]));
      }

      // POST /api/username/:username/register - Register a username
      const usernameRegisterMatch = path.match(/^\/api\/username\/([^/]+)\/register$/);
      if (usernameRegisterMatch && request.method === 'POST') {
        return await registerUsername(request, env, decodeURIComponent(usernameRegisterMatch[1]));
      }

      // POST /api/username/:username/heartbeat - Update last active timestamp
      const heartbeatMatch = path.match(/^\/api\/username\/([^/]+)\/heartbeat$/);
      if (heartbeatMatch && request.method === 'POST') {
        return await updateHeartbeat(env, decodeURIComponent(heartbeatMatch[1]));
      }

      // DELETE /api/username/:username - Delete a username from the pool
      const usernameDeleteMatch = path.match(/^\/api\/username\/([^/]+)$/);
      if (usernameDeleteMatch && request.method === 'DELETE') {
        return await deleteUsername(env, decodeURIComponent(usernameDeleteMatch[1]));
      }

      // =======================================================================
      // EMIC Study Participant Routes: /api/emic/participants/*
      // Stores participant submissions and master list in main R2 bucket
      // R2 Structure:
      //   emic/participants/{participantId}/submission_{timestamp}.json
      //   emic/participants/_master.json
      // =======================================================================

      // POST /api/emic/participants/:id/submit — Save a participant submission
      const emicSubmitMatch = path.match(/^\/api\/emic\/participants\/([^/]+)\/submit$/);
      if (emicSubmitMatch && request.method === 'POST') {
        return await emicSubmitParticipant(request, env, decodeURIComponent(emicSubmitMatch[1]));
      }

      // GET /api/emic/participants — List all participants (master list)
      if (path === '/api/emic/participants' && request.method === 'GET') {
        return await emicListParticipants(env);
      }

      // GET /api/emic/participants/_master.json — Direct master file download
      // (Must be before the :id catch-all)
      if (path === '/api/emic/participants/_master.json' && request.method === 'GET') {
        const obj = await env.EMIC_DATA.get('emic/participants/_master.json');
        if (!obj) return json({ participants: [], count: 0 });
        return new Response(obj.body, {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }

      // GET /api/emic/participants/:id — Get all submissions for a participant
      const emicGetMatch = path.match(/^\/api\/emic\/participants\/([^/]+)$/);
      if (emicGetMatch && request.method === 'GET') {
        return await emicGetParticipant(env, decodeURIComponent(emicGetMatch[1]));
      }

      // =======================================================================
      // Audio Cache Routes: /api/audio-cache/*
      // Stores and serves pre-cached WAV files for default datasets
      // R2 Structure: audio-cache/{spacecraft}/{dataset}/{startISO}/{endISO}/{component}.wav
      // =======================================================================

      // GET /api/audio-cache/:spacecraft/:dataset/:start/:end — List cached components
      // GET /api/audio-cache/:spacecraft/:dataset/:start/:end/:component.wav — Serve WAV
      // PUT /api/audio-cache/:spacecraft/:dataset/:start/:end/:component.wav — Upload WAV
      const audioCacheMatch = path.match(/^\/api\/audio-cache\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/?(.*)$/);
      if (audioCacheMatch) {
        const [, acSpacecraft, acDataset, acStart, acEnd, acRest] = audioCacheMatch;
        const r2Prefix = `audio-cache/${acSpacecraft}/${acDataset}/${acStart}/${acEnd}`;

        if (!acRest && request.method === 'GET') {
          // List available components for this time range
          const listed = await env.BUCKET.list({ prefix: r2Prefix + '/' });
          const components = listed.objects.map(obj => {
            const filename = obj.key.split('/').pop();
            return { name: filename, size: obj.size };
          });
          return json({ spacecraft: acSpacecraft, dataset: acDataset, start: acStart, end: acEnd, components });
        }

        if (acRest && acRest.endsWith('.wav')) {
          const r2Key = `${r2Prefix}/${acRest}`;

          if (request.method === 'GET') {
            const obj = await env.BUCKET.get(r2Key);
            if (!obj) return json({ error: 'Not found', key: r2Key }, 404);
            return new Response(obj.body, {
              headers: {
                'Content-Type': 'audio/wav',
                'Cache-Control': 'public, max-age=31536000', // 1 year — data never changes
                ...CORS_HEADERS,
              },
            });
          }

          if (request.method === 'PUT') {
            const wavData = await request.arrayBuffer();
            await env.BUCKET.put(r2Key, wavData, {
              httpMetadata: { contentType: 'audio/wav' },
            });
            console.log(`Cached WAV: ${r2Key} (${wavData.byteLength} bytes)`);
            return json({ ok: true, key: r2Key, size: wavData.byteLength });
          }
        }
      }

      // =======================================================================
      // EMIC Data Routes: /emic/data/*
      // Serves GOES magnetometer chunks from emic-data R2 bucket
      // =======================================================================
      if (path.startsWith('/emic/data/')) {
        const r2Key = path.slice('/emic/'.length); // Strip /emic/ prefix → data/2022/...
        const obj = await env.EMIC_DATA.get(r2Key);

        if (!obj) {
          return json({ error: 'Not found', key: r2Key }, 404);
        }

        // Determine content type from extension
        let contentType = 'application/octet-stream';
        if (r2Key.endsWith('.json')) contentType = 'application/json';
        else if (r2Key.endsWith('.zst')) contentType = 'application/zstd';

        return new Response(obj.body, {
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400', // 24h cache — data doesn't change
            ...CORS_HEADERS,
          },
        });
      }

      // =======================================================================
      // D1 Study Routes: /api/study/:studyId/*
      // =======================================================================
      const studyConfigMatch = path.match(/^\/api\/study\/([^/]+)\/config$/);
      if (studyConfigMatch) {
        const studyId = studyConfigMatch[1];

        if (request.method === 'GET') {
          const row = await env.DB.prepare('SELECT * FROM studies WHERE id = ?').bind(studyId).first();
          if (!row) return json({ error: 'Study not found' }, 404);
          const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
          return json({ success: true, study: { id: row.id, name: row.name, config } });
        }

        if (request.method === 'PUT') {
          const body = await request.json();
          const configStr = typeof body.config === 'string' ? body.config : JSON.stringify(body.config);
          const name = body.name || studyId;
          await env.DB.prepare(
            `INSERT INTO studies (id, name, config, updated_at) VALUES (?, ?, ?, datetime('now'))
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, config = excluded.config, updated_at = datetime('now')`
          ).bind(studyId, name, configStr).run();
          return json({ success: true });
        }

        return json({ error: 'Method not allowed' }, 405);
      }

      // Helper: detect mode from participant ID prefix (for logging only)
      function detectMode(pid) {
        if (pid.startsWith('Preview_')) return 'preview';
        if (pid.startsWith('TEST_'))    return 'test';
        return 'live';
      }

      // POST /api/study/:studyId/participants — UPSERT participant
      const studyParticipantsMatch = path.match(/^\/api\/study\/([^/]+)\/participants$/);
      if (studyParticipantsMatch && request.method === 'POST') {
        const studyId = studyParticipantsMatch[1];
        const body = await request.json();
        const pid = body.id;
        if (!pid) return json({ error: 'Missing participant id' }, 400);
        const mode = detectMode(pid);
        await env.DB.prepare(
          `INSERT INTO participants (participant_id, study_id) VALUES (?, ?)
           ON CONFLICT(participant_id, study_id) DO UPDATE SET registered_at = registered_at`
        ).bind(pid, studyId).run();
        return json({ success: true, participant_id: pid, mode });
      }

      // GET /api/study/:studyId/participants/:pid/progress — fetch progress
      const progressMatch = path.match(/^\/api\/study\/([^/]+)\/participants\/([^/]+)\/progress$/);
      if (progressMatch && request.method === 'GET') {
        const [, studyId, pid] = progressMatch;
        const row = await env.DB.prepare(
          'SELECT current_step, responses, flags, completed_at FROM participants WHERE participant_id = ? AND study_id = ?'
        ).bind(decodeURIComponent(pid), studyId).first();
        if (!row) return json({ error: 'Participant not found' }, 404);
        return json({
          success: true,
          current_step: row.current_step,
          responses: typeof row.responses === 'string' ? JSON.parse(row.responses) : row.responses,
          flags: typeof row.flags === 'string' ? JSON.parse(row.flags) : row.flags,
          completed_at: row.completed_at,
        });
      }

      // PUT /api/study/:studyId/participants/:pid/step — update current step
      const stepMatch = path.match(/^\/api\/study\/([^/]+)\/participants\/([^/]+)\/step$/);
      if (stepMatch && request.method === 'PUT') {
        const [, studyId, pid] = stepMatch;
        const body = await request.json();
        const step = body.step;
        if (step == null) return json({ error: 'Missing step' }, 400);
        await env.DB.prepare(
          'UPDATE participants SET current_step = ? WHERE participant_id = ? AND study_id = ?'
        ).bind(step, decodeURIComponent(pid), studyId).run();
        return json({ success: true, current_step: step });
      }

      // POST /api/study/:studyId/responses — save feature or survey response
      const studyResponsesMatch = path.match(/^\/api\/study\/([^/]+)\/responses$/);
      if (studyResponsesMatch && request.method === 'POST') {
        const studyId = studyResponsesMatch[1];
        const body = await request.json();
        const pid = body.participant_id;
        if (!pid) return json({ error: 'Missing participant_id' }, 400);
        const mode = detectMode(pid);
        const type = body.type || 'unknown';

        if (type === 'feature') {
          // Insert into features table
          const id = body.id || (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36));
          const d = body.data || {};
          await env.DB.prepare(
            `INSERT INTO features (id, participant_id, study_id, start_time, end_time, low_freq, high_freq, confidence, notes, speed_factor)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(id, pid, studyId, d.startTime || null, d.endTime || null, d.lowFreq || null, d.highFreq || null, d.confidence || 'confirmed', d.notes || '', d.speedFactor || null).run();
          return json({ success: true, feature_id: id, mode });
        }

        if (type === 'milestone' && body.data?.event === 'completed') {
          // Mark participant as complete
          await env.DB.prepare(
            `UPDATE participants SET completed_at = datetime('now') WHERE participant_id = ? AND study_id = ?`
          ).bind(pid, studyId).run();
          return json({ success: true, mode });
        }

        // Survey answers and other responses → store in participants.responses JSON
        const dataStr = typeof body.data === 'string' ? body.data : JSON.stringify(body.data || {});
        const responseKey = `$.${type}`;
        await env.DB.prepare(
          `UPDATE participants SET responses = json_set(responses, ?, json(?)) WHERE participant_id = ? AND study_id = ?`
        ).bind(responseKey, dataStr, pid, studyId).run();
        return json({ success: true, mode });
      }

      // GET /api/study/:studyId/participants/:pid/features — fetch all features
      const featuresMatch = path.match(/^\/api\/study\/([^/]+)\/participants\/([^/]+)\/features$/);
      if (featuresMatch && request.method === 'GET') {
        const [, studyId, pid] = featuresMatch;
        const { results } = await env.DB.prepare(
          'SELECT * FROM features WHERE participant_id = ? AND study_id = ? ORDER BY created_at'
        ).bind(decodeURIComponent(pid), studyId).all();
        return json({ success: true, features: results });
      }

      // =======================================================================
      // Proxy everything else to GitHub Pages
      // =======================================================================
      const githubPagesUrl = 'https://sonified.github.io/space-weather-audio';

      // Build the proxied URL
      let proxyPath = path;
      if (proxyPath === '/' || proxyPath === '') {
        proxyPath = '/index.html';
      }

      const proxyUrl = `${githubPagesUrl}${proxyPath}${url.search}`;

      try {
        const proxyResponse = await fetch(proxyUrl, {
          method: request.method,
          headers: request.headers,
        });

        // Return the GitHub Pages response with CORS headers
        const response = new Response(proxyResponse.body, {
          status: proxyResponse.status,
          headers: proxyResponse.headers,
        });

        return response;
      } catch (proxyError) {
        console.error('Proxy error:', proxyError);
        return json({ error: 'Failed to load page' }, 502);
      }

    } catch (error) {
      console.error('Worker error:', error);
      return json({ error: error.message }, 500);
    }
  },
};

// =============================================================================
// Session Handlers
// =============================================================================

async function saveSession(request, env, username) {
  const data = await request.json();

  const sessionId = data.session_id || generateSessionId();
  const now = new Date().toISOString();

  const session = {
    session_id: sessionId,
    username: sanitizeUsername(username),
    created_at: data.created_at || now,
    updated_at: now,
    spacecraft: data.spacecraft,
    data_type: data.data_type,
    time_range: data.time_range,
    regions: data.regions || [],
    view_settings: data.view_settings || {},
    version: data.version || 1,
  };

  await env.BUCKET.put(
    getSessionKey(username, sessionId),
    JSON.stringify(session),
    { httpMetadata: { contentType: 'application/json' } }
  );

  return json({
    success: true,
    session_id: sessionId,
    username: sanitizeUsername(username),
    updated_at: now,
  }, 201);
}

async function listSessions(env, username) {
  const prefix = `users/${sanitizeUsername(username)}/sessions/`;
  const listed = await env.BUCKET.list({ prefix });

  const sessions = [];
  for (const obj of listed.objects) {
    try {
      const data = await env.BUCKET.get(obj.key);
      if (data) {
        const session = await data.json();
        sessions.push({
          session_id: session.session_id,
          spacecraft: session.spacecraft,
          data_type: session.data_type,
          time_range: session.time_range,
          region_count: (session.regions || []).length,
          created_at: session.created_at,
          updated_at: session.updated_at,
        });
      }
    } catch (e) {
      // Skip malformed sessions
      sessions.push({
        session_id: obj.key.replace(prefix, '').replace('.json', ''),
        last_modified: obj.uploaded,
      });
    }
  }

  // Sort by updated_at descending
  sessions.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));

  return json({
    success: true,
    username: sanitizeUsername(username),
    sessions,
    count: sessions.length,
  });
}

async function getSession(env, username, sessionId) {
  const obj = await env.BUCKET.get(getSessionKey(username, sessionId));

  if (!obj) {
    return json({ success: false, error: 'Session not found' }, 404);
  }

  const session = await obj.json();
  return json({ success: true, session });
}

async function deleteSession(env, username, sessionId) {
  await env.BUCKET.delete(getSessionKey(username, sessionId));
  return json({ success: true, message: `Session ${sessionId} deleted` });
}

// =============================================================================
// Username Handlers
// =============================================================================

async function listUsernames(env) {
  const prefix = 'usernames/';
  const listed = await env.BUCKET.list({ prefix });

  // Count shares per user
  const sharePrefix = 'shares/';
  const shareListed = await env.BUCKET.list({ prefix: sharePrefix });
  const shareCountByUser = {};

  for (const obj of shareListed.objects) {
    try {
      const data = await env.BUCKET.get(obj.key);
      if (data) {
        const shareData = await data.json();
        const sourceUser = shareData.source_username;
        if (sourceUser) {
          shareCountByUser[sourceUser.toLowerCase()] = (shareCountByUser[sourceUser.toLowerCase()] || 0) + 1;
        }
      }
    } catch (e) {
      // Skip malformed shares
    }
  }

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const hourAgo = new Date(now - 60 * 60 * 1000);

  const usernames = [];
  for (const obj of listed.objects) {
    try {
      const data = await env.BUCKET.get(obj.key);
      if (data) {
        const userData = await data.json();
        const username = userData.username;
        const lastActive = new Date(userData.last_active_at);
        usernames.push({
          username: username,
          registered_at: userData.registered_at,
          last_active_at: userData.last_active_at,
          active_today: lastActive >= todayStart,
          active_last_hour: lastActive >= hourAgo,
          share_count: shareCountByUser[username.toLowerCase()] || 0,
          login_count: userData.login_count || 1,
          login_history: userData.login_history || [userData.registered_at],
        });
      }
    } catch (e) {
      // Extract username from key if JSON parse fails
      const username = obj.key.replace(prefix, '').replace('.json', '');
      usernames.push({ username, last_modified: obj.uploaded, share_count: 0, active_today: false, active_last_hour: false });
    }
  }

  // Sort by last_active_at descending
  usernames.sort((a, b) => (b.last_active_at || '').localeCompare(a.last_active_at || ''));

  return json({
    success: true,
    usernames,
    count: usernames.length,
  });
}

// Helper: Validate username
function validateUsername(username) {
  if (!username || typeof username !== 'string') {
    return { valid: false, error: 'Username is required' };
  }

  const cleaned = username.trim();

  if (cleaned.length < 3) {
    return { valid: false, error: 'Username must be at least 3 characters' };
  }
  if (cleaned.length > 30) {
    return { valid: false, error: 'Username must be 30 characters or less' };
  }

  // Allow letters, numbers, underscores, hyphens
  if (!/^[a-zA-Z0-9_-]+$/.test(cleaned)) {
    return { valid: false, error: 'Username can only contain letters, numbers, underscores, and hyphens' };
  }

  return { valid: true, username: cleaned };
}

async function checkUsernameAvailable(env, username) {
  const validation = validateUsername(username);
  if (!validation.valid) {
    return json({ available: false, error: validation.error }, 400);
  }

  const existing = await env.BUCKET.head(getUsernameKey(validation.username));

  // Always allow login (duplicates OK)
  if (existing) {
    return json({
      available: true,
      username: validation.username,
      exists: true,
      message: 'Welcome back!'
    });
  }

  return json({
    available: true,
    username: validation.username,
    exists: false
  });
}

async function registerUsername(request, env, username) {
  const validation = validateUsername(username);
  if (!validation.valid) {
    return json({ success: false, error: validation.error }, 400);
  }

  const cleanUsername = validation.username;
  const key = getUsernameKey(cleanUsername);

  // Check if already taken (TEMPORARILY DISABLED - allows duplicate logins)
  const existing = await env.BUCKET.get(key);
  const now = new Date().toISOString();

  if (existing) {
    // Username exists - update last_active_at and append to login history
    const existingData = await existing.json();
    const loginHistory = existingData.login_history || [existingData.registered_at];

    // Add current login to history (keep last 100 to prevent infinite growth)
    loginHistory.push(now);
    if (loginHistory.length > 100) {
      loginHistory.shift(); // Remove oldest if over 100
    }

    const userData = {
      username: cleanUsername,
      registered_at: existingData.registered_at || now, // Preserve original registration date
      last_active_at: now,
      login_history: loginHistory,
      login_count: loginHistory.length
    };

    await env.BUCKET.put(key, JSON.stringify(userData), {
      httpMetadata: { contentType: 'application/json' }
    });

    return json({
      success: true,
      username: cleanUsername,
      registered_at: existingData.registered_at,
      login_count: loginHistory.length,
      message: 'Username already registered, activity updated'
    }, 200);
  }

  // Register the username (first time)
  const userData = {
    username: cleanUsername,
    registered_at: now,
    last_active_at: now,
    login_history: [now],
    login_count: 1
  };

  await env.BUCKET.put(key, JSON.stringify(userData), {
    httpMetadata: { contentType: 'application/json' }
  });

  return json({
    success: true,
    username: cleanUsername,
    registered_at: now
  }, 201);
}

async function deleteUsername(env, username) {
  const validation = validateUsername(username);
  if (!validation.valid) {
    return json({ success: false, error: validation.error }, 400);
  }

  const key = getUsernameKey(validation.username);

  // Check if username exists
  const existing = await env.BUCKET.head(key);
  if (!existing) {
    return json({ success: false, error: 'Username not found' }, 404);
  }

  // Delete the username
  await env.BUCKET.delete(key);

  return json({
    success: true,
    username: validation.username,
    message: 'Username deleted successfully'
  });
}

async function updateHeartbeat(env, username) {
  const validation = validateUsername(username);
  if (!validation.valid) {
    return json({ success: false, error: validation.error }, 400);
  }

  const key = getUsernameKey(validation.username);
  const now = new Date().toISOString();

  try {
    const existing = await env.BUCKET.get(key);
    if (!existing) {
      return json({ success: false, error: 'Username not found' }, 404);
    }

    const userData = await existing.json();
    userData.last_active_at = now;

    await env.BUCKET.put(key, JSON.stringify(userData), {
      httpMetadata: { contentType: 'application/json' }
    });

    return json({ success: true, last_active_at: now });
  } catch (e) {
    return json({ success: false, error: 'Failed to update heartbeat' }, 500);
  }
}

// =============================================================================
// Share Handlers
// =============================================================================

// Helper: Validate and sanitize share slug
function validateShareSlug(slug) {
  if (!slug || typeof slug !== 'string') {
    return { valid: false, error: 'Share ID is required' };
  }

  // Lowercase and trim
  const cleaned = slug.toLowerCase().trim();

  // Check length
  if (cleaned.length < 3) {
    return { valid: false, error: 'Share ID must be at least 3 characters' };
  }
  if (cleaned.length > 500) {
    return { valid: false, error: 'Share ID must be 500 characters or less' };
  }

  // Only allow lowercase letters, numbers, and hyphens
  if (!/^[a-z0-9-]+$/.test(cleaned)) {
    return { valid: false, error: 'Share ID can only contain letters, numbers, and hyphens' };
  }

  // No leading/trailing hyphens
  if (cleaned.startsWith('-') || cleaned.endsWith('-')) {
    return { valid: false, error: 'Share ID cannot start or end with a hyphen' };
  }

  // No consecutive hyphens
  if (cleaned.includes('--')) {
    return { valid: false, error: 'Share ID cannot contain consecutive hyphens' };
  }

  return { valid: true, slug: cleaned };
}

async function checkShareAvailable(env, shareId) {
  const validation = validateShareSlug(shareId);
  if (!validation.valid) {
    return json({ available: false, error: validation.error }, 400);
  }

  const existing = await env.BUCKET.head(getShareKey(validation.slug));
  return json({
    available: !existing,
    share_id: validation.slug
  });
}

async function createShare(request, env) {
  const data = await request.json();
  const { username, session_id, share_id: customShareId, thumbnail } = data;

  if (!username || !session_id) {
    return json({ success: false, error: 'username and session_id required' }, 400);
  }

  // Validate custom share ID
  if (!customShareId) {
    return json({ success: false, error: 'share_id is required' }, 400);
  }

  const validation = validateShareSlug(customShareId);
  if (!validation.valid) {
    return json({ success: false, error: validation.error }, 400);
  }

  const shareId = validation.slug;

  // Check if share ID is already taken
  const existing = await env.BUCKET.head(getShareKey(shareId));
  if (existing) {
    return json({ success: false, error: 'This share ID is already taken' }, 409);
  }

  // Verify source session exists
  const sourceObj = await env.BUCKET.get(getSessionKey(username, session_id));
  if (!sourceObj) {
    return json({ success: false, error: 'Source session not found' }, 404);
  }

  const sourceSession = await sourceObj.json();
  const now = new Date();

  // Save thumbnail if provided (supports both JPEG and PNG)
  let hasThumbnail = false;
  if (thumbnail && thumbnail.startsWith('data:image/')) {
    try {
      // Extract base64 data and content type
      const matches = thumbnail.match(/^data:image\/(jpeg|png);base64,(.+)$/);
      if (matches) {
        const imageType = matches[1];
        const base64Data = matches[2];
        const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
        const contentType = `image/${imageType}`;

        await env.BUCKET.put(
          getThumbnailKey(shareId),
          binaryData,
          { httpMetadata: { contentType } }
        );
        hasThumbnail = true;
        const sizeKB = Math.round(binaryData.length / 1024);
        console.log(`Thumbnail saved for share ${shareId}: ${sizeKB}KB ${imageType.toUpperCase()}`);
      }
    } catch (thumbError) {
      console.error('Failed to save thumbnail:', thumbError);
      // Continue without thumbnail - not a fatal error
    }
  }

  const shareMeta = {
    share_id: shareId,
    source_username: sanitizeUsername(username),
    source_session_id: session_id,
    title: data.title || sourceSession.spacecraft || 'Shared Analysis',
    description: data.description || '',
    spacecraft: sourceSession.spacecraft,
    data_type: sourceSession.data_type,
    time_range: sourceSession.time_range,
    region_count: (sourceSession.regions || []).length,
    created_at: now.toISOString(),
    view_count: 0,
    has_thumbnail: hasThumbnail,
  };

  await env.BUCKET.put(
    getShareKey(shareId),
    JSON.stringify(shareMeta),
    { httpMetadata: { contentType: 'application/json' } }
  );

  const shareUrl = `${env.FRONTEND_URL || 'https://spaceweather.now.audio'}/?share=${shareId}`;

  return json({
    success: true,
    share_id: shareId,
    share_url: shareUrl,
    has_thumbnail: hasThumbnail,
  }, 201);
}

async function getShare(env, shareId) {
  // Get share metadata
  const shareObj = await env.BUCKET.get(getShareKey(shareId));
  if (!shareObj) {
    return json({ success: false, error: 'Share not found' }, 404);
  }

  const shareMeta = await shareObj.json();

  // Get source session
  const sessionObj = await env.BUCKET.get(
    getSessionKey(shareMeta.source_username, shareMeta.source_session_id)
  );

  if (!sessionObj) {
    return json({ success: false, error: 'Source session no longer exists' }, 404);
  }

  const sessionData = await sessionObj.json();

  // Update view count (fire and forget)
  shareMeta.view_count = (shareMeta.view_count || 0) + 1;
  shareMeta.last_viewed_at = new Date().toISOString();

  // Don't await - fire and forget
  env.BUCKET.put(
    getShareKey(shareId),
    JSON.stringify(shareMeta),
    { httpMetadata: { contentType: 'application/json' } }
  );

  return json({
    success: true,
    share_id: shareId,
    metadata: shareMeta,
    session: sessionData,
  });
}

async function cloneShare(request, env, shareId) {
  const data = await request.json();
  const newUsername = data?.username;

  if (!newUsername) {
    return json({ success: false, error: 'username required' }, 400);
  }

  // Get share metadata
  const shareObj = await env.BUCKET.get(getShareKey(shareId));
  if (!shareObj) {
    return json({ success: false, error: 'Share not found' }, 404);
  }

  const shareMeta = await shareObj.json();

  // Check expiry
  if (new Date() > new Date(shareMeta.expires_at)) {
    return json({ success: false, error: 'Share has expired' }, 410);
  }

  // Get source session
  const sessionObj = await env.BUCKET.get(
    getSessionKey(shareMeta.source_username, shareMeta.source_session_id)
  );

  if (!sessionObj) {
    return json({ success: false, error: 'Source session no longer exists' }, 404);
  }

  const sessionData = await sessionObj.json();
  const newSessionId = generateSessionId();
  const now = new Date().toISOString();

  const newSession = {
    ...sessionData,
    session_id: newSessionId,
    username: sanitizeUsername(newUsername),
    created_at: now,
    updated_at: now,
    cloned_from: {
      share_id: shareId,
      source_username: shareMeta.source_username,
      source_session_id: shareMeta.source_session_id,
    },
  };

  await env.BUCKET.put(
    getSessionKey(newUsername, newSessionId),
    JSON.stringify(newSession),
    { httpMetadata: { contentType: 'application/json' } }
  );

  return json({
    success: true,
    session_id: newSessionId,
    username: sanitizeUsername(newUsername),
    message: 'Session cloned successfully',
  }, 201);
}

// =============================================================================
// EMIC Study Participant Handlers
// =============================================================================

const EMIC_PARTICIPANTS_PREFIX = 'emic/participants/';
const EMIC_MASTER_KEY = 'emic/participants/_master.json';

/**
 * Submit participant data for the EMIC study.
 * Saves individual submission + updates master participant list.
 */
async function emicSubmitParticipant(request, env, participantId) {
  if (!participantId || participantId === '_master') {
    return json({ success: false, error: 'Invalid participant ID' }, 400);
  }

  const data = await request.json();
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:]/g, '').split('.')[0];

  // Validate required fields
  if (!data.submittedAt) {
    data.submittedAt = now.toISOString();
  }

  const submission = {
    ...data,
    participantId: sanitizeUsername(participantId),
    serverReceivedAt: now.toISOString(),
  };

  // Save individual submission (append-only: each submit creates a new file)
  const submissionKey = `${EMIC_PARTICIPANTS_PREFIX}${sanitizeUsername(participantId)}/submission_${timestamp}.json`;
  await env.EMIC_DATA.put(submissionKey, JSON.stringify(submission, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });

  // Update master JSON — contains FULL submission data for all participants
  // (Single file for analysis — individual files are the backup/audit trail)
  // ⚠️ KNOWN LIMITATION: Concurrent writes can cause data loss (read-modify-write race).
  // R2 doesn't support conditional writes. Individual per-submission files above are the
  // safety net. For <20 concurrent participants this is a non-issue in practice.
  let masterData = { submissions: [], lastUpdated: null };
  try {
    const masterObj = await env.EMIC_DATA.get(EMIC_MASTER_KEY);
    if (masterObj) {
      const raw = await masterObj.json();
      masterData.submissions = raw.submissions || [];
      // Drop legacy 'participants' summary array if present (old schema)
    }
  } catch (e) {
    console.error('Error reading EMIC master list:', e);
  }

  // Append the full submission (every submit is a new entry — no dedup)
  masterData.submissions.push(submission);
  masterData.count = masterData.submissions.length;
  masterData.lastUpdated = now.toISOString();

  // Write updated master
  await env.EMIC_DATA.put(EMIC_MASTER_KEY, JSON.stringify(masterData, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });

  return json({
    success: true,
    participantId: sanitizeUsername(participantId),
    submissionKey,
    masterCount: masterData.count,
    submittedAt: now.toISOString(),
  }, 201);
}

/**
 * List all EMIC study participants (from master list)
 */
async function emicListParticipants(env) {
  try {
    const masterObj = await env.EMIC_DATA.get(EMIC_MASTER_KEY);
    if (!masterObj) {
      return json({ success: true, submissions: [], count: 0 });
    }
    const masterData = await masterObj.json();
    return json({
      success: true,
      submissions: masterData.submissions || [],
      count: masterData.count || 0,
      lastUpdated: masterData.lastUpdated,
    });
  } catch (e) {
    return json({ success: false, error: e.message }, 500);
  }
}

/**
 * Get all submissions for a specific EMIC participant
 */
async function emicGetParticipant(env, participantId) {
  if (!participantId) {
    return json({ success: false, error: 'Participant ID required' }, 400);
  }

  const prefix = `${EMIC_PARTICIPANTS_PREFIX}${sanitizeUsername(participantId)}/`;
  const listed = await env.EMIC_DATA.list({ prefix });

  const submissions = [];
  for (const obj of listed.objects) {
    try {
      const data = await env.EMIC_DATA.get(obj.key);
      if (data) {
        submissions.push(await data.json());
      }
    } catch (e) {
      submissions.push({ key: obj.key, error: 'Parse failed', uploaded: obj.uploaded });
    }
  }

  // Sort by serverReceivedAt descending
  submissions.sort((a, b) => (b.serverReceivedAt || '').localeCompare(a.serverReceivedAt || ''));

  return json({
    success: true,
    participantId: sanitizeUsername(participantId),
    submissions,
    count: submissions.length,
  });
}
