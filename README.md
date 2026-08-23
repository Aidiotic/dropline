# dropline

Send files straight from one browser to another. The bytes travel over a WebRTC
data channel — they never land on a server, so there is nothing to host, nothing
to pay for, and nothing to delete afterwards.

**Live at [aidiotic.github.io/dropline](https://aidiotic.github.io/dropline/)** ·
[Update log and roadmap](https://aidiotic.github.io/dropline/updates.html)

## What it does

- **Both directions.** Once two devices are paired, either can send.
- **Files, folders, and text.** Drag a folder in, pick several files, paste a
  screenshot, or send a link or password as a snippet.
- **Streams to disk.** Nothing is held in memory, so file size is not bounded by
  RAM.
- **Compresses in flight** when that helps, and skips it when it wouldn't.
- **Reconnects** if the connection drops or a phone locks.

A signalling server is used only to introduce the two browsers. It sees the
session id and the connection handshake — never the files, never their names.

## The catch

**Both tabs must be open at the same time.** There is no storage anywhere, so
this is a live handoff, not a dropbox.

**Roughly 10–20% of network pairs cannot connect** — usually two symmetric NATs
or a strict corporate firewall. A TURN relay fixes this and the client is
already wired for one; see [DEPLOYING.md](DEPLOYING.md). Without a relay, those
transfers fail to connect at all.

An interrupted transfer restarts the file rather than resuming from where it
stopped.

## How it moves bytes

```
sender     File.stream() → [gzip] → chunk → data channel
receiver   data channel → [gunzip] → disk, or sealed Blobs → download
```

- **Chunk size is negotiated,** from `RTCPeerConnection.sctp.maxMessageSize`,
  rather than hard-coded — 256 KB on current browsers against the 64 KB that is
  usually assumed.
- **Compressible files are gzipped in flight** via `CompressionStream`. Formats
  that are already compressed skip it, because gzipping a JPEG costs CPU and
  saves nothing.
- **The receiver never holds a file in the heap.** With the File System Access
  API it writes straight to disk. Everywhere else, chunks are sealed into Blobs
  every few megabytes — Blob bytes live outside the JS heap and the browser
  spills them to disk. The seal interval follows `navigator.deviceMemory`.

**Two layers of backpressure, and both are needed.** `bufferedAmount` stops a
fast disk outrunning a slow network, but it only describes the *sender's* own
queue — it cannot see a receiver that writes slower than the channel delivers.
So the receiver also queues by byte length against a 4 MB watermark and sends
`hold`/`go` back over the channel. Without that second layer, a 64 MB transfer
grew the receiver's heap by 118 MB.

## Safety

Names and relative paths arriving from the far end are untrusted input. Both are
sanitised when sent *and* again when received: separators are stripped from
names, `..` segments are dropped from paths, depth is capped, and colliding
names are disambiguated rather than silently overwriting each other. A peer
cannot write outside the folder you picked.

The link is the secret — anyone holding it can join the session, and only one
peer may be connected at a time.

## Development

```bash
npm test          # unit tests over the pure logic
npm run build     # bundle src/ into content-hashed assets
npm run check     # fail if the committed build is stale
npm run serve     # static server for local testing
```

Sources live in `src/`. **Edit those, never the generated `dropline.*.js` at the
root**, and run `npm run build` before committing — CI fails otherwise.

Assets are content-hashed on purpose. GitHub Pages serves with
`cache-control: max-age=600`, so a fixed filename means returning visitors can
run ten minutes of stale code against fresh markup. A filename that changes with
its contents makes that impossible, and removes a manual step someone would
eventually forget.

WebRTC and the clipboard API need a secure context, so use the `localhost` URL
`npm run serve` prints — opening `index.html` as a `file://` path will not work.

## Layout

| Path | What's in it |
| --- | --- |
| `src/util.js` | Pure helpers: formatting, sizing, name and path sanitising |
| `src/protocol.js` | Wire messages, manifest building, untrusted-input parsing |
| `src/transfer.js` | Stream plumbing: chunked send, sealing, destinations |
| `src/session.js` | Peer lifecycle, reconnection, routing, send/receive machines |
| `src/ui.js` | The only file that touches the DOM |
| `config.js` | Runtime config — not bundled, editable on a live deploy |
| `worker/` | Cloudflare Worker that mints short-lived TURN credentials |
| `build.js` / `test.js` | Bundler and test runner, no dependencies |

See [TESTING.md](TESTING.md) for what is verified and what isn't.
