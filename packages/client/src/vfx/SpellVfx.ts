/**
 * M12（14.2）：八属性技能特效的编排器。
 *
 * ★★ **它把三样此前各自孤立的东西接成一条链：**
 *     数据（`schools.ts` 八属性表 + `phases.ts` 阶段）
 *   × 素材（`assets/art/vfx/` 的 16 张粒子贴图）
 *   × 时机（`CombatDirector` 的只读表现钩子 + sim 的投射物/地面存储）
 *   在此之前这三样都在，却从没连起来 —— 玩家看不到任何属性颜色、飞行体或命中爆发。
 *
 * ★★ **「飞行」阶段为什么由本文件负责，而不是 sim：**
 *
 *   全部 91 个技能里**只有猎人的一发穿透弩箭**带 `spawnProjectile` 效果。
 *   霜矢、火焰冲击这些一眼就该「飞过去」的法术在 sim 里是**瞬时结算**的 ——
 *   这不是遗漏，是 6.6 的规则：`mage.frostbolt` 的数据里写着
 *
 *       // 6.6 锁定投射物：释放瞬间确认命中资格，飞行只是表现
 *
 *   「飞行只是表现」这句话此前**没有任何代码兑现它**：玩家按下霜矢，
 *   目标直接掉血，中间什么都没有。本文件的 `VisualBolt` 就是那句话的落点 ——
 *   纯表现、零规则：命中资格早已在释放瞬间定死，弹体只是把它演出来。
 *   ★ 所以它**不影响任何一条战斗规则**，走位躲不掉它（6.6 明确要求如此）。
 *
 * ★ **纯只读旁路**：本类不订阅、不修改任何战斗状态，与 M12 音效同性质。
 *   删掉它游戏规则一行不变 —— 它只负责「好看」。
 *
 * ★ **安全边界（与 M12 每一层一致）：**
 *   · 整体受 `?art=off` 门禁（在 `TestbedScene` 里，art 关就压根不构造本类）
 *   · 投射物主体、地面边界 = `ESSENTIAL_ROLES`，任何画质都画（验收 #48）
 *   · 拖尾、地面装饰粒子 = `DECORATIVE_ROLES`，低画质按 `isVisible` 裁剪、
 *     按 `decorativeDensity` 减量（14.4）
 *   · 贴图缺失逐层退回程序化软圆点 / 纯色球（属性颜色不丢）
 *   · 近镜头（第一人称）压低释放爆发透明度，不糊满屏（14.3）
 */

import * as THREE from 'three';
import {
  School,
  Targeting,
  asSkillId,
  getSkill,
  type EntityId,
  type SkillDef,
} from '@wowpvp/shared';

import { BurstPool, FlashPool, type Vec3Like } from './ParticleBurst.js';
import {
  ACCENT_TEXTURES,
  PARTICLE_TEXTURE,
  VFX_TEXTURE_FILES,
  accentTexture,
  particleTextureFor,
  type AccentTexture,
} from './particleTextures.js';
import {
  ATTRIBUTE_VISUALS,
  visualForSchool,
  visualOf,
  type AttributeVisual,
} from './schools.js';
import { QualityTier, decorativeDensity, isVisible } from '../render/quality.js';
import { MOTION, boltOrientation, trailPlanFor } from './boltVfx.js';
import { fizzlePlanFor, windupPlanFor } from './castVfx.js';
import { MAX_FILL_AREAS, groundFillPlanFor, wavePlanFor, waveEase } from './groundVfx.js';
import type { ImpactTier } from '../feedback/impactTier.js';

/** 水平+垂直平方距离。★ 只用于排序，不开根号 */
const sqDist = (a: Vec3Like, b: Vec3Like): number =>
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;

// ★ MOTION 表已挪进 `boltVfx.ts` 成为唯一来源 —— 此前它只活在本文件里，
//   而地面填充写死了一个向上的 gravity 把 frost 的「雪花飘落」掰成了上升。

/**
 * 命中时叠加的**第二通道**点缀（14.2「形状与运动」列里的余烬/星屑）。
 * 物理不在这张表里 —— 它的点缀是刀光 + 火星，走 `FlashPool`（要随机旋转）。
 * 没列的属性（冰/暗/自然/毒）主粒子本身已经足够独特，再叠会糊成一团。
 */
const HIT_ACCENT: Partial<Record<AttributeVisual['particle'], AccentTexture>> = {
  ember: 'ember',    // 火：余烬
  rune: 'sparkle',   // 奥术：星屑
  beam: 'sparkle',   // 神圣：星屑
};

/** 免疫/闪避这类「无属性」反馈用的中性白 */
const NEUTRAL: AttributeVisual = {
  primary: 0xffffff,
  secondary: 0xcfd8e6,
  motion: '',
  particle: 'beam',
  glyph: '',
};

/**
 * 表现用弹体的飞行速度（米/秒）。
 * ★ 取得快（55）是有意的：命中**早已结算**（6.6），弹体越慢，
 *   「数字已经跳出来但弹体还在半路」的割裂就越明显。
 *   55 m/s 下 30 米最远射程也只飞 0.55 秒，读作「嗖」的一下。
 */
const BOLT_SPEED = 55;

/** 近战技能不该有弹体。6.1 的近战档最长 3.8 米，取 8 米作为「这是远程」的判据 */
const BOLT_MIN_RANGE = 8;

export interface SpellVfxStatus {
  texturesLoaded: number;
  texturesTotal: number;
  attributesCovered: number;
  /**
   * 当前存活的爆发数。★ **两池之和** —— 分池是内部结构调整，
   * 既有诊断脚本（diag-vfx / diag-net）读的是这个语义，不能变。
   */
  activeBursts: number;
  /** 其中细流池占用（拖尾/地面填充/蓄力）。低画质下应恒为 0 */
  streamBursts: number;
  projectileBodies: number;
  /** 当前在飞的表现用弹体数 */
  visualBolts: number;
  /** 当前在场的持续边界环数（地面区域 + 延迟落点，14.3）*/
  groundRings: number;
  /** 当前正在画蓄力法阵的施法者数（14.1 预备）*/
  activeWindups: number;
  /** 其中真的在冒聚能粒子的（受 MAX_WINDUP_EMITTERS 与画质约束）*/
  windupEmitters: number;
  /** 当前在冒拖尾粒子的弹体数（受 MAX_TRAIL_EMITTERS 与画质约束）*/
  trailEmitters: number;
  /** 当前在扩张的瞬发 AOE 地面波 */
  groundWaves: number;
  /** 当前在场的地面染色盘（波残留 + 区域底色，装饰层）*/
  groundDecals: number;
  /** 当前存活的一次性闪光数（刀光/免疫白闪）*/
  activeFlashes: number;
}

/**
 * 投射物的**表现视图** —— 只含画一发飞行体所需的字段。
 *
 * ★★ 为什么不直接收 sim 的 `ProjectileStore`：联网场景没有 sim，
 *   它拿到的是快照里的 `ProjectileSnapshot`。两边都收窄到这个视图，
 *   本类就同时服务试验场（本地存储适配）与联网场景（快照适配），
 *   而且**读不到** onHit/sourceId 这些它本不该关心的字段。
 */
export interface ProjectileView {
  id: number;
  kind: 'homing' | 'colliding' | 'delayedImpact';
  skillId: string;
  /** homing/colliding 是当前位置；delayedImpact 是落点圆心 */
  position: Vec3Like;
  /** 仅 delayedImpact：落点半径 */
  radius?: number;
  /** 仅 delayedImpact：落地时刻（与 frame 的 `now` 同一时钟）。14.3 倒计时靠它 */
  impactAt?: number;
}

/** 地面区域的表现视图（14.3 边界 + 内部装饰粒子所需的最小字段）*/
export interface GroundAreaView {
  id: number;
  skillId: string;
  center: Vec3Like;
  radius: number;
}

/**
 * 正在施法的单位 —— 14.1「预备」阶段的驱动源。
 *
 * ★★ 与 `ProjectileView` / `GroundAreaView` 同一个套路：收窄到画蓄力所需的最小字段，
 *   于是本地 sim（`CombatDirector.castOf`）与联网快照（`SnapshotCombatView` 的
 *   施法注册表）都能喂同一个类，而它**读不到** targetId/groundPoint 这些
 *   本不该关心的东西。
 */
export interface CastView {
  id: number;
  skillId: string;
  position: Vec3Like;
  /** 角色身高，用于把法阵放脚下、聚能放手上 */
  height: number;
  yaw: number;
  startedAt: number;
  endsAt: number;
  /** 引导结束时刻。仅引导技能有 —— 没有它，暴风雪的法阵会在第 0.8 秒就消失 */
  channelEndsAt?: number;
}

/**
 * 表现层消费的战斗事件 —— `CombatEvent` 的子集，字段收窄到真的会读的。
 * ★ 联网场景没有本地 sim：它拿到的是协议消息，凑不出完整的 `CombatEvent`
 *   （redact 之后连 sourceId 都没有）。收窄之后本地事件与网络消息都能喂。
 */
