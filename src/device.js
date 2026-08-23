/* Device profiling.
 *
 * One place decides what this machine is and what it can afford, and every
 * other module reads the answer. Nothing here guesses from user-agent strings
 * where a real capability signal exists.
 *
 * Two outputs:
 *   - a performance budget (chunk sizes, watermarks, repaint rate, motion)
 *   - a layout shape (form factor, density) published as attributes on <html>
 *     so CSS can respond without JavaScript touching styles.
 */

var DL = (typeof DL !== 'undefined') ? DL : {};

DL.device = (function () {
  const listeners = [];
  let profile = null;

  const mq = (q) => (typeof matchMedia === 'function' ? matchMedia(q) : { matches: false, addEventListener() {} });

  function readSignals() {
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    const conn = nav.connection || nav.mozConnection || nav.webkitConnection || null;
    const w = typeof innerWidth === 'number' ? innerWidth : 1024;
    const h = typeof innerHeight === 'number' ? innerHeight : 768;

    return {
      memory: nav.deviceMemory || null,          // GB, coarse and capped at 8
      cores: nav.hardwareConcurrency || null,
      effectiveType: conn ? conn.effectiveType : null,   // '4g' | '3g' | '2g' | 'slow-2g'
      downlink: conn ? conn.downlink : null,             // Mbit/s estimate
      rtt: conn ? conn.rtt : null,
      saveData: !!(conn && conn.saveData),
      coarse: mq('(pointer: coarse)').matches,
      hover: mq('(hover: hover)').matches,
      reduceMotion: mq('(prefers-reduced-motion: reduce)').matches,
      width: w,
      height: h,
      landscape: w > h,
      dpr: typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
      battery: batteryState,
      throughput: probeThroughput(),   // MB/s, measured
    };
  }

  // Battery is async and may be unavailable; kept in a slot the sync read uses.
  let batteryState = { level: null, charging: null };

  // Measured, not claimed. navigator.deviceMemory is coarse and, per spec, may
  // be clamped -- it cannot separate a 2 GB netbook from a workstation. Timing
  // real work over a megabyte takes a couple of milliseconds and says what the
  // machine actually does. Cached: the answer does not change.
  let probed = null;

  function probeThroughput() {
    if (probed !== null) return probed;
    try {
      const sample = new Uint8Array(1 << 20);
      for (let i = 0; i < sample.length; i += 977) sample[i] = i & 0xFF;
      const started = performance.now();
      DL.util.crcFinal(DL.util.crcUpdate(DL.util.crcInit(), sample));
      const seconds = (performance.now() - started) / 1000;
      probed = seconds > 0 ? 1 / seconds : null;      // MB/s
    } catch {
      probed = null;
    }
    return probed;
  }

  function watchBattery() {
    if (typeof navigator === 'undefined' || !navigator.getBattery) return;
    navigator.getBattery().then((b) => {
      const sync = () => {
        batteryState = { level: b.level, charging: b.charging };
        recompute();
      };
      b.addEventListener('levelchange', sync);
      b.addEventListener('chargingchange', sync);
      sync();
    }).catch(() => {});
  }

  /* ── tiering ──
     A score, not a lookup table: the same phone is a different machine on a
     dying battery over 3G than it is plugged in on wifi. */

  function tierFor(s) {
    let score = 0;

    if (s.memory !== null) score += s.memory >= 8 ? 2 : s.memory >= 4 ? 1 : s.memory >= 2 ? 0 : -2;

    if (s.cores !== null) {
      score += s.cores >= 16 ? 3 : s.cores >= 8 ? 2 : s.cores >= 4 ? 1 : s.cores >= 2 ? 0 : -2;
    }

    if (s.effectiveType === '4g') score += 1;
    else if (s.effectiveType === '3g') score -= 1;
    else if (s.effectiveType === '2g' || s.effectiveType === 'slow-2g') score -= 3;

    // The measured figure outranks the advertised one where they disagree.
    // Thresholds are set against what this actually achieves in JavaScript --
    // a few hundred MB/s is a healthy machine, not a slow one.
    if (s.throughput !== null) {
      score += s.throughput >= 500 ? 2 : s.throughput >= 250 ? 1 : s.throughput >= 100 ? 0 : -2;
    }

    if (s.saveData) score -= 3;                        // an explicit request
    if (s.battery.level !== null && s.battery.level < 0.2 && !s.battery.charging) score -= 2;

    // 8 GB / 16 cores / 4g / fast scores 8; 4 GB / 4 cores / 4g / average
    // scores 4, which is a mid-range machine and should be treated as one.
    if (score >= 8) return 'ultra';
    if (score >= 6) return 'high';
    if (score >= 2) return 'mid';
    if (score >= -1) return 'low';
    return 'minimal';
  }

  function formFor(s) {
    if (s.width < 600) return 'phone';
    if (s.width < 900 || (s.coarse && !s.hover)) return 'tablet';
    return 'desktop';
  }

  function densityFor(s, form) {
    if (form === 'phone') return s.height < 700 ? 'compact' : 'cosy';
    if (form === 'tablet') return 'cosy';
    return s.height < 760 ? 'cosy' : 'roomy';
  }

  function motionFor(s, tier) {
    if (s.reduceMotion) return 'none';
    if (s.saveData) return 'minimal';
    if (tier === 'low') return 'minimal';
    if (tier === 'minimal') return 'none';
    if (s.battery.level !== null && s.battery.level < 0.2 && !s.battery.charging) return 'minimal';
    return 'full';
  }

  const MB = 1024 * 1024;

  function budgetFor(tier, s) {
    // Every knob that costs memory, CPU or battery scales together, so a weak
    // machine does less work rather than the same work more slowly.
    const table = {
      minimal: { seal: 1 * MB,  watermark: MB / 2, chunkCap: 32 * 1024,  repaintMs: 250, stripes: 1 },
      low:     { seal: 2 * MB,  watermark: 1 * MB, chunkCap: 64 * 1024,  repaintMs: 150, stripes: 2 },
      mid:     { seal: 4 * MB,  watermark: 4 * MB, chunkCap: 192 * 1024, repaintMs: 90,  stripes: 3 },
      high:    { seal: 8 * MB,  watermark: 8 * MB, chunkCap: 256 * 1024, repaintMs: 60,  stripes: 4 },
      ultra:   { seal: 16 * MB, watermark: 16 * MB, chunkCap: 256 * 1024, repaintMs: 45, stripes: 6 },
    }[tier] || {
      seal: 4 * MB, watermark: 4 * MB, chunkCap: 192 * 1024, repaintMs: 90, stripes: 3,
    };

    return {
      ...table,
      // Thumbnails decode a whole image into memory; not worth it on a device
      // that is already tight, or when the user asked us to save data.
      thumbnails: tier !== 'low' && tier !== 'minimal' && !s.saveData,
      qrPixels: tier === 'minimal' || tier === 'low' ? 132 : 148,
    };
  }

  function build() {
    const signals = readSignals();
    const tier = tierFor(signals);
    const form = formFor(signals);
    const density = densityFor(signals, form);
    const motion = motionFor(signals, tier);
    return {
      signals, tier, form, density, motion,
      ...budgetFor(tier, signals),
      // A short human-readable summary, shown in the interface.
      describe() {
        const label = {
          ultra: 'maximum', high: 'high performance', mid: 'balanced',
          low: 'power saving', minimal: 'lightweight',
        }[tier] || 'balanced';
        const bits = [form, label];
        if (signals.saveData) bits.push('data saver');
        return bits.join(' · ');
      },
    };
  }

  function apply(p) {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.dataset.tier = p.tier;
    root.dataset.form = p.form;
    root.dataset.density = p.density;
    root.dataset.motion = p.motion;
  }

  function recompute() {
    const next = build();
    const changed = !profile
      || next.tier !== profile.tier
      || next.form !== profile.form
      || next.density !== profile.density
      || next.motion !== profile.motion;
    profile = next;
    apply(profile);
    if (changed) listeners.forEach((fn) => { try { fn(profile); } catch { /* listener's problem */ } });
    return profile;
  }

  function init() {
    recompute();
    watchBattery();

    if (typeof window !== 'undefined') {
      let resizeTimer = null;
      addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(recompute, 180);
      });
      addEventListener('orientationchange', () => setTimeout(recompute, 120));

      const conn = navigator.connection;
      if (conn && conn.addEventListener) conn.addEventListener('change', recompute);

      mq('(prefers-reduced-motion: reduce)').addEventListener('change', recompute);
      mq('(pointer: coarse)').addEventListener('change', recompute);
    }
    return profile;
  }

  return {
    init,
    recompute,
    onChange(fn) { listeners.push(fn); },
    get profile() { return profile || (profile = build()); },
    // exposed for tests
    _tierFor: tierFor, _formFor: formFor, _densityFor: densityFor,
    _motionFor: motionFor, _budgetFor: budgetFor,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DL.device;
