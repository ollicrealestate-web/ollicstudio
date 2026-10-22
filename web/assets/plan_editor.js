// Plan review (Phase 3b): the customer checks what Ollic read from the floor plan, fixes
// anything wrong, confirms the scale and builds the 3D model. Coordinates are kept in
// the plan image's pixels; metres are shown once the scale is known.
const SVGNS = "http://www.w3.org/2000/svg";
const SOURCE = { drawing: "Read from drawing", ai: "Read by AI", user: "You", default: "Standard value" };
const DEF = { door: { w: 0.9, h: 2.1, sill: 0 }, window: { w: 1.2, h: 1.2, sill: 0.9 } };

function svg(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  kids.flat().forEach(k => k != null && e.append(k instanceof Node ? k : document.createTextNode(String(k))));
  return e;
}
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const fmt = (m, d = 2) => (m == null || !isFinite(m) ? "—" : `${m.toFixed(d)} m`);

export function createPlanEditor(host, draft, { onConfirm, projectName = "House" } = {}) {
  const P = draft.proposal;
  const W = P.image.width, H = P.image.height;
  const st = {
    scale: P.scale?.m_per_px || null,
    scaleSource: P.scale?.m_per_px ? "ai" : null,
    walls: P.walls.map(w => ({ ...w, a: [...w.a], b: [...w.b] })),
    openings: P.openings.map(o => ({ ...o, height_m: o.height, sill_m: o.sill, hsrc: o.height_source || "default" })),
    rooms: P.rooms.map(r => ({ ...r })),
    storeys: 1, storeyHeight: P.levels?.[0]?.height || 3.0, heightSrc: "default",
    roof: { ...(P.roof || { type: "gable", pitch: 25, overhang: 0.5 }) },
    name: projectName, tool: "select", sel: null, pending: null, n: 1000,
  };

  host.replaceChildren();
  const root = h("div", { class: "pe" });
  const flags = h("ul", { class: "pe-flags" });
  const tools = h("div", { class: "pe-tools", role: "toolbar", "aria-label": "Plan tools" });
  const stage = h("div", { class: "pe-stage" });
  const side = h("div", { class: "pe-side" });
  root.append(flags, tools, h("div", { class: "pe-body" }, stage, side));
  host.append(root);

  const sv = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "pe-svg", role: "img", "aria-label": "Floor plan with the walls, doors, windows and rooms Ollic found" });
  stage.append(sv);
  if (draft.image_url) svg("image", { href: draft.image_url, x: 0, y: 0, width: W, height: H, opacity: 0.55 }, sv);
  const gRooms = svg("g", {}, sv), gWalls = svg("g", {}, sv), gOpen = svg("g", {}, sv), gLabels = svg("g", {}, sv), gHandles = svg("g", {}, sv), gGhost = svg("g", {}, sv);
  const ux = Math.max(W, H) / 900; // drawing unit: keeps strokes and labels readable at any image size

  const TOOLS = [["select", "Select"], ["wall", "Add wall"], ["door", "Add door"], ["window", "Add window"], ["delete", "Delete"]];
  for (const [k, label] of TOOLS) tools.append(h("button", { type: "button", class: "pe-tool", "data-tool": k, "aria-pressed": String(k === st.tool), onclick: () => setTool(k) }, label));
  tools.append(h("span", { class: "pe-hint", id: "peHint" }));

  function setTool(t) { st.tool = t; st.pending = null; tools.querySelectorAll(".pe-tool").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tool === t))); hint(); draw(); }
  function hint() {
    const m = { select: "Tap a wall, door, window or room to check it. Drag a wall's end to move it.", wall: st.pending ? "Tap where the wall ends." : "Tap where the new wall starts.",
      door: "Tap a wall where the door goes.", window: "Tap a wall where the window goes.", delete: "Tap anything to remove it." };
    tools.querySelector("#peHint").textContent = m[st.tool];
  }

  const wallById = id => st.walls.find(w => w.id === id);
  const wlen = w => dist(w.a, w.b);
  function pointOnWall(w, off) { const L = wlen(w) || 1; return [w.a[0] + (w.b[0] - w.a[0]) * off / L, w.a[1] + (w.b[1] - w.a[1]) * off / L]; }
  function nearestWall(p, maxd = 18 * ux) {
    let best = null, bd = maxd, boff = 0;
    for (const w of st.walls) {
      const L = wlen(w); if (!L) continue;
      const t = Math.max(0, Math.min(1, ((p[0] - w.a[0]) * (w.b[0] - w.a[0]) + (p[1] - w.a[1]) * (w.b[1] - w.a[1])) / (L * L)));
      const q = [w.a[0] + t * (w.b[0] - w.a[0]), w.a[1] + t * (w.b[1] - w.a[1])];
      const d = dist(p, q);
      if (d < bd + w.thickness_px / 2) { best = w; bd = d; boff = t * L; }
    }
    return best ? { wall: best, offset: boff } : null;
  }
  function toSvg(ev) { const pt = sv.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY; const p = pt.matrixTransform(sv.getScreenCTM().inverse()); return [p.x, p.y]; }
  function snap(p, from) {
    let q = [...p];
    for (const w of st.walls) for (const e of [w.a, w.b]) if (dist(q, e) < 10 * ux) q = [...e];
    if (from) { if (Math.abs(q[0] - from[0]) < 8 * ux) q[0] = from[0]; if (Math.abs(q[1] - from[1]) < 8 * ux) q[1] = from[1]; }
    return q;
  }
  const px2m = px => (st.scale ? px * st.scale : null);
  const m2px = m => (st.scale ? m / st.scale : null);

  // ------------------------------------------------------------ drawing
  function draw() {
    for (const g of [gRooms, gWalls, gOpen, gLabels, gHandles, gGhost]) g.replaceChildren();
    for (const r of st.rooms) {
      const poly = svg("polygon", { points: r.polygon_px.map(p => p.join(",")).join(" "), class: `pe-room${st.sel?.room === r.id ? " sel" : ""}` }, gRooms);
      poly.addEventListener("click", ev => pick(ev, { room: r.id }));
      const cx = r.polygon_px.reduce((s, p) => s + p[0], 0) / r.polygon_px.length, cy = r.polygon_px.reduce((s, p) => s + p[1], 0) / r.polygon_px.length;
      const t = svg("text", { x: cx, y: cy, class: `pe-label ${r.name_source}`, "font-size": 15 * ux, "text-anchor": "middle" }, gLabels);
      t.textContent = r.name;
      t.addEventListener("click", ev => pick(ev, { room: r.id }));
    }
    for (const w of st.walls) {
      const l = svg("line", { x1: w.a[0], y1: w.a[1], x2: w.b[0], y2: w.b[1], "stroke-width": Math.max(4 * ux, w.thickness_px), class: `pe-wall${w.exterior ? " ext" : ""}${st.sel?.wall === w.id ? " sel" : ""}` }, gWalls);
      l.addEventListener("click", ev => pick(ev, { wall: w.id }));
    }
    for (const o of st.openings) {
      const w = wallById(o.wall); if (!w) continue;
      const half = (o.width_px || 40) / 2;
      const p1 = pointOnWall(w, o.offset_px - half), p2 = pointOnWall(w, o.offset_px + half);
      const l = svg("line", { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], "stroke-width": Math.max(6 * ux, w.thickness_px + 4 * ux), class: `pe-open ${o.kind}${st.sel?.opening === o.id ? " sel" : ""}` }, gOpen);
      l.addEventListener("click", ev => pick(ev, { opening: o.id }));
    }
    if (st.sel?.wall) {
      const w = wallById(st.sel.wall);
      if (w) for (const end of ["a", "b"]) {
        const c = svg("circle", { cx: w[end][0], cy: w[end][1], r: 9 * ux, class: "pe-handle" }, gHandles);
        c.addEventListener("pointerdown", ev => startDrag(ev, w, end));
      }
    }
    if (st.pending) svg("circle", { cx: st.pending[0], cy: st.pending[1], r: 6 * ux, class: "pe-handle" }, gGhost);
    drawFlags();
    drawSide();
  }

  function startDrag(ev, w, end) {
    ev.preventDefault(); ev.stopPropagation();
    sv.setPointerCapture(ev.pointerId);
    const other = end === "a" ? w.b : w.a;
    const move = e => { w[end] = snap(toSvg(e), other); w.source = "user"; draw(); };
    const up = () => { sv.removeEventListener("pointermove", move); sv.removeEventListener("pointerup", up); };
    sv.addEventListener("pointermove", move);
    sv.addEventListener("pointerup", up);
  }

  function pick(ev, what) {
    ev.stopPropagation();
    if (st.tool === "delete") return remove(what);
    if (st.tool === "door" || st.tool === "window") return sv.dispatchEvent(new MouseEvent("click", ev));
    if (st.tool === "select") { st.sel = what; draw(); }
  }
  function remove(what) {
    if (what.wall) { st.walls = st.walls.filter(w => w.id !== what.wall); st.openings = st.openings.filter(o => o.wall !== what.wall); }
    if (what.opening) st.openings = st.openings.filter(o => o.id !== what.opening);
    if (what.room) st.rooms = st.rooms.filter(r => r.id !== what.room);
    st.sel = null; draw();
  }

  sv.addEventListener("click", ev => {
    const p = toSvg(ev);
    if (st.tool === "wall") {
      if (!st.pending) { st.pending = snap(p); hint(); draw(); return; }
      const b = snap(p, st.pending);
      if (dist(st.pending, b) > 8 * ux) {
        const id = `u${st.n++}`;
        const t = m2px(0.15) || 9 * ux;
        st.walls.push({ id, a: st.pending, b, thickness_px: t, exterior: false, source: "user" });
        st.sel = { wall: id };
      }
      st.pending = null; hint(); draw(); return;
    }
    if (st.tool === "door" || st.tool === "window") {
      const hit = nearestWall(p);
      if (!hit) return;
      const d = DEF[st.tool];
      const width = m2px(d.w) || 50 * ux;
      const id = `u${st.n++}`;
      const L = wlen(hit.wall);
      st.openings.push({ id, wall: hit.wall.id, kind: st.tool, offset_px: Math.min(Math.max(hit.offset, width / 2), L - width / 2), width_px: Math.min(width, L * 0.9), height_m: d.h, sill_m: d.sill, source: "user", hsrc: "user" });
      st.sel = { opening: id }; setTool("select"); return;
    }
    if (st.tool === "select") { st.sel = null; draw(); }
  });

  // ------------------------------------------------------------ side panel
  function field(label, input, note) { return h("label", { class: "field" }, label, input, note ? h("span", { class: "hint" }, note) : null); }
  function num(value, step, onchange, attrs = {}) {
    const i = h("input", { type: "number", step, value: value ?? "", inputmode: "decimal", ...attrs });
    i.addEventListener("change", () => { const v = parseFloat(i.value); if (isFinite(v)) onchange(v); });
    return i;
  }
  const chip = src => h("span", { class: `chip src-${src}` }, SOURCE[src] || src);

  function drawSide() {
    side.replaceChildren();
    // scale first: nothing is built without it
    const ev = P.scale?.evidence || [];
    const scaleBox = h("section", { class: `pe-card${st.scale ? "" : " need"}` },
      h("h4", {}, "Scale ", st.scale ? chip(st.scaleSource === "user" ? "user" : "ai") : h("span", { class: "chip warn" }, "Needed")),
      st.scale ? h("p", {}, `1 m on site = ${(1 / st.scale).toFixed(1)} px on the plan.`) : h("p", {}, "Ollic could not read the scale. Enter the real length of one wall below."),
      ev.length && st.scaleSource !== "user" ? h("p", { class: "hint" }, `Worked out from ${ev.length} room area${ev.length > 1 ? "s" : ""} written on the plan${P.scale.spread != null && ev.length > 1 ? `, which agree within ${(P.scale.spread * 100).toFixed(0)}%` : ""}. Check one wall you know.`) : null);
    side.append(scaleBox);

    const sel = st.sel;
    if (sel?.wall) {
      const w = wallById(sel.wall);
      if (w) {
        const known = num("", "0.01", v => { if (v > 0.2) { st.scale = v / wlen(w); st.scaleSource = "user"; w.source = "user"; draw(); } }, { placeholder: "e.g. 12.00", "aria-label": "Real length of this wall in metres" });
        side.append(h("section", { class: "pe-card" },
          h("h4", {}, w.exterior ? "Outside wall " : "Inside wall ", chip(w.source)),
          h("p", {}, `Length ${fmt(px2m(wlen(w)))} · thickness ${fmt(px2m(w.thickness_px), 2)}`),
          field("Real length (sets the scale)", known, "Type the length you know, for example from the drawing's dimensions."),
          st.scale ? field("Thickness (m)", num(+(px2m(w.thickness_px)).toFixed(2), "0.01", v => { w.thickness_px = m2px(Math.min(0.6, Math.max(0.05, v))); w.source = "user"; draw(); })) : null,
          h("label", { class: "check" }, Object.assign(h("input", { type: "checkbox" }), { checked: w.exterior, onchange: e => { w.exterior = e.target.checked; w.source = "user"; draw(); } }), " Outside wall"),
          h("button", { type: "button", class: "btn danger", onclick: () => remove({ wall: w.id }) }, "Remove wall")));
      }
    } else if (sel?.opening) {
      const o = st.openings.find(x => x.id === sel.opening);
      if (o) {
        const kind = h("select", {}, h("option", { value: "door" }, "Door"), h("option", { value: "window" }, "Window"));
        kind.value = o.kind;
        kind.onchange = () => { o.kind = kind.value; const d = DEF[o.kind]; o.height_m = d.h; o.sill_m = d.sill; o.source = "user"; draw(); };
        side.append(h("section", { class: "pe-card" },
          h("h4", {}, o.kind === "door" ? "Door " : "Window ", chip(o.source)),
          field("Type", kind),
          st.scale ? field("Width (m)", num(+(px2m(o.width_px)).toFixed(2), "0.05", v => { o.width_px = m2px(v); o.source = "user"; draw(); })) : h("p", { class: "hint" }, "Set the scale to see sizes in metres."),
          field("Height (m)", num(o.height_m, "0.05", v => { o.height_m = v; o.hsrc = "user"; draw(); }), o.hsrc === "default" ? "Standard height, not read from the plan." : null),
          o.kind === "window" ? field("Sill height (m)", num(o.sill_m, "0.05", v => { o.sill_m = v; o.hsrc = "user"; draw(); })) : null,
          h("button", { type: "button", class: "btn danger", onclick: () => remove({ opening: o.id }) }, `Remove ${o.kind}`)));
      }
    } else if (sel?.room) {
      const r = st.rooms.find(x => x.id === sel.room);
      if (r) {
        const name = h("input", { type: "text", value: r.name, maxlength: "60" });
        name.onchange = () => { r.name = name.value.trim() || r.name; r.name_source = "user"; draw(); };
        side.append(h("section", { class: "pe-card" },
          h("h4", {}, "Room ", chip(r.name_source)),
          field("Name", name),
          h("p", {}, `Floor area about ${st.scale ? (r.area_px * st.scale * st.scale).toFixed(1) + " m²" : "— (set the scale)"}${r.area_label ? ` · plan says ${r.area_label} m²` : ""}`),
          h("button", { type: "button", class: "btn danger", onclick: () => remove({ room: r.id }) }, "Remove room")));
      }
    }

    const roofType = h("select", {}, ...["gable", "hip", "flat"].map(t => h("option", { value: t }, t[0].toUpperCase() + t.slice(1))));
    roofType.value = st.roof.type;
    roofType.onchange = () => { st.roof.type = roofType.value; st.roof.source = "user"; drawSide(); };
    const storeys = h("select", {}, h("option", { value: "1" }, "1 (bungalow)"), h("option", { value: "2" }, "2 (storey building)"));
    storeys.value = String(st.storeys);
    storeys.onchange = () => { st.storeys = +storeys.value; drawSide(); };
    side.append(h("section", { class: "pe-card" },
      h("h4", {}, "Building ", chip(st.roof.source === "user" || st.heightSrc === "user" ? "user" : "default")),
      field("Storeys", storeys, st.storeys === 2 ? "The first floor repeats this outline as one open space until you upload its own plan." : null),
      field("Storey height (m)", num(st.storeyHeight, "0.1", v => { st.storeyHeight = v; st.heightSrc = "user"; })),
      field("Roof", roofType),
      st.roof.type !== "flat" ? field("Roof pitch (degrees)", num(st.roof.pitch, "1", v => { st.roof.pitch = v; st.roof.source = "user"; })) : null,
      field("Roof overhang (m)", num(st.roof.overhang, "0.1", v => { st.roof.overhang = v; st.roof.source = "user"; }))));

    const summary = `${st.walls.length} walls · ${st.openings.filter(o => o.kind === "door").length} doors · ${st.openings.filter(o => o.kind === "window").length} windows · ${st.rooms.length} rooms`;
    const go = h("button", { type: "button", class: "btn primary big", disabled: !st.scale || st.walls.length < 3, onclick: () => confirm(go) }, "Build 3D model");
    side.append(h("section", { class: "pe-card pe-go" }, h("p", {}, summary), go,
      !st.scale ? h("p", { class: "hint" }, "Set the scale first.") : h("p", { class: "hint" }, "Ollic builds the walls, floors, doors, windows, roof and rooms from these values. You can come back and change them.")));
  }

  function drawFlags() {
    flags.replaceChildren();
    const live = [];
    if (!st.scale) live.push({ kind: "missing", message: "Scale needed: tap a wall you know and type its real length." });
    const unnamed = st.rooms.filter(r => r.name_source === "default").length;
    if (unnamed) live.push({ kind: "missing", message: `${unnamed} room${unnamed > 1 ? "s have" : " has"} a suggested name only. Tap a room to name it.` });
    for (const f of P.flags || []) if (!["scale", "rooms"].includes(f.target)) live.push(f);
    for (const f of live) flags.append(h("li", { class: f.kind }, f.message));
  }

  async function confirm(btn) {
    const s = st.scale;
    const body = {
      draft_id: draft.id, name: st.name, scale_m_per_px: s, scale_source: st.scaleSource === "user" ? "user" : "ai", image_height_px: H,
      walls: st.walls.map(w => ({ id: w.id, a: w.a, b: w.b, thickness_m: +Math.min(0.6, Math.max(0.05, w.thickness_px * s)).toFixed(3), exterior: !!w.exterior, source: w.source || "drawing" })),
      openings: st.openings.map(o => ({ id: o.id, wall: o.wall, kind: o.kind, offset_px: Math.max(0, o.offset_px), width_m: +Math.min(6, Math.max(0.3, o.width_px * s)).toFixed(3), height_m: o.height_m, sill_m: o.kind === "door" ? 0 : o.sill_m, source: o.source || "drawing" })),
      rooms: st.rooms.map(r => ({ id: r.id, name: r.name, polygon_px: r.polygon_px, area_label: r.area_label, source: r.name_source === "user" ? "user" : r.name_source === "ai" ? "ai" : "default" })),
      storeys: st.storeys, storey_height_m: st.storeyHeight, roof: { type: st.roof.type, pitch: st.roof.pitch, overhang: st.roof.overhang, source: st.roof.source === "user" ? "user" : "default" },
    };
    btn.disabled = true;
    try { await onConfirm?.(body); } finally { btn.disabled = false; }
  }

  hint();
  draw();
  return { state: st, redraw: draw };
}