export type SpellVfxEvent =
  | { t: 'damage'; targetId: EntityId; amount: number; school: School; immune: boolean
      avoided?: 'dodge' | 'parry' | 'block'
      /** 打击分档（由 HitFeedback 用 impactTierOf 算好传入 —— 本类不该知道 maxHealth）*/
      tier?: ImpactTier }
  | { t: 'heal'; targetId: EntityId; amount: number }
  | { t: 'auraApplied'; targetId: EntityId; auraId: string }
  | { t: 'shieldBroken'; targetId: EntityId }
  | { t: 'death'; targetId: EntityId };

// ── 打击分档 → 爆发参数（纯函数，vfx.test.ts 不用 WebGL 就能测）────

/**
 * 各档的额外放大。★ 单靠连续曲线不行：300 与 600 伤害在旧曲线
 * `min(1.6, 0.7+a/400)` 下差别只有 0.85 vs 1.6，而玩家需要的「这一下
 * 不一样」是一个**台阶**，不是一段斜坡。
 */
export const TIER_BOOST: Record<ImpactTier, number> = {
  light: 0.8,
  normal: 1.0,
  heavy: 1.25,
  crit: 1.45,
  critHeavy: 1.6,
  kill: 1.6,
};

export interface BurstPlan {
  scale: number;
  count: number;
  speed: number;
  size: number;
  life: number;
  /** heavy 及以上：一圈扩张的冲击波环 */
  shockwave: boolean;
  /** heavy 及以上且画质允许（impactDebris 装饰角色，14.4）：碎屑层 */
  debris: boolean;
  /** 暴击档：白色核心闪光 —— 白不是任何学派色，八学派下读作同一件事 */
  whiteCore: boolean;
}

/** 命中爆发的参数计划。★ 总缩放钳在 2.1 → count 上限 38 < MAX_PARTICLES 48 */
export const burstPlanFor = (
  tier: ImpactTier,
  amount: number,
  quality: QualityTier,
): BurstPlan => {
  const scale = Math.min(2.1, (0.75 + amount / 320) * TIER_BOOST[tier]);
  const heavyPlus = tier === 'heavy' || tier === 'crit' || tier === 'critHeavy' || tier === 'kill';
  return {
    scale,
    count: Math.min(48, Math.round(18 * scale)),
    speed: 4.6 * scale,
    size: 0.72 * scale,
    // ★ 旧实现 life 是常量 0.55 —— 重击应该「留」得久一点
    life: 0.5 + 0.14 * scale,
    shockwave: heavyPlus,
    debris: heavyPlus && isVisible('impactDebris', quality),
    whiteCore: tier === 'crit' || tier === 'critHeavy',
  };
};

/** 每帧驱动所需的全部外部状态。一次传齐，见 `frame()` */
export interface SpellVfxFrame {
  quality: QualityTier;
  cameraDistance: number;
  /**
   * 点精灵的透视缩放系数 = 视口像素高 / (2·tan(fov/2))。
   * 由场景算好传进来 —— 本类不该知道 canvas 或相机参数。
   */
  pointScale: number;
  /** 当前时钟（试验场 = world.time，联网 = serverTime）。倒计时用它减 impactAt */
  now: number;
  projectiles: readonly ProjectileView[];
  grounds: readonly GroundAreaView[];
  /** 正在施法的单位（14.1 预备阶段）。不传 = 本场景不提供施法信息，如实不画 */
  casts?: readonly CastView[];
  /**
   * 相机世界位置。★ 装饰层按距离取最近 N 个发射器 ——
   * 12v12 混战里同时有十几个人在读条，每个都冒粒子会瞬间打满细流池。
   * 被裁掉的只有粒子，法阵（关键信息「这个人在施法」）一个都不少。
   */
  cameraPosition?: Vec3Like;
}

interface ProjBody {
  group: THREE.Group;
  visual: AttributeVisual;
  /** ★ 复用同一个对象，不每帧新建（12v12 下这是每秒上千次分配）*/
  lastPos: { x: number; y: number; z: number };
  /** 刚创建、还没有位置：第一帧直接落位，不做平滑 */
  fresh: boolean;
}

/**
 * 一圈持续边界环，延迟落点的环还带**倒计时数字**（14.3：
 * 「延迟技能显示落点和倒计时」—— 看不到剩余秒数就不知道该什么时候躲开）。
 * 环与数字都是 `ESSENTIAL_ROLES.groundBoundary`，任何画质都画。
 */
interface RingEntry {
  mesh: THREE.Mesh;
  /**
   * 区域内部的填充节拍计时器。★ 每片区域各一份 —— 全局共用一个的话
   * 多片区域会同一帧齐发，一阵一阵地闪（本轮修的）。
   */
  fillTimer?: number;
  /** 地面染色盘（装饰层，低画质隐藏而不是销毁 —— 画质可以来回切）*/
  tint?: {
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    visible?: boolean;
  };
  label?: {
    sprite: THREE.Sprite;
    mat: THREE.SpriteMaterial;
    tex: THREE.CanvasTexture;
    canvas: HTMLCanvasElement;
    /** 当前画着的秒数，变了才重绘（canvas 重绘 + 纹理上传不是免费的）*/
    shown: number;
  };
}

/**
 * 表现用弹体：从施法者**追着目标**飞，追上即爆。零规则影响。
 *
 * ★★ **命中结果**在释放瞬间已锁定（6.6），但**终点不是**：
 *   sim 的 HomingProjectile 每 tick 朝目标当前位置推进，表现弹体也一样 ——
 *   否则目标一走位，弹体就打在他两秒前站的空地上，爆一朵空气花（用户实测）。
 *   `track` 每帧给出目标当前的躯干位置；目标从视野消失（潜行/离场）时
 *   返回 undefined，弹体飞向最后已知位置 —— 不追一个看不见的人。
 */
interface VisualBolt {
  group: THREE.Group;
  visual: AttributeVisual;
  /** 当前追踪的终点（有 track 时每帧刷新）*/
  to: Vec3Like;
  track?: (() => Vec3Like | undefined) | undefined;
  /** 已飞行秒数。超过上限强制抵达 —— 别让弹体追一个反复闪现的人追到天荒地老 */
  age: number;
  /** 拖尾节拍计时器。★ 此前拖尾是**每帧**发的，把池刷空了（见 boltVfx.ts 文件头）*/
  trailTimer: number;
}

/**
 * 一个人的蓄力表现（14.1「预备」）：脚下法阵 + 手上聚能粒子。
 * ★ 法阵是 `ESSENTIAL_ROLES.character`（`phases.ts` 早就这么归的）——
 *   「这个人在施法」是关键信息，任何画质都画；粒子才是装饰。
 */
interface WindupEntry {
  group: THREE.Group;
  /** 外圈：干净的圆环轮廓，一眼读出「这是个法阵」而不是「地上有片光」 */
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  /** 内层符文（`magic_04`）。★ 与外圈**反向**转 —— 两层反转是「机关在动」的最短路径 */
  runes?: THREE.Mesh;
  runeMat?: THREE.MeshBasicMaterial;
  visual: AttributeVisual;
  /** 聚能粒子的节拍计时器 */
  timer: number;
  /** 累计旋转角 */
  spin: number;
  /** 打断时要用：攒到哪儿了、在哪儿散 */
  lastProgress: number;
  lastPos: Vec3Like;
}

/**
 * 同时冒聚能粒子的施法者上限（按到相机的距离取最近的几个）。
 * ★ 12v12 混战里十几个人一起读条，每人一路细流会瞬间打满池子；
 *   远处那些只留法阵，玩家读到的信息一样不少。
 */
const MAX_WINDUP_EMITTERS = 4;

/**
 * 同时冒拖尾粒子的表现用弹体上限（同上，按到相机的距离取最近的几发）。
 * ★ 3 而不是 4：一发弹体只活半秒，而一片暴风雪要撑 4 秒 —— 槽位该给后者。
 *   彗尾条零池占用，所以被裁掉的弹体仍然拖着那条连贯的尾巴。
 */
const MAX_TRAIL_EMITTERS = 3;

/**
 * 一次瞬发范围技能在地上留下的**扩张冲击波**。
 *
 * ★★ 与 `FlashPool` 那个叫「冲击波」的东西不是一回事：那是面向镜头的
 *   广告牌光斑，从上往下看就是一团光。这个是**贴地的环**，
 *   扩张终点恰好等于 `shape.radius` —— 它画的就是这次 AOE 的真实覆盖范围。
 *
 * ★ 公平性：波在**结算之后**才出现，不提供任何预判信息，双方对称可见
 *   （docs/10 已知偏差登记的依据）。
 */
interface GroundWave {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  age: number;
  life: number;
  radius: number;
}

