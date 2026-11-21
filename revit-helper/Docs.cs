using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace OllicSketch.Revit
{
    internal static class Docs
    {
        static string ExportFolder(JObject a)
        {
            var f = H.Str(a["folder"]) ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Ollic Sketch", "Exports");
            Directory.CreateDirectory(f);
            return f;
        }

        static void TryName(View v, string name)
        {
            if (string.IsNullOrWhiteSpace(name)) return;
            for (int i = 0; i < 20; i++)
            {
                try { v.Name = i == 0 ? name : $"{name} ({i + 1})"; return; } catch { }
            }
        }

        public static JToken CreateViews(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            var items = a["views"] as JArray ?? throw new Exception("views is required");
            return Tx.Run(doc, "create views", () =>
            {
                var made = new JArray();
                foreach (var it in items)
                {
                    string kind = (H.Str(it["kind"]) ?? "floor_plan").ToLowerInvariant();
                    int scale = (int)H.Num(it["scale"], 100);
                    var created = new List<View>();
                    switch (kind)
                    {
                        case "floor_plan":
                        case "ceiling_plan":
                        case "structural_plan":
                        {
                            var fam = kind == "floor_plan" ? ViewFamily.FloorPlan : kind == "ceiling_plan" ? ViewFamily.CeilingPlan : ViewFamily.StructuralPlan;
                            var lv = H.Level(doc, it["level"], app);
                            var v = ViewPlan.Create(doc, H.ViewType(doc, fam).Id, lv.Id);
                            TryName(v, H.Str(it["name"]) ?? $"{lv.Name} - {kind.Replace('_', ' ')}");
                            created.Add(v);
                            break;
                        }
                        case "3d":
                        {
                            var v = View3D.CreateIsometric(doc, H.ViewType(doc, ViewFamily.ThreeDimensional).Id);
                            TryName(v, H.Str(it["name"]) ?? "3D - Ollic");
                            created.Add(v);
                            break;
                        }
                        case "section":
                        {
                            var s = H.Pt(it["start"]); var e = H.Pt(it["end"]);
                            double len = s.DistanceTo(e); if (len < H.Ft(500)) throw new Exception("section line is too short");
                            var levels = H.Levels(doc);
                            double zMin = H.Ft(H.Num(it["bottom_mm"], -1500));
                            double zMax = H.Ft(H.Num(it["top_mm"], H.Mm(levels.Last().Elevation) + 6000));
                            double depth = H.Ft(H.Num(it["depth_mm"], 15000));
                            var dir = (e - s).Normalize();
                            var t = Transform.CreateTranslation(XYZ.Zero);
                            t.Origin = (s + e) / 2; t.BasisX = dir; t.BasisY = XYZ.BasisZ; t.BasisZ = dir.CrossProduct(XYZ.BasisZ);
                            var box = new BoundingBoxXYZ { Transform = t, Min = new XYZ(-len / 2, zMin, 0), Max = new XYZ(len / 2, zMax, depth) };
                            var v = ViewSection.CreateSection(doc, H.ViewType(doc, ViewFamily.Section).Id, box);
                            TryName(v, H.Str(it["name"]) ?? "Section A-A");
                            created.Add(v);
                            break;
                        }
                        case "elevations":
                        {
                            var plan = new FilteredElementCollector(doc).OfClass(typeof(ViewPlan)).Cast<ViewPlan>()
                                .FirstOrDefault(v => !v.IsTemplate && v.ViewType == ViewType.FloorPlan)
                                ?? throw new Exception("Create a floor plan view first.");
                            var walls = new FilteredElementCollector(doc).OfClass(typeof(Wall)).ToElements();
                            if (walls.Count == 0) throw new Exception("There are no walls to take elevations of.");
                            double x0 = double.MaxValue, y0 = double.MaxValue, x1 = double.MinValue, y1 = double.MinValue;
                            foreach (var w in walls) { var bb = w.get_BoundingBox(null); if (bb == null) continue; x0 = Math.Min(x0, bb.Min.X); y0 = Math.Min(y0, bb.Min.Y); x1 = Math.Max(x1, bb.Max.X); y1 = Math.Max(y1, bb.Max.Y); }
                            double gap = H.Ft(5000), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
                            var sides = new[]
                            {
                                ("South", new XYZ(cx, y0 - gap, 0), new XYZ(0, -1, 0)),
                                ("North", new XYZ(cx, y1 + gap, 0), new XYZ(0, 1, 0)),
                                ("East", new XYZ(x1 + gap, cy, 0), new XYZ(1, 0, 0)),
                                ("West", new XYZ(x0 - gap, cy, 0), new XYZ(-1, 0, 0)),
                            };
                            var vft = H.ViewType(doc, ViewFamily.Elevation);
                            foreach (var (name, pos, toward) in sides)
                            {
                                var marker = ElevationMarker.CreateElevationMarker(doc, vft.Id, pos, scale);
                                for (int i = 0; i < 4; i++)
                                {
                                    var v = marker.CreateElevation(doc, plan.Id, i);
                                    if (v.ViewDirection.IsAlmostEqualTo(toward)) { TryName(v, $"{name} Elevation"); created.Add(v); break; }
                                    doc.Delete(v.Id);
                                }
                            }
                            break;
                        }
                        default: throw new Exception("kind must be floor_plan, ceiling_plan, structural_plan, section, elevations or 3d");
                    }
                    foreach (var v in created)
                    {
                        try { v.Scale = scale; } catch { }
                        made.Add(new JObject { ["id"] = H.Id(v.Id), ["name"] = v.Name, ["kind"] = kind });
                    }
                }
                return new JObject { ["views"] = made };
            });
        }

        public static JToken CreateSheets(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            var items = a["sheets"] as JArray ?? throw new Exception("sheets is required");
            return Tx.Run(doc, "create sheets", () =>
            {
                var tbs = H.Symbols(doc, BuiltInCategory.OST_TitleBlocks).ToList();
                var made = new JArray();
                foreach (var it in items)
                {
                    ElementId tb = ElementId.InvalidElementId;
                    if (tbs.Count > 0) { var s = H.TypeByName(tbs, H.Str(it["titleblock"] ?? a["titleblock"]), "title block"); if (!s.IsActive) s.Activate(); tb = s.Id; }
                    var sheet = ViewSheet.Create(doc, tb);
                    if (it["number"] != null) { try { sheet.SheetNumber = H.Str(it["number"]); } catch { } }
                    if (it["name"] != null) sheet.Name = H.Str(it["name"]);
                    doc.Regenerate();
                    var ids = ((it["view_ids"] as JArray) ?? new JArray()).Select(H.EId).ToList();
                    var o = sheet.Outline;
                    double w = o.Max.U - o.Min.U, h = o.Max.V - o.Min.V;
                    if (w <= 0 || h <= 0) { w = 420 / H.MmPerFt; h = 297 / H.MmPerFt; o = new BoundingBoxUV(0, 0, w, h); }
                    int cols = (int)Math.Ceiling(Math.Sqrt(Math.Max(1, ids.Count))), rows = (int)Math.Ceiling(ids.Count / (double)cols);
                    double usableW = w * 0.8, usableH = h * 0.85;
                    var placed = new JArray(); var skipped = new JArray();
                    for (int i = 0; i < ids.Count; i++)
                    {
                        if (!Viewport.CanAddViewToSheet(doc, sheet.Id, ids[i])) { skipped.Add(H.Id(ids[i])); continue; }
                        int r = i / cols, c = i % cols;
                        var center = new XYZ(o.Min.U + w * 0.05 + usableW * (c + 0.5) / cols, o.Max.V - h * 0.07 - usableH * (r + 0.5) / Math.Max(1, rows), 0);
                        var vp = Viewport.Create(doc, sheet.Id, ids[i], center);
                        placed.Add(H.Id(vp.Id));
                    }
                    var res = new JObject { ["id"] = H.Id(sheet.Id), ["number"] = sheet.SheetNumber, ["name"] = sheet.Name, ["viewports"] = placed.Count };
                    if (skipped.Count > 0) res["not_placed"] = new JObject { ["view_ids"] = skipped, ["reason"] = "A view can only sit on one sheet, and schedules or sheets cannot be placed this way." };
                    made.Add(res);
                }
                return new JObject { ["sheets"] = made, ["note"] = tbs.Count == 0 ? "No title block family is loaded, so sheets have no title block." : null };
            });
        }

        public static JToken OpenView(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            View v = null;
            if (a["view_id"] != null) v = doc.GetElement(H.EId(a["view_id"])) as View;
            else if (a["name"] != null)
            {
                string n = H.Str(a["name"]);
                v = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(x => !x.IsTemplate)
                    .FirstOrDefault(x => x.Name.Equals(n, StringComparison.OrdinalIgnoreCase))
                    ?? new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(x => !x.IsTemplate)
                    .FirstOrDefault(x => x.Name.IndexOf(n, StringComparison.OrdinalIgnoreCase) >= 0);
            }
            if (v == null) throw new Exception("View not found.");
            app.ActiveUIDocument.RequestViewChange(v);
            return new JObject { ["opened"] = v.Name };
        }

        static List<ElementId> PrintIds(Document doc, JObject a)
        {
            var ids = new List<ElementId>();
            foreach (var t in (a["sheet_ids"] as JArray) ?? new JArray()) ids.Add(H.EId(t));
            foreach (var t in (a["view_ids"] as JArray) ?? new JArray()) ids.Add(H.EId(t));
            if (a["all_sheets"]?.Value<bool>() == true || ids.Count == 0)
                ids.AddRange(new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>().Where(s => !s.IsPlaceholder).OrderBy(s => s.SheetNumber).Select(s => s.Id));
            if (ids.Count == 0) throw new Exception("There are no sheets to export. Create sheets first or give view_ids.");
            return ids;
        }

        public static JToken ExportPdf(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            var ids = PrintIds(doc, a);
            var folder = ExportFolder(a);
            string name = H.Str(a["file_name"]) ?? (doc.Title + " drawings");
            var opts = new PDFExportOptions { FileName = name, Combine = true };
            bool ok = doc.Export(folder, ids, opts);
            if (!ok) throw new Exception("Revit could not export the PDF.");
            return new JObject { ["file"] = Path.Combine(folder, name + ".pdf"), ["pages"] = ids.Count };
        }

        /// <summary>Exports a 3D view to FBX so Blender can make renders, walkthroughs, construction films and buyer tours.</summary>
        public static JToken ExportFbx(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            var folder = ExportFolder(a);
            View3D view = a["view_id"] != null ? doc.GetElement(H.EId(a["view_id"])) as View3D : null;
            if (view == null)
            {
                view = new FilteredElementCollector(doc).OfClass(typeof(View3D)).Cast<View3D>()
                    .FirstOrDefault(v => !v.IsTemplate && v.Name == "3D - Ollic export");
                if (view == null)
                {
                    using (var t = new Transaction(doc, "Ollic Sketch: 3D view for export"))
                    {
                        t.Start();
                        view = View3D.CreateIsometric(doc, H.ViewType(doc, ViewFamily.ThreeDimensional).Id);
                        TryName(view, "3D - Ollic export");
                        view.DetailLevel = ViewDetailLevel.Fine;
                        t.Commit();
                    }
                }
            }
            if (view.IsTemplate) throw new Exception("Choose a 3D view, not a view template.");
            string name = H.Str(a["file_name"]) ?? (doc.Title + " model");
            var set = new ViewSet();
            set.Insert(view);
            var opts = new FBXExportOptions { WithoutBoundaryEdges = true };
            bool ok = doc.Export(folder, name, set, opts);
            if (!ok) throw new Exception("Revit could not export the FBX file.");
            var file = Path.Combine(folder, name.EndsWith(".fbx", StringComparison.OrdinalIgnoreCase) ? name : name + ".fbx");
            return new JObject { ["file"] = file, ["view"] = view.Name, ["next"] = "Open Blender and use blender_import_model with this file." };
        }

        public static JToken ExportImage(UIApplication app, JObject a)
        {
            var doc = H.Doc(app);
            var folder = ExportFolder(a);
            View3D view = a["view_id"] != null ? doc.GetElement(H.EId(a["view_id"])) as View3D : null;
            var start = DateTime.Now.AddSeconds(-2);
            var ids = new List<ElementId>();
            if (view == null && a["view_id"] != null) ids.Add(H.EId(a["view_id"]));
            else
            {
                if (view == null)
                {
                    using (var t = new Transaction(doc, "Ollic Sketch: 3D view for image"))
                    {
                        t.Start();
                        view = View3D.CreateIsometric(doc, H.ViewType(doc, ViewFamily.ThreeDimensional).Id);
                        TryName(view, "3D - Ollic image");
                        t.Commit();
                    }
                }
                string style = (H.Str(a["style"]) ?? "realistic").ToLowerInvariant();
                using (var t = new Transaction(doc, "Ollic Sketch: image style"))
                {
                    t.Start();
                    view.DisplayStyle = style == "shaded" ? DisplayStyle.Shading : style == "hidden" ? DisplayStyle.HLR : DisplayStyle.Realistic;
                    view.DetailLevel = ViewDetailLevel.Fine;
                    t.Commit();
                }
                ids.Add(view.Id);
            }
            string baseName = H.Str(a["file_name"]) ?? doc.Title + " view";
            var opts = new ImageExportOptions
            {
                ExportRange = ExportRange.SetOfViews,
                FilePath = Path.Combine(folder, baseName),
                ZoomType = ZoomFitType.FitToPage,
                PixelSize = (int)H.Num(a["width_px"], 2400),
                FitDirection = FitDirectionType.Horizontal,
                ImageResolution = ImageResolution.DPI_300,
                HLRandWFViewsFileType = ImageFileType.PNG,
                ShadowViewsFileType = ImageFileType.PNG,
            };
            opts.SetViewsAndSheets(ids);
            doc.ExportImage(opts);
            var files = Directory.GetFiles(folder).Where(f => File.GetLastWriteTime(f) >= start).ToList();
            return new JObject { ["files"] = new JArray(files), ["folder"] = folder, ["note"] = "For photorealistic renders and animations, use the Blender connection." };
        }
    }
}
