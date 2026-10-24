import { api, uploadFile, uploadAnimation, saveBrowserModel, sendShot, ApiError, newKey } from "./api.js";
import * as session from "./session.js";

const $ = s => document.querySelector(s);
const views = ["setupView", "authView", "projectsView", "projectView"];
function show(id) { views.forEach(v => { $("#" + v).hidden = v !== id; }); }

let toastTimer;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000); }
function message(el, text, kind = "error") { el.textContent = text; el.className = `notice ${kind}`; el.hidden = !text; }

const fmtBytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const fmtDate = iso => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const TYPE = { png: "PNG", jpeg: "JPEG", pdf: "PDF", ifc: "IFC", rvt: "Revit" };
const INPUT = { unknown: "No files yet", sketch: "Drawings and images", ifc: "IFC model" };
function el(tag, attrs = {}, ...kids) { const e = document.createElement(tag); Object.entries(attrs).forEach(([k, v]) => { if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }); kids.flat().forEach(k => e.append(k instanceof Node ? k : document.createTextNode(String(k)))); return e; }
function details(f) { const d = f.validation?.details || {}; if (d.width) return `${d.width} × ${d.height} px`; if (d.pages) return `${d.pages} page${d.pages > 1 ? "s" : ""}`; if (d.schema) return d.schema; return ""; }

/* ---------- auth ---------- */
function authMode(mode) {
  $("#signInForm").hidden = mode !== "in"; $("#signUpForm").hidden = mode !== "up"; $("#resetForm").hidden = mode !== "reset"; $("#newPasswordForm").hidden = mode !== "newpw";
  $("#tabIn").setAttribute("aria-selected", mode === "in"); $("#tabUp").setAttribute("aria-selected", mode === "up");
  $(".tabs").hidden = mode === "newpw";
  message($("#authMsg"), "");
}
$("#tabIn").onclick = () => authMode("in");
$("#tabUp").onclick = () => authMode("up");
$("#forgotBtn").onclick = () => { authMode("reset"); $("#resetEmail").value = $("#inEmail").value; };
$("#backToSignIn").onclick = () => authMode("in");

async function busy(form, fn) { const b = form.querySelector("button[type=submit]"); b.disabled = true; try { await fn(); } finally { b.disabled = false; } }

$("#signInForm").onsubmit = e => { e.preventDefault(); busy(e.target, async () => {
  try { await session.signIn($("#inEmail").value.trim(), $("#inPassword").value); await enterApp(); }
  catch (err) { message($("#authMsg"), err.message); }
}); };
$("#signUpForm").onsubmit = e => { e.preventDefault(); busy(e.target, async () => {
  try {
    const needsConfirm = await session.signUp($("#upEmail").value.trim(), $("#upPassword").value, $("#upName").value.trim());
    if (needsConfirm) { authMode("in"); $("#inEmail").value = $("#upEmail").value.trim(); message($("#authMsg"), "Check your email and open the confirmation link, then sign in.", "ok"); }
    else await enterApp();
  } catch (err) { message($("#authMsg"), err.message); }
}); };
$("#resetForm").onsubmit = e => { e.preventDefault(); busy(e.target, async () => {
  try { await session.requestPasswordReset($("#resetEmail").value.trim()); authMode("in"); message($("#authMsg"), "If that email has an account, a reset link is on its way.", "ok"); }
  catch (err) { message($("#authMsg"), err.message); }
}); };
$("#newPasswordForm").onsubmit = e => { e.preventDefault(); busy(e.target, async () => {
  try { await session.setNewPassword($("#newPassword").value); toast("Password updated."); await enterApp(); }
  catch (err) { message($("#authMsg"), err.message); }
}); };
$("#signOutBtn").onclick = async () => { stopPolling(); await session.signOut(); $("#userNav").hidden = true; authMode("in"); show("authView"); };

/* ---------- projects ---------- */
async function enterApp() {
  const user = await session.loadUser().catch(() => null);
  if (!user) { authMode("in"); show("authView"); return; }
  $("#userEmail").textContent = user.email || ""; $("#userNav").hidden = false;
  const id = new URLSearchParams(location.search).get("project");
  if (id) openProject(id); else listProjects();
}

async function listProjects() {
  history.replaceState(null, "", location.pathname);
  show("projectsView"); message($("#projectsMsg"), "");
  const list = $("#projectList"); list.replaceChildren();
  try {
    const projects = await api.listProjects();
    $("#projectsEmpty").hidden = projects.length > 0;
    projects.forEach(p => list.append(el("button", { class: "card project", type: "button", onclick: () => openProject(p.id) },
      el("h3", {}, p.name),
      el("div", { class: "meta" }, el("span", { class: `chip ${p.input_type}` }, INPUT[p.input_type] || p.input_type), el("span", { class: "muted" }, `Created ${fmtDate(p.created_at)}`)))));
  } catch (err) { handle(err, $("#projectsMsg")); }
}

$("#newProjectForm").onsubmit = e => { e.preventDefault(); busy(e.target, async () => {
  try { const p = await api.createProject($("#newProjectName").value.trim()); $("#newProjectName").value = ""; openProject(p.id); }
  catch (err) { handle(err, $("#projectsMsg")); }
}); };

let current = null;
async function openProject(id) {
  show("projectView"); $("#uploads").replaceChildren(); resetDelete(); stopPolling();
  $("#gallery").replaceChildren(); $("#jobList").replaceChildren(); message($("#renderMsg"), "");
  $("#renderForm").hidden = true; $("#studioOff").hidden = true; $("#galleryEmpty").hidden = true;
  images = []; videos = []; resetModel(); resetIA(); shots = []; drawShots(); outputsLoadedOnce = false; seenDone = new Set();
  const q = new URLSearchParams(location.search), same = q.get("project") === id;
  service = same && SERVICES[q.get("service")] ? q.get("service") : null;
  step = service ? (q.get("step") === "start" && service !== "library" ? "start" : "work") : null;
  chosenIfc = same ? q.get("model") : null;
  applyView();
  try { current = await api.getProject(id); renderProject(); loadOutputs(); loadModels(); loadVideos(); applyView(); }
  catch (err) { if (err.status === 404) { toast("That project does not exist or is not yours."); listProjects(); } else handle(err); }
}
function renderProject() {
  $("#projectName").textContent = current.name;
  $("#projectMeta").textContent = `${INPUT[current.input_type] || ""} · created ${fmtDate(current.created_at)}`;
  const rows = $("#fileRows"); rows.replaceChildren();
  current.source_files.forEach(f => rows.append(el("tr", {},
    el("td", {}, f.original_name, f.origin === "generated" ? el("span", { class: "chip generated", style: "margin-left:8px" }, "Made by Ollic") : ""),
    el("td", {}, TYPE[f.detected_type] || f.detected_type), el("td", { class: "mono" }, fmtBytes(f.size_bytes)),
    el("td", {}, details(f)), el("td", {}, fmtDate(f.created_at)), el("td", { class: "mono", title: f.checksum_sha256 }, f.checksum_sha256.slice(0, 12) + "…"),
    el("td", {}, el("div", { class: "file-actions" }, ...fileActions(f))))));
  $("#filesWrap").hidden = current.source_files.length === 0;
  $("#libFilesEmpty").hidden = current.source_files.length > 0;
  if (step === "start") drawStart();
  drawRenderBox(); drawIA();
}

/* the render box: the picture to render, reference images, the description, and the prompt the AI writes */
let rPick = null, rRefSel = [], promptByAI = false;
const HIDDEN_FILE = /^(Photoreal view|Cinematic start view) \d|^Guide - /;
const renderPics = () => (current?.source_files || []).filter(f => ["png", "jpeg", "pdf"].includes(f.detected_type) && !HIDDEN_FILE.test(f.original_name))
  .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
const picRole = f => (service === "plan" || f.detected_type === "pdf") ? "plan" : /^3D view/i.test(f.original_name) ? "model" : "base";
function picTile(f, on, onclick, kind) {
  const img = f.preview_url ? el("img", { src: f.preview_url, alt: "", loading: "lazy" }) : el("span", { class: "rpic-doc" }, f.detected_type.toUpperCase());
  const tag = /^3D view/i.test(f.original_name) ? "Captured view" : f.detected_type === "pdf" ? "Drawing" : service === "plan" ? "Floor plan" : "Picture";
  return el("button", { type: "button", class: `rpic${on ? " on" : ""}`, role: kind === "radio" ? "radio" : "checkbox", "aria-checked": String(on), title: f.original_name, onclick },
    img, el("span", { class: "rpic-name" }, kind === "radio" ? tag : f.original_name));
}
function drawRenderBox() {
  const pics = renderPics();
  if (rPick && !pics.some(f => f.id === rPick)) rPick = null;
  rRefSel = rRefSel.filter(id => pics.some(f => f.id === id) && id !== rPick);
  $("#rPics").replaceChildren(...(pics.length ? pics.slice(0, 16).map(f => picTile(f, f.id === rPick, () => { rPick = rPick === f.id ? null : f.id; drawRenderBox(); }, "radio"))
    : [el("span", { class: "hint" }, service === "model" ? "Frame a view of your model, then press Capture view." : service === "plan" ? "Upload a picture or PDF of the floor plan." : "Upload a sketch, 3D image or photo.")]));
  const refs = pics.filter(f => f.id !== rPick && f.detected_type !== "pdf");
  $("#rRefs").replaceChildren(...(refs.length ? refs.slice(0, 16).map(f => picTile(f, rRefSel.includes(f.id), () => {
    if (rRefSel.includes(f.id)) rRefSel = rRefSel.filter(x => x !== f.id);
    else if (rRefSel.length >= 3) { toast("Use up to three reference images."); return; }
    else rRefSel = [...rRefSel, f.id];
    drawRenderBox();
  }, "check")) : [el("span", { class: "hint" }, "Upload photos of buildings or scenes you like.")]));
  $("#rPicHint").textContent = rPick ? `Rendering: ${pics.find(f => f.id === rPick)?.original_name}${guideFor(rPick) ? " · checked against your model" : ""}` : service === "model"
    ? "Frame a view of your model, then press Capture view." : "Choose the picture to render.";
}
function renderRefs() {
  const refs = [];
  const f = (current?.source_files || []).find(x => x.id === rPick);
  if (f) refs.push({ file_id: f.id, role: picRole(f) });
  rRefSel.forEach(id => refs.push({ file_id: id, role: "style" }));
  return refs;
}
$("#rPicUpload").onchange = async e => {
  const files = [...e.target.files]; e.target.value = "";
  const saved = await uploadAll(files);
  if (saved[0]) { rPick = saved[0].id; drawRenderBox(); }
};
$("#rRefUpload").onchange = async e => {
  const files = [...e.target.files].slice(0, 3); e.target.value = "";
  const saved = await uploadAll(files);
  saved.forEach(f => { if (rRefSel.length < 3 && f.id !== rPick) rRefSel.push(f.id); });
  drawRenderBox();
};
$("#writePromptBtn").onclick = async () => {
  const btn = $("#writePromptBtn");
  if (!rPick && !$("#rDesc").value.trim()) { toast("Capture a view or choose a picture first, or describe the building."); return; }
  btn.disabled = true; btn.textContent = "Studying the picture…";
  $("#planNote").textContent = "The AI is studying the picture and the references. This takes about 10–30 seconds.";
  try {
    const r = await api.writePrompt(current.id, { references: renderRefs(), description: $("#rDesc").value.trim(),
      ...(SERVICES[service]?.modes && viewerModelId ? { model_id: viewerModelId } : {}) });
    $("#rPrompt").value = r.prompt; promptByAI = true;
    $("#planNote").textContent = r.notes ? `AI: ${r.notes} Check the prompt below, then render.` : "Prompt written. Check it below, then render.";
  } catch (err) { if (err.status === 401) return handle(err); $("#planNote").textContent = err.message; }
  finally { btn.disabled = false; btn.textContent = "Read image and write prompt"; }
};
$("#rPrompt").addEventListener("input", () => { if (!$("#rPrompt").value.trim()) promptByAI = false; });
$("#backBtn").onclick = () => { stopPolling(); listProjects(); };