/** 波之后留下的地面染色（装饰层）*/
interface GroundDecal {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  age: number;
  life: number;
  opacity: number;
}

const MAX_WAVES = 12;
const MAX_DECALS = 8;

export class SpellVfx {
  readonly group = new THREE.Group();
  /**
   * **事件型**爆发：命中、释放 pop、死亡、破盾、规避。
   * ★ 短促、要立刻被看见 —— 48 粒 × 32 格，一发 8 目标 AOE 占 16 格。
   */
  private readonly pool = new BurstPool(32);
  /**
   * **持续型**细流：弹体拖尾、地面区域填充、施法蓄力。
   * ★★ 与事件池分开是**结构性修复**不是优化：细流每隔几十毫秒就要占一格，
   *   合在一起时它们会把命中爆发挤出池子（回收策略是「最旧的」，
   *   而最旧的往往正是刚才那记重击）。分池之后两边互不影响。
   *
   * ★ 48 格是三类细流的**预算和**，每一项都由 `vfxPlans.test.ts` 钉着上限：
   *     蓄力 3 格 × 4 个 + 拖尾 6 格 × 3 发 + 地面 6 格 × 3 片 = 48。
   *   改任何一处的 life/cadence 都会先在单测里撞线，而不是在 12v12 里掉帧。
   */
  private readonly streams = new BurstPool(48, 32);
  /**
   * 刀光、免疫白闪与冲击波环（要随机旋转/展开，Points 做不了）。
   * 16 而不是 12：冲击波是新消费者，重击一发要占两个槽（刀光 + 环）——
   * verify:m12 读 activeFlashes 观察是否长期打满。
   */
  private readonly flashes = new FlashPool(16);

  /** 已解码的贴图（异步填充；未就绪时取到 null 走程序化兜底）*/
  private readonly particleTex = new Map<AttributeVisual['particle'], THREE.Texture | null>();
  private readonly accentTex = new Map<AccentTexture, THREE.Texture | null>();
  private texturesLoaded = 0;

  /** sim 真实投射物的主体。key = projectile.id */
  private readonly projBodies = new Map<number, ProjBody>();
  /** 表现用弹体（sim 里不存在，见文件头）*/
  private readonly bolts: VisualBolt[] = [];
  /** 延迟落点 / 地面区域的持续边界环。key = 'p'+id / 'g'+id */
  private readonly rings = new Map<string, RingEntry>();
  /** 正在施法的单位的蓄力表现。key = 实体 id */
  private readonly windups = new Map<number, WindupEntry>();
  /** 瞬发范围技能的地面冲击波（瞬时，自然消亡）*/
  private readonly waves: GroundWave[] = [];
  /** 波之后的地面染色（装饰层）*/
  private readonly decals: GroundDecal[] = [];
  /** 最近一帧真的在冒聚能粒子的施法者数（自检用）*/
  private windupEmitterCount = 0;
  /** 最近一帧真的在冒拖尾粒子的弹体数（自检用）*/
  private trailEmitterCount = 0;

  /** 上一帧场上还在的投射物 id，用于检出「消失 → 补一发命中爆发」*/
  private seenProjectiles = new Set<number>();

  private trailTimer = 0;
  private fillTimer = 0;
  private cameraDistance = 8;
  /** 最近一帧的画质档（onCombatEvent 的碎屑门禁读它，事件到达时不在 frame 里）*/
  private quality: QualityTier = 'high';
  private disposed = false;

  constructor() {
    this.group.name = 'spell-vfx';
    this.group.add(this.pool.group);
    this.group.add(this.streams.group);
    this.group.add(this.flashes.group);
    void this.preload();
  }

  /** 预加载全部贴图并记录成功张数（供 `verify:m12` 自检）*/
  private async preload(): Promise<void> {
    const particleKeys = Object.keys(PARTICLE_TEXTURE) as AttributeVisual['particle'][];
    const accentKeys = Object.keys(ACCENT_TEXTURES) as AccentTexture[];
    await Promise.all([
      ...particleKeys.map(async (k) => {
        this.particleTex.set(k, await particleTextureFor(k));
      }),
      ...accentKeys.map(async (k) => {
        this.accentTex.set(k, await accentTexture(k));
      }),
    ]);
    if (this.disposed) return;
    // 两张表互斥且合起来正好 16 张（由 particleTextures.test.ts 钉死），
    // 所以数这两个 Map 就是数全部贴图 —— 不必再跑一遍加载
    this.texturesLoaded =
      [...this.particleTex.values()].filter((t) => t !== null).length +
      [...this.accentTex.values()].filter((t) => t !== null).length;
  }

  private texFor(particle: AttributeVisual['particle']): THREE.Texture | null {
    return this.particleTex.get(particle) ?? null;
  }

  // ── 表现钩子 ──────────────────────────────────────────────────

  /**
   * 施法生命周期。
   *   `started`  读条期间的手部蓄力
   *   `resolved` 出手 pop + **表现用弹体**射向每个目标
   * ★ 属性走 `visualOf(skill)`（毒感知：毒刃是 physical 学派但显示黄绿）。
   */
  onCast(
    kind: 'started' | 'resolved' | 'interrupted' | 'failed',
    /** ★ `id` 可选：带上才能把蓄力法阵在这一刻立刻摘掉（不等下一帧差分） */
    caster: { position: Vec3Like; height: number; yaw: number; id?: number },
    skill: SkillDef | undefined,
    /**
     * 本次施法的结算目标（`onCastResolved` 给的那一份，结算前快照）。
     * `track` 可选：每帧返回该目标**当前**的躯干位置，弹体据此追踪（见 VisualBolt）。
     */
    targets: readonly {
      position: Vec3Like;
      height: number;
      track?: () => Vec3Like | undefined;
    }[] = [],
  ): void {
    if (!skill) return;
    const av = visualOf(skill);
    /**
     * ★ 释放点**前移半米**（沿角色朝向），不贴在躯干正中 ——
     *   粒子开加法混合但仍做深度测试，埋在身体里会被自己的模型挡掉大半。
     *   镜头在背后时玩家几乎看不到自己的释放 pop，实测就是「感觉没放出东西」。
     */
    const hand: Vec3Like = {
      x: caster.position.x - Math.sin(caster.yaw) * 0.5,
      y: caster.position.y + caster.height * 0.62,
      z: caster.position.z - Math.cos(caster.yaw) * 0.5,
    };

    if (kind === 'started') {
      // 起手一记 pop；**持续**蓄力由 frame() 的 casts 驱动（见 syncCasts）
      this.emitBurst(hand, av, { count: 6, speed: 1.0, size: 0.42, life: 0.5, drag: 3.5 });
      return;
    }

    /**
     * 打断/失败：攒的东西**垮下去**。
     * ★ 立刻摘法阵而不是等下一帧的 present 差分 —— 差分要等场景下一次喂
     *   `casts`，而打断消息与 frame 之间隔着的那一帧里，法阵还亮着，
     *   读起来像「打断没生效」。7.5 的博弈里这半帧就是全部意义。
     */
    if (kind === 'interrupted' || kind === 'failed') {
      const entry = caster.id !== undefined ? this.windups.get(caster.id) : undefined;
      const plan = fizzlePlanFor(entry?.lastProgress ?? 0.5);
      this.emitBurst(entry?.lastPos ?? hand, av, {
        count: plan.count, speed: plan.speed, size: plan.size,
        life: plan.life, gravity: plan.gravity, drag: 1.6,
      });
      if (caster.id !== undefined) this.removeWindup(caster.id);
      return;
    }
    if (kind !== 'resolved') return;
    // 释放接管：蓄力到此结束（引导技能的 resolved 在引导**结束**才到，见协议注释）
    if (caster.id !== undefined) this.removeWindup(caster.id);

    // Q 版基调：释放要「砰」地一下 —— 大、密、亮
    this.emitBurst(hand, av, { count: 16, speed: 3.0, size: 0.72, life: 0.55 });
    this.emitAccent(hand, 'glow', av.secondary, 1.4);

    /**
     * ★★ 自身中心的圆形范围技能 → 贴地扩张冲击波。
     *
     *   霜爆新星（`SelfCenter` + `circle radius 5`，纯定身无伤害）此前走的是
     *   下面那条「无弹体且无伤害」分支，地上一点痕迹都没有 ——
     *   玩家实测反馈「就闪了一下」。带伤害的自身中心 AOE 同样受益。
     *
     *   ★ 判定放在**所有分支之前**：它与「有没有伤害」「有没有弹体」正交，
     *     漏进哪条分支都会少画一批技能。
     */
    if (skill.targeting === Targeting.SelfCenter && skill.shape.kind === 'circle') {
      this.spawnWave(caster.position, skill.shape.radius, av);
    }

    if (this.flies(skill)) {
      for (const t of targets) {
        const to: Vec3Like = {
          x: t.position.x,
          y: t.position.y + t.height * 0.5,
          z: t.position.z,
        };
        const d = Math.hypot(to.x - hand.x, to.y - hand.y, to.z - hand.z);
        if (d < 1.5) continue; // 自身/贴脸：没有可看的飞行段
        this.spawnBolt(hand, to, av, t.track);
      }
      return;
    }

    /**
     * ★ 无弹体且无伤害的技能（霜爆新星的定身、群体控制…）：
     *   在每个目标身上直接放到位爆发。它们不产生 damage 事件，
     *   CC 光环的 id 又是 `control.*`（查不回技能拿颜色），
     *   不在这里补的话「被定住的人」身上什么都不会亮。
     */
    if (skill.effects.some((e) => e.kind === 'damage')) return;
    for (const t of targets) {
      const at: Vec3Like = {
        x: t.position.x,
        y: t.position.y + t.height * 0.5,
        z: t.position.z,
      };
      if (Math.hypot(at.x - hand.x, at.z - hand.z) < 0.6) continue; // 自己那份 pop 已经有了
      this.emitBurst(at, av, { count: 12, speed: 2.2, size: 0.6, life: 0.55 });
    }
  }

