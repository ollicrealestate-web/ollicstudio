// "Complete my design": the whole flow in the Ollic AI panel.
//  1. Start: readiness check, level of detail, scope, reference images (up to 6), a description, the cost estimate.
//  2. Ollic AI looks at the model (summary + clay pictures + plans with ids) and the references, says what it sees in
//     each reference (editable), and asks up to 6 short questions with tap-to-choose answers.
//  3. The plan: numbered items to tick, untick or change in words; then Build.
//  4. Build into the AI proposal, item by item (one undo step per item), every command checked in code.
//  5. Up to 3 check rounds with fresh pictures; it fixes what it finds.
//  6. The honest report; then review in the AI proposal list (accept, reject, change one item in words).
import { readiness, modelSummary } from "./summary.js";
import { prepareModel } from "./autofix.js";
import { captureViews } from "./capture.js";
import { runStage, pictureBlocks, checkPictures, serverTransport, addUser } from "./aiclient.js";
import { proposalItems, OPTION, hasProposal } from "./options.js";

const MAX_REFS = 6, MAX_ROUNDS = 3;
const DETAIL = { light: "Light: materials, railings, copings", medium: "Medium: also bands, fins, canopies, soffits, planters", full: "Full: everything the references show" };

export function initAiFlow(app) {
  const F = app.aiFlow = { step: "idle", detail: "medium", scopeKind: "all", levels: [], refs: [], description: "", chat: [], questions: [], answers: {}, own: {}, plan: [], progress: {}, log: [], cost: 0, round: 0, report: null, busy: "", error: "" };
  app.completeDesign = () => start(app);
  app.aiPanel.extraHtml = () => flowHtml(app);
  app.aiPanel.wire = box => wireFlow(app, box);
  app.aiPanel.change = (a, item) => changeItem(app, item);
  app.aiPanel.closed = status => save(app, { status, log: F.log, chat: F.chat });
  F.transport = null;
  return F;
}

const render = app => app.aiPanel.render();
const say = (app, from, text) => { if (text?.trim()) app.aiFlow.chat.push({ from, text: text.trim() }); };
async function transport(app) {
  const F = app.aiFlow;
  if (!F.transport) F.transport = app.aiTransportOverride || await serverTransport();
  return F.transport;
}
async function save(app, fields) {
  const F = app.aiFlow; if (!F.session) return;
  try { await (await transport(app)).update(F.session.id, fields); } catch { /* the record is best effort; the work goes on */ }
}

// --------------------------------------------------------------------------- 1. start
async function start(app) {
  const F = app.aiFlow;
  if (F.step !== "idle" && F.step !== "done" && F.step !== "setup" && F.step !== "notready") { app.aiPanel.show(); return; }
  Object.assign(F, { step: "setup", chat: [], questions: [], answers: {}, own: {}, plan: [], progress: {}, log: [], cost: 0, round: 0, report: null, error: "", session: null, refs: [], description: "" });
  const sel = [...app.selection].filter(id => app.lookup(id));
  F.selection = sel; F.scopeKind = sel.length ? "selected" : "all"; F.levels = app.doc.levels.map(l => l.id);
  // the model is made ready by itself (walls joined into loops, missing floors added); only an empty model stops here
  const prep = readiness(app.doc).length ? prepareModel(app.history) : { done: [], issues: [] };
  F.prepared = prep.done;
  if (prep.done.length) app.redraw?.(true);
  if (prep.issues.length) { F.step = "notready"; F.issues = prep.issues; }
  app.aiPanel.show();
  try { const t = await transport(app); const c = await t.config(); F.available = c.available !== false; } catch (e) { F.available = false; F.error = e.message; }
  render(app);
}

function scopeOf(app) {
  const F = app.aiFlow;
  if (F.scopeKind === "selected" && F.selection?.length) return { ids: F.selection };
  if (F.scopeKind === "levels") return { levels: F.levels };
  return {};
}

/** A picture file, made at most 1568 px (what the assistant reads best), as a JPEG data URL. */
function readPicture(file) {
  return new Promise((res, rej) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { rej(new Error(`${file.name}: use JPEG, PNG or WebP pictures.`)); return; }
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => { const k = Math.min(1, 1568 / Math.max(im.width, im.height)), c = document.createElement("canvas"); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k); c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(url); res(c.toDataURL("image/jpeg", 0.88)); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error(`${file.name} could not be read as a picture.`)); };
    im.src = url;
  });
}

