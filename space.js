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
  const S = { rooms: [], units: [], sel: null, tool: "select", draft: [], rect: null, v: { ox: -1, oz: -1, ppm: 60 }, view: null, t: null, find: "", hl: null, drag: null, hover: null, undo: [], burst: false, pending: null, saveT: null, guides: null, keys: null };
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
  const saveUnit = u => { const rm = roomOf(u); return guard(rpcAuth("toolscale_space_unit_set", { p_id: u.id || null, p_room: rm ? rm.id : null, p_kind: u.kind, p_name: u.name, p_x: r2(u.x), p_z: r2(u.z), p_w: r2(u.w), p_d: r2(u.d), p_h: r2(u.h), p_rot: u.rot, p_levels: u.levels, p_color: u.color || "" })); };
  /* edits save a moment after the last change, so dragging a slider or typing a size does not send a request on every keystroke */
  function scheduleSave(u) { clearTimeout(S.saveT); S.pending = u; S.saveT = setTimeout(flushSave, 600); }
  function flushSave() { clearTimeout(S.saveT); const u = S.pending; S.pending = null; S.burst = false; if (u && unit(u.id)) return saveUnit(u).catch(() => {}); }
  /* undo: a snapshot is taken before each change (one per burst of typing or nudging) */
  function snapUndo(entry) { S.undo.push(entry); if (S.undo.length > 50) S.undo.shift(); paintUndo(); }
  const snapUnit = u => snapUndo({ kind: "unit", data: { ...u } });
  function burstSnap(u) { if (!S.burst) { snapUnit(u); S.burst = true; } }
  async function undo() {
    const e = S.undo.pop(); paintUndo(); if (!e) return; await flushSave();
    try {
      if (e.kind === "unit") { const u = unit(e.data.id); if (!u) return; Object.assign(u, e.data); await saveUnit(u); S.sel = { kind: "unit", id: u.id }; }
      else if (e.kind === "room") { const r = room(e.id); if (!r) return; r.points = e.points; await saveRoom(r); S.sel = { kind: "room", id: r.id }; }
      else if (e.kind === "add") { await guard(rpcAuth("toolscale_space_remove", { p_kind: "unit", p_id: e.id })); await load(); S.sel = null; }
      toast("Undone");
    } catch (err) {}
    paintProps(); draw();
  }
  function paintUndo() { const b = $("#sUndo"); if (b) b.disabled = !S.undo.length; }
  function stop() {
    flushSave(); S.view = null; S.drag = null; window.onresize = null;
    if (S.keys) { document.removeEventListener("keydown", S.keys); S.keys = null; }
    if (S.t) { cancelAnimationFrame(S.t.raf); try { S.t.renderer.dispose(); } catch (e) {} window.removeEventListener("resize", S.t.onResize); S.t = null; }
  }

  /* ====================================================== Plan (2D) ====================================================== */
  const SWATCH = ["#24607A", "#3A87AA", "#5B6B73", "#A8B3B8", "#2F7D7A", "#2E7D4F", "#8A6A3F", "#C7A27A", "#B83A26", "#D9822B", "#E0B000", "#6B4FA0", "#2B2B2B", "#E8E4DA"];
  const PRESETS = {
    shelf: [[100, 40, 180], [120, 50, 200], [90, 30, 180], [150, 60, 200], [80, 40, 100]],
    cabinet: [[80, 50, 180], [90, 45, 100], [100, 60, 200], [60, 40, 75]],
    drawers: [[60, 60, 90], [40, 50, 70], [80, 60, 100], [30, 40, 50]],
    bench: [[150, 70, 90], [180, 80, 90], [120, 60, 75], [200, 90, 90]],
  };
  const colorOf = u => u.color || KINDS[u.kind]?.fill || "#24607A";
  const light = hex => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) > 160; };
  const cm = m => Math.round(m * 100);
  const facing = rot => ({ 0: "down", 90: "left", 180: "up", 270: "right" })[rot] || "down";
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
    $("#main").innerHTML = `<div class="summary"><div><h1>Space plan</h1><p>Draw your space from above. Make each room (any shape), add shelves and cabinets, then drag them into place. Select one to change its size, height, levels and colour.</p></div></div>
      <div class="row" id="sBar" style="margin-bottom:10px"></div>
      <div class="split"><div class="panel" style="padding:8px"><canvas id="sCv" style="width:100%;display:block;touch-action:none;background:var(--panel);cursor:default"></canvas><p class="hint" id="sHint" style="margin:6px 4px 0"></p></div><div class="panel" id="sProps"></div></div>`;
    try { await load(); } catch (e) { return; } if (S.view !== me) return;
    sizeCanvas(); fitView(); paintBar(); paintProps(); draw(); bindCanvas(); window.onresize = () => { if (S.view === me) { sizeCanvas(); draw(); } };
    S.keys = onKey; document.addEventListener("keydown", S.keys);
  }
  function sizeCanvas() { const cv = $("#sCv"); if (!cv) return; const w = Math.max(280, cv.parentElement.clientWidth - 16); cv.width = w; cv.height = Math.round(clamp(w * 0.68, 320, 560)); }
  function paintBar() {
    const el = $("#sBar"); if (!el) return; const t = S.tool, B = (id, label, on) => `<button class="btn ${on ? "" : "sec"}" data-tool="${id}">${label}</button>`;
    el.innerHTML = B("select", "Select / move", t === "select") + B("rect", "Room: rectangle", t === "rect") + B("poly", "Room: corners", t === "poly") + `<span class="hint" style="margin:0 4px">Add:</span>` + Object.entries(KINDS).map(([k, v]) => `<button class="btn sec" data-add="${k}">${v.label}</button>`).join("")
      + `<span style="flex:1"></span><button class="btn sec" id="sUndo" title="Undo (Ctrl+Z)" ${S.undo.length ? "" : "disabled"}>Undo</button><button class="btn sec" id="zOut" aria-label="Zoom out">−</button><button class="btn sec" id="zIn" aria-label="Zoom in">+</button><button class="btn sec" id="zFit">Fit</button>`
      + (t === "poly" ? `<span class="row" style="width:100%;margin-top:4px"><button class="btn" id="pFin" ${S.draft.length >= 3 ? "" : "disabled"}>Finish room</button><button class="btn sec" id="pUndo" ${S.draft.length ? "" : "disabled"}>Undo corner</button><button class="btn sec" id="pCancel">Cancel</button></span>` : "");
    el.querySelectorAll("[data-tool]").forEach(b => b.onclick = () => { S.tool = b.dataset.tool; S.draft = []; S.rect = null; S.hover = null; paintBar(); draw(); });
    el.querySelectorAll("[data-add]").forEach(b => b.onclick = () => requireAuth(() => addUnit(b.dataset.add)));
    const zoom = f => { const cv = $("#sCv"), cx = S.v.ox + cv.width / 2 / S.v.ppm, cz = S.v.oz + cv.height / 2 / S.v.ppm; S.v.ppm = clamp(S.v.ppm * f, 8, 400); S.v.ox = cx - cv.width / 2 / S.v.ppm; S.v.oz = cz - cv.height / 2 / S.v.ppm; draw(); };
    $("#zIn").onclick = () => zoom(1.25); $("#zOut").onclick = () => zoom(0.8); $("#zFit").onclick = () => { fitView(); draw(); }; $("#sUndo").onclick = () => requireAuth(undo);
    const fin = $("#pFin"); if (fin) fin.onclick = finishPoly; const un = $("#pUndo"); if (un) un.onclick = () => { S.draft.pop(); paintBar(); draw(); }; const ca = $("#pCancel"); if (ca) ca.onclick = () => { S.draft = []; S.tool = "select"; paintBar(); draw(); };
  }
  async function addUnit(kind, from) {
    await flushSave(); const cv = $("#sCv"), k = KINDS[kind], n = S.units.filter(x => x.kind === kind).length + 1;
    const u = from ? { ...from, id: null, name: from.name + " copy" } : { kind, name: k.label + " " + n, w: k.w, d: k.d, h: k.h, rot: 0, levels: k.levels, color: null };
    if (from) { const f = fp(from); u.x = snapTo(from.x + (f.w < f.d ? f.w : 0) + 0.05, 0.05); u.z = snapTo(from.z + (f.w < f.d ? 0 : f.d) + 0.05, 0.05); }   // copies go right next to the original
    else { u.x = snapTo(S.v.ox + cv.width / 2 / S.v.ppm - u.w / 2, 0.05); u.z = snapTo(S.v.oz + cv.height / 2 / S.v.ppm - u.d / 2, 0.05); }
    try { const id = await saveUnit(u); snapUndo({ kind: "add", id }); await load(); S.sel = { kind: "unit", id }; paintProps(); draw(); } catch (e) {}
  }
  const sx = x => (x - S.v.ox) * S.v.ppm, sy = z => (z - S.v.oz) * S.v.ppm;
  function handles(u) {   // resize grips on the selected unit, in screen pixels
    const f = fp(u), x0 = sx(f.x), y0 = sy(f.z), x1 = sx(f.x + f.w), y1 = sy(f.z + f.d), mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    return [["l", x0, my], ["r", x1, my], ["t", mx, y0], ["b", mx, y1], ["br", x1, y1]];
  }
  function dimLabel(g, text, x, y, vertical) {
    g.save(); g.translate(x, y); if (vertical) g.rotate(-Math.PI / 2); g.font = "600 12px sans-serif"; const w = g.measureText(text).width + 10;
    g.fillStyle = "#14232B"; g.fillRect(-w / 2, -9, w, 18); g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text, 0, 1); g.restore();
  }
  function edgeLengths(g, pts, closed) {
    for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) { const a = pts[i], b = pts[(i + 1) % pts.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L * S.v.ppm < 40) continue; dimLabel(g, r2(L) + " m", (sx(a[0]) + sx(b[0])) / 2, (sy(a[1]) + sy(b[1])) / 2, false); }
  }
  function draw() {
    const cv = $("#sCv"); if (!cv) return; const g = cv.getContext("2d"), p = S.v.ppm; g.clearRect(0, 0, cv.width, cv.height); g.fillStyle = "#EEF1F2"; g.fillRect(0, 0, cv.width, cv.height);
    const gx0 = Math.floor(S.v.ox), gx1 = Math.ceil(S.v.ox + cv.width / p), gz0 = Math.floor(S.v.oz), gz1 = Math.ceil(S.v.oz + cv.height / p);
    g.lineWidth = 1; g.font = "11px sans-serif"; g.textBaseline = "top"; g.textAlign = "left"; const labelEvery = p > 50 ? 1 : p > 25 ? 2 : 5;
    for (let x = gx0; x <= gx1; x++) { g.strokeStyle = x % 5 === 0 ? "#B9C4C9" : "#DDE4E7"; g.beginPath(); g.moveTo(sx(x), 0); g.lineTo(sx(x), cv.height); g.stroke(); if (x % labelEvery === 0) { g.fillStyle = "#5B6B73"; g.fillText(x + " m", sx(x) + 2, 2); } }
    for (let z = gz0; z <= gz1; z++) { g.strokeStyle = z % 5 === 0 ? "#B9C4C9" : "#DDE4E7"; g.beginPath(); g.moveTo(0, sy(z)); g.lineTo(cv.width, sy(z)); g.stroke(); if (z % labelEvery === 0 && z !== gz0) { g.fillStyle = "#5B6B73"; g.fillText(z + " m", 2, sy(z) + 2); } }
    let selRoom = null;
    for (const r of S.rooms) {
      const sel = S.sel && S.sel.kind === "room" && S.sel.id === r.id; if (sel) selRoom = r; g.beginPath(); r.points.forEach((q, i) => i ? g.lineTo(sx(q[0]), sy(q[1])) : g.moveTo(sx(q[0]), sy(q[1]))); g.closePath();
      g.fillStyle = sel ? "rgba(242,194,0,.14)" : "rgba(255,255,255,.95)"; g.fill(); g.strokeStyle = sel ? "#C99F00" : "#14232B"; g.lineWidth = sel ? 4 : 3; g.stroke();
      const c = centroid(r.points); g.fillStyle = "rgba(20,35,43,.55)"; g.font = "600 14px sans-serif"; g.textBaseline = "middle"; g.textAlign = "center"; g.fillText(r.name, sx(c[0]), sy(c[1])); g.font = "11px sans-serif"; g.fillText(r2(area(r.points)) + " m²", sx(c[0]), sy(c[1]) + 15); g.textAlign = "left";
    }
    let selUnit = null;
    for (const u of S.units) {
      const f = fp(u), x = sx(f.x), y = sy(f.z), w = f.w * p, h = f.d * p, sel = S.sel && S.sel.kind === "unit" && S.sel.id === u.id, n = itemsAt(u.id).length, col = colorOf(u), lt = light(col);
      if (sel) selUnit = u;
      g.fillStyle = col; g.globalAlpha = .94; g.fillRect(x, y, w, h); g.globalAlpha = 1; g.strokeStyle = sel ? "#F2C200" : "#14232B"; g.lineWidth = sel ? 4 : 1.5; g.strokeRect(x, y, w, h);
      g.strokeStyle = lt ? "#14232B" : "#fff"; g.lineWidth = 3; g.beginPath();   // the front edge
      if (u.rot === 0) { g.moveTo(x + 3, y + h - 2); g.lineTo(x + w - 3, y + h - 2); } else if (u.rot === 90) { g.moveTo(x + 2, y + 3); g.lineTo(x + 2, y + h - 3); } else if (u.rot === 180) { g.moveTo(x + 3, y + 2); g.lineTo(x + w - 3, y + 2); } else { g.moveTo(x + w - 2, y + 3); g.lineTo(x + w - 2, y + h - 3); } g.stroke();
      g.save(); g.beginPath(); g.rect(x + 3, y + 3, w - 6, h - 6); g.clip(); g.fillStyle = lt ? "#14232B" : "#fff"; g.font = "600 12px sans-serif"; g.textBaseline = "top"; g.fillText(u.name, x + 6, y + 6); if (n && h > 34) { g.font = "11px sans-serif"; g.fillText(n + " item" + (n > 1 ? "s" : ""), x + 6, y + 21); } g.restore();
    }
    if (selRoom) { edgeLengths(g, selRoom.points, true); selRoom.points.forEach(q => { g.fillStyle = "#fff"; g.strokeStyle = "#14232B"; g.lineWidth = 2; g.fillRect(sx(q[0]) - 6, sy(q[1]) - 6, 12, 12); g.strokeRect(sx(q[0]) - 6, sy(q[1]) - 6, 12, 12); }); }
    if (selUnit) {
      const f = fp(selUnit), x0 = sx(f.x), y0 = sy(f.z), x1 = sx(f.x + f.w), y1 = sy(f.z + f.d);
      dimLabel(g, cm(f.w) + " cm", (x0 + x1) / 2, y0 - 14, false); dimLabel(g, cm(f.d) + " cm", x1 + 14, (y0 + y1) / 2, true);
      if (state.user) handles(selUnit).forEach(([k, hx, hy]) => { g.fillStyle = "#F2C200"; g.strokeStyle = "#14232B"; g.lineWidth = 2; g.beginPath(); if (k === "br") { g.rect(hx - 7, hy - 7, 14, 14); } else g.arc(hx, hy, 6, 0, 7); g.fill(); g.stroke(); });
    }
    if (S.guides) { g.save(); g.strokeStyle = "#D9822B"; g.lineWidth = 1; g.setLineDash([6, 4]); S.guides.x.forEach(v => { g.beginPath(); g.moveTo(sx(v), 0); g.lineTo(sx(v), cv.height); g.stroke(); }); S.guides.z.forEach(v => { g.beginPath(); g.moveTo(0, sy(v)); g.lineTo(cv.width, sy(v)); g.stroke(); }); g.restore(); }
    g.lineWidth = 3; g.strokeStyle = "#F2C200"; g.fillStyle = "rgba(242,194,0,.2)";
    if (S.rect) { const x = Math.min(S.rect.x0, S.rect.x1), z = Math.min(S.rect.z0, S.rect.z1), w = Math.abs(S.rect.x1 - S.rect.x0), d = Math.abs(S.rect.z1 - S.rect.z0); g.fillRect(sx(x), sy(z), w * p, d * p); g.strokeRect(sx(x), sy(z), w * p, d * p); dimLabel(g, r2(w) + " m", sx(x + w / 2), sy(z) - 12, false); dimLabel(g, r2(d) + " m", sx(x + w) + 12, sy(z + d / 2), true); }
    if (S.draft.length) { g.beginPath(); S.draft.forEach((q, i) => i ? g.lineTo(sx(q[0]), sy(q[1])) : g.moveTo(sx(q[0]), sy(q[1]))); if (S.hover) g.lineTo(sx(S.hover[0]), sy(S.hover[1])); g.stroke(); S.draft.forEach((q, i) => { g.fillStyle = i === 0 ? "#2E7D4F" : "#F2C200"; g.beginPath(); g.arc(sx(q[0]), sy(q[1]), i === 0 ? 7 : 5, 0, 7); g.fill(); }); edgeLengths(g, S.hover ? [...S.draft, S.hover] : S.draft, false); }
    const hint = $("#sHint"); if (hint) hint.textContent = S.tool === "rect" ? "Drag from one corner of the room to the opposite corner." : S.tool === "poly" ? "Click each corner of the room in order. Click the green first corner (or Finish room) to close it." : !state.user ? "Sign in (top right) to change things. You can still look around and pick things."
      : selUnit ? "Drag to move. Drag the yellow handles to resize. Keys: arrows nudge 5 cm (Shift 50 cm), R turns, Ctrl+D copies, Delete removes, Ctrl+Z undoes." : "Click a shelf, cabinet or room to edit it. Drag the empty background to move the view; scroll or pinch to zoom.";
  }
  /* snapping: edges of a moving or resizing unit stick to other units' edges and to walls */
  function snapLines(skipId) {
    const xs = [], zs = []; S.units.forEach(o => { if (o.id === skipId) return; const f = fp(o); xs.push(f.x, f.x + f.w); zs.push(f.z, f.z + f.d); });
    S.rooms.forEach(r => r.points.forEach(q => { xs.push(q[0]); zs.push(q[1]); })); return { xs, zs };
  }
  function snapEdge(v, list, out) { const thr = 8 / S.v.ppm; let best = null; list.forEach(c => { if (Math.abs(c - v) < thr && (best == null || Math.abs(c - v) < Math.abs(best - v))) best = c; }); if (best != null) { out.push(best); return best; } return null; }
  function edgeNear(r, w) {   // the wall of room r closest to the pointer, if within 10px
    let best = null;
    for (let i = 0; i < r.points.length; i++) { const a = r.points[i], b = r.points[(i + 1) % r.points.length], ax = sx(a[0]), ay = sy(a[1]), bx = sx(b[0]), by = sy(b[1]), L = Math.hypot(bx - ax, by - ay) || 1, tt = clamp(((w.px - ax) * (bx - ax) + (w.py - ay) * (by - ay)) / (L * L), 0, 1), dd = Math.hypot(ax + tt * (bx - ax) - w.px, ay + tt * (by - ay) - w.py); if (dd < 10 && (!best || dd < best.dd)) best = { i, dd }; }
    return best;
  }
  function setFootprint(u, f) { const sw = u.rot % 180 !== 0; u.x = r2(f.x); u.z = r2(f.z); if (sw) { u.d = r2(f.w); u.w = r2(f.d); } else { u.w = r2(f.w); u.d = r2(f.d); } }
  function bindCanvas() {
    const cv = $("#sCv"); if (!cv) return; const pt = e => { const b = cv.getBoundingClientRect(), k = cv.width / b.width, px = (e.clientX - b.left) * k, py = (e.clientY - b.top) * k; return { px, py, x: px / S.v.ppm + S.v.ox, z: py / S.v.ppm + S.v.oz }; };
    const hitUnit = w => { for (let i = S.units.length - 1; i >= 0; i--) { const f = fp(S.units[i]); if (w.x >= f.x && w.x <= f.x + f.w && w.z >= f.z && w.z <= f.z + f.d) return S.units[i]; } return null; };
    const hitRoom = w => { for (let i = S.rooms.length - 1; i >= 0; i--) if (inPoly(w.x, w.z, S.rooms[i].points)) return S.rooms[i]; return null; };
    const hitVertex = w => { const r = S.sel && S.sel.kind === "room" ? room(S.sel.id) : null; if (!r) return null; for (let i = 0; i < r.points.length; i++) if (Math.hypot(sx(r.points[i][0]) - w.px, sy(r.points[i][1]) - w.py) < 10) return { r, i }; return null; };
    const hitHandle = (w, touch) => { const u = S.sel && S.sel.kind === "unit" ? unit(S.sel.id) : null; if (!u || !state.user) return null; const hit = handles(u).find(([, hx, hy]) => Math.hypot(hx - w.px, hy - w.py) < (touch ? 16 : 10)); return hit ? { u, edge: hit[0] } : null; };
    const needSignIn = () => { if (!state.user) { toast("Sign in to change things."); return true; } return false; };
    const pts = new Map();
    cv.onpointerdown = e => {
      const w = pt(e); cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, w);
      if (pts.size === 2) { if (S.drag?.orig && S.drag.moved && unit(S.drag.id)) Object.assign(unit(S.drag.id), S.drag.orig); S.rect = null; const [a, b] = [...pts.values()]; S.drag = { kind: "pinch", d0: Math.hypot(a.px - b.px, a.py - b.py), ppm: S.v.ppm }; return; }
      if (S.tool === "rect") { if (needSignIn()) return; const x = snapTo(w.x, 0.1), z = snapTo(w.z, 0.1); S.rect = { x0: x, z0: z, x1: x, z1: z }; return; }
      if (S.tool === "poly") { if (needSignIn()) return; const x = snapTo(w.x, 0.1), z = snapTo(w.z, 0.1), f = S.draft[0]; if (f && S.draft.length >= 3 && Math.hypot(sx(f[0]) - w.px, sy(f[1]) - w.py) < 12) { finishPoly(); return; } S.draft.push([x, z]); paintBar(); draw(); return; }
      const hh = hitHandle(w, e.pointerType === "touch"); if (hh) { flushSave(); S.drag = { kind: "resize", id: hh.u.id, edge: hh.edge, f0: fp(hh.u), orig: { ...hh.u }, moved: false }; return; }
      const hv = hitVertex(w); if (hv) { if (needSignIn()) return; S.drag = { kind: "vertex", r: hv.r, i: hv.i, orig: hv.r.points.map(q => q.slice()), moved: false }; return; }
      const u = hitUnit(w); if (u) { if (!(S.sel && S.sel.id === u.id)) { flushSave(); S.sel = { kind: "unit", id: u.id }; paintProps(); } draw(); if (needSignIn()) return; const f = fp(u); S.drag = { kind: "unit", id: u.id, dx: w.x - f.x, dz: w.z - f.z, orig: { ...u }, moved: false }; return; }
      const r = hitRoom(w), cur = S.sel && S.sel.kind === "room" ? room(S.sel.id) : null;
      flushSave(); if (r) S.sel = { kind: "room", id: r.id }; else if (!(cur && edgeNear(cur, w))) S.sel = null; paintProps(); draw();
      S.drag = { kind: "pan", px: w.px, py: w.py, ox: S.v.ox, oz: S.v.oz };
    };
    cv.onpointermove = e => {
      const w = pt(e), d = S.drag; if (pts.has(e.pointerId)) pts.set(e.pointerId, w);
      if (S.tool === "rect" && S.rect) { S.rect.x1 = snapTo(w.x, 0.1); S.rect.z1 = snapTo(w.z, 0.1); draw(); return; }
      if (S.tool === "poly") { S.hover = [snapTo(w.x, 0.1), snapTo(w.z, 0.1)]; draw(); return; }
      if (!d) { const hh = hitHandle(w); cv.style.cursor = !hh ? "default" : hh.edge === "l" || hh.edge === "r" ? "ew-resize" : hh.edge === "br" ? "nwse-resize" : "ns-resize"; return; }
      if (d.kind === "pinch") { if (pts.size < 2) return; const [a, b] = [...pts.values()], dist = Math.hypot(a.px - b.px, a.py - b.py), mx = (a.px + b.px) / 2, my = (a.py + b.py) / 2, wx = mx / S.v.ppm + S.v.ox, wz = my / S.v.ppm + S.v.oz; S.v.ppm = clamp(d.ppm * dist / d.d0, 8, 400); S.v.ox = wx - mx / S.v.ppm; S.v.oz = wz - my / S.v.ppm; draw(); return; }
      if (d.kind === "pan") { S.v.ox = d.ox - (w.px - d.px) / S.v.ppm; S.v.oz = d.oz - (w.py - d.py) / S.v.ppm; draw(); }
      else if (d.kind === "unit") {
        const u = unit(d.id), f = fp(u), L = snapLines(u.id), gx = [], gz = []; let nx = snapTo(w.x - d.dx, 0.05), nz = snapTo(w.z - d.dz, 0.05);
        if (!e.altKey) { const a = snapEdge(nx, L.xs, gx), b = a == null ? snapEdge(nx + f.w, L.xs, gx) : null; if (a != null) nx = a; else if (b != null) nx = b - f.w; const c = snapEdge(nz, L.zs, gz), dd = c == null ? snapEdge(nz + f.d, L.zs, gz) : null; if (c != null) nz = c; else if (dd != null) nz = dd - f.d; }
        S.guides = { x: gx, z: gz }; if (nx !== u.x || nz !== u.z) d.moved = true; u.x = r2(nx); u.z = r2(nz); draw();
      }
      else if (d.kind === "resize") {
        const u = unit(d.id), F = { ...d.f0 }, L = snapLines(u.id), gx = [], gz = [], E = d.edge; let x = snapTo(w.x, 0.05), z = snapTo(w.z, 0.05);
        if (!e.altKey) { if (E === "l" || E === "r" || E === "br") { const s = snapEdge(x, L.xs, gx); if (s != null) x = s; } if (E === "t" || E === "b" || E === "br") { const s = snapEdge(z, L.zs, gz); if (s != null) z = s; } }
        if (E === "r" || E === "br") F.w = Math.max(0.1, x - F.x);
        if (E === "l") { const nx = Math.min(x, F.x + F.w - 0.1); F.w = F.x + F.w - nx; F.x = nx; }
        if (E === "b" || E === "br") F.d = Math.max(0.1, z - F.z);
        if (E === "t") { const nz = Math.min(z, F.z + F.d - 0.1); F.d = F.z + F.d - nz; F.z = nz; }
        setFootprint(u, F); S.guides = { x: gx, z: gz }; d.moved = true; draw(); paintSizeInputs(u);
      }
      else if (d.kind === "vertex") { d.r.points[d.i] = [snapTo(w.x, 0.1), snapTo(w.z, 0.1)]; d.moved = true; draw(); }
    };
    const up = async e => {
      pts.delete(e.pointerId); S.guides = null;
      if (S.tool === "rect" && S.rect) { const R = S.rect; S.rect = null; const w = Math.abs(R.x1 - R.x0), d = Math.abs(R.z1 - R.z0); if (w < 0.5 || d < 0.5) { draw(); return; } const x0 = Math.min(R.x0, R.x1), z0 = Math.min(R.z0, R.z1); roomDialog(null, [[x0, z0], [x0 + w, z0], [x0 + w, z0 + d], [x0, z0 + d]]); return; }
      const d = S.drag; S.drag = null; if (!d) { draw(); return; } if (d.kind === "pinch") { return; }
      if ((d.kind === "unit" || d.kind === "resize") && d.moved) { const u = unit(d.id); snapUnit(d.orig); try { await saveUnit(u); paintProps(); } catch (e) { Object.assign(u, d.orig); S.undo.pop(); paintUndo(); } draw(); }
      else if (d.kind === "vertex" && d.moved) { snapUndo({ kind: "room", id: d.r.id, points: d.orig }); try { await saveRoom(d.r); } catch (e) { d.r.points = d.orig; S.undo.pop(); paintUndo(); } paintProps(); draw(); }
      else draw();
    };
    cv.onpointerup = up; cv.onpointercancel = up;
    cv.ondblclick = async e => {   // double-click a wall of the selected room to add a corner, or a corner to remove it
      if (S.tool !== "select" || !state.user) return; const w = pt(e), r = S.sel && S.sel.kind === "room" ? room(S.sel.id) : null; if (!r) return;
      const hv = hitVertex(w), orig = r.points.map(q => q.slice());
      if (hv) { if (r.points.length <= 3) return toast("A room needs at least 3 corners."); r.points.splice(hv.i, 1); }
      else { const best = edgeNear(r, w); if (!best) return; r.points.splice(best.i + 1, 0, [snapTo(w.x, 0.1), snapTo(w.z, 0.1)]); }
      snapUndo({ kind: "room", id: r.id, points: orig });
      try { await saveRoom(r); } catch (err) { r.points = orig; S.undo.pop(); paintUndo(); } paintProps(); draw();
    };
    cv.onwheel = e => { e.preventDefault(); const w = pt(e), f = e.deltaY < 0 ? 1.12 : 0.89; S.v.ppm = clamp(S.v.ppm * f, 8, 400); S.v.ox = w.x - w.px / S.v.ppm; S.v.oz = w.z - w.py / S.v.ppm; draw(); };
  }
  function onKey(e) {
    if (!S.view || $("#dlg").open || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) return;
    const ctrl = e.ctrlKey || e.metaKey, u = S.sel && S.sel.kind === "unit" ? unit(S.sel.id) : null;
    if (ctrl && e.key.toLowerCase() === "z") { e.preventDefault(); if (state.user) undo(); return; }
    if (e.key === "Escape") { flushSave(); S.sel = null; S.draft = []; S.rect = null; paintBar(); paintProps(); draw(); return; }
    if (!u || !state.user) return;
    const step = e.shiftKey ? 0.5 : 0.05, mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (mv) { e.preventDefault(); burstSnap(u); u.x = r2(u.x + mv[0]); u.z = r2(u.z + mv[1]); draw(); paintPos(u); scheduleSave(u); return; }
    if (e.key.toLowerCase() === "r" && !ctrl) { e.preventDefault(); turn(u, 90); return; }
    if (ctrl && e.key.toLowerCase() === "d") { e.preventDefault(); addUnit(u.kind, u); return; }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeUnit(u); }
  }
  function turn(u, by) {   // turn about the centre so it stays in place
    flushSave(); snapUnit(u); const f = fp(u), cx = f.x + f.w / 2, cz = f.z + f.d / 2; u.rot = (u.rot + by + 360) % 360; const g = fp(u); u.x = r2(cx - g.w / 2); u.z = r2(cz - g.d / 2);
    saveUnit(u).catch(() => {}); paintProps(); draw();
  }
  async function removeUnit(u) {
    if (!confirm("Remove " + u.name + "? Items stored here become unplaced.")) return;
    await flushSave(); try { await guard(rpcAuth("toolscale_space_remove", { p_kind: "unit", p_id: u.id })); S.sel = null; S.undo = S.undo.filter(x => (x.data?.id || x.id) !== u.id); await load(); await refreshAll(); paintBar(); paintProps(); draw(); } catch (e) {}
  }
  function finishPoly() {
    if (S.draft.length < 3) return; const pts = S.draft.slice(); S.draft = []; S.hover = null; roomDialog(null, pts);
  }
  /* front view of the selected unit: its height and levels, numbered from the floor, with how many items sit on each */
  function paintFront(u) {
    const c = $("#uFront"); if (!c || !u) return; const W = c.width = c.clientWidth || 260, H = c.height = 170, g = c.getContext("2d"), pad = 22;
    g.clearRect(0, 0, W, H); const k = Math.min((W - pad * 2 - 30) / Math.max(u.w, 0.1), (H - pad * 2) / Math.max(u.h, 0.1)), bw = u.w * k, bh = u.h * k, x0 = pad + 26 + (W - pad * 2 - 30 - bw) / 2, y1 = H - pad, y0 = y1 - bh, col = colorOf(u), lt = light(col);
    g.fillStyle = "#C2CBD0"; g.fillRect(0, y1, W, 2);
    g.fillStyle = col; g.fillRect(x0, y0, bw, bh); g.strokeStyle = "#14232B"; g.lineWidth = 1.5; g.strokeRect(x0, y0, bw, bh);
    g.strokeStyle = lt ? "rgba(20,35,43,.6)" : "rgba(255,255,255,.75)"; g.fillStyle = lt ? "#14232B" : "#fff"; g.font = "600 11px sans-serif"; g.textBaseline = "middle";
    const L = u.kind === "bench" ? 1 : u.levels;
    for (let i = 0; i < L; i++) {
      const yb = y1 - bh * i / L, yt = y1 - bh * (i + 1) / L; if (i) { g.beginPath(); g.moveTo(x0 + 2, yb); g.lineTo(x0 + bw - 2, yb); g.stroke(); }
      if (bh / L > 12) { g.textAlign = "left"; g.fillText(String(i + 1), x0 + 5, (yb + yt) / 2); const n = itemsAt(u.id, i + 1).length; if (n) { g.textAlign = "right"; g.fillText(n + " item" + (n > 1 ? "s" : ""), x0 + bw - 5, (yb + yt) / 2); } }
    }
    g.fillStyle = "#14232B"; g.textAlign = "center"; g.font = "600 11px sans-serif"; g.fillText(cm(u.w) + " cm wide", x0 + bw / 2, y0 - 9);
    g.save(); g.translate(x0 - 14, (y0 + y1) / 2); g.rotate(-Math.PI / 2); g.fillText(cm(u.h) + " cm high", 0, 0); g.restore();
  }
  function paintSizeInputs(u) { const s = (id, v) => { const el = $("#" + id); if (el && document.activeElement !== el) el.value = v; }; s("uW", cm(u.w)); s("uD", cm(u.d)); s("uH", cm(u.h)); paintFront(u); paintPos(u); }
  function paintPos(u) { const s = (id, v) => { const el = $("#" + id); if (el && document.activeElement !== el) el.value = v; }; s("uX", r2(u.x)); s("uZ", r2(u.z)); }
  function paintProps() {
    const el = $("#sProps"); if (!el) return; const s = S.sel;
    if (s && s.kind === "room") {
      const r = room(s.id); if (!r) return; const inside = S.units.filter(u => roomOf(u) === r);
      el.innerHTML = `<h2>${esc(r.name)}</h2><p>${r2(area(r.points))} m², ${r.points.length} corners, walls ${r.h} m high.</p><p class="hint">${inside.length} shelf or cabinet${inside.length === 1 ? "" : "s"} inside. Drag a corner to reshape the room. Double-click a wall to add a corner, or a corner to remove it. Wall lengths are shown on the plan.</p>
        <div class="row" style="margin-top:10px"><button class="btn sec" id="rEdit">Rename or change height</button><button class="btn danger" id="rDel">Remove room</button></div>`;
      $("#rEdit").onclick = () => requireAuth(() => roomDialog(r));
      $("#rDel").onclick = () => requireAuth(async () => { if (!confirm("Remove " + r.name + "? The shelves and cabinets stay where they are.")) return; try { await guard(rpcAuth("toolscale_space_remove", { p_kind: "room", p_id: r.id })); S.sel = null; S.undo = S.undo.filter(x => x.id !== r.id); await load(); await refreshAll(); paintBar(); paintProps(); draw(); } catch (e) {} });
      return;
    }
    const u = s && s.kind === "unit" ? unit(s.id) : null;
    if (!u) { el.innerHTML = `<h2>Your space</h2><p>${S.rooms.length} room${S.rooms.length === 1 ? "" : "s"}, ${S.units.length} shelf or cabinet${S.units.length === 1 ? "" : "s"}.</p><p class="hint">Use <strong>Room: rectangle</strong> or <strong>Room: corners</strong> to draw a room. Use the <strong>Add</strong> buttons for shelves and cabinets. Click one to change its size, height, levels and colour.</p>`; return; }
    const its = itemsAt(u.id), rm = roomOf(u), col = colorOf(u), ro = !state.user;
    const sw = c => `<button type="button" class="sw" data-col="${c}" title="${c}" aria-label="Colour ${c}" style="background:${c};${c.toUpperCase() === col.toUpperCase() ? "outline:3px solid var(--hivis);outline-offset:1px" : ""}"></button>`;
    el.innerHTML = `<style>.sw{width:26px;height:26px;border:1px solid #14232B;cursor:pointer;padding:0}.pgrp{border:0;border-top:1px solid var(--line);padding:10px 0 0;margin:10px 0 0}.pgrp legend{font:600 18px var(--display);padding:0 6px 0 0}.mini{width:38px;padding:0;min-height:42px}</style>
      <fieldset style="border:0;padding:0;margin:0" ${ro ? "disabled" : ""}>
      ${ro ? `<p class="status-line err" style="margin-top:0">Sign in (top right) to edit.</p>` : ""}
      <div class="row"><div class="field" style="min-width:150px"><label for="uName">Name</label><input id="uName" type="text" maxlength="40" value="${esc(u.name)}"></div>
        <div class="field" style="min-width:120px;max-width:150px"><label for="uKind">Type</label><select id="uKind" class="sel">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${k === u.kind ? "selected" : ""}>${v.label}</option>`).join("")}</select></div></div>
      <p class="hint">${rm ? "In " + esc(rm.name) : "Not inside a room"}</p>
      <fieldset class="pgrp"><legend>Size</legend>
        <div class="row"><div class="field" style="min-width:70px"><label for="uW">Width (cm)</label><input id="uW" type="number" step="5" min="10" max="3000" value="${cm(u.w)}"></div>
          <div class="field" style="min-width:70px"><label for="uD">Depth (cm)</label><input id="uD" type="number" step="5" min="10" max="3000" value="${cm(u.d)}"></div>
          <div class="field" style="min-width:70px"><label for="uH">Height (cm)</label><input id="uH" type="number" step="5" min="10" max="1000" value="${cm(u.h)}"></div></div>
        <div style="margin-top:8px"><label for="uPre">Common sizes</label><select id="uPre" class="sel"><option value="">Pick a size...</option>${(PRESETS[u.kind] || []).map(p => `<option value="${p.join(",")}">${p[0]} × ${p[1]} × ${p[2]} cm</option>`).join("")}</select></div></fieldset>
      <fieldset class="pgrp"><legend>${u.kind === "drawers" ? "Drawers" : "Levels"}</legend>
        <div class="row" style="align-items:center"><button type="button" class="btn sec mini" id="uLm" aria-label="One less">−</button><input id="uL" type="number" step="1" min="1" max="30" value="${u.levels}" style="width:70px;text-align:center" aria-label="Levels"><button type="button" class="btn sec mini" id="uLp" aria-label="One more">+</button><span class="hint" style="margin:0">numbered from the floor up</span></div>
        <canvas id="uFront" style="width:100%;height:170px;display:block;margin-top:8px;background:#fff;border:1px solid var(--line)"></canvas></fieldset>
      <fieldset class="pgrp"><legend>Colour</legend>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${SWATCH.map(sw).join("")}<label style="display:flex;gap:6px;align-items:center;margin:0 0 0 4px;font-weight:400"><input type="color" id="uCol" value="${col}" style="width:34px;height:28px;padding:0;border:1px solid #14232B"> Other</label>
        <button type="button" class="linkbtn" id="uColDef" style="color:var(--steel);padding:0 4px">Default</button></div></fieldset>
      <fieldset class="pgrp"><legend>Position</legend>
        <div class="row"><div class="field" style="min-width:70px"><label for="uX">Left edge (m)</label><input id="uX" type="number" step="0.05" value="${r2(u.x)}"></div><div class="field" style="min-width:70px"><label for="uZ">Top edge (m)</label><input id="uZ" type="number" step="0.05" value="${r2(u.z)}"></div></div>
        <div class="row" style="margin-top:8px;align-items:center"><button type="button" class="btn sec" id="uRotL" aria-label="Turn left">↺ Turn</button><button type="button" class="btn sec" id="uRot" aria-label="Turn right">Turn ↻</button><span class="hint" style="margin:0">Front faces ${facing(u.rot)} on the plan (white edge)</span></div></fieldset>
      <div class="row" style="margin-top:12px"><button type="button" class="btn sec" id="uDup">Copy</button><button type="button" class="btn sec" id="u3d">See in 3D</button><button type="button" class="btn danger" id="uDel">Remove</button></div>
      </fieldset>
      <p class="hint" style="margin-top:10px">${its.length ? its.length + " item" + (its.length > 1 ? "s" : "") + " stored here: " + esc(its.slice(0, 6).map(itemName).join(", ")) + (its.length > 6 ? "…" : "") : "Nothing stored here yet. Place items under Setup, Place items."}</p>`;
    paintFront(u);
    const change = (fn, now) => { if (!state.user) return; burstSnap(u); fn(); draw(); paintFront(u); if (now) { clearTimeout(S.saveT); S.pending = u; flushSave(); } else scheduleSave(u); };
    const numIn = (id, key, lo, hi, div) => { $("#" + id).oninput = e => { const v = Number(e.target.value); if (!(v >= lo && v <= hi)) return; change(() => { u[key] = r2(v / div); }); }; };
    numIn("uW", "w", 10, 3000, 100); numIn("uD", "d", 10, 3000, 100); numIn("uH", "h", 10, 1000, 100);
    $("#uX").oninput = e => { const v = Number(e.target.value); if (e.target.value === "" || isNaN(v)) return; change(() => { u.x = r2(v); }); };
    $("#uZ").oninput = e => { const v = Number(e.target.value); if (e.target.value === "" || isNaN(v)) return; change(() => { u.z = r2(v); }); };
    $("#uName").oninput = e => { const v = e.target.value.trim(); if (v) change(() => { u.name = v; }); };
    $("#uKind").onchange = e => { change(() => { u.kind = e.target.value; }, true); paintProps(); };
    $("#uPre").onchange = e => { if (!e.target.value) return; const [a, b, c] = e.target.value.split(",").map(Number); change(() => { u.w = a / 100; u.d = b / 100; u.h = c / 100; }, true); paintSizeInputs(u); e.target.value = ""; };
    const setL = v => { v = clamp(Math.round(v) || 1, 1, 30); $("#uL").value = v; change(() => { u.levels = v; }); };
    $("#uL").oninput = e => { if (e.target.value) setL(Number(e.target.value)); };
    $("#uLm").onclick = () => setL(u.levels - 1); $("#uLp").onclick = () => setL(u.levels + 1);
    el.querySelectorAll(".sw").forEach(b => b.onclick = () => { change(() => { u.color = b.dataset.col; }, true); paintProps(); });
    $("#uCol").oninput = e => change(() => { u.color = e.target.value.toUpperCase(); });
    $("#uCol").onchange = () => paintProps();
    $("#uColDef").onclick = () => { change(() => { u.color = null; }, true); paintProps(); };
    $("#uRot").onclick = () => turn(u, 90); $("#uRotL").onclick = () => turn(u, -90);
    $("#uDup").onclick = () => requireAuth(() => addUnit(u.kind, u));
    $("#u3d").onclick = async () => { await flushSave(); state.spaceFocusUnit = u.id; setTab("s3d"); };
    $("#uDel").onclick = () => requireAuth(() => removeUnit(u));
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
    $("#s3Msg").textContent = S.rooms.length || S.units.length ? "" : "Nothing drawn yet. Draw rooms and shelves under Setup, Space plan."; paintSide();
    if (state.spaceFocus) { const f = state.spaceFocus; state.spaceFocus = null; S.find = ""; focusItem(f.kind, f.id); }
    else if (state.spaceFocusUnit && unit(state.spaceFocusUnit)) { S.hl = state.spaceFocusUnit; S.sel = { kind: "unit", id: S.hl }; state.spaceFocusUnit = null; focusUnit(S.hl); paintSide(); }
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
      const f = fp(u), m = new T.MeshStandardMaterial({ color: u.color ? parseInt(u.color.slice(1), 16) : KINDS[u.kind]?.c3 || 0x3A87AA, roughness: .6, metalness: .05, emissive: 0x000000 }), o = new T.Mesh(B(f.w, u.h, f.d), m);
      o.position.set(f.x + f.w / 2, u.h / 2, f.z + f.d / 2); o.userData.unit = u.id; root.add(o); k.pick.push(o); k.unitM[u.id] = o;
      const e = new T.LineSegments(new T.EdgesGeometry(B(f.w, u.h, f.d)), new T.LineBasicMaterial({ color: 0xE6EEF1 })); e.position.copy(o.position); root.add(e);
      const lt = label(u.name, 0.8); lt.position.set(f.x + f.w / 2, u.h + 0.25, f.z + f.d / 2); root.add(lt);
      if (u.kind !== "bench" && u.levels > 1) {   // level lines on the front, so you can count to the right shelf
        const x0 = f.x, x1 = f.x + f.w, z0 = f.z, z1 = f.z + f.d, o2 = 0.004, ends = { 0: [[x0, z1 + o2], [x1, z1 + o2]], 90: [[x0 - o2, z0], [x0 - o2, z1]], 180: [[x0, z0 - o2], [x1, z0 - o2]], 270: [[x1 + o2, z0], [x1 + o2, z1]] }[u.rot] || [[x0, z1 + o2], [x1, z1 + o2]], segs = [];
        for (let i = 1; i < u.levels; i++) { const y = u.h * i / u.levels; segs.push(new T.Vector3(ends[0][0], y, ends[0][1]), new T.Vector3(ends[1][0], y, ends[1][1])); }
        root.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(segs), new T.LineBasicMaterial({ color: u.color && light(u.color) ? 0x14232B : 0xE6EEF1 })));
      }
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
    const x = allItems().find(a => a.kind === kind && String(a.it.id) === String(id)); if (!x) return; if (!x.it.unit_id || !unit(x.it.unit_id)) { toast(itemName(x) + " has no place yet. Set one under Setup, Place items."); return; }
    S.hl = x.it.unit_id; S.sel = { kind: "unit", id: S.hl }; S.focusItem = kind + ":" + x.it.id; focusUnit(S.hl); paintSide();
  }
  function paintSide() {
    const el = $("#s3Side"); if (!el) return; const u = S.sel && S.sel.kind === "unit" ? unit(S.sel.id) : null;
    const find = `<div class="field"><label for="sFind">What are you looking for?</label><input id="sFind" type="text" placeholder="e.g. cutter, M6, screw" value="${esc(S.find || "")}" autocomplete="off"></div><div id="sRes" style="margin-top:8px"></div>`;
    if (!u) { el.innerHTML = find + `<p class="hint" style="margin-top:12px">Or click a shelf or cabinet in the 3D view to see what is inside.</p>`; bindFind(); showRes(); return; }
    const rm = roomOf(u);
    el.innerHTML = find + `<h2 style="margin-top:16px">${esc(u.name)}</h2><p class="hint">${rm ? esc(rm.name) + ". " : ""}Level 1 is the lowest.</p>
      ${Array.from({ length: u.levels }, (_, i) => u.levels - i).map(lv => { const its = itemsAt(u.id, lv); return its.length ? `<div style="border-top:1px solid var(--line);padding:6px 0"><strong>Level ${lv}</strong>${its.map(x => `<div style="font-size:14px;${S.focusItem === x.kind + ":" + x.it.id ? "font-weight:700" : ""}"><i class="lg" style="background:${x.kind === "tool" ? "#F2C200" : "#2FB3B3"}"></i>${esc(itemName(x))}${x.kind === "tool" && x.it.status === "out" ? " (out)" : ""}</div>`).join("")}</div>` : ""; }).join("") || `<p class="hint">Nothing stored here yet.</p>`}
      <div class="row" style="margin-top:10px"><button class="btn sec" id="sEdit">Edit in space plan</button></div>`;
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
    $("#main").innerHTML = `<div class="summary"><div><h1>Place items</h1><p>Say where each tool and consumable lives: which shelf or cabinet, and which level (1 is the lowest). Then Find can show it in 3D.</p></div></div>
      <div class="row" style="margin-bottom:12px"><div class="field"><label for="iQ">Search</label><input id="iQ" type="text" placeholder="name or size"></div><label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="iUn"> Not placed yet only</label></div><div id="iList"></div>`;
    try { await load(); } catch (e) { return; } if (S.view !== me) return;
    const paint = () => {
      const q = $("#iQ").value.trim().toLowerCase(), un = $("#iUn").checked, list = allItems().filter(x => (!q || itemName(x).toLowerCase().includes(q)) && (!un || !unit(x.it.unit_id)));
      const ops = uid => S.units.map(uu => { const rm = roomOf(uu); return `<option value="${uu.id}" ${uu.id === uid ? "selected" : ""}>${esc((rm ? rm.name + " · " : "") + uu.name)}</option>`; }).join("");
      $("#iList").innerHTML = S.units.length ? `<div class="tablewrap"><table class="cards"><thead><tr><th>Item</th><th>Type</th><th>Now</th><th>Shelf or cabinet</th><th>Level</th><th></th></tr></thead><tbody>${list.map(x => `<tr data-k="${x.kind}" data-id="${x.it.id}"><td><strong>${esc(itemName(x))}</strong></td><td>${x.kind === "tool" ? "Tool" : "Consumable"}</td><td>${esc(whereOf(x.it) || "Not placed")}</td>
        <td><select class="sel iU"><option value="">Not placed</option>${ops(x.it.unit_id)}</select></td><td><select class="sel iL" style="min-width:70px"></select></td><td><button class="btn sec iGo">Place</button></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty"><p>Draw some shelves or cabinets under Setup, Space plan, first.</p></div>`;
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
