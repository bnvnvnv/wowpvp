# Blender asset workflow

## Installed local setup

- Blender: `E:\Program Files\Blender Foundation\Blender 5.2\blender.exe`
- Isolated Python environment: `E:\work\tools\blendmcp-env`
- MCP server and matching Blender add-on: [BlendMCP](https://github.com/owenpkent/blendmcp), version 1.4.3, commit `ee36dea918b3d12bd73ec4eb53403de229cda23d`.
- MCP SDK: 1.29.1. Keep `mcp<2`: this server imports the SDK 1.x FastMCP API.
- Codex server name: `blender`; STDIO executable: `E:\work\tools\blendmcp-env\Scripts\blendmcp.exe`.
- Blender socket: `127.0.0.1:9877`. External model and asset service integrations are disabled.

Codex registration follows its [official MCP setup](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
The configured tool allowlist covers scene inspection, viewport capture, Python execution, primitives, materials and object editing.
Startup timeout is 20 seconds; tool timeout is 180 seconds. An existing Codex conversation may need a new session to expose a newly registered server's tool catalog.
The helper below uses a real MCP STDIO client and works independently of that catalog refresh.

## Start and inspect

Run from the repository root in PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/blender/start-mcp.ps1
& 'E:\work\tools\blendmcp-env\Scripts\python.exe' scripts/blender/mcp_call.py get_blender_status
& 'E:\work\tools\blendmcp-env\Scripts\python.exe' scripts/blender/mcp_call.py get_scene_info
```

The launcher starts a hidden, independent `--factory-startup` process named `WOWPVP_AssetLab`.
It does not save global Blender preferences. If port 9877 is already listening, reuse that process instead of launching another.
`-BlenderPath`, `-ToolEnvironment` and `-Port` override the launcher's local defaults.
The MCP helper accepts `--host` and `--port`; match those values in the Codex server environment when changing ports.
Logs are ignored under `scripts/.diag/blender-mcp/`.

## Rebuild the sample

```powershell
& 'E:\work\tools\blendmcp-env\Scripts\python.exe' scripts/blender/mcp_call.py execute_blender_code --code-file scripts/blender/build_royal_armory.py
```

The builder requires the isolated `WOWPVP_AssetLab` scene and the launcher's workspace marker.
It rebuilds that dedicated scratch scene, removing temporary references, and outputs:

| Output | Purpose |
| --- | --- |
| `assets/source/royal-armory/royal-armory-v1.blend` | Editable source, display copies, camera and lights |
| `assets/art/models/weapons/custom/royal_sword_v1.glb` | 1128 triangles, one material |
| `assets/art/models/weapons/custom/royal_shield_v1.glb` | 1108 triangles, one material |
| `assets/art/ui/screens/royal-armory-v1.png` | 1200 x 900 Blender render |

The new models use vertex colors and no texture downloads. Their attachment coordinates match the existing character weapon pipeline.
`ModelLibrary.ts` selects this pair for `warrior.sword_shield`. Source and exports contain no imported reference mesh.

Optional reference inspection:

```powershell
node scripts/blender/prepare-reference.mjs
& 'E:\work\tools\blendmcp-env\Scripts\python.exe' scripts/blender/mcp_call.py execute_blender_code --code-file scripts/blender/inspect_weapon.py
```

The original weapon GLBs use compressed textures Blender 5.2 cannot import directly.
The preparation script creates geometry-only copies in the ignored diagnostic directory; it does not modify the shipped originals.

## Recreate the private environment

```powershell
& 'E:\Program Files\Blender Foundation\Blender 5.2\5.2\python\bin\python.exe' -m venv E:\work\tools\blendmcp-env
& 'E:\work\tools\blendmcp-env\Scripts\python.exe' -m pip install -r scripts/blender/requirements-mcp.txt
& 'E:\work\tools\blendmcp-env\Scripts\blendmcp.exe' install-addon --blender-version 5.2
codex.cmd mcp add blender --env BLENDER_HOST=127.0.0.1 --env BLENDER_PORT=9877 -- E:\work\tools\blendmcp-env\Scripts\blendmcp.exe
```

## Image generation status

This session had the `image_generation` client feature enabled but no callable native image-generation tool.
No Images API or image CLI fallback was used. The sample image is a Blender render; the warrior portrait is a game capture.
Native AI concept art and texture generation remain pending tool availability.
