// Prices the quantities measured in Revit using Naira rates the user can edit.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "./connectors.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRates = path.join(here, "..", "rates.json");
export const userRatesFile = path.join(dataDir, "rates.json");

export function loadRates() {
  const base = JSON.parse(fs.readFileSync(defaultRates, "utf8"));
  try {
    if (!fs.existsSync(userRatesFile)) { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(userRatesFile, JSON.stringify(base, null, 2)); }
    const user = JSON.parse(fs.readFileSync(userRatesFile, "utf8"));
    for (const k of Object.keys(base.rates)) if (user.rates && user.rates[k]) base.rates[k] = { ...base.rates[k], ...user.rates[k] };
  } catch {}
  return base;
}

export function saveRates(updates) {
  const r = loadRates();
  for (const [k, v] of Object.entries(updates)) {
    if (!r.rates[k]) throw new Error(`Unknown rate "${k}". Known: ${Object.keys(r.rates).join(", ")}`);
    r.rates[k].rate = Number(v);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(userRatesFile, JSON.stringify(r, null, 2));
  return r;
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const countAll = (o) => sum(Object.values(o || {}).map(Number));

export function price(q) {
  const { rates } = loadRates();
  const items = [];
  const add = (section, key, qty, note) => {
    if (!qty || qty <= 0) return;
    const r = rates[key];
    items.push({ section, item: r.label, qty: Math.round(qty * 100) / 100, unit: r.unit, rate: r.rate, amount: Math.round(qty * r.rate), note });
  };
  const walls = q.walls_by_thickness || [];
  const area9 = sum(walls.filter((w) => w.thickness_mm >= 200).map((w) => w.net_area_m2));
  const area6 = sum(walls.filter((w) => w.thickness_mm < 200).map((w) => w.net_area_m2));
  const b9 = Math.ceil(area9 * 10 * 1.05), b6 = Math.ceil(area6 * 10 * 1.05);
  add("Substructure", "foundation_concrete", q.foundations?.volume_m3);
  add("Frame", "rc_frame", (q.structural_columns?.volume_m3 || 0) + (q.beams?.volume_m3 || 0), "columns and beams");
  add("Floors", "floor_concrete", q.floors?.volume_m3);
  add("Walling", "block_225", b9, "10 blocks per m² + 5% waste");
  add("Walling", "block_150", b6, "10 blocks per m² + 5% waste");
  add("Walling", "cement_mortar", Math.ceil((b9 + b6) / 35), "about 35 blocks per bag");
  add("Roof", "roof_carcass", q.roofs?.area_m2);
  add("Roof", "roof_covering", (q.roofs?.area_m2 || 0) * 1.1, "incl. 10% laps");
  add("Openings", "door", countAll(q.doors));
  add("Openings", "window", countAll(q.windows));
  add("Services", "plumbing_fixture", countAll(q.plumbing_fixtures));
  add("Services", "pipework", q.pipes_length_m);
  add("Services", "ductwork", q.ducts_length_m);
  add("Finishes", "plaster", (area9 + area6) * 2, "both faces");
  add("Finishes", "paint", (area9 + area6) * 2, "both faces");
  add("Finishes", "floor_tiles", q.room_area_total_m2);
  const total = sum(items.map((i) => i.amount));
  return { items, total, rates_file: userRatesFile };
}

export function asTable(boq) {
  const ng = (n) => "₦" + Math.round(n).toLocaleString("en-NG");
  let s = "| Section | Item | Qty | Unit | Rate | Amount |\n|---|---|---:|---|---:|---:|\n";
  for (const i of boq.items) s += `| ${i.section} | ${i.item}${i.note ? ` (${i.note})` : ""} | ${i.qty.toLocaleString("en-NG")} | ${i.unit} | ${ng(i.rate)} | ${ng(i.amount)} |\n`;
  s += `| | **Estimated total** | | | | **${ng(boq.total)}** |\n`;
  return s;
}
