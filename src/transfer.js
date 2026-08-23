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
    const limit = DL.util.sealSize(typeof navigator !== 'undefined' ? navigator.deviceMemory : 4);
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

  async function pumpFile(conn, file, opts) {
    const sctp = conn.peerConnection && conn.peerConnection.sctp;
    const size = DL.util.chunkSize(sctp && sctp.maxMessageSize);
    const high = Math.max(1 << 20, size * 8);
    const channel = conn.dataChannel;

    let read = 0;
    let wire = 0;
    let crc = DL.util.crcInit();

    // Checksummed before compression so both ends hash the same plaintext.
    let stream = file.stream().pipeThrough(new TransformStream({
      transform(chunk, ctrl) {
        read += chunk.byteLength;
        crc = DL.util.crcUpdate(crc, chunk);
        opts.onProgress(read);
        ctrl.enqueue(chunk);
      },
    }));
    if (opts.gzip) stream = stream.pipeThrough(new CompressionStream('gzip'));

    const reader = stream.getReader();
    let pending = new Uint8Array(0);

    const push = async (view) => {
      await opts.flow.wait();                       // receiver is behind
      if (channel && channel.bufferedAmount > high) await drain(channel, high >> 1);
      if (!opts.isLive()) throw new Error('connection lost');
      conn.send(view.slice().buffer);               // copy: view aliases a reused buffer
      wire += view.byteLength;
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

    return { read, wire, crc: DL.util.crcFinal(crc) };
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
