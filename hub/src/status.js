// Quick check from a terminal: which design tools are connected?
import { status } from "./connectors.js";

const s = await status();
const revit = s.revit || [];
for (const b of s.blender || []) console.log(`Blender ${b.version}: ${b.connected ? "connected" : "not answering"} (port ${b.port})`);
if (!(s.blender || []).length) console.log("Blender: not connected. Open Blender.");
if (revit.length === 0) console.log("Revit: not connected. Open Revit and a project.");
for (const r of revit) console.log(`Revit ${r.version}: ${r.connected ? "connected" : "not answering"} (port ${r.port})`);
