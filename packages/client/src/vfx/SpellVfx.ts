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

/** 每个属性的运动倾向（14.2「形状与运动」列的粒子化）*/
const MOTION: Record<AttributeVisual['particle'], { gravity: number; swirl: number }> = {
  ember: { gravity: 2.2, swirl: 0.2 },      // 火：热浪上升
  beam: { gravity: 2.6, swirl: 0 },         // 神圣：光柱上冲
  smoke: { gravity: 0.7, swirl: 0.4 },      // 暗影：烟雾缓升
  snowflake: { gravity: -1.2, swirl: 0.6 }, // 寒冰：雪花飘落
  rune: { gravity: 0.4, swirl: 2.6 },       // 奥术：符文旋绕
  leaf: { gravity: -0.4, swirl: 2.0 },      // 自然：叶片打旋
  spark: { gravity: -3.2, swirl: 0 },       // 物理：火花迸落
  droplet: { gravity: -4.2, swirl: 0 },     // 毒素：液滴下坠
};

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
  activeBursts: number;
  projectileBodies: number;
  /** 当前在飞的表现用弹体数 */
  visualBolts: number;
  /** 当前在场的持续边界环数（地面区域 + 延迟落点，14.3）*/
  groundRings: number;
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
}

/** 地面区域的表现视图（14.3 边界 + 内部装饰粒子所需的最小字段）*/
export interface GroundAreaView {
  id: number;
  skillId: string;
  center: Vec3Like;
  radius: number;
}

/**
 * 表现层消费的战斗事件 —— `CombatEvent` 的子集，字段收窄到真的会读的。
 * ★ 联网场景没有本地 sim：它拿到的是协议消息，凑不出完整的 `CombatEvent`
 *   （redact 之后连 sourceId 都没有）。收窄之后本地事件与网络消息都能喂。
 */
export type SpellVfxEvent =
  | { t: 'damage'; targetId: EntityId; amount: number; school: School; immune: boolean
      avoided?: 'dodge' | 'parry' | 'block' }
  | { t: 'heal'; targetId: EntityId; amount: number }
  | { t: 'auraApplied'; targetId: EntityId; auraId: string }
  | { t: 'shieldBroken'; targetId: EntityId }
  | { t: 'death'; targetId: EntityId };

/** 每帧驱动所需的全部外部状态。一次传齐，见 `frame()` */
export interface SpellVfxFrame {
  quality: QualityTier;
  cameraDistance: number;
  /**
   * 点精灵的透视缩放系数 = 视口像素高 / (2·tan(fov/2))。
   * 由场景算好传进来 —— 本类不该知道 canvas 或相机参数。
   */
  pointScale: number;
  projectiles: readonly ProjectileView[];
  grounds: readonly GroundAreaView[];
}

interface ProjBody {
  group: THREE.Group;
  visual: AttributeVisual;
  /** ★ 复用同一个对象，不每帧新建（12v12 下这是每秒上千次分配）*/
  lastPos: { x: number; y: number; z: number };
  /** 刚创建、还没有位置：第一帧直接落位，不做平滑 */
  fresh: boolean;
}

/** 表现用弹体：从施法者飞向命中点，抵达即爆。零规则影响 */
interface VisualBolt {
  group: THREE.Group;
  visual: AttributeVisual;
  from: Vec3Like;
  /** 终点在**释放瞬间**取定 —— 6.6：命中资格已定，目标之后怎么跑都不改变结果 */
  to: Vec3Like;
  distance: number;
  traveled: number;
}

export class SpellVfx {
  readonly group = new THREE.Group();
  private readonly pool = new BurstPool(32);
  /** 刀光与免疫白闪（要随机旋转，Points 做不了，见 FlashPool 文件头）*/
  private readonly flashes = new FlashPool(12);

  /** 已解码的贴图（异步填充；未就绪时取到 null 走程序化兜底）*/
  private readonly particleTex = new Map<AttributeVisual['particle'], THREE.Texture | null>();
  private readonly accentTex = new Map<AccentTexture, THREE.Texture | null>();
  private texturesLoaded = 0;

  /** sim 真实投射物的主体。key = projectile.id */
  private readonly projBodies = new Map<number, ProjBody>();
  /** 表现用弹体（sim 里不存在，见文件头）*/
  private readonly bolts: VisualBolt[] = [];
  /** 延迟落点 / 地面区域的持续边界环。key = 'p'+id / 'g'+id */
  private readonly rings = new Map<string, THREE.Mesh>();

  /** 上一帧场上还在的投射物 id，用于检出「消失 → 补一发命中爆发」*/
  private seenProjectiles = new Set<number>();

  private trailTimer = 0;
  private fillTimer = 0;
  private cameraDistance = 8;
  private disposed = false;