/* ---------- services: pick one, give it a file, then only its screen is shown ---------- */
const IMG = ["png", "jpeg"];
const SERVICES = {
  model: { name: "Render your model", short: "Model render", accept: ["ifc", "rvt"], multi: 1, needs: "your model (Revit .rvt, or IFC from Revit or ArchiCAD)",
    lead: "Upload your model. Frame any view inside or out; the AI renders on top of an exact view of your model, and each render is checked against it.",
    hint: "Choose the model.", sections: ["modelSection", "studio"], modes: ["exterior", "interior", "walk"], icon: "M12 2 3 7v10l9 5 9-5V7zM3 7l9 5 9-5M12 12v10" },
  film: { name: "AI walkthrough", short: "Walkthrough", accept: ["ifc", "rvt"], multi: 1, needs: "your model (Revit .rvt or IFC)",
    lead: "Claude plans the shots, Ollic records each camera move exactly from your model, and the AI films it photoreal, with people and cars if you like. Every shot is checked against the model.",
    hint: "Choose the model.", sections: ["modelSection", "filmSection"], modes: ["exterior", "interior", "walk"], icon: "M4 6h12v12H4zM16 10l5-3v10l-5-3" },
  render: { name: "Photoreal render", short: "Photoreal render", accept: [...IMG, "pdf"], multi: 4, optional: true, needs: "a picture or a PDF drawing",
    lead: "Turn a sketch, photo or 3D view into a photoreal image, or just describe the building.",
    hint: "Tick the pictures to use. The first keeps its shape and camera; the others give the look and materials.",
    sections: ["studio"], icon: "M4 20 10 4h4l6 16M7 13h10" },
  plan: { name: "Floor plan to 3D", short: "Floor plan to 3D", accept: [...IMG, "pdf"], multi: 1, needs: "a floor plan (PDF or picture)",
    lead: "Upload a floor plan. Ollic reads the rooms and makes photoreal 3D views of the building that follow the layout.",
    hint: "Choose the floor plan.", sections: ["studio"], icon: "M3 3h18v18H3zM3 12h8V3M11 12v9M15 12h6" },
  imageanim: { name: "Animation from a 3D image", short: "3D image animation", accept: IMG, multi: 3, needs: "a 3D image (PNG or JPEG)",
    lead: "Upload a 3D image of the building (a Revit, SketchUp or Lumion view, or a render). Gold lines rise from the ground, then a light sweep reveals the photoreal building.",
    hint: "Tick up to three images, in order. Each becomes one shot of the video.", sections: ["imgAnimSection"], icon: "M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4" },
  library: { name: "Library", short: "Library", sections: ["libSection"], icon: "M4 4h6v16H4zM14 4h6v16h-6z" },
};
const SVC_ORDER = ["model", "film", "render", "plan", "imageanim"];
const WORK = ["modelSection", "filmSection", "imgAnimSection", "studio", "libSection"];
const MODE_BTN = { exterior: "#viewOutside", interior: "#viewInside", walk: "#viewWalk" };
const EXT = { png: ".png", jpeg: ".jpg,.jpeg", pdf: ".pdf", ifc: ".ifc", rvt: ".rvt" };
let service = null, step = null, chosenIfc = null, lastJobs = [], modelsNow = [], svcPicked = [];
function svcIcon(d) {   // SVG needs its own namespace, so it is built from markup
  const t = document.createElement("template");
  t.innerHTML = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  return t.content.firstChild;
}

function goTo(svc, st) {
  service = svc; step = svc ? st : null;
  const q = new URLSearchParams({ project: current?.id || new URLSearchParams(location.search).get("project") || "" });
  if (service) { q.set("service", service); q.set("step", step); }
  if (chosenIfc && SERVICES[service]?.modes) q.set("model", chosenIfc);
  history.replaceState(null, "", `${location.pathname}?${q}`);
  applyView();
  if (!reduceMotion()) window.scrollTo({ top: 0 }); else window.scrollTo(0, 0);
}
function chooseService(k) { svcPicked = []; goTo(k, k === "library" ? "work" : "start"); }

function applyView() {
  const svc = SERVICES[service];
  const pv = $("#projectView"); pv.dataset.service = service || ""; pv.dataset.step = step || "";
  $("#svcTabs").replaceChildren(...[...SVC_ORDER, "library"].map(k => el("button", { type: "button", class: `svc-tab${k === service ? " on" : ""}${k === "library" ? " lib" : ""}`,
    "aria-pressed": String(k === service), onclick: () => chooseService(k) }, svcIcon(SERVICES[k].icon), SERVICES[k].short)));
  $("#svcGrid").replaceChildren(...SVC_ORDER.map(k => el("button", { type: "button", class: "svc-card", onclick: () => chooseService(k) },
    svcIcon(SERVICES[k].icon), el("b", {}, SERVICES[k].name), el("span", {}, SERVICES[k].lead), el("small", {}, `You upload: ${SERVICES[k].needs}`))));
  $("#svcPick").hidden = !!service;
  $("#svcStart").hidden = step !== "start";
  const show = step === "work" && svc ? svc.sections : [];
  WORK.forEach(id => { $("#" + id).hidden = !show.includes(id); });
  $("#dangerZone").hidden = service !== "library";
  // the AI version choice sits in the screen that makes the pictures
  // the 3D view offers only this service's buttons
  Object.entries(MODE_BTN).forEach(([m, sel]) => { $(sel).hidden = !(svc?.modes || []).includes(m); });
  $("#useView").hidden = service !== "model";
  $("#addShotView").hidden = service !== "film";
  const slot = service === "imageanim" ? "#tierSlotIA" : service === "film" ? "#tierSlotFilm" : "#tierHome";
  if ($("#tierPick").parentElement !== $(slot)) $(slot).append($("#tierPick"));
  // renders: in the studio, or in the Library
  const gHome = service === "library" ? $("#libGallery") : $("#studio");
  if ($("#gallery").parentElement !== gHome) gHome.append($("#gallery"), $("#galleryEmpty"));
  if (step === "start") drawStart();
  if (step === "work" && svc?.modes && viewer && !modelLoading && viewerModelId && viewer.mode === "walk" && !svc.modes.includes("walk")) setViewMode("exterior");
  if (service === "film" && step === "work") loadFilmEngines();
}

/* step 1: upload a file for this service, or pick one already in the project */
function svcFiles() {
  const svc = SERVICES[service];
  return (current?.source_files || []).filter(f => svc.accept.includes(f.detected_type) && !HIDDEN_FILE.test(f.original_name));
}
function drawStart() {
  const svc = SERVICES[service];
  if (!svc || !svc.accept) return;
  $("#svcTitle").textContent = svc.name; $("#svcLead").textContent = svc.lead;
  $("#svcEyebrow").textContent = "Step 1 of 2 · Your file";
  const input = $("#fileInput");
  input.accept = svc.accept.map(t => EXT[t]).join(","); input.multiple = svc.multi > 1;
  $("#dropZone h3").textContent = svc.multi > 1 ? "Upload new files" : "Upload a new file";
  $("#dropZone p.muted").textContent = `For this service: ${svc.needs}.`;
  const files = current ? svcFiles() : [];
  svcPicked = svcPicked.filter(id => files.some(f => f.id === id));
  $("#svcLibHint").textContent = files.length ? svc.hint : "Nothing suitable in this project yet. Upload a file to start.";
  $("#svcFiles").replaceChildren(...files.map(f => {
    const on = svcPicked.includes(f.id);
    const box = el("input", { type: svc.multi > 1 ? "checkbox" : "radio", name: "svcFile", value: f.id, ...(on ? { checked: "" } : {}) });
    box.onchange = () => {
      if (svc.multi > 1) {
        if (box.checked && svcPicked.length >= svc.multi) { box.checked = false; toast(`Use up to ${svc.multi} files here.`); return; }
        svcPicked = box.checked ? [...svcPicked, f.id] : svcPicked.filter(x => x !== f.id);
      } else svcPicked = [f.id];
      drawStart();
    };
    const order = svc.multi > 1 && on ? el("span", { class: "chip" }, String(svcPicked.indexOf(f.id) + 1)) : "";
    const model = modelsNow.find(m => m.source_file_id === f.id);
    const note = f.detected_type === "ifc" ? (model ? "3D model ready" : "not read into 3D yet") : (TYPE[f.detected_type] || f.detected_type);
    return el("label", { class: `svc-file${on ? " on" : ""}` }, box, el("span", { class: "svc-file-name" }, f.original_name, el("small", { class: "muted" }, ` ${note} · ${fmtDate(f.created_at)}`)), order);
  }));
  $("#svcLib").classList.toggle("empty-lib", !files.length);
  $("#svcGo").disabled = !svcPicked.length;
  $("#svcSkip").hidden = !svc.optional;
}
$("#svcGo").onclick = () => { if (svcPicked.length) useFiles(svcPicked); };
$("#svcSkip").onclick = () => useFiles([]);

