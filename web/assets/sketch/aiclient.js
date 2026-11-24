// The browser end of Ollic AI. The server holds the key and asks the assistant; the browser runs the commands it
// answers with (each checked in code by aitools.js) and sends back the results, step by step, until the assistant
// stops or asks something. A stand-in transport replaces the server in tests (no cost).
import { runTool, toolSchemas, TOOL_BY_NAME } from "./aitools.js";
import { captureViews, capture3D } from "./capture.js";
import { OPTION } from "./options.js";

/** The server transport: create a session, one step, save the record, add a reference image. */
export async function serverTransport() {
  const { api } = await import("../api.js");
  return {
    config: () => api.aiConfig(),
    estimate: q => api.aiEstimate(q),
    list: sketchId => api.aiSessions(sketchId),
    get: id => api.aiSession(id),
    createSession: body => api.aiCreateSession(body),
    step: (id, body) => api.aiStep(id, body),
    update: (id, body) => api.aiUpdateSession(id, body),
    addReference: (id, body) => api.aiAddReference(id, body),
  };
}

/** Model commands offered to the assistant (the server keeps only those each stage may use). */
export const offeredTools = () => toolSchemas();

const img = dataUrl => ({ type: "image", source: { type: "base64", media_type: dataUrl.slice(5, dataUrl.indexOf(";")), data: dataUrl.split(",")[1] } });
/** Pictures as message content: a caption, then the picture. */
export const pictureBlocks = (shots, label = "") => shots.flatMap(s => [{ type: "text", text: `${label}${s.name}${s.kind === "plan" ? " (ids written on it)" : ""}:` }, img(s.dataUrl)]);

/**
 * Runs one stage: asks, carries out every command in the answer, sends the results back, and repeats.
 *  - meta tools (ask_questions, write_plan, item_done, ...) go to onMeta(name, input) which returns
 *    { result: "text for the assistant", pause: true } to stop the loop (e.g. to wait for the person's answers);
 *  - onEvent({ type: "text" | "tool" | "cost", ... }) reports progress as it happens.
 * Returns { messages, paused, meta: [{ name, input }], cost }.
 */
export async function runStage(app, { transport, session, stage, messages, onMeta = () => ({}), onEvent = () => {}, maxSteps = 40, ctx = {} }) {
  const meta = [];
  let cost = 0, paused = null;
  const toolCtx = { source: "ai", session: session.id, option: OPTION, ...ctx };
  for (let stepNo = 0; stepNo < maxSteps; stepNo++) {
    const res = await transport.step(session.id, { stage, messages, tools: offeredTools() });
    cost = res.session_cost_usd ?? cost + (res.cost_usd || 0);
    onEvent({ type: "cost", stage, cost, step: res.cost_usd });
    const content = res.content || [];
    messages = [...messages, { role: "assistant", content }];
    for (const b of content) if (b.type === "text" && b.text.trim()) onEvent({ type: "text", text: b.text });
    const uses = content.filter(b => b.type === "tool_use");
    if (!uses.length) break;
    const results = [];
    for (const u of uses) {
      const T = TOOL_BY_NAME[u.name];
      if (!T) {
        meta.push({ name: u.name, input: u.input });
        const r = (await onMeta(u.name, u.input || {})) || {};
        results.push({ type: "tool_result", tool_use_id: u.id, content: r.result || "Noted." });
        if (r.pause) paused = paused || { name: u.name, input: u.input };
        continue;
      }
      if (u.name === "capture_views") {
        const a = u.input || {};
        const shots = await captureViews(app, { views: a.views?.length ? a.views : undefined, style: a.style || "clay", plans: a.plans !== false });
        results.push({ type: "tool_result", tool_use_id: u.id, content: [{ type: "text", text: `${shots.length} pictures.` }, ...pictureBlocks(shots)] });
        onEvent({ type: "tool", name: u.name, ok: true, message: `${shots.length} pictures` });
        continue;
      }
      const r = runTool(app.history, u.name, u.input || {}, toolCtx);
      onEvent({ type: "tool", name: u.name, ok: r.ok, message: r.ok ? r.message || "" : r.error, ids: r.ids, planItem: u.input?.plan_item });
      results.push({ type: "tool_result", tool_use_id: u.id, content: r.ok ? JSON.stringify(r.result ?? { ids: r.ids, message: r.message }) : r.error, ...(r.ok ? {} : { is_error: true }) });
    }
    messages = [...messages, { role: "user", content: results }];
    if (paused) break;
  }
  return { messages, paused, meta, cost };
}

/** Fresh pictures for a check round: clay views, one material view, and plans. */
export async function checkPictures(app) {
  return [...await captureViews(app, { style: "clay" }), ...await capture3D(app, ["sw"], { style: "material" })];
}

/**
 * A stand-in for the server and the assistant, for tests and demonstrations without cost: `script(stage, messages,
 * n)` returns the assistant's content blocks for each step (n counts steps within the stage).
 */
export function standInTransport(script, { costPerStep = 0.05 } = {}) {
  let total = 0, n = {}, sessions = 0;
  const calls = [];
  return {
    calls,
    config: async () => ({ available: true, max_references: 6 }),
    estimate: async () => ({ low_usd: 0.4, high_usd: 1.2, model: "stand-in" }),
    createSession: async function (body) { const s = { id: `standin-${++sessions}`, status: "open", created_at: new Date().toISOString(), cost_usd: 0, estimate: { low_usd: 0.4, high_usd: 1.2, model: "stand-in" }, ...body }; this.records[s.id] = s; return s; },
    step: async (id, body) => {
      calls.push({ id, stage: body.stage, messages: body.messages, tools: body.tools.map(t => t.name) });
      n[body.stage] = (n[body.stage] || 0) + 1;
      const content = await script(body.stage, body.messages, n[body.stage] - 1);
      total += costPerStep;
      return { content, stop_reason: content.some(b => b.type === "tool_use") ? "tool_use" : "end_turn", cost_usd: costPerStep, session_cost_usd: total, usage: { input_tokens: 1000, output_tokens: 100 } };
    },
    records: {},
    update: async function (id, body) { this.records[id] = { ...(this.records[id] || { id, created_at: new Date().toISOString(), status: "open", cost_usd: 0 }), ...body, cost_usd: total }; return this.records[id]; },
    list: async function () { return Object.values(this.records); },
    get: async function (id) { return this.records[id]; },
    addReference: async (id, body) => ({ n: 1, path: `stand-in/${id}/1.jpg`, name: body.name, data_url: body.data_url }),
  };
}
let uid = 0;
/** A tool call block, for stand-in scripts. */
export const use = (name, input) => ({ type: "tool_use", id: `tu_${++uid}`, name, input });
/** The tool results in the last message (what the browser sent back). */
/** Adds to the conversation as the person: joined to the last message when that is theirs (tool results). */
export function addUser(messages, content) {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content, last = messages.at(-1);
  if (last?.role === "user") return [...messages.slice(0, -1), { role: "user", content: [...(typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content), ...blocks] }];
  return [...messages, { role: "user", content: blocks }];
}
export const lastResults = messages => (messages.at(-1)?.content || []).filter(b => b.type === "tool_result");
