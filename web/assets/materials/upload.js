// Make a material from a photo: choose a photo (JPEG, PNG, WebP, HEIC from iPhones), drag four corners onto the
// area to use (straightened for a photo taken at an angle), say how big it is, let Ollic AI suggest what it is,
// then check the result (the crop, 3 x 3 repeats, a sphere and a wall) and save it to My materials.
import { photoToMaterial, tiled, resize } from "./fromphoto.js";
import { registerMaterial, forgetMaterial } from "./look.js";
import { drawPreview } from "./preview.js";

const KINDS = [["stone", "Stone"], ["tile", "Tile"], ["wood", "Timber"], ["brick", "Brick or block"], ["plaster", "Render or plaster"], ["paint", "Paint"], ["concrete", "Concrete"],
  ["roof", "Roofing"], ["metal", "Metal"], ["paving", "Paving"], ["grass", "Grass or plants"], ["furniture", "Fabric"]];
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v); }
  kids.flat().forEach(k => k != null && e.append(k instanceof Node ? k : document.createTextNode(String(k))));
  return e;
};
const canvasOf = p => { const c = document.createElement("canvas"); c.width = p.width; c.height = p.height; c.getContext("2d").putImageData(new ImageData(p.data, p.width, p.height), 0, 0); return c; };
const blobOf = (p, type = "image/jpeg", q = 0.92) => new Promise(r => canvasOf(p).toBlob(r, type, q));
const hex = c => "#" + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

/** The photo's pixels (at most 2400 px on its long side), whatever format it came in. */
export async function readPhoto(file) {
  let bmp = null;
  try { bmp = await createImageBitmap(file); } catch { /* not a format this browser reads by itself */ }
  if (!bmp && /hei[cf]/i.test(file.type + file.name)) {
    if (!window.heic2any) await new Promise((ok, no) => { const s = document.createElement("script"); s.src = new URL("../../vendor/heic2any/heic2any.min.js", import.meta.url).href; s.onload = ok; s.onerror = () => no(new Error("heic")); document.head.append(s); })
      .catch(() => { throw new Error("This browser cannot open iPhone (HEIC) photos. On the iPhone, share the photo as JPEG (or set Camera > Formats > Most Compatible)."); });
    const jpeg = await window.heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
    bmp = await createImageBitmap(Array.isArray(jpeg) ? jpeg[0] : jpeg);
  }
  if (!bmp) throw new Error("This picture could not be opened. Use a JPEG, PNG, WebP or HEIC photo.");
  const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height)), w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"); g.drawImage(bmp, 0, 0, w, h);
  return { data: g.getImageData(0, 0, w, h).data, width: w, height: h, canvas: c };
}

/**
 * Opens the dialog. store: { saveMaterial(FormData) -> material, suggest(Blob) -> { name, cls, rough, metal, size_mm,
 * tile_mm } }. onSaved(material) is called with the saved material (already registered for the 3D view).
 */
