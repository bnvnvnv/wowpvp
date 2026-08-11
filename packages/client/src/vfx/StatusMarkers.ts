/**
 * 控制状态与护盾的实际渲染。规格书 14.3，验收 #48 / #49。
 *
 * `status.ts` 定义**该长什么样**，本文件负责**画出来**。
 * 拆成两个文件的原因：前者是纯数据，可以被测试逐条断言
 * （沉默与恐惧至少两个通道不同、护盾四态运动方式互不相同…），
 * 后者依赖 three.js 和真实场景，只能靠肉眼验收。
 *
 * ★ 这里的每个可视元素都用 `ESSENTIAL_ROLES` 里的角色标注，
 *   并且**没有任何一处读 quality** —— 关键信息不该有被画质影响的通道。
 *   装饰粒子（余烬、雪花…）走另一条路，见 quality.ts。
 */

import * as THREE from 'three';
import { GEOMETRY } from '@wowpvp/shared';
import { QualityTier } from '../render/quality.js';
import {
  NEUTRAL_SHELL_MOTION,
  SHELL_FADE_IN,
  SHELL_FADE_OUT,
  SHELL_LAYERS,
  type ShellCategory,
  type ShellMotion,
  type ShellPick,
} from './debuffAura.js';
import {
  CONTROL_VISUALS,
  SHIELD_VISUALS,
  ShieldState,
  closeUpOpacity,
  controlMarkerScale,
  essentialMarkerScale,
  isFirstPersonDistance,
  shieldStateFor,
  type ControlKind,
} from './status.js';

// ★ three 的 examples 包，本项目第一次用它。只取一个纯几何合并函数，
//   不引入任何运行时子系统（loader/controls 之类）。
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const H = GEOMETRY.HITBOX_HEIGHT;
const R = GEOMETRY.HITBOX_RADIUS;

/**
 * 查不到学派时的中性护盾色。
 * ★ 这不是「默认颜色」而是**兜底** —— 正常路径由调用方传盾的学派色
 *   （冰盾冰蓝、护心屏障圣金）。此前这个值是唯一的颜色。
 */
const SHIELD_FALLBACK_COLOR = 0xffd98a;
/** W16 复活保护：亮金（语义近圣光，与护盾回落色同族但形态完全不同）*/
const SPAWN_PROTECTION_COLOR = 0xffe9a0;

/**
 * X30：第一人称下 debuff 壳的收缩系数。
 *
 * ★ 不能只靠 `closeUpOpacity`：壳的基准（0.20 / 0.26）本来就低于那条
 *   0.25 的上限，压不到。而第一人称时镜头**在壳里面** —— 正面那层被背面
 *   剔除掉（看不见），背面那层糊在整个视野上（14.3 第五条点名不许）。
 * ★ 0.3 而不是 0：留一点点色调是对的，「我身上有个冰系减速」在第一人称下
 *   也该看得出来；14.4 只禁止把关键信息**隐藏**，不禁止压淡。
 */
const FIRST_PERSON_SHELL_FACTOR = 0.3;

/**
 * X7：护盾**自然过期**的收束淡出时长，秒。
 *
 * ★★ 「过期」与「破裂」是两件事，这里只补前者 ——
 *   · **破裂** = 被打穿。`flashBroken()` 已经有一整套表达（shatter 胀开 0.4 秒
 *     + `SpellVfx` 从壳体半径炸出碎片），壳在那之后**该**干净地没有：
 *     碎掉的东西不会「慢慢淡出」，那反而把「打穿了」削弱成「消散了」。
 *   · **过期** = 时间到了，盾自己收了。此前它走的是同一条
 *     `shell.visible = false` —— 一帧之内壳凭空消失，实测读作
 *     「刚才那个盾是不是 bug」。0.3 秒的收束淡出把它读成「护罩收了」。
 *
 * ★ 0.3 秒的出处：比承伤闪光（0.15）长、比破裂（0.4）短 —— 三者在时间轴上
 *   两两可分，玩家不必看形状就能从**长度**上把它们区分开。占位值，真机可调。
 */
const SHIELD_EXPIRE_FADE = 0.3;

