/**
 * 角色的可视化表现。
 *
 * M1–M11 用程序化几何体（胶囊 + 盒子）；M12 起在其上按需挂真实模型：
 * 构造时立即出现胶囊体，模型异步加载完成后原位替换 —— 素材缺失、
 * 加载失败、或场景没 init 过 ModelLibrary 时，胶囊体就是最终外观。
 * ★ M1–M10 的 154 项验收因此不依赖素材存在。
 *
 * 13.2「所有人形职业使用大体一致的战斗碰撞体，不能因模型胖瘦获得命中优势」——
 * 碰撞体只存在于 shared 的 GEOMETRY 常量（sim 不读模型，结构性保证），
 * 视觉上模型在 ModelLibrary 里统一归一化到 HITBOX_HEIGHT（验收 #10）。
 */

import * as THREE from 'three';
import { BOSS_CLASS_ID, GEOMETRY } from '@wowpvp/shared';
import { AnimState } from './AnimationController.js';
import { ModelLibrary, type CharacterModel } from './ModelLibrary.js';
import { buildUpperBodyAdditive } from './animLayer.js';

/** 各动作状态的调试配色。模型加载前（或加载失败时）的兜底表现 */
const STATE_COLOR: Record<AnimState, number> = {
  [AnimState.Idle]: 0x7fa8d0,
  [AnimState.Walk]: 0x7fd0a8,
  [AnimState.Run]: 0x4fe08a,
  [AnimState.Backward]: 0xd0a87f,
  [AnimState.StrafeLeft]: 0xd0d07f,
  [AnimState.StrafeRight]: 0xd0d07f,
  [AnimState.Jump]: 0xe0e0ff,
  [AnimState.Fall]: 0xa0a0ff,
  [AnimState.Land]: 0xffd070,
  [AnimState.Stunned]: 0xff8040,
  [AnimState.Death]: 0x606060,
};

/**
 * 动作状态 → 动画片段。八个玩家模型共用同一套片段名（上游同一骨架）。
 *
 * ★ `loop: 'once'` 的两个都会停在最后一帧（clampWhenFinished）：
 *   死亡定格在倒地，重落地的 Hit_A 顶多播完 —— AnimationController
 *   的 Land 状态只持续 0.18s，随后自然切回 Idle。
 * ★ 昏迷用放慢的受击循环 —— 反复的踉跄读作「晕」，且与 14.3 的
 *   头顶标记（StatusMarkers）双通道并存，动画只是氛围不是信息。
 */
const CLIP: Record<AnimState, { name: string; loop?: 'once'; speed?: number; locomotion?: boolean }> = {
  [AnimState.Idle]: { name: 'Idle' },
  [AnimState.Walk]: { name: 'Walking_A', locomotion: true },
  [AnimState.Run]: { name: 'Running_A', locomotion: true },
  [AnimState.Backward]: { name: 'Walking_Backwards', locomotion: true },
  [AnimState.StrafeLeft]: { name: 'Running_Strafe_Left', locomotion: true },
  [AnimState.StrafeRight]: { name: 'Running_Strafe_Right', locomotion: true },
  [AnimState.Jump]: { name: 'Jump_Idle' },
  [AnimState.Fall]: { name: 'Jump_Idle' },
  [AnimState.Land]: { name: 'Hit_A', loop: 'once' },
  [AnimState.Stunned]: { name: 'Hit_A', speed: 0.55 },
  [AnimState.Death]: { name: 'Death_A', loop: 'once' },
};

/** 施法覆盖动画：只在站立不动时覆盖 Idle（移动时腿部优先，7.3 原地读条也多为站桩） */
const CASTING_CLIP = 'Spellcasting';

/**
 * 近战挥砍的候选片段，找到第一个存在的就用（上游同一骨架，片段名一致）。
 * 一个都没有时安静跳过 —— 挥砍是氛围，刀光/伤害反馈不依赖它（13.4「缺失
 * 专属动作时使用最接近的武器动作」，全缺就保持当前动作，绝不 T-pose）。
 */
const SWING_CLIPS = [
  '1H_Melee_Attack_Slice_Diagonal',
  '1H_Melee_Attack_Chop',
  '2H_Melee_Attack_Chop',
  // ★ A14：原第 4 项 'Unarmed_Melee_Attack_Punch_A' 在**任何**模型里都不存在
  //   （八个职业共用同一组 22 片段，逐一核对过）—— 死条目已删，
  //   按武器类型选片段（双持/远程）是 W14 动画分层批的事，别在这里预埋假名字
];

/**
 * 受击踉跄的最短间隔（秒）。12v12 里挨打频率能到每秒 3–4 次，
 * 不加冷却角色会永久踉跄 —— 破坏 13.4 的移动节奏可读性。
 */
