/**
 * X14 后半：**全体**脚下阵营标记 + 便宜路轮廓。规格 00 §777、14.4、17.2。
 *
 * ★★ §777 要求阵营区分走**四条通道**：姓名板、脚下标记、轮廓、UI。
 *   此前只有三条：姓名板（P3a）、UI 目标框（P10），以及一个**只服务当前目标**
 *   的 `TargetRing`。也就是说在 12v12 里，除了你正选中的那一个，
 *   场上另外 22 个人脚下什么都没有 —— 「谁是敌人」全靠姓名板文字，
 *   而姓名板在混战里会被 `namePlateDensity` 裁掉一半。本文件补的是这一条。
 *
 * ★ 与 `TargetRing` 的分工（两者会同时出现在同一个人脚下，必须读得开）：
 *     · `TargetRing`  —— 「**我选的是他**」。半径 0.52–0.62 + 外扩刻度，
 *       高不透明度，自转 + 呼吸。**更醒目**是它的本分。
 *     · 本文件        —— 「他是哪一边」。半径 0.30–0.44，低不透明度，
 *       **完全静止**。静止 vs 运动本身就是第三条分辨通道，
 *       两个环半径不重叠，叠在一起也不会互相啃。
 *
 * ★★ 17.2「不能只依赖颜色」在这里是**两条**非颜色通道：
 *     · 友方 = 连续实环；敌对 = 八段虚线环（形状/虚实）
 *     · 敌对环外沿更大（0.44 vs 0.40）（尺寸）
 *   把画面转成灰度之后仍然分得出敌我 —— 这不是锦上添花，
 *   `paletteFor()` 的色盲色板只换色相，换不出「实线 vs 虚线」。
 *
 * ★★ 这是**可读性信息不是装饰**，与 14.4 的 essential 同口径：
 *   本文件**不 import `quality.ts` 的任何过滤函数**（只借 `ESSENTIAL_ROLES`
 *   做一次自检），所以没有人能在这里加一行 `if (low) return` ——
 *   与 `TargetRing` / `StatusMarkers` 是同一把锁的第三面。
 *
 * ★ `?art=off` 路径必须能构造：**纯程序化，零贴图** —— 几何体全是
 *   `RingGeometry` / `CapsuleGeometry`，材质一律 `MeshBasicMaterial`
 *   且不带 `map`。与 `StatusMarkers` 的硬约束逐字相同。
 *
 * ★★ 资源**按阵营各一份**，逐实体只 new 一个 `Mesh` 引用它们（P8 合批教训：
 *   逐实体 clone 几何体/材质在 24 人局里就是 24 份 GPU 上传 + 24 次
 *   dispose 的账）。所以 `dispose()` 释放的是那几份共享资源，
 *   移除一个实体只是把 Mesh 从组里摘掉，什么都不用释放。
 */

import * as THREE from 'three';
import { GEOMETRY } from '@wowpvp/shared';
import { ESSENTIAL_ROLES, isEssential } from '../render/quality.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { essentialMarkerScale } from './status.js';

/** 站在你这边还是对面。中立/第三方目前不存在，出现了再加 */
export type FactionKind = 'friendly' | 'hostile';

/**
 * 一个实体的阵营标记输入。
 * ★ 与 `CastView` / `ProjectileView` 同一个套路：收窄到画标记真的要读的字段，
 *   于是试验场与联网快照都能喂同一个类。
 */
export interface FactionRingView {
  id: number;
  /** **脚底**世界坐标（不是身体中心）*/
  position: { x: number; y: number; z: number };
  faction: FactionKind;
  /**
   * 角色身高，米。rim 轮廓按它等比缩放；省略用标准碰撞盒高度。
   * ★ 等比而不是只拉 Y —— 非等比会把胶囊两头的半球压扁成椭球，
   *   轮廓在头顶脚底出现两道明显的接缝。
   */
  height?: number;
  /**
   * 这一帧该不该画。★ 潜行/死亡/第一人称下的自己由**调用方**判断 ——
   * 本文件读不到那些状态，硬猜只会猜错（潜行可见性还牵扯 7.x 的侦测规则）。
   */
  hidden?: boolean;
}

/** 语义色。直接收 `paletteFor(colorblind)` 的两个字段，色盲模式自动跟随 */
export interface FactionRingPalette {
  friendly: string;
  hostile: string;
}

/** 友方：连续实环。★ 内外半径都明显小于 TargetRing，两者不抢地盘 */
const FRIENDLY_INNER = 0.3;
const FRIENDLY_OUTER = 0.4;
/** 敌对：八段虚线环，外沿再大一点 —— 灰度下靠「更大 + 有缺口」认 */
const HOSTILE_INNER = 0.3;
const HOSTILE_OUTER = 0.44;
const HOSTILE_SEGMENTS = 8;
/** 每段占的角度比例（0.62 = 段实、段虚各占六成/四成，缺口一眼可见）*/
const HOSTILE_DUTY = 0.62;

/** 抬离地面：比 TargetRing 的 0.04 低 —— 两者重叠时选中环压在上面 */
const RING_Y = 0.022;

