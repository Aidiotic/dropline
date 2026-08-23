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
- **Compresses in flight** when a measurement says it will actually help.
- **Reconnects** if the connection drops or a phone locks.
- **Verifies both ends** hold the same link, and checksums every file.
- **Adapts to the device** rather than assuming a fast desktop — five tiers,
  chosen partly by measuring what the machine actually does.

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
sender     file.slice() → [gzip] → 4 striped data channels
receiver   striped channels → reorder → [gunzip] → disk, or sealed Blobs
```

- **The payload is striped across parallel data channels.** A single channel
  measured 10.5 MB/s over loopback — and so did a raw channel carrying no
  application logic at all, which is how we know the limit was SCTP rather than
  anything above it. Four channels measured 15.0 MB/s. Ordering needs no
  per-chunk header: chunk *i* is sent on channel *i mod N*, and since each
  channel is ordered on its own, the *k*-th arrival on channel *c* is globally
  chunk *k·N + c*. That keeps the send path copy-free.
- **PeerJS runs in `raw` mode.** Its default `binary` serialization packs every
  message and re-splits it into 16 KB pieces, undoing the negotiated chunk size
  and costing an encode and decode pass per chunk.
- **Nothing is copied on the way out.** Slicing the file directly yields buffers
  that are already exactly one chunk and already owned by us, and reads run one
  chunk ahead so disk and network overlap instead of taking turns.
- **Chunk size is negotiated,** from `RTCPeerConnection.sctp.maxMessageSize`,
  and then capped by what the device can afford.
- **Compression is measured, not guessed.** A quarter-megabyte sample is
  compressed first and the real ratio decides; anything that only shaves a few
  percent is sent raw, because that CPU is paid on both ends. The sample comes
  from a quarter of the way in, since container headers compress quite unlike
  the payload behind them. Types already known to be packed skip the
  measurement entirely.
- **The receiver never holds a file in the heap.** With the File System Access
  API it writes straight to disk. Everywhere else, chunks are sealed into Blobs
  every few megabytes — Blob bytes live outside the JS heap and the browser
  spills them to disk. The seal interval comes from the device tier.

**Two layers of backpressure, and both are needed.** `bufferedAmount` stops a
fast disk outrunning a slow network, but it only describes the *sender's* own
queue — it cannot see a receiver that writes slower than the channel delivers.
So the receiver also queues by byte length against a tier-sized watermark and sends
`hold`/`go` back over the channel. Without that second layer, a 64 MB transfer
grew the receiver's heap by 118 MB.

## The device profile

`src/device.js` is the only place that decides what the machine is. It scores
the real capability signals — memory, cores, network type, data-saver, battery,
pointer, viewport — into one of five tiers, plus a form factor, a density and a motion
level, and publishes them on `<html>` so CSS responds without JavaScript
touching styles.

The signals include a **measured** one, not just advertised ones: the browser
times a checksum over a megabyte and scores the result. `deviceMemory` is coarse
and may be clamped, so it cannot separate a netbook from a workstation — where
the spec sheet and the stopwatch disagree, the stopwatch wins. Chunk cap, seal interval, receive watermark, repaint rate, thumbnails
and animation all follow from it, and it is recomputed on resize, rotation,
network change and battery change.

The point is that a cheap phone on a dying battery over 3G does *less work*,
rather than the same work more slowly.

## Safety

Names and relative paths arriving from the far end are untrusted input. Both are
sanitised when sent *and* again when received: separators are stripped from
names, `..` segments are dropped from paths, depth is capped, and colliding
names are disambiguated rather than silently overwriting each other. A peer
cannot write outside the folder you picked.

**The link carries a secret**, after the `~`. URL fragments are never sent to a
server, so the signalling broker learns the session id and nothing else — it
cannot impersonate either side. Both peers prove they hold the secret via a
nonce challenge before any transfer is accepted, and a four-character code
derived from it is shown on both devices to compare by eye. A link without a
secret still works, and says plainly that it is unverified.

**Every file is checksummed** with a rolling CRC32 as it streams — before
compression outbound, after decompression inbound — and compared on arrival.
A mismatch fails the transfer visibly and refuses to offer the file. It is a
corruption check, not a tamper check, and is not relied on for security.

Only one peer may be connected at a time.

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
| `src/util.js` | Pure helpers: formatting, sizing, CRC32, name and path sanitising |
| `src/device.js` | Capability scoring; the performance budget and layout shape |
| `src/stripe.js` | Parallel data channels and header-free reordering |
| `src/protocol.js` | Wire messages, manifest building, untrusted-input parsing |
| `src/transfer.js` | Stream plumbing: chunked send, sealing, destinations |
| `src/session.js` | Peer lifecycle, reconnection, routing, send/receive machines |
| `src/ui.js` | The only file that touches the DOM |
| `config.js` | Runtime config — not bundled, editable on a live deploy |
| `worker/` | Cloudflare Worker that mints short-lived TURN credentials |
| `sw.js` | Offline shell; cache-first only for fingerprinted assets |
| `build.js` / `test.js` | Bundler and test runner, no dependencies |

## Debugging

`DL.session.active.trace` holds a ring of recent protocol events — every control
message sent, queued and received, plus connection and authentication
transitions. It costs nothing and turns "it didn't connect" into something
answerable without a redeploy.

See [TESTING.md](TESTING.md) for what is verified and what isn't.
