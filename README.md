# dropline

Send a file straight from your browser to someone else's. The bytes travel over a
WebRTC data channel — they never land on a server, so there is nothing to host,
nothing to pay for, and nothing to delete afterwards.

## How it works

1. You pick a file. The page mints a random peer id and shows you a link.
2. Your friend opens the link. Their browser connects directly to yours.
3. The file streams across in 64 KB chunks, with a progress bar on both ends.

A signalling server (PeerJS's free public broker) is used only to introduce the
two browsers to each other. It sees the peer id and the connection handshake —
never the file, never its name.

## The catch

**Both tabs must be open at the same time.** There is no storage anywhere, so if
you close your tab the link goes dead. This is a live handoff, not a dropbox.

Other limits worth knowing:

- The receiver buffers the whole file in memory before saving, so very large
  files (past a couple of GB) can exhaust the tab's memory.
- Roughly 10–20% of network pairs — typically two symmetric NATs, or strict
  corporate firewalls — cannot form a direct connection. Fixing that requires a
  TURN relay server, which is the one piece that genuinely costs money. Without
  one, those transfers just fail to connect.
- One file per link. Zip a folder if you need to send several.

## Running it locally

It is three static files with no build step, so any static server works:

```bash
npx serve .
```

Then open the printed URL. WebRTC and the clipboard API both need a secure
context, which means `localhost` or `https://` — opening `index.html` as a
`file://` path will not work properly.

## Deploying

Any static host will serve it. For GitHub Pages, push to a repo and turn on
Pages for the `main` branch root — there is no build step to configure.

## Layout

| File | What's in it |
| --- | --- |
| `index.html` | Markup for all four panels (pick / share / receive / error) |
| `style.css` | Styling, light and dark |
| `app.js` | Peer setup, chunked sending with backpressure, reassembly |
