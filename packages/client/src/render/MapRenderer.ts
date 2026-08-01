/**
 * 地图渲染。
 *
 * ★ 网格**完全由 `MapDef.geometry` 生成**，不允许美术单独提供场景模型再「大致对齐」碰撞盒。
 *   见 docs/06-modes-and-maps.md §8.2 —— 那样做会立刻违反验收 #8（范围边界与判定一致）
 *   和 #11（墙柱门正确挡视线）。所见即所中，只有一份几何。
 *
 * ★ M12 引入美术后这条**更要守住**：地面贴图只换 `material`，
 *   `BoxGeometry` 的三个尺寸仍逐字来自 `MapVolume` 的 min/max。
 *   贴图糊了是观感问题，几何偏一米是**判定**问题。
 */

import * as THREE from 'three';
import type { MapDef, MapVolume } from '@wowpvp/shared';
import { loadGroundTextures, type GroundTexture } from './Environment.js';

/**
 * 按语义标签选材。颜色只影响观感，判定看 Aabb 上的 flag。
 *
 * ★ M12 起（`art` 开启时）用 `MeshStandardMaterial` —— `MeshLambertMaterial`
 *   不参与 `scene.environment` 的 IBL，混用会让地图在有 HDR 时明显比角色「脏」。
 *   roughness/metal 按材质语义给，石头粗糙、水面光滑。
 *
 * ★ **颜色沿用 M11 的原值，一个都没调亮。** 有 HDR 时靠 IBL 提亮，
 *   没有时就是 M11 那个画面 —— 两条路径共用一张表，才谈得上
 *   「`art=off` 精确等于 M11」。
 */
const MATERIALS: Record<
  MapVolume['tag'],
  { color: number; opacity?: number; roughness?: number; metalness?: number }
> = {
  floor: { color: 0x3a4048, roughness: 0.95 },
  wall: { color: 0x555d68, roughness: 0.85 },
  pillar: { color: 0x6a7280, roughness: 0.8 },
  roof: { color: 0x4a5058, roughness: 0.9 },
  ramp: { color: 0x455060, roughness: 0.85 },
  rail: { color: 0x8a7a5a, roughness: 0.6 },
  arch: { color: 0x7a6a9a, opacity: 0.25, roughness: 0.4 },
  water: { color: 0x2a6a9a, opacity: 0.45, roughness: 0.08, metalness: 0.2 },
  gate: { color: 0x9a6a3a, roughness: 0.7 },
};

export class MapRenderer {
  readonly group = new THREE.Group();
  private debugGroup = new THREE.Group();
  /** 地面网格与它的水平尺寸，M12 的地形贴图按米制平铺时要用 */
  private readonly floors: { mesh: THREE.Mesh; w: number; d: number }[] = [];

  /**
   * @param pbr 用 PBR 材质（吃 IBL）还是 M11 的 Lambert。
   *
   * ★★ **`?art=off` 时必须回到 Lambert，不能只是「不给贴图」。**
   *   PBR 着色本身就比 Lambert 贵得多 —— 实测软件渲染下光是换材质
   *   就让帧率从 21 掉到 14，而 M1–M9 的验收脚本正跑在软件渲染上，
   *   且历史上曾因为 12 FPS 超时过（见 PROGRESS 的 M4 性能修复）。
   *   `art=off` 的契约是「**精确**回到 M11 的表现」，否则那 106 项的
   *   结果就不能和历史直接对比 —— 而能对比正是这个开关存在的理由。
   */
  constructor(map: MapDef, pbr = true) {
    this.group.name = `map:${map.id}`;
    this.debugGroup.visible = false;
    this.group.add(this.debugGroup);

    for (const v of map.geometry) {
      const w = v.max.x - v.min.x;
      const h = v.max.y - v.min.y;
      const d = v.max.z - v.min.z;
      const spec = MATERIALS[v.tag] ?? { color: 0x666666 };

      const common = {
        color: spec.color,
        transparent: spec.opacity !== undefined,
        opacity: spec.opacity ?? 1,
      };
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        pbr
          ? new THREE.MeshStandardMaterial({
              ...common,
              roughness: spec.roughness ?? 0.9,
              metalness: spec.metalness ?? 0,
            })
          : new THREE.MeshLambertMaterial(common),
      );
      mesh.position.set(
        (v.min.x + v.max.x) / 2,
        (v.min.y + v.max.y) / 2,
        (v.min.z + v.max.z) / 2,
      );
      mesh.name = v.id;
      mesh.castShadow = v.tag !== 'floor';
      mesh.receiveShadow = true;
      this.group.add(mesh);

      if (v.tag === 'floor') this.floors.push({ mesh, w, d });

      // 调试线框：标出「挡移动但不挡视线」的物件（6.4 低矮栏杆）
      if (v.blocksSight === false && v.blocksMovement !== false) {
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)),
          new THREE.LineBasicMaterial({ color: 0x00ff88 }),
        );
        edges.position.copy(mesh.position);
        this.debugGroup.add(edges);
      }
    }
  }

  /**
   * M12：给地面铺真实材质。失败或素材缺失时保留纯色 —— 不阻塞、不报错。
   *
   * ★ 贴图**每 4 米重复一次**。这个数字不是随手取的：13.5 的移动验收要靠
   *   地面纹理判断「滑了多远」，纹理周期与米制对得上，肉眼才能当尺子用
   *   （试验场的 1 米网格线也仍然画着，两者互补）。
   */
  async applyGroundTexture(kind: GroundTexture): Promise<void> {
    if (this.floors.length === 0) return;
    // 同一份贴图在所有地面间共享，但 repeat 各不相同 → 逐块克隆（克隆共享 image）
    const base = await loadGroundTextures(kind, 1);
    if (!base) return;

    for (const { mesh, w, d } of this.floors) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      /**
       * ★ 分轴算重复次数。`BoxGeometry` 六个面共用 0–1 的 UV，
       *   顶面因此把整个 w×d 映射到一格 —— 用 `max(w,d)` 会让长条地面
       *   在短边方向被拉伸成条纹，而地面纹理正是用来目测距离的。
       */
      const use = (t: THREE.Texture): THREE.Texture => {
        const c = t.clone();
        c.needsUpdate = true;
        c.repeat.set(Math.max(1, Math.round(w / 4)), Math.max(1, Math.round(d / 4)));
        return c;
      };
      mat.map = use(base.map);
      if (base.normalMap) mat.normalMap = use(base.normalMap);
      if (base.roughnessMap) mat.roughnessMap = use(base.roughnessMap);
      // 贴图自带明暗，底色调回白色，否则叠出来是脏的
      mat.color.setHex(0xffffff);
      mat.needsUpdate = true;
    }
    this.textured = true;
  }

  /** 地面是否已铺上真实材质。供 `verify:m12` 观察，不提供开关 */
  get groundTextured(): boolean {
    return this.textured;
  }
  private textured = false;

  setDebugVisible(v: boolean): void {
    this.debugGroup.visible = v;
  }
}
