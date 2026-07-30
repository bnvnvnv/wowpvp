/**
 * 客户端预测与纠正。docs/08 §5 的七步。
 *
 * ★★ **整个设计成立的前提只有一条：第 6 步的重放用的是和服务器
 *   完全相同的那份 `shared/sim/movement`，而且步长也相同。**
 *
 *   前半句是 docs/08 §5 的原话（「这也是 packages/shared 必须零依赖的原因之一」）。
 *   后半句是 A3 收尾时定下的**固定指令帧**契约：客户端每个服务器 tick
 *   采样并发送恰好一条指令，预测积分用 `SIM.TICK_DT`，服务器也用 `SIM.TICK_DT`。
 *
 *   为什么后半句同样是前提：`stepMovement` 有加速度，**「一大步」≠「三小步」**。
 *   如果客户端按渲染帧（60fps，dt=1/60）预测三步而服务器按 50ms 积一步，
 *   两边就算跑同一份代码也会得到不同的位置，于是每一帧都在纠正 ——
 *   表现是角色持续轻微抽动，而且**查不出来**，因为两边代码确实是同一份。
 *
 * ★ 只预测**自己的移动**。技能效果一律等服务器确认（docs/08 §5 开头）——
 *   预测伤害会导致「打出去了又收回」，而目标制战斗的技能延迟本来就有
 *   施法条掩盖。所以本文件里没有任何效果结算。
 */

import {
  SIM,
  add,
  distance,
  scale,
  stepMovement,
  sub,
  vec3,
  type Aabb,
  type InputMessage,
  type MovementInput,
  type MovementState,
  type SelfMovementSnapshot,
  type Vec3,
} from '@wowpvp/shared';

/** 纠正的三档处理。单位：米 */
export const CORRECTION = {
  /**
   * 小于这个值就当没偏 —— 直接采用权威值，不做任何平滑。
   * ★ 亚厘米级的偏差每 tick 都会有（浮点），为它启动平滑只会让位置永远在动。
   */
  IGNORE_BELOW: 0.02,
  /**
   * 大于这个值**不平滑，直接瞬移**。
   *
   * ★★ 13.4：「传送、位置纠正和大位移不能被识别为高速跑步。」
   *   闪现 20 米、被击退、复活 —— 这些是**真的瞬移**，平滑过去会让角色
   *   以几十米每秒滑行，而 `AnimationController` 会把那个速度判成冲刺。
   *   取和 sim 同一个阈值，两边对「什么算瞬移」的判断才一致。
   */
  SNAP_ABOVE: 3,
  /** 平滑档的收敛时间，秒。取插值缓冲同值，两种平滑的观感才一致 */
  SMOOTH_SECONDS: SIM.INTERP_DELAY,
} as const;

interface Pending {
  seq: number;
  input: MovementInput;
}

/** 快照里自己的权威状态。`movement` 缺失时沿用本地速度（见 `reconcile`）*/
export interface AuthoritativeState {
  position: Vec3;
  yaw: number;
  movement?: SelfMovementSnapshot;
}

export interface PredictorOptions {
  obstacles: readonly Aabb[];
  radius?: number;
  height?: number;
}

export class Predictor {
  /** 已发出、服务器还没确认的指令。第 4 步按 ackSeq 裁剪 */
  private pending: Pending[] = [];
  private seq = 0;
  /** 预测出来的权威态（不含平滑偏移）*/
  private predicted: MovementState;
  /**
   * 尚未消化完的纠正量。**只影响渲染，不影响预测**。
   *
   * ★ 分开是关键：把平滑偏移混进 `predicted` 的话，下一次重放会从一个
   *   「为了好看而挪过的」位置出发，误差会累积并自我放大。
   */
  private smoothing: Vec3 = vec3(0, 0, 0);

  constructor(initial: MovementState, private readonly opts: PredictorOptions) {
    this.predicted = initial;
  }

  /** 当前预测的权威位置（不含平滑偏移）。发给服务器/做碰撞判断用这个 */
  get position(): Vec3 { return this.predicted.position; }
  get yaw(): number { return this.predicted.yaw; }
  get state(): MovementState { return this.predicted; }
  /** 还没被确认的指令条数。调试与测试用 */
  get pendingCount(): number { return this.pending.length; }

  /**
   * 第 1–3 步：采一帧指令 → 立刻本地推进 → 入队并返回要发送的消息。
   *
   * ★ 每个**指令帧**调一次（20Hz），不是每个渲染帧调一次。见文件头。
   */
  sample(input: MovementInput): InputMessage {
    this.seq++;
    this.predicted = stepMovement(
      this.predicted, input, SIM.TICK_DT, this.opts.obstacles,
      { ...(this.opts.radius !== undefined ? { radius: this.opts.radius } : {}),
        ...(this.opts.height !== undefined ? { height: this.opts.height } : {}) },
    ).state;
    this.pending.push({ seq: this.seq, input });

    return {
      t: 'Input',
      seq: this.seq,
      // ★ 如实上报本次积分用的步长。服务器**不会采信它**（它用自己的 TICK_DT），
      //   但发一个假的没有任何好处，而发真的让抓包调试能对上账
      dt: SIM.TICK_DT,
      forward: input.forward,
      strafe: input.strafe,
      characterYaw: input.yaw,
      jump: input.jump,
    };
  }

