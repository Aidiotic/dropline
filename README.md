# dropline

Send a file straight from your browser to someone else's. The bytes travel over
a WebRTC data channel — they never land on a server, so there is nothing to
host, nothing to pay for, and nothing to delete afterwards.

**Live at [aidiotic.github.io/dropline](https://aidiotic.github.io/dropline/)**

## How it works

1. You pick a file. The page mints a random peer id and shows a link and a QR code.
2. Your friend opens the link, or scans the code with a phone.
3. They accept, and the file streams across with a progress bar on both ends.

A signalling server (PeerJS's free public broker) is used only to introduce the
two browsers. It sees the peer id and the connection handshake — never the file,
never its name.

## The catch

**Both tabs must be open at the same time.** There is no storage anywhere, so if
you close your tab the link goes dead. This is a live handoff, not a dropbox.

The other real limit: roughly 10–20% of network pairs — typically two symmetric
NATs, or strict corporate firewalls — cannot form a direct connection. Fixing
that requires a TURN relay, which is the one piece that genuinely costs money.
Without one, those transfers fail to connect at all.

One file per link. Zip a folder if you need to send several.

## Why it's fast

Nothing here is buffered whole. The file is a stream from end to end:

```
sender     File.stream() → [gzip] → re-chunk → data channel
receiver   data channel → [gunzip] → disk, or sealed Blobs → download
```

Three things do the work:

- **Chunk size is negotiated, not guessed.** The sender reads
  `RTCPeerConnection.sctp.maxMessageSize` and sends the largest message the
  transport will take — 256 KB on current browsers, against the 64 KB that is
  usually hard-coded. Fewer, larger messages means less per-message overhead.
- **Compressible files are gzipped in flight** via `CompressionStream`, and
  decompressed on the fly at the other end. Text, CSV, logs and JSON often move
  in a fraction of their real size. Formats that are already compressed —
  images, video, audio, archives — skip this, because running them through gzip
  costs CPU and saves nothing.
- **The receiver never holds the file in the heap.** Where the File System
  Access API exists it writes straight to disk, which is why receiving takes an
  explicit click — `showSaveFilePicker()` requires a user gesture. Everywhere
  else, chunks are sealed into Blobs every few megabytes; Blob bytes live
  outside the JS heap and the browser spills them to disk, so memory stays flat
  there too. The seal interval follows `navigator.deviceMemory`, 2 MB to 8 MB.

Two layers of backpressure, and both are needed. `bufferedAmount` stops a fast
disk outrunning a slow network, but it only describes the *sender's* own queue —
it cannot see a receiver that is slower at writing than the channel is at
delivering. So the receiver also queues by byte length against a 4 MB watermark
and sends hold/go back over the data channel. Without that second layer a 64 MB
transfer grew the receiver's heap by 118 MB; with it, the steady state sits
around 15 MB regardless of file size.

Progress repaints are throttled to ~15/second — at 100 MB/s a chunk lands every
few milliseconds, and repainting on each one is itself enough to slow the
transfer down.

An earlier version streamed the non-FSA path through a service worker instead.
It was dropped: browsers treat the synthetic download it produced with
suspicion — Chrome was observed silently refusing them — whereas a sealed Blob
is offered as an ordinary link the user clicks, which is a trusted gesture.
The sealing approach is taken from *Beam*, a LAN QR-transfer app.

## Running it locally

Four static files, no build step:

```bash
npx serve .
```

WebRTC and the clipboard API both need a secure context, so use the `localhost`
URL it prints — opening `index.html` as a `file://` path will not work.

## Deploying

Any static host will serve it. It is on GitHub Pages from `main` at the repo
root with no build step.

One wrinkle worth knowing: Pages serves assets with `cache-control: max-age=600`,
so `index.html` references `app.js?v=N` and `style.css?v=N`. **Bump `N` when you
change either file**, or returning visitors will run up to ten minutes of stale
code against fresh markup.

## Layout

| File | What's in it |
| --- | --- |
| `index.html` | Markup for all four panels (pick / share / receive / error) |
| `style.css` | Flat cream-and-ink theme, light and dark |
| `app.js` | Peer setup, the streaming pipelines, QR rendering |
| `updates.html` | Release log and roadmap, served at `/updates.html` |
