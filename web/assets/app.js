import { api, uploadFile, ApiError } from "./api.js";
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
$("#signOutBtn").onclick = async () => { await session.signOut(); $("#userNav").hidden = true; authMode("in"); show("authView"); };

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
  show("projectView"); $("#uploads").replaceChildren(); resetDelete();
  history.replaceState(null, "", `${location.pathname}?project=${encodeURIComponent(id)}`);
  try { current = await api.getProject(id); renderProject(); }
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
}
$("#backBtn").onclick = () => listProjects();

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
