// The Materials panel beside the 3D view: what the clicked part shows and where that came from; apply a library
// material to this part, everything with the same material, every element of its type (this floor or the whole
// building) or one face of a wall; drag a material onto the model; copy one part's material to another (eyedropper);
// colour, size, rotation, roughness and offset; undo, redo and reset. Saved for the model on the server.
import { MATERIALS, CATEGORIES, materialById } from "./library.js";
import { drawPreview } from "./preview.js";
import { userMaterials, registerMaterial, forgetMaterial } from "./look.js";

const HOW = { ifc: "From your IFC", name: "Matched from its name", guess: "Guessed", user: "Set by you" };
const TYPE_NAME = { IfcWall: "walls", IfcWallStandardCase: "walls", IfcSlab: "floor slabs", IfcRoof: "roofs", IfcDoor: "doors", IfcWindow: "windows", IfcColumn: "columns", IfcBeam: "beams",
  IfcStair: "stairs", IfcStairFlight: "stair flights", IfcCovering: "coverings", IfcRailing: "railings", IfcCurtainWall: "curtain walls", IfcPlate: "panels", IfcMember: "members" };
const typeName = t => TYPE_NAME[t] || "elements of this type";
const TEX = new URL("./tex/", import.meta.url).href;
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v); }
  kids.flat().forEach(k => k != null && e.append(k instanceof Node ? k : document.createTextNode(String(k))));
  return e;
};

/** A swatch's look in plain CSS: the photo, or its grain under the material's colour, or just the colour. */
export function swatchStyle(m, tint = null) {
  if (!m) return "";
  if (m.swatch) return `background:${tint || m.color} url("${m.swatch}") center/cover;${tint ? "background-blend-mode:luminosity" : ""}`;
  if (!m.set) return `background:${tint || m.color}`;
  const img = `url("${TEX}${m.set}/color.jpg") center/160%`;
  return tint || (m.color.toLowerCase() !== "#ffffff" && !m.photo) ? `background:${img}, ${tint || m.color};background-blend-mode:luminosity` : `background:${img}`;
}

/**
 * root: the panel's element. viewer: the Studio viewer. store: { load(), save(assignments), prefs(), savePrefs(p) }.
 * extra(): materials beyond the library (My materials), each like a library entry. toast(text).
 */
