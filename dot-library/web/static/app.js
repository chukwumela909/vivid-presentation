/* dotlib face-scan front end — 3D replayer + expression engine.
 *
 * The browser is a thin replayer: it captures camera frames, POSTs them (with
 * the current dot positions) to the dotlib server, and replays the returned
 * timeline — same easings, per-dot stagger delays, drift amplitudes, spin,
 * sway, and perspective camera as the Python renderer.
 *
 * On top of the replayed timeline, face responses carry per-dot region tags
 * (mouth / eyes / jaw) so the page puppets expressions locally at 60fps:
 * a talking mouth, periodic blinks, and pupils (plus a subtle head turn)
 * that follow the cursor. Expressions are applied in anchor space, before
 * rotation, so they ride the swaying head correctly.
 */

"use strict";

const N = 3200;            // dots (server caps at 6000)
const LOGICAL_H = 840;     // logical field height; width follows the viewport aspect
const BG = [12, 13, 17];
const FG = [242, 243, 247];
const LIVE_INTERVAL_MS = 2400;
const AUTO_INTERVAL_MS = 6500;
const CORRECTION_S = 0.35;
const IDLE_SPIN = 0.1;     // rad/s swirl of the resting cloud
const DEPTH_SHADE = 0.45;
const SHAPE_CYCLE = ["heart", "star", "ring", "spiral", "polygon"];

// Logical field size — established on the first layout with a real viewport
// (embedded panes can boot at 0x0, which would poison the aspect with NaN),
// then fixed; pixel mapping rescales on resize.
let W = 0, H = LOGICAL_H, DEFAULT_CAM = 2.4 * LOGICAL_H;
let inited = false;

// ---------------------------------------------------------------- easing (mirror of dotlib.easing)

const EASE = {
  linear: p => p,
  quad: p => 1 - (1 - p) ** 2,
  cubic: p => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2),
  quint: p => (p < 0.5 ? 16 * p ** 5 : 1 - (-2 * p + 2) ** 5 / 2),
  expo: p => (p >= 1 ? 1 : 1 - 2 ** (-10 * p)),
  back: p => { const s = 1.70158, q = p - 1; return 1 + q * q * ((s + 1) * q + s); },
  elastic: p => (p <= 0 ? 0 : p >= 1 ? 1 : 2 ** (-10 * p) * Math.sin((p * 10 - 0.75) * (2 * Math.PI / 3)) + 1),
};

// ---------------------------------------------------------------- per-dot drift (mirror of dotlib.noise, 3 axes)

function makeDrift(n) {
  const TWO_PI = Math.PI * 2;
  const m = n * 3;
  const w1 = new Float64Array(m), w2 = new Float64Array(m);
  const p1 = new Float64Array(m), p2 = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    w1[i] = (0.25 + Math.random() * 0.35) * TWO_PI * 0.55;
    w2[i] = (0.7 + Math.random() * 0.6) * TWO_PI * 0.55;
    p1[i] = Math.random() * TWO_PI;
    p2[i] = Math.random() * TWO_PI;
  }
  const scale = 1 / 1.6;
  return (t, outX, outY, outZ) => {
    for (let i = 0; i < n; i++) {
      const a = i * 3, b = i * 3 + 1, c = i * 3 + 2;
      outX[i] = (Math.sin(w1[a] * t + p1[a]) + 0.6 * Math.sin(w2[a] * t + p2[a])) * scale;
      outY[i] = (Math.sin(w1[b] * t + p1[b]) + 0.6 * Math.sin(w2[b] * t + p2[b])) * scale;
      outZ[i] = (Math.sin(w1[c] * t + p1[c]) + 0.6 * Math.sin(w2[c] * t + p2[c])) * scale;
    }
  };
}

// ---------------------------------------------------------------- state

const canvas = document.getElementById("dots");
const ctx = canvas.getContext("2d");
const video = document.getElementById("cam");

const els = {
  word: document.getElementById("word-input"),
  wordBtn: document.getElementById("btn-word"),
  shape: document.getElementById("btn-shape"),
  talk: document.getElementById("btn-talk"),
  auto: document.getElementById("btn-auto"),
  camera: document.getElementById("btn-camera"),
  scan: document.getElementById("btn-scan"),
  live: document.getElementById("btn-live"),
  disperse: document.getElementById("btn-disperse"),
  sample: document.getElementById("btn-sample"),
  status: document.getElementById("status-text"),
  yaw: document.getElementById("a-yaw"),
  pitch: document.getElementById("a-pitch"),
  roll: document.getElementById("a-roll"),
  backend: document.getElementById("a-backend"),
  toast: document.getElementById("toast"),
};

