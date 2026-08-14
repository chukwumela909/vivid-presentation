/* ============================================================
   Vivid — session limit
   One session lasts two minutes (data-minutes on the script tag
   overrides); there is no limit on how many a visitor may start.

   No interface of its own — the page is the orb and nothing else, so
   the clock is drawn as a thinning ring around it. This file only
   keeps the time and hangs up.

     VividSession.left()    1 -> 0 across the session, 1 when idle
     VividSession.active
   ============================================================ */
(function () {
  'use strict';

  var minutes = parseFloat((document.currentScript && document.currentScript.dataset.minutes) || '') || 2;
  var LIMIT = Math.max(10, minutes * 60) * 1000;

  var Vivid = window.Vivid;
  if (!Vivid) return;

  var deadline = 0;
  var ticker = 0;

  var Session = {
    limit: LIMIT,
    active: false,
    left: function () {
      if (!deadline) return 1;
      return Math.max(0, Math.min(1, (deadline - Date.now()) / LIMIT));
    },
    ms: function () {
      return deadline ? Math.max(0, deadline - Date.now()) : LIMIT;
    }
  };

  window.VividSession = Session;

  Vivid.on('phase', function (change) {
    if (change.state === 'live') return start();
    if (change.state === 'connecting') return;
    stop();
  });

  function start() {
    if (deadline) return;              // already running; listening -> speaking is not a new session
    deadline = Date.now() + LIMIT;
    Session.active = true;
    ticker = setInterval(check, 250);
  }

  function stop() {
    clearInterval(ticker);
    ticker = 0;
    deadline = 0;
    Session.active = false;
  }

  function check() {
    if (Session.ms() > 0) return;
    stop();
    Vivid.tap();                        // hangs up; the orb takes it from there
  }

  /* a backgrounded tab throttles the interval — settle up on return */
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && deadline) check();
  });
})();
