import { api, uploadFile, uploadAnimation, readSchedule, ApiError, newKey } from "./api.js";
import * as session from "./session.js";

const $ = s => document.querySelector(s);
const views = ["setupView", "authView", "projectsView", "projectView"];
function show(id) { views.forEach(v => { $("#" + v).hidden = v !== id; }); }

let toastTimer;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000); }
function message(el, text, kind = "error") { el.textContent = text; el.className = `notice ${kind}`; el.hidden = !text; }

const fmtBytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const fmtDate = iso => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const TYPE = { png: "PNG", jpeg: "JPEG", pdf: "PDF", ifc: "IFC" };
const INPUT = { unknown: "No files yet", sketch: "Drawings", ifc: "IFC model" };
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
  resetModel(); resetWalk(); resetIA(); outputsLoadedOnce = false; seenDone = new Set();
  const q = new URLSearchParams(location.search), same = q.get("project") === id;
  service = same && SERVICES[q.get("service")] ? q.get("service") : null;
  step = service ? (q.get("step") === "start" && service !== "library" ? "start" : "work") : null;
  chosenIfc = same ? q.get("model") : null;
  applyView();
  try { current = await api.getProject(id); renderProject(); loadOutputs(); loadModels(); loadShots(); loadVideos(); applyView(); }
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
  fillPickers(); drawIA();
}

/* reference pickers: floor plan, shape to keep, look references */
function fillPickers() {
  const imgs = current.source_files.filter(f => f.detected_type === "png" || f.detected_type === "jpeg");
  const plans = current.source_files.filter(f => ["png", "jpeg", "pdf"].includes(f.detected_type));
  const keepSel = (sel, first, files) => {
    const keep = sel.value;
    sel.replaceChildren(el("option", { value: "" }, first), ...files.map(f => el("option", { value: f.id }, f.original_name)));
    sel.value = [...sel.options].some(o => o.value === keep) ? keep : "";
  };
  keepSel($("#rPlan"), "No plan", plans);
  keepSel($("#rBase"), "Nothing", imgs);
  const box = $("#rLooks"), ticked = new Set([...box.querySelectorAll("input:checked")].map(i => i.value));
  box.replaceChildren(...(imgs.length ? imgs.map(f => el("label", { class: "look" },
    el("input", { type: "checkbox", value: f.id, ...(ticked.has(f.id) ? { checked: "" } : {}), onchange: limitLooks }), el("span", {}, f.original_name)))
    : [el("span", { class: "hint" }, "Upload photos of facades you like and they appear here.")]));
  $("#readPlanBtn").disabled = !$("#rPlan").value;
}
function limitLooks(e) {
  const on = [...$("#rLooks").querySelectorAll("input:checked")];
  if (on.length > 3) { e.target.checked = false; toast("Use up to three look references."); }
}
$("#rPlan").onchange = () => { $("#readPlanBtn").disabled = !$("#rPlan").value; $("#planNote").textContent = ""; };
$("#readPlanBtn").onclick = async () => {
  const btn = $("#readPlanBtn"), id = $("#rPlan").value;
  if (!id) return;
  btn.disabled = true; btn.textContent = "Reading…";
  try {
    const r = await api.readPlan(current.id, id);
    const box = $("#rPrompt");
    box.value = box.value.trim() ? `${box.value.trim()}\n\n${r.summary}` : r.summary;
    if (r.reading.storeys && !$("#rStoreys").value) $("#rStoreys").value = r.reading.storeys;
    $("#planNote").textContent = `Read by AI from “${r.reading.drawing_title || "your plan"}”. Check and edit it before you render.`;
  } catch (err) { if (err.status === 401) return handle(err); toast(err.message); }
  finally { btn.disabled = false; btn.textContent = "Read my plan"; }
};
$("#backBtn").onclick = () => { stopPolling(); listProjects(); };

/* ---------- services: pick one, give it a file, then only its screen is shown ---------- */
const IMG = ["png", "jpeg"];
const SERVICES = {
  render: { name: "Photoreal render", short: "Photoreal render", accept: [...IMG, "pdf"], multi: 4, optional: true, needs: "a picture or a PDF drawing",
    lead: "Turn a sketch, photo, 3D view or PDF drawing into a photoreal image, or just describe the building.",
    hint: "Tick the pictures to use. The first keeps its shape and camera; the others give the look and materials. A PDF is used as the floor plan.",
    sections: ["studio"], icon: "M4 20 10 4h4l6 16M7 13h10" },
  plan: { name: "Floor plan to 3D", short: "Floor plan to 3D", accept: [...IMG, "pdf"], multi: 1, needs: "a floor plan (PDF or picture)",
    lead: "Upload a floor plan. Ollic reads the rooms and makes photoreal 3D views of the building that follow the layout.",
    hint: "Choose the floor plan.", sections: ["studio"], icon: "M3 3h18v18H3zM3 12h8V3M11 12v9M15 12h6" },
  model: { name: "Render your Revit model", short: "Revit model", accept: ["ifc"], multi: 1, needs: "an IFC model (Revit: File > Export > IFC)",
    lead: "Upload your Revit model as IFC. See it in 3D inside and out, then turn any view into a photoreal render of your exact building.",
    hint: "Choose the IFC model.", sections: ["modelSection", "studio"], modes: ["exterior", "interior"], icon: "M12 2 3 7v10l9 5 9-5V7zM3 7l9 5 9-5M12 12v10" },
  walk: { name: "Walkthrough video", short: "Walkthrough", accept: ["ifc"], multi: 1, needs: "an IFC model",
    lead: "Walk through your IFC model room by room, save the shots, render them all with one look, and make an MP4 walkthrough.",
    hint: "Choose the IFC model.", sections: ["modelSection", "studio", "walkSection"], modes: ["walk", "exterior"], icon: "M13 4a2 2 0 1 0 0 .1M10 22l2-7 3 3v4M8 11l3-3 4 2 3 3M12 15l-3-4" },
  build: { name: "Construction animation", short: "Construction", accept: ["ifc"], multi: 1, needs: "an IFC model",
    lead: "Your IFC model builds itself on video: gold setting-out, a wireframe rising floor by floor, then a light sweep to the photoreal building. It can follow your construction programme, and make AI cinematic clips.",
    hint: "Choose the IFC model.", sections: ["modelSection"], modes: ["build"], icon: "M3 21h18M5 21V10l7-5 7 5v11M9 21v-6h6v6" },
  imageanim: { name: "Animation from a 3D image", short: "3D image animation", accept: IMG, multi: 3, needs: "a 3D image (PNG or JPEG)",
    lead: "No model file? Upload a 3D image of the building (a Revit, SketchUp or Lumion view, or a render). Gold lines rise from the ground, then a light sweep reveals the photoreal building.",
    hint: "Tick up to three images, in order. Each becomes one shot of the video.", sections: ["imgAnimSection"], icon: "M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4" },
  library: { name: "Library", short: "Library", sections: ["libSection"], icon: "M4 4h6v16H4zM14 4h6v16h-6z" },
};
const SVC_ORDER = ["render", "plan", "model", "walk", "build", "imageanim"];
const WORK = ["modelSection", "imgAnimSection", "studio", "walkSection", "libSection"];
const MODE_BTN = { exterior: "#viewOutside", interior: "#viewInside", walk: "#viewWalk", build: "#viewBuild" };
const EXT = { png: ".png", jpeg: ".jpg,.jpeg", pdf: ".pdf", ifc: ".ifc" };
let service = null, step = null, chosenIfc = null, lastJobs = [], modelsNow = [], svcPicked = [];
function svcIcon(d) {   // SVG needs its own namespace, so it is built from markup
  const t = document.createElement("template");
  t.innerHTML = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  return t.content.firstChild;
}

