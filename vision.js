/* Vision mode: webcam fastener recognition that runs in the browser.
   1. It learns what the empty background looks like, then finds any part that appears on it and crops tightly around it,
      so the part's size and position do not matter and no "empty" training is needed.
   2. MobileNet turns that crop into a 1280-number fingerprint. Training stores the part in four rotations, so how it is turned does not matter.
   3. A nearest-neighbour check against the trained samples (kept in the shared database) names the part, or says it is unknown.
   Loaded on demand by index.html, which also provides: state, $, esc, when, toast, guard, rpcAuth, requireAuth, refreshAll, setTab, sb. */
(function () {
  const VERSION = "7";
  const MODEL_URL = "https://storage.googleapis.com/tfjs-models/savedmodel/mobilenet_v2_1.0_224/model.json";
  const NODE = "module_apply_default/MobilenetV2/Logits/AvgPool";   // the 1280-number feature layer
  const DIM = 1280, AW = 320, STREAK = 3, ABSENT = 4, MAX_AREA = 0.3, MIN_AREA = 40, PAD = 1.5, TAG = "v2:";
  const V = { model: null, loading: null, samples: [], old: 0, loaded: false, stream: null, running: false, timer: null, view: null,
    centered: null, mean: null, bg: null, aw: 0, ah: 0, ac: null, thr: 28, unknownT: 0.2, action: 0, record: true, tally: {}, recent: [],
    fps: 0, frames: 0, t0: 0, absent: 99, armed: true, lastKey: null, streak: 0, last: null, cls: null };
  try { const t = Number(localStorage.getItem("v_thr")); if (t >= 10 && t <= 70) V.thr = t; const u = Number(localStorage.getItem("v_unk")); if (u >= 0 && u <= 0.8) V.unknownT = u; } catch (e) {}

  /* ---------- fingerprints ---------- */
  const b64 = u8 => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  function encode(vec) {   // float32 -> int8 -> base64 (about 1.7 KB per sample)
    let m = 0; for (const x of vec) m = Math.max(m, Math.abs(x)); const k = m ? 127 / m : 0, q = new Int8Array(vec.length);
    for (let i = 0; i < vec.length; i++) q[i] = Math.round(vec[i] * k);
    return TAG + b64(new Uint8Array(q.buffer));
  }
  function decode(s) { const bin = atob(s.replace(/^v2:/, "")), u = new Int8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i) << 24 >> 24; return Float32Array.from(u); }
  const unit = v => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map(x => x / n); };

  function rebuild() {   // centre the fingerprints so that "similar" really means similar, then group by class
    V.centered = null; if (!V.samples.length) return;
    const mean = new Float32Array(DIM); V.samples.forEach(s => { for (let i = 0; i < DIM; i++) mean[i] += s.raw[i]; }); for (let i = 0; i < DIM; i++) mean[i] /= V.samples.length;
    V.mean = mean; const by = {};
    V.samples.forEach(s => { (by[s.key] = by[s.key] || []).push(unit(s.raw.map((x, i) => x - mean[i]))); });
    V.centered = by;
  }
  function predict(raw) {
    if (!V.centered || Object.keys(V.centered).length < 2) return null;
    const q = unit(raw.map((x, i) => x - V.mean[i])), scores = [];
    for (const [key, list] of Object.entries(V.centered)) {
      const sims = list.map(c => { let d = 0; for (let i = 0; i < DIM; i++) d += c[i] * q[i]; return d; }).sort((a, b) => b - a);
      const top = sims.slice(0, 3); scores.push({ key, s: top.reduce((a, b) => a + b, 0) / top.length });
    }
    scores.sort((a, b) => b.s - a.s);
    const den = scores.reduce((a, x) => a + Math.exp(20 * (x.s - scores[0].s)), 0);
    return { key: scores[0].key, score: scores[0].s, conf: 1 / den, ranks: scores, den };
  }

  /* ---------- finding the part on the background ---------- */
  function grab(video) {
    const w = video.videoWidth, h = video.videoHeight; if (!w) return null;
    if (!V.ac || V.ah !== Math.round(AW * h / w)) { V.aw = AW; V.ah = Math.round(AW * h / w); V.ac = document.createElement("canvas"); V.ac.width = V.aw; V.ac.height = V.ah; V.bg = null; }
    const g = V.ac.getContext("2d", { willReadFrequently: true }); g.drawImage(video, 0, 0, V.aw, V.ah); return g.getImageData(0, 0, V.aw, V.ah);
  }
  async function learnBackground(video, n = 8) {
    let acc = null;
    for (let i = 0; i < n; i++) { const im = grab(video); if (!im) return false; if (!acc) acc = new Float32Array(im.data.length); for (let j = 0; j < im.data.length; j++) acc[j] += im.data[j]; await new Promise(r => setTimeout(r, 90)); }
    for (let j = 0; j < acc.length; j++) acc[j] /= n; V.bg = acc; return true;
  }
  /* returns { box:{x0,y0,x1,y1,area}, big } for the largest thing that differs from the background, or null */
  function findPart(im, bg, w, h, thr) {
    const d = im.data; let ox = 0, oy = 0, oz = 0, on = 0;   // brightness shift measured on the border, where the part is not
    for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) { if (x < w * 0.08 || x > w * 0.92 || y < h * 0.08 || y > h * 0.92) { const i = (y * w + x) * 4; ox += d[i] - bg[i]; oy += d[i + 1] - bg[i + 1]; oz += d[i + 2] - bg[i + 2]; on++; } }
    ox /= on || 1; oy /= on || 1; oz /= on || 1;
    const mask = new Uint8Array(w * h);
    for (let p = 0, i = 0; p < w * h; p++, i += 4) { const e = (Math.abs(d[i] - bg[i] - ox) + Math.abs(d[i + 1] - bg[i + 1] - oy) + Math.abs(d[i + 2] - bg[i + 2] - oz)) / 3; if (e > thr) mask[p] = 1; }
    let best = null; const stack = new Int32Array(w * h);
    for (let s = 0; s < w * h; s++) {
      if (mask[s] !== 1) continue; let sp = 0, area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0; stack[sp++] = s; mask[s] = 2;
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p - x) / w; area++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && mask[p - 1] === 1) { mask[p - 1] = 2; stack[sp++] = p - 1; } if (x < w - 1 && mask[p + 1] === 1) { mask[p + 1] = 2; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] === 1) { mask[p - w] = 2; stack[sp++] = p - w; } if (y < h - 1 && mask[p + w] === 1) { mask[p + w] = 2; stack[sp++] = p + w; }
      }
      if (area >= MIN_AREA && (!best || area > best.area)) best = { x0, y0, x1, y1, area };
    }
    if (!best) return null; return { box: best, big: best.area > MAX_AREA * w * h };
  }

  const detect = im => V.testPart !== undefined ? V.testPart : findPart(im, V.bg, V.aw, V.ah, V.thr);   // testPart lets tests stand in for a real part

  /* ---------- model, crops and camera ---------- */
  async function ensureModel() {
    if (V.model) return;
    V.loading = V.loading || (async () => { await tf.ready(); V.model = await tf.loadGraphModel(MODEL_URL); tf.tidy(() => V.model.execute(tf.zeros([1, 224, 224, 3]), NODE)); })();
    await V.loading;
  }
  async function loadSamples(force) {
    if (V.loaded && !force) return;
    const rows = await guard(sb.from("vision_samples").select("class_key,item_id,emb").eq("active", true).limit(4000));
    const mine = rows.filter(r => r.emb.startsWith(TAG) && r.class_key !== "empty");
    V.old = rows.length - mine.length; V.samples = mine.map(r => ({ key: r.class_key, item: r.item_id, raw: decode(r.emb) })); V.loaded = true; rebuild();
  }
  const crop = document.createElement("canvas"); crop.width = crop.height = 224;
  function drawCrop(video, box, k) {   // square crop around the part, rotated k quarter turns, into a 224 x 224 canvas
    const sx = video.videoWidth / V.aw, cx = (box.x0 + box.x1 + 1) / 2 * sx, cy = (box.y0 + box.y1 + 1) / 2 * sx;
    let side = Math.max(box.x1 - box.x0 + 1, box.y1 - box.y0 + 1) * sx * PAD; side = Math.min(Math.max(side, 80), Math.min(video.videoWidth, video.videoHeight));
    const x = Math.min(Math.max(cx - side / 2, 0), video.videoWidth - side), y = Math.min(Math.max(cy - side / 2, 0), video.videoHeight - side);
    const g = crop.getContext("2d"); g.save(); g.translate(112, 112); g.rotate(k * Math.PI / 2); g.drawImage(video, x, y, side, side, -112, -112, 224, 224); g.restore();
  }
  function embedCrop() {
    return tf.tidy(() => V.model.execute(tf.browser.fromPixels(crop).toFloat().div(127.5).sub(1).expandDims(0), NODE).flatten()).data();
  }
  async function startCamera(video, deviceId) {
    stopCamera();
    const c = { video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } : { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
    V.stream = await navigator.mediaDevices.getUserMedia(c); video.srcObject = V.stream; await video.play().catch(() => {});
    return V.stream;
  }
  function stopCamera() { if (V.stream) { V.stream.getTracks().forEach(t => t.stop()); V.stream = null; } }
  function stop() { V.view = null; V.running = false; clearTimeout(V.timer); stopCamera(); window.DetectUI?.stop(); }

  const itemName = k => { const i = state.citems.find(x => x.id === k); return i ? i.name + (i.spec ? " " + i.spec : "") : "Unknown item"; };
  const counts = () => { const c = {}; V.samples.forEach(s => c[s.key] = (c[s.key] || 0) + 1); return c; };

  /* ---------- shared camera panel ---------- */
  function camHtml() {
    return `<div class="vcam" id="vCamBox"><video id="vVid" playsinline muted autoplay></video><canvas id="vOv" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none"></canvas></div>
    <div style="display:flex;gap:12px;align-items:center;margin-top:12px"><canvas id="vSees" width="112" height="112" style="width:112px;height:112px;background:#000;border:2px solid var(--ink);flex:none"></canvas>
      <p class="hint" style="margin:0"><strong>What it sees.</strong> The tight picture of the part that it learns from and compares. It finds the part on its own, so just place it on the plain background.</p></div>
    <div class="row" style="margin-top:12px"><button class="btn" id="vBg">Learn the empty background</button><span class="status-line" id="vBgSt" style="margin:0">Take everything out of view first.</span></div>
    <div class="row" style="margin-top:12px"><div class="field"><label for="vCam">Camera</label><select id="vCam" class="sel"></select></div>
      <div class="field"><label for="vThr">Part detection (more sensitive on the left)</label><input id="vThr" type="range" min="10" max="70" step="2" value="${V.thr}"></div></div>`;
  }
  const bgOk = () => !!V.bg;
  function paintBg() { const s = $("#vBgSt"); if (!s) return; s.className = "status-line " + (bgOk() ? "ok" : "err"); s.style.margin = "0"; s.textContent = bgOk() ? "Background learned." : "Background not learned yet. Take everything out of view, then press the button."; }
  async function setupCamera(statusEl, me) {
    const v = $("#vVid"), sel = $("#vCam"), stale = () => V.view !== me;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot use the camera here. Open the site with https:// in Chrome, Edge or Safari.");
      let saved = null; try { saved = localStorage.getItem("v_cam"); } catch (e) {}
      await startCamera(v, saved || null); if (stale()) return false;
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput"), cur = V.stream?.getVideoTracks()[0]?.getSettings().deviceId; if (stale()) return false;
      sel.innerHTML = devs.map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? "selected" : ""}>${esc(d.label || "Camera " + (i + 1))}</option>`).join("");
      sel.onchange = async () => { try { localStorage.setItem("v_cam", sel.value); } catch (e) {} V.bg = null; await startCamera(v, sel.value); paintBg(); };
      $("#vThr").oninput = e => { V.thr = Number(e.target.value); try { localStorage.setItem("v_thr", V.thr); } catch (x) {} };
      const fit = () => { if (v.videoWidth) $("#vCamBox").style.aspectRatio = v.videoWidth + " / " + v.videoHeight; }; v.onloadedmetadata = fit; fit();
      $("#vBg").onclick = async () => { const b = $("#vBg"); b.disabled = true; await learnBackground(v); b.disabled = false; V.absent = 99; paintBg(); };
      paintBg(); return true;
    } catch (e) { statusEl.className = "status-line err"; statusEl.textContent = e.name === "NotAllowedError" ? "Camera permission was blocked. Allow the camera for this site, then reload." : (e.message || String(e)); return false; }
  }
  function overlay(res, color) {
    const o = $("#vOv"); if (!o) return; if (o.width !== V.aw) { o.width = V.aw; o.height = V.ah; } const g = o.getContext("2d"); g.clearRect(0, 0, o.width, o.height);
    if (res) { g.strokeStyle = color || "#F2C200"; g.lineWidth = 2; g.strokeRect(res.box.x0, res.box.y0, res.box.x1 - res.box.x0 + 1, res.box.y1 - res.box.y0 + 1); }
  }
  function preview() { const c = $("#vSees"); if (c) c.getContext("2d").drawImage(crop, 0, 0, c.width, c.height); }

  /* ---------- Identify ---------- */
  async function identify() {
    stop(); const me = V.view = {};
    $("#main").innerHTML = `<div class="summary"><div><h1>Identify</h1><p>Place one fastener at a time on the plain background. It finds the part, names it and records it.</p></div></div>
      <div class="grid2"><div class="panel">${camHtml()}</div>
      <div class="panel"><h2>Seen now</h2><div class="bigcount" id="vLabel" style="font-size:44px">...</div><p class="status-line" id="vStatus">Loading the recogniser...</p><p class="hint" id="vScores"></p>
        <div class="row" style="margin-top:12px"><div class="field"><label for="vAct">When it sees a fastener</label><select id="vAct" class="sel"><option value="0">Just log it</option><option value="1">Add 1 to stock</option><option value="-1">Take 1 from stock</option></select></div></div>
        <label style="margin-top:12px;display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="vRec" ${V.record ? "checked" : ""}> Record what it sees</label>
        <p class="hint" id="vNote"></p>
        <details style="margin-top:8px"><summary style="cursor:pointer;font-weight:600">Advanced</summary><div class="field" style="margin-top:8px"><label for="vUnk">Call it "unknown" below this match score</label><input id="vUnk" type="range" min="0" max="60" step="2" value="${Math.round(V.unknownT * 100)}"><p class="hint">Higher is stricter. Now ${V.unknownT.toFixed(2)}. Watch the score in the line above.</p></div></details>
        <p class="hint">Recogniser version ${VERSION}</p></div></div>
      <section class="block"><h2>This session</h2><div id="vTally"></div></section>`;
    $("#vAct").value = String(V.action); $("#vAct").onchange = e => { V.action = Number(e.target.value); };
    $("#vRec").onchange = e => { V.record = e.target.checked; paintNote(); };
    $("#vUnk").oninput = e => { V.unknownT = Number(e.target.value) / 100; try { localStorage.setItem("v_unk", V.unknownT); } catch (x) {} e.target.nextElementSibling.textContent = "Higher is stricter. Now " + V.unknownT.toFixed(2) + ". Watch the score in the line above."; };
    const st = $("#vStatus"); paintNote(); paintTally();
    if (!(await setupCamera(st, me))) return; if (V.view !== me) { if (!V.view) stopCamera(); return; }
    try { await Promise.all([ensureModel(), loadSamples(true)]); } catch (e) { if (V.view === me) { st.className = "status-line err"; st.textContent = "Could not load the recogniser: " + (e.message || e); } return; }
    if (V.view !== me) { stopCamera(); return; }
    const n = Object.keys(counts()).length;
    if (n < 2) {
      st.className = "status-line err"; st.innerHTML = `<strong>It needs to learn at least two different fasteners</strong> so it can tell them apart. ${n} trained so far.${V.old ? ` (${V.old} older samples from the previous version are ignored. Retrain on the Train tab.)` : ""}<br><button class="btn" style="margin-top:8px" id="vGoTrain">Go to Train</button>`;
      const g = $("#vGoTrain"); if (g) g.onclick = () => setTab("train");
    } else { st.className = "status-line"; st.textContent = bgOk() ? "Ready." : "Press \"Learn the empty background\" first, with nothing in view."; }
    V.running = true; V.absent = 99; V.armed = true; V.lastKey = null; V.streak = 0; loop(me);
  }
  function paintNote() {
    const n = $("#vNote"); if (!n) return;
    n.textContent = !V.record ? "Recording is off. It only shows what it sees." : state.user ? "Recording as " + (state.user.name || "you") + ". Each fastener is saved to the Log." : "Sign in (top right) to record. Until then it only shows what it sees.";
  }
  function paintTally() {
    const t = $("#vTally"); if (!t) return; const e = Object.entries(V.tally);
    t.innerHTML = e.length ? `<ul class="log">${e.map(([k, n]) => `<li><div class="t">${n}</div><div class="what">${esc(itemName(k))}</div></li>`).join("")}</ul><p class="hint">${V.recent.slice(0, 5).map(r => esc(r)).join(" &middot; ")}</p>` : `<div class="empty"><p>Nothing seen yet.</p></div>`;
  }
  function setLabel(text, dim) { const L = $("#vLabel"); if (L) { L.textContent = text; L.style.opacity = dim ? .45 : 1; } }
  async function loop(me) {
    if (!V.running || V.view !== me) return;
    try {
      const v = $("#vVid"), st = $("#vStatus"), sc = $("#vScores");
      if (v && v.readyState >= 2 && V.model) {
        const im = grab(v);
        if (im && bgOk() && V.centered) {
          const res = detect(im);
          if (!res) {   // nothing on the background
            overlay(null); V.absent++; setLabel("Nothing in view", true); if (sc) sc.textContent = "";
            if (V.absent >= ABSENT) { V.armed = true; V.lastKey = null; V.streak = 0; }
            if (V.absent >= 10) for (let j = 0; j < V.bg.length; j++) V.bg[j] = V.bg[j] * 0.97 + im.data[j] * 0.03;   // follow slow lighting changes
          } else if (res.big) { overlay(res, "#E5795F"); V.absent = 0; V.streak = 0; setLabel("Large object", true); if (sc) sc.textContent = "Something large is in view (a hand?). Waiting for a single part."; }
          else {
            V.absent = 0; overlay(res); drawCrop(v, res.box, 0); preview(); const p = predict(await embedCrop());
            if (p && V.view === me) {
              const known = p.score >= V.unknownT && p.conf >= 0.7;
              setLabel(known ? itemName(p.key) : "Unknown part", !known);
              if (st && !st.classList.contains("err")) st.textContent = known ? Math.round(p.conf * 100) + "% sure" : "Closest: " + itemName(p.key) + " (match score " + p.score.toFixed(2) + ")";
              if (sc) sc.textContent = p.ranks.map(r => itemName(r.key) + " " + Math.round(Math.exp(20 * (r.s - p.ranks[0].s)) / p.den * 100) + "% (score " + r.s.toFixed(2) + ")").join("  |  ") + "  (" + V.fps + " frames/s)";
              step(known ? p.key : null, p.conf);
            }
          }
        } else if (st && im && !st.classList.contains("err") && !bgOk()) { st.textContent = 'Press "Learn the empty background" first, with nothing in view.'; }
        V.frames++; const now = Date.now(); if (!V.t0 || now - V.t0 > 2000) { V.fps = V.t0 ? Math.round(V.frames / ((now - V.t0) / 1000) * 10) / 10 : 0; V.t0 = now; V.frames = 0; }
      }
    } catch (e) { const st = $("#vStatus"); if (st) { st.className = "status-line err"; st.textContent = "Recogniser error: " + (e.message || e); } }
    V.timer = setTimeout(() => loop(me), 80);
  }
  function step(key, conf) {
    if (!key) { V.streak = 0; return; }
    if (key === V.lastKey) V.streak++; else { V.lastKey = key; V.streak = 1; }
    if (V.streak >= STREAK && V.armed) { V.armed = false; fire(key, conf); }
  }
  async function fire(key, conf) {
    V.tally[key] = (V.tally[key] || 0) + 1; V.recent.unshift(itemName(key) + " " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })); V.recent.length = Math.min(V.recent.length, 20);
    paintTally(); if (navigator.vibrate) navigator.vibrate(40);
    if (!V.record || !state.token) return;
    try { await guard(rpcAuth("toolscale_vision_log", { p_item: key, p_score: Math.round(conf * 1000) / 1000, p_delta: V.action, p_note: "Seen by camera" })); refreshAll(); } catch (e) {}
  }

  /* ---------- Train ---------- */
  async function train() {
    stop(); const me = V.view = {}; const items = state.citems;
    $("#main").innerHTML = `<div class="summary"><div><h1>Train</h1><p>Show it each fastener so it learns what it looks like. About a minute per type.</p></div></div>
      <div class="grid2"><div class="panel">${camHtml()}</div>
      <div class="panel"><h2>1. Learn the background</h2><p>Take everything out of view and press <em>Learn the empty background</em>. Use a plain, matte background in steady light.</p>
        <h2 style="margin-top:16px">2. Pick what you are showing</h2><div class="field"><label for="tCls">Fastener</label><select id="tCls" class="sel">${items.map(i => `<option value="${i.id}">${esc(i.name)}${i.spec ? " (" + esc(i.spec) + ")" : ""}</option>`).join("")}</select></div>
        ${items.length ? "" : `<p class="hint">No fasteners yet. Add them on the Consumables page (Items tab), then come back.</p>`}
        <h2 style="margin-top:16px">3. Capture</h2><p>Put one part on the background, press the button, then slowly turn it and move it a little.</p>
        <button class="btn" id="tCap">Capture 10 pictures</button><p class="status-line" id="vStatus"></p></div></div>
      <section class="block"><h2>What it has learned</h2><div id="tCounts"></div></section>
      <details class="panel" style="margin-top:24px"><summary style="cursor:pointer;font-weight:600">Tips for good recognition</summary><ul>
        <li>The yellow box on the video is the part it found. If there is no box, make the detection more sensitive (slider to the left) or check the background.</li>
        <li>Each press takes 10 pictures and stores each one in 4 rotations, so how the part is turned does not matter.</li>
        <li>Teach at least two different fasteners. Capture 3 or more times per fastener, with the part lying differently each time (on its side, upright, head up).</li>
        <li>Types that look alike (hex head and socket head screws) need more captures, including from the side, where the head shape shows.</li>
        <li>Sizes that differ only by length are hard to tell by camera. Use the scale weight for that.</li></ul></details>`;
    $("#tCls").value = V.cls && items.some(i => i.id === V.cls) ? V.cls : (items[0]?.id || ""); $("#tCls").onchange = e => { V.cls = e.target.value; };
    const st = $("#vStatus"); if (!(await setupCamera(st, me))) return; if (V.view !== me) { if (!V.view) stopCamera(); return; }
    try { st.textContent = "Loading the recogniser..."; await Promise.all([ensureModel(), loadSamples(true)]); if (V.view !== me) { stopCamera(); return; } st.textContent = ""; } catch (e) { if (V.view === me) { st.className = "status-line err"; st.textContent = "Could not load the recogniser: " + (e.message || e); } return; }
    paintCounts(); V.running = true; liveBox(me);
    $("#tCap").onclick = () => requireAuth(capture);
  }
  async function liveBox(me) {   // shows the box around the part while training
    while (V.view === me) {
      try {
        const v = $("#vVid");
        if (v && v.readyState >= 2 && V.model && !V.capturing) { const im = grab(v); if (im && bgOk()) { const res = detect(im); V.last = res && !res.big ? res : null; overlay(res, res?.big ? "#E5795F" : "#F2C200"); if (V.last) { drawCrop(v, V.last.box, 0); preview(); } } }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 150));
    }
  }
  function paintCounts() {
    const t = $("#tCounts"); if (!t) return; const c = counts(), items = state.citems;
    const nTrained = items.filter(i => c[i.id]).length;
    t.innerHTML = (nTrained < 2 ? `<div class="banner info"><span><strong>To finish:</strong> teach at least two different fasteners, then open the Identify tab.</span></div>` : `<div class="banner info" style="border-color:var(--ok)"><span><strong>Ready.</strong> Open the Identify tab to try it.</span></div>`)
      + (V.old ? `<div class="banner"><span>${V.old} samples from the previous version are ignored because they were taken a different way.</span><button class="btn sec" id="tOld">Delete them</button></div>` : "")
      + `<ul class="log">${items.map(i => `<li><div class="t num">${c[i.id] || 0}</div><div><div class="what">${esc(itemName(i.id))}</div><div class="note">${(c[i.id] || 0) >= 120 ? "Good" : (c[i.id] || 0) ? "Add more captures (3 or more, laid differently)" : "Not trained"}</div>
      ${c[i.id] ? `<button class="btn sec" style="margin-top:6px" data-vclear="${i.id}">Clear</button>` : ""}</div></li>`).join("")}</ul>`;
    t.querySelectorAll("[data-vclear]").forEach(b => b.onclick = () => requireAuth(async () => {
      if (!confirm("Clear everything it learned about " + itemName(b.dataset.vclear) + "?")) return;
      try { await guard(rpcAuth("toolscale_vision_clear_class", { p_class: b.dataset.vclear })); await loadSamples(true); paintCounts(); } catch (e) {} }));
    const o = $("#tOld"); if (o) o.onclick = () => requireAuth(async () => { try { await guard(rpcAuth("toolscale_vision_clear_old", {})); await loadSamples(true); paintCounts(); } catch (e) {} });
  }
  async function capture() {
    const v = $("#vVid"), st = $("#vStatus"), btn = $("#tCap"); if (!V.model || !v || v.readyState < 2) return;
    if (!bgOk()) { st.className = "status-line err"; st.textContent = 'First press "Learn the empty background" with nothing in view.'; return; }
    const cls = $("#tCls").value; if (!cls) { st.className = "status-line err"; st.textContent = "Pick a fastener first."; return; }
    V.cls = cls; btn.disabled = true; V.capturing = true; const embs = [], fresh = []; let got = 0, tries = 0;
    while (got < 10 && tries < 40) {
      tries++; st.className = "status-line"; st.textContent = `Capturing ${got + 1} of 10...`;
      const im = grab(v), res = im && detect(im);
      if (!res || res.big) { st.textContent = res?.big ? "Something large is in view. Keep your hand out." : "I cannot see the part. Place it on the background."; await new Promise(r => setTimeout(r, 250)); continue; }
      overlay(res);
      for (let k = 0; k < 4; k++) { drawCrop(v, res.box, k); const raw = await embedCrop(); embs.push(encode(raw)); fresh.push({ key: cls, item: cls, raw }); }
      preview(); got++; await new Promise(r => setTimeout(r, 250));
    }
    V.capturing = false;
    if (got < 10) { st.className = "status-line err"; st.textContent = got ? `Only ${got} pictures had a part in view. Nothing was saved. Try again.` : "I could not find the part. Check the background and the sensitivity."; btn.disabled = false; return; }
    try {
      await guard(rpcAuth("toolscale_vision_add_samples", { p_class: cls, p_item: cls, p_embs: embs }));
      V.samples.push(...fresh); rebuild(); st.className = "status-line ok"; st.textContent = "Saved 10 pictures of " + itemName(cls) + " (40 samples with rotations)."; paintCounts();
    } catch (e) { st.className = "status-line err"; st.textContent = "Could not save: " + (e.message || e); }
    btn.disabled = false;
  }

  /* ---------- Log ---------- */
  async function vlog() {
    stop(); $("#main").innerHTML = `<div class="summary"><div><h1>Log</h1><p>Every fastener the camera recorded, newest first.</p></div></div><div id="vlogBody"></div>`;
    try {
      const rows = await guard(sb.from("vision_events").select("*").order("id", { ascending: false }).limit(100));
      $("#vlogBody").innerHTML = rows.length ? `<ul class="log">${rows.map(r => `<li><div class="t">${esc(when(r.ts))}</div><div><div class="what">${esc(r.item_name || "")}${r.delta ? " (" + (r.delta > 0 ? "+1 stock" : "-1 stock") + ")" : ""}</div>
        <div class="note">${r.score != null ? Math.round(Number(r.score) * 100) + "% sure" : esc(r.note || "")}${r.person ? " &middot; " + esc(r.person) : ""}</div></div></li>`).join("")}</ul>` : `<div class="empty"><p>Nothing recorded yet.</p></div>`;
    } catch (e) {}
  }

  window.VisionUI = { identify, train, vlog, stop, _t: { V, rebuild, predict, step, encode, decode, findPart } };   // _t is for tests
})();
