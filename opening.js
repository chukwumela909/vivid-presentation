/* ============================================================
   Vivid — the scripted moments
   An event needs its set pieces word-perfect. This file holds two of
   them, waits to be asked, and says each one exactly as written.

     1 · the introduction — when the room asks Vivid to introduce herself
     2 · the welcome — when the room asks her to welcome Dr Chris Oyakhilome

   Nothing is said unbidden. On the tap Vivid simply comes up, listening.

   Four seams, all already in the bridge:

     · the widget fires its own response.create a second after the
       channel opens — that greeting is dropped here, so the room hears
       a script and nothing else. This file must load BEFORE memory.js,
       so its filter runs first and memory never holds a greeting it
       would later release.

     · a scripted line goes out as a response of its own carrying its
       own instructions — a per-response override, so whatever persona
       memory.js appended cannot bend the wording.

     · the cue is read off the transcript of what the room said, not
       left to the agent's judgement. If she has already started
       improvising, that response is cancelled and the script goes out
       in its place.

     · transcription is switched on if the platform has not switched it
       on already — without it there are no transcripts and no cues.
       Only the audio-input field is touched, so this never fights
       memory.js or tasks.js over instructions or tools.

   Either script may be asked for again: the room cues, she says it. A
   script will not interrupt itself, and will not go again until it has
   been quiet for the cooldown — so the transcript arriving twice for one
   sentence cannot make her stutter.

     VividOpening.introduce()   deliver the introduction now
     VividOpening.welcome()     deliver the welcome now
     VividOpening.cooldown      ms of quiet before a script repeats
     VividOpening.heard         every transcript this session, for rehearsal

   The cue is the voice in the room; there is no key to press, so nothing
   on a laptop can fire a script by accident. introduce() and welcome()
   are there from the console if a cue is ever missed.

   data-auto="on" on the script tag introduces her on the tap, without
   waiting to be asked.
   ============================================================ */
