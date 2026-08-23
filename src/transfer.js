/* Stream plumbing: how bytes leave a file and where they land on arrival.
   Knows nothing about the UI or the peer lifecycle. */

var DL = (typeof DL !== 'undefined') ? DL : {};

DL.transfer = (function () {
  const HAS_SAVE = typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
  const HAS_DIR  = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  const HAS_GZIP = typeof CompressionStream === 'function';

  // Counts bytes past a point in a pipeline without buffering them.
  const meter = (onCount) => new TransformStream({
    transform(chunk, ctrl) { onCount(chunk.byteLength); ctrl.enqueue(chunk); },
  });

  // Blob bytes live outside the JS heap and the browser spills them to disk,
  // so sealing periodically keeps the heap flat however large the file is.
  // Blob bytes live outside the JS heap and the browser spills them to disk,
  // so sealing periodically keeps the heap flat however large the file is.
  //
  // The sealed parts hang off the item rather than off this closure, because a
  // transfer interrupted half way must be able to resume onto the end of what
  // it already has rather than discarding it.
  function sealingSink(item) {
    if (!item.parts) item.parts = [];
    const sealed = item.parts;
    const limit = DL.device.profile.seal;
    let pending = [];
    let bytesPending = 0;

    const seal = () => {
      if (!pending.length) return;
      sealed.push(new Blob(pending));
      pending = [];
      bytesPending = 0;
    };

    return new WritableStream({
      write(chunk) {
        pending.push(chunk);
        bytesPending += chunk.byteLength;
        if (bytesPending >= limit) seal();
      },
      // Closed on a dropped connection as well as on completion, so whatever
      // arrived is retained either way.
      close() { seal(); },
      abort() { seal(); },
    });
  }

  // Called once the item is verified complete.
  function finishBlob(item) {
    if (!item.parts) return null;
    return new Blob(item.parts, { type: item.mime || 'application/octet-stream' });
  }

  // PeerJS hands binary back as ArrayBuffer, Blob or a view depending on
  // browser and version.
  async function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      return new Uint8Array(await data.arrayBuffer());
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
  }

  // Let our own send queue drain before pushing more at the transport. A closed
  // channel never fires bufferedamountlow, so this must not wait on that alone.
  const drain = (channel, low) => new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      channel.removeEventListener('bufferedamountlow', done);
      channel.removeEventListener('close', done);
      channel.removeEventListener('error', done);
      resolve();
    };
    const timer = setTimeout(done, 5000);
    channel.bufferedAmountLowThreshold = low;
    channel.addEventListener('bufferedamountlow', done);
    channel.addEventListener('close', done);
    channel.addEventListener('error', done);
  });

  const SAMPLE = 256 * 1024;

  // Whether to compress used to be a guess from the file's declared type,
  // which is wrong in both directions: a .bin that is already an archive got
  // compressed for nothing, and a .dat of plain text did not get compressed at
  // all. Compress a sample and measure instead. The cost is a few milliseconds
  // on a quarter-megabyte, paid once per file.
  async function shouldCompress(file, mime) {
    if (!DL.util.shouldCompress(mime, file.size, HAS_GZIP)) return false;
    try {
      const { start, end } = DL.util.sampleWindow(file.size, SAMPLE);
      const slice = file.slice(start, end);
      const raw = end - start;
      if (raw <= 0) return false;

      let packed = 0;
      const reader = slice.stream().pipeThrough(new CompressionStream('gzip')).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        packed += value.byteLength;
      }
      return DL.util.worthCompressing(packed / raw);
    } catch {
      return false;   // if the measurement fails, send it plain
    }
  }

  /* ── sending ── */

  async function pumpFile(file, opts) {
    const size = opts.chunkSize;
    const from = opts.from || 0;   // plaintext offset to resume at

    let wire = 0;
    let crc = DL.util.crcInit();

    let chunks = 0;
    const ready = async () => {
      await opts.flow.wait();                       // receiver is behind
      if (!opts.isLive()) throw new Error('connection lost');
    };

    // ── uncompressed: straight from disk to the wire ──
    // Slicing the file directly yields buffers that are already exactly one
    // chunk and already owned by us, so there is no stream to drive, nothing
    // to re-chunk, and no copy before send. Reads run one chunk ahead so disk
    // and network overlap instead of taking turns.
    if (!opts.gzip) {
      const readAt = (off) => file.slice(off, Math.min(off + size, file.size)).arrayBuffer();

      // The checksum covers the whole file, so a resumed transfer still has to
      // account for the prefix it is not sending. Reading it costs disk but no
      // network, and keeps the verification genuinely end to end rather than
      // trusting the receiver's word for the part it already holds.
      for (let off = 0; off < from; off += size) {
        const skip = await readAt(off);
        crc = DL.util.crcUpdate(crc, new Uint8Array(skip));
      }

      let next = from < file.size ? readAt(from) : null;

      for (let off = from; off < file.size; off += size) {
        const buf = await next;
        const following = off + size;
        next = following < file.size ? readAt(following) : null;

        crc = DL.util.crcUpdate(crc, new Uint8Array(buf));
        opts.onProgress(off + buf.byteLength);

        await ready();
        await opts.write(buf);                      // no copy: we own this buffer
        wire += buf.byteLength;
        chunks++;
      }
      return { read: file.size, wire, chunks, crc: DL.util.crcFinal(crc) };
    }

    // ── compressed: the gzip stream decides its own chunk boundaries ──
    // A resumed segment is compressed as its own gzip stream; the receiver
    // decompresses it separately and appends the result.
    //
    // As on the uncompressed path, the checksum covers the whole plaintext, so
    // the prefix that is not being resent still has to be read and hashed.
    for (let off = 0; off < from; off += size) {
      const skip = await file.slice(off, Math.min(off + size, from)).arrayBuffer();
      crc = DL.util.crcUpdate(crc, new Uint8Array(skip));
    }

    let read = from;
    const source = from ? file.slice(from) : file;
    let stream = source.stream().pipeThrough(new TransformStream({
      transform(chunk, ctrl) {
        read += chunk.byteLength;
        crc = DL.util.crcUpdate(crc, chunk);        // hash the plaintext
        opts.onProgress(read);
        ctrl.enqueue(chunk);
      },
    })).pipeThrough(new CompressionStream('gzip'));

    const reader = stream.getReader();
    let pending = new Uint8Array(0);

    const push = async (view) => {
      await ready();
      await opts.write(view.buffer.byteLength === view.byteLength && view.byteOffset === 0
        ? view.buffer
        : view.slice().buffer);
      wire += view.byteLength;
      chunks++;
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending = pending.byteLength ? concat(pending, value) : value;
        let off = 0;
        while (pending.byteLength - off >= size) {
          await push(pending.subarray(off, off + size));
          off += size;
        }
        pending = off ? pending.slice(off) : pending;
      }
      if (pending.byteLength) await push(pending);
    } finally {
      reader.cancel().catch(() => {});
    }

    return { read, wire, chunks, crc: DL.util.crcFinal(crc) };
  }

  function concat(a, b) {
    const out = new Uint8Array(a.byteLength + b.byteLength);
    out.set(a, 0);
    out.set(b, a.byteLength);
    return out;
  }

  /* ── receiving ── */

  // Must be called from a user gesture: the pickers require one. Returns null
  // if the person cancelled, so the caller can leave the offer pending.
  async function chooseDestination(fileItems) {
    if (!fileItems.length) return { kind: 'seal' };

    if (fileItems.length === 1 && HAS_SAVE) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: fileItems[0].name });
        return { kind: 'file', handle };
      } catch (err) {
        if (err && err.name === 'AbortError') return null;
      }
    } else if (fileItems.length > 1 && HAS_DIR) {
      try {
        const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
        return { kind: 'dir', dir };
      } catch (err) {
        if (err && err.name === 'AbortError') return null;
      }
    }
    return { kind: 'seal' }; // no picker, or it failed for a reason other than cancel
  }

  async function sinkFor(dest, item, resuming) {
    try {
      if (dest.kind === 'file' || dest.kind === 'dir') {
        let handle = item.handle;
        if (!handle) {
          if (dest.kind === 'file') {
            handle = dest.handle;
          } else {
            let folder = dest.dir;
            for (const segment of (item.path || [])) {
              folder = await folder.getDirectoryHandle(segment, { create: true });
            }
            handle = await folder.getFileHandle(item.name, { create: true });
          }
          item.handle = handle;
        }
        // Resuming must not truncate what is already on disk, and must land at
        // the offset the receiver reported rather than back at the start.
        const writable = await handle.createWritable({ keepExistingData: !!resuming });
        if (resuming && item.done) await writable.seek(item.done);
        return writable;
      }
    } catch {
      // lost permission, or the name was rejected — fall back rather than fail
    }
    return sealingSink(item);
  }

  return {
    HAS_SAVE, HAS_DIR, HAS_GZIP,
    meter, sealingSink, finishBlob, toBytes, drain, pumpFile, chooseDestination,
    sinkFor, shouldCompress,
  };
})();
