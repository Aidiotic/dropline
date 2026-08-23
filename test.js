#!/usr/bin/env node
/* Unit tests for the pure logic — the parts where a bug is silent rather than
 * loud. Anything needing a real peer connection is verified in the browser
 * instead; see TESTING.md for what that covers and what it doesn't.
 *
 * No test framework: node test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// src/util.js and src/protocol.js are written to avoid browser globals at load
// time precisely so they can be evaluated here.
const context = vm.createContext({
  console, Date, Math, JSON, String, Number, Array, Object,
  Uint8Array, Uint32Array, TextEncoder,
});
for (const file of ['util.js', 'device.js', 'protocol.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'src', file), 'utf8'), context);
}
const { util, protocol, device } = context.DL;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
  }
}

function group(name) { console.log(`\n${name}`); }

// Arrays created inside the vm context belong to a different realm, so
// deepStrictEqual rejects them on prototype identity alone. Normalise first.
const sameList = (actual, expected, msg) =>
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, msg);

/* ── formatting ── */

group('util.bytes');
test('formats below a kilobyte in plain bytes', () => {
  assert.strictEqual(util.bytes(0), '0 B');
  assert.strictEqual(util.bytes(999), '999 B');
});
test('switches to binary units above that', () => {
  assert.strictEqual(util.bytes(1024), '1.0 KB');
  assert.strictEqual(util.bytes(1048576), '1.0 MB');
  assert.strictEqual(util.bytes(1073741824), '1.0 GB');
});
test('drops the decimal once the number is large enough to not need it', () => {
  assert.strictEqual(util.bytes(15 * 1024), '15 KB');
});
test('does not render NaN or negatives as numbers', () => {
  assert.strictEqual(util.bytes(NaN), '—');
  assert.strictEqual(util.bytes(-5), '—');
});

group('util.duration');
test('renders seconds and minutes', () => {
  assert.strictEqual(util.duration(5), '5s');
  assert.strictEqual(util.duration(65), '1m 5s');
  assert.strictEqual(util.duration(120), '2m');
});
test('never claims zero seconds remain', () => {
  assert.strictEqual(util.duration(0.2), '1s');
});

/* ── compression policy ── */

group('util.shouldCompress');
test('compresses text', () => {
  assert.strictEqual(util.shouldCompress('text/plain', 1e6, true), true);
  assert.strictEqual(util.shouldCompress('application/json', 1e6, true), true);
});
test('skips formats that are already compressed', () => {
  for (const mime of ['image/jpeg', 'image/png', 'video/mp4', 'audio/mpeg',
                      'application/zip', 'application/gzip', 'application/x-7z-compressed']) {
    assert.strictEqual(util.shouldCompress(mime, 1e6, true), false, `${mime} should be skipped`);
  }
});
test('treats SVG as text despite the image/ prefix', () => {
  assert.strictEqual(util.shouldCompress('image/svg+xml', 1e6, true), true);
});
test('skips tiny files, where the gzip header costs more than it saves', () => {
  assert.strictEqual(util.shouldCompress('text/plain', 100, true), false);
});
test('skips everything when the browser has no CompressionStream', () => {
  assert.strictEqual(util.shouldCompress('text/plain', 1e6, false), false);
});

/* ── sizing ── */

group('util.sealSize');
test('seals more often on low-memory devices', () => {
  assert.strictEqual(util.sealSize(1), 2 * 1024 * 1024);
  assert.strictEqual(util.sealSize(4), 4 * 1024 * 1024);
  assert.strictEqual(util.sealSize(8), 8 * 1024 * 1024);
});
test('assumes a middling device when the browser will not say', () => {
  assert.strictEqual(util.sealSize(undefined), 4 * 1024 * 1024);
});

group('util.chunkSize');
test('leaves headroom under the transport limit', () => {
  assert.ok(util.chunkSize(65536) <= 65536 - 2048);
});
test('caps at 256 KB even when the transport allows more', () => {
  assert.strictEqual(util.chunkSize(1024 * 1024 * 1024), 256 * 1024);
});
test('stays sane when the transport reports nothing', () => {
  assert.ok(util.chunkSize(undefined) >= 16 * 1024);
});
test('never returns a non-positive size', () => {
  assert.ok(util.chunkSize(1) >= 16 * 1024);
});

