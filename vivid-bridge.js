/* ============================================================
   Vivid — bridge
   The embedded widget is a closed box: a closed shadow root, no public
   API beyond window.__vivid.run, and its own small orb bottom-right.
   We keep its transport (OpenAI Realtime over WebRTC) and throw away
   its pixels, so this file is the seam between the two.

   It must run BEFORE widget.js — every patch here has to be in place
   before the widget constructs anything.

     Vivid.on('phase',  fn)  idle · connecting · listening · thinking · speaking · error
     Vivid.on('level',  fn)  {mic, agent} 0..1, per animation frame
     Vivid.on('event',  fn)  realtime events arriving on the data channel
     Vivid.on('open',   fn)  data channel is live
     Vivid.tap()             start or end the session
     Vivid.send(obj)         push a realtime event
     Vivid.onOutgoing(fn)    inspect/rewrite/drop what the widget sends
   ============================================================ */
(function () {
  'use strict';

  /* the widget's status pill is the only phase signal it exposes */
  var PHASE = {
    '': 'idle',
    'Connecting': 'connecting',
    'Ready': 'listening',
    'Listening': 'listening',
    'Thinking': 'thinking',
    'Speaking': 'speaking',
    'Error': 'error'
  };

  /* four coarse states — everything visual keys off these */
  var STATE = {
    idle: 'idle',
    connecting: 'connecting',
    listening: 'live',
    thinking: 'live',
    speaking: 'live',
    error: 'error'
  };

  var listeners = Object.create(null);
  var outgoing = [];          // filters over the widget's own sends
  var queued = [];            // our sends, before the channel opens

  var orb = null;             // the widget's canvas — our tap target
  var channel = null;
  var channelSend = null;     // unpatched, ours to use
  var wantsTap = false;

  var Vivid = {
    phase: 'idle',
    state: 'idle',
    mounted: false,
    levels: { mic: 0, agent: 0 },

    on: function (name, fn) {
      (listeners[name] || (listeners[name] = [])).push(fn);
      return Vivid;
    },

    off: function (name, fn) {
      var list = listeners[name];
      if (list) listeners[name] = list.filter(function (f) { return f !== fn; });
      return Vivid;
    },

    /* toggles the session: the widget listens for a click on its canvas */
    tap: function () {
      if (!orb) { wantsTap = true; return; }
      orb.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    },

    send: function (obj) {
      if (!channelSend || channel.readyState !== 'open') { queued.push(obj); return; }
      try { channelSend(JSON.stringify(obj)); } catch (err) { warn('send failed', err); }
    },

    /* fn(event) -> event | null. Returning null drops it. */
    onOutgoing: function (fn) { outgoing.push(fn); return Vivid; }
  };

  window.Vivid = Vivid;

  var DEBUG = /[?&]debug\b/.test(location.search);
  function warn() {
    if (!DEBUG) return;
    console.warn.apply(console, ['[vivid]'].concat([].slice.call(arguments)));
  }

  function emit(name, payload) {
    var list = listeners[name];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (err) { warn(name + ' listener threw', err); }
    }
  }

  /* ============================================================
     1 · the shadow root
     The widget attaches a closed root, so its status and its canvas are
     both unreachable from outside. The host carries data-vivid before
     attachShadow runs, which is the one moment we can force it open.
     ============================================================ */
  var nativeAttach = Element.prototype.attachShadow;

  Element.prototype.attachShadow = function (init) {
    var isWidget = this.nodeType === 1 && this.hasAttribute('data-vivid');
    var root = nativeAttach.call(this, isWidget ? { mode: 'open' } : init);
    if (isWidget) {
      Element.prototype.attachShadow = nativeAttach;   // one root only
      awaitMount(root);
    }
    return root;
  };

  /* the root is empty here; the widget renders into it a tick later */
  function awaitMount(root) {
    var mo = new MutationObserver(function () {
      var canvas = root.querySelector('canvas');
      var pill = root.querySelector('.pill');
      if (!canvas || !pill) return;
      mo.disconnect();
      mount(canvas, pill);
    });
    mo.observe(root, { childList: true, subtree: true });
  }

  function mount(canvas, pill) {
    orb = canvas;
    Vivid.mounted = true;

    new MutationObserver(function () { readPhase(pill); })
      .observe(pill, { childList: true, characterData: true, subtree: true });

    readPhase(pill);
    emit('mount', null);

    if (wantsTap) { wantsTap = false; Vivid.tap(); }
  }

  function readPhase(pill) {
    var text = (pill.textContent || '').trim();
    var phase = PHASE[text] || (text ? 'listening' : 'idle');
    if (phase === Vivid.phase) return;

    var prev = Vivid.phase;
    Vivid.phase = phase;
    Vivid.state = STATE[phase];

    document.body.setAttribute('data-phase', Vivid.state);
    document.body.setAttribute('data-mode', phase);

    if (Vivid.state !== 'live') decay();
    emit('phase', { phase: phase, state: Vivid.state, prev: prev });
  }

  /* ============================================================
     2 · the peer connection
     Gives us two things the widget keeps to itself: the agent's audio
     track, and the oai-events data channel that carries the session.
     ============================================================ */
  var NativePC = window.RTCPeerConnection;

  if (NativePC) {
    var PatchedPC = function (config) {
      var pc = new NativePC(config);

      /* addEventListener rather than .ontrack — the widget assigns that */
      pc.addEventListener('track', function (ev) {
        if (ev.track && ev.track.kind !== 'audio') return;
        var stream = ev.streams && ev.streams[0];
        if (!stream && ev.track) stream = new MediaStream([ev.track]);
        if (stream) meter(stream, 'agent');
      });

      var nativeCreate = pc.createDataChannel.bind(pc);
      pc.createDataChannel = function (label, opts) {
        var ch = nativeCreate(label, opts);
        if (label === 'oai-events') adopt(ch);
        return ch;
      };

      pc.addEventListener('connectionstatechange', function () {
        if (pc.connectionState === 'closed' || pc.connectionState === 'failed') release();
      });

      return pc;
    };

    PatchedPC.prototype = NativePC.prototype;
    ['generateCertificate', 'getDefaultIceServers'].forEach(function (fn) {
      if (NativePC[fn]) PatchedPC[fn] = NativePC[fn].bind(NativePC);
    });
    window.RTCPeerConnection = PatchedPC;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = PatchedPC;
  }

  function adopt(ch) {
    channel = ch;
    channelSend = ch.send.bind(ch);

    /* every event the widget sends passes through the filters first, so a
       tool result can be rewritten before it reaches the model */
    ch.send = function (data) {
      if (!outgoing.length) return channelSend(data);

      var parsed;
      try { parsed = JSON.parse(data); } catch (err) { return channelSend(data); }

      for (var i = 0; i < outgoing.length; i++) {
        try {
          var next = outgoing[i](parsed);
          if (next === null) return;               // dropped
          if (next) parsed = next;
        } catch (err) { warn('outgoing filter threw', err); }
      }
      return channelSend(JSON.stringify(parsed));
    };

    ch.addEventListener('message', function (ev) {
      var event;
      try { event = JSON.parse(ev.data); } catch (err) { return; }
      emit('event', event);
    });

    ch.addEventListener('open', function () {
      emit('open', ch);
      var pending = queued.splice(0, queued.length);
      for (var i = 0; i < pending.length; i++) Vivid.send(pending[i]);
    });

    ch.addEventListener('close', release);
  }

  /* ============================================================
     3 · the microphone
     ============================================================ */
  var media = navigator.mediaDevices;

  if (media && media.getUserMedia) {
    var nativeGUM = media.getUserMedia.bind(media);
    media.getUserMedia = function (constraints) {
      return nativeGUM(constraints).then(function (stream) {
        if (stream.getAudioTracks().length) meter(stream, 'mic');
        return stream;
      });
    };
  }

  /* ============================================================
     4 · levels
     One shared context, one analyser per side. The widget runs its own
     meter for its own orb; these are ours and cost nothing next to the
     call itself.
     ============================================================ */
  var ctx = null;
  var taps = { mic: null, agent: null };
  var raf = 0;
  var buf = null;

  function meter(stream, side) {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!ctx) ctx = new Ctx();
      if (ctx.state === 'suspended') ctx.resume().catch(function () {});

      var analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      ctx.createMediaStreamSource(stream).connect(analyser);

      if (!buf || buf.length !== analyser.fftSize) buf = new Float32Array(analyser.fftSize);
      taps[side] = analyser;

      if (!raf) raf = requestAnimationFrame(sample);
    } catch (err) {
      warn('could not meter ' + side, err);
    }
  }

  function rms(analyser) {
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(buf);
    var sum = 0;
    for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    /* speech sits low in a linear scale — lift it into a usable range */
    return Math.min(1, Math.sqrt(sum / buf.length) * 4.4);
  }

  function sample() {
    raf = requestAnimationFrame(sample);
    ease('mic', rms(taps.mic));
    ease('agent', rms(taps.agent));
    emit('level', Vivid.levels);
  }

  /* fast to rise, slow to fall — the orb should catch a consonant but
     not flicker between syllables */
  function ease(side, target) {
    var now = Vivid.levels[side];
    Vivid.levels[side] = now + (target - now) * (target > now ? 0.5 : 0.09);
  }

  function decay() {
    Vivid.levels.mic = 0;
    Vivid.levels.agent = 0;
  }

  function release() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    taps.mic = taps.agent = null;
    decay();
    if (ctx) {
      var closing = ctx;
      ctx = null;
      closing.close().catch(function () {});
    }
    channel = null;
    channelSend = null;
  }

  document.body ? document.body.setAttribute('data-phase', 'idle')
                : document.addEventListener('DOMContentLoaded', function () {
                    document.body.setAttribute('data-phase', 'idle');
                  });
})();