async function begin(app) {
  const F = app.aiFlow;
  F.busy = "Looking at your model…"; F.error = ""; render(app);
  try {
    const t = await transport(app), scope = scopeOf(app);
    const summary = modelSummary(app.doc, scope), summaryText = JSON.stringify(summary);
    F.session = await t.createSession({ sketch_id: app.store?.cloudId || null, detail: F.detail, scope, pictures: 7, references: F.refs.length, summary_kb: summaryText.length / 1024, items: F.detail === "light" ? 5 : F.detail === "medium" ? 8 : 12 });
    F.estimate = F.session.estimate;
    for (const r of F.refs) { const s = await t.addReference(F.session.id, { data_url: r.dataUrl, name: r.name }); r.n = s.n; r.path = s.path; }
    F.refs.forEach((r, i) => { r.n = r.n || i + 1; });
    const shots = await captureViews(app, { style: "clay" });
    F.summary = summary;
    const intro = [
      { type: "text", text: `Model summary (JSON):\n${summaryText}` },
      ...pictureBlocks(shots, "Picture of the model, "),
      ...F.refs.flatMap(r => [{ type: "text", text: `Reference image ${r.n} (${r.name}):` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: r.dataUrl.split(",")[1] } }]),
      { type: "text", text: `Level of detail: ${DETAIL[F.detail]}.\nScope: ${F.scopeKind === "selected" ? `only these elements: ${F.selection.join(", ")}` : F.scopeKind === "levels" ? `only levels ${F.levels.join(", ")}` : "the whole building"}.\nTheir description: ${F.description.trim() || "(none)"}` },
    ];
    say(app, "you", F.description.trim() || `Complete my design (${F.detail}).`);
    F.messages = [{ role: "user", content: intro }];
    await save(app, { stage: "interview", summary, chat: F.chat });
    await interview(app);
  } catch (e) { fail(app, e); }
}

function fail(app, e) { const F = app.aiFlow; F.busy = ""; F.error = e.message || String(e); render(app); }
const onEvent = app => e => {
  const F = app.aiFlow;
  if (e.type === "text") say(app, "ai", e.text);
  if (e.type === "cost") F.cost = e.cost;
  if (e.type === "tool") { F.log.push({ name: e.name, ok: e.ok, message: e.message, item: e.planItem ?? null }); if (e.planItem != null && F.progress[e.planItem] === "waiting") F.progress[e.planItem] = "building"; }
  render(app);
};

// --------------------------------------------------------------------------- 2. what it sees, and questions
async function interview(app) {
  const F = app.aiFlow;
  F.busy = "Ollic AI is studying the model and your pictures…"; render(app);
  const out = await runStage(app, { transport: await transport(app), session: F.session, stage: "interview", messages: F.messages, onEvent: onEvent(app), onMeta: (name, input) => {
    if (name === "describe_references") { for (const im of input.images || []) { const r = F.refs.find(x => x.n === im.n); if (r) { r.sees = im.sees; r.takes = im.takes; } } return { result: "Shown to them; they may correct it." }; }
    if (name === "ask_questions") { F.questions = (input.questions || []).slice(0, 6); if (input.note) say(app, "ai", input.note); return { result: "Waiting for their answers.", pause: true }; }
    return { result: "Not used in this stage." };
  } });
  F.messages = out.messages; F.busy = "";
  F.step = "questions";
  await save(app, { stage: "interview", chat: F.chat, refs: F.refs.filter(r => r.n).map(r => ({ n: r.n, sees: r.sees || "", takes: r.takes || "" })) });
  render(app);
}

async function sendAnswers(app) {
  const F = app.aiFlow;
  const lines = F.questions.map(q => { const a = [...(F.answers[q.id] || [])], own = (F.own[q.id] || "").trim(); return `${q.text} -> ${[...a, own].filter(Boolean).join("; ") || "(no answer: use your judgement)"}`; });
  const refs = F.refs.filter(r => r.sees != null).map(r => `Image ${r.n}: they confirm you see "${r.sees}" and will take "${r.takes}".`);
  const text = [lines.length ? `Answers:\n${lines.join("\n")}` : "", refs.length ? refs.join("\n") : "", F.extra?.trim() ? `They add: ${F.extra.trim()}` : ""].filter(Boolean).join("\n\n") || "Go ahead.";
  say(app, "you", lines.length ? lines.map(l => l.split(" -> ")[1]).join(" · ") : "Go ahead.");
  F.messages = addUser(F.messages, text);
  await plan(app);
}