const state = {
  timeline: null,
  tlStart: 0,
  camera: DEFAULT_CAM,   // patched once the logical size is established
  theta: 0,
  anchors: { x: new Float64Array(N), y: new Float64Array(N), z: new Float64Array(N) },
  colors: { r: new Float64Array(N), g: new Float64Array(N), b: new Float64Array(N) },
  radii: new Float64Array(N),
  corr: null,
  regions: null,           // face feature ellipses (canvas coords) or null
  tags: null,              // per-dot region tags (Int8Array) or null
  idleAmp: 3.0,
  camOn: false,
  busy: false,
  live: false,
  liveTimer: null,
  talk: false,
  auto: false,
  autoTimer: null,
  autoStep: 0,
  shapeIdx: 0,
  cursor: { x: 0, y: 0 },
  cursorAt: -10,
  saccade: { x: 0, y: 0 },
  nextSaccade: 0,
  nextBrow: 4,
  browAt: -10,
  yawBias: 0,
  userYaw: 0,          // drag-to-rotate: horizontal
  userPitch: 0,        // drag-to-rotate: vertical
  dragging: false,
  lastDragAt: -10,
  nextBlink: 2.5,
  blinkAt: -10,
  hiddenVal: new Float64Array(N).fill(-1),   // >=0: true value of a hidden-layer dot
  hasSample: false,
};

const driftX = new Float64Array(N), driftY = new Float64Array(N), driftZ = new Float64Array(N);
const drift = makeDrift(N);
const exX = new Float64Array(N), exY = new Float64Array(N);   // expression offsets (anchor space)
const wx = new Float64Array(N), wy = new Float64Array(N), wz = new Float64Array(N);
const orderArr = new Array(N);
for (let i = 0; i < N; i++) orderArr[i] = i;

// Idle start: floating ball of dots (matches dotlib's scatter), fg color, jittered radii.
function initDots() {
  const R = 0.34 * Math.min(W, H);
  for (let i = 0; i < N; i++) {
    let dx = 0, dy = 0, dz = 0, len = 0;
    do {
      dx = Math.random() * 2 - 1; dy = Math.random() * 2 - 1; dz = Math.random() * 2 - 1;
      len = Math.hypot(dx, dy, dz);
    } while (len < 1e-6 || len > 1);
    const rad = R * Math.cbrt(Math.random()) / len;
    state.anchors.x[i] = W / 2 + dx * rad;
    state.anchors.y[i] = H / 2 + dy * rad * 0.92;
    state.anchors.z[i] = dz * rad * 0.85;
    state.colors.r[i] = FG[0]; state.colors.g[i] = FG[1]; state.colors.b[i] = FG[2];
    state.radii[i] = 1.5 * (1 + (Math.random() * 2 - 1) * 0.18);
  }
}

// ---------------------------------------------------------------- layout (canvas fills the viewport)

let viewSX = 1, viewSY = 1;

function ensureLogical() {
  if (inited) return true;
  const iw = window.innerWidth, ih = window.innerHeight;
  if (!(iw > 0) || !(ih > 0)) return false;
  W = Math.max(600, Math.min(2400, Math.round(LOGICAL_H * (iw / ih))));
  H = LOGICAL_H;
  DEFAULT_CAM = 2.4 * Math.min(W, H);
  state.camera = DEFAULT_CAM;
  state.cursor.x = W / 2;
  state.cursor.y = H / 2;
  initDots();
  inited = true;
  return true;
}

function layout() {
  if (!ensureLogical()) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  viewSX = canvas.width / W;
  viewSY = canvas.height / H;
}
window.addEventListener("resize", layout);
layout();

window.addEventListener("mousemove", (e) => {
  state.cursor.x = (e.clientX / window.innerWidth) * W;
  state.cursor.y = (e.clientY / window.innerHeight) * H;
  state.cursorAt = performance.now() / 1000;
});