/** 按 CONTROL_VISUALS 的 shape 键造几何体 */
const makeControlGeometry = (shape: string): THREE.BufferGeometry => {
  switch (shape) {
    case 'chains':
      // 定身（旧形状，保留给可能的其他控制复用）：脚下一圈锁链环
      return new THREE.TorusGeometry(R * 1.3, 0.05, 6, 20);
    case 'iceShards': {
      /**
       * 定身：脚下**炸起一圈棱柱** + 一块贴地底座。
       *
       * ★★ 换掉 `chains` 的原因很具体：那是 `TorusGeometry(R*1.3, **0.05**, ...)`，
       *   管径只有 5 厘米 —— 规则、接线、可见性全都是对的，
       *   但玩家在正常镜头距离下**根本看不见**，实测反馈就是「没有」。
       *   这类「做了但看不见」比没做更难查，因为所有断言都是绿的。
       *
       * ★ 用四棱锥（radialSegments=4）而不是圆锥：棱柱有明确的棱面高光，
       *   读作「结晶」；圆锥读作「一个尖」。低多边形也更合 Q 版基调。
       * ★ 合并成一个几何体（不是 Group）：`makeControlGeometry` 的契约是
       *   返回单个 BufferGeometry，调用方按它建一个 Mesh 并统一做缩放/运动。
       */
      const parts: THREE.BufferGeometry[] = [];
      // 贴地底座：一层薄冰
      const base = new THREE.CylinderGeometry(R * 1.35, R * 1.5, 0.08, 12);
      base.translate(0, 0.04, 0);
      parts.push(base);
      // 一圈斜插的棱柱，高矮交替，读作「炸起来的碎冰」
      const SHARDS = 7;
      for (let i = 0; i < SHARDS; i++) {
        const tall = i % 2 === 0;
        const h = tall ? 0.62 : 0.4;
        const shard = new THREE.ConeGeometry(tall ? 0.13 : 0.1, h, 4);
        const ang = (i / SHARDS) * Math.PI * 2;
        // 向外倾斜，像从地里挤出来的
        shard.rotateX(0.32);
        shard.rotateY(-ang);
        shard.translate(Math.cos(ang) * R * 1.15, h * 0.5, Math.sin(ang) * R * 1.15);
        parts.push(shard);
      }
      const merged = mergeGeometries(parts);
      for (const p of parts) p.dispose();
      /**
       * ★ 调用方对 feet 锚点会统一 `rotation.x = -π/2`（把「贴地圆环」摆平）。
       *   而本几何体是**按世界朝向**建的（Y 轴向上），所以先预旋 +π/2 抵消，
       *   否则冰棱会全部倒下去躺在地上。
       */
      merged.rotateX(Math.PI / 2);
      return merged;
    }
    case 'stars':
      // 昏迷：头顶几颗星，用一个八面体代表
      return new THREE.OctahedronGeometry(0.14, 0);
    case 'crossedBar':
      // 沉默/缴械：一道横杠
      return new THREE.BoxGeometry(0.5, 0.08, 0.08);
    case 'wave':
      // 恐惧：环绕身体的波纹
      return new THREE.TorusGeometry(R * 1.6, 0.04, 5, 16, Math.PI * 1.4);
    case 'ring':
    default:
      return new THREE.TorusGeometry(R * 1.2, 0.05, 6, 18);
  }
};

/**
 * X30：debuff 壳的胶囊几何体。
 * ★ 与 `FactionRing.makeRimGeometry` 同一条公式（总高 = length + 2×radius），
 *   低分段数（3×10）—— 它是一层朦胧的色膜，多边形多一倍也看不出区别。
 */
const makeShellGeometry = (radiusScale: number, heightScale: number): THREE.CapsuleGeometry => {
  const r = R * radiusScale;
  const total = H * heightScale;
  return new THREE.CapsuleGeometry(r, Math.max(0.05, total - r * 2), 3, 10);
};

/** 挂点对应的高度 */
const anchorY = (anchor: string): number => {
  if (anchor === 'feet') return 0.06;
  if (anchor === 'overhead') return H + 0.35;
  return H * 0.55; // body
};

/**
 * 一个角色身上的全部状态标记。
 * 每帧由 `update()` 驱动，内部按需显隐，不重建对象。
 */
export class StatusMarkers {
  readonly group = new THREE.Group();

