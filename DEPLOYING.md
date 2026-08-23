# Deploying

The site itself is static: push to `main` and GitHub Pages serves it. The two
things below are optional, but the first is what separates "works for me" from
"works for everyone".

---

## 1. TURN relay — fixes the transfers that fail entirely

> **Current state:** the worker is deployed at
> `https://dropline-turn.dropline.workers.dev` with both secrets set, but it
> answers `404` from the TURN provider because **no TURN key has been created in
> the Cloudflare dashboard** — the stored secrets are placeholder text. The
> endpoint reports this in its own response body. Until a real key exists, the
> app falls back to STUN and roughly 10–20% of pairs cannot connect.

**Why you want this.** Two peers behind symmetric NATs, or on a network that
blocks peer-to-peer UDP, cannot reach each other directly no matter what. STUN
does not help; only a relay does. That is roughly 10–20% of real-world pairs,
and today those people see a connection that never establishes.

The client already reads short-lived credentials from an endpoint. You need to
stand that endpoint up.

### Steps

1. **Create a TURN key.** In the Cloudflare dashboard, go to Realtime → TURN and
   create a key. Note the key id and the API token.

2. **Deploy the worker.**

   ```bash
   cd worker
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_API_TOKEN
   npx wrangler deploy
   ```

   The secrets stay in Cloudflare. They are never committed, and never reach a
   browser — only the derived credential does, and it expires in an hour.

3. **Point `config.js` at it** once the key exists, by uncommenting
   `turnCredentialsUrl`. The client already reads it and falls back silently
   when it is absent or failing, so nothing breaks in the meantime.

4. **Edit `ALLOWED_ORIGINS`** in `worker/turn-credentials.js` if you serve the
   site from anywhere other than `aidiotic.github.io`. This keeps other sites
   off your relay quota.

   `config.js` is deliberately not bundled or hashed, so you can edit it on a
   deployed site without rebuilding:

   ```js
   turnCredentialsUrl: 'https://dropline-turn.dropline.workers.dev/',
   ```

5. **Verify.** Load the site and check the network tab for a request to the
   worker returning `iceServers`. If it fails, dropline logs a warning and
   carries on with STUN only — a missing relay costs reliability, not
   correctness.

> Relayed traffic is still end-to-end encrypted; the relay forwards DTLS it
> cannot read. But it does consume bandwidth you pay for, which is why the
> endpoint is origin-restricted.

---

## 2. Self-hosted signalling — removes the last third-party dependency

By default, introductions go through PeerJS's free public broker. It only ever
sees the handshake, never file contents — but it is a shared free service with
no uptime guarantee, and it is the single likeliest thing to break without
warning.

Run your own:

```bash
npx peerjs --port 9000 --key peerjs --path /
```

Put it behind TLS (any reverse proxy will do — it must be `https`/`wss` for the
browser to use it from an https page), then in `config.js`:

```js
peerServer: { host: 'signal.example.com', port: 443, path: '/', secure: true },
```

---

## 3. Serving it somewhere else

Any static host works — there is no build step at request time and no server
code. Copy the repo root as-is.

Two requirements:

- **HTTPS.** WebRTC and the clipboard API both need a secure context.
- **Don't rewrite asset URLs.** `dropline.<hash>.js` and `style.<hash>.css` are
  content-addressed; serving them with a long cache lifetime is correct and
  desirable.

---

## Release checklist

```bash
npm test          # must pass
npm run build     # regenerate hashed assets
npm run check     # confirms the committed build matches src/
git add -A && git commit && git push
```

CI runs `npm test` and `npm run check` on every push. The check exists because a
stale committed bundle would silently deploy old code with new markup — the
exact failure that content hashing is meant to prevent.

After pushing, Pages takes a minute to build and its CDN lags a little behind
the build API. Poll the served HTML rather than the API if you need certainty:

```bash
curl -s "https://aidiotic.github.io/dropline/?cachebust=$RANDOM" | grep dropline
```
