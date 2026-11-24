// Which library material an IFC material is: by its exact name (Ollic Sketch files, or a name that is already a
// library name), then by the words in its name (Revit and ArchiCAD names), then by its class and colour.
// how: "ifc" (From your IFC), "name" (Matched from its name), "guess" (Guessed). "user" (Set by you) comes later.
import { MATERIALS, BY_CLASS, TINTABLE, materialById } from "./library.js";

const RE = new Map(MATERIALS.map(m => [m.id, new RegExp(m.words, "i")]));
const BY_NAME = new Map(MATERIALS.map(m => [m.name.toLowerCase(), m]));
const hex = rgba => "#" + rgba.slice(0, 3).map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
/** A colour that says something (not a default white or mid grey). */
const telling = rgba => { if (!rgba) return false; const [r, g, b] = rgba, mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx - mn > 0.06 || mx < 0.55 || mx > 0.97 && mn < 0.9; };
const clean = s => String(s || "").replace(/^(material|mat|m)\s*[:\-_]\s*/i, "").replace(/\s+/g, " ").trim();

/**
 * part: { name (the part's own material or surface style name), names (the element's material names), ollic (Ollic
 * Sketch's material name), cls (class from the reader), rgba, parts (how many parts the element has) }.
 * Returns { id, how, tint (hex or null), ifcName }.
 */
export function matchMaterial({ name = null, names = [], ollic = null, cls = "paint", rgba = null, parts = 1 }) {
  const seeThrough = rgba && rgba[3] < 0.95;
  const ok = m => (seeThrough ? m.cls === "glass" : !(m.cls === "glass" && parts > 1));   // the glass of a window is its see-through part
  const cands = [name, ollic, ...names].map(clean).filter(Boolean);   // the part's own name first (a railing: its glass and its frame)
  // 1. exactly a library name (the part's own name is trusted as it is: it names that very surface)
  const own = clean(name), exact = own && BY_NAME.get(own.toLowerCase());
  if (exact) return { id: exact.id, how: "ifc", tint: null, ifcName: own };
  for (const c of cands) { const m = BY_NAME.get(c.toLowerCase()); if (m && ok(m)) return { id: m.id, how: "ifc", tint: null, ifcName: c }; }
  // 2. the words in the name: the most specific match (longest matched text), the part's own name first
  for (const c of cands) {
    let best = null, len = 0;
    for (const m of MATERIALS) {
      if (!ok(m)) continue;
      const hit = RE.get(m.id).exec(c);
      if (hit && hit[0].length > len) { best = m; len = hit[0].length; }
    }
    if (best) return { id: best.id, how: "name", tint: tintFor(best, rgba), ifcName: c };
  }
  // 3. the class and the colour
  const k = seeThrough ? "glass" : cls in BY_CLASS ? cls : "paint";
  const id = BY_CLASS[k];
  if (!id) return { id: null, how: "guess", tint: rgba ? hex(rgba) : null, ifcName: cands[0] || null };
  return { id, how: "guess", tint: TINTABLE.has(k) && telling(rgba) ? hex(rgba) : null, ifcName: cands[0] || null };
}
/** A material whose look is its colour (paints, plain surfaces) keeps the architect's colour only when it was a generic name. */
function tintFor(m, rgba) {
  if (!rgba || !telling(rgba)) return null;
  if (m.category === "Paint and render" && /^mt-paint-white$|^mt-render-sand$/.test(m.id)) return hex(rgba);   // "Paint" or "Plaster" with a colour
  return null;
}
export { materialById };
