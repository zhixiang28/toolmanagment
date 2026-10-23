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
    desk: { label: "PC desk", w: 1.4, d: 0.7, h: 0.75, levels: 1, fill: "#A8793F", c3: 0xC7955A },
    rack: { label: "Rack", w: 1.2, d: 0.5, h: 1.8, levels: 4, fill: "#5B6B73", c3: 0x9BA7AD },
    box: { label: "Box", w: 0.4, d: 0.3, h: 0.25, levels: 1, fill: "#D9822B", c3: 0xE39A4A },
  };
  /* what the Add buttons make; a wall cabinet is a cabinet that hangs 120 cm up */
  const ADDS = { shelf: {}, cabinet: {}, wall: { kind: "cabinet", label: "Wall cabinet", w: 0.8, d: 0.35, h: 0.6, levels: 2, elev: 1.2 }, drawers: {}, bench: {}, desk: {}, rack: {} };
  const ADD_LABEL = { shelf: "Shelf", cabinet: "Cabinet", wall: "Wall cabinet", drawers: "Drawer unit", bench: "Workbench", desk: "PC desk", rack: "Rack" };
  const S = { rooms: [], units: [], sel: null, tool: "select", draft: [], rect: null, v: { ox: -1, oz: -1, ppm: 60 }, view: null, t: null, find: "", hl: null, drag: null, hover: null, undo: [], burst: false, pending: null, saveT: null, guides: null, keys: null, esize: (() => { try { return localStorage.getItem("sp_esize") || "M"; } catch (e) { return "M"; } })(), ev: null, eg: null, eview: (() => { try { return localStorage.getItem("sp_view") || "S"; } catch (e) { return "S"; } })(), open: {} };
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b), r2 = v => Math.round(v * 100) / 100, snapTo = (v, s) => Math.round(v / s) * s;
  const num = o => { const r = { ...o }; ["w", "d", "h", "x", "z", "rot", "levels"].forEach(k => { if (k in r) r[k] = Number(r[k]); }); r.elev = Number(r.elev || 0); r.parent_level = r.parent_level == null ? null : Number(r.parent_level); if (Array.isArray(r.points)) r.points = r.points.map(p => [Number(p[0]), Number(p[1])]); return r; };
  const fp = u => { const sw = u.rot % 180 !== 0; return { x: u.x, z: u.z, w: sw ? u.d : u.w, d: sw ? u.w : u.d }; };
  const unit = id => S.units.find(u => u.id === id), room = id => S.rooms.find(r => r.id === id);
  /* which way is "right along the front" (R) and "towards the back" (F) for each way a unit can face */
  const DIR = { 0: { R: [1, 0], F: [0, -1] }, 90: { R: [0, 1], F: [1, 0] }, 180: { R: [-1, 0], F: [0, 1] }, 270: { R: [0, -1], F: [-1, 0] } };
  const isTable = u => u.kind === "desk" || u.kind === "bench";   // a top on legs, with room underneath
  const vrange = u => isTable(u) ? [(u.elev || 0) + u.h - 0.05, (u.elev || 0) + u.h] : [u.elev || 0, (u.elev || 0) + u.h];   // a table only fills its top: the space under it is free
  const overlaps2d = (a, b) => { const f = fp(a), g = fp(b); return f.x < g.x + g.w - 0.001 && g.x < f.x + f.w - 0.001 && f.z < g.z + g.d - 0.001 && g.z < f.z + f.d - 0.001; };
  const clashes = u => tops().filter(o => o.id !== u.id && o.kind !== "rack" && u.kind !== "rack" && overlaps2d(u, o) && vrange(u)[0] < vrange(o)[1] - 0.001 && vrange(o)[0] < vrange(u)[1] - 0.001);
  const parentOf = b => b.parent_id ? unit(b.parent_id) : null;
  const kids = r => S.units.filter(b => b.parent_id === r.id).sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")) || String(a.id).localeCompare(String(b.id)));
  const tops = () => S.units.filter(u => !parentOf(u));   // boxes on a rack live inside the rack, not on the floor plan
  /* boxes sit on a rack level in the order they were added, left to right */
  function boxLayout(r) {
    const f = fp(r), cx = f.x + f.w / 2, cz = f.z + f.d / 2, D = DIR[r.rot] || DIR[0], lh = r.h / r.levels, T = 0.03, acc = {}, out = [];
    for (const b of kids(r)) {
      const L = clamp(b.parent_level || 1, 1, r.levels); acc[L] = acc[L] ?? 0.02; const left = acc[L], along = -r.w / 2 + left + b.w / 2; acc[L] += b.w + 0.02;
      const alongX = D.R[0] !== 0;
      out.push({ b, L, left, cx: cx + D.R[0] * along, cz: cz + D.R[1] * along, y: r.elev + (L - 1) * lh + T, wx: alongX ? b.w : b.d, wz: alongX ? b.d : b.w, h: b.h, over: left + b.w > r.w + 0.001 || b.d > r.d + 0.001 || b.h > lh - T + 0.001 });
    }
    return out;
  }
  function anchor(u) {   // where a unit is in space: centre on the floor plan and bottom and top heights
    const p = parentOf(u);
    if (p) { const e = boxLayout(p).find(x => x.b.id === u.id); if (e) return { x: e.cx, z: e.cz, y0: e.y, y1: e.y + e.h, w: e.wx, d: e.wz }; }
    const f = fp(u); return { x: f.x + f.w / 2, z: f.z + f.d / 2, y0: u.elev || 0, y1: (u.elev || 0) + u.h, w: f.w, d: f.d };
  }
  const loadScript = src => new Promise((res, rej) => { const el = document.createElement("script"); el.src = src; el.onload = res; el.onerror = () => rej(new Error("Could not load " + src)); document.head.appendChild(el); });
  const allItems = () => [...state.tools.map(it => ({ kind: "tool", it })), ...state.citems.map(it => ({ kind: "consumable", it }))];
  const itemsAt = (uid, lvl) => allItems().filter(x => x.it.unit_id === uid && (lvl == null || Number(x.it.level) === lvl));
  const itemName = x => x.it.name + (x.it.spec ? " " + x.it.spec : "");
  const inPoly = (x, z, pts) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, zi] = pts[i], [xj, zj] = pts[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; };
  const area = pts => { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]); return Math.abs(a / 2); };
  const centroid = pts => { const n = pts.length; return [pts.reduce((a, p) => a + p[0], 0) / n, pts.reduce((a, p) => a + p[1], 0) / n]; };
  const roomOf = u => { const b = parentOf(u) || u, f = fp(b), cx = f.x + f.w / 2, cz = f.z + f.d / 2; for (let i = S.rooms.length - 1; i >= 0; i--) if (inPoly(cx, cz, S.rooms[i].points)) return S.rooms[i]; return null; };
  const unitPath = u => { const p = parentOf(u), r = roomOf(u); return (r ? r.name + " · " : "") + (p ? p.name + " · level " + u.parent_level + " · " : "") + u.name; };
  const whereOf = it => { const u = unit(it.unit_id); if (!u) return null; return unitPath(u) + (u.parent_id ? "" : " · level " + it.level); };
  const contents = u => [...itemsAt(u.id), ...kids(u).flatMap(b => itemsAt(b.id))];

  async function load() {
    const [rooms, units] = await Promise.all([guard(sb.from("space_rooms").select("*").eq("active", true).order("created_at")), guard(sb.from("space_units").select("*").eq("active", true).order("created_at"))]);
    S.rooms = rooms.map(num).filter(r => Array.isArray(r.points) && r.points.length >= 3); S.units = units.map(num);
    if (S.sel && !(S.sel.kind === "unit" ? unit(S.sel.id) : room(S.sel.id))) S.sel = null;
  }
  const saveRoom = r => guard(rpcAuth("toolscale_space_room_poly", { p_id: r.id || null, p_name: r.name, p_points: r.points.map(p => [r2(p[0]), r2(p[1])]), p_h: r2(r.h) }));
  const saveUnit = u => { const rm = roomOf(u), p = parentOf(u); if (p) { u.x = p.x; u.z = p.z; } return guard(rpcAuth("toolscale_space_unit_v2", { p_id: u.id || null, p_room: rm ? rm.id : null, p_kind: u.kind, p_name: u.name, p_x: r2(u.x), p_z: r2(u.z), p_w: r2(u.w), p_d: r2(u.d), p_h: r2(u.h), p_rot: u.rot, p_levels: u.levels, p_color: u.color || null, p_elev: r2(u.elev || 0), p_parent: u.parent_id || null, p_plevel: u.parent_id ? (u.parent_level || 1) : null })); };
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
    desk: [[140, 70, 75], [160, 80, 75], [120, 60, 75], [180, 80, 75]],
    rack: [[120, 50, 180], [100, 40, 200], [150, 60, 200], [80, 40, 150]],
  };
  const colorOf = u => u.color || KINDS[u.kind]?.fill || "#24607A";
  const light = hex => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) > 160; };
  const cm = m => Math.round(m * 100);
  const facing = rot => ({ 0: "down", 90: "left", 180: "up", 270: "right" })[rot] || "down";
  function bounds() {
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9; const add = (x, z) => { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); };
    S.rooms.forEach(r => r.points.forEach(p => add(p[0], p[1]))); tops().forEach(u => { const f = fp(u); add(f.x, f.z); add(f.x + f.w, f.z + f.d); });
    if (x0 > x1) { x0 = 0; z0 = 0; x1 = 12; z1 = 8; } return { x0, z0, x1, z1 };
  }
  function fitView() {
    const cv = $("#sCv"); if (!cv) return; const b = bounds(), pad = 1, w = b.x1 - b.x0 + 2 * pad, h = b.z1 - b.z0 + 2 * pad;
    const ppm = Math.min(cv.width / Math.max(w, 6), cv.height / Math.max(h, 4)); S.v = { ppm, ox: b.x0 - pad - (cv.width / ppm - w) / 2, oz: b.z0 - pad - (cv.height / ppm - h) / 2 };
  }
  /* the page's own styles, added once */
  function ensureStyle() {
    if (document.getElementById("spStyle")) return; const st = document.createElement("style"); st.id = "spStyle";
    st.textContent = `.sptool{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--panel);border:1px solid var(--line);padding:8px 10px;margin-bottom:12px}
.sptool .grow{flex:1}.sptool .btn{min-height:38px;padding:4px 12px}
.seg{display:inline-flex;border:2px solid var(--ink);background:#fff;max-width:100%;overflow-x:auto;scrollbar-width:none;flex:0 0 auto}
.seg button{flex:0 0 auto}
@media(max-width:560px){.seg button{padding:6px 8px;font-size:14px}.sptool{gap:8px}}
.seg button{border:0;background:#fff;padding:6px 12px;cursor:pointer;font-weight:600;min-height:36px;white-space:nowrap}
.seg button+button{border-left:2px solid var(--ink)}
.seg .ts{display:none}
@media(max-width:560px){.seg .tl{display:none}.seg .ts{display:inline}.vwh .hint{white-space:nowrap}}
.seg button[aria-pressed=true]{background:var(--ink);color:#fff}
.addm{position:relative}.addm>summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;background:var(--hivis);border:2px solid var(--ink);padding:4px 14px;min-height:38px;font-weight:700}
.addm>summary::-webkit-details-marker{display:none}
.addp{position:absolute;z-index:8;top:calc(100% + 6px);left:0;background:#fff;border:2px solid var(--ink);padding:8px;display:grid;grid-template-columns:repeat(2,minmax(150px,1fr));gap:6px;box-shadow:0 8px 24px rgba(20,35,43,.25)}
.addp button{display:flex;gap:8px;align-items:center;text-align:left;border:1px solid var(--line);background:var(--panel);padding:8px 10px;cursor:pointer;font-weight:600}
.addp button:hover{border-color:var(--ink)}.addp i{width:22px;height:16px;flex:none;border:1px solid #14232B}
.spcol{display:grid;gap:12px;min-width:0;align-content:start}
.vw{padding:0;overflow:hidden}
.vwh{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:6px 12px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.vwh strong{font:600 20px var(--display)}.vwh .seg button{padding:3px 10px;min-height:30px;font-size:14px}
.vw canvas{width:100%;display:block;touch-action:none;background:#EEF1F2}.vw .hint{margin:0;padding:6px 12px}
.spprops{align-self:start}
.split.wide .spcol{display:contents}.split.wide .vtop{grid-column:1;grid-row:1}.split.wide .spprops{grid-column:2;grid-row:1;position:static;max-height:none;overflow:visible}.split.wide .vfront{grid-column:1/-1;grid-row:2}
@media(max-width:760px){.split.wide .spprops{grid-column:1;grid-row:3}.split.wide .vfront{grid-row:2}.split.wide .vtop{grid-row:1}}
@media(min-width:761px){.spprops{position:sticky;top:176px;max-height:calc(100vh - 192px);overflow:auto}}
details.acc{border-top:1px solid var(--line)}
details.acc>summary{cursor:pointer;font:600 19px var(--display);padding:8px 0;list-style:none;display:flex;justify-content:space-between;align-items:center}
details.acc>summary::-webkit-details-marker{display:none}
details.acc>summary::after{content:"\\25BE";font-size:14px;color:var(--ink-2)}
details.acc:not([open])>summary::after{content:"\\25B8"}
.accb{padding:0 0 12px}
.chipk{display:inline-block;font-size:12px;font-weight:600;background:var(--ink);color:#fff;padding:1px 8px;margin-left:6px;vertical-align:middle}
.nudge{display:grid;grid-template-columns:repeat(3,42px);gap:4px}
.nudge button,.nbtn{min-height:40px;border:2px solid var(--ink);background:#fff;cursor:pointer;font-weight:700;padding:0 8px}
.nudge button:active,.nbtn:active{background:var(--hivis)}
.sw{width:26px;height:26px;border:1px solid #14232B;cursor:pointer;padding:0}.mini{width:38px;padding:0;min-height:42px}
.bxr{display:flex;gap:6px;align-items:center;justify-content:space-between;border:1px solid var(--line);background:#fff;padding:4px 8px;margin:3px 0;font-size:14px;cursor:pointer;width:100%;text-align:left}.bxr.over{border-color:var(--alert)}`;
    document.head.appendChild(st);
  }
  async function plan() {
    stop(); ensureStyle(); const me = S.view = {};
    $("#main").innerHTML = `<div class="summary"><div><h1>Space plan</h1><p>Draw rooms from above, then place shelves, cabinets, desks and racks. Drag in the <strong>top view</strong> to move along the floor, and in the <strong>front view</strong> to move sideways and up or down.</p></div></div>
      <div class="sptool" id="sBar"></div>
      <div class="split" id="spSplit"><div class="spcol">
        <div class="panel vw vtop"><div class="vwh"><strong>Top view</strong><span class="hint" style="margin:0;padding:0" id="sInfo"></span></div><canvas id="sCv"></canvas><p class="hint" id="sHint"></p></div>
        <div class="panel vw vfront"><div class="vwh"><strong id="eTitle">Front view</strong><span style="display:flex;gap:8px;align-items:center"><span class="hint" style="margin:0;padding:0">Seen from</span><span class="seg" id="eSeg" role="group" aria-label="Which side to look from"></span><span class="seg" id="eSz" role="group" aria-label="Size of this view"></span><span class="seg" id="eZ" role="group" aria-label="Zoom this view"><button data-ez="out" aria-label="Zoom out">−</button><button data-ez="in" aria-label="Zoom in">＋</button><button data-ez="fit">Fit</button></span></span></div><canvas id="eCv"></canvas><p class="hint" id="eHint"></p></div></div>
        <div class="panel spprops" id="sProps"></div></div>`;
    try { await load(); } catch (e) { return; } if (S.view !== me) return;
    sizeCanvas(); fitView(); fitFront(); paintBar(); paintSeg(); paintProps(); draw(); bindCanvas(); bindFront();
    window.onresize = () => { if (S.view === me) { sizeCanvas(); fitFront(); draw(); } };
    S.keys = onKey; document.addEventListener("keydown", S.keys);
  }
  function sizeCanvas() {
    const cv = $("#sCv"), ev = $("#eCv"), sp = $("#spSplit"); if (!cv || !ev) return; sp.classList.toggle("wide", S.esize === "L");   // the large front view takes the full width
    const w = Math.max(280, cv.parentElement.clientWidth), ew = Math.max(280, ev.parentElement.clientWidth);
    cv.width = w; cv.height = Math.round(clamp(w * 0.54, 280, 440)); ev.width = ew;
    ev.height = Math.round(({ S: clamp(ew * 0.36, 210, 270), M: clamp(ew * 0.5, 300, 420), L: clamp(ew * 0.5, 420, 640) })[S.esize] || 300);
  }
  function paintBar() {
    const el = $("#sBar"); if (!el) return; const t = S.tool, T = (id, label) => `<button data-tool="${id}" aria-pressed="${t === id}">${label}</button>`;
    el.innerHTML = `<span class="seg" role="group" aria-label="Tool">${T("select", "<span class=\"tl\">Select / move</span><span class=\"ts\">Select</span>")}${T("rect", "<span class=\"tl\">Room: rectangle</span><span class=\"ts\">Rect room</span>")}${T("poly", "<span class=\"tl\">Room: corners</span><span class=\"ts\">Corner room</span>")}</span>
      <details class="addm" id="addm"><summary>＋ Add</summary><div class="addp">${Object.entries(ADD_LABEL).map(([k, l]) => { const kd = KINDS[(ADDS[k] || {}).kind || k]; return `<button type="button" data-add="${k}"><i style="background:${kd.fill}"></i>${l}</button>`; }).join("")}</div></details>
      <span class="grow"></span><button class="btn sec" id="sUndo" title="Undo (Ctrl+Z)" ${S.undo.length ? "" : "disabled"}>↶ Undo</button><span class="seg"><button id="zOut" aria-label="Zoom out">−</button><button id="zIn" aria-label="Zoom in">＋</button><button id="zFit">Fit</button></span>
      ${t === "poly" ? `<span class="row" style="width:100%"><button class="btn" id="pFin" ${S.draft.length >= 3 ? "" : "disabled"}>Finish room</button><button class="btn sec" id="pUndo" ${S.draft.length ? "" : "disabled"}>Undo corner</button><button class="btn sec" id="pCancel">Cancel</button></span>` : ""}`;
    el.querySelectorAll("[data-tool]").forEach(b => b.onclick = () => { S.tool = b.dataset.tool; S.draft = []; S.rect = null; S.hover = null; paintBar(); draw(); });
    el.querySelectorAll("[data-add]").forEach(b => b.onclick = () => { $("#addm").open = false; requireAuth(() => addUnit(b.dataset.add)); });
    const zoom = f => { const cv = $("#sCv"), cx = S.v.ox + cv.width / 2 / S.v.ppm, cz = S.v.oz + cv.height / 2 / S.v.ppm; S.v.ppm = clamp(S.v.ppm * f, 8, 400); S.v.ox = cx - cv.width / 2 / S.v.ppm; S.v.oz = cz - cv.height / 2 / S.v.ppm; draw(); };
    $("#zIn").onclick = () => zoom(1.25); $("#zOut").onclick = () => zoom(0.8); $("#zFit").onclick = () => { fitView(); fitFront(); draw(); }; $("#sUndo").onclick = () => requireAuth(undo);
    const fin = $("#pFin"); if (fin) fin.onclick = finishPoly; const un = $("#pUndo"); if (un) un.onclick = () => { S.draft.pop(); paintBar(); draw(); }; const ca = $("#pCancel"); if (ca) ca.onclick = () => { S.draft = []; S.tool = "select"; paintBar(); draw(); };
  }
  async function addUnit(key, from) {
    await flushSave(); const cv = $("#sCv"), sp = ADDS[key] || {}, kind = from ? from.kind : (sp.kind || key), k = KINDS[kind], label = sp.label || k.label, n = S.units.filter(x => x.name.startsWith(label)).length + 1;
    const u = from ? { ...from, id: null, name: from.name + " copy" } : { kind, name: label + " " + n, w: sp.w ?? k.w, d: sp.d ?? k.d, h: sp.h ?? k.h, rot: 0, levels: sp.levels ?? k.levels, color: null, elev: sp.elev ?? 0 };
    if (from && from.parent_id) { /* a copy of a box stays on the same rack */ }
    else if (from) { const f = fp(from); u.x = snapTo(from.x + (f.w < f.d ? f.w : 0) + 0.05, 0.05); u.z = snapTo(from.z + (f.w < f.d ? 0 : f.d) + 0.05, 0.05); }   // copies go right next to the original
    else { u.x = snapTo(S.v.ox + cv.width / 2 / S.v.ppm - u.w / 2, 0.05); u.z = snapTo(S.v.oz + cv.height / 2 / S.v.ppm - u.d / 2, 0.05); }
    if (!from && key === "wall" && !snapToWall(u, true)) toast("Drag it against a wall, then press Snap to wall.");
    try { const id = await saveUnit(u); snapUndo({ kind: "add", id }); await load(); S.sel = { kind: "unit", id }; paintProps(); draw(); } catch (e) {}
  }
  /* put a unit's back against the nearest straight wall (within 1.5 m), facing into the room */
  function snapToWall(u, quiet) {
    const f0 = fp(u), cx = f0.x + f0.w / 2, cz = f0.z + f0.d / 2; let best = null;
    for (const r of S.rooms) for (let i = 0; i < r.points.length; i++) {
      const a = r.points[i], b = r.points[(i + 1) % r.points.length], horiz = Math.abs(a[1] - b[1]) < 1e-6, vert = Math.abs(a[0] - b[0]) < 1e-6; if (!horiz && !vert) continue;
      const lo = horiz ? Math.min(a[0], b[0]) : Math.min(a[1], b[1]), hi = horiz ? Math.max(a[0], b[0]) : Math.max(a[1], b[1]), pos = horiz ? cz : cx, at = horiz ? cx : cz, wall = horiz ? a[1] : a[0];
      const dist = Math.abs(pos - wall) + (at < lo ? lo - at : at > hi ? at - hi : 0), mid = (lo + hi) / 2, plus = horiz ? inPoly(mid, wall + 0.05, r.points) : inPoly(wall + 0.05, mid, r.points);
      if (!best || dist < best.dist) best = { dist, horiz, lo, hi, wall, plus };
    }
    if (!best || best.dist > 1.5) { if (!quiet) toast("No straight wall within 1.5 m. Drag it closer to a wall first."); return false; }
    if (!quiet) snapUnit(u);
    if (best.horiz) { u.rot = best.plus ? 0 : 180; const g = fp(u); u.z = r2(best.plus ? best.wall : best.wall - g.d); u.x = r2(clamp(cx - g.w / 2, best.lo, Math.max(best.lo, best.hi - g.w))); }
    else { u.rot = best.plus ? 270 : 90; const g = fp(u); u.x = r2(best.plus ? best.wall : best.wall - g.w); u.z = r2(clamp(cz - g.d / 2, best.lo, Math.max(best.lo, best.hi - g.d))); }
    return true;
  }
  async function addUnderUnit(top, key) {   // something standing on the floor beneath a wall cabinet, back to the same wall
    await flushSave(); const sp = ADDS[key] || {}, kind = sp.kind || key, k = KINDS[kind], gap = (top.elev || 0) - 0.05;
    if (gap < 0.2) return toast("Raise the cabinet first. There is less than 20 cm under it.");
    const h = Math.min(sp.h ?? k.h, gap), D = DIR[top.rot] || DIR[0], f = fp(top), cx = f.x + f.w / 2, cz = f.z + f.d / 2, w = kind === "drawers" ? k.w : Math.max(0.4, top.w), d = Math.min(sp.d ?? k.d, Math.max(top.d, kind === "bench" ? 0.7 : top.d));
    const u = { kind, name: k.label + " under " + top.name, w, d, h: r2(h), rot: top.rot, levels: kind === "drawers" ? Math.max(1, Math.round(k.levels * h / k.h)) : k.levels, color: null, elev: 0 };
    const off = (top.d - u.d) / 2, g = fp(u); u.x = r2(cx + D.F[0] * off - g.w / 2); u.z = r2(cz + D.F[1] * off - g.d / 2);
    try { const id = await saveUnit(u); snapUndo({ kind: "add", id }); await load(); S.sel = { kind: "unit", id }; paintProps(); draw(); toast(h < (sp.h ?? k.h) ? "Added underneath, made " + cm(h) + " cm high to fit." : "Added underneath."); } catch (e) {}
  }
  async function addUnderDesk(desk) {   // a cabinet tucked under the table, at the right-hand end, facing the same way
    await flushSave(); const f = fp(desk), D = DIR[desk.rot] || DIR[0], cx = f.x + f.w / 2, cz = f.z + f.d / 2, off = desk.w / 2 - 0.5 / 2 - 0.05;
    const u = { kind: "cabinet", name: "Cabinet under " + desk.name, w: 0.5, d: Math.min(0.5, Math.max(0.2, desk.d - 0.1)), h: Math.max(0.2, Math.min(0.7, desk.h - 0.05)), rot: desk.rot, levels: 2, color: null, elev: 0 };
    const g = fp(u); u.x = r2(cx + D.R[0] * off - g.w / 2); u.z = r2(cz + D.R[1] * off - g.d / 2);
    try { const id = await saveUnit(u); snapUndo({ kind: "add", id }); await load(); S.sel = { kind: "unit", id }; paintProps(); draw(); toast("Cabinet added underneath."); } catch (e) {}
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
    const raised = u => isTable(u) || u.elev > 0, order = [...tops().filter(u => !raised(u)), ...tops().filter(raised)];
    for (const u of order) {
      const f = fp(u), x = sx(f.x), y = sy(f.z), w = f.w * p, h = f.d * p, sel = S.sel && S.sel.kind === "unit" && S.sel.id === u.id, n = contents(u).length, col = colorOf(u), over = raised(u), lt = over ? true : light(col);
      if (sel) selUnit = u;
      g.fillStyle = col; g.globalAlpha = over ? .5 : .94; g.fillRect(x, y, w, h); g.globalAlpha = 1; const bad = clashes(u).length > 0; g.strokeStyle = sel ? "#F2C200" : bad ? "#B83A26" : "#14232B"; g.lineWidth = sel ? 4 : bad ? 3 : 1.5; if (over && !sel) g.setLineDash([7, 4]); g.strokeRect(x, y, w, h); g.setLineDash([]);
      g.strokeStyle = lt ? "#14232B" : "#fff"; g.lineWidth = 3; g.beginPath();   // the front edge
      if (u.rot === 0) { g.moveTo(x + 3, y + h - 2); g.lineTo(x + w - 3, y + h - 2); } else if (u.rot === 90) { g.moveTo(x + 2, y + 3); g.lineTo(x + 2, y + h - 3); } else if (u.rot === 180) { g.moveTo(x + 3, y + 2); g.lineTo(x + w - 3, y + 2); } else { g.moveTo(x + w - 2, y + 3); g.lineTo(x + w - 2, y + h - 3); } g.stroke();
      g.save(); g.beginPath(); g.rect(x + 3, y + 3, w - 6, h - 6); g.clip(); g.fillStyle = lt ? "#14232B" : "#fff"; g.font = "600 12px sans-serif"; g.textBaseline = "top"; g.fillText(u.name + (u.elev > 0 && !isTable(u) ? " ↑" + cm(u.elev) : ""), x + 6, y + 6); if (n && h > 34) { g.font = "11px sans-serif"; g.fillText(n + " item" + (n > 1 ? "s" : ""), x + 6, y + 21); } g.restore();
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
    g.save(); g.font = "700 11px sans-serif"; g.textBaseline = "middle"; g.textAlign = "center"; g.fillStyle = "rgba(20,35,43,.55)";
    const tag = (t, x, y, rot) => { g.save(); g.translate(x, y); if (rot) g.rotate(rot); const w = g.measureText(t).width + 12; g.fillStyle = "rgba(238,241,242,.9)"; g.fillRect(-w / 2, -8, w, 16); g.fillStyle = "rgba(20,35,43,.6)"; g.fillText(t, 0, 1); g.restore(); };
    tag("BACK", cv.width / 2, 22); tag("FRONT", cv.width / 2, cv.height - 10); tag("LEFT", 10, cv.height / 2, -Math.PI / 2); tag("RIGHT", cv.width - 10, cv.height / 2, Math.PI / 2); g.restore();
    drawFront(); paintInfo();
    const hint = $("#sHint"); if (hint) hint.textContent = S.tool === "rect" ? "Drag from one corner of the room to the opposite corner." : S.tool === "poly" ? "Click each corner of the room in order. Click the green first corner (or Finish room) to close it." : !state.user ? "Sign in (top right) to change things. You can still look around and pick things."
      : selUnit ? "Drag to move. Drag the yellow handles to resize. Keys: arrows nudge 5 cm (Shift 50 cm), R turns, Ctrl+D copies, Delete removes, Ctrl+Z undoes." : "Click a shelf, cabinet or room to edit it. Drag the empty background to move the view; scroll or pinch to zoom.";
  }
  /* snapping: edges of a moving or resizing unit stick to other units' edges and to walls */
  function snapLines(skipId) {
    const xs = [], zs = []; tops().forEach(o => { if (o.id === skipId) return; const f = fp(o); xs.push(f.x, f.x + f.w); zs.push(f.z, f.z + f.d); });
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
    const hitsAt = w => tops().filter(u => { const f = fp(u); return w.x >= f.x && w.x <= f.x + f.w && w.z >= f.z && w.z <= f.z + f.d; }).sort((a, b) => fp(a).w * fp(a).d - fp(b).w * fp(b).d);   // smallest on top, so a cabinet under a desk can still be picked
    const hitRoom = w => { for (let i = S.rooms.length - 1; i >= 0; i--) if (inPoly(w.x, w.z, S.rooms[i].points)) return S.rooms[i]; return null; };
    const hitVertex = w => { const r = S.sel && S.sel.kind === "room" ? room(S.sel.id) : null; if (!r) return null; for (let i = 0; i < r.points.length; i++) if (Math.hypot(sx(r.points[i][0]) - w.px, sy(r.points[i][1]) - w.py) < 10) return { r, i }; return null; };
    const hitHandle = (w, touch) => { const u = S.sel && S.sel.kind === "unit" ? unit(S.sel.id) : null; if (!u || !state.user || parentOf(u)) return null; const hit = handles(u).find(([, hx, hy]) => Math.hypot(hx - w.px, hy - w.py) < (touch ? 16 : 10)); return hit ? { u, edge: hit[0] } : null; };
    const needSignIn = () => { if (!state.user) { toast("Sign in to change things."); return true; } return false; };
    const pts = new Map();
    cv.onpointerdown = e => {
      const w = pt(e); cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, w);
      if (pts.size === 2) { if (S.drag?.orig && S.drag.moved && unit(S.drag.id)) Object.assign(unit(S.drag.id), S.drag.orig); S.rect = null; const [a, b] = [...pts.values()]; S.drag = { kind: "pinch", d0: Math.hypot(a.px - b.px, a.py - b.py), ppm: S.v.ppm }; return; }
      if (S.tool === "rect") { if (needSignIn()) return; const x = snapTo(w.x, 0.1), z = snapTo(w.z, 0.1); S.rect = { x0: x, z0: z, x1: x, z1: z }; return; }
      if (S.tool === "poly") { if (needSignIn()) return; const x = snapTo(w.x, 0.1), z = snapTo(w.z, 0.1), f = S.draft[0]; if (f && S.draft.length >= 3 && Math.hypot(sx(f[0]) - w.px, sy(f[1]) - w.py) < 12) { finishPoly(); return; } S.draft.push([x, z]); paintBar(); draw(); return; }
      const hh = hitHandle(w, e.pointerType === "touch"); if (hh) { flushSave(); S.drag = { kind: "resize", id: hh.u.id, edge: hh.edge, f0: fp(hh.u), orig: { ...hh.u }, moved: false }; return; }
      const hv = hitVertex(w); if (hv) { if (needSignIn()) return; S.drag = { kind: "vertex", r: hv.r, i: hv.i, orig: hv.r.points.map(q => q.slice()), moved: false }; return; }
      const hits = hitsAt(w), u = hits.find(h => S.sel && S.sel.id === h.id) || hits[0];
      if (u) { const was = !!(S.sel && S.sel.id === u.id); if (!was) { flushSave(); S.sel = { kind: "unit", id: u.id }; paintProps(); } draw(); if (needSignIn()) { S.drag = { kind: "tap", hits: hits.map(h => h.id), was }; return; } const f = fp(u); S.drag = { kind: "unit", id: u.id, dx: w.x - f.x, dz: w.z - f.z, orig: { ...u }, moved: false, hits: hits.map(h => h.id), was }; return; }
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
      if ((d.kind === "tap" || (d.kind === "unit" && !d.moved)) && d.was && d.hits.length > 1) { const nxt = d.hits[(d.hits.indexOf(S.sel.id) + 1) % d.hits.length]; S.sel = { kind: "unit", id: nxt }; paintProps(); draw(); return; }   // clicking the same spot again picks what is underneath
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
  /* ====================================================== Front view (side-on) ======================================================
     The same space seen from one edge of the plan. Across is the floor line, up is height, so dragging here moves a unit sideways and up or down. */
  const VIEWS = { S: { label: "Front", edge: "bottom edge", arrow: "↑", axis: "x", sign: 1, looking: "up" }, N: { label: "Back", edge: "top edge", arrow: "↓", axis: "x", sign: -1, looking: "down" }, W: { label: "Left", edge: "left edge", arrow: "→", axis: "z", sign: 1, looking: "right" }, E: { label: "Right", edge: "right edge", arrow: "←", axis: "z", sign: -1, looking: "left" } };
  const EV = () => VIEWS[S.eview] || VIEWS.S;
  const aext = f => EV().axis === "x" ? [f.x, f.x + f.w] : [f.z, f.z + f.d];                  // a footprint's span along the way we are looking across, in plan metres
  const hext = (a0, a1) => EV().sign > 0 ? [a0, a1] : [-a1, -a0];                              // the same span as it runs left to right on screen
  const esx = h => (h - S.ev.h0) * S.ev.ppm, esy = y => S.ev.base - y * S.ev.ppm;
  function edepth(u) { const f = fp(u), xc = f.x + f.w / 2, zc = f.z + f.d / 2; return { S: zc, N: -zc, W: -xc, E: xc }[S.eview]; }   // bigger is nearer to you
  function boxSpan(e) { const V = EV(); return V.axis === "x" ? [e.cx - e.wx / 2, e.cx + e.wx / 2] : [e.cz - e.wz / 2, e.cz + e.wz / 2]; }
  function fitFront() {
    const cv = $("#eCv"); if (!cv) return; const V = EV(); let hmin = 1e9, hmax = -1e9, ymax = 0;
    const add = (a0, a1) => { const h = hext(a0, a1); hmin = Math.min(hmin, h[0]); hmax = Math.max(hmax, h[1]); };
    S.rooms.forEach(r => { const as = r.points.map(q => V.axis === "x" ? q[0] : q[1]); add(Math.min(...as), Math.max(...as)); ymax = Math.max(ymax, r.h); });
    tops().forEach(u => { const e = aext(fp(u)); add(e[0], e[1]); ymax = Math.max(ymax, (u.elev || 0) + u.h); });
    if (hmin > hmax) { hmin = 0; hmax = 6; ymax = 2.6; }
    const ppm = Math.min((cv.width - 30) / (hmax - hmin + 0.6), (cv.height - 46) / (ymax + 0.2)); S.ev = { ppm, h0: (hmin + hmax) / 2 - cv.width / 2 / ppm, base: cv.height - 24 };
  }
  function paintSeg() {
    const el = $("#eSeg"); if (!el) return; const V = EV();
    el.innerHTML = Object.entries(VIEWS).map(([k, v]) => `<button data-view="${k}" aria-pressed="${S.eview === k}" title="Stand at the ${v.edge} of the plan, looking ${v.looking}">${v.label} ${v.arrow}</button>`).join("");
    el.querySelectorAll("[data-view]").forEach(b => b.onclick = () => { S.eview = b.dataset.view; try { localStorage.setItem("sp_view", S.eview); } catch (e) {} paintSeg(); fitFront(); drawFront(); });
    const sz = $("#eSz"); if (sz) { sz.innerHTML = ["S", "M", "L"].map(k => `<button data-sz="${k}" aria-pressed="${S.esize === k}" aria-label="${({ S: "Small", M: "Medium", L: "Large" })[k]} view">${k}</button>`).join(""); sz.querySelectorAll("[data-sz]").forEach(b => b.onclick = () => { S.esize = b.dataset.sz; try { localStorage.setItem("sp_esize", S.esize); } catch (e) {} sizeCanvas(); fitFront(); draw(); paintSeg(); }); }
    const ez = $("#eZ"); if (ez) ez.querySelectorAll("[data-ez]").forEach(b => b.onclick = () => { const cv = $("#eCv"), E = S.ev; if (b.dataset.ez === "fit") { fitFront(); drawFront(); return; } const f = b.dataset.ez === "in" ? 1.25 : 0.8, hc = cv.width / 2 / E.ppm + E.h0, yc = (E.base - cv.height / 2) / E.ppm; E.ppm = clamp(E.ppm * f, 10, 400); E.h0 = hc - cv.width / 2 / E.ppm; E.base = cv.height / 2 + yc * E.ppm; drawFront(); });
    const tt = $("#eTitle"); if (tt) tt.textContent = V.label + " view";
    const h = $("#eHint"); if (h) h.textContent = "Seen from the " + V.label.toLowerCase() + " (" + V.edge + " of the plan), looking " + V.looking + ". " + (state.user ? "Drag a unit sideways or up and down. Drag the yellow dots to resize. Drag empty space to pan; scroll to zoom." : "Sign in (top right) to change things.");
  }
  function ehandles(u) {
    const V = EV(), e = aext(fp(u)), hh = hext(e[0], e[1]), L = esx(hh[0]), R = esx(hh[1]), xm = (L + R) / 2, yT = esy((u.elev || 0) + u.h), yB = esy(u.elev || 0), ym = (yT + yB) / 2;
    const hs = [["min", V.sign > 0 ? L : R, ym], ["max", V.sign > 0 ? R : L, ym], ["t", xm, yT]]; if (!isTable(u) && u.kind !== "rack") hs.push(["b", xm, yB]); return hs;
  }
  function drawElev(g, u, sel) {
    const E = S.ev, f = fp(u), e = aext(f), hh = hext(e[0], e[1]), x = esx(hh[0]), w = (hh[1] - hh[0]) * E.ppm, yT = esy((u.elev || 0) + u.h), yB = esy(u.elev || 0), col = colorOf(u), lt = light(col), ink = lt ? "#14232B" : "#fff";
    g.lineWidth = 1.5; g.strokeStyle = "#14232B"; g.textBaseline = "middle";
    if (isTable(u)) {
      const bench = u.kind === "bench", t = Math.max(5, (bench ? 0.05 : 0.035) * E.ppm), lw = Math.max(5, (bench ? 0.07 : 0.05) * E.ppm); g.fillStyle = col; g.fillRect(x, yT, w, t); g.strokeRect(x, yT, w, t);
      g.fillRect(x + 3, yT + t, lw, yB - yT - t); g.fillRect(x + w - 3 - lw, yT + t, lw, yB - yT - t); g.strokeRect(x + 3, yT + t, lw, yB - yT - t); g.strokeRect(x + w - 3 - lw, yT + t, lw, yB - yT - t);
    } else if (u.kind === "rack") {
      const L = u.levels, lh = (yB - yT) / L, T = Math.max(3, 0.03 * E.ppm); g.fillStyle = "rgba(255,255,255,.35)"; g.fillRect(x, yT, w, yB - yT); g.fillStyle = col;
      for (let i = 0; i <= L; i++) g.fillRect(x, i === L ? yT : yB - lh * i - T, w, T); g.fillRect(x, yT, 4, yB - yT); g.fillRect(x + w - 4, yT, 4, yB - yT);
      for (const b of boxLayout(u)) { const s = boxSpan(b), bh = hext(s[0], s[1]), bx = esx(bh[0]), bw = (bh[1] - bh[0]) * E.ppm, by = esy(b.y + b.h), bhei = b.h * E.ppm, sb = S.sel && S.sel.id === b.b.id; g.fillStyle = colorOf(b.b); g.fillRect(bx, by, bw, bhei); g.strokeStyle = sb ? "#F2C200" : b.over ? "#B83A26" : "#14232B"; g.lineWidth = sb ? 3 : 1; g.strokeRect(bx, by, bw, bhei); if (bw > 30) { g.save(); g.beginPath(); g.rect(bx, by, bw, bhei); g.clip(); g.fillStyle = light(colorOf(b.b)) ? "#14232B" : "#fff"; g.font = "600 10px sans-serif"; g.textAlign = "left"; g.fillText(b.b.name, bx + 3, by + bhei / 2); g.restore(); } }
      g.strokeStyle = "#14232B"; g.lineWidth = 1.2; g.strokeRect(x, yT, w, yB - yT); g.fillStyle = "#14232B"; g.font = "600 10px sans-serif"; g.textAlign = "left"; for (let i = 0; i < L; i++) if (lh > 14) g.fillText(String(i + 1), x + 6, yB - lh * (i + 0.5));
    } else {
      g.globalAlpha = .96; g.fillStyle = col; g.fillRect(x, yT, w, yB - yT); g.globalAlpha = 1; g.strokeRect(x, yT, w, yB - yT);
      const L = u.kind === "bench" || u.kind === "box" ? 1 : u.levels; g.strokeStyle = lt ? "rgba(20,35,43,.55)" : "rgba(255,255,255,.75)"; g.fillStyle = ink; g.font = "600 10px sans-serif"; g.lineWidth = 1;
      for (let i = 0; i < L; i++) {
        const yb2 = yB - (yB - yT) * i / L, yt2 = yB - (yB - yT) * (i + 1) / L; if (i) { g.beginPath(); g.moveTo(x + 2, yb2); g.lineTo(x + w - 2, yb2); g.stroke(); }
        if (L > 1 && (yb2 - yt2) > 14) { g.textAlign = "left"; g.fillText(String(i + 1), x + 5, (yb2 + yt2) / 2); const n = itemsAt(u.id, i + 1).length; if (n && w > 40) { g.textAlign = "right"; g.fillText(w > 90 ? n + " item" + (n > 1 ? "s" : "") : String(n), x + w - 5, (yb2 + yt2) / 2); } }
      }
    }
    if (w > 46) { g.save(); g.beginPath(); g.rect(x + 2, yT - 1, w - 4, 40); g.clip(); g.fillStyle = isTable(u) || u.kind === "rack" ? "#14232B" : ink; g.font = "600 11px sans-serif"; g.textAlign = "left"; g.textBaseline = "top"; g.fillText(u.name, x + 5, isTable(u) ? yT + 7 : yT + 4); g.restore(); }
    if (sel) {
      g.strokeStyle = "#F2C200"; g.lineWidth = 3; g.setLineDash([]); g.strokeRect(x - 1, yT - 1, w + 2, yB - yT + 2);
      dimLabel(g, cm(e[1] - e[0]) + " cm", x + w / 2, yT - 14, false); dimLabel(g, cm(u.h) + " cm", x + w + 16, (yT + yB) / 2, true);
      if (u.elev > 0 && !isTable(u)) dimLabel(g, "↑ " + cm(u.elev) + " cm", x + w / 2, yB + 14, false);
      if (state.user) ehandles(u).forEach(([k, hx, hy]) => { g.fillStyle = "#F2C200"; g.strokeStyle = "#14232B"; g.lineWidth = 2; g.beginPath(); if (k === "t" || k === "b") g.rect(hx - 7, hy - 7, 14, 14); else g.arc(hx, hy, 7, 0, 7); g.fill(); g.stroke(); });
    }
  }
  function drawFront() {
    const cv = $("#eCv"); if (!cv || !S.ev) return; const g = cv.getContext("2d"), E = S.ev, V = EV(), W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H); g.fillStyle = "#EEF1F2"; g.fillRect(0, 0, W, H); g.font = "11px sans-serif"; g.textAlign = "left"; g.textBaseline = "top"; g.lineWidth = 1;
    const step = E.ppm > 50 ? 1 : E.ppm > 25 ? 2 : 5, hl = E.h0, hr = E.h0 + W / E.ppm;
    for (let h = Math.ceil(hl / step) * step; h <= hr; h += step) { g.strokeStyle = "#DDE4E7"; g.beginPath(); g.moveTo(esx(h), 0); g.lineTo(esx(h), H); g.stroke(); g.fillStyle = "#5B6B73"; g.fillText((V.sign * h || 0) + " m", esx(h) + 2, 2); }
    for (let y = 1; esy(y) > 12; y++) { g.strokeStyle = "#DDE4E7"; g.beginPath(); g.moveTo(0, esy(y)); g.lineTo(W, esy(y)); g.stroke(); g.fillStyle = "#5B6B73"; g.fillText(y + " m", 2, esy(y) + 2); }
    for (const r of S.rooms) {
      const as = r.points.map(q => V.axis === "x" ? q[0] : q[1]), hh = hext(Math.min(...as), Math.max(...as)), x = esx(hh[0]), w = (hh[1] - hh[0]) * E.ppm;
      g.fillStyle = "rgba(255,255,255,.75)"; g.fillRect(x, esy(r.h), w, r.h * E.ppm); g.strokeStyle = "#14232B"; g.lineWidth = 2; g.strokeRect(x, esy(r.h), w, r.h * E.ppm);
      g.fillStyle = "rgba(20,35,43,.5)"; g.font = "600 12px sans-serif"; g.textAlign = "left"; g.textBaseline = "top"; g.fillText(r.name + " · walls " + r.h + " m", x + 6, esy(r.h) + 4); g.font = "11px sans-serif";
    }
    g.fillStyle = "#C9D2D6"; g.fillRect(0, E.base, W, H - E.base); g.fillStyle = "#14232B"; g.fillRect(0, E.base, W, 3);
    const order = tops().sort((a, b) => edepth(a) - edepth(b)); let selU = null;
    for (const u of order) { const sel = S.sel && S.sel.kind === "unit" && S.sel.id === u.id; if (sel) selU = u; if (!sel) drawElev(g, u, false); }
    if (selU) drawElev(g, selU, true);
    if (S.sel && S.sel.kind === "unit" && parentOf(unit(S.sel.id) || {})) { const b = unit(S.sel.id), p = parentOf(b), e = boxLayout(p).find(x => x.b.id === b.id); if (e) { const s = boxSpan(e), bh = hext(s[0], s[1]); g.strokeStyle = "#F2C200"; g.lineWidth = 3; g.strokeRect(esx(bh[0]) - 1, esy(e.y + e.h) - 1, (bh[1] - bh[0]) * E.ppm + 2, e.h * E.ppm + 2); } }
    if (S.eg) { g.save(); g.strokeStyle = "#D9822B"; g.lineWidth = 1; g.setLineDash([6, 4]); S.eg.h.forEach(h => { g.beginPath(); g.moveTo(esx(h), 0); g.lineTo(esx(h), H); g.stroke(); }); S.eg.y.forEach(y => { g.beginPath(); g.moveTo(0, esy(y)); g.lineTo(W, esy(y)); g.stroke(); }); g.restore(); }
  }
  function snapAxisLines(skipId) { const V = EV(), out = []; tops().forEach(o => { if (o.id === skipId) return; const e = aext(fp(o)); out.push(e[0], e[1]); }); S.rooms.forEach(r => r.points.forEach(q => out.push(V.axis === "x" ? q[0] : q[1]))); return out; }
  function snapYLines(skipId) { const out = [0]; tops().forEach(o => { if (o.id === skipId) return; out.push(o.elev || 0, (o.elev || 0) + o.h); }); S.rooms.forEach(r => out.push(r.h)); return out; }
  function snapV(v, list, out, thr) { let best = null; list.forEach(c => { if (Math.abs(c - v) < thr && (best == null || Math.abs(c - v) < Math.abs(best - v))) best = c; }); if (best != null) out.push(best); return best; }
  function bindFront() {
    const cv = $("#eCv"); if (!cv) return; const E = () => S.ev, V = () => EV();
    const pt = e => { const b = cv.getBoundingClientRect(), k = cv.width / b.width, px = (e.clientX - b.left) * k, py = (e.clientY - b.top) * k; return { px, py, h: px / E().ppm + E().h0, y: (E().base - py) / E().ppm }; };
    const hitsE = w => {
      const out = [];
      for (const r of tops().filter(u => u.kind === "rack")) for (const b of boxLayout(r)) { const s = boxSpan(b), hh = hext(s[0], s[1]); if (w.h >= hh[0] && w.h <= hh[1] && w.y >= b.y && w.y <= b.y + b.h) out.push(b.b); }
      return [...out, ...tops().filter(u => { const hh = hext(...aext(fp(u))); return w.h >= hh[0] && w.h <= hh[1] && w.y >= (u.elev || 0) && w.y <= (u.elev || 0) + u.h; }).sort((a, b) => edepth(b) - edepth(a))];
    };
    const hitHandle = (w, touch) => { const u = S.sel && S.sel.kind === "unit" ? unit(S.sel.id) : null; if (!u || !state.user || parentOf(u)) return null; const hit = ehandles(u).find(([, hx, hy]) => Math.hypot(hx - w.px, hy - w.py) < (touch ? 16 : 10)); return hit ? { u, edge: hit[0] } : null; };
    const needSignIn = () => { if (!state.user) { toast("Sign in to change things."); return true; } return false; };
    cv.onpointerdown = e => {
      const w = pt(e); cv.setPointerCapture(e.pointerId);
      const hh = hitHandle(w, e.pointerType === "touch"); if (hh) { flushSave(); S.drag = { kind: "eresize", id: hh.u.id, edge: hh.edge, f0: fp(hh.u), orig: { ...hh.u }, moved: false }; return; }
      const hits = hitsE(w), u = hits.find(h => S.sel && S.sel.id === h.id) || hits[0];
      if (u) {
        const was = !!(S.sel && S.sel.id === u.id); if (!was) { flushSave(); S.sel = { kind: "unit", id: u.id }; paintProps(); } draw();
        if (parentOf(u) || needSignIn()) { S.drag = { kind: "tap", hits: hits.map(h => h.id), was }; return; }
        const e0 = aext(fp(u)); S.drag = { kind: "emove", id: u.id, a: V().sign * w.h, a0: e0[0], ext: e0[1] - e0[0], y: w.y, e0: u.elev || 0, canLift: !isTable(u) && u.kind !== "rack", orig: { ...u }, moved: false, hits: hits.map(h => h.id), was }; return;
      }
      flushSave(); S.sel = null; paintProps(); draw(); S.drag = { kind: "epan", px: w.px, py: w.py, h0: E().h0, base: E().base };
    };
    cv.onpointermove = e => {
      const w = pt(e), d = S.drag, Ev = E(); if (!d) { const hh = hitHandle(w); cv.style.cursor = !hh ? "default" : hh.edge === "min" || hh.edge === "max" ? "ew-resize" : "ns-resize"; return; }
      if (d.kind === "epan") { Ev.h0 = d.h0 - (w.px - d.px) / Ev.ppm; Ev.base = d.base + (w.py - d.py); drawFront(); return; }
      const u = unit(d.id); if (!u) return; const thr = 8 / Ev.ppm, gh = [], gy = [], a = V().sign * w.h, alt = e.altKey, x = V().axis === "x";
      if (d.kind === "emove") {
        const lines = snapAxisLines(u.id); let a0 = snapTo(d.a0 + (a - d.a), 0.05);
        if (!alt) { const s1 = snapV(a0, lines, gh, thr); if (s1 != null) a0 = s1; else { const s2 = snapV(a0 + d.ext, lines, gh, thr); if (s2 != null) a0 = s2 - d.ext; } }
        if (x) u.x = r2(a0); else u.z = r2(a0);
        if (d.canLift) { let e0 = Math.max(0, snapTo(d.e0 + (w.y - d.y), 0.05)); if (!alt) { const yl = snapYLines(u.id), s1 = snapV(e0, yl, gy, thr); if (s1 != null) e0 = s1; else { const s2 = snapV(e0 + u.h, yl, gy, thr); if (s2 != null) e0 = Math.max(0, s2 - u.h); } } u.elev = r2(e0); }
        if (Math.abs(a0 - d.a0) > 0.001 || (d.canLift && Math.abs((u.elev || 0) - d.e0) > 0.001)) d.moved = true;
      } else if (d.kind === "eresize") {
        const F = { ...d.f0 }, ed = d.edge;
        if (ed === "min" || ed === "max") {
          let v = snapTo(a, 0.05); if (!alt) { const s = snapV(v, snapAxisLines(u.id), gh, thr); if (s != null) v = s; }
          if (x) { if (ed === "min") { const nx = Math.min(v, F.x + F.w - 0.1); F.w = F.x + F.w - nx; F.x = nx; } else F.w = Math.max(0.1, v - F.x); }
          else { if (ed === "min") { const nz = Math.min(v, F.z + F.d - 0.1); F.d = F.z + F.d - nz; F.z = nz; } else F.d = Math.max(0.1, v - F.z); }
          setFootprint(u, F);
        } else if (ed === "t") { let y = snapTo(w.y, 0.05); if (!alt) { const s = snapV(y, snapYLines(u.id), gy, thr); if (s != null) y = s; } u.h = Math.max(0.1, r2(y - (u.elev || 0))); }
        else if (ed === "b") { const top = d.orig.elev + d.orig.h; let y = clamp(snapTo(w.y, 0.05), 0, top - 0.1); if (!alt) { const s = snapV(y, snapYLines(u.id), gy, thr); if (s != null) y = clamp(s, 0, top - 0.1); } u.elev = r2(y); u.h = r2(top - y); }
        d.moved = true;
      }
      S.eg = { h: gh.map(v => V().sign * v), y: gy }; draw(); paintSizeInputs(u);
    };
    const up = async e => {
      S.eg = null; const d = S.drag; S.drag = null; if (!d) { draw(); return; }
      if ((d.kind === "tap" || (d.kind === "emove" && !d.moved)) && d.was && d.hits.length > 1) { const nxt = d.hits[(d.hits.indexOf(S.sel.id) + 1) % d.hits.length]; S.sel = { kind: "unit", id: nxt }; paintProps(); draw(); return; }   // click the same spot again to pick what is behind
      if ((d.kind === "emove" || d.kind === "eresize") && d.moved) { const u = unit(d.id); snapUnit(d.orig); try { await saveUnit(u); paintProps(); } catch (err) { Object.assign(u, d.orig); S.undo.pop(); paintUndo(); } }
      draw();
    };
    cv.onpointerup = up; cv.onpointercancel = up;
    cv.onwheel = e => { e.preventDefault(); const w = pt(e), Ev = E(), f = e.deltaY < 0 ? 1.12 : 0.89; Ev.ppm = clamp(Ev.ppm * f, 10, 400); Ev.h0 = w.h - w.px / Ev.ppm; Ev.base = w.py + w.y * Ev.ppm; drawFront(); };
  }
  function onKey(e) {
    if (!S.view || $("#dlg").open || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) return;
    const ctrl = e.ctrlKey || e.metaKey, u = S.sel && S.sel.kind === "unit" ? unit(S.sel.id) : null;
    if (ctrl && e.key.toLowerCase() === "z") { e.preventDefault(); if (state.user) undo(); return; }
    if (e.key === "Escape") { flushSave(); S.sel = null; S.draft = []; S.rect = null; paintBar(); paintProps(); draw(); return; }
    if (!u || !state.user) return;
    if (parentOf(u)) { if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeUnit(u); } return; }
    const step = e.shiftKey ? 0.5 : 0.05, mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (mv) { e.preventDefault(); burstSnap(u); u.x = r2(u.x + mv[0]); u.z = r2(u.z + mv[1]); draw(); paintPos(u); scheduleSave(u); return; }
    if ((e.key === "PageUp" || e.key === "PageDown") && !isTable(u) && u.kind !== "rack") { e.preventDefault(); burstSnap(u); u.elev = Math.max(0, r2((u.elev || 0) + (e.key === "PageUp" ? 1 : -1) * step)); draw(); paintSizeInputs(u); scheduleSave(u); return; }
    if (e.key.toLowerCase() === "r" && !ctrl) { e.preventDefault(); turn(u, 90); return; }
    if (ctrl && e.key.toLowerCase() === "d") { e.preventDefault(); addUnit(u.kind, u); return; }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeUnit(u); }
  }
  /* choose which side is the front without moving the shape on the plan: width and depth swap when the front moves to a short side */
  const FRONT_ROT = { down: 0, left: 90, up: 180, right: 270 };
  function setFront(u, dir) {
    const r = FRONT_ROT[dir]; if (r == null || r === u.rot) return;
    flushSave(); snapUnit(u); if ((r % 180) !== (u.rot % 180)) { const w = u.w; u.w = u.d; u.d = w; } u.rot = r;
    saveUnit(u).catch(() => {}); paintProps(); draw();
  }
  function turn(u, by) {   // turn about the centre so it stays in place
    flushSave(); snapUnit(u); const f = fp(u), cx = f.x + f.w / 2, cz = f.z + f.d / 2; u.rot = (u.rot + by + 360) % 360; const g = fp(u); u.x = r2(cx - g.w / 2); u.z = r2(cz - g.d / 2);
    saveUnit(u).catch(() => {}); paintProps(); draw();
  }
  async function removeUnit(u) {
    if (!confirm("Remove " + u.name + "? " + (kids(u).length ? "The boxes on it are removed too. " : "") + "Items stored here become unplaced.")) return;
    await flushSave(); try { await guard(rpcAuth("toolscale_space_remove", { p_kind: "unit", p_id: u.id })); S.sel = null; S.undo = S.undo.filter(x => (x.data?.id || x.id) !== u.id); await load(); await refreshAll(); paintBar(); paintProps(); draw(); } catch (e) {}
  }
  function finishPoly() {
    if (S.draft.length < 3) return; const pts = S.draft.slice(); S.draft = []; S.hover = null; roomDialog(null, pts);
  }
  function paintSizeInputs(u) { const s = (id, v) => { const el = $("#" + id); if (el && document.activeElement !== el) el.value = v; }; s("uW", cm(u.w)); s("uD", cm(u.d)); s("uH", cm(u.h)); s("uE", cm(u.elev || 0)); paintPos(u); paintInfo(); }
  function paintPos(u) { const s = (id, v) => { const el = $("#" + id); if (el && document.activeElement !== el) el.value = v; }; s("uX", r2(u.x)); s("uZ", r2(u.z)); }
  function paintInfo() {
    const el = $("#sInfo"); if (!el) return; const u = S.sel && S.sel.kind === "unit" ? unit(S.sel.id) : null;
    el.textContent = u ? u.name + " · " + cm(u.w) + " × " + cm(u.d) + " × " + cm(u.h) + " cm" + (u.elev > 0 ? " · " + cm(u.elev) + " cm up" : "") : S.rooms.length + " room" + (S.rooms.length === 1 ? "" : "s") + ", " + tops().length + " unit" + (tops().length === 1 ? "" : "s");
  }
  const SIZES_BOX = [[40, 30, 25], [60, 40, 30], [30, 20, 15], [25, 25, 25]];
  const swatches = col => SWATCH.map(c => `<button type="button" class="sw" data-col="${c}" title="${c}" aria-label="Colour ${c}" style="background:${c};${c.toUpperCase() === col.toUpperCase() ? "outline:3px solid var(--hivis);outline-offset:1px" : ""}"></button>`).join("");
  /* collapsible panel sections that remember whether you left them open */
  const sec = (key, title, html, dflt = true) => `<details class="acc" data-k="${key}" ${(S.open[key] ?? dflt) ? "open" : ""}><summary>${title}</summary><div class="accb">${html}</div></details>`;
  const bindSecs = el => el.querySelectorAll("details.acc").forEach(d => d.addEventListener("toggle", () => { S.open[d.dataset.k] = d.open; }));
  function nudge(u, dx, dz, de) {
    const step = (Number($("#nStep")?.value) || 5) / 100; burstSnap(u);
    if (dx || dz) { u.x = r2(u.x + dx * step); u.z = r2(u.z + dz * step); } if (de && !isTable(u) && u.kind !== "rack") u.elev = Math.max(0, r2((u.elev || 0) + de * step));
    draw(); paintSizeInputs(u); scheduleSave(u);
  }
  function paintProps() {
    const el = $("#sProps"); if (!el) return; const s = S.sel; paintInfo();
    if (s && s.kind === "room") {
      const r = room(s.id); if (!r) return; const inside = tops().filter(u => roomOf(u) === r);
      el.innerHTML = `<h2>${esc(r.name)} <span class="chipk">Room</span></h2><p class="hint">${r2(area(r.points))} m² · ${r.points.length} corners · walls ${r.h} m high · ${inside.length} unit${inside.length === 1 ? "" : "s"} inside</p>
        <p>Drag a corner on the top view to reshape the room. Double-click a wall to add a corner, or a corner to remove it. Wall lengths show on the plan.</p>
        <div class="row" style="margin-top:10px"><button class="btn sec" id="rEdit">Rename or change height</button><button class="btn danger" id="rDel">Remove room</button></div>`;
      $("#rEdit").onclick = () => requireAuth(() => roomDialog(r));
      $("#rDel").onclick = () => requireAuth(async () => { if (!confirm("Remove " + r.name + "? The shelves and cabinets stay where they are.")) return; try { await guard(rpcAuth("toolscale_space_remove", { p_kind: "room", p_id: r.id })); S.sel = null; S.undo = S.undo.filter(x => x.id !== r.id); await load(); await refreshAll(); paintBar(); paintProps(); fitFront(); draw(); } catch (e) {} });
      return;
    }
    const u = s && s.kind === "unit" ? unit(s.id) : null;
    if (!u) { el.innerHTML = `<h2>Your space</h2><p class="hint">${S.rooms.length} room${S.rooms.length === 1 ? "" : "s"} · ${tops().length} unit${tops().length === 1 ? "" : "s"}</p>
      <ol style="padding-left:20px;display:grid;gap:6px;margin:0 0 10px"><li>Draw a room with <strong>Room: rectangle</strong> or <strong>Room: corners</strong>.</li><li>Press <strong>＋ Add</strong> for a shelf, cabinet, wall cabinet, drawers, workbench, PC desk or rack.</li><li>Drag it in the <strong>top view</strong> to place it on the floor, and in the <strong>front view</strong> to set how high it is.</li></ol>
      <p class="hint">Click a unit to edit its size, levels, colour and position. Click the same spot again to pick what is behind or underneath.</p>`; return; }
    if (u.kind === "box" && parentOf(u)) return boxProps(u, el);
    const its = contents(u), rm = roomOf(u), col = colorOf(u), ro = !state.user, desk = isTable(u), rack = u.kind === "rack";
    const types = Object.entries(KINDS).filter(([k]) => k !== "box").map(([k, v]) => `<option value="${k}" ${k === u.kind ? "selected" : ""}>${v.label}</option>`).join("");
    const clash = clashes(u), lift = !desk && !rack;
    const sizeHtml = `<div class="row"><div class="field" style="min-width:70px"><label for="uW">Width (cm)</label><input id="uW" type="number" step="5" min="10" max="3000" value="${cm(u.w)}"></div>
        <div class="field" style="min-width:70px"><label for="uD">Depth (cm)</label><input id="uD" type="number" step="5" min="10" max="3000" value="${cm(u.d)}"></div>
        <div class="field" style="min-width:70px"><label for="uH">${desk ? "Top height" : "Height"} (cm)</label><input id="uH" type="number" step="5" min="10" max="1000" value="${cm(u.h)}"></div></div>
      <div style="margin-top:8px"><label for="uPre">Common sizes</label><select id="uPre" class="sel"><option value="">Pick a size...</option>${(PRESETS[u.kind] || []).map(p => `<option value="${p.join(",")}">${p[0]} × ${p[1]} × ${p[2]} cm</option>`).join("")}</select></div>
      <p class="hint">Width is across the front. You can also drag the yellow dots in either view.</p>`;
    const levelsHtml = `<div class="row" style="align-items:center"><button type="button" class="btn sec mini" id="uLm" aria-label="One less">−</button><input id="uL" type="number" step="1" min="1" max="30" value="${u.levels}" style="width:70px;text-align:center" aria-label="Levels"><button type="button" class="btn sec mini" id="uLp" aria-label="One more">+</button><span class="hint" style="margin:0">numbered from the bottom up</span></div>`;
    const posHtml = `<div class="row"><div class="field" style="min-width:70px"><label for="uX">Left edge (m)</label><input id="uX" type="number" step="0.05" value="${r2(u.x)}"></div><div class="field" style="min-width:70px"><label for="uZ">Top edge (m)</label><input id="uZ" type="number" step="0.05" value="${r2(u.z)}"></div>
        ${lift ? `<div class="field" style="min-width:90px"><label for="uE">Off the floor (cm)</label><input id="uE" type="number" step="5" min="0" max="500" value="${cm(u.elev)}"></div>` : ""}</div>
      <div class="row" style="align-items:center;gap:16px;margin-top:10px"><div class="nudge" role="group" aria-label="Nudge on the floor plan"><span></span><button type="button" data-n="0,-1,0" aria-label="Up on the plan">▲</button><span></span><button type="button" data-n="-1,0,0" aria-label="Left">◀</button><span></span><button type="button" data-n="1,0,0" aria-label="Right">▶</button><span></span><button type="button" data-n="0,1,0" aria-label="Down on the plan">▼</button><span></span></div>
        <div style="display:grid;gap:4px">${lift ? `<button type="button" class="nbtn" data-n="0,0,1">⤒ Raise</button><button type="button" class="nbtn" data-n="0,0,-1">⤓ Lower</button>` : ""}<select id="nStep" class="sel" aria-label="Nudge step"><option value="1">1 cm</option><option value="5" selected>5 cm</option><option value="10">10 cm</option><option value="50">50 cm</option></select></div></div>
      <div style="margin-top:12px"><label>Front faces (white edge on the plan)</label>
        <div class="row" style="gap:6px;align-items:center" role="group" aria-label="Which side is the front">${[["up", "↑ Up"], ["left", "← Left"], ["down", "↓ Down"], ["right", "→ Right"]].map(([d, l]) => `<button type="button" class="btn ${facing(u.rot) === d ? "" : "sec"}" data-front="${d}" aria-pressed="${facing(u.rot) === d}" style="padding:6px 10px">${l}</button>`).join("")}</div></div>
      <div class="row" style="margin-top:10px;align-items:center"><button type="button" class="btn sec" id="uRotL" aria-label="Turn left">↺ Turn</button><button type="button" class="btn sec" id="uRot" aria-label="Turn right">Turn ↻</button><button type="button" class="btn sec" id="uWall">Snap to wall</button>${lift ? `<button type="button" class="btn sec" id="uMount">Mount on wall</button>` : ""}</div>
      <p class="hint">Snap to wall puts the back against the nearest straight wall.${lift ? " Mount on wall also lifts it 120 cm." : ""} Turn rotates the whole unit; picking a front side keeps the shape in place.</p>`;
    const underCab = !desk && !rack && u.elev > 0 ? sec("undercab", "Under this cabinet", `<p class="hint" style="margin:0 0 8px">There is ${cm(u.elev)} cm under it. Put something below, such as a workbench, drawers or a cabinet. It is made to fit, back to the same wall.</p>
        <div class="row" style="align-items:flex-end"><div class="field" style="min-width:130px"><label for="uUnderKind">Put underneath</label><select id="uUnderKind" class="sel"><option value="bench">Workbench</option><option value="drawers">Drawer unit</option><option value="cabinet">Cabinet</option><option value="shelf">Shelf</option></select></div><button type="button" class="btn sec" id="uUnderAdd">Add underneath</button></div>`) : "";
    const underDesk = desk ? sec("underdesk", "Under the " + (u.kind === "bench" ? "bench" : "desk"), `<p class="hint" style="margin:0 0 8px">Cabinets and drawers can sit under the table top. It shows see-through on the plan; click the same spot again to pick what is under it.</p><button type="button" class="btn sec" id="uUnder">Add a cabinet under this ${u.kind === "bench" ? "bench" : "desk"}</button>`) : "";
    const boxesHtml = rack ? sec("boxes", "Boxes on this rack", `${kids(u).length ? Array.from({ length: u.levels }, (_, i) => u.levels - i).map(lv => { const bs = boxLayout(u).filter(e => e.L === lv); return bs.length ? `<div><strong style="font-size:14px">Level ${lv}</strong>${bs.map(e => `<button type="button" class="bxr ${e.over ? "over" : ""}" data-box="${e.b.id}"><span>${esc(e.b.name)}</span><span class="hint" style="margin:0">${cm(e.b.w)}×${cm(e.b.d)}×${cm(e.b.h)} cm${itemsAt(e.b.id).length ? " · " + itemsAt(e.b.id).length + " item" + (itemsAt(e.b.id).length > 1 ? "s" : "") : ""}${e.over ? " · does not fit" : ""}</span></button>`).join("")}</div>` : ""; }).join("") : `<p class="hint" style="margin:0 0 8px">No boxes yet. Add one, then say which items are in it under Setup, Place items.</p>`}
        <div class="row" style="margin-top:8px;align-items:flex-end"><div class="field" style="min-width:90px;max-width:130px"><label for="bxL">Put on level</label><select id="bxL" class="sel">${Array.from({ length: u.levels }, (_, i) => `<option>${i + 1}</option>`).join("")}</select></div><button type="button" class="btn" id="bxAdd">Add a box</button></div>`) : "";
    el.innerHTML = `<fieldset style="border:0;padding:0;margin:0" ${ro ? "disabled" : ""}>
      ${ro ? `<p class="status-line err" style="margin-top:0">Sign in (top right) to edit.</p>` : ""}
      <div class="row"><div class="field" style="min-width:150px"><label for="uName">Name</label><input id="uName" type="text" maxlength="40" value="${esc(u.name)}"></div>
        <div class="field" style="min-width:120px;max-width:150px"><label for="uKind">Type</label><select id="uKind" class="sel">${types}</select></div></div>
      <p class="hint">${rm ? "In " + esc(rm.name) : "Not inside a room"}${u.elev > 0 && !desk ? " · hangs " + cm(u.elev) + " cm above the floor" : ""}${its.length ? " · " + its.length + " item" + (its.length > 1 ? "s" : "") + " stored" : ""}</p>
      ${clash.length ? `<p class="status-line err" style="margin:6px 0">Overlaps ${esc(clash.map(o => o.name).join(", "))} in height, so they would collide. Lower it, or raise or shorten the other one.</p>` : ""}
      ${sec("pos", "Position", posHtml)}${sec("size", "Size", sizeHtml)}${desk ? "" : sec("lev", u.kind === "drawers" ? "Drawers" : "Levels", levelsHtml)}${underCab}${underDesk}${boxesHtml}
      ${sec("col", "Colour", `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${swatches(col)}<label style="display:flex;gap:6px;align-items:center;margin:0 0 0 4px;font-weight:400"><input type="color" id="uCol" value="${col}" style="width:34px;height:28px;padding:0;border:1px solid #14232B"> Other</label><button type="button" class="linkbtn" id="uColDef" style="color:var(--steel);padding:0 4px">Default</button></div>`, false)}
      <div class="row" style="margin-top:12px"><button type="button" class="btn sec" id="uDup">Copy</button><button type="button" class="btn sec" id="u3d">See in 3D</button><button type="button" class="btn danger" id="uDel">Remove</button></div>
      </fieldset>
      ${its.length ? `<p class="hint" style="margin-top:10px">Stored here: ${esc(its.slice(0, 6).map(itemName).join(", "))}${its.length > 6 ? "…" : ""}</p>` : `<p class="hint" style="margin-top:10px">Nothing stored here yet. Place items under Setup, Place items.</p>`}`;
    bindSecs(el);
    const change = (fn, now) => { if (!state.user) return; burstSnap(u); fn(); draw(); if (now) { clearTimeout(S.saveT); S.pending = u; flushSave(); } else scheduleSave(u); };
    const numIn = (id, key, lo, hi, div) => { const n = $("#" + id); if (!n) return; n.oninput = e => { const v = Number(e.target.value); if (e.target.value === "" || !(v >= lo && v <= hi)) return; change(() => { u[key] = r2(v / div); }); }; };
    numIn("uW", "w", 10, 3000, 100); numIn("uD", "d", 10, 3000, 100); numIn("uH", "h", 10, 1000, 100); numIn("uE", "elev", 0, 500, 100);
    $("#uX").oninput = e => { const v = Number(e.target.value); if (e.target.value === "" || isNaN(v)) return; change(() => { u.x = r2(v); }); };
    $("#uZ").oninput = e => { const v = Number(e.target.value); if (e.target.value === "" || isNaN(v)) return; change(() => { u.z = r2(v); }); };
    $("#uName").oninput = e => { const v = e.target.value.trim(); if (v) change(() => { u.name = v; }); };
    $("#uKind").onchange = e => { change(() => { u.kind = e.target.value; if (isTable(u)) { u.levels = 1; u.elev = 0; } }, true); paintProps(); };
    $("#uPre").onchange = e => { if (!e.target.value) return; const [a, b, c] = e.target.value.split(",").map(Number); change(() => { u.w = a / 100; u.d = b / 100; u.h = c / 100; }, true); paintSizeInputs(u); e.target.value = ""; };
    if ($("#uL")) { const setL = v => { v = clamp(Math.round(v) || 1, 1, 30); $("#uL").value = v; change(() => { u.levels = v; }); if (rack) setTimeout(paintProps, 700); };
      $("#uL").oninput = e => { if (e.target.value) setL(Number(e.target.value)); }; $("#uLm").onclick = () => setL(u.levels - 1); $("#uLp").onclick = () => setL(u.levels + 1); }
    el.querySelectorAll("[data-n]").forEach(b => b.onclick = () => requireAuth(() => { const [dx, dz, de] = b.dataset.n.split(",").map(Number); nudge(u, dx, dz, de); }));
    el.querySelectorAll(".sw").forEach(b => b.onclick = () => { change(() => { u.color = b.dataset.col; }, true); paintProps(); });
    $("#uCol").oninput = e => change(() => { u.color = e.target.value.toUpperCase(); });
    $("#uCol").onchange = () => paintProps();
    $("#uColDef").onclick = () => { change(() => { u.color = null; }, true); paintProps(); };
    el.querySelectorAll("[data-front]").forEach(b => b.onclick = () => requireAuth(() => setFront(u, b.dataset.front)));
    $("#uRot").onclick = () => turn(u, 90); $("#uRotL").onclick = () => turn(u, -90);
    $("#uWall").onclick = () => requireAuth(async () => { await flushSave(); if (snapToWall(u)) { try { await saveUnit(u); } catch (e) {} paintProps(); draw(); } });
    if ($("#uMount")) $("#uMount").onclick = () => requireAuth(async () => { await flushSave(); const before = { ...u }; if (!u.elev) u.elev = 1.2; if (snapToWall(u)) { try { await saveUnit(u); } catch (e) {} } else { Object.assign(u, before); snapUnit(u); u.elev = before.elev || 1.2; try { await saveUnit(u); } catch (e) {} } paintProps(); draw(); });
    if ($("#uUnderAdd")) $("#uUnderAdd").onclick = () => requireAuth(() => addUnderUnit(u, $("#uUnderKind").value));
    if ($("#uUnder")) $("#uUnder").onclick = () => requireAuth(() => addUnderDesk(u));
    if ($("#bxAdd")) $("#bxAdd").onclick = () => requireAuth(() => addBox(u, Number($("#bxL").value)));
    el.querySelectorAll("[data-box]").forEach(b => b.onclick = () => { S.sel = { kind: "unit", id: b.dataset.box }; paintProps(); draw(); });
    $("#uDup").onclick = () => requireAuth(() => addUnit(u.kind, u));
    $("#u3d").onclick = async () => { await flushSave(); state.spaceFocusUnit = u.id; setTab("s3d"); };
    $("#uDel").onclick = () => requireAuth(() => removeUnit(u));
  }
  async function addBox(rack, level) {
    await flushSave(); const lh = rack.h / rack.levels, n = kids(rack).length + 1;
    const b = { kind: "box", name: "Box " + n, w: 0.4, d: Math.min(0.3, rack.d), h: Math.max(0.1, Math.min(0.25, lh - 0.04)), rot: 0, levels: 1, color: null, elev: 0, parent_id: rack.id, parent_level: level, x: rack.x, z: rack.z };
    try { const id = await saveUnit(b); snapUndo({ kind: "add", id }); await load(); S.sel = { kind: "unit", id }; paintProps(); draw(); } catch (e) {}
  }
  function boxProps(u, el) {
    const p = parentOf(u), racks = S.units.filter(x => x.kind === "rack"), its = itemsAt(u.id), col = colorOf(u), ro = !state.user, over = boxLayout(p).find(e => e.b.id === u.id)?.over;
    el.innerHTML = `<fieldset style="border:0;padding:0;margin:0" ${ro ? "disabled" : ""}>
      ${ro ? `<p class="status-line err" style="margin-top:0">Sign in (top right) to edit.</p>` : ""}
      <div class="row"><div class="field"><label for="uName">Box name</label><input id="uName" type="text" maxlength="40" value="${esc(u.name)}"></div></div>
      <p class="hint">${esc(unitPath(u))}${its.length ? " · " + its.length + " item" + (its.length > 1 ? "s" : "") + " inside" : ""}</p>
      ${sec("bxon", "On the rack", `<div class="row"><div class="field" style="min-width:140px"><label for="bxR">Rack</label><select id="bxR" class="sel">${racks.map(r => `<option value="${r.id}" ${r.id === p.id ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></div>
        <div class="field" style="min-width:80px;max-width:110px"><label for="bxLv">Level</label><select id="bxLv" class="sel">${Array.from({ length: p.levels }, (_, i) => `<option ${u.parent_level === i + 1 ? "selected" : ""}>${i + 1}</option>`).join("")}</select></div></div>`)}
      ${sec("bxsize", "Size", `<div class="row"><div class="field" style="min-width:70px"><label for="uW">Width (cm)</label><input id="uW" type="number" step="5" min="10" max="300" value="${cm(u.w)}"></div><div class="field" style="min-width:70px"><label for="uD">Depth (cm)</label><input id="uD" type="number" step="5" min="10" max="300" value="${cm(u.d)}"></div><div class="field" style="min-width:70px"><label for="uH">Height (cm)</label><input id="uH" type="number" step="5" min="10" max="300" value="${cm(u.h)}"></div></div>
        <div style="margin-top:8px"><label for="uPre">Common sizes</label><select id="uPre" class="sel"><option value="">Pick a size...</option>${SIZES_BOX.map(q => `<option value="${q.join(",")}">${q[0]} × ${q[1]} × ${q[2]} cm</option>`).join("")}</select></div>
        ${over ? `<p class="status-line err">This box does not fit on that level of the rack (too wide, deep or tall).</p>` : ""}`)}
      ${sec("col", "Colour", `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${swatches(col)}<label style="display:flex;gap:6px;align-items:center;margin:0 0 0 4px;font-weight:400"><input type="color" id="uCol" value="${col}" style="width:34px;height:28px;padding:0;border:1px solid #14232B"> Other</label><button type="button" class="linkbtn" id="uColDef" style="color:var(--steel);padding:0 4px">Default</button></div>`, false)}
      <div class="row" style="margin-top:12px"><button type="button" class="btn sec" id="bxBack">Back to ${esc(p.name)}</button><button type="button" class="btn sec" id="uDup">Copy</button><button type="button" class="btn sec" id="u3d">See in 3D</button><button type="button" class="btn danger" id="uDel">Remove</button></div></fieldset>
      ${its.length ? `<p class="hint" style="margin-top:10px">Inside: ${esc(its.slice(0, 6).map(itemName).join(", "))}${its.length > 6 ? "…" : ""}</p>` : `<p class="hint" style="margin-top:10px">Nothing inside yet. Place items in it under Setup, Place items.</p>`}`;
    bindSecs(el);
    const change = (fn, now) => { if (!state.user) return; burstSnap(u); fn(); draw(); if (now) { clearTimeout(S.saveT); S.pending = u; flushSave(); } else scheduleSave(u); };
    const numIn = (id, key) => { $("#" + id).oninput = e => { const v = Number(e.target.value); if (e.target.value === "" || !(v >= 10 && v <= 300)) return; change(() => { u[key] = r2(v / 100); }); }; };
    numIn("uW", "w"); numIn("uD", "d"); numIn("uH", "h");
    $("#uName").oninput = e => { const v = e.target.value.trim(); if (v) change(() => { u.name = v; }); };
    $("#uPre").onchange = e => { if (!e.target.value) return; const [a, b, c] = e.target.value.split(",").map(Number); change(() => { u.w = a / 100; u.d = b / 100; u.h = c / 100; }, true); paintProps(); };
    const move = () => { const r = unit($("#bxR").value), lv = clamp(Number($("#bxLv").value) || 1, 1, r.levels); change(() => { u.parent_id = r.id; u.parent_level = lv; }, true); paintProps(); };
    $("#bxR").onchange = () => { $("#bxLv").innerHTML = Array.from({ length: unit($("#bxR").value).levels }, (_, i) => `<option>${i + 1}</option>`).join(""); move(); }; $("#bxLv").onchange = move;
    el.querySelectorAll(".sw").forEach(b => b.onclick = () => { change(() => { u.color = b.dataset.col; }, true); paintProps(); });
    $("#uCol").oninput = e => change(() => { u.color = e.target.value.toUpperCase(); }); $("#uCol").onchange = () => paintProps();
    $("#uColDef").onclick = () => { change(() => { u.color = null; }, true); paintProps(); };
    $("#bxBack").onclick = () => { flushSave(); S.sel = { kind: "unit", id: p.id }; paintProps(); draw(); };
    $("#uDup").onclick = () => requireAuth(() => addUnit("box", u));
    $("#u3d").onclick = async () => { await flushSave(); state.spaceFocusUnit = u.id; setTab("s3d"); };
    $("#uDel").onclick = () => requireAuth(async () => { const back = p.id; await removeUnit(u); if (!unit(u.id)) { S.sel = { kind: "unit", id: back }; paintProps(); draw(); } });
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
    const edgeM = new T.LineBasicMaterial({ color: 0xE6EEF1 });
    const addBox3 = (u, m, cx, cy, cz, wx, hy, wz, pick) => {
      const o = new T.Mesh(B(wx, hy, wz), m); o.position.set(cx, cy, cz); root.add(o);
      if (pick !== false) { o.userData.unit = u.id; k.pick.push(o); }
      const e = new T.LineSegments(new T.EdgesGeometry(B(wx, hy, wz)), edgeM); e.position.copy(o.position); root.add(e); return o;
    };
    k.mats = {};
    const matOf = u => { const m = new T.MeshStandardMaterial({ color: u.color ? parseInt(u.color.slice(1), 16) : KINDS[u.kind]?.c3 || 0x3A87AA, roughness: .6, metalness: .05, emissive: 0x000000 }); k.mats[u.id] = m; return m; };
    for (const u of tops()) {
      const f = fp(u), cx = f.x + f.w / 2, cz = f.z + f.d / 2, e0 = u.elev || 0, D = DIR[u.rot] || DIR[0], alongX = D.R[0] !== 0, m = matOf(u);
      const wd = (lr, lf) => alongX ? [lr, lf] : [lf, lr];   // a length along the front and a depth, as world x and z sizes
      if (isTable(u)) {
        const bench = u.kind === "bench", t = bench ? 0.05 : 0.035, lg = bench ? 0.07 : 0.05, ins = bench ? 0.05 : 0.04; addBox3(u, m, cx, e0 + u.h - t / 2, cz, f.w, t, f.d);
        for (const sr of [-1, 1]) for (const sf of [-1, 1]) { const px = cx + D.R[0] * sr * (u.w / 2 - ins) + D.F[0] * sf * (u.d / 2 - ins), pz = cz + D.R[1] * sr * (u.w / 2 - ins) + D.F[1] * sf * (u.d / 2 - ins); addBox3(u, m, px, e0 + (u.h - t) / 2, pz, lg, u.h - t, lg); }
        if (!bench) {
        const dm = new T.MeshStandardMaterial({ color: 0x1b2328, roughness: .5 }), top = e0 + u.h;   // a monitor and keyboard so it reads as a PC desk
        const [mw, md] = wd(Math.min(0.55, u.w * 0.5), 0.04); addBox3(u, dm, cx + D.F[0] * (u.d / 2 - 0.14), top + 0.2, cz + D.F[1] * (u.d / 2 - 0.14), mw, 0.32, md, false);
        const [kw, kd] = wd(Math.min(0.42, u.w * 0.4), 0.14); addBox3(u, dm, cx - D.F[0] * 0.08, top + 0.01, cz - D.F[1] * 0.08, kw, 0.02, kd, false);
        }
      } else if (u.kind === "rack") {
        const T3 = 0.03, lg = 0.04, lh = u.h / u.levels;
        for (let i = 0; i <= u.levels; i++) addBox3(u, m, cx, e0 + (i === u.levels ? u.h - T3 / 2 : i * lh + T3 / 2), cz, f.w, T3, f.d);
        for (const sr of [-1, 1]) for (const sf of [-1, 1]) { const px = cx + D.R[0] * sr * (u.w / 2 - lg / 2) + D.F[0] * sf * (u.d / 2 - lg / 2), pz = cz + D.R[1] * sr * (u.w / 2 - lg / 2) + D.F[1] * sf * (u.d / 2 - lg / 2); addBox3(u, m, px, e0 + u.h / 2, pz, lg, u.h, lg); }
        for (const e of boxLayout(u)) addBox3(e.b, matOf(e.b), e.cx, e.y + e.h / 2, e.cz, e.wx, e.h, e.wz);
        if (S.t) { /* level lines are the shelves themselves */ }
      } else {
        addBox3(u, m, cx, e0 + u.h / 2, cz, f.w, u.h, f.d);
        if (u.kind !== "bench" && u.kind !== "box" && u.levels > 1) {   // level lines on the front, so you can count to the right shelf
          const x0 = f.x, x1 = f.x + f.w, z0 = f.z, z1 = f.z + f.d, o2 = 0.004, ends = { 0: [[x0, z1 + o2], [x1, z1 + o2]], 90: [[x0 - o2, z0], [x0 - o2, z1]], 180: [[x0, z0 - o2], [x1, z0 - o2]], 270: [[x1 + o2, z0], [x1 + o2, z1]] }[u.rot] || [[x0, z1 + o2], [x1, z1 + o2]], segs = [];
          for (let i = 1; i < u.levels; i++) { const y = e0 + u.h * i / u.levels; segs.push(new T.Vector3(ends[0][0], y, ends[0][1]), new T.Vector3(ends[1][0], y, ends[1][1])); }
          root.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(segs), new T.LineBasicMaterial({ color: u.color && light(u.color) ? 0x14232B : 0xE6EEF1 })));
        }
      }
      const lt = label(u.name, 0.8); lt.position.set(cx, e0 + u.h + (u.kind === "desk" ? 0.55 : 0.25), cz); root.add(lt);
    }
    const mk = new T.Mesh(new T.ConeGeometry(0.16, 0.4, 16), new T.MeshBasicMaterial({ color: 0xF2C200 })); mk.rotation.x = Math.PI; mk.visible = false; root.add(mk); k.marker = mk;
  }
  function pulse(ts) {
    const k = S.t, p = 0.5 + 0.5 * Math.sin(ts / 240);
    for (const [uid, m] of Object.entries(k.mats)) { const on = S.hl === uid; m.emissive.setHex(on ? 0x6B5400 : 0x000000); m.emissiveIntensity = on ? 0.5 + p : 0; }
    const u = S.hl && unit(S.hl); if (u && k.marker) { const a = anchor(u); k.marker.visible = true; k.marker.position.set(a.x, a.y1 + (u.parent_id ? 0.45 : 0.75) + 0.15 * p, a.z); } else if (k.marker) k.marker.visible = false;
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
  function focusUnit(uid) { const k = S.t, u = unit(uid); if (!k || !u) return; const a = anchor(u), C = k.C; C.tx = a.x; C.tz = a.z; C.ty = (a.y0 + a.y1) / 2; C.dist = Math.max(u.parent_id ? 1.8 : 3, Math.max(a.w, a.d, a.y1 - a.y0) * 2.4); camUpdate(); }
  function focusItem(kind, id) {
    const x = allItems().find(a => a.kind === kind && String(a.it.id) === String(id)); if (!x) return; if (!x.it.unit_id || !unit(x.it.unit_id)) { toast(itemName(x) + " has no place yet. Set one under Setup, Place items."); return; }
    S.hl = x.it.unit_id; S.sel = { kind: "unit", id: S.hl }; S.focusItem = kind + ":" + x.it.id; focusUnit(S.hl); paintSide();
  }
  function paintSide() {
    const el = $("#s3Side"); if (!el) return; const u = S.sel && S.sel.kind === "unit" ? unit(S.sel.id) : null;
    const find = `<div class="field"><label for="sFind">What are you looking for?</label><input id="sFind" type="text" placeholder="e.g. cutter, M6, screw" value="${esc(S.find || "")}" autocomplete="off"></div><div id="sRes" style="margin-top:8px"></div>`;
    if (!u) { el.innerHTML = find + `<p class="hint" style="margin-top:12px">Or click a shelf or cabinet in the 3D view to see what is inside.</p>`; bindFind(); showRes(); return; }
    const rm = roomOf(u), p = parentOf(u), hi = x => S.focusItem === x.kind + ":" + x.it.id ? "font-weight:700" : "";
    const itemRows = its => its.map(x => `<div style="font-size:14px;${hi(x)}"><i class="lg" style="background:${x.kind === "tool" ? "#F2C200" : "#2FB3B3"}"></i>${esc(itemName(x))}${x.kind === "tool" && x.it.status === "out" ? " (out)" : ""}</div>`).join("");
    let body;
    if (p) body = (itemsAt(u.id).length ? itemRows(itemsAt(u.id)) : `<p class="hint">Nothing stored in this box yet.</p>`) + `<div class="row" style="margin-top:10px"><button class="btn sec" id="sRack">Show the rack</button></div>`;
    else body = Array.from({ length: u.levels }, (_, i) => u.levels - i).map(lv => {
      const its = itemsAt(u.id, lv), bx = kids(u).filter(b => b.parent_level === lv);
      return its.length || bx.length ? `<div style="border-top:1px solid var(--line);padding:6px 0"><strong>Level ${lv}</strong>${itemRows(its)}${bx.map(b => `<div style="margin-top:4px"><button class="linkbtn" style="color:var(--steel);padding:0;font-size:14px;font-weight:600" data-box="${b.id}">▢ ${esc(b.name)}</button>${itemRows(itemsAt(b.id)) || `<div class="hint" style="margin:0 0 0 14px">empty</div>`}</div>`).join("")}</div>` : "";
    }).join("") || `<p class="hint">Nothing stored here yet.</p>`;
    el.innerHTML = find + `<h2 style="margin-top:16px">${esc(u.name)}</h2><p class="hint">${rm ? esc(rm.name) + ". " : ""}${p ? "In " + esc(p.name) + ", level " + u.parent_level + "." : "Level 1 is the lowest."}${u.elev > 0 && !p ? " Hangs " + cm(u.elev) + " cm above the floor." : ""}</p>${body}
      <div class="row" style="margin-top:10px"><button class="btn sec" id="sEdit">Edit in space plan</button></div>`;
    bindFind(); showRes(); $("#sEdit").onclick = () => { S.sel = { kind: "unit", id: u.id }; setTab("splan"); };
    if ($("#sRack")) $("#sRack").onclick = () => { S.hl = p.id; S.sel = { kind: "unit", id: p.id }; focusUnit(p.id); paintSide(); };
    el.querySelectorAll("[data-box]").forEach(b => b.onclick = () => { S.hl = b.dataset.box; S.sel = { kind: "unit", id: S.hl }; focusUnit(S.hl); paintSide(); });
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
      const ops = uid => S.units.map(uu => `<option value="${uu.id}" ${uu.id === uid ? "selected" : ""}>${esc(unitPath(uu))}</option>`).join("");
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