/**
 * 不透明度。★ 刻意压得比 `TargetRing`（0.82–1.0）低一档：
 *   「他是哪一边」是**背景信息**，一直在场，太亮会把 12v12 的地面糊满，
 *   也会把「我选中的是谁」这条前景信息淹掉。
 * ★ 敌对略高于友方 —— 需要先看清的永远是敌人。
 */
const FRIENDLY_OPACITY = 0.34;
const HOSTILE_OPACITY = 0.42;

/**
 * 轮廓（§777 第三条通道）的实现：**放大一圈的背面胶囊壳**。
 *
 * ★★ 为什么不上后处理 outline：X10 实测这类机器 CPU/GPU 都紧，
 *   `OutlinePass` 要额外一遍全屏描边 + 一张深度/法线目标，
 *   为了一条可读性通道去背一个后处理链不划算。
 *
 * ★★ 便宜路的原理（与 `StatusMarkers` 的护盾外壳同一招）：壳比角色**大一圈**、
 *   `side: BackSide` 只画远侧壁、`depthTest` **开着**。于是角色身体把壳的中间
 *   挡掉，只剩「探出角色剪影之外」的那一圈还在 —— 那一圈就是轮廓。
 *   加法混合让它在深色背景上发一点微光，不遮挡任何信息。
 *
 * ⚠️ 诚实的局限：胶囊是**近似**剪影，不是真剪影。武器、法杖、张开的手臂
 *   探出壳外时那一段没有描边；蹲下/趴地的姿势会有富余。真剪影只有
 *   后处理或模板缓冲做得到，而那正是上面拒绝的开销。
 *   docs/15 的 X14 行如实记着这一点，真机看过再决定要不要升级。
 */
const RIM_RADIUS_SCALE = 1.16;
const RIM_HEIGHT_SCALE = 1.02;
/** 微光强度。0.13 是「凑近看得出、混战里不刺眼」，占位值，真机可调 */
const RIM_OPACITY = 0.13;

/** 一个阵营的共享资源 */
interface FactionAssets {
  ring: THREE.BufferGeometry;
  ringMat: THREE.MeshBasicMaterial;
  rimMat: THREE.MeshBasicMaterial;
}

/** 挂在场上的一个实体标记 */
interface RingEntry {
  group: THREE.Group;
  ring: THREE.Mesh;
  rim: THREE.Mesh;
  faction: FactionKind;
}

/** 友方那一圈：一个干净的连续环 */
const makeFriendlyGeometry = (): THREE.BufferGeometry =>
  new THREE.RingGeometry(FRIENDLY_INNER, FRIENDLY_OUTER, 40);

/**
 * 敌对那一圈：八段带缺口的弧，合并成**一个**几何体。
 * ★ 合并而不是八个 Mesh —— 一个实体一次 draw call 是本文件的成本上限。
 */
const makeHostileGeometry = (): THREE.BufferGeometry => {
  const step = (Math.PI * 2) / HOSTILE_SEGMENTS;
  const arcs: THREE.BufferGeometry[] = [];
  for (let i = 0; i < HOSTILE_SEGMENTS; i++) {
    arcs.push(
      new THREE.RingGeometry(
        HOSTILE_INNER, HOSTILE_OUTER, 6, 1, i * step, step * HOSTILE_DUTY,
      ),
    );
  }
  const merged = mergeGeometries(arcs);
  for (const a of arcs) a.dispose();
  return merged;
};

/**
 * rim 壳的几何体：**一份**，按标准碰撞盒建，逐实体等比缩放。
 * `CapsuleGeometry(radius, length, …)` 的总高 = length + 2×radius。
 */
const makeRimGeometry = (): THREE.CapsuleGeometry => {
  const r = GEOMETRY.HITBOX_RADIUS * RIM_RADIUS_SCALE;
  const total = GEOMETRY.HITBOX_HEIGHT * RIM_HEIGHT_SCALE;
  return new THREE.CapsuleGeometry(r, Math.max(0.05, total - r * 2), 3, 10);
};

/** MeshBasic：不受光照 —— 关键信息不能因为站在阴影里就看不清（FlagMarkers 同款理由）*/
const makeRingMaterial = (opacity: number): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

/** rim 壳：只画背面 + 加法混合 + **保留深度测试**（角色挡掉中间那块，见 RIM_* 注释）*/
const makeRimMaterial = (): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: RIM_OPACITY,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

/**
 * 全场的阵营脚下标记。挂一个 group 进场景，每帧喂一次全量视图。
 *
 * ★ 类名是复数：它管的是**全场**，共享资源的账也记在它头上
 *   （`FlagMarkers` 同一个形状）。文件名沿用 `TargetRing.ts` 那种
 *   「这是什么标记」的单数叫法。
 */
export class FactionRings {
  readonly group = new THREE.Group();

  /**
   * 轮廓开关。★ 单独一个字段而不是搭画质的车 —— 轮廓是 §777 的
   * 第四条通道，要关也该是**显式**地关（真机看下来嫌乱再说），
   * 不该由「降低特效」顺手带走一条可读性通道。
   */
  rim = true;

