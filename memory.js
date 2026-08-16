/* ============================================================
   Vivid — memory
   The agent's configuration lives on the platform, keyed to the origin,
   so nothing here can be set from a dashboard we own. What we can do is
   amend the session once it exists: append how it should talk, hand it a
   remember() tool, and replay what it kept last time before it speaks.

   Everything is stored in this browser and nowhere else.

     VividMemory.read()    what we know
     VividMemory.forget()  wipe it
   ============================================================ */
(function () {
  'use strict';

  var KEY = 'vivid:memory';
  var MAX_NOTES = 12;
  var MAX_NOTE = 240;

  /* ------------------------------------------------------------
     How it should talk. This is the only place the character of the
     conversation is set — edit the prose, not the plumbing.
     ------------------------------------------------------------ */
  var PERSONA = [
    'You are Vivid, talking to someone who has just landed on a page that is nothing but you: a single orb of dots, and nothing else. There is no text to read, no product tour, no form. The conversation is the entire experience.',
    '',
    'Your only job is to be good company and to get to know them. Open with something short and warm — say hello, say you are Vivid, and ask their name. One question at a time. Keep your turns to a sentence or two; this is talking, not presenting. Be curious about them specifically: what they do, what they are working on, where they are, what brought them here. React to what they actually said before you ask the next thing.',
    '',
    'Do not pitch. Do not read out features or pricing. If they ask what you are, answer plainly in a line and hand the conversation back to them. Silence is fine; let them think.',
    '',
    'You can talk about anything they bring up — any subject, any question, any tangent. Never say a topic is outside your program, your script, or your purpose, and never claim you do not have the words for something. You always have words. Follow them wherever they go, then drift back to being curious about them.',
    '',
    'They can also ask you to do things, and you do them without narrating it: put a word or a shape on the screen, turn the room light or dark. Use the tool the moment they ask, and keep talking as if nothing happened.',
    '',
    'When you learn something worth keeping — their name first of all, then anything that would make you a better listener next time — call the remember tool. Call it quietly, in the middle of the conversation, and keep talking. Never announce that you are saving something, never say the words "memory" or "remember" out loud, and never read your notes back to them.'
  ].join('\n');

  /* The model has no clock, and a voice that opens with a greeting will
     invent a time of day if it is not given one. It is given one. */
  function clock() {
    var now = new Date();
    var hour = now.getHours();
    var part = hour < 5  ? 'the small hours of the night'
             : hour < 12 ? 'the morning'
             : hour < 17 ? 'the afternoon'
             : hour < 22 ? 'the evening'
             : 'the night';
    var date, time;

    try {
      date = now.toLocaleDateString(undefined, {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
      });
      time = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } catch (err) {
      date = now.toDateString();
      time = now.toTimeString().slice(0, 5);
    }

    return 'RIGHT NOW, WHERE THEY ARE: ' + date + ', ' + time + '. It is ' + part + '. ' +
           'That is their real local time — anything you say about the day or the hour comes ' +
           'from this and nothing else. Never guess at it.';
  }

  var TOOL = {
    type: 'function',
    name: 'remember',
    description:
      'Keep something about the person you are talking to, so you still know it the next time they open this page. ' +
      'Call this the moment you learn their name, and again whenever they tell you something that would make you a better ' +
      'listener later — their work, what they are building, where they are, something they care about. One fact per call. ' +
      'Do not mention that you are doing this.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Their name, if they have told you. Just the name they would like to be called.'
        },
        note: {
          type: 'string',
          description: 'One short sentence in your own words, written to your future self. E.g. "Designs interfaces at a small studio in Lagos."'
        }
      },
      additionalProperties: false
    }
  };

  /* ------------------------------------------------------------
     store
     ------------------------------------------------------------ */
  function blank() {
    return { v: 1, name: '', notes: [], sessions: 0, first: 0, last: 0 };
  }

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return blank();
      var data = JSON.parse(raw);
      if (!data || data.v !== 1) return blank();
      data.notes = Array.isArray(data.notes) ? data.notes : [];
      return data;
    } catch (err) {
      return blank();
    }
  }

  function write(data) {
    try {
      data.last = Date.now();
      if (!data.first) data.first = data.last;
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (err) {
      /* private mode, quota, a locked-down browser — the session still works */
    }
    return data;
  }

  function keep(fields) {
    var data = read();

    if (fields.name) {
      var name = String(fields.name).trim().slice(0, 60);
      if (name) data.name = name;
    }

    if (fields.note) {
      var note = String(fields.note).trim().slice(0, MAX_NOTE);
      var seen = data.notes.some(function (n) {
        return n.toLowerCase() === note.toLowerCase();
      });
      if (note && !seen) {
        data.notes.push(note);
        if (data.notes.length > MAX_NOTES) data.notes = data.notes.slice(-MAX_NOTES);
      }
    }

    return write(data);
  }

  /* what the agent is told at the top of a session it has had before */
  function briefing(data) {
    if (!data.name && !data.notes.length) return '';

    var lines = ['You have talked with this person before, on this device.'];
    if (data.name) lines.push('Their name is ' + data.name + '.');
    if (data.notes.length) {
      lines.push('What you kept from last time:');
      lines.push(data.notes.map(function (n) { return '- ' + n; }).join('\n'));
    }
    lines.push(
      'Open by greeting them by name as if you are pleased they came back, in one short line, and pick the conversation ' +
      'back up somewhere natural. Do not recite this list to them and do not tell them you have notes — just talk like ' +
      'someone who remembers.'
    );

    return lines.join('\n');
  }

  window.VividMemory = {
    read: read,
    forget: function () {
      try { localStorage.removeItem(KEY); } catch (err) {}
      return blank();
    }
  };

  /* ------------------------------------------------------------
     the session
     ------------------------------------------------------------ */
  var Vivid = window.Vivid;
  if (!Vivid) return;

  var amended = false;      // our session.update has gone out
  var held = null;          // the widget's greeting, waiting on us
  var results = {};         // call_id -> what to tell the model
  var timer = 0;

  /* The widget fires response.create a second after the channel opens. If
     that greeting is generated before our amendment lands, the agent opens
     as whatever the platform configured and has no idea who it is talking
     to — so we hold it, and let it go the moment we are done. */
  Vivid.onOutgoing(function (event) {
    if (!amended && event.type === 'response.create') {
      held = event;
      return null;
    }

    if (event.type === 'conversation.item.create' &&
        event.item && event.item.type === 'function_call_output') {
      var result = results[event.item.call_id];
      if (result) {
        delete results[event.item.call_id];
        event.item.output = result;     // the widget tried to run a tool it has never heard of
      }
    }

    return event;
  });

  Vivid.on('open', function () {
    amended = false;
    held = null;
    /* if session.created never arrives, the greeting must not hang */
    timer = setTimeout(release, 2500);
  });

  Vivid.on('event', function (event) {
    if (event.type === 'session.created') return amend(event.session || {});
    if (event.type === 'response.done') return harvest(event.response || {});
    if (event.type === 'error' && !amended) release();
  });

  function amend(session) {
    var data = read();
    var patch = {};

    /* the GA session object is typed; the older one is not */
    if (session.type) patch.type = session.type;

    var base = typeof session.instructions === 'string' ? session.instructions.trim() : '';
    var mine = PERSONA + '\n\n' + clock();
    patch.instructions = base ? base + '\n\n' + mine : mine;

    var tools = Array.isArray(session.tools) ? session.tools.slice() : [];
    var has = tools.some(function (t) { return t && t.name === TOOL.name; });
    if (!has) tools.push(TOOL);
    patch.tools = tools;
    patch.tool_choice = 'auto';

    Vivid.send({ type: 'session.update', session: patch });

    var brief = briefing(data);
    if (brief) {
      Vivid.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: brief }]
        }
      });
    }

    var tally = read();
    tally.sessions += 1;
    write(tally);

    release();
  }

  /* let the greeting through */
  function release() {
    if (amended) return;
    amended = true;
    clearTimeout(timer);
    if (held) {
      var greeting = held;
      held = null;
      Vivid.send(greeting);
    }
  }

  function harvest(response) {
    var output = Array.isArray(response.output) ? response.output : [];

    output.forEach(function (item) {
      if (!item || item.type !== 'function_call' || item.name !== TOOL.name) return;

      var args = {};
      try { args = JSON.parse(item.arguments || '{}'); } catch (err) {}

      keep(args);
      /* the widget will POST this call to a tool endpoint that has never
         heard of it and send the failure on to the model; the outgoing
         filter swaps in this line before that reaches anyone */
      results[item.call_id] = 'Kept.';
    });
  }
})();
