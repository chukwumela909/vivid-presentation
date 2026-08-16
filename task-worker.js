/* ============================================================
   Vivid — the worker
   The other half of tasks.js. Runs off the main thread so nothing
   here — a long wait, a heavy computation — can cost the orb a frame.

   Contract: receives {id, task, args}, answers {id, ok, summary}.
   A summary is one plain sentence, written for a voice to say.

   To add a task, add an entry to TASKS: fn(args, done) where done
   takes that sentence. Then let the tool schema in tasks.js know.
   ============================================================ */
'use strict';

var TASKS = {

  /* wait, then say so — "give me thirty seconds, then tell me" */
  timer: function (args, done) {
    var seconds = Math.max(1, Math.min(600, Number(args.seconds) || 30));
    setTimeout(function () {
      done('The ' + seconds + ' second timer is up.');
    }, seconds * 1000);
  },

  /* genuinely heavy on purpose: proof that work happens off-thread
     while the conversation and the orb carry on untouched */
  nth_prime: function (args, done) {
    var n = Math.max(1, Math.min(2000000, Math.floor(Number(args.n) || 1000)));
    var count = 0;
    var candidate = 1;
    while (count < n) {
      candidate++;
      if (isPrime(candidate)) count++;
    }
    done('Prime number ' + n + ' is ' + candidate + '.');
  }
};

function isPrime(x) {
  if (x < 4) return x > 1;
  if (x % 2 === 0 || x % 3 === 0) return false;
  for (var i = 5; i * i <= x; i += 6) {
    if (x % i === 0 || x % (i + 2) === 0) return false;
  }
  return true;
}

onmessage = function (e) {
  var job = e.data || {};
  var run = TASKS[job.task];

  if (!run) {
    postMessage({ id: job.id, ok: false, summary: 'No such task as "' + job.task + '".' });
    return;
  }

  try {
    run(job.args || {}, function (summary) {
      postMessage({ id: job.id, ok: true, summary: summary });
    });
  } catch (err) {
    postMessage({ id: job.id, ok: false, summary: 'The task failed: ' + (err && err.message || 'unknown error') + '.' });
  }
};