// Drag anywhere on the canvas to rotate the head: horizontal = turn (yaw),
// vertical = nod (pitch). Released, it eases home after a few seconds.
canvas.addEventListener("pointerdown", (e) => {
  state.dragging = true;
  state.dragX = e.clientX;
  state.dragY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!state.dragging) return;
  state.userYaw = Math.max(-1.15, Math.min(1.15, state.userYaw + (e.clientX - state.dragX) * 0.005));
  state.userPitch = Math.max(-0.45, Math.min(0.45, state.userPitch + (e.clientY - state.dragY) * 0.0035));
  state.dragX = e.clientX;
  state.dragY = e.clientY;
  state.lastDragAt = performance.now() / 1000;
});
const endDrag = () => { state.dragging = false; state.lastDragAt = performance.now() / 1000; };
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

// ---------------------------------------------------------------- timeline evaluation

function evalTimeline(tSec) {
  const tl = state.timeline;
  let amp = state.idleAmp;
  let alpha = 1.0;
  let theta = IDLE_SPIN * tSec;

  if (tl) {
    const tt = tSec - state.tlStart;
    const segs = tl.segments;
    let seg = segs[segs.length - 1];
    let p = 1;
    for (const s of segs) {
      if (tt < s.t1) { seg = s; p = Math.max(0, (tt - s.t0) / (s.t1 - s.t0)); break; }
    }
    const ease = EASE[seg.easing] || EASE.cubic;
    const ep = ease(p);
    amp = seg.driftAmp[0] + (seg.driftAmp[1] - seg.driftAmp[0]) * p;
    alpha = seg.alpha[0] + (seg.alpha[1] - seg.alpha[0]) * ep;
    // Spin runs on unclamped segment time so a formed face keeps turning
    // after the timeline ends; sway oscillates on the absolute clock (two
    // incommensurate sines — organic wander, not a metronome) so its phase
    // never jumps across segments or adopted timelines.
    const sw = seg.sway || [0, 0];
    const swayAmp = sw[0] + (sw[1] - sw[0]) * p;
    const wsp = tl.swaySpeed || 0.45;
    const swayWave = 0.72 * Math.sin(wsp * tSec) + 0.28 * Math.sin(1.417 * wsp * tSec + 1.1);
    theta = (seg.theta0 || 0) + (seg.spin || 0) * Math.max(0, tt - seg.t0) + swayAmp * swayWave;
    const del = seg.delays;
    const arcs = seg.arcs;
    const { from, to, colorsFrom, colorsTo } = seg;
    for (let i = 0; i < N; i++) {
      let e = ep;
      if (del) {
        const d = del[i];
        e = ease(Math.min(1, Math.max(0, (p - d) / (1 - d))));
      }
      let ax = from[i][0] + (to[i][0] - from[i][0]) * e;
      let ay = from[i][1] + (to[i][1] - from[i][1]) * e;
      let az = (from[i][2] || 0) + ((to[i][2] || 0) - (from[i][2] || 0)) * e;
      if (arcs) {
        const bow = Math.sin(Math.PI * e);   // curved flight, zero at endpoints
        ax += arcs[i][0] * bow;
        ay += arcs[i][1] * bow;
        az += arcs[i][2] * bow;
      }
      state.anchors.x[i] = ax;
      state.anchors.y[i] = ay;
      state.anchors.z[i] = az;
      state.colors.r[i] = colorsFrom[i][0] + (colorsTo[i][0] - colorsFrom[i][0]) * e;
      state.colors.g[i] = colorsFrom[i][1] + (colorsTo[i][1] - colorsFrom[i][1]) * e;
      state.colors.b[i] = colorsFrom[i][2] + (colorsTo[i][2] - colorsFrom[i][2]) * e;
    }
  }
  return { amp, alpha, theta };
}

// ---------------------------------------------------------------- expressions
// v2 (landmark layers): tags 0 skin, 1 lipU, 2 lipL, 3 lidA, 4 lidB, 5 jaw,
// 6/7 brows, 8/9 teeth, 10 tongue, 11 cavity, 12-14 eyeA (scl/iris/pup),
// 15-17 eyeB. Mouth-interior layers ship hidden (bg color) and are revealed
// with openness. v1 (ellipse fallback): 1 mouth, 2/3 eyes, 4 jaw.

const vis = new Float64Array(N).fill(1);   // per-dot visibility (0 hidden .. >1 boosted)

function blinkLevel(tSec) {
  if (tSec >= state.nextBlink) {
    state.blinkAt = state.nextBlink;
    state.nextBlink = tSec + 2.2 + Math.random() * 3.3;
  }
  const dt = tSec - state.blinkAt;
  if (dt < 0 || dt > 0.28) return 0;
  return dt < 0.12 ? dt / 0.12 : 1 - (dt - 0.12) / 0.16;   // close fast, open a touch slower
}

