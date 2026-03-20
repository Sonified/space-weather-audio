/**
 * Space Weather Audification Portal - Cloudflare Worker API
 * Handles user sessions and sharing via R2 storage
 *
 * R2 Structure:
 *   users/{username}/sessions/{session_id}.json
 *   shares/{share_id}.json
 */

/** ISO timestamp with milliseconds (D1's datetime('now') only has second precision) */
function nowISO() { return new Date().toISOString(); }

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, If-Modified-Since',
  'Access-Control-Expose-Headers': 'Last-Modified',
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
// Randomization Algorithm (ported from randomization-sim.html)
// =============================================================================

/**
 * Shuffle array in place (Fisher-Yates).
 */
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Sort heal queue according to healPriority mode.
 * Mutates the array in place.
 */
function sortHealQueue(incompletes, healPriority) {
  const useHeight = healPriority === 'fifo-height' || healPriority === 'random-height';
  const useRandom = healPriority === 'random' || healPriority === 'random-height';

  if (useHeight) {
    const counts = new Map();
    for (const item of incompletes) {
      counts.set(item.condition, (counts.get(item.condition) || 0) + 1);
    }
    if (useRandom) {
      const groups = new Map();
      for (const item of incompletes) {
        if (!groups.has(item.condition)) groups.set(item.condition, []);
        groups.get(item.condition).push(item);
      }
      const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
      incompletes.length = 0;
      for (const [, group] of sorted) {
        shuffleArray(group);
        incompletes.push(...group);
      }
    } else {
      incompletes.sort((a, b) => {
        const countDiff = counts.get(b.condition) - counts.get(a.condition);
        if (countDiff !== 0) return countDiff;
        return a.assignTime - b.assignTime;
      });
    }
  } else if (useRandom) {
    shuffleArray(incompletes);
  } else {
    // FIFO
    incompletes.sort((a, b) => a.assignTime - b.assignTime);
  }
}

/**
 * Plain block assignment — no healing. Just walk through blocks sequentially.
 * Returns the condition index (0-based). Mutates state in place.
 */
function blockAssign(state) {
  const { blocks, numConditions } = state;
  // Wrap around if we exceed block count
  if (state.currentBlock >= blocks.length) state.currentBlock = 0;
  const block = blocks[state.currentBlock];
  const condition = block[state.currentSlot];
  state.currentSlot++;
  if (state.currentSlot >= numConditions) {
    state.currentBlock++;
    state.currentSlot = 0;
    if (state.currentBlock >= blocks.length) state.currentBlock = 0;
  }
  return condition;
}

/**
 * Healing block assignment — one step of the algorithm.
 * Returns { condition (0-based index), mode ('walk' or 'heal') }.
 * Mutates state in place.
 */
function healingBlockAssign(state) {
  const { blocks, numConditions } = state;

  // Ensure blockIncomplete is an object (may come from JSON as {})
  if (!state.blockIncomplete) state.blockIncomplete = {};

  if (state.phase === 'healing') {
    return doHealAssign(state);
  }
  return doWalkAssign(state);
}

function doWalkAssign(state) {
  const { blocks, numConditions } = state;
  // Wrap block index
  if (state.currentBlock >= blocks.length) state.currentBlock = 0;

  // Check if we've hit the heal boundary
  if (state.currentSlot >= state.nextHealAt) {
    startHealRound(state);
    if (state.phase === 'healing') {
      return doHealAssign(state);
    }
    return doWalkAssign(state);
  }

  const block = blocks[state.currentBlock];
  const condition = block[state.currentSlot];
  state.currentSlot++;

  // Check if we've hit heal boundary after advancing
  if (state.currentSlot >= state.nextHealAt) {
    startHealRound(state);
  }

  return { condition, mode: 'walk' };
}

function startHealRound(state) {
  const { numConditions } = state;
  const blockKey = String(state.currentBlock);
  const incompletes = state.blockIncomplete[blockKey];

  if (!incompletes || incompletes.length === 0) {
    // No incompletes — advance to next block/segment
    if (state.nextHealAt >= numConditions) {
      state.currentBlock++;
      state.currentSlot = 0;
      state.nextHealAt = numConditions; // healInterval = numConditions
      if (state.currentBlock >= state.blocks.length) state.currentBlock = 0;
    } else {
      state.nextHealAt += numConditions;
    }
    state.phase = 'walking';
    state.healPassesLeft = 0;
    return;
  }

  sortHealQueue(incompletes, state.healPriority || 'fifo');
  state.healQueue = incompletes.map(s => s.condition);
  state.healIndex = 0;
  state.phase = 'healing';
  delete state.blockIncomplete[blockKey]; // consumed

  if (state.healPassesLeft === 0) {
    state.healPassesLeft = state.maxHealPasses || 1;
  }
  state.healPassesLeft--;
}

function advanceAfterHeal(state) {
  const { numConditions } = state;

  // Check for more passes
  if (state.healPassesLeft > 0) {
    const blockKey = String(state.currentBlock);
    const incompletes = state.blockIncomplete[blockKey];
    if (incompletes && incompletes.length > 0) {
      startHealRound(state);
      return;
    }
  }

  if (state.nextHealAt >= numConditions) {
    state.currentBlock++;
    state.currentSlot = 0;
    state.nextHealAt = numConditions;
    if (state.currentBlock >= state.blocks.length) state.currentBlock = 0;
  } else {
    state.nextHealAt += numConditions;
  }
  state.phase = 'walking';
  state.healPassesLeft = 0;
}

