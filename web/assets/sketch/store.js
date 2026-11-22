// Saving: every change is kept in this browser at once (crash recovery), and signed-in users'
// sketches are saved to their account every 30 seconds, on Save, and when they leave the page.
import { api } from "../api.js";
import { accessToken } from "../session.js";
import { normalize } from "./model.js";

const LOCAL = "ollic.sketch.autosave";
const PREFS = "ollic.sketch.prefs";
const AUTOSAVE_MS = 30000;

export function readLocal() { try { return JSON.parse(localStorage.getItem(LOCAL) || "null"); } catch { return null; } }
export function readPrefs() { try { return JSON.parse(localStorage.getItem(PREFS) || "{}") || {}; } catch { return {}; } }
export function writePrefs(p) { try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch { /* private mode */ } }

export class Store {
  constructor(app) {
    this.app = app;
    this.cloudId = null;
    this.cloudSavedVersion = -1; // history.version at the last successful account save
    this.localTimer = 0;
    this.saving = false;
    this.signedIn = false;
    this.lastError = "";
    setInterval(() => this.autosave(), AUTOSAVE_MS);
    addEventListener("pagehide", () => { this.saveLocalNow(); this.flushOnLeave(); });
    addEventListener("beforeunload", e => {
      this.saveLocalNow();
      if (this.signedIn && this.unsaved()) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  async init() {
    this.signedIn = !!(await accessToken().catch(() => null));
    this.render();
  }

  unsaved() { return this.app.history.version !== this.cloudSavedVersion; }

  changed() {
    clearTimeout(this.localTimer);
    this.localTimer = setTimeout(() => this.saveLocalNow(), 600);
    this.render();
  }

  saveLocalNow() {
    try {
      localStorage.setItem(LOCAL, JSON.stringify({ doc: this.app.doc, cloudId: this.cloudId, savedAt: new Date().toISOString(), cloudVersionSaved: this.unsaved() ? null : true }));
    } catch { /* storage full or blocked: the account copy still works */ }
  }

  async autosave() {
    this.saveLocalNow();
    if (this.signedIn && this.unsaved() && !this.saving) await this.save({ quiet: true });
  }

  /** Saves to the account. Returns true on success. */
  async save({ quiet = false, asCopy = false } = {}) {
    if (!this.signedIn) {
      this.signedIn = !!(await accessToken().catch(() => null));
      if (!this.signedIn) { if (!quiet) this.app.toast("Saved in this browser. Sign in on the studio page to keep sketches in your account."); this.render(); return false; }
    }
    if (this.saving) return false;
    this.saving = true; this.render();
    const version = this.app.history.version;
    const doc = this.app.doc;
    try {
      if (asCopy || !this.cloudId) {
        const name = asCopy ? `${doc.name} (copy)` : doc.name;
        const body = { name, doc: asCopy ? { ...doc, name } : doc };
        const row = await api.createSketch(body);
        if (asCopy) this.app.renameSilently(name);
        this.cloudId = row.id;
        history.replaceState(null, "", `?id=${row.id}`);
      } else {
        await api.updateSketch(this.cloudId, { name: doc.name, doc });
      }
      this.cloudSavedVersion = version;
      this.lastSaved = new Date();
      this.lastError = "";
      this.saveLocalNow();
      if (!quiet) this.app.toast(asCopy ? "Saved as a copy." : "Saved to your account.");
      return true;
    } catch (err) {
      this.lastError = err.message || "Could not save.";
      if (err.status === 401) this.signedIn = false;
      if (!quiet) this.app.toast(this.lastError + " Your work is still kept in this browser.", true);
      return false;
    } finally {
      this.saving = false; this.render();
    }
  }

  /** Last-chance save when the tab closes (small sketches only: browsers cap keepalive bodies at 64 KB). */
  flushOnLeave() {
    if (!this.signedIn || !this.cloudId || !this.unsaved()) return;
    const body = JSON.stringify({ name: this.app.doc.name, doc: this.app.doc });
    if (body.length > 60000) return;
    const s = (() => { try { return JSON.parse(localStorage.getItem("ollic.session") || "null"); } catch { return null; } })();
    if (!s?.access_token) return;
    const base = (window.OLLIC_CONFIG?.apiUrl || "").replace(/\/$/, "") + "/api";
    fetch(`${base}/sketches/${this.cloudId}`, { method: "PUT", keepalive: true, headers: { Authorization: `Bearer ${s.access_token}`, "Content-Type": "application/json" }, body }).catch(() => {});
  }

  async list() { return api.listSketches(); }

  /** Opens a sketch from the account; prefers this browser's newer copy of the same sketch (after a crash). */
  async open(id) {
    const row = await api.getSketch(id);
    let doc = normalize(row.doc);
    let recovered = false;
    const local = readLocal();
    if (local?.cloudId === id && local.doc && !local.cloudVersionSaved && new Date(local.savedAt) > new Date(row.updated_at)) {
      try { doc = normalize(local.doc); recovered = true; } catch { /* keep the account copy */ }
    }
    this.cloudId = id;
    this.app.loadDoc(doc);
    this.cloudSavedVersion = recovered ? -1 : this.app.history.version;
    this.lastSaved = new Date(row.updated_at);
    history.replaceState(null, "", `?id=${id}`);
    this.render();
    return { recovered, savedAt: local?.savedAt };
  }

  async remove(id) { await api.deleteSketch(id); if (id === this.cloudId) { this.cloudId = null; history.replaceState(null, "", location.pathname); } }

  startNew(doc) {
    this.cloudId = null;
    this.app.loadDoc(doc);
    this.cloudSavedVersion = -1;
    history.replaceState(null, "", location.pathname);
    this.saveLocalNow();
    this.render();
  }

  render() {
    const el = document.getElementById("saveState");
    if (!el) return;
    el.classList.remove("warn");
    if (this.saving) el.textContent = "Saving…";
    else if (!this.signedIn) { el.textContent = "Kept in this browser · sign in to save to your account"; el.classList.add("warn"); }
    else if (this.lastError && this.unsaved()) { el.textContent = "Not saved to your account yet · kept in this browser"; el.classList.add("warn"); }
    else if (this.unsaved()) el.textContent = this.cloudId ? "Unsaved changes · autosave every 30 s" : "Not saved yet";
    else el.textContent = `Saved ${this.lastSaved ? this.lastSaved.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}`;
  }
}