const HIT_REACT_COOLDOWN = 0.35;
/** P6 程序化侧闪（闪避没有动画素材，见 playAvoidReact）：时长/横移/侧倾 */
const DODGE_DURATION = 0.18;
const DODGE_OFFSET = 0.3;
const DODGE_TILT = 0.16;

/**
 * 化形术的小动物。选 chicken_cow 不是审美偏好，是**测量诚实度**：
 * creatures 包里多数模型（frog/fox/alpaca…）是 meshopt 量化 + 蒙皮骨骼缩放，
 * `Box3.setFromObject` 对 SkinnedMesh 不算骨骼变换，量出的包围盒比渲染实高
 * 大好几倍 —— 归一化后青蛙只有 ~0.15 米，场上就是一粒橘色像素（实测）。
 * chicken_cow 是包里唯一几何高（0.85）与渲染高一致的：量多少渲染多少。
 * 变成小鸡也正好是「无害生物」的经典读法。
 */
const MORPH_CREATURE = 'chicken_cow';

/**
 * 大 BOSS 的**视觉**放大倍数。⚠️ 占位值 2.2 —— 取「一眼看出不是玩家」的最小
 * 倍数：2.0 米的人形放到 4.4 米，比场上任何职业都高出一头，又不至于把镜头挡死。
 * ★★ 它**只**乘在渲染几何上，碰撞体与任何判定都不乘（见构造函数的注释）。
 */
const BOSS_VISUAL_SCALE = 2.2;
/** ★ 从 shared 的注册表拿，不写字面量 —— 判据只有一处（`BOSS_CLASS_ID`）*/
const BOSS_CLASS_ID_STR = BOSS_CLASS_ID as string;

export class CharacterView {
  readonly group = new THREE.Group();
  /** 4.1 第一人称要隐藏的部分：胶囊阶段是头与躯干；模型阶段是整个模型 */
  private hideInFirstPerson: THREE.Object3D[] = [];
  private readonly bodyMat: THREE.MeshLambertMaterial;
  private readonly hitboxHelper: THREE.LineSegments;
  /** 朝向指示器，让「角色朝向 ≠ 镜头朝向」肉眼可辨（验收 #2）*/
  private readonly facingArrow: THREE.Mesh;
  /** 胶囊体部件，模型加载成功后整体移除 */
  private readonly capsuleParts: THREE.Object3D[] = [];

  // ── M12：模型与动画 ──────────────────────────────────────────
  private model: CharacterModel | undefined;
  private mixer: THREE.AnimationMixer | undefined;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  /** 当前片段名，供 `actions` 查找与 `setLocomotionTimeScale` */
  private currentClip = '';
  /** 片段名 + 播放配置的合成键，见 applyClip 里的注释 */
  private currentKey = '';
  private state: AnimState = AnimState.Idle;
  private casting = false;
  private locomotionScale = 1;
  private firstPerson = false;
  private disposed = false;
  /** 受击闪白：剩余秒数，update 里衰减 */
  private flashLeft = 0;
  private flashMats: THREE.MeshStandardMaterial[] = [];
  /** 换装是异步的：序号防止旧请求覆盖新请求 */
  private weaponSeq = 0;
  private pendingWeaponId: string | undefined;
  private weaponNodes: THREE.Object3D[] = [];

  constructor(classId?: string) {
    /**
     * ★★ **只有大 BOSS 的「视觉」变大，碰撞体一寸不变。**
     *
     *   13.2 / 验收 #10 的原话是「模型大小不改变碰撞体」—— 这里正是那条
     *   规则第一次被真正**用到**（此前八个职业本来就一样高，规则空转）。
     *   放大的是躯干与头（下面用 `s` 缩放的那几何体）与真实模型；
     *   `hitboxHelper` 线框**刻意不乘 `s`**：按 F1 打开时看到的就是
     *   「一个大块头站在一个普通碰撞体里」，这正是判定的真相。
     *
     * ⚠️ 服务器侧 BOSS 的 `radius`/`height` 就是 `GEOMETRY` 的那两个值
     *   （`createEntity` 全场统一）。它的「大」在规则上只体现为**武器触及
     *   距离 5 米**（`data/classes/boss.ts` 的 reach）—— 那是数据，不是几何。
     *   想让碰撞体也变大，得先给 `createEntity` 开一个口子，那会牵动软推开、
     *   视线与投射物判定，不是一个渲染改动能顺手做的事。
     */
    const s = classId === BOSS_CLASS_ID_STR ? BOSS_VISUAL_SCALE : 1;
    const r = GEOMETRY.HITBOX_RADIUS * s;
    const h = GEOMETRY.HITBOX_HEIGHT * s;

    this.bodyMat = new THREE.MeshLambertMaterial({ color: STATE_COLOR[AnimState.Idle] });

    // 躯干：胶囊，高度扣掉两端半球
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(r, h - r * 2 - 0.35, 6, 12), this.bodyMat);
    torso.position.y = (h - 0.35) / 2;
    torso.castShadow = true;
    this.group.add(torso);
    this.hideInFirstPerson.push(torso);
    this.capsuleParts.push(torso);