  /**
   * 第 4–7 步：收到快照后对账。
   *
   * @param auth 快照里自己的权威状态。★ **必须包含速度等积分输入**，见下。
   * @param ackSeq 服务器已确认到第几号指令
   * @param teleported 服务器说这一 tick 是瞬移过来的（13.4）
   */
  reconcile(auth: AuthoritativeState, ackSeq: number, teleported = false): void {
    const before = this.predicted.position;

    // 第 4 步：丢弃已确认的
    this.pending = this.pending.filter((p) => p.seq > ackSeq);

    /**
     * 第 5 步：重置为权威状态。
     *
     * ★★ **不能只重置位置。** `stepMovement` 有加速度，下一步的位移取决于
     *   当前**速度**；是否着地、空中速度上限、起跳高度同样参与积分。
     *   只覆盖 position 而沿用本地的当前速度，等于「从正确的位置、
     *   错误的速度」开始重放 —— 每次对账都差一点点，看起来像网络抖动。
     *   这就是 `EntitySnapshot.selfMovement` 存在的原因。
     *
     * ★ 服务器没给 selfMovement 时**沿用本地速度**：那多半是老快照或
     *   非移动驱动的实体，沿用比清零好（清零会让角色一顿）。
     */
    let s: MovementState = {
      ...this.predicted,
      position: vec3(auth.position.x, auth.position.y, auth.position.z),
      yaw: auth.yaw,
      ...(auth.movement
        ? {
            velocity: { ...auth.movement.velocity },
            grounded: auth.movement.grounded,
            airSpeedCap: auth.movement.airSpeedCap,
            fallStartY: auth.movement.fallStartY,
          }
        : {}),
    };

    // 第 6 步：重放剩余指令 —— 用**同一份** movement，**同一个**步长
    for (const p of this.pending) {
      s = stepMovement(
        s, p.input, SIM.TICK_DT, this.opts.obstacles,
        { ...(this.opts.radius !== undefined ? { radius: this.opts.radius } : {}),
          ...(this.opts.height !== undefined ? { height: this.opts.height } : {}) },
      ).state;
    }
    this.predicted = s;

    // 第 7 步：偏差处理
    const drift = distance(before, s.position);

    /**
     * ★★ 服务器说这是瞬移，或者偏差本来就大到不可能是预测误差 → **不平滑**。
     *   平滑一次 20 米的闪现会让角色滑过去，动画状态机判成冲刺（13.4）。
     *   注意两个条件是**或**：服务器的 `teleported` 是权威依据，
     *   而距离阈值兜住「服务器没标记但确实跳了一大截」的情况（例如连续丢包
     *   之后一次性对账）—— 那种同样不该滑。
     */
    if (teleported || drift > CORRECTION.SNAP_ABOVE) {
      this.smoothing = vec3(0, 0, 0);
      return;
    }

    if (drift < CORRECTION.IGNORE_BELOW) {
      this.smoothing = vec3(0, 0, 0);
      return;
    }

    // 中间档：把「原本画在哪」和「现在应该在哪」的差记下来，逐帧还回去
    this.smoothing = sub(before, s.position);
  }

  /**
   * 渲染位置：预测位置 + 尚未消化完的纠正量。
   *
   * ★ 每个**渲染帧**调一次，传渲染 dt。它只动 `smoothing`，不动 `predicted` ——
   *   见 `smoothing` 的注释。
   */
  renderPosition(dt: number): Vec3 {
    if (dt > 0) {
      const decay = Math.max(0, 1 - dt / CORRECTION.SMOOTH_SECONDS);
      this.smoothing = scale(this.smoothing, decay);
    }
    return add(this.predicted.position, this.smoothing);
  }

  /**
   * 重连后的硬复位：丢弃全部本地状态。
   *
   * ★ docs/08 §6：「下发完整快照，客户端**丢弃所有本地状态**」——
   *   `reconnect.ts` 把 `fullSnapshotRequired` 写死成 `true` 就是为了这件事。
   *   增量恢复会让客户端带着一份已经错了的预测继续跑。
   */
  reset(state: MovementState): void {
    this.predicted = state;
    this.pending = [];
    this.smoothing = vec3(0, 0, 0);
    // ★ seq 不清零：服务器的 ackSeq 是单调的，清零会让它把新指令当成旧的丢掉
  }
}
