/* Space mode: draw your rooms and shelves in 2D, then find things in 3D.
   Plan  - one floor plan. Draw rooms of any shape (rectangle or corner by corner), then drop in shelves, cabinets, drawer units and benches.
   Find  - the same plan as a simple 3D model. Search for a tool or consumable and the box that holds it lights up.
   Items - say which shelf or cabinet, and which level, each tool and consumable lives in.
   Loaded on demand by index.html, which provides: state, $, esc, toast, guard, rpcAuth, requireAuth, refreshAll, setTab, labelTables, sb. */
(function () {
  const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js";
  const KINDS = {
    shelf: { label: "Shelf", w: 1.0, d: 0.4, h: 1.8, levels: 4, fill: "#24607A", c3: 0x3A87AA },
    cabinet: { label: "Cabinet", w: 0.8, d: 0.5, h: 1.8, levels: 3, fill: "#5B6B73", c3: 0x8696A0 },
    drawers: { label: "Drawer unit", w: 0.6, d: 0.6, h: 0.9, levels: 5, fill: "#2F7D7A", c3: 0x3FA6A1 },
    bench: { label: "Workbench", w: 1.5, d: 0.7, h: 0.9, levels: 1, fill: "#8A6A3F", c3: 0xB58A4F },
  };
  const S = { rooms: [], units: [], sel: null, tool: "select", draft: [], rect: null, v: { ox: -1, oz: -1, ppm: 60 }, view: null, t: null, find: "", hl: null, drag: null, hover: null };
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b), r2 = v => Math.round(v * 100) / 100, snapTo = (v, s) => Math.round(v / s) * s;
  const num = o => { const r = { ...o }; ["w", "d", "h", "x", "z", "rot", "levels"].forEach(k => { if (k in r) r[k] = Number(r[k]); }); if (Array.isArray(r.points)) r.points = r.points.map(p => [Number(p[0]), Number(p[1])]); return r; };
  const fp = u => { const sw = u.rot % 180 !== 0; return { x: u.x, z: u.z, w: sw ? u.d : u.w, d: sw ? u.w : u.d }; };
  const unit = id => S.units.find(u => u.id === id), room = id => S.rooms.find(r => r.id === id);
  const loadScript = src => new Promise((res, rej) => { const el = document.createElement("script"); el.src = src; el.onload = res; el.onerror = () => rej(new Error("Could not load " + src)); document.head.appendChild(el); });
  const allItems = () => [...state.tools.map(it => ({ kind: "tool", it })), ...state.citems.map(it => ({ kind: "consumable", it }))];
  const itemsAt = (uid, lvl) => allItems().filter(x => x.it.unit_id === uid && (lvl == null || Number(x.it.level) === lvl));
  const itemName = x => x.it.name + (x.it.spec ? " " + x.it.spec : "");
  const inPoly = (x, z, pts) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, zi] = pts[i], [xj, zj] = pts[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; };
  const area = pts => { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]); return Math.abs(a / 2); };
  const centroid = pts => { const n = pts.length; return [pts.reduce((a, p) => a + p[0], 0) / n, pts.reduce((a, p) => a + p[1], 0) / n]; };
  const roomOf = u => { const f = fp(u), cx = f.x + f.w / 2, cz = f.z + f.d / 2; for (let i = S.rooms.length - 1; i >= 0; i--) if (inPoly(cx, cz, S.rooms[i].points)) return S.rooms[i]; return null; };
  const whereOf = it => { const u = unit(it.unit_id); if (!u) return null; const r = roomOf(u); return (r ? r.name + " · " : "") + u.name + " · level " + it.level; };

  async function load() {
    const [rooms, units] = await Promise.all([guard(sb.from("space_rooms").select("*").eq("active", true).order("created_at")), guard(sb.from("space_units").select("*").eq("active", true).order("created_at"))]);
    S.rooms = rooms.map(num).filter(r => Array.isArray(r.points) && r.points.length >= 3); S.units = units.map(num);
    if (S.sel && !(S.sel.kind === "unit" ? unit(S.sel.id) : room(S.sel.id))) S.sel = null;
  }
  const saveRoom = r => guard(rpcAuth("toolscale_space_room_poly", { p_id: r.id || null, p_name: r.name, p_points: r.points.map(p => [r2(p[0]), r2(p[1])]), p_h: r2(r.h) }));
  const saveUnit = u => { const rm = roomOf(u); return guard(rpcAuth("toolscale_space_unit_put", { p_id: u.id || null, p_room: rm ? rm.id : null, p_kind: u.kind, p_name: u.name, p_x: r2(u.x), p_z: r2(u.z), p_w: r2(u.w), p_d: r2(u.d), p_h: r2(u.h), p_rot: u.rot, p_levels: u.levels })); };
  function stop() {
    S.view = null; S.drag = null; window.onresize = null;
    if (S.t) { cancelAnimationFrame(S.t.raf); try { S.t.renderer.dispose(); } catch (e) {} window.removeEventListener("resize", S.t.onResize); S.t = null; }
  }

  /* ====================================================== Plan (2D) ====================================================== */
  function bounds() {
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9; const add = (x, z) => { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); };
    S.rooms.forEach(r => r.points.forEach(p => add(p[0], p[1]))); S.units.forEach(u => { const f = fp(u); add(f.x, f.z); add(f.x + f.w, f.z + f.d); });
    if (x0 > x1) { x0 = 0; z0 = 0; x1 = 12; z1 = 8; } return { x0, z0, x1, z1 };
  }
  function fitView() {
    const cv = $("#sCv"); if (!cv) return; const b = bounds(), pad = 1, w = b.x1 - b.x0 + 2 * pad, h = b.z1 - b.z0 + 2 * pad;
    const ppm = Math.min(cv.width / Math.max(w, 6), cv.height / Math.max(h, 4)); S.v = { ppm, ox: b.x0 - pad - (cv.width / ppm - w) / 2, oz: b.z0 - pad - (cv.height / ppm - h) / 2 };
  }
  async function plan() {
    stop(); const me = S.view = {};
    $("#main").innerHTML = `<div class="summary"><div><h1>Plan</h1><p>Draw your space from above. Make each room (any shape), then drop in shelves and cabinets and drag them into place. Sizes are in metres.</p></div></div>
      <div class="row" id="sBar" style="margin-bottom:10px"></div>
      <div class="split"><div class="panel" style="padding:8px"><canvas id="sCv" style="width:100%;display:block;touch-action:none;background:var(--panel);cursor:default"></canvas><p class="hint" id="sHint" style="margin:6px 4px 0"></p></div><div class="panel" id="sProps"></div></div>`;
    try { await load(); } catch (e) { return; } if (S.view !== me) return;
    sizeCanvas(); fitView(); paintBar(); paintProps(); draw(); bindCanvas(); window.onresize = () => { if (S.view === me) { sizeCanvas(); draw(); } };
  }
  function sizeCanvas() { const cv = $("#sCv"); if (!cv) return; const w = Math.max(280, cv.parentElement.clientWidth - 16); cv.width = w; cv.height = Math.round(clamp(w * 0.68, 320, 560)); }
  function paintBar() {
    const el = $("#sBar"); if (!el) return; const t = S.tool, B = (id, label, on) => `<button class="btn ${on ? "" : "sec"}" data-tool="${id}">${label}</button>`;
    el.innerHTML = B("select", "Select / move", t === "select") + B("rect", "Room: rectangle", t === "rect") + B("poly", "Room: corners", t === "poly") + `<span class="hint" style="margin:0 4px">Add:</span>` + Object.entries(KINDS).map(([k, v]) => `<button class="btn sec" data-add="${k}">${v.label}</button>`).join("")
      + `<span style="flex:1"></span><button class="btn sec" id="zOut" aria-label="Zoom out">−</button><button class="btn sec" id="zIn" aria-label="Zoom in">+</button><button class="btn sec" id="zFit">Fit</button>`
      + (t === "poly" ? `<span class="row" style="width:100%;margin-top:4px"><button class="btn" id="pFin" ${S.draft.length >= 3 ? "" : "disabled"}>Finish room</button><button class="btn sec" id="pUndo" ${S.draft.length ? "" : "disabled"}>Undo corner</button><button class="btn sec" id="pCancel">Cancel</button></span>` : "");
    el.querySelectorAll("[data-tool]").forEach(b => b.onclick = () => { S.tool = b.dataset.tool; S.draft = []; S.rect = null; S.hover = null; paintBar(); draw(); });
    el.querySelectorAll("[data-add]").forEach(b => b.onclick = () => requireAuth(() => addUnit(b.dataset.add)));
    const zoom = f => { const cv = $("#sCv"), cx = S.v.ox + cv.width / 2 / S.v.ppm, cz = S.v.oz + cv.height / 2 / S.v.ppm; S.v.ppm = clamp(S.v.ppm * f, 8, 400); S.v.ox = cx - cv.width / 2 / S.v.ppm; S.v.oz = cz - cv.height / 2 / S.v.ppm; draw(); };
    $("#zIn").onclick = () => zoom(1.25); $("#zOut").onclick = () => zoom(0.8); $("#zFit").onclick = () => { fitView(); draw(); };
    const fin = $("#pFin"); if (fin) fin.onclick = finishPoly; const un = $("#pUndo"); if (un) un.onclick = () => { S.draft.pop(); paintBar(); draw(); }; const ca = $("#pCancel"); if (ca) ca.onclick = () => { S.draft = []; S.tool = "select"; paintBar(); draw(); };
  }
  async function addUnit(kind) {
    const cv = $("#sCv"), k = KINDS[kind], n = S.units.filter(x => x.kind === kind).length + 1;
    const u = { kind, name: k.label + " " + n, w: k.w, d: k.d, h: k.h, rot: 0, levels: k.levels };
    u.x = snapTo(S.v.ox + cv.width / 2 / S.v.ppm - u.w / 2, 0.05); u.z = snapTo(S.v.oz + cv.height / 2 / S.v.ppm - u.d / 2, 0.05);
    try { const id = await saveUnit(u); await load(); S.sel = { kind: "unit", id }; paintProps(); draw(); } catch (e) {}
  }
  const sx = x => (x - S.v.ox) * S.v.ppm, sy = z => (z - S.v.oz) * S.v.ppm;
  function draw() {
    const cv = $("#sCv"); if (!cv) return; const g = cv.getContext("2d"), p = S.v.ppm; g.clearRect(0, 0, cv.width, cv.height); g.fillStyle = "#EEF1F2"; g.fillRect(0, 0, cv.width, cv.height);
    const gx0 = Math.floor(S.v.ox), gx1 = Math.ceil(S.v.ox + cv.width / p), gz0 = Math.floor(S.v.oz), gz1 = Math.ceil(S.v.oz + cv.height / p);
    g.lineWidth = 1; g.font = "11px sans-serif"; g.textBaseline = "top"; g.textAlign = "left"; const labelEvery = p > 50 ? 1 : p > 25 ? 2 : 5;
    for (let x = gx0; x <= gx1; x++) { g.strokeStyle = x % 5 === 0 ? "#B9C4C9" : "#DDE4E7"; g.beginPath(); g.moveTo(sx(x), 0); g.lineTo(sx(x), cv.height); g.stroke(); if (x % labelEvery === 0) { g.fillStyle = "#5B6B73"; g.fillText(x + " m", sx(x) + 2, 2); } }
    for (let z = gz0; z <= gz1; z++) { g.strokeStyle = z % 5 === 0 ? "#B9C4C9" : "#DDE4E7"; g.beginPath(); g.moveTo(0, sy(z)); g.lineTo(cv.width, sy(z)); g.stroke(); if (z % labelEvery === 0 && z !== gz0) { g.fillStyle = "#5B6B73"; g.fillText(z + " m", 2, sy(z) + 2); } }
    for (const r of S.rooms) {
      const sel = S.sel && S.sel.kind === "room" && S.sel.id === r.id; g.beginPath(); r.points.forEach((q, i) => i ? g.lineTo(sx(q[0]), sy(q[1])) : g.moveTo(sx(q[0]), sy(q[1]))); g.closePath();
      g.fillStyle = sel ? "rgba(242,194,0,.14)" : "rgba(255,255,255,.95)"; g.fill(); g.strokeStyle = sel ? "#C99F00" : "#14232B"; g.lineWidth = sel ? 4 : 3; g.stroke();
      const c = centroid(r.points); g.fillStyle = "rgba(20,35,43,.55)"; g.font = "600 14px sans-serif"; g.textBaseline = "middle"; g.textAlign = "center"; g.fillText(r.name, sx(c[0]), sy(c[1])); g.font = "11px sans-serif"; g.fillText(r2(area(r.points)) + " m²", sx(c[0]), sy(c[1]) + 15); g.textAlign = "left";
      if (sel) r.points.forEach(q => { g.fillStyle = "#fff"; g.strokeStyle = "#14232B"; g.lineWidth = 2; g.fillRect(sx(q[0]) - 6, sy(q[1]) - 6, 12, 12); g.strokeRect(sx(q[0]) - 6, sy(q[1]) - 6, 12, 12); });
    }
    for (const u of S.units) {
      const f = fp(u), x = sx(f.x), y = sy(f.z), w = f.w * p, h = f.d * p, sel = S.sel && S.sel.kind === "unit" && S.sel.id === u.id, n = itemsAt(u.id).length;
      g.fillStyle = KINDS[u.kind]?.fill || "#24607A"; g.globalAlpha = .92; g.fillRect(x, y, w, h); g.globalAlpha = 1; g.strokeStyle = sel ? "#F2C200" : "#14232B"; g.lineWidth = sel ? 4 : 1.5; g.strokeRect(x, y, w, h);
      g.strokeStyle = "#fff"; g.lineWidth = 3; g.beginPath();   // the front edge
      if (u.rot === 0) { g.moveTo(x + 3, y + h - 2); g.lineTo(x + w - 3, y + h - 2); } else if (u.rot === 90) { g.moveTo(x + 2, y + 3); g.lineTo(x + 2, y + h - 3); } else if (u.rot === 180) { g.moveTo(x + 3, y + 2); g.lineTo(x + w - 3, y + 2); } else { g.moveTo(x + w - 2, y + 3); g.lineTo(x + w - 2, y + h - 3); } g.stroke();
      g.save(); g.beginPath(); g.rect(x + 3, y + 3, w - 6, h - 6); g.clip(); g.fillStyle = "#fff"; g.font = "600 12px sans-serif"; g.textBaseline = "top"; g.fillText(u.name, x + 6, y + 6); if (n && h > 34) { g.font = "11px sans-serif"; g.fillText(n + " item" + (n > 1 ? "s" : ""), x + 6, y + 21); } g.restore();
    }
    g.lineWidth = 3; g.strokeStyle = "#F2C200"; g.fillStyle = "rgba(242,194,0,.2)";
    if (S.rect) { const x = Math.min(S.rect.x0, S.rect.x1), z = Math.min(S.rect.z0, S.rect.z1), w = Math.abs(S.rect.x1 - S.rect.x0), d = Math.abs(S.rect.z1 - S.rect.z0); g.fillRect(sx(x), sy(z), w * p, d * p); g.strokeRect(sx(x), sy(z), w * p, d * p); g.fillStyle = "#14232B"; g.font = "12px sans-serif"; g.textBaseline = "top"; g.fillText(r2(w) + " × " + r2(d) + " m", sx(x) + 4, sy(z) + 4); }
    if (S.draft.length) { g.beginPath(); S.draft.forEach((q, i) => i ? g.lineTo(sx(q[0]), sy(q[1])) : g.moveTo(sx(q[0]), sy(q[1]))); if (S.hover) g.lineTo(sx(S.hover[0]), sy(S.hover[1])); g.stroke(); S.draft.forEach((q, i) => { g.fillStyle = i === 0 ? "#2E7D4F" : "#F2C200"; g.beginPath(); g.arc(sx(q[0]), sy(q[1]), i === 0 ? 7 : 5, 0, 7); g.fill(); }); }
    const hint = $("#sHint"); if (hint) hint.textContent = S.tool === "rect" ? "Drag from one corner of the room to the opposite corner." : S.tool === "poly" ? "Click each corner of the room in order. Click the green first corner (or Finish room) to close it." : (state.user ? "Drag a shelf or cabinet to move it. Click a room or a unit to edit it. Drag the empty background to move the view." : "Sign in (top right) to change things. You can still look around and pick things.");
  }
  function edgeNear(r, w) {   // the wall of room r closest to the pointer, if within 10px
    let best = null;
    for (let i = 0; i < r.points.length; i++) { const a = r.points[i], b = r.points[(i + 1) % r.points.length], ax = sx(a[0]), ay = sy(a[1]), bx = sx(b[0]), by = sy(b[1]), L = Math.hypot(bx - ax, by - ay) || 1, tt = clamp(((w.px - ax) * (bx - ax) + (w.py - ay) * (by - ay)) / (L * L), 0, 1), dd = Math.hypot(ax + tt * (bx - ax) - w.px, ay + tt * (by - ay) - w.py); if (dd < 10 && (!best || dd < best.dd)) best = { i, dd }; }
    return best;
  }
  function bindCanvas() {
    const cv = $("#sCv"); if (!cv) return; const pt = e => { const b = cv.getBoundingClientRect(), k = cv.width / b.width, px = (e.clientX - b.left) * k, py = (e.clientY - b.top) * k; return { px, py, x: px / S.v.ppm + S.v.ox, z: py / S.v.ppm + S.v.oz }; };
    const hitUnit = w => { for (let i = S.units.length - 1; i >= 0; i--) { const f = fp(S.units[i]); if (w.x >= f.x && w.x <= f.x + f.w && w.z >= f.z && w.z <= f.z + f.d) return S.units[i]; } return null; };
    const hitRoom = w => { for (let i = S.rooms.length - 1; i >= 0; i--) if (inPoly(w.x, w.z, S.rooms[i].points)) return S.rooms[i]; return null; };
    const hitVertex = w => { const r = S.sel && S.sel.kind === "room" ? room(S.sel.id) : null; if (!r) return null; for (let i = 0; i < r.points.length; i++) if (Math.hypot(sx(r.points[i][0]) - w.px, sy(r.points[i][1]) - w.py) < 10) return { r, i }; return null; };
    const needSignIn = () => { if (!state.user) { toast("Sign in to change things."); return true; } return false; };
    cv.onpointerdown = e => {
      const w = pt(e); cv.setPointerCapture(e.pointerId);
      if (S.tool === "rect") { if (needSignIn()) return; const x = snapTo(w.x, 0.1), z = snapTo(w.z, 0.1); S.rect = { x0: x, z0: z, x1: x, z1: z }; return; }
      if (S.tool === "poly") { if (needSignIn()) return; const x = snapTo(w.x, 0.1), z = snapTo(w.z, 0.1), f = S.draft[0]; if (f && S.draft.length >= 3 && Math.hypot(sx(f[0]) - w.px, sy(f[1]) - w.py) < 12) { finishPoly(); return; } S.draft.push([x, z]); paintBar(); draw(); return; }
      const hv = hitVertex(w); if (hv) { if (needSignIn()) return; S.drag = { kind: "vertex", r: hv.r, i: hv.i, orig: hv.r.points.map(q => q.slice()), moved: false }; return; }
      const u = hitUnit(w); if (u) { S.sel = { kind: "unit", id: u.id }; paintProps(); draw(); if (needSignIn()) return; const f = fp(u); S.drag = { kind: "unit", id: u.id, dx: w.x - f.x, dz: w.z - f.z, ox: u.x, oz: u.z, moved: false }; return; }
      const r = hitRoom(w), cur = S.sel && S.sel.kind === "room" ? room(S.sel.id) : null;
      if (r) S.sel = { kind: "room", id: r.id }; else if (!(cur && edgeNear(cur, w))) S.sel = null; paintProps(); draw();
      S.drag = { kind: "pan", px: w.px, py: w.py, ox: S.v.ox, oz: S.v.oz };
    };
    cv.onpointermove = e => {
      const w = pt(e), d = S.drag;
      if (S.tool === "rect" && S.rect) { S.rect.x1 = snapTo(w.x, 0.1); S.rect.z1 = snapTo(w.z, 0.1); draw(); return; }
      if (S.tool === "poly") { S.hover = [snapTo(w.x, 0.1), snapTo(w.z, 0.1)]; draw(); return; }
      if (!d) return;
      if (d.kind === "pan") { S.v.ox = d.ox - (w.px - d.px) / S.v.ppm; S.v.oz = d.oz - (w.py - d.py) / S.v.ppm; draw(); }
      else if (d.kind === "unit") { const u = unit(d.id); u.x = snapTo(w.x - d.dx, 0.05); u.z = snapTo(w.z - d.dz, 0.05); if (u.x !== d.ox || u.z !== d.oz) d.moved = true; draw(); }
      else if (d.kind === "vertex") { d.r.points[d.i] = [snapTo(w.x, 0.1), snapTo(w.z, 0.1)]; d.moved = true; draw(); }
    };
    cv.onpointerup = async () => {
      if (S.tool === "rect" && S.rect) { const R = S.rect; S.rect = null; const w = Math.abs(R.x1 - R.x0), d = Math.abs(R.z1 - R.z0); if (w < 0.5 || d < 0.5) { draw(); return; } const x0 = Math.min(R.x0, R.x1), z0 = Math.min(R.z0, R.z1); roomDialog(null, [[x0, z0], [x0 + w, z0], [x0 + w, z0 + d], [x0, z0 + d]]); return; }
      const d = S.drag; S.drag = null; if (!d) return;
      if (d.kind === "unit" && d.moved) { const u = unit(d.id); try { await saveUnit(u); paintProps(); } catch (e) { u.x = d.ox; u.z = d.oz; draw(); } }
      else if (d.kind === "vertex" && d.moved) { try { await saveRoom(d.r); } catch (e) { d.r.points = d.orig; } paintProps(); draw(); }
    };
    cv.ondblclick = async e => {   // double-click a wall of the selected room to add a corner, or a corner to remove it
      if (S.tool !== "select" || !state.user) return; const w = pt(e), r = S.sel && S.sel.kind === "room" ? room(S.sel.id) : null; if (!r) return;
      const hv = hitVertex(w), orig = r.points.map(q => q.slice());
      if (hv) { if (r.points.length <= 3) return toast("A room needs at least 3 corners."); r.points.splice(hv.i, 1); }
      else {
        const best = edgeNear(r, w); if (!best) return; r.points.splice(best.i + 1, 0, [snapTo(w.x, 0.1), snapTo(w.z, 0.1)]);
      }
      try { await saveRoom(r); } catch (err) { r.points = orig; } paintProps(); draw();
    };
    cv.onwheel = e => { e.preventDefault(); const w = pt(e), f = e.deltaY < 0 ? 1.12 : 0.89; S.v.ppm = clamp(S.v.ppm * f, 8, 400); S.v.ox = w.x - w.px / S.v.ppm; S.v.oz = w.z - w.py / S.v.ppm; draw(); };
  }
  function finishPoly() {
    if (S.draft.length < 3) return; const pts = S.draft.slice(); S.draft = []; S.hover = null; roomDialog(null, pts);
  }
  function paintProps() {
    const el = $("#sProps"); if (!el) return; const s = S.sel;
    if (s && s.kind === "room") {
      const r = room(s.id); if (!r) return; const inside = S.units.filter(u => roomOf(u) === r);
      el.innerHTML = `<h2>${esc(r.name)}</h2><p>${r2(area(r.points))} m², ${r.points.length} corners, walls ${r.h} m high.</p><p class="hint">${inside.length} shelf or cabinet${inside.length === 1 ? "" : "s"} inside. Drag a corner to reshape the room. Double-click a wall to add a corner, or a corner to remove it.</p>
        <div class="row" style="margin-top:10px"><button class="btn sec" id="rEdit">Rename or change height</button><button class="btn danger" id="rDel">Remove room</button></div>`;
      $("#rEdit").onclick = () => requireAuth(() => roomDialog(r));
      $("#rDel").onclick = () => requireAuth(async () => { if (!confirm("Remove " + r.name + "? The shelves and cabinets stay where they are.")) return; try { await guard(rpcAuth("toolscale_space_remove", { p_kind: "room", p_id: r.id })); S.sel = null; await load(); await refreshAll(); paintProps(); draw(); } catch (e) {} });
      return;
    }
    const u = s && s.kind === "unit" ? unit(s.id) : null;
    if (!u) { el.innerHTML = `<h2>Your space</h2><p>${S.rooms.length} room${S.rooms.length === 1 ? "" : "s"}, ${S.units.length} shelf or cabinet${S.units.length === 1 ? "" : "s"}.</p><p class="hint">Use <strong>Room: rectangle</strong> or <strong>Room: corners</strong> to draw a room. Use the <strong>Add</strong> buttons for shelves and cabinets. Click anything to edit it.</p>`; return; }
    const its = itemsAt(u.id), rm = roomOf(u);
    el.innerHTML = `<h2>${esc(u.name)}</h2><p class="hint">${rm ? "In " + esc(rm.name) : "Not inside a room"}</p>
      <div style="display:grid;gap:10px"><div><label for="uName">Name</label><input id="uName" type="text" maxlength="40" value="${esc(u.name)}"></div>
      <div><label for="uKind">Type</label><select id="uKind" class="sel">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${k === u.kind ? "selected" : ""}>${v.label}</option>`).join("")}</select></div>
      <div class="row"><div class="field"><label for="uW">Width (m)</label><input id="uW" type="number" step="0.05" min="0.1" value="${u.w}"></div><div class="field"><label for="uD">Depth (m)</label><input id="uD" type="number" step="0.05" min="0.1" value="${u.d}"></div></div>
      <div class="row"><div class="field"><label for="uH">Height (m)</label><input id="uH" type="number" step="0.05" min="0.1" value="${u.h}"></div><div class="field"><label for="uL">${u.kind === "drawers" ? "Drawers" : u.kind === "bench" ? "Levels" : "Shelves / levels"}</label><input id="uL" type="number" step="1" min="1" max="20" value="${u.levels}"></div></div>
      <div class="row"><button class="btn sec" id="uRot">Turn 90°</button><button class="btn sec" id="uDup">Copy</button><button class="btn danger" id="uDel">Remove</button></div>
      <p class="hint">${its.length ? its.length + " item" + (its.length > 1 ? "s" : "") + " stored here: " + esc(its.slice(0, 6).map(itemName).join(", ")) + (its.length > 6 ? "…" : "") : "Nothing stored here yet. Place items on the Items tab."}</p></div>`;
    let tm = null; const apply = () => requireAuth(async () => {
      Object.assign(u, { name: $("#uName").value.trim() || u.name, kind: $("#uKind").value, w: Math.max(0.1, Number($("#uW").value) || u.w), d: Math.max(0.1, Number($("#uD").value) || u.d), h: Math.max(0.1, Number($("#uH").value) || u.h), levels: clamp(Math.round(Number($("#uL").value) || u.levels), 1, 20) });
      try { await saveUnit(u); } catch (e) {} draw();
    });
    ["uName", "uKind", "uW", "uD", "uH", "uL"].forEach(id => { $("#" + id).onchange = () => { clearTimeout(tm); tm = setTimeout(apply, 150); }; });
    $("#uRot").onclick = () => requireAuth(async () => { u.rot = (u.rot + 90) % 360; try { await saveUnit(u); } catch (e) {} paintProps(); draw(); });
    $("#uDup").onclick = () => requireAuth(async () => { const c = { ...u, id: null, name: u.name + " copy", x: snapTo(u.x + 0.2, 0.05), z: snapTo(u.z + 0.2, 0.05) }; try { const id = await saveUnit(c); await load(); S.sel = { kind: "unit", id }; paintProps(); draw(); } catch (e) {} });
    $("#uDel").onclick = () => requireAuth(async () => { if (!confirm("Remove " + u.name + "? Items stored here become unplaced.")) return; try { await guard(rpcAuth("toolscale_space_remove", { p_kind: "unit", p_id: u.id })); S.sel = null; await load(); await refreshAll(); paintProps(); draw(); } catch (e) {} });
  }
  function roomDialog(r, pts) {
    if (!state.user) { draw(); return requireAuth(() => roomDialog(r, pts)); }
    const d = $("#dlg"); d.innerHTML = `<form method="dialog" id="rmForm"><div class="dlg-h"><h2>${r ? "Room" : "New room"}</h2></div><div class="dlg-b">
      <div><label for="rName">Room name</label><input id="rName" type="text" required maxlength="40" placeholder="e.g. Workshop" value="${esc(r?.name || "")}"></div>
      <div><label for="rH">Wall height (m)</label><input id="rH" type="number" step="0.1" min="1" required value="${r?.h ?? 2.6}"></div>
      ${pts ? `<p class="hint">${r2(area(pts))} m², ${pts.length} corners.</p>` : ""}</div>
      <div class="dlg-f"><button type="button" class="btn sec" id="rCancel">Cancel</button><button type="submit" class="btn">Save room</button></div></form>`;
    d.showModal(); $("#rCancel").onclick = () => { d.close(); draw(); };
    $("#rmForm").onsubmit = async e => { e.preventDefault(); const pp = r ? r.points : pts; try { const id = await saveRoom({ id: r?.id, name: $("#rName").value.trim(), points: pp, h: Number($("#rH").value) }); await load(); S.sel = { kind: "room", id }; S.tool = "select"; d.close(); paintBar(); paintProps(); draw(); } catch (err) {} };
  }

  /* ====================================================== Find (3D) ====================================================== */
  async function view3d() {
    stop(); const me = S.view = {};
    $("#main").innerHTML = `<div class="summary"><div><h1>Find</h1><p>Type what you are looking for. Its shelf or cabinet lights up in your space. Drag to turn the view, scroll or pinch to zoom.</p></div></div>
      <div class="split"><div class="panel" style="padding:0"><div id="s3Box" style="position:relative;width:100%;height:clamp(300px,62vw,520px);background:#16252D;overflow:hidden"><canvas id="s3" style="width:100%;height:100%;display:block;touch-action:none"></canvas><div id="s3Msg" class="hint" style="position:absolute;left:12px;top:10px;color:#9DB0B8;margin:0">Loading 3D...</div></div></div>
        <div class="panel" id="s3Side"></div></div>`;
    try { await Promise.all([load(), window.THREE ? 0 : loadScript(THREE_URL)]); } catch (e) { const m = $("#s3Msg"); if (m) m.textContent = "Could not load 3D: " + (e.message || e); return; }
    if (S.view !== me) return; if (!window.WebGLRenderingContext) { $("#s3Msg").textContent = "This browser cannot show 3D."; return; }
    try { init3d(); } catch (e) { const m = $("#s3Msg"); if (m) m.textContent = "Could not start 3D: " + (e.message || e); return; }
    $("#s3Msg").textContent = S.rooms.length || S.units.length ? "" : "Nothing drawn yet. Draw rooms and shelves on the Plan tab."; paintSide();
    if (state.spaceFocus) { const f = state.spaceFocus; state.spaceFocus = null; S.find = ""; focusItem(f.kind, f.id); }
  }
  function init3d() {
    const T = THREE, cv = $("#s3"), box = $("#s3Box"), renderer = new T.WebGLRenderer({ canvas: cv, antialias: true }), scene = new T.Scene(), camera = new T.PerspectiveCamera(45, 1, 0.05, 500);
    scene.background = new T.Color(0x16252D); scene.add(new T.HemisphereLight(0xffffff, 0x445566, 0.9)); const sun = new T.DirectionalLight(0xffffff, 0.7); sun.position.set(6, 12, 8); scene.add(sun);
    const root = new T.Group(); scene.add(root);
    const k = S.t = { T, renderer, scene, camera, root, C: { th: 1.0, ph: 0.9, dist: 12, tx: 4, ty: 0.5, tz: 3 }, pick: [], unitM: {}, marker: null, raf: 0, ptr: new Map(), moved: 0 };
    const resize = () => { const w = box.clientWidth, h = box.clientHeight; renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }; k.onResize = resize; window.addEventListener("resize", resize); resize();
    build(); fit(); controls(cv);
    const loop = ts => { if (S.t !== k) return; k.raf = requestAnimationFrame(loop); pulse(ts); renderer.render(scene, camera); }; k.raf = requestAnimationFrame(loop);
  }
  function camUpdate() { const k = S.t, C = k.C, sp = Math.sin(C.ph), cp = Math.cos(C.ph); k.camera.position.set(C.tx + C.dist * sp * Math.cos(C.th), C.ty + C.dist * cp, C.tz + C.dist * sp * Math.sin(C.th)); k.camera.lookAt(C.tx, C.ty, C.tz); }
  function fit() { const k = S.t, C = k.C, b = bounds(), w = b.x1 - b.x0, d = b.z1 - b.z0; C.tx = (b.x0 + b.x1) / 2; C.tz = (b.z0 + b.z1) / 2; C.ty = 0.4; C.dist = Math.max(w * 0.9, d * 1.5, 4) + 2; C.th = 1.1; C.ph = 0.95; camUpdate(); }
  function label(text, s) {
    const T = THREE, c = document.createElement("canvas"); c.width = 256; c.height = 64; const g = c.getContext("2d"); g.fillStyle = "rgba(14,24,29,.78)"; g.fillRect(0, 0, 256, 64); g.fillStyle = "#fff"; g.font = "600 28px sans-serif"; g.textBaseline = "middle"; g.fillText(text.length > 16 ? text.slice(0, 15) + "…" : text, 12, 34);
    const sp = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(c), transparent: true, depthTest: false })); sp.scale.set(s, s / 4, 1); sp.renderOrder = 5; return sp;
  }
  function build() {
    const k = S.t, T = k.T, root = k.root; while (root.children.length) root.remove(root.children[0]); k.pick = []; k.unitM = {};
    const B = (w, h, d) => new T.BoxGeometry(w, h, d);
    for (const r of S.rooms) {
      const shape = new T.Shape(); r.points.forEach((q, i) => i ? shape.lineTo(q[0], -q[1]) : shape.moveTo(q[0], -q[1]));
      const floor = new T.Mesh(new T.ShapeGeometry(shape), new T.MeshStandardMaterial({ color: 0x2c3e47, roughness: 1, side: T.DoubleSide })); floor.rotation.x = -Math.PI / 2; root.add(floor);
      const wallM = new T.MeshBasicMaterial({ color: 0x9DB0B8, transparent: true, opacity: 0.12, depthWrite: false, side: T.DoubleSide }), lineM = new T.LineBasicMaterial({ color: 0xB9C7CD });
      for (let i = 0; i < r.points.length; i++) {
        const a = r.points[i], b = r.points[(i + 1) % r.points.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.01) continue;
        const wall = new T.Mesh(B(L, r.h, 0.05), wallM); wall.position.set((a[0] + b[0]) / 2, r.h / 2, (a[1] + b[1]) / 2); wall.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]); root.add(wall);
        root.add(new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(a[0], r.h, a[1]), new T.Vector3(b[0], r.h, b[1]), new T.Vector3(b[0], 0.01, b[1]), new T.Vector3(a[0], 0.01, a[1]), new T.Vector3(a[0], r.h, a[1])]), lineM));
      }
      const c = centroid(r.points), lb = label(r.name, 1.5); lb.position.set(c[0], r.h + 0.3, c[1]); root.add(lb);
    }
    for (const u of S.units) {
      const f = fp(u), m = new T.MeshStandardMaterial({ color: KINDS[u.kind]?.c3 || 0x3A87AA, roughness: .6, metalness: .05, emissive: 0x000000 }), o = new T.Mesh(B(f.w, u.h, f.d), m);
      o.position.set(f.x + f.w / 2, u.h / 2, f.z + f.d / 2); o.userData.unit = u.id; root.add(o); k.pick.push(o); k.unitM[u.id] = o;
      const e = new T.LineSegments(new T.EdgesGeometry(B(f.w, u.h, f.d)), new T.LineBasicMaterial({ color: 0xE6EEF1 })); e.position.copy(o.position); root.add(e);
      const lt = label(u.name, 0.8); lt.position.set(f.x + f.w / 2, u.h + 0.25, f.z + f.d / 2); root.add(lt);
    }
    const mk = new T.Mesh(new T.ConeGeometry(0.16, 0.4, 16), new T.MeshBasicMaterial({ color: 0xF2C200 })); mk.rotation.x = Math.PI; mk.visible = false; root.add(mk); k.marker = mk;
  }
  function pulse(ts) {
    const k = S.t, p = 0.5 + 0.5 * Math.sin(ts / 240);
    for (const [uid, o] of Object.entries(k.unitM)) { const on = S.hl === uid; o.material.emissive.setHex(on ? 0x6B5400 : 0x000000); o.material.emissiveIntensity = on ? 0.5 + p : 0; }
    const u = S.hl && unit(S.hl); if (u && k.marker) { const f = fp(u); k.marker.visible = true; k.marker.position.set(f.x + f.w / 2, u.h + 0.75 + 0.15 * p, f.z + f.d / 2); } else if (k.marker) k.marker.visible = false;
  }
  function controls(cv) {
    const k = S.t, C = k.C;
    cv.onpointerdown = e => { cv.setPointerCapture(e.pointerId); k.ptr.set(e.pointerId, { x: e.clientX, y: e.clientY, b: e.button }); k.moved = 0; };
    cv.onpointermove = e => {
      const p = k.ptr.get(e.pointerId); if (!p) return; const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (k.ptr.size === 1) {
        k.moved += Math.abs(dx) + Math.abs(dy);
        if (e.shiftKey || p.b === 2) { const sc = C.dist * 0.0018, rx = Math.sin(C.th), rz = -Math.cos(C.th), fx = -Math.cos(C.th), fz = -Math.sin(C.th); C.tx += (-rx * dx + fx * dy) * sc; C.tz += (-rz * dx + fz * dy) * sc; }
        else { C.th -= dx * 0.008; C.ph = clamp(C.ph - dy * 0.008, 0.12, 1.52); }
      } else if (k.ptr.size === 2) { const o = [...k.ptr.entries()].find(([id]) => id !== e.pointerId)[1], before = Math.hypot(p.x - o.x, p.y - o.y), after = Math.hypot(e.clientX - o.x, e.clientY - o.y); if (before > 0 && after > 0) C.dist = clamp(C.dist * before / after, 0.8, 120); k.moved += 10; }
      p.x = e.clientX; p.y = e.clientY; camUpdate();
    };
    cv.onpointerup = e => { const p = k.ptr.get(e.pointerId); k.ptr.delete(e.pointerId); if (p && k.ptr.size === 0 && k.moved < 6) pick(e, cv); };
    cv.onpointercancel = e => k.ptr.delete(e.pointerId); cv.oncontextmenu = e => e.preventDefault();
    cv.onwheel = e => { e.preventDefault(); C.dist = clamp(C.dist * (1 + e.deltaY * 0.001), 0.8, 120); camUpdate(); };
  }
  function pick(e, cv) {
    const k = S.t, T = k.T, b = cv.getBoundingClientRect(), v = new T.Vector2(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1), rc = new T.Raycaster(); rc.setFromCamera(v, k.camera);
    const h = rc.intersectObjects(k.pick, false)[0]; S.hl = h ? h.object.userData.unit : null; S.sel = S.hl ? { kind: "unit", id: S.hl } : null; S.focusItem = null; paintSide();
  }
  function focusUnit(uid) { const k = S.t, u = unit(uid); if (!k || !u) return; const f = fp(u), C = k.C; C.tx = f.x + f.w / 2; C.tz = f.z + f.d / 2; C.ty = u.h / 2; C.dist = Math.max(3, Math.max(f.w, f.d, u.h) * 2.4); camUpdate(); }
  function focusItem(kind, id) {
    const x = allItems().find(a => a.kind === kind && String(a.it.id) === String(id)); if (!x) return; if (!x.it.unit_id || !unit(x.it.unit_id)) { toast(itemName(x) + " has no place yet. Set one on the Items tab."); return; }
    S.hl = x.it.unit_id; S.sel = { kind: "unit", id: S.hl }; S.focusItem = kind + ":" + x.it.id; focusUnit(S.hl); paintSide();
  }
  function paintSide() {
    const el = $("#s3Side"); if (!el) return; const u = S.sel && S.sel.kind === "unit" ? unit(S.sel.id) : null;
    const find = `<div class="field"><label for="sFind">What are you looking for?</label><input id="sFind" type="text" placeholder="e.g. cutter, M6, screw" value="${esc(S.find || "")}" autocomplete="off"></div><div id="sRes" style="margin-top:8px"></div>`;
    if (!u) { el.innerHTML = find + `<p class="hint" style="margin-top:12px">Or click a shelf or cabinet in the 3D view to see what is inside.</p>`; bindFind(); showRes(); return; }
    const rm = roomOf(u);
    el.innerHTML = find + `<h2 style="margin-top:16px">${esc(u.name)}</h2><p class="hint">${rm ? esc(rm.name) + ". " : ""}Level 1 is the lowest.</p>
      ${Array.from({ length: u.levels }, (_, i) => u.levels - i).map(lv => { const its = itemsAt(u.id, lv); return its.length ? `<div style="border-top:1px solid var(--line);padding:6px 0"><strong>Level ${lv}</strong>${its.map(x => `<div style="font-size:14px;${S.focusItem === x.kind + ":" + x.it.id ? "font-weight:700" : ""}"><i class="lg" style="background:${x.kind === "tool" ? "#F2C200" : "#2FB3B3"}"></i>${esc(itemName(x))}${x.kind === "tool" && x.it.status === "out" ? " (out)" : ""}</div>`).join("")}</div>` : ""; }).join("") || `<p class="hint">Nothing stored here yet.</p>`}
      <div class="row" style="margin-top:10px"><button class="btn sec" id="sEdit">Edit in plan</button></div>`;
    bindFind(); showRes(); $("#sEdit").onclick = () => { S.sel = { kind: "unit", id: u.id }; setTab("splan"); };
  }
  function bindFind() { const i = $("#sFind"); if (!i) return; i.oninput = () => { S.find = i.value; showRes(); }; }
  function showRes() {
    const el = $("#sRes"); if (!el) return; const q = (S.find || "").trim().toLowerCase(); if (!q) { el.innerHTML = ""; return; }
    const hits = allItems().filter(x => (itemName(x) + " " + (x.it.slot || "") + " " + (x.it.location || "") + " " + (x.it.category || "")).toLowerCase().includes(q)).slice(0, 8);
    el.innerHTML = hits.length ? hits.map(x => `<div class="row" style="justify-content:space-between;gap:6px;font-size:14px;border-bottom:1px solid var(--line);padding:4px 0"><span>${esc(itemName(x))}<br><span class="hint">${esc(whereOf(x.it) || "not placed yet")}</span></span><button class="btn sec" style="padding:2px 10px" data-go="${x.kind}:${x.it.id}">Show</button></div>`).join("") : `<p class="hint">Nothing matches.</p>`;
    el.querySelectorAll("[data-go]").forEach(b => b.onclick = () => { const i = b.dataset.go.indexOf(":"); focusItem(b.dataset.go.slice(0, i), b.dataset.go.slice(i + 1)); });
  }

  /* ====================================================== Items ====================================================== */
  async function items() {
    stop(); const me = S.view = {};
    $("#main").innerHTML = `<div class="summary"><div><h1>Items</h1><p>Say where each tool and consumable lives: which shelf or cabinet, and which level (1 is the lowest). Then you can find it on the Find tab.</p></div></div>
      <div class="row" style="margin-bottom:12px"><div class="field"><label for="iQ">Search</label><input id="iQ" type="text" placeholder="name or size"></div><label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="iUn"> Not placed yet only</label></div><div id="iList"></div>`;
    try { await load(); } catch (e) { return; } if (S.view !== me) return;
    const paint = () => {
      const q = $("#iQ").value.trim().toLowerCase(), un = $("#iUn").checked, list = allItems().filter(x => (!q || itemName(x).toLowerCase().includes(q)) && (!un || !unit(x.it.unit_id)));
      const ops = uid => S.units.map(uu => { const rm = roomOf(uu); return `<option value="${uu.id}" ${uu.id === uid ? "selected" : ""}>${esc((rm ? rm.name + " · " : "") + uu.name)}</option>`; }).join("");
      $("#iList").innerHTML = S.units.length ? `<div class="tablewrap"><table class="cards"><thead><tr><th>Item</th><th>Type</th><th>Now</th><th>Shelf or cabinet</th><th>Level</th><th></th></tr></thead><tbody>${list.map(x => `<tr data-k="${x.kind}" data-id="${x.it.id}"><td><strong>${esc(itemName(x))}</strong></td><td>${x.kind === "tool" ? "Tool" : "Consumable"}</td><td>${esc(whereOf(x.it) || "Not placed")}</td>
        <td><select class="sel iU"><option value="">Not placed</option>${ops(x.it.unit_id)}</select></td><td><select class="sel iL" style="min-width:70px"></select></td><td><button class="btn sec iGo">Place</button></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty"><p>Draw some shelves or cabinets on the Plan tab first.</p></div>`;
      $("#iList").querySelectorAll("tbody tr").forEach(tr => {
        const x = allItems().find(a => a.kind === tr.dataset.k && String(a.it.id) === tr.dataset.id), us = tr.querySelector(".iU"), ls = tr.querySelector(".iL");
        const fill = () => { const uu = unit(us.value); ls.innerHTML = uu ? Array.from({ length: uu.levels }, (_, i) => `<option ${Number(x.it.level) === i + 1 && x.it.unit_id === uu.id ? "selected" : ""}>${i + 1}</option>`).join("") : `<option>-</option>`; ls.disabled = !uu; }; fill(); us.onchange = fill;
        tr.querySelector(".iGo").onclick = () => requireAuth(async () => { try { await guard(rpcAuth("toolscale_space_place", { p_kind: x.kind, p_id: x.it.id, p_unit: us.value || null, p_level: us.value ? Number(ls.value) : null })); await refreshAll(); paint(); toast("Saved"); } catch (e) {} });
      });
      labelTables();
    };
    $("#iQ").oninput = paint; $("#iUn").onchange = paint; paint();
  }

  window.SpaceUI = { plan, view3d, items, stop, onData() { if (S.t) paintSide(); }, _t: { S, fp, inPoly, area, roomOf } };
})();