function talkLevel(tSec) {
  if (!state.talk) return 0;
  const syll = (0.55 + 0.45 * Math.sin(2 * Math.PI * 2.3 * tSec))
             * (0.55 + 0.45 * Math.sin(2 * Math.PI * 3.9 * tSec + 1.4));
  const gate = Math.max(0, Math.min(1, (Math.sin(2 * Math.PI * 0.23 * tSec) + 0.55) * 1.6));
  return Math.min(1, syll * 1.6) * gate;
}

function gazeTarget(tSec) {
  // Cursor when it moved recently; otherwise natural saccades around ahead.
  if (tSec - state.cursorAt < 2.5) return state.cursor;
  if (tSec >= state.nextSaccade) {
    state.nextSaccade = tSec + 1.2 + Math.random() * 2.3;
    state.saccade = {
      x: W / 2 + (Math.random() * 2 - 1) * W * 0.22,
      y: H / 2 + (Math.random() * 2 - 1) * H * 0.14,
    };
  }
  return state.saccade;
}

function expressionsV2(tSec, R, tags) {
  const fw = R.faceW;
  const level = talkLevel(tSec);
  const open = R.mouth.open * level;
  const mouthVis = Math.min(1, level * 1.6);
  const bl = blinkLevel(tSec);
  const eyeVis = 1 - bl * 0.95;

  // Breathing: the whole sculpture rises and settles.
  const breath = Math.sin(2 * Math.PI * tSec / 3.8) * fw * 0.014;

  // Occasional brow raise.
  if (tSec >= state.nextBrow) {
    state.browAt = state.nextBrow;
    state.nextBrow = tSec + 6 + Math.random() * 11;
  }
  const bdt = tSec - state.browAt;
  const brow = (bdt >= 0 && bdt < 0.9)
    ? Math.sin(Math.min(1, bdt / 0.9) * Math.PI) * R.browLift : 0;

  const gz = gazeTarget(tSec);
  const gA = eyeShift(R.eyeA, gz), gB = eyeShift(R.eyeB, gz);

  for (let i = 0; i < N; i++) {
    const tg = tags[i];
    exY[i] += breath;
    switch (tg) {
      case 1:   // upper lip: barely moves
        exY[i] -= open * 0.12;
        exX[i] += -(state.anchors.x[i] - R.mouth.cx) * 0.10 * level;
        break;
      case 2:   // lower lip: drops with the jaw
        exY[i] += open * 0.85;
        exX[i] += -(state.anchors.x[i] - R.mouth.cx) * 0.12 * level;
        break;
      case 5:   // jaw/chin skin follows
        exY[i] += open * 0.55;
        break;
      case 8:   // upper teeth: fixed to the skull, just revealed
        vis[i] = Math.max((R.restOpen || 0) * 0.9, mouthVis);
        break;
      case 9:   // lower teeth ride the jaw
        vis[i] = Math.max((R.restOpen || 0) * 0.85, mouthVis);
        exY[i] += open * 0.80;
        break;
      case 10:  // tongue: rides the jaw, wiggles while talking
        vis[i] = Math.max((R.restOpen || 0) * 0.55, mouthVis * 0.9);
        exY[i] += open * 0.70 + Math.sin(2 * Math.PI * 3.1 * tSec) * open * 0.10;
        break;
      case 11:  // cavity: dark backdrop of the open mouth
        vis[i] = Math.max((R.restOpen || 0) * 0.45, mouthVis * 0.8);
        exY[i] += open * 0.40;
        break;
      case 3: case 4: {           // eyelids: sweep down to cover the eye
        const eye = tg === 3 ? R.eyeA : R.eyeB;
        const lidLine = eye.cy + eye.ry * 0.18;
        if (bl > 0 && state.anchors.y[i] < lidLine) {
          exY[i] += (lidLine - state.anchors.y[i]) * 0.85 * bl;
        }
        if (tg === 3 || tg === 4) exY[i] -= brow * 0.25;
        break;
      }
      case 6: case 7:             // brows
        exY[i] -= brow;
        break;
      case 12: case 13: case 14: { // eyeball A: gaze + hidden under lids
        vis[i] = eyeVis;
        const k = tg === 12 ? 0.25 : 1.0;
        exX[i] += gA.dx * k; exY[i] += gA.dy * k;
        break;
      }
      case 15: case 16: case 17: {
        vis[i] = eyeVis;
        const k = tg === 15 ? 0.25 : 1.0;
        exX[i] += gB.dx * k; exY[i] += gB.dy * k;
        break;
      }
    }
  }
}

