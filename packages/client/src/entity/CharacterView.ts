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
import { GEOMETRY } from '@wowpvp/shared';
import { AnimState } from './AnimationController.js';
import { ModelLibrary, type CharacterModel } from './ModelLibrary.js';

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
    const r = GEOMETRY.HITBOX_RADIUS;
    const h = GEOMETRY.HITBOX_HEIGHT;

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
      new THREE.SphereGeometry(0.22, 12, 10),
      new THREE.MeshLambertMaterial({ color: 0xe8d0b0 }),
    );
    head.position.y = h - 0.2;
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

    // 战斗碰撞体线框（F1 切换）。13.2：所有职业一致
    this.hitboxHelper = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.CylinderGeometry(r, r, h, 16, 1, true)),
      new THREE.LineBasicMaterial({ color: 0xff4488 }),
    );
    this.hitboxHelper.position.y = h / 2;
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

  /** 施法时的上身动作覆盖（只覆盖 Idle，见 CASTING_CLIP 注释） */
  setCasting(on: boolean): void {
    if (this.casting === on) return;
    this.casting = on;
    this.applyClip();
  }

  /** 受击反馈：0.12 秒的白闪。14.1 命中反馈的模型侧通道 */
  flashHit(): void {
    this.flashLeft = 0.12;
  }

  /** 每帧推进动画与受击闪光。没挂模型时是空操作 */
  update(dt: number): void {
    this.mixer?.update(dt);
    if (this.flashLeft > 0) {
      this.flashLeft = Math.max(0, this.flashLeft - dt);
      const k = this.flashLeft / 0.12; // 最后一步 k=0，恰好把 emissive 归零
      for (const m of this.flashMats) m.emissive.setScalar(k * 0.85);
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
  }

  setHitboxVisible(v: boolean): void {
    this.hitboxHelper.visible = v;
  }

  // ── 内部：把（状态 × 施法）合成到一个动画片段 ────────────────
  private applyClip(): void {
    if (!this.mixer || !this.model) return;
    const spec = CLIP[this.state];
    const name =
      this.casting && this.state === AnimState.Idle ? CASTING_CLIP : spec.name;

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