// --------------------------------------------------------------------------- 3. the plan
async function plan(app, change = "") {
  const F = app.aiFlow;
  F.busy = "Writing the plan…"; F.step = "planning"; render(app);
  try {
    if (change) F.messages = addUser(F.messages, `Rewrite the plan with these changes: ${change}`);
    const out = await runStage(app, { transport: await transport(app), session: F.session, stage: "plan", messages: F.messages, onEvent: onEvent(app), onMeta: (name, input) => {
      if (name === "write_plan") { F.plan = (input.items || []).map((it, i) => ({ ...it, n: it.n ?? i + 1, on: true, change: "" })); if (input.summary) say(app, "ai", input.summary); return { result: "Shown to them for ticking and changes.", pause: true }; }
      return { result: "Not used in this stage." };
    } });
    F.messages = out.messages; F.busy = ""; F.step = "plan";
    await save(app, { stage: "plan", plan: F.plan, chat: F.chat });
    render(app);
  } catch (e) { fail(app, e); }
}

// --------------------------------------------------------------------------- 4-6. build, check, report
async function build(app) {
  const F = app.aiFlow, items = F.plan.filter(i => i.on);
  if (!items.length) { app.toast("Tick at least one item to build."); return; }
  F.step = "building"; F.busy = "Building into the AI proposal…"; F.progress = Object.fromEntries(items.map(i => [i.n, "waiting"])); render(app);
  try {
    app.commit("Ollic AI plan", doc => { doc.settings = { ...doc.settings, ai: { session: F.session.id, plan: items.map(i => ({ n: i.n, text: i.title })) } }; });
    const t = await transport(app), refsText = F.refs.filter(r => r.sees).map(r => `Image ${r.n}: ${r.sees}. Take: ${r.takes}.`).join("\n");
    const plans = await captureViews(app, { views: [], style: "clay" });
    const planText = items.map(i => `${i.n}. ${i.title}: ${i.what} | where: ${i.where}${i.sizes ? ` | sizes: ${i.sizes}` : ""}${i.material ? ` | material: ${i.material}` : ""}${i.image ? ` | image ${i.image}` : ""}${i.change ? `\n   THEIR CHANGE: ${i.change}` : ""}`).join("\n");
    say(app, "you", `Build ${items.length} item${items.length > 1 ? "s" : ""}.`);
    const msg = [{ type: "text", text: `Model summary (JSON):\n${JSON.stringify(modelSummary(app.doc, scopeOf(app)))}` }, ...pictureBlocks(plans), { type: "text", text: `What you saw in their references:\n${refsText || "(no references)"}\n\nThe plan to build (only these items; level of detail ${F.detail}):\n${planText}` }];
    const doneItem = (fix = false) => (name, input) => {
      if (name !== "item_done") return { result: "Not used in this stage." };
      const n = input.plan_item;
      F.progress[n] = input.ok === false ? "failed" : "done";
      if (input.note) F.log.push({ name: "item_done", ok: input.ok !== false, message: `Item ${n}: ${input.note}`, item: n });
      const it = F.plan.find(x => x.n === n);
      if (app.history.squash(s => s.label.startsWith(`Item ${n}: `) && !s.squashed, `${fix ? "Fix item" : "Item"} ${n}${it ? `: ${it.title}` : ""}`)) app.history.undoStack.at(-1).squashed = true;
      render(app);
      return { result: "Noted." };
    };
    let out = await runStage(app, { transport: t, session: F.session, stage: "build", messages: [{ role: "user", content: msg }], onEvent: onEvent(app), onMeta: doneItem(), maxSteps: 80 });
    for (const i of items) if (F.progress[i.n] === "waiting" || F.progress[i.n] === "building") F.progress[i.n] = proposalItems(app.doc).some(p => p.planItem === i.n) ? "done" : "failed";
    // check rounds with fresh pictures
    for (F.round = 1; F.round <= MAX_ROUNDS; F.round++) {
      F.busy = `Checking its work (round ${F.round} of ${MAX_ROUNDS})…`; render(app);
      const shots = await checkPictures(app);
      let ok = false, problems = [];
      const built = proposalItems(app.doc).map(p => `${p.planItem ?? "-"}: ${p.title} (${[...p.ids, ...p.materialIds].join(", ")})`).join("\n");
      const content = [{ type: "text", text: `Round ${F.round} of ${MAX_ROUNDS}. The plan:\n${planText}\n\nWhat is in the AI proposal now:\n${built}` }, ...pictureBlocks(shots, "After, "),
        ...F.refs.flatMap(r => [{ type: "text", text: `Reference image ${r.n}:` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: r.dataUrl.split(",")[1] } }])];
      out = await runStage(app, { transport: t, session: F.session, stage: "check", messages: [{ role: "user", content }], onEvent: onEvent(app), maxSteps: 40, onMeta: (name, input) => {
        if (name === "check_result") { ok = input.ok !== false && !(input.problems || []).length; problems = input.problems || []; F.lastCheck = { round: F.round, ok, problems }; render(app); return { result: ok ? "Good." : "Fix these now with the commands, then call item_done for each item you changed." }; }
        return doneItem(true)(name, input);
      } });
      if (ok) break;
    }
    if (F.round > MAX_ROUNDS) F.round = MAX_ROUNDS;
    // the honest report
    F.busy = "Writing the report…"; render(app);
    const logText = F.log.map(l => `${l.ok ? "ok" : "refused"} ${l.name}${l.item != null ? ` (item ${l.item})` : ""}: ${l.message}`).join("\n").slice(-12000);
    out = await runStage(app, { transport: t, session: F.session, stage: "report", messages: [{ role: "user", content: `The plan:\n${planText}\n\nItem results: ${JSON.stringify(F.progress)}\nLast check: ${JSON.stringify(F.lastCheck || {})}\n\nCommand log:\n${logText}` }], onEvent: onEvent(app), onMeta: (name, input) => {
      if (name === "final_report") { F.report = { built: input.built || [], not_built: input.not_built || [], please_check: input.please_check || [] }; return { result: "Shown to them.", pause: true }; }
      return { result: "Not used in this stage." };
    } });
    F.step = "review"; F.busy = "";
    await save(app, { stage: "review", status: "built", plan: F.plan, chat: F.chat, log: F.log, report: F.report || {} });
    render(app);
  } catch (e) { fail(app, e); }
}

