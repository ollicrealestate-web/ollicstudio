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
  history.replaceState(null, "", `${location.pathname}?project=${encodeURIComponent(id)}`);
  try { current = await api.getProject(id); renderProject(); loadOutputs(); }
  catch (err) { if (err.status === 404) { toast("That project does not exist or is not yours."); listProjects(); } else handle(err); }
}
function renderProject() {
  $("#projectName").textContent = current.name;
  $("#projectMeta").textContent = `${INPUT[current.input_type] || ""} · created ${fmtDate(current.created_at)}`;
  const rows = $("#fileRows"); rows.replaceChildren();
  current.source_files.forEach(f => rows.append(el("tr", {},
    el("td", {}, f.original_name), el("td", {}, TYPE[f.detected_type] || f.detected_type), el("td", { class: "mono" }, fmtBytes(f.size_bytes)),
    el("td", {}, details(f)), el("td", {}, fmtDate(f.created_at)), el("td", { class: "mono", title: f.checksum_sha256 }, f.checksum_sha256.slice(0, 12) + "…"))));
  $("#filesWrap").hidden = current.source_files.length === 0;
  const ref = $("#rRef"), keep = ref.value;
  ref.replaceChildren(el("option", { value: "" }, "Nothing: a fresh concept"),
    ...current.source_files.filter(f => f.detected_type === "png" || f.detected_type === "jpeg").map(f => el("option", { value: f.id }, f.original_name)));
  ref.value = [...ref.options].some(o => o.value === keep) ? keep : "";
}
$("#backBtn").onclick = () => { stopPolling(); listProjects(); };

/* ---------- concept renders (Phase 2) ---------- */
const JOB_NAME = { concept_render: "New concept", concept_edit: "Revision" };
const LIGHT_NAME = { morning: "Morning", midday: "Midday", "golden hour": "Golden hour", dusk: "Dusk", night: "Night" };
let pollTimer = null, outputsFor = null, seenFailed = new Set();
function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }

async function loadOutputs() {
  if (!current) return;
  const pid = current.id; outputsFor = pid;
  let out;
  try { out = await api.outputs(pid); }
  catch (err) { if (err.status === 401) return handle(err); pollTimer = setTimeout(loadOutputs, 8000); return; }
  if (outputsFor !== pid || $("#projectView").hidden) return;
  $("#studioOff").hidden = out.renders_enabled; $("#renderForm").hidden = !out.renders_enabled;
  $("#rQuality").closest("label").hidden = out.provider !== "openai";  // the free model has one detail level
  $("#renderLimit").textContent = out.daily_limit ? `Up to ${out.daily_limit} free concepts a day. Failed ones do not count.` : "";
  drawJobs(out.jobs); drawGallery(out.images);
  stopPolling();
  if (out.jobs.some(j => j.status === "queued" || j.status === "running")) pollTimer = setTimeout(loadOutputs, 3000);
}

function drawJobs(jobs) {
  const now = Date.now();
  const show = jobs.filter(j => j.status === "queued" || j.status === "running"
    || ((j.status === "failed" || j.status === "cancelled") && now - new Date(j.finished_at || j.created_at).getTime() < 30 * 60 * 1000 && !seenFailed.has(j.id)));
  $("#jobList").replaceChildren(...show.map(j => {
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
    const tags = [o.view, LIGHT_NAME[o.time_of_day], o.quality === "high" ? "High detail" : null].filter(Boolean);
    const input = el("input", { type: "text", maxlength: "1000", placeholder: "What should change? e.g. make the roof dark grey", "aria-label": "Describe a change" });
    const go = el("button", { class: "btn primary", type: "submit" }, "Revise");
    const parent = i.parent_image_id ? byId[i.parent_image_id] : null;
    return el("article", { class: "shot" },
      el("div", { class: "frame", style: `aspect-ratio:${w}/${h}` },
        i.url ? el("img", { src: i.url, alt: `AI concept render: ${i.prompt}`, loading: "lazy", width: String(w), height: String(h) }) : el("span", { class: "muted" }, "Image link unavailable"),
        el("span", { class: "badge" }, i.label)),
      el("div", { class: "body" },
        el("p", { class: "prompt" }, i.parent_image_id ? `Revision: ${i.prompt}` : i.prompt),
        el("div", { class: "tags" }, ...tags.map(t => el("span", { class: "chip" }, t)), parent ? el("span", { class: "chip" }, "Revised") : ""),
        el("p", { class: "hint" }, `${fmtDate(i.created_at)} · ${i.model}`),
        el("div", { class: "actions" }, i.download_url ? el("a", { class: "btn", href: i.download_url, download: "" }, "Download") : ""),
        el("form", { class: "revise", onsubmit: e => { e.preventDefault(); revise(i.id, input, go); } }, input, go)));
  }));
}

$("#renderForm").onsubmit = e => {
  e.preventDefault();
  const body = { prompt: $("#rPrompt").value.trim(), view: $("#rView").value, time_of_day: $("#rLight").value, aspect: $("#rAspect").value,
    quality: $("#rQuality").value, materials: $("#rMaterials").value.trim(), landscaping: $("#rLand").value.trim() };
  if ($("#rRef").value) body.reference_file_id = $("#rRef").value;
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
      await uploadFile(current.id, file, f => { bar.style.width = `${Math.round(f * 100)}%`; status.textContent = `${Math.round(f * 100)}%`; });
      bar.style.width = "100%"; status.textContent = "Checked and saved";
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