/* step 2: the service's own screen, with the chosen files already in place */
function useFiles(ids) {
  const files = ids.map(id => current.source_files.find(f => f.id === id)).filter(Boolean);
  if (SERVICES[service].modes) {
    let f = files[0];
    if (f?.detected_type === "rvt") {           // Revit: use its IFC once converted; convert it if not yet
      const ifc = ifcFromRevit(f.id);
      if (!ifc) { convertRevit(f); goTo(service, "work"); return; }
      f = ifc;
    }
    chosenIfc = f ? f.id : null;
    viewerModelId = viewerModelId && modelsNow.find(m => m.id === viewerModelId)?.source_file_id === chosenIfc ? viewerModelId : null;
    if (!viewerModelId && viewer) resetModel();
    const busy = lastJobs.some(j => j.type === "ifc_import" && ["queued", "running"].includes(j.status) && (j.input || {}).source_file_id === chosenIfc);
    if (f && !modelsNow.some(m => m.source_file_id === f.id) && !busy) readModel(f);
    goTo(service, "work"); loadModels(); return;
  }
  if (service === "imageanim") { iaSel = files.map(f => f.id).slice(0, 3); goTo(service, "work"); drawIA(); return; }
  // renders: the first chosen file is the picture to render; the others are references
  rPick = files[0]?.id || null; rRefSel = files.slice(1, 4).map(f => f.id); promptByAI = false;
  drawRenderBox();
  goTo(service, "work");
  $("#rDesc").focus({ preventScroll: true });
}

/** A delete button that asks once ("Delete?" then "Yes, delete") before acting. */
function deleteButton(what, onDelete, small = true) {
  const b = el("button", { class: `btn danger${small ? " sm" : ""}`, type: "button", "aria-label": `Delete ${what}` }, "Delete");
  let armed = null;
  b.onclick = async () => {
    if (!armed) { b.textContent = "Yes, delete"; b.classList.add("solid"); armed = setTimeout(() => { armed = null; b.textContent = "Delete"; b.classList.remove("solid"); }, 4000); return; }
    clearTimeout(armed); armed = null; b.disabled = true; b.textContent = "Deleting…";
    try { await onDelete(); }
    catch (err) { if (err.status === 401) return handle(err); toast(err.message); b.disabled = false; b.textContent = "Delete"; b.classList.remove("solid"); }
  };
  return b;
}

function fileActions(f) {
  const del = deleteButton(f.original_name, async () => {
    await api.deleteFile(current.id, f.id);
    toast(f.detected_type === "ifc" ? "File and its 3D model deleted." : "File deleted.");
    current = await api.getProject(current.id); renderProject(); loadModels(); loadOutputs();
  });
  if (f.detected_type === "rvt" && !ifcFromRevit(f.id))
    return [el("button", { class: "btn", type: "button", onclick: () => convertRevit(f) }, "Convert to IFC"), del];
  if (f.detected_type === "ifc" && f.origin !== "generated")
    return [el("button", { class: "btn", type: "button", onclick: () => readModel(f) }, "Import 3D"), del];
  return [del];
}
/* IFC models are read on the architect's own computer (web-ifc, in a background worker): fast,
   and no load on the server. The server reads small files itself if this computer cannot. */
const reading = new Map();   // file id -> state, while this browser reads it
function drawReading() {
  $("#modelLocal").replaceChildren(...[...reading.values()].filter(r => r.project === current?.id).map(r => el("div", { class: `job${r.error ? " failed" : ""}` },
    r.error ? "" : el("span", { class: "spinner", "aria-hidden": "true" }),
    el("div", { class: "job-body" }, el("b", {}, `Reading ${r.name} on this computer`), el("span", { class: "hint" }, r.error || r.stage),
      r.error ? "" : el("div", { class: "progress" }, el("i", { style: `width:${Math.round((r.k || 0) * 100)}%` }))))));
}
async function readModel(f, localFile) {
  if (!current || reading.has(f.id) && !reading.get(f.id).error) return;
  const pid = current.id, r = { project: pid, name: f.original_name, stage: "Starting…", k: 0.01 };
  reading.set(f.id, r); drawReading();
  $("#modelEmpty").textContent = "Your IFC model is being read on this computer. Large models take a minute or two.";
  const say = (stage, k) => { r.stage = stage; r.k = k; drawReading(); };
  const fallback = async why => {
    console.warn("reading the IFC in the browser failed:", why);
    reading.delete(f.id); drawReading();
    if (current?.id === pid) startImport(f);
  };
  if (typeof WebAssembly === "undefined" || typeof Worker === "undefined") return fallback("no WebAssembly or workers");
  let bytes;
  try {
    say("Opening the file…", 0.02);
    if (localFile) bytes = await localFile.arrayBuffer();
    else { const l = await api.fileLink(pid, f.id); const res = await fetch(l.url || l.download_url); if (!res.ok) throw new Error(`download ${res.status}`); bytes = await res.arrayBuffer(); }
  } catch (err) { if (err.status === 401) return handle(err); return fallback(err); }
  let out;
  try {
    out = await new Promise((resolve, reject) => {
      const w = new Worker(new URL("./ifcread.js", import.meta.url), { type: "module" });
      w.onmessage = e => {
        if (e.data.progress) say(e.data.progress.stage, 0.05 + 0.75 * e.data.progress.k);
        else { w.terminate(); e.data.done ? resolve(e.data.done) : reject(Object.assign(new Error(e.data.error), { told: e.data.error, detail: e.data.detail })); }
      };
      w.onerror = e => { w.terminate(); reject(new Error(e.message || "worker failed")); };
      w.postMessage({ bytes }, [bytes]);
    });
  } catch (err) {
    if (err.told && !/could not be read on this computer/.test(err.told)) {   // a real problem with the file: say what it is
      r.error = err.told; drawReading(); $("#modelEmpty").textContent = err.told; return;
    }
    return fallback(err.detail || err);
  }
  try {
    say("Saving the 3D model to your project… 0%", 0.82);
    await saveBrowserModel(pid, out.glb, { source_file_id: f.id, report: out.report, components: out.components },
      p => say(`Saving the 3D model to your project… ${Math.round(p * 100)}%`, 0.82 + 0.17 * p));
    reading.delete(f.id); drawReading();
    toast(`${f.original_name}: ${out.stats.with_geometry.toLocaleString()} elements read. Your 3D model is ready.`);
    if (current?.id === pid) loadModels();
  } catch (err) {
    if (err.status === 401) return handle(err);
    r.error = err.message; drawReading(); $("#modelEmpty").textContent = err.message;
  }
}
/* Revit: the server has the file converted to IFC (a few minutes); the IFC is then read here like any other. */
let waitingRevit = null;
function ifcFromRevit(rvtId) {
  const j = lastJobs.find(x => x.type === "revit_translate" && x.status === "succeeded" && (x.result || {}).source_file_id === rvtId);
  const id = j?.result?.ifc_file_id || (current?.source_files || []).find(f => f.validation?.details?.from_revit === rvtId)?.id;
  return id ? current.source_files.find(f => f.id === id) || null : null;
}
async function convertRevit(f) {
  waitingRevit = f.id;
  $("#modelEmpty").textContent = "Your Revit file is being converted to IFC. This takes 2 to 10 minutes; it opens here in 3D when ready.";
  try { await api.revitToIfc(current.id, f.id); toast("Converting your Revit file. It opens in 3D when ready."); }
  catch (err) { waitingRevit = null; if (err.status === 401) return handle(err); $("#modelEmpty").textContent = err.message; toast(err.message); }
  loadOutputs();
}
async function startImport(f, btn) {
  if (btn) btn.disabled = true;
  try {
    await api.importIfc(current.id, f.id, newKey());
    $("#modelEmpty").textContent = "Your IFC model is being read into 3D. Small models take under a minute; large ones several minutes.";
    toast("Reading the IFC model. Small models take under a minute; large ones several minutes."); loadOutputs();
  }
  catch (err) { if (err.status === 401) return handle(err); toast(err.message); $("#modelEmpty").textContent = err.message; }
  finally { if (btn) btn.disabled = false; }
}

/* ---------- 3D models (Phase 3) ---------- */
let viewer = null, viewerModelId = null, walkRoom = null, modelLoading = null;   // modelLoading: the model being downloaded into the viewer
function resetModel() {
  $("#walkPanel").hidden = true; walkRoom = null;
  $("#viewerWrap").hidden = true; $("#modelEmpty").hidden = true; $("#modelJobs").replaceChildren();
  $("#modelBadge").hidden = true; $("#modelDetails").hidden = true;
  if (viewer) { viewer.dispose(); viewer = null; }
  viewerModelId = null;
  $("#viewer").replaceChildren(el("div", { class: "viewer-msg", id: "viewerMsg" }, "Loading the 3D model…"));
}

async function loadModels() {
  if (!current) return;
  const pid = current.id;
  let models;
  try { models = await api.models(pid); } catch (err) { if (err.status === 401) return handle(err); return; }
  if (current?.id !== pid) return;
  modelsNow = models;
  if (step === "start") drawStart();      // the Library list shows which IFCs are already in 3D
  // the IFC chosen in this service's first step; while it is still being read, nothing else is shown
  const m = chosenIfc ? models.find(x => x.source_file_id === chosenIfc) : models[0];
  if (!m && viewerModelId) resetModel();
  $("#viewerWrap").hidden = !m;
  $("#modelEmpty").hidden = !!m;
  if (!m || m.id === viewerModelId) return;
  if (viewer) setViewMode("exterior");
  viewerModelId = m.id;
  drawReport(m);
  $("#dlGlb").href = m.glb_url ? `${m.glb_url}&download=${encodeURIComponent(current.name)}-3d.glb` : "#";
  const ifc = current.source_files.find(f => f.id === m.source_file_id);
  $("#dlIfc").hidden = !ifc;
  if (ifc) $("#dlIfc").onclick = async e => { e.preventDefault(); try { const l = await api.fileLink(pid, ifc.id); location.href = l.download_url; } catch (err) { toast(err.message); } };
  try {
    if (!viewer) {
      const { createViewer } = await import("./viewer.js");
      $("#viewer").querySelector(".viewer-msg")?.remove();
      viewer = createViewer($("#viewer"), { onSelect: showElement });
      setViewMode("exterior");
    }
    modelLoading = viewer.load(m.glb_url);
    const info = await modelLoading.finally(() => { modelLoading = null; });
    const pick = $("#storeySelect");
    pick.replaceChildren(el("option", { value: "" }, "All floors"), ...info.storeys.map(s => el("option", { value: s }, s)));
    $("#storeyPick").hidden = info.storeys.length < 2;
    showElement(null);
    if (step === "work" && SERVICES[service]?.modes) setViewMode(SERVICES[service].modes[0]);
  } catch (err) {
    $("#viewer").append(el("div", { class: "viewer-msg" }, "The 3D view could not start on this device. You can still download the model."));
  }
}