    // 头
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.22 * s, 12, 10),
      new THREE.MeshLambertMaterial({ color: s > 1 ? 0xd85a2a : 0xe8d0b0 }),
    );
    head.position.y = h - 0.2 * s;
    head.castShadow = true;
    this.group.add(head);
    this.hideInFirstPerson.push(head);
    this.capsuleParts.push(head);

    // 朝向箭头：贴地的一个楔形，指向角色正面（-Z）
    this.facingArrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.18, 0.5, 4),
      new THREE.MeshBasicMaterial({ color: 0xffcc44 }),
    );
    this.facingArrow.rotation.x = -Math.PI / 2;
    this.facingArrow.position.set(0, 0.05, -r - 0.3);
    this.group.add(this.facingArrow);

    /**
     * 战斗碰撞体线框（F1 切换）。13.2：所有职业一致 ——
     * ★ 用的是**未缩放**的 GEOMETRY，不是上面那对 `r`/`h`：
     *   它画的是判定，而判定对 BOSS 与对玩家逐位相同（见构造函数头注释）。
     */
    this.hitboxHelper = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.CylinderGeometry(
        GEOMETRY.HITBOX_RADIUS, GEOMETRY.HITBOX_RADIUS, GEOMETRY.HITBOX_HEIGHT, 16, 1, true,
      )),
      new THREE.LineBasicMaterial({ color: 0xff4488 }),
    );
    this.hitboxHelper.position.y = GEOMETRY.HITBOX_HEIGHT / 2;
    this.hitboxHelper.visible = false;
    this.group.add(this.hitboxHelper);

    if (classId) this.setClass(classId);
  }

  /**
   * 请求挂载职业模型。幂等：只有第一次调用生效。
   * 构造时职业未知的调用方（联网场景的字段初始化）可以事后再补。
   */
  setClass(classId: string): void {
    if (this.modelRequested) return;
    this.modelRequested = true;
    void this.attachModel(classId);
  }
  private modelRequested = false;

  /** 场景移除该视图时调用，取消在途的异步挂载 */
  dispose(): void {
    this.disposed = true;
  }

  /**
   * 归一化之后的**身体**高度；仍是胶囊体时返回 undefined。
   *
   * ★ 供 `verify:m12` 的验收 #10：八个职业的源模型比例各不相同，
   *   这个值必须全部等于 `GEOMETRY.HITBOX_HEIGHT` —— 否则「模型大小
   *   不改变碰撞体」就只剩 sim 侧成立，而玩家看到的是胖瘦不一的靶子。
   *
   * ⚠️ **在挂载时量一次并存下来，不是每次调用现算。**
   *   现算会把两样东西一起量进去：
   *     · 挂在 `handslot.*` 骨骼上的**武器** —— 长杖比人还高
   *     · 当前**动画姿势** —— 施法抬手时包围盒会长高
   *   实测牧师假人（长杖 + 施法循环）的实时包围盒在 1.976～2.149 之间摆动，
   *   而这跟「模型有没有被正确归一化」毫无关系。
   *   ★ 这是 `verify:m12` 第一次跑就暴露的：检测量错了对象，
   *     报出来的不是缺陷而是长杖在挥。
   */
  get modelHeight(): number | undefined {
    return this.bodyHeight;
  }
  private bodyHeight: number | undefined;

  /** 是否已经挂上真实模型（false = 仍是程序化胶囊体） */
  get hasModel(): boolean {
    return this.model !== undefined;
  }

  private async attachModel(classId: string): Promise<void> {
    const lib = ModelLibrary.instance;
    if (!lib) return;
    const m = await lib.characterFor(classId);
    if (!m || this.disposed) return;

    this.model = m;
    for (const part of this.capsuleParts) this.group.remove(part);
    this.hideInFirstPerson = [m.root];
    m.root.visible = !this.firstPerson;
    this.group.add(m.root);
    // 模型是异步挂上来的 —— 挂之前设过的体型要在这里补上（巨人化中途换模型）
    if (this.bodyScale !== 1) m.root.scale.setScalar(this.bodyScale);

    // ★ 就在这里量身高：**绑定姿势、尚未挂武器**（见 modelHeight 注释）
    const box = new THREE.Box3().setFromObject(m.root);
    this.bodyHeight = box.max.y - box.min.y;

    // 受击闪白的材质清单（逐实例克隆过，见 ModelLibrary）
    this.flashMats = [];
    m.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if ((mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
          this.flashMats.push(mat as THREE.MeshStandardMaterial);
        }
      }
    });

    this.mixer = new THREE.AnimationMixer(m.root);
    this.currentClip = '';
    this.currentKey = '';
    this.buildCastLayer(m);
    this.applyClip();

    if (this.pendingWeaponId !== undefined) {
      const id = this.pendingWeaponId;
      this.pendingWeaponId = undefined;
      this.setWeapon(id);
    }
  }

  setTransform(position: { x: number; y: number; z: number }, yaw: number): void {
    this.group.position.set(position.x, position.y, position.z);
    this.group.rotation.y = yaw;
  }

  setAnimState(state: AnimState): void {
    this.state = state;
    this.bodyMat.color.setHex(STATE_COLOR[state]);
    this.applyClip();
  }

  /** 13.4：腿部动作节奏与实际速度一致。只作用于移动类片段 */
  setLocomotionTimeScale(t: number): void {
    this.locomotionScale = t;
    const spec = CLIP[this.state];
    if (spec.locomotion && this.currentClip === spec.name) {
      const action = this.actions.get(spec.name);
      if (action) action.timeScale = t;
    }
  }

  /**
   * W14：从全身施法 clip 造「上半身叠加」动作 —— 一次，模型加载时。
   * ★ 造不出来（骨架无脊柱 / 缺 CASTING_CLIP）时 `castUpper` 留 undefined，
   *   `setCasting` 与 `applyClip` 会安全回落到旧的「只在 Idle 播施法」行为。
   */
  private buildCastLayer(m: CharacterModel): void {
    if (!this.mixer) return;
    const clip = THREE.AnimationClip.findByName(m.clips as THREE.AnimationClip[], CASTING_CLIP);
    if (!clip) return;
    const bones: THREE.Object3D[] = [];
    m.root.traverse((o) => { if ((o as THREE.Bone).isBone) bones.push(o); });
    /**
     * ★★ 参考姿势必须传 Idle：Spellcasting 是循环片段，第 0 帧就是施法
     *   姿态，以自己为参考的叠加增量 ≈ 0 —— 层在播但看不见（X10 实测）。
     *   Idle 缺失时宁可不建叠加层走全身兜底，也不建一个隐形层。
     */
    const idle = THREE.AnimationClip.findByName(
      m.clips as THREE.AnimationClip[], CLIP[AnimState.Idle].name,
    );
    if (!idle) return;
    const additive = buildUpperBodyAdditive(clip, bones, idle);
    if (!additive) return;
    const a = this.mixer.clipAction(additive, undefined, THREE.AdditiveAnimationBlendMode);
    a.setLoop(THREE.LoopRepeat, Infinity);
    a.play();
    a.setEffectiveWeight(0); // 常驻播放、平时权重 0，施法时淡入
    this.castUpper = a;
  }
  private castUpper: THREE.AnimationAction | undefined;

  /**
   * W14：施法的上半身表现。
   * ★ 有叠加层（`castUpper`）时：腿照跑，上半身**叠加**施法姿态淡入淡出 ——
   *   「跑动中施法无上半身表现」由此消除（总账 W14 的核心）。
   * ★ 没有叠加层时：回落旧行为（`applyClip` 里「Idle 才播 Spellcasting」）。
   */
  setCasting(on: boolean): void {
    if (this.casting === on) return;
    this.casting = on;
    if (this.castUpper) {
      this.castUpper.enabled = true;
      if (on) this.castUpper.fadeIn(0.15);
      else this.castUpper.fadeOut(0.15);
    }
    this.applyClip();
  }

  /**
   * 受击反馈：闪光。14.1 命中反馈的模型侧通道。
   * 打击感分档：普通 (0.85, 0.12)、重击 (1.1, 0.16)、暴击 (1.4, 0.2) ——
   * 由 HitFeedback 决定，这里只执行。
   *
   * @param color 这一击的学派色（由 `flashColorFor()` 给）。
   *   ★ 用户实测反馈「承受者不够酷炫」的根因就在这里：此前无论挨的是火球
   *     还是冰箭，模型都只会闪同一种白 —— 八属性视觉语言（14.2）在
   *     **受击方**这条通道上完全没有兑现，只活在粒子上。
   *   ★ 缺省仍是白：白不属于任何学派，留给暴击（见 `flashColorFor`）。
   */
  flashHit(strength = 0.85, seconds = 0.12, color = 0xffffff): void {
    this.flashStrength = strength;
    this.flashDuration = seconds;
    this.flashLeft = seconds;
    this.flashColor.setHex(color);
  }
  private flashStrength = 0.85;
  private flashDuration = 0.12;
  private readonly flashColor = new THREE.Color(0xffffff);

  /**
   * 受击踉跄：一次性覆盖动作（打击感改造，只在重击及以上触发）。
   *
   * ⚠️★★ **`Hit_A` 同时是 Land 与 Stunned 的片段**（见 CLIP 表），而
   *   `mixer.clipAction(clip)` 对同一个 clip 返回**同一个 AnimationAction
   *   对象**。在昏迷/落地状态下再 `setLoop(LoopOnce)` 一次，会把状态机
   *   自己那份循环**永久改坏**（人定格在受击最后一帧）。
   *   下面前三条守卫因此不是「体验优化」，是**正确性前提**。
   */
  playHitReact(): void {
    if (!this.mixer || !this.model) return;
    // ★ 正确性守卫：这三个状态本身就在用 Hit_A / Death_A
    if (
      this.state === AnimState.Stunned ||
      this.state === AnimState.Land ||
      this.state === AnimState.Death
    ) return;
    // ★ 7.3 / 验收 #14：普通伤害**不打断施法**。读条中踉跄一下，玩家会读成
    //   「我的法术被打断了」—— 那是对一条明确规则的误导。施法中被打走
    //   加强版闪白（HitFeedback 已给了更强的参数），模型通道不缺席。
    if (this.casting) return;
    if (this.morphed) return; // 变形中人形是隐藏的
    if (this.hitReactCooldown > 0) return;

    const clip = THREE.AnimationClip.findByName(
      this.model.clips as THREE.AnimationClip[], 'Hit_A',
    );
    if (!clip) return;
    this.hitReactCooldown = HIT_REACT_COOLDOWN;

    // 上一次的 finished 监听器还挂着（快速连续重击）→ 先清掉，防泄漏
    this.hitReactOff?.();

    const react = this.mixer.clipAction(clip);
    const current = this.actions.get(this.currentClip);
    react.reset();
    react.setLoop(THREE.LoopOnce, 1);
    react.clampWhenFinished = false;
    react.timeScale = 1.5; // 踉跄要「短促」—— 全速播读作被击倒
    if (current && current !== react) current.fadeOut(0.06);
    react.fadeIn(0.06);
    react.play();

    const onFinished = (e: { action: THREE.AnimationAction }): void => {
      if (e.action !== react) return;
      this.hitReactOff?.();
      react.fadeOut(0.1);
      // 与 playMeleeSwing 同一手法：不走 applyClip 去重、不 reset（见那边注释）
      const back = this.actions.get(this.currentClip);
      if (back) {
        back.enabled = true;
        back.paused = false;
        back.play();
        back.fadeIn(0.1);
      }
    };
    this.hitReactOff = () => {
      this.mixer?.removeEventListener('finished', onFinished as never);
      this.hitReactOff = undefined;
    };
    this.mixer.addEventListener('finished', onFinished as never);
  }
  private hitReactCooldown = 0;
  private hitReactOff: (() => void) | undefined;

  /**
   * P6：规避反应 —— 此前闪避/招架/格挡只有浮字 + 音效，模型纹丝不动
   * （用户实测「闪避未命中不知道做了没」）。
   *
   * · 招架/格挡 → `Block` 片段（八个玩家模型全都有，GLB 逐个验过）：
   *   抬手格挡的读法对两者都成立
   * · 闪避 → **没有素材**（上游包里没有 Dodge 片段），用程序化侧闪顶上：
   *   0.18s 内往侧向偏 ~0.3m 再回位 + 轻微侧倾，左右交替免得读成循环贴图。
   *   将来素材到位，换片段的落点就在这里。
   *
   * 守卫与 playHitReact 同一组（并共用冷却）：昏迷/落地/死亡状态不播
   * （Hit_A/状态机正确性）、施法中不播 —— 施法中被规避看起来像被打断，
   * 会误导 7.3 的「普通伤害不打断施法」。
   */
  playAvoidReact(kind: 'dodge' | 'parry' | 'block'): void {
    if (
      this.state === AnimState.Stunned ||
      this.state === AnimState.Land ||
      this.state === AnimState.Death
    ) return;
    if (this.casting || this.morphed) return;
    if (this.hitReactCooldown > 0) return;
    this.hitReactCooldown = HIT_REACT_COOLDOWN;

    if (kind === 'dodge') {
      const root = this.model?.root;
      if (!root) return; // 胶囊兜底没有可位移的骨架 —— 浮字与音效通道仍在
      this.dodgeElapsed = 0;
      this.dodgeDir = this.dodgeFlip ? 1 : -1;
      this.dodgeFlip = !this.dodgeFlip;
      this.dodgeBaseX = root.position.x;
      this.dodgeBaseTilt = root.rotation.z;
      return;
    }

    // 招架/格挡：与 playHitReact 同构的一次性覆盖（Block 片段）
    if (!this.mixer || !this.model) return;
    const clip = THREE.AnimationClip.findByName(
      this.model.clips as THREE.AnimationClip[], 'Block',
    );
    if (!clip) return;
    this.avoidOff?.();

    const react = this.mixer.clipAction(clip);
    const current = this.actions.get(this.currentClip);
    react.reset();
    react.setLoop(THREE.LoopOnce, 1);
    react.clampWhenFinished = false;
    react.timeScale = 1.7; // 格挡要「弹」—— 抬手即回，拖长了像摆姿势
    if (current && current !== react) current.fadeOut(0.05);
    react.fadeIn(0.05);
    react.play();

    const onFinished = (e: { action: THREE.AnimationAction }): void => {
      if (e.action !== react) return;
      this.avoidOff?.();
      react.fadeOut(0.08);
      const back = this.actions.get(this.currentClip);
      if (back) {
        back.enabled = true;
        back.paused = false;
        back.play();
        back.fadeIn(0.08);
      }
    };
    this.avoidOff = () => {
      this.mixer?.removeEventListener('finished', onFinished as never);
      this.avoidOff = undefined;
    };
    this.mixer.addEventListener('finished', onFinished as never);
  }
  private avoidOff: (() => void) | undefined;
  /** 程序化侧闪的进度（undefined = 不在闪）。基准值开闪时记录、闪完恢复 */
  private dodgeElapsed: number | undefined;
  private dodgeDir = 1;
  private dodgeFlip = false;
  private dodgeBaseX = 0;
  private dodgeBaseTilt = 0;

  /**
   * 近战挥砍：一次性覆盖动作，播完自动回到状态机当前片段。
   * ★ 素材缺片段时安静跳过 —— 刀光与伤害反馈不依赖它（M12 逐层兜底）。
   */
  playMeleeSwing(): void {
    if (!this.mixer || !this.model) return;
    const clips = this.model.clips as THREE.AnimationClip[];
    const clip = SWING_CLIPS
      .map((n) => THREE.AnimationClip.findByName(clips, n))
      .find((c): c is THREE.AnimationClip => c !== null && c !== undefined);
    if (!clip) return;

    const swing = this.mixer.clipAction(clip);
    const current = this.actions.get(this.currentClip);
    swing.reset();
    swing.setLoop(THREE.LoopOnce, 1);
    swing.clampWhenFinished = false;
    swing.timeScale = 1.3; // 稍快：出拳/挥砍要「脆」
    if (current && current !== swing) current.fadeOut(0.07);
    swing.fadeIn(0.07);
    swing.play();

    // ★ 上一次挥砍的 finished 监听器可能还挂着（0.6 秒内连挥两刀 ——
    //   第一刀被 reset() 打断就永远不会 finished）→ 先清掉，防泄漏
    this.swingOff?.();
    const onFinished = (e: { action: THREE.AnimationAction }): void => {
      if (e.action !== swing) return;
      this.swingOff?.();
      swing.fadeOut(0.1);
      /**
       * 回到状态机当前片段。★ 不能走 `applyClip()` 的去重路径：那边
       * `prev === action` 时不做 fadeIn，而这个动作刚被 fadeOut 到权重 0 ——
       * 会定格成绑定姿势。也刻意不 `reset()`：动作在权重 0 期间时间照走，
       * 切回奔跑时步伐不跳帧。
       */
      const back = this.actions.get(this.currentClip);
      if (back) {
        back.enabled = true;
        back.paused = false;
        back.play();
        back.fadeIn(0.1);
      }
    };
    this.swingOff = () => {
      this.mixer?.removeEventListener('finished', onFinished as never);
      this.swingOff = undefined;
    };
    this.mixer.addEventListener('finished', onFinished as never);
  }
  private swingOff: (() => void) | undefined;

  // ── 化形术（8.2 迷惑）────────────────────────────────────────

  private morphNode: THREE.Group | undefined;
  private morphed = false;
  private morphLoading = false;

  /**
   * 被变形 ↔ 恢复。变形期间隐藏人形（连同手上武器），显示小动物。
   * ★ 素材缺失或 `?art=off`（ModelLibrary 没 init）时**什么都不做** ——
   *   被变形仍由头顶标记表达，画面精确保持 M11。
   */
  setMorphed(on: boolean): void {
    if (this.morphed === on) return;
    this.morphed = on;
    if (on && !this.morphNode && !this.morphLoading) {
      this.morphLoading = true;
      void ModelLibrary.instance?.creatureFor(MORPH_CREATURE, 0.9).then((g) => {
        this.morphLoading = false;
        if (!g || this.disposed) return;
        this.morphNode = g;
        this.group.add(g);
        this.applyMorphVisibility();
      });
    }
    this.applyMorphVisibility();
  }

  // ── 体型（大乱斗巨人化药水）──────────────────────────────────

  private bodyScale = 1;

  /**
   * 视觉体型倍数。1 = 常态，1.6 = 巨人化药水。
   *
   * ★★ **只放大模型，碰撞体一个字节都没变**（验收 #10：模型大小不改变碰撞体）。
   *   证据在代码结构里：`hitboxHelper` 与 `facingArrow` 是 `group` 的**兄弟**
   *   节点，这里缩放的是 `model.root` —— 想连碰撞体一起放大就得显式去改
   *   `GEOMETRY` 常量，而那在 shared 里、客户端够不着。
   *   规则侧的「变大更好打中」由光环的 `damageTaken` 表达（见 data/party.ts）。
   *
   * ★ 缩放挂在 `model.root`（`characterFor` 返回的 wrapper）上，不是它的子节点 ——
   *   子节点扛着 13.2 的身高归一化，动它会把「八职业视觉身高一致」搞坏。
   * ★ 没有模型（素材缺失 / `?art=off`）时**什么都不做**，与 `setMorphed` 同一条
   *   兜底规矩：胶囊体阶段的体型由头顶增益图标表达，画面不假装有这件事。
   */
  setBodyScale(scale: number): void {
    if (this.bodyScale === scale) return;
    this.bodyScale = scale;
    this.model?.root.scale.setScalar(scale);
  }

  private applyMorphVisibility(): void {
    const showCreature = this.morphed && this.morphNode !== undefined;
    if (this.morphNode) this.morphNode.visible = showCreature && !this.firstPerson;
    if (this.model) this.model.root.visible = !showCreature && !this.firstPerson;
    // 胶囊体阶段没有小动物可换（见 setMorphed 头注），不动 capsuleParts
  }

  /** 每帧推进动画与受击闪光 */
  update(dt: number): void {
    this.mixer?.update(dt);
    if (this.hitReactCooldown > 0) this.hitReactCooldown -= dt;
    // P6 程序化侧闪：sin 半波去-回，闪完恢复基准（模型根的 x/侧倾归位）
    if (this.dodgeElapsed !== undefined) {
      this.dodgeElapsed += dt;
      const root = this.model?.root;
      const t = this.dodgeElapsed / DODGE_DURATION;
      if (!root || t >= 1) {
        if (root) {
          root.position.x = this.dodgeBaseX;
          root.rotation.z = this.dodgeBaseTilt;
        }
        this.dodgeElapsed = undefined;
      } else {
        const k = Math.sin(Math.PI * t);
        root.position.x = this.dodgeBaseX + this.dodgeDir * DODGE_OFFSET * k;
        root.rotation.z = this.dodgeBaseTilt + this.dodgeDir * DODGE_TILT * k;
      }
    }
    if (this.flashLeft > 0) {
      this.flashLeft = Math.max(0, this.flashLeft - dt);
      const k = this.flashLeft / this.flashDuration; // 最后一步 k=0，恰好把 emissive 归零
      if (this.flashMats.length > 0) {
        // ★ copy + multiplyScalar 而不是 setScalar：k=0 时三通道同样归零，
        //   所以「闪完恢复原样」这条不变量没有变，只是中间过程带上了学派色
        for (const m of this.flashMats) {
          m.emissive.copy(this.flashColor).multiplyScalar(k * this.flashStrength);
        }
      } else {
        // ★ 胶囊兜底（模型未加载 / ?art=off）：Lambert 也有 emissive ——
        //   这条路径此前完全没有受击反馈，14.1 在 ?art=off 下少了一条通道
        this.bodyMat.emissive
          .copy(this.flashColor)
          .multiplyScalar(k * Math.min(1, this.flashStrength) * 0.6);
      }
    }
  }

  /** 15.2：目标框显示当前武器 —— 模型手上也拿着它（10.6 敌人可见当前武器） */
  setWeapon(weaponId: string | undefined): void {
    if (!this.model) {
      this.pendingWeaponId = weaponId;
      return;
    }
    const seq = ++this.weaponSeq;
    for (const n of this.weaponNodes) n.removeFromParent();
    this.weaponNodes = [];
    if (weaponId === undefined) return;

    void ModelLibrary.instance?.weaponFor(weaponId).then(({ right, left }) => {
      // 加载期间又换了一次装（10.7 换装 3 秒读条，但取消/反复换是常态）→ 丢弃旧结果
      if (seq !== this.weaponSeq || this.disposed || !this.model) return;
      if (right && this.model.handR) {
        this.model.handR.add(right);
        this.weaponNodes.push(right);
      }
      if (left && this.model.handL) {
        this.model.handL.add(left);
        this.weaponNodes.push(left);
      }
    });
  }

  /** 4.1 第一人称隐藏遮挡视线的头部和身体 */
  setFirstPerson(on: boolean): void {
    this.firstPerson = on;
    for (const o of this.hideInFirstPerson) o.visible = !on;
    // 朝向箭头保留 —— 它是地面指示器性质的信息，4.1 要求第一人称保留地面范围
    // ★ 变形显隐与第一人称共用 model.root.visible，必须最后统一裁决一次
    this.applyMorphVisibility();
  }

  setHitboxVisible(v: boolean): void {
    this.hitboxHelper.visible = v;
  }

  /**
   * 胜利庆祝（docs/14 §16a）。模型自带的 `Cheer` 片段**至今从未被播放过** ——
   * 22 个片段的清单里躺着一个零调用方的动作，零素材成本。
   *
   * ★★ **它会接管动画通道直到场景销毁**（`celebrating` 让 `applyClip` 短路）。
   *   这在别处会是个 bug，在这里是对的：对局已经结束，不再有快照进来，
   *   状态机没有任何新状态要表达。不短路的话，下一帧的 Idle 会把庆祝盖掉。
   * ★ 素材缺片段时安静跳过 —— 与 `playMeleeSwing` 同一条兜底规矩。
   */
  playCheer(): void {
    if (!this.mixer || !this.model || this.celebrating) return;
    const clip = THREE.AnimationClip.findByName(
      this.model.clips as THREE.AnimationClip[], 'Cheer',
    );
    if (!clip) return;

    this.celebrating = true;
    // 受击/挥砍的一次性覆盖此刻可能还挂着监听器 —— 先清掉，免得它把庆祝切走
    this.hitReactOff?.();

    const cheer = this.mixer.clipAction(clip);
    const prev = this.actions.get(this.currentClip);
    cheer.reset();
    cheer.setLoop(THREE.LoopRepeat, Infinity);
    if (prev && prev !== cheer) prev.fadeOut(0.2);
    cheer.fadeIn(0.2);
    cheer.play();
  }
  private celebrating = false;

  // ── 内部：把（状态 × 施法）合成到一个动画片段 ────────────────
  private applyClip(): void {
    if (!this.mixer || !this.model) return;
    // ★ 庆祝期间不再跟随状态机（见 playCheer 的注释）
    if (this.celebrating) return;
    const spec = CLIP[this.state];
    // ★ W14：有叠加层时基础层永远是 locomotion/idle（施法姿态走叠加，见
    //   setCasting）；没有叠加层才回落到旧的「Idle 全身播 Spellcasting」
    const name =
      this.casting && this.state === AnimState.Idle && !this.castUpper
        ? CASTING_CLIP : spec.name;

    /**
     * ★ 去重的键是「片段名 **+ 播放配置**」，不只是片段名。
     *
     *   两个方向都会出错：
     *   · 只看片段名 —— `Land` 与 `Stunned` **共用 `Hit_A`**，
     *     但前者是单次定格（clampWhenFinished）、后者是 0.55 倍速循环。
     *     落地后立刻被击晕会被判成「没变」，于是一直卡在定格的最后一帧。
     *   · 只看动作状态 —— `Jump` 与 `Fall` 共用 `Jump_Idle`，
     *     起跳到下落的那一刻会 `reset()` 重播，空中动作抖一下。
     */
    const key = `${name}|${spec.loop ?? ''}|${spec.speed ?? ''}|${spec.locomotion ? 'loco' : ''}`;
    if (key === this.currentKey) return;

    const prev = this.actions.get(this.currentClip);
    const action = this.action(name);
    if (!action) return;
    this.currentKey = key;
    this.currentClip = name;

    action.reset();
    action.loop = spec.loop === 'once' && name === spec.name ? THREE.LoopOnce : THREE.LoopRepeat;
    action.clampWhenFinished = action.loop === THREE.LoopOnce;
    action.timeScale = spec.locomotion && name === spec.name ? this.locomotionScale : (spec.speed ?? 1);
    if (prev && prev !== action) {
      prev.fadeOut(0.12);
      action.fadeIn(0.12);
    }
    action.play();
  }

  private action(name: string): THREE.AnimationAction | undefined {
    let a = this.actions.get(name);
    if (a) return a;
    const clip =
      THREE.AnimationClip.findByName(this.model!.clips as THREE.AnimationClip[], name) ??
      THREE.AnimationClip.findByName(this.model!.clips as THREE.AnimationClip[], 'Idle') ??
      this.model!.clips[0];
    if (!clip) return undefined;
    a = this.mixer!.clipAction(clip);
    this.actions.set(name, a);
    return a;
  }
}
