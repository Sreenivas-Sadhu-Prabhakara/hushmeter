/* ============================================================
   hushmeter — client-side noise-level logger.
   Web Audio AnalyserNode only. No <audio>/<video> element,
   no recording, no network. Sessions live in localStorage.
   ============================================================ */
(function () {
  "use strict";

  /* ---------- tiny helpers ---------- */
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var STORE_KEY = "hushmeter:sessions:v1";
  var CALIB_KEY = "hushmeter:calibration:v1";

  /* ---------- level model ----------
     We read the time-domain waveform from an AnalyserNode, compute RMS,
     convert to dBFS, then map to an indicative dB(A)-style number.
     A phone mic is uncalibrated + AGC-affected, so this is a RELATIVE
     indicator, deliberately labelled as such throughout the UI.
     Anchor: dBFS -60 -> ~30 (very quiet), dBFS 0 -> ~90 (very loud). */
  function dbfsToIndicative(dbfs) {
    // clamp dbfs to a sane window then linear-map into ~30..100
    var lo = -60, hi = 0;
    var t = (dbfs - lo) / (hi - lo);
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return 30 + t * 70; // 30..100
  }

  function bandFor(level) {
    if (level < 50) return "quiet";
    if (level < 68) return "moderate";
    if (level < 85) return "loud";
    return "risk";
  }
  var BAND_LABEL = { quiet: "Quiet", moderate: "Moderate", loud: "Loud", risk: "Hearing risk" };

  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }
  function fmtWhen(ts) {
    try {
      var d = new Date(ts);
      return d.toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
      });
    } catch (e) { return ""; }
  }

  /* ============================================================
     STORAGE
     ============================================================ */
  var storageOk = true;

  function loadSessions() {
    if (!storageOk) return [];
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveSessions(list) {
    if (!storageOk) return;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); }
    catch (e) { storageOk = false; }
  }
  function loadCalibration() {
    if (!storageOk) return 0;
    try {
      var v = parseInt(localStorage.getItem(CALIB_KEY), 10);
      return isNaN(v) ? 0 : Math.max(-30, Math.min(30, v));
    } catch (e) { return 0; }
  }
  function saveCalibration(v) {
    if (!storageOk) return;
    try { localStorage.setItem(CALIB_KEY, String(v)); } catch (e) {}
  }

  /* ============================================================
     AUDIO ENGINE (AnalyserNode only — no media element)
     ============================================================ */
  var audio = {
    ctx: null,
    analyser: null,
    stream: null,
    source: null,
    buf: null,
    running: false,      // mic active + drawing
    rafId: 0,
    smoothed: null       // smoothed indicative level
  };

  // session recording state
  var session = {
    active: false,
    startedAt: 0,
    samples: [],         // { t: seconds, v: level }
    lastSampleAt: 0,
    min: Infinity, max: -Infinity, sum: 0, count: 0
  };

  var calibration = 0;   // dB offset

  function setMsg(text, kind) {
    var m = $("#micMsg");
    m.textContent = text || "";
    m.classList.remove("is-error", "is-ok");
    if (kind) m.classList.add(kind);
  }

  function measureDbfs() {
    var a = audio.analyser, buf = audio.buf;
    a.getByteTimeDomainData(buf);
    var sum = 0;
    for (var i = 0; i < buf.length; i++) {
      var v = (buf[i] - 128) / 128; // -1..1
      sum += v * v;
    }
    var rms = Math.sqrt(sum / buf.length);
    if (rms < 1e-8) rms = 1e-8;
    return 20 * Math.log10(rms); // dBFS, <= 0
  }

  function currentLevel() {
    var dbfs = measureDbfs();
    var lvl = dbfsToIndicative(dbfs) + calibration;
    return Math.max(0, lvl);
  }

  /* ---------- render loop ---------- */
  function tick() {
    if (!audio.running) return;
    var raw = currentLevel();

    // smooth for a calm readout (exponential moving average)
    if (audio.smoothed == null) audio.smoothed = raw;
    audio.smoothed += (raw - audio.smoothed) * 0.25;
    var lvl = audio.smoothed;

    drawWave();
    updateReadout(lvl);

    if (session.active) {
      var now = performance.now();
      // sample ~5x/second into the timeline
      if (now - session.lastSampleAt >= 200) {
        session.lastSampleAt = now;
        var t = (Date.now() - session.startedAt) / 1000;
        session.samples.push({ t: t, v: Math.round(lvl * 10) / 10 });
        if (lvl < session.min) session.min = lvl;
        if (lvl > session.max) session.max = lvl;
        session.sum += lvl; session.count++;
        updateSessionStats();
        drawTimeline();
      }
    }

    audio.rafId = requestAnimationFrame(tick);
  }

  var lastSrAt = 0;
  function updateReadout(lvl) {
    var num = $("#levelNum");
    var band = bandFor(lvl);
    var rounded = Math.round(lvl);
    num.textContent = String(rounded);

    var readout = $(".readout");
    readout.classList.remove("is-loud", "is-risk");
    if (band === "loud") readout.classList.add("is-loud");
    else if (band === "risk") readout.classList.add("is-risk");

    var badge = $("#levelBand");
    badge.textContent = BAND_LABEL[band];
    badge.className = "readout__band is-" + band;

    // Screen-reader text, throttled so it doesn't spam AT.
    var now = performance.now();
    if (now - lastSrAt > 1500) {
      lastSrAt = now;
      $("#levelSr").textContent = rounded + " decibels relative, " + BAND_LABEL[band] + ".";
    }
  }

  function updateSessionStats() {
    $("#statMin").textContent = session.count ? Math.round(session.min) : "--";
    $("#statMax").textContent = session.count ? Math.round(session.max) : "--";
    $("#statAvg").textContent = session.count ? Math.round(session.sum / session.count) : "--";
    var elapsed = session.active ? (Date.now() - session.startedAt) / 1000 : 0;
    $("#statTime").textContent = fmtDuration(elapsed);
  }

  function resetStats() {
    session.samples = [];
    session.min = Infinity; session.max = -Infinity; session.sum = 0; session.count = 0;
    $("#statMin").textContent = "--";
    $("#statMax").textContent = "--";
    $("#statAvg").textContent = "--";
    $("#statTime").textContent = "0:00";
  }

  /* ============================================================
     CANVAS DRAWING
     ============================================================ */
  function dpr() { return Math.min(window.devicePixelRatio || 1, 2); }

  // scale a canvas to its CSS size crisply
  function fitCanvas(cv) {
    var ratio = dpr();
    var rect = cv.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height || (cv.height / (cv.width / w))));
    if (cv.width !== w * ratio || cv.height !== h * ratio) {
      cv.width = w * ratio; cv.height = h * ratio;
    }
    var ctx = cv.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  function drawWave() {
    var cv = $("#wave");
    var f = fitCanvas(cv);
    var ctx = f.ctx, w = f.w, h = f.h;
    ctx.clearRect(0, 0, w, h);

    var buf = audio.buf, mid = h / 2;

    // midline
    ctx.strokeStyle = "rgba(95,108,80,0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

    // waveform
    ctx.strokeStyle = "#B6FF3C";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.shadowColor = "rgba(182,255,60,0.5)";
    ctx.shadowBlur = 6;
    ctx.beginPath();
    var step = buf.length / w;
    for (var x = 0; x < w; x++) {
      var idx = Math.floor(x * step);
      var v = (buf[idx] - 128) / 128; // -1..1
      var y = mid + v * (mid - 4);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // draw a level-over-time line into any canvas + optional min/avg/max guides
  function drawSeries(cv, samples, opts) {
    opts = opts || {};
    var f = fitCanvas(cv);
    var ctx = f.ctx, w = f.w, h = f.h;
    ctx.clearRect(0, 0, w, h);
    if (!samples.length) return;

    var loY = 25, hiY = 105;               // fixed dB window for the y-axis
    var pad = { l: 34, r: 10, t: 10, b: 18 };
    var plotW = w - pad.l - pad.r;
    var plotH = h - pad.t - pad.b;

    function yFor(v) {
      var t = (v - loY) / (hiY - loY);
      t = Math.max(0, Math.min(1, t));
      return pad.t + (1 - t) * plotH;
    }
    var maxT = samples[samples.length - 1].t || 1;
    function xFor(t) { return pad.l + (t / maxT) * plotW; }

    // y gridlines + labels
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.textBaseline = "middle";
    [40, 60, 80, 100].forEach(function (g) {
      var y = yFor(g);
      ctx.strokeStyle = "rgba(56,67,31,0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillStyle = "#5F6C50";
      ctx.textAlign = "right";
      ctx.fillText(String(g), pad.l - 6, y);
    });

    // avg guide
    if (opts.avg != null) {
      var ay = yFor(opts.avg);
      ctx.strokeStyle = "rgba(182,255,60,0.35)";
      ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.l, ay); ctx.lineTo(w - pad.r, ay); ctx.stroke();
      ctx.setLineDash([]);
    }

    // area fill under the line
    var grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + plotH);
    grad.addColorStop(0, "rgba(182,255,60,0.22)");
    grad.addColorStop(1, "rgba(182,255,60,0.0)");
    ctx.beginPath();
    ctx.moveTo(xFor(samples[0].t), yFor(samples[0].v));
    samples.forEach(function (s) { ctx.lineTo(xFor(s.t), yFor(s.v)); });
    ctx.lineTo(xFor(samples[samples.length - 1].t), pad.t + plotH);
    ctx.lineTo(xFor(samples[0].t), pad.t + plotH);
    ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    // the line itself
    ctx.beginPath();
    samples.forEach(function (s, i) {
      var x = xFor(s.t), y = yFor(s.v);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#B6FF3C"; ctx.lineWidth = 2; ctx.lineJoin = "round";
    ctx.stroke();

    // peak marker (amber)
    if (opts.peak != null) {
      var pk = samples.reduce(function (a, b) { return b.v > a.v ? b : a; }, samples[0]);
      var px = xFor(pk.t), py = yFor(pk.v);
      ctx.fillStyle = "#FFB020";
      ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawTimeline() {
    if (!session.samples.length) return;
    var avg = session.count ? session.sum / session.count : null;
    drawSeries($("#chart"), session.samples, { avg: avg, peak: session.max });
    var wrap = $("#timeline");
    if (wrap.hidden) wrap.hidden = false;
    $("#timelineMeta").textContent =
      session.samples.length + " samples · " +
      fmtDuration((Date.now() - session.startedAt) / 1000) + " elapsed";
  }

  /* ============================================================
     MIC LIFECYCLE
     ============================================================ */
  function startMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMsg("This browser does not support microphone access (getUserMedia).", "is-error");
      return;
    }
    if (!(window.AudioContext || window.webkitAudioContext)) {
      setMsg("This browser does not support the Web Audio API.", "is-error");
      return;
    }
    setMsg("Requesting microphone permission…");
    $("#micBtn").disabled = true;

    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    }).then(function (stream) {
      audio.stream = stream;
      var Ctx = window.AudioContext || window.webkitAudioContext;
      audio.ctx = new Ctx();
      // NOTE: stream is connected ONLY to an AnalyserNode — never to an
      // <audio>/<video> element and never to ctx.destination. So nothing
      // is played back, recorded, or written to any media element.
      audio.source = audio.ctx.createMediaStreamSource(stream);
      audio.analyser = audio.ctx.createAnalyser();
      audio.analyser.fftSize = 2048;
      audio.analyser.smoothingTimeConstant = 0.4;
      audio.buf = new Uint8Array(audio.analyser.fftSize);
      audio.source.connect(audio.analyser); // dead-ends here on purpose

      if (audio.ctx.state === "suspended") audio.ctx.resume();

      audio.running = true;
      audio.smoothed = null;
      $("#micBtn").textContent = "Stop microphone";
      $("#micBtn").disabled = false;
      $("#sessionBtn").disabled = false;
      setMsg("Microphone live. Audio is analysed on your device and never recorded.", "is-ok");
      tick();
    }).catch(function (err) {
      $("#micBtn").disabled = false;
      var name = err && err.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        setMsg("Microphone permission was blocked. Allow mic access for this page in your browser, then try again.", "is-error");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setMsg("No microphone was found. Connect or enable a mic and try again.", "is-error");
      } else if (name === "NotReadableError") {
        setMsg("The microphone is in use by another app. Close it and try again.", "is-error");
      } else {
        setMsg("Could not access the microphone" + (name ? " (" + name + ")" : "") + ".", "is-error");
      }
    });
  }

  function stopMic() {
    audio.running = false;
    if (audio.rafId) cancelAnimationFrame(audio.rafId);
    if (session.active) finishSession(); // will prompt to save
    if (audio.source) { try { audio.source.disconnect(); } catch (e) {} }
    if (audio.stream) { audio.stream.getTracks().forEach(function (t) { t.stop(); }); }
    if (audio.ctx) { try { audio.ctx.close(); } catch (e) {} }
    audio.ctx = audio.analyser = audio.stream = audio.source = audio.buf = null;
    audio.smoothed = null;
    $("#micBtn").textContent = "Enable microphone";
    $("#sessionBtn").disabled = true;
    $("#levelNum").textContent = "--";
    var badge = $("#levelBand"); badge.textContent = "Idle"; badge.className = "readout__band";
    $(".readout").classList.remove("is-loud", "is-risk");
    // clear the scope
    var f = fitCanvas($("#wave")); f.ctx.clearRect(0, 0, f.w, f.h);
    setMsg("Microphone stopped.");
  }

  function toggleMic() {
    if (audio.running) stopMic(); else startMic();
  }

  /* ============================================================
     SESSION START / STOP / SAVE
     ============================================================ */
  function startSession() {
    session.active = true;
    session.startedAt = Date.now();
    session.lastSampleAt = 0;
    resetStats();
    var btn = $("#sessionBtn");
    btn.textContent = "Stop session";
    btn.classList.add("is-recording");
    $("#timeline").hidden = true;
    setMsg("Session started. Move around the space to sample it.", "is-ok");
  }

  function finishSession() {
    if (!session.active) return;
    session.active = false;
    var btn = $("#sessionBtn");
    btn.textContent = "Start session";
    btn.classList.remove("is-recording");

    if (session.count < 1) {
      setMsg("Session was too short to save — try running it for a few seconds.");
      return;
    }
    // freeze a summary and prompt to name it
    pendingSession = {
      durationSec: (Date.now() - session.startedAt) / 1000,
      min: Math.round(session.min * 10) / 10,
      max: Math.round(session.max * 10) / 10,
      avg: Math.round((session.sum / session.count) * 10) / 10,
      samples: session.samples.slice(),
      savedAt: Date.now(),
      calibration: calibration
    };
    openSaveDialog();
  }

  function toggleSession() {
    if (session.active) finishSession(); else startSession();
  }

  var pendingSession = null;

  function openSaveDialog() {
    var dlg = $("#saveDialog");
    $("#saveSummary").textContent =
      fmtDuration(pendingSession.durationSec) + " · min " + Math.round(pendingSession.min) +
      " · avg " + Math.round(pendingSession.avg) + " · peak " + Math.round(pendingSession.max) + " dB(rel)";
    $("#sessionName").value = "";
    if (typeof dlg.showModal === "function") {
      dlg.showModal();
      setTimeout(function () { $("#sessionName").focus(); }, 30);
    } else {
      // fallback: save with a default name
      commitSession("Session " + fmtWhen(pendingSession.savedAt));
    }
  }

  function commitSession(name) {
    if (!pendingSession) return;
    var list = loadSessions();
    pendingSession.id = "s_" + pendingSession.savedAt + "_" + Math.floor(Math.random() * 1e6).toString(36);
    pendingSession.name = (name || "").trim() || "Session " + fmtWhen(pendingSession.savedAt);
    list.unshift(pendingSession);
    saveSessions(list);
    pendingSession = null;
    renderHistory();
    setMsg("Session saved.", "is-ok");
  }

  /* ============================================================
     HISTORY
     ============================================================ */
  function renderHistory() {
    var list = loadSessions();
    var wrap = $("#historyList");
    wrap.innerHTML = "";
    $("#historyEmpty").hidden = list.length > 0;
    $("#clearAllBtn").hidden = list.length === 0;

    list.forEach(function (s) {
      var card = el("div", "session");
      card.dataset.id = s.id;

      var row = el("div", "session__row");

      var head = el("div", "session__namewrap");
      head.appendChild(el("span", "session__name", s.name));
      head.appendChild(el("span", "session__when", fmtWhen(s.savedAt)));

      var facts = el("div", "session__facts");
      facts.appendChild(sfact("dur", fmtDuration(s.durationSec)));
      facts.appendChild(sfact("min " , String(Math.round(s.min)), "sfact"));
      facts.appendChild(sfact("avg ", String(Math.round(s.avg)), "sfact sfact--avg"));
      facts.appendChild(sfact("peak ", String(Math.round(s.max)), "sfact sfact--peak"));

      var actions = el("div", "session__actions");
      var viewBtn = el("button", "icon-btn", "View");
      viewBtn.type = "button";
      viewBtn.setAttribute("aria-expanded", "false");
      var csvBtn = el("button", "icon-btn", "CSV");
      csvBtn.type = "button";
      var txtBtn = el("button", "icon-btn", "Summary");
      txtBtn.type = "button";
      var delBtn = el("button", "icon-btn icon-btn--danger", "Delete");
      delBtn.type = "button";
      actions.appendChild(viewBtn);
      actions.appendChild(csvBtn);
      actions.appendChild(txtBtn);
      actions.appendChild(delBtn);

      row.appendChild(head);
      row.appendChild(facts);
      row.appendChild(actions);
      card.appendChild(row);

      var detail = el("div", "session__detail");
      detail.hidden = true;
      var cwrap = el("div", "session__canvas-wrap");
      var cv = el("canvas", "session__canvas");
      cv.width = 1000; cv.height = 200;
      cv.setAttribute("role", "img");
      cv.setAttribute("aria-label", "Timeline of " + s.name + ": min " + Math.round(s.min) +
        ", average " + Math.round(s.avg) + ", peak " + Math.round(s.max) + " relative decibels");
      cwrap.appendChild(cv);
      detail.appendChild(cwrap);
      card.appendChild(detail);

      viewBtn.addEventListener("click", function () {
        var open = detail.hidden;
        detail.hidden = !open;
        viewBtn.textContent = open ? "Hide" : "View";
        viewBtn.setAttribute("aria-expanded", open ? "true" : "false");
        if (open) drawSeries(cv, s.samples, { avg: s.avg, peak: s.max });
      });
      csvBtn.addEventListener("click", function () { exportCSV(s); });
      txtBtn.addEventListener("click", function () { exportSummary(s); });
      delBtn.addEventListener("click", function () { deleteSession(s.id); });

      wrap.appendChild(card);
    });
  }

  function sfact(label, val, cls) {
    var f = el("span", cls || "sfact");
    f.appendChild(document.createTextNode(label + " "));
    f.appendChild(el("b", null, val));
    return f;
  }

  function deleteSession(id) {
    var list = loadSessions().filter(function (s) { return s.id !== id; });
    saveSessions(list);
    renderHistory();
    setMsg("Session deleted.");
  }

  function clearAll() {
    saveSessions([]);
    renderHistory();
    setMsg("All sessions deleted.");
  }

  /* ============================================================
     EXPORT — build a blob + object URL, click a temp anchor.
     No network; the data: / blob: download stays local.
     ============================================================ */
  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = el("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function safeName(name) {
    return (name || "session").replace(/[^a-z0-9\-_]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "session";
  }

  function exportCSV(s) {
    var rows = ["timestamp,level"];
    var base = s.savedAt - Math.round(s.durationSec * 1000);
    s.samples.forEach(function (p) {
      var isoish = new Date(base + Math.round(p.t * 1000)).toISOString();
      rows.push(isoish + "," + p.v);
    });
    download("hushmeter-" + safeName(s.name) + ".csv", rows.join("\n"), "text/csv;charset=utf-8");
  }

  function exportSummary(s) {
    var lines = [
      "hushmeter session summary",
      "==========================",
      "Name:        " + s.name,
      "Saved:       " + new Date(s.savedAt).toString(),
      "Duration:    " + fmtDuration(s.durationSec),
      "Samples:     " + s.samples.length,
      "",
      "Level (indicative dB, relative — NOT calibrated):",
      "  Minimum:   " + Math.round(s.min),
      "  Average:   " + Math.round(s.avg),
      "  Peak:      " + Math.round(s.max),
      "  Calibration offset applied: " + (s.calibration || 0) + " dB",
      "",
      "Note: hushmeter uses an uncalibrated microphone with automatic gain",
      "control. These figures are a relative indicator for general awareness",
      "only and must not be used for occupational, medical, or legal decisions."
    ];
    download("hushmeter-" + safeName(s.name) + "-summary.txt", lines.join("\n"));
  }

  /* ============================================================
     CALIBRATION SLIDER
     ============================================================ */
  function initCalib() {
    var range = $("#calib");
    calibration = loadCalibration();
    range.value = String(calibration);
    updateCalibOut();
    range.addEventListener("input", function () {
      calibration = parseInt(range.value, 10) || 0;
      updateCalibOut();
      saveCalibration(calibration);
    });
  }
  function updateCalibOut() {
    var v = calibration;
    $("#calibOut").textContent = (v > 0 ? "+" : "") + v + " dB";
  }

  /* ============================================================
     HERO GRID + TRACE SIGNATURE
     ============================================================ */
  function renderHeroGrid() {
    var lines = $(".grid__lines");
    var trace = $(".grid__trace");
    if (!lines || !trace) return;
    var W = 1440, H = 360;
    var svgNS = "http://www.w3.org/2000/svg";

    // grid
    var gfrag = document.createDocumentFragment();
    for (var x = 0; x <= W; x += 48) {
      var vl = document.createElementNS(svgNS, "line");
      vl.setAttribute("x1", x); vl.setAttribute("y1", 0);
      vl.setAttribute("x2", x); vl.setAttribute("y2", H);
      gfrag.appendChild(vl);
    }
    for (var y = 0; y <= H; y += 40) {
      var hl = document.createElementNS(svgNS, "line");
      hl.setAttribute("x1", 0); hl.setAttribute("y1", y);
      hl.setAttribute("x2", W); hl.setAttribute("y2", y);
      gfrag.appendChild(hl);
    }
    lines.appendChild(gfrag);

    // an oscilloscope trace across the top
    var mid = H * 0.42;
    var d = "M -80 " + mid.toFixed(1);
    for (var px = -80; px <= W + 80; px += 8) {
      var yy = mid
        + Math.sin(px / 90) * 34
        + Math.sin(px / 23 + 1.3) * 12
        + Math.sin(px / 300) * 20;
      d += " L " + px + " " + yy.toFixed(1);
    }
    var p = document.createElementNS(svgNS, "path");
    p.setAttribute("d", d);
    trace.appendChild(p);
  }

  /* ============================================================
     RESIZE handling — redraw canvases crisply
     ============================================================ */
  var resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (audio.running) drawWave();
      if (session.samples.length) drawTimeline();
    }, 120);
  }

  /* ============================================================
     WIRE UP
     ============================================================ */
  function init() {
    // storage feature test
    try { localStorage.setItem("hushmeter:test", "1"); localStorage.removeItem("hushmeter:test"); }
    catch (e) { storageOk = false; }

    initCalib();
    renderHeroGrid();
    renderHistory();

    $("#micBtn").addEventListener("click", toggleMic);
    $("#sessionBtn").addEventListener("click", toggleSession);
    $("#clearAllBtn").addEventListener("click", clearAll);

    // save dialog result
    var dlg = $("#saveDialog");
    $("#saveForm").addEventListener("submit", function () {
      // returnValue is the submit button's value ("save" | "discard")
      if (dlg.returnValue === "save") {
        commitSession($("#sessionName").value);
      } else if (pendingSession) {
        pendingSession = null;
        setMsg("Session discarded.");
      }
    });
    dlg.addEventListener("close", function () {
      if (dlg.returnValue !== "save" && pendingSession) {
        pendingSession = null;
      }
    });

    window.addEventListener("resize", onResize);
    // stop cleanly when leaving the page
    window.addEventListener("pagehide", function () {
      if (audio.stream) audio.stream.getTracks().forEach(function (t) { t.stop(); });
    });

    if (!storageOk) {
      setMsg("Note: your browser is blocking local storage, so sessions cannot be saved on this device.");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