  constructor() {
    this.group.name = 'spell-vfx';
    this.group.add(this.pool.group);
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
    caster: { position: Vec3Like; height: number; yaw: number },
    skill: SkillDef | undefined,
    /** 本次施法的结算目标（`onCastResolved` 给的那一份，结算前快照）*/
    targets: readonly { position: Vec3Like; height: number }[] = [],
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
      this.emitBurst(hand, av, { count: 6, speed: 1.0, size: 0.42, life: 0.5, drag: 3.5 });
      return;
    }
    if (kind !== 'resolved') return;

    // Q 版基调：释放要「砰」地一下 —— 大、密、亮
    this.emitBurst(hand, av, { count: 16, speed: 3.0, size: 0.72, life: 0.55 });
    this.emitAccent(hand, 'glow', av.secondary, 1.4);

    if (this.flies(skill)) {
      for (const t of targets) {
        const to: Vec3Like = {
          x: t.position.x,
          y: t.position.y + t.height * 0.5,
          z: t.position.z,
        };
        const d = Math.hypot(to.x - hand.x, to.y - hand.y, to.z - hand.z);
        if (d < 1.5) continue; // 自身/贴脸：没有可看的飞行段
        this.spawnBolt(hand, to, av, d);
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
          this.emitBurst(at, NEUTRAL, { count: 4, speed: 1.2, size: 0.3, life: 0.35 });
          return;
        }
        if (ev.amount <= 0) return;
        const av = visualForSchool(ev.school);
        // 伤害越大爆发越猛（钳在合理范围）。Q 版基调：底数就大
        const scale = Math.min(1.6, 0.7 + ev.amount / 400);
        this.emitBurst(at, av, {
          count: Math.round(16 * scale),
          speed: 4.2 * scale,
          size: 0.7 * scale,
          life: 0.55,
        });
        // 第二通道点缀（14.2）：物理 = 刀光 + 迸溅火星；火/奥/圣见 HIT_ACCENT
        if (ev.school === School.Physical) {
          this.flashes.emit({
            origin: at, texture: this.accentTex.get('slash') ?? null,
            color: 0xfff3e0, size: 2.2 * scale, life: 0.24,
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
        if (at) this.emitBurst(at, ATTRIBUTE_VISUALS.shadow, { count: 18, speed: 2.6, size: 0.8, life: 0.85 });
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
    this.pool.setScale(ctx.pointScale);
    this.syncProjectiles(ctx.projectiles, ctx.quality, dt);
    this.syncGround(ctx.grounds, ctx.quality, dt);
    this.updateBolts(dt, ctx.quality);
    this.pool.update(dt);
    this.flashes.update(dt);
  }

  /** 表现用弹体的推进：匀速直线，抵达即爆并回收 */
  private updateBolts(dt: number, quality: QualityTier): void {
    const showTrail = isVisible('projectileTrail', quality);
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i]!;
      b.traveled += BOLT_SPEED * dt;
      const k = Math.min(1, b.traveled / b.distance);
      const at = {
        x: b.from.x + (b.to.x - b.from.x) * k,
        y: b.from.y + (b.to.y - b.from.y) * k,
        z: b.from.z + (b.to.z - b.from.z) * k,
      };
      b.group.position.set(at.x, at.y, at.z);

      if (showTrail) {
        this.emitBurst(at, b.visual, {
          count: 3, speed: 0.5, size: 0.42, life: 0.3, drag: 4, opacity: 0.9,
        });
      }

      if (k >= 1) {
        // 抵达：命中爆发（命中资格早已在释放瞬间定死，这里只是把它演出来）
        this.emitBurst(b.to, b.visual, { count: 18, speed: 4.4, size: 0.75, life: 0.55 });
        this.emitAccent(b.to, 'debris', b.visual.secondary, 0.95);
        this.disposeNode(b.group);
        this.bolts.splice(i, 1);
      }
    }
  }

  private spawnBolt(from: Vec3Like, to: Vec3Like, av: AttributeVisual, distance: number): void {
    // 同时在飞的弹体设个上限：12v12 混战里这是唯一会无界增长的东西
    if (this.bolts.length >= 24) {
      const oldest = this.bolts.shift();
      if (oldest) this.disposeNode(oldest.group);
    }
    const group = this.makeBoltNode(av);
    group.position.set(from.x, from.y, from.z);
    this.group.add(group);
    this.bolts.push({
      group, visual: av,
      from: { ...from }, to: { ...to },
      distance, traveled: 0,
    });
  }

  // ── 每帧：真实投射物（本地 sim 或服务器快照，都收 ProjectileView）──

  /**
   * 把投射物视图画成看得见的飞行体。
   *   homing / colliding → 属性色球（essential）+ 拖尾（decorative）
   *   delayedImpact      → 持续落点边界环（essential，14.3 要求全程可见）
   * 消失的投射物在末位置补一发命中爆发。
   */
  private syncProjectiles(items: readonly ProjectileView[], quality: QualityTier, dt: number): void {
    this.trailTimer += dt;
    const trailDue = this.trailTimer >= 0.05;
    if (trailDue) this.trailTimer = 0;
    const showTrail = isVisible('projectileTrail', quality);

    const present = new Set<number>();
    const delayedPresent = new Set<string>();

    for (const p of items) {
      if (p.kind === 'delayedImpact') {
        const key = `p${p.id}`;
        delayedPresent.add(key);
        const skill = getSkill(asSkillId(p.skillId));
        this.ensureRing(
          key, p.position, p.radius ?? 1,
          (skill ? visualOf(skill) : ATTRIBUTE_VISUALS.fire).primary,
        );
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
      body.lastPos.x = g.x;
      body.lastPos.y = g.y;
      body.lastPos.z = g.z;

      if (trailDue && showTrail) {
        // 真投射物（弩箭）的拖尾用轨迹条贴图 trace_05，与法术弹体的属性粒子区分
        this.emitBurst(body.lastPos, body.visual, {
          count: 3, speed: 0.5, size: 0.45, life: 0.32, drag: 4, opacity: 0.9,
          texture: this.accentTex.get('trail') ?? this.texFor(body.visual.particle),
        });
      }
    }

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
  private syncGround(areas: readonly GroundAreaView[], quality: QualityTier, dt: number): void {
    this.fillTimer += dt;
    const fillDue = this.fillTimer >= 0.12;
    if (fillDue) this.fillTimer = 0;
    const showFill = isVisible('groundFill', quality);
    const density = decorativeDensity(quality);

    const present = new Set<string>();
    for (const a of areas) {
      const key = `g${a.id}`;
      present.add(key);
      const skill = getSkill(asSkillId(a.skillId));
      const av = skill ? visualOf(skill) : ATTRIBUTE_VISUALS.frost;
      this.ensureRing(key, a.center, a.radius, av.primary);

      if (fillDue && showFill && density > 0) {
        // 区域内随机点冒一小簇，贴地起、向上飘
        const r = a.radius * Math.sqrt(Math.random());
        const ang = Math.random() * Math.PI * 2;
        this.emitBurst(
          { x: a.center.x + Math.cos(ang) * r, y: a.center.y, z: a.center.z + Math.sin(ang) * r },
          av,
          {
            count: Math.max(2, Math.round(4 * density)),
            speed: 0.6, size: 0.34, life: 0.8, gravity: 1.4, spread: 'disc',
          },
        );
      }
    }

    for (const key of [...this.rings.keys()]) {
      if (key.startsWith('g') && !present.has(key)) this.removeRing(key);
    }
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
    },
  ): void {
    const motion = MOTION[av.particle];
    // 近镜头（第一人称）压低透明度，不糊满屏（14.3）
    const closeFade = this.cameraDistance < 3 ? 0.45 : 1;
    this.pool.emit({
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

  /** 弹体外观：实心核（无贴图也可见）+ 加法辉光贴片。Q 版基调 —— 弹体要大到看不漏 */
  private makeBoltNode(av: AttributeVisual): THREE.Group {
    const g = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 12, 12),
      new THREE.MeshBasicMaterial({ color: av.primary }),
    );
    core.renderOrder = 5;
    g.add(core);

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
      sprite.scale.setScalar(1.7);
      sprite.renderOrder = 5;
      g.add(sprite);
    }
    return g;
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

  private ensureRing(key: string, center: Vec3Like, radius: number, color: number): void {
    let ring = this.rings.get(key);
    if (!ring) {
      // 半径 1 的单位环，实例按真实半径缩放 —— 边界永远等于判定半径（14.3）
      ring = new THREE.Mesh(
        new THREE.RingGeometry(0.9, 1, 48),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.85,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.renderOrder = 3;
      this.group.add(ring);
      this.rings.set(key, ring);
    }
    ring.scale.setScalar(radius);
    ring.position.set(center.x, center.y + 0.05, center.z);
    (ring.material as THREE.MeshBasicMaterial).color.set(color);
  }

  private removeRing(key: string): void {
    const ring = this.rings.get(key);
    if (!ring) return;
    this.group.remove(ring);
    ring.geometry.dispose();
    (ring.material as THREE.Material).dispose();
    this.rings.delete(key);
  }

  // ── 自检 / 清理 ───────────────────────────────────────────────

  status(): SpellVfxStatus {
    return {
      texturesLoaded: this.texturesLoaded,
      texturesTotal: VFX_TEXTURE_FILES.length,
      attributesCovered: Object.keys(PARTICLE_TEXTURE).length,
      activeBursts: this.pool.activeCount,
      projectileBodies: this.projBodies.size,
      visualBolts: this.bolts.length,
      groundRings: this.rings.size,
      activeFlashes: this.flashes.activeCount,
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.projBodies.keys()]) this.removeProjBody(id);
    for (const b of this.bolts) this.disposeNode(b.group);
    this.bolts.length = 0;
    for (const key of [...this.rings.keys()]) this.removeRing(key);
    this.pool.dispose();
    this.flashes.dispose();
  }
}