/* ── names and paths: the security-relevant bits ── */

group('util.safeName');
test('strips directory separators', () => {
  assert.strictEqual(util.safeName('../../etc/passwd'), 'passwd');
  assert.strictEqual(util.safeName('a\\b\\c.txt'), 'c.txt');
});
test('refuses to produce a dotfile from a traversal attempt', () => {
  assert.strictEqual(util.safeName('...'), 'file');
  assert.strictEqual(util.safeName('.bashrc'), 'bashrc');
});
test('always returns something usable', () => {
  assert.strictEqual(util.safeName(''), 'file');
  assert.strictEqual(util.safeName(null), 'file');
});

group('util.safePath');
test('drops segments that climb out of the target directory', () => {
  sameList(util.safePath('../../secrets'), ['secrets']);
  sameList(util.safePath('a/../../b'), ['a', 'b']);
});
test('keeps ordinary nesting intact', () => {
  sameList(util.safePath('photos/2026/june'), ['photos', '2026', 'june']);
});
test('returns an empty path for flat files', () => {
  sameList(util.safePath(''), []);
  sameList(util.safePath(null), []);
});
test('caps absurd depth', () => {
  assert.ok(util.safePath(Array(50).fill('x').join('/')).length <= 16);
});

group('util.dedupeNames');
test('leaves distinct names alone', () => {
  sameList(util.dedupeNames(['a.txt', 'b.txt']), ['a.txt', 'b.txt']);
});
test('disambiguates collisions before the extension', () => {
  sameList(util.dedupeNames(['a.txt', 'a.txt', 'a.txt']),
           ['a.txt', 'a (1).txt', 'a (2).txt']);
});
test('handles names with no extension', () => {
  sameList(util.dedupeNames(['README', 'README']), ['README', 'README (1)']);
});

/* ── ids ── */

group('util.newId');
test('uses the prefix and avoids look-alike glyphs', () => {
  const id = util.newId('dropline-', (n) => new Uint8Array(n).fill(0));
  assert.ok(id.startsWith('dropline-'));
  assert.ok(!/[loj01]/.test(id.slice(9)), `ambiguous glyph in ${id}`);
});
test('produces a different id for different randomness', () => {
  const a = util.newId('x', (n) => new Uint8Array(n).fill(1));
  const b = util.newId('x', (n) => new Uint8Array(n).fill(2));
  assert.notStrictEqual(a, b);
});

/* ── eta ── */

group('util.eta');
test('estimates from observed rate', () => {
  assert.strictEqual(util.eta(50, 100, 5), 5); // 10/s, 50 left
});
test('declines to guess without data', () => {
  assert.strictEqual(util.eta(0, 100, 0), null);
  assert.strictEqual(util.eta(0, 100, 5), null);
});

/* ── integrity ── */

group('util.crc32');
test('matches the standard check vector', () => {
  // The canonical CRC-32 check value for "123456789".
  const bytes = new Uint8Array([...'123456789'].map((c) => c.charCodeAt(0)));
  assert.strictEqual(util.crc32(bytes) >>> 0, 0xCBF43926);
});
test('is empty-safe', () => {
  assert.strictEqual(util.crc32(new Uint8Array(0)) >>> 0, 0);
});
test('incremental updates equal a single pass', () => {
  const all = new Uint8Array([...'the quick brown fox'].map((c) => c.charCodeAt(0)));
  let state = util.crcInit();
  state = util.crcUpdate(state, all.subarray(0, 4));
  state = util.crcUpdate(state, all.subarray(4, 11));
  state = util.crcUpdate(state, all.subarray(11));
  assert.strictEqual(util.crcFinal(state) >>> 0, util.crc32(all) >>> 0);
});
test('detects a reordered chunk, which is the bug it exists to catch', () => {
  const a = new Uint8Array([1, 2, 3, 4]);
  const b = new Uint8Array([3, 4, 1, 2]);
  assert.notStrictEqual(util.crc32(a), util.crc32(b));
});
test('detects truncation', () => {
  const full = new Uint8Array([9, 8, 7, 6, 5]);
  assert.notStrictEqual(util.crc32(full), util.crc32(full.subarray(0, 4)));
});
test('stays an unsigned 32-bit value', () => {
  const bytes = new Uint8Array([255, 255, 255, 255, 0, 1]);
  const v = util.crc32(bytes);
  assert.ok(v >= 0 && v <= 0xFFFFFFFF, `out of range: ${v}`);
});

