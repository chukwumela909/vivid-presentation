/* ============================================================
   Vivid — landing page behaviour
   No dependencies. Everything degrades to a static page.
   ============================================================ */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- deterministic pseudo-random (stable bars per reload) ---------- */
  function seeded(seed) {
    var s = seed;
    return function () {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  }

  /* ---------- waveforms ---------- */
  function buildWave(el, index) {
    var requested = parseInt(el.getAttribute('data-bars'), 10) || 32;
    // a bar is 2px minimum plus a 3px gap — drop bars rather than clip them
    var fits = Math.floor(el.clientWidth / 5);
    var count = Math.max(8, Math.min(requested, fits || requested));
    var rand = seeded(9001 + index * 137);
    var frag = document.createDocumentFragment();

    for (var i = 0; i < count; i++) {
      var bar = document.createElement('i');
      // envelope: taller in the middle, quieter at the edges
      var t = i / (count - 1);
      var envelope = 0.35 + 0.65 * Math.sin(Math.PI * t);
      var h = Math.round((18 + rand() * 82) * envelope);
      bar.style.setProperty('--h', Math.max(10, h) + '%');
      bar.style.setProperty('--delay', (rand() * 0.9).toFixed(2) + 's');
      frag.appendChild(bar);
    }
    el.appendChild(frag);
  }

  var waves = [].slice.call(document.querySelectorAll('.wave'));
  waves.forEach(buildWave);

  // hero + finale waveforms idle-animate
  document.querySelectorAll('.wave--panel, .wave--finale, .wave--spot').forEach(function (w) {
    if (!reduceMotion) w.classList.add('is-active');
  });

  /* ---------- scroll reveal ---------- */
  var revealables = [].slice.call(document.querySelectorAll('.reveal'));
  if ('IntersectionObserver' in window && !reduceMotion) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    revealables.forEach(function (el) { io.observe(el); });
  } else {
    revealables.forEach(function (el) { el.classList.add('is-in'); });
  }

  /* ---------- sticky nav hairline ---------- */
  var nav = document.getElementById('nav');
  function onScroll() {
    nav.classList.toggle('is-stuck', window.scrollY > 8);
  }
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  /* ---------- mobile menu ---------- */
  var burger = document.getElementById('burger');
  var sheet = document.getElementById('mobile-menu');

  burger.addEventListener('click', function () {
    var open = burger.getAttribute('aria-expanded') === 'true';
    burger.setAttribute('aria-expanded', String(!open));
    burger.setAttribute('aria-label', open ? 'Open menu' : 'Close menu');
    sheet.hidden = open;
  });

  sheet.addEventListener('click', function (e) {
    if (e.target.tagName === 'A') {
      burger.setAttribute('aria-expanded', 'false');
      burger.setAttribute('aria-label', 'Open menu');
      sheet.hidden = true;
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !sheet.hidden) {
      burger.setAttribute('aria-expanded', 'false');
      sheet.hidden = true;
      burger.focus();
    }
  });

  /* ---------- hero: live call simulation ---------- */
  var TURNS = [
    { who: 'Riley · Vivid', text: 'Northwind Dental, this is Riley — how can I help?', role: 'agent' },
    { who: 'Caller', text: 'Hi, I need to move my cleaning to next week if you have anything.', role: 'caller' },
    { who: 'Riley · Vivid', text: 'Of course. I have Tuesday at 9:40 or Thursday at 2 — either work?', role: 'agent' },
    { who: 'Caller', text: 'Thursday. Actually — wait, does Dr. Amara work Thursdays?', role: 'caller' },
    { who: '', text: 'lookupProvider({ name: "Amara", day: "thu" })', role: 'tool' },
    { who: 'Riley · Vivid', text: 'She does — Thursday at 2 is with her. Want me to lock it in?', role: 'agent' }
  ];

  var transcript = document.getElementById('transcript');
  var timerEl = document.getElementById('timer');
  var latencyEl = document.getElementById('latency');
  var panel = document.getElementById('callPanel');

  function renderTurn(turn) {
    var li = document.createElement('li');
    li.className = turn.role === 'caller' ? 'is-caller' : (turn.role === 'tool' ? 'is-tool' : '');

    if (turn.who) {
      var who = document.createElement('span');
      who.className = 'who';
      who.textContent = turn.who;
      li.appendChild(who);
    }

    var said = document.createElement('span');
    said.className = 'said';
    said.textContent = turn.text;
    li.appendChild(said);

    transcript.appendChild(li);

    // keep only the last 3 turns visible in the panel
    while (transcript.children.length > 3) {
      transcript.removeChild(transcript.firstChild);
    }
  }

  var turnIndex = 0;
  var callTimer = null;
  var callSeconds = 41;

  function nextTurn() {
    renderTurn(TURNS[turnIndex % TURNS.length]);
    turnIndex++;

    if (latencyEl) {
      var ms = 288 + Math.floor(Math.random() * 46);
      latencyEl.textContent = String(ms);
      var meter = latencyEl.closest('.signal').querySelector('.meter i');
      // budget is 1000ms; the bar shows how much of it we're using
      if (meter) meter.style.setProperty('--w', Math.round(ms / 10) + '%');
    }
  }

  function startCall() {
    if (callTimer) return;
    nextTurn();
    nextTurn();
    callTimer = window.setInterval(nextTurn, 3200);

    window.setInterval(function () {
      callSeconds++;
      var m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
      var s = String(callSeconds % 60).padStart(2, '0');
      timerEl.textContent = m + ':' + s;
    }, 1000);
  }

  if (transcript) {
    if (reduceMotion) {
      // static: show the conversation without cycling
      TURNS.slice(0, 3).forEach(renderTurn);
    } else if ('IntersectionObserver' in window) {
      var callIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            startCall();
            callIO.disconnect();
          }
        });
      }, { threshold: 0.25 });
      callIO.observe(panel);
    } else {
      startCall();
    }
  }

  /* ---------- voice previews (visual only — no audio assets shipped) ---------- */
  var voiceButtons = [].slice.call(document.querySelectorAll('.voice'));
  voiceButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var isOn = btn.getAttribute('aria-pressed') === 'true';

      voiceButtons.forEach(function (other) {
        other.setAttribute('aria-pressed', 'false');
        var w = other.querySelector('.wave');
        if (w) w.classList.remove('is-active');
      });

      if (!isOn) {
        btn.setAttribute('aria-pressed', 'true');
        var wave = btn.querySelector('.wave');
        if (wave && !reduceMotion) wave.classList.add('is-active');
      }
    });
  });

  /* ---------- pricing: monthly / annual ---------- */
  var tabs = [].slice.call(document.querySelectorAll('.tab'));
  var prices = [].slice.call(document.querySelectorAll('[data-m][data-a]'));

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (t) {
        t.classList.remove('is-selected');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('is-selected');
      tab.setAttribute('aria-selected', 'true');

      var annual = tab.getAttribute('data-plan') === 'annual';
      prices.forEach(function (p) {
        p.textContent = annual ? p.getAttribute('data-a') : p.getAttribute('data-m');
      });
    });
  });

  /* ---------- metric count-up ---------- */
  var metrics = [].slice.call(document.querySelectorAll('.metric__v[data-count]'));
  function countUp(el) {
    var target = parseFloat(el.getAttribute('data-count'));
    var suffix = el.getAttribute('data-suffix') || '';
    var decimals = (String(target).split('.')[1] || '').length;
    var duration = 900;
    var start = null;

    function frame(ts) {
      if (start === null) start = ts;
      var p = Math.min((ts - start) / duration, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = (target * eased).toFixed(decimals) + suffix;
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  if ('IntersectionObserver' in window && !reduceMotion) {
    var mIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          countUp(entry.target);
          mIO.unobserve(entry.target);
        }
      });
    }, { threshold: 0.6 });
    metrics.forEach(function (el) { mIO.observe(el); });
  }

  /* ---------- FAQ: one open at a time ---------- */
  var faqRows = [].slice.call(document.querySelectorAll('.faq__row'));
  faqRows.forEach(function (row) {
    row.addEventListener('toggle', function () {
      if (!row.open) return;
      faqRows.forEach(function (other) {
        if (other !== row) other.open = false;
      });
    });
  });
})();
