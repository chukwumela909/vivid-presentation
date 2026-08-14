/* ============================================================
   Vivid — voice session limits
   Wraps the embedded orb widget: one session lasts five minutes,
   and there is no limit on how many sessions a visitor can start.
   Must load BEFORE widget.js — it opens the widget's shadow root
   on creation, which can only be done before the orb is built.
   ============================================================ */
(function () {
  'use strict';

  // data-minutes on this script tag overrides the cap
  var minutes = parseFloat((document.currentScript || {}).dataset ? document.currentScript.dataset.minutes : '') || 5;
  var LIMIT_MS = Math.max(10, minutes * 60) * 1000;
  var WARN_MS = Math.min(30 * 1000, LIMIT_MS / 4);   // "wrap up" nudge
  var TENSE_MS = Math.min(10 * 1000, LIMIT_MS / 12); // final countdown styling
  var TOAST_MS = 7000;
  var LIMIT_LABEL = minutes === 1 ? '1 minute' : minutes + ' minutes';

  // the widget's status pill is the only signal it exposes about the call
  var PHASE = {
    '': 'idle',
    'Connecting': 'connecting',
    'Ready': 'live',
    'Listening': 'live',
    'Thinking': 'live',
    'Speaking': 'live',
    'Error': 'error'
  };

  /* ---------- open the orb's shadow root ---------- */
  // The widget attaches a closed root, so nothing outside can read its status
  // or end a call. Forcing this one root open (it is tagged data-vivid before
  // attachShadow runs) gives us both; the patch removes itself right after.
  var nativeAttach = Element.prototype.attachShadow;

  Element.prototype.attachShadow = function (init) {
    var isOrb = this.nodeType === 1 && this.hasAttribute('data-vivid');
    var root = nativeAttach.call(this, isOrb ? { mode: 'open' } : init);
    if (isOrb) {
      Element.prototype.attachShadow = nativeAttach;
      awaitOrb(root);
    }
    return root;
  };

  // the root is empty at this point — the orb renders into it a tick later
  function awaitOrb(root) {
    var mo = new MutationObserver(function () {
      var canvas = root.querySelector('canvas');
      var pill = root.querySelector('.pill');
      if (!canvas || !pill) return;
      mo.disconnect();
      govern(canvas, pill);
    });
    mo.observe(root, { childList: true, subtree: true });
  }

  /* ---------- UI ---------- */
  function govern(canvas, pill) {
    var ui = build();
    var state = 'idle';
    var deadline = 0;
    var ticker = null;
    var warned = false;
    var expired = false;
    var hideToast = null;

    function tapOrb() {
      canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    }

    function toast(title, body, cta) {
      ui.title.textContent = title;
      ui.body.textContent = body;
      ui.again.hidden = !cta;
      ui.toast.hidden = false;
      // reflow so the transition replays when one toast replaces another
      void ui.toast.offsetWidth;
      ui.toast.classList.add('is-in');

      window.clearTimeout(hideToast);
      hideToast = window.setTimeout(dismiss, cta ? TOAST_MS * 2 : TOAST_MS);
    }

    function dismiss() {
      window.clearTimeout(hideToast);
      if (ui.toast.hidden) return;
      ui.toast.classList.remove('is-in');
      // don't wait on transitionend — a throttled tab may never fire it, and a
      // faded-but-present toast must not linger over the page
      hideToast = window.setTimeout(function () { ui.toast.hidden = true; }, 280);
    }

    ui.again.addEventListener('click', function () {
      dismiss();
      tapOrb();
    });

    ui.close.addEventListener('click', dismiss);

    /* ---------- the clock ---------- */
    function render() {
      var left = Math.max(0, deadline - Date.now());
      ui.time.textContent = format(left);
      ui.bar.style.setProperty('--p', (left / LIMIT_MS).toFixed(4));
      ui.clock.setAttribute('data-tone', left <= TENSE_MS ? 'out' : left <= WARN_MS ? 'low' : 'ok');

      if (left <= WARN_MS && !warned) {
        warned = true;
        toast(format(WARN_MS).replace(/^0:0?/, '') + ' seconds left', 'Wrap up — or start a fresh session when this one ends.');
      }

      if (left === 0) {
        expired = true;
        stopClock();
        tapOrb(); // hangs up; the pill going idle finishes the teardown
      }
    }

    function startClock() {
      deadline = Date.now() + LIMIT_MS;
      warned = false;
      expired = false;
      ui.clock.hidden = false;
      window.clearInterval(ticker);
      ticker = window.setInterval(render, 250);
      render();
    }

    function stopClock() {
      window.clearInterval(ticker);
      ticker = null;
    }

    function endSession() {
      stopClock();
      deadline = 0;
      ui.clock.hidden = true;

      if (expired) {
        expired = false;
        toast('Your ' + LIMIT_LABEL + ' are up', 'That session has ended. Sessions are unlimited — start another whenever you like.', true);
      }
    }

    /* ---------- follow the widget's status ---------- */
    function onStatus() {
      var text = (pill.textContent || '').trim();
      var phase = PHASE[text] || (text ? 'live' : 'idle');
      if (phase === state) return;
      var prev = state;
      state = phase;

      if (phase === 'connecting') {
        // fires the moment the orb is tapped, before the mic prompt resolves
        toast('You have ' + LIMIT_LABEL, 'That is one session with Vivid. Sessions are unlimited — when it ends, tap the orb for another.');
        return;
      }

      if (phase === 'live') {
        if (!deadline) startClock();
        return;
      }

      if (phase === 'error') {
        expired = false;
        endSession();
        toast('Could not start the session', 'Allow microphone access, then tap the orb to try again.', true);
        return;
      }

      // idle — either the visitor hung up early or the clock ran out
      if (prev === 'idle') return;
      if (!expired) dismiss();
      endSession();
    }

    new MutationObserver(onStatus).observe(pill, {
      childList: true,
      characterData: true,
      subtree: true
    });

    // background tabs throttle timers; re-check the moment we are looked at
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && deadline) render();
    });

    onStatus();
  }

  /* ---------- helpers ---------- */
  function build() {
    var wrap = el('div', 'vsession');
    // widget chrome: keeps this out of the agent's page snapshot and out of the
    // reach of its restyle tools, exactly as the orb itself is kept out
    wrap.setAttribute('data-vivid', '');

    var toast = el('div', 'vsession__toast');
    toast.hidden = true;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    var title = el('p', 'vsession__title');
    var body = el('p', 'vsession__body');

    var again = el('button', 'vsession__again');
    again.type = 'button';
    again.textContent = 'Start another session';
    again.hidden = true;

    var close = el('button', 'vsession__close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';

    toast.append(close, title, body, again);

    var clock = el('div', 'vsession__clock');
    clock.hidden = true;
    clock.setAttribute('role', 'timer');
    clock.setAttribute('aria-label', 'Time left in this session');

    var time = el('span', 'vsession__time');
    time.textContent = format(LIMIT_MS);
    var label = el('span', 'vsession__label');
    label.textContent = 'left';
    var bar = el('i', 'vsession__bar');
    bar.style.setProperty('--p', '1');

    clock.append(time, label, bar);
    wrap.append(toast, clock);
    document.body.appendChild(wrap);

    return { toast: toast, title: title, body: body, again: again, close: close, clock: clock, time: time, bar: bar };
  }

  function el(tag, cls) {
    var node = document.createElement(tag);
    node.className = cls;
    return node;
  }

  function format(ms) {
    var total = Math.ceil(ms / 1000);
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }
})();
