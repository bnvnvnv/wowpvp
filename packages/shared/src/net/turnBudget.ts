/**
 * A5：**转身速率的令牌桶**（技术债总账 A5 —— spinbot）。
 *
 * ★★ **它住在 shared 而不是 server，理由只有一条：客户端预测要用同一份。**
 *
 *   `Predictor` 的文件头写着整个设计成立的前提 ——「重放用的是和服务器
 *   完全相同的那份 `shared/sim/movement`」。服务器一旦有了一条**客户端
 *   没有的规则**（钳 yaw），这条前提就破了：客户端拿未钳的 yaw 积分、
 *   服务器拿钳过的积分，`stepMovement` 的朝向直接决定移动方向，位置必然
 *   分叉。实测（全速前进 + 匀速转身）：1440°/s 转 0.5 秒差 0.164 m、
 *   2880°/s 转 1 秒差 0.746 m —— 都落在 `CORRECTION.IGNORE_BELOW`(0.02)
 *   与 `SNAP_ABOVE`(3) 之间，于是**转身的每一个 tick 都在被往回拽**（橡皮筋）。
 *   所以钳制必须两边各跑一份、跑的是**同一个函数**。
 *
 * ★★ **为什么是令牌桶，不是「每 tick 一个硬上限」。**
 *
 *   硬上限（每 tick 最多转 36°）有两个洞，都不是边缘情况：
 *     · **真人的甩镜头是脉冲，不是匀速。** 指针锁定之后光标不再有屏幕边界
 *       （X15），一次 180° 转身就是 100-200ms 里一口气拖完 —— 瞬时角速度
 *       上千度每秒，硬上限当场误伤。而 `combat.ts` 自己写着：被误伤的表现是
 *       「我明明面向他，技能却说我没面向」，比作弊更难查。
 *     · **预算的时钟不能是「消息到达」。** 硬上限那版在 `MatchLoop` 里是
 *       「这一 tick 没有 Input 就 continue」，于是有效上限 = 36° × 本秒里
 *       **收到过 Input** 的 tick 数。而客户端天然是成对投递的：`GameLoop`
 *       一帧补 0..5 个固定步、每步发一条 `Input`，帧率低于 20fps 时两条
 *       Input 背靠背落在同一个服务器 tick 上，下一个 tick 是空的。
 *       实测（20 个 tick、600°/s，远低于 720°/s 的上限）：稳定投递落后 0°，
 *       **同样的 600°/s 改成成对投递，客户端转了 600°、服务器只转了 330°**
 *       —— 每秒再拉开 270°，而且持续转身期间**永远追不齐**。P4 这一批瞄准的
 *       正是 12-15fps 的机器，这条不修等于对低帧玩家单方面加了一道限速。
 *
 *   令牌桶把两件事分开：**持续速率**（桶的注入率）挡机械旋转，**桶容量**
 *   （瞬时透支）放过真人的一次甩镜头与低帧客户端的一次补步。空 tick 攒
 *   令牌、爆发 tick 花令牌 —— 时钟是 tick，不是消息。
 *
 * ★ 令牌桶不是新东西：S1 的消息限流用的就是它（`rateLimit.ts`，按秒注入）。
 *   这里按 tick 注入，因为朝向的采信本来就是每 tick 恰好一次。
 *
 * ⚠️ **如实说清它挡不住什么。** 桶满时（静止 250ms 之后）脚本客户端能瞬间
 *   转到任意角度一次 —— 因为 180° 就是「任意角度」的最大值。A5 挡的是
 *   **持续**机械旋转（spinbot 的定义：每 tick 都瞬移朝向，于是朝向门禁永远
 *   满足、背刺的「背后 120°」转身博弈对他不存在），不是一次性的瞄准；
 *   后者是 aimbot，从来不在这条闸的射程内。要它也挡住，代价就是误伤每一个
 *   甩镜头的真人 —— `combat.ts` 的取舍是「宁可放过一个转得飞快的真人」。
 */

import { SIM, TURN_RATE } from '../constants/combat.js';
import { DEG, wrapAngle } from '../math/index.js';

/**
 * 单个 tick 注入的令牌，弧度。720°/s × 50ms = 36° ≈ 0.6283 rad。
 * ★ 由 `TURN_RATE.MAX_DEG_PER_SEC` 与 `SIM.TICK_DT` 推导，不写死 ——
 *   改 tick 率时这条限速自动跟着走（它是角速度，不是每帧角度）。
 */
export const MAX_YAW_STEP_PER_TICK = TURN_RATE.MAX_DEG_PER_SEC * DEG * SIM.TICK_DT;

/** 桶容量，弧度。客户端口径 —— 玩家能感觉到的那条线就是这个数 */
export const TURN_BURST_RAD = TURN_RATE.BURST_DEG * DEG;