function setViewMode(mode) {
  if (!viewer) return;
  if (mode === "walk") {
    if (viewer.mode !== "walk") walkRoom = viewer.walkTo(walkRoom) ?? walkRoom;
    if (!viewer.rooms().length) toast("This model has no rooms (spaces), so you start in the middle of the ground floor. Walk, or use Floor up.");
    drawRooms();
    $("#viewer canvas")?.focus({ preventScroll: true });
  } else viewer.setMode(mode);
  $("#viewOutside").setAttribute("aria-pressed", String(mode === "exterior"));
  $("#viewInside").setAttribute("aria-pressed", String(mode === "interior"));
  $("#viewWalk").setAttribute("aria-pressed", String(mode === "walk"));
  $("#walkPanel").hidden = mode !== "walk";
}
$("#viewOutside").onclick = () => setViewMode("exterior");
$("#viewInside").onclick = () => setViewMode("interior");
$("#viewWalk").onclick = () => setViewMode("walk");
$("#viewPick").onchange = e => { const v = e.target.value; e.target.value = ""; if (!v || !viewer) return; if (viewer.mode === "walk") setViewMode("exterior"); viewer.view(v); };
const floorStep = k => { const s = viewer?.changeFloor(k); if (s) toast(s); else toast(k > 0 ? "This is the top floor." : "This is the lowest floor."); };
$("#floorUp").onclick = () => floorStep(1);
$("#floorDown").onclick = () => floorStep(-1);

/* walking through the rooms */
function drawRooms() {
  const rs = viewer?.rooms() || [], floors = new Set(rs.map(r => r.storey)).size;
  $("#roomList").replaceChildren(...rs.map(r => el("button", { type: "button", class: "chip room", "aria-pressed": String(r.index === walkRoom),
    onclick: () => { walkRoom = r.index; viewer.walkTo(r.index); drawRooms(); } }, floors > 1 && r.storey ? `${r.name} · ${r.storey}` : r.name)));
}
document.querySelectorAll("[data-hold]").forEach(b => {
  const [f, t, u = 0] = b.dataset.hold.split(",").map(Number);
  const stop = () => viewer?.hold(0, 0, 0);
  b.addEventListener("pointerdown", e => { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch { /* not a real pointer */ } viewer?.hold(f, t, u); });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach(ev => b.addEventListener(ev, stop));
  b.addEventListener("contextmenu", e => e.preventDefault());
});

$("#viewReset").onclick = () => viewer?.reset();
$("#storeySelect").onchange = e => { viewer?.setStorey(e.target.value); if (e.target.value) setViewMode("interior"); };

const TYPE_NAME = { IfcWall: "Wall", IfcWallStandardCase: "Wall", IfcSlab: "Floor slab", IfcRoof: "Roof", IfcDoor: "Door", IfcWindow: "Window", IfcSpace: "Room", IfcColumn: "Column", IfcBeam: "Beam", IfcStair: "Stair", IfcCovering: "Covering", IfcRailing: "Railing" };
/* a tapped part of the building: a small label over the 3D view, gone again with its close button */
function showElement(x) {
  const host = $("#viewer");
  let tip = host.querySelector(".el-tip");
  if (!x) { tip?.remove(); return; }
  if (!tip) { tip = el("div", { class: "el-tip", role: "status", id: "elementCard" }); host.append(tip); }
  tip.replaceChildren(el("b", {}, TYPE_NAME[x.ifcType] || (x.ifcType || "Element").replace(/^Ifc/, "")),
    el("span", {}, [x.name, x.storey].filter(Boolean).join(" · ") || "No name"),
    el("button", { type: "button", class: "el-close", "aria-label": "Close", onclick: () => tip.remove() }, "×"));
}

/* the model check: one small badge; the full list only when asked for */
function drawReport(m) {
  const r = m.report || {};
  const verdict = { pass: "Model checked: ready to use", warn: "Model checked: usable, with notes", fail: "Model has problems" }[r.status] || "Model report";
  $("#reportCard").replaceChildren(el("h3", {}, verdict),
    el("ul", { class: "checks" }, ...(r.checks || []).map(c => el("li", { class: c.status }, c.message))));
  const badge = $("#modelBadge"), n = (m.stats || {}).with_geometry || r.with_geometry;
  badge.hidden = false; badge.className = `btn model-badge ${r.status || ""}`;
  badge.textContent = `${r.status === "fail" ? "! Problems" : r.status === "warn" ? "✓ Ready, with notes" : "✓ Ready"}${n ? ` · ${n.toLocaleString()} parts` : ""}`;
  badge.title = "Model check and downloads";
  $("#modelDetails").hidden = r.status !== "fail"; badge.setAttribute("aria-expanded", String(r.status === "fail"));
}
$("#modelBadge").onclick = () => { const d = $("#modelDetails"); d.hidden = !d.hidden; $("#modelBadge").setAttribute("aria-expanded", String(!d.hidden)); };

/* "Capture view": the current view of the model becomes the picture to render, with its exact line
   drawing saved beside it; the render is checked against the lines (see renders.geometry_check). */
const dataBlob = url => fetch(url).then(r => r.blob());
const stampNow = () => new Date().toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }).replace(/[/:]/g, "-");
$("#useView").onclick = async () => {
  if (!viewer) return;
  const btn = $("#useView"); btn.disabled = true; btn.textContent = "Capturing…";
  try {
    const name = `3D view ${stampNow()}`;
    const g = viewer.guides(1536, 1024, ["view", "lines"]);
    const saved = await uploadFile(current.id, new File([await dataBlob(g.view)], `${name}.jpg`, { type: "image/jpeg" }), () => {});
    await uploadFile(current.id, new File([await dataBlob(g.lines)], `Guide - ${name} - lines.png`, { type: "image/png" }), () => {});
    current = await api.getProject(current.id); rPick = saved.id; promptByAI = false; renderProject();
    toast("View captured. Press “Read image and write prompt”.");
    $("#renderForm").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
  } catch (err) { if (err.status === 401) return handle(err); toast(err.message); }
  finally { btn.disabled = false; btn.textContent = "Capture view"; }
};
/** The line drawing captured with a view of the model, if there is one. */
function guideFor(fileId) {
  const f = (current?.source_files || []).find(x => x.id === fileId);
  if (!f) return null;
  const base = f.original_name.replace(/\.(jpe?g|png)$/i, "");
  return (current.source_files || []).find(x => x.original_name === `Guide - ${base} - lines.png`)?.id || null;
}

