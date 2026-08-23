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
  function sealingSink(mime, onFinished) {
    const sealed = [];
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
      close() {
        seal();
        onFinished(new Blob(sealed, { type: mime || 'application/octet-stream' }));
      },
      abort() { pending = []; sealed.length = 0; },
    });
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

  // Let our own send queue drain before pushing more at the transport.
  const drain = (channel, low) => new Promise((resolve) => {
    channel.bufferedAmountLowThreshold = low;
    channel.addEventListener('bufferedamountlow', resolve, { once: true });
  });

  /* ── sending ── */

  async function pumpFile(file, opts) {
    const size = opts.chunkSize;

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
      let next = file.size ? readAt(0) : null;

      for (let off = 0; off < file.size; off += size) {
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
    let read = 0;
    let stream = file.stream().pipeThrough(new TransformStream({
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

  async function sinkFor(dest, item, onBlob) {
    try {
      if (dest.kind === 'file') return await dest.handle.createWritable();
      if (dest.kind === 'dir') {
        let folder = dest.dir;
        for (const segment of (item.path || [])) {
          folder = await folder.getDirectoryHandle(segment, { create: true });
        }
        const fh = await folder.getFileHandle(item.name, { create: true });
        return await fh.createWritable();
      }
    } catch {
      // lost permission, or the name was rejected — fall back rather than fail
    }
    return sealingSink(item.mime, onBlob);
  }

  return {
    HAS_SAVE, HAS_DIR, HAS_GZIP,
    meter, sealingSink, toBytes, drain, pumpFile, chooseDestination, sinkFor,
  };
})();
