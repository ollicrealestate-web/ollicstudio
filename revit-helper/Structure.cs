using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace OllicSketch.Revit
{
    internal static class Structure
    {
        /// <summary>
        /// Returns a column/beam/footing type of the requested size, duplicating the closest
        /// type and setting its size parameters when no exact size exists.
        /// Common parameter names: concrete rectangular families use b and h; others use Width/Depth/Length/Thickness.
        /// </summary>
        internal static FamilySymbol Sized(Document doc, BuiltInCategory cat, string typeName, string what, Dictionary<string[], double> sizesMm)
        {
            var sym = H.Symbol(doc, cat, typeName, what);
            var wanted = sizesMm.Where(kv => !double.IsNaN(kv.Value)).ToList();
            if (wanted.Count == 0) return sym;
            string label = string.Join(" x ", wanted.Select(kv => Math.Round(kv.Value))) + "mm (Ollic)";
            var existing = H.Symbols(doc, cat).FirstOrDefault(s => s.FamilyName == sym.FamilyName && s.Name == label);
            if (existing != null) { if (!existing.IsActive) existing.Activate(); return existing; }
            try
            {
                var dup = (FamilySymbol)sym.Duplicate(label);
                foreach (var kv in wanted)
                {
                    var p = kv.Key.Select(n => dup.LookupParameter(n)).FirstOrDefault(x => x != null && !x.IsReadOnly && x.StorageType == StorageType.Double);
                    p?.Set(H.Ft(kv.Value));
                }
                if (!dup.IsActive) dup.Activate();
                doc.Regenerate();
                return dup;
            }
            catch { return sym; }
        }

        static readonly string[] WidthNames = { "b", "Width", "B", "Section Width", "Foundation Width" };
        static readonly string[] DepthNames = { "h", "Depth", "Height", "H", "Section Height" };
        static readonly string[] LengthNames = { "Length", "L" };
        static readonly string[] ThickNames = { "Thickness", "Foundation Thickness", "Depth", "h" };

        /// <summary>Plan intersection of two straight grid segments, or null if they do not cross.</summary>
        internal static XYZ Cross(XYZ a1, XYZ a2, XYZ b1, XYZ b2)
        {
            double dx1 = a2.X - a1.X, dy1 = a2.Y - a1.Y, dx2 = b2.X - b1.X, dy2 = b2.Y - b1.Y;
            double den = dx1 * dy2 - dy1 * dx2;
            if (Math.Abs(den) < 1e-9) return null;
            double t = ((b1.X - a1.X) * dy2 - (b1.Y - a1.Y) * dx2) / den;
            double u = ((b1.X - a1.X) * dy1 - (b1.Y - a1.Y) * dx1) / den;
            const double e = 1e-6;
            if (t < -e || t > 1 + e || u < -e || u > 1 + e) return null;
            return new XYZ(a1.X + dx1 * t, a1.Y + dy1 * t, 0);
        }

        public static JToken CreateColumns(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            return Tx.Run(doc, "create columns", () =>
            {
                var baseLevel = H.Level(doc, a["base_level"], app);
                var topLevel = a["top_level"] != null ? H.Level(doc, a["top_level"]) : H.LevelAbove(doc, baseLevel);
                var sym = Sized(doc, BuiltInCategory.OST_StructuralColumns, H.Str(a["type"]), "structural column",
                    new Dictionary<string[], double> { [WidthNames] = H.Num(a["width_mm"]), [DepthNames] = H.Num(a["depth_mm"]) });
                var points = new List<XYZ>();
                foreach (var p in (a["points"] as JArray) ?? new JArray()) points.Add(H.Pt(p));
                if (a["at_grid_intersections"]?.Value<bool>() == true)
                {
                    var grids = new FilteredElementCollector(doc).OfClass(typeof(Grid)).Cast<Grid>().Where(g => g.Curve is Line).ToList();
                    for (int i = 0; i < grids.Count; i++)
                        for (int j = i + 1; j < grids.Count; j++)
                        {
                            var hit = Cross(grids[i].Curve.GetEndPoint(0), grids[i].Curve.GetEndPoint(1), grids[j].Curve.GetEndPoint(0), grids[j].Curve.GetEndPoint(1));
                            if (hit != null) points.Add(hit);
                        }
                }
                if (points.Count == 0) throw new Exception("Give points, or set at_grid_intersections with grids in the model.");
                var made = new JArray();
                foreach (var p in points.GroupBy(q => $"{Math.Round(q.X, 3)},{Math.Round(q.Y, 3)}").Select(g => g.First()))
                {
                    var col = doc.Create.NewFamilyInstance(new XYZ(p.X, p.Y, baseLevel.Elevation), sym, baseLevel, StructuralType.Column);
                    if (topLevel != null)
                    {
                        col.get_Parameter(BuiltInParameter.FAMILY_TOP_LEVEL_PARAM)?.Set(topLevel.Id);
                        col.get_Parameter(BuiltInParameter.FAMILY_TOP_LEVEL_OFFSET_PARAM)?.Set(0.0);
                    }
                    made.Add(new JObject { ["id"] = H.Id(col.Id), ["point"] = H.P(p) });
                }
                return new JObject { ["created"] = made.Count, ["type"] = H.TypeLabel(sym), ["base_level"] = baseLevel.Name, ["top_level"] = topLevel?.Name, ["columns"] = made };
            });
        }

        /// <summary>Beams from start/end points, or along the walls of a level (ring beams / lintel bands), placed at a given level.</summary>
        public static JToken CreateBeams(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            return Tx.Run(doc, "create beams", () =>
            {
                var level = H.Level(doc, a["level"], app);
                var sym = Sized(doc, BuiltInCategory.OST_StructuralFraming, H.Str(a["type"]), "beam",
                    new Dictionary<string[], double> { [WidthNames] = H.Num(a["width_mm"]), [DepthNames] = H.Num(a["depth_mm"]) });
                var lines = new List<Line>();
                double z = level.Elevation + H.Ft(H.Num(a["offset_mm"], 0));
                foreach (var b in (a["beams"] as JArray) ?? new JArray())
                {
                    var p1 = H.Pt(b["start"]); var p2 = H.Pt(b["end"]);
                    lines.Add(Line.CreateBound(new XYZ(p1.X, p1.Y, z), new XYZ(p2.X, p2.Y, z)));
                }
                if (a["on_walls_of_level"] != null)
                {
                    var wl = H.Level(doc, a["on_walls_of_level"]);
                    foreach (var w in new FilteredElementCollector(doc).OfClass(typeof(Wall)).Cast<Wall>().Where(w => w.LevelId == wl.Id))
                        if (w.Location is LocationCurve lc && lc.Curve is Line ln)
                            lines.Add(Line.CreateBound(new XYZ(ln.GetEndPoint(0).X, ln.GetEndPoint(0).Y, z), new XYZ(ln.GetEndPoint(1).X, ln.GetEndPoint(1).Y, z)));
                }
                if (lines.Count == 0) throw new Exception("Give beams (start/end) or on_walls_of_level.");
                var made = new JArray();
                foreach (var l in lines.Where(l => l.Length > H.Ft(100)))
                {
                    var beam = doc.Create.NewFamilyInstance(l, sym, level, StructuralType.Beam);
                    made.Add(new JObject { ["id"] = H.Id(beam.Id), ["length_mm"] = H.Mm(l.Length) });
                }
                return new JObject { ["created"] = made.Count, ["type"] = H.TypeLabel(sym), ["level"] = level.Name, ["beams"] = made };
            });
        }

        /// <summary>Strip footings under walls and/or pad footings at points or under every column.</summary>
        public static JToken CreateFoundations(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            return Tx.Run(doc, "create foundations", () =>
            {
                var res = new JObject();
                if (a["strip_under_walls_of_level"] != null)
                {
                    var lv = H.Level(doc, a["strip_under_walls_of_level"]);
                    var types = new FilteredElementCollector(doc).OfClass(typeof(WallFoundationType)).Cast<WallFoundationType>();
                    var ft = H.TypeByName(types, H.Str(a["strip_type"]), "wall foundation");
                    double sw = H.Num(a["strip_width_mm"]);
                    if (!double.IsNaN(sw))
                    {
                        string nm = $"Strip {Math.Round(sw)}mm (Ollic)";
                        var ex = types.FirstOrDefault(t => t.Name == nm);
                        if (ex != null) ft = ex;
                        else { try { var dup = (WallFoundationType)ft.Duplicate(nm); (dup.get_Parameter(BuiltInParameter.STRUCTURAL_FOUNDATION_WIDTH) ?? dup.LookupParameter("Width"))?.Set(H.Ft(sw)); ft = dup; } catch { } }
                    }
                    var made = new JArray();
                    foreach (var w in new FilteredElementCollector(doc).OfClass(typeof(Wall)).Cast<Wall>().Where(w => w.LevelId == lv.Id))
                    {
                        try { var f = WallFoundation.Create(doc, ft.Id, w.Id); made.Add(H.Id(f.Id)); } catch { }
                    }
                    res["strip_footings"] = made.Count; res["strip_type"] = ft.Name;
                }
                var pads = new List<(XYZ p, Level l)>();
                foreach (var it in (a["pads"] as JArray) ?? new JArray())
                {
                    var l = H.Level(doc, it["level"] ?? a["level"], app);
                    pads.Add((H.Pt(it["point"]), l));
                }
                if (a["pads_under_columns"]?.Value<bool>() == true)
                {
                    foreach (var c in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_StructuralColumns).WhereElementIsNotElementType().OfType<FamilyInstance>())
                        if (c.Location is LocationPoint lp) pads.Add((lp.Point, doc.GetElement(c.LevelId) as Level ?? H.Levels(doc)[0]));
                }
                if (pads.Count > 0)
                {
                    var sym = Sized(doc, BuiltInCategory.OST_StructuralFoundation, H.Str(a["pad_type"]), "isolated foundation",
                        new Dictionary<string[], double> { [WidthNames] = H.Num(a["pad_width_mm"]), [LengthNames] = H.Num(a["pad_length_mm"]), [ThickNames] = H.Num(a["pad_thickness_mm"]) });
                    var made = new JArray();
                    foreach (var (p, l) in pads)
                    {
                        var f = doc.Create.NewFamilyInstance(new XYZ(p.X, p.Y, l.Elevation), sym, l, StructuralType.Footing);
                        made.Add(H.Id(f.Id));
                    }
                    res["pad_footings"] = made.Count; res["pad_type"] = H.TypeLabel(sym);
                }
                if (res.Count == 0) throw new Exception("Give strip_under_walls_of_level, pads, or pads_under_columns.");
                return res;
            });
        }
    }
}