/** Change one item in words (review): Ollic AI revises only that item. */
async function changeItem(app, item) {
  const F = app.aiFlow;
  if (!F.session || item.planItem == null) { app.toast("This item was not made in this session; edit it by hand (select it, then Edit in Properties)."); return; }
  const words = await app.askText(`What should change in item ${item.planItem} (${item.title})?`, "", 400);
  if (!words) return;
  F.busy = `Changing item ${item.planItem}…`; say(app, "you", `Item ${item.planItem}: ${words}`); render(app);
  try {
    const els = [...app.doc.details, ...app.doc.components].filter(e => e.planItem === item.planItem && e.option === OPTION).map(e => ({ id: e.id, kind: e.kind, settings: e.args }));
    await runStage(app, { transport: await transport(app), session: F.session, stage: "revise", messages: [{ role: "user", content: `Item ${item.planItem} (${item.title}). Its elements now: ${JSON.stringify(els)}\nThey ask: ${words}` }], onEvent: onEvent(app), onMeta: (name) => {
      if (name === "item_done") { app.history.squash(s => s.label.startsWith(`Item ${item.planItem}: `), `Change item ${item.planItem}`); return { result: "Noted." }; }
      return { result: "Not used in this stage." };
    } });
    F.busy = ""; await save(app, { chat: F.chat, log: F.log }); render(app);
  } catch (e) { fail(app, e); }
}