  private readonly control = new Map<ControlKind, THREE.Mesh>();
  /**
   * 护盾**双层壳**。
   *
   * ★★ 外层用 `BackSide` + 加法混合 —— 这就是不写 shader 的边缘光：
   *   只画球的背面时，屏幕上最亮的那一圈恰好是轮廓（菲涅尔的廉价近似）。
   *   单层实心球在 Q 版明亮场景里读作「角色被套了个塑料袋」，
   *   有了轮廓亮边才读作「有一层护罩」。
   *
   * ★ 硬约束：**纯程序化，不许引贴图** —— `StatusMarkers` 在 `?art=off` 下
   *   照常构造，而 `verify:m12 #12e` 断言那条路径零外部素材加载。
   */
  private readonly shell: THREE.Group;
  private readonly shieldInner: THREE.Mesh;
  private readonly shieldOuter: THREE.Mesh;
  private readonly shieldInnerMat: THREE.MeshBasicMaterial;
  private readonly shieldOuterMat: THREE.MeshBasicMaterial;
  /** 承伤/破裂这类一次性反馈的剩余秒数 */
  private burstRemaining = 0;
  private burstState: ShieldState | null = null;
  /** 壳体自转角（内外反向）与最近一帧的持续态，供 update() 推进 */
  private shellSpin = 0;
  private shownState: ShieldState | null = null;
  /**
   * X7：自然过期的收束淡出剩余秒数。> 0 时壳仍在场，由 `update()` 推进。
   * ★ 与 `burstRemaining` 分开而不是复用：那个是「一次性反馈还剩多久」，
   *   这个是「壳还剩多久才真的没了」，两者可以互不相干地并存
   *   （盾在承伤闪光的中途到期是完全可能的）。
   */
  private expireRemaining = 0;
  /**
   * 淡出**起点**的三个值（内层/外层不透明度、壳体缩放）。
   * ★★ 必须存起点再插值，不能每帧在当前值上乘一个衰减系数：
   *   淡出期间 `setShield` 走的是早退分支，不再重写不透明度，
   *   于是「每帧乘 (1-t)」会连乘成指数衰减 —— 0.3 秒的淡出实际
   *   两三帧就黑了，参数写着 0.3 而画面上根本没有 0.3。
   */
  private expireFrom = { inner: 0, outer: 0, scale: 1 };
  /**
   * 最近一次消失是不是**破裂**导致的。
   *
   * ★★ 为什么需要这个闩：`flashBroken()` 的 burst 只活 0.4 秒，之后
   *   `burstState` 归 null。此时场景仍在每帧喂 `setShield(0, …)`，
   *   下面那条早退分支**分不出**「刚被打碎」和「时间到了」——
   *   没有闩的话破裂的壳也会走 0.3 秒淡出，语义区分当场丢掉。
   */
  private brokenLatch = false;

  /**
   * W16（技术债总账）：复活保护（12.6）。
   * ★ 它是 14.4 essential 八项里**唯一从未被画过**的角色 —— 清单保证了
   *   「不许被画质隐藏」，却没有人给它一个渲染器。
   * ★ 必须与护盾（球壳）和完全免疫读得开：保护是「刚复活、别打我也
   *   别指望他拔旗」的**状态公告**，用金色地环 + 柔光柱 —— 语义近圣光，
   *   形态上没有任何其他标记用竖直光柱。
   */
  private readonly spawnRing: THREE.Mesh;
  private readonly spawnPillar: THREE.Mesh;
  private spawnProtected = false;