function eyeShift(eye, gz) {
  let dx = gz.x - eye.irisX, dy = gz.y - eye.irisY;
  const len = Math.hypot(dx, dy) || 1;
  const shift = Math.min(1, len / (W * 0.30));
  return { dx: (dx / len) * eye.rx * 0.30 * shift, dy: (dy / len) * eye.ry * 0.22 * shift };
}

function expressionsV1(tSec, R, tags) {
  const level = talkLevel(tSec);
  if (level > 0.01) {
    const amp = R.mouth.ry * 0.8 * level;
    for (let i = 0; i < N; i++) {
      const tg = tags[i];
      if (tg === 1) {
        const rel = (state.anchors.y[i] - R.mouth.cy) / R.mouth.ry;
        exY[i] += rel >= 0 ? amp * (0.55 + 0.45 * Math.min(rel, 1)) : -amp * 0.15;
        exX[i] += -(state.anchors.x[i] - R.mouth.cx) * 0.12 * level;
      } else if (tg === 4) {
        exY[i] += amp * 0.32;
      }
    }
  }
  const bl = blinkLevel(tSec);
  if (bl > 0) {
    for (let i = 0; i < N; i++) {
      const tg = tags[i];
      if (tg === 2 || tg === 3) {
        const eye = tg === 2 ? R.eyeL : R.eyeR;
        exY[i] += (eye.cy - state.anchors.y[i]) * 0.9 * bl;
      }
    }
  }
  const look = state.cursor;
  for (const key of ["eyeL", "eyeR"]) {
    const eye = R[key];
    const tag = key === "eyeL" ? 2 : 3;
    let dx = look.x - eye.cx, dy = look.y - eye.cy;
    const len = Math.hypot(dx, dy) || 1;
    const shift = Math.min(1, len / (W * 0.25));
    dx = (dx / len) * eye.rx * 0.34 * shift;
    dy = (dy / len) * eye.ry * 0.40 * shift;
    for (let i = 0; i < N; i++) {
      if (tags[i] !== tag) continue;
      const ex = (state.anchors.x[i] - eye.cx) / eye.rx;
      const ey = (state.anchors.y[i] - eye.cy) / eye.ry;
      const d = Math.hypot(ex, ey);
      if (d < 0.62) {
        const k = 1 - d / 0.62;
        exX[i] += dx * (0.5 + 0.5 * k);
        exY[i] += dy * (0.5 + 0.5 * k);
      }
    }
  }
}

function expressions(tSec) {
  exX.fill(0); exY.fill(0); vis.fill(1);
  const R = state.regions, tags = state.tags;

  // Head life: turns subtly toward the cursor plus a barely-there wander —
  // rotation belongs to the user (drag); life comes from breath and drift.
  const wander = R ? 0.018 * Math.sin(0.29 * tSec) + 0.012 * Math.sin(0.117 * tSec + 2.1) : 0;
  const cursorBias = R ? Math.max(-1, Math.min(1, (state.cursor.x - W / 2) / (W / 2))) * 0.10 : 0;
  state.yawBias += (cursorBias + wander - state.yawBias) * 0.05;

  if (!R || !tags) return;
  if (R.v === 2) expressionsV2(tSec, R, tags);
  else expressionsV1(tSec, R, tags);
}

// ---------------------------------------------------------------- render loop

let lastFrame = 0, rafQueued = false;

function queueFrame() {
  if (!rafQueued) { rafQueued = true; requestAnimationFrame(render); }
}