// --------------------------------------------------------------------------- the panel
const usd = v => `$${(+v || 0).toFixed(2)}`;
function flowHtml(app) {
  const F = app.aiFlow, esc = app.ui.esc;
  if (F.step === "idle") return "";
  const chat = F.chat.length ? `<div class="ai-chat" id="aiChat">${F.chat.slice(-30).map(m => `<div class="msg ${m.from}"><b>${m.from === "ai" ? "Ollic AI" : "You"}</b> ${esc(m.text)}</div>`).join("")}</div>` : "";
  const busy = F.busy ? `<div class="ai-busy" role="status"><span class="spin" aria-hidden="true"></span>${esc(F.busy)}</div>` : "";
  const err = F.error ? `<div class="err">${esc(F.error)}</div>` : "";
  const cost = F.session ? `<div class="ai-cost">Cost so far: ${usd(F.cost)}${F.estimate ? ` (estimate ${usd(F.estimate.low_usd)}–${usd(F.estimate.high_usd)})` : ""}</div>` : "";
  let body = "";
  if (F.step === "notready") body = `<p><b>Ollic AI needs a little more to start from:</b></p><ul class="ai-issues">${F.issues.map(i => `<li>${esc(i)}</li>`).join("")}</ul><button class="btn" type="button" id="aiRecheck">Check again</button>`;
  else if (F.step === "setup") body = (F.prepared?.length ? `<div class="ai-prepared"><p><b>Ollic AI first made the model ready</b> (one step: Undo takes it back):</p><ul class="ai-issues">${F.prepared.map(i => `<li>${esc(i)}</li>`).join("")}</ul></div>` : "") + setupHtml(app);
  else if (F.step === "past") body = pastHtml(app);
  else if (F.step === "questions") body = questionsHtml(app);
  else if (F.step === "plan") body = planHtml(app);
  else if (F.step === "building" || F.step === "review") body = progressHtml(app);
  return `<section class="ai-flow" aria-label="Complete my design"><div class="ai-row"><b>Complete my design</b>${F.step !== "setup" && F.step !== "notready" ? `<button class="btn" type="button" id="aiRestart">New</button>` : ""}</div>${chat}${err}${busy}${F.busy ? "" : body}${cost}</section>`;
}
function setupHtml(app) {
  const F = app.aiFlow, esc = app.ui.esc;
  if (F.available === false) return `<p>${esc(F.error || "Ollic AI is not set up on this server yet.")}</p>`;
  return `<fieldset class="ai-field"><legend>Level of detail</legend>${Object.entries(DETAIL).map(([k, v]) => `<label><input type="radio" name="aiDetail" value="${k}"${F.detail === k ? " checked" : ""}> ${esc(v)}</label>`).join("")}</fieldset>
    <fieldset class="ai-field"><legend>What to complete</legend>
      <label><input type="radio" name="aiScope" value="all"${F.scopeKind === "all" ? " checked" : ""}> The whole building</label>
      <label><input type="radio" name="aiScope" value="selected"${F.scopeKind === "selected" ? " checked" : ""}${F.selection?.length ? "" : " disabled"}> Only what is selected${F.selection?.length ? ` (${F.selection.length})` : " (select in plan or 3D first)"}</label>
      <label><input type="radio" name="aiScope" value="levels"${F.scopeKind === "levels" ? " checked" : ""}> Only these levels:</label>
      <div class="ai-levels">${app.doc.levels.map(l => `<label><input type="checkbox" class="aiLv" value="${l.id}"${F.levels.includes(l.id) ? " checked" : ""}> ${esc(l.name)}</label>`).join("")}</div></fieldset>
    <fieldset class="ai-field"><legend>Reference images (up to ${MAX_REFS})</legend>
      <div class="ai-refs">${F.refs.map((r, i) => `<figure><img src="${r.dataUrl}" alt="Reference ${i + 1}"><button type="button" class="x" data-rm="${i}" aria-label="Remove">×</button></figure>`).join("")}</div>
      ${F.refs.length < MAX_REFS ? `<label class="btn ai-upload">Add pictures<input type="file" id="aiFiles" accept="image/jpeg,image/png,image/webp" multiple hidden></label>` : ""}</fieldset>
    <label class="ai-field"><span>Describe the style you want (optional)</span><textarea id="aiDesc" rows="3" maxlength="2000" placeholder="e.g. Modern Nigerian duplex, travertine and teak, glass balconies, a big thin roof overhang">${esc(F.description)}</textarea></label>
    <p class="ai-note">Ollic AI completes your design; it does not move your walls, levels, rooms or openings. Everything it adds goes into the AI proposal for you to accept.</p>
    <div class="ai-foot"><span class="ai-cost" id="aiEst"></span><button class="btn primary" type="button" id="aiStart">Start</button></div>
    <button class="btn" type="button" id="aiPast">Past sessions</button>`;
}
function questionsHtml(app) {
  const F = app.aiFlow, esc = app.ui.esc;
  const refs = F.refs.filter(r => r.sees != null).map(r => `<div class="ai-ref"><img src="${r.dataUrl}" alt="Image ${r.n}"><div><b>Image ${r.n}</b><label>Sees<textarea data-ref="${r.n}" data-k="sees" rows="2">${esc(r.sees)}</textarea></label><label>Will take<textarea data-ref="${r.n}" data-k="takes" rows="2">${esc(r.takes)}</textarea></label></div></div>`).join("");
  const qs = F.questions.map(q => `<div class="ai-q" data-q="${esc(q.id)}"><p>${esc(q.text)}</p><div class="chips">${(q.choices || []).map(c => `<button type="button" class="chip" aria-pressed="${!!F.answers[q.id]?.has?.(c)}" data-c="${esc(c)}">${esc(c)}</button>`).join("")}</div><input class="wide" data-own="${esc(q.id)}" placeholder="Type my own" value="${esc(F.own[q.id] || "")}"></div>`).join("");
  return `${refs ? `<p class="ai-note">What Ollic AI sees in your pictures. Correct it if needed.</p>${refs}` : ""}${qs || `<p class="ai-note">No questions: Ollic AI has what it needs.</p>`}
    <label class="ai-field"><span>Anything else (optional)</span><textarea id="aiExtra" rows="2" maxlength="1000">${esc(F.extra || "")}</textarea></label>
    <div class="ai-foot"><span></span><button class="btn primary" type="button" id="aiAnswer">Continue to the plan</button></div>`;
}
function planHtml(app) {
  const F = app.aiFlow, esc = app.ui.esc;
  if (!F.plan.length) return `<p class="ai-note">Ollic AI has not written a plan yet (see its message above). Answer it here, then press Send.</p>
    <label class="ai-field"><span>Your answer</span><textarea id="aiTell" rows="3" maxlength="1000">${esc(F.tell || "")}</textarea></label>
    <div class="ai-foot"><span></span><button class="btn primary" type="button" id="aiReplan">Send</button></div>`;
  return `<p class="ai-note">Tick what to build. To change an item, write the change under it (for example "make the fins 150 mm apart").</p>
    <ol class="ai-plan">${F.plan.map((it, i) => `<li><label><input type="checkbox" data-on="${i}"${it.on ? " checked" : ""}> <span class="n">${it.n}</span><b>${esc(it.title)}</b></label>
      <div class="ai-meta">${esc(it.what)} · ${esc(it.where)}${it.sizes ? ` · ${esc(it.sizes)}` : ""}${it.material ? ` · ${esc(it.material)}` : ""}${it.image ? ` · from image ${it.image}` : ""}</div>
      <input class="wide" data-change="${i}" placeholder="Change in words (optional)" value="${esc(it.change)}"></li>`).join("")}</ol>
    <label class="ai-field"><span>Tell Ollic AI (optional): a question, or a change to the whole plan</span><textarea id="aiTell" rows="2" maxlength="1000">${esc(F.tell || "")}</textarea></label>
    <div class="ai-foot"><button class="btn" type="button" id="aiReplan">Rewrite plan with my changes</button><button class="btn primary" type="button" id="aiBuild">Build</button></div>`;
}
function progressHtml(app) {
  const F = app.aiFlow, esc = app.ui.esc;
  const ICON = { waiting: "○", building: "◐", done: "✓", failed: "✕" };
  const items = F.plan.filter(i => i.on).map(it => `<li class="${F.progress[it.n] || "waiting"}"><span>${ICON[F.progress[it.n] || "waiting"]}</span> ${it.n}. ${esc(it.title)}</li>`).join("");
  const rep = F.report ? `<div class="ai-report"><b>Report</b>${[["Built", F.report.built], ["Could not build, or simplified", F.report.not_built], ["Please check", F.report.please_check]].filter(([, l]) => l.length).map(([h, l]) => `<p>${h}:</p><ul>${l.map(x => `<li>${esc(x)}</li>`).join("")}</ul>`).join("")}</div>` : "";
  const chk = F.lastCheck ? `<p class="ai-note">Check round ${F.lastCheck.round}: ${F.lastCheck.ok ? "no problems found." : `${F.lastCheck.problems.length} problem${F.lastCheck.problems.length > 1 ? "s" : ""} found and fixed: ${esc(F.lastCheck.problems.map(p => p.problem).join("; "))}`}</p>` : "";
  const refused = F.log.filter(l => !l.ok).length;
  return `<ul class="ai-progress">${items}</ul>${chk}<p class="ai-note">${F.log.filter(l => l.ok && l.name !== "item_done").length} commands done${refused ? `, ${refused} refused by the checks and retried` : ""}.</p>${rep}
    ${F.step === "review" ? `<p class="ai-note">${hasProposal(app.doc) ? "Review the AI proposal below: accept, reject or change each item. Export is available once you accept or discard it." : "The proposal has been accepted or discarded."}</p>` : ""}`;
}