/* ---------- AI walkthrough: Claude plans the shots, the model gives the exact camera moves ---------- */
const SHOT_NAME = { approach: "Approach from the street", orbit: "Orbit around the building", aerial: "Aerial over the site", rise: "Rise up the facade", push: "Slow move in", custom: "Your move" };
const FILM_PRICE = { path: 0.28, path_plus: 0.17 };
let shots = [], filmEngines = {}, filming = null;
function newShot(kind, seconds, extra = {}) {
  if (!viewer) { toast("Open your model first."); return null; }
  const poses = viewer.shotPath(kind);
  const thumb = viewer.guides(320, 180, ["clay"], viewer.along(poses, 0)).clay;
  return { id: newKey(), kind, seconds, name: extra.name || SHOT_NAME[kind], poses, thumb, frame_prompt: extra.frame_prompt || "", motion_prompt: extra.motion_prompt || "", life: extra.life ?? null };
}
function drawShots() {
  $("#filmShots").replaceChildren(...shots.map((s, i) => {
    const name = el("input", { type: "text", value: s.name, maxlength: "80", "aria-label": "Shot name" });
    name.addEventListener("change", () => { s.name = name.value.trim() || SHOT_NAME[s.kind]; });
    const secs = el("select", { "aria-label": `Length of ${s.name}` }, ...[4, 5, 6, 8, 10].map(v => el("option", { value: String(v), ...(v === s.seconds ? { selected: "" } : {}) }, `${v} s`)));
    secs.onchange = () => { s.seconds = Number(secs.value); drawFilmEstimate(); };
    return el("li", { class: "film-shot" },
      el("img", { src: s.thumb, alt: `First frame of ${s.name}`, width: "160", height: "90" }),
      el("div", { class: "film-shot-body" }, el("span", { class: "num" }, String(i + 1)), name,
        el("span", { class: "hint" }, SHOT_NAME[s.kind] + (s.frame_prompt ? " · prompts by Claude" : "")), secs,
        el("div", { class: "film-shot-tools" },
          el("button", { class: "btn sm", type: "button", onclick: () => previewShot(s) }, "Preview"),
          el("button", { class: "btn sm", type: "button", "aria-label": `Move ${s.name} earlier`, ...(i === 0 ? { disabled: "" } : {}), onclick: () => { [shots[i - 1], shots[i]] = [shots[i], shots[i - 1]]; drawShots(); } }, "↑"),
          el("button", { class: "btn sm danger", type: "button", onclick: () => { shots = shots.filter(x => x !== s); drawShots(); } }, "Remove"))));
  }));
  drawFilmEstimate();
}
function drawFilmEstimate() {
  const secs = shots.reduce((a, s) => a + s.seconds, 0), eng = $("#filmEngine").value, p = FILM_PRICE[eng] || 0.28;
  $("#filmGo").disabled = !shots.length || !!filming;
  $("#filmEst").textContent = shots.length ? `${shots.length} shot${shots.length > 1 ? "s" : ""}, ${secs} s of film. About $${(secs * p).toFixed(2)} for the video plus one render per shot; ready in about ${Math.max(3, Math.round(2 + secs / 4))}–${Math.round(6 + secs / 3)} minutes.` : "Add a shot first.";
}
async function previewShot(s) {
  if (!viewer) return;
  const n = Math.max(2, s.seconds * 20), t0 = performance.now();
  const step = now => {
    const k = Math.min(1, (now - t0) / (s.seconds * 1000));
    viewer.showPose(viewer.along(s.poses, k));
    if (k < 1) requestAnimationFrame(step);
  };
  if (viewer.mode === "walk") setViewMode("exterior");
  $("#viewer").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" });
  void n; requestAnimationFrame(step);
}
$("#addShot").onclick = () => { const s = newShot($("#shotKind").value, Number($("#shotSecs").value)); if (s) { shots.push(s); drawShots(); } };
$("#addShotView").onclick = () => { const s = newShot("push", 6, { name: viewer?.mode === "walk" ? (viewer.room || "Inside") : "This view" }); if (s) { shots.push(s); drawShots(); toast("Shot added from this view. Find it under AI walkthrough."); } };
$("#filmEngine").addEventListener("change", () => {
  const e = filmEngines[$("#filmEngine").value]; $("#filmEngineNote").textContent = e ? `${e.blurb} ${e.price}.` : ""; drawFilmEstimate();
});
async function loadFilmEngines() {
  try { filmEngines = await api.filmEngines(); } catch { filmEngines = {}; }
  delete filmEngines._pictures;
  const keep = $("#filmEngine").value;
  $("#filmEngine").replaceChildren(...Object.entries(filmEngines).map(([k, e]) => el("option", { value: k, ...(e.available ? {} : { disabled: "" }) }, `${e.name}${e.available ? "" : " (not connected yet)"}`)));
  $("#filmEngine").value = filmEngines[keep]?.available ? keep : (Object.keys(filmEngines).find(k => filmEngines[k].available) || "path");
  $("#filmEngine").dispatchEvent(new Event("change"));
}
$("#planBtn").onclick = async () => {
  if (!viewer || !current) { toast("Open your model first."); return; }
  const btn = $("#planBtn"); btn.disabled = true; btn.textContent = "Claude is planning…";
  try {
    const plan = await api.planFilm(current.id, { ...viewer.facts, description: $("#filmDesc").value.trim(), seconds: 24 });
    shots = plan.shots.map(s => newShot(s.kind, s.seconds, s)).filter(Boolean);
    drawShots();
    $("#planNoteFilm").textContent = plan.notes || (plan.by === "claude" ? "Planned by Claude." : "A ready-made plan.");
  } catch (err) { if (err.status === 401) return handle(err); toast(err.message); }
  finally { btn.disabled = false; btn.textContent = "Plan the shots with Claude"; }
};
$("#filmGo").onclick = async () => {
  if (!shots.length || filming || !viewer) return;
  const { canRecord, recordShot } = await import("./guidevideo.js");
  if (!canRecord()) { message($("#filmMsg"), "This browser cannot record the shots. Use Chrome or Edge on a computer, or Safari 17 or newer."); return; }
  message($("#filmMsg"), "");
  const ctl = new AbortController(); filming = ctl; drawFilmEstimate();
  const fmt = $("#filmFormat").value, engine = $("#filmEngine").value, desc = $("#filmDesc").value.trim(), life = $("#filmLife").checked;
  const say = (f, text) => { $("#filmProgress").hidden = false; $("#filmBar").style.width = `${Math.round(f * 100)}%`; $("#filmProgText").textContent = text; };
  let sent = 0;
  try {
    for (const [i, s] of shots.entries()) {
      const part = 1 / shots.length, at = i * part;
      say(at, `Shot ${i + 1} of ${shots.length}: recording the exact camera move from your model…`);
      const rec = await recordShot(viewer, s.poses, s.seconds, fmt, { signal: ctl.signal, onProgress: f => say(at + part * 0.7 * f, `Shot ${i + 1} of ${shots.length}: recording the camera move… ${Math.round(f * 100)}%`) });
      const stamp = stampNow();
      const clay = await uploadFile(current.id, new File([await dataBlob(rec.first.clay)], `Guide - ${s.name} ${stamp} - clay.jpg`, { type: "image/jpeg" }), () => {});
      const lines = await uploadFile(current.id, new File([await dataBlob(rec.first.lines)], `Guide - ${s.name} ${stamp} - lines.png`, { type: "image/png" }), () => {});
      await sendShot(current.id, rec.blob, { name: s.name, kind: s.kind, engine, tier: chosenTier(), format: fmt, description: desc,
        frame_prompt: s.frame_prompt, motion_prompt: s.motion_prompt, life: s.life ?? life, clay_file_id: clay.id, lines_file_id: lines.id },
        f => say(at + part * (0.7 + 0.3 * f), `Shot ${i + 1} of ${shots.length}: sending… ${Math.round(f * 100)}%`));
      sent++;
    }
    say(1, `${sent} shot${sent > 1 ? "s" : ""} sent. Each is rendered, filmed and checked against your model; they appear below in a few minutes.`);
    toast("Filming started. You can leave this page; the shots appear below when ready.");
    current = await api.getProject(current.id).catch(() => current); renderProject(); loadOutputs();
  } catch (err) {
    if (err.name === "AbortError") message($("#filmMsg"), "Stopped.", "ok");
    else if (err.status === 401) handle(err);
    else message($("#filmMsg"), (sent ? `${sent} shot${sent > 1 ? "s were" : " was"} sent. ` : "") + (err.message || "The shots could not be recorded."));
    if (sent) loadOutputs();
  } finally { filming = null; drawFilmEstimate(); }
};
function checkChip(v) {
  const c = (v.script || {}).check;
  if (!c || c.score === undefined) return "";
  const word = { good: "Matches the model", fair: "Mostly matches the model", poor: "Drifted from the model" }[c.band] || "Checked";
  return el("span", { class: `chip check-${c.band}`, title: (c.claude?.issues || []).join("; ") || `Match ${Math.round(c.score * 100)}%` }, `${word} · ${Math.round(c.score * 100)}%`);
}

/* ---------- concept renders (Phase 2) ---------- */
const JOB_NAME = { concept_render: "New concept", concept_edit: "Revision", ifc_import: "Reading your model", animation_export: "Animation video", cinematic_clip: "Cinematic clip", film_shot: "Walkthrough shot", revit_translate: "Converting Revit to IFC" };
const LIGHT_NAME = { morning: "Morning", midday: "Midday", "golden hour": "Golden hour", dusk: "Dusk", night: "Night" };
let pollTimer = null, outputsFor = null, seenFailed = new Set(), seenDone = new Set(), outputsLoadedOnce = false;
function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }

async function loadOutputs() {
  if (!current) return;
  const pid = current.id; outputsFor = pid;
  let out;
  try { out = await api.outputs(pid); }
  catch (err) { if (err.status === 401) return handle(err); pollTimer = setTimeout(loadOutputs, 8000); return; }
  if (outputsFor !== pid || $("#projectView").hidden) return;
  $("#studioOff").hidden = out.renders_enabled; $("#renderForm").hidden = !out.renders_enabled;
  setupTiers(out); lastJobs = out.jobs;
  const IMAGE_JOBS = ["concept_render", "concept_edit"], VIDEO_JOBS = ["animation_export", "cinematic_clip", "film_shot"];
  drawJobs(out.jobs.filter(j => IMAGE_JOBS.includes(j.type)), "#jobList");
  drawJobs(out.jobs.filter(j => j.type === "ifc_import" || j.type === "revit_translate"), "#modelJobs");
  drawJobs(out.jobs.filter(j => j.type === "film_shot"), "#filmJobs");
  drawJobs(out.jobs.filter(j => j.type === "animation_export" || j.type === "cinematic_clip"), "#iaJobs");
  drawGallery(out.images);
  images = out.images; drawIA();
  const vids = out.jobs.filter(j => VIDEO_JOBS.includes(j.type) && j.status === "succeeded" && !seenDone.has(j.id));
  vids.forEach(j => seenDone.add(j.id));
  if (vids.length && outputsLoadedOnce) { loadVideos(); toast(vids.some(j => j.type === "film_shot") ? "A walkthrough shot is ready." : vids.some(j => j.type === "cinematic_clip") ? "Your cinematic clip is ready." : "Your animation video is ready."); }
  const read = out.jobs.filter(j => j.type === "ifc_import" && j.status === "succeeded" && !seenDone.has(j.id));
  read.forEach(j => seenDone.add(j.id));
  if (read.length && outputsLoadedOnce) { loadModels(); current = await api.getProject(current.id).catch(() => current); renderProject(); }
  const converted = out.jobs.filter(j => j.type === "revit_translate" && j.status === "succeeded" && !seenDone.has(j.id));
  converted.forEach(j => seenDone.add(j.id));
  if (converted.length && outputsLoadedOnce) {
    current = await api.getProject(current.id).catch(() => current); renderProject();
    const j = converted.find(x => (x.result || {}).source_file_id === waitingRevit) || converted[0];
    const ifc = current.source_files.find(f => f.id === (j.result || {}).ifc_file_id);
    if (ifc) { toast(`${ifc.original_name} is ready. Reading it into 3D…`); if (SERVICES[service]?.modes && (waitingRevit === j.result.source_file_id || !chosenIfc)) useFiles([ifc.id]); }
    waitingRevit = null;
  }
  outputsLoadedOnce = true;
  stopPolling();
  if (out.jobs.some(j => j.status === "queued" || j.status === "running")) pollTimer = setTimeout(loadOutputs, 3000);
}

function drawJobs(jobs, target = "#jobList") {
  const now = Date.now();
  const show = jobs.filter(j => j.status === "queued" || j.status === "running"
    || ((j.status === "failed" || j.status === "cancelled") && now - new Date(j.finished_at || j.created_at).getTime() < 30 * 60 * 1000 && !seenFailed.has(j.id)));
  $(target).replaceChildren(...show.map(j => {
    const active = j.status === "queued" || j.status === "running";
    const text = j.status === "failed" ? j.error : j.status === "cancelled" ? (j.stage || "Cancelled.") : (j.stage || (j.status === "queued" ? "Waiting to start" : "Working"));
    return el("div", { class: `job ${j.status}` },
      el("span", { class: "spinner", "aria-hidden": "true" }),
      el("span", { class: "what" }, `${JOB_NAME[j.type] || "Render"} · ${j.status === "running" ? "working" : j.status}`),
      active ? el("button", { class: "btn", type: "button", onclick: () => cancel(j.id) }, "Cancel")
             : el("button", { class: "btn", type: "button", onclick: () => { seenFailed.add(j.id); loadOutputs(); } }, "Dismiss"),
      el("span", { class: "stage" }, text));
  }));
}

function drawGallery(images) {
  $("#galleryEmpty").hidden = images.length > 0;
  const byId = Object.fromEntries(images.map(i => [i.id, i]));
  $("#gallery").replaceChildren(...images.map(i => {
    const o = i.options || {};
    const [w, h] = [i.width || 3, i.height || 2];
    const tags = [o.film_shot ? `First frame: ${o.film_shot}` : null, o.prompt_ready ? "AI prompt" : null, i.tier === "premium" && o.quality === "high" ? "High detail" : null].filter(Boolean);
    const input = el("input", { type: "text", maxlength: "1000", placeholder: "What should change? e.g. make the roof dark grey", "aria-label": "Describe a change" });
    const go = el("button", { class: "btn primary", type: "submit" }, "Revise");
    const parent = i.parent_image_id ? byId[i.parent_image_id] : null;
    return el("article", { class: "shot" },
      el("div", { class: "frame", style: `aspect-ratio:${w}/${h}` },
        i.url ? el("img", { src: i.url, alt: `AI concept render: ${i.prompt}`, loading: "lazy", width: String(w), height: String(h) }) : el("span", { class: "muted" }, "Image link unavailable"),
        el("span", { class: "badge" }, i.label)),
      el("div", { class: "body" },
        el("p", { class: "prompt" }, i.parent_image_id ? `Revision: ${i.prompt}` : i.prompt),
        el("div", { class: "tags" }, el("span", { class: `chip ${i.tier === "premium" ? "premium" : ""}` }, i.tier_name || "Render"), ...tags.map(t => el("span", { class: "chip" }, t)), parent ? el("span", { class: "chip" }, "Revised") : "",
          o.check ? checkChip({ script: { check: o.check } }) : ""),
        el("p", { class: "hint" }, fmtDate(i.created_at)),
        el("div", { class: "actions" }, i.download_url ? el("a", { class: "btn", href: i.download_url, download: "" }, "Download") : "",
          deleteButton("this render", async () => { await api.deleteRender(i.id); toast("Render deleted."); loadOutputs(); }, false)),
        el("form", { class: "revise", onsubmit: e => { e.preventDefault(); revise(i.id, input, go); } }, input, go)));
  }));
}