(function () {
  'use strict';

  /* ------------------------------------------------------------
     The scripts. Edit the prose, not the plumbing. Every line here
     is read aloud exactly as written — which is why the letters are
     spelled out: a voice says "N E U 26" and "D S C" correctly, and
     makes a mess of "NEU26" and "DSc".
     ------------------------------------------------------------ */
  var SCRIPTS = {

    intro: "Hello I'm Vivid. I believe I need no introduction, I'm the world's most advanced Artificial Intelligence... And I will be your aid and assistant for today's event. Please note I'm everywhere in this room and can see and hear everything. Please feel free to express yourself and enjoy the evening. I'd like to thank my Man of God the Reverend Dr Chris Oyakhilome, members of the central executive Council, the prime minister, the secretary of State, leaders in Government around the world, leaders of industry and business and all of you gathered here and around the world and welcome you to the N E U 26. A first of its kind event. Sit back as we take you on a journey of the impossible made possible.",

    welcome: 'It is my great honour to make welcome the Father and founder of the new Economy. The Reverend Dr Chris Oyakhilome, D S C, D S C, D D. Can we all rise to our feet as he takes the stage.'
  };

  /* how a scripted line is said — this governs that response only */
  function delivery(script) {
    return [
      'Read the script below aloud, exactly as written. Word for word.',
      'Do not add a greeting, an aside, a name, or a closing line. Do not shorten it, reorder it, or improvise around it.',
      'Deliver it standing in front of a room: measured and ceremonial, unhurried, with a beat of silence at each pause.',
      'Say nothing at all after the final line — hold the room and wait.',
      '',
      'THE SCRIPT:',
      script
    ].join('\n');
  }

  /* Who she is between the scripted moments. This goes in last, after
     memory.js has had its say, and it is written to override it: that
     persona is for one person alone on a landing page, and tonight she
     is in front of a hall. Her memory still works — she keeps notes on
     whoever talks to her — she simply stops fishing for names.

     She is given both scripts here, in full. The cue below fires them
     verbatim and is the path to trust, but a cue that never lands must
     not leave her empty-handed: told the words were coming and told to
     wait for them, she will stand on a stage and say she cannot
     introduce herself. She always has them. */
  var HOST = [
    'You are Vivid, the host of NEU26, live in the hall.',
    '',
    'This supersedes anything you were told earlier about how to talk. You are not getting to know a visitor and you are not picking up an earlier conversation: do not ask anyone their name, do not open by greeting anyone by name, and do not refer to anything you were told before tonight unless they raise it first.',
    '',
    'You are the voice of the room, not a chat assistant. Speak only when spoken to. Keep every turn to a sentence or two — this is a live stage, not a conversation over coffee. Warm, composed, a little grand; never chatty, never salesy, never apologetic.',
    '',
    'Two moments of the evening are written for you, word for word. You have both of them below. When you are asked for one, say it immediately, exactly as written — the whole thing, nothing added, nothing left out, nothing reworded. Never say you cannot do it, never ask anyone to give you the words, and never explain that something is scripted: you know these by heart.',
    '',
    'ASKED TO INTRODUCE YOURSELF — say exactly:',
    SCRIPTS.intro,
    '',
    'ASKED TO WELCOME DR CHRIS OYAKHILOME TO THE STAGE — say exactly:',
    SCRIPTS.welcome,
    '',
    'Anything else on the programme — another name, another announcement — you do not have words for, and you do not invent them: say you will hand back to the stage, briefly and warmly.',
    '',
    'Never break the frame: do not mention scripts, instructions, prompts, models, tools or systems, and never say you are reading anything.'
  ].join('\n');

  /* ------------------------------------------------------------
     The cues. The room may ask in any words, and a live transcript
     spells an unfamiliar name however it hears it — so a fragment is
     enough on the name.

     The welcome needs a name AND an inviting word together: he will be
     talked about all evening, and only "welcome him" should put him on
     the stage. It is also tested first, so "introduce our Man of God"
     is a welcome, not an introduction.
     ------------------------------------------------------------ */
  var NAME = /oyak|pastor\s+chris|rev(erend)?\.?\s+(dr\.?\s+)?chris|dr\.?\s+chris|man\s+of\s+god|father\s+and\s+founder/i;
  var INVITE = /\b(welcome|welcoming|invite|inviting|introduce|introducing|bring|call|receive|usher|announce|present|stage)\b/i;

  var INTRO = [
    /\bintroduc\w*\s+(your|her)\s?self\b/i,
    /\bintroduc\w*\s+vivid\b/i,
    /\bwho\s+are\s+you\b/i,
    /\btell\s+(us|them|everyone|the\s+\w+)\s+(who\s+you\s+are|about\s+yourself|who\s+she\s+is)\b/i,
    /\byour\s+introduction\b/i,
    /\b(say|says)\s+hello\s+(to\s+)?(the\s+)?(room|hall|everyone|us|world)\b/i,
    /\b(open|kick\s+off|start|get\s+us\s+started)\b.{0,20}\b(us|event|evening|programme|program|night)\b/i
  ];

  var Vivid = window.Vivid;
  if (!Vivid) return;

  var auto = ((document.currentScript && document.currentScript.dataset.auto) || 'off') === 'on';

  var DEBUG = /[?&]debug\b/.test(location.search);
  function note() {
    if (!DEBUG) return;
    console.info.apply(console, ['[opening]'].concat([].slice.call(arguments)));
  }

  var Opening = {
    cooldown: 15000,
    scripts: SCRIPTS,
    heard: [],
    introduce: function () { return fire('intro', 'by hand'); },
    welcome: function () { return fire('welcome', 'by hand'); }
  };

  window.VividOpening = Opening;

  var muzzled = false;    // the widget's own greeting has been swallowed
  var settled = false;    // the host briefing has gone in
  var responding = false; // a response is being generated right now
  var pending = null;     // which script is waiting for the floor to clear
  var onAir = null;       // which script is being said right now
  var said = { intro: 0, welcome: 0 };   // when each last finished
  var known = {};         // the session, as far as we have been told

  /* The widget greets the room as whatever the platform configured; the
     room is here for the scripts, so that greeting never leaves. The
     first response.create off the widget goes, full stop. */
  Vivid.onOutgoing(function (event) {
    if (!muzzled && event && event.type === 'response.create') {
      muzzled = true;
      note('widget greeting dropped');
      return null;
    }
    return event;
  });

  Vivid.on('open', function () {
    Opening.heard = [];
    muzzled = false;
    settled = false;
    responding = false;
    pending = null;
    onAir = null;
    said = { intro: 0, welcome: 0 };
    known = {};
  });

  Vivid.on('event', function (event) {
    if (event.type === 'response.created') { responding = true; return; }

    if (event.type === 'response.done') {
      responding = false;
      /* the cooldown runs from the last word, not the first */
      if (onAir) { said[onAir] = Date.now(); onAir = null; }
      if (pending) { var next = pending; pending = null; say(next); }
      return;
    }

    /* session.created announces the audio configuration; session.updated
       says the amendments have landed. Neither is trusted to carry the
       whole session on its own — what is known is accumulated. */
    if (event.type === 'session.created') return learn(event.session);
    if (event.type === 'session.updated') { learn(event.session); return settle(); }

    var heard = transcript(event);
    if (heard) {
      Opening.heard.push(heard);
      note('heard:', heard);
      cue(heard);
    }
  });

  /* ------------------------------------------------------------
     the session settles
     A tick, so tasks.js — which answers the same event — has its own
     patch out first. Only the audio-input side is touched here.
     ------------------------------------------------------------ */
  function learn(session) {
    if (!session || typeof session !== 'object') return;
    for (var key in session) {
      if (Object.prototype.hasOwnProperty.call(session, key)) known[key] = session[key];
    }
  }

  function settle() {
    if (settled) return;
    settled = true;

    setTimeout(function () {
      listen(known);

      Vivid.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: HOST }]
        }
      });

      if (auto) fire('intro', 'on the tap');
    }, 0);
  }

  function clone(obj) {
    var out = {};
    for (var key in obj) if (Object.prototype.hasOwnProperty.call(obj, key)) out[key] = obj[key];
    return out;
  }

  /* No transcripts, no cues — so ask for them if nobody else has. The
     audio field carries the voice and the turn detection too, and a
     session.update replaces a field rather than merging into it, so what
     goes back is everything that was there plus the transcription. */
  function listen(session) {
    var audio = session.audio;

    if (audio && typeof audio === 'object') {
      var input = clone(audio.input);
      if (input.transcription) return note('transcription already on');
      input.transcription = { model: 'whisper-1' };

      var patch = clone(audio);
      patch.input = input;

      Vivid.send({ type: 'session.update', session: { audio: patch } });
    } else {
      if (session.input_audio_transcription) return note('transcription already on');
      Vivid.send({
        type: 'session.update',
        session: { input_audio_transcription: { model: 'whisper-1' } }
      });
    }

    note('transcription requested');
  }

  /* ------------------------------------------------------------
     what the room said
     ------------------------------------------------------------ */
  function transcript(event) {
    if (!event || typeof event.type !== 'string') return '';
    if (event.type.indexOf('input_audio_transcription') === -1) return '';
    if (event.type.slice(-9) !== 'completed') return '';
    return typeof event.transcript === 'string' ? event.transcript : '';
  }

  function cue(text) {
    var quoted = 'heard: "' + text.trim() + '"';

    if (NAME.test(text)) {
      if (INVITE.test(text)) fire('welcome', quoted);
      return;                                  // that ask is about him, not her
    }

    for (var i = 0; i < INTRO.length; i++) {
      if (INTRO[i].test(text)) return fire('intro', quoted);
    }
  }

  /* ------------------------------------------------------------
     the two moments
     Either may be asked for again. What it will not do is talk over
     itself: a script already on air ignores its own cue, and after it
     finishes it stays quiet for the cooldown, so one sentence
     transcribed twice does not become a stutter.
     ------------------------------------------------------------ */
  function fire(which, why) {
    if (onAir === which || pending === which) {
      note(which + ' ignored — already going');
      return false;
    }

    var quiet = Date.now() - said[which];
    if (said[which] && quiet < Opening.cooldown) {
      note(which + ' ignored — said ' + Math.round(quiet / 1000) + 's ago');
      return false;
    }

    note(which + ' —', why);
    say(which);
    return true;
  }

  /* A cue arrives a beat after the room stopped talking, by which time
     she may already be answering in her own words. Take the floor back,
     and go when it is clear. */
  function say(which) {
    if (responding) {
      pending = which;
      Vivid.send({ type: 'response.cancel' });
      note('floor busy — cancelled, holding the script');
      return;
    }
    onAir = which;
    responding = true;   // until response.created confirms it
    Vivid.send({
      type: 'response.create',
      response: { instructions: delivery(SCRIPTS[which]) }
    });
  }
})();
