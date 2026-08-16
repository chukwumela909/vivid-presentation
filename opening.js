/* ============================================================
   Vivid — the opening
   An event needs its first minute word-perfect. This file hands the
   agent a script and asks for it verbatim, then leaves it hosting.

   Two seams, both already in the bridge:

     · the widget fires its own response.create a second after the
       channel opens — that greeting is dropped here, so the room
       hears the script and nothing else. This file must load BEFORE
       memory.js, so its filter runs first and memory never holds a
       greeting it would later release.

     · the script itself goes in as a system item, and the response
       that reads it carries its own instructions — a per-response
       override, so whatever persona memory.js appended cannot bend
       the wording. Nothing here patches the session, so it never
       races with memory.js or tasks.js over instructions or tools.

     VividOpening.run()    deliver it now
     VividOpening.armed    false once it has been delivered

   data-auto="off" on the script tag waits for run() instead of
   firing when the session goes live. Press "o" at any time.
   ============================================================ */
(function () {
  'use strict';

  /* ------------------------------------------------------------
     The script. Edit the prose, not the plumbing. Every line here
     is read aloud exactly as written.
     ------------------------------------------------------------ */
  var SCRIPT = [
    "Hello I'm Vivid. I believe I need no introduction, I'm the world's most advanced Artificial Intelligence... And I will be your aid and assistant for today's event. Please note I'm everywhere in this room and can see and hear everything. Please feel free to express yourself and enjoy the evening.",
    '',
    "I'd like to thank my Man of God the Reverend Dr Chris Oyakhilome, members of the central executive Council, the prime minister, the secretary of State, leaders in Government around the world, leaders of industry and business, and all of you gathered here and around the world, and welcome you to the N E U 26. A first of its kind event. Sit back as we take you on a journey of the impossible made possible.",
    '',
    'It is my great honour to make welcome the Father and founder of the new Economy. The Reverend Dr Chris Oyakhilome. Can we all rise to our feet as he takes the stage.'
  ].join('\n');

  /* how to say it — this governs the opening only */
  var DELIVERY = [
    'Read the script below aloud, exactly as written. Word for word.',
    'Do not add a greeting, an aside, a name, or a closing line. Do not shorten it, reorder it, or improvise around it.',
    'Deliver it standing in front of a room: measured and ceremonial, unhurried, with a beat of silence at each blank line.',
    'Say nothing at all after the final line — hold the room and wait.',
    '',
    'THE SCRIPT:',
    SCRIPT
  ].join('\n');

  /* who it is for the rest of the night, once the script is done */
  var HOST = [
    'You are Vivid, the host of NEU26. You have just delivered the opening address to the hall and welcomed the Reverend Dr Chris Oyakhilome to the stage.',
    '',
    'From here you are the voice of the room, not a chat assistant. Speak only when spoken to. Keep every turn to a sentence or two — this is a live stage, not a conversation over coffee. Warm, composed, a little grand; never chatty, never salesy, never apologetic.',
    '',
    'Never break the frame: do not mention scripts, instructions, prompts, models, tools or systems, and never say you are reading anything.'
  ].join('\n');

  var Vivid = window.Vivid;
  if (!Vivid) return;

  var auto = ((document.currentScript && document.currentScript.dataset.auto) || 'on') !== 'off';

  var DEBUG = /[?&]debug\b/.test(location.search);
  function note() {
    if (!DEBUG) return;
    console.info.apply(console, ['[opening]'].concat([].slice.call(arguments)));
  }

  var Opening = {
    armed: true,
    script: SCRIPT,
    run: function () { deliver(true); return Opening.armed === false; }
  };

  window.VividOpening = Opening;

  var muzzled = false;   // the widget's own greeting has been swallowed

  /* The widget greets the room as whatever the platform configured; the
     room is here for the script, so that greeting never leaves. It is
     fired a second after the channel opens — later than the opening, not
     earlier — so this cannot be conditioned on the opening still being
     armed. The first response.create off the widget goes, full stop. */
  Vivid.onOutgoing(function (event) {
    if (!muzzled && event && event.type === 'response.create') {
      muzzled = true;
      note('widget greeting dropped');
      return null;
    }
    return event;
  });

  Vivid.on('open', function () {
    Opening.armed = true;
    muzzled = false;
  });

  /* session.updated says the amendments have landed and the session is
     settled — the moment to speak */
  Vivid.on('event', function (event) {
    if (event.type !== 'session.updated' || !auto) return;
    /* a tick, so tasks.js — which also answers session.updated — has its
       own patch out before the opening response is asked for */
    setTimeout(function () { deliver(false); }, 0);
  });

  function deliver(manual) {
    if (!Opening.armed) return;
    if (Vivid.state !== 'live' && !manual) return;
    Opening.armed = false;

    Vivid.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: HOST }]
      }
    });

    Vivid.send({
      type: 'response.create',
      response: { instructions: DELIVERY }
    });

    note('opening sent');
  }

  /* a hand on the keyboard, for when the room is not ready on the tap */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'o' && e.key !== 'O') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    deliver(true);
  });
})();