  /**
   * 这个技能该不该有一发**表现用**弹体。
   *
   * 判据全部来自已有数据，不新增配置：
   *   · 单体形状 + 直接/投射物瞄准 —— 排除地面技能与自身中心 AOE
   *   · 射程 ≥ 8 米 —— 排除近战（6.1 近战档最长 3.8 米）
   *   · 没有 `spawnProjectile` —— 那种由 sim 真的产生弹体，走 `syncProjectiles`，
   *     在这里再来一发就成了双份
   */
  private flies(skill: SkillDef): boolean {
    if (skill.shape.kind !== 'single') return false;
    if (skill.targeting !== Targeting.Direct && skill.targeting !== Targeting.Projectile) {
      return false;
    }
    if (skill.range.max < BOLT_MIN_RANGE) return false;
    return !skill.effects.some((e) => e.kind === 'spawnProjectile');
  }

  /**
   * 战斗事件 → 命中反馈。
   * ★ 伤害按**学派**取属性（事件不带 skillId，取舍说明见 `visualForSchool`）。
   */
  onCombatEvent(ev: SpellVfxEvent, posOf: (id: EntityId) => Vec3Like | undefined): void {
    switch (ev.t) {
      case 'damage': {
        const at = posOf(ev.targetId);
        if (!at) return;
        if (ev.immune) {
          // 14.1「免疫反馈」：白色爆发 + 一记白闪。免疫是关键信息（14.4），做大一点
          this.emitBurst(at, NEUTRAL, { count: 8, speed: 1.6, size: 0.42, life: 0.45 });
          this.flashes.emit({
            origin: at, texture: this.accentTex.get('flash') ?? null,
            color: 0xffffff, size: 1.7, life: 0.32,
          });
          return;
        }
        if (ev.avoided) {
          /**
           * 规避反馈三种形状（8.x 六种结果六种读法 —— 此前粒子层只有
           * 一种 4 粒弱散，闪避/招架/格挡在粒子上读不出区别）：
           *   dodge = 碟形侧散 + 低透明水平刀光 →「侧身让开」
           *   parry = 火星上迸 + 一记小 glow →「金属格开」
           *   block = 一枚盾面 glow →「盾接住了」
           * 全部中性钢色、life ≤ 0.32，不抢真实伤害的注意力。
           */
          if (ev.avoided === 'dodge') {
            this.emitBurst(at, NEUTRAL, {
              count: 8, speed: 2.4, size: 0.34, life: 0.3, drag: 5, spread: 'disc',
            });
            this.flashes.emit({
              origin: at, texture: this.accentTex.get('slash') ?? null,
              color: 0xcfd8e3, size: 1.6, life: 0.22, rotation: Math.PI / 2,
            });
          } else if (ev.avoided === 'parry') {
            this.emitAccent(at, 'spark', 0xffd890, 0.85);
            this.flashes.emit({
              origin: at, texture: this.accentTex.get('glow') ?? null,
              color: 0xffe2a8, size: 1.1, life: 0.2,
            });
          } else {
            this.flashes.emit({
              origin: at, texture: this.accentTex.get('glow') ?? null,
              color: 0xbfd4ff, size: 1.4, life: 0.28,
            });
            this.emitBurst(at, NEUTRAL, { count: 5, speed: 1.4, size: 0.3, life: 0.3 });
          }
          return;
        }
        if (ev.amount <= 0) return;
        const av = visualForSchool(ev.school);
        // 伤害越大爆发越猛，分档再上台阶（打击感改造）。Q 版基调：底数就大
        const plan = burstPlanFor(ev.tier ?? 'normal', ev.amount, this.quality);
        this.emitBurst(at, av, {
          count: plan.count,
          speed: plan.speed,
          size: plan.size,
          life: plan.life,
        });
        // 重击冲击波：现成的 glow 贴图 + FlashPool 的 grow 展开，零新资源
        if (plan.shockwave) {
          this.flashes.emit({
            origin: at, texture: this.accentTex.get('glow') ?? null,
            color: av.secondary, size: 1.2 * plan.scale, life: 0.26, grow: 3.8,
          });
        }
        // 碎屑层（impactDebris 装饰角色 —— M8 定义至今第一次被消费）
        if (plan.debris) {
          this.emitAccent(at, 'debris', av.secondary, 0.6 * plan.scale);
        }
        // 暴击白核：白不属于任何学派，八学派下都读作「暴击」
        if (plan.whiteCore) {
          this.flashes.emit({
            origin: at, texture: this.accentTex.get('flash') ?? null,
            color: 0xffffff, size: 2.4 * plan.scale, life: 0.18,
          });
        }
        // 第二通道点缀（14.2）：物理 = 刀光 + 迸溅火星；火/奥/圣见 HIT_ACCENT
        if (ev.school === School.Physical) {
          this.flashes.emit({
            origin: at, texture: this.accentTex.get('slash') ?? null,
            color: 0xfff3e0, size: 2.2 * plan.scale, life: 0.24,
            rotation: (Math.random() - 0.5) * 2.6,
          });
          this.emitAccent(at, 'spark', av.secondary, 0.7);
        } else {
          const acc = HIT_ACCENT[av.particle];
          if (acc) this.emitAccent(at, acc, av.secondary, 0.75);
        }
        break;
      }
      /**
       * ★ 纯光环技能（化形术、霜爆新星的定身…）此前**完全没有命中表现** ——
       *   它们不产生 damage 事件，唯一的痕迹是头顶标记。这里补上到位爆发。
       *   带伤害的技能跳过：它们的命中爆发已经由 damage 事件承担，不再叠一份。
       *   auraId 约定为 `<class>.<skill>.<名>`，取前两段查回技能拿属性色；
       *   对不上（如系统光环）就静默跳过。
       */
      case 'auraApplied': {
        const at = posOf(ev.targetId);
        if (!at) return;
        const skill = getSkill(asSkillId(ev.auraId.split('.').slice(0, 2).join('.')));
        if (!skill || skill.effects.some((e) => e.kind === 'damage')) return;
        const av = visualOf(skill);
        this.emitBurst(at, av, { count: 14, speed: 2.4, size: 0.65, life: 0.6 });
        this.emitAccent(at, 'sparkle', av.secondary, 0.9);
        break;
      }
      case 'heal': {
        const at = posOf(ev.targetId);
        if (at && ev.amount > 0) {
          // 治疗恒用自然的暖绿上浮星火，与伤害一眼可分
          this.emitBurst(at, ATTRIBUTE_VISUALS.nature, {
            count: 12, speed: 1.6, size: 0.55, life: 0.75, gravity: 2.2,
          });
        }
        break;
      }
      case 'shieldBroken': {
        const at = posOf(ev.targetId);
        if (at) this.emitBurst(at, ATTRIBUTE_VISUALS.holy, { count: 16, speed: 3.6, size: 0.6, life: 0.45 });
        break;
      }
      case 'death': {
        const at = posOf(ev.targetId);
        if (at) {
          // 死亡是一局里最重的表现时刻：大爆发 + 一圈冲击波（Q 版的「砰」）
          this.emitBurst(at, ATTRIBUTE_VISUALS.shadow, { count: 26, speed: 5.4, size: 0.9, life: 0.8 });
          this.flashes.emit({
            origin: at, texture: this.accentTex.get('glow') ?? null,
            color: 0x9a86c8, size: 2.0, life: 0.3, grow: 4.2,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  // ── 每帧 ──────────────────────────────────────────────────────

  /**
   * 一次调用推进全部特效。
   * ★ 单一入口是有意的：调用方只需在 draw() 里写一行，
   *   顺序（先更新镜头距离、再产生新粒子、最后推进）也就无从写反。
   */
  frame(dt: number, ctx: SpellVfxFrame): void {
    this.cameraDistance = ctx.cameraDistance;
    // 缓存画质给 onCombatEvent 的碎屑门禁用（事件不在 frame 里到达）
    this.quality = ctx.quality;
    this.pool.setScale(ctx.pointScale);
    this.streams.setScale(ctx.pointScale);
    this.syncCasts(ctx.casts ?? [], ctx.quality, dt, ctx.now, ctx.cameraPosition);
    this.syncProjectiles(ctx.projectiles, ctx.quality, dt, ctx.now);
    this.syncGround(ctx.grounds, ctx.quality, dt, ctx.cameraPosition);
    this.updateBolts(dt, ctx.quality, ctx.cameraPosition);
    this.updateWaves(dt);
    this.pool.update(dt);
    this.streams.update(dt);
    this.flashes.update(dt);
  }

  // ── 瞬发范围技能的地面冲击波 ──────────────────────────────────

  /**
   * 放一圈从 0 扩到 `radius` 的贴地环，外加一张淡出的染色盘。
   * ★ 环的终点半径 = 技能的 `shape.radius`，与判定同源 —— 与
   *   `ensureRing`（地面区域边界）遵守同一条「边界即判定」的规矩（14.3）。
   */
  private spawnWave(center: Vec3Like, radius: number, av: AttributeVisual): void {
    const plan = wavePlanFor(radius, this.quality);

    if (this.waves.length >= MAX_WAVES) {
      const oldest = this.waves.shift();
      if (oldest) this.disposeGroundMesh(oldest.mesh, oldest.mat);
    }
    const mat = new THREE.MeshBasicMaterial({
      color: av.primary,
      transparent: true,
      opacity: plan.ringOpacity,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    // 单位环按半径缩放 —— 与 ensureRing 同一手法
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.88, 1, 56), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(center.x, center.y + 0.05, center.z);
    mesh.scale.setScalar(0.01);
    mesh.renderOrder = 3;
    this.group.add(mesh);
    this.waves.push({ mesh, mat, age: 0, life: plan.life, radius });

    if (!plan.decal) return;
    if (this.decals.length >= MAX_DECALS) {
      const oldest = this.decals.shift();
      if (oldest) this.disposeGroundMesh(oldest.mesh, oldest.mat);
    }
    const decalMat = new THREE.MeshBasicMaterial({
      color: av.primary,
      transparent: true,
      opacity: plan.decalOpacity,
      side: THREE.DoubleSide,
      depthWrite: false,
      // ★ 正常混合而不是加法：加法会把本来就亮的地面糊成白斑
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    const decal = new THREE.Mesh(new THREE.CircleGeometry(1, 40), decalMat);
    decal.rotation.x = -Math.PI / 2;
    decal.position.set(center.x, center.y + 0.02, center.z);
    decal.scale.setScalar(radius);
    decal.renderOrder = 2; // 排在边界环之下
    this.group.add(decal);
    this.decals.push({
      mesh: decal, mat: decalMat, age: 0, life: plan.decalLife, opacity: plan.decalOpacity,
    });
  }

  /** 波与染色盘的推进。两者都是「自然消亡」的瞬时对象，没有 present 差分 */
  private updateWaves(dt: number): void {
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i]!;
      w.age += dt;
      const t = w.age / w.life;
      if (t >= 1) {
        this.disposeGroundMesh(w.mesh, w.mat);
        this.waves.splice(i, 1);
        continue;
      }
      // 先快后慢地铺开，同时淡出
      w.mesh.scale.setScalar(Math.max(0.01, w.radius * waveEase(t)));
      w.mat.opacity = 0.9 * (1 - t);
    }
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i]!;
      d.age += dt;
      const t = d.age / d.life;
      if (t >= 1) {
        this.disposeGroundMesh(d.mesh, d.mat);
        this.decals.splice(i, 1);
        continue;
      }
      d.mat.opacity = d.opacity * (1 - t);
    }
  }

  private disposeGroundMesh(mesh: THREE.Mesh, mat: THREE.Material): void {
    this.group.remove(mesh);
    mesh.geometry.dispose();
    mat.dispose();
  }

  // ── 每帧：施法蓄力（14.1「预备」）─────────────────────────────

  /**
   * 读条/引导期间的持续表现：脚下旋转符文法阵 + 手上聚能粒子。
   *
   * ★★ 14.1 的「预备」阶段此前只有**一帧** pop —— 一个 1.5 秒的读条里
   *   有 1.4 秒施法者身上什么都没有。这个方法就是那句话的兑现。
   *
   * ★ 数据来源与场景无关：试验场喂 `CombatDirector.castOf`，
   *   联网喂施法注册表 —— 两边都收窄成 `CastView`。
   */
  private syncCasts(
    casts: readonly CastView[],
    quality: QualityTier,
    dt: number,
    now: number,
    cameraPosition?: Vec3Like,
  ): void {
    const density = decorativeDensity(quality);

    /**
     * 谁能冒粒子：按到相机的距离取最近的几个。
     * ★ 只裁装饰粒子 —— 法阵下面照画不误（验收 #48）。
     */
    const emitters = new Set<number>();
    if (density > 0 && casts.length > 0) {
      const ranked = cameraPosition
        ? [...casts].sort(
            (a, b) => sqDist(a.position, cameraPosition) - sqDist(b.position, cameraPosition),
          )
        : casts;
      for (const c of ranked.slice(0, MAX_WINDUP_EMITTERS)) emitters.add(c.id);
    }
    this.windupEmitterCount = emitters.size;

    const present = new Set<number>();
    for (const c of casts) {
      present.add(c.id);
      const skill = getSkill(asSkillId(c.skillId));
      const av = skill ? visualOf(skill) : ATTRIBUTE_VISUALS.arcane;
      const plan = windupPlanFor({
        now,
        startedAt: c.startedAt,
        endsAt: c.endsAt,
        ...(c.channelEndsAt !== undefined ? { channelEndsAt: c.channelEndsAt } : {}),
        density,
      });

      const entry = this.ensureWindup(c.id, av);
      entry.lastProgress = plan.progress;

      // 法阵贴在脚下，跟着人走（施法期间也可能被击退/位移）
      entry.spin += plan.circleSpin * dt;
      entry.group.position.set(c.position.x, c.position.y + 0.06, c.position.z);
      entry.group.scale.setScalar(2.2 * plan.circleScale);
      entry.ring.rotation.z = entry.spin;
      if (entry.runes) entry.runes.rotation.z = -entry.spin * 0.6;
      // 第一人称压透明度，与粒子的 closeFade 同一条规矩（14.3 / 验收 #49）
      const fade = plan.circleOpacity * (this.cameraDistance < 3 ? 0.45 : 1);
      entry.ringMat.opacity = fade;
      if (entry.runeMat) entry.runeMat.opacity = fade * 0.7;

      // 手部锚点：与释放 pop 用同一个前移半米的算法，两者才接得上
      const hand: Vec3Like = {
        x: c.position.x - Math.sin(c.yaw) * 0.5,
        y: c.position.y + c.height * 0.62,
        z: c.position.z - Math.cos(c.yaw) * 0.5,
      };
      entry.lastPos = hand;

      if (plan.count <= 0 || plan.cadence <= 0 || !emitters.has(c.id)) continue;
      entry.timer += dt;
      if (entry.timer < plan.cadence) continue;
      entry.timer = 0;
      /**
       * ★ 聚能是**向内**的：粒子生在环上、朝手心收 —— 用负 speed 做不到
       *   （speed 是标量），所以生在环上、给一个朝内的初速度。
       *   `drag` 调大让它们很快停在手上而不是穿过去。
       */
      const ang = Math.random() * Math.PI * 2;
      const r = plan.gatherRadius;
      this.emitBurst(
        { x: hand.x + Math.cos(ang) * r, y: hand.y + (Math.random() - 0.5) * 0.5, z: hand.z + Math.sin(ang) * r },
        av,
        {
          count: plan.count,
          speed: 0.35,
          size: plan.size,
          life: plan.life,
          gravity: 0.6,
          drag: 3.4,
          stream: true,
        },
      );
    }

    for (const id of [...this.windups.keys()]) {
      if (!present.has(id)) this.removeWindup(id);
    }
  }

  /**
   * 法阵节点 = **外圈轮廓 + 内层符文**，两层反向转。
   *
   * ★★ 只用符文贴图（`magic_04` 是一团实心符文斑）铺在地上，实测读作
   *   「地上有片光」而不是「一个法阵」—— 圆形轮廓才是「法阵」这个符号的
   *   识别特征。所以外圈用程序化 `RingGeometry` 画一道干净的环，
   *   符文贴图缩在里面当纹理层；素材缺失时只剩外圈，**信息一点不丢**
   *   （与本文件其它退化路径同一条原则）。
   */
  private ensureWindup(id: number, av: AttributeVisual): WindupEntry {
    let entry = this.windups.get(id);
    if (entry) return entry;

    const group = new THREE.Group();
    group.rotation.x = -Math.PI / 2;

    // ★ 几何体逐实例新建 —— removeWindup 会释放它（共享的话第一个人施法结束
    //   就会把全场法阵打成空白，与 disposeNode 的 ★★ 是同一个坑）
    const ringMat = new THREE.MeshBasicMaterial({
      color: av.primary,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 56), ringMat);
    ring.renderOrder = 3;
    group.add(ring);

    let runes: THREE.Mesh | undefined;
    let runeMat: THREE.MeshBasicMaterial | undefined;
    const tex = this.particleTex.get('rune');
    if (tex) {
      runeMat = new THREE.MeshBasicMaterial({
        map: tex,
        color: av.secondary,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      runes = new THREE.Mesh(new THREE.PlaneGeometry(1.55, 1.55), runeMat);
      runes.renderOrder = 3;
      group.add(runes);
    }

    this.group.add(group);
    entry = {
      group, ring, ringMat,
      ...(runes ? { runes } : {}),
      ...(runeMat ? { runeMat } : {}),
      visual: av, timer: 0, spin: 0, lastProgress: 0, lastPos: { x: 0, y: 0, z: 0 },
    };
    this.windups.set(id, entry);
    return entry;
  }

  private removeWindup(id: number): void {
    const entry = this.windups.get(id);
    if (!entry) return;
    this.group.remove(entry.group);
    entry.ring.geometry.dispose();
    entry.ringMat.dispose();
    entry.runes?.geometry.dispose();
    entry.runeMat?.dispose();
    this.windups.delete(id);
  }

  /**
   * 表现用弹体的推进：**追踪**目标当前位置（每帧刷新终点），追上即爆并回收。
   * ★ 追不上的极端情况（目标反复闪现）由 age 上限兜底强制抵达。
   */
  private updateBolts(dt: number, quality: QualityTier, cameraPosition?: Vec3Like): void {
    const showTrail = isVisible('projectileTrail', quality);
    const density = decorativeDensity(quality);
    // 只有离相机最近的几发冒拖尾粒子；彗尾条（零池占用）每发都有
    const emitters = this.nearestIds(this.bolts.map((b, i) => ({ id: i, position: b.group.position })), cameraPosition, MAX_TRAIL_EMITTERS);
    let emitting = 0;

    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i]!;
      b.age += dt;
      // 终点每帧刷新；目标不可见（潜行/离场）时保持最后已知位置
      const tracked = b.track?.();
      if (tracked) b.to = tracked;

      const g = b.group.position;
      const dx = b.to.x - g.x;
      const dy = b.to.y - g.y;
      const dz = b.to.z - g.z;
      const d = Math.hypot(dx, dy, dz);
      const step = BOLT_SPEED * dt;

      if (d > step && b.age < 2) {
        const k = step / d;
        g.set(g.x + dx * k, g.y + dy * k, g.z + dz * k);
        this.orientBolt(b.group, { x: dx, y: dy, z: dz }, b.visual, dt, showTrail);

        const plan = trailPlanFor(b.visual.particle, density);
        if (!showTrail || plan.count <= 0 || !emitters.has(i)) continue;
        emitting += 1;
        b.trailTimer += dt;
        if (b.trailTimer < plan.cadence) continue;
        b.trailTimer = 0;
        this.emitBurst(g, b.visual, {
          count: plan.count, speed: 0.7, size: plan.size, life: plan.life,
          gravity: plan.gravity, drag: plan.drag, opacity: plan.opacity,
          stream: true,
        });
        continue;
      }

      // 抵达（或超龄强制抵达）：命中爆发在目标**当前**位置炸开 ——
      // 命中资格早在释放瞬间定死（6.6），这里只是把它演在人身上而不是空地上
      this.emitBurst(b.to, b.visual, { count: 18, speed: 4.4, size: 0.75, life: 0.55 });
      this.emitAccent(b.to, 'debris', b.visual.secondary, 0.95);
      this.disposeNode(b.group);
      this.bolts.splice(i, 1);
    }
    this.trailEmitterCount = emitting;
  }

  /**
   * 离相机最近的 N 个 id（装饰层 LOD 的唯一实现）。
   * ★ 只用于裁**装饰**发射器 —— essential 部件（弹体主体、边界环、法阵）
   *   一个都不裁，验收 #48 的边界在这里就守住了。
   */
  private nearestIds(
    items: readonly { id: number; position: Vec3Like }[],
    cameraPosition: Vec3Like | undefined,
    limit: number,
  ): Set<number> {
    if (items.length <= limit) return new Set(items.map((it) => it.id));
    const ranked = cameraPosition
      ? [...items].sort(
          (a, b) => sqDist(a.position, cameraPosition) - sqDist(b.position, cameraPosition),
        )
      : items;
    return new Set(ranked.slice(0, limit).map((it) => it.id));
  }

  private spawnBolt(
    from: Vec3Like,
    to: Vec3Like,
    av: AttributeVisual,
    track?: () => Vec3Like | undefined,
  ): void {
    // 同时在飞的弹体设个上限：12v12 混战里这是唯一会无界增长的东西
    if (this.bolts.length >= 24) {
      const oldest = this.bolts.shift();
      if (oldest) this.disposeNode(oldest.group);
    }
    const group = this.makeBoltNode(av);
    group.position.set(from.x, from.y, from.z);
    this.group.add(group);
    this.bolts.push({ group, visual: av, to: { ...to }, track, age: 0, trailTimer: 0 });
  }

  // ── 每帧：真实投射物（本地 sim 或服务器快照，都收 ProjectileView）──

  /**
   * 把投射物视图画成看得见的飞行体。
   *   homing / colliding → 属性色球（essential）+ 拖尾（decorative）
   *   delayedImpact      → 持续落点边界环（essential，14.3 要求全程可见）
   * 消失的投射物在末位置补一发命中爆发。
   */
  private syncProjectiles(
    items: readonly ProjectileView[], quality: QualityTier, dt: number, now: number,
  ): void {
    this.trailTimer += dt;
    const showTrail = isVisible('projectileTrail', quality);
    const density = decorativeDensity(quality);

    const present = new Set<number>();
    const delayedPresent = new Set<string>();

    for (const p of items) {
      if (p.kind === 'delayedImpact') {
        const key = `p${p.id}`;
        delayedPresent.add(key);
        const skill = getSkill(asSkillId(p.skillId));
        const entry = this.ensureRing(
          key, p.position, p.radius ?? 1,
          (skill ? visualOf(skill) : ATTRIBUTE_VISUALS.fire).primary,
        );
        // 14.3：落点边界 + **倒计时**。剩余秒数向上取整（「还有 2 秒」比 1.7 可读）
        if (p.impactAt !== undefined) {
          this.updateCountdown(entry, Math.max(0, Math.ceil(p.impactAt - now)));
        }
        continue;
      }
      // homing | colliding
      present.add(p.id);
      // ★ 属性只在**创建时**解析一次并存进 ProjBody —— 之前是每帧
      //   `getSkill()` 一次，纯属白做（一发弹体的技能不会中途改变）
      const body = this.ensureProjBody(p.id, p.skillId);
      /**
       * ★ 位置做指数平滑：联网时快照 20Hz 一跳，直接 set 会让弹体
       *   以台阶前进。平滑系数取 ~22/s（半衰期 ~30ms），本地 60Hz 驱动时
       *   误差不足一帧、肉眼不可辨，所以两边共用同一条路径。
       *   跳变超过 4 米按瞬移处理（新一发复用了旧 id 之类的情况）。
       */
      const g = body.group.position;
      const jump = Math.hypot(p.position.x - g.x, p.position.y - g.y, p.position.z - g.z);
      if (body.fresh || jump > 4) {
        g.set(p.position.x, p.position.y, p.position.z);
        body.fresh = false;
      } else {
        const k = 1 - Math.exp(-22 * dt);
        g.x += (p.position.x - g.x) * k;
        g.y += (p.position.y - g.y) * k;
        g.z += (p.position.z - g.z) * k;
      }
      // ★ 真投射物没有「目标」可指 —— 方向取本帧的**位移**（平滑后的），
      //   位移过小说明刚生成/静止，保持上一帧朝向不动（避免抖成陀螺）
      const dir = { x: g.x - body.lastPos.x, y: g.y - body.lastPos.y, z: g.z - body.lastPos.z };
      if (Math.hypot(dir.x, dir.y, dir.z) > 1e-4) {
        this.orientBolt(body.group, dir, body.visual, dt, showTrail);
      }
      body.lastPos.x = g.x;
      body.lastPos.y = g.y;
      body.lastPos.z = g.z;

      const plan = trailPlanFor(body.visual.particle, density);
      if (showTrail && plan.count > 0 && this.trailTimer >= plan.cadence) {
        // 真投射物（弩箭）的拖尾用轨迹条贴图 trace_05，与法术弹体的属性粒子区分
        this.emitBurst(body.lastPos, body.visual, {
          count: plan.count, speed: 0.6, size: plan.size, life: plan.life,
          gravity: plan.gravity, drag: plan.drag, opacity: plan.opacity,
          texture: this.accentTex.get('trail') ?? this.texFor(body.visual.particle),
          stream: true,
        });
      }
    }
    // ★ 节拍计时器在**遍历之后**清零：多发弩箭同帧共用一个节拍，
    //   不会因为「第一发清了零」让后面几发这一帧发不出来
    if (this.trailTimer >= trailPlanFor('spark', density).cadence) this.trailTimer = 0;

    // 消失的飞行体 → 命中爆发 + 回收
    for (const id of this.seenProjectiles) {
      if (present.has(id)) continue;
      const body = this.projBodies.get(id);
      if (!body) continue;
      this.emitBurst(body.lastPos, body.visual, { count: 14, speed: 3.8, size: 0.55, life: 0.5 });
      this.emitAccent(body.lastPos, 'debris', body.visual.secondary, 0.7);
      this.removeProjBody(id);
    }
    this.seenProjectiles = present;

    /**
     * 落点环随延迟落点消失而回收。
     * ★ 这里**不补爆发** —— 陨石落地会产生真实的 damage 事件，
     *   由 `onCombatEvent` 在每个被命中者身上各放一发。在这里再放一发
     *   会变成「中心一发 + 每人一发」的双份。
     */
    for (const key of [...this.rings.keys()]) {
      if (key.startsWith('p') && !delayedPresent.has(key)) this.removeRing(key);
    }
  }

  // ── 每帧：地面区域 ─────────────────────────────────────────────

  /**
   * 地面持续区域（暴风雪、毒云…）：
   *   持续边界环（essential，14.3「边界全程可见」）+ 内部上升装饰粒子（decorative，可淡出）。
   */
  private syncGround(
    areas: readonly GroundAreaView[], quality: QualityTier, dt: number, cameraPosition?: Vec3Like,
  ): void {
    const showFill = isVisible('groundFill', quality);
    const density = decorativeDensity(quality);
    // 只有离相机最近的几片冒粒子；其余照画边界环与染色盘（边界是 essential）
    const emitters = this.nearestIds(
      areas.map((a) => ({ id: a.id, position: a.center })), cameraPosition, MAX_FILL_AREAS,
    );

    const present = new Set<string>();
    for (const a of areas) {
      const key = `g${a.id}`;
      present.add(key);
      const skill = getSkill(asSkillId(a.skillId));
      const av = skill ? visualOf(skill) : ATTRIBUTE_VISUALS.frost;
      const entry = this.ensureRing(key, a.center, a.radius, av.primary);
      const plan = groundFillPlanFor(av.particle, a.radius, density);

      // 地面染色盘：让区域读作「这里有东西」，而不只是一圈线
      this.syncAreaTint(entry, a, av.primary, showFill ? plan.tintOpacity : 0);

      if (!showFill || plan.clusters <= 0 || !emitters.has(a.id)) continue;
      /**
       * ★ 每片区域**自带计时器**（此前是一个全局 fillTimer）：
       *   多片区域同时在场时，全局计时器会让它们同一帧齐发 ——
       *   一帧吃掉好几个池槽，下一帧又全空，观感是一阵一阵地闪。
       */
      entry.fillTimer = (entry.fillTimer ?? 0) + dt;
      if (entry.fillTimer < plan.cadence) continue;
      entry.fillTimer = 0;

      for (let i = 0; i < plan.clusters; i++) {
        this.emitBurst(
          {
            x: a.center.x,
            // ★ 关键的一行：雪从三米多高开始飘，火从贴地升起 ——
            //   此前这里写死 y = center.y、gravity = +1.4，把「雪花飘落」掰成了上升
            y: a.center.y + plan.spawnHeight,
            z: a.center.z,
          },
          av,
          {
            count: plan.count,
            speed: plan.mode === 'fall' ? 0.35 : 0.6,
            size: plan.size,
            life: plan.life,
            gravity: plan.gravity,
            drag: plan.drag,
            spread: plan.spread,
            // ★ 一次 emit 铺满整片区域 —— 此前是「在区域内随机挑一个点撒一小簇」，
            //   实测读作「地上有两团东西」而不是「这一片在下雪」
            originRadius: a.radius,
            stream: true,
          },
        );
      }
    }

    for (const key of [...this.rings.keys()]) {
      if (key.startsWith('g') && !present.has(key)) this.removeRing(key);
    }
  }

  /**
   * 区域的地面染色盘。★ 正常混合而不是加法 —— 加法会把明亮的地面糊成白斑，
   * 而这一层的作用恰恰是「地面被这个法术改了颜色」。
   */
  private syncAreaTint(
    entry: RingEntry, area: GroundAreaView, color: number, opacity: number,
  ): void {
    if (opacity <= 0) {
      if (entry.tint) entry.tint.visible = false;
      return;
    }
    if (!entry.tint) {
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      });
      const mesh = new THREE.Mesh(new THREE.CircleGeometry(1, 40), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 2; // 排在边界环（3）之下
      this.group.add(mesh);
      entry.tint = { mesh, mat };
    }
    entry.tint.visible = true;
    entry.tint.mesh.visible = true;
    entry.tint.mat.color.set(color);
    entry.tint.mat.opacity = opacity;
    entry.tint.mesh.scale.setScalar(area.radius);
    entry.tint.mesh.position.set(area.center.x, area.center.y + 0.02, area.center.z);
  }

  // ── 发射工具 ──────────────────────────────────────────────────

  private emitBurst(
    origin: Vec3Like,
    av: AttributeVisual,
    opts: {
      count: number;
      speed?: number;
      size?: number;
      life?: number;
      gravity?: number;
      drag?: number;
      spread?: 'sphere' | 'disc';
      opacity?: number;
      /** 覆盖默认的属性主粒子贴图（拖尾用轨迹条时传）。null = 程序化软圆点 */
      texture?: THREE.Texture | null;
      /** 水平生成半径（天气类填充传区域半径，一次铺满整片）*/
      originRadius?: number;
      /**
       * 走**细流池**而不是事件池。★ 拖尾/地面填充/蓄力这类每隔几十毫秒
       * 就发一次的必须传 true —— 否则它们会把命中爆发挤出事件池。
       */
      stream?: boolean;
    },
  ): void {
    const motion = MOTION[av.particle];
    // 近镜头（第一人称）压低透明度，不糊满屏（14.3）
    const closeFade = this.cameraDistance < 3 ? 0.45 : 1;
    (opts.stream === true ? this.streams : this.pool).emit({
      origin,
      count: opts.count,
      primary: av.primary,
      secondary: av.secondary,
      texture: opts.texture !== undefined ? opts.texture : this.texFor(av.particle),
      speed: opts.speed,
      size: opts.size,
      life: opts.life,
      gravity: opts.gravity ?? motion.gravity,
      swirl: motion.swirl,
      drag: opts.drag,
      spread: opts.spread,
      opacity: (opts.opacity ?? 1) * closeFade,
      ...(opts.originRadius !== undefined ? { originRadius: opts.originRadius } : {}),
    });
  }

  private emitAccent(origin: Vec3Like, which: AccentTexture, color: number, size: number): void {
    this.pool.emit({
      origin,
      count: 8,
      primary: color,
      secondary: color,
      texture: this.accentTex.get(which) ?? null,
      speed: 2.8,
      size,
      life: 0.4,
      drag: 3,
    });
  }

  // ── 飞行体节点 ────────────────────────────────────────────────

  /**
   * 弹体外观。**整组沿速度方向定向**（见 `boltOrientation`），所有拉长的部件
   * 都摆在本地 -Z（后方），于是一转就自动跟着飞行方向走。
   *
   * 五层，从内到外：
   *   1. 实心核  —— 无贴图也可见的最后一道保底（essential）
   *   2. 拖长锥  —— 沿速度拉长的尾锥，「这是飞过去的」的形状信号（essential）
   *   3. 属性头  —— 火用 `fire_01`、冰用 `star_07`… 这才是「火焰球 / 冰晶球」
   *   4. 辉光    —— 一圈软光晕
   *   5. 彗尾条  —— `trace_05` 拉长的一条尾迹（decorative，低画质裁）
   *
   * ★★ **几何体一律逐实例新建，绝不共享**：`disposeNode()` 会 traverse 释放
   *   所有 Mesh 的几何体 —— 共享的话第一发弹体消失就把全场弹体打成空白。
   *   （与文件里那条「Sprite 全体共用一个模块级几何体」是同一个坑的两面。）
   */
  private makeBoltNode(av: AttributeVisual): THREE.Group {
    const g = new THREE.Group();

    // 1. 实心核
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 12, 12),
      new THREE.MeshBasicMaterial({ color: av.primary }),
    );
    core.renderOrder = 5;
    g.add(core);

    // 2. 拖长锥：底面在前、尖端朝后 —— 读作「拖着走」
    //    ConeGeometry 默认尖端在 +Y；rotateX(-90°) 把 +Y 转到 **-Z**（后方）
    const coneGeo = new THREE.ConeGeometry(0.2, 0.95, 12, 1, true);
    coneGeo.rotateX(-Math.PI / 2);
    const cone = new THREE.Mesh(
      coneGeo,
      new THREE.MeshBasicMaterial({
        color: av.secondary,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    cone.position.z = -0.5;
    cone.renderOrder = 5;
    g.add(cone);

    // 3. 属性头部：火焰/冰晶/符文…（Sprite 恒面向镜头，任何角度都认得出属性）
    const head = this.particleTex.get(av.particle);
    if (head) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: head,
          color: av.primary,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      sprite.scale.setScalar(1.35);
      sprite.position.z = 0.12;
      sprite.renderOrder = 6;
      g.add(sprite);
    }

    // 4. 辉光（比旧实现小一圈，给头部让位）
    const glow = this.accentTex.get('glow');
    if (glow) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glow,
          color: av.secondary,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      sprite.scale.setScalar(1.25);
      sprite.renderOrder = 5;
      g.add(sprite);
    }

    /**
     * 5. 彗尾条：★ 连贯的那条尾巴是它，粒子只负责撒落的余烬/雪花。
     *    零池占用 —— 挂在已定向的组下面，自动沿速度对齐。
     *
     * ★★ **两片交叉**而不是一片：一片贴片沿飞行方向躺平之后，从侧面看是
     *   一条零厚度的线（几乎不可见）。交叉双片（法线一个朝 Y、一个朝 X）
     *   在任何视角都至少有一片正对镜头 —— 拖尾/火焰的老办法，
     *   比让它 billboard 便宜，也不会在弹体转向时打转。
     */
    const trailTex = this.accentTex.get('trail');
    if (trailTex) {
      const tailMat = new THREE.MeshBasicMaterial({
        map: trailTex,
        color: av.primary,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      for (const roll of [0, Math.PI / 2]) {
        // 贴图长边是 Y：绕 X 转 -90° 让长边躺进 -Z（后方），再绕长轴滚 0/90°
        const geo = new THREE.PlaneGeometry(0.62, 3.2);
        geo.rotateX(-Math.PI / 2);
        if (roll !== 0) geo.rotateZ(roll);
        const tail = new THREE.Mesh(geo, tailMat);
        tail.position.z = -1.7;
        tail.renderOrder = 4;
        tail.name = 'bolt-tail'; // 画质裁剪按名字找它（projectileTrail 装饰角色）
        g.add(tail);
      }
    }
    return g;
  }

  /**
   * 弹体定向 + 彗尾条的画质门禁。两件事都只跟「这一帧往哪飞」有关，收在一处。
   * ★ `swirl > 0` 的属性（奥术符文、自然叶片）再叠一层自旋 —— 14.2 的
   *   「符文旋绕 / 叶片打旋」在弹体上的兑现。
   */
  private orientBolt(
    group: THREE.Group, dir: Vec3Like, av: AttributeVisual, dt: number, showTrail: boolean,
  ): void {
    const { yaw, pitch } = boltOrientation(dir);
    group.rotation.order = 'YXZ';
    group.rotation.y = yaw;
    group.rotation.x = pitch;
    const swirl = MOTION[av.particle].swirl;
    if (swirl > 0) group.rotation.z += swirl * dt;
    // ★ 两片交叉的尾条都要切（getObjectByName 只返回第一个，会漏掉另一片）
    for (const child of group.children) {
      if (child.name === 'bolt-tail') child.visible = showTrail;
    }
  }

  private ensureProjBody(id: number, skillId: string): ProjBody {
    let body = this.projBodies.get(id);
    if (body) return body;
    const skill = getSkill(asSkillId(skillId));
    const av = skill ? visualOf(skill) : ATTRIBUTE_VISUALS.arcane;
    const group = this.makeBoltNode(av);
    this.group.add(group);
    body = { group, visual: av, lastPos: { x: 0, y: 0, z: 0 }, fresh: true };
    this.projBodies.set(id, body);
    return body;
  }

  private removeProjBody(id: number): void {
    const body = this.projBodies.get(id);
    if (!body) return;
    this.disposeNode(body.group);
    this.projBodies.delete(id);
  }

  /**
   * 从场景摘下并释放一个飞行体节点。
   *
   * ★★ **只释放 Mesh 的几何体，绝不碰 Sprite 的。**
   *   three.js 的 `Sprite` 全体**共用一个模块级几何体** ——
   *   对它调一次 `dispose()` 会把场上**所有** Sprite 一起打成空白。
   *   材质是逐实例新建的，所以材质该释放。
   */
  private disposeNode(node: THREE.Object3D): void {
    this.group.remove(node);
    node.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
      const mat = (o as { material?: THREE.Material }).material;
      mat?.dispose();
    });
  }

  private ensureRing(key: string, center: Vec3Like, radius: number, color: number): RingEntry {
    let entry = this.rings.get(key);
    if (!entry) {
      // 半径 1 的单位环，实例按真实半径缩放 —— 边界永远等于判定半径（14.3）
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(0.9, 1, 48),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.85,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 3;
      this.group.add(mesh);
      entry = { mesh };
      this.rings.set(key, entry);
    }
    entry.mesh.scale.setScalar(radius);
    entry.mesh.position.set(center.x, center.y + 0.05, center.z);
    (entry.mesh.material as THREE.MeshBasicMaterial).color.set(color);
    return entry;
  }

  /**
   * 14.3「延迟技能显示落点和倒计时」的**倒计时**半边。
   * 数字用 canvas 纹理 Sprite 悬在环心上方；秒数没变就不重绘不重传。
   * ★ 与边界环同属 groundBoundary（essential）—— 没有任何画质分支。
   */
  private updateCountdown(entry: RingEntry, seconds: number): void {
    if (!entry.label) {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      const tex = new THREE.CanvasTexture(canvas);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      sprite.renderOrder = 8;
      // 挂在环 mesh 下会吃到环的 radius 缩放 —— 所以挂在顶层组里，位置手动跟
      this.group.add(sprite);
      entry.label = { sprite, mat, tex, canvas, shown: -1 };
    }
    const l = entry.label;
    l.sprite.position.set(
      entry.mesh.position.x,
      entry.mesh.position.y + 1.4,
      entry.mesh.position.z,
    );
    l.sprite.scale.setScalar(1.7);
    if (l.shown === seconds) return;
    l.shown = seconds;
    const c = l.canvas.getContext('2d');
    if (!c) return;
    c.clearRect(0, 0, 128, 128);
    c.font = 'bold 84px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineWidth = 10;
    c.strokeStyle = 'rgba(0,0,0,0.85)';
    c.strokeText(String(seconds), 64, 66);
    c.fillStyle = '#ffffff';
    c.fillText(String(seconds), 64, 66);
    l.tex.needsUpdate = true;
  }

  private removeRing(key: string): void {
    const entry = this.rings.get(key);
    if (!entry) return;
    this.group.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    (entry.mesh.material as THREE.Material).dispose();
    if (entry.tint) this.disposeGroundMesh(entry.tint.mesh, entry.tint.mat);
    if (entry.label) {
      this.group.remove(entry.label.sprite);
      entry.label.mat.dispose();
      entry.label.tex.dispose();
    }
    this.rings.delete(key);
  }

  // ── 自检 / 清理 ───────────────────────────────────────────────

  status(): SpellVfxStatus {
    return {
      texturesLoaded: this.texturesLoaded,
      texturesTotal: VFX_TEXTURE_FILES.length,
      attributesCovered: Object.keys(PARTICLE_TEXTURE).length,
      activeBursts: this.pool.activeCount + this.streams.activeCount,
      streamBursts: this.streams.activeCount,
      projectileBodies: this.projBodies.size,
      visualBolts: this.bolts.length,
      groundRings: this.rings.size,
      activeWindups: this.windups.size,
      windupEmitters: this.windupEmitterCount,
      trailEmitters: this.trailEmitterCount,
      groundWaves: this.waves.length,
      groundDecals:
        this.decals.length + [...this.rings.values()].filter((r) => r.tint?.visible).length,
      activeFlashes: this.flashes.activeCount,
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.projBodies.keys()]) this.removeProjBody(id);
    for (const b of this.bolts) this.disposeNode(b.group);
    this.bolts.length = 0;
    for (const key of [...this.rings.keys()]) this.removeRing(key);
    for (const id of [...this.windups.keys()]) this.removeWindup(id);
    for (const w of this.waves) this.disposeGroundMesh(w.mesh, w.mat);
    this.waves.length = 0;
    for (const d of this.decals) this.disposeGroundMesh(d.mesh, d.mat);
    this.decals.length = 0;
    this.pool.dispose();
    this.streams.dispose();
    this.flashes.dispose();
  }
}
