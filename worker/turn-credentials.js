/* Cloudflare Worker: mints short-lived TURN credentials for dropline.
 *
 * Why this exists: roughly 10-20% of network pairs cannot form a direct
 * connection, and a relay is the only fix. Long-lived TURN credentials must not
 * sit in a public static file, so the client fetches them at page load and they
 * expire quickly.
 *
 * Deploy:
 *   1. Create a Cloudflare Realtime/Calls TURN key in the dashboard.
 *   2. wrangler secret put TURN_KEY_ID
 *      wrangler secret put TURN_API_TOKEN
 *   3. wrangler deploy
 *   4. Put the resulting URL in config.js as turnCredentialsUrl.
 *
 * See DEPLOYING.md. The secrets stay in Cloudflare; they are never committed
 * and never reach the browser — only the derived short-lived credential does.
 */

const TTL_SECONDS = 3600;

// Only these origins may request credentials. Anyone can still read the
// response they are given, but this keeps other sites off your relay quota.
const ALLOWED_ORIGINS = [
  'https://aidiotic.github.io',
  'http://localhost:3000',
  'http://localhost:5000',
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') {
      return json({ error: 'method not allowed' }, 405, cors);
    }
    if (origin && !allowed) {
      return json({ error: 'origin not allowed' }, 403, cors);
    }
    if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) {
      return json({ error: 'worker is missing TURN_KEY_ID or TURN_API_TOKEN' }, 500, cors);
    }

    const upstream = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TURN_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      },
    );

    if (!upstream.ok) {
      // Don't leak the upstream body — it can contain account detail.
      return json({ error: `turn provider returned ${upstream.status}` }, 502, cors);
    }

    const data = await upstream.json();
    return json(data, 200, {
      ...cors,
      // Comfortably shorter than the credential's own lifetime.
      'Cache-Control': `public, max-age=${Math.floor(TTL_SECONDS / 4)}`,
    });
  },
};

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
