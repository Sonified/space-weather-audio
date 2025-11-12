/**
 * Cloudflare Worker for purging CDN cache
 * 
 * Environment variables needed:
 * - CLOUDFLARE_API_TOKEN: API token with cache purge permissions
 * - CLOUDFLARE_ZONE_ID: Zone ID for cdn.now.audio
 */

export default {
    async fetch(request, env) {
        // CORS headers for allowing frontend requests
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };

        // Handle preflight OPTIONS request
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeaders
            });
        }

        // Only allow POST requests
        if (request.method !== 'POST') {
            return new Response(JSON.stringify({
                success: false,
                error: 'Method not allowed. Use POST.'
            }), {
                status: 405,
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'application/json'
                }
            });
        }

        try {
            // Get credentials from environment variables
            const CLOUDFLARE_TOKEN = env.CLOUDFLARE_API_TOKEN;
            const ZONE_ID = env.CLOUDFLARE_ZONE_ID;

            if (!CLOUDFLARE_TOKEN || !ZONE_ID) {
                throw new Error('Worker not configured: Missing API token or Zone ID');
            }

            // Call Cloudflare API to purge cache
            const response = await fetch(
                `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${CLOUDFLARE_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ purge_everything: true })
                }
            );

            const result = await response.json();

            if (result.success) {
                return new Response(JSON.stringify({
                    success: true,
                    message: 'CDN cache purged successfully',
                    timestamp: new Date().toISOString()
                }), {
                    status: 200,
                    headers: {
                        ...corsHeaders,
                        'Content-Type': 'application/json'
                    }
                });
            } else {
                throw new Error(result.errors?.[0]?.message || 'Cloudflare API returned failure');
            }

        } catch (error) {
            console.error('Cache purge error:', error);
            
            return new Response(JSON.stringify({
                success: false,
                error: error.message || 'Failed to purge cache'
            }), {
                status: 500,
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'application/json'
                }
            });
        }
    }
};

