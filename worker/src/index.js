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

// Helper: Generate Open Graph HTML for share links
function generateOgHtml(shareMeta, frontendUrl, shareId) {
  const title = shareMeta.title || 'Space Weather Analysis';
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

  const shareUrl = `${frontendUrl}/?share=${shareId}`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title} - Space Weather Audio</title>
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${shareUrl}">
  <meta property="og:site_name" content="Space Weather Audio">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
  <meta http-equiv="refresh" content="0;url=${shareUrl}">
</head>
<body>
  <p>Redirecting to <a href="${shareUrl}">${title}</a>...</p>
</body>
</html>`;
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
      // Open Graph Preview for Share Links
      // Serves HTML with OG meta tags for social media crawlers
      // =======================================================================
      const shareId = url.searchParams.get('share');
      if (shareId && (path === '/' || path === '')) {
        const shareObj = await env.BUCKET.get(getShareKey(shareId));
        if (shareObj) {
          const shareMeta = await shareObj.json();
          // Check not expired
          if (new Date() <= new Date(shareMeta.expires_at)) {
            const html = generateOgHtml(shareMeta, frontendUrl, shareId);
            return new Response(html, {
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
            });
          }
        }
        // If share not found or expired, redirect to frontend anyway
        return Response.redirect(`${frontendUrl}/?share=${shareId}`, 302);
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

// Helper: Validate username
function validateUsername(username) {
  if (!username || typeof username !== 'string') {
    return { valid: false, error: 'Username is required' };
  }

  const cleaned = username.trim();

  if (cleaned.length < 2) {
    return { valid: false, error: 'Username must be at least 2 characters' };
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
  return json({
    available: !existing,
    username: validation.username
  });
}

async function registerUsername(request, env, username) {
  const validation = validateUsername(username);
  if (!validation.valid) {
    return json({ success: false, error: validation.error }, 400);
  }

  const cleanUsername = validation.username;
  const key = getUsernameKey(cleanUsername);

  // Check if already taken
  const existing = await env.BUCKET.head(key);
  if (existing) {
    return json({ success: false, error: 'Username is already taken' }, 409);
  }

  // Register the username
  const now = new Date().toISOString();
  const userData = {
    username: cleanUsername,
    registered_at: now,
    last_active_at: now
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
  const { username, session_id, share_id: customShareId } = data;

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
  const expiryDays = parseInt(env.SHARE_EXPIRY_DAYS || '90');
  const expiresAt = new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000);

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
    expires_at: expiresAt.toISOString(),
    view_count: 0,
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
    expires_at: expiresAt.toISOString(),
  }, 201);
}

async function getShare(env, shareId) {
  // Get share metadata
  const shareObj = await env.BUCKET.get(getShareKey(shareId));
  if (!shareObj) {
    return json({ success: false, error: 'Share not found' }, 404);
  }

  const shareMeta = await shareObj.json();

  // Check expiry
  if (new Date() > new Date(shareMeta.expires_at)) {
    return json({
      success: false,
      error: 'Share has expired',
      expired_at: shareMeta.expires_at
    }, 410);
  }

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