function doHealAssign(state) {
  if (state.healIndex >= state.healQueue.length) {
    advanceAfterHeal(state);
    if (state.phase === 'healing') {
      return doHealAssign(state);
    }
    return doWalkAssign(state);
  }

  // Heal cap check
  const { simultHealCap = Infinity, healCapMode = 'total' } = state;
  // Note: in single-participant-at-a-time mode, cap is mostly irrelevant
  // but we keep the structure for consistency with the sim

  const condition = state.healQueue[state.healIndex];
  state.healIndex++;

  if (state.healIndex >= state.healQueue.length) {
    advanceAfterHeal(state);
  }

  return { condition, mode: 'heal' };
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

      // POST /api/emic/errors — Save a client-side error report
      if (path === '/api/emic/errors' && request.method === 'POST') {
        return await emicSaveErrorReport(request, env);
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
      // Pre-rendered EMIC audio: /api/emic-audio/:filename.wav
      // Serves wavelet-stretched WAVs from emic-data R2 bucket
      // =======================================================================
      const emicAudioMatch = path.match(/^\/api\/emic-audio\/([^/]+\.wav)$/);
      if (emicAudioMatch && request.method === 'GET') {
        const filename = emicAudioMatch[1];
        const obj = await env.EMIC_DATA.get(`audio/${filename}`);
        if (!obj) return json({ error: 'Not found', key: `audio/${filename}` }, 404);
        return new Response(obj.body, {
          headers: {
            'Content-Type': 'audio/wav',
            'Cache-Control': 'public, max-age=31536000',
            ...CORS_HEADERS,
          },
        });
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
      // GET /api/studies — list all studies (id, name, participant count)
      // =======================================================================
      if (path === '/api/studies' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT s.id, s.name, s.updated_at,
                  COUNT(p.participant_id) as participant_count
           FROM studies s
           LEFT JOIN participants p ON p.study_id = s.id
           GROUP BY s.id
           ORDER BY s.updated_at DESC`
        ).all();
        return json({ success: true, studies: results || [] });
      }

      // =======================================================================
      // D1 Study Routes: /api/study/:studyId/*
      // =======================================================================
      const studyConfigMatch = path.match(/^\/api\/study\/([^/]+)\/config$/);
      if (studyConfigMatch) {
        const studyId = studyConfigMatch[1];

        if (request.method === 'GET') {
          const [row, activeSession] = await Promise.all([
            env.DB.prepare('SELECT id, name, config, created_at, updated_at FROM studies WHERE id = ?').bind(studyId).first(),
            env.DB.prepare(
              `SELECT session_id, mode, started_at, assignment_state FROM assignment_sessions
               WHERE study_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`
            ).bind(studyId).first(),
          ]);
          if (!row) return json({ error: 'Study not found' }, 404);
          const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
          // Strip adminKey from config — it lives in its own column now
          delete config.adminKey;
          // Include active session summary (mode, block, started_at)
          let session = null;
          if (activeSession) {
            let currentBlock = null;
            try {
              const s = JSON.parse(activeSession.assignment_state);
              currentBlock = s.currentBlock != null ? s.currentBlock + 1 : null;
            } catch {}
            session = {
              id: activeSession.session_id,
              mode: activeSession.mode || 'test',
              startedAt: activeSession.started_at,
              currentBlock,
            };
          }
          return json({ success: true, study: { id: row.id, name: row.name, config }, session });
        }

        if (request.method === 'PUT') {
          const body = await request.json();
          const config = typeof body.config === 'string' ? JSON.parse(body.config) : body.config;
          // Extract adminKey from config, store in its own column
          const adminKey = config.adminKey || null;
          delete config.adminKey;
          const configStr = JSON.stringify(config);
          const name = body.name || studyId;
          if (adminKey) {
            const now = nowISO();
            await env.DB.prepare(
              `INSERT INTO studies (id, name, config, admin_key, updated_at) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET name = excluded.name, config = excluded.config, admin_key = excluded.admin_key, updated_at = ?`
            ).bind(studyId, name, configStr, adminKey, now, now).run();
          } else {
            const now = nowISO();
            await env.DB.prepare(
              `INSERT INTO studies (id, name, config, updated_at) VALUES (?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET name = excluded.name, config = excluded.config, updated_at = ?`
            ).bind(studyId, name, configStr, now, now).run();
          }
          return json({ success: true });
        }

        return json({ error: 'Method not allowed' }, 405);
      }

      // POST /api/study/:studyId/snapshot — save config snapshot to R2
      // GET  /api/study/:studyId/snapshot — list all snapshots
      const snapshotMatch = path.match(/^\/api\/study\/([^/]+)\/snapshot$/);
      if (snapshotMatch) {
        const studyId = snapshotMatch[1];

        if (request.method === 'POST') {
          const body = await request.json();
          const label = body.label || body.session_id || nowISO().replace(/[:.]/g, '-');
          const config = typeof body.config === 'string' ? body.config : JSON.stringify(body.config, null, 2);
          if (!config) return json({ error: 'config required' }, 400);
          const key = `study_snapshots/${studyId}/${label}.json`;
          await env.BUCKET.put(key, config, {
            customMetadata: { study_id: studyId, label, created_at: nowISO() },
          });
          return json({ success: true, key });
        }

        if (request.method === 'GET') {
          const prefix = `study_snapshots/${studyId}/`;
          const listed = await env.BUCKET.list({ prefix });
          const snapshots = listed.objects.map(obj => ({
            key: obj.key,
            label: obj.key.replace(prefix, '').replace('.json', ''),
            size: obj.size,
            uploaded: obj.uploaded,
          }));
          return json({ success: true, snapshots });
        }

        return json({ error: 'Method not allowed' }, 405);
      }

      // POST /api/study/:studyId/backup — save config backup to R2
      // GET  /api/study/:studyId/backup — list all backups
      // GET  /api/study/:studyId/backup/:label — download a specific backup
      const backupMatch = path.match(/^\/api\/study\/([^/]+)\/backup(?:\/(.+))?$/);
      if (backupMatch) {
        const studyId = backupMatch[1];
        const backupLabel = backupMatch[2] ? decodeURIComponent(backupMatch[2]) : null;

        if (request.method === 'POST') {
          const body = await request.json();
          const config = typeof body.config === 'string' ? body.config : JSON.stringify(body.config, null, 2);
          if (!config) return json({ error: 'config required' }, 400);
          const now = new Date();
          const label = `${now.getUTCFullYear()}${String(now.getUTCMonth()+1).padStart(2,'0')}${String(now.getUTCDate()).padStart(2,'0')}_${String(now.getUTCHours()).padStart(2,'0')}${String(now.getUTCMinutes()).padStart(2,'0')}${String(now.getUTCSeconds()).padStart(2,'0')}`;
          const key = `study_backups/${studyId}/${label}.json`;
          await env.BUCKET.put(key, config, {
            customMetadata: { study_id: studyId, label, created_at: nowISO(), note: body.note || '' },
          });
          console.log(`[BACKUP] ${studyId} → ${key}`);
          return json({ success: true, key, label });
        }

        if (request.method === 'GET' && backupLabel) {
          const key = `study_backups/${studyId}/${backupLabel}.json`;
          const obj = await env.BUCKET.get(key);
          if (!obj) return json({ error: 'Backup not found' }, 404);
          const config = await obj.text();
          return json({ success: true, label: backupLabel, config: JSON.parse(config), metadata: obj.customMetadata });
        }

        if (request.method === 'GET') {
          const prefix = `study_backups/${studyId}/`;
          const listed = await env.BUCKET.list({ prefix });
          const backups = listed.objects.map(obj => ({
            key: obj.key,
            label: obj.key.replace(prefix, '').replace('.json', ''),
            size: obj.size,
            uploaded: obj.uploaded,
          }));
          // Most recent first
          backups.sort((a, b) => (b.uploaded || '').toString().localeCompare((a.uploaded || '').toString()));
          return json({ success: true, backups });
        }

        return json({ error: 'Method not allowed' }, 405);
      }

      // POST /api/verify-admin — verify admin key with exponential backoff
      // Single endpoint: check lockout → try key → success or increment fails
      if (path === '/api/verify-admin' && request.method === 'POST') {
        const body = await request.json();
        const submitted = (body.key || '').trim();
        if (!submitted) return json({ error: 'No key provided' }, 400);

        // Check global lockout (study with highest fails = rate-limit sentinel)
        const sentinel = await env.DB.prepare(
          'SELECT id, auth_fails, auth_locked_until FROM studies WHERE auth_fails > 0 ORDER BY auth_fails DESC LIMIT 1'
        ).first();
        if (sentinel?.auth_locked_until) {
          const lockedUntil = new Date(sentinel.auth_locked_until + 'Z').getTime();
          const now = Date.now();
          if (now < lockedUntil) {
            const waitSec = Math.ceil((lockedUntil - now) / 1000);
            return json({ error: 'Too many attempts', retry_after: waitSec }, 429);
          }
        }

        // Try to find study with this admin key
        const row = await env.DB.prepare(
          'SELECT id, name, config FROM studies WHERE admin_key = ?'
        ).bind(submitted).first();

        if (row) {
          // Success — reset all fail counters
          await env.DB.prepare('UPDATE studies SET auth_fails = 0, auth_locked_until = NULL WHERE auth_fails > 0').run();
          const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
          delete config.adminKey;
          return json({ success: true, study: { id: row.id, name: row.name, config } });
        }

        // Wrong key — first attempt free, then exponential lockout: 5s, 20s, 80s, 320s...
        const target = sentinel || await env.DB.prepare('SELECT id, auth_fails FROM studies LIMIT 1').first();
        if (target) {
          const fails = (target.auth_fails || 0) + 1;
          if (fails === 1) {
            await env.DB.prepare('UPDATE studies SET auth_fails = ? WHERE id = ?').bind(fails, target.id).run();
            return json({ error: 'Invalid admin key' }, 403);
          }
          const lockoutSec = 5 * Math.pow(4, fails - 2);
          const lockedUntil = new Date(Date.now() + lockoutSec * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
          await env.DB.prepare('UPDATE studies SET auth_fails = ?, auth_locked_until = ? WHERE id = ?').bind(fails, lockedUntil, target.id).run();
          return json({ error: 'Invalid admin key', retry_after: lockoutSec }, 403);
        }
        return json({ error: 'Invalid admin key' }, 403);
      }

      // Helper: bump studies.updated_at so If-Modified-Since polling can short-circuit
      // Optional 5s debounce — uncomment if write budget becomes a concern
      // const _lastTouchTime = {};
      const touchStudy = (studyId) => {
        // const now = Date.now();
        // if (_lastTouchTime[studyId] && now - _lastTouchTime[studyId] < 5000) {
        //   console.log(`[TOUCH] ${studyId} — skipped (debounce)`);
        //   return Promise.resolve();
        // }
        // _lastTouchTime[studyId] = now;
        console.log(`[TOUCH] ${studyId} — bumping updated_at`);
        return env.DB.prepare(`UPDATE studies SET updated_at = ? WHERE id = ?`).bind(nowISO(), studyId).run();
      };

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
        const regEvent = JSON.stringify({ type: 'registration' });
        const now = nowISO();
        await env.DB.prepare(
          `INSERT INTO participants (participant_id, study_id, updated_at, last_event, registered_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(participant_id, study_id) DO UPDATE SET updated_at = ?, last_event = ?`
        ).bind(pid, studyId, now, regEvent, now, now, regEvent).run();
        await touchStudy(studyId);
        return json({ success: true, participant_id: pid, mode });
      }

      // GET /api/study/:studyId/participants/:pid/data — fetch participant data
      // (also responds to /progress for backwards compat)
      const dataMatch = path.match(/^\/api\/study\/([^/]+)\/participants\/([^/]+)\/(data|progress)$/);
      if (dataMatch && request.method === 'GET') {
        const [, studyId, pid] = dataMatch;
        const row = await env.DB.prepare(
          'SELECT current_step, responses, flags, step_history, completed_at FROM participants WHERE participant_id = ? AND study_id = ?'
        ).bind(decodeURIComponent(pid), studyId).first();
        if (!row) return json({ error: 'Participant not found' }, 404);
        return json({
          success: true,
          current_step: row.current_step,
          responses: typeof row.responses === 'string' ? JSON.parse(row.responses) : row.responses,
          flags: typeof row.flags === 'string' ? JSON.parse(row.flags) : row.flags,
          step_history: typeof row.step_history === 'string' ? JSON.parse(row.step_history) : row.step_history,
          completed_at: row.completed_at,
        });
      }

      // PUT /api/study/:studyId/participants/:pid/step — update current step + append history
      const stepMatch = path.match(/^\/api\/study\/([^/]+)\/participants\/([^/]+)\/step$/);
      if (stepMatch && request.method === 'PUT') {
        const [, studyId, pid] = stepMatch;
        const body = await request.json();
        const step = body.step;
        if (step == null) return json({ error: 'Missing step' }, 400);
        const decodedPid = decodeURIComponent(pid);
        const entry = JSON.stringify({ step, completed_at: new Date().toISOString() });
        const stepEvent = JSON.stringify({ type: 'step', step });
        await env.DB.prepare(
          `UPDATE participants
           SET current_step = ?,
               step_history = json_insert(step_history, '$[#]', json(?)),
               updated_at = ?,
               last_event = ?
           WHERE participant_id = ? AND study_id = ?`
        ).bind(step, entry, nowISO(), stepEvent, decodedPid, studyId).run();
        await touchStudy(studyId);
        return json({ success: true, current_step: step });
      }

      // ═══════════════════════════════════════════════════════════════════
      // SESSION-BASED ASSIGNMENT + SERVER-SIDE RANDOMIZATION
      // ═══════════════════════════════════════════════════════════════════

      // POST /api/study/:studyId/session/start — create a new assignment session
      const sessionStartMatch = path.match(/^\/api\/study\/([^/]+)\/session\/start$/);
      if (sessionStartMatch && request.method === 'POST') {
        const studyId = sessionStartMatch[1];
        const body = await request.json();
        if (!body.state) return json({ error: 'Missing state' }, 400);

        // End any currently active session
        await env.DB.prepare(
          `UPDATE assignment_sessions SET ended_at = ? WHERE study_id = ? AND ended_at IS NULL`
        ).bind(nowISO(), studyId).run();

        // Create new session — ID format: STUDY_slug_YYYYMMDD_HHMM_XXXXX or TEST_slug_YYYYMMDD_HHMM_XXXXX
        const mode = body.mode || 'test';
        const prefix = mode === 'live' ? 'STUDY' : 'TEST';
        const now = new Date();
        const datePart = `${now.getUTCFullYear()}${String(now.getUTCMonth()+1).padStart(2,'0')}${String(now.getUTCDate()).padStart(2,'0')}`;
        const timePart = `${String(now.getUTCHours()).padStart(2,'0')}${String(now.getUTCMinutes()).padStart(2,'0')}`;
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        let suffix = ''; for (let i = 0; i < 5; i++) suffix += chars[Math.floor(Math.random() * 26)];
        const sessionId = body.sessionId || `${prefix}_${studyId}_${datePart}_${timePart}_${suffix}`;
        await env.DB.prepare(
          `INSERT INTO assignment_sessions (session_id, study_id, assignment_state, assignment_version, mode)
           VALUES (?, ?, ?, 0, ?)`
        ).bind(sessionId, studyId, JSON.stringify(body.state), mode).run();

        await touchStudy(studyId);
        const s = body.state;
        return json({
          success: true,
          sessionId,
          numBlocks: s.blocks?.length || 0,
          numConditions: s.numConditions || 0,
          totalSlots: (s.blocks?.length || 0) * (s.numConditions || 0),
          method: s.healPriority ? 'healingBlock' : 'block',
        });
      }

      // POST /api/study/:studyId/session/end — end the active session
      const sessionEndMatch = path.match(/^\/api\/study\/([^/]+)\/session\/end$/);
      if (sessionEndMatch && request.method === 'POST') {
        const studyId = sessionEndMatch[1];
        await env.DB.prepare(
          `UPDATE assignment_sessions SET ended_at = ? WHERE study_id = ? AND ended_at IS NULL`
        ).bind(nowISO(), studyId).run();
        await touchStudy(studyId);
        return json({ success: true });
      }

      // GET /api/study/:studyId/sessions — list all sessions for this study
      const sessionsListMatch = path.match(/^\/api\/study\/([^/]+)\/sessions$/);
      if (sessionsListMatch && request.method === 'GET') {
        const studyId = sessionsListMatch[1];
        const { results } = await env.DB.prepare(
          `SELECT session_id, study_id, started_at, ended_at, mode FROM assignment_sessions
           WHERE study_id = ? ORDER BY started_at DESC LIMIT 50`
        ).bind(studyId).all();
        return json({ success: true, sessions: results || [] });
      }

      // POST /api/study/:studyId/assign — assign next condition to a participant
      const assignMatch = path.match(/^\/api\/study\/([^/]+)\/assign$/);
      if (assignMatch && request.method === 'POST') {
        const studyId = assignMatch[1];
        const body = await request.json();
        const pid = body.participant_id;
        if (!pid) return json({ error: 'Missing participant_id' }, 400);

        // Get study config for condition details
        const studyRow = await env.DB.prepare(
          'SELECT config FROM studies WHERE id = ?'
        ).bind(studyId).first();
        const config = studyRow?.config ? JSON.parse(studyRow.config) : {};
        const conditions = config.experimentalDesign?.conditions || [];
        const method = config.experimentalDesign?.randomization?.method || 'random';

        // Retry loop for optimistic concurrency
        for (let attempt = 0; attempt < 10; attempt++) {
          // Find active session
          const session = await env.DB.prepare(
            `SELECT session_id, assignment_state, assignment_version, mode FROM assignment_sessions
             WHERE study_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`
          ).bind(studyId).first();
          if (!session || !session.assignment_state) {
            return json({ success: false, noSession: true, message: 'No active session' });
          }

          // Test participant in a live session → return default condition, don't burn a block slot
          const isTestParticipant = pid.startsWith('TEST_');
          const isLiveSession = session.mode === 'live';
          if (isTestParticipant && isLiveSession) {
            const defaultCondition = conditions[0] || {};
            return json({
              success: true,
              conditionIndex: 0,
              order: [0, 1],
              task1Processing: null,
              task2Processing: null,
              assignmentMode: 'test_in_live',
              sessionId: session.session_id,
              block: null,
              phase: 'test_bypass',
              step: null,
            });
          }

          const sessionId = session.session_id;
          const state = JSON.parse(session.assignment_state);
          const version = session.assignment_version || 0;

          // Check for dropouts (>dropout timeout, no completion) and add to heal queue
          if (method === 'healingBlock') {
            const dropoutMin = state.dropoutTimeoutMin || 120;
            const { results: dropouts } = await env.DB.prepare(
              `SELECT assigned_condition, assignment_mode FROM participants
               WHERE study_id = ? AND group_id = ? AND completed_at IS NULL AND assigned_condition IS NOT NULL
               AND REPLACE(REPLACE(updated_at, 'T', ' '), 'Z', '') < datetime('now', '-' || ? || ' minutes')`
            ).bind(studyId, sessionId, dropoutMin).all();

            if (dropouts && dropouts.length > 0) {
              if (!state.blockIncomplete) state.blockIncomplete = {};
              for (const d of dropouts) {
                const blockIdx = state.currentBlock;
                if (!state.blockIncomplete[blockIdx]) state.blockIncomplete[blockIdx] = [];
                const already = state.blockIncomplete[blockIdx].some(
                  item => item.condition === d.assigned_condition && item.source === 'dropout'
                );
                if (!already) {
                  state.blockIncomplete[blockIdx].push({
                    condition: d.assigned_condition,
                    assignTime: state.step,
                    source: 'dropout'
                  });
                }
              }
            }
          }

          // Run one assignment step
          state.step++;
          let assignedCondition;
          let assignmentMode;

          if (method === 'healingBlock') {
            const result = healingBlockAssign(state);
            assignedCondition = result.condition;
            assignmentMode = result.mode;
          } else {
            assignedCondition = blockAssign(state);
            assignmentMode = 'walk';
          }

          // Optimistic concurrency write to session
          const writeResult = await env.DB.prepare(
            `UPDATE assignment_sessions SET assignment_state = ?, assignment_version = ?
             WHERE session_id = ? AND assignment_version = ?`
          ).bind(JSON.stringify(state), version + 1, sessionId, version).run();

          if (writeResult.meta?.changes === 0) {
            continue; // retry
          }

          // Write assignment to participant row (include group_id + block)
          const assignedBlock = state.currentBlock != null ? state.currentBlock + 1 : null;
          const now = nowISO();
          await env.DB.prepare(
            `UPDATE participants SET assigned_condition = ?, assignment_mode = ?, assigned_block = ?, assigned_at = ?,
             group_id = ?, updated_at = ? WHERE participant_id = ? AND study_id = ?`
          ).bind(assignedCondition, assignmentMode, assignedBlock, now, sessionId, now, pid, studyId).run();
          await touchStudy(studyId);

          const conditionDetails = conditions[assignedCondition - 1] || {};
          return json({
            success: true,
            conditionIndex: assignedCondition,
            order: conditionDetails.order,
            task1Processing: conditionDetails.task1Processing,
            task2Processing: conditionDetails.task2Processing,
            assignmentMode,
            sessionId,
            block: state.currentBlock + 1,
            phase: state.phase,
            step: state.step,
            slot: state.currentSlot,
            completions: state.completions,
            version: version + 1,
          });
        }

        return json({ error: 'Assignment failed after retries — high concurrency' }, 503);
      }

      // PUT /api/study/:studyId/participants/:pid/condition — store assigned condition
      const conditionMatch = path.match(/^\/api\/study\/([^/]+)\/participants\/([^/]+)\/condition$/);
      if (conditionMatch && request.method === 'PUT') {
        const [, studyId, pid] = conditionMatch;
        const body = await request.json();
        if (body.conditionIndex == null) return json({ error: 'Missing conditionIndex' }, 400);
        const decodedPid = decodeURIComponent(pid);
        const conditionJson = JSON.stringify(body);
        const conditionEvent = JSON.stringify({ type: 'condition', conditionIndex: body.conditionIndex });
        await env.DB.prepare(
          `UPDATE participants
           SET flags = json_set(flags, '$.condition', json(?)),
               updated_at = ?,
               last_event = ?
           WHERE participant_id = ? AND study_id = ?`
        ).bind(conditionJson, nowISO(), conditionEvent, decodedPid, studyId).run();
        await touchStudy(studyId);
        return json({ success: true, conditionIndex: body.conditionIndex });
      }

      // POST /api/study/:studyId/participants/:pid/heartbeat — DISABLED (last_heartbeat never read)
      // Returns 200 so old cached clients don't error, but does zero DB work
      const heartbeatStudyMatch = path.match(/^\/api\/study\/([^/]+)\/participants\/([^/]+)\/heartbeat$/);
      if (heartbeatStudyMatch && request.method === 'POST') {
        return json({ success: true });
        // const [, studyId, pid] = heartbeatStudyMatch;
        // const decodedPid = decodeURIComponent(pid);
        // await env.DB.prepare(
        //   `UPDATE participants SET last_heartbeat = ?
        //    WHERE participant_id = ? AND study_id = ?`
        // ).bind(nowISO(), decodedPid, studyId).run();
        // return json({ success: true });
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
          // Upsert into features table (stable d1Id allows re-saves without duplicates)
          const id = body.id || (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36));
          const d = body.data || {};
          // Client-authoritative created_at; preserve original on re-saves
          const clientCreatedAt = d.createdAt || null;
          const analysisSession = d.analysisSession || null;
          await env.DB.prepare(
            `INSERT OR REPLACE INTO features (id, participant_id, study_id, start_time, end_time, low_freq, high_freq, confidence, notes, speed_factor, created_at, analysis_session)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM features WHERE id = ?), ?, ?), ?)`
          ).bind(id, pid, studyId, d.startTime || null, d.endTime || null, d.lowFreq || null, d.highFreq || null, d.confidence || 'confirmed', d.notes || '', d.speedFactor || null, id, clientCreatedAt, nowISO(), analysisSession).run();
          // Bump updated_at on participant (real action, not just keepalive)
          await env.DB.prepare(
            `UPDATE participants SET updated_at = ? WHERE participant_id = ? AND study_id = ?`
          ).bind(nowISO(), pid, studyId).run();
          await touchStudy(studyId);
          return json({ success: true, feature_id: id, mode });
        }

        if (type === 'milestone' && body.data?.event === 'completed') {
          // Mark participant as complete
          const milestoneEvent = JSON.stringify({ type: 'milestone', event: 'completed' });
          const now = nowISO();
          await env.DB.prepare(
            `UPDATE participants SET completed_at = ?, updated_at = ?, last_event = ? WHERE participant_id = ? AND study_id = ?`
          ).bind(now, now, milestoneEvent, pid, studyId).run();
          await touchStudy(studyId);
          return json({ success: true, mode });
        }

        // Survey answers — key by questionId so each answer accumulates
        const data = typeof body.data === 'string' ? JSON.parse(body.data) : (body.data || {});
        const qid = data.questionId;
        const dataStr = JSON.stringify(data);
        const responseKey = qid ? `$.${qid}` : `$.${type}`;
        const respEvent = JSON.stringify({ type: 'response', key: responseKey, data });
        await env.DB.prepare(
          `UPDATE participants SET responses = json_set(responses, ?, json(?)), updated_at = ?, last_event = ? WHERE participant_id = ? AND study_id = ?`
        ).bind(responseKey, dataStr, nowISO(), respEvent, pid, studyId).run();
        await touchStudy(studyId);
        return json({ success: true, mode });
      }

      // DELETE /api/study/:studyId/features/:featureId — remove a single feature
      const deleteFeatureMatch = path.match(/^\/api\/study\/([^/]+)\/features\/([^/]+)$/);
      if (deleteFeatureMatch && request.method === 'DELETE') {
        const [, studyId, featureId] = deleteFeatureMatch;
        await env.DB.prepare(`DELETE FROM features WHERE id = ? AND study_id = ?`).bind(featureId, studyId).run();
        await touchStudy(studyId);
        return json({ success: true, deleted: featureId });
      }

      // GET /api/study/:studyId/participants — list all participants with feature counts
      const listParticipantsMatch = path.match(/^\/api\/study\/([^/]+)\/participants$/);
      if (listParticipantsMatch && request.method === 'GET') {
        const studyId = listParticipantsMatch[1];

        // If-Modified-Since: cheap 1-row check before expensive JOIN query
        const ims = request.headers.get('If-Modified-Since');
        if (ims) {
          const study = await env.DB.prepare('SELECT updated_at FROM studies WHERE id = ?').bind(studyId).first();
          if (study?.updated_at && new Date(study.updated_at) <= new Date(ims)) {
            console.log(`[304] /participants ${studyId} — not modified`);
            return new Response(null, { status: 304, headers: CORS_HEADERS });
          }
        }

        const filter = url.searchParams.get('filter') || 'all'; // all | test | live
        const timeoutMin = parseInt(url.searchParams.get('timeout') || '10', 10);

        let whereClause = 'p.study_id = ?';
        if (filter === 'test') whereClause += " AND (p.participant_id LIKE 'test_%' OR p.participant_id LIKE 'preview_%')";
        else if (filter === 'live') whereClause += " AND p.participant_id NOT LIKE 'test_%' AND p.participant_id NOT LIKE 'preview_%'";

        const { results } = await env.DB.prepare(
          `SELECT p.participant_id, p.current_step, p.registered_at, p.completed_at,
                  p.assigned_condition, p.assignment_mode, p.assigned_block, p.assigned_at,
                  p.updated_at, p.responses, p.flags, p.group_id,
                  COUNT(f.id) as feature_count,
                  CASE WHEN REPLACE(REPLACE(p.updated_at, 'T', ' '), 'Z', '') > datetime('now', '-' || ? || ' minutes') THEN 1 ELSE 0 END as is_active
           FROM participants p
           LEFT JOIN features f ON f.participant_id = p.participant_id AND f.study_id = p.study_id
           WHERE ${whereClause}
           GROUP BY p.participant_id, p.study_id
           ORDER BY p.registered_at DESC`
        ).bind(timeoutMin, studyId).all();

        const resp = json({ success: true, participants: results || [] });
        resp.headers.set('Last-Modified', new Date().toUTCString());
        return resp;
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

      // GET /api/study/:studyId/activity — recent activity feed
      const activityMatch = path.match(/^\/api\/study\/([^/]+)\/activity$/);
      if (activityMatch && request.method === 'GET') {
        const studyId = activityMatch[1];

        // If-Modified-Since: cheap 1-row check before expensive 2-query activity scan
        const ims = request.headers.get('If-Modified-Since');
        if (ims) {
          const study = await env.DB.prepare('SELECT updated_at FROM studies WHERE id = ?').bind(studyId).first();
          if (study?.updated_at && new Date(study.updated_at) <= new Date(ims)) {
            console.log(`[304] /activity ${studyId} — not modified`);
            return new Response(null, { status: 304, headers: CORS_HEADERS });
          }
        }

        // Keep since in ISO format — nowISO() stores 'YYYY-MM-DDTHH:MM:SS.mmmZ' in D1
        const since = url.searchParams.get('since') || new Date(Date.now() - 3600000).toISOString();
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 2000);

        // Direct column comparison — no functions on columns, so indexes can be used
        const [participantRows, featureRows] = await Promise.all([
          env.DB.prepare(
            `SELECT participant_id, current_step, updated_at, registered_at, completed_at, last_event, 'participant' as source
             FROM participants WHERE study_id = ? AND updated_at > ?
             ORDER BY updated_at DESC LIMIT ?`
          ).bind(studyId, since, limit).all(),
          env.DB.prepare(
            `SELECT participant_id, id as feature_id, confidence, notes, start_time, end_time,
                    low_freq, high_freq, created_at as updated_at, 'feature' as source
             FROM features WHERE study_id = ? AND created_at > ?
             ORDER BY created_at DESC LIMIT ?`
          ).bind(studyId, since, limit).all(),
        ]);

        // Merge and sort by timestamp descending
        const events = [
          ...(participantRows.results || []).map(r => ({ ...r, timestamp: r.updated_at })),
          ...(featureRows.results || []).map(r => ({ ...r, timestamp: r.updated_at })),
        ].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
         .slice(0, limit);

        const actResp = json({ success: true, events, count: events.length });
        actResp.headers.set('Last-Modified', new Date().toUTCString());
        return actResp;
      }

      // GET /api/study/:studyId/dashboard — aggregate stats for study builder
      const dashboardMatch = path.match(/^\/api\/study\/([^/]+)\/dashboard$/);
      if (dashboardMatch && request.method === 'GET') {
        const studyId = dashboardMatch[1];

        // If-Modified-Since: cheap 1-row check before expensive multi-query dashboard
        const ims = request.headers.get('If-Modified-Since');
        if (ims) {
          const study = await env.DB.prepare('SELECT updated_at FROM studies WHERE id = ?').bind(studyId).first();
          if (study?.updated_at && new Date(study.updated_at) <= new Date(ims)) {
            console.log(`[304] /dashboard ${studyId} — not modified`);
            return new Response(null, { status: 304, headers: CORS_HEADERS });
          }
        }

        const timeoutMin = parseInt(url.searchParams.get('timeout') || '10', 10);
        // Session-based filtering: use active session's session_id
        const activeSession = await env.DB.prepare(
          `SELECT session_id, assignment_state FROM assignment_sessions
           WHERE study_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`
        ).bind(studyId).first();
        const sessionId = activeSession?.session_id;
        const sessionFilter = sessionId ? ' AND group_id = ?' : '';
        const sessionBinds = sessionId ? [sessionId] : [];

        const [totalRow, activeRow, assignedRow, completedRow, participantRows] = await Promise.all([
          env.DB.prepare(`SELECT COUNT(*) as count FROM participants WHERE study_id = ?${sessionFilter}`).bind(studyId, ...sessionBinds).first(),
          env.DB.prepare(
            `SELECT COUNT(*) as count FROM participants WHERE study_id = ? AND REPLACE(REPLACE(updated_at, 'T', ' '), 'Z', '') > datetime('now', '-' || ? || ' minutes')${sessionFilter}`
          ).bind(studyId, timeoutMin, ...sessionBinds).first(),
          env.DB.prepare(`SELECT COUNT(*) as count FROM participants WHERE study_id = ? AND assigned_condition IS NOT NULL${sessionFilter}`).bind(studyId, ...sessionBinds).first(),
          env.DB.prepare(`SELECT COUNT(*) as count FROM participants WHERE study_id = ? AND completed_at IS NOT NULL${sessionFilter}`).bind(studyId, ...sessionBinds).first(),
          env.DB.prepare(
            `SELECT participant_id, current_step, updated_at, registered_at, completed_at, assigned_condition, assignment_mode, assigned_block,
                    CASE WHEN REPLACE(REPLACE(updated_at, 'T', ' '), 'Z', '') > datetime('now', '-' || ? || ' minutes') THEN 1 ELSE 0 END as is_active
             FROM participants WHERE study_id = ?${sessionFilter} ORDER BY updated_at DESC LIMIT 100`
          ).bind(timeoutMin, studyId, ...sessionBinds).all(),
        ]);

        // Extract algorithm state from active session
        let algorithmState = null;
        if (activeSession?.assignment_state) {
          try {
            const s = JSON.parse(activeSession.assignment_state);
            const nextBlock = s.blocks?.[s.currentBlock];
            algorithmState = {
              currentBlock: s.currentBlock,
              phase: s.phase,
              nextAssignment: nextBlock ? nextBlock[s.currentSlot] : null,
              completions: s.completions,
              step: s.step,
            };
          } catch {}
        }

        const dashResp = json({
          success: true,
          sessionId: sessionId || null,
          totalStarted: totalRow?.count || 0,
          activeParticipants: activeRow?.count || 0,
          totalAssigned: assignedRow?.count || 0,
          completedCount: completedRow?.count || 0,
          participants: participantRows?.results || [],
          algorithmState,
        });
        dashResp.headers.set('Last-Modified', new Date().toUTCString());
        return dashResp;
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

/**
 * Save a client-side error report to R2
 * R2 key: emic/errors/{timestamp}_{random}.json
 */
async function emicSaveErrorReport(request, env) {
  try {
    const data = await request.json();
    const now = new Date();
    const timestamp = now.toISOString().replace(/[-:]/g, '').split('.')[0];
    const random = Math.random().toString(36).slice(2, 8);

    const report = {
      ...data,
      serverReceivedAt: now.toISOString(),
    };

    const key = `emic/errors/${timestamp}_${random}.json`;
    await env.EMIC_DATA.put(key, JSON.stringify(report, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    });

    return json({ success: true, key, receivedAt: now.toISOString() }, 201);
  } catch (e) {
    return json({ success: false, error: e.message }, 500);
  }
}
