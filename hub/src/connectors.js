// Finds running design tools that have the Ollic Sketch helper loaded, and talks to them.
// Each helper listens on 127.0.0.1 only and writes a small file announcing its port:
//   %LOCALAPPDATA%\OllicSketch\instances\<app>-<pid>.json
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";

export const dataDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "OllicSketch");
const instancesDir = path.join(dataDir, "instances");

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** Running instances of one app (newest first). Stale files from crashed sessions are removed. */
export function instances(app) {
  let files = [];
  try { files = fs.readdirSync(instancesDir).filter((f) => f.startsWith(app + "-") && f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const f of files) {
    const full = path.join(instancesDir, f);
    try {
      const info = JSON.parse(fs.readFileSync(full, "utf8"));
      if (!alive(info.pid)) { try { fs.unlinkSync(full); } catch {} continue; }
      out.push(info);
    } catch {}
  }
  return out.sort((a, b) => String(b.started).localeCompare(String(a.started)));
}

/** Sends one command and waits for one reply line. */
export function send(port, tool, args, timeoutMs = 6 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port });
    let buf = "";
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("The design tool did not answer in time. Close any open dialog in it and try again.")); }, timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ tool, args: args || {} }) + "\n"));
    sock.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i >= 0) {
        clearTimeout(timer);
        sock.end();
        try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(new Error("Unreadable reply from the design tool.")); }
      }
    });
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

const NOT_RUNNING = {
  revit: "Revit is not connected. Open Revit 2024 or later on this computer (with the Ollic Sketch helper installed by setup) and open a project, then try again.",
  blender: "Blender is not connected. Open Blender 4.2 or later on this computer (with the Ollic Sketch add-on installed by setup), then try again.",
};

/** Calls a tool on the newest running instance of an app. Throws a plain-language error when it is not running. */
export async function call(app, tool, args) {
  const list = instances(app);
  if (list.length === 0) throw new Error(NOT_RUNNING[app] || `${app} is not connected.`);
  const reply = await send(list[0].port, tool, args).catch((e) => {
    if (e.code === "ECONNREFUSED") throw new Error(NOT_RUNNING[app]);
    throw e;
  });
  if (!reply.ok) throw new Error(reply.error || "The design tool reported an error.");
  return reply.result;
}

export async function status() {
  const res = {};
  for (const app of ["revit", "blender"]) {
    const list = instances(app);
    res[app] = [];
    for (const i of list) {
      try { await send(i.port, "ping", {}, 3000); res[app].push({ version: i.version, port: i.port, connected: true }); }
      catch { res[app].push({ version: i.version, port: i.port, connected: false }); }
    }
  }
  return res;
}
