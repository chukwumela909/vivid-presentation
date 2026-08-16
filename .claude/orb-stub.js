/* ============================================================
   Dev-only stand-in for platformvivid's widget.js.
   The live key is origin-locked, so localhost can never reach the real
   agent — this reproduces the whole contract the page is built on so
   the orb, the bridge, the memory and the session cap can all be
   exercised offline:

     · a div[data-vivid] host with a CLOSED shadow root, a .pill status
       label and a <canvas> whose click toggles the call
     · a real RTCPeerConnection, looped back to a second one in this
       same page, carrying an 'oai-events' data channel and an audio
       track that stands in for the agent's voice
     · enough of the Realtime protocol to answer: session.created,
       session.updated, a spoken response, and — six seconds in — a
       remember() tool call, so memory.js can be seen doing its job
     · the widget's own quirks, because the page depends on them: the
       response.create fired one second after the channel opens, and
       tool calls executed blindly and reported back

   Loaded in place of widget.js by serve.mjs when the URL carries ?stub.
   Never referenced by index.html.
   ============================================================ */
(function () {
  'use strict';

  var STATUS = {
    idle: '', connecting: 'Connecting', ready: 'Ready',
    thinking: 'Thinking', speaking: 'Speaking', error: 'Error'
  };

  /* ---------- the widget's shell ---------- */
  var host = document.createElement('div');
  host.setAttribute('data-vivid', '');
  var shadow = host.attachShadow({ mode: 'closed' });

  var style = document.createElement('style');
  style.textContent =
    ':host{all:initial}.wrap{position:fixed;right:14px;bottom:14px;z-index:2147483000;' +
    'display:flex;flex-direction:column;align-items:center;gap:2px;font-family:system-ui,sans-serif}' +
    '.pill{background:rgba(20,20,24,.85);color:#fff;font-size:12px;padding:4px 10px;border-radius:999px;opacity:0}' +
    'canvas{cursor:pointer;display:block;border-radius:50%;background:radial-gradient(circle at 40% 35%,#8b7bff,#4a34d4)}';

  var wrap = document.createElement('div');
  wrap.className = 'wrap';
  var pill = document.createElement('div');
  pill.className = 'pill';
  var canvas = document.createElement('canvas');
  canvas.style.width = canvas.style.height = '88px';

  wrap.append(pill, canvas);
  shadow.append(style, wrap);
  document.body.appendChild(host);

  var status = 'idle';
  function set(next) {
    status = next;
    pill.textContent = STATUS[next];
    pill.style.opacity = STATUS[next] ? '1' : '0';
  }
  set('idle');

  /* ---------- call plumbing ---------- */
  var pcIn = null, pcOut = null;   // pcIn is "the widget's"; pcOut plays the far end
  var dc = null;                   // the widget's side of oai-events
  var wire = null;                 // the far end's side
  var audio = null, actx = null, osc = null, gain = null;
  var timers = [];

  canvas.addEventListener('click', function () {
    if (status === 'idle' || status === 'error') connect();
    else hangup();
  });

  async function connect() {
    set('connecting');
    try {
      /* the real widget treats a refused mic as fatal; the harness carries
         on without one so the rest of the call can still be exercised in
         environments that block capture outright */
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        console.warn('[stub] no microphone — mic levels will read 0', err.name);
      }

      pcIn = new RTCPeerConnection();
      pcOut = new RTCPeerConnection();

      pcIn.onicecandidate = function (e) { if (e.candidate) pcOut.addIceCandidate(e.candidate); };
      pcOut.onicecandidate = function (e) { if (e.candidate) pcIn.addIceCandidate(e.candidate); };

      /* the far end's voice */
      actx = new AudioContext();
      osc = actx.createOscillator();
      gain = actx.createGain();
      var sink = actx.createMediaStreamDestination();
      osc.type = 'sawtooth';
      osc.frequency.value = 150;
      gain.gain.value = 0;
      osc.connect(gain).connect(sink);
      osc.start();
      pcOut.addTrack(sink.stream.getAudioTracks()[0], sink.stream);

      pcIn.addTransceiver('audio', { direction: 'recvonly' });
      pcIn.ontrack = function (e) {
        /* the real widget plays through a detached Audio element */
        audio = new Audio();
        audio.srcObject = e.streams[0];
        /* quiet, but genuinely playing: Chrome only pumps a remote track
           into WebAudio once something is pulling on it */
        audio.volume = 0.04;
        audio.play().catch(function () {});
      };

      dc = pcIn.createDataChannel('oai-events');
      dc.onmessage = function (e) { widgetHeard(JSON.parse(e.data)); };
      dc.onopen = function () {
        set('ready');
        /* the widget's own greeting trigger, one second late */
        after(1000, function () { widgetSend({ type: 'response.create' }); });
      };

      pcOut.ondatachannel = function (e) {
        wire = e.channel;
        wire.onmessage = function (m) { farEndHeard(JSON.parse(m.data)); };
        wire.onopen = function () {
          farEndSend({ type: 'session.created', session: SESSION });
        };
      };

      var offer = await pcIn.createOffer();
      await pcIn.setLocalDescription(offer);
      await pcOut.setRemoteDescription(offer);
      var answer = await pcOut.createAnswer();
      await pcOut.setLocalDescription(answer);
      await pcIn.setRemoteDescription(answer);
    } catch (err) {
      console.warn('[stub] connect failed', err);
      set('error');
    }
  }

  function hangup() {
    timers.forEach(clearTimeout);
    timers = [];
    try { osc && osc.stop(); } catch (e) {}
    try { actx && actx.close(); } catch (e) {}
    if (audio) { audio.pause(); audio.srcObject = null; audio = null; }
    if (pcIn) pcIn.close();
    if (pcOut) pcOut.close();
    pcIn = pcOut = dc = wire = osc = gain = actx = null;
    set('idle');
  }

  function after(ms, fn) { timers.push(setTimeout(fn, ms)); }

  /* ---------- the widget's side ---------- */
  function widgetSend(event) { if (dc && dc.readyState === 'open') dc.send(JSON.stringify(event)); }

  function widgetHeard(event) {
    if (event.type === 'response.created') set('speaking');

    if (event.type === 'response.done') {
      set('ready');
      (event.response.output || []).forEach(function (item) {
        if (item.type !== 'function_call') return;
        /* the real widget runs every call through its own tool endpoint,
           which has never heard of remember() — the page rewrites this */
        set('thinking');
        after(400, function () {
          widgetSend({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: item.call_id, output: 'Failed: unknown tool.' }
          });
          widgetSend({ type: 'response.create' });
          set('ready');
        });
      });
    }
  }

  /* ---------- the far end ---------- */
  var turn = 0;

  /* the session as the far end holds it: what session.created announces,
     what every patch is applied to, and what session.updated hands back.
     The GA shape — the voice and the turn detection live under audio, and
     a patch replaces that field whole, so anything switching transcription
     on has to carry the rest of it back untouched. */
  var SESSION = {
    type: 'realtime',
    instructions: 'You are the platform-configured Vivid agent. Be helpful about the product.',
    tools: [{ type: 'function', name: 'navigate', description: 'stand-in for a server tool', parameters: { type: 'object', properties: {} } }],
    audio: {
      input: { format: 'pcm16', turn_detection: { type: 'server_vad', threshold: 0.5 } },
      output: { format: 'pcm16', voice: 'alloy' }
    }
  };

  function farEndSend(event) { if (wire && wire.readyState === 'open') wire.send(JSON.stringify(event)); }

  function farEndHeard(event) {
    if (event.type === 'session.update') {
      console.info('[stub] session.update — tools:',
        (event.session.tools || []).map(function (t) { return t.name; }).join(', '));
      if (event.session.audio) console.info('[stub] session.update — audio:', JSON.stringify(event.session.audio));
      /* a patch replaces the fields it names and leaves the rest alone,
         and what comes back is the whole session, not the patch */
      Object.keys(event.session).forEach(function (key) { SESSION[key] = event.session[key]; });
      farEndSend({ type: 'session.updated', session: SESSION });
      return;
    }

    if (event.type === 'conversation.item.create' && event.item.type === 'function_call_output') {
      console.info('[stub] tool result reached the model:', event.item.output);
      return;
    }

    if (event.type === 'conversation.item.create') {
      console.info('[stub] context item:', event.item.content && event.item.content[0].text);
      return;
    }

    if (event.type === 'response.cancel') {
      if (!speaking) return;
      clearTimeout(speaking);
      speaking = 0;
      hush();
      console.info('[stub] response cancelled');
      farEndSend({ type: 'response.done', response: { status: 'cancelled', output: [] } });
      return;
    }

    if (event.type === 'response.create') {
      var override = event.response && event.response.instructions;
      if (override) console.info('[stub] response instructions:\n' + override);
      speak();
    }
  }

  var speaking = 0;   // the turn in flight, so response.cancel can end it

  function hush() {
    if (!actx || !gain) return;
    gain.gain.cancelScheduledValues(actx.currentTime);
    gain.gain.setValueAtTime(0, actx.currentTime);
  }

  /* a spoken turn: modulate the tone so the level meter has something to
     follow, then close the response — and on the second turn, ask to
     remember something */
  function speak() {
    turn++;
    farEndSend({ type: 'response.created' });

    var seconds = 3.2;
    var start = actx.currentTime;
    gain.gain.cancelScheduledValues(start);
    gain.gain.setValueAtTime(0, start);
    for (var i = 0; i < seconds * 6; i++) {
      var at = start + i / 6;
      gain.gain.linearRampToValueAtTime(0.05 + Math.random() * 0.22, at + 0.05);
      gain.gain.linearRampToValueAtTime(0.02, at + 0.14);
    }
    gain.gain.linearRampToValueAtTime(0, start + seconds);

    speaking = setTimeout(function () {
      speaking = 0;
      var output = [{ type: 'message', role: 'assistant' }];

      if (turn === 1) {
        output.push({
          type: 'function_call',
          name: 'remember',
          call_id: 'call_stub_' + turn,
          arguments: JSON.stringify({ name: 'Amiri', note: 'Building a voice-first landing page; likes things quiet.' })
        });
      }

      /* ...and on the second, start background work, so tasks.js and its
         worker can be seen carrying a result back into the session */
      if (turn === 2) {
        output.push({
          type: 'function_call',
          name: 'run_task',
          call_id: 'call_stub_' + turn,
          arguments: JSON.stringify({ task: 'timer', seconds: 4 })
        });
      }

      farEndSend({ type: 'response.done', response: { output: output } });
    }, seconds * 1000);
    timers.push(speaking);
  }

  window.__orbStub = {
    tap: function () { canvas.click(); },
    /* put words in the room's mouth: the transcript of a spoken turn,
       which is what opening.js listens to for its cue */
    hear: function (text) {
      farEndSend({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_stub_heard',
        transcript: text
      });
    },
    status: function () { return status; },
    fail: function () { set('error'); },
    peek: function () {
      return {
        connection: pcIn && pcIn.connectionState,
        channel: dc && dc.readyState,
        receiving: pcIn ? pcIn.getReceivers().map(function (r) {
          return r.track && r.track.kind + ':' + r.track.readyState + (r.track.muted ? ':muted' : '');
        }) : [],
        playing: audio ? !audio.paused : false
      };
    },
    incoming: function () {
      var rx = pcIn && pcIn.getReceivers()[0];
      return rx && rx.track ? new MediaStream([rx.track]) : null;
    }
  };
})();