group('util.ema');
test('takes the first sample as-is', () => {
  assert.strictEqual(util.ema(null, 100, 0.3), 100);
  assert.strictEqual(util.ema(undefined, 42, 0.3), 42);
});
test('moves toward the new sample without jumping to it', () => {
  const next = util.ema(100, 200, 0.5);
  assert.strictEqual(next, 150);
});
test('recovers from a non-finite previous value', () => {
  assert.strictEqual(util.ema(NaN, 7, 0.3), 7);
});

/* ── device profiling ── */

const sig = (over) => Object.assign({
  memory: 4, cores: 4, effectiveType: '4g', downlink: 10, rtt: 50,
  saveData: false, coarse: false, hover: true, reduceMotion: false,
  width: 1400, height: 900, landscape: true, dpr: 2,
  battery: { level: null, charging: null },
}, over);

group('device.tier');
test('a capable machine on a fast link is high', () => {
  assert.strictEqual(device._tierFor(sig({ memory: 8, cores: 8 })), 'high');
});
test('a weak machine on a slow link is low', () => {
  assert.strictEqual(device._tierFor(sig({ memory: 2, cores: 2, effectiveType: '2g' })), 'low');
});
test('save-data alone drops the tier, whatever the hardware', () => {
  assert.strictEqual(device._tierFor(sig({ memory: 8, cores: 8, saveData: true })), 'mid');
});
test('a mid-range machine is not flattered into the top tier', () => {
  assert.strictEqual(device._tierFor(sig({ memory: 4, cores: 4 })), 'mid');
});
test('a draining battery pushes a borderline device down a tier', () => {
  // Penalises the score rather than overriding it: plenty of headroom absorbs
  // it, a marginal device does not.
  const marginal = sig({ memory: 4, cores: 2 });
  assert.strictEqual(device._tierFor(marginal), 'mid');
  assert.strictEqual(
    device._tierFor({ ...marginal, battery: { level: 0.1, charging: false } }), 'low');
});
test('a draining battery cuts motion even on capable hardware', () => {
  const flat = sig({ memory: 8, cores: 8, battery: { level: 0.1, charging: false } });
  assert.strictEqual(device._tierFor(flat), 'mid', 'top-tier hardware steps down one');
  assert.strictEqual(device._motionFor(flat, 'high'), 'minimal', 'and stops animating');
});
test('charging removes the battery penalty entirely', () => {
  const charging = sig({ memory: 8, cores: 8, battery: { level: 0.1, charging: true } });
  assert.strictEqual(device._tierFor(charging), 'high');
  assert.strictEqual(device._motionFor(charging, 'high'), 'full');
});
test('unknown hardware lands in the middle rather than assuming the worst', () => {
  assert.strictEqual(device._tierFor(sig({ memory: null, cores: null })), 'mid');
});

group('device.form');
test('reads form factor from width', () => {
  assert.strictEqual(device._formFor(sig({ width: 390 })), 'phone');
  assert.strictEqual(device._formFor(sig({ width: 800 })), 'tablet');
  assert.strictEqual(device._formFor(sig({ width: 1400 })), 'desktop');
});
test('a wide touch screen without hover is treated as a tablet', () => {
  assert.strictEqual(device._formFor(sig({ width: 1100, coarse: true, hover: false })), 'tablet');
});

group('device.motion');
test('an explicit reduced-motion preference always wins', () => {
  assert.strictEqual(device._motionFor(sig({ reduceMotion: true }), 'high'), 'none');
});
test('low-end and data-saving devices get minimal motion', () => {
  assert.strictEqual(device._motionFor(sig(), 'low'), 'minimal');
  assert.strictEqual(device._motionFor(sig({ saveData: true }), 'high'), 'minimal');
});

