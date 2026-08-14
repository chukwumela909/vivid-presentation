/* Dev-only stand-in for platformvivid widget.js.
   Reproduces exactly the contract voice-session.js depends on:
   a div[data-vivid] host with a CLOSED shadow root holding a
   .pill status label and a <canvas> whose click toggles the call.
   The live key is origin-locked, so this is how the session
   limit gets exercised locally. Not referenced by index.html. */
(function () {
  var STATUS = { idle: '', connecting: 'Connecting', ready: 'Ready', speaking: 'Speaking', error: 'Error' };

  var host = document.createElement('div');
  host.setAttribute('data-vivid', '');
  var shadow = host.attachShadow({ mode: 'closed' });

  var style = document.createElement('style');
  style.textContent = ':host{all:initial}.wrap{position:fixed;right:14px;bottom:14px;z-index:2147483000;display:flex;flex-direction:column;align-items:center;gap:2px;font-family:system-ui,sans-serif}.pill{background:rgba(20,20,24,.85);color:#fff;font-size:12px;padding:4px 10px;border-radius:999px;opacity:0;transition:opacity .2s;pointer-events:none}canvas{cursor:pointer;display:block;border-radius:50%;background:radial-gradient(circle at 40% 35%,#8b7bff,#4a34d4)}';

  var wrap = document.createElement('div');
  wrap.className = 'wrap';
  var pill = document.createElement('div');
  pill.className = 'pill';
  var canvas = document.createElement('canvas');
  canvas.style.width = canvas.style.height = '88px';

  var status = 'idle';
  function set(next) {
    status = next;
    pill.textContent = STATUS[next];
    pill.style.opacity = STATUS[next] ? '1' : '0';
  }

  canvas.addEventListener('click', function () {
    if (status === 'idle' || status === 'error') {
      set('connecting');
      window.setTimeout(function () { if (status === 'connecting') set('ready'); }, 600);
    } else {
      set('idle');
    }
  });

  wrap.append(pill, canvas);
  shadow.append(style, wrap);
  document.body.appendChild(host);
  set('idle');

  window.__orbStub = { tap: function () { canvas.click(); }, status: function () { return status; }, fail: function () { set('error'); } };
})();
