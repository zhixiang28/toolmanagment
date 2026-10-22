/* Space mode: draw your rooms, shelves and cabinets, see them in 3D, and keep track of where every tool and consumable lives.
   Plan  - 2D editor: rooms in metres, drag shelves, cabinets, drawer units and benches into place.
   3D    - the same layout as a 3D model you can orbit. Tools and consumables show up where you put them. Find anything by name.
   Items - give each tool and consumable a place (shelf or cabinet, and which level).
   Loaded on demand by index.html, which provides: state, $, esc, toast, guard, rpcAuth, requireAuth, refreshAll, setTab, setMode, labelTables, sb. */
(function () {
  const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js";
  const KINDS = {
    shelf: { label: "Shelf", w: 1.0, d: 0.4, h: 1.8, levels: 4, fill: "#24607A" },
    cabinet: { label: "Cabinet", w: 0.8, d: 0.5, h: 1.8, levels: 3, fill: "#5B6B73" },
    drawers: { label: "Drawer unit", w: 0.6, d: 0.6, h: 0.9, levels: 5, fill: "#2F7D7A" },
    bench: { label: "Workbench", w: 1.5, d: 0.7, h: 0.9, levels: 1, fill: "#8A6A3F" },
  };
  const S = { rooms: [], units: [], roomId: null, selId: null, drag: null, view: null, t: null, hl: null };
  const num = o => { const r = { ...o }; ["w", "d", "h", "x", "z"].forEach(k => { if (k in r) r[k] = Number(r[k]); }); if ("rot" in r) r.rot = Number(r.rot); if ("levels" in r) r.levels = Number(r.levels); return r; };
  const snap = v => Math.round(v / 0.05) * 0.05, r2 = v => Math.round(v * 100) / 100, clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const fp = u => { const sw = u.rot % 180 !== 0; return { x: u.x, z: u.z, w: sw ? u.d : u.w, d: sw ? u.w : u.d }; };
  const room = id => S.rooms.find(r => r.id === id), unit = id => S.units.find(u => u.id === id);
  const unitsOf = id => S.units.filter(u => u.room_id === id);
  const loadScript = src => new Promise((res, rej) => { const el = document.createElement("script"); el.src = src; el.onload = res; el.onerror = () => rej(new Error("Could not load " + src)); document.head.appendChild(el); });
  const lowItem = i => Number(i.min_stock) > 0 && Number(i.count_on_hand) <= Number(i.min_stock);
  const allItems = () => [...state.tools.map(it => ({ kind: "tool", it })), ...state.citems.map(it => ({ kind: "consumable", it }))];
  const itemsAt = (uid, lvl) => allItems().filter(x => x.it.unit_id === uid && (lvl == null || Number(x.it.level) === lvl));
  const itemName = x => x.it.name + (x.it.spec ? " " + x.it.spec : "");
  const whereOf = it => { const u = unit(it.unit_id); if (!u) return null; const r = room(u.room_id); return (r ? r.name + " · " : "") + u.name + " · level " + it.level; };

  async function load() {
    const [rooms, units] = await Promise.all([guard(sb.from("space_rooms").select("*").eq("active", true).order("created_at")), guard(sb.from("space_units").select("*").eq("active", true).order("created_at"))]);
    S.rooms = rooms.map(num); S.units = units.map(num); if (!room(S.roomId)) S.roomId = S.rooms[0]?.id || null; if (S.selId && !unit(S.selId)) S.selId = null;
  }
  const saveRoom = r => guard(rpcAuth("toolscale_space_room_save", { p_id: r.id || null, p_name: r.name, p_w: r2(r.w), p_d: r2(r.d), p_h: r2(r.h) }));
  const saveUnit = u => guard(rpcAuth("toolscale_space_unit_save", { p_id: u.id || null, p_room: u.room_id, p_kind: u.kind, p_name: u.name, p_x: r2(u.x), p_z: r2(u.z), p_w: r2(u.w), p_d: r2(u.d), p_h: r2(u.h), p_rot: u.rot, p_levels: u.levels }));
  function stop() { S.view = null; S.drag = null; window.onresize = null; if (S.t) { cancelAnimationFrame(S.t.raf); try { S.t.renderer.dispose(); } catch (e) {} window.removeEventListener("resize", S.t.onResize); S.t = null; } }

  /* ====================================================== Plan (2D) ====================================================== */
  async function plan() {
    stop(); const me = S.view = {};
    $("#main").innerHTML = `<div class="summary"><div><h1>Plan</h1><p>Draw each room, then drop in shelves, cabinets, drawer units and benches. Drag them into place. Sizes are in metres.</p></div></div>
      <div class="filters" id="sRooms"></div><div class="row" id="sAdd" style="margin-bottom:12px"></div>
      <div class="split"><div class="panel" style="padding:8px"><canvas id="sCv" style="width:100%;display:block;touch-action:none;background:var(--panel)"></canvas><p class="hint" id="sHint" style="margin:6px 4px 0"></p></div><div class="panel" id="sProps"></div></div>`;
    try { await load(); } catch (e) { return; } if (S.view !== me) return;
    paintRooms(); paintAdd(); paintProps(); draw(); bindCanvas(); window.onresize = () => { if (S.view === me) draw(); };
  }
  function paintRooms() {
    const el = $("#sRooms"); if (!el) return;
    el.innerHTML = S.rooms.map(r => `<button data-room="${r.id}" aria-pressed="${r.id === S.roomId}">${esc(r.name)}</button>`).join("") + `<button data-act="room-add" style="border-style:dashed">+ Room</button>` + (S.roomId ? `<button data-act="room-edit" style="border-style:dashed">Edit room</button>` : "");
    el.querySelectorAll("[data-room]").forEach(b => b.onclick = () => { S.roomId = b.dataset.room; S.selId = null; paintRooms(); paintProps(); draw(); });
    el.querySelector('[data-act="room-add"]').onclick = () => requireAuth(() => roomDialog(null)); const ed = el.querySelector('[data-act="room-edit"]'); if (ed) ed.onclick = () => requireAuth(() => roomDialog(room(S.roomId)));
  }
  function paintAdd() {
    const el = $("#sAdd"); if (!el) return; if (!S.roomId) { el.innerHTML = `<p class="hint">Start by adding a room with the <strong>+ Room</strong> button.</p>`; return; }
    el.innerHTML = `<span class="hint" style="margin:0">Add:</span>` + Object.entries(KINDS).map(([k, v]) => `<button class="btn sec" data-add="${k}">${v.label}</button>`).join("");
    el.querySelectorAll("[data-add]").forEach(b => b.onclick = () => requireAuth(() => addUnit(b.dataset.add)));
  }
  async function addUnit(kind) {
    const r = room(S.roomId); if (!r) return; const k = KINDS[kind], u = { room_id: r.id, kind, name: k.label + " " + (unitsOf(r.id).filter(x => x.kind === kind).length + 1), w: Math.min(k.w, r.w), d: Math.min(k.d, r.d), h: k.h, rot: 0, levels: k.levels };
    u.x = snap(Math.max(0, (r.w - u.w) / 2)); u.z = snap(Math.max(0, (r.d - u.d) / 2));
    try { const id = await saveUnit(u); await load(); S.selId = id; paintProps(); draw(); } catch (e) {}
  }
  const geo = { pad: 28, ppm: 100 };
  function draw() {
    const cv = $("#sCv"), r = room(S.roomId); if (!cv) return; const g = cv.getContext("2d");
    if (!r) { cv.width = 600; cv.height = 240; g.fillStyle = "#16252D"; g.fillRect(0, 0, 600, 240); g.fillStyle = "#9DB0B8"; g.font = "16px sans-serif"; g.fillText("No room yet. Press + Room.", 20, 120); return; }
    const cw = Math.max(280, cv.parentElement.clientWidth - 16), pad = geo.pad; geo.ppm = Math.min((cw - 2 * pad) / r.w, 560 / r.d);
    cv.width = Math.round(r.w * geo.ppm + 2 * pad); cv.height = Math.round(r.d * geo.ppm + 2 * pad); const p = geo.ppm;
    const css = getComputedStyle(document.documentElement), ink = css.getPropertyValue("--ink").trim() || "#14232B", line = css.getPropertyValue("--line").trim() || "#C2CBD0";
    g.fillStyle = "#EEF1F2"; g.fillRect(0, 0, cv.width, cv.height); g.fillStyle = "#fff"; g.fillRect(pad, pad, r.w * p, r.d * p);
    g.lineWidth = 1; g.font = "11px sans-serif"; g.textBaseline = "top";
    for (let x = 0; x <= r.w + 1e-6; x += 0.5) { const major = Math.abs(x - Math.round(x)) < 1e-6; g.strokeStyle = major ? "#B9C4C9" : "#E2E8EB"; g.beginPath(); g.moveTo(pad + x * p, pad); g.lineTo(pad + x * p, pad + r.d * p); g.stroke(); if (major) { g.fillStyle = "#5B6B73"; g.fillText(x + " m", pad + x * p + 2, 6); } }
    for (let z = 0; z <= r.d + 1e-6; z += 0.5) { const major = Math.abs(z - Math.round(z)) < 1e-6; g.strokeStyle = major ? "#B9C4C9" : "#E2E8EB"; g.beginPath(); g.moveTo(pad, pad + z * p); g.lineTo(pad + r.w * p, pad + z * p); g.stroke(); if (major && z > 0) { g.fillStyle = "#5B6B73"; g.fillText(z + " m", 2, pad + z * p - 13); } }
    g.strokeStyle = "#14232B"; g.lineWidth = 3; g.strokeRect(pad, pad, r.w * p, r.d * p);
    for (const u of unitsOf(r.id)) {
      const f = fp(u), x = pad + f.x * p, y = pad + f.z * p, w = f.w * p, h = f.d * p, sel = u.id === S.selId, n = itemsAt(u.id).length;
      g.fillStyle = KINDS[u.kind]?.fill || "#24607A"; g.globalAlpha = .92; g.fillRect(x, y, w, h); g.globalAlpha = 1; g.strokeStyle = sel ? "#F2C200" : "#14232B"; g.lineWidth = sel ? 4 : 1.5; g.strokeRect(x, y, w, h);
      g.strokeStyle = "#fff"; g.lineWidth = 4; g.beginPath();   // the front edge, so you can tell which way a unit faces
      if (u.rot === 0) { g.moveTo(x + 3, y + h - 2); g.lineTo(x + w - 3, y + h - 2); } else if (u.rot === 90) { g.moveTo(x + 2, y + 3); g.lineTo(x + 2, y + h - 3); } else if (u.rot === 180) { g.moveTo(x + 3, y + 2); g.lineTo(x + w - 3, y + 2); } else { g.moveTo(x + w - 2, y + 3); g.lineTo(x + w - 2, y + h - 3); } g.stroke();
      g.save(); g.beginPath(); g.rect(x + 3, y + 3, w - 6, h - 6); g.clip(); g.fillStyle = "#fff"; g.font = "600 12px sans-serif"; g.textBaseline = "top"; g.fillText(u.name, x + 6, y + 6); if (n) { g.font = "11px sans-serif"; g.fillText(n + " item" + (n > 1 ? "s" : ""), x + 6, y + 22); } g.restore();
    }
    const hint = $("#sHint"); if (hint) hint.textContent = state.user ? "Drag a unit to move it. Pick one to change its size, levels or direction. The white edge is the front." : "Sign in (top right) to move things. You can still look around and pick units.";
  }
  function bindCanvas() {
    const cv = $("#sCv"); if (!cv) return;
    const world = e => { const b = cv.getBoundingClientRect(), k = cv.width / b.width; return { x: ((e.clientX - b.left) * k - geo.pad) / geo.ppm, z: ((e.clientY - b.top) * k - geo.pad) / geo.ppm }; };
    const hit = w => { const list = unitsOf(S.roomId); for (let i = list.length - 1; i >= 0; i--) { const f = fp(list[i]); if (w.x >= f.x && w.x <= f.x + f.w && w.z >= f.z && w.z <= f.z + f.d) return list[i]; } return null; };
    cv.onpointerdown = e => {
      const w = world(e), u = hit(w); S.selId = u ? u.id : null; paintProps(); draw(); if (!u) return;
      if (!state.user) { toast("Sign in to move things."); return; }
      const f = fp(u); S.drag = { id: u.id, dx: w.x - f.x, dz: w.z - f.z, ox: u.x, oz: u.z, moved: false }; cv.setPointerCapture(e.pointerId);
    };
    cv.onpointermove = e => {
      const d = S.drag; if (!d) return; const u = unit(d.id), r = room(u.room_id), f = fp(u), w = world(e);
      u.x = clamp(snap(w.x - d.dx), 0, Math.max(0, r.w - f.w)); u.z = clamp(snap(w.z - d.dz), 0, Math.max(0, r.d - f.d)); if (u.x !== d.ox || u.z !== d.oz) d.moved = true; draw();
    };
    cv.onpointerup = async () => {
      const d = S.drag; S.drag = null; if (!d || !d.moved) return; const u = unit(d.id);
      try { await saveUnit(u); paintProps(); } catch (e) { u.x = d.ox; u.z = d.oz; draw(); }
    };
  }
  function paintProps() {
    const el = $("#sProps"); if (!el) return; const u = unit(S.selId);
    if (!u) { const r = room(S.roomId); el.innerHTML = r ? `<h2>${esc(r.name)}</h2><p>${r.w} × ${r.d} m, ${r.h} m high.</p><p class="hint">${unitsOf(r.id).length} shelf or cabinet${unitsOf(r.id).length === 1 ? "" : "s"} in this room. Pick one to edit it.</p>` : `<p class="hint">Add a room to begin.</p>`; return; }
    const its = itemsAt(u.id);
    el.innerHTML = `<h2>${esc(u.name)}</h2>
      <div style="display:grid;gap:10px"><div><label for="uName">Name</label><input id="uName" type="text" maxlength="40" value="${esc(u.name)}"></div>
      <div><label for="uKind">Type</label><select id="uKind" class="sel">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${k === u.kind ? "selected" : ""}>${v.label}</option>`).join("")}</select></div>
      <div class="row"><div class="field"><label for="uW">Width (m)</label><input id="uW" type="number" step="0.05" min="0.1" value="${u.w}"></div><div class="field"><label for="uD">Depth (m)</label><input id="uD" type="number" step="0.05" min="0.1" value="${u.d}"></div></div>
      <div class="row"><div class="field"><label for="uH">Height (m)</label><input id="uH" type="number" step="0.05" min="0.1" value="${u.h}"></div><div class="field"><label for="uL">${u.kind === "drawers" ? "Drawers" : u.kind === "bench" ? "Levels" : "Shelves / levels"}</label><input id="uL" type="number" step="1" min="1" max="20" value="${u.levels}"></div></div>
      <div class="row"><button class="btn sec" id="uRot">Turn 90°</button><button class="btn sec" id="uDup">Copy</button><button class="btn danger" id="uDel">Remove</button></div>
      <p class="hint">${its.length ? its.length + " item" + (its.length > 1 ? "s" : "") + " stored here: " + esc(its.slice(0, 6).map(itemName).join(", ")) + (its.length > 6 ? "…" : "") : "Nothing stored here yet. Place items on the Items tab."}</p></div>`;
    let t = null; const apply = () => requireAuth(async () => {
      const r = room(u.room_id), n = { ...u, name: $("#uName").value.trim() || u.name, kind: $("#uKind").value, w: Math.max(0.1, Number($("#uW").value) || u.w), d: Math.max(0.1, Number($("#uD").value) || u.d), h: Math.max(0.1, Number($("#uH").value) || u.h), levels: clamp(Math.round(Number($("#uL").value) || u.levels), 1, 20) };
      Object.assign(u, n); const f = fp(u); u.x = clamp(u.x, 0, Math.max(0, r.w - f.w)); u.z = clamp(u.z, 0, Math.max(0, r.d - f.d));
      try { await saveUnit(u); } catch (e) {} draw();
    });
    ["uName", "uKind", "uW", "uD", "uH", "uL"].forEach(id => { $("#" + id).onchange = () => { clearTimeout(t); t = setTimeout(apply, 150); }; });
    $("#uRot").onclick = () => requireAuth(async () => { const r = room(u.room_id); u.rot = (u.rot + 90) % 360; const f = fp(u); u.x = clamp(u.x, 0, Math.max(0, r.w - f.w)); u.z = clamp(u.z, 0, Math.max(0, r.d - f.d)); try { await saveUnit(u); } catch (e) {} draw(); });
    $("#uDup").onclick = () => requireAuth(async () => { const c = { ...u, id: null, name: u.name + " copy", x: snap(u.x + 0.2), z: snap(u.z + 0.2) }; const r = room(u.room_id), f = fp(c); c.x = clamp(c.x, 0, Math.max(0, r.w - f.w)); c.z = clamp(c.z, 0, Math.max(0, r.d - f.d)); try { const id = await saveUnit(c); await load(); S.selId = id; paintProps(); draw(); } catch (e) {} });
    $("#uDel").onclick = () => requireAuth(async () => { if (!confirm("Remove " + u.name + "? Items stored here become unplaced.")) return; try { await guard(rpcAuth("toolscale_space_remove", { p_kind: "unit", p_id: u.id })); S.selId = null; await load(); await refreshAll(); paintProps(); draw(); } catch (e) {} });
  }
  function roomDialog(r) {
    const d = $("#dlg"); d.innerHTML = `<form method="dialog" id="rmForm"><div class="dlg-h"><h2>${r ? "Edit room" : "Add room"}</h2></div><div class="dlg-b">
      <div><label for="rName">Room name</label><input id="rName" type="text" required maxlength="40" placeholder="e.g. Workshop" value="${esc(r?.name || "")}"></div>
      <div class="row"><div class="field"><label for="rW">Width (m)</label><input id="rW" type="number" step="0.1" min="0.5" required value="${r?.w ?? 5}"></div><div class="field"><label for="rD">Depth (m)</label><input id="rD" type="number" step="0.1" min="0.5" required value="${r?.d ?? 4}"></div><div class="field"><label for="rH">Height (m)</label><input id="rH" type="number" step="0.1" min="1" required value="${r?.h ?? 2.6}"></div></div>
      <p class="hint">Rooms are rectangles. Measure the floor with a tape measure and round to 0.1 m.</p></div>
      <div class="dlg-f">${r ? `<button type="button" class="btn danger" id="rDel" style="margin-right:auto">Remove room</button>` : ""}<button type="button" class="btn sec" id="rCancel">Cancel</button><button type="submit" class="btn">Save room</button></div></form>`;
    d.showModal(); $("#rCancel").onclick = () => d.close();
    $("#rDel")?.addEventListener("click", async () => { if (!confirm("Remove " + r.name + " and everything in it? Stored items become unplaced.")) return; try { await guard(rpcAuth("toolscale_space_remove", { p_kind: "room", p_id: r.id })); S.roomId = null; await load(); await refreshAll(); d.close(); paintRooms(); paintAdd(); paintProps(); draw(); } catch (e) {} });
    $("#rmForm").onsubmit = async e => { e.preventDefault(); try { const id = await saveRoom({ id: r?.id, name: $("#rName").value.trim(), w: Number($("#rW").value), d: Number($("#rD").value), h: Number($("#rH").value) }); S.roomId = id; await load(); d.close(); paintRooms(); paintAdd(); paintProps(); draw(); } catch (err) {} };
  }

  /* ====================================================== 3D ====================================================== */
  async function view3d() {
    stop(); const me = S.view = {};
    $("#main").innerHTML = `<div class="summary"><div><h1>3D</h1><p>Your rooms as a model. Drag to turn, scroll or pinch to zoom, right-drag or two fingers to move. Click a shelf to see what is on it.</p></div></div>
      <div class="split"><div class="panel" style="padding:0"><div id="s3Box" style="position:relative;width:100%;height:clamp(300px,62vw,520px);background:#16252D;overflow:hidden"><canvas id="s3" style="width:100%;height:100%;display:block;touch-action:none"></canvas><div id="s3Msg" class="hint" style="position:absolute;left:12px;top:10px;color:#9DB0B8;margin:0">Loading 3D...</div></div>
        <div class="row" style="padding:8px 12px;gap:14px;font-size:13px"><span><i style="background:#F2C200" class="lg"></i>Tool</span><span><i style="background:#2FB3B3" class="lg"></i>Consumable</span><span><i style="background:#B83A26" class="lg"></i>Low stock</span><span><i style="border:2px solid #F2C200;background:transparent" class="lg"></i>Tool is out</span></div></div>
        <div class="panel" id="s3Side"></div></div>`;
    try { await Promise.all([load(), window.THREE ? 0 : loadScript(THREE_URL)]); } catch (e) { const m = $("#s3Msg"); if (m) m.textContent = "Could not load 3D: " + (e.message || e); return; }
    if (S.view !== me) return; if (!window.WebGLRenderingContext) { $("#s3Msg").textContent = "This browser cannot show 3D."; return; }
    try { init3d(me); } catch (e) { const m = $("#s3Msg"); if (m) m.textContent = "Could not start 3D: " + (e.message || e); return; }
    $("#s3Msg").textContent = S.rooms.length ? "" : "No rooms yet. Draw one on the Plan tab."; paintSide();
    if (state.spaceFocus) { const f = state.spaceFocus; state.spaceFocus = null; focusItem(f.kind, f.id); }
  }
  function init3d(me) {
    const T = THREE, cv = $("#s3"), box = $("#s3Box"), renderer = new T.WebGLRenderer({ canvas: cv, antialias: true }), scene = new T.Scene(), camera = new T.PerspectiveCamera(45, 1, 0.05, 500);
    scene.background = new T.Color(0x16252D); scene.add(new T.HemisphereLight(0xffffff, 0x445566, 0.85)); const sun = new T.DirectionalLight(0xffffff, 0.8); sun.position.set(6, 12, 8); scene.add(sun);
    const root = new T.Group(); scene.add(root);
    const t = S.t = { T, renderer, scene, camera, root, C: { th: 0.9, ph: 0.95, dist: 9, tx: 2, ty: 0.9, tz: 1.5 }, pick: [], unitG: {}, mats: {}, itemM: {}, layout: {}, raf: 0, ptr: new Map(), moved: 0 };
    const resize = () => { const w = box.clientWidth, h = box.clientHeight; renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }; t.onResize = resize; window.addEventListener("resize", resize); resize();
    build(); fit(); camUpdate(); controls(cv);
    const loop = t0 => { if (S.t !== t) return; t.raf = requestAnimationFrame(loop); pulse(t0); renderer.render(scene, camera); }; t.raf = requestAnimationFrame(loop);
  }
  function camUpdate() { const t = S.t, C = t.C, sp = Math.sin(C.ph), cp = Math.cos(C.ph); t.camera.position.set(C.tx + C.dist * sp * Math.cos(C.th), C.ty + C.dist * cp, C.tz + C.dist * sp * Math.sin(C.th)); t.camera.lookAt(C.tx, C.ty, C.tz); }
  function fit() {
    const t = S.t, C = t.C; if (!S.rooms.length) return; let w = 0, d = 0, h = 2; S.rooms.forEach(r => { w += r.w + 1.5; d = Math.max(d, r.d); h = Math.max(h, r.h); }); w -= 1.5;
    C.tx = w / 2; C.tz = d / 2; C.ty = 0.9; C.dist = Math.max(w * 0.8, d * 1.4) + 2; C.th = 1.1; C.ph = 0.95; camUpdate();
  }
  function label(text, s) {
    const T = THREE, c = document.createElement("canvas"); c.width = 256; c.height = 64; const g = c.getContext("2d"); g.fillStyle = "rgba(14,24,29,.78)"; g.fillRect(0, 0, 256, 64); g.fillStyle = "#fff"; g.font = "600 28px sans-serif"; g.textBaseline = "middle"; g.fillText(text.length > 16 ? text.slice(0, 15) + "…" : text, 12, 34);
    const sp = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(c), transparent: true, depthTest: false })); sp.scale.set(s, s / 4, 1); sp.renderOrder = 5; return sp;
  }
  function lvlY(u, i) { if (u.kind === "drawers") return (i - 0.5) * u.h / u.levels; if (u.kind === "bench") return u.h; return 0.08 + (i - 1) * (u.h - 0.12) / u.levels; }
  function build() {
    const t = S.t, T = t.T, root = t.root; while (root.children.length) root.remove(root.children[0]); t.pick = []; t.unitG = {}; t.mats = {}; t.layout = {};
    const mat = (c, o = {}) => new T.MeshStandardMaterial({ color: c, roughness: .7, metalness: .1, ...o }), mesh = (g, m, x, y, z) => { const o = new T.Mesh(g, m); o.position.set(x, y, z); return o; }, B = (w, h, d) => new T.BoxGeometry(w, h, d);
    let ox = 0;
    for (const r of S.rooms) {
      t.layout[r.id] = ox; const floor = mesh(B(r.w, 0.04, r.d), mat(0x2c3e47), ox + r.w / 2, -0.02, r.d / 2); root.add(floor);
      const wm = new T.MeshBasicMaterial({ color: 0x9DB0B8, transparent: true, opacity: 0.07, depthWrite: false }), edge = new T.LineBasicMaterial({ color: 0x9DB0B8 }), wall = mesh(B(r.w, r.h, r.d), wm, ox + r.w / 2, r.h / 2, r.d / 2); wall.material.side = T.BackSide; root.add(wall);
      { const e = new T.LineSegments(new T.EdgesGeometry(B(r.w, r.h, r.d)), edge); e.position.set(ox + r.w / 2, r.h / 2, r.d / 2); root.add(e); }
      const lb = label(r.name, 1.3); lb.position.set(ox + 0.8, r.h + 0.25, 0.2); root.add(lb);
      for (const u of unitsOf(r.id)) {
        const f = fp(u), g = new T.Group(); g.position.set(ox + f.x + f.w / 2, 0, f.z + f.d / 2); g.rotation.y = -u.rot * Math.PI / 180; g.userData.unit = u.id; t.unitG[u.id] = g; t.mats[u.id] = [];
        const add = (geo, m, x, y, z, solid = true) => { const o = mesh(geo, m, x, y, z); o.userData.unit = u.id; g.add(o); if (solid) t.pick.push(o); if (m.emissive) t.mats[u.id].push(m); return o; };
        const col = KINDS[u.kind]?.fill ? parseInt(KINDS[u.kind].fill.slice(1), 16) : 0x24607A, pm = () => mat(col), bm = () => mat(0xC5CDD2);
        if (u.kind === "shelf") {
          [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) => add(B(0.04, u.h, 0.04), pm(), sx * (u.w / 2 - 0.02), u.h / 2, sz * (u.d / 2 - 0.02)));
          for (let i = 1; i <= u.levels; i++) add(B(u.w, 0.03, u.d), bm(), 0, lvlY(u, i), 0); add(B(u.w, 0.03, u.d), bm(), 0, u.h, 0);
        } else if (u.kind === "cabinet") {
          add(B(u.w, u.h, u.d), mat(col, { transparent: true, opacity: 0.28, depthWrite: false }), 0, u.h / 2, 0); { const e = new T.LineSegments(new T.EdgesGeometry(B(u.w, u.h, u.d)), new T.LineBasicMaterial({ color: 0xE6EEF1 })); e.position.set(0, u.h / 2, 0); g.add(e); }
          for (let i = 1; i <= u.levels; i++) add(B(u.w - 0.04, 0.02, u.d - 0.04), bm(), 0, lvlY(u, i), 0);
          [-1, 1].forEach(s => add(B(u.w / 2 - 0.02, u.h - 0.04, 0.02), mat(col, { transparent: true, opacity: 0.45, depthWrite: false }), s * (u.w / 4), u.h / 2, u.d / 2 + 0.01));
        } else if (u.kind === "drawers") {
          add(B(u.w, u.h, u.d), mat(0x3E4B52), 0, u.h / 2, 0);
          for (let i = 1; i <= u.levels; i++) { const yy = lvlY(u, i), hh = u.h / u.levels - 0.02; add(B(u.w - 0.04, hh, 0.03), pm(), 0, yy, u.d / 2 + 0.015); add(B(Math.min(0.2, u.w / 2), 0.02, 0.03), bm(), 0, yy + hh / 4, u.d / 2 + 0.045); }
        } else {
          add(B(u.w, 0.05, u.d), mat(col), 0, u.h - 0.025, 0); [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) => add(B(0.05, u.h - 0.05, 0.05), bm(), sx * (u.w / 2 - 0.04), (u.h - 0.05) / 2, sz * (u.d / 2 - 0.04)));
        }
        root.add(g);
        const lt = label(u.name, 0.7); lt.position.set(ox + f.x + f.w / 2, u.h + 0.22, f.z + f.d / 2); root.add(lt);
      }
      ox += r.w + 1.5;
    }
    placeItems();
  }
  function placeItems() {
    const t = S.t, T = t.T; (t.items || []).forEach(o => o.parent && o.parent.remove(o)); t.items = []; t.itemM = {}; t.pick = t.pick.filter(o => !o.userData.item);
    for (const u of S.units) {
      const g = t.unitG[u.id]; if (!g) continue;
      for (let lv = 1; lv <= u.levels; lv++) {
        const list = itemsAt(u.id, lv); const cols = Math.max(1, Math.min(list.length, Math.floor(u.w / 0.15)));
        list.forEach((x, k) => {
          const idx = k % cols, row = Math.floor(k / cols), px = -u.w / 2 + (idx + 0.5) * u.w / cols, isTool = x.kind === "tool", out = isTool && x.it.status === "out", low = !isTool && lowItem(x.it);
          const colr = low ? 0xB83A26 : isTool ? 0xF2C200 : 0x2FB3B3, m = new T.MeshStandardMaterial({ color: colr, roughness: .6, emissive: 0x000000, transparent: out, opacity: out ? 0.3 : 1, wireframe: false });
          let geoB, py, pz; if (u.kind === "drawers") { geoB = new T.BoxGeometry(0.11, 0.05, 0.02); py = lvlY(u, lv) - 0.02 - row * 0.06; pz = u.d / 2 + 0.06; } else { geoB = new T.BoxGeometry(0.11, 0.09, 0.11); py = lvlY(u, lv) + 0.015 + 0.045; pz = -u.d / 2 + 0.08 + row * 0.13; if (pz > u.d / 2 - 0.06) pz = u.d / 2 - 0.06; }
          const o = new T.Mesh(geoB, m); o.position.set(px, py, pz); o.userData = { item: { kind: x.kind, id: x.it.id }, unit: u.id }; g.add(o); t.items.push(o); t.pick.push(o); t.itemM[x.kind + ":" + x.it.id] = o;
          if (out) { const e = new T.LineSegments(new T.EdgesGeometry(geoB), new T.LineBasicMaterial({ color: 0xF2C200 })); e.position.copy(o.position); g.add(e); t.items.push(e); }
        });
      }
    }
  }
  function pulse(ts) {
    const t = S.t, k = 0.5 + 0.5 * Math.sin(ts / 260);
    for (const [uid, ms] of Object.entries(t.mats)) ms.forEach(m => { m.emissive.setHex(S.hl && S.hl.unit === uid ? 0x554400 : 0x000000); m.emissiveIntensity = S.hl && S.hl.unit === uid ? 0.4 + k : 0; });
    for (const [key, o] of Object.entries(t.itemM)) { const on = S.hl && S.hl.item === key; o.scale.setScalar(on ? 1.2 + 0.5 * k : 1); o.material.emissive.setHex(on ? 0xFFFFFF : 0x000000); o.material.emissiveIntensity = on ? 0.5 * k : 0; }
  }
  function controls(cv) {
    const t = S.t, C = t.C; let last = null;
    cv.onpointerdown = e => { cv.setPointerCapture(e.pointerId); t.ptr.set(e.pointerId, { x: e.clientX, y: e.clientY, b: e.button, sx: e.clientX, sy: e.clientY }); t.moved = 0; };
    cv.onpointermove = e => {
      const p = t.ptr.get(e.pointerId); if (!p) return; const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (t.ptr.size === 1) {
        t.moved += Math.abs(dx) + Math.abs(dy);
        if (e.shiftKey || p.b === 2) { const sc = C.dist * 0.0018, rx = Math.sin(C.th), rz = -Math.cos(C.th), fx = -Math.cos(C.th), fz = -Math.sin(C.th); C.tx += (-rx * dx + fx * dy) * sc; C.tz += (-rz * dx + fz * dy) * sc; }
        else { C.th -= dx * 0.008; C.ph = clamp(C.ph - dy * 0.008, 0.12, 1.52); }
      } else if (t.ptr.size === 2) {
        const o = [...t.ptr.entries()].find(([id]) => id !== e.pointerId)[1], before = Math.hypot(p.x - o.x, p.y - o.y), after = Math.hypot(e.clientX - o.x, e.clientY - o.y);
        if (before > 0 && after > 0) C.dist = clamp(C.dist * before / after, 0.8, 80); t.moved += 10;
      }
      p.x = e.clientX; p.y = e.clientY; camUpdate();
    };
    const up = e => { const p = t.ptr.get(e.pointerId); t.ptr.delete(e.pointerId); if (p && t.ptr.size === 0 && t.moved < 6) pick(e, cv); };
    cv.onpointerup = up; cv.onpointercancel = e => t.ptr.delete(e.pointerId); cv.oncontextmenu = e => e.preventDefault();
    cv.onwheel = e => { e.preventDefault(); C.dist = clamp(C.dist * (1 + e.deltaY * 0.001), 0.8, 80); camUpdate(); };
  }
  function pick(e, cv) {
    const t = S.t, T = t.T, b = cv.getBoundingClientRect(), v = new T.Vector2(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1), rc = new T.Raycaster(); rc.setFromCamera(v, t.camera);
    const hits = rc.intersectObjects(t.pick, false); const h = hits.find(x => x.object.userData.item) || hits[0];
    if (!h) { S.selId = null; S.hl = null; paintSide(); return; }
    S.selId = h.object.userData.unit; S.hl = h.object.userData.item ? { unit: S.selId, item: h.object.userData.item.kind + ":" + h.object.userData.item.id } : { unit: S.selId }; paintSide();
  }
  function focusUnit(uid) { const t = S.t, u = unit(uid); if (!t || !u) return; const f = fp(u), ox = t.layout[u.room_id] || 0, C = t.C; C.tx = ox + f.x + f.w / 2; C.tz = f.z + f.d / 2; C.ty = u.h / 2; C.dist = Math.max(2.2, Math.max(u.w, u.d, u.h) * 2.2); camUpdate(); }
  function focusItem(kind, id) {
    const x = allItems().find(a => a.kind === kind && a.it.id === id); if (!x) return; if (!x.it.unit_id || !unit(x.it.unit_id)) { toast(itemName(x) + " has no place yet. Set one on the Items tab."); return; }
    S.selId = x.it.unit_id; S.hl = { unit: S.selId, item: kind + ":" + id }; focusUnit(S.selId); paintSide();
  }
  function paintSide() {
    const el = $("#s3Side"); if (!el) return; const u = unit(S.selId);
    const find = `<div class="field"><label for="sFind">Find an item</label><input id="sFind" type="text" placeholder="e.g. cutter, M6, screw" value="${esc(S.find || "")}"></div><div id="sRes" style="margin-top:8px"></div>`;
    if (!u) { el.innerHTML = find + `<h2 style="margin-top:16px">Selected</h2><p class="hint">Click a shelf, cabinet or item in the 3D view.</p>`; bindFind(); showRes(); return; }
    const r = room(u.room_id), opts = allItems().sort((a, b) => itemName(a).localeCompare(itemName(b)));
    el.innerHTML = find + `<h2 style="margin-top:16px">${esc(u.name)}</h2><p class="hint">${esc(KINDS[u.kind]?.label || "")} in ${esc(r?.name || "")}. ${u.w} × ${u.d} × ${u.h} m. Level 1 is the lowest.</p>
      <div id="sLv">${Array.from({ length: u.levels }, (_, i) => u.levels - i).map(lv => { const its = itemsAt(u.id, lv); return `<div style="border-top:1px solid var(--line);padding:6px 0"><strong>Level ${lv}</strong>${its.length ? its.map(x => `<div class="row" style="justify-content:space-between;gap:6px;font-size:14px"><span><i class="lg" style="background:${x.kind === "tool" ? "#F2C200" : "#2FB3B3"}"></i>${esc(itemName(x))}</span><button class="linkbtn" style="padding:0 4px;color:var(--bad)" data-rm="${x.kind}:${x.it.id}">take off</button></div>`).join("") : `<span class="hint" style="margin-left:8px">empty</span>`}</div>`; }).join("")}</div>
      <h2 style="margin-top:12px">Put an item here</h2><div class="row"><div class="field" style="min-width:160px"><label for="sPick">Item</label><select id="sPick" class="sel">${opts.map(x => `<option value="${x.kind}:${x.it.id}">${esc(itemName(x))} (${x.kind === "tool" ? "tool" : "consumable"})</option>`).join("")}</select></div><div class="field" style="min-width:90px"><label for="sLvl">Level</label><select id="sLvl" class="sel">${Array.from({ length: u.levels }, (_, i) => `<option>${i + 1}</option>`).join("")}</select></div></div>
      <div class="row" style="margin-top:8px"><button class="btn" id="sPut">Put here</button><button class="btn sec" id="sEdit">Edit in plan</button></div>`;
    bindFind(); showRes();
    el.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { const [k, id] = b.dataset.rm.split(":"); requireAuth(() => place(k, id, null, null)); });
    $("#sPut").onclick = () => requireAuth(() => { const [k, id] = $("#sPick").value.split(":"); place(k, id, u.id, Number($("#sLvl").value)); });
    $("#sEdit").onclick = () => { S.roomId = u.room_id; setTab("splan"); };
  }
  async function place(kind, id, unitId, level) {
    try { await guard(rpcAuth("toolscale_space_place", { p_kind: kind, p_id: id, p_unit: unitId, p_level: level })); await refreshAll(); if (S.t) { placeItems(); paintSide(); } toast(unitId ? "Placed" : "Taken off the shelf"); } catch (e) {}
  }
  function bindFind() { const i = $("#sFind"); if (!i) return; i.oninput = () => { S.find = i.value; showRes(); }; }
  function showRes() {
    const el = $("#sRes"); if (!el) return; const q = (S.find || "").trim().toLowerCase(); if (!q) { el.innerHTML = ""; return; }
    const hits = allItems().filter(x => (itemName(x) + " " + (x.it.slot || "") + " " + (x.it.location || "") + " " + (x.it.category || "")).toLowerCase().includes(q)).slice(0, 8);
    el.innerHTML = hits.length ? hits.map(x => `<div class="row" style="justify-content:space-between;gap:6px;font-size:14px;border-bottom:1px solid var(--line);padding:4px 0"><span>${esc(itemName(x))}<br><span class="hint">${esc(whereOf(x.it) || "not placed yet")}</span></span><button class="btn sec" style="padding:2px 10px" data-go="${x.kind}:${x.it.id}">Show</button></div>`).join("") : `<p class="hint">Nothing matches.</p>`;
    el.querySelectorAll("[data-go]").forEach(b => b.onclick = () => { const [k, id] = b.dataset.go.split(":"); focusItem(k, id); });
  }

  /* ====================================================== Items ====================================================== */
  async function items() {
    stop(); const me = S.view = {};
    $("#main").innerHTML = `<div class="summary"><div><h1>Items</h1><p>Say where each tool and consumable lives: which shelf or cabinet, and which level (1 is the lowest). Then it appears in the 3D view.</p></div></div>
      <div class="row" style="margin-bottom:12px"><div class="field"><label for="iQ">Search</label><input id="iQ" type="text" placeholder="name or size"></div><label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="iUn"> Not placed yet only</label></div><div id="iList"></div>`;
    try { await load(); } catch (e) { return; } if (S.view !== me) return;
    const paint = () => {
      const q = $("#iQ").value.trim().toLowerCase(), un = $("#iUn").checked, list = allItems().filter(x => (!q || itemName(x).toLowerCase().includes(q)) && (!un || !unit(x.it.unit_id)));
      const ops = u => S.rooms.map(r => `<optgroup label="${esc(r.name)}">${unitsOf(r.id).map(uu => `<option value="${uu.id}" ${uu.id === u ? "selected" : ""}>${esc(uu.name)}</option>`).join("")}</optgroup>`).join("");
      $("#iList").innerHTML = S.units.length ? `<div class="tablewrap"><table class="cards"><thead><tr><th>Item</th><th>Type</th><th>Now</th><th>Shelf or cabinet</th><th>Level</th><th></th></tr></thead><tbody>${list.map(x => `<tr data-k="${x.kind}" data-id="${x.it.id}"><td><strong>${esc(itemName(x))}</strong></td><td>${x.kind === "tool" ? "Tool" : "Consumable"}</td><td>${esc(whereOf(x.it) || "Not placed")}</td>
        <td><select class="sel iU"><option value="">Not placed</option>${ops(x.it.unit_id)}</select></td><td><select class="sel iL" style="min-width:70px"></select></td><td><button class="btn sec iGo">Place</button></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty"><p>Draw some shelves or cabinets on the Plan tab first.</p></div>`;
      $("#iList").querySelectorAll("tbody tr").forEach(tr => {
        const x = allItems().find(a => a.kind === tr.dataset.k && a.it.id === tr.dataset.id), us = tr.querySelector(".iU"), ls = tr.querySelector(".iL");
        const fill = () => { const u = unit(us.value); ls.innerHTML = u ? Array.from({ length: u.levels }, (_, i) => `<option ${Number(x.it.level) === i + 1 && x.it.unit_id === u.id ? "selected" : ""}>${i + 1}</option>`).join("") : `<option>-</option>`; ls.disabled = !u; }; fill(); us.onchange = fill;
        tr.querySelector(".iGo").onclick = () => requireAuth(async () => { try { await guard(rpcAuth("toolscale_space_place", { p_kind: x.kind, p_id: x.it.id, p_unit: us.value || null, p_level: us.value ? Number(ls.value) : null })); await refreshAll(); paint(); toast("Saved"); } catch (e) {} });
      });
      labelTables();
    };
    $("#iQ").oninput = paint; $("#iUn").onchange = paint; paint();
  }

  window.SpaceUI = { plan, view3d, items, stop, onData() { if (S.t) { placeItems(); const u = unit(S.selId); if (u) paintSide(); } }, _t: { S, fp, KINDS } };
})();
