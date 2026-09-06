"""Build an editable stylized sword/shield set in the isolated Blender MCP workspace."""
import bpy
import bmesh
import json
import math
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
if bpy.context.scene.name != "WOWPVP_AssetLab" or not bpy.context.scene.get("wowpvp_asset_workspace"):
    raise RuntimeError("This script requires the isolated WOWPVP asset workspace")
scene = bpy.context.scene
# This dedicated scratch scene is rebuilt, including any temporary reference imports.
for obj in list(scene.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
for collection in list(bpy.data.collections):
    if collection.name.startswith("RoyalArmory_"):
        bpy.data.collections.remove(collection)
bpy.data.orphans_purge(do_recursive=True)

palette = bpy.data.materials.get("RoyalArmory_Palette") or bpy.data.materials.new("RoyalArmory_Palette")
palette.use_nodes = True
palette.use_backface_culling = True
nodes = palette.node_tree.nodes
nodes.clear()
out = nodes.new("ShaderNodeOutputMaterial")
shader = nodes.new("ShaderNodeBsdfPrincipled")
color = nodes.new("ShaderNodeVertexColor")
color.layer_name = "Color"
palette.node_tree.links.new(color.outputs["Color"], shader.inputs["Base Color"])
shader.inputs["Metallic"].default_value = 0.35
shader.inputs["Roughness"].default_value = 0.34
palette.node_tree.links.new(shader.outputs["BSDF"], out.inputs["Surface"])

STEEL = (0.52, 0.77, 0.88, 1)
EDGE = (0.85, 0.96, 1.0, 1)
GOLD = (0.95, 0.54, 0.08, 1)
GOLD_LIGHT = (1.0, 0.78, 0.23, 1)
NAVY = (0.015, 0.11, 0.18, 1)
BLUE = (0.025, 0.38, 0.62, 1)
BLUE_LIGHT = (0.08, 0.57, 0.72, 1)
GEM = (0.03, 0.85, 0.83, 1)


def paint(obj, rgba):
    obj.data.materials.clear()
    obj.data.materials.append(palette)
    attr = obj.data.color_attributes.get("Color") or obj.data.color_attributes.new(name="Color", type="BYTE_COLOR", domain="CORNER")
    for item in attr.data:
        item.color = rgba
    return obj


def prism(name, outline, front, back, rgba, bevel=0.008):
    n = len(outline)
    vertices = [(x, front, z) for x, z in outline] + [(x, back, z) for x, z in outline]
    faces = [tuple(reversed(range(n))), tuple(range(n, n * 2))]
    faces.extend((i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    paint(obj, rgba)
    if bevel:
        mod = obj.modifiers.new("Edge bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
    return obj


def cylinder(name, radius, depth, location, rgba, vertices=12, axis="Z"):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location)
    obj = bpy.context.object
    obj.name = name
    if axis == "Y":
        obj.rotation_euler.x = math.pi / 2
    paint(obj, rgba)
    return obj


def join_asset(name, parts):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in parts:
        obj.hide_set(False)
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        for mod in list(obj.modifiers):
            bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    obj = bpy.context.object
    obj.name = name
    scene.cursor.location = (0, 0, 0)
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    obj.data.validate()
    obj.data.update()
    return obj


blade = [(-0.09, 0.015), (-0.14, 0.28), (-0.145, 0.94), (0, 1.40), (0.145, 0.94), (0.14, 0.28), (0.09, 0.015)]
inner = [(-0.075, 0.10), (-0.104, 0.34), (-0.106, 0.94), (0, 1.31), (0.106, 0.94), (0.104, 0.34), (0.075, 0.10)]
parts = [prism("Sword polished edge", blade, -0.045, 0.045, EDGE),
         prism("Sword broad blue steel", inner, -0.052, 0.052, STEEL, 0.006)]
ridge = [(-0.025, 0.24), (-0.034, 0.94), (0, 1.31), (0.034, 0.94), (0.025, 0.24)]
parts.append(prism("Sword raised fuller", ridge, -0.066, 0.066, BLUE_LIGHT, 0.004))
guard = [(-0.31, 0.025), (-0.32, 0.15), (-0.22, 0.12), (-0.14, 0.045), (0, 0.025),
         (0.14, 0.045), (0.22, 0.12), (0.32, 0.15), (0.31, 0.025), (0.16, -0.045), (-0.16, -0.045)]
parts.append(prism("Sword swept gold guard", guard, -0.068, 0.068, GOLD, 0.014))
parts.append(cylinder("Sword grip", 0.044, 0.26, (0, 0, -0.16), NAVY))
for z in [-0.055, -0.12, -0.185, -0.25]:
    parts.append(cylinder("Sword grip binding", 0.049, 0.017, (0, 0, z), GOLD_LIGHT))
parts.append(prism("Sword diamond pommel", [(0, -0.39), (-0.078, -0.32), (0, -0.25), (0.078, -0.32)], -0.06, 0.06, GOLD, 0.009))
parts.append(prism("Sword inset gem", [(0, -0.365), (-0.043, -0.32), (0, -0.276), (0.043, -0.32)], -0.071, -0.055, GEM, 0.004))
parts.append(prism("Sword guard jewel", [(0, -0.018), (-0.057, 0.044), (0, 0.125), (0.057, 0.044)], -0.086, -0.06, GEM, 0.006))
sword = join_asset("RoyalArmory_Sword", parts)

outline = [(-0.34, 0.42), (0, 0.51), (0.34, 0.42), (0.43, 0.15), (0.36, -0.23), (0, -0.55), (-0.36, -0.23), (-0.43, 0.15)]
inset = [(x * 0.88, z * 0.88) for x, z in outline]
parts = [prism("Shield gold rim", outline, -0.09, 0.065, GOLD, 0.025),
         prism("Shield enamel", inset, -0.145, -0.078, BLUE, 0.015)]
parts.append(prism("Shield center facet", [(0, 0.435), (-0.15, 0.30), (-0.12, -0.24), (0, -0.47), (0.12, -0.24), (0.15, 0.30)], -0.16, -0.143, BLUE_LIGHT, 0.008))
crown = [(-0.19, -0.09), (-0.21, 0.15), (-0.105, 0.07), (0, 0.25), (0.105, 0.07), (0.21, 0.15), (0.19, -0.09)]
parts.append(prism("Shield crown emblem", crown, -0.197, -0.155, GOLD_LIGHT, 0.009))
parts.append(prism("Shield crown base", [(-0.19, -0.14), (-0.19, -0.095), (0.19, -0.095), (0.19, -0.14)], -0.199, -0.157, GOLD, 0.008))
parts.append(prism("Shield crown sapphire", [(0, -0.035), (-0.039, 0.02), (0, 0.084), (0.039, 0.02)], -0.217, -0.193, GEM, 0.004))
for x, z in [(-0.26, 0.33), (0.26, 0.33), (-0.31, -0.16), (0.31, -0.16), (0, -0.42)]:
    parts.append(cylinder("Shield rivet", 0.022, 0.016, (x, -0.142, z), GOLD_LIGHT, 10, "Y"))
parts.append(cylinder("Shield rear handle", 0.045, 0.24, (0, 0.11, 0), NAVY, 12))
shield = join_asset("RoyalArmory_Shield", parts)
# The existing left-hand attachment presents the asset's positive Y side outward.
shield.rotation_euler.z = math.pi

asset_dir = ROOT / "assets/art/models/weapons/custom"
source_dir = ROOT / "assets/source/royal-armory"
preview_dir = ROOT / "assets/art/ui/screens"
for directory in [asset_dir, source_dir, preview_dir]:
    directory.mkdir(parents=True, exist_ok=True)
assets = [(sword, "royal_sword_v1"), (shield, "royal_shield_v1")]
metrics = []
for obj, filename in assets:
    bpy.ops.object.select_all(action="DESELECT")
    obj.hide_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(filepath=str(asset_dir / f"{filename}.glb"), export_format="GLB", use_selection=True,
                              export_animations=False, export_cameras=False, export_lights=False, export_apply=True)
    obj.data.calc_loop_triangles()
    metrics.append({"asset": filename, "triangles": len(obj.data.loop_triangles), "vertices": len(obj.data.vertices)})
    obj.hide_render = True
    obj.hide_set(True)

preview = bpy.data.collections.new("RoyalArmory_Preview")
scene.collection.children.link(preview)
for original, location in [(sword, (-0.53, 0, 0.39)), (shield, (0.52, 0.08, 0.55))]:
    obj = original.copy()
    obj.name = original.name + "_Display"
    preview.objects.link(obj)
    obj.location = location
    obj.rotation_euler.z = 0
    obj.hide_render = False
    obj.hide_set(False)

bpy.ops.mesh.primitive_plane_add(size=200)
ground = bpy.context.object
ground.name = "RoyalArmory_Ground"
mat = bpy.data.materials.new("RoyalArmory_Backdrop")
mat.diffuse_color = (0.67, 0.75, 0.78, 1)
ground.data.materials.append(mat)
bpy.ops.object.camera_add(location=(2.6, -6, 2.5))
camera = bpy.context.object
camera.name = "RoyalArmory_Camera"
camera.rotation_euler = (Vector((0, 0, 0.95)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.type = 'ORTHO'
camera.data.ortho_scale = 2.7
scene.camera = camera
for name, position, energy, size in [
    ("Key", (-3, -4, 5), 500, 3), ("Fill", (4, -1, 3), 260, 3), ("Rim", (0, 3, 4), 380, 2),
]:
    bpy.ops.object.light_add(type='AREA', location=position)
    light = bpy.context.object
    light.name = "RoyalArmory_" + name
    light.data.energy = energy
    light.data.shape = 'DISK'
    light.data.size = size
    light.rotation_euler = (Vector((0, 0, 0.8)) - light.location).to_track_quat('-Z', 'Y').to_euler()
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.render.resolution_x = 1200
scene.render.resolution_y = 900
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = 'Standard'
scene.view_settings.exposure = -0.7
scene.world.color = (0.25, 0.25, 0.25)
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = str(preview_dir / "royal-armory-v1.png")
bpy.ops.wm.save_as_mainfile(filepath=str(source_dir / "royal-armory-v1.blend"))
bpy.ops.render.render(write_still=True)
print(json.dumps({"assets": metrics, "source": str(source_dir), "preview": scene.render.filepath}))
