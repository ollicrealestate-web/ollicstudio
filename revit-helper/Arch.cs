using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace OllicSketch.Revit
{
    internal static class Arch
    {
        public static JToken CreateLevels(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            var items = a["levels"] as JArray ?? throw new Exception("levels is required");
            return Tx.Run(doc, "create levels", () =>
            {
                var made = new JArray();
                var planType = H.ViewType(doc, ViewFamily.FloorPlan);
                foreach (var it in items)
                {
                    double elev = H.Ft(H.Num(it["elevation_mm"] ?? it["elevation"], 0));
                    var existing = H.Levels(doc).FirstOrDefault(l => Math.Abs(l.Elevation - elev) < 1e-4);
                    var lv = existing ?? Level.Create(doc, elev);
                    string name = H.Str(it["name"]);
                    if (name != null && lv.Name != name) { try { lv.Name = name; } catch { } }
                    bool hasPlan = new FilteredElementCollector(doc).OfClass(typeof(ViewPlan)).Cast<ViewPlan>()
                        .Any(v => !v.IsTemplate && v.GenLevel?.Id == lv.Id && v.ViewType == ViewType.FloorPlan);
                    if (!hasPlan && it["create_plan"]?.Value<bool>() != false)
                    {
                        var vp = ViewPlan.Create(doc, planType.Id, lv.Id);
                        try { vp.Name = lv.Name; } catch { }
                    }
                    made.Add(new JObject { ["id"] = H.Id(lv.Id), ["name"] = lv.Name, ["elevation_mm"] = H.Mm(lv.Elevation), ["existed"] = existing != null });
                }
                return new JObject { ["levels"] = made };
            });
        }

        public static JToken CreateGrids(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            var items = a["grids"] as JArray ?? throw new Exception("grids is required");
            return Tx.Run(doc, "create grids", () =>
            {
                var made = new JArray();
                foreach (var it in items)
                {
                    var g = Grid.Create(doc, Line.CreateBound(H.Pt(it["start"]), H.Pt(it["end"])));
                    string name = H.Str(it["name"]);
                    if (name != null) { try { g.Name = name; } catch { } }
                    made.Add(new JObject { ["id"] = H.Id(g.Id), ["name"] = g.Name });
                }
                return new JObject { ["grids"] = made };
            });
        }

        public static JToken CreateWalls(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            var items = a["walls"] as JArray ?? throw new Exception("walls is required");
            return Tx.Run(doc, "create walls", () =>
            {
                var made = new JArray();
                foreach (var it in items)
                {
                    var level = H.Level(doc, it["level"] ?? a["level"], app);
                    var type = H.WallType(doc, H.Str(it["type"] ?? a["type"]), H.Num(it["thickness_mm"] ?? a["thickness_mm"]));
                    double height = H.Ft(H.Num(it["height_mm"] ?? a["height_mm"], 3000));
                    var p1 = H.Pt(it["start"], level.Elevation); var p2 = H.Pt(it["end"], level.Elevation);
                    p1 = new XYZ(p1.X, p1.Y, level.Elevation); p2 = new XYZ(p2.X, p2.Y, level.Elevation);
                    if (p1.DistanceTo(p2) < H.Ft(50)) continue;
                    bool structural = (it["structural"] ?? a["structural"])?.Value<bool>() ?? false;
                    var w = Wall.Create(doc, Line.CreateBound(p1, p2), type.Id, level.Id, height, 0, false, structural);
                    var top = it["top_level"] ?? a["top_level"];
                    if (top != null)
                    {
                        var tl = H.Level(doc, top);
                        w.get_Parameter(BuiltInParameter.WALL_HEIGHT_TYPE)?.Set(tl.Id);
                    }
                    made.Add(new JObject { ["id"] = H.Id(w.Id), ["type"] = type.Name, ["level"] = level.Name, ["length_mm"] = H.Mm(p1.DistanceTo(p2)) });
                }
                return new JObject { ["created"] = made.Count, ["walls"] = made };
            });
        }

        /// <summary>Rectangle around the outer faces of the walls on a level.</summary>
        internal static List<XYZ> WallOutline(Document doc, Level level, double z)
        {
            var walls = new FilteredElementCollector(doc).OfClass(typeof(Wall)).Cast<Wall>().Where(w => w.LevelId == level.Id).ToList();
            if (walls.Count == 0) throw new Exception($"There are no walls on {level.Name} to take an outline from. Give the boundary points instead.");
            double x0 = double.MaxValue, y0 = double.MaxValue, x1 = double.MinValue, y1 = double.MinValue;
            foreach (var w in walls)
            {
                if (!(w.Location is LocationCurve lc)) continue;
                foreach (var p in new[] { lc.Curve.GetEndPoint(0), lc.Curve.GetEndPoint(1) })
                {
                    x0 = Math.Min(x0, p.X - w.Width / 2); y0 = Math.Min(y0, p.Y - w.Width / 2);
                    x1 = Math.Max(x1, p.X + w.Width / 2); y1 = Math.Max(y1, p.Y + w.Width / 2);
                }
            }
            return new List<XYZ> { new XYZ(x0, y0, z), new XYZ(x1, y0, z), new XYZ(x1, y1, z), new XYZ(x0, y1, z) };
        }

        public static JToken CreateFloors(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            var items = a["floors"] as JArray ?? new JArray(a);
            return Tx.Run(doc, "create floors", () =>
            {
                var made = new JArray();
                var floorTypes = new FilteredElementCollector(doc).OfClass(typeof(FloorType)).Cast<FloorType>().Where(t => !t.IsFoundationSlab);
                foreach (var it in items)
                {
                    var level = H.Level(doc, it["level"], app);
                    var type = H.TypeByName(floorTypes, H.Str(it["type"]), "floor");
                    CurveLoop loop;
                    if (it["boundary"] is JArray b) loop = H.Loop(b, level.Elevation);
                    else
                    {
                        var pts = WallOutline(doc, H.Level(doc, it["outline_from_level"] ?? it["level"], app), level.Elevation);
                        loop = new CurveLoop();
                        for (int i = 0; i < pts.Count; i++) loop.Append(Line.CreateBound(pts[i], pts[(i + 1) % pts.Count]));
                    }
                    var f = Floor.Create(doc, new List<CurveLoop> { loop }, type.Id, level.Id);
                    if (it["offset_mm"] != null) f.get_Parameter(BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM)?.Set(H.Ft(H.Num(it["offset_mm"])));
                    if (it["structural"]?.Value<bool>() == true) f.get_Parameter(BuiltInParameter.FLOOR_PARAM_IS_STRUCTURAL)?.Set(1);
                    made.Add(new JObject { ["id"] = H.Id(f.Id), ["type"] = type.Name, ["level"] = level.Name });
                }
                return new JObject { ["floors"] = made };
            });
        }

        /// <summary>Footprint roof. style: gable (two long sides slope), hip (all sides), mono (one side), flat.</summary>
        public static JToken CreateRoof(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            var levels = H.Levels(doc);
            var level = a["level"] != null ? H.Level(doc, a["level"]) : levels.Last();
            var roofType = H.TypeByName(new FilteredElementCollector(doc).OfClass(typeof(RoofType)).Cast<RoofType>(), H.Str(a["type"]), "roof");
            string style = (H.Str(a["style"]) ?? "gable").ToLowerInvariant();
            double pitch = H.Num(a["pitch_degrees"], 25);
            double overhang = H.Ft(H.Num(a["overhang_mm"], 600));
            return Tx.Run(doc, "create roof", () =>
            {
                List<XYZ> pts = a["footprint"] is JArray fp
                    ? fp.Select(p => H.Pt(p, level.Elevation)).Select(p => new XYZ(p.X, p.Y, level.Elevation)).ToList()
                    : WallOutline(doc, a["outline_from_level"] != null ? H.Level(doc, a["outline_from_level"]) : (levels.LastOrDefault(l => l.Elevation < level.Elevation - 1e-6) ?? level), level.Elevation);
                pts = H.OffsetPolygon(pts, overhang);
                var ca = new CurveArray();
                for (int i = 0; i < pts.Count; i++) ca.Append(Line.CreateBound(pts[i], pts[(i + 1) % pts.Count]));
                var roof = doc.Create.NewFootPrintRoof(ca, level, roofType, out ModelCurveArray mapping);
                var curves = new List<ModelCurve>();
                foreach (ModelCurve mc in mapping) curves.Add(mc);
                double longest = curves.Max(c => c.GeometryCurve.Length);
                bool monoDone = false;
                foreach (var mc in curves)
                {
                    bool isLong = mc.GeometryCurve.Length >= longest - 1e-3;
                    bool slope = style == "hip" || (style == "gable" && isLong) || (style == "mono" && isLong && !monoDone);
                    if (style == "mono" && slope) monoDone = true;
                    roof.set_DefinesSlope(mc, slope);
                    if (slope) roof.set_SlopeAngle(mc, Math.Tan(pitch * Math.PI / 180));
                }
                if (a["base_offset_mm"] != null) roof.get_Parameter(BuiltInParameter.ROOF_LEVEL_OFFSET_PARAM)?.Set(H.Ft(H.Num(a["base_offset_mm"])));
                return new JObject { ["id"] = H.Id(roof.Id), ["style"] = style, ["pitch_degrees"] = style == "flat" ? 0 : pitch, ["level"] = level.Name, ["overhang_mm"] = H.Mm(overhang) };
            });
        }

        /// <summary>Picks a door/window type by name, or the closest by width; duplicates a new size if asked for an exact width/height.</summary>
        internal static FamilySymbol OpeningType(Document doc, BuiltInCategory cat, JToken it)
        {
            string what = cat == BuiltInCategory.OST_Doors ? "door" : "window";
            var name = H.Str(it["type"]);
            if (name != null) return H.Symbol(doc, cat, name, what);
            double w = H.Num(it["width_mm"]), h = H.Num(it["height_mm"]);
            var all = H.Symbols(doc, cat).ToList();
            if (all.Count == 0) throw new Exception($"No {what} families are loaded. Load one in Revit (Insert > Load Family).");
            if (double.IsNaN(w)) { var s0 = all[0]; if (!s0.IsActive) s0.Activate(); return s0; }
            var wb = cat == BuiltInCategory.OST_Doors ? BuiltInParameter.DOOR_WIDTH : BuiltInParameter.WINDOW_WIDTH;
            var hb = cat == BuiltInCategory.OST_Doors ? BuiltInParameter.DOOR_HEIGHT : BuiltInParameter.WINDOW_HEIGHT;
            Parameter WP(FamilySymbol s) => s.get_Parameter(wb) ?? s.get_Parameter(BuiltInParameter.FAMILY_WIDTH_PARAM) ?? s.LookupParameter("Width");
            Parameter HP(FamilySymbol s) => s.get_Parameter(hb) ?? s.get_Parameter(BuiltInParameter.FAMILY_HEIGHT_PARAM) ?? s.LookupParameter("Height");
            double W(FamilySymbol s) => WP(s)?.AsDouble() ?? 0;
            double Hh(FamilySymbol s) => HP(s)?.AsDouble() ?? 0;
            var best = all.OrderBy(s => Math.Abs(W(s) - H.Ft(w)) + (double.IsNaN(h) ? 0 : Math.Abs(Hh(s) - H.Ft(h)))).First();
            bool exact = Math.Abs(W(best) - H.Ft(w)) < H.Ft(5) && (double.IsNaN(h) || Math.Abs(Hh(best) - H.Ft(h)) < H.Ft(5));
            if (!exact)
            {
                string newName = $"{Math.Round(w)} x {(double.IsNaN(h) ? Math.Round(H.Mm(Hh(best))) : Math.Round(h))}mm (Ollic)";
                var existing = all.FirstOrDefault(s => s.FamilyName == best.FamilyName && s.Name == newName);
                if (existing != null) best = existing;
                else
                {
                    try
                    {
                        var dup = (FamilySymbol)best.Duplicate(newName);
                        var dw = WP(dup); if (dw != null && !dw.IsReadOnly) dw.Set(H.Ft(w));
                        var dh = HP(dup); if (!double.IsNaN(h) && dh != null && !dh.IsReadOnly) dh.Set(H.Ft(h));
                        best = dup;
                    }
                    catch { /* family does not allow size change; keep closest size */ }
                }
            }
            if (!best.IsActive) { best.Activate(); doc.Regenerate(); }
            return best;
        }

        public static JToken PlaceOpenings(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            var items = a["openings"] as JArray ?? throw new Exception("openings is required");
            return Tx.Run(doc, "place doors and windows", () =>
            {
                var made = new JArray(); var skipped = new JArray();
                foreach (var it in items)
                {
                    try
                    {
                        string kind = (H.Str(it["kind"]) ?? "door").ToLowerInvariant();
                        var cat = kind.StartsWith("win") ? BuiltInCategory.OST_Windows : BuiltInCategory.OST_Doors;
                        Wall wall;
                        if (it["wall_id"] != null) wall = doc.GetElement(H.EId(it["wall_id"])) as Wall ?? throw new Exception("wall_id is not a wall");
                        else
                        {
                            var level = it["level"] != null ? H.Level(doc, it["level"]) : null;
                            var p = H.Pt(it["point"]);
                            wall = new FilteredElementCollector(doc).OfClass(typeof(Wall)).Cast<Wall>()
                                .Where(w => level == null || w.LevelId == level.Id)
                                .Where(w => w.Location is LocationCurve)
                                .OrderBy(w => ((LocationCurve)w.Location).Curve.Distance(new XYZ(p.X, p.Y, ((LocationCurve)w.Location).Curve.GetEndPoint(0).Z)))
                                .FirstOrDefault() ?? throw new Exception("no wall found near the point");
                        }
                        var curve = ((LocationCurve)wall.Location).Curve;
                        var wl = doc.GetElement(wall.LevelId) as Level;
                        XYZ loc;
                        if (it["offset_mm"] != null)
                        {
                            var s = curve.GetEndPoint(0); var e = curve.GetEndPoint(1);
                            loc = s + (e - s).Normalize() * H.Ft(H.Num(it["offset_mm"]));
                        }
                        else
                        {
                            var p = H.Pt(it["point"]);
                            loc = curve.Project(new XYZ(p.X, p.Y, curve.GetEndPoint(0).Z)).XYZPoint;
                        }
                        loc = new XYZ(loc.X, loc.Y, wl.Elevation);
                        var sym = OpeningType(doc, cat, it);
                        var fi = doc.Create.NewFamilyInstance(loc, sym, wall, wl, StructuralType.NonStructural);
                        if (it["sill_mm"] != null) fi.get_Parameter(BuiltInParameter.INSTANCE_SILL_HEIGHT_PARAM)?.Set(H.Ft(H.Num(it["sill_mm"])));
                        if (it["flip_facing"]?.Value<bool>() == true) fi.flipFacing();
                        if (it["flip_hand"]?.Value<bool>() == true) fi.flipHand();
                        made.Add(new JObject { ["id"] = H.Id(fi.Id), ["kind"] = kind, ["type"] = H.TypeLabel(sym), ["wall_id"] = H.Id(wall.Id) });
                    }
                    catch (Exception ex) { skipped.Add(new JObject { ["input"] = it, ["reason"] = ex.Message }); }
                }
                var r = new JObject { ["placed"] = made.Count, ["openings"] = made };
                if (skipped.Count > 0) r["skipped"] = skipped;
                return r;
            });
        }

        public static JToken CreateRooms(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            return Tx.Run(doc, "create rooms", () =>
            {
                var made = new JArray();
                if (a["auto_level"] != null)
                {
                    var lv = H.Level(doc, a["auto_level"]);
                    foreach (var id in doc.Create.NewRooms2(lv))
                        if (doc.GetElement(id) is Room r) made.Add(new JObject { ["id"] = H.Id(id), ["number"] = r.Number });
                }
                foreach (var it in (a["rooms"] as JArray) ?? new JArray())
                {
                    var level = H.Level(doc, it["level"], app);
                    var p = H.Pt(it["point"]);
                    var room = doc.Create.NewRoom(level, new UV(p.X, p.Y));
                    if (it["name"] != null) room.Name = H.Str(it["name"]);
                    if (it["number"] != null) room.Number = H.Str(it["number"]);
                    doc.Regenerate();
                    made.Add(new JObject { ["id"] = H.Id(room.Id), ["name"] = H.Str(it["name"]), ["area_m2"] = H.M2(room.Area), ["enclosed"] = room.Area > 0 });
                }
                return new JObject { ["rooms"] = made, ["note"] = "A room with area 0 is not enclosed by walls; check the walls around it." };
            });
        }

        /// <summary>Places loadable families: plumbing fixtures, lights, sockets, furniture, generic models.</summary>
        public static JToken PlaceComponents(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            var cats = new Dictionary<string, BuiltInCategory>(StringComparer.OrdinalIgnoreCase)
            {
                ["plumbing_fixture"] = BuiltInCategory.OST_PlumbingFixtures, ["lighting_fixture"] = BuiltInCategory.OST_LightingFixtures,
                ["electrical_fixture"] = BuiltInCategory.OST_ElectricalFixtures, ["electrical_equipment"] = BuiltInCategory.OST_ElectricalEquipment,
                ["mechanical_equipment"] = BuiltInCategory.OST_MechanicalEquipment, ["furniture"] = BuiltInCategory.OST_Furniture,
                ["casework"] = BuiltInCategory.OST_Casework, ["generic"] = BuiltInCategory.OST_GenericModel, ["planting"] = BuiltInCategory.OST_Planting,
            };
            var items = a["components"] as JArray ?? throw new Exception("components is required");
            return Tx.Run(doc, "place components", () =>
            {
                var made = new JArray(); var skipped = new JArray();
                foreach (var it in items)
                {
                    try
                    {
                        string c = H.Str(it["category"]) ?? "generic";
                        if (!cats.TryGetValue(c, out var cat)) throw new Exception("category must be one of " + string.Join(", ", cats.Keys));
                        var level = H.Level(doc, it["level"], app);
                        var sym = H.Symbol(doc, cat, H.Str(it["type"]), c.Replace('_', ' '));
                        var p = H.Pt(it["point"]);
                        var fi = doc.Create.NewFamilyInstance(new XYZ(p.X, p.Y, level.Elevation + (it["point"]?["z"] != null ? p.Z : 0)), sym, level, StructuralType.NonStructural);
                        double rot = H.Num(it["rotation_degrees"], 0);
                        if (Math.Abs(rot) > 1e-6)
                        {
                            var o = ((LocationPoint)fi.Location).Point;
                            ElementTransformUtils.RotateElement(doc, fi.Id, Line.CreateBound(o, o + XYZ.BasisZ), rot * Math.PI / 180);
                        }
                        made.Add(new JObject { ["id"] = H.Id(fi.Id), ["type"] = H.TypeLabel(sym) });
                    }
                    catch (Exception ex) { skipped.Add(new JObject { ["input"] = it, ["reason"] = ex.Message }); }
                }
                var r = new JObject { ["placed"] = made.Count, ["components"] = made };
                if (skipped.Count > 0) r["skipped"] = skipped;
                return r;
            });
        }

        public static JToken Modify(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            var ids = (a["ids"] as JArray ?? throw new Exception("ids is required")).Select(H.EId).ToList();
            return Tx.Run(doc, "modify elements", () =>
            {
                var notes = new JArray();
                if (a["move"] != null)
                {
                    var m = a["move"];
                    var v = new XYZ(H.Ft(H.Num(m["x"], 0)), H.Ft(H.Num(m["y"], 0)), H.Ft(H.Num(m["z"], 0)));
                    ElementTransformUtils.MoveElements(doc, ids, v);
                }
                if (a["rotate_degrees"] != null)
                {
                    XYZ c;
                    if (a["about"] != null) c = H.Pt(a["about"]);
                    else
                    {
                        var bb = ids.Select(id => doc.GetElement(id).get_BoundingBox(null)).Where(b => b != null).ToList();
                        c = bb.Count == 0 ? XYZ.Zero : new XYZ(bb.Average(b => (b.Min.X + b.Max.X) / 2), bb.Average(b => (b.Min.Y + b.Max.Y) / 2), 0);
                    }
                    ElementTransformUtils.RotateElements(doc, ids, Line.CreateBound(c, c + XYZ.BasisZ), H.Num(a["rotate_degrees"]) * Math.PI / 180);
                }
                foreach (var id in ids)
                {
                    var e = doc.GetElement(id);
                    if (e == null) { notes.Add($"{H.Id(id)}: not found"); continue; }
                    if (a["type"] != null)
                    {
                        var valid = e.GetValidTypes().Select(t => doc.GetElement(t)).Where(t => t != null);
                        try { var t = H.TypeByName(valid, H.Str(a["type"]), "matching"); e.ChangeTypeId(t.Id); }
                        catch (Exception ex) { notes.Add($"{H.Id(id)}: {ex.Message}"); }
                    }
                    if (a["thickness_mm"] != null && e is Wall)
                        e.ChangeTypeId(H.WallType(doc, null, H.Num(a["thickness_mm"])).Id);
                    if (a["parameters"] is JObject ps)
                        foreach (var kv in ps)
                        {
                            var p = e.LookupParameter(kv.Key);
                            if (p == null && Enum.TryParse(kv.Key, true, out BuiltInParameter bip)) p = e.get_Parameter(bip);
                            if (p == null) { notes.Add($"{H.Id(id)}: no parameter \"{kv.Key}\""); continue; }
                            if (p.IsReadOnly) { notes.Add($"{H.Id(id)}: \"{kv.Key}\" is read-only"); continue; }
                            try { SetParam(p, kv.Value); } catch (Exception ex) { notes.Add($"{H.Id(id)}: {kv.Key}: {ex.Message}"); }
                        }
                }
                var r = new JObject { ["modified"] = ids.Count };
                if (notes.Count > 0) r["notes"] = notes;
                return r;
            });
        }

        /// <summary>Lengths are taken as mm and angles as degrees; other numbers are set as given.</summary>
        internal static void SetParam(Parameter p, JToken v)
        {
            switch (p.StorageType)
            {
                case StorageType.String: p.Set(v.ToString()); break;
                case StorageType.Integer: p.Set(v.Type == JTokenType.Boolean ? (v.Value<bool>() ? 1 : 0) : v.Value<int>()); break;
                case StorageType.ElementId: p.Set(new ElementId(v.Value<long>())); break;
                case StorageType.Double:
                    double d = v.Value<double>();
                    var spec = p.Definition.GetDataType();
                    if (SpecTypeId.Length.Equals(spec)) d = H.Ft(d);
                    else if (SpecTypeId.Angle.Equals(spec)) d = d * Math.PI / 180;
                    else if (SpecTypeId.Area.Equals(spec)) d = d / 0.09290304;
                    p.Set(d); break;
            }
        }

        public static JToken Delete(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            var ids = (a["ids"] as JArray ?? throw new Exception("ids is required")).Select(H.EId).ToList();
            return Tx.Run(doc, "delete elements", () =>
            {
                var gone = doc.Delete(ids);
                return new JObject { ["deleted"] = gone.Count, ["note"] = "Count includes dependent elements (for example doors in a deleted wall)." };
            });
        }
    }
}
