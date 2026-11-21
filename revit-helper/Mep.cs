using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace OllicSketch.Revit
{
    internal static class Mep
    {
        static ElementId SystemType<T>(Document doc, string name, string what) where T : ElementType =>
            H.TypeByName(new FilteredElementCollector(doc).OfClass(typeof(T)).Cast<T>(), name, what).Id;

        /// <summary>Pipe runs. Points are mm; z is height above the given level. Consecutive pipes in one run are joined with elbows.</summary>
        public static JToken CreatePipes(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            var runs = a["runs"] as JArray ?? throw new Exception("runs is required: [{points:[{x,y,z}], diameter_mm, system, level}]");
            return Tx.Run(doc, "create pipes", () =>
            {
                var made = new JArray(); var notes = new JArray();
                foreach (var run in runs)
                {
                    var level = H.Level(doc, run["level"], app);
                    var sys = SystemType<PipingSystemType>(doc, H.Str(run["system"]), "piping system");
                    var pt = H.TypeByName(new FilteredElementCollector(doc).OfClass(typeof(PipeType)).Cast<PipeType>(), H.Str(run["type"]), "pipe");
                    var pts = ((JArray)run["points"]).Select(p => { var q = H.Pt(p); return new XYZ(q.X, q.Y, level.Elevation + (p["z"] != null ? q.Z : 0)); }).ToList();
                    var pipes = new List<MEPCurve>();
                    for (int i = 0; i < pts.Count - 1; i++)
                    {
                        if (pts[i].DistanceTo(pts[i + 1]) < H.Ft(20)) continue;
                        var pipe = Pipe.Create(doc, sys, pt.Id, level.Id, pts[i], pts[i + 1]);
                        if (run["diameter_mm"] != null) pipe.get_Parameter(BuiltInParameter.RBS_PIPE_DIAMETER_PARAM)?.Set(H.Ft(H.Num(run["diameter_mm"])));
                        pipes.Add(pipe); made.Add(H.Id(pipe.Id));
                    }
                    Join(doc, pipes, notes);
                }
                var r = new JObject { ["pipes"] = made.Count, ["ids"] = made };
                if (notes.Count > 0) r["notes"] = notes;
                return r;
            });
        }

        /// <summary>Duct runs; rectangular (width/height) or round (diameter).</summary>
        public static JToken CreateDucts(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            var runs = a["runs"] as JArray ?? throw new Exception("runs is required: [{points:[{x,y,z}], width_mm, height_mm, system, level}]");
            return Tx.Run(doc, "create ducts", () =>
            {
                var made = new JArray(); var notes = new JArray();
                foreach (var run in runs)
                {
                    var level = H.Level(doc, run["level"], app);
                    var sys = SystemType<MechanicalSystemType>(doc, H.Str(run["system"]), "duct system");
                    var dt = H.TypeByName(new FilteredElementCollector(doc).OfClass(typeof(DuctType)).Cast<DuctType>(), H.Str(run["type"]), "duct");
                    var pts = ((JArray)run["points"]).Select(p => { var q = H.Pt(p); return new XYZ(q.X, q.Y, level.Elevation + (p["z"] != null ? q.Z : 0)); }).ToList();
                    var ducts = new List<MEPCurve>();
                    for (int i = 0; i < pts.Count - 1; i++)
                    {
                        if (pts[i].DistanceTo(pts[i + 1]) < H.Ft(20)) continue;
                        var d = Duct.Create(doc, sys, dt.Id, level.Id, pts[i], pts[i + 1]);
                        if (run["width_mm"] != null) d.get_Parameter(BuiltInParameter.RBS_CURVE_WIDTH_PARAM)?.Set(H.Ft(H.Num(run["width_mm"])));
                        if (run["height_mm"] != null) d.get_Parameter(BuiltInParameter.RBS_CURVE_HEIGHT_PARAM)?.Set(H.Ft(H.Num(run["height_mm"])));
                        if (run["diameter_mm"] != null) d.get_Parameter(BuiltInParameter.RBS_CURVE_DIAMETER_PARAM)?.Set(H.Ft(H.Num(run["diameter_mm"])));
                        ducts.Add(d); made.Add(H.Id(d.Id));
                    }
                    Join(doc, ducts, notes);
                }
                var r = new JObject { ["ducts"] = made.Count, ["ids"] = made };
                if (notes.Count > 0) r["notes"] = notes;
                return r;
            });
        }

        static void Join(Document doc, List<MEPCurve> run, JArray notes)
        {
            for (int i = 0; i < run.Count - 1; i++)
            {
                var c1 = Nearest(run[i], run[i + 1]); var c2 = Nearest(run[i + 1], run[i]);
                if (c1 == null || c2 == null) continue;
                try
                {
                    var d1 = (run[i].Location as LocationCurve).Curve as Line; var d2 = (run[i + 1].Location as LocationCurve).Curve as Line;
                    if (d1 != null && d2 != null && d1.Direction.IsAlmostEqualTo(d2.Direction)) c1.ConnectTo(c2);
                    else doc.Create.NewElbowFitting(c1, c2);
                }
                catch (Exception ex) { notes.Add($"Could not join segments {i + 1} and {i + 2}: {ex.Message}"); }
            }
        }

        static Connector Nearest(MEPCurve a, MEPCurve b)
        {
            var target = ((LocationCurve)b.Location).Curve;
            Connector best = null; double bd = double.MaxValue;
            foreach (Connector c in a.ConnectorManager.Connectors)
            {
                if (c.IsConnected) continue;
                double d = target.Distance(c.Origin);
                if (d < bd) { bd = d; best = c; }
            }
            return best;
        }

        /// <summary>Hard clashes between two groups of categories. Uses solid geometry intersection.</summary>
        public static JToken FindClashes(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            BuiltInCategory[] Cats(JToken t, string[] fallback)
            {
                var names = t is JArray arr ? arr.Select(x => x.Value<string>()).ToArray() : (t != null ? new[] { t.Value<string>() } : fallback);
                return names.SelectMany(n => Query.Categories.TryGetValue(n, out var c) ? c : throw new Exception("Unknown category " + n)).ToArray();
            }
            var A = Cats(a["group_a"], new[] { "pipes", "ducts" });
            var B = Cats(a["group_b"], new[] { "beams", "columns", "walls", "floors", "foundations" });
            int limit = (int)H.Num(a["limit"], 200);
            var clashes = new JArray(); int checkedA = 0;
            var seen = new HashSet<string>();
            foreach (var cat in A)
            {
                foreach (var ea in new FilteredElementCollector(doc).OfCategory(cat).WhereElementIsNotElementType().ToElements())
                {
                    if (clashes.Count >= limit) break;
                    checkedA++;
                    var bb = ea.get_BoundingBox(null); if (bb == null) continue;
                    var outline = new Outline(bb.Min, bb.Max);
                    IList<Element> hits;
                    try
                    {
                        hits = new FilteredElementCollector(doc).WherePasses(new ElementMulticategoryFilter(B))
                            .WherePasses(new BoundingBoxIntersectsFilter(outline))
                            .WherePasses(new ElementIntersectsElementFilter(ea))
                            .WhereElementIsNotElementType().ToElements();
                    }
                    catch { continue; } // element has no solid geometry to test
                    foreach (var eb in hits)
                    {
                        if (eb.Id == ea.Id) continue;
                        string key = string.Join("-", new[] { H.Id(ea.Id), H.Id(eb.Id) }.OrderBy(x => x));
                        if (!seen.Add(key)) continue;
                        var c = (bb.Min + bb.Max) / 2;
                        clashes.Add(new JObject
                        {
                            ["a"] = new JObject { ["id"] = H.Id(ea.Id), ["category"] = H.CategoryName(ea), ["name"] = ea.Name },
                            ["b"] = new JObject { ["id"] = H.Id(eb.Id), ["category"] = H.CategoryName(eb), ["name"] = eb.Name },
                            ["near"] = H.P(c),
                            ["level"] = (doc.GetElement(ea.LevelId) as Level)?.Name
                        });
                        if (clashes.Count >= limit) break;
                    }
                }
            }
            return new JObject { ["clashes"] = clashes.Count, ["elements_checked"] = checkedA, ["list"] = clashes, ["capped"] = clashes.Count >= limit };
        }
    }
}