/**
 * 服务器的桶容量，弧度 = 客户端容量 + 余量。
 *
 * ★★ **为什么服务器要多留一点。** 两边的桶按各自的钟注入：客户端在
 *   `GameLoop` 的固定步里注入，服务器在 tick 里注入 —— 长期同为 20Hz，
 *   但 tick 边界不可能对齐（客户端一帧补两步的那一瞬，服务器可能只走了
 *   一个 tick）。少了这点余量就会出现「客户端自己已经钳过了、服务器还是
 *   要再钳一次」的分叉，而那正是本文件开头要消灭的东西。
 * ★ 余量取 `SLACK_TICKS`（= `takeInputs` 一 tick 最多吃的条数）。它换来的
 *   是「诚实客户端永远碰不到服务器那道闸」这个结构性保证；对脚本客户端
 *   多放的那点角度，与桶容量本身是同一个量级，不改变威胁模型。
 */
export const TURN_BURST_SERVER_RAD =
  TURN_BURST_RAD + TURN_RATE.SLACK_TICKS * MAX_YAW_STEP_PER_TICK;

/**
 * 一个席位的转身账本。
 *
 * ★★ `yaw` 记的是「客户端上次说了什么」，**不是 `entity.yaw`**。两者会分开，
 *   而分开的时候按前者才对：死亡之握把人拽过来、影袭把人挪到背后
 *   （`effects/displacement.ts` 会直接写 `source.yaw`）、化形游走替他走路 ——
 *   这些都是 **sim 自己**在改朝向，不是客户端的主张。拿 `entity.yaw` 当基准
 *   的话，玩家下一 tick 的正常输入会被判成「转太快」，于是他要花 250ms
 *   转回自己本来就朝着的方向 —— 白白为服务器自己的位移道歉。
 */
export interface TurnBudget {
  /** 上一次**被采信**的朝向。`undefined` = 这个席位还没交过朝向 */
  yaw: number | undefined;
  /** 桶里现有的令牌，弧度 */
  tokens: number;
  /** 桶容量，弧度 */
  readonly capacity: number;
}

/**
 * 开一个账本。★ **桶从满的开始**：开局第一下就甩镜头的玩家不该被钳，
 * 而多给脚本客户端的那一次爆发与他静止 250ms 之后拿到的完全一样。
 */
export const createTurnBudget = (capacity: number = TURN_BURST_RAD): TurnBudget => ({
  yaw: undefined,
  tokens: capacity,
  capacity,
});

/**
 * 注入一个 tick 的令牌。★★ **每个 tick 恰好调一次，不管这一 tick 有没有
 * 收到输入** —— 这正是「预算的时钟是 tick，不是消息到达」那句话的落地处。
 */
export const refillTurnBudget = (b: TurnBudget): void => {
  b.tokens = Math.min(b.tokens + MAX_YAW_STEP_PER_TICK, b.capacity);
};

/**
 * 按当前令牌数把 `wanted` 钳一次 —— **只算，不扣**。
 *
 * ★ 预算内**原样返回 `wanted`**（不是重算一遍 `prev + delta`）：正常转速下
 *   这个函数逐位透明，联网轨迹与改动前完全一致 —— 一个浮点尾数都不动。
 * ★ `prev === undefined`（开局第一条 / 中途加入 / 重连后的第一条 /
 *   人机让位给真人）时**原样采信**：他此刻朝哪跟 50ms 前无关，没有可比的基准。
 */
export const clampYaw = (prev: number | undefined, tokens: number, wanted: number): number => {
  if (prev === undefined) return wanted;
  // 最短弧：从 prev 到 wanted 该往哪边转、转多少（(-π, π]）
  const delta = wrapAngle(wanted - prev);
  if (Math.abs(delta) <= tokens) return wanted;
  // 令牌不够 → 朝他想去的方向推进到令牌用尽为止，下一 tick 接着推
  return wrapAngle(prev + Math.sign(delta) * tokens);
};

/**
 * 采信一次朝向：钳 + 扣费 + 更新基准。每 tick 每席位**恰好一次**。
 *
 * ★★ **钳而不是拒绝整条输入。** 拒绝会把高延迟玩家的一次合法急转变成
 *   「输入被吞」—— 表现是角色卡一下又弹回去（橡皮筋），比作弊更难查。
 *   钳制是**朝他想去的方向推进一步**：合法的急转慢半拍就补齐，机械旋转
 *   则永远只能以真人的速度转。这与 codec 对 `forward=999`「钳制而不是拒绝」
 *   是同一条纪律。
 */
export const admitYaw = (b: TurnBudget, wanted: number): number => {
  const admitted = clampYaw(b.yaw, b.tokens, wanted);
  if (b.yaw !== undefined) b.tokens = Math.max(0, b.tokens - Math.abs(wrapAngle(admitted - b.yaw)));
  b.yaw = admitted;
  return admitted;
};
