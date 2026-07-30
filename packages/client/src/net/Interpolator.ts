/**
 * 其他玩家的位置插值。docs/08 §5 末段、规格书 13.4。
 *
 * ★ 其他玩家的位置**不预测** —— 预测别人要猜他的输入，猜错的代价是
 *   「他明明在那却打不到」。改用 100ms 延迟缓冲：始终渲染
 *   `now - INTERP_DELAY` 时刻的状态，两个快照之间插值。
 *   代价是看到的别人比真实晚 100ms，而这对目标制战斗是可接受的
 *   （命中判定在服务器，不在你看到的那一帧）。
 *
 * ★★ **13.4 是硬要求，而且它正是这个文件最容易写错的地方：**
 *   「传送、位置纠正和大位移不能被识别为高速跑步。」
 *
 *   插值器天然会把「两帧之间位置差了 20 米」画成「用 400 米/秒滑过去」——
 *   而 `AnimationController` 是**按位移速度**判跑/冲刺的，于是一次闪现
 *   会让远端角色播出冲刺动画并滑行。所以遇到瞬移必须**直接跳过去**，
 *   不插值。判据用服务器给的 `EntitySnapshot.teleported`（权威），
 *   距离阈值只是兜底。
 */

import {
  SIM,
  lerp,
  distance,
  type EntityId,
  type EntitySnapshot,
  type Vec3,
} from '@wowpvp/shared';

/** 超过这个距离（米）即便服务器没标记也当瞬移处理。与 sim 的阈值同值 */
const SNAP_DISTANCE = 3;

/** 缓冲里保留多久的历史，秒。★ 至少要 2 倍缓冲时长，否则插值会时不时没有下界 */
const HISTORY_SECONDS = SIM.INTERP_DELAY * 4;

interface Frame {
  /** 服务器时间，秒 */
  time: number;
  entities: Map<EntityId, EntitySnapshot>;
}

/** 一个实体在渲染时刻的插值结果 */
export interface InterpolatedEntity {
  snapshot: EntitySnapshot;
  position: Vec3;
  yaw: number;
  /**
   * 这一帧是瞬移过来的 —— 表现层据此**跳过**移动动画判定（13.4）。
   * ★ 必须往上传：`AnimationController` 收到它才知道「这不是跑步」。
   */
  teleported: boolean;
}

export class Interpolator {
  private frames: Frame[] = [];

  /** 收到一份快照 */
  push(time: number, entities: readonly EntitySnapshot[]): void {
    const map = new Map<EntityId, EntitySnapshot>();
    for (const e of entities) map.set(e.id, e);

    // ★ 乱序到达的旧快照直接丢 —— 插进去会让插值来回跳
    const last = this.frames[this.frames.length - 1];
    if (last && time <= last.time) return;

    this.frames.push({ time, entities: map });

    const cutoff = time - HISTORY_SECONDS;
    while (this.frames.length > 2 && this.frames[0]!.time < cutoff) this.frames.shift();
  }

  /**
   * 取 `serverNow - INTERP_DELAY` 时刻的插值结果。
   *
   * @param serverNow 客户端估计的当前服务器时间
   * @param exclude 不插值的实体（自己 —— 自己走预测，见 Predictor）
   */
  sample(serverNow: number, exclude?: EntityId): InterpolatedEntity[] {
    const target = serverNow - SIM.INTERP_DELAY;
    const out: InterpolatedEntity[] = [];
    if (this.frames.length === 0) return out;

    // 找出夹住 target 的两帧
    let older: Frame | undefined;
    let newer: Frame | undefined;
    for (const f of this.frames) {
      if (f.time <= target) older = f;
      else { newer = f; break; }
    }

    /**
     * 缓冲还没填满（刚进场）或者已经追过头（网络卡了）——
     * ★ 退化成「显示最后一帧」，而不是外推。
     *   外推猜的是别人的输入，猜错会让角色冲出去再被拉回来，
     *   而那个「拉回来」正是 13.4 要防的大位移。宁可短暂静止。
     */
    if (!older || !newer) {
      const f = older ?? this.frames[0]!;
      for (const e of f.entities.values()) {
        if (e.id === exclude) continue;
        out.push({ snapshot: e, position: e.position, yaw: e.yaw, teleported: e.teleported });
      }
      return out;
    }

    const span = newer.time - older.time;
    const t = span > 0 ? (target - older.time) / span : 1;

    for (const e of newer.entities.values()) {
      if (e.id === exclude) continue;
      const prev = older.entities.get(e.id);

      // 上一帧没有他（刚进入视野 / 刚从潜行现身）→ 直接放在当前位置，不插
      if (!prev) {
        out.push({ snapshot: e, position: e.position, yaw: e.yaw, teleported: true });
        continue;
      }

      /**
       * ★★ 13.4：瞬移不插值。
       *   `e.teleported` 是服务器的权威判断；距离阈值兜住「服务器没标记
       *   但确实跳了一大截」的情况（丢包后一次性对账）。
       */
      if (e.teleported || distance(prev.position, e.position) > SNAP_DISTANCE) {
        out.push({ snapshot: e, position: e.position, yaw: e.yaw, teleported: true });
        continue;
      }

      out.push({
        snapshot: e,
        position: lerp(prev.position, e.position, t),
        yaw: lerpAngle(prev.yaw, e.yaw, t),
        teleported: false,
      });
    }
    return out;
  }

  /** 重连后丢弃全部缓冲（docs/08 §6：客户端丢弃所有本地状态）*/
  reset(): void {
    this.frames = [];
  }
}

/**
 * 角度插值。★ 必须走最短弧 —— 直接 lerp 会让角色在 ±π 边界上
 * 「原地转一整圈」，而那同样是 13.4 说的「不该被识别为正常动作」的表现。
 */
export const lerpAngle = (a: number, b: number, t: number): number => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};