function goTo(svc, st) {
  if (svc !== service && service) leaveBuild();
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
  // the 3D view offers only this service's views and buttons
  Object.entries(MODE_BTN).forEach(([m, sel]) => { $(sel).hidden = !(svc?.modes || []).includes(m) || (svc?.modes || []).length < 2; });
  $("#useView").hidden = !["model", "walk"].includes(service);
  $("#saveShot").hidden = service !== "walk";
  // the AI version choice sits in the screen that makes the pictures
  const slot = service === "build" ? "#tierSlotBuild" : service === "imageanim" ? "#tierSlotIA" : "#tierHome";
  if ($("#tierPick").parentElement !== $(slot)) $(slot).append($("#tierPick"));
  // renders: in the studio, or in the Library
  const gHome = service === "library" ? $("#libGallery") : $("#studio");
  if ($("#gallery").parentElement !== gHome) gHome.append($("#gallery"), $("#galleryEmpty"));
  if (step === "start") drawStart();
  if (step === "work" && svc?.modes && viewer && !modelLoading && viewerModelId) setViewMode(svc.modes[0]);
  if (step === "work" && !svc?.modes) leaveBuild();
}

/* step 1: upload a file for this service, or pick one already in the project */
function svcFiles() {
  const svc = SERVICES[service];
  return (current?.source_files || []).filter(f => svc.accept.includes(f.detected_type) && !/^(Photoreal view|Cinematic start view) \d/.test(f.original_name));
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
  const model = id => modelsNow.find(m => m.source_file_id === id);
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
    const note = f.detected_type === "ifc" ? (model(f.id) ? "3D model ready" : "not read into 3D yet") : (TYPE[f.detected_type] || f.detected_type);
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
    const f = files[0];
    chosenIfc = f ? f.id : null;
    viewerModelId = viewerModelId && modelsNow.find(m => m.id === viewerModelId)?.source_file_id === chosenIfc ? viewerModelId : null;
    if (!viewerModelId && viewer) resetModel();
    const busy = lastJobs.some(j => j.type === "ifc_import" && ["queued", "running"].includes(j.status) && (j.input || {}).source_file_id === chosenIfc);
    if (f && !modelsNow.some(m => m.source_file_id === f.id) && !busy) startImport(f);
    goTo(service, "work"); loadModels(); return;
  }
  if (service === "imageanim") { iaSel = files.map(f => f.id).slice(0, 3); goTo(service, "work"); drawIA(); return; }
  // renders: a PDF is the floor plan; the first picture keeps its shape (or is the plan); the rest give the look
  fillPickers();
  const pdf = files.find(f => f.detected_type === "pdf"), pics = files.filter(f => f.detected_type !== "pdf");
  $("#rLooks").querySelectorAll("input").forEach(i => { i.checked = false; });
  if (service === "plan") { $("#rPlan").value = (pdf || pics[0])?.id || ""; $("#rBase").value = ""; }
  else {
    $("#rPlan").value = pdf?.id || "";
    $("#rBase").value = pics[0]?.id || "";
    pics.slice(1, 4).forEach(f => { const i = $(`#rLooks input[value="${f.id}"]`); if (i) i.checked = true; });
  }
  $("#readPlanBtn").disabled = !$("#rPlan").value; $("#planNote").textContent = service === "plan" && $("#rPlan").value ? "Press “Read my plan” so the AI writes the rooms into the description, then check it." : "";
  goTo(service, "work");
  $("#rPrompt").focus({ preventScroll: true });
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
    current = await api.getProject(current.id); renderProject(); loadModels(); loadShots(); loadOutputs();
  });
  if (f.detected_type === "ifc" && f.origin !== "generated")
    return [el("button", { class: "btn", type: "button", onclick: e => startImport(f, e.currentTarget) }, "Import 3D"), del];
  return [del];
}
async function startImport(f, btn) {
  if (btn) btn.disabled = true;
  try { await api.importIfc(current.id, f.id, newKey()); toast("Reading the IFC model. This takes a few seconds to a minute."); loadOutputs(); }
  catch (err) { if (err.status === 401) return handle(err); toast(err.message); }
  finally { if (btn) btn.disabled = false; }
}

/* ---------- 3D models (Phase 3) ---------- */
let viewer = null, viewerModelId = null, walkRoom = 0, modelLoading = null;   // modelLoading: the model being downloaded into the viewer
function resetModel() {
  leaveBuild();
  $("#walkPanel").hidden = true; walkRoom = 0;
  $("#viewerWrap").hidden = true; $("#modelEmpty").hidden = true; $("#modelJobs").replaceChildren();
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
  // the IFC chosen in this service's first step; while it is still being read, nothing else is shown
  const m = chosenIfc ? models.find(x => x.source_file_id === chosenIfc) : models[0];
  if (!m && viewerModelId) resetModel();
  $("#viewerWrap").hidden = !m;
  $("#modelEmpty").hidden = !!m;
  if (!m || m.id === viewerModelId) return;
  leaveBuild(); if (viewer) setViewMode("exterior");
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
  if (mode !== "build") leaveBuild();
  if (mode === "build") {
    if (modelLoading) { toast("The 3D model is still loading. Try again in a moment."); modelLoading.then(() => {}, () => {}); return; }
    if (!enterBuild()) return;
  } else if (mode === "walk") {
    if (!viewer.rooms().length) { toast("This model has no rooms to walk into. In Revit's IFC export settings, include rooms (spaces) and export again."); return; }
    if (viewer.mode !== "walk") viewer.walkTo(walkRoom);
    drawRooms();
    $("#viewer canvas")?.focus({ preventScroll: true });
  } else viewer.setMode(mode);
  $("#viewOutside").setAttribute("aria-pressed", String(mode === "exterior"));
  $("#viewInside").setAttribute("aria-pressed", String(mode === "interior"));
  $("#viewWalk").setAttribute("aria-pressed", String(mode === "walk"));
  $("#viewBuild").setAttribute("aria-pressed", String(mode === "build"));
  $("#walkPanel").hidden = mode !== "walk";
  $("#animPanel").hidden = mode !== "build";
  ["#viewReset", "#useView", "#saveShot", "#storeyPick"].forEach(sel => { const b = $(sel); if (b) b.classList.toggle("is-off", mode === "build"); });
}
$("#viewOutside").onclick = () => setViewMode("exterior");
$("#viewInside").onclick = () => setViewMode("interior");
$("#viewWalk").onclick = () => setViewMode("walk");
$("#viewBuild").onclick = () => setViewMode("build");

/* walking through the rooms */
function drawRooms() {
  const rs = viewer?.rooms() || [], floors = new Set(rs.map(r => r.storey)).size;
  $("#roomList").replaceChildren(...rs.map(r => el("button", { type: "button", class: "chip room", "aria-pressed": String(r.index === walkRoom),
    onclick: () => { walkRoom = r.index; viewer.walkTo(r.index); drawRooms(); } }, floors > 1 && r.storey ? `${r.name} · ${r.storey}` : r.name)));
}
document.querySelectorAll("[data-hold]").forEach(b => {
  const [f, t] = b.dataset.hold.split(",").map(Number);
  const stop = () => viewer?.hold(0, 0);
  b.addEventListener("pointerdown", e => { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch { /* not a real pointer */ } viewer?.hold(f, t); });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach(ev => b.addEventListener(ev, stop));
  b.addEventListener("contextmenu", e => e.preventDefault());
});

