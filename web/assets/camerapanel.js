// The Camera panel over the 3D view: ready-made angles, the architect's own numbers (lens, height, distance, angle
// from the front, straight vertical lines, shift, picture shape), "say it in words", framing guides, the front of the
// building, and saved views (kept for the model on the server).
import { PRESETS, SHAPES, anglesOf, fromWords, presetSettings } from "./camera.js";
import { matchView, prepare, pixelsOf, linesOf, matchScore } from "./cameramatch.js";

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v); }
  kids.flat().forEach(k => k != null && e.append(k instanceof Node ? k : document.createTextNode(String(k))));
  return e;
};
const GROUPS = [["Outside", ["front-eye", "front-raised", "corner-eye-left", "corner-eye-right", "drone-corner-left", "drone-corner-right", "aerial", "hero-low"]],
  ["Sides and rear", ["side-left", "side", "rear-left", "rear", "rear-right"]], ["Details", ["entrance", "plan"]], ["Inside", ["interior-one", "interior-two"]]];
const FROM = { entrance: "found from the main entrance", guessed: "guessed (the model's own front)", you: "set by you" };

/** root: the panel. viewer: the Studio viewer. store: { load() -> { front, views }, save({ front, views }), words(text, height) -> { settings, understood } }. */
export function createCameraPanel({ root, viewer, store, toast = () => {}, onRender = null, onFilm = null }) {
  let views = [], frontSaved = null, saveTimer = 0, now = null;
  root.replaceChildren(
    el("div", { class: "cp-presets", id: "cpPresets" }),
    el("div", { class: "cp-words" },
      el("label", { for: "cpWords" }, "Say it in words"),
      el("textarea", { id: "cpWords", rows: "2", maxlength: "600", placeholder: "e.g. elevated three-quarter corner view, low drone height, two-point perspective with vertical lines kept straight, 24 mm wide-angle lens, street intersection in foreground" }),
      el("div", { class: "row" }, el("button", { type: "button", class: "btn", id: "cpWordsGo" }, "Set the camera"), el("span", { class: "hint", id: "cpWordsMsg", role: "status" }))),
    el("fieldset", { class: "cp-settings", id: "cpSettings" }, el("legend", {}, "Camera"),
      el("label", {}, "Lens ", el("input", { type: "range", id: "cpLensR", min: "14", max: "135", step: "1" }), el("input", { type: "number", id: "cpLens", min: "14", max: "135", step: "1", "aria-label": "Lens (mm)" }), " mm ", el("span", { class: "hint", id: "cpAngle" })),
      el("label", {}, "Camera height ", el("input", { type: "number", id: "cpHeight", min: "0.1", max: "500", step: "0.1", "aria-label": "Camera height (m)" }), " m above the ground"),
      el("label", {}, "Distance ", el("label", { class: "check" }, el("input", { type: "checkbox", id: "cpFit", checked: true }), " fit the building"), el("input", { type: "number", id: "cpDist", min: "1", max: "5000", step: "1", "aria-label": "Distance (m)" }), " m"),
      el("label", {}, "Building fills ", el("input", { type: "range", id: "cpFill", min: "40", max: "100", step: "1" }), el("output", { id: "cpFillOut" })),
      el("label", {}, "Angle from the front ", el("input", { type: "range", id: "cpAz", min: "-180", max: "180", step: "1" }), el("input", { type: "number", id: "cpAzN", min: "-180", max: "180", step: "1", "aria-label": "Angle from the front (degrees)" }), "°"),
      el("label", { class: "check" }, el("input", { type: "checkbox", id: "cpStraight" }), " Vertical lines straight (two-point perspective)"),
      el("label", {}, "Look up or down ", el("input", { type: "range", id: "cpPitch", min: "-45", max: "89", step: "1" }), el("output", { id: "cpPitchOut" })),
      el("label", {}, "Frame shift up / down ", el("input", { type: "range", id: "cpShiftY", min: "-0.5", max: "0.5", step: "0.01", value: "0" })),
      el("label", {}, "Frame shift left / right ", el("input", { type: "range", id: "cpShiftX", min: "-0.5", max: "0.5", step: "0.01", value: "0" })),
      el("label", {}, "Picture shape ", el("select", { id: "cpShape" }, ...Object.keys(SHAPES).map(k => el("option", { value: k }, { "3:2": "3:2 (photo)", "16:9": "16:9 (widescreen)", "4:5": "4:5 (portrait)", "1:1": "1:1 (square)", "9:16": "9:16 (phone reels)" }[k]))))),
    el("fieldset", { class: "cp-guides" }, el("legend", {}, "Framing guides"),
      ...[["thirds", "Thirds"], ["centre", "Centre line"], ["horizon", "Horizon"], ["safe", "Safe margin"]].map(([k, t]) => el("label", { class: "check" }, el("input", { type: "checkbox", "data-guide": k }), " ", t))),
    el("div", { class: "cp-front row" },
      el("span", { id: "cpFrontMsg" }),
      el("label", { class: "check" }, el("input", { type: "checkbox", id: "cpShowFront" }), " Show the front"),
      el("button", { type: "button", class: "btn sm", id: "cpPickFront" }, "Make this side the front")),
    el("fieldset", { class: "cp-match" }, el("legend", {}, "Match a picture's angle"),
      el("p", { class: "hint" }, "A Revit render or a photo of the building: the model is laid under it, and the camera moves until the lines meet."),
      el("div", { class: "row" },
        el("label", { class: "btn sm", style: "cursor:pointer" }, "Choose a picture", el("input", { type: "file", id: "cpMatchFile", accept: "image/jpeg,image/png,image/webp", hidden: true })),
        el("label", {}, "See-through ", el("input", { type: "range", id: "cpMatchOpacity", min: "0", max: "1", step: "0.05", value: "0.5" })),
        el("button", { type: "button", class: "btn sm", id: "cpMatchAI", disabled: true }, "Ollic AI: rough start"),
        el("button", { type: "button", class: "btn sm primary", id: "cpMatchFine", disabled: true }, "Fine-tune automatically"),
        el("button", { type: "button", class: "btn sm", id: "cpMatchStop", hidden: true }, "Stop"),
        el("button", { type: "button", class: "btn sm", id: "cpMatchRemove", disabled: true }, "Remove the picture")),
      el("div", { class: "row cp-nudges", id: "cpNudges", hidden: true },
        ...[["lens", -1, "Lens −"], ["lens", 1, "Lens +"], ["height", -1, "Lower"], ["height", 1, "Higher"], ["azimuth", -1, "◀ Round"], ["azimuth", 1, "Round ▶"],
          ["distance", -1, "Closer"], ["distance", 1, "Farther"], ["shiftY", 1, "Frame ▲"], ["shiftY", -1, "Frame ▼"], ["shiftX", -1, "Frame ◀"], ["shiftX", 1, "Frame ▶"]]
          .map(([k, d, t]) => el("button", { type: "button", class: "btn sm", "data-nudge": k, "data-dir": d }, t)),
        el("span", { class: "cp-score", id: "cpScore", role: "status" }))),
    el("div", { class: "cp-views" },
      el("div", { class: "row" }, el("input", { type: "text", id: "cpViewName", maxlength: "80", placeholder: "Name this view (e.g. Front eye level)", "aria-label": "Name of the view" }),
        el("button", { type: "button", class: "btn primary", id: "cpSave" }, "Save this view"), el("button", { type: "button", class: "btn", id: "cpFree" }, "Free camera"), el("span", { class: "hint", id: "cpMsg", role: "status" })),
      el("ul", { class: "cp-list", id: "cpList" }),
      el("div", { class: "row cp-batch", id: "cpBatch", hidden: true },
        el("button", { type: "button", class: "btn primary", id: "cpRenderTicked" }, "Render the ticked views"),
        el("span", { class: "hint" }, "Each is rendered from its own camera, in the project's look, with the settings of the render form."),
        el("span", { class: "cp-between" }, "Film shot from ", el("select", { id: "cpFrom", "aria-label": "Film shot from this view" }), " to ", el("select", { id: "cpTo", "aria-label": "to this view" }),
          el("button", { type: "button", class: "btn sm", id: "cpFilmBetween" }, "Add film shot")))));
  const $ = s => root.querySelector(s);
  $("#cpPresets").append(...GROUPS.map(([g, keys]) => el("div", { class: "cp-group" }, el("span", { class: "cp-gname" }, g),
    ...keys.map(k => el("button", { type: "button", class: "chip", "data-preset": k, "aria-pressed": "false", title: PRESETS[k].words, onclick: () => setPreset(k) }, PRESETS[k].name)))));

  const msg = t => { $("#cpMsg").textContent = t; };
  function draw(info = viewer.camera) {
    now = info?.settings || null;
    root.querySelectorAll("[data-preset]").forEach(b => b.setAttribute("aria-pressed", String(!!now && b.dataset.preset === now.preset && !now.custom)));
    const s = now || { lens: 35, height: 1.6, azimuth: 0, straight: true, pitch: 0, shiftX: 0, shiftY: 0, aspect: "3:2", fill: 0.85, distance: "fit" };
    $("#cpLens").value = $("#cpLensR").value = Math.round(s.lens);
    const a = anglesOf(s.lens, SHAPES[s.aspect] || +s.aspect || 1.5);
    $("#cpAngle").textContent = `${a.h.toFixed(1)}° across, ${a.v.toFixed(1)}° up and down`;
    $("#cpHeight").value = info?.height ?? s.height ?? 1.6;
    $("#cpFit").checked = s.distance === "fit" || s.distance == null; $("#cpDist").disabled = $("#cpFit").checked;
    $("#cpDist").value = info?.distance ? Math.round(info.distance) : (typeof s.distance === "number" ? s.distance : "");
    $("#cpFill").value = Math.round((s.fill ?? 0.85) * 100); $("#cpFillOut").textContent = `${$("#cpFill").value}%`;
    $("#cpAz").value = $("#cpAzN").value = Math.round(s.azimuth || 0);
    $("#cpStraight").checked = s.straight !== false; $("#cpPitch").disabled = s.straight !== false;
    $("#cpPitch").value = Math.round(s.pitch || 0); $("#cpPitchOut").textContent = `${Math.round(s.pitch || 0)}°`;
    $("#cpShiftX").value = s.shiftX || 0; $("#cpShiftY").value = s.shiftY || 0;
    const own = !SHAPES[s.aspect] && +s.aspect > 0;
    root.querySelector("#cpShape option[data-own]")?.remove();
    if (own) $("#cpShape").append(el("option", { value: String(s.aspect), "data-own": "1" }, `The picture's own (${(+s.aspect).toFixed(2)}:1)`));
    $("#cpShape").value = String(s.aspect || "3:2");
    const f = viewer.front;
    $("#cpFrontMsg").textContent = `Front: ${FROM[f.from] || f.from}.`;
  }
  function setPreset(key) {
    const info = viewer.setCamera({ preset: key, aspect: $("#cpShape").value || "3:2" });
    if (info?.error) { msg(info.error); return; }
    msg(""); draw(info);
  }
  /** Any number changed: the camera keeps the angle it came from, with the change. */
  function tweak(change) {
    const base = now ? { ...now } : presetSettings("front-eye", viewer.camera.buildingHeight);
    const info = viewer.setCamera({ ...base, ...change, custom: true });
    if (info?.error) { msg(info.error); return; }
    draw(info);
  }
  $("#cpLensR").oninput = e => tweak({ lens: +e.target.value });
  $("#cpLens").onchange = e => tweak({ lens: Math.min(135, Math.max(14, +e.target.value || 35)) });
  $("#cpHeight").onchange = e => tweak({ height: Math.max(0.1, +e.target.value || 1.6) });
  $("#cpFit").onchange = e => tweak({ distance: e.target.checked ? "fit" : (+$("#cpDist").value || viewer.camera.distance || 30) });
  $("#cpDist").onchange = e => tweak({ distance: Math.max(1, +e.target.value || 30) });
  $("#cpFill").oninput = e => { $("#cpFillOut").textContent = `${e.target.value}%`; tweak({ fill: +e.target.value / 100 }); };
  $("#cpAz").oninput = e => tweak({ azimuth: +e.target.value });
  $("#cpAzN").onchange = e => tweak({ azimuth: Math.max(-180, Math.min(180, +e.target.value || 0)) });
  $("#cpStraight").onchange = e => tweak({ straight: e.target.checked, pitch: e.target.checked ? 0 : (now?.pitch || 15) });
  $("#cpPitch").oninput = e => { $("#cpPitchOut").textContent = `${e.target.value}°`; tweak({ pitch: +e.target.value }); };
  $("#cpShiftX").oninput = e => tweak({ shiftX: +e.target.value });
  $("#cpShiftY").oninput = e => tweak({ shiftY: +e.target.value });
  $("#cpShape").onchange = e => tweak({ aspect: e.target.value });
  root.querySelectorAll("[data-guide]").forEach(c => { c.onchange = () => viewer.setFrameGuides({ [c.dataset.guide]: c.checked }); });

  // words: Ollic AI when connected, else the app's own table of the words architects use
  $("#cpWordsGo").onclick = async () => {
    const text = $("#cpWords").value.trim();
    if (!text) return;
    const H = viewer.camera.buildingHeight;
    $("#cpWordsMsg").textContent = "Reading…";
    let r = null, by = "Ollic AI";
    try { r = await store.words?.(text, H); } catch { r = null; }
    if (!r?.settings) { r = fromWords(text, H); by = "the app"; }
    const info = viewer.setCamera({ ...presetSettings(r.settings.preset, H), ...r.settings, custom: true, preset: r.settings.preset });
    if (info?.error) { $("#cpWordsMsg").textContent = info.error; return; }
    draw(info);
    $("#cpWordsMsg").textContent = `Read by ${by}: ${(r.understood || []).join(", ") || PRESETS[r.settings.preset]?.name}. Check the numbers and adjust.`;
  };

  // the front
  $("#cpShowFront").onchange = e => viewer.showFront(e.target.checked);
  $("#cpPickFront").onclick = async () => {
    msg("Click a wall on the side that is the front.");
    viewer.showFront(true); $("#cpShowFront").checked = true;
    const f = await viewer.pickFront();
    if (f) { msg("Front set. Every angle now follows it."); draw(); }
  };
  viewer.onFront(f => { frontSaved = { dir: f.front, from: f.from }; save(); draw(); });

  // saved views
  function drawViews() {
    $("#cpList").replaceChildren(...views.map(v => el("li", { class: "cp-view" },
      el("label", { class: "check cp-tick" }, el("input", { type: "checkbox", "data-view": v.id, "aria-label": `Tick ${v.name} to render` }), " Render"),
      el("button", { type: "button", class: "cp-go", title: v.words || v.name, onclick: () => goTo(v) },
        v.thumb ? el("img", { src: v.thumb, alt: "" }) : el("span", { class: "cp-nothumb" }), el("span", {}, v.name)),
      el("div", { class: "cp-acts" },
        el("button", { type: "button", class: "btn sm", "aria-label": `Rename ${v.name}`, onclick: e => {
          const li = e.target.closest("li"), input = el("input", { type: "text", value: v.name, maxlength: "80", "aria-label": "New name", class: "cp-rename" });
          const done = () => { const n = input.value.trim(); if (n) { v.name = n.slice(0, 80); save(); } drawViews(); };
          input.addEventListener("keydown", k => { if (k.key === "Enter") done(); if (k.key === "Escape") drawViews(); });
          input.addEventListener("blur", done, { once: true });
          li.querySelector(".cp-go span:last-child").replaceWith(input); input.focus(); input.select();
        } }, "Rename"),
        el("button", { type: "button", class: "btn sm", "aria-label": `Duplicate ${v.name}`, onclick: () => { views.splice(views.indexOf(v) + 1, 0, { ...structuredClone(v), id: `v${Date.now().toString(36)}`, name: `${v.name} (copy)`.slice(0, 80) }); drawViews(); save(); } }, "Duplicate"),
        onFilm ? el("button", { type: "button", class: "btn sm", "aria-label": `Film shot from ${v.name}`, onclick: () => onFilm(v) }, "Film shot") : null,
        el("button", { type: "button", class: "btn sm", "aria-label": `Delete ${v.name}`, onclick: () => { views = views.filter(x => x !== v); drawViews(); save(); msg(`${v.name} deleted.`); } }, "Delete")))));
    $("#cpBatch").hidden = !views.length || (!onRender && !onFilm);
    $("#cpRenderTicked").hidden = !onRender;
    root.querySelector(".cp-between").hidden = !onFilm || views.length < 2;
    for (const id of ["#cpFrom", "#cpTo"]) $(id).replaceChildren(...views.map(v => el("option", { value: v.id }, v.name)));
    if (views.length > 1) $("#cpTo").value = views[1].id;
    if (!views.length) $("#cpList").append(el("li", { class: "hint" }, "No saved views yet. Set an angle you like and press Save this view."));
  }
  function goTo(v) {
    viewer.showPose(v.pose);
    draw({ ...viewer.camera, settings: v.settings || null });
    now = v.settings || null;
    msg(`${v.name}.`);
  }
  $("#cpSave").onclick = () => {
    const pose = viewer.currentPose();
    if (!pose.aspect) { msg("Pick an angle first (or press one of the ready-made angles), then save it."); return; }
    const name = $("#cpViewName").value.trim() || `${PRESETS[now?.preset]?.name || "View"} ${views.length + 1}`;
    let thumb = null;
    try { const W = 240, H = Math.round(240 / pose.aspect); thumb = viewer.guides(W, H, ["view"], pose).view; } catch { /* no picture */ }
    const v = { id: `v${Date.now().toString(36)}`, name: name.slice(0, 80), settings: now ? { ...now } : null, pose, thumb, words: viewer.camera.words || null };
    views.push(v); $("#cpViewName").value = ""; drawViews(); save(); msg(`Saved “${v.name}”.`);
  };
  $("#cpRenderTicked").onclick = () => {
    const ids = [...root.querySelectorAll("[data-view]:checked")].map(c => c.dataset.view), list = views.filter(v => ids.includes(v.id));
    if (!list.length) { msg("Tick the views to render first."); return; }
    onRender?.(list);
  };
  $("#cpFilmBetween").onclick = () => {
    const a = views.find(v => v.id === $("#cpFrom").value), b = views.find(v => v.id === $("#cpTo").value);
    if (!a || !b || a === b) { msg("Choose two different views."); return; }
    onFilm?.(a, b);
  };
  // ---------------------------------------------------------------- match a picture's angle
  let matchImg = null, matchPic = null, matchStop = null;
  const scoreNow = () => {
    if (!matchImg) return;
    const a = matchImg.naturalWidth / matchImg.naturalHeight, w = a >= 1 ? 240 : Math.round(240 * a), h = a >= 1 ? Math.round(240 / a) : 240;
    if (!matchPic || matchPic.w !== w) matchPic = { w, ...prepare(pixelsOf(matchImg, w, h)) };
    const s = matchScore(matchPic, linesOf(viewer.linePixels(w, h)));
    $("#cpScore").textContent = `Lines up: ${Math.round(s)} / 100`;
    return s;
  };
  const numbers = () => { const c = viewer.camera; return { ...(now || presetSettings("corner-eye-right", c.buildingHeight)), height: c.height, distance: c.distance || 30, custom: true }; };
  $("#cpMatchFile").onchange = async e => {
    const f = e.target.files?.[0]; if (!f) return;
    const url = URL.createObjectURL(f), img = new Image(); img.src = url;
    try { await img.decode(); } catch { msg("That picture could not be opened."); return; }
    matchImg = img; matchPic = null;
    const a = img.naturalWidth / img.naturalHeight;
    const info = viewer.setCamera({ ...numbers(), aspect: +a.toFixed(4), distance: "fit", custom: true });
    draw(info);
    viewer.setOverlay(url, +$("#cpMatchOpacity").value);
    for (const id of ["#cpMatchAI", "#cpMatchFine", "#cpMatchRemove"]) $(id).disabled = false;
    $("#cpNudges").hidden = false; scoreNow();
    msg("Line the model up with the picture: Ollic AI's rough start, the buttons, then Fine-tune.");
  };
  $("#cpMatchOpacity").oninput = e => { if (matchImg) viewer.setOverlay(matchImg.src, +e.target.value); };
  $("#cpMatchRemove").onclick = () => { matchImg = null; matchPic = null; viewer.setOverlay(null); $("#cpNudges").hidden = true; for (const id of ["#cpMatchAI", "#cpMatchFine", "#cpMatchRemove"]) $(id).disabled = true; $("#cpScore").textContent = ""; };
  root.querySelectorAll("[data-nudge]").forEach(b => { b.onclick = () => {
    const k = b.dataset.nudge, d = +b.dataset.dir, s = numbers();
    const step = { lens: 2, height: Math.max(0.2, s.height * 0.08), azimuth: 2, distance: Math.max(0.5, s.distance * 0.05), shiftX: 0.02, shiftY: 0.02 }[k];
    const info = viewer.setCamera({ ...s, aspect: now?.aspect, [k]: (s[k] || 0) + d * step });
    draw(info); scoreNow();
  }; });
  $("#cpMatchAI").onclick = async () => {
    if (!matchImg || !store.match) return;
    $("#cpScore").textContent = "Ollic AI is looking…";
    try {
      const blob = await new Promise(r => { const c = document.createElement("canvas"), k = Math.min(1, 1024 / Math.max(matchImg.naturalWidth, matchImg.naturalHeight)); c.width = matchImg.naturalWidth * k; c.height = matchImg.naturalHeight * k; c.getContext("2d").drawImage(matchImg, 0, 0, c.width, c.height); c.toBlob(r, "image/jpeg", 0.88); });
      const r = await store.match(blob, viewer.camera.buildingHeight);
      const info = viewer.setCamera({ ...presetSettings(r.settings.preset, viewer.camera.buildingHeight), ...r.settings, aspect: now?.aspect, distance: "fit", custom: true });
      draw(info); scoreNow();
      msg(`Ollic AI: ${(r.understood || []).join(", ")}. Now press Fine-tune.`);
    } catch (err) { $("#cpScore").textContent = ""; msg(err.message || "Ollic AI could not read the picture; line it up by hand, then press Fine-tune."); }
  };
  $("#cpMatchFine").onclick = async () => {
    if (!matchImg) return;
    const ctrl = new AbortController(); matchStop = ctrl;
    $("#cpMatchFine").disabled = true; $("#cpMatchStop").hidden = false;
    msg("Fine-tuning: the camera moves in small steps while the lines meet…");
    try {
      const r = await matchView(viewer, matchImg, numbers(), { signal: ctrl.signal, onStep: (_, sc) => { $("#cpScore").textContent = `Lines up: ${Math.round(sc)} / 100`; } });
      draw(viewer.camera); $("#cpScore").textContent = `Lines up: ${Math.round(r.score)} / 100`;
      msg(r.score >= 50 ? "Matched. Save it as a view if it looks right." : "Close, but not a clean match: nudge it nearer by hand and fine-tune again.");
    } finally { $("#cpMatchFine").disabled = false; $("#cpMatchStop").hidden = true; matchStop = null; }
  };
  $("#cpMatchStop").onclick = () => matchStop?.abort();
  $("#cpFree").onclick = () => { viewer.freeCamera(); draw(); msg("Free camera: orbit as you like."); };
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => { try { await store.save({ front: frontSaved, views }); } catch (err) { msg("Not saved: " + (err.message || "try again")); } }, 500);
  }

  draw(); drawViews();
  return {
    async load() {
      views = []; frontSaved = null; drawViews();
      try {
        const r = (await store.load()) || {};
        views = r.views || [];
        if (r.front?.dir) { frontSaved = r.front; viewer.onFront(null); viewer.setFront(r.front.dir, r.front.from || "you"); viewer.onFront(f => { frontSaved = { dir: f.front, from: f.from }; save(); draw(); }); }
      } catch (err) { toast("Your saved views could not be loaded: " + err.message); }
      drawViews(); draw();
    },
    refresh: () => draw(),
    get views() { return views; },
  };
}