group('device.budget');
test('budgets grow with the tier and never invert', () => {
  const low = device._budgetFor('low', sig());
  const high = device._budgetFor('high', sig());
  assert.ok(low.seal < high.seal);
  assert.ok(low.watermark < high.watermark);
  assert.ok(low.chunkCap < high.chunkCap);
  assert.ok(low.repaintMs > high.repaintMs, 'low tier should repaint less often');
});
test('thumbnails are dropped on low-end and data-saving devices', () => {
  assert.strictEqual(device._budgetFor('low', sig()).thumbnails, false);
  assert.strictEqual(device._budgetFor('high', sig({ saveData: true })).thumbnails, false);
  assert.strictEqual(device._budgetFor('high', sig()).thumbnails, true);
});

/* ── protocol ── */

group('protocol.manifest');
test('assigns stable ids and sanitises names', () => {
  const { items } = protocol.manifest('b1', [
    { kind: 'file', name: '../evil.sh', size: 10, mime: 'text/x-sh' },
  ]);
  assert.strictEqual(items[0].id, 'b1-0');
  assert.strictEqual(items[0].name, 'evil.sh');
});
test('dedupes names within a batch', () => {
  const { items } = protocol.manifest('b1', [
    { name: 'a.txt', size: 1 }, { name: 'a.txt', size: 1 },
  ]);
  assert.strictEqual(items[1].name, 'a (1).txt');
});
test('carries a sanitised relative path', () => {
  const { items } = protocol.manifest('b1', [
    { name: 'x.txt', size: 1, path: 'docs/../notes' },
  ]);
  sameList(items[0].path, ['docs', 'notes']);
});

group('protocol.parse');
test('rejects malformed input rather than throwing', () => {
  assert.strictEqual(protocol.parse('not json'), null);
  assert.strictEqual(protocol.parse('{}'), null);
  assert.strictEqual(protocol.parse(null), null);
  assert.strictEqual(protocol.parse(12), null);
});
test('re-sanitises names arriving from the far end', () => {
  const raw = JSON.stringify({
    t: 'manifest', batchId: 'b', items: [{ id: 'b-0', name: '../../x', size: 1 }],
  });
  assert.strictEqual(protocol.parse(raw).items[0].name, 'x');
});
test('re-sanitises paths arriving from the far end', () => {
  const raw = JSON.stringify({
    t: 'manifest', batchId: 'b', items: [{ id: 'b-0', name: 'x', path: ['..', 'etc'], size: 1 }],
  });
  sameList(protocol.parse(raw).items[0].path, ['etc']);
});
test('refuses an empty or oversized manifest', () => {
  assert.strictEqual(protocol.parse('{"t":"manifest","items":[]}'), null);
  const huge = { t: 'manifest', batchId: 'b', items: Array(501).fill({ id: 'x', name: 'a', size: 1 }) };
  assert.strictEqual(protocol.parse(JSON.stringify(huge)), null);
});
test('coerces a negative size to zero', () => {
  const raw = JSON.stringify({ t: 'manifest', batchId: 'b', items: [{ id: 'b-0', name: 'x', size: -5 }] });
  assert.strictEqual(protocol.parse(raw).items[0].size, 0);
});
test('requires a string body on a text message', () => {
  assert.strictEqual(protocol.parse('{"t":"text","itemId":"a","body":42}'), null);
  assert.ok(protocol.parse('{"t":"text","itemId":"a","body":"hi"}'));
});
test('round-trips the control messages', () => {
  assert.strictEqual(protocol.parse(protocol.hold()).t, 'hold');
  assert.strictEqual(protocol.parse(protocol.go()).t, 'go');
  assert.strictEqual(protocol.parse(protocol.accept('b1')).batchId, 'b1');
  assert.strictEqual(protocol.parse(protocol.begin('i1')).itemId, 'i1');
});

group('protocol.totalBytes');
test('sums files and ignores text', () => {
  assert.strictEqual(protocol.totalBytes([
    { kind: 'file', size: 100 }, { kind: 'file', size: 50 }, { kind: 'text', size: 999 },
  ]), 150);
});

/* ── report ── */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
