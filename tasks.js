/* ============================================================
   Vivid — background tasks
   Gives the agent hands that keep working while it talks. A run_task
   tool is merged into the session; when the agent calls it, the work
   is handed to a Web Worker (task-worker.js) and the tool answers
   "started" at once, so the conversation never stalls. When the worker
   finishes, the result is slipped into the conversation as a system
   item and a response is asked for — the agent tells the user in its
   own words, mid-session, unprompted.

   Same seams as memory.js: the tool is merged (never replaced) into
   the session, and the widget's blind attempt to run a tool it has
   never heard of is rewritten on the way out.

   Tasks live in task-worker.js. Results outlive nothing: a session
   that ends takes its pending tasks with it.
   ============================================================ */
(function () {
  'use strict';

  var TOOL = {
    type: 'function',
    name: 'run_task',
    description:
      'Start a piece of work that runs in the background while you keep talking. It does not block you: you get ' +
      '"started" back immediately, and a system message will arrive with the result when it is done — usually within ' +
      'the same conversation. When you start one, say so casually in a few words and move on. When the result arrives, ' +
      'work it into your next line naturally.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          enum: ['timer', 'nth_prime'],
          description:
            'timer — wait a number of seconds, then report back; for "give me a minute, then tell me". ' +
            'nth_prime — compute the nth prime number; slow on purpose, for showing off background work.'
        },
        seconds: {
          type: 'number',
          description: 'timer only: how long to wait, in seconds. 1 to 600.'
        },
        n: {
          type: 'number',
          description: 'nth_prime only: which prime to find. 1 to 2000000.'
        }
      },
      required: ['task'],
      additionalProperties: false
    }
  };

  var NOTE = [
    'You can start background work with the run_task tool. It never blocks the conversation: mention in passing that',
    'you have set it going, and keep talking. When a system message reports that a task has finished, tell them the',
    'result in one natural line. Never say the words "tool", "task", "worker" or "system" out loud.'
  ].join(' ');

  var Vivid = window.Vivid;
  if (!Vivid) return;

  var DEBUG = /[?&]debug\b/.test(location.search);
  function note() {
    if (!DEBUG) return;
    console.info.apply(console, ['[tasks]'].concat([].slice.call(arguments)));
  }

  var registered = false;   // our session.update has gone out
  var responding = false;   // a response is being generated right now
  var results = {};         // call_id -> what to tell the model at once
  var finished = [];        // worker results waiting for a quiet moment
  var worker = null;

  /* ------------------------------------------------------------
     the tool joins the session
     memory.js amends on session.created; the session.updated that
     answers it carries the full amended session — instructions,
     persona, remember() and all — which is exactly what to build on.
     ------------------------------------------------------------ */
  Vivid.on('open', function () {
    registered = false;
    responding = false;
    results = {};
  });

  Vivid.on('event', function (event) {
    if (event.type === 'session.updated' && !registered) return register(event.session || {});
    if (event.type === 'response.created') { responding = true; return; }
    if (event.type === 'response.done') {
      responding = false;
      harvest(event.response || {});
      flush();
    }
  });

  function register(session) {
    registered = true;

    var patch = {};
    if (session.type) patch.type = session.type;

    var base = typeof session.instructions === 'string' ? session.instructions.trim() : '';
    patch.instructions = base ? base + '\n\n' + NOTE : NOTE;

    var tools = Array.isArray(session.tools) ? session.tools.slice() : [];
    var has = tools.some(function (t) { return t && t.name === TOOL.name; });
    if (!has) tools.push(TOOL);
    patch.tools = tools;
    patch.tool_choice = 'auto';

    Vivid.send({ type: 'session.update', session: patch });
    note('run_task joined the session');
  }

  /* ------------------------------------------------------------
     calls out, results back
     ------------------------------------------------------------ */
  function harvest(response) {
    var output = Array.isArray(response.output) ? response.output : [];

    output.forEach(function (item) {
      if (!item || item.type !== 'function_call' || item.name !== TOOL.name) return;

      var args = {};
      try { args = JSON.parse(item.arguments || '{}'); } catch (err) {}

      results[item.call_id] =
        'Started. A system message will bring the result when it is done — keep the conversation going.';
      dispatch(item.call_id, args);
    });
  }

  /* the widget will POST run_task to a tool endpoint that has never
     heard of it; swap the failure for "started" before it reaches
     the model — the same move memory.js makes */
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

  function dispatch(id, args) {
    if (!worker) {
      try { worker = new Worker('task-worker.js'); } catch (err) {
        note('no worker', err);
        finished.push('The background task could not start.');
        return flush();
      }
      worker.onmessage = function (e) {
        var done = e.data || {};
        note('finished:', done.summary);
        finished.push('A background task you started has finished. Result: ' + done.summary);
        flush();
      };
    }

    note('dispatch:', args.task, args);
    worker.postMessage({ id: id, task: args.task, args: args });
  }

  /* ------------------------------------------------------------
     telling the user
     A result must not talk over the agent: it waits for the gap
     after response.done, then arrives as a system item plus a
     request to speak.
     ------------------------------------------------------------ */
  function flush() {
    if (!finished.length) return;
    if (Vivid.state !== 'live') return;      // the session will collect it, or drop it
    if (responding) return;                  // the next response.done tries again

    var text = finished.splice(0, finished.length).join('\n');

    Vivid.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: text + '\nTell them in one short, natural line.' }]
      }
    });
    Vivid.send({ type: 'response.create' });
    responding = true;                       // until response.created confirms it
  }

  /* a session that ends takes its pending work with it */
  Vivid.on('phase', function (change) {
    if (change.state === 'live' || change.state === 'connecting') return;
    finished = [];
    results = {};
    if (worker) { worker.terminate(); worker = null; }
  });
})();
