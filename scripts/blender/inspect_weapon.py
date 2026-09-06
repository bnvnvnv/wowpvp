import bpy
import json
from mathutils import Vector
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

if bpy.context.scene.name != "WOWPVP_AssetLab":
    raise RuntimeError("This script requires the isolated WOWPVP asset workspace")

result = []
for name in ["adv_sword_1handed", "shield_round"]:
    bpy.ops.import_scene.gltf(filepath=str(ROOT / f"scripts/.diag/blender-navigation-20260905/references/{name}.glb"))
    objects = list(bpy.context.selected_objects)
    points = [obj.matrix_world @ Vector(corner) for obj in objects if obj.type == "MESH" for corner in obj.bound_box]
    result.append({"asset": name, "min": [min(p[i] for p in points) for i in range(3)],
                   "max": [max(p[i] for p in points) for i in range(3)],
                   "objects": [obj.name for obj in objects]})
    for obj in objects:
        obj.hide_set(True)
        obj.hide_render = True
print(json.dumps(result))