  /**
   * X30：**中招的那一层** —— debuff 学派色壳（用户 2026-08-11 拍板）。
   *
   * ★ 选哪一枚、什么颜色、怎么动全在 `debuffAura.ts`（纯判据，逐条可断言）；
   *   这里只负责画。与 `status.ts` / 本文件的分工逐字相同。
   * ★ 与 X14 的阵营 rim 同族的便宜路：内层正面色膜（「身上有一层冰蓝色」）
   *   + 外缘背面加法（廉价边缘光）。分层表见 `SHELL_LAYERS` 的注释 ——
   *   半径 1.05/1.11 都在阵营 rim（1.16）以内，护盾球壳（1.85+）在最外面。
   * ★ 硬约束与护盾壳一字不差：**纯程序化、零贴图**，`?art=off` 下照常构造。
   */
  private readonly shellDebuff: THREE.Group;
  private readonly debuffFill: THREE.Mesh;
  private readonly debuffRim: THREE.Mesh;
  private readonly debuffFillMat: THREE.MeshBasicMaterial;
  private readonly debuffRimMat: THREE.MeshBasicMaterial;
  /** 当前生效的壳（undefined = 没中招）*/
  private debuffPick: ShellPick | undefined;
  /**
   * 淡入淡出权重 0..1。★ 与「有没有 pick」分开记：解除之后还要淡 0.28 秒，
   * 那期间 `debuffPick` 已经是 undefined 了，但壳还得知道用哪个颜色淡出 ——
   * 所以颜色写在材质上（不随 pick 清空），权重单独走。
   */
  private debuffWeight = 0;
  private debuffMotion: ShellMotion | undefined;
  /** 壳自己的相位钟：每次**重新**中招从 0 起，脉动不会从半路接上 */
  private debuffPhase = 0;

