/**
 * A5：**服务器采信客户端朝向那一刻**的转身令牌桶接线（技术债总账 A5）。
 *
 * ★★ **这道闸挡的是 spinbot。**
 *
 *   `intent.facing` 与 `Input.characterYaw` 此前都是**无条件采信**的：
 *   服务器拿到什么就写进 `caster.yaw` / `MovementState.yaw`，中间没有任何
 *   一条判据问过「他 50 毫秒前朝哪」。于是一个脚本客户端可以每 tick 把朝向
 *   瞬移到任意角度 —— 6.5 的朝向门禁（`requiresFacing`）对他永远成立，
 *   而 6.5「背刺要求攻击者位于目标背后 120°」那条**转身博弈**（被偷袭的人
 *   转身面对，让对方吃不到背刺加成）对他根本不存在：他背后没有背后。
 *
 * ★★ **规则本身在 `@wowpvp/shared` 的 `net/turnBudget.ts`，不在这里。**
 *   理由写在那个文件的开头：客户端预测必须跑同一份 —— 服务器一旦有了一条
 *   客户端没有的规则，`Predictor` 的立身前提就破了，快速转身全程走位置纠正
 *   的平滑分支（橡皮筋）。这个文件只剩「服务器这一侧怎么接线」。
 *
 * ★★ **服务器的桶用 `TURN_BURST_SERVER_RAD`（比客户端多 5 个 tick 的余量）。**
 *   诚实客户端在发出 `Input` 之前已经自钳过一次，服务器这一道**不该**再钳到
 *   他 —— 两边的 tick 边界不可能对齐，少了这点余量就会出现「客户端钳过了、
 *   服务器又钳一次」的分叉。余量只对脚本客户端有意义，而它与桶容量同量级，
 *   不改变威胁模型。
 *
 * ★★ **每 tick 恰好注入一次令牌，不随消息条数、不随客户端报的 dt 变化。**
 *   按**消费到的输入条数**注入是个洞：`takeInputsForTick` 一 tick 最多吃 5 条,
 *   攒 5 条发一次就变成 5 份预算。而反过来「这一 tick 没收到 Input 就跳过」
 *   （旧版的写法）是**同一个错误的另一个方向**：客户端一帧补两步就会把两条
 *   Input 挤进同一个 tick、留下一个空 tick，于是有效上限被腰斩成 360°/s ——
 *   实测 600°/s 的成对投递每秒拉开 270°，而且持续转身期间永远追不齐。
 *   现在的写法是：**每个真人席位每 tick 注入一次**（`refillTurnBudget`，在
 *   `collectInputs` 的循环里、在「有没有输入」这个判断**之前**），有输入时
 *   从桶里扣。空 tick 攒、爆发 tick 花，时钟是 tick，不是消息到达。
 */

export {
  MAX_YAW_STEP_PER_TICK,
  TURN_BURST_RAD,
  TURN_BURST_SERVER_RAD,
  admitYaw,
  clampYaw,
  createTurnBudget,
  refillTurnBudget,
  type TurnBudget,
} from '@wowpvp/shared';
