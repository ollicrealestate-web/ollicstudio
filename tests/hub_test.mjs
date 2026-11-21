// Starts stand-in Revit and Blender helpers (same wire protocol), then drives the hub like Claude Desktop does.
import net from "node:net"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn } from "node:child_process";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ollic-")); process.env.LOCALAPPDATA = tmp;
const dir = path.join(tmp, "OllicSketch", "instances"); fs.mkdirSync(dir, { recursive: true });
const seen = [];
function fake(app) {
  const srv = net.createServer((sock) => { let buf = ""; sock.setEncoding("utf8");
    sock.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const req = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); seen.push([app, req.tool]);
      const res = req.tool === "get_quantities" ? { walls_by_thickness: [{ thickness_mm: 225, net_area_m2: 100 }], doors: { a: 2 }, windows: { b: 3 }, floors: { volume_m3: 10 } } : { app, tool: req.tool };
      sock.write(JSON.stringify({ ok: true, result: res }) + "\n"); } }); });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => { fs.writeFileSync(path.join(dir, `${app}-${process.pid}.json`), JSON.stringify({ app, version: "test", port: srv.address().port, pid: process.pid, started: new Date().toISOString() })); r(srv); }));
}
const servers = [await fake("revit"), await fake("blender")];
const hub = spawn(process.execPath, [new URL("../hub/src/index.js", import.meta.url).pathname], { env: process.env, stdio: ["pipe", "pipe", "inherit"] });
let buf = ""; const waits = new Map(); let id = 0;
hub.stdout.setEncoding("utf8"); hub.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waits.get(m.id)?.(m); } });
const rpc = (method, params) => new Promise((r) => { const n = ++id; waits.set(n, r); hub.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
const fails = [];
await rpc("initialize", { protocolVersion: "2025-06-18" });
const tools = (await rpc("tools/list", {})).result.tools;
console.log(tools.length, "tools");
for (const t of tools) {
  if (t.inputSchema.type !== "object") fails.push("bad schema " + t.name);
  const r = await rpc("tools/call", { name: t.name, arguments: {} });
  if (r.error) fails.push(t.name + " " + r.error.message);
  if (r.result?.isError) fails.push(t.name + ": " + r.result.content[0].text);
}
for (const app of ["revit", "blender"]) if (!seen.some((s) => s[0] === app)) fails.push("no calls reached " + app);
const manifest = JSON.parse(fs.readFileSync(new URL("../hub/manifest.json", import.meta.url)));
const names = new Set(tools.map((t) => t.name));
for (const t of manifest.tools) if (!names.has(t.name)) fails.push("manifest lists missing tool " + t.name);
if (manifest.tools.length !== tools.length) fails.push(`manifest has ${manifest.tools.length} tools, hub has ${tools.length}`);
hub.kill(); servers.forEach((s) => s.close());
console.log(fails.length ? "HUB FAILED\n" + fails.join("\n") : "HUB PASSED (" + seen.length + " calls reached the stand-ins)");
process.exit(fails.length ? 1 : 0);