function wireFlow(app, box) {
  const F = app.aiFlow, q = s => box.querySelector(s);
  q("#aiRestart")?.addEventListener("click", async () => { if (!hasProposal(app.doc) || await app.ask("Start again? The current AI proposal stays until you accept or discard it.", "Start again")) { F.step = "idle"; start(app); } });
  q("#aiRecheck")?.addEventListener("click", () => { F.step = "idle"; start(app); });
  box.querySelectorAll("input[name=aiDetail]").forEach(r => r.onchange = () => { F.detail = r.value; estimate(app, box); });
  box.querySelectorAll("input[name=aiScope]").forEach(r => r.onchange = () => { F.scopeKind = r.value; });
  box.querySelectorAll(".aiLv").forEach(c => c.onchange = () => { F.levels = [...box.querySelectorAll(".aiLv:checked")].map(x => x.value); if (F.scopeKind !== "levels") { F.scopeKind = "levels"; render(app); } });
  const desc = q("#aiDesc"); if (desc) desc.oninput = () => { F.description = desc.value; };
  box.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { F.refs.splice(+b.dataset.rm, 1); render(app); });
  const files = q("#aiFiles");
  if (files) files.onchange = async () => {
    for (const f of [...files.files].slice(0, MAX_REFS - F.refs.length)) { try { F.refs.push({ name: f.name, dataUrl: await readPicture(f) }); } catch (e) { app.toast(e.message, true); } }
    render(app);
  };
  q("#aiStart")?.addEventListener("click", () => begin(app));
  if (q("#aiEst")) estimate(app, box);
  // questions
  box.querySelectorAll(".ai-q").forEach(div => {
    const id = div.dataset.q, qq = F.questions.find(x => x.id === id);
    div.querySelectorAll(".chip").forEach(c => c.onclick = () => {
      const set = F.answers[id] instanceof Set ? F.answers[id] : (F.answers[id] = new Set());
      if (!qq?.multiple) for (const v of [...set]) if (v !== c.dataset.c) set.delete(v);
      set.has(c.dataset.c) ? set.delete(c.dataset.c) : set.add(c.dataset.c);
      div.querySelectorAll(".chip").forEach(x => x.setAttribute("aria-pressed", String(set.has(x.dataset.c))));
    });
    const own = div.querySelector("[data-own]"); if (own) own.oninput = () => { F.own[id] = own.value; };
  });
  box.querySelectorAll("textarea[data-ref]").forEach(t => t.oninput = () => { const r = F.refs.find(x => x.n === +t.dataset.ref); if (r) r[t.dataset.k] = t.value; });
  const extra = q("#aiExtra"); if (extra) extra.oninput = () => { F.extra = extra.value; };
  q("#aiAnswer")?.addEventListener("click", () => sendAnswers(app).catch(e => fail(app, e)));
  // plan
  box.querySelectorAll("[data-on]").forEach(c => c.onchange = () => { F.plan[+c.dataset.on].on = c.checked; });
  box.querySelectorAll("[data-change]").forEach(c => c.oninput = () => { F.plan[+c.dataset.change].change = c.value; });
  const tell = q("#aiTell"); if (tell) tell.oninput = () => { F.tell = tell.value; };
  q("#aiReplan")?.addEventListener("click", () => {
    const ch = F.plan.filter(i => i.change.trim()).map(i => `item ${i.n}: ${i.change.trim()}`).join("; "), off = F.plan.filter(i => !i.on).map(i => i.n), told = (F.tell || "").trim();
    if (!ch && !off.length && !told) { app.toast("Write a change first."); return; }
    if (told) say(app, "you", told);
    F.tell = "";
    plan(app, [told, ch, off.length ? `leave out items ${off.join(", ")}` : ""].filter(Boolean).join("; "));
  });
  q("#aiPast")?.addEventListener("click", () => pastSessions(app));
  box.querySelectorAll("[data-past]").forEach(b => b.onclick = () => openPast(app, b.dataset.past));
  q("#aiPastBack")?.addEventListener("click", () => { F.step = "setup"; F.past = null; render(app); });
  q("#aiBuild")?.addEventListener("click", () => build(app));
  const chat = q("#aiChat"); if (chat) chat.scrollTop = chat.scrollHeight;
}

