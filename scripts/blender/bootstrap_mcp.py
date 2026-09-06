"""Run only in a dedicated Blender --factory-startup process for this workspace."""
import os
import sys
from pathlib import Path

import bpy

tool_env = Path(os.environ.get("WOWPVP_BLENDER_MCP_ENV", "E:/work/tools/blendmcp-env"))
sys.path.insert(0, str(tool_env / "Lib" / "site-packages"))
bpy.ops.preferences.addon_enable(module="blendmcp_addon")
scene = bpy.context.scene
scene.name = "WOWPVP_AssetLab"
scene["wowpvp_asset_workspace"] = True
scene.blendermcp_port = int(os.environ.get("BLENDER_PORT", "9877"))
scene.blendermcp_use_polyhaven = False
scene.blendermcp_use_sketchfab = False
scene.blendermcp_use_hyper3d = False
scene.blendermcp_use_hunyuan3d = False
bpy.ops.blendermcp.start_server()
print(f"WOWPVP Blender MCP ready on localhost:{scene.blendermcp_port}", flush=True)
