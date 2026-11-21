using System;
using System.Collections.Generic;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace OllicSketch.Revit
{
    internal static class Dispatcher
    {
        private static readonly Dictionary<string, Func<UIApplication, JObject, JToken>> Tools =
            new Dictionary<string, Func<UIApplication, JObject, JToken>>(StringComparer.OrdinalIgnoreCase)
            {
                // Reading the model
                ["get_project_info"] = Query.ProjectInfo,
                ["get_selection"] = Query.Selection,
                ["list_elements"] = Query.ListElements,
                ["list_types"] = Query.ListTypes,
                ["get_quantities"] = Query.Quantities,
                // Architecture
                ["create_levels"] = Arch.CreateLevels,
                ["create_grids"] = Arch.CreateGrids,
                ["create_walls"] = Arch.CreateWalls,
                ["create_floors"] = Arch.CreateFloors,
                ["create_roof"] = Arch.CreateRoof,
                ["place_openings"] = Arch.PlaceOpenings,
                ["create_rooms"] = Arch.CreateRooms,
                ["place_components"] = Arch.PlaceComponents,
                ["modify_elements"] = Arch.Modify,
                ["delete_elements"] = Arch.Delete,
                // Structure
                ["create_columns"] = Structure.CreateColumns,
                ["create_beams"] = Structure.CreateBeams,
                ["create_foundations"] = Structure.CreateFoundations,
                // MEP and coordination
                ["create_pipes"] = Mep.CreatePipes,
                ["create_ducts"] = Mep.CreateDucts,
                ["find_clashes"] = Mep.FindClashes,
                // Drawings and output
                ["create_views"] = Docs.CreateViews,
                ["create_sheets"] = Docs.CreateSheets,
                ["open_view"] = Docs.OpenView,
                ["export_pdf"] = Docs.ExportPdf,
                ["export_image"] = Docs.ExportImage,
                ["export_fbx"] = Docs.ExportFbx,
            };

        public static JToken Run(UIApplication app, JObject req)
        {
            string tool = (string)req["tool"] ?? throw new Exception("missing tool name");
            var args = req["args"] as JObject ?? new JObject();
            if (!Tools.TryGetValue(tool, out var fn)) throw new Exception("Unknown Revit command: " + tool);
            return fn(app, args);
        }
    }
}
