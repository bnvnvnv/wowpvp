# Blender assets and bot navigation

Updated: 2026-09-06.

## Bot failures found

The previous 2D A* navigator was only connected to capture-the-flag movement.
Arena and training bots could still walk directly into a wall. The trigger required forward movement and blocked line of sight, so a ranged bot already within cast range could stop behind cover, while low barriers with clear sight never triggered routing.
It also planned at one ground height and waited for a target to move five meters before updating the path.

## Current implementation

`packages/shared/src/navigation/index.ts` uses [Recast/Detour through recast-navigation-js](https://github.com/isaac-mason/recast-navigation-js).
Navigation meshes are built from the same solid AABBs used by character movement, including stacked walkable surfaces and active map restrictions.
Body clearance accounts for character radius and height. The movement output still passes through the existing movement solver and, on the server, the normal input protocol.

- All server game modes and combat-enabled local training now share this navigator.
- Blocked sight can trigger routing even when a ranged controller requests zero forward movement.
- Body-height checks catch low barriers that do not block the eye-level sight ray.
- Routes follow moving goals, cache their waypoints, replan when progress stalls and request a jump for supported small steps.
- Unobstructed spacing, dodging and retreat decisions remain in the combat controller.
- A stationary active cast is preserved so an enemy behind a wall does not repeatedly interrupt the bot's own healing.
- Map meshes are reused across matches with bounded inactive cache entries. A match releases its handles on reset, abandonment and server shutdown.
- The browser loads the navigation WASM through a separate dynamic import only for local bot combat. It is not initialized on the lobby screen.

This improves traversal and pursuit. Tactical choices, alternative targets for unreachable destinations, long jumps and human-level team strategy remain separate work.

## Blender workflow

See [the installation and rebuild guide](../scripts/blender/README.md).
The MCP server, matching add-on and Blender 5.2 were connected and used to build an editable sword-and-shield sample.
The runtime still uses Three.js; Blender is an asset creation tool and does not replace the browser renderer.

The pair uses bright blue, silver and gold, readable silhouettes and one vertex-color material per weapon.
The sword has 1128 triangles and the shield 1108. The total exported GLB size is approximately 200 KiB.
The warrior's default equipment now selects these assets, and the class preview fits the equipped model's bounds.
Source and attribution are recorded in `assets/SOURCE.md` and `docs/09-asset-license.md`.

The original compressed reference GLBs required geometry-only copies for Blender inspection.
Imported references are excluded from the sample GLBs and saved source scene.

## Verification

- Full Vitest suite: 140 files, 2925 tests passed.
- Navigation regressions run the actual movement solver across wall corners, low cover, 0.4/0.5 m steps, the arena and the CTF8 underground-to-surface route.
- Server regressions verify a warrior can reach and damage a target behind cover, and that a priest can finish healing while its enemy is occluded.
- Type checking and ESLint passed. The production client build emits the navigation WASM in a separate lazy chunk.
- Chrome checks covered 1440 x 900 and 390 x 844 game canvases, WebGL pixel samples, equipped weapon nodes, training navigation initialization and a live server arena.
- The browser checks also exercised keyboard movement and observed moving entities in the server match. Art acceptance (`pnpm verify:m12`) passed all 26 checks.
- A fresh Blender background process reopened the saved source successfully and verified it contains only the sample's nine objects, three meshes and two materials.
- Diagnostics and captures are in the ignored `scripts/.diag/blender-navigation-20260905/` directory.

Narrow-screen rendering checks do not establish touch-control support. The suite also does not establish long-session or 24-player performance under production load.
No native AI bitmap was generated in this session because the callable image-generation tool was absent, even though the client feature switch was enabled.
