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
  GEOMETRY,
  SPELL_PROJECTILE,
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
  SLASH_ACCENTS,
  VFX_TEXTURE_FILES,
  accentTexture,
  particleTextureFor,
  type AccentTexture,
} from './particleTextures.js';
import {
  ATTRIBUTE_VISUALS,
  tintedVisual,
  visualForAuraId,
  visualForSchool,
  visualOf,
  type AttributeVisual,
} from './schools.js';
import {
  SignatureForm,
  resolveSignature,
  signatureOf,
  type ResolvedSignature,
} from '../av/skillSignature.js';
import { QualityTier, decorativeDensity, isVisible } from '../render/quality.js';
import {
  BOLT_BASE,
  GENERIC_BOLT_FORM,
  MOTION,
  boltFormFor,
  boltOrientation,
  trailPlanFor,
  type BoltForm,
} from './boltVfx.js';
import { fizzlePlanFor, windupPlanFor, windupStyleOf, type WindupStyle } from './castVfx.js';
import { castCircleStyleOf } from './castTint.js';
// ★ three 的 examples 包，只取一个纯几何合并函数（`StatusMarkers` 已在用同一个）
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { vfxScaleOf } from './skillWeight.js';
import {
  MAX_FILL_AREAS,
  fallHeightAt,
  fallPlanFor,
  groundFillPlanFor,
  impactPlanFor,
  wavePlanFor,
  waveEase,
  type ImpactStep,
} from './groundVfx.js';
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

/**
 * 地面区域的**风暴盘**贴图（八属性各一张）。
 *
 * ★★ 它承担的是「这一片有天气」的**持续**表达。粒子那条路已经顶死细流池预算
 *   （`vfxPlans.test.ts:246` 钉着 `ceil(life/cadence)*clusters ≤ 6`，雪正好 = 6），
 *   而且粒子是**间歇**的 —— 区域只活 4 秒，雪一生只发 6 轮，
 *   前后各有约 1.8 秒的空窗。贴图盘零池占用、零断言约束，且区域在它就在。
 * ★ 全部复用已登记的 25 张，不新增素材。
 */
