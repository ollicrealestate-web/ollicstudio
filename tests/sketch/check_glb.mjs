// Validates the GLB written by the phase 8 browser test with the Khronos glTF validator.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const validator = require("gltf-validator");
const dir = process.argv[2] || "out/sketch";
const files = readdirSync(dir).filter(f => f.endsWith(".glb"));
if (!files.length) { console.log("no GLB found: run tests/sketch/e2e_phase8.mjs first"); process.exit(1); }
let bad = 0;
for (const f of files) {
  const r = await validator.validateBytes(new Uint8Array(readFileSync(`${dir}/${f}`)));
  const e = r.issues.numErrors;
  console.log(`${e ? "FAIL" : "ok  "} ${f}: ${e} errors, ${r.issues.numWarnings} warnings (Khronos glTF validator ${r.validatorVersion})`);
  if (e) { bad++; console.log(r.issues.messages.filter(m => m.severity === 0).slice(0, 10)); }
}
process.exit(bad ? 1 : 0);
