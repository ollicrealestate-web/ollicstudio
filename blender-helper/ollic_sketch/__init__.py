bl_info = {
    "name": "Ollic Sketch",
    "author": "OLLIC Real Estate Development Limited",
    "version": (0, 2, 0),
    "blender": (4, 2, 0),
    "location": "Runs in the background; used by Claude through Ollic Sketch",
    "description": "Lets Claude build models from plans, light them, fly camera paths, render walkthroughs and construction films, and export 3D buyer tours.",
    "category": "Import-Export",
}

import bpy

from . import server


def register():
    # No connection when Blender runs without a window (setup, tests, render farms).
    if not bpy.app.background:
        server.start()


def unregister():
    server.stop()


if __name__ == "__main__":
    register()