let estT = 0;
function estimate(app, box) {
  const F = app.aiFlow, el = box.querySelector("#aiEst"); if (!el) return;
  clearTimeout(estT);
  estT = setTimeout(async () => {
    try {
      const t = await transport(app);
      const kb = JSON.stringify(modelSummary(app.doc, scopeOf(app))).length / 1024, items = F.detail === "light" ? 5 : F.detail === "medium" ? 8 : 12;
      const e = t.estimate ? await t.estimate({ pictures: 7, references: F.refs.length, summary_kb: kb, items }) : null;
      if (e) el.textContent = `Estimated cost: ${usd(e.low_usd)}–${usd(e.high_usd)}`;
    } catch { /* the estimate is shown again when the session starts */ }
  }, 200);
}

// --------------------------------------------------------------------------- past sessions (what was done and why)
async function pastSessions(app) {
  const F = app.aiFlow;
  F.step = "past"; F.past = { list: null }; render(app);
  try { F.past.list = await (await transport(app)).list(app.store?.cloudId || null); } catch (e) { F.past.error = e.message; }
  render(app);
}
async function openPast(app, id) {
  const F = app.aiFlow;
  try { F.past.open = await (await transport(app)).get(id); } catch (e) { F.past.error = e.message; }
  render(app);
}
function pastHtml(app) {
  const F = app.aiFlow, esc = app.ui.esc, P = F.past || {};
  const back = `<button class="btn" type="button" id="aiPastBack">Back</button>`;
  if (P.error) return `<div class="err">${esc(P.error)}</div>${back}`;
  if (!P.list) return `<p class="ai-note">Loading…</p>${back}`;
  const when = t => new Date(t).toLocaleString();
  if (P.open) {
    const s = P.open, r = s.report || {};
    return `<p><b>${esc(when(s.created_at))}</b> · ${esc(s.status)} · ${esc(s.detail || "")} · cost ${usd(s.cost_usd)}</p>
      ${(s.refs || []).length ? `<div class="ai-refs">${s.refs.map(x => x.url ? `<figure><img src="${esc(x.url)}" alt="${esc(x.name || "")}"></figure>` : "").join("")}</div>` : ""}
      <div class="ai-chat">${(s.chat || []).map(m => `<div class="msg ${m.from === "ai" ? "ai" : "you"}"><b>${m.from === "ai" ? "Ollic AI" : "You"}</b> ${esc(m.text)}</div>`).join("")}</div>
      ${(s.plan || []).length ? `<p class="ai-note">Plan</p><ol class="ai-progress">${s.plan.map(i => `<li>${esc(`${i.n}. ${i.title}${i.on === false ? " (not built)" : ""}${i.change ? ` — your change: ${i.change}` : ""}`)}</li>`).join("")}</ol>` : ""}
      ${r.built ? `<div class="ai-report"><b>Report</b>${[["Built", r.built], ["Could not build, or simplified", r.not_built || []], ["Please check", r.please_check || []]].filter(([, l]) => l.length).map(([h, l]) => `<p>${h}:</p><ul>${l.map(x => `<li>${esc(x)}</li>`).join("")}</ul>`).join("")}</div>` : ""}
      <p class="ai-note">${(s.log || []).length} commands recorded${(s.log || []).filter(l => !l.ok).length ? `, ${(s.log || []).filter(l => !l.ok).length} refused by the checks` : ""}.</p>
      <details><summary>Commands</summary><ol class="ai-log">${(s.log || []).map(l => `<li>${l.ok ? "✓" : "✕"} ${esc(l.name)}${l.item != null ? ` (item ${l.item})` : ""}: ${esc(l.message || "")}</li>`).join("")}</ol></details>${back}`;
  }
  if (!P.list.length) return `<p class="ai-note">No sessions yet${app.store?.cloudId ? " for this sketch" : ""}.</p>${back}`;
  return `<ul class="ai-past">${P.list.map(s => `<li><button type="button" class="btn" data-past="${esc(s.id)}">${esc(when(s.created_at))} · ${esc(s.status)} · ${usd(s.cost_usd)}</button></li>`).join("")}</ul>${back}`;
}