let tierInfo = null;
function setupTiers(out) {
  tierInfo = out.tiers || {};
  const std = tierInfo.standard || {}, prem = tierInfo.premium || {};
  const stdInput = $("#tierPick input[value=standard]"), premInput = $("#tierPick input[value=premium]");
  stdInput.disabled = !std.available;
  $("#stdNote").textContent = std.available ? `Free · ${std.daily_limit ? `${std.daily_limit} a day` : "no daily limit"}` : "Not available right now";
  $("#premiumTier").hidden = !prem.available;
  $("#premiumTier").classList.add("premium-tag");
  premInput.disabled = !prem.allowed;
  $("#premNote").textContent = prem.allowed ? `Our best image quality, with expert prompting that studies your plan, sketches and references · ${prem.daily_limit ? `${prem.daily_limit} a day` : "no daily limit"}` : "Paid plans only. Upgrade to unlock.";
  if (!std.available && prem.allowed) premInput.checked = true;
  if (premInput.checked && premInput.disabled) stdInput.checked = true;
  // the added options, beside Standard and Premium (which are unchanged)
  let more = $("#moreTiers");
  if (!more) { more = el("div", { id: "moreTiers", class: "more-tiers", role: "group", "aria-label": "More options" }); $("#tierPick").append(more); }
  const was = chosenTier();
  more.replaceChildren(...Object.entries(tierInfo).filter(([k]) => k !== "standard" && k !== "premium").map(([k, t]) => {
    const on = t.available && t.allowed;
    const note = t.soon ? "Coming soon" : !t.available ? "Not connected yet" : t.left === 0 ? "Your free ones are used" : !t.allowed ? "Paid plans only"
      : t.left ? `${t.left} free for you` : t.price;
    const input = el("input", { type: "radio", name: "tier", value: k, ...(on ? {} : { disabled: "" }), ...(on && was === k ? { checked: "" } : {}) });
    input.addEventListener("change", tierChanged);
    return el("label", { class: `tier premium-tag${on ? "" : " off"}` }, input, el("span", {}, el("b", {}, t.name), el("small", {}, `${t.blurb} · ${note}`)));
  }));
  if (!$("#tierPick input[name=tier]:checked")) stdInput.checked = true;
  tierChanged();
  updateClipEngines(out.video_engines || {});
}
function chosenTier() { return $("#tierPick input[name=tier]:checked")?.value || "standard"; }
/* AI version: a dropdown. Closed, it shows only the chosen one; open, the list; picking one closes it. */
function tierToggle() {
  let b = $("#tierToggle");
  if (!b) {
    b = el("button", { type: "button", id: "tierToggle", class: "tier-toggle", "aria-expanded": "false" });
    b.onclick = () => setTierOpen(!$("#tierPick").classList.contains("open"));
    $("#tierPick legend").after(b);
  }
  return b;
}
function setTierOpen(open) {
  $("#tierPick").classList.toggle("open", open);
  tierToggle().setAttribute("aria-expanded", String(open));
}
function drawTierToggle() {
  const chosen = $("#tierPick input[name=tier]:checked")?.closest("label");
  const name = chosen?.querySelector("b")?.textContent || "Standard render", note = chosen?.querySelector("small")?.textContent || "";
  tierToggle().replaceChildren(el("span", {}, el("b", {}, name), el("small", {}, note)), el("span", { class: "chev", "aria-hidden": "true" }, "▾"));
  tierToggle().classList.toggle("pro", !!chosen?.classList.contains("premium-tag"));
}
function tierChanged() {
  drawTierToggle();
  setTierOpen(false);
  const t = chosenTier(), info = tierInfo?.[t] || {};
  $("#qualityField").hidden = t !== "premium";  // the free model has one detail level
  $("#renderLimit").textContent = info.daily_limit ? `${info.name}: up to ${info.daily_limit} a day, reset at 01:00 Lagos time. Failed ones do not count.` : "";
}
document.querySelectorAll("#tierPick input").forEach(i => i.addEventListener("change", tierChanged));

function briefFromForm() {
  const f = (current?.source_files || []).find(x => x.id === rPick), d = f?.details || {};
  const ratio = d.width && d.height ? d.width / d.height : 1.5;
  const prompt = $("#rPrompt").value.trim() || $("#rDesc").value.trim();
  const guide = rPick ? guideFor(rPick) : null;
  return { prompt, prompt_ready: promptByAI && !!$("#rPrompt").value.trim(), references: renderRefs(), tier: chosenTier(), quality: $("#rQuality").value,
    ...(guide ? { guide_file_id: guide } : {}),
    aspect: ratio > 1.15 ? "landscape" : ratio < 0.87 ? "portrait" : "square" };
}
$("#renderForm").onsubmit = e => {
  e.preventDefault();
  const body = briefFromForm();
  if (body.prompt.length < 3) { message($("#renderMsg"), "Press “Read image and write prompt” first, or write the prompt yourself."); return; }
  const key = newKey();
  busy(e.target, async () => {
    message($("#renderMsg"), "");
    try { await api.startRender(current.id, body, key); toast("Render started. It takes about a minute."); loadOutputs(); }
    catch (err) { if (err.status === 401) return handle(err); message($("#renderMsg"), err.message); }
  });
};

async function revise(id, input, btn) {
  const text = input.value.trim();
  if (text.length < 3) { input.focus(); toast("Say what should change."); return; }
  btn.disabled = true;
  try { await api.editRender(id, text, newKey()); input.value = ""; toast("Revision started. The original stays as it is."); loadOutputs(); }
  catch (err) { if (err.status === 401) return handle(err); toast(err.message); }
  finally { btn.disabled = false; }
}

async function cancel(id) {
  try { const j = await api.cancelJob(id); toast(j.stage || "Cancelled."); }
  catch (err) { if (err.status === 401) return handle(err); toast(err.message); }
  loadOutputs();
}

/* ---------- uploads ---------- */
async function uploadAll(files) {
  const done = [];
  for (const file of files) {
    const bar = el("i"); const status = el("span", { class: "muted mono" }, "0%");
    const row = el("div", { class: "upload-row" }, el("span", { class: "name" }, file.name), status, el("div", { class: "progress" }, bar));
    $("#uploads").prepend(row);
    try {
      const uploaded = uploadFile(current.id, file, f => { bar.style.width = `${Math.round(f * 100)}%`; status.textContent = `${Math.round(f * 100)}%`; });
      const saved = await uploaded;
      bar.style.width = "100%"; status.textContent = "Checked and saved";
      if (saved?.detected_type === "ifc") readModel(saved, file);
      if (saved) done.push(saved);
      current = await api.getProject(current.id); renderProject();
      setTimeout(() => row.remove(), 2500);
    } catch (err) {
      row.classList.add("error"); status.textContent = "Not uploaded"; row.append(el("span", { class: "reason" }, err.message));
      if (err.status === 401) { handle(err); return done; }
    }
  }
  return done;
}
/* a file uploaded in a service's first step is used straight away */
async function uploadForService(files) {
  const svc = service, saved = await uploadAll(files);
  if (!svc || service !== svc || step !== "start") return;
  const fits = saved.filter(f => SERVICES[svc].accept.includes(f.detected_type));
  if (fits.length) useFiles(fits.map(f => f.id));
  else if (saved.length) toast(`Saved to your Library. ${SERVICES[svc].name} needs ${SERVICES[svc].needs}.`);
}
$("#fileInput").onchange = e => { uploadForService([...e.target.files]); e.target.value = ""; };
const dz = $("#dropZone");
["dragenter", "dragover"].forEach(t => dz.addEventListener(t, e => { e.preventDefault(); dz.classList.add("over"); }));
["dragleave", "drop"].forEach(t => dz.addEventListener(t, e => { e.preventDefault(); dz.classList.remove("over"); }));
dz.addEventListener("drop", e => uploadForService([...e.dataTransfer.files]));

/* ---------- delete with an in-page confirmation ---------- */
function resetDelete() { $("#deleteArea").replaceChildren(el("button", { class: "btn danger", type: "button", id: "deleteBtn", onclick: askDelete }, "Delete project")); }
function askDelete() {
  const n = current.source_files.length;
  $("#deleteArea").replaceChildren(
    el("span", {}, `Delete “${current.name}” and its ${n} file${n === 1 ? "" : "s"}?`),
    el("button", { class: "btn danger solid", type: "button", onclick: doDelete }, "Yes, delete it"),
    el("button", { class: "btn", type: "button", onclick: resetDelete }, "Cancel"));
}
async function doDelete() {
  try { await api.deleteProject(current.id); toast("Project deleted."); listProjects(); }
  catch (err) { handle(err); }
}

function handle(err, box) {
  if (err instanceof ApiError && err.status === 401) { session.signOut(); authMode("in"); message($("#authMsg"), "Your session ended. Sign in again."); show("authView"); return; }
  if (box) message(box, err.message); else toast(err.message);
}