  constructor() {
    for (const [kind, v] of Object.entries(CONTROL_VISUALS) as [ControlKind, typeof CONTROL_VISUALS[ControlKind]][]) {
      const mesh = new THREE.Mesh(
        makeControlGeometry(v.shape),
        // MeshBasic：不受光照影响 —— 关键信息不能因为站在阴影里就看不清
        new THREE.MeshBasicMaterial({ color: v.color, transparent: true, opacity: 0.95 }),
      );
      mesh.position.y = anchorY(v.anchor);
      if (v.anchor === 'feet') mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.renderOrder = 10;
      this.group.add(mesh);
      this.control.set(kind, mesh);
    }

    this.shell = new THREE.Group();
    this.shell.position.y = H * 0.5;
    this.shell.visible = false;

    // 内层：淡淡的实心填充，告诉玩家「这里面有个人被罩着」
    this.shieldInnerMat = new THREE.MeshBasicMaterial({
      color: SHIELD_FALLBACK_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    this.shieldInner = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.85, 20, 14), this.shieldInnerMat,
    );
    this.shell.add(this.shieldInner);

    // 外层：只画背面 + 加法混合 = 轮廓亮边（见字段注释）
    this.shieldOuterMat = new THREE.MeshBasicMaterial({
      color: SHIELD_FALLBACK_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
    });
    this.shieldOuter = new THREE.Mesh(
      new THREE.SphereGeometry(R * 2.02, 20, 14), this.shieldOuterMat,
    );
    this.shell.add(this.shieldOuter);

    this.group.add(this.shell);

    // W16 复活保护：金色地环（管径 0.1 —— 四期教训：0.05 在正常镜头下看不见）
    this.spawnRing = new THREE.Mesh(
      new THREE.TorusGeometry(R * 1.7, 0.1, 8, 32),
      new THREE.MeshBasicMaterial({
        color: SPAWN_PROTECTION_COLOR, transparent: true, opacity: 0.85, depthWrite: false,
      }),
    );
    this.spawnRing.rotation.x = -Math.PI / 2;
    this.spawnRing.position.y = 0.06;
    this.spawnRing.visible = false;
    this.spawnRing.renderOrder = 10;
    this.group.add(this.spawnRing);

    // 柔光柱：开口圆筒 + 加法混合，从脚下升到头顶上方
    this.spawnPillar = new THREE.Mesh(
      new THREE.CylinderGeometry(R * 1.15, R * 1.35, H * 1.7, 16, 1, true),
      new THREE.MeshBasicMaterial({
        color: SPAWN_PROTECTION_COLOR, transparent: true, opacity: 0.14,
        depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      }),
    );
    this.spawnPillar.position.y = H * 0.85;
    this.spawnPillar.visible = false;
    this.spawnPillar.renderOrder = 9;
    this.group.add(this.spawnPillar);

    // X30：debuff 学派色壳（分层表见 SHELL_LAYERS）
    this.shellDebuff = new THREE.Group();
    this.shellDebuff.position.y = H * 0.5;
    this.shellDebuff.visible = false;
    this.debuffFillMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.FrontSide,
    });
    this.debuffFill = new THREE.Mesh(
      makeShellGeometry(SHELL_LAYERS.fill.radiusScale, SHELL_LAYERS.fill.heightScale),
      this.debuffFillMat,
    );
    this.debuffFill.renderOrder = 8;
    this.shellDebuff.add(this.debuffFill);
    this.debuffRimMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
    });
    this.debuffRim = new THREE.Mesh(
      makeShellGeometry(SHELL_LAYERS.rim.radiusScale, SHELL_LAYERS.rim.heightScale),
      this.debuffRimMat,
    );
    this.debuffRim.renderOrder = 8;
    this.shellDebuff.add(this.debuffRim);
    this.group.add(this.shellDebuff);
  }

  /** W16：复活保护开关。检测在调用方（按光环 id，两个场景同一判据）*/
  setSpawnProtected(on: boolean): void {
    if (on === this.spawnProtected) return;
    this.spawnProtected = on;
    this.spawnRing.visible = on;
    this.spawnPillar.visible = on;
  }

  /** 诊断出口（verify 断言读它）*/
  get spawnProtectionVisible(): boolean {
    return this.spawnProtected;
  }

  /**
   * X30：这一帧该罩哪一层 debuff 壳。传 undefined = 没中招（走淡出）。
   *
   * ★ 判据全在 `debuffShellOf()` —— 两个场景各自把自己的光环列表喂给它，
   *   这里只接结果。**不许**在这个方法里补任何「哪个更重要」的判断，
   *   那会变成第二份优先级实现。
   * ★ 颜色写在材质上而**不是**跟着 `debuffPick` 走：解除之后还有
   *   0.28 秒淡出，那期间 pick 已经没了，壳仍要用最后那个颜色淡下去。
   */
  setDebuffShell(pick: ShellPick | undefined): void {
    const prev = this.debuffPick;
    this.debuffPick = pick;
    if (pick === undefined) return;
    /**
     * 换了一枚（被冰减速的中途又吃了一记火焰昏迷）→ 相位重来。
     * ★ 不重置的话新学派的脉动会从旧学派的半路接上，读作
     *   「同一个东西变了个色」而不是「又中了一发」。
     */
    if (prev === undefined || prev.auraId !== pick.auraId || prev.category !== pick.category) {
      this.debuffPhase = 0;
    }
    this.debuffFillMat.color.set(pick.color);
    this.debuffRimMat.color.set(pick.edge);
    this.debuffMotion = pick.motion;
  }

  /** 当前是否在画 debuff 壳（自检 / 单测用）*/
  get debuffShellVisible(): boolean {
    return this.shellDebuff.visible;
  }

  /** 壳选中的类别（自检 / 单测用）。淡出期间已经是 undefined —— 它跟着 pick 走 */
  get debuffShellCategory(): ShellCategory | undefined {
    return this.debuffPick?.category;
  }

  /** 壳的内层颜色（自检 / 单测用）。★ S7 的中性灰是从这里断言的 */
  get debuffShellColor(): number {
    return this.debuffFillMat.color.getHex();
  }

  /** 壳的内层当前不透明度（自检 / 单测用）—— 淡入淡出与脉动都写在这一个通道上 */
  get debuffShellOpacity(): number {
    return this.debuffFillMat.opacity;
  }

  /**
   * 壳相对身体中心的竖向偏移（自检 / 单测用）。
   * ★ 灰度下区分火与霜的那条通道就在这里：火恒为正（往上窜）、霜恒为负（往下沉）。
   */
  get debuffShellDrift(): number {
    return this.shellDebuff.position.y - H * 0.5;
  }

  /**
   * 推进一帧 debuff 壳：淡入淡出 + 学派脉动 + 竖向漂移。
   * ★ 由 `update()` 调用 —— 与控制标记同一个时钟，场景不需要多喂一次。
   */
  private advanceDebuffShell(dt: number, cameraDistance: number): void {
    const rising = this.debuffPick !== undefined;
    const step = dt / (rising ? SHELL_FADE_IN : SHELL_FADE_OUT);
    this.debuffWeight = rising
      ? Math.min(1, this.debuffWeight + step)
      : Math.max(0, this.debuffWeight - step);

    if (this.debuffWeight <= 0) {
      this.shellDebuff.visible = false;
      this.debuffFillMat.opacity = 0;
      this.debuffRimMat.opacity = 0;
      this.shellDebuff.position.y = H * 0.5;
      this.debuffPhase = 0; // 下一次中招从头脉动
      return;
    }

    this.shellDebuff.visible = true;
    this.debuffPhase += dt;
    const m = this.debuffMotion ?? NEUTRAL_SHELL_MOTION;
    const pulse = 1 + Math.sin(this.debuffPhase * m.rate) * m.amp;
    const fp = isFirstPersonDistance(cameraDistance) ? FIRST_PERSON_SHELL_FACTOR : 1;
    const k = this.debuffWeight * Math.max(0, pulse) * fp;
    this.debuffFillMat.opacity = SHELL_LAYERS.fill.opacity * k;
    this.debuffRimMat.opacity = SHELL_LAYERS.rim.opacity * k;

    /**
     * 竖向漂移。★★ 用 `0.5 + 0.5·sin` 而不是裸 `sin`：裸的会让壳上下**对称**
     *   摆动，于是 `drift` 的正负只改变相位、不改变观感 —— 火与霜在灰度下
     *   又变成同一个东西。半波偏置让正的 drift **恒在中心之上**（往上窜）、
     *   负的恒在中心之下（往下沉），符号第一次真的成为一条通道。
     */
    const bias = 0.5 + 0.5 * Math.sin(this.debuffPhase * m.rate * 0.5);
    this.shellDebuff.position.y = H * 0.5 + m.drift * bias * this.debuffWeight;
  }

  /**
   * 更新一帧。
   *
   * @param active     当前生效的控制种类
   * @param quality    画质档位。★ 只用于**放大**低画质下的标记，绝不用于隐藏
   * @param cameraDistance 镜头距离，用于 14.3 的远近调整
   */
  update(
    active: ReadonlyMap<ControlKind, number | undefined>,
    quality: QualityTier,
    cameraDistance: number,
    dt: number,
    elapsed: number,
  ): void {
    // 14.3 最后一条 + 低画质补偿：关键标记在远处和低画质下都要更大
    const scale = essentialMarkerScale(cameraDistance) * controlMarkerScale(quality);

    // W16 复活保护：地环缓转 + 关键标记同一套远近缩放（不看画质 —— essential）
    if (this.spawnProtected) {
      this.spawnRing.rotation.z = elapsed * 0.8;
      this.spawnRing.scale.setScalar(essentialMarkerScale(cameraDistance));
    }

    for (const [kind, mesh] of this.control) {
      const on = active.has(kind);
      mesh.visible = on;
      if (!on) continue;
      mesh.scale.setScalar(scale);
      /**
       * ★ 按**施加它的技能的学派**染色（冰系定身冰蓝、自然系翠绿）。
       *   与 `setShield(…, color?)` 完全同构：查不到就退回 `CONTROL_VISUALS`
       *   里的中性常量 —— 编一个颜色比不画更糟。
       * ★★ 无障碍安全：17.2 的「不能只靠颜色」由 `distinguishingChannels`
       *   （锚点/形状/字形/运动四通道）保证，而**颜色本来就不在那四条里**，
       *   所以加学派色是纯增量，不会削弱任何区分度。
       */
      const tint = active.get(kind);
      (mesh.material as THREE.MeshBasicMaterial).color.set(
        tint ?? CONTROL_VISUALS[kind].color,
      );
      applyMotion(mesh, CONTROL_VISUALS[kind].motion, elapsed, anchorY(CONTROL_VISUALS[kind].anchor));
    }

    if (this.burstRemaining > 0) this.burstRemaining -= dt;
    if (this.burstRemaining <= 0) this.burstState = null;

    /**
     * X7：自然过期的**收束**淡出。
     * ★ 「收束」= 一边缩一边淡（缩到**起点尺寸的 0.72 倍** —— 起点由四态的
     *   motion 决定，衰减态本来就已经收薄到 0.88，收束是在它之上继续往里收），
     *   不是单纯把 alpha 拉到 0：
     *   只淡出读作「护罩变透明了」，缩起来才读作「护罩收回去了」——
     *   与破裂的 `shatter`（1.35 胀开）在**方向上**正好相反，
     *   哪怕玩家没看清也能从「往里收还是往外炸」分辨出发生了什么。
     */
    if (this.expireRemaining > 0) {
      this.expireRemaining -= dt;
      if (this.expireRemaining <= 0) {
        this.expireRemaining = 0;
        this.shell.visible = false;
        this.shownState = null;
      } else {
        const t = 1 - this.expireRemaining / SHIELD_EXPIRE_FADE; // 0 → 1
        this.shell.scale.setScalar(this.expireFrom.scale * (1 - 0.28 * t));
        this.shieldInnerMat.opacity = this.expireFrom.inner * (1 - t);
        this.shieldOuterMat.opacity = this.expireFrom.outer * (1 - t);
      }
    }

    /**
     * 壳体内外**反向**缓转。★ 两层反转是「这是个在运转的护罩」最短的表达 ——
     * 静止的球读作贴图，转起来才读作力场。衰减态转速减半（快没劲了）。
     */
    if (this.shell.visible) {
      const slow = this.shownState === ShieldState.Decaying ? 0.5 : 1;
      this.shellSpin += dt * slow;
      this.shieldInner.rotation.y = this.shellSpin * 0.35;
      this.shieldOuter.rotation.y = -this.shellSpin * 0.22;
    }

    // X30：debuff 学派色壳（与控制标记同一个时钟，场景不需要多喂一次）
    this.advanceDebuffShell(dt, cameraDistance);
  }

  /**
   * 护盾的持续态。传 undefined 表示没有护盾。
   *
   * ★ 14.3 要求四种反馈，其中「承伤」和「破裂」是事件，
   *   由 `flashAbsorb()` / `flashBroken()` 触发，不走这里。
   * ★ X7：盾**自然过期**（remaining 变成 undefined）时壳不再瞬间消失，
   *   而是走 0.3 秒收束淡出，由 `update()` 推进 —— 见 `SHIELD_EXPIRE_FADE`。
   *
   * @param color 盾的学派色（由调用方从 auraId 解析）。★ 缺省退到中性金 ——
   *   此前这里写死金色，八职业的盾长得一模一样，冰盾也是金的。
   */
  setShield(
    remaining: number | undefined, initial: number, cameraDistance: number, color?: number,
  ): void {
    if (remaining === undefined || (remaining <= 0 && this.burstState !== ShieldState.Broken)) {
      /**
       * X7：盾没了。两条出路，按**原因**分：
       *   · 破裂（`brokenLatch`）→ 立刻收掉，碎片表现已经演完（见 SHIELD_EXPIRE_FADE）
       *   · 自然过期        → 起 0.3 秒收束淡出，由 `update()` 推进
       * ★ 只在壳**当前还看得见**时起淡出：没有盾的角色每帧都会走到这一行
       *   （`shieldOf` 返回 undefined），不加这道判断就是每帧重置计时器，
       *   淡出永远走不完 —— 而它「看起来是对的」，因为壳确实不见了。
       */
      if (this.shell.visible && !this.brokenLatch && this.expireRemaining <= 0) {
        this.expireRemaining = SHIELD_EXPIRE_FADE;
        this.expireFrom = {
          inner: this.shieldInnerMat.opacity,
          outer: this.shieldOuterMat.opacity,
          scale: this.shell.scale.x,
        };
      }
      if (this.expireRemaining <= 0) {
        this.shell.visible = false;
        this.shownState = null;
        this.brokenLatch = false;
      }
      return;
    }
    /**
     * 盾**真的还在**（remaining > 0，新的一层）：过期淡出与破裂闩一起作废。
     *
     * ⚠️ `remaining > 0` 这个条件不是多余的保险 —— 少了它就是一个 bug，
     *   而且是单测抓出来的：破裂之后场景每帧仍喂 `setShield(0, …)`，
     *   这一帧因为 `burstState === Broken` 会**走到这里**（不是上面的早退分支），
     *   于是破裂闩在演出的第一帧就被自己清掉；等 0.4 秒的 shatter 结束、
     *   `burstState` 归 null 之后，下一次 `setShield(0)` 就分不出
     *   「刚被打碎」和「时间到了」，破裂的壳也跟着走 0.3 秒淡出 ——
     *   X7 要保留的语义区分当场丢失，而画面上只是「碎得有点软」，没人会报。
     */
    if (remaining > 0) {
      this.expireRemaining = 0;
      this.brokenLatch = false;
    }
    const state = this.burstState ?? shieldStateFor(remaining, initial);
    const v = SHIELD_VISUALS[state];
    this.shell.visible = true;
    this.shownState = state;

    const tint = color ?? SHIELD_FALLBACK_COLOR;
    this.shieldInnerMat.color.set(tint);
    this.shieldOuterMat.color.set(tint);

    // ★ 验收 #49：第一人称下把护盾压到 0.25 以下，但**不关掉**
    const base = closeUpOpacity('shield', v.opacity, cameraDistance);
    // 内层薄、外层亮 —— 亮的是轮廓，实心部分不能糊住角色
    this.shieldInnerMat.opacity = base * 0.5;
    this.shieldOuterMat.opacity = base * 0.95;

    /**
     * 四态的 `motion` 此前**只影响不透明度**（数据里定义了四种运动，
     * 渲染层一种都没做）。现在真的落地：
     *   steady   慢转
     *   flash    一瞬间胀大提亮（承伤）
     *   thin     收薄 + 转速减半（快破了）
     *   shatter  快速胀开（破裂）
     */
    const scale =
      v.motion === 'thin' ? 0.88
        : v.motion === 'flash' ? 1.12
          : v.motion === 'shatter' ? 1.35
            : 1;
    this.shell.scale.setScalar(scale);
  }

  /** 当前是否在画护盾壳（自检用）*/
  get shieldVisible(): boolean {
    return this.shell.visible;
  }

  /** 当前护盾处于四态里的哪一态（自检用）。★ 过期淡出期间仍报最后那一态 */
  get shieldState(): ShieldState | null {
    return this.shell.visible ? this.shownState : null;
  }

  /**
   * X7：当前是否正在走「自然过期」的收束淡出（自检 / 单测用）。
   * ★ 破裂路径恒为 false —— 这个 getter 就是那条语义区分的观测口。
   */
  get shieldExpiring(): boolean {
    return this.expireRemaining > 0;
  }

  /**
   * 壳体当前缩放（自检 / 单测用）。
   * ★ 四态的 `motion` 与 X7 的收束**都写在这一个通道上**（thin 0.88 /
   *   flash 1.12 / shatter 1.35 / 过期收束一路缩到 0.72），
   *   所以「往里收还是往外炸」这件事有一个可断言的出口。
   */
  get shieldShellScale(): number {
    return this.shell.scale.x;
  }

  /** 14.3：护盾**承伤**——一次闪光。与「衰减」是两回事 */
  flashAbsorb(): void {
    this.burstState = ShieldState.Absorbing;
    this.burstRemaining = SHIELD_VISUALS.absorbing.durationSeconds;
  }

  /** 14.3：护盾**破裂**——比承伤更强更长的反馈 */
  flashBroken(): void {
    this.burstState = ShieldState.Broken;
    this.burstRemaining = SHIELD_VISUALS.broken.durationSeconds;
    // X7：闩上「这次是被打碎的」。破裂不走过期淡出 —— 见 SHIELD_EXPIRE_FADE 的 ★★
    this.brokenLatch = true;
    this.expireRemaining = 0;
  }

  dispose(): void {
    for (const m of this.control.values()) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.shieldInner.geometry.dispose();
    this.shieldOuter.geometry.dispose();
    this.shieldInnerMat.dispose();
    this.shieldOuterMat.dispose();
    this.debuffFill.geometry.dispose();
    this.debuffRim.geometry.dispose();
    this.debuffFillMat.dispose();
    this.debuffRimMat.dispose();
  }
}

/** 各控制状态的运动方式。静止时两种控制容易看混，运动是重要的区分通道 */
const applyMotion = (
  mesh: THREE.Mesh,
  motion: string,
  t: number,
  baseY: number,
): void => {
  switch (motion) {
    case 'orbit':
      mesh.position.x = Math.cos(t * 3) * 0.22;
      mesh.position.z = Math.sin(t * 3) * 0.22;
      mesh.position.y = baseY;
      break;
    case 'spin':
      mesh.rotation.y = t * 2;
      break;
    case 'pulse':
      mesh.scale.multiplyScalar(1 + Math.sin(t * 5) * 0.08);
      break;
    case 'shake':
      mesh.position.x = Math.sin(t * 22) * 0.03;
      break;
    case 'drift':
      mesh.position.y = baseY + Math.sin(t * 1.6) * 0.12;
      mesh.rotation.y = t * 0.8;
      break;
    default:
      break;
  }
};
