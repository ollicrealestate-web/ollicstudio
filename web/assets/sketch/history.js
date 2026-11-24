// Every change goes through a transaction: the change is recorded as a list of element
// edits (added, removed, changed, by id), so Undo and Redo replay exactly what happened.
import { COLLECTIONS, clone } from "./model.js";

function index(doc) {
  const m = new Map();
  for (const k of COLLECTIONS) doc[k].forEach((e, i) => m.set(e.id, { k, i, json: JSON.stringify(e) }));
  return m;
}

export class History {
  constructor(doc) {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.version = 0;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(info) { this.version++; for (const fn of this.listeners) fn(info); }

  /**
   * Runs fn(doc) as one undoable step. If fn throws, the document is restored and the error is rethrown,
   * so a refused edit (e.g. an 11th level) never leaves half a change behind.
   */
  transact(label, fn) {
    const before = index(this.doc);
    const docFields = JSON.stringify({ name: this.doc.name, settings: this.doc.settings });
    const backup = clone(this.doc);
    let result;
    try {
      result = fn(this.doc);
    } catch (err) {
      Object.assign(this.doc, backup);
      throw err;
    }
    const after = index(this.doc);
    const ops = [];
    for (const [id, a] of after) {
      const b = before.get(id);
      if (!b) ops.push({ op: "add", k: a.k, i: a.i, after: JSON.parse(a.json) });
      else if (b.json !== a.json) ops.push({ op: "set", k: a.k, id, before: JSON.parse(b.json), after: JSON.parse(a.json) });
    }
    for (const [id, b] of before) if (!after.has(id)) ops.push({ op: "del", k: b.k, i: b.i, before: JSON.parse(b.json) });
    const fieldsAfter = JSON.stringify({ name: this.doc.name, settings: this.doc.settings });
    if (fieldsAfter !== docFields) ops.push({ op: "doc", before: JSON.parse(docFields), after: JSON.parse(fieldsAfter) });
    if (!ops.length) return result;
    this.undoStack.push({ label, ops });
    this.redoStack = [];
    this.emit({ label, ops, kind: "do" });
    return result;
  }

  /** Joins the steps at the top of the undo list that match `test` into one step called `label` (one undo per item). */
  squash(test, label) {
    let k = this.undoStack.length;
    while (k > 0 && test(this.undoStack[k - 1])) k--;
    const steps = this.undoStack.slice(k);
    if (steps.length < 2) { if (steps[0]) steps[0].label = label; return steps.length; }
    this.undoStack.splice(k, steps.length, { label, ops: steps.flatMap(s => s.ops) });
    return steps.length;
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    const step = this.undoStack.pop();
    if (!step) return null;
    this.apply(step.ops, true);
    this.redoStack.push(step);
    this.emit({ label: step.label, ops: step.ops, kind: "undo" });
    return step.label;
  }

  redo() {
    const step = this.redoStack.pop();
    if (!step) return null;
    this.apply(step.ops, false);
    this.undoStack.push(step);
    this.emit({ label: step.label, ops: step.ops, kind: "redo" });
    return step.label;
  }

  apply(ops, reverse) {
    const d = this.doc;
    const list = reverse ? [...ops].reverse() : ops;
    // removals first (highest index first) so positions stay valid, then additions in index order
    const adds = [], dels = [];
    for (const o of list) {
      if (o.op === "doc") { Object.assign(d, clone(reverse ? o.before : o.after)); continue; }
      if (o.op === "set") {
        const arr = d[o.k];
        const i = arr.findIndex(e => e.id === o.id);
        if (i >= 0) arr[i] = clone(reverse ? o.before : o.after);
        continue;
      }
      const isAdd = (o.op === "add") !== reverse;
      (isAdd ? adds : dels).push(o);
    }
    for (const o of dels) {
      const el = o.after || o.before;
      const arr = d[o.k];
      const i = arr.findIndex(e => e.id === el.id);
      if (i >= 0) arr.splice(i, 1);
    }
    adds.sort((a, b) => a.i - b.i);
    for (const o of adds) {
      const el = clone(o.before || o.after);
      const arr = d[o.k];
      arr.splice(Math.min(o.i, arr.length), 0, el);
    }
  }

  /** Replace the whole document (open / load). Clears undo. */
  reset(doc) {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.emit({ kind: "reset" });
  }
}
