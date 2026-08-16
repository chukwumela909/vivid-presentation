/* ============================================================
   Vivid — the dots
   The page is a field of dots and nothing else. They rest as a sphere
   that breathes with the voice, and on a word from the agent they
   rearrange themselves into a word, a shape, or a scatter across the
   whole room — then gather back.

   No dependencies and no build: every dot is placed here, in this file.
   A target (text, a shape, a picture) is drawn to an offscreen canvas,
   turned into a density map, sampled, and relaxed into an even stipple;
   the dots are then matched to that arrangement along a Hilbert curve so
   each dot takes the shortest sensible path and no place goes unfilled.
   The relaxation runs one pass per frame, because it happens while
   someone is mid-sentence and nothing here may stutter.

     Dots.word('hello')        arrange into a word
     Dots.shape('heart')       arrange into a shape
     Dots.burst()              scatter across the whole screen
     Dots.rest()               gather back into the sphere
     Dots.auto(true)           ambient: cycle by itself
     Dots.showing              what is on screen, or null at rest

   Tool registration mirrors tasks.js: the tool is merged into the
   session, never replaces it, and the widget's blind attempt to run a
   tool it has never heard of is rewritten on the way out.
   ============================================================ */
(function () {
  'use strict';

  var Vivid = window.Vivid;

  var DEBUG = /[?&]debug\b/.test(location.search);
  function note() {
    if (!DEBUG) return;
    console.info.apply(console, ['[dots]'].concat([].slice.call(arguments)));
  }

  /* ------------------------------------------------------------
     the room
     ------------------------------------------------------------ */
  var canvas = document.getElementById('dots');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');

  var w = 0, h = 0, dpr = 1;
  var N = 0;                          /* dot count, set from the viewport */

  var MIN_N = 1200, MAX_N = 3000;
  var DOT_R = 1.5;                    /* css px at z = 0 */
  var HOLD_DEFAULT = 6.5;             /* seconds a formation stays before it goes */
  var CAM = 1.9;                      /* perspective distance, in canvas heights */
  var DEPTH_SHADE = 0.42;

  /* ------------------------------------------------------------
     easings — the same curves the python engine uses
     ------------------------------------------------------------ */
  var EASE = {
    linear: function (p) { return p; },
    quad: function (p) { return 1 - (1 - p) * (1 - p); },
    cubic: function (p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; },
    quint: function (p) { return p < 0.5 ? 16 * Math.pow(p, 5) : 1 - Math.pow(-2 * p + 2, 5) / 2; },
    expo: function (p) { return p >= 1 ? 1 : 1 - Math.pow(2, -10 * p); }
  };

  /* ------------------------------------------------------------
     a seeded rng, so a formation is the same every time it is asked for
     ------------------------------------------------------------ */
  function rng(seed) {
    var s = seed >>> 0 || 1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  /* ============================================================
     1 · targets — anything that can be drawn can be a formation
     ============================================================ */

  var raster = document.createElement('canvas');
  var rctx = raster.getContext('2d', { willReadFrequently: true });

  /* Draw into a small offscreen canvas and read it back as weights. Small
     on purpose: the stipple only needs the shape, not the detail. */
  function rasterize(draw, rw, rh) {
    raster.width = rw;
    raster.height = rh;
    rctx.setTransform(1, 0, 0, 1, 0, 0);
    rctx.clearRect(0, 0, rw, rh);
    rctx.fillStyle = '#fff';
    rctx.strokeStyle = '#fff';
    draw(rctx, rw, rh);

    var px = rctx.getImageData(0, 0, rw, rh).data;
    var d = new Float32Array(rw * rh);
    var total = 0;
    for (var i = 0, j = 0; i < d.length; i++, j += 4) {
      /* alpha carries the shape; luminance carries a picture's tone */
      var a = px[j + 3] / 255;
      var lum = a ? (0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2]) / 255 : 0;
      var v = a * lum;
      d[i] = v;
      total += v;
    }
    return total > 0 ? { d: d, w: rw, h: rh } : null;
  }

  function fitFont(rctx2, text, boxW, boxH) {
    /* binary search the size that fills the box */
    var lo = 8, hi = Math.floor(boxH * 1.6), best = 8;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      rctx2.font = '700 ' + mid + 'px ' + FONT;
      var m = rctx2.measureText(text);
      var tw = m.width;
      var th = (m.actualBoundingBoxAscent || mid * 0.72) + (m.actualBoundingBoxDescent || mid * 0.22);
      if (tw <= boxW && th <= boxH) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best;
  }

  var FONT = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

  /* The raster is walked pixel by pixel to build the sampling table, so its
     area — not its width — is the cost. A tall phone screen would otherwise
     make it three times the work of a laptop. */
  var MAX_RASTER = 110000;

  function rasterSize(wide, aspect) {
    var rw = wide, rh = Math.max(100, Math.round(wide * aspect));
    var area = rw * rh;
    if (area > MAX_RASTER) {
      var s = Math.sqrt(MAX_RASTER / area);
      rw = Math.max(120, Math.round(rw * s));
      rh = Math.max(100, Math.round(rh * s));
    }
    return [rw, rh];
  }

  function targetText(text) {
    var size = rasterSize(420, h / Math.max(w, 1));
    var rw = size[0], rh = size[1];
    return rasterize(function (c, W, H) {
      var size = fitFont(c, text, W * 0.88, H * 0.72);
      c.font = '700 ' + size + 'px ' + FONT;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(text, W / 2, H / 2);
    }, rw, rh);
  }

  var SHAPES = {
    circle: function (c, W, H, r) { c.beginPath(); c.arc(W / 2, H / 2, r, 0, 6.2832); c.fill(); },
    ring: function (c, W, H, r) {
      c.beginPath();
      c.arc(W / 2, H / 2, r, 0, 6.2832);
      c.arc(W / 2, H / 2, r * 0.62, 0, 6.2832, true);
      c.fill('evenodd');
    },
    heart: function (c, W, H, r) {
      c.beginPath();
      for (var i = 0; i <= 240; i++) {
        var t = i / 240 * Math.PI * 2;
        var x = 16 * Math.pow(Math.sin(t), 3);
        var y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
        var px = W / 2 + x / 17 * r, py = H / 2 - y / 17 * r + r * 0.06;
        i ? c.lineTo(px, py) : c.moveTo(px, py);
      }
      c.closePath(); c.fill();
    },
    star: function (c, W, H, r) { poly(c, W, H, r, 5, 0.45); },
    triangle: function (c, W, H, r) { poly(c, W, H, r, 3, 0); },
    hexagon: function (c, W, H, r) { poly(c, W, H, r, 6, 0); },
    spiral: function (c, W, H, r) {
      c.lineWidth = r * 0.16;
      c.lineCap = 'round';
      c.beginPath();
      for (var i = 0; i <= 420; i++) {
        var t = i / 420;
        var a = t * 3.2 * Math.PI * 2, rr = t * r;
        var px = W / 2 + rr * Math.cos(a), py = H / 2 + rr * Math.sin(a);
        i ? c.lineTo(px, py) : c.moveTo(px, py);
      }
      c.stroke();
    }
  };

  /* a regular polygon, or a star when `inner` gives the notch radius */
  function poly(c, W, H, r, sides, inner) {
    c.beginPath();
    var steps = inner ? sides * 2 : sides;
    for (var i = 0; i < steps; i++) {
      var a = -Math.PI / 2 + (i * Math.PI * 2) / steps;
      var rad = (!inner || i % 2 === 0) ? r : r * inner;
      var vx = W / 2 + rad * Math.cos(a), vy = H / 2 + rad * Math.sin(a);
      i ? c.lineTo(vx, vy) : c.moveTo(vx, vy);
    }
    c.closePath(); c.fill();
  }

  function targetShape(name) {
    var fn = SHAPES[name];
    if (!fn) return null;
    var rw = 300, rh = 300;
    return rasterize(function (c, W, H) { fn(c, W, H, Math.min(W, H) * 0.40); }, rw, rh);
  }

  function targetImage(img) {
    var size = rasterSize(320, img.height / Math.max(img.width, 1));
    return rasterize(function (c, W, H) { c.drawImage(img, 0, 0, W, H); }, size[0], size[1]);
  }

  /* ============================================================
     2 · density -> an even stipple
     Importance sampling puts dots where the shape is; Lloyd relaxation
     then spreads them evenly so the arrangement reads as placed rather
     than sprinkled.
     ============================================================ */

  function buildCdf(map) {
    var d = map.d, cdf = new Float32Array(d.length), acc = 0;
    for (var i = 0; i < d.length; i++) { acc += d[i]; cdf[i] = acc; }
    return { cdf: cdf, total: acc };
  }

  function samplePoints(map, cdfObj, count, rand, out) {
    var cdf = cdfObj.cdf, total = cdfObj.total, mw = map.w;
    for (var k = 0; k < count; k++) {
      var target = rand() * total;
      /* binary search the pixel that owns this slice of the mass */
      var lo = 0, hi = cdf.length - 1;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (cdf[mid] < target) lo = mid + 1; else hi = mid;
      }
      out[k * 2] = (lo % mw) + rand();
      out[k * 2 + 1] = Math.floor(lo / mw) + rand();
    }
    return out;
  }

  /* A uniform grid over the sites: Lloyd needs a nearest-site query per
     sample per iteration, and a grid is all that costs. */
  function Grid(xs, ys, n, mw, mh) {
    var cell = Math.max(Math.sqrt((mw * mh) / Math.max(n, 1)) * 1.1, 1);
    var cols = Math.max(1, Math.ceil(mw / cell));
    var rows = Math.max(1, Math.ceil(mh / cell));
    var heads = new Int32Array(cols * rows).fill(-1);
    var next = new Int32Array(n).fill(-1);
    for (var i = 0; i < n; i++) {
      var cx = Math.min(cols - 1, Math.max(0, (xs[i] / cell) | 0));
      var cy = Math.min(rows - 1, Math.max(0, (ys[i] / cell) | 0));
      var c = cy * cols + cx;
      next[i] = heads[c];
      heads[c] = i;
    }
    this.cell = cell; this.cols = cols; this.rows = rows;
    this.heads = heads; this.next = next; this.xs = xs; this.ys = ys;
  }

  Grid.prototype.nearest = function (x, y) {
    var cell = this.cell, cols = this.cols, rows = this.rows;
    var cx = Math.min(cols - 1, Math.max(0, (x / cell) | 0));
    var cy = Math.min(rows - 1, Math.max(0, (y / cell) | 0));
    var best = -1, bestD = Infinity;
    for (var ring = 0; ring < Math.max(cols, rows); ring++) {
      for (var gy = cy - ring; gy <= cy + ring; gy++) {
        if (gy < 0 || gy >= rows) continue;
        for (var gx = cx - ring; gx <= cx + ring; gx++) {
          if (gx < 0 || gx >= cols) continue;
          /* only the ring's edge is new */
          if (ring > 0 && gx !== cx - ring && gx !== cx + ring && gy !== cy - ring && gy !== cy + ring) continue;
          for (var i = this.heads[gy * cols + gx]; i !== -1; i = this.next[i]) {
            var dx = this.xs[i] - x, dy = this.ys[i] - y;
            var d2 = dx * dx + dy * dy;
            if (d2 < bestD) { bestD = d2; best = i; }
          }
        }
      }
      /* one more ring than the hit guarantees no closer site was missed */
      if (best !== -1 && bestD <= Math.pow(ring * cell, 2)) break;
    }
    return best;
  };

  /* The relaxation is the expensive part, and it happens while someone is
     mid-sentence — so it is done one pass per frame rather than all at once.
     Six passes in a row would freeze the orb for the best part of a tenth of
     a second; six passes on six frames is invisible. */
  function stippleInit(map, n, seed, iters) {
    var rand = rng(seed);
    var cdfObj = buildCdf(map);
    var pts = samplePoints(map, cdfObj, n, rand, new Float32Array(n * 2));

    var xs = new Float32Array(n), ys = new Float32Array(n);
    for (var i = 0; i < n; i++) { xs[i] = pts[i * 2]; ys[i] = pts[i * 2 + 1]; }

    var M = Math.min(Math.max(n * 8, 5000), 16000);
    return {
      map: map, n: n, xs: xs, ys: ys, iters: iters, done: 0,
      samples: samplePoints(map, cdfObj, M, rand, new Float32Array(M * 2)), M: M,
      sumX: new Float32Array(n), sumY: new Float32Array(n), cnt: new Float32Array(n)
    };
  }

  /* one Lloyd pass: every sample is claimed by its nearest dot, and every dot
     steps to the middle of what it claimed */
  function stippleStep(st) {
    var n = st.n, M = st.M, samples = st.samples;
    var grid = new Grid(st.xs, st.ys, n, st.map.w, st.map.h);
    st.sumX.fill(0); st.sumY.fill(0); st.cnt.fill(0);
    for (var s = 0; s < M; s++) {
      var qx = samples[s * 2], qy = samples[s * 2 + 1];
      var owner = grid.nearest(qx, qy);
      if (owner < 0) continue;
      st.sumX[owner] += qx; st.sumY[owner] += qy; st.cnt[owner]++;
    }
    for (var k = 0; k < n; k++) {
      if (st.cnt[k] > 0) { st.xs[k] = st.sumX[k] / st.cnt[k]; st.ys[k] = st.sumY[k] / st.cnt[k]; }
    }
    st.done++;
    return st.done >= st.iters;
  }

  /* ============================================================
     3 · assignment
     Both point sets are ordered along a Hilbert curve and paired by rank:
     neighbours stay neighbours, so the field slides into place instead of
     criss-crossing, and every target position gets exactly one dot.
     ============================================================ */

  function hilbertD(x, y, order) {
    var rx, ry, d = 0;
    for (var s = order >> 1; s > 0; s = s >> 1) {
      rx = (x & s) > 0 ? 1 : 0;
      ry = (y & s) > 0 ? 1 : 0;
      d += s * s * ((3 * rx) ^ ry);
      /* rotate */
      if (ry === 0) {
        if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
        var t = x; x = y; y = t;
      }
    }
    return d;
  }

  function hilbertOrder(xs, ys, n, minX, minY, span) {
    var ORDER = 1024;                       /* 2^10 cells a side */
    var keys = new Float64Array(n);
    var idx = new Array(n);
    for (var i = 0; i < n; i++) {
      var gx = Math.min(ORDER - 1, Math.max(0, ((xs[i] - minX) / span * (ORDER - 1)) | 0));
      var gy = Math.min(ORDER - 1, Math.max(0, ((ys[i] - minY) / span * (ORDER - 1)) | 0));
      keys[i] = hilbertD(gx, gy, ORDER);
      idx[i] = i;
    }
    idx.sort(function (a, b) { return keys[a] - keys[b]; });
    return idx;
  }

  function assign(ax, ay, bx, by, n) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, i;
    for (i = 0; i < n; i++) {
      if (ax[i] < minX) minX = ax[i]; if (ax[i] > maxX) maxX = ax[i];
      if (ay[i] < minY) minY = ay[i]; if (ay[i] > maxY) maxY = ay[i];
      if (bx[i] < minX) minX = bx[i]; if (bx[i] > maxX) maxX = bx[i];
      if (by[i] < minY) minY = by[i]; if (by[i] > maxY) maxY = by[i];
    }
    var span = Math.max(maxX - minX, maxY - minY, 1e-6);
    var oa = hilbertOrder(ax, ay, n, minX, minY, span);
    var ob = hilbertOrder(bx, by, n, minX, minY, span);
    var perm = new Int32Array(n);
    for (i = 0; i < n; i++) perm[oa[i]] = ob[i];
    return perm;
  }

  /* ============================================================
     4 · the field
     ============================================================ */

  var px, py, pz, pb;                 /* live position + brightness */
  var fx, fy, fz, fb;                 /* where each dot is flying from */
  var tx, ty, tz, tb;                 /* and to */
  var delay, arcX, arcY, arcZ;
  var w1, w2, ph1, ph2;               /* per-dot drift */

  var seg = null;                     /* {t0, t1, ease, alpha0, alpha1} */
  var alpha = 0;                      /* field opacity */
  var resting = true;                 /* showing the sphere, not a formation */
  var level = 0;                      /* voice, eased — fast to rise, slow to fall */
  var phase = 'idle';                 /* mirrors Vivid: idle · connecting · live ... */
  var swirlAmp = 0;                   /* connecting: the field spirals; eased in and out */
  var rgbT0 = -10;                    /* the moment a session connected, for the shimmer */
  var rgbLen = 2.6;                   /* how long the shimmer lasts */
  var lean = { tx: 0, ty: 0, x: 0, y: 0 };   /* the field leans toward the pointer */
  var spin = 0, spin0 = 0;
  var holdUntil = 0;                  /* when the current formation should go */
  var raf = 0;
  var reduceMotion = false;

  function allocate(n) {
    px = new Float32Array(n); py = new Float32Array(n); pz = new Float32Array(n); pb = new Float32Array(n);
    fx = new Float32Array(n); fy = new Float32Array(n); fz = new Float32Array(n); fb = new Float32Array(n);
    tx = new Float32Array(n); ty = new Float32Array(n); tz = new Float32Array(n); tb = new Float32Array(n);
    delay = new Float32Array(n);
    arcX = new Float32Array(n); arcY = new Float32Array(n); arcZ = new Float32Array(n);
    w1 = new Float32Array(n * 3); w2 = new Float32Array(n * 3);
    ph1 = new Float32Array(n * 3); ph2 = new Float32Array(n * 3);

    var rand = rng(9);
    for (var i = 0; i < n * 3; i++) {
      w1[i] = (0.25 + rand() * 0.35) * 6.2832 * 0.5;
      w2[i] = (0.70 + rand() * 0.60) * 6.2832 * 0.5;
      ph1[i] = rand() * 6.2832;
      ph2[i] = rand() * 6.2832;
    }
    /* everything starts as an invisible cloud in the middle */
    scatterInto(px, py, pz, n, 0.34, rng(3));
    for (var k = 0; k < n; k++) pb[k] = 0;
  }

  function scatterInto(ax, ay, az, n, radius, rand) {
    var R = radius * Math.min(w, h);
    for (var i = 0; i < n; i++) {
      var dx, dy, dz, len;
      do {
        dx = rand() * 2 - 1; dy = rand() * 2 - 1; dz = rand() * 2 - 1;
        len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      } while (len < 1e-6 || len > 1);
      var rr = R * Math.cbrt(rand()) / len;
      ax[i] = w / 2 + dx * rr;
      ay[i] = h / 2 + dy * rr * 0.92;
      az[i] = dz * rr * 0.85;
    }
  }

  /* The resting state: a shell of dots where the orb used to be, and the
     rest of the field hanging in the room around it as faint dust. All of
     them are the same dots — the dust is simply the part of the word that
     is not being spelled yet. Fibonacci spacing covers the shell evenly,
     with no seam and no crowded pole. */
  function sphereInto(ax, ay, az, ab, n, rand) {
    var R = 0.185 * Math.min(w, h);
    var GOLD = Math.PI * (1 + Math.sqrt(5));
    var shell = Math.round(n * 0.58);
    var i;

    for (i = 0; i < shell; i++) {
      var k = i + 0.5;
      var phi = Math.acos(1 - 2 * k / shell);
      var theta = GOLD * k;
      var jitter = 0.94 + rand() * 0.12;
      var sinp = Math.sin(phi);
      ax[i] = w / 2 + R * jitter * sinp * Math.cos(theta);
      ay[i] = h / 2 + R * jitter * Math.cos(phi);
      az[i] = R * jitter * sinp * Math.sin(theta);
      if (ab) ab[i] = 0.5 + rand() * 0.32;
    }

    /* the dust: thinner the further it drifts from the middle */
    for (; i < n; i++) {
      var a = rand() * Math.PI * 2;
      var rad = R * (1.35 + Math.pow(rand(), 0.7) * 3.4);
      ax[i] = w / 2 + Math.cos(a) * rad;
      ay[i] = h / 2 + Math.sin(a) * rad * 0.82;
      az[i] = (rand() * 2 - 1) * R * 1.2;
      if (ab) ab[i] = 0.05 + rand() * 0.13;
    }
  }

  function fillInto(ax, ay, az, n, rand) {
    for (var i = 0; i < n; i++) {
      ax[i] = rand() * w;
      ay[i] = rand() * h;
      az[i] = (rand() * 2 - 1) * 0.28 * Math.min(w, h);
    }
  }

  /* ------------------------------------------------------------
     starting a move
     ------------------------------------------------------------ */
  function begin(nextX, nextY, nextZ, nextB, opts) {
    opts = opts || {};
    var dur = opts.duration != null ? opts.duration : 1.7;
    var stagger = opts.stagger != null ? opts.stagger : 0.34;
    var arc = opts.arc != null ? opts.arc : 0.2;
    var rand = rng(opts.seed || 17);
    var now = performance.now() / 1000;

    if (reduceMotion) { dur = Math.min(dur, 0.45); stagger = 0; arc = 0; }

    for (var i = 0; i < N; i++) {
      fx[i] = px[i]; fy[i] = py[i]; fz[i] = pz[i]; fb[i] = pb[i];
      tx[i] = nextX[i]; ty[i] = nextY[i]; tz[i] = nextZ[i];
      tb[i] = nextB ? nextB[i] : 1;
      delay[i] = stagger > 0 ? rand() * stagger : 0;

      if (arc > 0) {
        var dx = tx[i] - fx[i], dy = ty[i] - fy[i];
        var dist = Math.sqrt(dx * dx + dy * dy) || 1;
        var amp = (rand() * 2 - 1) * arc * dist;
        arcX[i] = (-dy / dist) * amp;
        arcY[i] = (dx / dist) * amp;
        arcZ[i] = (rand() * 2 - 1) * arc * 0.6 * dist;
      } else { arcX[i] = arcY[i] = arcZ[i] = 0; }
    }

    seg = {
      t0: now,
      t1: now + dur,
      ease: EASE[opts.easing] || EASE.cubic,
      a0: alpha,
      a1: opts.alpha != null ? opts.alpha : 1,
      spinTo: opts.spin != null ? opts.spin : 0
    };
    spin0 = spin;
    holdUntil = opts.hold === false ? Infinity : now + dur + (opts.hold != null ? opts.hold : HOLD_DEFAULT);
    start();
  }

  /* ------------------------------------------------------------
     the frame
     ------------------------------------------------------------ */
  function frame() {
    raf = requestAnimationFrame(frame);
    var t = performance.now() / 1000;

    stepJob();

    if (seg) {
      var p = Math.min(1, Math.max(0, (t - seg.t0) / (seg.t1 - seg.t0)));
      var ep = seg.ease(p);
      alpha = seg.a0 + (seg.a1 - seg.a0) * ep;
      spin = spin0 + (seg.spinTo - spin0) * ep;

      for (var i = 0; i < N; i++) {
        var d = delay[i];
        var e = seg.ease(Math.min(1, Math.max(0, (p - d) / (1 - d))));
        var bow = Math.sin(Math.PI * Math.min(1, Math.max(0, e)));
        px[i] = fx[i] + (tx[i] - fx[i]) * e + arcX[i] * bow;
        py[i] = fy[i] + (ty[i] - fy[i]) * e + arcY[i] * bow;
        pz[i] = fz[i] + (tz[i] - fz[i]) * e + arcZ[i] * bow;
        pb[i] = fb[i] + (tb[i] - fb[i]) * e;
      }
      if (p >= 1) seg = null;
    }

    draw(t);

    /* a formation that has had its moment leaves on its own */
    if (holdUntil !== Infinity && t > holdUntil && !seg && !job) {
      if (auto.on) next(); else Dots.rest();
    }
  }

  function start() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  /* one white dot, drawn once, stamped everywhere */
  var sprite = document.createElement('canvas');
  (function buildSprite() {
    var S = 32;
    sprite.width = sprite.height = S;
    var s = sprite.getContext('2d');
    var g = s.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.62, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    s.fillStyle = g;
    s.fillRect(0, 0, S, S);
  })();

  /* ...and a ring of coloured ones, for the moment a session connects */
  var HUES = (function () {
    var out = [];
    for (var hdeg = 0; hdeg < 360; hdeg += 30) {
      var c = document.createElement('canvas');
      var S = 32;
      c.width = c.height = S;
      var s = c.getContext('2d');
      var g = s.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      g.addColorStop(0, 'hsla(' + hdeg + ',100%,68%,1)');
      g.addColorStop(0.62, 'hsla(' + hdeg + ',100%,62%,1)');
      g.addColorStop(1, 'hsla(' + hdeg + ',100%,62%,0)');
      s.fillStyle = g;
      s.fillRect(0, 0, S, S);
      out.push(c);
    }
    return out;
  })();

  function draw(t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (alpha <= 0.001) return;

    var cx = w / 2, cy = h / 2;
    var cam = CAM * Math.min(w, h);
    var cosT = Math.cos(spin), sinT = Math.sin(spin);
    var zref = 0.22 * Math.min(w, h);
    var driftAmp = 1.6;

    /* the voice moves it: fast to rise so a consonant lands, slow to fall so
       it does not flicker between syllables. The agent's voice counts for
       more — when it speaks, the sphere visibly expands. */
    lean.x += (lean.tx - lean.x) * 0.045;
    lean.y += (lean.ty - lean.y) * 0.045;

    var mic = Vivid ? Vivid.levels.mic : 0;
    var agent = Vivid ? Vivid.levels.agent : 0;
    var target = Math.max(mic * 0.8, agent * 1.3);
    level += (target - level) * (target > level ? 0.35 : 0.06);

    /* at rest the whole sphere breathes and swells with the voice; a word or
       a shape must keep its proportions, so it only brightens */
    var breath = 1;
    var lift = 1 + level * 0.55;
    if (resting) {
      breath = 1 + 0.022 * Math.sin(t * 1.15) + level * 0.34;
      lift = 1 + level * 0.85;
    }

    /* connecting: the field spirals about the middle — faster toward the
       centre, a vortex — and unwinds again once the line is open */
    swirlAmp += ((phase === 'connecting' ? 1 : 0) - swirlAmp) * 0.05;
    var swirling = swirlAmp > 0.004;
    var swirlR = 0.24 * Math.min(w, h);

    /* the moment it connects: a shimmer of colour wobbles through the
       field, then it settles back to its own white */
    var rgbK = 0;
    var dtRGB = t - rgbT0;
    if (dtRGB >= 0 && dtRGB < rgbLen) rgbK = Math.sin(Math.min(1, dtRGB / rgbLen) * Math.PI);

    /* drift keeps the field alive while it holds a pose */
    var i;
    for (i = 0; i < N; i++) {
      var a = i * 3;
      var dx = (Math.sin(w1[a] * t + ph1[a]) + 0.6 * Math.sin(w2[a] * t + ph2[a])) * 0.625;
      var dy = (Math.sin(w1[a + 1] * t + ph1[a + 1]) + 0.6 * Math.sin(w2[a + 1] * t + ph2[a + 1])) * 0.625;
      var dz = (Math.sin(w1[a + 2] * t + ph1[a + 2]) + 0.6 * Math.sin(w2[a + 2] * t + ph2[a + 2])) * 0.625;

      var x = px[i] + dx * driftAmp - cx;
      var y = py[i] + dy * driftAmp - cy;
      var z = pz[i] + dz * driftAmp;

      if (swirling) {
        var rr = Math.sqrt(x * x + y * y) + 1e-3;
        var ang = swirlAmp * t * 1.15 * (1.5 / (0.35 + rr / swirlR));
        var ca = Math.cos(ang), sa = Math.sin(ang);
        var nx = x * ca - y * sa;
        y = x * sa + y * ca;
        x = nx;
      }

      if (rgbK > 0) {
        /* a radial wobble rides along with the colour */
        var rw2 = Math.sqrt(x * x + y * y) + 1e-3;
        var wob = Math.sin(t * 6 + Math.atan2(y, x) * 3) * 4 * rgbK;
        x += (x / rw2) * wob;
        y += (y / rw2) * wob;
      }

      x *= breath; y *= breath; z *= breath;
      sx[i] = cx + x * cosT + z * sinT + lean.x;
      sy[i] = cy + y + lean.y;
      sz[i] = -x * sinT + z * cosT;
    }

    /* the dots are drawn additively, and addition does not care what order
       it happens in — so there is no depth sort here to pay for. Depth is
       carried by size and brightness alone. */
    ctx.globalCompositeOperation = 'lighter';
    for (i = 0; i < N; i++) {
      var zc = Math.min(sz[i], 0.8 * cam);
      var persp = cam / (cam - zc);
      var znorm = Math.max(-1, Math.min(1, sz[i] / zref));
      var shade = 1 + znorm * DEPTH_SHADE * (znorm > 0 ? 0.35 : 1);
      var av = alpha * pb[i] * shade * lift;
      if (av <= 0.004) continue;
      var r = DOT_R * persp;
      if (rgbK > 0.01) {
        /* colour crossfades in over the white and back out again */
        ctx.globalAlpha = Math.min(1, av * (1 - rgbK * 0.7));
        ctx.drawImage(sprite, sx[i] - r, sy[i] - r, r * 2, r * 2);
        ctx.globalAlpha = Math.min(1, av * rgbK);
        var hue = HUES[(i * 5 + ((t * 9) | 0)) % HUES.length];
        ctx.drawImage(hue, sx[i] - r, sy[i] - r, r * 2, r * 2);
      } else {
        ctx.globalAlpha = Math.min(1, av);
        ctx.drawImage(sprite, sx[i] - r, sy[i] - r, r * 2, r * 2);
      }
    }

    ring(t);

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /* The session clock, drawn the way orb.js drew it — a ring that thins as
     the ten minutes run down — except this one is made of dots too. */
  function ring(t) {
    var S = window.VividSession;
    if (!S || !S.active) return;
    var left = S.left();
    if (left <= 0) return;

    var R = 0.30 * Math.min(w, h) * (1 + level * 0.06);
    var count = 150;
    var upto = Math.floor(count * left);
    var cx = w / 2, cy = h / 2;
    for (var i = 0; i < upto; i++) {
      var a = -Math.PI / 2 + (i / count) * Math.PI * 2;
      var wob = 1 + 0.008 * Math.sin(t * 0.9 + i * 0.35);
      var x = cx + Math.cos(a) * R * wob;
      var y = cy + Math.sin(a) * R * wob;
      /* the leading end fades, so the ring dissolves rather than snaps */
      var edge = Math.min(1, (upto - i) / 14);
      ctx.globalAlpha = alpha * 0.5 * edge;
      ctx.drawImage(sprite, x - 1.1, y - 1.1, 2.2, 2.2);
    }
  }

  var sx = null, sy = null, sz = null;

  /* ------------------------------------------------------------
     layout
     ------------------------------------------------------------ */
  var refit = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    var prevW = w, prevH = h;
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    /* the dot count follows the area... */
    var want = Math.round(Math.min(MAX_N, Math.max(MIN_N, (w * h) / 620)));
    if (want !== N) {
      N = want;
      allocate(N);
      sx = new Float32Array(N); sy = new Float32Array(N); sz = new Float32Array(N);
      buf.x = null;                                  /* sized to the old count */
    }

    /* ...but a formation is laid out in absolute screen coordinates, so it
       has to be re-fitted whenever the room changes shape — not only when
       the count does. A rotation keeps the area (and the count) identical
       while moving every edge, and the clamps mean whole classes of resize
       land on the same count too. Debounced: a drag fires this a hundred
       times and each re-fit is real work. */
    if ((w !== prevW || h !== prevH) && Dots.showing && prevW) {
      clearTimeout(refit);
      refit = setTimeout(function () { replay(Dots.showing, { duration: 0.9 }); }, 180);
    }
  }

  /* whatever is on screen, asked for again — used by resize and auto */
  function replay(spec, opts) {
    if (!spec) return false;
    if (spec.kind === 'burst') return Dots.burst(opts);
    return show(spec, opts);
  }

  /* ============================================================
     5 · what to show
     ============================================================ */

  var buf = { x: null, y: null, z: null, b: null };

  function ensureBuf() {
    if (!buf.x || buf.x.length !== N) {
      buf.x = new Float32Array(N); buf.y = new Float32Array(N);
      buf.z = new Float32Array(N); buf.b = new Float32Array(N);
    }
  }

  /* map a stipple (in raster space) onto the screen, centred and fitted */
  function place(st, n, seed) {
    ensureBuf();
    var map = st.map;
    var pad = 0.86;
    var scale = Math.min((w * pad) / map.w, (h * pad) / map.h);
    var ox = (w - map.w * scale) / 2, oy = (h - map.h * scale) / 2;
    var rand = rng(seed + 5);
    var d = map.d, mw = map.w;

    for (var i = 0; i < n; i++) {
      var x = st.xs[i], y = st.ys[i];
      buf.x[i] = x * scale + ox;
      buf.y[i] = y * scale + oy;
      /* a little depth so the field is a slab, not a sheet */
      buf.z[i] = (rand() * 2 - 1) * Math.min(w, h) * 0.035;
      var pxi = Math.min(mw - 1, Math.max(0, x | 0));
      var pyi = Math.min(map.h - 1, Math.max(0, y | 0));
      var v = d[pyi * mw + pxi];
      buf.b[i] = 0.55 + 0.45 * Math.min(1, v);
    }
    return buf;
  }

  var lastSeed = 11;

  var job = null;                     /* a formation being relaxed, a pass a frame */

  function show(spec, opts) {
    opts = opts || {};
    var map = null;
    if (spec.kind === 'word') map = targetText(String(spec.text || '').trim().slice(0, 40));
    else if (spec.kind === 'shape') map = targetShape(spec.shape);
    else if (spec.kind === 'image') map = targetImage(spec.image);

    if (!map) { note('nothing to show for', spec); return false; }

    lastSeed = (lastSeed * 7 + 13) & 0xffff;
    job = {
      st: stippleInit(map, N, lastSeed, reduceMotion ? 2 : 6),
      opts: opts, seed: lastSeed, n: N
    };
    Dots.showing = spec;
    resting = false;
    start();
    note('showing', spec);
    return true;
  }

  /* one relaxation pass per frame; when the arrangement has settled, the dots
     are matched to it and the move begins */
  function stepJob() {
    if (!job) return;
    if (job.n !== N) { job = null; return; }        /* the room changed size */
    if (!stippleStep(job.st)) return;

    var b = place(job.st, N, job.seed);
    var perm = assign(px, py, b.x, b.y, N);
    var ax = new Float32Array(N), ay = new Float32Array(N),
        az = new Float32Array(N), ab = new Float32Array(N);
    for (var i = 0; i < N; i++) {
      var j = perm[i];
      ax[i] = b.x[j]; ay[i] = b.y[j]; az[i] = b.z[j]; ab[i] = b.b[j];
    }
    var opts = job.opts, seed = job.seed;
    job = null;
    begin(ax, ay, az, ab, {
      duration: opts.duration != null ? opts.duration : 1.7,
      hold: opts.hold,
      seed: seed,
      spin: opts.spin != null ? opts.spin : 0,
      alpha: 1
    });
  }

  /* ============================================================
     6 · auto — the field entertains itself
     ============================================================ */
  var auto = { on: false, i: 0 };

  var LOOP = [
    { kind: 'shape', shape: 'circle' },
    { kind: 'word', text: 'vivid' },
    { kind: 'shape', shape: 'heart' },
    { kind: 'burst' },
    { kind: 'shape', shape: 'spiral' },
    { kind: 'word', text: 'hello' },
    { kind: 'shape', shape: 'star' }
  ];

  function next() {
    replay(LOOP[auto.i++ % LOOP.length], { hold: 5.5 });
  }

  /* ============================================================
     7 · the public face
     ============================================================ */
  var Dots = {
    showing: null,

    word: function (text, opts) {
      if (!text) return false;
      return show({ kind: 'word', text: text }, opts);
    },

    shape: function (name, opts) {
      return show({ kind: 'shape', shape: String(name || '').toLowerCase() }, opts);
    },

    image: function (img, opts) {
      return show({ kind: 'image', image: img }, opts);
    },

    /* every dot flung across the whole screen */
    burst: function (opts) {
      opts = opts || {};
      ensureBuf();
      fillInto(buf.x, buf.y, buf.z, N, rng(41));
      for (var i = 0; i < N; i++) buf.b[i] = 0.5 + 0.5 * (i % 7) / 7;
      Dots.showing = { kind: 'burst' };
      resting = false;
      job = null;
      begin(buf.x, buf.y, buf.z, buf.b, {
        duration: opts.duration != null ? opts.duration : 1.4,
        easing: 'expo',
        arc: 0.1,
        hold: opts.hold != null ? opts.hold : 4,
        alpha: 1
      });
      return true;
    },

    /* Back to the resting sphere — the page's one permanent object, and the
       end of the ambient cycle, since resting is the only "otherwise" the
       agent is given for `auto ... until told otherwise`. */
    rest: function (opts) {
      opts = opts || {};
      auto.on = false;
      job = null;
      ensureBuf();
      sphereInto(buf.x, buf.y, buf.z, buf.b, N, rng(77));
      Dots.showing = null;
      resting = true;
      begin(buf.x, buf.y, buf.z, buf.b, {
        duration: opts.duration != null ? opts.duration : 1.5,
        stagger: 0.28,
        arc: 0.18,
        hold: false,
        alpha: 1
      });
      return true;
    },

    /* kept so `clear` in the tool still reads naturally in code */
    clear: function (opts) { return Dots.rest(opts); },

    auto: function (on) {
      auto.on = on !== false;
      if (auto.on) { auto.i = 0; next(); } else { Dots.rest(); }
      return auto.on;
    },

    shapes: Object.keys(SHAPES),

    get count() { return N; }
  };

  window.Dots = Dots;

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);

  var mq = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  if (mq) {
    reduceMotion = mq.matches;
    if (mq.addEventListener) mq.addEventListener('change', function (e) { reduceMotion = e.matches; });
  }

  resize();
  Dots.rest();                        /* the dots gather into the sphere on load */

  /* ============================================================
     input and voice — the button, the line of type, the announcements.
     All of this used to live in orb.js; the orb is gone and the dots
     inherited it, unchanged in behaviour.
     ============================================================ */
  var button = document.getElementById('tap');
  var hint = document.getElementById('hint');
  var live = document.getElementById('live');

  if (button) {
    button.addEventListener('click', function () {
      if (Vivid) Vivid.tap();
    });
  }

  /* the field leans a little towards the pointer — enough to feel watched,
     not enough to notice it moving */
  window.addEventListener('pointermove', function (ev) {
    if (ev.pointerType === 'touch') return;
    lean.tx = ((ev.clientX - w / 2) / w) * 22;
    lean.ty = ((ev.clientY - h / 2) / h) * 16;
    start();
  });

  var HINT = {
    idle: 'tap to talk',
    error: 'allow the microphone, then tap again'
  };

  var SAID = {
    connecting: 'Connecting',
    listening: 'Listening',
    thinking: 'Thinking',
    speaking: 'Vivid is speaking',
    idle: 'Session ended. Tap to talk again.',
    error: 'Could not start. Allow microphone access and tap again.'
  };

  if (Vivid) {
    Vivid.on('phase', function (change) {
      if (hint) hint.textContent = HINT[change.phase] || HINT.idle;
      if (live && SAID[change.phase]) live.textContent = SAID[change.phase];

      /* the hint is the button's only visible label and it fades out once a
         call starts, so the accessible name has to carry it from there */
      if (button) {
        button.setAttribute('aria-label',
          change.state === 'live' || change.state === 'connecting'
            ? 'End the conversation'
            : 'Talk to Vivid');
      }
    });
  }

  /* under ?debug, the transient states can be forced, for eyes and for tests */
  if (DEBUG) {
    Dots._debug = {
      shimmer: function (secs) { rgbLen = secs || 2.6; rgbT0 = performance.now() / 1000; },
      phase: function (p) { phase = p; }
    };
  }

  /* the session's moods, straight onto the field: connecting spirals,
     the moment of connection shimmers, speaking swells (via levels above) */
  if (Vivid) {
    Vivid.on('phase', function (change) {
      var wasConnecting = phase === 'connecting';
      phase = change.state === 'connecting' ? 'connecting' : change.state;
      if (wasConnecting && change.state === 'live') rgbT0 = performance.now() / 1000;
      start();
    });
  }

  /* ============================================================
     8 · the agent's hands
     Same seam as tasks.js: merge the tool into the session, answer the
     widget's blind tool call on the way out.
     ============================================================ */
  if (!Vivid) return;

  var TOOL = {
    type: 'function',
    name: 'show_dots',
    description:
      'You are made of dots on their screen — a sphere of them, breathing with your voice. This rearranges them: ' +
      'into a word, a shape, a scatter across the room, or back into the sphere. Use it to make a point visible: ' +
      'a word they should remember, a heart when you are being warm, a burst when something lands. It is your body, ' +
      'not your speech: never announce it, never read the word out loud, never mention dots. Use it sparingly, at ' +
      'most once every few turns; it returns to the sphere on its own.',
    parameters: {
      type: 'object',
      properties: {
        show: {
          type: 'string',
          enum: ['word', 'shape', 'burst', 'auto', 'rest'],
          description:
            'word — the dots spell something (give text). shape — they form a shape (give shape). ' +
            'burst — they scatter across the whole screen. auto — they cycle on their own until told otherwise. ' +
            'rest — they gather back into the sphere, which is where they live when nothing is being shown.'
        },
        text: {
          type: 'string',
          description:
            'word only: ANY text you choose — whatever the moment calls for. A name, a number, a place, ' +
            'the word you just landed on. Nothing is preset and nothing is off limits: you decide it as ' +
            'you speak. Up to 40 characters, though one or two words reads best on screen.'
        },
        shape: {
          type: 'string',
          enum: ['circle', 'ring', 'heart', 'star', 'spiral', 'hexagon', 'triangle'],
          description: 'shape only: which shape to form.'
        }
      },
      required: ['show'],
      additionalProperties: false
    }
  };

  var NOTE = [
    'On their screen you are a sphere of dots that moves with your voice. The show_dots tool rearranges those dots',
    'into a word, a shape, a burst, or back to the sphere. Use it now and then for emphasis, never narrate it, never',
    'say the words "dots", "screen", "show" or "tool" out loud, and never read out what it spells. Keep talking as normal.'
  ].join(' ');

  var attempts = 0;
  var results = {};

  Vivid.on('open', function () { attempts = 0; results = {}; });

  Vivid.on('event', function (event) {
    if (event.type === 'session.updated') return register(event.session || {});
    if (event.type === 'response.done') harvest(event.response || {});
  });

  /* Not a one-shot: tasks.js amends the session on the same session.updated
     we do, and both patches are built from that same (pre-amendment) session,
     so whichever lands second would drop the other's tool. Re-adding ourselves
     whenever we are missing converges instead — each update echoes back a
     fuller session, and we stop as soon as show_dots is in it. */
  function register(session) {
    var tools = Array.isArray(session.tools) ? session.tools.slice() : [];
    var has = tools.some(function (t) { return t && t.name === TOOL.name; });
    if (has || attempts >= 4) return;
    attempts++;

    var patch = {};
    if (session.type) patch.type = session.type;

    var base = typeof session.instructions === 'string' ? session.instructions.trim() : '';
    patch.instructions = !base ? NOTE
      : base.indexOf(NOTE) !== -1 ? base          /* already carried over */
      : base + '\n\n' + NOTE;

    tools.push(TOOL);
    patch.tools = tools;
    patch.tool_choice = 'auto';

    Vivid.send({ type: 'session.update', session: patch });
    note('show_dots joined the session (attempt ' + attempts + ', ' + tools.length + ' tools)');
  }

  function harvest(response) {
    var output = Array.isArray(response.output) ? response.output : [];
    output.forEach(function (item) {
      if (!item || item.type !== 'function_call' || item.name !== TOOL.name) return;

      var args = {};
      try { args = JSON.parse(item.arguments || '{}'); } catch (err) {}

      results[item.call_id] = run(args) ? 'Done.' : 'Nothing shown.';
    });
  }

  function run(args) {
    switch (args.show) {
      case 'word': return Dots.word(args.text);
      case 'shape': return Dots.shape(args.shape || 'circle');
      case 'burst': return Dots.burst();
      case 'auto': return Dots.auto(true);
      case 'rest': case 'clear': return Dots.rest();
      default: return false;
    }
  }

  /* the widget will POST show_dots to an endpoint that has never heard of
     it; swap the failure for our answer before it reaches the model */
  Vivid.onOutgoing(function (event) {
    if (event.type === 'conversation.item.create' &&
        event.item && event.item.type === 'function_call_output') {
      var result = results[event.item.call_id];
      if (result) {
        delete results[event.item.call_id];
        event.item.output = result;
      }
    }
    return event;
  });

  /* a session that ends puts the room back to the resting sphere */
  Vivid.on('phase', function (change) {
    if (change.state === 'live' || change.state === 'connecting') return;
    auto.on = false;
    if (Dots.showing) Dots.rest();
    results = {};
  });
})();