export function createMaterialsPanel({ root, viewer, store, toast = () => {}, extra = () => userMaterials().filter(m => !m.id.startsWith("my-preview-")) }) {
  let part = null, chosen = null, scope = "part", eyedrop = null, prefs = { favourites: [], recent: [] }, cat = "All", query = "", saveTimer = 0, stopPreview = null;
  const all = () => [...extra(), ...MATERIALS];
  const byId = id => all().find(m => m.id === id) || materialById(id);

  root.replaceChildren(
    el("div", { class: "mp-part", id: "mpPart" }, el("p", { class: "hint" }, "Click any part of the model to see its material and change it.")),
    el("div", { class: "mp-apply" },
      el("canvas", { id: "mpPreview", width: 320, height: 160, class: "mp-preview", "aria-label": "Preview: a sphere and a square of wall" }),
      el("div", { class: "mp-settings" },
        el("p", { class: "mp-chosen", id: "mpChosen" }, "Choose a material below."),
        el("label", {}, "Colour ", el("input", { type: "color", id: "mpTint", value: "#ffffff" }), el("button", { type: "button", class: "btn sm", id: "mpTintClear" }, "Its own colour")),
        el("label", { id: "mpSizeWrap" }, el("span", { id: "mpSizeLabel" }, "Pattern size (m)"), el("input", { type: "number", id: "mpSize", min: "0.02", step: "0.05" }), el("input", { type: "number", id: "mpSizeH", min: "20", step: "10", hidden: true, "aria-label": "Tile height (mm)" })),
        el("label", {}, "Rotation ", el("input", { type: "range", id: "mpRot", min: "0", max: "180", step: "15", value: "0" }), el("output", { id: "mpRotOut" }, "0°")),
        el("label", {}, "Roughness ", el("input", { type: "range", id: "mpRough", min: "0", max: "1", step: "0.05" })),
        el("label", {}, "Offset (mm) ", el("input", { type: "number", id: "mpOffX", step: "10", value: "0", "aria-label": "Offset across (mm)" }), el("input", { type: "number", id: "mpOffY", step: "10", value: "0", "aria-label": "Offset up (mm)" })))),
    el("fieldset", { class: "mp-scope", id: "mpScope" }, el("legend", {}, "Apply to")),
    el("div", { class: "row mp-actions" },
      el("button", { type: "button", class: "btn primary", id: "mpApply", disabled: true }, "Apply"),
      el("button", { type: "button", class: "btn", id: "mpEyedrop", "aria-pressed": "false" }, "Copy from a part"),
      el("button", { type: "button", class: "btn", id: "mpUndo", disabled: true }, "Undo"),
      el("button", { type: "button", class: "btn", id: "mpRedo", disabled: true }, "Redo"),
      el("button", { type: "button", class: "btn", id: "mpResetPart", disabled: true }, "Back to the IFC's material"),
      el("button", { type: "button", class: "btn", id: "mpResetAll" }, "Reset everything"),
      el("span", { class: "hint", id: "mpMsg", role: "status" })),
    el("div", { class: "mp-lib" },
      el("div", { class: "row" }, el("input", { type: "search", id: "mpSearch", placeholder: "Search materials (travertine, teak, porcelain…)", "aria-label": "Search materials" }),
        el("button", { type: "button", class: "btn", id: "mpPhoto" }, "Make a material from a photo")),
      el("div", { class: "chips", id: "mpCats", role: "group", "aria-label": "Groups" }),
      el("ul", { class: "mp-grid", id: "mpGrid" }),
      el("p", { class: "hint" }, "Tip: drag a material onto the model to put it on the part under the pointer. Double-click a material to apply it.")));
  const $ = s => root.querySelector(s);

  // ---------------------------------------------------------------- the library
  function drawCats() {
    $("#mpCats").replaceChildren(...["All", "Favourites", "Recently used", ...(extra().length ? ["My materials"] : []), ...CATEGORIES].map(c =>
      el("button", { type: "button", class: "chip", "aria-pressed": String(c === cat), onclick: () => { cat = c; drawCats(); drawGrid(); } }, c)));
  }
  function visible() {
    const q = query.trim().toLowerCase();
    let list = all();
    if (cat === "Favourites") list = prefs.favourites.map(byId).filter(Boolean);
    else if (cat === "Recently used") list = prefs.recent.map(byId).filter(Boolean);
    else if (cat === "My materials") list = extra();
    else if (cat !== "All") list = list.filter(m => m.category === cat);
    if (q) list = list.filter(m => `${m.name} ${m.category}`.toLowerCase().includes(q) || new RegExp(m.words || "^$", "i").test(q));
    return list.filter(m => m.id !== "mt-light-line" || q);
  }
  function drawGrid() {
    const list = visible();
    $("#mpGrid").replaceChildren(...list.map(m => {
      const fav = prefs.favourites.includes(m.id);
      return el("li", {},
        el("button", { type: "button", class: "mp-swatch", draggable: "true", "data-id": m.id, "aria-pressed": String(chosen?.id === m.id), title: m.name,
          onclick: () => choose({ id: m.id }), ondblclick: () => { choose({ id: m.id }); apply(); },
          ondragstart: e => { e.dataTransfer.setData("text/ollic-material", m.id); e.dataTransfer.effectAllowed = "copy"; } },
          el("span", { class: "mp-thumb", style: swatchStyle(m) }), el("span", { class: "mp-name" }, m.name)),
        el("button", { type: "button", class: "mp-fav", "aria-pressed": String(fav), "aria-label": fav ? `Remove ${m.name} from favourites` : `Add ${m.name} to favourites`, onclick: () => toggleFav(m.id) }, fav ? "★" : "☆"),
        m.id.startsWith("my-") && store.deleteMaterial ? el("button", { type: "button", class: "mp-del", "aria-label": `Delete ${m.name} from My materials`, onclick: async () => {
          if (!confirm(`Delete ${m.name} from My materials? Parts that show it go back to their own material.`)) return;
          try { await store.deleteMaterial(m.id); forgetMaterial(m.id); drawGrid(); msg(`${m.name} deleted.`); } catch (err) { msg("Not deleted: " + err.message); }
        } }, "×") : null);
    }));
    if (!list.length) $("#mpGrid").append(el("li", { class: "hint" }, cat === "Favourites" ? "No favourites yet: tap ☆ on a material." : "Nothing matches."));
  }
  function toggleFav(id) {
    prefs.favourites = prefs.favourites.includes(id) ? prefs.favourites.filter(x => x !== id) : [id, ...prefs.favourites];
    store.savePrefs?.(prefs); drawGrid();
  }
  $("#mpPhoto").onclick = async () => {
    const { openPhotoDialog } = await import("./upload.js");
    openPhotoDialog({ store, toast, onSaved: m => { cat = "My materials"; drawCats(); choose({ id: m.id }); msg(`${m.name} is ready: click a part and Apply.`); } });
  };
  $("#mpSearch").oninput = e => { query = e.target.value; if (query && cat !== "All") { cat = "All"; drawCats(); } drawGrid(); };

  // ---------------------------------------------------------------- the material being set up
  function choose(spec) {
    const m = byId(spec.id);
    if (!m) return;
    chosen = { id: m.id, tint: spec.tint || null, scale: spec.scale || 1, rotation: spec.rotation || 0, rough: spec.rough ?? null, offset: spec.offset || [0, 0] };
    drawChosen(); drawGrid();
  }
  function drawChosen() {
    const m = chosen && byId(chosen.id);
    $("#mpChosen").textContent = m ? m.name : "Choose a material below.";
    $("#mpApply").disabled = !m || !part;
    if (!m) return;
    $("#mpTint").value = chosen.tint || (m.color?.startsWith("#") ? m.color : "#ffffff");
    if (m.tile) {
      $("#mpSizeLabel").textContent = "Tile size (mm)";
      $("#mpSize").min = "20"; $("#mpSize").step = "10"; $("#mpSize").value = Math.round(m.tile.w * chosen.scale);
      $("#mpSizeH").hidden = false; $("#mpSizeH").value = Math.round(m.tile.h * chosen.scale);
    } else {
      $("#mpSizeLabel").textContent = "Pattern size (m)";
      $("#mpSize").min = "0.02"; $("#mpSize").step = "0.05"; $("#mpSize").value = +((m.size || 1) * chosen.scale).toFixed(2);
      $("#mpSizeH").hidden = true;
    }
    $("#mpRot").value = chosen.rotation; $("#mpRotOut").textContent = `${chosen.rotation}°`;
    $("#mpRough").value = chosen.rough ?? m.rough ?? 0.5;
    $("#mpOffX").value = Math.round((chosen.offset?.[0] || 0) * 1000); $("#mpOffY").value = Math.round((chosen.offset?.[1] || 0) * 1000);
    stopPreview?.(); stopPreview = drawPreview($("#mpPreview"), chosen);
  }
  const tweak = () => { if (!chosen) return; stopPreview?.(); stopPreview = drawPreview($("#mpPreview"), chosen); };
  $("#mpTint").oninput = e => { if (chosen) { chosen.tint = e.target.value; tweak(); } };
  $("#mpTintClear").onclick = () => { if (chosen) { chosen.tint = null; drawChosen(); } };
  $("#mpSize").oninput = e => {
    const m = chosen && byId(chosen.id), v = +e.target.value;
    if (!m || !(v > 0)) return;
    chosen.scale = Math.min(20, Math.max(0.05, m.tile ? v / m.tile.w : v / (m.size || 1)));
    if (m.tile) $("#mpSizeH").value = Math.round(m.tile.h * chosen.scale);
    tweak();
  };
  $("#mpSizeH").oninput = e => { const m = chosen && byId(chosen.id), v = +e.target.value; if (m?.tile && v > 0) { chosen.scale = Math.min(20, Math.max(0.05, v / m.tile.h)); $("#mpSize").value = Math.round(m.tile.w * chosen.scale); tweak(); } };
  $("#mpRot").oninput = e => { if (chosen) { chosen.rotation = +e.target.value; $("#mpRotOut").textContent = `${chosen.rotation}°`; tweak(); } };
  $("#mpRough").oninput = e => { if (chosen) { chosen.rough = +e.target.value; tweak(); } };
  $("#mpOffX").oninput = $("#mpOffY").oninput = () => { if (chosen) { chosen.offset = [(+$("#mpOffX").value || 0) / 1000, (+$("#mpOffY").value || 0) / 1000]; tweak(); } };

  // ---------------------------------------------------------------- the clicked part
  function drawScope() {
    const f = $("#mpScope"), info = part;
    const opts = [["part", "This part only"]];
    if (info) {
      opts.push(["same", `Everything with this material (${info.count.same})`]);
      if (info.storey) opts.push(["type-floor", `All ${typeName(info.ifcType)} on ${info.storey} (${info.count.typeFloor})`]);
      opts.push(["type", `All ${typeName(info.ifcType)} in the building (${info.count.type})`]);
      if (/Wall/.test(info.ifcType || "") && !info.face) opts.push(["outside", "Only the outside face"], ["inside", "Only the inside face"]);
    }
    if (!opts.some(([k]) => k === scope)) scope = "part";
    f.replaceChildren(el("legend", {}, "Apply to"), ...opts.map(([k, label]) => el("label", { class: "check" },
      el("input", { type: "radio", name: "mpScope", value: k, checked: k === scope, onchange: () => { scope = k; } }), " ", label)));
  }
  function drawPart() {
    const box = $("#mpPart");
    if (!part) { box.replaceChildren(el("p", { class: "hint" }, "Click any part of the model to see its material and change it.")); }
    else {
      const m = byId(part.spec.id);
      box.replaceChildren(el("div", { class: "mp-now" },
        el("span", { class: "mp-thumb", style: swatchStyle(m, part.spec.tint) }),
        el("div", {}, el("b", {}, part.name || typeName(part.ifcType)), part.face ? ` · ${part.face} face` : "", part.storey ? ` · ${part.storey}` : "", el("br"),
          m ? m.name : "No library material", " ", el("span", { class: `badge mp-how how-${part.how}` }, HOW[part.how] || "Guessed"),
          part.ifcName && part.how !== "user" ? el("span", { class: "hint" }, ` (the IFC calls it "${part.ifcName}")`) : "")));
    }
    $("#mpResetPart").disabled = !part || part.how !== "user";
    $("#mpApply").disabled = !chosen || !part;
    drawScope(); drawUndo();
  }
  function drawUndo() { $("#mpUndo").disabled = !viewer.canUndo; $("#mpRedo").disabled = !viewer.canRedo; }

  function apply(spec = chosen, key = part?.key, how = scope) {
    if (!spec || !key) return 0;
    const clean = { id: spec.id, ...(spec.tint ? { tint: spec.tint } : {}), ...(spec.scale && spec.scale !== 1 ? { scale: +spec.scale.toFixed(4) } : {}), ...(spec.rotation ? { rotation: spec.rotation } : {}),
      ...(spec.rough != null && spec.rough !== byId(spec.id)?.rough ? { rough: spec.rough } : {}), ...(spec.offset && (spec.offset[0] || spec.offset[1]) ? { offset: spec.offset } : {}) };
    const n = viewer.applyMaterial(key, clean, how);
    prefs.recent = [spec.id, ...prefs.recent.filter(x => x !== spec.id)].slice(0, 12);
    store.savePrefs?.(prefs);
    msg(n === 1 ? `${byId(spec.id)?.name} applied.` : `${byId(spec.id)?.name} applied to ${n} parts.`);
    return n;
  }
  const msg = t => { $("#mpMsg").textContent = t; };
  $("#mpApply").onclick = () => apply();
  $("#mpUndo").onclick = () => { viewer.undo(); drawUndo(); msg("Undone."); };
  $("#mpRedo").onclick = () => { viewer.redo(); drawUndo(); msg("Redone."); };
  $("#mpResetPart").onclick = () => { if (part) { viewer.resetMaterials(part.key); msg("Back to the IFC's material."); } };
  $("#mpResetAll").onclick = () => { const n = viewer.resetMaterials(); msg(n ? `${n} parts back to the IFC's materials (Undo brings them back).` : "Nothing to reset."); };
  $("#mpEyedrop").onclick = () => {
    eyedrop = eyedrop ? null : "from";
    $("#mpEyedrop").setAttribute("aria-pressed", String(!!eyedrop));
    msg(eyedrop ? "Click the part to copy its material from." : "");
  };

  // ---------------------------------------------------------------- saving
  viewer.onAssign(a => {
    clearTimeout(saveTimer);
    msg("Saving…");
    saveTimer = setTimeout(async () => { try { await store.save(a); msg("Saved."); } catch (err) { msg("Not saved: " + (err.message || "try again")); } }, 700);
    drawUndo();
  });

  // ---------------------------------------------------------------- drag a material onto the model
  const canvas = viewer.engine().renderer.domElement;
  canvas.addEventListener("dragover", e => { if (e.dataTransfer.types.includes("text/ollic-material")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  canvas.addEventListener("drop", e => {
    const id = e.dataTransfer.getData("text/ollic-material");
    if (!id) return;
    e.preventDefault();
    const key = viewer.partAt(e.clientX, e.clientY);
    if (!key) { msg("Drop it on a part of the model."); return; }
    viewer.select(key);
    apply({ id }, key, "part");
  });

  drawCats(); drawGrid(); drawPart();
  return {
    /** Called by the viewer when a part is clicked (or nothing). */
    selected(data, extraInfo) {
      const info = data && extraInfo?.key ? viewer.partInfo(extraInfo.key) : null;
      if (eyedrop === "from" && info) { choose(info.spec); eyedrop = "to"; msg(`Copied ${byId(info.spec.id)?.name || "the material"}. Now click the part to put it on.`); part = info; drawPart(); return; }
      if (eyedrop === "to" && info) { eyedrop = null; $("#mpEyedrop").setAttribute("aria-pressed", "false"); part = info; apply(chosen, info.key, "part"); part = viewer.partInfo(info.key); drawPart(); return; }
      part = info; drawPart();
      if (info && !chosen) choose(info.spec);
    },
    async load() {
      try { prefs = { favourites: [], recent: [], ...(await store.prefs?.()) }; } catch { /* favourites can wait */ }
      try { for (const m of (await store.mine?.()) || []) registerMaterial(m); } catch { /* my materials can wait */ }
      drawCats(); drawGrid();
      try { const a = await store.load(); if (a && Object.keys(a).length) viewer.setAssignments(a); } catch (err) { toast("Your material changes could not be loaded: " + err.message); }
      drawUndo();
    },
    refresh() { drawCats(); drawGrid(); },
    choose,
    get state() { return { part, chosen, scope, eyedrop }; },
  };
}