function render() {
  const nowS = performance.now() / 1000;
  if (nowS - lastFrame < 0.004) return;   // dedupe if watchdog + rAF chains converge
  rafQueued = false;
  if (!inited) {              // pane may boot at 0x0; keep waiting for a real size
    layout();
    queueFrame();
    return;
  }
  const tSec = nowS;
  const { amp, alpha, theta } = evalTimeline(tSec);
  drift(tSec, driftX, driftY, driftZ);
  expressions(tSec);
  // User rotation eases home a few seconds after the drag ends.
  if (!state.dragging && tSec - state.lastDragAt > 3.0) {
    state.userYaw *= 0.985;
    state.userPitch *= 0.985;
  }
  const th = theta + state.yawBias + state.userYaw;
  const ph = state.userPitch;
  state.theta = th;
  state.phi = ph;

  let corrK = 0;
  if (state.corr) {
    const d = (tSec - state.corr.start) / CORRECTION_S;
    if (d >= 1) state.corr = null;
    else corrK = 1 - EASE.cubic(Math.min(1, Math.max(0, d)));
  }
  const corr = state.corr;

  const cx = W / 2, cy = H / 2;
  const cosT = Math.cos(th), sinT = Math.sin(th);
  const cosP = Math.cos(ph), sinP = Math.sin(ph);
  const cam = state.camera;

  for (let i = 0; i < N; i++) {
    let x = state.anchors.x[i] + exX[i] + amp * driftX[i];
    let y = state.anchors.y[i] + exY[i] + amp * driftY[i];
    let z = state.anchors.z[i] + amp * driftZ[i];
    if (corr) { x += corr.x[i] * corrK; y += corr.y[i] * corrK; z += corr.z[i] * corrK; }
    const rx = x - cx;
    const x1 = cx + rx * cosT + z * sinT;
    const z1 = -rx * sinT + z * cosT;
    const ry = y - cy;
    wx[i] = x1;
    wy[i] = cy + ry * cosP - z1 * sinP;
    wz[i] = ry * sinP + z1 * cosP;
  }

  orderArr.sort((a, b) => wz[a] - wz[b]);   // painter's order: far dots first

  ctx.setTransform(viewSX, 0, 0, viewSY, 0, 0);
  ctx.fillStyle = `rgb(${BG[0]},${BG[1]},${BG[2]})`;
  ctx.fillRect(0, 0, W, H);

  // Fixed depth-shading reference: flat formations stay uniformly lit and
  // morphs between deep and flat targets don't pump brightness.
  const zref = 0.22 * Math.min(W, H);

  for (let k = 0; k < N; k++) {
    const i = orderArr[k];
    const zc = Math.min(wz[i], 0.82 * cam);
    const s = cam / (cam - zc);
    const px = cx + (wx[i] - cx) * s;
    const py = cy + (wy[i] - cy) * s;
    const znorm = Math.max(-1, Math.min(1, wz[i] / zref));
    const shade = 1 + znorm * DEPTH_SHADE * (znorm > 0 ? 0.35 : 1);
    const ka = alpha * shade * vis[i];
    let cr = state.colors.r[i], cg = state.colors.g[i], cb = state.colors.b[i];
    const hv = state.hiddenVal[i];
    if (hv >= 0) {   // hidden anatomy layer: true value, revealed by vis
      cr = BG[0] + (FG[0] - BG[0]) * hv;
      cg = BG[1] + (FG[1] - BG[1]) * hv;
      cb = BG[2] + (FG[2] - BG[2]) * hv;
    }
    const r = Math.max(0, Math.min(255, BG[0] + (cr - BG[0]) * ka));
    const g = Math.max(0, Math.min(255, BG[1] + (cg - BG[1]) * ka));
    const b = Math.max(0, Math.min(255, BG[2] + (cb - BG[2]) * ka));
    ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
    ctx.beginPath();
    ctx.arc(px, py, state.radii[i] * s, 0, 6.2832);
    ctx.fill();
  }
  lastFrame = nowS;
  queueFrame();
}
queueFrame();

// Watchdog: rAF pauses in hidden/backgrounded panes; keep the field alive at
// a low tick rate and re-arm the chain the moment frames stall.
setInterval(() => {
  if (performance.now() / 1000 - lastFrame > 0.6) render();
}, 500);

// ---------------------------------------------------------------- server I/O

function worldOf(i, cosT, sinT, cosP, sinP, cx, cy) {
  const rx = state.anchors.x[i] - cx;
  const z = state.anchors.z[i];
  const x1 = cx + rx * cosT + z * sinT;
  const z1 = -rx * sinT + z * cosT;
  const ry = state.anchors.y[i] - cy;
  return [x1, cy + ry * cosP - z1 * sinP, ry * sinP + z1 * cosP];
}

function currentPositions() {
  // World-space (all rotations applied) pre-drift anchors: the server seeds
  // its timeline from these, and its fresh timeline starts unrotated.
  const cx = W / 2, cy = H / 2;
  const cosT = Math.cos(state.theta), sinT = Math.sin(state.theta);
  const cosP = Math.cos(state.phi || 0), sinP = Math.sin(state.phi || 0);
  const out = new Array(N);
  for (let i = 0; i < N; i++) out[i] = worldOf(i, cosT, sinT, cosP, sinP, cx, cy);
  return out;
}