async function snapshotFile(name) {
  const blob = await (await fetch(viewer.snapshot())).blob();
  return uploadFile(current.id, new File([blob], name, { type: "image/png" }), () => {});
}

/* "Save shot": a picture of this view plus the camera position, for the walkthrough */
$("#saveShot").onclick = async () => {
  if (!viewer) return;
  const btn = $("#saveShot"); btn.disabled = true;
  try {
    const walking = viewer.mode === "walk", room = walking ? viewer.room : null;
    const base = room || (viewer.mode === "interior" ? "Inside view" : "Outside view");
    const same = shots.filter(s => s.name === base || s.name.startsWith(base + " ")).length;
    const name = same ? `${base} ${same + 1}` : base;
    const saved = await snapshotFile(`Shot - ${name}.png`);
    await api.saveShot(current.id, { source_file_id: saved.id, name, room, pose: viewer.pose(), model_id: viewerModelId });
    current = await api.getProject(current.id); renderProject();
    await loadShots();
    toast(`Shot “${name}” saved. Find it under Walkthrough.`);
  } catch (err) { if (err.status === 401) return handle(err); toast(err.message); }
  finally { btn.disabled = false; }
};
$("#viewReset").onclick = () => viewer?.reset();
$("#storeySelect").onchange = e => { viewer?.setStorey(e.target.value); if (e.target.value) setViewMode("interior"); };

const TYPE_NAME = { IfcWall: "Wall", IfcWallStandardCase: "Wall", IfcSlab: "Floor slab", IfcRoof: "Roof", IfcDoor: "Door", IfcWindow: "Window", IfcSpace: "Room", IfcColumn: "Column", IfcBeam: "Beam", IfcStair: "Stair", IfcCovering: "Covering", IfcRailing: "Railing" };
function showElement(x) {
  const card = $("#elementCard");
  if (!x) { card.replaceChildren(el("h3", {}, "Element"), el("p", { class: "muted" }, "Tap any part of the building to see what it is.")); return; }
  card.replaceChildren(el("h3", {}, TYPE_NAME[x.ifcType] || x.ifcType || "Element"),
    el("dl", { class: "kv" }, el("dt", {}, "Name"), el("dd", {}, x.name || "—"), el("dt", {}, "Floor"), el("dd", {}, x.storey || "—"),
      el("dt", {}, "IFC type"), el("dd", { class: "mono" }, x.ifcType || "—"), el("dt", {}, "GlobalId"), el("dd", { class: "mono" }, x.globalId || "—")));
}

function drawReport(m) {
  const r = m.report || {};
  const verdict = { pass: "Model checked: ready to use", warn: "Model checked: usable, with notes", fail: "Model has problems" }[r.status] || "Model report";
  $("#reportCard").replaceChildren(el("h3", {}, verdict),
    el("ul", { class: "checks" }, ...(r.checks || []).map(c => el("li", { class: c.status }, c.message))));
}

/* "Render this view": a picture of the 3D model becomes the shape the render keeps */
$("#useView").onclick = async () => {
  if (!viewer) return;
  const btn = $("#useView"); btn.disabled = true;
  try {
    const stamp = new Date().toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).replace(/[/:]/g, "-");
    const saved = await snapshotFile(`3D view ${stamp}.png`);
    current = await api.getProject(current.id); renderProject();
    $("#rBase").value = saved.id;
    toast("View saved. Describe the materials and press Create concept.");
    $("#studio").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  } catch (err) { if (err.status === 401) return handle(err); toast(err.message); }
  finally { btn.disabled = false; }
};

/* ---------- concept renders (Phase 2) ---------- */
const JOB_NAME = { concept_render: "New concept", concept_edit: "Revision", ifc_import: "Reading IFC model", video_export: "Walkthrough video", animation_export: "Construction video", cinematic_clip: "Cinematic clip" };
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
  const MODEL_JOBS = ["ifc_import"], VIDEO_JOBS = ["video_export", "animation_export", "cinematic_clip"];
  drawJobs(out.jobs.filter(j => !MODEL_JOBS.includes(j.type) && !VIDEO_JOBS.includes(j.type)), "#jobList");
  drawJobs(out.jobs.filter(j => MODEL_JOBS.includes(j.type)), "#modelJobs");
  drawJobs(out.jobs.filter(j => j.type === "video_export"), "#walkJobs");
  drawJobs(out.jobs.filter(j => j.type === "animation_export" || j.type === "cinematic_clip"), "#animJobs");
  drawJobs(out.jobs.filter(j => j.type === "animation_export" || j.type === "cinematic_clip"), "#iaJobs");
  drawGallery(out.images);
  images = out.images; drawWalk(); if (seq) refreshHeroes(); drawIA();
  const vids = out.jobs.filter(j => VIDEO_JOBS.includes(j.type) && j.status === "succeeded" && !seenDone.has(j.id));
  vids.forEach(j => seenDone.add(j.id));
  if (vids.length && outputsLoadedOnce) { loadVideos(); toast(vids.some(j => j.type === "cinematic_clip") ? "Your cinematic clip is ready." : vids.some(j => j.type === "animation_export") ? "Your construction video is ready." : "Your walkthrough video is ready."); }
  const done = out.jobs.filter(j => MODEL_JOBS.includes(j.type) && j.status === "succeeded" && !seenDone.has(j.id));
  done.forEach(j => seenDone.add(j.id));
  if (done.length && outputsLoadedOnce) { loadModels(); current = await api.getProject(current.id).catch(() => current); renderProject(); }
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
    const tags = [o.shot_name ? `Shot: ${o.shot_name}` : null, o.view, LIGHT_NAME[o.time_of_day], i.tier === "premium" && o.quality === "high" ? "High detail" : null].filter(Boolean);
    const input = el("input", { type: "text", maxlength: "1000", placeholder: "What should change? e.g. make the roof dark grey", "aria-label": "Describe a change" });
    const go = el("button", { class: "btn primary", type: "submit" }, "Revise");
    const parent = i.parent_image_id ? byId[i.parent_image_id] : null;
    return el("article", { class: "shot" },
      el("div", { class: "frame", style: `aspect-ratio:${w}/${h}` },
        i.url ? el("img", { src: i.url, alt: `AI concept render: ${i.prompt}`, loading: "lazy", width: String(w), height: String(h) }) : el("span", { class: "muted" }, "Image link unavailable"),
        el("span", { class: "badge" }, i.label)),
      el("div", { class: "body" },
        el("p", { class: "prompt" }, i.parent_image_id ? `Revision: ${i.prompt}` : i.prompt),
        el("div", { class: "tags" }, el("span", { class: `chip ${i.tier === "premium" ? "premium" : ""}` }, i.tier_name || "Render"), ...tags.map(t => el("span", { class: "chip" }, t)), parent ? el("span", { class: "chip" }, "Revised") : ""),
        el("p", { class: "hint" }, fmtDate(i.created_at)),
        el("div", { class: "actions" }, i.download_url ? el("a", { class: "btn", href: i.download_url, download: "" }, "Download") : "",
          deleteButton("this render", async () => { await api.deleteRender(i.id); toast("Render deleted."); loadOutputs(); loadShots(); }, false)),
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
    const note = t.soon ? "Coming soon" : !t.available ? "Not connected yet" : !t.allowed ? "Paid plans only" : t.price;
    const input = el("input", { type: "radio", name: "tier", value: k, ...(on ? {} : { disabled: "" }), ...(on && was === k ? { checked: "" } : {}) });
    input.addEventListener("change", tierChanged);
    return el("label", { class: `tier premium-tag${on ? "" : " off"}` }, input, el("span", {}, el("b", {}, t.name), el("small", {}, `${t.blurb} · ${note}`)));
  }));
  if (!$("#tierPick input[name=tier]:checked")) stdInput.checked = true;
  tierChanged();
  updateClipEngines(out.video_engines || {});
}
function chosenTier() { return $("#tierPick input[name=tier]:checked")?.value || "standard"; }
function tierChanged() {
  const t = chosenTier(), info = tierInfo?.[t] || {};
  $("#qualityField").hidden = t !== "premium";  // the free model has one detail level
  $("#renderLimit").textContent = info.daily_limit ? `${info.name}: up to ${info.daily_limit} a day, reset at 01:00 Lagos time. Failed ones do not count.` : "";
}
document.querySelectorAll("#tierPick input").forEach(i => i.addEventListener("change", tierChanged));

