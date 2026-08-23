# Testing

Two layers, and it is worth being precise about which claims each one actually
supports.

## Automated: `npm test`

65 unit tests over the pure logic in `src/util.js`, `src/device.js` and
`src/protocol.js` — the parts where a bug is silent rather than loud. They run
in CI on every push, alongside `npm run check`, which fails if the committed
bundle no longer matches `src/`.

Covered:

- Byte and duration formatting, including `NaN` and negative input.
- Compression policy: that text is compressed, that already-packed formats are
  skipped, that SVG counts as text, and that tiny files skip it.
- The measured compression decision: that a marginal ratio is refused because
  both ends pay for it, that an expanding ratio is refused, that nonsense input
  is refused rather than guessed at, and that the sample window skips the
  container header without reading past the end of the file.
- Chunk sizing against the transport limit, and seal sizing per device tier.
- **Name and path sanitising**, in both directions. `../../etc/passwd` becomes
  `passwd`; `a/../../b` becomes `a/b`; depth is capped; colliding names are
  disambiguated instead of overwriting.
- **Malformed and hostile messages**: bad JSON, missing fields, wrong types, an
  empty manifest, a 501-item manifest, negative sizes. These must return `null`
  rather than throw inside an event handler.
- **CRC32** against the canonical `123456789` → `0xCBF43926` check vector, plus
  the cases it exists to catch: a reordered chunk and a truncated stream must
  both produce a different value, and incremental updates must equal one pass.
- **Device tiering**: that save-data alone drops a tier, that a draining battery
  penalises rather than overrides, that charging removes the penalty, that
  unknown hardware lands mid-range rather than assuming the worst, and that
  budgets never invert between tiers.

Not covered here: anything needing a real peer connection, a real stream, or a
DOM. `src/session.js`, `src/transfer.js` and `src/ui.js` have no unit tests —
they are exercised in the browser instead.

## Manual: two real browsers against the deployed site

Verified for v1.0 by driving two tabs on the live site and comparing SHA-256
digests on both ends:

| Case | Result |
| --- | --- |
| 4 files, 5.1 MB, one nested in `archive/2026/` | All four digests matched |
| Duplicate filename in one batch | Arrived as `report (1).txt`, both correct |
| Folder path preservation | `archive/2026/notes.bin` rebuilt on arrival |
| Guest → host, 1 MB | Digest matched — both directions work |
| Text snippet | Body arrived intact with a copy button |
| Compression | 840 KB of text moved as 2.5 KB on the wire |
| Compression skipped | `image/png` sent uncompressed, as intended |
| Reconnect | Guest reloaded; host re-paired and a later transfer matched |
| Memory | 96 MB file received with a median heap of 15 MB |
| Backpressure | 64 MB grew the heap 118 MB before flow control, 55 MB after |
| Corruption caught | One byte flipped in flight → failed with a checksum mismatch, no download offered |
| Authentication | Both ends showed the same code and reported verified |
| Striped transfer | 64 MB over 4 channels, SHA-256 matched and CRC verified |
| Two guests at once | One send reached both; identical digests on each |
| Resume | 160 MB severed at 3%, reconnected and resumed; digest matched |
| Multi-file batch | 3 files incl. a nested folder and gzipped text, all matched |
| Capability probe | 400 MB/s measured; tier and stripe count followed |
| Settings | Theme, motion, performance and auto-accept persist across reload |

## Performance measurements

All over loopback between two tabs, which isolates CPU cost rather than network:

| Configuration | Throughput |
| --- | --- |
| v1.1 baseline, single channel, BinaryPack | 8.7 MB/s |
| After raw serialization + zero-copy send | 10.5 MB/s |
| A *raw* data channel with no application logic | 10.5 MB/s |
| 2 striped channels | 14.1 MB/s |
| 4 striped channels (current default) | 15.0 MB/s |
| 8 striped channels | 16.0 MB/s |

The third row is the important one: once the engine matched a bare data channel,
everything above the transport had been paid for, and the remaining limit was
SCTP itself. That is what justified striping rather than further micro-tuning.

Loopback numbers are not representative of a real link — both peers are on one
machine — and should be read as a ceiling on our own overhead, not as a
transfer speed anyone will see.

## What is *not* verified

Being blunt about the gaps, because they are the ones most likely to bite:

- **Only one browser engine.** Every check above ran in Chromium. The Firefox
  and Safari paths are exercised by deleting `showSaveFilePicker` and
  `showDirectoryPicker` at runtime to force the fallback, which proves the
  fallback *code* works — it is not the same as running on those engines.
- **No real iOS device.** The QR code exists to be scanned by a phone, and the
  phone is where memory limits and background-tab eviction are harshest.
- **No TURN path.** There is no relay deployed, so relayed connections have
  never been exercised end to end.
- **No test of two peers on genuinely different networks.** Both tabs sit on one
  machine, which means loopback: throughput numbers from these runs are not
  representative of a real link, and NAT traversal is never actually stressed.
- **Reconnect is only tested by reloading a tab.** A phone sleeping, a network
  changing, or a flaky link may behave differently.

## Reproducing the browser checks

1. Open the site in two tabs; copy the link from the first into the second.
2. In the receiving tab's console, `delete window.showSaveFilePicker;
   delete window.showDirectoryPicker;` to force the sealing path.
3. Build a file with known content, send it with
   `DL.session.active.sendFiles([...])`, accept in the other tab.
4. Fetch the resulting download link and compare `crypto.subtle.digest`
   against the source.

`DL.session.active` is exposed for exactly this.