/* ---------- videos ---------- */
let images = [], videos = [];
async function loadVideos() {
  if (!current) return;
  const pid = current.id;
  try { const v = await api.videos(pid); if (current?.id !== pid) return; videos = v; drawVideos(); }
  catch (err) { if (err.status === 401) return handle(err); }
}
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function drawVideos() {
  const card = v => {
    const ratio = `${v.width}/${v.height}`;
    return el("article", { class: "video-card" },
      el("div", { class: "frame", style: `aspect-ratio:${ratio}` },
        v.url ? el("video", { src: v.url, controls: "", preload: "metadata", playsinline: "", "aria-label": `Video: ${v.title || "untitled"}` }) : el("span", { class: "muted" }, "Video link unavailable")),
      el("div", { class: "body" },
        el("h3", {}, v.title || (v.kind === "cinematic" ? "Cinematic clip" : v.kind === "construction" ? "Construction sequence" : "Walkthrough")),
        v.kind === "film" ? el("div", { class: "tags" }, checkChip(v)) : "",
        el("div", { class: "tags" }, el("span", { class: "chip" }, v.format), el("span", { class: "chip" }, `${Math.round(v.duration_s)} s`), el("span", { class: "chip" }, v.kind === "cinematic" ? "AI video" : v.kind === "construction" ? "Construction" : `${(v.items || []).length} shot${(v.items || []).length === 1 ? "" : "s"}`), el("span", { class: "chip" }, v.label)),
        el("p", { class: "hint" }, fmtDate(v.created_at)),
        el("div", { class: "actions" }, v.download_url ? el("a", { class: "btn primary", href: v.download_url, download: "" }, "Download MP4") : "",
          deleteButton("this video", async () => { await api.deleteVideo(v.id); toast("Video deleted."); loadVideos(); }, false))));
  };
  $("#filmVideos").replaceChildren(...videos.filter(v => v.kind === "film").map(card));
  $("#iaVideos").replaceChildren(...videos.filter(v => v.kind === "construction" || v.kind === "cinematic").map(card));
  $("#libVideos").replaceChildren(...videos.map(card));
  $("#libVideosEmpty").hidden = videos.length > 0;
}