function briefFromForm() {
  const body = { prompt: $("#rPrompt").value.trim(), view: $("#rView").value, time_of_day: $("#rLight").value, aspect: $("#rAspect").value,
    quality: $("#rQuality").value, materials: $("#rMaterials").value.trim(), landscaping: $("#rLand").value.trim(), tier: chosenTier() };
  const refs = [];
  if ($("#rPlan").value) refs.push({ file_id: $("#rPlan").value, role: "plan" });
  const base = $("#rBase").value;
  if (base) { const f = current.source_files.find(x => x.id === base); refs.push({ file_id: base, role: /^3D view/i.test(f?.original_name || "") ? "model" : "base" }); }
  $("#rLooks").querySelectorAll("input:checked").forEach(i => { if (i.value !== base && i.value !== $("#rPlan").value) refs.push({ file_id: i.value, role: "style" }); });
  body.references = refs;
  body.view = $("#rView").value; body.style = $("#rStyle").value; body.ground_floor = $("#rGround").value;
  const floors = parseInt($("#rStoreys").value, 10);
  if (floors >= 1 && floors <= 60) body.storeys = floors;
  return body;
}
function tickedLooks() { return [...$("#rLooks").querySelectorAll("input:checked")].map(i => i.value); }

$("#renderForm").onsubmit = e => {
  e.preventDefault();
  const body = briefFromForm();
  if (body.prompt.length < 3) { message($("#renderMsg"), "Describe what you want to see."); return; }
  const key = newKey();
  busy(e.target, async () => {
    message($("#renderMsg"), "");
    try { await api.startRender(current.id, body, key); toast("Concept started. It takes about a minute."); loadOutputs(); }
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
      if (saved?.detected_type === "ifc") startImport(saved);
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

/* ---------- walkthrough: shots, render all shots, video ---------- */
let shots = [], images = [], videos = [], untickedShots = new Set(), stripKey = "", picksKey = "";
function resetWalk() {
  shots = []; images = []; videos = []; untickedShots = new Set(); stripKey = picksKey = "";
  $("#shotStrip").replaceChildren(); $("#videoPicks").replaceChildren(); $("#videoList").replaceChildren(); $("#walkJobs").replaceChildren();
  $("#shotsEmpty").hidden = false; $("#shotGo").hidden = true; $("#videoForm").hidden = true; message($("#videoMsg"), "");
}
async function loadShots() {
  if (!current) return;
  const pid = current.id;
  try { const s = await api.shots(pid); if (current?.id !== pid) return; shots = s; drawWalk(); }
  catch (err) { if (err.status === 401) return handle(err); }
}
async function loadVideos() {
  if (!current) return;
  const pid = current.id;
  try { const v = await api.videos(pid); if (current?.id !== pid) return; videos = v; drawVideos(); }
  catch (err) { if (err.status === 401) return handle(err); }
}
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
function shotRenders(id) { return images.filter(i => (i.options || {}).shot_id === id); }   // newest first

function drawWalk() {
  $("#shotsEmpty").hidden = shots.length > 0;
  $("#shotGo").hidden = shots.length === 0;
  const key = JSON.stringify(shots.map(s => [s.id, s.name, s.picture_url && s.picture_url.split("?")[0], shotRenders(s.id)[0]?.id]));
  if (key !== stripKey) { stripKey = key; drawStrip(); }
  const withRenders = shots.filter(s => shotRenders(s.id).length);
  $("#videoForm").hidden = withRenders.length === 0;
  const pkey = JSON.stringify(withRenders.map(s => [s.id, shotRenders(s.id).map(i => i.id)]));
  if (pkey !== picksKey) { picksKey = pkey; drawPicks(withRenders); }
  if (!$("#vTitle").value && current) $("#vTitle").placeholder = current.name;
}

function drawStrip() {
  $("#shotStrip").replaceChildren(...shots.map((s, i) => {
    const latest = shotRenders(s.id)[0];
    const name = el("input", { type: "text", value: s.name, maxlength: "80", "aria-label": "Shot name" });
    name.addEventListener("change", async () => {
      const v = name.value.trim(); if (!v) { name.value = s.name; return; }
      try { const r = await api.editShot(s.id, { name: v }); s.name = r.name; name.value = r.name; drawWalk(); } catch (err) { if (err.status === 401) return handle(err); toast(err.message); }
    });
    const tick = el("input", { type: "checkbox", "aria-label": `Render ${s.name}`, ...(untickedShots.has(s.id) ? {} : { checked: "" }) });
    tick.onchange = () => { if (tick.checked) untickedShots.delete(s.id); else untickedShots.add(s.id); };
    const src = latest?.url || s.picture_url;
    return el("li", { class: "shot-card" },
      el("div", { class: "thumb" }, src ? el("img", { src, alt: latest ? `Render of ${s.name}` : `3D view of ${s.name}`, loading: "lazy" }) : "",
        el("span", { class: "badge" }, latest ? "Rendered" : "3D view")),
      el("div", { class: "shot-body" },
        el("label", { class: "tick" }, tick, el("span", { class: "num" }, String(i + 1))), name,
        el("div", { class: "shot-tools" },
          el("button", { class: "btn", type: "button", title: "Show this view in the 3D model", onclick: () => goToShot(s) }, "View"),
          el("button", { class: "btn", type: "button", "aria-label": `Move ${s.name} earlier`, ...(i === 0 ? { disabled: "" } : {}), onclick: () => moveShot(i, -1) }, "↑"),
          el("button", { class: "btn", type: "button", "aria-label": `Move ${s.name} later`, ...(i === shots.length - 1 ? { disabled: "" } : {}), onclick: () => moveShot(i, 1) }, "↓"),
          el("button", { class: "btn danger", type: "button", "aria-label": `Delete ${s.name}`, onclick: () => removeShot(s) }, "Delete"))));
  }));
}

function goToShot(s) {
  if (!viewer) { toast("Open the 3D model to see this view."); return; }
  viewer.goTo(s.pose, s.room);
  setViewMode(s.pose.mode === "walk" ? "walk" : "exterior");
  $("#viewer").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" });
}
async function moveShot(i, d) {
  const order = shots.slice(); [order[i], order[i + d]] = [order[i + d], order[i]];
  try {
    await Promise.all(order.map((s, k) => s.position !== k ? api.editShot(s.id, { position: k }) : null));
    await loadShots();
  } catch (err) { if (err.status === 401) return handle(err); toast(err.message); }
}
async function removeShot(s) {
  try { await api.deleteShot(s.id); untickedShots.delete(s.id); toast(`Shot “${s.name}” deleted. Its renders stay in the gallery.`); await loadShots(); }
  catch (err) { if (err.status === 401) return handle(err); toast(err.message); }
}

$("#renderAllBtn").onclick = async () => {
  const ids = shots.filter(s => !untickedShots.has(s.id)).map(s => s.id);
  if (!ids.length) { toast("Tick at least one shot to render."); return; }
  if ($("#renderForm").hidden) { toast("Concept renders are not switched on yet."); return; }
  const brief = briefFromForm();
  delete brief.references;
  if (brief.prompt.length < 3) {
    message($("#renderMsg"), "Describe the look you want here first (materials, finishes, furniture style), then press Render all shots again.");
    $("#rPrompt").focus(); $("#studio").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" }); return;
  }
  const btn = $("#renderAllBtn"); btn.disabled = true;
  try {
    const r = await api.renderShots(current.id, { shot_ids: ids, brief, look_file_ids: tickedLooks() });
    toast(`Rendering ${r.jobs.length} shot${r.jobs.length === 1 ? "" : "s"}. Each takes about a minute.`);
    loadOutputs();
  } catch (err) { if (err.status === 401) return handle(err); toast(err.message); }
  finally { btn.disabled = false; }
};

function drawPicks(withRenders) {
  $("#videoPicks").replaceChildren(...withRenders.map(s => {
    const rs = shotRenders(s.id);
    const use = el("input", { type: "checkbox", checked: "", "aria-label": `Use ${s.name} in the video` });
    const pick = el("select", { "aria-label": `Render to use for ${s.name}` }, ...rs.map((r, k) => el("option", { value: r.id }, `${k === 0 ? "Newest" : `Earlier ${k}`} · ${r.tier_name || "Render"} · ${fmtDate(r.created_at)}`)));
    const cap = el("input", { type: "text", value: s.name, maxlength: "80", "aria-label": `Title for ${s.name}` });
    const thumb = el("img", { src: rs[0].url || "", alt: "", loading: "lazy" });
    pick.onchange = () => { thumb.src = rs.find(r => r.id === pick.value)?.url || ""; };
    return el("li", { class: "pick", "data-shot": s.id }, use, thumb, el("div", { class: "pick-body" }, cap, pick));
  }));
}

$("#videoForm").onsubmit = e => {
  e.preventDefault();
  const rows = [...$("#videoPicks").querySelectorAll("li.pick")].filter(li => li.querySelector("input[type=checkbox]").checked);
  if (!rows.length) { message($("#videoMsg"), "Tick at least one rendered shot."); return; }
  const body = { render_ids: rows.map(li => li.querySelector("select").value), captions: rows.map(li => li.querySelector("input[type=text]").value.trim()),
    format: $("#vFormat").value, seconds: Math.max(2.5, Math.min(12, parseFloat($("#vSeconds").value) || 5)),
    title: $("#vTitle").value.trim(), subtitle: $("#vSubtitle").value.trim() };
  busy(e.target, async () => {
    message($("#videoMsg"), "");
    try { await api.makeVideo(current.id, body); toast("Making your video. This takes a few minutes."); loadOutputs(); }
    catch (err) { if (err.status === 401) return handle(err); message($("#videoMsg"), err.message); }
  });
};

function drawVideos() {
  const card = v => {
    const ratio = `${v.width}/${v.height}`;
    return el("article", { class: "video-card" },
      el("div", { class: "frame", style: `aspect-ratio:${ratio}` },
        v.url ? el("video", { src: v.url, controls: "", preload: "metadata", playsinline: "", "aria-label": `Walkthrough video: ${v.title || "untitled"}` }) : el("span", { class: "muted" }, "Video link unavailable")),
      el("div", { class: "body" },
        el("h3", {}, v.title || (v.kind === "cinematic" ? "Cinematic clip" : v.kind === "construction" ? "Construction sequence" : "Walkthrough")),
        el("div", { class: "tags" }, el("span", { class: "chip" }, v.format), el("span", { class: "chip" }, `${Math.round(v.duration_s)} s`), el("span", { class: "chip" }, v.kind === "cinematic" ? "AI video" : v.kind === "construction" ? "Construction" : `${(v.items || []).length} shot${(v.items || []).length === 1 ? "" : "s"}`), el("span", { class: "chip" }, v.label)),
        el("p", { class: "hint" }, fmtDate(v.created_at)),
        el("div", { class: "actions" }, v.download_url ? el("a", { class: "btn primary", href: v.download_url, download: "" }, "Download MP4") : "",
          deleteButton("this video", async () => { await api.deleteVideo(v.id); toast("Video deleted."); loadVideos(); }, false))));
  };
  $("#videoList").replaceChildren(...videos.filter(v => v.kind !== "construction").map(card));
  $("#animVideos").replaceChildren(...videos.filter(v => v.kind === "construction" || v.kind === "cinematic").map(card));
  $("#iaVideos").replaceChildren(...videos.filter(v => v.kind === "construction" || v.kind === "cinematic").map(card));
  $("#libVideos").replaceChildren(...videos.map(card));
  $("#libVideosEmpty").hidden = videos.length > 0;
}

/* ---------- construction animation ---------- */
const PHASE_UI = { site: "Site", foundation: "Foundation", structure: "Structure (per floor)", walls: "Walls (per floor)", openings: "Doors and windows",
  roof: "Roof", orbit: "Fly-around", furnish: "Furniture", interior: "Rooms (per room)" };
const HIDE_UI = { furniture: "Furniture", stairs: "Stairs", beams: "Beams", columns: "Columns", footings: "Footings", doors: "Doors", windows: "Windows", railings: "Railings" };
let C = null, LUX = null, heroImgs = [], heroPending = new Set(), seq = null, animScript = null, animT = 0, animPlaying = false, animRaf = 0, lastTick = 0, exporting = null;
const fmtClock = x => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, "0")}`;
const scriptKey = () => `ollic-anim-${current?.id}`;
function saveScript() { try { localStorage.setItem(scriptKey(), JSON.stringify(animScript)); } catch { /* private mode: settings last until the page closes */ } }
function loadScript() { try { const s = JSON.parse(localStorage.getItem(scriptKey()) || "null"); return s; } catch { return null; } }

function enterBuild() {
  if (!viewer || !C) { if (!C) toast("The animation is still loading. Try again in a moment."); return false; }
  if (seq) return true;
  viewer.takeOver(true);
  animScript = C.normalise(loadScript() || { ...C.defaultScript(), title: current?.name || "" });
  frameViewer(); buildSeq(); drawAnimSettings();
  return true;
}
function leaveBuild() {
  if (!seq) return;
  if (exporting) exporting.abort();
  stopAnim(); seq.dispose(); seq = null;
  $("#viewer").classList.remove("framed"); $("#viewer").style.removeProperty("--ar");
  viewer?.takeOver(false);
  $("#animPanel").hidden = true;
}
function frameViewer() {
  const [w, h] = { "16:9": [16, 9], "9:16": [9, 16], "1:1": [1, 1] }[animScript.format] || [16, 9];
  const v = $("#viewer"); v.classList.add("framed"); v.style.setProperty("--ar", `${w} / ${h}`); v.style.setProperty("--arw", String(w / h));
}
function previewSize() { const e = viewer.engine(); e.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)); e.resize(); }
function buildSeq() {
  if (seq) seq.dispose();
  previewSize();
  seq = C.createConstruction(viewer.engine(), animScript, { lux: LUX, heroImages: heroImgs });
  animScript = seq.script;
  refreshHeroes();
  animT = Math.min(animT, seq.duration);
  $("#animScrub").max = String(Math.round(seq.duration * 100));
  $("#animChapters").replaceChildren(...seq.segments.filter((s, i, a) => i === 0 || s.phase !== a[i - 1].phase).map(s =>
    el("button", { type: "button", class: "chip room", onclick: () => { stopAnim(); showAt(s.start + 0.01); } }, C.PHASE_LABEL[s.phase] || s.label)));
  const stills = script => script.renders ? animStills().length : 0;
  const total = 6 + seq.duration + stills(animScript) * animScript.render_seconds;
  $("#animEst").textContent = `${fmtClock(total)} video, ${animScript.format}. Made on this device, then saved to your project.`;
  showAt(animT);
}
function showAt(t) {
  if (!seq) return;
  animT = Math.max(0, Math.min(seq.duration, t));
  seq.frameAt(animT); seq.draw();
  $("#animScrub").value = String(Math.round(animT * 100));
  $("#animTime").textContent = `${fmtClock(animT)} / ${fmtClock(seq.duration)} · ${seq.labelAt(animT)}`;
}
function stopAnim() { animPlaying = false; cancelAnimationFrame(animRaf); $("#animPlay").textContent = "Play"; }
function stepAnim(now) {
  if (!animPlaying) return;
  const dt = Math.min(0.1, (now - lastTick) / 1000); lastTick = now;
  showAt(animT + dt);
  if (animT >= seq.duration) { stopAnim(); return; }
  animRaf = requestAnimationFrame(stepAnim);
}
$("#animPlay").onclick = () => {
  if (!seq) return;
  if (animPlaying) { stopAnim(); return; }
  if (animT >= seq.duration - 0.05) animT = 0;
  animPlaying = true; $("#animPlay").textContent = "Pause"; lastTick = performance.now();
  animRaf = requestAnimationFrame(stepAnim);
};
$("#animScrub").oninput = e => { stopAnim(); showAt(Number(e.target.value) / 100); };

/* the contractor's programme: build in its order, on its dates */
const PROG_GROUPS = [["site", "Site works"], ["foundation", "Foundation"], ["structure", "Structure"], ["walls", "Walls and facade"], ["openings", "Doors and windows"],
  ["roof", "Roof"], ["mep", "MEP services"], ["finishes", "Finishes"], ["furnish", "Furniture and fittings"], ["none", "Not shown"]];
const PROG_KINDS = [["", "all"], ["columns", "columns"], ["beams", "beams"], ["slabs", "slabs"], ["stairs", "stairs"]];
const fmtDay = d => new Date(d + "T00:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
function progChanged() { saveScript(); buildSeq(); drawProgramme(); }
function drawProgramme() {
  const plan = animScript.schedule || [];
  $("#progClear").hidden = $("#progOpts").hidden = $("#progWrap").hidden = !plan.length;
  if (!plan.length) { $("#progNote").textContent = "Now using the usual order: site, foundation, each floor, doors and windows, roof."; return; }
  $("#progSeconds").value = String(animScript.schedule_seconds); $("#progDates").checked = animScript.show_dates;
  const prog = seq?.programme, parts = Object.fromEntries((prog?.tasks || []).map(t => [t.i, t.parts]));
  const shown = plan.filter(t => t.group !== "none").length;
  const left = Object.values(prog?.unscheduled || {}).reduce((a, b) => a + b, 0);
  const d0 = plan.reduce((m, t) => t.start < m ? t.start : m, plan[0].start), d1 = plan.reduce((m, t) => t.finish > m ? t.finish : m, plan[0].finish);
  $("#progNote").textContent = `Following your programme: ${plan.length} tasks, ${fmtDay(d0)} to ${fmtDay(d1)}, shown in ${animScript.schedule_seconds} s. ${shown} tasks build parts of the model.`
    + (left ? ` ${left} parts of the model are in no task, so they appear at the end; give them a task below.` : "");
  $("#progCount").textContent = `${shown} of ${plan.length} matched`;
  const storeys = viewer?.engine().storeys || [];
  $("#progRows").replaceChildren(...plan.map((t, i) => {
    const grp = el("select", { "aria-label": `Building part for ${t.name}` }, ...PROG_GROUPS.map(([v, n]) => el("option", { value: v, ...(v === t.group ? { selected: "" } : {}) }, n)));
    const kind = el("select", { "aria-label": `Which structure for ${t.name}`, ...(t.group === "structure" ? {} : { hidden: "" }) },
      ...PROG_KINDS.map(([v, n]) => el("option", { value: v, ...(v === (t.kind || "") ? { selected: "" } : {}) }, n)));
    const many = (t.floors || []).length > 1 ? (t.floors || []).join(", ") : null;
    const floor = el("select", { "aria-label": `Floor for ${t.name}` }, el("option", { value: "" }, "All floors"),
      ...(many ? [el("option", { value: "__many", selected: "" }, `${t.floors.length} floors`)] : []),
      ...storeys.map(n => el("option", { value: n, ...(!many && (t.floors || [])[0] === n ? { selected: "" } : {}) }, n)));
    grp.onchange = () => { t.group = grp.value; if (t.group !== "structure") t.kind = null; progChanged(); };
    kind.onchange = () => { t.kind = kind.value || null; progChanged(); };
    floor.onchange = () => { if (floor.value !== "__many") { t.floors = floor.value ? [floor.value] : []; progChanged(); } };
    const n = t.group === "none" ? "—" : String(parts[i] ?? 0);
    return el("tr", { class: t.group === "none" ? "unmatched" : "" }, el("td", {}, t.name, ...(many ? [el("br"), el("small", { class: "muted" }, many)] : [])),
      el("td", { class: "mono" }, `${fmtDay(t.start)} – ${fmtDay(t.finish)}`), el("td", {}, grp, " ", kind), el("td", {}, floor), el("td", { class: "mono" }, n));
  }));
}
$("#progFile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f || !current) return;
  if (modelLoading) { $("#progNote").textContent = "Waiting for the 3D model to finish loading…"; await modelLoading.catch(() => {}); }
  if (!enterBuild()) return;
  $("#progNote").textContent = `Reading ${f.name}…`;
  try {
    const out = await readSchedule(current.id, f, viewer.engine().storeys || []);
    animScript.schedule = out.tasks.map(t => ({ name: t.name, start: t.start, finish: t.finish, group: t.group, kind: t.kind, floors: t.floors, milestone: t.milestone }));
    progChanged();
    $("#progWrap").open = out.matched < out.tasks.length;
    toast(`${out.format} schedule read: ${out.tasks.length} tasks, ${out.matched} matched to the model. Check the matches below.`);
  } catch (err) { if (err.status === 401) return handle(err); $("#progNote").textContent = err.message; }
};
$("#progClear").onclick = () => { animScript.schedule = []; progChanged(); };
$("#progSeconds").onchange = e => { animScript.schedule_seconds = Math.min(180, Math.max(10, Number(e.target.value) || 40)); progChanged(); };
$("#progDates").onchange = e => { animScript.show_dates = e.target.checked; progChanged(); };

function drawAnimSettings() {
  drawProgramme();
  const s = animScript, lux = s.style === "luxury" && !!LUX;
  $("#aStyle").value = s.style; $("#aHeroes").value = String(s.heroes); $("#aLook").value = s.look;
  $("#aHeroesField").hidden = !lux; $("#aTimeField").hidden = lux; $("#animHeroes").hidden = !lux;
  $("#animPhases").replaceChildren(...C.PHASES.map(p => {
    const [lo, hi] = C.LIMITS[p];
    const on = el("input", { type: "checkbox", ...(s.phases[p].on ? { checked: "" } : {}), "aria-label": `Show ${PHASE_UI[p]}` });
    const sec = el("input", { type: "number", min: String(lo), max: String(hi), step: "0.5", value: String(s.phases[p].seconds), "aria-label": `Seconds for ${PHASE_UI[p]}` });
    on.onchange = () => { s.phases[p].on = on.checked; changed(); };
    sec.onchange = () => { s.phases[p].seconds = Number(sec.value); changed(); };
    const off = lux && (p === "furnish" || p === "interior");
    if (off) { on.disabled = true; sec.disabled = true; }
    const name = lux && p === "orbit" ? "Photoreal reveal (per view)" : off ? `${PHASE_UI[p]}: shown as AI renders in this style` : PHASE_UI[p];
    return el("div", { class: `phase-row${off ? " off" : ""}` }, el("label", { class: "check" }, on, name), el("span", { class: "sec" }, sec, "s"));
  }));
  $("#aTime").value = s.time_of_day; $("#aDir").value = s.direction; $("#aFormat").value = s.format;
  $("#aTitle").value = s.title; $("#aSub").value = s.subtitle; $("#aCaptions").checked = s.captions;
  $("#aRenders").checked = s.renders; $("#aRenderSec").value = String(s.render_seconds);
  $("#aHide").replaceChildren(...Object.entries(HIDE_UI).map(([k, label]) => { const c = el("input", { type: "checkbox", value: k, ...(s.hide.includes(k) ? { checked: "" } : {}) });
    c.onchange = () => { s.hide = c.checked ? [...s.hide, k] : s.hide.filter(x => x !== k); changed(); }; return el("label", { class: "check" }, c, label); }));
  const rooms = seq?.rooms || [];
  $("#aRooms").replaceChildren(...(rooms.length ? rooms.map(r => { const c = el("input", { type: "checkbox", value: r, ...(s.rooms.some(x => x.toLowerCase() === r.toLowerCase()) ? { checked: "" } : {}) });
    c.onchange = () => { s.rooms = c.checked ? [...s.rooms, r] : s.rooms.filter(x => x.toLowerCase() !== r.toLowerCase()); changed(); }; return el("label", { class: "check" }, c, r); })
    : [el("span", { class: "hint" }, "This model has no rooms. In Revit's IFC export settings, include rooms (spaces).")]));
}
function changed(redraw = false) {
  animScript = C.normalise(animScript); saveScript(); frameViewer(); buildSeq();
  if (redraw) drawAnimSettings();
}
$("#aStyle").onchange = e => { animScript.style = e.target.value; changed(true); };
$("#aHeroes").onchange = e => { animScript.heroes = Number(e.target.value); changed(true); };
$("#aLook").onchange = e => { animScript.look = e.target.value.trim(); saveScript(); };
$("#aTime").onchange = e => { animScript.time_of_day = e.target.value; changed(); };
$("#aDir").onchange = e => { animScript.direction = e.target.value; changed(); };
$("#aFormat").onchange = e => { animScript.format = e.target.value; changed(); };
$("#aTitle").onchange = e => { animScript.title = e.target.value.trim(); changed(); };
$("#aSub").onchange = e => { animScript.subtitle = e.target.value.trim(); changed(); };
$("#aCaptions").onchange = e => { animScript.captions = e.target.checked; changed(); };
$("#aRenders").onchange = e => { animScript.renders = e.target.checked; changed(); };
$("#aRenderSec").onchange = e => { animScript.render_seconds = Number(e.target.value); changed(); };

$("#animDirect").onsubmit = async e => {
  e.preventDefault();
  const ask = $("#animAsk").value.trim();
  if (ask.length < 3 || !seq) { $("#animAsk").focus(); return; }
  const btn = $("#animAskBtn"); btn.disabled = true; btn.textContent = "Working…";
  try {
    const r = await api.directAnimation(current.id, { instruction: ask, script: animScript, context: seq.context() });
    animScript = r.script; $("#animAsk").value = "";
    $("#animNotes").textContent = r.notes;
    changed(true); stopAnim(); showAt(0);
  } catch (err) { if (err.status === 401) return handle(err); $("#animNotes").textContent = err.message; }
  finally { btn.disabled = false; btn.textContent = "Apply"; }
};

function animStills() {
  // the newest AI render of each walkthrough shot, in the shots' order
  return shots.map(s => ({ s, r: shotRenders(s.id)[0] })).filter(x => x.r && x.r.url).map(x => ({ url: x.r.url, caption: x.s.name, render_id: x.r.id }));
}

let exportWarned = false;
$("#animExport").onclick = async () => {
  if (!seq || exporting) return;
  const missing = seq.luxury ? Array.from({ length: animScript.heroes }, (_, k) => !heroImgs[k]).filter(Boolean).length : 0;
  if (missing && !exportWarned) {
    exportWarned = true;
    message($("#animMsg"), `${missing} photoreal view${missing > 1 ? "s are" : " is"} not made yet, so the video will end on the gold wireframe instead of the photoreal building. Press “Make photoreal views” first, or press Export MP4 again to export anyway.`);
    $("#animHeroes").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" });
    return;
  }
  exportWarned = false;
  const { canExport, exportVideo } = await import("./export.js");
  if (!canExport()) { message($("#animMsg"), "This browser cannot make videos. Use Chrome or Edge on a computer, or Safari 17 or newer."); return; }
  stopAnim(); message($("#animMsg"), "");
  const ctl = new AbortController(); exporting = ctl;
  const btn = $("#animExport"); btn.disabled = true;
  $("#animProgress").hidden = false; $("#animBar").style.width = "0%";
  const say = (f, text) => { $("#animBar").style.width = `${Math.round(f * 100)}%`; $("#animProgText").textContent = text; };
  try {
    const out = await exportVideo({ seq, script: animScript, stills: animStills(), title: current.name, signal: ctl.signal,
      onProgress: (f, text) => say(f * 0.85, `Making the video: ${text.toLowerCase()}. Keep this tab open.`) });
    say(0.86, `Uploading ${(out.blob.size / 1048576).toFixed(1)} MB…`);
    await uploadAnimation(current.id, out.blob, { script: animScript, model_id: viewerModelId, items: out.items }, f => say(0.86 + f * 0.14, `Uploading… ${Math.round(f * 100)}%`));
    say(1, "Uploaded. Ollic is preparing it for phones; it appears below in a minute or two.");
    toast("Video uploaded. It will appear below when it is ready.");
    loadOutputs();
  } catch (err) {
    if (err.name === "AbortError") message($("#animMsg"), "Export cancelled.", "ok");
    else if (err.status === 401) handle(err);
    else message($("#animMsg"), err.message || "The video could not be made.");
  } finally {
    exporting = null; btn.disabled = false;
    setTimeout(() => { $("#animProgress").hidden = true; }, 4000);
    if (seq) { previewSize(); showAt(animT); }
  }
};
$("#animCancel").onclick = () => exporting?.abort();

import("./construction.js").then(m => { C = m; }).catch(() => { /* the button explains */ });
import("./luxury.js").then(m => { LUX = m; }).catch(() => { /* without it, the technical style is used */ });

/* photoreal views for the luxury style: the AI render of each hero view, matched by its key */
function refreshHeroes() {
  if (!seq) return;
  const n = seq.luxury ? animScript.heroes : 0;
  heroImgs.length = n;
  for (let k = 0; k < n; k++) {
    const key = seq.heroKey(k);
    const r = images.find(i => (i.options || {}).anim_hero?.key === key && (i.base_url || i.url));
    if (!r) { heroImgs[k] = null; continue; }
    heroPending.delete(key);
    if (heroImgs[k]?._rid === r.id) continue;
    heroImgs[k] = null;
    const img = new Image(); img.crossOrigin = "anonymous"; img._rid = r.id; img._url = r.url;
    img.onload = () => { if (seq && seq.heroKey(k) === key) { heroImgs[k] = img; drawHeroes(); showAt(animT); } };
    img.src = r.base_url || r.url;
  }
  drawHeroes();
}
function drawHeroes() {
  if (!seq || !seq.luxury) return;
  const n = animScript.heroes;
  $("#heroList").replaceChildren(...Array.from({ length: n }, (_, k) => {
    const img = heroImgs[k], key = seq.heroKey(k), waiting = heroPending.has(key);
    return el("div", { class: "hero-card" },
      el("div", { class: "thumb" }, img ? el("img", { src: img._url || img.src, alt: `Photoreal view ${k + 1}` }) : waiting ? "Rendering…" : "Not made yet"),
      el("div", { class: "cap" }, el("span", {}, `View ${k + 1}`), el("span", { class: "hint" }, img ? "Ready" : waiting ? "About a minute" : "Wireframe only"),
        img ? el("button", { class: "btn clip", type: "button", onclick: e => heroClip(k, e.currentTarget) }, "Cinematic clip") : ""));
  }));
  const missing = Array.from({ length: n }, (_, k) => !heroImgs[k] && !heroPending.has(seq.heroKey(k))).filter(Boolean).length;
  $("#heroBtn").textContent = missing ? `Make photoreal view${missing > 1 ? "s" : ""} (${missing})` : "Remake photoreal views";
}
$("#heroBtn").onclick = async () => {
  if (!seq || !seq.luxury) return;
  if ($("#renderForm").hidden) { toast("Concept renders are not switched on yet."); return; }
  const n = animScript.heroes, keys = Array.from({ length: n }, (_, k) => seq.heroKey(k));
  let todo = keys.map((key, k) => k).filter(k => !heroImgs[k] && !heroPending.has(keys[k]));
  if (!todo.length) todo = keys.map((_, k) => k);
  const [w, h, aspect] = { "16:9": [1536, 1024, "landscape"], "9:16": [1024, 1536, "portrait"], "1:1": [1024, 1024, "square"] }[animScript.format];
  stopAnim();
  const shots = [];
  for (const k of todo) {
    const canvas = seq.heroSnapshot(k, w, h);
    shots.push({ k, blob: await new Promise(res => canvas.toBlob(res, "image/png")) });
  }
  previewSize(); showAt(animT);
  const btn = $("#heroBtn"); btn.disabled = true;
  const look = $("#aLook").value.trim() || animScript.look;
  const prompt = `${look ? look + ". " : ""}Photorealistic luxury architectural visualisation of this exact building at night: blue hour sky with stars, warm light glowing from every window, `
    + "subtle warm facade uplighting, refined landscaping, cinematic low-angle architectural photography. Keep the building's exact shape, floors, roof and window positions from the model view.";
  try {
    for (const { k, blob } of shots) {
      const f = await uploadFile(current.id, new File([blob], `Photoreal view ${k + 1}.png`, { type: "image/png" }), () => {});
      const looks = tickedLooks().filter(id => id !== f.id).slice(0, 3).map(id => ({ file_id: id, role: "style" }));
      await api.startRender(current.id, { prompt, view: "exterior", time_of_day: "night", aspect, style: "luxury contemporary",
        tier: chosenTier(), quality: $("#rQuality").value, references: [{ file_id: f.id, role: "model" }, ...looks], anim_hero: { index: k, key: keys[k] } }, newKey());
      heroPending.add(keys[k]); drawHeroes();
    }
    toast(`Making ${shots.length} photoreal view${shots.length > 1 ? "s" : ""}. Each takes about a minute.`);
  } catch (err) { if (err.status === 401) return handle(err); toast(err.message); }
  finally { btn.disabled = false; current = await api.getProject(current.id).catch(() => current); renderProject(); loadOutputs(); }
};

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
  if ($("#renderForm").hidden) { toast("Concept renders are not switched on yet."); return; }
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
  const base = C ? C.defaultScript() : {};
  const script = C ? C.normalise({ ...base, format: $("#iaFormat").value, title: $("#iaTitle2").value.trim() || current.name, subtitle: $("#iaSub").value.trim(), renders: false, look: $("#iaLook").value.trim() })
    : { format: $("#iaFormat").value, title: current.name, subtitle: "", renders: false, captions: true, render_seconds: 4 };
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
    sel.replaceChildren(...Object.entries(engines).map(([k, e]) => el("option", { value: k, ...(e.available ? {} : { disabled: "" }) },
      `${e.name}${e.soon ? " (coming soon)" : !e.available ? " (not connected yet)" : ""}`)));
    sel.value = engines[keep]?.available ? keep : (Object.keys(engines).find(k => engines[k].available) || "motion");
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
clipControls($("#animClipOpts"), "anim"); clipControls($("#iaClipOpts"), "ia");

async function startClip(start, end, format, title, prefix, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await api.makeClip(current.id, { start, end, format, title: (title || "").slice(0, 80), ...clipOpts[prefix]() });
    toast(`Cinematic clip started (about $${Number(r.estimate_usd).toFixed(2)}). It takes 2–6 minutes and appears under the videos.`);
    loadOutputs();
  } catch (err) { if (err.status === 401) return handle(err); toast(err.message); }
  finally { if (btn) btn.disabled = false; }
}
async function heroClip(k, btn) {
  if (!seq || !heroImgs[k]) return;
  btn.disabled = true;
  try {
    const [w, h] = { "16:9": [1536, 1024], "9:16": [1024, 1536], "1:1": [1024, 1024] }[animScript.format];
    stopAnim();
    const canvas = seq.heroWireSnapshot(k, w, h);
    const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
    previewSize(); showAt(animT);
    const f = await uploadFile(current.id, new File([blob], `Cinematic start view ${k + 1}.png`, { type: "image/png" }), () => {});
    await startClip({ kind: "file", id: f.id }, { kind: "render", id: heroImgs[k]._rid }, animScript.format, animScript.title || current.name, "anim", null);
    current = await api.getProject(current.id).catch(() => current); renderProject();
  } catch (err) { if (err.status === 401) return handle(err); toast(err.message); }
  finally { btn.disabled = false; }
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