export function openPhotoDialog({ store, onSaved = () => {}, toast = () => {} }) {
  let photo = null, corners = null, result = null, tempId = null, stopPreview = null, view = { k: 1 };
  const dlg = el("dialog", { class: "photo-dlg", "aria-labelledby": "pdTitle" });
  const stage = el("div", { class: "pd-stage" });
  const quad = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  quad.setAttribute("class", "pd-quad"); quad.id = "pdQuad";
  const crop = el("div", { class: "pd-crop", hidden: true }, el("canvas", { id: "pdPhoto" }), quad);
  const handles = [0, 1, 2, 3].map(i => el("button", { type: "button", class: "pd-handle", "data-i": i, "aria-label": ["Top-left corner", "Top-right corner", "Bottom-right corner", "Bottom-left corner"][i] }));
  handles.forEach(h => crop.append(h));
  dlg.append(
    el("h2", { id: "pdTitle" }, "Make a material from a photo"),
    el("p", { class: "hint" }, "A photo of a tile, a stone sample, a wall you like or a catalogue picture. Take it as straight-on as you can, in even light."),
    el("label", { class: "pd-file" }, "Photo ", el("input", { type: "file", id: "pdFile", accept: "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" })),
    stage, crop,
    el("div", { class: "row pd-croptools", hidden: true, id: "pdCropTools" },
      el("span", { class: "hint" }, "Drag the four corners onto the edges of the area to use (on tiles: onto the grout lines)."),
      el("button", { type: "button", class: "btn sm", id: "pdWhole" }, "Whole photo"), el("button", { type: "button", class: "btn sm", id: "pdSquare" }, "Square in the middle")),
    el("fieldset", { class: "pd-size", id: "pdSize", disabled: true }, el("legend", {}, "How big is it?"),
      el("label", { class: "check" }, el("input", { type: "radio", name: "pdMode", value: "across", checked: true }), " What I cropped is ", el("input", { type: "number", id: "pdAcross", min: "10", step: "10", value: "600" }), " mm across",
        el("span", { class: "hint" }, " and "), el("input", { type: "number", id: "pdUp", min: "10", step: "10", placeholder: "(optional)", "aria-label": "Height (mm), optional" }), el("span", { class: "hint" }, " mm up")),
      el("label", { class: "check" }, el("input", { type: "radio", name: "pdMode", value: "tile" }), " One tile is ", el("input", { type: "number", id: "pdTileW", min: "10", step: "10", value: "600", "aria-label": "Tile width (mm)" }),
        " x ", el("input", { type: "number", id: "pdTileH", min: "10", step: "10", value: "600", "aria-label": "Tile height (mm)" }), " mm, grout ", el("input", { type: "number", id: "pdGrout", min: "0", step: "1", value: "3", "aria-label": "Grout gap (mm)" }), " mm")),
    el("fieldset", { class: "pd-what", id: "pdWhat", disabled: true }, el("legend", {}, "What is it?"),
      el("label", {}, "Name ", el("input", { type: "text", id: "pdName", maxlength: "80", value: "My material" })),
      el("label", {}, "Kind ", el("select", { id: "pdCls" }, ...KINDS.map(([v, t]) => el("option", { value: v }, t)))),
      el("label", {}, "Shine ", el("span", { class: "hint" }, "matt"), el("input", { type: "range", id: "pdRough", min: "0", max: "1", step: "0.05", value: "0.4" }), el("span", { class: "hint" }, "polished")),
      el("label", { class: "check" }, el("input", { type: "checkbox", id: "pdMetal" }), " Metal"),
      el("label", { class: "check" }, el("input", { type: "checkbox", id: "pdLight", checked: true }), " Remove uneven light and shadows"),
      el("button", { type: "button", class: "btn sm", id: "pdAsk" }, "Ask Ollic AI"), el("span", { class: "hint", id: "pdAskMsg", role: "status" })),
    el("div", { class: "row" }, el("button", { type: "button", class: "btn primary", id: "pdMake", disabled: true }, "Make the material"), el("span", { class: "hint", id: "pdMsg", role: "status" })),
    el("div", { class: "pd-result", id: "pdResult", hidden: true },
      el("figure", {}, el("div", { id: "pdOrig" }), el("figcaption", {}, "Your photo, straightened")),
      el("figure", {}, el("div", { id: "pdTiled" }), el("figcaption", {}, "Repeated 3 x 3")),
      el("figure", {}, el("canvas", { id: "pdSphere", width: 320, height: 160 }), el("figcaption", {}, "On a sphere and a wall")),
      el("ul", { class: "pd-checks", id: "pdChecks" })),
    el("div", { class: "row pd-foot" }, el("button", { type: "button", class: "btn primary", id: "pdSave", disabled: true }, "Save to My materials"),
      el("button", { type: "button", class: "btn", id: "pdCancel" }, "Cancel")));
  document.body.append(dlg);
  const $ = s => dlg.querySelector(s);
  const close = () => { stopPreview?.(); if (tempId) forgetMaterial(tempId); dlg.close(); dlg.remove(); };
  $("#pdCancel").onclick = close;
  dlg.addEventListener("cancel", e => { e.preventDefault(); close(); });

  // ---------------------------------------------------------------- the photo and its four corners
  function drawQuad() {
    const pts = corners.map(([x, y]) => [x * view.k, y * view.k]);
    handles.forEach((h, i) => { h.style.left = `${pts[i][0]}px`; h.style.top = `${pts[i][1]}px`; });
    $("#pdQuad").setAttribute("viewBox", `0 0 ${$("#pdPhoto").width} ${$("#pdPhoto").height}`);
    let poly = quad.querySelector("polygon");
    if (!poly) { poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon"); quad.append(poly); }
    poly.setAttribute("points", pts.map(p => p.join(",")).join(" "));
  }
  $("#pdFile").onchange = async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    $("#pdMsg").textContent = "Opening the photo…";
    try { photo = await readPhoto(f); } catch (err) { $("#pdMsg").textContent = err.message; return; }
    const show = $("#pdPhoto"), maxW = Math.min(720, dlg.clientWidth - 48 || 720);
    view.k = Math.min(1, maxW / photo.width, 480 / photo.height);
    show.width = Math.round(photo.width * view.k); show.height = Math.round(photo.height * view.k);
    show.getContext("2d").drawImage(photo.canvas, 0, 0, show.width, show.height);
    crop.style.width = `${show.width}px`; crop.style.height = `${show.height}px`;
    const m = 0.1;
    corners = [[photo.width * m, photo.height * m], [photo.width * (1 - m), photo.height * m], [photo.width * (1 - m), photo.height * (1 - m)], [photo.width * m, photo.height * (1 - m)]];
    crop.hidden = false; $("#pdCropTools").hidden = false; $("#pdSize").disabled = false; $("#pdWhat").disabled = false; $("#pdMake").disabled = false;
    $("#pdName").value = f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").slice(0, 80) || "My material";
    $("#pdMsg").textContent = ""; drawQuad();
  };
  handles.forEach((h, i) => {
    h.addEventListener("pointerdown", e => { e.preventDefault(); h.setPointerCapture(e.pointerId); h.dataset.drag = "1"; });
    h.addEventListener("pointermove", e => {
      if (!h.dataset.drag) return;
      const r = $("#pdPhoto").getBoundingClientRect();
      corners[i] = [Math.max(0, Math.min(photo.width, (e.clientX - r.left) / view.k)), Math.max(0, Math.min(photo.height, (e.clientY - r.top) / view.k))];
      drawQuad();
    });
    h.addEventListener("pointerup", () => { delete h.dataset.drag; });
    h.addEventListener("keydown", e => {   // arrow keys move a corner too
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!d) return; e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) / view.k;
      corners[i] = [corners[i][0] + d[0] * step, corners[i][1] + d[1] * step]; drawQuad();
    });
  });
  $("#pdWhole").onclick = () => { corners = [[0, 0], [photo.width, 0], [photo.width, photo.height], [0, photo.height]]; drawQuad(); };
  $("#pdSquare").onclick = () => { const s = Math.min(photo.width, photo.height) * 0.8, x = (photo.width - s) / 2, y = (photo.height - s) / 2; corners = [[x, y], [x + s, y], [x + s, y + s], [x, y + s]]; drawQuad(); };

  // ---------------------------------------------------------------- Ollic AI's suggestions
  $("#pdAsk").onclick = async () => {
    if (!photo) return;
    $("#pdAskMsg").textContent = "Ollic AI is looking…";
    try {
      const small = document.createElement("canvas"), k = Math.min(1, 1024 / Math.max(photo.width, photo.height));
      small.width = photo.width * k; small.height = photo.height * k; small.getContext("2d").drawImage(photo.canvas, 0, 0, small.width, small.height);
      const s = await store.suggest(await new Promise(r => small.toBlob(r, "image/jpeg", 0.88)));
      $("#pdName").value = s.name || $("#pdName").value;
      if (KINDS.some(([v]) => v === s.cls)) $("#pdCls").value = s.cls;
      $("#pdRough").value = 1 - (s.rough ?? 0.6); $("#pdMetal").checked = !!s.metal;
      if (s.tile_mm?.[0] && s.tile_mm?.[1]) { dlg.querySelector("input[name=pdMode][value=tile]").checked = true; $("#pdTileW").value = Math.round(s.tile_mm[0]); $("#pdTileH").value = Math.round(s.tile_mm[1]); }
      else if (s.size_mm) $("#pdAcross").value = Math.round(s.size_mm);
      $("#pdAskMsg").textContent = `Suggested${s.notes ? ": " + s.notes.replace(/[.\s]+$/, "") : ""}. Change anything that is not right.`;
    } catch (err) { $("#pdAskMsg").textContent = err.message || "Ollic AI could not look at the photo. Fill in the details yourself."; }
  };

  // ---------------------------------------------------------------- make it, check it
  const settings = () => {
    const mode = dlg.querySelector("input[name=pdMode]:checked").value;
    return { corners, mode, acrossMm: +$("#pdAcross").value, upMm: +$("#pdUp").value || null, tileW: +$("#pdTileW").value, tileH: +$("#pdTileH").value,
      rough: 1 - +$("#pdRough").value, lighting: $("#pdLight").checked, strength: $("#pdCls").value === "paint" ? 1 : 2.5 };
  };
  $("#pdMake").onclick = async () => {
    if (!photo) return;
    $("#pdMsg").textContent = "Making the material…"; $("#pdMake").disabled = true;
    await new Promise(r => setTimeout(r, 30));
    try {
      const st = settings(), n = Math.max(st.mode === "tile" ? 512 : 256, Math.min(1024, 2 ** Math.round(Math.log2(Math.max(64, Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]))))));
      result = photoToMaterial(photo, { ...st, size: n });
      const c = result.checks;
      const show = (p, max) => { const cv = canvasOf(p); cv.style.width = `${Math.min(max, p.width)}px`; cv.style.height = "auto"; return cv; };
      $("#pdOrig").replaceChildren(show(result.original, 220)); $("#pdTiled").replaceChildren(show(tiled(resize(result.color, 192, 192), 3), 220));
      // a temporary material for the sphere, from the made pictures
      if (tempId) forgetMaterial(tempId);
      tempId = `my-preview-${Date.now()}`;
      const urls = {};
      for (const k of ["color", "normal", "rough", "ao"]) urls[k] = URL.createObjectURL(await blobOf(result[k], "image/jpeg", 0.92));
      registerMaterial({ id: tempId, name: $("#pdName").value, cls: $("#pdCls").value, size: Math.max(result.sizeM[0], 0.05), sizeV: Math.max(result.sizeM[1], 0.05), rough: 1 - +$("#pdRough").value, metal: $("#pdMetal").checked ? 1 : 0, urls });
      stopPreview?.(); stopPreview = drawPreview($("#pdSphere"), { id: tempId });
      const ok = (good, text) => el("li", { class: good ? "pass" : "warn" }, good ? "✓ " : "! ", text);
      $("#pdChecks").replaceChildren(
        ok(c.deltaE < 5, `Colour: the same as your photo (difference ${c.deltaE.toFixed(1)}; under 5 looks the same)`),
        ok(c.seam < 2, c.seam < 2 ? "Repeats with no visible join" : "The join may show when it repeats: crop exactly on the pattern's edges (tiles: on the grout)"),
        ok(true, st.lighting ? `Uneven light removed (${c.lightBefore.toFixed(0)}% across the photo, now ${c.lightAfter.toFixed(0)}%)` : "Light kept as in the photo"),
        ok(true, result.tiles ? `${result.tiles[0]} x ${result.tiles[1]} tiles of ${st.tileW} x ${st.tileH} mm: one repeat is ${(result.sizeM[0] * 1000).toFixed(0)} x ${(result.sizeM[1] * 1000).toFixed(0)} mm` : `One repeat is ${(result.sizeM[0] * 1000).toFixed(0)} x ${(result.sizeM[1] * 1000).toFixed(0)} mm`));
      $("#pdResult").hidden = false; $("#pdSave").disabled = false;
      $("#pdMsg").textContent = "";
    } catch (err) { $("#pdMsg").textContent = "The material could not be made: " + err.message; }
    $("#pdMake").disabled = false;
  };
  $("#pdSave").onclick = async () => {
    if (!result) return;
    $("#pdSave").disabled = true; $("#pdMsg").textContent = "Saving…";
    try {
      const st = settings(), mean = (() => { const d = result.color.data, s = [0, 0, 0]; for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; } return s.map(v => v / (d.length / 4)); })();
      const meta = { name: $("#pdName").value.trim() || "My material", cls: $("#pdCls").value, size: +result.sizeM[0].toFixed(4), sizeV: +result.sizeM[1].toFixed(4),
        rough: +(1 - +$("#pdRough").value).toFixed(2), metal: $("#pdMetal").checked ? 1 : 0, plain: hex(mean),
        ...(result.tiles ? { tiles: result.tiles, tile_mm: [st.tileW, st.tileH, +$("#pdGrout").value || 0] } : {}),
        checks: { deltaE: +result.checks.deltaE.toFixed(2), seam: +result.checks.seam.toFixed(2), lightBefore: +result.checks.lightBefore.toFixed(1), lightAfter: +result.checks.lightAfter.toFixed(1) } };
      const form = new FormData();
      form.append("meta", JSON.stringify(meta));
      for (const k of ["color", "normal", "rough", "ao"]) form.append(k, await blobOf(result[k], "image/jpeg", k === "normal" ? 0.95 : 0.9), `${k}.jpg`);
      form.append("original", await blobOf(result.original, "image/jpeg", 0.88), "original.jpg");
      const saved = await store.saveMaterial(form);
      registerMaterial(saved);
      onSaved(saved);
      toast(`${saved.name} is in My materials.`);
      close();
    } catch (err) { $("#pdMsg").textContent = "Not saved: " + (err.message || "try again"); $("#pdSave").disabled = false; }
  };
  dlg.showModal();
  return dlg;
}
