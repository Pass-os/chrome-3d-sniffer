import os
import sys

import bpy

argv = sys.argv
path = argv[argv.index("--") + 1] if "--" in argv else None
if not path:
    raise SystemExit("sem arquivo")

ext = os.path.splitext(path)[1].lower()

# limpa a cena padrão (cubo, luz, câmera)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()

importers = {
    ".glb": lambda: bpy.ops.import_scene.gltf(filepath=path),
    ".gltf": lambda: bpy.ops.import_scene.gltf(filepath=path),
    ".obj": lambda: bpy.ops.wm.obj_import(filepath=path),
    ".fbx": lambda: bpy.ops.import_scene.fbx(filepath=path),
    ".stl": lambda: bpy.ops.wm.stl_import(filepath=path),
    ".ply": lambda: bpy.ops.wm.ply_import(filepath=path),
    ".dae": lambda: bpy.ops.wm.collada_import(filepath=path),
    ".usd": lambda: bpy.ops.wm.usd_import(filepath=path),
    ".usda": lambda: bpy.ops.wm.usd_import(filepath=path),
    ".usdc": lambda: bpy.ops.wm.usd_import(filepath=path),
    ".usdz": lambda: bpy.ops.wm.usd_import(filepath=path),
}

result = importers[ext]()
print("import result:", result, "objects:", len(bpy.data.objects))


def frame_all():
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type == "VIEW_3D":
                region = next(r for r in area.regions if r.type == "WINDOW")
                with bpy.context.temp_override(window=window, area=area, region=region):
                    bpy.ops.view3d.view_all()
                    area.spaces[0].shading.type = "MATERIAL"
                return None
    return 0.2


bpy.app.timers.register(frame_all, first_interval=0.5)
