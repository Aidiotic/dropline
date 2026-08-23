/* Runtime configuration. Deliberately not bundled or fingerprinted, so it can
   be edited on a deployed site without a rebuild.
 *
 * Everything here is optional — with the file untouched, dropline runs on
 * public STUN and PeerJS's free public broker.
 */

window.DROPLINE_CONFIG = {
  // Extra ICE servers, merged ahead of whatever the TURN endpoint returns.
  // iceServers: [{ urls: 'stun:stun.example.net:3478' }],

  // A URL returning short-lived TURN credentials as
  //   { "iceServers": [{ "urls": [...], "username": "...", "credential": "..." }] }
  // Roughly 10-20% of network pairs cannot connect without a relay. See
  // worker/turn-credentials.js for a Cloudflare Worker that serves this, and
  // DEPLOYING.md for how to stand it up.
  //
  // turnCredentialsUrl: 'https://dropline-turn.<your-subdomain>.workers.dev/',

  // Point at your own signalling server instead of the public PeerJS broker.
  // The broker only ever sees the handshake, never file contents, but it is a
  // shared free service with no uptime guarantee.
  //
  // peerServer: { host: 'signal.example.com', port: 443, path: '/', secure: true },
};
