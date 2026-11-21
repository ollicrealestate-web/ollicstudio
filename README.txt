OLLIC SKETCH 0.2  -  Design in your own Revit and Blender by talking to Claude
==============================================================================

WHAT IT DOES
Ollic Sketch connects Claude to the Revit and Blender on your computer. You type what you
want in plain English, and Claude builds or changes it in your real model:

  Architecture  levels, grids, walls, floors, roofs (gable, hip, mono, flat),
                doors, windows, rooms, fittings and furniture
  Structure     columns, beams (incl. ring beams on walls), strip and pad footings
  MEP           pipes and ducts, plus clash checks against the structure
  Drawings      plans, sections, elevations, 3D views, sheets, PDF and image export
  Cost          measured quantities and a priced bill of quantities in Naira
  Visuals       (Blender) realistic or clay renders, sun by time of day,
                a camera path through the house, walkthrough videos,
                a foundation-to-furnished construction film, and a 3D buyer
                tour (one HTML file: walk, dollhouse, guided tour, music)

Every change is one undo step in Revit (Ctrl+Z).

WHAT YOU NEED
  - A Windows computer with Revit 2024, 2025, 2026 or 2027 (full Revit, not Revit LT)
  - For visuals: Blender 4.2 or newer (free, blender.org), installed normally
  - Claude Desktop for Windows (claude.ai/download), signed in
  - Internet for the first setup (it downloads Microsoft's free .NET build tools once)

INSTALL (about 5-10 minutes the first time)
  1. Unzip this folder anywhere, for example to your Desktop.
  2. Close Revit and Blender.
  3. Double-click "Install Ollic Sketch.bat" and follow the window.
  4. Claude Desktop opens the Ollic Sketch extension. Click Install.
     If it does not open: Claude Desktop > Settings > Extensions >
     Advanced settings > Install extension, then choose OllicSketch.mcpb.

FIRST TEST
  1. Open Revit and any project (an architectural template is fine).
     If Revit asks about loading "Ollic Sketch", choose "Always Load".
  2. In Claude Desktop, start a new chat and type:
        Check the Ollic Sketch connection, then tell me about my Revit project.
  3. Then try:
        Create Ground floor at 0 and First floor at 3150. On Ground floor draw a
        12 m x 10 m outline of 225 mm walls, 3000 mm high, starting at 0,0.
  4. Look in Revit: the walls are there. Ctrl+Z in Revit undoes the change.
  5. Open Blender, then type:
        Send my Revit model to Blender, set it to 5 pm, and render the outside.
     Then: "Make a walkthrough video", "Make the construction film",
     "Export a buyer tour".

GOOD TO KNOW
  - Revit (or Blender) must be open for Claude to work in it.
  - Claude asks before deleting things it did not create in the chat.
  - Structural and MEP sizes Claude proposes are first drafts. A qualified
    engineer must check and sign them.
  - Naira rates for the BoQ are samples. Ask Claude: "show my Ollic rates" or
    "set the 225 block rate to 900". They are saved on your computer in
    %LOCALAPPDATA%\OllicSketch\rates.json
  - Exports go to Documents\Ollic Sketch\Exports
  - Setup log: %TEMP%\OllicSketch-setup.log

REMOVE
  Double-click "Uninstall Ollic Sketch.bat", then remove the extension in
  Claude Desktop > Settings > Extensions.

  - Videos render in the background; Blender stays usable. Ask "how is the
    render going?" to check.
  - AI-styled videos: Claude makes a grey video from the true model first, so
    an AI video service can restyle it without inventing walls.

COMING NEXT
  AutoCAD and Civil 3D, and saving projects and buyer tours online.
