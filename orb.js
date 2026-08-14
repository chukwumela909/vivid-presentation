/* ============================================================
   Vivid — the orb
   A sphere of light on a black screen, lit by the call itself: the
   surface deforms on harmonics whose amplitude is the live audio level,
   rings leave it when the visitor speaks, and the remaining time is a
   thinning arc around it.

   Nothing here talks to the network. It reads Vivid (levels, phase) and
   VividSession (time left) and paints.
   ============================================================ */
(function () {
  'use strict';

  var Vivid = window.Vivid;
  if (!Vivid) return;

  var canvas = document.getElementById('orb');
  var button = document.getElementById('tap');
  var hint = document.getElementById('hint');
  var live = document.getElementById('live');
  var ctx = canvas.getContext('2d', { alpha: false });

  var CALM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- the room ---------- */
  var VOID = '#050506';
  var LIFT = 'rgba(24, 25, 33, 1)';

  /* ---------- light, per phase ----------
     All within a few degrees of white; the difference is felt more than
     seen, which is the point. */
  var TINT = {
    idle:       [226, 231, 246],
    connecting: [214, 222, 244],
    listening:  [222, 234, 255],
    thinking:   [232, 230, 250],
    speaking:   [255, 248, 240],
    error:      [150, 150, 156]
  };

  /* ---------- surface ----------
     Four harmonics: the low ones give the shape its slow roll, the high
     ones catch consonants. */
  var HARMONICS = [
    { k: 2, a: 0.056, w:  0.34, p: 0.0 },
    { k: 3, a: 0.030, w: -0.27, p: 1.7 },
    { k: 5, a: 0.015, w:  0.21, p: 3.1 },
    { k: 7, a: 0.008, w: -0.17, p: 0.6 }
  ];

  var STEPS = 168;

  /* light adrift inside the sphere, on slow incommensurable orbits so the
     pattern never repeats within a session */
  var LOBES = [
    { u:  0.23, v:  0.17, p: 0.0, reach: 0.30, size: 0.62, lit: 0.10 },
    { u: -0.19, v:  0.26, p: 2.1, reach: 0.38, size: 0.46, lit: 0.075 },
    { u:  0.13, v: -0.21, p: 4.3, reach: 0.24, size: 0.72, lit: 0.055 }
  ];

  /* ---------- state ---------- */
  var w = 0, h = 0, dpr = 1;
  var cx = 0, cy = 0, R = 100;

  var tint = TINT.idle.slice();
  var energy = 0;            /* smoothed level, whoever is talking */
  var presence = 0;          /* 0 asleep, 1 in a call — everything scales by it */
  var press = 0;             /* pointer-down dip */
  var sweep = 0;             /* connecting arc */
  var glow = 0;              /* thinking shimmer */
  var drift = { x: 0, y: 0, tx: 0, ty: 0 };

  var rings = [];
  var lastRing = 0;
  var micWas = 0;
  var agentWas = 0;

  var t0 = performance.now();
  var last = t0;

  /* ============================================================
     size
     ============================================================ */
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    cx = w / 2;
    cy = h / 2;

    var vmin = Math.min(w, h);
    R = Math.max(76, Math.min(vmin * (vmin < 620 ? 0.21 : 0.155), 220));

    grain = null;   /* retile for the new size */
  }

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);

  /* ============================================================
     grain
     A single tile of noise, drawn over everything at a whisper. Without
     it, large soft gradients band badly on dark screens.
     ============================================================ */
  var grain = null;

  function tile() {
    var size = 128;
    var off = document.createElement('canvas');
    off.width = off.height = size;
    var g = off.getContext('2d');
    var img = g.createImageData(size, size);

    for (var i = 0; i < img.data.length; i += 4) {
      var v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }

    g.putImageData(img, 0, 0);
    return ctx.createPattern(off, 'repeat');
  }

  /* ============================================================
     input
     ============================================================ */
  button.addEventListener('click', function () {
    Vivid.tap();
  });

  button.addEventListener('pointerdown', function () { press = 1; });
  window.addEventListener('pointerup', function () { press = 0; });
  window.addEventListener('pointercancel', function () { press = 0; });

  /* the orb leans a little towards the pointer — enough to feel watched,
     not enough to notice it moving */
  window.addEventListener('pointermove', function (ev) {
    if (ev.pointerType === 'touch') return;
    drift.tx = ((ev.clientX - cx) / w) * 26;
    drift.ty = ((ev.clientY - cy) / h) * 20;
  });

  /* ============================================================
     phase
     ============================================================ */
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

  Vivid.on('phase', function (change) {
    if (hint) hint.textContent = HINT[change.phase] || HINT.idle;
    if (live && SAID[change.phase]) live.textContent = SAID[change.phase];

    /* the hint is the button's only visible label and it fades out once a
       call starts, so the accessible name has to carry it from there */
    button.setAttribute('aria-label', change.state === 'live' || change.state === 'connecting'
      ? 'End the conversation'
      : 'Talk to Vivid');

    if (change.phase === 'idle' || change.phase === 'error') rings.length = 0;
  });

  /* ============================================================
     frame
     ============================================================ */
  function frame(now) {
    requestAnimationFrame(frame);

    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    var t = (now - t0) / 1000;

    step(dt, t);
    paint(t);
  }

  function step(dt, t) {
    var phase = Vivid.phase;
    var mic = Vivid.levels.mic;
    var agent = Vivid.levels.agent;

    /* whoever holds the turn drives the surface */
    var target =
      phase === 'speaking' ? agent :
      phase === 'listening' ? mic * 0.85 :
      phase === 'thinking' ? 0.16 + Math.sin(t * 2.4) * 0.05 :
      phase === 'connecting' ? 0.1 : 0;

    energy += (target - energy) * Math.min(1, dt * (target > energy ? 16 : 5));

    var awake = phase !== 'idle' && phase !== 'error' ? 1 : 0;
    presence += (awake - presence) * Math.min(1, dt * 3.2);

    sweep += dt * (phase === 'connecting' ? 2.6 : 0.5);
    glow += ((phase === 'thinking' ? 1 : 0) - glow) * Math.min(1, dt * 4);

    drift.x += (drift.tx - drift.x) * Math.min(1, dt * 2.4);
    drift.y += (drift.ty - drift.y) * Math.min(1, dt * 2.4);

    var to = TINT[phase] || TINT.idle;
    for (var i = 0; i < 3; i++) tint[i] += (to[i] - tint[i]) * Math.min(1, dt * 2.6);

    /* rings leave the orb on the attack of a phrase, not on every sample */
    var onset = phase === 'listening' ? mic - micWas : phase === 'speaking' ? (agent - agentWas) * 0.7 : 0;
    var loud = phase === 'listening' ? mic : agent;
    micWas = mic;
    agentWas = agent;

    if (!CALM && onset > 0.055 && loud > 0.12 && t - lastRing > 0.22 && rings.length < 7) {
      lastRing = t;
      rings.push({ born: t, force: Math.min(1, loud * 1.5) });
    }

    for (var j = rings.length - 1; j >= 0; j--) {
      if (t - rings[j].born > 1.9) rings.splice(j, 1);
    }
  }

  function paint(t) {
    var rgb = tint[0].toFixed(0) + ',' + tint[1].toFixed(0) + ',' + tint[2].toFixed(0);

    /* ---------- room ---------- */
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = VOID;
    ctx.fillRect(0, 0, w, h);

    var room = ctx.createRadialGradient(cx, cy * 0.94, 0, cx, cy * 0.94, Math.max(w, h) * 0.72);
    room.addColorStop(0, LIFT);
    room.addColorStop(1, VOID);
    ctx.fillStyle = room;
    ctx.fillRect(0, 0, w, h);

    var x = cx + drift.x;
    var y = cy + drift.y;

    /* breathing carries the idle state; the call takes over from there */
    var breath = CALM ? 0 : Math.sin(t * 1.14) * 0.022 + Math.sin(t * 0.41) * 0.012;
    var scale = 1 + breath + energy * 0.15 - press * 0.03;
    var r = R * scale;

    ctx.globalCompositeOperation = 'lighter';

    /* ---------- halo ---------- */
    var reach = r * (1.9 + energy * 1.6 + presence * 0.4);
    var halo = ctx.createRadialGradient(x, y, r * 0.5, x, y, reach);
    var lit = 0.085 + energy * 0.2 + presence * 0.04;
    halo.addColorStop(0, 'rgba(' + rgb + ',' + lit.toFixed(3) + ')');
    halo.addColorStop(0.38, 'rgba(' + rgb + ',' + (lit * 0.3).toFixed(3) + ')');
    halo.addColorStop(1, 'rgba(' + rgb + ',0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, reach, 0, Math.PI * 2);
    ctx.fill();

    /* ---------- rings ---------- */
    for (var i = 0; i < rings.length; i++) {
      var age = (t - rings[i].born) / 1.9;
      if (age >= 1) continue;
      var ease = 1 - Math.pow(1 - age, 2.4);
      var rr = r * (1.02 + ease * 1.5);
      var alpha = (1 - age) * (1 - age) * 0.15 * rings[i].force;

      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(' + rgb + ',' + alpha.toFixed(3) + ')';
      ctx.lineWidth = Math.max(0.6, 1.6 * (1 - age));
      ctx.stroke();
    }

    /* ---------- the body ---------- */
    var wob = (CALM ? 0.12 : 0.32) + energy * (CALM ? 0.3 : 1.05);
    body(x, y, r, t, wob, rgb);

    /* ---------- connecting sweep ---------- */
    if (Vivid.phase === 'connecting') {
      ctx.beginPath();
      ctx.arc(x, y, r * 1.34, sweep, sweep + 0.85);
      ctx.strokeStyle = 'rgba(' + rgb + ',0.34)';
      ctx.lineWidth = 1.4;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    /* ---------- time ----------
       Two minutes, drawn as an arc that gives way. It is never announced
       and never counted down in numbers; it simply runs out. */
    var session = window.VividSession;
    if (session && session.active) {
      var left = session.left();
      var span = Math.PI * 2 * left;
      var faint = 0.028 + (1 - left) * 0.026;

      ctx.beginPath();
      ctx.arc(x, y, r * 2.08, -Math.PI / 2, -Math.PI / 2 + span);
      ctx.strokeStyle = 'rgba(' + rgb + ',' + (left < 0.12 ? faint + 0.05 : faint).toFixed(3) + ')';
      ctx.lineWidth = left < 0.12 ? 1.3 : 1;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    /* ---------- grain ---------- */
    if (!grain) grain = tile();
    ctx.globalAlpha = 0.022;
    ctx.fillStyle = grain;
    ctx.save();
    ctx.translate((t * 41) % 128 | 0, (t * 27) % 128 | 0);
    ctx.fillRect(-128, -128, w + 256, h + 256);
    ctx.restore();
    ctx.globalAlpha = 1;

    ctx.globalCompositeOperation = 'source-over';
  }

  /* ============================================================
     the body
     Painted on its own small layer so it can be masked. A key light
     offset up and left is what makes it read as a sphere rather than a
     disc — but an offset gradient clipped by the path leaves a hard
     crescent where the two disagree. Masking with a concentric fade
     instead lets the light land wherever it likes and still guarantees
     the silhouette goes to nothing at its edge.
     ============================================================ */
  var layer = document.createElement('canvas');
  var lctx = layer.getContext('2d');
  var laid = 0;

  function body(x, y, r, t, wob, rgb) {
    var pad = Math.ceil(r * 1.5);
    var size = pad * 2;
    var fit = size + '@' + dpr;      /* a move between screens changes dpr alone */

    if (laid !== fit) {
      layer.width = layer.height = Math.ceil(size * dpr);
      laid = fit;
    }

    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lctx.clearRect(0, 0, size, size);
    lctx.globalCompositeOperation = 'source-over';

    /* the key light */
    outline(lctx, pad, pad, r, t, wob);
    var key = lctx.createRadialGradient(
      pad - r * 0.32, pad - r * 0.38, r * 0.07,
      pad - r * 0.06, pad - r * 0.06, r * 1.42
    );
    /* diffuse when it is only breathing, focused when there is a voice —
       a hard point of white on a resting orb reads as moulded plastic */
    key.addColorStop(0, 'rgba(255,255,255,' + (0.46 + energy * 0.52).toFixed(3) + ')');
    key.addColorStop(0.15, 'rgba(' + rgb + ',' + (0.2 + energy * 0.24).toFixed(3) + ')');
    key.addColorStop(0.34, 'rgba(' + rgb + ',' + (0.05 + energy * 0.13).toFixed(3) + ')');
    key.addColorStop(0.62, 'rgba(' + rgb + ',' + (0.012 + energy * 0.05).toFixed(3) + ')');
    key.addColorStop(1, 'rgba(' + rgb + ',0)');
    lctx.fillStyle = key;
    lctx.fill();

    /* three lobes of light adrift inside it — the difference between a
       lit sphere and something with weather in it */
    lctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < LOBES.length; i++) {
      var lobe = LOBES[i];
      var lx = pad + Math.cos(t * lobe.u + lobe.p) * r * lobe.reach;
      var ly = pad + Math.sin(t * lobe.v + lobe.p) * r * lobe.reach * 0.8;
      var lr = r * (lobe.size + energy * 0.16);
      var la = (lobe.lit + energy * 0.14) * (0.55 + presence * 0.45);

      var cloud = lctx.createRadialGradient(lx, ly, 0, lx, ly, lr);
      cloud.addColorStop(0, 'rgba(' + rgb + ',' + la.toFixed(3) + ')');
      cloud.addColorStop(0.55, 'rgba(' + rgb + ',' + (la * 0.28).toFixed(3) + ')');
      cloud.addColorStop(1, 'rgba(' + rgb + ',0)');
      lctx.fillStyle = cloud;
      lctx.beginPath();
      lctx.arc(lx, ly, lr, 0, Math.PI * 2);
      lctx.fill();
    }

    /* fresnel — light gathering at the limb, which is most of what makes
       a sphere of light look like one */
    outline(lctx, pad, pad, r, t, wob);
    var limb = lctx.createRadialGradient(pad, pad, r * 0.55, pad, pad, r);
    var edge = 0.17 + energy * 0.4 + presence * 0.05;
    limb.addColorStop(0, 'rgba(' + rgb + ',0)');
    limb.addColorStop(0.72, 'rgba(' + rgb + ',' + (edge * 0.22).toFixed(3) + ')');
    limb.addColorStop(0.94, 'rgba(' + rgb + ',' + edge.toFixed(3) + ')');
    limb.addColorStop(1, 'rgba(' + rgb + ',' + (edge * 0.72).toFixed(3) + ')');
    lctx.fillStyle = limb;
    lctx.fill();

    /* the core, which is where the voice lands hardest. It sits under the
       key light rather than beside it — two separate bright spots read as
       a bead of plastic, one reads as a source. */
    var heat = 0.15 + energy * 0.58 + glow * 0.18;
    var seedX = pad - r * 0.26;
    var seedY = pad - r * 0.3;
    var seedR = r * (0.62 + energy * 0.34);

    var seed = lctx.createRadialGradient(seedX, seedY, 0, seedX, seedY, seedR);
    seed.addColorStop(0, 'rgba(255,255,255,' + Math.min(0.92, heat).toFixed(3) + ')');
    seed.addColorStop(0.3, 'rgba(255,255,255,' + (heat * 0.3).toFixed(3) + ')');
    seed.addColorStop(0.66, 'rgba(' + rgb + ',' + (heat * 0.08).toFixed(3) + ')');
    seed.addColorStop(1, 'rgba(' + rgb + ',0)');
    lctx.fillStyle = seed;
    lctx.beginPath();
    lctx.arc(seedX, seedY, seedR, 0, Math.PI * 2);
    lctx.fill();

    /* the mask: hold the light, then let go just before the edge */
    lctx.globalCompositeOperation = 'destination-in';
    outline(lctx, pad, pad, r, t, wob);
    var mask = lctx.createRadialGradient(pad, pad, 0, pad, pad, r);
    mask.addColorStop(0, 'rgba(0,0,0,1)');
    mask.addColorStop(0.88, 'rgba(0,0,0,1)');
    mask.addColorStop(0.97, 'rgba(0,0,0,0.72)');
    mask.addColorStop(1, 'rgba(0,0,0,0)');
    lctx.fillStyle = mask;
    lctx.fill();

    ctx.drawImage(layer, 0, 0, layer.width, layer.height, x - pad, y - pad, size, size);
  }

  /* the closed path the body is cut from */
  function outline(c, x, y, r, t, wob) {
    c.beginPath();

    for (var i = 0; i <= STEPS; i++) {
      var a = (i / STEPS) * Math.PI * 2;
      var d = 0;

      for (var j = 0; j < HARMONICS.length; j++) {
        var harm = HARMONICS[j];
        d += harm.a * Math.sin(harm.k * a + harm.w * t * 2.2 + harm.p);
      }

      var rr = r * (1 + d * wob);
      var px = x + Math.cos(a) * rr;
      var py = y + Math.sin(a) * rr;
      i ? c.lineTo(px, py) : c.moveTo(px, py);
    }

    c.closePath();
  }

  resize();
  requestAnimationFrame(frame);
})();
