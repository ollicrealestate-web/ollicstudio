// The Ollic AI panel (right side of the workspace). This part shows the design option "AI proposal": before/after,
// a compare slider, and the list of proposed items to accept, reject or change; Accept all and Discard.
import { OPTION_NAME, hasProposal, proposalItems, acceptIds, rejectIds, acceptAll, discardAll } from "./options.js";

const $ = s => document.querySelector(s);

export function initAiPanel(app) {
  app.showProposal = true;
  app.hiddenOption = el => !app.showProposal && el?.option === "ai-proposal";
  app.aiPanel = { open: false, render: () => renderAiPanel(app), show: () => { app.aiPanel.open = true; renderAiPanel(app); }, hide: () => { app.aiPanel.open = false; renderAiPanel(app); } };
  app.history.onChange(() => { if (hasProposal(app.doc) && !app.aiPanel.open) app.aiPanel.open = true; renderAiPanel(app); });
}

function setShown(app, on) { app.showProposal = on; app.view3d.invalidate(); app.redraw(true); renderAiPanel(app); }

export function renderAiPanel(app) {
  const box = $("#aiPanel"); if (!box) return;
  box.hidden = !app.aiPanel.open;
  document.body.classList.toggle("ai-open", app.aiPanel.open);
  if (!app.aiPanel.open) return;
  const esc = app.ui.esc, doc = app.doc, items = proposalItems(doc), any = items.length > 0;
  const extra = app.aiPanel.extraHtml?.() || "";
  box.innerHTML = `<div class="ai-head"><b>Ollic AI</b><button class="icon-btn" type="button" id="aiClose" title="Close" aria-label="Close">×</button></div>
    ${extra}
    <section class="ai-prop" aria-label="${OPTION_NAME}">
      <div class="ai-row"><b>${OPTION_NAME}</b><span class="ai-count">${any ? `${items.length} item${items.length > 1 ? "s" : ""}` : "nothing proposed"}</span></div>
      ${any ? `<div class="ai-seg" role="group" aria-label="Show"><button type="button" id="aiBefore" aria-pressed="${!app.showProposal}">Before</button><button type="button" id="aiAfter" aria-pressed="${app.showProposal}">After</button><button type="button" id="aiCompare">Compare</button></div>
      <ol class="ai-items">${items.map(it => `<li data-key="${esc(it.key)}"><button type="button" class="ai-title" data-act="select">${it.planItem != null ? `<span class="n">${it.planItem}</span>` : ""}${esc(it.title)}</button>
        <span class="ai-meta">${it.ids.length ? `${it.ids.length} part${it.ids.length > 1 ? "s" : ""}` : ""}${it.materialIds.length ? `${it.ids.length ? ", " : ""}material on ${it.materialIds.length}` : ""}</span>
        <span class="ai-acts"><button type="button" class="btn" data-act="accept">Accept</button><button type="button" class="btn" data-act="reject">Reject</button><button type="button" class="btn" data-act="change">Change</button></span></li>`).join("")}</ol>
      <div class="ai-foot"><button type="button" class="btn" id="aiDiscard">Discard all</button><button type="button" class="btn primary" id="aiAcceptAll">Accept all</button></div>
      <p class="ai-note">Your model stays as you drew it until you accept. Undo reverses each accept or reject.</p>` : `<p class="ai-note">When Ollic AI builds, its additions are kept here as the ${OPTION_NAME}, apart from your model, until you accept them.</p>`}
    </section>`;
  $("#aiClose").onclick = () => app.aiPanel.hide();
  app.aiPanel.wire?.(box);
  if (!any) return;
  $("#aiBefore").onclick = () => setShown(app, false);
  $("#aiAfter").onclick = () => setShown(app, true);
  $("#aiCompare").onclick = () => compare(app);
  $("#aiAcceptAll").onclick = () => { app.commit(`Accept all (${OPTION_NAME})`, doc => acceptAll(doc)); app.aiPanel.closed?.("accepted"); app.toast("The proposal is now part of your model. Everything in it can be edited by hand."); };
  $("#aiDiscard").onclick = async () => { if (await app.ask(`Discard the whole ${OPTION_NAME}? Your model stays as it is.`, "Discard")) { app.commit(`Discard ${OPTION_NAME}`, doc => discardAll(doc)); app.aiPanel.closed?.("discarded"); } };
  box.querySelectorAll(".ai-items li").forEach(li => {
    const it = items.find(x => x.key === li.dataset.key), all = [...it.ids, ...it.materialIds];
    li.querySelectorAll("button[data-act]").forEach(b => b.onclick = () => {
      const act = b.dataset.act;
      if (act === "select") { app.setTool("select"); app.selection = new Set(all); app.selectionChanged(); if (!app.showProposal) setShown(app, true); return; }
      if (act === "accept") app.commit(`Accept: ${it.title}`, doc => acceptIds(doc, all));
      if (act === "reject") app.commit(`Reject: ${it.title}`, doc => rejectIds(doc, all));
      if (act === "change") (app.aiPanel.change || defaultChange)(app, it);
    });
  });
}

/** Without the assistant connected, Change edits the item's first part by hand. */
function defaultChange(app, it) {
  const id = it.ids[0]; if (!id) { app.toast("Select the element and choose a material in Properties."); return; }
  app.setTool("select"); app.selection = new Set([id]); app.selectionChanged();
  document.querySelector("#dEdit")?.click();
}

/** Before and after, side by side in one picture with a slider. */
export async function compare(app) {
  const v = app.view3d, el = document.getElementById("view3d"), w = Math.max(320, el.clientWidth), h = Math.max(240, el.clientHeight);
  const keep = app.showProposal;
  const shot = async on => { app.showProposal = on; v.invalidate(); return v.snapshot(w, h); };
  let before, after;
  try { before = await shot(false); after = await shot(true); } finally { app.showProposal = keep; v.invalidate(); }
  const url = c => (typeof c === "string" ? c : c.toDataURL ? c.toDataURL("image/png") : URL.createObjectURL(c));
  app.ui.openDialog(`<h3>Before and after</h3><p>Drag the slider: left of it is your model, right of it the ${OPTION_NAME}. Turn the 3D view first to compare from another side.</p>
    <div class="cmp" style="aspect-ratio:${w}/${h}"><img alt="After" src="${url(after)}"><div class="cmp-before" id="cmpBefore"><img alt="Before" src="${url(before)}" style="width:${100 * 100 / 50}%"></div><div class="cmp-line" id="cmpLine"></div>
      <span class="cmp-tag l">Before</span><span class="cmp-tag r">After</span></div>
    <input type="range" id="cmpSlider" min="0" max="100" value="50" aria-label="Before and after" style="width:100%">
    <div class="actions"><button class="btn" type="button" id="cmpClose">Close</button></div>`, d => {
    const s = d.querySelector("#cmpSlider"), b = d.querySelector("#cmpBefore"), line = d.querySelector("#cmpLine"), img = b.querySelector("img");
    const set = () => { const p = Math.max(0.5, +s.value); b.style.width = `${p}%`; img.style.width = `${(100 * 100) / p}%`; line.style.left = `${p}%`; };
    s.oninput = set; set();
    d.querySelector("#cmpClose").onclick = app.ui.closeDialog;
  });
}
