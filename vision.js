/* Vision mode: webcam fastener recognition that runs in the browser.
   MobileNet turns each camera frame into a 1280-number "fingerprint"; a nearest-neighbour check compares it with the
   samples you trained (stored in the shared database). No separate server and no model file to build.
   Loaded on demand by index.html, which also provides: state, $, esc, when, toast, guard, rpcAuth, requireAuth, refreshAll, sb. */
(function () {
  const MODEL_URL = "https://storage.googleapis.com/tfjs-models/savedmodel/mobilenet_v2_1.0_224/model.json";
  const NODE = "module_apply_default/MobilenetV2/Logits/AvgPool";   // the 1280-number feature layer
  const DIM = 1280, MIN_CONF = 0.8, STREAK = 4, KEEP_PER_CLASS = 80;
  const V = { model: null, loading: null, samples: [], loaded: false, stream: null, timer: null, running: false, roi: 0.6, cls: "empty",
    action: 0, record: true, tally: {}, lastKey: null, streak: 0, emptyStreak: 0, armed: true, recent: [], centered: null, mean: null, busy: false };
  try { const r = Number(localStorage.getItem("v_roi")); if (r >= 0.3 && r <= 1) V.roi = r; } catch (e) {}

  /* ---------- fingerprints ---------- */
  const b64 = u8 => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  function encode(vec) {   // float32 -> int8 -> base64 (about 1.7 KB per sample)
    let m = 0; for (const x of vec) m = Math.max(m, Math.abs(x)); const k = m ? 127 / m : 0, q = new Int8Array(vec.length);
    for (let i = 0; i < vec.length; i++) q[i] = Math.round(vec[i] * k);
    return b64(new Uint8Array(q.buffer));
  }
  function decode(s) { const bin = atob(s), u = new Int8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i) << 24 >> 24; return Float32Array.from(u); }
  function unit(v) { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map(x => x / n); }

  function rebuild() {   // centre the fingerprints so that "similar" really means similar, then group by class
    V.centered = null; if (!V.samples.length) return;
    const mean = new Float32Array(DIM); V.samples.forEach(s => { for (let i = 0; i < DIM; i++) mean[i] += s.raw[i]; }); for (let i = 0; i < DIM; i++) mean[i] /= V.samples.length;
    V.mean = mean; const by = {};
    V.samples.forEach(s => { const c = unit(s.raw.map((x, i) => x - mean[i])); (by[s.key] = by[s.key] || []).push(c); });
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
    return { key: scores[0].key, score: scores[0].s, conf: 1 / den, ranks: scores };
  }

  /* ---------- model and camera ---------- */
  async function ensureModel() {
    if (V.model) return;
    V.loading = V.loading || (async () => { await tf.ready(); V.model = await tf.loadGraphModel(MODEL_URL); tf.tidy(() => V.model.execute(tf.zeros([1, 224, 224, 3]), NODE)); })();
    await V.loading;
  }
  async function loadSamples(force) {
    if (V.loaded && !force) return;
    const rows = await guard(sb.from("vision_samples").select("class_key,item_id,emb").eq("active", true).limit(3000));
    V.samples = rows.map(r => ({ key: r.class_key, item: r.item_id, raw: decode(r.emb) })); V.loaded = true; rebuild();
  }
  function embed(video) {
    return tf.tidy(() => {
      const img = tf.browser.fromPixels(video), [h, w] = img.shape, side = Math.max(32, Math.round(V.roi * Math.min(h, w)));
      const y0 = Math.floor((h - side) / 2), x0 = Math.floor((w - side) / 2);
      const x = img.slice([y0, x0, 0], [side, side, 3]).resizeBilinear([224, 224]).toFloat().div(127.5).sub(1).expandDims(0);
      return V.model.execute(x, NODE).flatten();
    }).data();
  }
  async function startCamera(video, deviceId) {
    stopCamera();
    const c = { video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } : { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
    V.stream = await navigator.mediaDevices.getUserMedia(c); video.srcObject = V.stream; await video.play().catch(() => {});
    return V.stream;
  }
  function stopCamera() { if (V.stream) { V.stream.getTracks().forEach(t => t.stop()); V.stream = null; } }
  function stop() { V.view = null; V.running = false; clearTimeout(V.timer); stopCamera(); }

  const itemName = k => { if (k === "empty") return "Empty"; const i = state.citems.find(x => x.id === k); return i ? i.name + (i.spec ? " " + i.spec : "") : "Unknown item"; };
  const counts = () => { const c = {}; V.samples.forEach(s => c[s.key] = (c[s.key] || 0) + 1); return c; };

  /* ---------- shared camera panel ---------- */
  function camHtml() {
    return `<div class="vcam"><video id="vVid" playsinline muted autoplay></video><div class="vroi" id="vRoi"></div></div>
    <div class="row" style="margin-top:12px"><div class="field"><label for="vCam">Camera</label><select id="vCam" class="sel"></select></div>
      <div class="field"><label for="vRoiR">Look at the middle ${Math.round(V.roi * 100)}% of the picture</label><input id="vRoiR" type="range" min="30" max="100" step="5" value="${Math.round(V.roi * 100)}"></div></div>`;
  }
  function placeRoi() {
    const v = $("#vVid"), r = $("#vRoi"); if (!v || !r) return;
    const s = V.roi * Math.min(v.clientWidth, v.clientHeight); r.style.width = r.style.height = s + "px";
  }
  async function setupCamera(statusEl) {
    const v = $("#vVid"), sel = $("#vCam");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot use the camera here. Open the site with https:// in Chrome, Edge or Safari.");
      let saved = null; try { saved = localStorage.getItem("v_cam"); } catch (e) {}
      await startCamera(v, saved || null);
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
      const cur = V.stream.getVideoTracks()[0]?.getSettings().deviceId;
      sel.innerHTML = devs.map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? "selected" : ""}>${esc(d.label || "Camera " + (i + 1))}</option>`).join("");
      sel.onchange = async () => { try { localStorage.setItem("v_cam", sel.value); } catch (e) {} await startCamera(v, sel.value); placeRoi(); };
      $("#vRoiR").oninput = e => { V.roi = Number(e.target.value) / 100; try { localStorage.setItem("v_roi", V.roi); } catch (x) {} placeRoi(); e.target.previousElementSibling.textContent = `Look at the middle ${e.target.value}% of the picture`; };
      v.onloadedmetadata = placeRoi; window.onresize = placeRoi; setTimeout(placeRoi, 300); placeRoi();
      return true;
    } catch (e) {
      statusEl.className = "status-line err"; statusEl.textContent = e.name === "NotAllowedError" ? "Camera permission was blocked. Allow the camera for this site, then reload." : (e.message || String(e)); return false;
    }
  }

  /* ---------- Identify ---------- */
  async function identify() {
    stop(); const me = V.view = {};
    $("#main").innerHTML = `<div class="summary"><div><h1>Identify</h1><p>Drop one fastener at a time into the dashed square. It names the fastener and records it.</p></div></div>
      <div class="grid2"><div class="panel">${camHtml()}</div>
      <div class="panel"><h2>Seen now</h2><div class="bigcount" id="vLabel" style="font-size:44px">...</div><p class="status-line" id="vStatus">Loading the recogniser...</p>
        <div class="row" style="margin-top:12px"><div class="field"><label for="vAct">When it sees a fastener</label><select id="vAct" class="sel"><option value="0">Just log it</option><option value="1">Add 1 to stock</option><option value="-1">Take 1 from stock</option></select></div></div>
        <label style="margin-top:12px;display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="vRec" ${V.record ? "checked" : ""}> Record what it sees</label>
        <p class="hint" id="vNote"></p></div></div>
      <section class="block"><h2>This session</h2><div id="vTally"></div></section>`;
    $("#vAct").value = String(V.action); $("#vAct").onchange = e => { V.action = Number(e.target.value); };
    $("#vRec").onchange = e => { V.record = e.target.checked; paintNote(); };
    const st = $("#vStatus"); paintNote(); paintTally();
    if (!(await setupCamera(st))) return; if (V.view !== me) { if (!V.view) stopCamera(); return; }
    try { await Promise.all([ensureModel(), loadSamples(true)]); } catch (e) { if (V.view === me) { st.className = "status-line err"; st.textContent = "Could not load the recogniser: " + (e.message || e); } return; }
    if (V.view !== me) { stopCamera(); return; }
    const cs = counts(), fast = Object.keys(cs).filter(k => k !== "empty").length;
    if (!cs.empty || !fast) {
      st.className = "status-line err"; st.innerHTML = `<strong>It cannot name anything yet.</strong> It needs both of these on the Train tab:<br>
        ${cs.empty ? "&#10003;" : "&#10007;"} <strong>Empty</strong> (nothing in the square): ${cs.empty || 0} samples, needs 20<br>
        ${fast ? "&#10003;" : "&#10007;"} At least one fastener: ${fast} trained<br><button class="btn" style="margin-top:8px" id="vGoTrain">Go to Train</button>`;
      $("#vGoTrain").onclick = () => setTab("train");
    } else { st.className = "status-line"; st.textContent = "Ready."; }
    V.running = true; V.lastKey = null; V.streak = 0; V.emptyStreak = 0; V.armed = true; loop();
  }
  function paintNote() {
    const n = $("#vNote"); if (!n) return;
    n.textContent = !V.record ? "Recording is off. It only shows what it sees." : state.user ? "Recording as " + (state.user.name || "you") + ". Each fastener is saved to the History." : "Sign in (top right) to record. Until then it only shows what it sees.";
  }
  function paintTally() {
    const t = $("#vTally"); if (!t) return; const e = Object.entries(V.tally);
    t.innerHTML = e.length ? `<ul class="log">${e.map(([k, n]) => `<li><div class="t">${n}</div><div class="what">${esc(itemName(k))}</div></li>`).join("")}</ul><p class="hint">${V.recent.slice(0, 5).map(r => esc(r)).join(" &middot; ")}</p>` : `<div class="empty"><p>Nothing seen yet.</p></div>`;
  }
  async function loop() {
    if (!V.running) return;
    try {
      const v = $("#vVid"); if (v && v.readyState >= 2 && V.model) {
        const p = predict(await embed(v)), L = $("#vLabel"), st = $("#vStatus");
        if (p && L) {
          const ok = p.conf >= MIN_CONF; L.textContent = ok ? (p.key === "empty" ? "Nothing in view" : itemName(p.key)) : "Not sure"; L.style.opacity = ok ? 1 : .45;
          if (st && !st.classList.contains("err")) st.textContent = ok ? Math.round(p.conf * 100) + "% sure" : "Best guess: " + itemName(p.key) + " (" + Math.round(p.conf * 100) + "%)";
          step(ok ? p.key : null, p.conf);
        }
      }
    } catch (e) {}
    V.timer = setTimeout(loop, 120);
  }
  function step(key, conf) {
    if (key === "empty") { V.emptyStreak++; if (V.emptyStreak >= 3) { V.armed = true; V.lastKey = null; V.streak = 0; } return; }
    V.emptyStreak = 0; if (!key) { V.streak = 0; return; }
    if (key === V.lastKey) V.streak++; else { V.lastKey = key; V.streak = 1; if (V.armedFor && V.armedFor !== key) V.armed = true; }
    if (V.streak >= STREAK && V.armed) { V.armed = false; V.armedFor = key; fire(key, conf); }
  }
  async function fire(key, conf) {
    V.tally[key] = (V.tally[key] || 0) + 1; V.recent.unshift(itemName(key) + " " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })); V.recent.length = Math.min(V.recent.length, 20);
    paintTally(); if (navigator.vibrate) navigator.vibrate(40);
    if (!V.record || !state.token) return;
    try { await guard(rpcAuth("toolscale_vision_log", { p_item: key, p_score: Math.round(conf * 1000) / 1000, p_delta: V.action, p_note: "Seen by camera" })); refreshAll(); }
    catch (e) {}
  }

  /* ---------- Train ---------- */
  async function train() {
    stop(); const me = V.view = {}; const items = state.citems;
    $("#main").innerHTML = `<div class="summary"><div><h1>Train</h1><p>Show it each fastener so it learns what it looks like. Takes about a minute per type.</p></div></div>
      <div class="grid2"><div class="panel">${camHtml()}</div>
      <div class="panel"><h2>1. Pick what is in the square</h2><div class="field"><label for="tCls">Showing</label><select id="tCls" class="sel"><option value="empty">Empty (nothing in view)</option>${items.map(i => `<option value="${i.id}">${esc(i.name)}${i.spec ? " (" + esc(i.spec) + ")" : ""}</option>`).join("")}</select></div>
        ${items.length ? "" : `<p class="hint">No fasteners yet. Add them on the Consumables page (Items tab), then come back.</p>`}
        <h2 style="margin-top:16px">2. Capture</h2><p>Press the button, then slowly turn the part and move it a little inside the square.</p>
        <button class="btn" id="tCap">Capture 10 samples</button><p class="status-line" id="vStatus"></p></div></div>
      <section class="block"><h2>What it has learned</h2><div id="tCounts"></div></section>
      <details class="panel" style="margin-top:24px"><summary style="cursor:pointer;font-weight:600">Tips for good recognition</summary><ul>
        <li>Use a plain, matte background (white or grey paper) and the same light every time. Avoid shadows and glare.</li>
        <li>Teach <strong>Empty</strong> first with 20 samples. It is how the system knows a part has left.</li>
        <li>Capture 30 or more samples per fastener, turning it so the head, side and end are all seen.</li>
        <li>Types that look alike (a screw and a bolt of the same thread) need more samples. Sizes that differ only by length are hard to tell by camera. Use the scale weight for that.</li>
        <li>If it gets one wrong, capture a few more of that part and of the part it was confused with.</li></ul></details>`;
    $("#tCls").onchange = e => { V.cls = e.target.value; };
    const st = $("#vStatus"); if (!(await setupCamera(st))) return; if (V.view !== me) { if (!V.view) stopCamera(); return; }
    try { st.textContent = "Loading the recogniser..."; await Promise.all([ensureModel(), loadSamples(true)]); if (V.view !== me) { stopCamera(); return; } st.textContent = ""; } catch (e) { if (V.view === me) { st.className = "status-line err"; st.textContent = "Could not load the recogniser: " + (e.message || e); } return; }
    const c0 = counts(); V.cls = (c0.empty || 0) < 20 ? "empty" : (items.find(i => (c0[i.id] || 0) < 30)?.id || V.cls); $("#tCls").value = V.cls;
    paintCounts();
    $("#tCap").onclick = () => requireAuth(capture);
  }
  function paintCounts() {
    const t = $("#tCounts"); if (!t) return; const c = counts(), keys = ["empty", ...state.citems.map(i => i.id)];
    const fast = keys.filter(k => k !== "empty" && c[k]).length, need = [];
    if ((c.empty || 0) < 20) need.push("<strong>Empty</strong> needs 20 samples (nothing in the square)"); if (!fast) need.push("train at least one fastener");
    t.innerHTML = (need.length ? `<div class="banner info"><span><strong>To finish:</strong> ${need.join("; ")}. Then open the Identify tab.</span></div>` : `<div class="banner info" style="border-color:var(--ok)"><span><strong>Ready.</strong> Open the Identify tab to try it.</span></div>`) + `<ul class="log">${keys.map(k => `<li><div class="t num">${c[k] || 0}</div><div><div class="what">${esc(itemName(k))}</div><div class="note">${(c[k] || 0) >= 30 ? "Good" : (c[k] || 0) ? "Add more (30+ is best)" : "Not trained"}</div>
      ${c[k] ? `<button class="btn sec" style="margin-top:6px" data-vclear="${k}">Clear</button>` : ""}</div></li>`).join("")}</ul>`;
    t.querySelectorAll("[data-vclear]").forEach(b => b.onclick = () => requireAuth(async () => {
      if (!confirm("Clear everything it learned about " + itemName(b.dataset.vclear) + "?")) return;
      try { await guard(rpcAuth("toolscale_vision_clear_class", { p_class: b.dataset.vclear })); await loadSamples(true); paintCounts(); } catch (e) {} }));
  }
  async function capture() {
    const v = $("#vVid"), st = $("#vStatus"), btn = $("#tCap"); if (!V.model || !v || v.readyState < 2) return;
    const cls = $("#tCls").value; V.cls = cls; btn.disabled = true; const embs = [], fresh = [];
    for (let i = 0; i < 10; i++) {
      st.className = "status-line"; st.textContent = `Capturing ${i + 1} of 10...`;
      const raw = await embed(v); embs.push(encode(raw)); fresh.push({ key: cls, item: cls === "empty" ? null : cls, raw }); await new Promise(r => setTimeout(r, 250));
    }
    try {
      await guard(rpcAuth("toolscale_vision_add_samples", { p_class: cls, p_item: cls === "empty" ? null : cls, p_embs: embs }));
      V.samples.push(...fresh); rebuild(); st.className = "status-line ok"; st.textContent = "Saved 10 samples of " + itemName(cls) + "."; paintCounts();
    } catch (e) { st.className = "status-line err"; st.textContent = "Could not save: " + (e.message || e); }
    btn.disabled = false;
  }

  /* ---------- Log ---------- */
  async function vlog() {
    stop(); $("#main").innerHTML = `<div class="summary"><div><h1>Log</h1><p>Every fastener the camera recorded, newest first.</p></div></div><div id="vlogBody"></div>`;
    try {
      const rows = await guard(sb.from("vision_events").select("*").order("id", { ascending: false }).limit(100));
      $("#vlogBody").innerHTML = rows.length ? `<ul class="log">${rows.map(r => `<li><div class="t">${esc(when(r.ts))}</div><div><div class="what">${esc(r.item_name || "")}${r.delta ? " (" + (r.delta > 0 ? "+1 stock" : "-1 stock") + ")" : ""}</div>
        <div class="note">${Math.round(Number(r.score) * 100)}% sure${r.person ? " &middot; " + esc(r.person) : ""}</div></div></li>`).join("")}</ul>` : `<div class="empty"><p>Nothing recorded yet.</p></div>`;
    } catch (e) {}
  }

  window.VisionUI = { identify, train, vlog, stop, _t: { V, rebuild, predict, step, encode, decode } };   // _t is for tests
})();