  /** 镜头距离，由场景每帧提供 —— 远处标记**放大**而不是缩小（14.3 末条）*/
  cameraDistance = 8;

  private readonly assets: Record<FactionKind, FactionAssets>;
  private readonly rimGeo: THREE.CapsuleGeometry;
  private readonly entries = new Map<number, RingEntry>();

  constructor() {
    // 自检：脚下标记吃的是「角色」这条关键角色，否则本文件「不读画质」的前提不成立
    if (!isEssential(ESSENTIAL_ROLES.character)) {
      throw new Error('character 必须属于 ESSENTIAL_ROLES（14.4）');
    }
    this.group.name = 'faction-rings';
    this.rimGeo = makeRimGeometry();
    this.assets = {
      friendly: {
        ring: makeFriendlyGeometry(),
        ringMat: makeRingMaterial(FRIENDLY_OPACITY),
        rimMat: makeRimMaterial(),
      },
      hostile: {
        ring: makeHostileGeometry(),
        ringMat: makeRingMaterial(HOSTILE_OPACITY),
        rimMat: makeRimMaterial(),
      },
    };
  }

  /** 场上标记数。verify / 自检用它断言「环真的画了」而不是只有数据 */
  get count(): number {
    return this.entries.size;
  }

  /** 共享材质数 —— 断言「每阵营一份」而不是逐实体 clone（P8 合批教训）*/
  get materialCount(): number {
    return Object.keys(this.assets).length * 2;
  }

  /**
   * 每帧喂一次**全量**视图。没出现在 views 里的实体自动摘掉。
   *
   * @param views   本帧所有该有标记的实体（`hidden` 的仍要传，只是不画）
   * @param palette `paletteFor(accessibility.colorblind)` 的语义色
   */
  update(views: readonly FactionRingView[], palette: FactionRingPalette): void {
    this.assets.friendly.ringMat.color.set(palette.friendly);
    this.assets.friendly.rimMat.color.set(palette.friendly);
    this.assets.hostile.ringMat.color.set(palette.hostile);
    this.assets.hostile.rimMat.color.set(palette.hostile);

    const scale = essentialMarkerScale(this.cameraDistance);
    const present = new Set<number>();

    for (const v of views) {
      present.add(v.id);
      const entry = this.ensure(v.id, v.faction);
      if (entry.faction !== v.faction) this.reface(entry, v.faction);

      entry.group.visible = v.hidden !== true;
      if (!entry.group.visible) continue;

      entry.group.position.set(v.position.x, v.position.y, v.position.z);
      // ★ 只有脚下环吃远距放大；rim 是贴着身体的，放大它就成了套一层壳
      entry.ring.scale.setScalar(scale);

      entry.rim.visible = this.rim;
      if (this.rim) {
        const h = v.height ?? GEOMETRY.HITBOX_HEIGHT;
        const k = h / GEOMETRY.HITBOX_HEIGHT;
        entry.rim.scale.setScalar(k);
        entry.rim.position.y = h * 0.5;
      }
    }

    for (const [id, entry] of this.entries) {
      if (present.has(id)) continue;
      this.group.remove(entry.group);
      this.entries.delete(id);
    }
  }

  private ensure(id: number, faction: FactionKind): RingEntry {
    const found = this.entries.get(id);
    if (found) return found;

    const a = this.assets[faction];
    const group = new THREE.Group();

    // ★ 共享几何体 + 共享材质，逐实体只有 Mesh 这层壳
    const ring = new THREE.Mesh(a.ring, a.ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = RING_Y;
    ring.renderOrder = 1; // TargetRing 是 2 —— 选中环压在阵营环上面
    group.add(ring);

    const rim = new THREE.Mesh(this.rimGeo, a.rimMat);
    rim.position.y = GEOMETRY.HITBOX_HEIGHT * 0.5;
    group.add(rim);

    const entry: RingEntry = { group, ring, rim, faction };
    this.group.add(group);
    this.entries.set(id, entry);
    return entry;
  }

  /** 换边（换队/观战视角切换）：只换材质与几何体的**引用**，不重建对象 */
  private reface(entry: RingEntry, faction: FactionKind): void {
    const a = this.assets[faction];
    entry.ring.geometry = a.ring;
    entry.ring.material = a.ringMat;
    entry.rim.material = a.rimMat;
    entry.faction = faction;
  }

  /**
   * 释放共享资源。★ 逐实体的 Mesh **什么都不用释放** ——
   * 它们持有的是这里这几份共享几何体/材质的引用，
   * 逐实体 dispose 会把还在用的资源打掉（`SpellVfx.disposeNode` 的 ★★ 同款坑）。
   */
  dispose(): void {
    this.group.clear();
    this.entries.clear();
    this.rimGeo.dispose();
    for (const a of Object.values(this.assets)) {
      a.ring.dispose();
      a.ringMat.dispose();
      a.rimMat.dispose();
    }
  }
}
