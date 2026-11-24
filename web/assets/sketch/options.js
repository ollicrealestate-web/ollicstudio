// The design option "AI proposal": everything Ollic AI adds is kept in it, apart from your model, until you accept or
// reject it. Added elements carry option: "ai-proposal"; materials it proposes for your elements are kept in
// el.proposed (your element's own material is untouched). Accepting merges them into the model; rejecting removes them.
// Each accept or reject is one undoable step (done through history.transact by the caller).

export const OPTION = "ai-proposal";
export const OPTION_NAME = "AI proposal";
const COLLS = ["details", "components"];

export const inProposal = el => el?.option === OPTION;
export const hasProposal = doc => COLLS.some(k => (doc[k] || []).some(inProposal)) || proposedOn(doc).length > 0;
/** Your elements with a proposed material. */
export const proposedOn = doc => ["walls", "floors", "roofs", "openings", "components", "details"].flatMap(k => (doc[k] || []).filter(e => e.proposed?.[OPTION]));

/** The material an element shows: the proposed one while the proposal is shown. */
export function shownMaterial(el, showProposal) { const p = showProposal && el.proposed?.[OPTION]; return (p && p.material) || el.material; }
export function shownFinishes(el, showProposal) { const p = showProposal && el.proposed?.[OPTION]; return p?.finishes ? { ...(el.finishes || {}), ...p.finishes } : el.finishes; }

/** Proposes a material for one of your elements (kept apart until accepted). */
export function proposeMaterial(el, material, face, planItem) {
  const p = { ...(el.proposed?.[OPTION] || {}) };
  if (planItem != null) p.planItem = planItem;
  if (face) p.finishes = { ...(p.finishes || {}), [face]: material }; else p.material = material;
  el.proposed = { ...(el.proposed || {}), [OPTION]: p };
}

/**
 * The proposal's items for the review list: grouped by plan item (or one per element without one).
 * [{ key, planItem, title, ids, materialIds }]
 */
export function proposalItems(doc) {
  const plan = doc.settings?.ai?.plan || [], groups = new Map();
  const put = (key, planItem, id, isMat) => { if (!groups.has(key)) groups.set(key, { key, planItem, ids: [], materialIds: [] }); groups.get(key)[isMat ? "materialIds" : "ids"].push(id); };
  for (const k of COLLS) for (const e of doc[k] || []) if (inProposal(e)) put(e.planItem != null ? `p${e.planItem}` : e.id, e.planItem ?? null, e.id, false);
  for (const e of proposedOn(doc)) { const pi = e.proposed[OPTION].planItem; put(pi != null ? `p${pi}` : `m-${e.id}`, pi ?? null, e.id, true); }
  const out = [...groups.values()].map(g => {
    const p = plan.find(x => x.n === g.planItem);
    const first = g.ids.map(id => [...doc.details, ...doc.components].find(e => e.id === id)).find(Boolean);
    return { ...g, title: p?.text || (first ? first.name || first.kind : `Material on ${g.materialIds.join(", ")}`) };
  });
  return out.sort((a, b) => (a.planItem ?? 1e9) - (b.planItem ?? 1e9));
}

/** Accepts these elements (or proposed materials) into the model. */
export function acceptIds(doc, ids) {
  const set = new Set(ids);
  for (const k of COLLS) for (const e of doc[k]) if (set.has(e.id) && inProposal(e)) delete e.option;
  for (const e of proposedOn(doc)) {
    if (!set.has(e.id)) continue;
    const p = e.proposed[OPTION];
    if (p.material) e.material = p.material;
    if (p.finishes) e.finishes = { ...(e.finishes || {}), ...p.finishes };
    dropProposed(e);
  }
}
/** Removes these proposal elements (and proposed materials). */
export function rejectIds(doc, ids) {
  const set = new Set(ids);
  for (const k of COLLS) doc[k] = doc[k].filter(e => !(set.has(e.id) && inProposal(e)));
  for (const e of proposedOn(doc)) if (set.has(e.id)) dropProposed(e);
}
function dropProposed(e) { delete e.proposed[OPTION]; if (!Object.keys(e.proposed).length) delete e.proposed; }
const allIds = doc => proposalItems(doc).flatMap(i => [...i.ids, ...i.materialIds]);
export const acceptAll = doc => { acceptIds(doc, allIds(doc)); closePlan(doc, "accepted"); };
export const discardAll = doc => { rejectIds(doc, allIds(doc)); closePlan(doc, "discarded"); };
function closePlan(doc, how) { if (doc.settings?.ai) doc.settings = { ...doc.settings, ai: { ...doc.settings.ai, closed: how } }; }
