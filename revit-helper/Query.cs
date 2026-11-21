using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace OllicSketch.Revit
{
    internal static class Query
    {
        internal static readonly Dictionary<string, BuiltInCategory[]> Categories = new Dictionary<string, BuiltInCategory[]>(StringComparer.OrdinalIgnoreCase)
        {
            ["walls"] = new[] { BuiltInCategory.OST_Walls },
            ["doors"] = new[] { BuiltInCategory.OST_Doors },
            ["windows"] = new[] { BuiltInCategory.OST_Windows },
            ["floors"] = new[] { BuiltInCategory.OST_Floors },
            ["roofs"] = new[] { BuiltInCategory.OST_Roofs },
            ["rooms"] = new[] { BuiltInCategory.OST_Rooms },
            ["stairs"] = new[] { BuiltInCategory.OST_Stairs },
            ["columns"] = new[] { BuiltInCategory.OST_StructuralColumns, BuiltInCategory.OST_Columns },
            ["beams"] = new[] { BuiltInCategory.OST_StructuralFraming },
            ["foundations"] = new[] { BuiltInCategory.OST_StructuralFoundation },
            ["pipes"] = new[] { BuiltInCategory.OST_PipeCurves },
            ["ducts"] = new[] { BuiltInCategory.OST_DuctCurves },
            ["plumbing_fixtures"] = new[] { BuiltInCategory.OST_PlumbingFixtures },
            ["lighting_fixtures"] = new[] { BuiltInCategory.OST_LightingFixtures },
            ["electrical_fixtures"] = new[] { BuiltInCategory.OST_ElectricalFixtures },
            ["furniture"] = new[] { BuiltInCategory.OST_Furniture },
            ["grids"] = new[] { BuiltInCategory.OST_Grids },
            ["levels"] = new[] { BuiltInCategory.OST_Levels },
            ["sheets"] = new[] { BuiltInCategory.OST_Sheets },
        };

        public static JToken ProjectInfo(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            var counts = new JObject();
            foreach (var kv in Categories)
            {
                if (kv.Key == "levels" || kv.Key == "sheets") continue;
                int n = kv.Value.Sum(c => new FilteredElementCollector(doc).OfCategory(c).WhereElementIsNotElementType().GetElementCount());
                if (n > 0) counts[kv.Key] = n;
            }
            var views = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(v => !v.IsTemplate && v.CanBePrinted).ToList();
            return new JObject
            {
                ["project"] = doc.Title,
                ["file"] = doc.PathName,
                ["revit_version"] = app.Application.VersionNumber,
                ["units_note"] = "All lengths in mm. x = east (right on plan), y = north (up on plan), z = up.",
                ["levels"] = new JArray(H.Levels(doc).Select(l => new JObject { ["id"] = H.Id(l.Id), ["name"] = l.Name, ["elevation_mm"] = H.Mm(l.Elevation) })),
                ["element_counts"] = counts,
                ["active_view"] = app.ActiveUIDocument.ActiveView?.Name,
                ["views"] = views.Count,
                ["sheets"] = new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).GetElementCount(),
                ["selected"] = app.ActiveUIDocument.Selection.GetElementIds().Count,
            };
        }

        public static JToken Selection(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            var ids = app.ActiveUIDocument.Selection.GetElementIds();
            return new JObject
            {
                ["count"] = ids.Count,
                ["elements"] = new JArray(ids.Take(200).Select(id => Describe(doc, doc.GetElement(id))))
            };
        }

        public static JToken ListElements(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            string cat = H.Str(a["category"]) ?? throw new Exception("category is required");
            if (!Categories.TryGetValue(cat, out var cats)) throw new Exception("Unknown category. Use one of: " + string.Join(", ", Categories.Keys));
            int limit = (int)H.Num(a["limit"], 200);
            Level level = a["level"] != null ? H.Level(doc, a["level"]) : null;
            var els = cats.SelectMany(c => new FilteredElementCollector(doc).OfCategory(c).WhereElementIsNotElementType().ToElements()).ToList();
            if (level != null) els = els.Where(e => e.LevelId == level.Id || (e is Wall w && w.LevelId == level.Id)).ToList();
            return new JObject
            {
                ["category"] = cat,
                ["total"] = els.Count,
                ["elements"] = new JArray(els.Take(limit).Select(e => Describe(doc, e)))
            };
        }

        public static JObject Describe(Document doc, Element e)
        {
            var o = new JObject { ["id"] = H.Id(e.Id), ["category"] = H.CategoryName(e), ["name"] = e.Name };
            var type = doc.GetElement(e.GetTypeId());
            if (type != null) o["type"] = H.TypeLabel(type);
            if (e.LevelId != ElementId.InvalidElementId && doc.GetElement(e.LevelId) is Level lv) o["level"] = lv.Name;
            switch (e)
            {
                case Wall w when w.Location is LocationCurve lc:
                    o["start"] = H.P(lc.Curve.GetEndPoint(0)); o["end"] = H.P(lc.Curve.GetEndPoint(1));
                    o["length_mm"] = H.Mm(lc.Curve.Length); o["thickness_mm"] = H.Mm(w.Width);
                    o["height_mm"] = H.Mm(w.get_Parameter(BuiltInParameter.WALL_USER_HEIGHT_PARAM)?.AsDouble() ?? 0);
                    o["structural"] = w.get_Parameter(BuiltInParameter.WALL_STRUCTURAL_SIGNIFICANT)?.AsInteger() == 1;
                    break;
                case Room r:
                    o["name"] = r.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString(); o["number"] = r.Number; o["area_m2"] = H.M2(r.Area);
                    if (r.Location is LocationPoint rp) o["point"] = H.P(rp.Point);
                    break;
                case FamilyInstance fi:
                    if (fi.Location is LocationPoint lp) o["point"] = H.P(lp.Point);
                    if (fi.Location is LocationCurve fc) { o["start"] = H.P(fc.Curve.GetEndPoint(0)); o["end"] = H.P(fc.Curve.GetEndPoint(1)); }
                    if (fi.Host != null) o["host_id"] = H.Id(fi.Host.Id);
                    var sill = fi.get_Parameter(BuiltInParameter.INSTANCE_SILL_HEIGHT_PARAM);
                    if (sill != null) o["sill_mm"] = H.Mm(sill.AsDouble());
                    break;
                case MEPCurve mc when mc.Location is LocationCurve ml:
                    o["start"] = H.P(ml.Curve.GetEndPoint(0)); o["end"] = H.P(ml.Curve.GetEndPoint(1)); o["length_mm"] = H.Mm(ml.Curve.Length);
                    break;
                case Level l:
                    o["elevation_mm"] = H.Mm(l.Elevation);
                    break;
                case Grid g:
                    o["start"] = H.P(g.Curve.GetEndPoint(0)); o["end"] = H.P(g.Curve.GetEndPoint(1));
                    break;
                case ViewSheet s:
                    o["number"] = s.SheetNumber;
                    break;
            }
            return o;
        }

        public static JToken ListTypes(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            string kind = (H.Str(a["kind"]) ?? "").ToLowerInvariant();
            IEnumerable<Element> types;
            switch (kind)
            {
                case "wall": types = new FilteredElementCollector(doc).OfClass(typeof(WallType)).ToElements(); break;
                case "floor": types = new FilteredElementCollector(doc).OfClass(typeof(FloorType)).ToElements(); break;
                case "roof": types = new FilteredElementCollector(doc).OfClass(typeof(RoofType)).ToElements(); break;
                case "door": types = H.Symbols(doc, BuiltInCategory.OST_Doors); break;
                case "window": types = H.Symbols(doc, BuiltInCategory.OST_Windows); break;
                case "column": types = H.Symbols(doc, BuiltInCategory.OST_StructuralColumns); break;
                case "beam": types = H.Symbols(doc, BuiltInCategory.OST_StructuralFraming); break;
                case "foundation": types = H.Symbols(doc, BuiltInCategory.OST_StructuralFoundation).Cast<Element>().Concat(new FilteredElementCollector(doc).OfClass(typeof(WallFoundationType)).ToElements()); break;
                case "pipe": types = new FilteredElementCollector(doc).OfClass(typeof(PipeType)).ToElements(); break;
                case "duct": types = new FilteredElementCollector(doc).OfClass(typeof(DuctType)).ToElements(); break;
                case "titleblock": types = H.Symbols(doc, BuiltInCategory.OST_TitleBlocks); break;
                case "plumbing_fixture": types = H.Symbols(doc, BuiltInCategory.OST_PlumbingFixtures); break;
                case "furniture": types = H.Symbols(doc, BuiltInCategory.OST_Furniture); break;
                default: throw new Exception("kind must be one of: wall, floor, roof, door, window, column, beam, foundation, pipe, duct, titleblock, plumbing_fixture, furniture");
            }
            return new JObject
            {
                ["kind"] = kind,
                ["types"] = new JArray(types.Take(300).Select(t =>
                {
                    var o = new JObject { ["id"] = H.Id(t.Id), ["name"] = H.TypeLabel(t) };
                    if (t is WallType wt && wt.Kind == WallKind.Basic) o["thickness_mm"] = H.Mm(wt.Width);
                    return o;
                }))
            };
        }

        /// <summary>Measured quantities in metric units, for the bill of quantities.</summary>
        public static JToken Quantities(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            double P(Element e, BuiltInParameter bip) => e.get_Parameter(bip)?.AsDouble() ?? 0;
            List<Element> Of(BuiltInCategory c) => new FilteredElementCollector(doc).OfCategory(c).WhereElementIsNotElementType().ToElements().ToList();

            var walls = Of(BuiltInCategory.OST_Walls).OfType<Wall>().ToList();
            var wallGroups = walls.GroupBy(w => Math.Round(H.Mm(w.Width))).Select(g => new JObject
            {
                ["thickness_mm"] = g.Key,
                ["count"] = g.Count(),
                ["length_m"] = Math.Round(g.Sum(w => (w.Location as LocationCurve)?.Curve.Length ?? 0) * 0.3048, 2),
                ["net_area_m2"] = Math.Round(g.Sum(w => H.M2(P(w, BuiltInParameter.HOST_AREA_COMPUTED))), 2),
                ["volume_m3"] = Math.Round(g.Sum(w => H.M3(P(w, BuiltInParameter.HOST_VOLUME_COMPUTED))), 3),
            });
            JObject SumCat(BuiltInCategory c, bool area = true)
            {
                var els = Of(c);
                var o = new JObject { ["count"] = els.Count, ["volume_m3"] = Math.Round(els.Sum(e => H.M3(P(e, BuiltInParameter.HOST_VOLUME_COMPUTED))), 3) };
                if (area) o["area_m2"] = Math.Round(els.Sum(e => H.M2(P(e, BuiltInParameter.HOST_AREA_COMPUTED))), 2);
                return o;
            }
            JObject CountTypes(BuiltInCategory c) => new JObject(Of(c).GroupBy(e => H.TypeLabel(doc.GetElement(e.GetTypeId()) ?? e))
                .Select(g => new JProperty(g.Key, g.Count())));
            double LenM(BuiltInCategory c) => Math.Round(Of(c).Sum(e => (e.Location as LocationCurve)?.Curve.Length ?? 0) * 0.3048, 2);

            var rooms = Of(BuiltInCategory.OST_Rooms).OfType<Room>().Where(r => r.Area > 0).ToList();
            return new JObject
            {
                ["walls_by_thickness"] = new JArray(wallGroups),
                ["floors"] = SumCat(BuiltInCategory.OST_Floors),
                ["roofs"] = SumCat(BuiltInCategory.OST_Roofs),
                ["structural_columns"] = SumCat(BuiltInCategory.OST_StructuralColumns, false),
                ["beams"] = SumCat(BuiltInCategory.OST_StructuralFraming, false),
                ["foundations"] = SumCat(BuiltInCategory.OST_StructuralFoundation, false),
                ["doors"] = CountTypes(BuiltInCategory.OST_Doors),
                ["windows"] = CountTypes(BuiltInCategory.OST_Windows),
                ["plumbing_fixtures"] = CountTypes(BuiltInCategory.OST_PlumbingFixtures),
                ["pipes_length_m"] = LenM(BuiltInCategory.OST_PipeCurves),
                ["ducts_length_m"] = LenM(BuiltInCategory.OST_DuctCurves),
                ["rooms"] = new JArray(rooms.Select(r => new JObject { ["name"] = r.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString(), ["number"] = r.Number, ["level"] = r.Level?.Name, ["area_m2"] = H.M2(r.Area) })),
                ["room_area_total_m2"] = Math.Round(rooms.Sum(r => H.M2(r.Area)), 2),
            };
        }
    }
}