function adoptTimeline(tl, regions, tags) {
  const seg0 = tl.segments[0];
  const cx = W / 2, cy = H / 2;
  const cosT = Math.cos(state.theta), sinT = Math.sin(state.theta);
  const cosP = Math.cos(state.phi || 0), sinP = Math.sin(state.phi || 0);
  const dx = new Float64Array(N), dy = new Float64Array(N), dz = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const [wxi, wyi, wzi] = worldOf(i, cosT, sinT, cosP, sinP, cx, cy);
    dx[i] = wxi - seg0.from[i][0];
    dy[i] = wyi - seg0.from[i][1];
    dz[i] = wzi - (seg0.from[i][2] || 0);
  }
  // The new timeline starts unrotated; fold the user's rotation back to zero
  // so the incoming morph isn't double-rotated.
  state.userYaw = 0;
  state.userPitch = 0;
  state.corr = { x: dx, y: dy, z: dz, start: performance.now() / 1000 };
  state.timeline = tl;
  state.tlStart = performance.now() / 1000;
  state.regions = regions || null;
  state.tags = tags ? Int8Array.from(tags) : null;
  // Hidden anatomy layers (teeth/tongue/cavity) ship bg-colored; remember
  // their true values so talk can reveal them.
  state.hiddenVal.fill(-1);
  if (state.regions && state.regions.v === 2 && state.tags) {
    const tv = state.regions.tagValues || {};
    for (let i = 0; i < N; i++) {
      const v = tv[String(state.tags[i])];
      if (v !== undefined) state.hiddenVal[i] = v;
    }
  }
  els.talk.disabled = !state.regions;
  if (tl.camera) state.camera = tl.camera;
  if (tl.radii && tl.radii.length === N) {
    for (let i = 0; i < N; i++) state.radii[i] = tl.radii[i];
  }
}

async function post(path, payload) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function basePayload(extra = {}) {
  if (!inited) layout();
  return { n: N, size: [W, H], positions: currentPositions(), ...extra };
}

function captureFrame() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const w = 640, h = Math.round((vh / vw) * 640);
  const cap = document.createElement("canvas");
  cap.width = w; cap.height = h;
  const cctx = cap.getContext("2d");
  cctx.translate(w, 0);           // selfie mirror, so the dot face matches the PiP
  cctx.scale(-1, 1);
  cctx.drawImage(video, 0, 0, w, h);
  return cap.toDataURL("image/jpeg", 0.85);
}

async function scan({ live = false, sample = false } = {}) {
  if (state.busy) return;
  const payload = basePayload({ live });
  if (sample) {
    payload.sample = true;
  } else {
    const img = captureFrame();
    if (!img) { toast("Camera not ready yet"); return; }
    payload.image = img;
  }
  state.busy = true;
  if (!live) setStatus("scanning…");
  try {
    const j = await post("/api/scan", payload);
    if (!j.ok) {
      if (j.error === "no_face") { if (!live) toast("No face detected — face the camera"); setStatus("no face detected"); }
      else toast(`Scan failed: ${j.error}`);
      return;
    }
    adoptTimeline(j.timeline, j.regions, j.tags);
    showPose(j.meta.pose);
    setStatus(`${live ? "live tracking" : "face locked"} · ${Math.round(j.meta.elapsed * 1000)}ms · ${j.meta.pose.backend}`);
  } catch (err) {
    toast(`Server error: ${err.message}`);
    setStatus("server unreachable");
  } finally {
    state.busy = false;
  }
}

async function morphTarget(kindPayload, statusText) {
  if (state.busy) return;
  state.busy = true;
  try {
    const j = await post("/api/target", basePayload(kindPayload));
    if (!j.ok) {
      if (j.error === "no_face_yet") toast("Scan a face first");
      else toast(`Failed: ${j.error}`);
      return;
    }
    adoptTimeline(j.timeline, j.regions, j.tags);
    if (j.meta.pose) showPose(j.meta.pose); else showPose(null);
    setStatus(statusText || `→ ${j.meta.name || kindPayload.kind}`);
  } catch (err) {
    toast(`Server error: ${err.message}`);
  } finally {
    state.busy = false;
  }
}

