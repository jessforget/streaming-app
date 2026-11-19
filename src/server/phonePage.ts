/**
 * The page a phone opens after scanning the QR code: pick a camera, press
 * Start, and the phone sends its camera and microphone to the main window.
 * One self-contained page, so it loads fast and works in Chrome on Android
 * and Safari on iPhone. (No backticks or template placeholders inside: this
 * whole page is one template string.)
 */
export const PHONE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0e1014">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Camera">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<title>Phone camera</title>
<style>
  :root { color-scheme: dark; --bg:#0e1014; --panel:#171a21; --line:#2c323d; --fg:#e8eaee; --muted:#9ba4b4; --accent:#4c8dff; --live:#f2555a; --good:#3fb37f; --warn:#e7b13a; }
  * { box-sizing: border-box; }
  html, body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width:560px; margin:0 auto; padding:16px 16px calc(24px + env(safe-area-inset-bottom)); display:flex; flex-direction:column; gap:14px; }
  h1 { font-size:20px; margin:4px 0 0; }
  .preview { position:relative; background:#000; border-radius:12px; overflow:hidden; aspect-ratio:16/9; border:1px solid var(--line); }
  video { position:absolute; width:1px; height:1px; opacity:0; pointer-events:none; }
  canvas { width:100%; height:100%; display:block; background:#000; }
  .badge { position:absolute; top:10px; left:10px; padding:4px 10px; border-radius:999px; font-size:13px; font-weight:600; background:#000a; color:var(--muted); }
  .badge.on { background:var(--live); color:#fff; }
  .badge.wait { background:var(--warn); color:#111; }
  /* Flip between the front and back camera, on the picture itself (big enough for a thumb). */
  .flipcam { position:absolute; top:8px; right:8px; width:auto; min-height:48px; padding:0 16px; border-radius:999px; font-size:15px; font-weight:600; background:#000b; color:#fff; border:1px solid #fff5; display:none; }
  .flipcam:disabled { opacity:0.6; }
  /* Camera settings: only what this phone allows */
  details.camset { border:1px solid var(--line); border-radius:10px; background:var(--panel); padding:4px 12px; }
  details.camset summary { cursor:pointer; padding:10px 0; font-weight:600; min-height:44px; display:flex; align-items:center; }
  .camctl { display:flex; flex-direction:column; gap:12px; padding:4px 0 12px; }
  .camctl .ctl { display:flex; flex-direction:column; gap:6px; }
  .camctl .head { display:flex; justify-content:space-between; gap:10px; font-size:14px; }
  .camctl .head b { font-weight:600; }
  .camctl .val { color:var(--muted); font-variant-numeric:tabular-nums; }
  .camctl input[type=range] { width:100%; padding:0; height:32px; }
  .seg { display:flex; }
  .seg button { flex:1; padding:10px; font-size:15px; border-radius:0; background:var(--bg); border:1px solid var(--line); color:var(--fg); }
  .seg button:first-child { border-radius:8px 0 0 8px; }
  .seg button:last-child { border-radius:0 8px 8px 0; border-left:0; }
  .seg button.on { background:var(--accent); color:#0b1a33; border-color:var(--accent); }
  .camctl .note { font-size:13px; color:var(--muted); margin:0; }
  label { display:flex; flex-direction:column; gap:6px; font-size:14px; color:var(--muted); }
  input, select { font:inherit; color:var(--fg); background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px; width:100%; }
  .row { display:flex; gap:10px; }
  .row > * { flex:1; }
  button { font:inherit; font-weight:600; border:0; border-radius:12px; padding:16px; background:var(--accent); color:#fff; width:100%; }
  button.secondary { background:var(--panel); color:var(--fg); border:1px solid var(--line); }
  button.stop { background:var(--live); }
  button:disabled { opacity:.5; }
  .status { min-height:1.4em; color:var(--muted); font-size:14px; }
  .status.bad { color:var(--live); }
  .tip { font-size:13px; color:var(--muted); margin:0; }
  .check { flex-direction:row; align-items:center; gap:10px; color:var(--fg); }
  .check input { width:22px; height:22px; }
  #land { display:none; }
  /* Phone turned sideways: picture on the left, controls on the right. */
  @media (orientation: landscape) and (max-height: 600px) {
    main { max-width:none; height:100vh; height:100dvh; display:grid; grid-template-columns: minmax(0, 1.6fr) minmax(240px, 1fr); grid-template-rows: auto 1fr; gap:8px 14px; padding:8px calc(12px + env(safe-area-inset-right)) 8px calc(12px + env(safe-area-inset-left)); }
    h1 { display:none; }
    .preview { grid-column:1; grid-row:1 / span 2; align-self:center; max-height:calc(100dvh - 16px); }
    .controls { grid-column:2; grid-row:1 / span 2; overflow-y:auto; display:flex; flex-direction:column; gap:10px; padding-bottom:8px; }
    button { padding:12px; }
    input, select { padding:9px; }
  }
</style>
</head>
<body>
<main>
  <h1>Phone camera</h1>
  <div class="preview">
    <video id="video" playsinline muted autoplay></video>
    <canvas id="out" width="1280" height="720"></canvas>
    <span id="badge" class="badge">Not started</span>
    <button id="flipCam" class="flipcam" type="button" aria-label="Switch between the front and back camera">⟲ Front</button>
  </div>
  <div class="controls">
  <div class="status" id="status">Name this camera, then press Start.</div>
  <label>Camera name (shows in the app)
    <input id="name" maxlength="40" autocomplete="off">
  </label>
  <div class="row">
    <label>Camera
      <select id="facing">
        <option value="environment">Back</option>
        <option value="user">Front (selfie)</option>
      </select>
    </label>
    <label>Quality
      <select id="quality">
        <option value="720">720p</option>
        <option value="1080">1080p</option>
      </select>
    </label>
  </div>
  <label class="check"><input type="checkbox" id="mic" checked> Send the phone's microphone too</label>
  <label class="check"><input type="checkbox" id="flip"> Picture upside down? Turn it over</label>
  <label class="check"><input type="checkbox" id="mirror"> Mirror the front camera (like a selfie; text reads backwards on the stream)</label>
  <details class="camset" id="camSet" style="display:none">
    <summary>Camera settings (exposure, white balance, focus)</summary>
    <div class="camctl" id="camCtl"></div>
  </details>
  <button id="start">Start camera</button>
  <button id="land" class="secondary">Full screen, sideways</button>
  <button id="install" class="secondary" style="display:none">Install as an app</button>
  <p class="tip">Hold the phone sideways for a full 16:9 picture (1920 × 1080 at 1080p). It turns the right way up by itself, even with auto-rotate off. Held upright, the picture gets black bars at the sides.</p>
  <p class="tip" id="rotTip">Keep this page open and the phone unlocked while you're live. Plug the phone into power for long shows.</p>
  </div>
</main>
<script>
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var token = location.hash.slice(1);
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  if (token) store.set('cam-token', token); else token = store.get('cam-token') || '';
  // Its own manifest, so "Add to Home Screen" opens straight onto this camera, with no address bar.
  if (token) {
    var man = document.createElement('link');
    man.rel = 'manifest';
    man.href = '/cam.webmanifest?t=' + encodeURIComponent(token);
    document.head.appendChild(man);
  }
  var installEvent = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    installEvent = e;
    $('install').style.display = 'block';
  });
  var id = store.get('cam-id');
  if (!id) {
    var a = new Uint8Array(8); crypto.getRandomValues(a);
    id = Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    store.set('cam-id', id);
  }
  var isIphone = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  $('name').value = store.get('cam-name') || (isIphone ? 'iPhone' : 'Phone');
  if (!store.get('cam-name') && navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
    navigator.userAgentData.getHighEntropyValues(['model']).then(function (v) { if (v.model && !store.get('cam-name')) $('name').value = v.model; }).catch(function () {});
  }
  $('facing').value = store.get('cam-facing') || 'environment';
  $('flip').checked = store.get('cam-flip') === '1';
  $('flip').addEventListener('change', function () { store.set('cam-flip', $('flip').checked ? '1' : '0'); });
  $('mirror').checked = store.get('cam-mirror') === '1';
  $('mirror').addEventListener('change', function () { store.set('cam-mirror', $('mirror').checked ? '1' : '0'); });
  $('quality').value = store.get('cam-quality') || '720';

  var stream = null, pc = null, ctl = null, running = false, retryTimer = null, wakeLock = null, attempt = 0, switching = false;

  function status(text, bad) { $('status').textContent = text; $('status').className = 'status' + (bad ? ' bad' : ''); }
  function badge(text, cls) { $('badge').textContent = text; $('badge').className = 'badge ' + (cls || ''); }

  function keepAwake() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {});
  }
  document.addEventListener('visibilitychange', function () {
    if (!running) return;
    if (document.visibilityState === 'visible') { keepAwake(); if (!pc) connectSoon(0); }
    else status('The phone stopped the camera because the page is hidden. Come back to this page.', true);
  });

  function constraints() {
    var h = $('quality').value === '1080' ? 1080 : 720;
    return {
      video: { facingMode: { ideal: $('facing').value }, width: { ideal: h * 16 / 9 }, height: { ideal: h }, frameRate: { ideal: 30, max: 30 } },
      audio: $('mic').checked ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false
    };
  }

  // ---- Always a landscape picture (16:9), the right way up ----
  // The camera's picture follows the screen. With auto-rotate off (or on an
  // iPhone with rotation lock), a phone held sideways still gives a tall,
  // sideways picture. So the page draws each frame onto a 16:9 canvas,
  // turned by how the phone is actually held (from its motion sensor), and
  // sends the canvas.
  var gravity = null; // {x, y} in the phone's own axes, Android sign convention
  var isApple = isIphone || /Macintosh/.test(navigator.userAgent);
  window.addEventListener('devicemotion', function (e) {
    var g = e.accelerationIncludingGravity;
    if (!g || g.x === null || g.y === null) return;
    // iPhones report the opposite sign to Android.
    gravity = isApple ? { x: -g.x, y: -g.y } : { x: g.x, y: g.y };
  });
  function askMotion() {
    // iPhones ask before giving motion data; it must be asked from a tap.
    if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function') {
      DeviceMotionEvent.requestPermission().catch(function () {});
    }
  }
  /** Degrees to turn a tall camera picture so it is upright: 0 (held upright), 90, -90 or 180. */
  function turnFor() {
    if (!gravity) return 0;
    var ax = Math.abs(gravity.x), ay = Math.abs(gravity.y);
    if (ax < 3 && ay < 3) return lastTurn; // lying flat: keep what it was
    if (ax > ay * 1.3) return gravity.x > 0 ? -90 : 90;
    if (ay > ax * 1.3) return gravity.y > 0 ? 0 : 180;
    return lastTurn; // in between: no flicker
  }
  var lastTurn = 0, outStream = null, drawing = false, drawGen = 0;

  function sizeCanvas() {
    var h = $('quality').value === '1080' ? 1080 : 720;
    var c = $('out');
    if (c.height !== h) { c.width = h * 16 / 9; c.height = h; }
  }

  function drawLoop() {
    var gen = ++drawGen;
    var step = function () {
      if (!drawing || gen !== drawGen) return;
      drawFrame();
      var v = $('video');
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step);
      else requestAnimationFrame(step);
    };
    step();
  }

  function drawFrame() {
    var v = $('video'), c = $('out'), ctx = c.getContext('2d');
    var vw = v.videoWidth, vh = v.videoHeight;
    if (vw && vh) {
      var turn = vw >= vh ? 0 : turnFor();
      lastTurn = vw >= vh ? lastTurn : turn;
      var sideways = turn === 90 || turn === -90;
      var w = sideways ? vh : vw, h = sideways ? vw : vh; // size once turned
      var k = Math.min(c.width / w, c.height / h);
      // Upright and held sideways: fill the frame (crop a sliver if needed). Upright and held upright: fit, with bars.
      if (w >= h) k = Math.max(c.width / w, c.height / h);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.save();
      ctx.translate(c.width / 2, c.height / 2);
      if ($('mirror').checked && $('facing').value === 'user') ctx.scale(-1, 1);
      ctx.rotate((turn + ($('flip').checked ? 180 : 0)) * Math.PI / 180);
      ctx.drawImage(v, -vw * k / 2, -vh * k / 2, vw * k, vh * k);
      ctx.restore();
    }
  }

  function openCamera() {
    if (stream && stream.camera) stream.camera.getTracks().forEach(function (t) { t.stop(); });
    if (stream) stream.getAudioTracks().forEach(function (t) { t.stop(); });
    stream = null;
    return navigator.mediaDevices.getUserMedia(constraints()).then(function (s) {
      var cam = s;
      sizeCanvas();
      if (!outStream) {
        outStream = $('out').captureStream(30);
        var ov = outStream.getVideoTracks()[0];
        // A camera picture: keep it sharp (the frame rate may dip a little on busy Wi-Fi instead).
        if (ov && 'contentHint' in ov) ov.contentHint = 'detail';
      }
      // What goes to the app: the turned picture, plus the microphone.
      stream = new MediaStream(outStream.getVideoTracks().concat(cam.getAudioTracks()));
      stream.camera = cam;
      $('video').srcObject = cam;
      setupCamera();
      syncSendTrack();
      var started = $('video').play().catch(function () {});
      drawing = true;
      drawLoop();
      return started;
    });
  }
  function stopCamera() {
    drawing = false;
    if (stream && stream.camera) stream.camera.getTracks().forEach(function (t) { t.stop(); });
    if (stream) stream.getAudioTracks().forEach(function (t) { t.stop(); });
  }

  // ---- Camera settings: manual exposure, white balance, focus, zoom, torch ----
  // Only what this phone's camera allows (Chrome on Android allows most; Safari on iPhone very little).
  // Set here or from the app; remembered per camera (front / back) and put back after a flip or restart.
  var CAM_CONTROLS = [
    { key: 'exposure', label: 'Exposure', type: 'mode', cap: 'exposureMode' },
    { key: 'ev', label: 'Brightness', cap: 'exposureCompensation', unit: 'EV', show: ['exposure', 'auto'] },
    { key: 'shutter', label: 'Shutter', cap: 'exposureTime', scale: 'log', fmt: 'shutter', show: ['exposure', 'manual'] },
    { key: 'iso', label: 'ISO', cap: 'iso', scale: 'log', show: ['exposure', 'manual'] },
    { key: 'wb', label: 'White balance', type: 'mode', cap: 'whiteBalanceMode' },
    { key: 'kelvin', label: 'Colour temperature', cap: 'colorTemperature', unit: 'K', show: ['wb', 'manual'] },
    { key: 'focus', label: 'Focus', type: 'mode', cap: 'focusMode' },
    { key: 'focusDist', label: 'Focus distance', cap: 'focusDistance', unit: 'm', show: ['focus', 'manual'] },
    { key: 'zoom', label: 'Zoom', cap: 'zoom', unit: 'x' },
    { key: 'torch', label: 'Torch (light)', type: 'bool', cap: 'torch' }
  ];
  var camWant = {}, camDesc = [], camTimer = null, camReportTimer = null;
  function camTrack() { return stream && stream.camera ? stream.camera.getVideoTracks()[0] : null; }
  function camKey() { return 'cam-set-' + facingNow; }
  function modeOk(modes) { return Array.isArray(modes) && modes.indexOf('manual') >= 0 && (modes.indexOf('continuous') >= 0 || modes.indexOf('single-shot') >= 0); }
  /** What this camera allows, as controls (the same list goes to the app). */
  function describeCamera() {
    var t = camTrack();
    var caps = t && t.getCapabilities ? t.getCapabilities() : {};
    var now = t && t.getSettings ? t.getSettings() : {};
    var out = [];
    var modes = {};
    CAM_CONTROLS.forEach(function (c) { if (c.type === 'mode') modes[c.key] = modeOk(caps[c.cap]); });
    CAM_CONTROLS.forEach(function (c) {
      var cap = caps[c.cap];
      var d = { key: c.key, label: c.label, type: c.type || 'range' };
      if (c.type === 'mode') {
        if (!modes[c.key]) return;
        d.options = ['auto', 'manual'];
        d.value = camWant[c.key] || (now[c.cap] === 'manual' ? 'manual' : 'auto');
      } else if (c.type === 'bool') {
        if (cap !== true && !(Array.isArray(cap) && cap.indexOf(true) >= 0)) return;
        d.value = camWant[c.key] === true || (camWant[c.key] === undefined && now[c.cap] === true);
      } else {
        if (!cap || typeof cap.min !== 'number' || typeof cap.max !== 'number' || !(cap.max > cap.min)) return;
        d.min = cap.min; d.max = cap.max; d.step = cap.step || 0;
        if (c.unit) d.unit = c.unit;
        if (c.scale && cap.min > 0) d.scale = c.scale;
        if (c.fmt) d.fmt = c.fmt;
        var v = typeof camWant[c.key] === 'number' ? camWant[c.key] : now[c.cap];
        d.value = typeof v === 'number' ? Math.min(cap.max, Math.max(cap.min, v)) : cap.min;
      }
      // Shown only while its mode is set that way (and only if that mode can be set here at all).
      if (c.show && modes[c.show[0]]) d.show = c.show;
      out.push(d);
    });
    return out;
  }
  function camConstraints() {
    var c = {};
    var has = function (k) { return camDesc.some(function (d) { return d.key === k; }); };
    var val = function (k) { var d = camDesc.filter(function (x) { return x.key === k; })[0]; return d ? d.value : undefined; };
    if (has('exposure')) c.exposureMode = val('exposure') === 'manual' ? 'manual' : 'continuous';
    if (val('exposure') === 'manual') {
      if (has('shutter')) c.exposureTime = val('shutter');
      if (has('iso')) c.iso = val('iso');
    } else if (has('ev')) c.exposureCompensation = val('ev');
    if (has('wb')) c.whiteBalanceMode = val('wb') === 'manual' ? 'manual' : 'continuous';
    if (val('wb') === 'manual' && has('kelvin')) c.colorTemperature = val('kelvin');
    if (has('focus')) c.focusMode = val('focus') === 'manual' ? 'manual' : 'continuous';
    if (val('focus') === 'manual' && has('focusDist')) c.focusDistance = val('focusDist');
    if (has('zoom')) c.zoom = val('zoom');
    if (has('torch')) c.torch = val('torch') === true;
    return c;
  }
  function applyCamera() {
    var t = camTrack();
    if (!t || !t.applyConstraints) return;
    var c = camConstraints();
    t.applyConstraints({ advanced: [c] }).catch(function () {
      // Some phones refuse a set of several at once: one at a time, skipping what it won't take.
      var keys = Object.keys(c);
      var next = function (i) {
        if (i >= keys.length) return;
        var one = {}; one[keys[i]] = c[keys[i]];
        t.applyConstraints({ advanced: [one] }).catch(function () {}).then(function () { next(i + 1); });
      };
      next(0);
    });
  }
  function reportCamera() {
    clearTimeout(camReportTimer);
    camReportTimer = setTimeout(function () {
      if (ctl && ctl.readyState === 'open') { try { ctl.send(JSON.stringify({ camera: camDesc })); } catch (e) {} }
    }, 150);
  }
  /** Change some settings (from this page or from the app). */
  function setCamera(changes) {
    Object.keys(changes).forEach(function (k) {
      var d = camDesc.filter(function (x) { return x.key === k; })[0];
      if (!d) return;
      var v = changes[k];
      if (d.type === 'mode') { if (v !== 'auto' && v !== 'manual') return; }
      else if (d.type === 'bool') v = v === true;
      else { v = Number(v); if (!isFinite(v)) return; v = Math.min(d.max, Math.max(d.min, v)); }
      d.value = v;
      camWant[k] = v;
    });
    store.set(camKey(), JSON.stringify(camWant));
    renderCamera();
    clearTimeout(camTimer);
    camTimer = setTimeout(applyCamera, 60);
    reportCamera();
  }
  /** The camera just opened (start, flip, quality): read what it allows and put the saved settings back. */
  function setupCamera() {
    try { camWant = JSON.parse(store.get(camKey()) || '{}') || {}; } catch (e) { camWant = {}; }
    camDesc = describeCamera();
    $('camSet').style.display = running || stream ? 'block' : 'none';
    renderCamera();
    if (Object.keys(camWant).length) applyCamera();
    reportCamera();
  }
  function camFmt(d, v) {
    if (d.fmt === 'shutter') {
      var s = v / 10000; // the browser counts in 100-microsecond steps
      return s >= 0.3 ? (Math.round(s * 10) / 10) + ' s' : '1/' + Math.round(1 / s);
    }
    var r = d.step && d.step >= 1 ? Math.round(v) : Math.round(v * 100) / 100;
    return r + (d.unit ? (d.unit === 'x' ? 'x' : ' ' + d.unit) : '');
  }
  // Log settings (shutter, ISO) move in ratios over 1000 slider steps; the rest use the camera's own steps.
  function toPos(d, v) { return d.scale === 'log' ? Math.round(1000 * Math.log(v / d.min) / Math.log(d.max / d.min)) : v; }
  function fromPos(d, p) {
    var v = d.scale === 'log' ? d.min * Math.pow(d.max / d.min, p / 1000) : p;
    if (d.step && d.scale === 'log') v = d.min + Math.round((v - d.min) / d.step) * d.step;
    return Math.min(d.max, Math.max(d.min, v));
  }
  function renderCamera() {
    var box = $('camCtl');
    // Don't rebuild under a finger that is moving a slider.
    if (box.contains(document.activeElement) && document.activeElement.type === 'range') {
      camDesc.forEach(function (d) { var el = document.getElementById('cv-' + d.key); if (el) el.textContent = d.type === 'range' ? camFmt(d, d.value) : ''; });
      return;
    }
    box.textContent = '';
    if (!camDesc.length) {
      var n = document.createElement('p');
      n.className = 'note';
      n.textContent = isIphone ? 'iPhones don\u2019t let web pages change exposure, white balance or focus. The camera stays on auto.' : 'This phone\u2019s browser doesn\u2019t let the page change its camera settings. The camera stays on auto.';
      box.appendChild(n);
      return;
    }
    var val = function (k) { var d = camDesc.filter(function (x) { return x.key === k; })[0]; return d ? d.value : undefined; };
    camDesc.forEach(function (d) {
      if (d.show && val(d.show[0]) !== d.show[1]) return;
      var row = document.createElement('div');
      row.className = 'ctl';
      var head = document.createElement('div');
      head.className = 'head';
      var b = document.createElement('b'); b.textContent = d.label; head.appendChild(b);
      row.appendChild(head);
      if (d.type === 'mode') {
        var seg = document.createElement('div');
        seg.className = 'seg';
        d.options.forEach(function (o) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = o === 'auto' ? 'Auto' : 'Manual';
          btn.className = d.value === o ? 'on' : '';
          btn.setAttribute('aria-pressed', d.value === o ? 'true' : 'false');
          btn.addEventListener('click', function () { var ch = {}; ch[d.key] = o; setCamera(ch); });
          seg.appendChild(btn);
        });
        row.appendChild(seg);
      } else if (d.type === 'bool') {
        var seg2 = document.createElement('div');
        seg2.className = 'seg';
        [false, true].forEach(function (o) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = o ? 'On' : 'Off';
          btn.className = d.value === o ? 'on' : '';
          btn.addEventListener('click', function () { var ch = {}; ch[d.key] = o; setCamera(ch); });
          seg2.appendChild(btn);
        });
        row.appendChild(seg2);
      } else {
        var v = document.createElement('span'); v.className = 'val'; v.id = 'cv-' + d.key; v.textContent = camFmt(d, d.value); head.appendChild(v);
        var r = document.createElement('input');
        r.type = 'range';
        if (d.scale === 'log') { r.min = '0'; r.max = '1000'; r.step = '1'; }
        else { r.min = String(d.min); r.max = String(d.max); r.step = d.step ? String(d.step) : 'any'; }
        r.value = String(toPos(d, d.value));
        r.setAttribute('aria-label', d.label);
        r.addEventListener('input', function () { var ch = {}; ch[d.key] = fromPos(d, Number(r.value)); setCamera(ch); });
        r.addEventListener('change', function () { renderCamera(); });
        row.appendChild(r);
      }
      $('camCtl').appendChild(row);
    });
  }

  // ---- Front / back camera, while live ----
  // Only the camera changes: the page keeps sending the same picture (its canvas), so the app's
  // connection stays up. The stream holds the last frame for a moment while the other camera opens.
  function flipLabel() {
    $('flipCam').textContent = $('facing').value === 'user' ? '⟲ Back camera' : '⟲ Front camera';
    $('flipCam').style.display = running ? 'block' : 'none';
  }
  function tellApp() {
    if (ctl && ctl.readyState === 'open') { try { ctl.send(JSON.stringify({ facing: $('facing').value })); } catch (e) {} }
  }
  var facingNow = $('facing').value; // the camera in use (the select can be ahead of it while switching)
  function switchCamera(facing, from) {
    var was = from || facingNow;
    if (switching) { $('facing').value = was; return Promise.resolve(); }
    $('facing').value = facing;
    store.set('cam-facing', facing);
    flipLabel();
    if (!running || !stream || !stream.camera) { facingNow = facing; tellApp(); return Promise.resolve(); }
    switching = true;
    $('flipCam').disabled = true;
    var cam = stream.camera;
    // Most phones can't open both cameras at once: let go of this one first.
    cam.getVideoTracks().forEach(function (t) { t.stop(); });
    var video = constraints().video;
    return navigator.mediaDevices.getUserMedia({ video: video, audio: false }).catch(function () {
      // Some phones only answer a plain ask for the other camera.
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false });
    }).then(function (s) {
      var next = new MediaStream(s.getVideoTracks().concat(cam.getAudioTracks()));
      stream.camera = next;
      $('video').srcObject = next;
      facingNow = facing;
      setupCamera();
      syncSendTrack();
      $('video').play().catch(function () {});
      drawLoop();
    }).catch(function (e) {
      // Back to the camera it had.
      $('facing').value = was;
      store.set('cam-facing', was);
      status('Could not switch the camera: ' + (e && e.message ? e.message : e), true);
      return navigator.mediaDevices.getUserMedia({ video: constraints().video, audio: false }).then(function (s) {
        var back = new MediaStream(s.getVideoTracks().concat(cam.getAudioTracks()));
        stream.camera = back;
        $('video').srcObject = back;
        facingNow = was;
        setupCamera();
        syncSendTrack();
        $('video').play().catch(function () {});
        drawLoop();
      }).catch(function () {});
    }).then(function () {
      facingNow = $('facing').value;
      switching = false;
      $('flipCam').disabled = false;
      flipLabel();
      tellApp();
    });
  }
  $('flipCam').addEventListener('click', function () { switchCamera($('facing').value === 'user' ? 'environment' : 'user'); });

  function waitForIce(peer) {
    return new Promise(function (resolve) {
      if (peer.iceGatheringState === 'complete') return resolve();
      var done = function () { if (peer.iceGatheringState === 'complete') { peer.removeEventListener('icegatheringstatechange', done); resolve(); } };
      peer.addEventListener('icegatheringstatechange', done);
      setTimeout(resolve, 3000);
    });
  }

  function preferH264(tr) {
    if (!tr.setCodecPreferences || !window.RTCRtpSender || !RTCRtpSender.getCapabilities) return;
    var caps = RTCRtpSender.getCapabilities('video');
    if (!caps) return;
    var h264 = caps.codecs.filter(function (c) { return /h264/i.test(c.mimeType); });
    var rest = caps.codecs.filter(function (c) { return !/h264/i.test(c.mimeType); });
    try { if (h264.length) tr.setCodecPreferences(h264.concat(rest)); } catch (e) {}
  }

  // ---- What goes to the app: the camera itself when it's already the right way up, else the turned picture ----
  // Redrawing every frame costs the phone time (more delay, a warm phone), so it's only done when needed:
  // the phone held so the camera gives a tall picture, Turn it over, or the mirrored front camera.
  function wantedVideoTrack() {
    var cam = camTrack();
    if (cam && cam.readyState === 'live') {
      var s = cam.getSettings ? cam.getSettings() : {};
      if (s.width && s.height && s.width >= s.height && !$('flip').checked && !($('mirror').checked && facingNow === 'user')) {
        if ('contentHint' in cam) cam.contentHint = 'detail';
        return cam;
      }
    }
    return outStream ? outStream.getVideoTracks()[0] : null;
  }
  function syncSendTrack() {
    if (!pc) return;
    var t = wantedVideoTrack();
    if (!t) return;
    pc.getTransceivers().forEach(function (tr) {
      var s = tr.sender;
      if (!s || tr.receiver.track.kind !== 'video' || s.track === t) return;
      s.replaceTrack(t).catch(function () {});
    });
  }
  setInterval(syncSendTrack, 1000);
  $('flip').addEventListener('change', syncSendTrack);
  $('mirror').addEventListener('change', syncSendTrack);

  function setBitrate() {
    if (!pc) return;
    var kbps = $('quality').value === '1080' ? 8000 : 4000;
    pc.getSenders().forEach(function (s) {
      if (!s.track || s.track.kind !== 'video') return;
      var p = s.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = kbps * 1000;
      p.encodings[0].maxFramerate = 30;
      p.degradationPreference = 'maintain-resolution';
      s.setParameters(p).catch(function () {});
    });
  }

  function closePeer() {
    if (pc) { try { pc.close(); } catch (e) {} }
    pc = null;
    ctl = null;
  }

  function connectSoon(ms) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, ms);
  }

  function connect() {
    if (!running || !stream) return;
    closePeer();
    var peer = new RTCPeerConnection({ iceServers: [] });
    pc = peer;
    stream.getTracks().forEach(function (t) {
      if (t.kind === 'video') t = wantedVideoTrack() || t;
      var tr = peer.addTransceiver(t, { direction: 'sendonly', streams: [stream] });
      if (t.kind === 'video') preferH264(tr);
    });
    // A small message link: the app can flip this phone's camera, and sees which one it's on.
    var ch = peer.createDataChannel('control');
    ctl = ch;
    ch.onopen = function () { if (ctl === ch) { tellApp(); reportCamera(); } };
    ch.onmessage = function (m) {
      if (ctl !== ch) return;
      var msg = null;
      try { msg = JSON.parse(m.data); } catch (e) { return; }
      if (msg && (msg.facing === 'user' || msg.facing === 'environment') && msg.facing !== $('facing').value) switchCamera(msg.facing);
      if (msg && msg.set && typeof msg.set === 'object') setCamera(msg.set);
    };
    peer.onconnectionstatechange = function () {
      if (pc !== peer) return;
      var s = peer.connectionState;
      if (s === 'connected') { attempt = 0; setBitrate(); badge('LIVE IN APP', 'on'); status('Connected. This camera is in the app\\'s device list as "' + $('name').value + '".'); }
      else if (s === 'failed' || s === 'closed') { badge('Reconnecting', 'wait'); status('Lost the app. Trying again...', true); connectSoon(2000); }
      else if (s === 'disconnected') { badge('Reconnecting', 'wait'); setTimeout(function () { if (pc === peer && peer.connectionState === 'disconnected') connectSoon(0); }, 5000); }
    };
    badge('Connecting', 'wait');
    status('Connecting to the app...');
    peer.createOffer().then(function (o) { return peer.setLocalDescription(o); })
      .then(function () { return waitForIce(peer); })
      .then(function () {
        return fetch('/cam/offer', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ t: token, id: id, name: $('name').value.trim() || 'Phone', sdp: peer.localDescription.sdp })
        });
      })
      .then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.error || 'The app said no'); return b; }); })
      .then(function (b) { if (pc === peer) return peer.setRemoteDescription({ type: 'answer', sdp: b.sdp }); })
      .catch(function (e) {
        if (pc !== peer) return;
        closePeer();
        badge('Waiting', 'wait');
        status((e && e.message ? e.message : 'Could not reach the app') + ' Trying again...', true);
        connectSoon(Math.min(10000, 2000 * Math.pow(1.5, attempt++)));
      });
  }

  function start() {
    if (!token) { status('Scan the QR code in the app (Settings, Inputs) to open this page.', true); return; }
    if (!navigator.mediaDevices || !window.RTCPeerConnection) { status('This browser cannot send video. Use Chrome on Android or Safari on iPhone.', true); return; }
    store.set('cam-name', $('name').value.trim());
    store.set('cam-facing', $('facing').value);
    store.set('cam-quality', $('quality').value);
    $('start').disabled = true;
    askMotion();
    status('Allow the camera and microphone when the phone asks.');
    openCamera().then(function () {
      running = true;
      keepAwake();
      $('start').disabled = false;
      $('start').textContent = 'Stop camera';
      $('start').className = 'stop';
      flipLabel();
      connect();
    }).catch(function (e) {
      $('start').disabled = false;
      status(e && e.name === 'NotAllowedError' ? 'The camera was blocked. Allow it in the browser settings for this page, then try again.' : 'Could not open the camera: ' + (e && e.message ? e.message : e), true);
    });
  }

  function bye() {
    var body = JSON.stringify({ t: token, id: id });
    try { if (navigator.sendBeacon && navigator.sendBeacon('/cam/bye', new Blob([body], { type: 'text/plain' }))) return; } catch (e) {}
    fetch('/cam/bye', { method: 'POST', body: body, keepalive: true }).catch(function () {});
  }
  window.addEventListener('pagehide', function () { if (running) bye(); });

  function stop() {
    running = false;
    bye();
    clearTimeout(retryTimer);
    closePeer();
    stopCamera();
    stream = null;
    $('video').srcObject = null;
    if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
    $('start').textContent = 'Start camera';
    $('start').className = '';
    flipLabel();
    $('camSet').style.display = 'none';
    badge('Not started');
    status('Stopped. The camera left the app\\'s device list.');
  }

  $('start').addEventListener('click', function () { if (running) stop(); else start(); });

  // Android: full screen locked sideways, so the page turns even with auto-rotate off.
  // iPhones can't lock a web page sideways: turning off Portrait Orientation Lock lets it turn.
  var canLock = !isIphone && screen.orientation && typeof screen.orientation.lock === 'function' && document.documentElement.requestFullscreen;
  if (canLock) $('land').style.display = 'block';
  else if (isIphone) $('rotTip').textContent += ' To turn this page sideways too, turn off Portrait Orientation Lock in Control Centre.';
  $('install').addEventListener('click', function () {
    if (!installEvent) return;
    installEvent.prompt();
    installEvent = null;
    $('install').style.display = 'none';
  });
  var asApp = window.matchMedia('(display-mode: fullscreen)').matches || window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!asApp) {
    $('rotTip').textContent += isIphone
      ? ' For a clean full-screen camera with no address bar: tap Share, then Add to Home Screen, and open it from the new icon.'
      : ' For a clean full-screen camera: Chrome menu (⋮), Add to Home screen, then open it from the new icon. Or use Full screen, sideways.';
  }
  $('land').addEventListener('click', function () {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(function () {});
      return;
    }
    document.documentElement.requestFullscreen({ navigationUI: 'hide' })
      .then(function () { return screen.orientation.lock('landscape'); })
      .catch(function () { status('This phone did not allow turning the page. Turn on auto-rotate instead.', true); });
  });
  document.addEventListener('fullscreenchange', function () {
    $('land').textContent = document.fullscreenElement ? 'Leave full screen' : 'Full screen, sideways';
  });

  // Changing the camera, quality or microphone while running: open it again and reconnect.
  // The camera (front / back) switches without reconnecting, like the Flip button.
  $('facing').addEventListener('change', function () { switchCamera($('facing').value, facingNow); });
  ['quality', 'mic'].forEach(function (k) {
    $(k).addEventListener('change', function () {
      store.set('cam-facing', $('facing').value);
      store.set('cam-quality', $('quality').value);
      if (!running) return;
      openCamera().then(function () { connectSoon(0); }).catch(function () { status('Could not switch the camera.', true); });
    });
  });
  $('name').addEventListener('change', function () {
    store.set('cam-name', $('name').value.trim());
    if (running) connectSoon(0);
  });
})();
</script>
</body>
</html>
`
