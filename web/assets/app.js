import { api, uploadFile, ApiError, newKey } from "./api.js";
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
  resetModel(); resetWalk(); outputsLoadedOnce = false; seenDone = new Set();
  history.replaceState(null, "", `${location.pathname}?project=${encodeURIComponent(id)}`);
  try { current = await api.getProject(id); renderProject(); loadOutputs(); loadModels(); loadShots(); loadVideos(); }
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
  fillPickers();
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

function fileActions(f) {
  if (f.detected_type === "ifc" && f.origin !== "generated")
    return [el("button", { class: "btn", type: "button", onclick: e => startImport(f, e.currentTarget) }, "Import 3D")];
  return [];
}
async function startImport(f, btn) {
  if (btn) btn.disabled = true;
  try { await api.importIfc(current.id, f.id, newKey()); toast("Reading the IFC model. This takes a few seconds to a minute."); loadOutputs(); }
  catch (err) { if (err.status === 401) return handle(err); toast(err.message); }
  finally { if (btn) btn.disabled = false; }
}

/* ---------- 3D models (Phase 3) ---------- */
let viewer = null, viewerModelId = null, walkRoom = 0;
function resetModel() {
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
  const m = models[0];
  $("#viewerWrap").hidden = !m;
  $("#modelEmpty").hidden = !!m;
  if (!m || m.id === viewerModelId) return;
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
    const info = await viewer.load(m.glb_url);
    const pick = $("#storeySelect");
    pick.replaceChildren(el("option", { value: "" }, "All floors"), ...info.storeys.map(s => el("option", { value: s }, s)));
    $("#storeyPick").hidden = info.storeys.length < 2;
    showElement(null);
  } catch (err) {
    $("#viewer").append(el("div", { class: "viewer-msg" }, "The 3D view could not start on this device. You can still download the model."));
  }
}

function setViewMode(mode) {
  if (!viewer) return;
  if (mode === "walk") {
    if (!viewer.rooms().length) { toast("This model has no rooms to walk into. In Revit's IFC export settings, include rooms (spaces) and export again."); return; }
    if (viewer.mode !== "walk") viewer.walkTo(walkRoom);
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
const JOB_NAME = { concept_render: "New concept", concept_edit: "Revision", ifc_import: "Reading IFC model", video_export: "Walkthrough video" };
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
  setupTiers(out);
  const MODEL_JOBS = ["ifc_import"], VIDEO_JOBS = ["video_export"];
  drawJobs(out.jobs.filter(j => !MODEL_JOBS.includes(j.type) && !VIDEO_JOBS.includes(j.type)), "#jobList");
  drawJobs(out.jobs.filter(j => MODEL_JOBS.includes(j.type)), "#modelJobs");
  drawJobs(out.jobs.filter(j => VIDEO_JOBS.includes(j.type)), "#walkJobs");
  drawGallery(out.images);
  images = out.images; drawWalk();
  const vids = out.jobs.filter(j => VIDEO_JOBS.includes(j.type) && j.status === "succeeded" && !seenDone.has(j.id));
  vids.forEach(j => seenDone.add(j.id));
  if (vids.length && outputsLoadedOnce) { loadVideos(); toast("Your walkthrough video is ready."); }
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
        el("div", { class: "actions" }, i.download_url ? el("a", { class: "btn", href: i.download_url, download: "" }, "Download") : ""),
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
  tierChanged();
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
  for (const file of files) {
    const bar = el("i"); const status = el("span", { class: "muted mono" }, "0%");
    const row = el("div", { class: "upload-row" }, el("span", { class: "name" }, file.name), status, el("div", { class: "progress" }, bar));
    $("#uploads").prepend(row);
    try {
      const uploaded = uploadFile(current.id, file, f => { bar.style.width = `${Math.round(f * 100)}%`; status.textContent = `${Math.round(f * 100)}%`; });
      const saved = await uploaded;
      bar.style.width = "100%"; status.textContent = "Checked and saved";
      if (saved?.detected_type === "ifc") startImport(saved);
      current = await api.getProject(current.id); renderProject();
      setTimeout(() => row.remove(), 2500);
    } catch (err) {
      row.classList.add("error"); status.textContent = "Not uploaded"; row.append(el("span", { class: "reason" }, err.message));
      if (err.status === 401) return handle(err);
    }
  }
}
$("#fileInput").onchange = e => { uploadAll([...e.target.files]); e.target.value = ""; };
const dz = $("#dropZone");
["dragenter", "dragover"].forEach(t => dz.addEventListener(t, e => { e.preventDefault(); dz.classList.add("over"); }));
["dragleave", "drop"].forEach(t => dz.addEventListener(t, e => { e.preventDefault(); dz.classList.remove("over"); }));
dz.addEventListener("drop", e => uploadAll([...e.dataTransfer.files]));

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
  $("#videoList").replaceChildren(...videos.map(v => {
    const ratio = `${v.width}/${v.height}`;
    return el("article", { class: "video-card" },
      el("div", { class: "frame", style: `aspect-ratio:${ratio}` },
        v.url ? el("video", { src: v.url, controls: "", preload: "metadata", playsinline: "", "aria-label": `Walkthrough video: ${v.title || "untitled"}` }) : el("span", { class: "muted" }, "Video link unavailable")),
      el("div", { class: "body" },
        el("h3", {}, v.title || "Walkthrough"),
        el("div", { class: "tags" }, el("span", { class: "chip" }, v.format), el("span", { class: "chip" }, `${Math.round(v.duration_s)} s`), el("span", { class: "chip" }, `${(v.items || []).length} shot${(v.items || []).length === 1 ? "" : "s"}`), el("span", { class: "chip" }, v.label)),
        el("p", { class: "hint" }, fmtDate(v.created_at)),
        el("div", { class: "actions" }, v.download_url ? el("a", { class: "btn primary", href: v.download_url, download: "" }, "Download MP4") : "")));
  }));
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