async function disperse() {
  if (state.busy) return;
  state.busy = true;
  try {
    const j = await post("/api/disperse", basePayload({ style: "fill" }));
    if (j.ok) {
      adoptTimeline(j.timeline, null, null);
      setStatus("dispersed — dots fill the room");
      showPose(null);
    }
  } catch (err) {
    toast(`Server error: ${err.message}`);
  } finally {
    state.busy = false;
  }
}

function backToFace() {
  if (state.camOn) scan();
  else morphTarget({ kind: "face" }, "back to the face");
}

// ---------------------------------------------------------------- camera + controls

async function enableCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    video.classList.remove("hidden");
    state.camOn = true;
    els.camera.classList.add("hidden");
    els.scan.disabled = false;
    els.live.disabled = false;
    setStatus("camera on — scanning…");
    video.addEventListener("loadeddata", () => setTimeout(() => scan(), 500), { once: true });
  } catch (err) {
    toast(`Camera unavailable: ${err.name}`);
    setStatus("camera blocked — allow access and retry");
  }
}

function toggleLive() {
  state.live = !state.live;
  els.live.classList.toggle("on", state.live);
  if (state.live) {
    setStatus("live tracking");
    state.liveTimer = setInterval(() => { if (state.camOn && !state.busy) scan({ live: true }); }, LIVE_INTERVAL_MS);
    if (state.camOn) scan({ live: true });
  } else {
    clearInterval(state.liveTimer);
    setStatus("live off");
  }
}

function toggleTalk() {
  state.talk = !state.talk;
  els.talk.classList.toggle("on", state.talk);
  setStatus(state.talk ? "talking" : "quiet");
}

function autoStep() {
  if (!state.auto) return;
  const step = state.autoStep % 4;
  state.autoStep++;
  if (step === 0) {
    const word = (els.word.value || "SPOT").trim().slice(0, 18) || "SPOT";
    morphTarget({ kind: "text", text: word }, `→ “${word}”`);
  } else if (step === 1) {
    const shape = SHAPE_CYCLE[Math.floor(Math.random() * SHAPE_CYCLE.length)];
    morphTarget({ kind: "shape", shape }, `→ ${shape}`);
  } else if (step === 2) {
    disperse();
  } else {
    backToFace();
  }
  state.autoTimer = setTimeout(autoStep, AUTO_INTERVAL_MS);
}

function toggleAuto() {
  state.auto = !state.auto;
  els.auto.classList.toggle("on", state.auto);
  if (state.auto) { setStatus("auto — cycling face / words / shapes"); autoStep(); }
  else { clearTimeout(state.autoTimer); setStatus("auto off"); }
}

function setStatus(text) { els.status.textContent = text; }

function showPose(pose) {
  const fmt = v => (v === null || v === undefined ? "—" : `${v}°`);
  els.yaw.textContent = fmt(pose?.yaw);
  els.pitch.textContent = fmt(pose?.pitch);
  els.roll.textContent = fmt(pose?.roll);
  els.backend.textContent = `detector ${pose?.backend ?? "—"}`;
}

let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2600);
}

els.camera.addEventListener("click", enableCamera);
els.scan.addEventListener("click", () => scan());
els.live.addEventListener("click", toggleLive);
els.disperse.addEventListener("click", disperse);
els.sample.addEventListener("click", () => scan({ sample: true }));
els.talk.addEventListener("click", toggleTalk);
els.auto.addEventListener("click", toggleAuto);
els.wordBtn.addEventListener("click", () => {
  const word = (els.word.value || "").trim().slice(0, 18);
  morphTarget({ kind: "text", text: word || "HELLO" }, `→ “${word || "HELLO"}”`);
});
els.word.addEventListener("keydown", (e) => { if (e.key === "Enter") els.wordBtn.click(); });
els.shape.addEventListener("click", () => {
  const shape = SHAPE_CYCLE[state.shapeIdx++ % SHAPE_CYCLE.length];
  morphTarget({ kind: "shape", shape }, `→ ${shape}`);
});

// ---------------------------------------------------------------- boot

(async function boot() {
  setStatus("idle cloud — enable camera to scan your face");
  try {
    const h = await (await fetch("/api/health")).json();
    state.hasSample = !!h.sample;
    if (h.sample) els.sample.classList.remove("hidden");
    if (!h.opencv) { toast("Server is missing OpenCV — face scan disabled"); setStatus("server missing opencv"); }
  } catch {
    setStatus("server unreachable");
  }
})();