const STORM_TEXTURE: Record<AttributeVisual['particle'], AccentTexture> = {
  snowflake: 'cloud',   // 冰：细碎浓云 = 风雪
  ember: 'puff',        // 火：翻滚火云
  beam: 'glow',         // 神圣：一片光晕
  smoke: 'cloud',       // 暗影：浓烟
  droplet: 'scorch',    // 毒素：地面腐蚀斑
  leaf: 'puff',         // 自然：花粉/叶絮
  rune: 'sparkle',      // 奥术：符文星屑
  spark: 'scorch',      // 物理：焦土
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
 * 表现用弹体的**兜底**飞行速度（米/秒）。
 *
 * ★★ **W23 起这个数不再住在客户端** —— 它与 sim 的锁定投射物速度
 *   必须**逐位相同**：迁移后的法术在 `距离 / 速度` 秒后落账，
 *   客户端弹体也在同一时刻抵达。两边各写一个 55 就是「同一个数字有两处
 *   定义」，而本仓库这类漂移已经付过四次学费。
 * ★ W25：速度不再是一个数（箭 75 / 法术与投掷物 55），所以真正的取值
 *   走 `boltSpeedOf()` —— **按技能读它自己那一档**。这个常量退居兜底：
 *   没迁移的技能（客户端照旧画装饰弹道，sim 侧瞬时落账）用它，
 *   数值仍然只有 `constants/combat.ts` 一个来源。
 */
const BOLT_SPEED = SPELL_PROJECTILE.SPEED;

/**
 * 这个技能的装饰弹道该飞多快 —— **从技能数据的 `lockedProjectile.speed` 读**。
 *
 * ★★ W25 起 sim 的弹速按技能分档（`SPELL_PROJECTILE.ARROW_SPEED` = 75 的箭、
 *   `SPEED` = 55 的法术与投掷物）。装饰弹道的寿命公式是
 *   `距离 / 速度`，与 sim 的 `impactAt` 同一条 —— 速度这一项要是继续统一取 55，
 *   猎人的瞄准射击就会**每一发都晚到 0.17 秒**：伤害先落、箭后到，
 *   正好是 W23 修掉的那个错拍在物理远程上原样复发。
 * ★ 查不到 `lockedProjectile` 的技能（没迁移的、纯装饰弹道的）回落
 *   `BOLT_SPEED` —— 它们在 sim 里本来就是瞬时结算，没有要对齐的时刻，
 *   55 只是一个好看的观感值。
 * ★ 结果按技能 id 记一次：`onCast` 是每次施放都走的路，而技能定义
 *   在一局里不会变。
 */
const boltSpeedCache = new Map<string, number>();
const boltSpeedOf = (skill: SkillDef): number => {
  const key = skill.id as string;
  const hit = boltSpeedCache.get(key);
  if (hit !== undefined) return hit;
  const locked = skill.effects.find((e) => e.kind === 'lockedProjectile');
  const speed = locked?.speed ?? BOLT_SPEED;
  boltSpeedCache.set(key, speed);
  return speed;
};

/** 近战技能不该有弹体。6.1 的近战档最长 3.8 米，取 8 米作为「这是远程」的判据 */
const BOLT_MIN_RANGE = SPELL_PROJECTILE.MIN_RANGE;

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
 * 这一组效果里有没有**伤害** —— 必须下探 `lockedProjectile.onHit`。
 *
 * ★★ W23 把 21 个技能的伤害从技能顶层挪进了 `onHit`。本文件有两处
 *   「带伤害的就不补到位爆发」的顶层扫描，不下探的话它们对霜矢/裁决/月火
 *   （damage + applyAura 同时在 onHit 里）**恒为假**：命中瞬间 damage 事件
 *   画一次、auraApplied 再画一次，粒子量与二级形态在同一帧翻倍 ——
 *   W23 要消灭的双重渲染换个地方复活了，而且没有任何测试会因此变红。
 * ★ 与 `schools.ts` 的 `hasPoisonAura`、`phases.ts` 的 `appliesAuraIn`、
 *   `hud/skillIcon.ts` 的 `flattenEffects` 是同一族处理，改一处就该改一族。
 */
const dealsDamage = (effects: readonly SkillDef['effects'][number][]): boolean =>
  effects.some(
    (e) => e.kind === 'damage' || (e.kind === 'lockedProjectile' && dealsDamage(e.onHit)),
  );

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
  | { t: 'shieldBroken'; targetId: EntityId; auraId?: string }
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

/**
 * 命中爆发的参数计划。
 * ★ 总缩放仍钳在 2.1；系数 18 → 23 让 count 上限从 38 抬到 **48**，
 *   正好吃满 `MAX_PARTICLES`（`vfx.test.ts` 钉的就是 ≤48）——
 *   这 10 粒是**断言允许范围内白送的**，不需要动任何测试。
 */
export const burstPlanFor = (
  tier: ImpactTier,
  amount: number,
  quality: QualityTier,
): BurstPlan => {
  const scale = Math.min(2.1, (0.75 + amount / 320) * TIER_BOOST[tier]);
  const heavyPlus = tier === 'heavy' || tier === 'crit' || tier === 'critHeavy' || tier === 'kill';
  return {
    scale,
    count: Math.min(48, Math.round(23 * scale)),
    speed: 4.6 * scale,
    size: 0.72 * scale,
    // ★ 旧实现 life 是常量 0.55 —— 重击应该「留」得久一点
    life: 0.5 + 0.14 * scale,
    shockwave: heavyPlus,
    debris: heavyPlus && isVisible('impactDebris', quality),
    whiteCore: tier === 'crit' || tier === 'critHeavy',
  };
};

// ── P3 技能签名：规模乘数与二级形态（纯函数，vitest 里不用 WebGL 就能测）──

/**
 * 事件池单格粒子上限。★ 必须与 `ParticleBurst` 的 `MAX_PARTICLES` 同值 ——
 * 那边 `Burst.emit` 会把超出的 count **静默钳掉**，而静默正是问题：
 * 签名 scale 一旦把申请量顶穿，画面上是「大招反而没有小技能密」，
 * 没有任何日志、没有任何断言。所以这一层显式截断并由测试盯住。
 */
export const EVENT_PARTICLE_CAP = 48;
/** 细流池单格粒子上限（本类构造的 `new BurstPool(48, 32)` 的第二个参数）*/
export const STREAM_PARTICLE_CAP = 32;

/**
 * 一次签名编排最多占用的**事件池格数**，且是**每帧**上限而不是每次调用上限。
 *
 * ★★ 每帧而不是每次：一发 8 目标的群体光环技能会在同一帧触发 8 次到位表现，
 *   按「每次 ≤ 3 格」算就是 24 格 —— 事件池总共才 40 格，剩下的 16 格
 *   连这一发自己的命中爆发都装不下。这正是 X9「粒子池饱和」的复发形状：
 *   单点看每个数字都合理，乘上目标数就顶穿。
 * ★ 3 的出处：事件池 40 格里，一发 8 目标 AOE 的主爆发 + 碎屑已占 16 格
 *   （见 `pool` 字段注释），签名是**装饰层**，不该拿走同一量级的份额。
 *   占位值，真机 12v12 观察 `activeBursts` 后可调。
 */
export const MAX_FORM_SLOTS_PER_FRAME = 3;

/**
 * 规模乘数下的粒子申请量。**先乘后截断**，截断到池的单格上限。
 * ★ 下限 1：`scale` 最低 0.6，小技能被收着但不能被收没 ——
 *   「这个技能没有特效」和「这个技能特效小」是两种完全不同的反馈。
 */
export const scaledCount = (base: number, scale: number, cap = EVENT_PARTICLE_CAP): number =>
  Math.max(1, Math.min(cap, Math.round(base * scale)));

/** 二级形态的一段编排。★ 纯数据 —— `emitForm` 只负责把它翻译成 emit */
export interface FormStep {
  /**
   * 生成高度偏移（米）。`ground` 为 true 时相对**地面**，否则相对爆发中心。
   * ★ 分两种锚点是因为形态的语义就分两种：光柱/落雨/扩散环读的是「地面」，
   *   碎片放射读的是「打中的那一点」。全部锚在爆发中心的话，
   *   胸口高度炸出来的「光柱」会从半空开始，读作一段悬空的光。
   */
  dy: number;
  ground: boolean;
  count: number;
  speed: number;
  size: number;
  life: number;
  gravity: number;
  drag: number;
  spread: 'sphere' | 'disc';
  originRadius: number;
  /** 切向初速（绕竖直轴）。螺旋/轨道靠它，其余形态给 0 */
  swirl: number;
}

/**
 * 七种二级形态的基准编排。语义逐条对应 `skillSignature.ts` 的 `SignatureForm` 注释。
 *
 * ★★ **全部复用 `ParticleBurst` 现成的属性主粒子贴图，零新增资产** ——
 *   形态的识别特征做在**运动**上（生成半径、初速方向、重力符号、切向速度），
 *   不做在贴图上。这一点是刻意的：贴图会被属性占满（火用火球、冰用雪花…），
 *   八属性 × 七形态 = 56 张贴图是不可能的；而运动是与属性**正交**的通道，
 *   同一朵雪花绕着人转和从天上落下来，玩家一眼分得开。
 *
 * ★ 每种形态最多 2 步 —— 上限由 `MAX_FORM_SLOTS_PER_FRAME` 兜底，但表本身
 *   就写在预算里，不靠兜底救。
 */
const FORM_STEPS: Record<Exclude<SignatureForm, 'none'>, readonly FormStep[]> = {
  // 水平扩散环：贴地起、横着冲出去、很快被阻力刹住 —— 新星/震荡的读法
  ring: [
    { dy: 0.12, ground: true, count: 20, speed: 7.4, size: 0.5, life: 0.42,
      gravity: 0.4, drag: 2.6, spread: 'disc', originRadius: 0.35, swirl: 0 },
  ],
  // 上升螺旋：两层高度 + 强切向速度 + 正重力，绕着人往上拧 —— 增益/蓄力
  spiral: [
    { dy: 0.15, ground: true, count: 14, speed: 0.5, size: 0.46, life: 0.9,
      gravity: 3.4, drag: 0.7, spread: 'disc', originRadius: 0.8, swirl: 3.2 },
    { dy: 1.15, ground: true, count: 10, speed: 0.45, size: 0.4, life: 0.75,
      gravity: 3.0, drag: 0.7, spread: 'disc', originRadius: 0.5, swirl: 3.8 },
  ],
  // 锐利碎片：从命中点球面爆出，快、小、短命、往下坠 —— 物理暴发/斩杀
  shards: [
    { dy: 0, ground: false, count: 22, speed: 9.6, size: 0.34, life: 0.34,
      gravity: -6.5, drag: 0.9, spread: 'sphere', originRadius: 0.12, swirl: 0 },
  ],
  // 自上而下的落雨：高处大范围生成、几乎零初速、负重力拉下来 —— 持续区域
  rain: [
    { dy: 3.4, ground: true, count: 18, speed: 0.3, size: 0.44, life: 1.0,
      gravity: -7.5, drag: 0.35, spread: 'sphere', originRadius: 1.6, swirl: 0 },
  ],
  // 垂直光柱：窄生成半径 + 极小初速 + 强正重力 = 一根往上抽的柱子 —— 审判/惩击
  pillar: [
    { dy: 0.1, ground: true, count: 16, speed: 0.35, size: 0.5, life: 0.7,
      gravity: 11, drag: 0.5, spread: 'disc', originRadius: 0.3, swirl: 0.5 },
    { dy: 1.6, ground: true, count: 10, speed: 0.3, size: 0.42, life: 0.55,
      gravity: 9, drag: 0.5, spread: 'disc', originRadius: 0.22, swirl: 0.5 },
  ],
  // 环绕轨道：腰高一圈、零重力、低阻力 + 大切向速度，粒子留在轨道上 —— 护盾/光环
  orbit: [
    { dy: 0.95, ground: true, count: 16, speed: 0.25, size: 0.4, life: 1.1,
      gravity: 0, drag: 0.25, spread: 'disc', originRadius: 1.05, swirl: 5 },
  ],
};

/**
 * 解析一段二级形态编排。
 *
 * ★★ **17.2 特效密度的取舍：低密度档（`decorativeDensity` = 0，即 low）
 *   整体跳过二级形态；中密度档（0.5）整体减量。**
 *   如实说明为什么选「跳过」而不是「减量到 1 粒」：low 档已经把拖尾、
 *   地面填充、命中碎屑全砍光（14.4 的「可以减少」五项），二级形态是
 *   **同一类装饰** —— 唯独留下它，low 档反而会变成「只有签名形态在冒粒子」
 *   的怪样子，而且它会成为 low 档下唯一还在吃事件池的装饰源。
 *   ★ 被砍掉的只有**形态**：属性色、命中爆发、边界环、控制标记一个不少，
 *     没有任何关键信息（14.4 第二条八项）经由本函数消失。
 *
 * @param scale 已解析（已钳位）的签名规模乘数
 * @param density `decorativeDensity(quality)` 的返回值
 */
export const formPlanFor = (
  form: SignatureForm,
  scale: number,
  density: number,
): FormStep[] => {
  if (form === SignatureForm.None || density <= 0) return [];
  const base = FORM_STEPS[form];
  return base.slice(0, MAX_FORM_SLOTS_PER_FRAME).map((s) => ({
    ...s,
    // ★ 只乘 count 与 size：life/生成半径这些是形态的**识别特征**，
    //   跟着 scale 缩放会让大招的「环」变成「面」，形态就不是同一个符号了
    count: scaledCount(s.count * density, scale),
    size: s.size * scale,
  }));
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
  /**
   * 这一发的技能签名。★ 与 `visual` 一样**创建时解析一次**存起来 ——
   * 拖尾密度每 0.07 秒就要读它一次，每次重解析是纯白做（技能不会中途变）。
   */
  sig: ResolvedSignature;
  /** 这一发的弹体形态（技能级覆盖，霜矢是冰矛）。自旋每帧要读它 */
  form: BoltForm;
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
  /**
   * 天上那颗正在砸下来的东西（只有登记了 `fallPlanFor` 的技能有，目前只有陨星）。
   * ★ `from` = **首次看见这颗落点时的剩余秒数**，坠落高度按它归一化 ——
   *   不写死 1.5 秒，sim 改了 delay 这边不会错位，中途入场也从半空接着落。
   */
  fall?: {
    body: THREE.Group;
    from: number;
  };
  /**
   * 落地要放的冲击（技能级覆盖）。★ 存在环上而不是查表现算：
   *   环消失那一刻 `ProjectileView` 已经不在了，skillId / radius 都取不到。
   */
  impact?: {
    skillId: string;
    radius: number;
  };
}

/**
 * 一次**错峰**的落地冲击。`delay` 到点才发，见 `updateImpacts`。
 * ★ 队列存在的唯一理由就是错峰：同帧齐发只是一团更大的球，读不出层次。
 */
interface PendingImpact {
  center: Vec3Like;
  /** 落点地面高度 —— 三步都锚在地上（陨星是砸在地上的，不是炸在半空） */
  groundY: number;
  av: AttributeVisual;
  steps: ImpactStep[];
  /** 已经过去的秒数 */
  age: number;
  /** 下一个还没发的步序号 */
  next: number;
}

/**
 * 同时在排队的落地冲击上限。
 * ★ 4 而不是无界：12v12 里同时落三四颗陨星是可能的，再多就该丢最旧的 ——
 *   与弹体 24 发上限同一条理由（这是场上唯一另一处会无界增长的队列）。
 */
const MAX_PENDING_IMPACTS = 4;

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
  /** 这一发的技能签名：尾迹密度按 scale，抵达爆发按 scale + form */
  sig: ResolvedSignature;
  /** 这一发的弹体形态（技能级覆盖，霜矢是冰矛）*/
  form: BoltForm;
  /** 当前追踪的终点（有 track 时每帧刷新）*/
  to: Vec3Like;
  /**
   * 终点处的**地面**高度。★ 抵达时的二级形态（光柱/落雨/扩散环）要锚在脚下，
   *   而 `to` 是躯干高度 —— 释放那一刻目标的 `position.y` 是唯一没有猜测成分
   *   的地面高度，所以在这里存下来，不在抵达时拿躯干高度反推。
   */
  groundY: number;
  track?: (() => Vec3Like | undefined) | undefined;
  /** 这一发对应的技能 id —— 快照兜底渲染靠它认「这发已经有人画了」 */
  skillId: string;
  /**
   * 起飞时刻（**绝对**时钟：联网 = serverTime，试验场 = world.time），
   * 在第一次 `updateBolts` 时落定。
   *
   * ★★ 此前这里是「累计 dt」（`age += dt`），而 `frame()` 收到的 dt 是
   *   **渲染** dt —— 顿帧（HitStop）只缩放渲染 dt（见 render/HitStop.ts：
   *   模拟步、输入采样、插值时钟一律走真实 dt）。于是同一次 frame 里两个钟
   *   并存：伤害落在真实钟的 impactAt 上，弹体却按缩放钟计时，一次暴击顿帧
   *   就让它迟到 88ms ≈ 1.8 个 tick。改成绝对时刻之后，顿帧只影响弹体
   *   **在空中走得多快**（观感），不影响它**什么时候到**（对齐）。
   * ★ 为什么懒到第一帧才落定：`onCast` 是在两次 frame **之间**到达的，
   *   那一刻本类手里没有当前时钟。第一帧落定与老实现的 `age` 从 0 起算
   *   逐帧等价，误差上限仍是一帧。
   */
  bornAt?: number;
  /**
   * 这一发的**寿命**，秒：到点强制抵达并爆开。
   *
   * ★★ **必须与 sim 的 `HomingProjectile.impactAt` 是同一条公式**
   *   （`max(0.05, 释放瞬间的水平距离 / 这个技能的弹速)`，弹速见
   *   `boltSpeedOf` —— W25 起按技能分档，不再是一个全局常量）——
   *   W23 之后伤害就落在那一刻。此前这里只有一个「age < 2」的兜底上限，
   *   弹体靠**追**目标当前位置来决定何时抵达：目标狂奔时弹体越追越久，
   *   于是视觉抵达晚于伤害落账，玩家看到的是「血条先掉、特效后到」——
   *   正是用户抱怨的那个错拍，只是方向反过来。
   * ★ 追踪本身**保留**（`track`）：终点仍每帧刷新，弹体不会打在目标两秒前
   *   站过的空地上。改的只是「什么时候算到」，不是「往哪飞」。
   * ★★ 抵达判据**只看这一个数**，不再看「几何上追上了没有」。两者取先的
   *   写法只钳住了迟到：目标被冲锋/暗影步/死亡之握拉近时弹体提前追上，
   *   视觉早于结算最多 8 个 tick（「冰矛已经炸了，血条半秒后才掉」）。
   *   飞行段改按剩余时间配速（见 `updateBolts`），到点**恰好**落在终点，
   *   顺带消掉了老实现「按 BOLT_SPEED 沿三维斜线硬推、到点还差半米就
   *   强制抵达」的那次位置跳变。
   */
  life: number;
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
  /** 内层纹章（按属性：雪花/火球/光斑/旋叶…，奥术保留符文，物理无纹章）。
   *  ★ 与外圈**反向**转 —— 两层反转是「机关在动」的最短路径 */
  runes?: THREE.Mesh;
  runeMat?: THREE.MeshBasicMaterial;
  /**
   * 这一圈法阵的**签名色**（外圈色 = primary、纹章色 = secondary，
   * 由 `castTint.ts` 放大到色系预算上限）。聚能粒子也吃它 ——
   * 外圈/纹章/粒子三层同色才读得出「这是同一个技能的光环」。
   */
  visual: AttributeVisual;
  /** 按属性分化的蓄力形态（castVfx.ts 的 WINDUP_STYLES）*/
  style: WindupStyle;
  /**
   * 建这个节点时用的技能 id。★ 换技能必须重建 —— 见 `syncCasts` 里那条差分。
   * 缺省（查不回技能的兜底路径）时为 undefined，与「任何 id 都不等」同效。
   */
  skillId?: string;
  /** 签名规模换算出的法阵尺寸乘数（castTint.ts 的 CIRCLE_SCALE_GAIN）*/
  circleScale: number;
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
 * 法阵外圈的几何体：**一道连续的圆环 + n 个外扩的断齿**，合并成一个。
 *
 * ★★ 齿数是技能身份的**非颜色**通道（`castTint.ts` 的 `circleTeethOf`）。
 *   色相预算在 14.2 那里封死在 ±0.08，同学派技能的颜色差到此为止；
 *   而「这个法阵有五个齿、那个有八个」是一眼可数、与属性色正交、
 *   色盲下照样成立的差别 —— 17.2 一直更偏好的正是这种通道。
 *
 * ★ 齿只**向外**长（1.0 → 1.14），连续的圆环一位不动：
 *   那道圆是 14.4 的关键元素（「这个人在施法」，`verify:m12` #14e/#48d
 *   钉着），把它切成虚线等于削弱告示本身。
 *
 * ★ 合并成**一个** BufferGeometry 而不是加几个 Mesh：一个施法者的法阵
 *   只该有外圈 + 纹章两次 draw call，12v12 里十几个人一起读条的账
 *   是按人乘的（`MAX_WINDUP_EMITTERS` 裁的是粒子，法阵一个都不裁）。
 */
const makeCircleGeometry = (teeth: number): THREE.BufferGeometry => {
  const base = new THREE.RingGeometry(0.86, 1, 56);
  const n = Math.max(0, Math.round(teeth));
  if (n === 0) return base;
  const step = (Math.PI * 2) / n;
  const parts: THREE.BufferGeometry[] = [base];
  for (let i = 0; i < n; i++) {
    parts.push(new THREE.RingGeometry(1, 1.14, 3, 1, i * step, 0.11));
  }
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
};

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
   * ★ 短促、要立刻被看见 —— 48 粒 × 40 格，一发 8 目标 AOE 占 16 格。
   *
   * ★★ 32 → 40 不是「顺手加大」，是**修一个当前就在漏的洞**：
   *   一发 8 目标 AOE = 8 主爆发 + 8 碎屑 = 16 格，活约 0.6 秒。
   *   0.6 秒内来两发（12v12 里毫不罕见）正好打满 32 格，第三发开始
   *   按「回收最旧」把**第一发还活着的粒子**掐掉 —— 玩家看到的是
   *   「命中爆发闪一下就没了」。这与拖尾把自己刷没了是同一种病，
   *   只是这次源头是事件池自己。三期又给重击加了环/爆点/云三层，
   *   不扩容会漏得更快。
   * ★ 代价可忽略：每格约 2.9KB，8 格 ≈ 23KB，且构造时一次性分配
   *   （稳态零 GC 的前提不变）；空闲格 `visible=false`，不进渲染。
   */
  private readonly pool = new BurstPool(40);
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
   * ★ 16 → 24：三期给重击加了 `ring` + `scorch` 两层、暴击加了 `star` 一层，
   *   一记物理暴击重击现在最多占 5 格（刀光 + 环 + 爆点 + 白核 + 星芒）。
   *   16 格在两个人同时重击时就会开始挤掉别人的刀光。
   * ⚠️ 注意：此处旧注释写着「verify:m12 读 activeFlashes 观察是否长期打满」，
   *   但 verify-m12 里 grep 不到 activeFlashes —— **那个检查从来不存在**。
   *   已如实改掉这句，不留一条骗人的注释（真要补见 PROGRESS 已知不足）。
   */
  private readonly flashes = new FlashPool(24);

  /**
   * 刀光轮换游标。★ 轮流而不是随机：随机会连续抽到同一张，
   * 而要解决的恰恰是「连着两下长得一样」。见 `SLASH_ACCENTS`。
   */
  /** 地面风暴盘的自转钟，秒。见 `syncAreaTint` */
  private stormClock = 0;

  private slashCursor = 0;
  private nextSlash(): AccentTexture {
    const a = SLASH_ACCENTS[this.slashCursor % SLASH_ACCENTS.length]!;
    this.slashCursor += 1;
    return a;
  }

  /** 已解码的贴图（异步填充；未就绪时取到 null 走程序化兜底）*/
  private readonly particleTex = new Map<AttributeVisual['particle'], THREE.Texture | null>();
  private readonly accentTex = new Map<AccentTexture, THREE.Texture | null>();
  private texturesLoaded = 0;

  /** sim 真实投射物的主体。key = projectile.id */
  private readonly projBodies = new Map<number, ProjBody>();
  /** 表现用弹体（sim 里不存在，见文件头）*/
  private readonly bolts: VisualBolt[] = [];
  /**
   * 已经认定「由装饰弹道承担」的锁定投射物 id（见 `syncProjectiles`）。
   * ★ 认领粘住不放，直到该弹体从快照里消失 —— 装饰弹道抵达回收之后
   *   不能翻脸补画一颗球，那是双份命中反馈。
   */
  private readonly boltCovered = new Set<number>();
  /**
   * 兜底画出来的锁定投射物 id：它们**消失时不补命中爆发**（见 `syncProjectiles`）。
   * 命中反馈由 damage / auraApplied 事件在目标身上给，这里只负责飞行段。
   */
  private readonly burstlessBodies = new Set<number>();
  /** 延迟落点 / 地面区域的持续边界环。key = 'p'+id / 'g'+id */
  private readonly rings = new Map<string, RingEntry>();
  /** 正在施法的单位的蓄力表现。key = 实体 id */
  private readonly windups = new Map<number, WindupEntry>();
  /** 瞬发范围技能的地面冲击波（瞬时，自然消亡）*/
  private readonly waves: GroundWave[] = [];
  /** 波之后的地面染色（装饰层）*/
  private readonly decals: GroundDecal[] = [];
  /** 正在错峰放出的落地冲击（陨星），见 `PendingImpact` */
  private readonly pendingImpacts: PendingImpact[] = [];
  /** 最近一帧真的在冒聚能粒子的施法者数（自检用）*/
  private windupEmitterCount = 0;
  /** 最近一帧真的在冒拖尾粒子的弹体数（自检用）*/
  private trailEmitterCount = 0;

  /** 上一帧场上还在的投射物 id，用于检出「消失 → 补一发命中爆发」*/
  private seenProjectiles = new Set<number>();

  /**
   * 技能 id → 已做过色相偏移的属性视觉（P3 签名的颜色身份）。
   *
   * ★ 缓存不是性能优化而是**结构保证**：同一个技能在一局里永远是同一个颜色。
   *   签名是身份，不是随机装饰（`skillSignature.ts` 用确定性散列而非
   *   `Math.random` 是同一条理由）。117 个技能封顶，内存可忽略。
   */
  private readonly tintedVisuals = new Map<string, AttributeVisual>();

  /**
   * 本帧二级形态已经吃掉的事件池格数。★ 在 `frame()` 里清零 ——
   * 见 `MAX_FORM_SLOTS_PER_FRAME` 的 ★★（8 目标群体技能同帧 8 次触发）。
   */
  private formSlotsThisFrame = 0;

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

  // ── P3 技能签名的消费 ─────────────────────────────────────────

  /**
   * 这个技能的属性视觉，**已叠加签名色相偏移**。
   *
   * ★★ 唯一入口：本类里所有**手里有 SkillDef** 的地方都走它，
   *   `visualOf(skill)` 不再被直接调用。理由是一致性 ——
   *   蓄力法阵、释放爆发、飞行体、命中爆发是同一个技能的四个瞬间，
   *   其中一处没偏移就成了「读条是这个色、放出来是另一个色」，
   *   玩家会读成 bug 而不是签名。
   *
   * ⚠️ 与之相对，**按学派兜底的那条路（`visualForSchool`）保持原样** ——
   *   见 `onCombatEvent` 的 damage 分支注释：那里根本没有 skillId。
   */
  private visualFor(skill: SkillDef): AttributeVisual {
    const key = skill.id as string;
    let av = this.tintedVisuals.get(key);
    if (!av) {
      av = tintedVisual(visualOf(skill), signatureOf(skill).tintShift);
      this.tintedVisuals.set(key, av);
    }
    return av;
  }

  /**
   * 叠一段二级形态（`SignatureForm` 的七种之一）在既有爆发之上。
   *
   * @param anchor  爆发中心（手部 / 命中点）
   * @param groundY 该处的地面高度 —— `ground` 类形态锚在它上面
   *
   * ★ 三道闸门，缺一不可：
   *   1. `form === none` 或低密度档 → `formPlanFor` 返回空表（17.2）
   *   2. 本帧形态格数超预算 → 直接不发（X9 前科，见 MAX_FORM_SLOTS_PER_FRAME）
   *   3. 单步 count 已由 `scaledCount` 截断在事件池单格容量内
   */
  private emitForm(anchor: Vec3Like, groundY: number, av: AttributeVisual, sig: ResolvedSignature): void {
    const steps = formPlanFor(sig.form, sig.scale, decorativeDensity(this.quality));
    for (const s of steps) {
      if (this.formSlotsThisFrame >= MAX_FORM_SLOTS_PER_FRAME) return;
      this.formSlotsThisFrame += 1;
      this.emitBurst(
        { x: anchor.x, y: (s.ground ? groundY : anchor.y) + s.dy, z: anchor.z },
        av,
        {
          count: s.count, speed: s.speed, size: s.size, life: s.life,
          gravity: s.gravity, drag: s.drag, spread: s.spread,
          originRadius: s.originRadius, swirl: s.swirl,
        },
      );
    }
  }

  // ── 表现钩子 ──────────────────────────────────────────────────

  /**
   * 施法生命周期。
   *   `started`  读条期间的手部蓄力
   *   `resolved` 出手 pop + **表现用弹体**射向每个目标
   * ★ 属性走 `visualFor(skill)`（毒感知：毒刃是 physical 学派但显示黄绿；
   *   P3 起还叠了该技能的签名色相偏移）。
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
    // P3：属性基座 + 技能签名（色相偏移已在 visualFor 里叠好）
    const av = this.visualFor(skill);
    const sig = signatureOf(skill);
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

    /**
     * Q 版基调：释放要「砰」地一下 —— 大、密、亮。
     *
     * ★★ 分量在这里第一次起作用（`vfxScaleOf` 0.85~1.5）：
     *   陨星（0.88 分量）与秘法箭（0.09）不该炸出一样大的场面。
     *   **全都夸张 = 全都不夸张** —— 对比才是夸张的前提，
     *   所以小技能是被**收着**的（下限 0.85），不是被削弱。
     */
    const ws = vfxScaleOf(skill);
    /**
     * ★★ 分量（`ws`）与签名规模（`sig.scale`）是**两个不同的量，故意相乘**：
     *   `ws` 说的是「这个技能在数据上有多大」（冷却/耗蓝/伤害推导出来的），
     *   `sig.scale` 说的是「这个技能的表现该有多张扬」（手写的表达意图）。
     *   合成之后仍由 `scaledCount` 截在事件池单格容量内 —— 两个乘数叠起来
     *   最坏是 1.5 × 1.8 = 2.7 倍，正是 X9 那种「每个数字都合理、乘起来顶穿」
     *   的形状，所以截断放在这里而不是指望上游自觉。
     * ★ `speed` 不乘 scale：速度变了粒子会飞出爆发该有的体积，
     *   读作「另一种技能」而不是「同一种技能更大一号」。
     */
    this.emitBurst(hand, av, {
      count: scaledCount(16 * ws, sig.scale), speed: 3.0 * ws,
      size: 0.72 * ws * sig.scale, life: 0.55,
    });
    this.emitAccent(hand, 'glow', av.secondary, 1.4 * ws * sig.scale);
    /**
     * 大招额外一记**定向爆闪** + 广告牌环。
     * ★ 门槛 1.25 ≈ 分量 0.62，实测落在「60 秒以上冷却」那一档
     *   （陨星/凛冬领域/神圣壁障…），正是玩家心里的大招名单。
     * ★★ 环用 `FlashPool` 的**面向镜头广告牌**，不是 `spawnWave` 的贴地环 ——
     *   贴地环的终点半径恒等于 `shape.radius`（14.3「边界即判定」），
     *   给一个没有 AOE 的大招画贴地环，玩家会读成「这里刚发生了范围结算」，
     *   那是**编造判定信息**，比不画更糟。广告牌环不可能被误读成地面边界。
     */
    if (ws >= 1.25) {
      this.emitAccent(hand, 'muzzle', av.primary, 1.5 * ws);
      this.flashes.emit({
        origin: hand, texture: this.accentTex.get('ring') ?? null,
        color: av.secondary, size: 1.1 * ws, life: 0.34, grow: 4.4,
      });
    }

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

    /**
     * P3 二级形态：**释放点发一次，不按目标发**。
     * ★ 形态是「这个技能是什么」的签名，一次释放就是一次签名 ——
     *   按目标发的话，8 目标群体技能会把同一个符号画 8 遍，
     *   既顶穿事件池（X9），读起来也不是「一个大招」而是「八个小技能」。
     * ★ 锚在**施法者脚下**（`caster.position`）而不是手上：七种形态里
     *   五种（环/螺旋/落雨/光柱/轨道）的语义都是从地面或绕身体读的。
     */
    this.emitForm(caster.position, caster.position.y, av, sig);

    if (this.flies(skill)) {
      for (const t of targets) {
        const to: Vec3Like = {
          x: t.position.x,
          y: t.position.y + t.height * 0.5,
          z: t.position.z,
        };
        const d = Math.hypot(to.x - hand.x, to.y - hand.y, to.z - hand.z);
        if (d < 1.5) continue; // 自身/贴脸：没有可看的飞行段
        /**
         * ★★ 寿命用**施法者到目标的水平距离**算，不是手到躯干的那条斜线 ——
         *   sim 的 `spawnHoming` 用的正是 `distance2D(source.position,
         *   target.position)`，两边必须是同一条公式（见 VisualBolt.life）。
         * ★★ W25：速度也按**这个技能自己那一档**取（`boltSpeedOf`）——
         *   箭 75、法术与投掷物 55。同屏两种时序自此是**设计**而不是 bug：
         *   猎人的箭确实比法师的火球早到，sim 与视觉一起早到。
         */
        const flat = Math.hypot(
          t.position.x - caster.position.x, t.position.z - caster.position.z,
        );
        const life = Math.max(0.05, flat / boltSpeedOf(skill));
        this.spawnBolt(hand, to, av, sig, t.position.y, skill.id as string, life, t.track);
      }
      return;
    }

    /**
     * ★ 无弹体且无伤害的技能（霜爆新星的定身、群体控制…）：
     *   在每个目标身上直接放到位爆发。它们不产生 damage 事件，
     *   CC 光环的 id 又是 `control.*`（查不回技能拿颜色），
     *   不在这里补的话「被定住的人」身上什么都不会亮。
     */
    if (dealsDamage(skill.effects)) return;
    for (const t of targets) {
      const at: Vec3Like = {
        x: t.position.x,
        y: t.position.y + t.height * 0.5,
        z: t.position.z,
      };
      if (Math.hypot(at.x - hand.x, at.z - hand.z) < 0.6) continue; // 自己那份 pop 已经有了
      // ★ 到位爆发吃 scale（数量/尺寸），但**不**再发一遍形态 —— 见上面那条 ★
      this.emitBurst(at, av, {
        count: scaledCount(12, sig.scale), speed: 2.2, size: 0.6 * sig.scale, life: 0.55,
      });
    }
  }

  /**
   * 这个技能该不该有一发**表现用**弹体。
   *
   * 判据全部来自已有数据，不新增配置：
   *   · 单体形状 + 直接/投射物瞄准 —— 排除地面技能与自身中心 AOE
   *   · 射程 ≥ 8 米 —— 排除近战（6.1 近战档最长 3.8 米）
   *   · 没有 `spawnProjectile` —— **碰撞型**由 sim 真的产生弹体，走
   *     `syncProjectiles`（那条路要画真实轨迹，因为它能被墙挡、能躲开），
   *     在这里再来一发就成了双份
   *
   * ★ W23：带 `lockedProjectile` 的技能**照旧走这条路**（不排除）——
   *   锁定投射物的快照渲染在 `syncProjectiles` 里让位给它，双份的那一半
   *   在那边收口。判据本身一个字没改：这批技能本来就全部满足上面三条
   *   （迁移口径与 `flies()` 同源：Direct + 单体 + ≥8 米）。
   * ⚠️ 但这条同源关系**是数据巧合、不是不变式**：真有人把一条 6 米的
   *   或 cone 形状的技能迁进 `lockedProjectile`，`flies()` 就不认它。
   *   兜底在 `syncProjectiles`（没有装饰弹道就退回快照渲染），所以它
   *   最坏只是掉成一颗通用色球，不会整个隐形。用例见
   *   `lockedProjectileVfx.test.ts`。
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
   *
   * ⚠️ **P3 技能签名在这条路上不生效，这是如实的取舍不是遗漏。**
   *   `SpellVfxEvent.damage` 里根本没有 skillId —— 多目标瞬发伤害在 sim 里是
   *   「一次结算多个目标」，事件里没有技能引用可查（联网侧 redact 之后
   *   连 sourceId 都没有）。没有 id 就没有签名，色相偏移/规模/形态三样全不生效，
   *   命中爆发退回**纯学派色**。
   *   ★ 签名真正落在有 id 的三条路上：释放爆发（`onCast`）、
   *     弹道抵达（`updateBolts`）、真投射物消失（`syncProjectiles`）——
   *     而「飞过去再炸」的技能正好走后两条，玩家最容易注意签名的也是它们。
   *   ★ 想让这条路也有签名，得先给 `damage` 事件加 skillId ——
   *     那是协议改动，不是表现层能自己决定的，也不在本批范围内。
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
        /**
         * 重击冲击波。★ 贴图从 `glow` 换成 `ring`（真空心环）——
         *   地面波那一轮的提交信息自己吐槽过：叫「冲击波」的东西其实是
         *   **面向镜头的广告牌光斑**，从上往下看只是一团光，读不出「炸开一圈」。
         *   现在它真的是一个环，且 grow 随打击分档放大。
         */
        if (plan.shockwave) {
          this.flashes.emit({
            origin: at, texture: this.accentTex.get('ring') ?? null,
            color: av.secondary, size: 1.0 * plan.scale, life: 0.3,
            grow: 2.6 + 1.7 * plan.scale,
          });
          // 灼痕核心：环之外再压一层放射爆点，给「这一下很沉」一个实心中心
          this.flashes.emit({
            origin: at, texture: this.accentTex.get('scorch') ?? null,
            color: av.primary, size: 1.5 * plan.scale, life: 0.22, grow: 1.9,
          });
        }
        // 碎屑层（impactDebris 装饰角色 —— M8 定义至今第一次被消费）
        if (plan.debris) {
          this.emitAccent(at, 'debris', av.secondary, 0.6 * plan.scale);
          // 体积感：Q 版重击该有一团「炸开的云」，不只是四散的点
          this.emitAccent(at, av.particle === 'smoke' ? 'cloud' : 'puff',
            av.secondary, 0.9 * plan.scale);
        }
        // 暴击白核：白不属于任何学派，八学派下都读作「暴击」
        if (plan.whiteCore) {
          this.flashes.emit({
            origin: at, texture: this.accentTex.get('flash') ?? null,
            color: 0xffffff, size: 2.4 * plan.scale, life: 0.18,
          });
          /**
           * ★ 星芒是**形状通道**上的第二条暴击信号。
           *   颜色通道已经被「白只留给暴击」占死，但色盲玩家与低饱和屏幕上
           *   颜色最不可靠（17.2）—— 加一个只在暴击出现的形状，
           *   与浮字的 `!` 后缀是同一条思路。
           */
          this.flashes.emit({
            origin: at, texture: this.accentTex.get('star') ?? null,
            color: 0xffffff, size: 2.0 * plan.scale, life: 0.26, grow: 2.2,
            rotation: Math.random() * Math.PI,
          });
        }
        // 第二通道点缀（14.2）：物理 = 刀光 + 迸溅火星；火/奥/圣见 HIT_ACCENT
        if (ev.school === School.Physical) {
          this.flashes.emit({
            origin: at, texture: this.accentTex.get(this.nextSlash()) ?? null,
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
        if (!skill || dealsDamage(skill.effects)) return;
        // ★ 这条路**查回了技能**，所以签名生效（与 damage 分支的区别就在这一行）
        const av = this.visualFor(skill);
        const sig = signatureOf(skill);
        this.emitBurst(at, av, {
          count: scaledCount(14, sig.scale), speed: 2.4, size: 0.65 * sig.scale, life: 0.6,
        });
        this.emitAccent(at, 'sparkle', av.secondary, 0.9 * sig.scale);
        /**
         * ★ 光环类技能是 `orbit` / `spiral` 形态的主要归宿（护盾、嗜血…）。
         *   锚点用**脚下** —— `at` 是躯干高度，减 HITBOX_HEIGHT 的一半。
         *   ⚠️ 这里没有真实地面高度可用（`posOf` 只给一个点），
         *     `GEOMETRY.HITBOX_HEIGHT / 2` 是这个信息缺口下最诚实的近似：
         *     它就是站立角色躯干到脚的距离，斜坡上会差几厘米。
         */
        this.emitForm(at, at.y - GEOMETRY.HITBOX_HEIGHT / 2, av, sig);
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
        if (!at) return;
        /**
         * 破盾 = 一层壳碎掉。★ 三处改动兑现 14.3 的「破裂」：
         *   · 颜色跟**这面盾的学派**（此前一律圣金，冰盾碎了也是金的）
         *   · 碎片从**壳体半径**上炸开，而不是从躯干中心（那是「他挨打了」的位置）
         *   · 加一圈扩张 glow —— 让「壳没了」这件事在余光里也读得到
         */
        const av = (ev.auraId ? visualForAuraId(ev.auraId) : undefined) ?? ATTRIBUTE_VISUALS.holy;
        const shellR = GEOMETRY.HITBOX_RADIUS * 1.9;
        this.emitBurst(at, av, {
          count: 22, speed: 5.2, size: 0.5, life: 0.5, drag: 1.2, originRadius: shellR,
        });
        this.emitAccent(at, 'debris', av.secondary, 0.8);
        this.flashes.emit({
          origin: at, texture: this.accentTex.get('glow') ?? null,
          color: av.primary, size: 1.4, life: 0.3, grow: 2.6,
        });
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
    /**
     * ★ 签名形态的每帧预算在这里清零。
     *   放在 frame 开头而不是结尾：事件（onCast/onCombatEvent）是在两次 frame
     *   **之间**到达的，清在结尾会把「本帧刚发的形态」算进下一帧的额度里，
     *   预算就漏了一帧 —— 与 `trailTimer` 在遍历后清零是同一类顺序讲究。
     */
    this.formSlotsThisFrame = 0;
    this.pool.setScale(ctx.pointScale);
    this.streams.setScale(ctx.pointScale);
    this.syncCasts(ctx.casts ?? [], ctx.quality, dt, ctx.now, ctx.cameraPosition);
    this.syncProjectiles(ctx.projectiles, ctx.quality, dt, ctx.now);
    this.syncGround(ctx.grounds, ctx.quality, dt, ctx.cameraPosition);
    // ★ 抵达时刻走 ctx.now（真实/权威钟），不走可能被顿帧缩放的 dt
    this.updateBolts(dt, ctx.now, ctx.quality, ctx.cameraPosition);
    this.updateImpacts(dt);
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
  private spawnWave(
    center: Vec3Like,
    radius: number,
    av: AttributeVisual,
    /**
     * 染色盘的寿命/不透明度覆盖（陨星的灼烧残留要留 3 秒焦土，通用波是 1.2 秒）。
     * ★ **只覆盖这两项**：盘的半径恒等于 `radius`，也就是判定半径 ——
     *   给它一个别的尺寸就是编造判定信息（14.3）。
     */
    burn?: { life: number; opacity: number },
  ): void {
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
    const decalLife = burn?.life ?? plan.decalLife;
    const decalOpacity = burn?.opacity ?? plan.decalOpacity;
    if (this.decals.length >= MAX_DECALS) {
      const oldest = this.decals.shift();
      if (oldest) this.disposeGroundMesh(oldest.mesh, oldest.mat);
    }
    const decalMat = new THREE.MeshBasicMaterial({
      color: av.primary,
      transparent: true,
      opacity: decalOpacity,
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
      mesh: decal, mat: decalMat, age: 0, life: decalLife, opacity: decalOpacity,
    });
  }

  // ── 陨星：落地冲击的错峰编排 ──────────────────────────────────

  /**
   * 把一次落地冲击排进队列（真正的 emit 由 `updateImpacts` 按 `delay` 逐步放出）。
   *
   * ★★ 为什么中心补这一发**不**与「陨石落地由 damage 事件在每个人身上各放一发」
   *   冲突：那些是**打在人身上**的命中反馈，这一发是**砸在地上**的落点表现。
   *   没有人被命中时（全躲开了）落点照样该有一坑烟尘 —— 而按人发的那条路
   *   在那种情况下一粒都不会有，正是「陨星和霜矢区分不大」的一半成因。
   * ★ 公平性：全部发生在**结算之后**，且落点边界与倒计时早已全程可见（14.3），
   *   不提供任何新的预判信息。
   */
  private queueImpact(skillId: string, center: Vec3Like, radius: number, av: AttributeVisual): void {
    const plan = impactPlanFor(skillId, decorativeDensity(this.quality));
    if (!plan) return;
    // 贴地冲击波：终点半径 = 落点判定半径，与 14.3「边界即判定」同源
    this.spawnWave(center, radius, av, { life: plan.burnLife, opacity: plan.burnOpacity });
    this.flashes.emit({
      origin: { x: center.x, y: center.y + 0.4, z: center.z },
      texture: this.accentTex.get('ring') ?? null,
      color: av.secondary, size: plan.flashSize, life: 0.38, grow: plan.flashGrow,
    });
    /**
     * ★ 灼痕点缀与三步编排一起归**装饰层**：低画质档 `impactPlanFor` 把 steps 清空，
     *   这里就跟着一并跳过 —— 否则 low 档会剩下一个还在吃事件池的孤零零爆点。
     *   冲击波环与白闪留下（环画的是判定半径，白闪与既有大招闪同一档）。
     */
    if (plan.steps.length === 0) return;
    this.emitAccent({ x: center.x, y: center.y + 0.1, z: center.z }, 'scorch', av.primary, 2.6);
    if (this.pendingImpacts.length >= MAX_PENDING_IMPACTS) this.pendingImpacts.shift();
    this.pendingImpacts.push({
      center: { ...center }, groundY: center.y, av, steps: [...plan.steps], age: 0, next: 0,
    });
  }

  /** 队列推进：到点的步逐个 emit，全部放完就摘掉 */
  private updateImpacts(dt: number): void {
    for (let i = this.pendingImpacts.length - 1; i >= 0; i--) {
      const p = this.pendingImpacts[i]!;
      p.age += dt;
      while (p.next < p.steps.length && p.age >= p.steps[p.next]!.delay) {
        const s = p.steps[p.next]!;
        p.next += 1;
        this.emitBurst(
          { x: p.center.x, y: p.groundY + s.dy, z: p.center.z },
          p.av,
          {
            count: s.count, speed: s.speed, size: s.size, life: s.life,
            gravity: s.gravity, drag: s.drag, spread: s.spread, originRadius: s.originRadius,
            ...(s.accent !== undefined
              ? { texture: this.accentTex.get(s.accent) ?? this.texFor(p.av.particle) }
              : {}),
          },
        );
      }
      if (p.next >= p.steps.length) this.pendingImpacts.splice(i, 1);
    }
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
      const sig = skill ? signatureOf(skill) : resolveSignature(c.skillId);
      /**
       * ★ 蓄力也用签名色 —— 读条和放出来必须是同一个颜色，见 visualFor 的 ★★
       * ★★ 查不回技能的兜底路径**也要先叠 tintShift**：`castCircleStyleOf`
       *   的契约是「收已上色的视觉、内部补差额」，喂它一份没上色的基色，
       *   补出来的差额就变成了 `motifShift - tintShift`（最坏 0.16 色环）——
       *   一条谁都不会去看的兜底分支恰好打穿 14.2 的 ±0.08 预算。
       */
      const av = skill
        ? this.visualFor(skill)
        : tintedVisual(ATTRIBUTE_VISUALS.arcane, sig.tintShift);
      const plan = windupPlanFor({
        now,
        startedAt: c.startedAt,
        endsAt: c.endsAt,
        ...(c.channelEndsAt !== undefined ? { channelEndsAt: c.channelEndsAt } : {}),
        density,
      });

      /**
       * ★★ 换技能就重建法阵节点。
       *
       *   `WindupEntry` 按**施法者 id** 缓存，颜色/纹章/形态全在
       *   `ensureWindup` 建节点那一刻定死。此前靠「一次施法结束 →
       *   下一帧差分摘掉 → 再读条时重建」兜住换技能这件事，
       *   但那是**巧合**：只要哪天施法注册表在两次施法之间不留空帧
       *   （引导接读条、服务器合帧、或者未来的连续施法），
       *   火球的法阵就会顶着冰霜的雪花纹章继续转 ——
       *   而且不会有任何断言红，只有玩家看到「颜色好像都一样」。
       *   一行差分把这条隐患关掉，代价只有换技能那一帧的一次重建。
       */
      const stale = this.windups.get(c.id);
      if (stale && stale.skillId !== c.skillId) this.removeWindup(c.id);

      const entry = this.ensureWindup(c.id, av, sig, c.skillId);
      entry.lastProgress = plan.progress;

      /**
       * ★ 分量放大蓄力：大招的法阵更大、转得更快。
       *   这同时是 7.5 假读条博弈的**可读性收益** —— 对手一眼看出
       *   「他在读的是个大的」，才谈得上要不要把打断交出去。
       */
      const ws = skill ? vfxScaleOf(skill) : 1;

      // 法阵贴在脚下，跟着人走（施法期间也可能被击退/位移）
      // ★ spinScale 按属性：冰霜慢而稳、火焰急、物理几乎不转（castVfx.ts 风格表）
      entry.spin += plan.circleSpin * entry.style.spinScale * dt * (0.8 + 0.4 * ws);
      entry.group.position.set(c.position.x, c.position.y + 0.06, c.position.z);
      /**
       * ★ 尺寸吃**两个**乘数：`ws` 是数据推导的分量（冷却/耗蓝/范围），
       *   `entry.circleScale` 是签名手写的表达意图，与释放爆发那里
       *   `ws × sig.scale` 同一个道理。区别是法阵贴地、占的是地面，
       *   所以签名那一半在 `castTint.ts` 里先衰减到 0.9–1.2 才进来。
       */
      entry.group.scale.setScalar(2.2 * plan.circleScale * ws * entry.circleScale);
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
      /**
       * ★ 生成点与运动趋势按属性分化（castVfx.ts 的 WINDUP_STYLES）：
       *   'hand-ring' —— 环绕手部收拢（奥术/冰霜/自然/物理，半径各异）
       *   'ground'    —— 从脚下法阵升腾（火苗/暗影烟/毒泡，lift 为正往上冒）
       *   'above'     —— 从头顶落下（神圣独占：方向即语义，lift 为负）
       *   运动参数只动 gravity/drag/半径，**不碰 cadence/life/count** ——
       *   那三个是细流池预算的输入（3 格数学），分属性改会按属性偶发地挤爆池子。
       */
      const style = entry.style;
      const ang = Math.random() * Math.PI * 2;
      const r = plan.gatherRadius * style.radiusScale;
      const spawn: Vec3Like = style.origin === 'ground'
        ? {
            x: c.position.x + Math.cos(ang) * (0.9 * ws),
            y: c.position.y + 0.15,
            z: c.position.z + Math.sin(ang) * (0.9 * ws),
          }
        : style.origin === 'above'
          ? {
              x: c.position.x + Math.cos(ang) * r,
              y: c.position.y + c.height + 0.8,
              z: c.position.z + Math.sin(ang) * r,
            }
          : { x: hand.x + Math.cos(ang) * r, y: hand.y + (Math.random() - 0.5) * 0.5, z: hand.z + Math.sin(ang) * r };
      this.emitBurst(
        spawn,
        // ★ 用法阵的签名色而不是 `av`：外圈/纹章/聚能粒子三层同色，
        //   玩家读到的才是「这个技能的光环」而不是「学派的光环 + 别的粒子」
        entry.visual,
        {
          /**
           * ★★ 分量只乘在**低画质早退之后**（上方 `plan.count <= 0` 那条 continue）。
           *   顺序反过来的话，`0 * ws` 仍是 0 但 `cadence` 判断会先跑，
           *   更要命的是任何「至少发一粒」的兜底都会让低画质冒出粒子，
           *   直接打破 14.4 与 `verify:m12 #48d` 的 `streamBursts === 0`。
           */
          count: Math.round(plan.count * ws),
          speed: 0.35,
          size: plan.size * ws,
          life: plan.life,
          gravity: style.lift,
          drag: style.drag,
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
  private ensureWindup(
    id: number,
    av: AttributeVisual,
    sig: Pick<ResolvedSignature, 'tintShift' | 'scale'>,
    skillId?: string,
  ): WindupEntry {
    let entry = this.windups.get(id);
    if (entry) return entry;

    const group = new THREE.Group();
    group.rotation.x = -Math.PI / 2;

    /**
     * ★★ 技能级的法阵签名（`castTint.ts`）。
     *   `av` 进来时已经带了 `sig.tintShift`，这里把它放大到色系预算上限
     *   并让**外圈与纹章反向**偏移 —— 同学派的两个技能于是有
     *   「暖芯冷边」/「冷芯暖边」两张脸，而每一层仍钳在 ±TINT_CLAMP 内。
     *   14.2「看颜色识属性」一位不破：火技能永远是暖色，只是暖得各不相同。
     */
    const circle = castCircleStyleOf(av, sig, skillId);
    const tinted: AttributeVisual = {
      ...av, primary: circle.ringColor, secondary: circle.motifColor,
    };

    // ★ 几何体逐实例新建 —— removeWindup 会释放它（共享的话第一个人施法结束
    //   就会把全场法阵打成空白，与 disposeNode 的 ★★ 是同一个坑）
    const ringMat = new THREE.MeshBasicMaterial({
      color: circle.ringColor,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(makeCircleGeometry(circle.teeth), ringMat);
    ring.renderOrder = 3;
    group.add(ring);

    /**
     * ★ 中央纹章按属性分化（用户实测反馈：施法过程八属性长得一模一样）。
     *   'own' 直接复用该属性的主粒子贴图 —— 冰霜法阵中央是一朵大雪花、
     *   火焰是火球、神圣是光斑、自然是旋叶，**零新增资产**；
     *   奥术保留传统符文（它的 14.2 措辞就是「几何图形与符文」）；
     *   物理无纹章 —— 拉弓抡刀的人脚下不该有奥术法阵，
     *   「有人在蓄力」的告示由保留的外圈承担（14.4 关键元素，见 castVfx.ts）。
     */
    const style = windupStyleOf(av.particle, skillId);
    let runes: THREE.Mesh | undefined;
    let runeMat: THREE.MeshBasicMaterial | undefined;
    const tex = style.motif === 'none'
      ? null
      : this.particleTex.get(style.motif === 'rune' ? 'rune' : av.particle);
    if (tex) {
      runeMat = new THREE.MeshBasicMaterial({
        map: tex,
        color: circle.motifColor,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      // ★ 纹章额外吃签名规模（衰减 0.5）：「大招的印记更大」这句话
      //   主要由中央这个符号说 —— 它长在法阵里面，放大不占地面
      const side = 1.55 * style.motifScale * circle.motifScale;
      runes = new THREE.Mesh(new THREE.PlaneGeometry(side, side), runeMat);
      runes.renderOrder = 3;
      group.add(runes);
    }

    this.group.add(group);
    entry = {
      group, ring, ringMat,
      ...(runes ? { runes } : {}),
      ...(runeMat ? { runeMat } : {}),
      ...(skillId !== undefined ? { skillId } : {}),
      visual: tinted, style, circleScale: circle.circleScale,
      timer: 0, spin: 0, lastProgress: 0, lastPos: { x: 0, y: 0, z: 0 },
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
   * 表现用弹体的推进：**追踪**目标当前位置（每帧刷新终点），到点即爆并回收。
   *
   * ★★ **抵达时刻唯一由 `life` 决定，而且走绝对时钟 `now`**
   *   （= 释放瞬间水平距离 / 速度，与 sim 的 `impactAt` 同公式）：
   *     · 不看「几何上追上了没有」—— 否则目标迎面冲过来就提前爆（早到）
   *     · 不累计渲染 dt —— 否则一次顿帧就整体迟到（晚到）
   *   见 `VisualBolt.bornAt` / `life`：这一刻必须与伤害落账是同一个数。
   * ★ 飞行段按**剩余时间**配速（`k = dt / remaining`）而不是按固定速度硬推：
   *   目标怎么动都在 `life` 那一刻恰好落到它身上，不会到点还差半米。
   *   渲染 dt 被顿帧缩放时，弹体只是那几帧走得慢，随后自动补回来。
   */
  private updateBolts(
    dt: number, now: number, quality: QualityTier, cameraPosition?: Vec3Like,
  ): void {
    const showTrail = isVisible('projectileTrail', quality);
    const density = decorativeDensity(quality);
    // 只有离相机最近的几发冒拖尾粒子；彗尾条（零池占用）每发都有
    const emitters = this.nearestIds(this.bolts.map((b, i) => ({ id: i, position: b.group.position })), cameraPosition, MAX_TRAIL_EMITTERS);
    let emitting = 0;

    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i]!;
      // 起飞时刻在第一帧落定（onCast 在两次 frame 之间到达，那时没有时钟）
      b.bornAt ??= now;
      // 终点每帧刷新；目标不可见（潜行/离场）时保持最后已知位置
      const tracked = b.track?.();
      if (tracked) b.to = tracked;

      const g = b.group.position;
      const dx = b.to.x - g.x;
      const dy = b.to.y - g.y;
      const dz = b.to.z - g.z;
      /** 距抵达还剩多少秒（真实钟）—— 抵达判据就是它 ≤ 0 */
      const remaining = b.bornAt + b.life - now;

      if (remaining > 0) {
        // 按剩余时间配速：这一帧走「剩余路程 × 本帧占剩余时间的比例」
        const k = Math.min(1, Math.max(0, dt) / remaining);
        g.set(g.x + dx * k, g.y + dy * k, g.z + dz * k);
        // ★ 目标瞬移到弹体身上时朝向没有意义 —— 保持上一帧，别把它甩成陀螺
        //   （与真投射物那条路的 `> 1e-4` 门槛同一个理由）
        if (Math.hypot(dx, dy, dz) > 1e-4) {
          this.orientBolt(b.group, { x: dx, y: dy, z: dz }, b.visual, dt, showTrail, b.form);
        }

        const plan = trailPlanFor(b.visual.particle, density);
        if (!showTrail || plan.count <= 0 || !emitters.has(i)) continue;
        emitting += 1;
        b.trailTimer += dt;
        if (b.trailTimer < plan.cadence) continue;
        b.trailTimer = 0;
        /**
         * ★★ P3：签名规模影响**尾迹密度**，而且只能影响 `count`。
         *   `cadence` 与 `life` 是细流池预算不等式 `ceil(life/cadence) ≤ 6` 的两端，
         *   已经顶死（0.42/0.07 = 6，见 boltVfx.ts 的注释与 vfxPlans.test.ts:246）——
         *   乘上 scale 会让 1.8 倍的大招弹体一发吃掉 11 格，把另外两发的尾巴挤没。
         *   `count` 则只受细流池**单格容量 32** 约束（11 × 1.8 = 20，仍有余量），
         *   所以它是加密度唯一不撞预算的旋钮，截断按 `STREAM_PARTICLE_CAP`。
         */
        this.emitBurst(g, b.visual, {
          count: scaledCount(plan.count, b.sig.scale, STREAM_PARTICLE_CAP),
          speed: 0.7, size: plan.size, life: plan.life,
          gravity: plan.gravity, drag: plan.drag, opacity: plan.opacity,
          stream: true,
        });
        continue;
      }

      // 抵达（或超龄强制抵达）：命中爆发在目标**当前**位置炸开 ——
      // 命中资格早在释放瞬间定死（6.6），这里只是把它演在人身上而不是空地上
      this.emitBurst(b.to, b.visual, {
        count: scaledCount(18, b.sig.scale), speed: 4.4, size: 0.75 * b.sig.scale, life: 0.55,
      });
      this.emitAccent(b.to, 'debris', b.visual.secondary, 0.95 * b.sig.scale);
      // ★ 命中侧的二级形态：地面锚点用释放时存下的目标脚下高度（见 VisualBolt.groundY）
      this.emitForm(b.to, b.groundY, b.visual, b.sig);
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
    sig: ResolvedSignature,
    groundY: number,
    /** 形态查表用（霜矢是冰矛）。未登记的技能走通用档 */
    skillId: string,
    /** 强制抵达时刻，秒。与 sim 的 impactAt 同公式（见 VisualBolt.life）*/
    life: number,
    track?: () => Vec3Like | undefined,
  ): void {
    // 同时在飞的弹体设个上限：12v12 混战里这是唯一会无界增长的东西
    if (this.bolts.length >= 24) {
      const oldest = this.bolts.shift();
      if (oldest) this.disposeNode(oldest.group);
    }
    const form = boltFormFor(skillId);
    const group = this.makeBoltNode(av, form);
    group.position.set(from.x, from.y, from.z);
    this.group.add(group);
    this.bolts.push({
      group, visual: av, sig, form, to: { ...to }, groundY, track,
      skillId, life, trailTimer: 0,
    });
  }

  // ── 每帧：真实投射物（本地 sim 或服务器快照，都收 ProjectileView）──

  /**
   * 把投射物视图画成看得见的飞行体。
   *   colliding     → 属性色球（essential）+ 拖尾（decorative）
   *   delayedImpact → 持续落点边界环（essential，14.3 要求全程可见）
   *   homing        → **有装饰弹道在飞就不画，没有才兜底**，见下方 ★★
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
    /** 本帧出现过的锁定投射物 id —— 用来回收 `boltCovered` 的认领记录 */
    const homingSeen = new Set<number>();

    for (const p of items) {
      /**
       * ★★ **锁定投射物（homing）：有装饰弹道在飞就跳过，没有就自己画。**
       *
       *   W23 之后 sim 真的会生成 homing 弹体（21 个迁移技能），而客户端
       *   本来就在 `onCastResolved` 里给同一批技能画了一发追踪弹道
       *   （`flies()` → `spawnBolt`）。两条路都画 = **一发法术两颗球**。
       *
       *   两者都在时留装饰路径，理由是它带着表现层的全部身份信息：
       *   技能级弹体**形态**（霜矢是冰矛，Wave1 刚做）、P3 技能签名
       *   （尾迹密度 / 抵达爆发规模 / 二级形态）、以及目标追踪。
       *   快照路径只有 `skillId + position`，画出来是一颗通用色球。
       *   而 W23 已经把两者的**抵达时刻**对齐（`VisualBolt.life` 与
       *   `HomingProjectile.impactAt` 同公式），所以装饰路径不再有
       *   「视觉与结算错拍」这个原本唯一的短板。
       *
       * ★★ 但**无条件**跳过是错的（初版就是无条件）：装饰弹道要有一条
       *   带 `casterId` 的 CastResolved 才画得出来，而
       *     · 施法者对本机不可见时服务器会把 casterId 抹掉（MatchLoop redact）
       *     · 重连 / 中途加入 / 观战的客户端压根收不到那条消息，
       *       它们拿到的只有飞行中的快照
       *     · CastResolved 丢包
       *   这些情形下场上一个像素都没有、0.5 秒后伤害凭空落账 ——
       *   而 `ProjectileSnapshot` 存在的**全部理由**就是 14.4 的
       *   「不能隐藏投射物主体」（见 net/visibility.ts 那段注释）。
       *   所以这里退回快照渲染：一颗通用色球，总比什么都没有强。
       *
       * ★ 认领是**按 id 粘住**的：某发一旦被判给装饰弹道，后续帧不再翻脸
       *   补画 —— 否则装饰弹道抵达回收（它的寿命可能比快照短一两帧）之后
       *   会突然冒出一颗球，末位置还要补一发爆发，那就是双份命中反馈。
       */
      if (p.kind === 'homing') {
        homingSeen.add(p.id);
        if (this.bolts.some((b) => b.skillId === p.skillId)) this.boltCovered.add(p.id);
        if (this.boltCovered.has(p.id)) {
          // 认领之前可能已经兜底画过一两帧（快照先到、CastResolved 后到）：
          // 静默拆掉，别走「消失 → 补爆发」那条路
          this.burstlessBodies.delete(p.id);
          if (this.projBodies.has(p.id)) this.removeProjBody(p.id);
          continue;
        }
        /**
         * ★★ 兜底渲染**只负责飞行段，不负责命中表现**：消失时不补爆发。
         *   ① 抵达那一刻的反馈已经由 `damage` / `auraApplied` 事件在目标身上
         *      给了（这两条事件与 casterId 无关，重连的客户端照样收得到），
         *      这里再补一发就是双份；
         *   ② 贴脸施放（<1.5 米，装饰弹道故意不画「没有可看的飞行段」）时
         *      sim 仍有一发 0.05 秒的弹体，兜底会画出来 —— 那一发要是也补爆发，
         *      每个贴脸法术都会多一朵花。
         */
        this.burstlessBodies.add(p.id);
      }
      if (p.kind === 'delayedImpact') {
        const key = `p${p.id}`;
        delayedPresent.add(key);
        const skill = getSkill(asSkillId(p.skillId));
        const av = skill ? this.visualFor(skill) : ATTRIBUTE_VISUALS.fire;
        const radius = p.radius ?? 1;
        const entry = this.ensureRing(key, p.position, radius, av.primary);
        // 落地要放的冲击，趁 skillId/radius 还在的时候记在环上（见 RingEntry.impact）
        entry.impact = { skillId: p.skillId, radius };
        // 14.3：落点边界 + **倒计时**。剩余秒数向上取整（「还有 2 秒」比 1.7 可读）
        if (p.impactAt !== undefined) {
          this.updateCountdown(entry, Math.max(0, Math.ceil(p.impactAt - now)));
        }
        this.syncFallingBody(entry, p, av, now, dt, showTrail);
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
        this.orientBolt(body.group, dir, body.visual, dt, showTrail, body.form);
      }
      body.lastPos.x = g.x;
      body.lastPos.y = g.y;
      body.lastPos.z = g.z;

      const plan = trailPlanFor(body.visual.particle, density);
      if (showTrail && plan.count > 0 && this.trailTimer >= plan.cadence) {
        // 真投射物（弩箭）的拖尾用轨迹条贴图 trace_05，与法术弹体的属性粒子区分
        // ★ 与表现弹体同一条规矩：签名 scale 只乘 count，不碰 cadence/life
        this.emitBurst(body.lastPos, body.visual, {
          count: scaledCount(plan.count, body.sig.scale, STREAM_PARTICLE_CAP),
          speed: 0.6, size: plan.size, life: plan.life,
          gravity: plan.gravity, drag: plan.drag, opacity: plan.opacity,
          texture: this.accentTex.get('trail') ?? this.texFor(body.visual.particle),
          stream: true,
        });
      }
    }
    // ★ 节拍计时器在**遍历之后**清零：多发弩箭同帧共用一个节拍，
    //   不会因为「第一发清了零」让后面几发这一帧发不出来
    if (this.trailTimer >= trailPlanFor('spark', density).cadence) this.trailTimer = 0;

    // 认领记录随弹体消失一起回收 —— 12v12 打满一局也不会无界增长
    for (const id of this.boltCovered) {
      if (!homingSeen.has(id)) this.boltCovered.delete(id);
    }

    // 消失的飞行体 → 命中爆发 + 回收
    for (const id of this.seenProjectiles) {
      if (present.has(id)) continue;
      const body = this.projBodies.get(id);
      if (!body) continue;
      // 兜底画的锁定投射物只管飞行段，命中反馈归事件（见上面那条 ★★）
      if (this.burstlessBodies.has(id)) {
        this.burstlessBodies.delete(id);
        this.removeProjBody(id);
        continue;
      }
      this.emitBurst(body.lastPos, body.visual, {
        count: scaledCount(14, body.sig.scale), speed: 3.8,
        size: 0.55 * body.sig.scale, life: 0.5,
      });
      this.emitAccent(body.lastPos, 'debris', body.visual.secondary, 0.7 * body.sig.scale);
      /**
       * ⚠️ 地面锚点在这条路上只能近似：`ProjectileView` 不带地面高度
       *   （它是投射物的**当前位置**，弩箭可能停在半空）。取躯干到脚的
       *   固定距离 `HITBOX_HEIGHT / 2` —— 与 auraApplied 同一个占位理由，
       *   两处保持同一个值，别一处 0.9 一处 1.0。
       */
      this.emitForm(
        body.lastPos, body.lastPos.y - GEOMETRY.HITBOX_HEIGHT / 2, body.visual, body.sig,
      );
      this.removeProjBody(id);
    }
    this.seenProjectiles = present;

    /**
     * 落点环随延迟落点消失而回收 —— 那一刻就是**落地那一刻**。
     *
     * ★ 通用延迟技能在这里仍然**不补爆发**：命中反馈由 `onCombatEvent` 在每个
     *   被命中者身上各放一发，中心再来一发就成了「中心一发 + 每人一发」的双份。
     * ★★ 但登记了 `impactPlanFor` 的技能（陨星）走 `queueImpact` —— 它放的是
     *   **砸在地上**那一坑（冲击波 + 掀尘 + 腾烟 + 焦土），与打在人身上的
     *   命中反馈是两回事，全躲开时也该有。理由见 `queueImpact`。
     */
    for (const key of [...this.rings.keys()]) {
      if (!key.startsWith('p') || delayedPresent.has(key)) continue;
      const entry = this.rings.get(key);
      const im = entry?.impact;
      if (im && entry) {
        const skill = getSkill(asSkillId(im.skillId));
        this.queueImpact(
          im.skillId,
          { x: entry.mesh.position.x, y: entry.mesh.position.y - 0.05, z: entry.mesh.position.z },
          im.radius,
          skill ? this.visualFor(skill) : ATTRIBUTE_VISUALS.fire,
        );
      }
      this.removeRing(key);
    }
  }

  // ── 延迟落点的坠落体（陨星）────────────────────────────────────

  /**
   * 天上那颗正在砸下来的东西：按剩余时间摆高度、每帧翻滚。
   * ★ 未登记 `fallPlanFor` 的延迟技能（以及没有 `impactAt` 的）直接跳过 ——
   *   照旧只有边界环 + 倒计时，一像素不变。
   */
  private syncFallingBody(
    entry: RingEntry,
    p: ProjectileView,
    av: AttributeVisual,
    now: number,
    dt: number,
    showTrail: boolean,
  ): void {
    const plan = fallPlanFor(p.skillId);
    if (!plan || p.impactAt === undefined) return;
    const remaining = Math.max(0, p.impactAt - now);
    if (!entry.fall) {
      entry.fall = {
        body: this.makeFallNode(av, plan.bodyRadius, plan.tailWidth, plan.tailLength),
        // ★ 首帧的剩余秒数就是全程时长（中途入场时它天然小一些，于是从半空接着落）
        from: Math.max(0.001, remaining),
      };
      this.group.add(entry.fall.body);
    }
    const body = entry.fall.body;
    body.position.set(
      p.position.x,
      p.position.y + fallHeightAt(remaining, entry.fall.from, plan.height),
      p.position.z,
    );
    // 翻滚：两轴不同速，避免读成绕单轴的陀螺。★ 只转岩块，火尾恒指向天上
    const rock = body.children.find((c) => c.name === 'fall-rock');
    if (rock) {
      rock.rotation.x += plan.tumble * dt;
      rock.rotation.y += plan.tumble * 0.62 * dt;
    }
    for (const child of body.children) {
      if (child.name === 'bolt-tail') child.visible = showTrail;
    }
  }

  /**
   * 坠落体节点：一大块自发光岩心 + 一圈外焰 + 两片交叉的火尾。
   *
   * ★★ **零细流池占用**：细流池 48 格是三类细流的预算和（蓄力 12 + 拖尾 18 +
   *   地面 18），已经顶死 —— 给坠落体再插一路粒子拖尾会把别人的尾巴挤没。
   *   连贯的那条火尾交给彗尾条（Plane），与弹体是同一个手法。
   * ★ 火尾挂在**组的本地 -Y** 而不是 -Z：坠落体是竖着掉下来的，
   *   尾巴该在正上方；而弹体的组会被 `orientBolt` 转到速度方向，这里不转。
   */
  private makeFallNode(
    av: AttributeVisual, radius: number, tailWidth: number, tailLength: number,
  ): THREE.Group {
    const g = new THREE.Group();
    g.name = 'spell-vfx-fall'; // 单测按名字找它（场上有没有一颗在掉的东西）

    /**
     * 翻滚的只有岩块本身，火尾不跟着转 —— 尾巴要恒指向天上。
     * ★ 所以岩心/外焰装在一个内层组里，`syncFallingBody` 只转它。
     */
    const rock = new THREE.Group();
    rock.name = 'fall-rock';
    g.add(rock);

    // 岩心：低面数球体，纯色不透明 —— 无贴图也一定看得见（essential 兜底）
    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(radius, 1),
      new THREE.MeshBasicMaterial({ color: av.primary }),
    );
    core.renderOrder = 5;
    rock.add(core);

    // 外焰：比岩心大一圈的加法壳，读作「烧着的」
    const shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(radius * 1.45, 1),
      new THREE.MeshBasicMaterial({
        color: av.secondary,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    shell.renderOrder = 5;
    rock.add(shell);

    const puff = this.accentTex.get('puff');
    if (puff) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: puff, color: av.primary, transparent: true,
          depthWrite: false, blending: THREE.AdditiveBlending,
        }),
      );
      sprite.scale.setScalar(radius * 3.4);
      sprite.renderOrder = 6;
      g.add(sprite);
    }

    const trailTex = this.accentTex.get('trail');
    if (!trailTex) return g;
    const tailMat = new THREE.MeshBasicMaterial({
      map: trailTex,
      color: av.primary,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    for (const roll of [0, Math.PI / 2]) {
      // 贴图长边是 Y，坠落体的尾巴正好在 +Y —— 不用像弹体那样先转到 -Z
      const geo = new THREE.PlaneGeometry(tailWidth, tailLength);
      if (roll !== 0) geo.rotateY(roll);
      const tail = new THREE.Mesh(geo, tailMat);
      tail.position.y = tailLength / 2 + radius * 0.6;
      tail.renderOrder = 4;
      tail.name = 'bolt-tail'; // 画质裁剪按名字找它（projectileTrail 装饰角色）
      g.add(tail);
    }
    return g;
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
    // 风暴盘的自转钟。★ 用渲染 dt 累加（顿帧时跟着一起冻，与粒子同一个时钟）
    this.stormClock += dt;
    // 只有离相机最近的几片冒粒子；其余照画边界环与染色盘（边界是 essential）
    const emitters = this.nearestIds(
      areas.map((a) => ({ id: a.id, position: a.center })), cameraPosition, MAX_FILL_AREAS,
    );

    const present = new Set<string>();
    for (const a of areas) {
      const key = `g${a.id}`;
      present.add(key);
      const skill = getSkill(asSkillId(a.skillId));
      const av = skill ? this.visualFor(skill) : ATTRIBUTE_VISUALS.frost;
      const entry = this.ensureRing(key, a.center, a.radius, av.primary);
      // skillId 传进去：暴风雪等技能有自己的天气档（大雪球，不是通用小雪花）
      const plan = groundFillPlanFor(av.particle, a.radius, density, a.skillId);

      /**
       * 地面风暴盘：让区域读作「这里有一片天气」，而不只是一圈线。
       * ★ 它是**装饰层**（跟着 `showFill` 一起被低画质砍掉），
       *   而边界环是关键信息（14.3「边界即判定」），任何画质都画 ——
       *   两者的门禁必须分开，砍错一个就违反 14.4。
       */
      this.syncAreaTint(
        entry, a, av.primary,
        showFill ? plan.tintOpacity : 0,
        STORM_TEXTURE[av.particle],
        this.stormClock * 0.35,
      );

      if (!showFill || plan.clusters <= 0 || !emitters.has(a.id)) continue;
      /**
       * ★★ **起量**：区域刚出现时立刻发一轮，不等第一个 cadence。
       *
       *   这修的是「暴风雪啥都没有」的结构性成因：区域只活 4 秒，
       *   而 cadence 是 0.6 秒 —— 老实现要等 0.6 秒才发第一簇，
       *   再加上雪 life 1.8 秒才算「铺满」，等它真正稠起来区域已经过半。
       *   起量之后，玩家按下技能看到的第一帧就有雪。
       *
       * ★ 它是**一次性**的，不改 cadence/life，所以稳态槽位占用完全不变 ——
       *   `vfxPlans.test.ts:246` 的预算断言不受影响。
       */
      if (entry.fillTimer === undefined) entry.fillTimer = plan.cadence;

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
    textureKey: AccentTexture, spin: number,
  ): void {
    if (opacity <= 0) {
      if (entry.tint) entry.tint.visible = false;
      return;
    }
    if (!entry.tint) {
      /**
       * ★★ 「风暴盘」而不是纯色圆盘。
       *
       *   用户实测「暴风雪啥都没有」的**结构性**成因不是密度：地面区域只活 4 秒，
       *   而每次 emit 的雪 life 1.8 秒、cadence 0.6 秒 —— 一生只发约 6 轮，
       *   前 1.8 秒在起量、后 1.8 秒在区域消失后还在飘，真正「有雪」的窗口
       *   只有中间约 2 秒。而粒子那条路**已经顶死池预算**
       *   （`ceil(1.8/0.6)×2 = 6`，`vfxPlans.test.ts:246` 钉着），加不动了。
       *
       *   所以密度改走**非粒子通道**：一张平铺贴图 + 每帧转 UV。
       *   它零池占用、零断言约束，而且是**持续**的 —— 区域在，风暴就在，
       *   不存在「起量/收尾」的空窗。
       */
      const tex = this.accentTex.get(textureKey) ?? null;
      if (tex) {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
      }
      const mat = new THREE.MeshBasicMaterial({
        color,
        map: tex,
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
    /**
     * ★ 绕自身法线**缓转**（贴地平面绕 Z 转就是绕世界 Y 转）。
     *   静止的贴图读作「地上有块脏东西」，转起来才读作「一片风暴在这儿盘旋」。
     *   转速故意慢（0.35 rad/s）—— 快了会读成「一个转盘」而不是天气。
     */
    entry.tint.mesh.rotation.z = spin;
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
      /**
       * 覆盖属性默认的切向初速（`MOTION[particle].swirl`）。
       * ★ P3 二级形态的 `spiral` / `orbit` 靠它 —— 「绕着转」是运动通道上的
       *   形状信号，而属性表里的 swirl 是**属性**的固有倾向（符文旋绕、
       *   叶片打旋），两者是不同的量，所以是覆盖而不是相加。
       */
      swirl?: number;
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
      swirl: opts.swirl ?? motion.swirl,
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
   * ★★ 全部尺寸走 `BOLT_BASE × form`（`boltFormFor` 的技能级覆盖）：
   *   通用档逐字段是 1，所以没被覆盖的技能一像素不变；霜矢那一行把核拉成
   *   梭形、长出尖端、压小两个圆 Sprite，于是它才不再是「一颗球」。
   * ★★ **几何体一律逐实例新建，绝不共享**：`disposeNode()` 会 traverse 释放
   *   所有 Mesh 的几何体 —— 共享的话第一发弹体消失就把全场弹体打成空白。
   *   （与文件里那条「Sprite 全体共用一个模块级几何体」是同一个坑的两面。）
   */
  private makeBoltNode(av: AttributeVisual, form: BoltForm = GENERIC_BOLT_FORM): THREE.Group {
    const g = new THREE.Group();

    // 1. 实心核。★ spindle = 八面双锥：低面数有棱，沿 +Z 拉长就是冰矛的梭形
    const coreGeo = form.core === 'spindle'
      ? new THREE.OctahedronGeometry(BOLT_BASE.coreRadius, 0)
      : new THREE.SphereGeometry(BOLT_BASE.coreRadius, 12, 12);
    const core = new THREE.Mesh(
      coreGeo,
      new THREE.MeshBasicMaterial({ color: av.primary }),
    );
    core.scale.set(form.coreScale.x, form.coreScale.y, form.coreScale.z);
    core.renderOrder = 5;
    g.add(core);

    /**
     * 1b. 前向尖端锥（只有登记了形态的技能有）。
     * ★ ConeGeometry 默认尖端在 +Y；`rotateX(+90°)` 把 +Y 转到 **+Z**（前方）——
     *   与下面那个尾锥的 -90° 正好相反，写反了就是「矛尖朝后」。
     */
    if (form.tipLength > 0) {
      const tipGeo = new THREE.ConeGeometry(
        form.tipRadius, form.tipLength, Math.max(3, form.tipFacets), 1,
      );
      tipGeo.rotateX(Math.PI / 2);
      const tip = new THREE.Mesh(tipGeo, new THREE.MeshBasicMaterial({ color: av.primary }));
      tip.position.z = BOLT_BASE.coreRadius * form.coreScale.z + form.tipLength / 2 - 0.06;
      tip.renderOrder = 5;
      g.add(tip);
    }

    // 2. 拖长锥：底面在前、尖端朝后 —— 读作「拖着走」
    //    ConeGeometry 默认尖端在 +Y；rotateX(-90°) 把 +Y 转到 **-Z**（后方）
    const coneGeo = new THREE.ConeGeometry(
      BOLT_BASE.coneRadius * form.coneRadius,
      BOLT_BASE.coneLength * form.coneLength,
      12, 1, true,
    );
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
    cone.position.z = -0.5 * form.coneLength;
    cone.renderOrder = 5;
    g.add(cone);

    // 3. 属性头部：火焰/冰晶/符文…（Sprite 恒面向镜头，任何角度都认得出属性）
    //    ★ 冰矛把它压到三成半并挪到矛尖 —— 于是它从「球」变成「尖端亮核」
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
      sprite.scale.setScalar(BOLT_BASE.headScale * form.headScale);
      sprite.position.z = form.headZ;
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
      sprite.scale.setScalar(BOLT_BASE.glowScale * form.glowScale);
      sprite.renderOrder = 5;
      g.add(sprite);
    }

    /**
     * 4b. 绕轴的冰晶（冰矛的尾迹晶体）。
     * ★★ 它们是**自旋唯一看得见的载体**：核与尖端都绕 Z 轴对称，
     *   材质又是无光照纯色，转与不转一模一样。偏心挂几根才转得出来。
     */
    for (let i = 0; i < form.crystals; i++) {
      const geo = new THREE.ConeGeometry(0.055, form.crystalLength, 4, 1);
      geo.rotateX(-Math.PI / 2); // 尖端朝后（-Z），跟着飞行方向拖
      const shard = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: av.secondary,
          transparent: true,
          opacity: 0.85,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      const a = (i / form.crystals) * Math.PI * 2;
      shard.position.set(
        Math.cos(a) * form.crystalRadius,
        Math.sin(a) * form.crystalRadius,
        -form.crystalLength * 0.35,
      );
      shard.renderOrder = 5;
      g.add(shard);
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
      const tailW = BOLT_BASE.tailWidth * form.tailWidth;
      const tailL = BOLT_BASE.tailLength * form.tailLength;
      for (const roll of [0, Math.PI / 2]) {
        // 贴图长边是 Y：绕 X 转 -90° 让长边躺进 -Z（后方），再绕长轴滚 0/90°
        const geo = new THREE.PlaneGeometry(tailW, tailL);
        geo.rotateX(-Math.PI / 2);
        if (roll !== 0) geo.rotateZ(roll);
        const tail = new THREE.Mesh(geo, tailMat);
        tail.position.z = -tailL / 2 - 0.1;
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
    form: BoltForm = GENERIC_BOLT_FORM,
  ): void {
    const { yaw, pitch } = boltOrientation(dir);
    group.rotation.order = 'YXZ';
    group.rotation.y = yaw;
    group.rotation.x = pitch;
    // ★ 属性固有的旋绕倾向 + 技能形态自己的自旋（冰矛拧着飞）
    const swirl = MOTION[av.particle].swirl + form.spin;
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
    const av = skill ? this.visualFor(skill) : ATTRIBUTE_VISUALS.arcane;
    // ★ 查不回技能时用推导层兜底：`resolveSignature` 对任何 id 都有结果
    //   （见 skillSignature.ts 的两层结构），所以这里不需要 undefined 分支
    const sig = resolveSignature(skillId);
    const form = boltFormFor(skillId);
    const group = this.makeBoltNode(av, form);
    this.group.add(group);
    body = { group, visual: av, sig, form, lastPos: { x: 0, y: 0, z: 0 }, fresh: true };
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
    // 坠落体与弹体同构（Mesh + Sprite 混装），走同一条「只释放 Mesh 几何体」的路
    if (entry.fall) this.disposeNode(entry.fall.body);
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
    // 锁定投射物的两张认领表没有 GPU 资源，但留着会让复用的实例记错账
    this.boltCovered.clear();
    this.burstlessBodies.clear();
    for (const key of [...this.rings.keys()]) this.removeRing(key);
    for (const id of [...this.windups.keys()]) this.removeWindup(id);
    for (const w of this.waves) this.disposeGroundMesh(w.mesh, w.mat);
    this.waves.length = 0;
    for (const d of this.decals) this.disposeGroundMesh(d.mesh, d.mat);
    this.decals.length = 0;
    // 排队中的落地冲击只是参数，没有 GPU 资源 —— 清空即可，别在 dispose 之后还发
    this.pendingImpacts.length = 0;
    this.pool.dispose();
    this.streams.dispose();
    this.flashes.dispose();
  }
}
