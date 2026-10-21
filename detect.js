/* Vision: multi-object detection (many fasteners in one picture).
   Label  - capture camera pictures, draw a box around each fastener, save them, and export a YOLO training dataset (.zip).
   Detect - runs your trained YOLO model (ONNX, from models/fasteners.onnx) in the browser and counts every fastener in view.
   Training happens outside the browser, once, in the Colab notebook in training/. Loaded on demand by index.html, which provides:
   state, $, esc, when, toast, guard, rpcAuth, requireAuth, refreshAll, setTab, sb. */
(function () {
  const ORT_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/ort.min.js";
  const ORT_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/";
  const ZIP_URL = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
  const MODEL = "models/fasteners.onnx", CLASSES = "models/classes.json";
  const COLORS = ["#F2C200", "#2FB36D", "#E5795F", "#4FA3E0", "#B07CE8", "#E88FB4", "#7FD3C7", "#C9A66B"];
  const D = { view: null, stream: null, running: false, timer: null, session: null, meta: null, conf: 0.35, iou: 0.5, hist: [], counts: {}, fps: 0, frames: 0, t0: 0,
    frozen: null, boxes: [], cls: null, drag: null, mode: "log", busy: false, bg: null, bw: 0, bh: 0 };
  try { const c = Number(localStorage.getItem("d_conf")); if (c >= 0.05 && c <= 0.95) D.conf = c; } catch (e) {}

  const loadScript = src => new Promise((res, rej) => { const el = document.createElement("script"); el.src = src; el.onload = res; el.onerror = () => rej(new Error("Could not load " + src)); document.head.appendChild(el); });
  const items = () => [...state.citems].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
  const nameOf = id => { const i = state.citems.find(x => x.id === id); return i ? i.name + (i.spec ? " " + i.spec : "") : "Unknown"; };
  const colorOf = idx => COLORS[idx % COLORS.length];

  /* ---------- camera ---------- */
  async function startCamera(video) {
    stopCamera(); let saved = null; try { saved = localStorage.getItem("v_cam"); } catch (e) {}
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot use the camera here. Open the site with https:// in Chrome, Edge or Safari.");
    const c = { video: saved ? { deviceId: { exact: saved }, width: { ideal: 1280 }, height: { ideal: 720 } } : { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
    D.stream = await navigator.mediaDevices.getUserMedia(c); video.srcObject = D.stream; await video.play().catch(() => {});
    const fit = () => { const b = $("#dBox"); if (b && video.videoWidth) b.style.aspectRatio = video.videoWidth + " / " + video.videoHeight; }; video.onloadedmetadata = fit; fit();
  }
  function stopCamera() { if (D.stream) { D.stream.getTracks().forEach(t => t.stop()); D.stream = null; } }
  function stop() { D.view = null; D.running = false; clearTimeout(D.timer); stopCamera(); }
  const camErr = (e) => e.name === "NotAllowedError" ? "Camera permission was blocked. Allow the camera for this site, then reload." : (e.message || String(e));

  /* ---------- the empty background (so boxes on an unchanged scene are ignored) ---------- */
  const sc = document.createElement("canvas"), FG_THR = 28, FG_MIN = 0.15, MAX_FRAC = 0.35;
  function grabSmall(v) { const w = 320, h = Math.round(320 * v.videoHeight / v.videoWidth); if (sc.width !== w || sc.height !== h) { sc.width = w; sc.height = h; } const g = sc.getContext("2d", { willReadFrequently: true }); g.drawImage(v, 0, 0, w, h); return g.getImageData(0, 0, w, h); }
  async function learnBg(v) {
    let acc = null; for (let i = 0; i < 8; i++) { const im = grabSmall(v); if (!acc) acc = new Float32Array(im.data.length); for (let j = 0; j < im.data.length; j++) acc[j] += im.data[j]; await new Promise(r => setTimeout(r, 90)); }
    for (let j = 0; j < acc.length; j++) acc[j] /= 8; D.bg = acc; D.bw = sc.width; D.bh = sc.height;
  }
  /* integral image of "this pixel differs from the learned empty background", so any box can be checked in one lookup */
  function fgIntegral(im) {
    const w = D.bw, h = D.bh, d = im.data, bg = D.bg; let ox = 0, oy = 0, oz = 0, on = 0;
    for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) { if (x < w * 0.08 || x > w * 0.92 || y < h * 0.08 || y > h * 0.92) { const i = (y * w + x) * 4; ox += d[i] - bg[i]; oy += d[i + 1] - bg[i + 1]; oz += d[i + 2] - bg[i + 2]; on++; } }
    ox /= on || 1; oy /= on || 1; oz /= on || 1;
    const I = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, e = (Math.abs(d[i] - bg[i] - ox) + Math.abs(d[i + 1] - bg[i + 1] - oy) + Math.abs(d[i + 2] - bg[i + 2] - oz)) / 3; row += e > FG_THR ? 1 : 0; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; } }
    return I;
  }
  function fgFrac(I, b, vw, vh) {
    const w = D.bw, h = D.bh, sx = w / vw, sy = h / vh, x0 = Math.max(0, Math.floor(b.x0 * sx)), y0 = Math.max(0, Math.floor(b.y0 * sy)), x1 = Math.min(w, Math.ceil(b.x1 * sx)), y1 = Math.min(h, Math.ceil(b.y1 * sy));
    const area = (x1 - x0) * (y1 - y0); if (area <= 0) return 0; const W = w + 1;
    return (I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0]) / area;
  }
  function tidy(boxes, vw, vh) {   // drop whole-picture boxes, and let one fastener have only one box whatever its class
    const small = boxes.filter(b => (b.x1 - b.x0) * (b.y1 - b.y0) < MAX_FRAC * vw * vh); small.sort((a, b) => b.s - a.s); const keep = [];
    for (const b of small) { if (keep.every(k => iouOf(k, b) < 0.6)) keep.push(b); if (keep.length >= 150) break; }
    return keep;
  }

  /* ---------- Detect ---------- */
  async function ensureOrt() { if (!window.ort) await loadScript(ORT_URL); ort.env.wasm.wasmPaths = ORT_BASE; ort.env.wasm.numThreads = 1; }
  async function loadModel() {
    if (D.session) return true;
    const r = await fetch(CLASSES, { cache: "no-store" }); if (!r.ok) return false;
    D.meta = await r.json(); await ensureOrt();
    const url = MODEL + "?v=" + (D.meta.version || 1), eps = navigator.gpu ? [["webgpu"], ["wasm"]] : [["wasm"]];
    for (const ep of eps) { try { D.session = await ort.InferenceSession.create(url, { executionProviders: ep, graphOptimizationLevel: "all" }); D.ep = ep[0]; break; } catch (e) { D.err = e; } }
    if (!D.session) throw D.err || new Error("Could not start the model.");
    return true;
  }
  const lb = document.createElement("canvas");
  function prep(video, sz) {   // letterbox the camera picture into sz x sz and turn it into a model input
    lb.width = lb.height = sz; const g = lb.getContext("2d", { willReadFrequently: true }); g.fillStyle = "rgb(114,114,114)"; g.fillRect(0, 0, sz, sz);
    const sc = Math.min(sz / video.videoWidth, sz / video.videoHeight), nw = Math.round(video.videoWidth * sc), nh = Math.round(video.videoHeight * sc), px = Math.floor((sz - nw) / 2), py = Math.floor((sz - nh) / 2);
    g.drawImage(video, px, py, nw, nh); const d = g.getImageData(0, 0, sz, sz).data, n = sz * sz, f = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) { f[i] = d[i * 4] / 255; f[n + i] = d[i * 4 + 1] / 255; f[2 * n + i] = d[i * 4 + 2] / 255; }
    return { tensor: new ort.Tensor("float32", f, [1, 3, sz, sz]), sc, px, py };
  }
  /* YOLOv8/11 output: [1, 4 + classes, anchors] (or transposed). Returns boxes in camera pixels. */
  function decode(out, nc, conf, iou, sc, px, py, vw, vh) {
    const dims = out.dims, data = out.data; let nA, cols, byRow;   // byRow: [anchors, 4+nc]
    if (dims[1] === 4 + nc) { cols = dims[1]; nA = dims[2]; byRow = false; } else { cols = dims[2]; nA = dims[1]; byRow = true; }
    const at = (a, k) => byRow ? data[a * cols + k] : data[k * nA + a], found = [];
    for (let a = 0; a < nA; a++) {
      let best = -1, bs = 0; for (let c = 0; c < nc; c++) { const s = at(a, 4 + c); if (s > bs) { bs = s; best = c; } }
      if (bs < conf) continue;
      const cx = at(a, 0), cy = at(a, 1), w = at(a, 2), h = at(a, 3);
      found.push({ c: best, s: bs, x0: Math.max(0, (cx - w / 2 - px) / sc), y0: Math.max(0, (cy - h / 2 - py) / sc), x1: Math.min(vw, (cx + w / 2 - px) / sc), y1: Math.min(vh, (cy + h / 2 - py) / sc) });
    }
    return nms(found, iou);
  }
  function nms(boxes, thr) {
    boxes.sort((a, b) => b.s - a.s); const keep = [];
    for (const b of boxes) { let ok = true; for (const k of keep) { if (k.c !== b.c) continue; if (iouOf(k, b) > thr) { ok = false; break; } } if (ok) keep.push(b); }
    return keep;
  }
  function iouOf(a, b) { const x0 = Math.max(a.x0, b.x0), y0 = Math.max(a.y0, b.y0), x1 = Math.min(a.x1, b.x1), y1 = Math.min(a.y1, b.y1), i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0); const u = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - i; return u > 0 ? i / u : 0; }

  async function detect() {
    stop(); window.VisionUI?.stop(); const me = D.view = {};
    $("#main").innerHTML = `<div class="summary"><div><h1>Detect</h1><p>Spread the fasteners out so they do not touch. It finds and counts every one in the picture.</p></div></div>
      <div class="grid2"><div class="panel"><div class="vcam" id="dBox"><video id="dVid" playsinline muted autoplay></video><canvas id="dOv" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none"></canvas></div>
        <div class="field" style="margin-top:12px"><label for="dConf">Confidence needed (higher is stricter): <span id="dConfV">${Math.round(D.conf * 100)}%</span></label><input id="dConf" type="range" min="10" max="90" step="5" value="${Math.round(D.conf * 100)}"></div>
        <div class="row" style="margin-top:12px"><button class="btn sec" id="dBg">Learn the empty background</button><span class="hint" id="dBgSt" style="margin:0">Take everything out of view, then press. Anything that has not changed from the empty scene is then ignored.</span></div>
        <p class="status-line" id="dStatus">Loading the detector...</p></div>
      <div class="panel"><h2>In view now</h2><div id="dCounts"><p class="hint">Nothing yet.</p></div>
        <div class="row" style="margin-top:12px"><div class="field"><label for="dMode">Record the count as</label><select id="dMode" class="sel"><option value="log">Just log it</option><option value="set">The stock on hand</option><option value="add">Add to stock</option><option value="take">Take from stock</option></select></div></div>
        <div class="row" style="margin-top:12px"><button class="btn" id="dRec">Record this count</button></div><p class="hint" id="dNote"></p></div></div>`;
    $("#dMode").value = D.mode; $("#dMode").onchange = e => { D.mode = e.target.value; };
    $("#dConf").oninput = e => { D.conf = Number(e.target.value) / 100; $("#dConfV").textContent = e.target.value + "%"; try { localStorage.setItem("d_conf", D.conf); } catch (x) {} };
    $("#dRec").onclick = () => requireAuth(record);
    $("#dBg").onclick = async () => { const v = $("#dVid"), b = $("#dBg"); if (!v || !v.videoWidth) return; b.disabled = true; await learnBg(v); b.disabled = false; const t = $("#dBgSt"); if (t) { t.className = "status-line ok"; t.style.margin = "0"; t.textContent = "Background learned. Boxes on an unchanged scene are ignored."; } };
    $("#dNote").textContent = state.user ? "" : "Sign in (top right) to record counts.";
    const st = $("#dStatus");
    try { await startCamera($("#dVid")); } catch (e) { st.className = "status-line err"; st.textContent = camErr(e); return; }
    if (D.view !== me) { if (!D.view) stopCamera(); return; }
    try {
      if (!(await loadModel())) { st.className = "status-line err"; st.innerHTML = `<strong>There is no trained detector yet.</strong> Label pictures on the <em>Label</em> tab, export the dataset, train it with the Colab notebook, then upload <code>fasteners.onnx</code> and <code>classes.json</code> into the <code>models</code> folder of your repo.<br><button class="btn" style="margin-top:8px" id="dGo">Go to Label</button>`; const g = $("#dGo"); if (g) g.onclick = () => setTab("label"); return; }
    } catch (e) { if (D.view === me) { st.className = "status-line err"; st.textContent = "Could not start the detector: " + (e.message || e); } return; }
    if (D.view !== me) { stopCamera(); return; }
    st.className = "status-line"; st.textContent = "Running (" + D.ep + ")."; D.running = true; D.hist = []; loop(me);
  }
  async function loop(me) {
    if (!D.running || D.view !== me) return;
    try {
      const v = $("#dVid");
      if (v && v.readyState >= 2 && v.videoWidth && D.session) {
        const sz = D.meta.imgsz || 640, nc = D.meta.names.length, p = prep(v, sz), feeds = {}; feeds[D.session.inputNames[0]] = p.tensor;
        const res = await D.session.run(feeds), out = res[D.session.outputNames[0]];
        let boxes = tidy(decode(out, nc, D.conf, D.iou, p.sc, p.px, p.py, v.videoWidth, v.videoHeight), v.videoWidth, v.videoHeight);
        if (D.bg) { const im = grabSmall(v); if (im.width === D.bw && im.height === D.bh) { const I = fgIntegral(im); boxes = boxes.filter(b => fgFrac(I, b, v.videoWidth, v.videoHeight) >= FG_MIN); } }
        if (D.view === me) { draw(boxes, v); tally(boxes); }
        D.frames++; const now = Date.now(); if (!D.t0 || now - D.t0 > 2000) { D.fps = D.t0 ? Math.round(D.frames / ((now - D.t0) / 1000) * 10) / 10 : 0; D.t0 = now; D.frames = 0; const st = $("#dStatus"); if (st && !st.classList.contains("err")) st.textContent = "Running (" + D.ep + ", " + D.fps + " frames/s)."; }
      }
    } catch (e) { const st = $("#dStatus"); if (st) { st.className = "status-line err"; st.textContent = "Detector error: " + (e.message || e); } return; }
    D.timer = setTimeout(() => loop(me), 30);
  }
  function draw(boxes, v) {
    const o = $("#dOv"); if (!o) return; if (o.width !== v.videoWidth) { o.width = v.videoWidth; o.height = v.videoHeight; }
    const g = o.getContext("2d"); g.clearRect(0, 0, o.width, o.height); g.lineWidth = Math.max(2, o.width / 320); g.font = Math.max(12, o.width / 56) + "px sans-serif";
    for (const b of boxes) { const col = colorOf(b.c), nm = D.meta.names[b.c]?.name || "?"; g.strokeStyle = col; g.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
      const t = nm + " " + Math.round(b.s * 100) + "%", tw = g.measureText(t).width + 6; g.fillStyle = col; g.fillRect(b.x0, Math.max(0, b.y0 - 20), tw, 20); g.fillStyle = "#000"; g.fillText(t, b.x0 + 3, Math.max(14, b.y0 - 5)); }
  }
  function tally(boxes) {
    const c = {}; boxes.forEach(b => c[b.c] = (c[b.c] || 0) + 1); D.hist.push(c); if (D.hist.length > 7) D.hist.shift();
    const sm = {}; D.meta.names.forEach((n, i) => { const vals = D.hist.map(h => h[i] || 0).sort((a, b) => a - b); const m = vals[Math.floor(vals.length / 2)]; if (m) sm[i] = m; });   // median over the last frames steadies the count
    D.counts = sm; const el = $("#dCounts"); if (!el) return; const e = Object.entries(sm);
    el.innerHTML = e.length ? `<ul class="log">${e.map(([i, n]) => `<li><div class="t num" style="font:700 28px var(--display);color:${colorOf(Number(i))}">${n}</div><div class="what">${esc(D.meta.names[i].name)}</div></li>`).join("")}</ul><p class="hint">Total ${e.reduce((a, [, n]) => a + n, 0)}</p>` : `<p class="hint">Nothing in view.</p>`;
  }
  async function record() {
    const e = Object.entries(D.counts); if (!e.length) return toast("Nothing to record. Place fasteners in view first.");
    const btn = $("#dRec"); btn.disabled = true; let ok = 0;
    try {
      for (const [i, n] of e) { const id = D.meta.names[i].id; if (!state.citems.some(x => x.id === id)) continue; await guard(rpcAuth("toolscale_vision_record", { p_item: id, p_count: n, p_mode: D.mode })); ok++; }
      await refreshAll(); toast(ok ? "Recorded " + ok + " item type" + (ok > 1 ? "s" : "") : "None of these items exist any more.");
    } catch (err) {}
    btn.disabled = false;
  }

  /* ---------- Label ---------- */
  async function label() {
    stop(); window.VisionUI?.stop(); const me = D.view = {}; D.frozen = null; D.boxes = []; D.drag = null; const list = items();
    D.cls = D.cls && list.some(i => i.id === D.cls) ? D.cls : (list[0]?.id || null);
    $("#main").innerHTML = `<div class="summary"><div><h1>Label</h1><p>Build the training set. Capture a picture with several fasteners, draw a box around each one and choose its type. Boxes are what teach the detector.</p></div></div>
      <div class="grid2"><div class="panel"><div class="vcam" id="dBox"><video id="dVid" playsinline muted autoplay></video><canvas id="dFrozen" style="position:absolute;inset:0;width:100%;height:100%;display:none;touch-action:none;cursor:crosshair"></canvas></div>
        <div class="row" style="margin-top:12px"><button class="btn" id="dSnap">Capture a picture</button><button class="btn sec" id="dSave" style="display:none">Save picture</button><button class="btn sec" id="dDiscard" style="display:none">Discard</button></div>
        <p class="status-line" id="dStatus"></p></div>
      <div class="panel"><h2>Fastener type for the next box</h2>${list.length ? `<select id="dCls" class="sel">${list.map(i => `<option value="${i.id}">${esc(nameOf(i.id))}</option>`).join("")}</select>` : `<p class="hint">No fasteners yet. Add them on the Consumables page (Items tab), then come back.</p>`}
        <h2 style="margin-top:16px">Boxes in this picture</h2><div id="dBoxes"><p class="hint">Capture a picture, then drag on it to draw a box around each fastener.</p></div></div></div>
      <section class="block"><h2>Training set</h2><div id="dSet"><p class="hint">Loading...</p></div></section>
      <details class="panel" style="margin-top:24px"><summary style="cursor:pointer;font-weight:600">How to train the detector</summary><ol>
        <li>Capture pictures with 3 to 15 fasteners spread out, in different arrangements, on the background you will really use. Aim for <strong>30 or more boxes per type</strong> (100 is better), in 50 or more pictures.</li>
        <li>Include pictures with several different types together, and some with fasteners close but not touching.</li>
        <li>Press <strong>Export for training</strong>. You get a zip with the pictures and labels in the standard YOLO format.</li>
        <li>Open <code>training/train_fasteners.ipynb</code> from the repo in Google Colab (free GPU). Upload the zip and run the cells. It trains, shows the accuracy and a confusion matrix, and exports <code>fasteners.onnx</code> and <code>classes.json</code>.</li>
        <li>Upload both files into the <code>models</code> folder of your GitHub repo. Open the <em>Detect</em> tab. It loads the model and counts.</li></ol></details>`;
    const st = $("#dStatus");
    if (list.length) { $("#dCls").value = D.cls; $("#dCls").onchange = e => { D.cls = e.target.value; }; }
    try { await startCamera($("#dVid")); } catch (e) { st.className = "status-line err"; st.textContent = camErr(e); }
    if (D.view !== me) { if (!D.view) stopCamera(); return; }
    $("#dSnap").onclick = snap; $("#dDiscard").onclick = discard; $("#dSave").onclick = () => requireAuth(saveImage);
    bindDraw(); paintSet();
  }
  const snapCanvas = document.createElement("canvas");
  function snap() {
    const v = $("#dVid"), c = $("#dFrozen"); if (!v || !v.videoWidth) return;
    const sc = Math.min(1, 960 / v.videoWidth); c.width = snapCanvas.width = Math.round(v.videoWidth * sc); c.height = snapCanvas.height = Math.round(v.videoHeight * sc);
    snapCanvas.getContext("2d").drawImage(v, 0, 0, c.width, c.height); c.getContext("2d").drawImage(snapCanvas, 0, 0);   // snapCanvas stays clean for saving and for redrawing boxes
    D.frozen = true; D.boxes = []; c.style.display = "block"; v.style.visibility = "hidden";
    $("#dSnap").style.display = "none"; $("#dSave").style.display = ""; $("#dDiscard").style.display = ""; paintBoxes();
  }
  function discard() { D.frozen = null; D.boxes = []; const c = $("#dFrozen"); if (c) c.style.display = "none"; const v = $("#dVid"); if (v) v.style.visibility = ""; $("#dSnap").style.display = ""; $("#dSave").style.display = "none"; $("#dDiscard").style.display = "none"; paintBoxes(); }
  function bindDraw() {
    const c = $("#dFrozen"); if (!c) return;
    const pos = e => { const r = c.getBoundingClientRect(), t = e.touches?.[0] || e; return { x: Math.min(1, Math.max(0, (t.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (t.clientY - r.top) / r.height)) }; };
    const show = () => { const g = c.getContext("2d"); g.clearRect(0, 0, c.width, c.height); g.drawImage(snapCanvas, 0, 0); g.lineWidth = Math.max(2, c.width / 320); g.font = Math.max(12, c.width / 56) + "px sans-serif";
      const all = D.drag ? [...D.boxes, { ...D.drag, c: D.cls }] : D.boxes;
      all.forEach(b => { const idx = items().findIndex(i => i.id === b.c), col = colorOf(Math.max(0, idx)); g.strokeStyle = col; g.strokeRect(b.x0 * c.width, b.y0 * c.height, (b.x1 - b.x0) * c.width, (b.y1 - b.y0) * c.height); }); };
    D.showBoxes = show;
    const down = e => { if (!D.frozen || !D.cls) return; e.preventDefault(); const p = pos(e); D.drag = { sx: p.x, sy: p.y, x0: p.x, y0: p.y, x1: p.x, y1: p.y }; };
    const move = e => { if (!D.drag) return; e.preventDefault(); const p = pos(e); D.drag.x0 = Math.min(D.drag.sx, p.x); D.drag.x1 = Math.max(D.drag.sx, p.x); D.drag.y0 = Math.min(D.drag.sy, p.y); D.drag.y1 = Math.max(D.drag.sy, p.y); show(); };
    const up = () => { if (!D.drag) return; const d = D.drag; D.drag = null; if ((d.x1 - d.x0) * c.width > 6 && (d.y1 - d.y0) * c.height > 6) D.boxes.push({ c: D.cls, x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 }); show(); paintBoxes(); };
    c.addEventListener("mousedown", down); c.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    c.addEventListener("touchstart", down, { passive: false }); c.addEventListener("touchmove", move, { passive: false }); c.addEventListener("touchend", up);
  }
  function paintBoxes() {
    const el = $("#dBoxes"); if (!el) return; if (D.showBoxes && D.frozen) D.showBoxes(); const sv = $("#dSave"); if (sv) sv.textContent = D.boxes.length ? "Save picture" : "Save as empty picture";
    el.innerHTML = D.frozen ? (D.boxes.length ? `<ul class="log">${D.boxes.map((b, i) => `<li><div class="t">${i + 1}</div><div class="what">${esc(nameOf(b.c))}</div><div><button class="btn sec" data-rm="${i}">Remove</button></div></li>`).join("")}</ul>` : `<p class="hint">Drag on the picture to draw a box around each fastener. If there are no fasteners in the picture, save it with no boxes: it teaches the detector what "nothing here" looks like.</p>`) : `<p class="hint">Capture a picture, then drag on it to draw a box around each fastener.</p>`;
    el.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { D.boxes.splice(Number(b.dataset.rm), 1); paintBoxes(); });
  }
  async function saveImage() {
    const st = $("#dStatus"), c = snapCanvas; if (!D.frozen) return;
    const jpeg = c.toDataURL("image/jpeg", 0.85).split(",")[1], boxes = D.boxes.map(b => ({ c: b.c, x: round((b.x0 + b.x1) / 2), y: round((b.y0 + b.y1) / 2), w: round(b.x1 - b.x0), h: round(b.y1 - b.y0) }));
    $("#dSave").disabled = true;
    try { await guard(rpcAuth("toolscale_detect_save", { p_w: c.width, p_h: c.height, p_jpeg: jpeg, p_boxes: boxes })); st.className = "status-line ok"; st.textContent = "Saved with " + boxes.length + " box" + (boxes.length > 1 ? "es" : "") + "."; discard(); await paintSet(); }
    catch (e) { st.className = "status-line err"; st.textContent = "Could not save: " + (e.message || e); }
    const s = $("#dSave"); if (s) s.disabled = false;
  }
  const round = x => Math.round(x * 10000) / 10000;

  async function paintSet() {
    const el = $("#dSet"); if (!el) return;
    try {
      const rows = await guard(sb.from("detect_images").select("id,boxes,created_at,created_by").eq("active", true).order("created_at", { ascending: false }).limit(1000));
      const per = {}; let nb = 0; rows.forEach(r => (r.boxes || []).forEach(b => { per[b.c] = (per[b.c] || 0) + 1; nb++; }));
      const L = items();
      el.innerHTML = `<p>${rows.length} picture${rows.length === 1 ? "" : "s"}, ${nb} box${nb === 1 ? "" : "es"}, ${rows.filter(r => !(r.boxes || []).length).length} empty (no fasteners).</p>
        ${rows.filter(r => !(r.boxes || []).length).length < Math.max(3, Math.round(rows.length * 0.1)) ? `<p class="status-line err">Add some empty pictures (about 1 in 10): the plain background, a shadow, your hand, other objects, with no boxes. Without them the detector sees fasteners everywhere.</p>` : ""}
        ${rows.length < 40 ? `<p class="status-line err">Only ${rows.length} picture${rows.length === 1 ? "" : "s"}. Aim for 40 or more, with different screws and a new arrangement each time. Many different pictures teach more than a few pictures with many boxes, and the test score needs spare pictures to be meaningful.</p>` : ""}
        <ul class="log">${L.map(i => `<li><div class="t num">${per[i.id] || 0}</div><div><div class="what">${esc(nameOf(i.id))}</div><div class="note">${(per[i.id] || 0) >= 100 ? "Good" : (per[i.id] || 0) >= 30 ? "OK (100 is better)" : "Needs more (30 or more)"}</div></div></li>`).join("")}</ul>
        <div class="row" style="margin-top:12px"><button class="btn" id="dExport" ${rows.length ? "" : "disabled"}>Export for training (.zip)</button></div><p class="status-line" id="dExSt"></p>
        ${rows.length ? `<details style="margin-top:12px"><summary style="cursor:pointer">Recent pictures</summary><ul class="log">${rows.slice(0, 20).map(r => `<li><div class="t">${esc(when(r.created_at))}</div><div>${(r.boxes || []).length} boxes${r.created_by ? " &middot; " + esc(r.created_by) : ""} <button class="btn sec" style="margin-left:8px" data-rmimg="${r.id}">Remove</button></div></li>`).join("")}</ul></details>` : ""}`;
      const ex = $("#dExport"); if (ex) ex.onclick = exportZip;
      el.querySelectorAll("[data-rmimg]").forEach(b => b.onclick = () => requireAuth(async () => { if (!confirm("Remove this picture from the training set?")) return; try { await guard(rpcAuth("toolscale_detect_remove", { p_id: b.dataset.rmimg })); paintSet(); } catch (e) {} }));
    } catch (e) { el.innerHTML = `<p class="hint">Could not load the training set.</p>`; }
  }
  async function exportZip() {
    const st = $("#dExSt"), btn = $("#dExport"); btn.disabled = true; st.className = "status-line"; st.textContent = "Preparing...";
    try {
      if (!window.JSZip) await loadScript(ZIP_URL);
      const L = items(), idx = {}; L.forEach((i, n) => idx[i.id] = n);
      const ids = await guard(sb.from("detect_images").select("id").eq("active", true).order("created_at", { ascending: true }).limit(1000));
      const zip = new JSZip(); let n = 0, valN = 0;
      for (let s = 0; s < ids.length; s += 10) {
        const chunk = ids.slice(s, s + 10).map(r => r.id), rows = await guard(sb.from("detect_images").select("id,jpeg,boxes").in("id", chunk));
        for (const r of rows) {
          const val = parseInt(r.id.slice(-2), 16) % 5 === 0, split = val ? "val" : "train"; if (val) valN++;
          const lines = (r.boxes || []).filter(b => b.c in idx).map(b => `${idx[b.c]} ${b.x} ${b.y} ${b.w} ${b.h}`).join("\n");
          zip.file(`images/${split}/${r.id}.jpg`, r.jpeg, { base64: true }); zip.file(`labels/${split}/${r.id}.txt`, lines); n++;
        }
        st.textContent = `Preparing... ${Math.min(s + 10, ids.length)} of ${ids.length}`;
      }
      if (!valN && n) { const first = Object.keys(zip.files).find(f => /^images\/train\/.+\.jpg$/.test(f)); const id = first.split("/")[2].replace(".jpg", ""); zip.file(`images/val/${id}.jpg`, await zip.file(first).async("base64"), { base64: true }); zip.file(`labels/val/${id}.txt`, await zip.file(`labels/train/${id}.txt`).async("string")); }
      zip.file("data.yaml", `path: .\ntrain: images/train\nval: images/val\nnc: ${L.length}\nnames: [${L.map(i => JSON.stringify(nameOf(i.id))).join(", ")}]\n`);
      zip.file("classes.json", JSON.stringify({ version: Date.now(), imgsz: 640, names: L.map(i => ({ id: i.id, name: nameOf(i.id) })) }, null, 1));
      const blob = await zip.generateAsync({ type: "blob" }), a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "fastener-dataset.zip"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      st.className = "status-line ok"; st.textContent = `Exported ${n} pictures. Next: open training/train_fasteners.ipynb in Google Colab.`;
    } catch (e) { st.className = "status-line err"; st.textContent = "Export failed: " + (e.message || e); }
    btn.disabled = false;
  }

  window.DetectUI = { detect, label, stop, _t: { D, decode, nms, iouOf, fgIntegral, fgFrac, tidy } };   // _t is for tests
})();