const fmtClock = x => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, "0")}`;
function tickedLooks() { return rRefSel.slice(); }

/* ---------- construction animation from 3D images ---------- */
let IA = null, iaSel = [], iaAsIs = new Set(), iaPending = new Set(), iaAnim = null, iaT = 0, iaPlaying = false, iaRaf = 0, iaLast = 0, iaExporting = null, iaKey = "", iaBuildKey = "";
const imgCache = new Map(), linkCache = new Map();
const IA_SIZE = { "16:9": [960, 540], "9:16": [540, 960], "1:1": [720, 720] };
function resetIA() {
  iaSel = []; iaAsIs = new Set(); iaPending = new Set(); iaAnim = null; iaT = 0; iaKey = iaBuildKey = ""; iaStop();
  $("#iaPick").replaceChildren(el("span", { class: "hint" }, "Choose the images in step 1 of this service."));
  $("#iaStage").hidden = true; $("#iaExport").disabled = true; message($("#iaMsg"), "");
}
function loadImg(url) {
  if (!imgCache.has(url)) imgCache.set(url, new Promise((res, rej) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = rej; i.src = url; }));
  return imgCache.get(url);
}
async function sourceLink(fid) {
  if (!linkCache.has(fid)) linkCache.set(fid, api.fileLink(current.id, fid).then(r => r.url).catch(() => null));
  return linkCache.get(fid);
}
const iaFiles = () => (current?.source_files || []).filter(f => (f.detected_type === "png" || f.detected_type === "jpeg") && !/^(Photoreal view|Cinematic start view) \d/.test(f.original_name));
const iaRender = fid => images.find(i => (i.options || {}).anim_hero?.key === `img-${fid}` && (i.base_url || i.url));
const iaLine = fid => images.find(i => (i.options || {}).anim_line?.key === `img-${fid}` && (i.base_url || i.url));
const LINE_PROMPT = "Turn this picture into a clean architectural wireframe line drawing of the building only: thin, crisp, bright white lines on a pure black background, "
  + "tracing the outline, every floor slab edge, balcony edge, column and window frame, in exactly the same position, size and camera. "
  + "Remove the trees, cars, people, sky, ground texture and all shading and colour. No text.";
let iaLineWanted = new Set(), iaLinePending = new Set();
/** After a photoreal view arrives, its line drawing is made from it (only for views asked for in this visit). */
async function iaRequestLines() {
  for (const fid of [...iaLineWanted]) {
    const r = iaRender(fid);
    if (!r || iaLine(fid) || iaLinePending.has(fid)) { if (iaLine(fid)) { iaLineWanted.delete(fid); iaLinePending.delete(fid); } continue; }
    iaLinePending.add(fid);
    try { await api.editRender(r.id, LINE_PROMPT, newKey(), { anim_line: { index: Math.max(0, iaSel.indexOf(fid)), key: `img-${fid}` } }); drawIA(); loadOutputs(); }
    catch (err) { iaLinePending.delete(fid); iaLineWanted.delete(fid); toast(`The line drawing could not be started: ${err.message}`); }
  }
}

function drawIA() {
  if (!current) return;
  const files = iaFiles();
  iaSel = iaSel.filter(id => files.some(f => f.id === id));
  iaRequestLines();
  const key = JSON.stringify([files.map(f => f.id), iaSel, [...iaAsIs], [...iaPending], [...iaLinePending], files.map(f => (iaRender(f.id)?.id || "") + (iaLine(f.id)?.id || ""))]);
  if (key !== iaKey) {
    iaKey = key;
    $("#iaPick").replaceChildren(...(files.length ? files.map(f => {
      const r = iaRender(f.id), on = iaSel.includes(f.id), asIs = iaAsIs.has(f.id);
      if (r) iaPending.delete(`img-${f.id}`);
      const pending = iaPending.has(`img-${f.id}`);
      const thumb = el("img", { alt: `Photoreal view of ${f.original_name}`, loading: "lazy" });
      if (r && !asIs) thumb.src = r.url; else sourceLink(f.id).then(u => { if (u) thumb.src = u; });
      const use = el("input", { type: "checkbox", ...(on ? { checked: "" } : {}), "aria-label": `Animate ${f.original_name}` });
      use.onchange = () => {
        if (use.checked && iaSel.length >= 3) { use.checked = false; toast("Use up to three images."); return; }
        iaSel = use.checked ? [...iaSel, f.id] : iaSel.filter(x => x !== f.id); drawIA();
      };
      const real = el("input", { type: "checkbox", ...(asIs ? { checked: "" } : {}) });
      real.onchange = () => { if (real.checked) iaAsIs.add(f.id); else iaAsIs.delete(f.id); drawIA(); };
      const ln = iaLine(f.id);
      const badge = asIs ? (ln ? "As it is · lines ready" : "Used as it is") : r ? (ln ? "Photoreal + lines ready" : iaLinePending.has(f.id) ? "Drawing lines…" : "Photoreal ready") : pending ? "Rendering…" : "3D image";
      return el("div", { class: `ia-item${on ? " on" : ""}` },
        el("div", { class: "thumb" }, thumb, el("span", { class: "badge" }, on ? `${iaSel.indexOf(f.id) + 1} · ${badge}` : badge)),
        el("div", { class: "body" }, el("span", { class: "name", title: f.original_name }, f.original_name),
          el("label", { class: "check" }, use, "Animate this"), el("label", { class: "check" }, real, "Already photoreal"),
          (r || asIs) && ln ? el("button", { class: "btn clip", type: "button", onclick: e => startClip({ kind: "lines", id: ln.id }, asIs ? { kind: "file", id: f.id } : { kind: "render", id: r.id },
            $("#iaFormat").value, $("#iaTitle2").value.trim() || current.name, "ia", e.currentTarget) }, "Cinematic clip") : ""));
    }) : [el("span", { class: "hint" }, "Choose the images in step 1 of this service.")]));
  }
  buildIA();
}

async function buildIA() {
  const views = [];
  for (const fid of iaSel) {
    const f = iaFiles().find(x => x.id === fid), r = iaRender(fid);
    const ln = iaLine(fid), line = ln ? ln.base_url || ln.url : null;
    if (iaAsIs.has(fid)) views.push({ fid, url: await sourceLink(fid), line, caption: "", render_id: null, name: f?.original_name });
    else if (r) views.push({ fid, url: r.base_url || r.url, line, caption: "", render_id: r.id, name: f?.original_name });
  }
  const fmt = $("#iaFormat").value, secs = Number($("#iaSeconds").value) || 10;
  const bkey = JSON.stringify([views.map(v => v.url + (v.line || "")), fmt, secs, iaSel]);
  if (bkey === iaBuildKey) return;
  iaBuildKey = bkey;
  const missing = iaSel.length - views.length;
  if (!views.length || !IA) {
    iaAnim = null; $("#iaStage").hidden = true; $("#iaExport").disabled = true;
    $("#iaEst").textContent = iaSel.length ? "Make the photoreal views first (or tick “already photoreal”)." : "Tick the images to animate.";
    return;
  }
  try {
    const imgs = await Promise.all(views.map(v => loadImg(v.url)));
    const lines = await Promise.all(views.map(v => v.line ? loadImg(v.line).catch(() => null) : null));
    if (bkey !== iaBuildKey) return;
    iaStop();
    iaAnim = IA.createImageAnimation(views.map((v, i) => ({ image: imgs[i], drawing: lines[i], caption: "", render_id: v.render_id })), { seconds: secs });
    iaAnim.items = views.map(v => ({ caption: v.name || "", render_id: v.render_id }));
    const [w, h] = IA_SIZE[fmt];
    const c = $("#iaCanvas"); c.width = w; c.height = h;
    $("#iaFrame").style.setProperty("--ar", `${w} / ${h}`); $("#iaFrame").style.setProperty("--arw", String(w / h));
    $("#iaScrub").max = String(Math.round(iaAnim.duration * 100));
    $("#iaStage").hidden = false; $("#iaExport").disabled = false;
    $("#iaEst").textContent = `${fmtClock(iaAnim.duration + 6)} video, ${fmt}${missing ? `. ${missing} ticked image${missing > 1 ? "s have" : " has"} no photoreal view yet and ${missing > 1 ? "are" : "is"} left out` : ""}.`;
    iaShow(Math.min(iaT, iaAnim.duration));
  } catch { $("#iaEst").textContent = "One of the images could not be loaded. Reload the page and try again."; }
}
function iaShow(t) {
  if (!iaAnim) return;
  iaT = Math.max(0, Math.min(iaAnim.duration, t));
  const c = $("#iaCanvas"), frame = iaAnim.renderFrame(iaT, c.width, c.height);
  c.getContext("2d").drawImage(frame, 0, 0);
  $("#iaScrub").value = String(Math.round(iaT * 100));
  $("#iaTime").textContent = `${fmtClock(iaT)} / ${fmtClock(iaAnim.duration)} · ${iaAnim.labelAt(iaT)}`;
}
function iaStop() { iaPlaying = false; cancelAnimationFrame(iaRaf); const b = $("#iaPlay"); if (b) b.textContent = "Play"; }
function iaStep(now) {
  if (!iaPlaying) return;
  iaShow(iaT + Math.min(0.1, (now - iaLast) / 1000)); iaLast = now;
  if (iaT >= iaAnim.duration) { iaStop(); return; }
  iaRaf = requestAnimationFrame(iaStep);
}
$("#iaPlay").onclick = () => {
  if (!iaAnim) return;
  if (iaPlaying) { iaStop(); return; }
  if (iaT >= iaAnim.duration - 0.05) iaT = 0;
  iaPlaying = true; $("#iaPlay").textContent = "Pause"; iaLast = performance.now(); iaRaf = requestAnimationFrame(iaStep);
};
$("#iaScrub").oninput = e => { iaStop(); iaShow(Number(e.target.value) / 100); };
$("#iaFormat").onchange = () => { iaBuildKey = ""; buildIA(); };
$("#iaSeconds").onchange = () => { iaBuildKey = ""; buildIA(); };

$("#iaMake").onclick = async () => {
  if (!current) return;
  if ($("#renderForm").hidden) { toast("Rendering is not switched on yet."); return; }
  if (!iaSel.length) { toast("Tick the images to animate first."); return; }
  // views with a photoreal picture (made, or used as it is) but no line drawing yet: only the drawing is needed
  const needLines = iaSel.filter(fid => (iaRender(fid) || iaAsIs.has(fid)) && !iaLine(fid) && !iaLinePending.has(fid));
  const todo = iaSel.filter(fid => !iaAsIs.has(fid) && !iaPending.has(`img-${fid}`) && !iaRender(fid));
  if (!todo.length && needLines.length) {
    const asIs = needLines.filter(fid => iaAsIs.has(fid));
    needLines.filter(fid => !asIs.includes(fid)).forEach(fid => iaLineWanted.add(fid));
    for (const fid of asIs) {     // a picture used as it is: draw its lines from the uploaded file itself
      try { const f = await api.startRender(current.id, { prompt: LINE_PROMPT, view: "exterior", aspect: { "16:9": "landscape", "9:16": "portrait", "1:1": "square" }[$("#iaFormat").value],
          tier: chosenTier(), references: [{ file_id: fid, role: "base" }], anim_line: { index: Math.max(0, iaSel.indexOf(fid)), key: `img-${fid}` } }, newKey());
        void f; iaLinePending.add(fid); } catch (err) { toast(err.message); }
    }
    iaRequestLines(); drawIA(); toast("Making the line drawings. About a minute."); return;
  }
  const redo = todo.length ? todo : iaSel.filter(fid => !iaAsIs.has(fid));
  if (!redo.length) { toast("These images are used as they are."); return; }
  const look = $("#iaLook").value.trim();
  const aspect = { "16:9": "landscape", "9:16": "portrait", "1:1": "square" }[$("#iaFormat").value];
  const prompt = `${look ? look + ". " : ""}Photorealistic luxury architectural visualisation of this exact building at night: blue hour sky with stars, warm light glowing from every window, `
    + "subtle warm facade uplighting, refined landscaping, cinematic low-angle architectural photography. Keep the building's exact shape, floors, roof and window positions from the 3D image.";
  const btn = $("#iaMake"); btn.disabled = true;
  try {
    for (const fid of redo) {
      const looks = tickedLooks().filter(id => id !== fid).slice(0, 3).map(id => ({ file_id: id, role: "style" }));
      await api.startRender(current.id, { prompt, view: "exterior", time_of_day: "night", aspect, style: "luxury contemporary", tier: chosenTier(),
        quality: $("#rQuality").value, references: [{ file_id: fid, role: "model" }, ...looks], anim_hero: { index: Math.max(0, iaSel.indexOf(fid)), key: `img-${fid}` } }, newKey());
      iaPending.add(`img-${fid}`); iaLineWanted.add(fid);
    }
    toast(`Making ${redo.length} photoreal view${redo.length > 1 ? "s" : ""}. Each takes about a minute.`);
  } catch (err) { if (err.status === 401) return handle(err); toast(err.message); }
  finally { btn.disabled = false; drawIA(); loadOutputs(); }
};

$("#iaExport").onclick = async () => {
  if (!iaAnim || iaExporting) return;
  const { canExport, exportVideo } = await import("./export.js");
  if (!canExport()) { message($("#iaMsg"), "This browser cannot make videos. Use Chrome or Edge on a computer, or Safari 17 or newer."); return; }
  iaStop(); message($("#iaMsg"), "");
  const script = { version: 1, format: $("#iaFormat").value, title: $("#iaTitle2").value.trim() || current.name, subtitle: $("#iaSub").value.trim(),
    renders: false, captions: true, render_seconds: 4, look: $("#iaLook").value.trim().split(/\s+/).join(" ").slice(0, 400) };
  const ctl = new AbortController(); iaExporting = ctl;
  const btn = $("#iaExport"); btn.disabled = true; $("#iaProgress").hidden = false;
  const say = (f, text) => { $("#iaBar").style.width = `${Math.round(f * 100)}%`; $("#iaProgText").textContent = text; };
  try {
    const out = await exportVideo({ seq: iaAnim, script, stills: [], title: current.name, signal: ctl.signal, onProgress: (f, text) => say(f * 0.85, `Making the video: ${text.toLowerCase()}. Keep this tab open.`) });
    say(0.86, `Uploading ${(out.blob.size / 1048576).toFixed(1)} MB…`);
    await uploadAnimation(current.id, out.blob, { script, model_id: null, items: iaAnim.items.filter(i => i.render_id).map(i => ({ caption: i.caption.slice(0, 120), render_id: i.render_id })) },
      f => say(0.86 + f * 0.14, `Uploading… ${Math.round(f * 100)}%`));
    say(1, "Uploaded. Ollic is preparing it for phones; it appears below in a minute or two.");
    toast("Video uploaded. It will appear below when it is ready."); loadOutputs();
  } catch (err) {
    if (err.name === "AbortError") message($("#iaMsg"), "Export cancelled.", "ok");
    else if (err.status === 401) handle(err);
    else message($("#iaMsg"), err.message || "The video could not be made.");
  } finally { iaExporting = null; btn.disabled = false; setTimeout(() => { $("#iaProgress").hidden = true; }, 4000); iaShow(iaT); }
};
$("#iaCancel").onclick = () => iaExporting?.abort();
import("./imageanim.js").then(m => { IA = m; iaBuildKey = ""; if (current) buildIA(); }).catch(() => {});

/* ---------- cinematic clips (Premium): one AI video shot from the gold wireframe to the photoreal building ---------- */
const CLIP_PRICE = { "720p": [0.084, 0.126], "1080p": [0.112, 0.168] };   // US$ a second (silent, with sound), video service price list
const clipOpts = {};
const clipEngineSelects = [];
let clipEngines = {};
// US$ a second: [silent, with sound]
const ENGINE_PRICE = { vs: { "720p": [0.3034, 0.3034], "1080p": [0.682, 0.682] } };
function updateClipEngines(engines) {
  clipEngines = engines;
  for (const sel of clipEngineSelects) {
    const keep = sel.value;
    const usable = e => e.available && e.allowed !== false;
    sel.replaceChildren(...Object.entries(engines).map(([k, e]) => el("option", { value: k, ...(usable(e) ? {} : { disabled: "" }) },
      `${e.name}${e.soon ? " (coming soon)" : !e.available ? " (not connected yet)" : e.left === 0 ? " (your free clip is used)" : e.left ? ` (${e.left} free for you)` : e.allowed === false ? " (paid plans)" : ""}`)));
    sel.value = usable(engines[keep] || {}) ? keep : (Object.keys(engines).find(k => usable(engines[k])) || "motion");
    sel.dispatchEvent(new Event("change"));
  }
}
function clipControls(host, prefix) {
  const engine = el("select", { "aria-label": "Video option", class: "clip-engine" }, el("option", { value: "motion" }, "Ollic Motion"));
  clipEngineSelects.push(engine);
  const secs = el("select", { "aria-label": "Clip length" }, el("option", { value: "5" }, "5 s"), el("option", { value: "10", selected: "" }, "10 s"));
  const res = el("select", { "aria-label": "Clip quality" }, el("option", { value: "720p" }, "720p"), el("option", { value: "1080p" }, "1080p"));
  const audio = el("input", { type: "checkbox" });
  const est = el("span", { class: "hint" });
  const about = el("p", { class: "hint engine-note" });
  const update = () => {
    const table = ENGINE_PRICE[engine.value] || CLIP_PRICE;
    const p = table[res.value][audio.checked ? 1 : 0] * Number(secs.value);
    est.textContent = `About $${p.toFixed(2)} per clip, made in 2–6 minutes.`;
    const e = clipEngines[engine.value];
    about.textContent = e ? `${e.blurb} ${e.price}.` : "";
  };
  [engine, secs, res, audio].forEach(x => x.addEventListener("change", update)); update();
  clipOpts[prefix] = () => ({ engine: engine.value, seconds: Number(secs.value), resolution: res.value, audio: audio.checked });
  host.replaceChildren(
    el("div", {}, el("b", {}, "Cinematic clip "), el("span", { class: "chip premium" }, "Paid plans"),
      el("span", { class: "hint" }, " One continuous AI video shot: the gold wireframe turns into the real building while the camera moves. Press “Cinematic clip” on a ready view.")),
    el("label", { class: "check engine-pick" }, "Video option ", engine), about,
    el("div", { class: "row" }, el("label", { class: "check" }, "Length ", secs), el("label", { class: "check" }, "Quality ", res), el("label", { class: "check" }, audio, "Sound"), est));
}
clipControls($("#iaClipOpts"), "ia");

async function startClip(start, end, format, title, prefix, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await api.makeClip(current.id, { start, end, format, title: (title || "").slice(0, 80), ...clipOpts[prefix]() });
    toast(`Cinematic clip started (about $${Number(r.estimate_usd).toFixed(2)}). It takes 2–6 minutes and appears under the videos.`);
    loadOutputs();
  } catch (err) { if (err.status === 401) return handle(err); toast(err.message); }
  finally { if (btn) btn.disabled = false; }
}
/* ---------- start ---------- */
(async function start() {
  const c = window.OLLIC_CONFIG || {};
  if (!c.supabaseUrl || !c.supabaseAnonKey) { show("setupView"); return; }
  const link = session.takeSessionFromUrl();
  if (link?.error) { authMode("in"); message($("#authMsg"), link.error); show("authView"); return; }
  if (link?.type === "recovery") { authMode("newpw"); show("authView"); return; }
  if (location.hash === "#sign-up") { history.replaceState(null, "", location.pathname); if (!session.currentUser()) { authMode("up"); show("authView"); return; } }
  if (location.hash === "#sign-in") history.replaceState(null, "", location.pathname);
  if (await session.accessToken()) return enterApp();
  authMode("in"); show("authView");
})();
