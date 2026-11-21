using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace OllicSketch.Revit
{
    /// <summary>Shared helpers. All lengths cross the connection in millimetres; Revit works in feet internally.</summary>
    internal static class H
    {
        public const double MmPerFt = 304.8;
        public static double Ft(double mm) => mm / MmPerFt;
        public static double Mm(double ft) => Math.Round(ft * MmPerFt, 1);
        public static double M2(double sqft) => Math.Round(sqft * 0.09290304, 3);
        public static double M3(double cuft) => Math.Round(cuft * 0.028316846592, 4);

        public static Document Doc(UIApplication app)
        {
            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new Exception("No Revit project is open. Open or create a project in Revit first.");
            if (doc.IsFamilyDocument) throw new Exception("The active document is a family. Switch to a project.");
            return doc;
        }

        public static double Num(JToken t, double fallback = double.NaN)
        {
            if (t == null || t.Type == JTokenType.Null) return fallback;
            return t.Value<double>();
        }

        public static string Str(JToken t, string fallback = null) =>
            t == null || t.Type == JTokenType.Null ? fallback : t.Value<string>();

        /// <summary>Point in mm. x = east (right on plan), y = north (up on plan), z = height.</summary>
        public static XYZ Pt(JToken p, double zFt = 0)
        {
            if (p == null) throw new Exception("a point {x, y} is required");
            double z = p["z"] != null ? Ft(p["z"].Value<double>()) : zFt;
            return new XYZ(Ft(p["x"].Value<double>()), Ft(p["y"].Value<double>()), z);
        }

        public static JObject P(XYZ p) => new JObject { ["x"] = Mm(p.X), ["y"] = Mm(p.Y), ["z"] = Mm(p.Z) };

        public static long Id(ElementId id) => id.Value;
        public static ElementId EId(JToken t) => new ElementId(t.Value<long>());

        public static List<Level> Levels(Document doc) =>
            new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => l.Elevation).ToList();

        /// <summary>Finds a level by name (case-insensitive, partial allowed) or by elevation in mm. Defaults to the active view's level, then the lowest level.</summary>
        public static Level Level(Document doc, JToken t, UIApplication app = null)
        {
            var levels = Levels(doc);
            if (levels.Count == 0) throw new Exception("The project has no levels. Create one with create_levels.");
            if (t == null || t.Type == JTokenType.Null)
            {
                var av = app?.ActiveUIDocument?.ActiveView;
                if (av?.GenLevel != null) return av.GenLevel;
                return levels[0];
            }
            if (t.Type == JTokenType.Integer || t.Type == JTokenType.Float)
            {
                double ft = Ft(t.Value<double>());
                return levels.OrderBy(l => Math.Abs(l.Elevation - ft)).First();
            }
            string name = t.Value<string>();
            var exact = levels.FirstOrDefault(l => string.Equals(l.Name, name, StringComparison.OrdinalIgnoreCase));
            if (exact != null) return exact;
            var part = levels.FirstOrDefault(l => l.Name.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0);
            if (part != null) return part;
            throw new Exception($"No level called \"{name}\". Levels: {string.Join(", ", levels.Select(l => l.Name))}");
        }

        public static Level LevelAbove(Document doc, Level l) =>
            Levels(doc).FirstOrDefault(x => x.Elevation > l.Elevation + 1e-6);

        /// <summary>Picks an element type by (partial) name; falls back to the first one.</summary>
        public static T TypeByName<T>(IEnumerable<T> types, string name, string what) where T : Element
        {
            var list = types.ToList();
            if (list.Count == 0) throw new Exception($"The project has no {what} types loaded. Load a {what} family or use a template that includes one.");
            if (string.IsNullOrWhiteSpace(name)) return list[0];
            var hit = list.FirstOrDefault(x => string.Equals(TypeLabel(x), name, StringComparison.OrdinalIgnoreCase))
                   ?? list.FirstOrDefault(x => string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase))
                   ?? list.FirstOrDefault(x => TypeLabel(x).IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0);
            if (hit == null) throw new Exception($"No {what} type matching \"{name}\". Available: {string.Join(", ", list.Take(30).Select(TypeLabel))}");
            return hit;
        }

        public static string TypeLabel(Element e) =>
            e is FamilySymbol fs ? fs.FamilyName + " : " + fs.Name : e.Name;

        public static IEnumerable<FamilySymbol> Symbols(Document doc, BuiltInCategory cat) =>
            new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).OfCategory(cat).Cast<FamilySymbol>();

        public static FamilySymbol Symbol(Document doc, BuiltInCategory cat, string name, string what)
        {
            var s = TypeByName(Symbols(doc, cat), name, what);
            if (!s.IsActive) { s.Activate(); doc.Regenerate(); }
            return s;
        }

        /// <summary>Basic wall type by name, or the one whose thickness is closest to the requested mm.</summary>
        public static WallType WallType(Document doc, string name, double thicknessMm)
        {
            var types = new FilteredElementCollector(doc).OfClass(typeof(WallType)).Cast<WallType>()
                .Where(w => w.Kind == WallKind.Basic).ToList();
            if (!string.IsNullOrWhiteSpace(name)) return TypeByName(types, name, "wall");
            if (types.Count == 0) throw new Exception("The project has no basic wall types.");
            if (double.IsNaN(thicknessMm)) return types[0];
            double ft = Ft(thicknessMm);
            return types.OrderBy(w => Math.Abs(w.Width - ft)).First();
        }

        public static ViewFamilyType ViewType(Document doc, ViewFamily fam) =>
            new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>()
                .FirstOrDefault(v => v.ViewFamily == fam)
            ?? throw new Exception($"The project has no {fam} view type.");

        public static CurveLoop Loop(JArray pts, double zFt)
        {
            if (pts == null || pts.Count < 3) throw new Exception("a boundary needs at least 3 points");
            var loop = new CurveLoop();
            var xyz = pts.Select(p => Pt(p, zFt)).ToList();
            for (int i = 0; i < xyz.Count; i++)
            {
                var a = xyz[i]; var b = xyz[(i + 1) % xyz.Count];
                if (a.DistanceTo(b) < 1e-4) continue;
                loop.Append(Line.CreateBound(a, b));
            }
            return loop;
        }

        /// <summary>Offsets a simple polygon outward by d feet (used for roof overhangs).</summary>
        public static List<XYZ> OffsetPolygon(List<XYZ> pts, double d)
        {
            if (Math.Abs(d) < 1e-9) return pts;
            double area = 0;
            for (int i = 0; i < pts.Count; i++) { var a = pts[i]; var b = pts[(i + 1) % pts.Count]; area += a.X * b.Y - b.X * a.Y; }
            double sign = area > 0 ? 1 : -1; // counter-clockwise: outward normal is to the right of each edge
            int n = pts.Count;
            var lines = new List<(XYZ p, XYZ dir)>();
            for (int i = 0; i < n; i++)
            {
                var a = pts[i]; var b = pts[(i + 1) % n];
                var dir = (b - a).Normalize();
                var outward = new XYZ(dir.Y, -dir.X, 0) * sign;
                lines.Add((a + outward * d, dir));
            }
            var res = new List<XYZ>();
            for (int i = 0; i < n; i++)
            {
                var (p1, d1) = lines[(i - 1 + n) % n];
                var (p2, d2) = lines[i];
                double den = d1.X * d2.Y - d1.Y * d2.X;
                if (Math.Abs(den) < 1e-9) { res.Add(p2); continue; }
                double t = ((p2.X - p1.X) * d2.Y - (p2.Y - p1.Y) * d2.X) / den;
                res.Add(new XYZ(p1.X + d1.X * t, p1.Y + d1.Y * t, pts[i].Z));
            }
            return res;
        }

        public static string CategoryName(Element e) => e.Category?.Name ?? e.GetType().Name;
    }

    /// <summary>Accepts Revit warnings automatically and records them so Claude can report them.</summary>
    internal class WarningCollector : IFailuresPreprocessor
    {
        public readonly List<string> Warnings = new List<string>();
        public FailureProcessingResult PreprocessFailures(FailuresAccessor fa)
        {
            foreach (var f in fa.GetFailureMessages())
            {
                if (f.GetSeverity() == FailureSeverity.Warning)
                {
                    Warnings.Add(f.GetDescriptionText());
                    fa.DeleteWarning(f);
                }
            }
            return FailureProcessingResult.Continue;
        }
    }

    internal static class Tx
    {
        /// <summary>Runs work in one named transaction (one Ctrl+Z in Revit) and adds any warnings to the result.</summary>
        public static JObject Run(Document doc, string name, Func<JObject> work)
        {
            using (var t = new Transaction(doc, "Ollic Sketch: " + name))
            {
                var wc = new WarningCollector();
                var opts = t.GetFailureHandlingOptions();
                opts.SetFailuresPreprocessor(wc);
                t.SetFailureHandlingOptions(opts);
                t.Start();
                JObject res;
                try { res = work(); }
                catch { if (t.HasStarted() && !t.HasEnded()) t.RollBack(); throw; }
                var status = t.Commit();
                if (status != TransactionStatus.Committed) throw new Exception("Revit rejected the change (" + status + ").");
                if (wc.Warnings.Count > 0) res["revit_warnings"] = new JArray(wc.Warnings.Distinct().Take(10));
                return res;
            }
        }
    }
}
