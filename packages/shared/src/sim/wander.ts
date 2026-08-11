/**
 * 「被变形的人在原地小范围踱步」（8.2 迷惑）。
 *
 * 用户口径（2026-08-11）：「被变形宠物了也应该是在一个小范围内走来走去的」。
 *
 * ★★ **为什么在 sim 而不是在表现层。**
 *   让客户端把小鸡模型晃来晃去是最省的做法，也是最坏的做法：碰撞体钉在原地，
 *   而玩家看到的小鸡在两米外 —— 「所见即所中」（13.2）当场破掉，近战会
 *   对着一只空气小鸡挥空。位置**真的移动**之后，快照自动带着新坐标下发，
 *   表现层一行都不用改（模型本来就跟着位置走），命中判定与画面天然一致。
 *
 * ★★ **确定性：不掷骰子，只散列。**
 *   `packages/shared` 里一处 `Math.random()` 都没有（回放/预测重放/配平复现
 *   三样都建立在这上面）。但这里连 `world.ts` 的 `nextRandom()` 也**不能用** ——
 *   那是**每实体一条的流**，闪避/暴击/派对增益都在推进它：游走每 tick 掷一次
 *   骰子，等于把同一场比赛里所有人的闪避序列整体错开，「加一处随机不扰动别处」
 *   的分流承诺当场作废（`nextRandom` 自己的注释写着这条）。
 *   所以走**纯散列**：`(entityId + 中招点, 段序号)` → 角度/距离/停顿，
 *   同输入必同输出，一个字节的共享状态都不消耗（键的两维见 `keyOf`）。
 *
 * ★ **谁在按方向键**：游走**不改积分**（`stepMovement` 对它一无所知），
 *   只是替玩家合成一份 `MovementInput`。所有物理照旧 —— 撞墙滑动、跨台阶、
 *   软推开、重力、减速光环全部原样生效，因为走的是同一条积分路径。
 *
 * ⚠️ DEBT(X29): 客户端不预测自己的游走（滞后一个快照间隔）；恐惧未做；
 *    **balance 必动且本批未归因** —— 被变形的目标会走出近战贴脸范围。
 *
 * ⚠️ **如实记的一处降级：客户端不预测自己的游走。**
 *   `SelfMovementSnapshot` 不带锚与段（协议里加一份就得让 `Predictor` 也
 *   跑一遍这里的散列，那是客户端侧的改动，本批不做）。于是被变形的**自己**
 *   在本地预测里是站着不动的，位置靠每份快照纠正 —— 偏差是「一个 tick 的
 *   游走位移」（40% 基速 × 50ms ≈ 0.14 米），落在 `CORRECTION` 的平滑档里，
 *   表现为画面比权威位置**滞后约一拍**、平滑跟上，不是来回拉扯的橡皮筋
 *   （那需要预测与权威**朝相反方向**持续用力）。要消掉这最后一拍，得给
 *   `SelfMovementSnapshot` 补锚与段并让 `Predictor.stepOpts` 消费 —— 见
 *   docs/15 的余账，别在没有消费方的时候先把字段加上（死字段是本仓库的老病）。
 */

import { GEOMETRY } from '../constants/combat.js';
import { dirToYaw, TAU, vec3, type Vec3 } from '../math/vec3.js';
import type { Aabb } from '../math/geometry.js';
import type { AuraDef } from '../data/schema.js';
import { DrCategory } from '../types/enums.js';
import type { EntityId } from '../types/ids.js';
import { aurasOf, type AuraStore } from './aura.js';
import type { CombatEntity } from './entity.js';
import { findGroundY } from './movement.js';
import type { MovementInput, MovementState, WanderState } from './movement.js';

// ── 调参（WoW 变形羊参照）────────────────────────────────────────

export const WANDER = {
  /** 离中招点最远能走多远，米。羊在脚底下那一小圈晃，不是在遛弯 */
  RADIUS: 2.5,
  /**
   * 相对基础速度的档位。0.4 = 慢慢踱步，不是散步也不是逃命 ——
   * 它同时是**平衡上的刹车**：走得快等于给被控者白送一段逃脱位移。
   */
  SPEED_FACTOR: 0.4,
  /** 一段的最短/最长时长，秒。到点就换一个新目标点（或站一会儿）*/
  HOLD_MIN: 0.8,
  HOLD_MAX: 1.2,
  /**
   * 目标点取在 `[MIN, MAX] × RADIUS` 的圆环上。
   * ★ 上界刻意 < 1：目标点都在圆**内**，而圆是凸的 —— 从圈内走向圈内的
   *   一点，整条路都在圈内。留的这一档余量吃掉「最后一步走过头」的量
   *   （满速一 tick 也才 0.14 米）。半径不越界靠的是这条几何事实，
   *   不是每 tick 把位置拽回来（拽位置 = 又一个「所见即所中」的洞）。
   */
  TARGET_MIN: 0.35,
  TARGET_MAX: 0.85,
  /** 一段是「停下来站着」的比例。羊不会一刻不停地走 */
  IDLE_CHANCE: 0.3,
  /** 离目标点这么近就算到了，站着等下一段（省掉终点处的抖动）*/
  ARRIVE_EPSILON: 0.2,
  /**
   * 「往前探一小步看看有没有地」的探针距离，米（见 `driveWander` 的第二道闸）。
   * ★ 比一 tick 的位移（20Hz 下 0.056 米）大一个量级，所以是**提前**发现
   *   而不是掉下去之后才发现；又比 `ARRIVE_EPSILON` 大一点点，
   *   于是「快到终点了探针探到界外」最多让人早停一步，观感与到点即停一样。
   * ★ 与地面查询自带的半径容差配套：实体的中心走出台沿 `radius` 才会失去
   *   支撑，探针在中心还差约 0.25 米到边缘时就判否 —— 停在实地上。
   */
  GROUND_PROBE: 0.35,
} as const;

// ── 「被化形」的可判定形态 ───────────────────────────────────────

/**
 * 这一枚光环把人变成了小动物吗？—— **「画面上是不是小鸡」的唯一判据**。
 *
 * ★★ 判据是**递减类别 + 旗标**而不是光环名/光环 id：`DrCategory.Incapacitate`
 *   且 `flags.stunned` —— 8.2 的「迷惑」链就是「被变成无害生物」这一类
 *   （化形术、气旋囚笼、寒霜陷阱、致盲……）。按 id 判的失败模式已经被
 *   实测到过：联网侧曾拿 `auraId === 'control.incapacitate'` 一个字面常量
 *   当判据，于是**自带 id** 的气旋囚笼（`druid.cyclone`）在联网局里
 *   不换模型 —— 一个「无法行动、不能被打也不能被治」的人形角色边走边晃头，
 *   而同一发在试验场是小鸡。两个场景现在都调这一条（见客户端 `morphForm.ts`）。
 *
 * ★ **恐惧不在其中**（`flags.feared`，同属 Incapacitate 递减链）：WoW 的恐惧
 *   是朝**远离施法者**的方向跑开一大段，语义与「原地踱步」完全不同
 *   （半径、速度、朝向规则全不一样），混进来等于给恐惧偷偷加了个
 *   「跑不远」的削弱。DEBT(X29): 恐惧的乱跑本批不做。
 */
export const isMorphedFormAura = (def: Pick<AuraDef, 'drCategory' | 'flags'>): boolean =>
  def.drCategory === DrCategory.Incapacitate && def.flags?.stunned === true;

/**
 * 这个实体这一刻**该游走**吗？
 *
 * ★★ **它与 `isMorphedFormAura` 刻意不等价，别拿它去判「长什么样」。**
 *   前置条件同一条（身上有一枚化形光环），后置条件多一道：身上**同时**
 *   有别的「无法行动」来源（真昏迷、恐惧、冰封庇护）时**不走** ——
 *   被变形又被裁决之锤钉住的人应该是**钉住**的，两个控制同时在身上时
 *   限制更强的那个说了算。表现层要是改调这一条，「被变形又被昏迷」的目标
 *   会从小鸡**变回人形**、昏迷一结束又变回小鸡：一次纯粹由第二个控制引起的
 *   模型闪回（实测过，X29 复盘）。
 *   一句话：这一条回答「该不该走」，`isMorphedFormAura` 回答「长什么样」。
 */
export const isWanderIncapacitated = (auras: AuraStore, entity: CombatEntity): boolean => {
  let morphed = false;
  for (const a of aurasOf(auras, entity.id)) {
    const f = a.def.flags;
    if (!f) continue;
    if (isMorphedFormAura(a.def)) {
      morphed = true;
      continue;
    }
    // 另一个硬控在场 → 由它说了算，不游走
    if (f.stunned === true || f.feared === true) return false;
  }
  return morphed;
};

// ── 确定性散列 ───────────────────────────────────────────────────

/** 同一段里三个互不相关的取值各要一个盐，否则角度与距离会同相 */
const SALT_ANGLE = 0x2545f491;
const SALT_RADIUS = 0x9e3779b1;
const SALT_HOLD = 0x85ebca6b;
const SALT_IDLE = 0xc2b2ae35;

/**
 * `(键, 段序号, 盐)` → `[0, 1)`。**纯函数**，不碰任何流。键见 `keyOf`。
 * 混合手法与 `world.ts` 的 `deriveRngSeed` 同族（乘法 + 右移异或）。
 */
const hash01 = (key: number, segment: number, salt: number): number => {
  let h = Math.imul(key ^ salt, 0x27d4eb2f) >>> 0;
  h = Math.imul(h ^ (segment + 1), 0x165667b1) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x735a2d97) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** 本段持续多久（0.8~1.2 秒）*/
const holdOf = (key: number, segment: number): number =>
  WANDER.HOLD_MIN + (WANDER.HOLD_MAX - WANDER.HOLD_MIN) * hash01(key, segment, SALT_HOLD);

/**
 * 散列的第一维：**实体 id + 中招点**。
 *
 * ★ 为什么不是光有 id：那样同一个人每次被变形都走出**同一条**路，
 *   记住了就能预读小鸡往哪拐 —— 与「随机流不进快照」防的是同一件事。
 * ★ 为什么不掺 `world.seed`：那个东西**刻意不进快照**（发出去等于让人预测
 *   下一次闪避），掺进来会把「将来让客户端预测自己的游走」这条路堵死。
 *   而中招点是**公开信息**（谁都看得见他在哪儿中的招），拿它当第二维
 *   既有变化又不欠任何秘密。
 * ★ 量化到 1/32 米：锚点是浮点，但它在整段游走里**一个字节都不变**
 *   （存在 `WanderState` 里），所以量化只是为了让散列吃整数，不引入抖动。
 */
const keyOf = (id: number, w: WanderState): number =>
  (id
    ^ Math.imul(Math.round(w.anchorX * 32) | 0, 0x27d4eb2f)
    ^ Math.imul(Math.round(w.anchorZ * 32) | 0, 0x165667b1)) >>> 0;

// ── 驱动 ─────────────────────────────────────────────────────────

export interface WanderDrive {
  /** 推进后的锚与分段，由调用方写回 `MovementState.wander` */
  wander: WanderState;
  /** 这一 tick 替玩家按下的「方向键」。★ 永远不跳（jump 恒 false）*/
  input: MovementInput;
}

/**
 * 地面连续性闸要用的两样。**不传 = 不设闸**（无参默认路径逐位不变）。
 * 生产路径（`tick.ts`）一定要传 —— 见 `groundContinuous` 的 ★★。
 */
export interface WanderGround {
  obstacles: readonly Aabb[];
  /** 游走者的碰撞半径（`CombatEntity.radius`）*/
  radius: number;
}

/**
 * 目标点脚下**有连续地面**吗？
 *
 * ★★ **为什么必须有这道闸**：选目标点的规则只看「离锚点多远」与「圆是凸的」，
 *   一个字节都不看脚下 —— 而 `moveAndSlide` 只拒绝**水平**碰撞，走出台沿
 *   之后接管的是重力。实测：6×6 的台面上、离台沿 0.6 米处被变形 30 秒，
 *   小鸡在 30 秒内走下台面掉了 12 米（`MOVEMENT.FALL_DAMAGE_HEIGHT` 是 8，
 *   这一跤是要吃坠落伤害的）。「被控期间被游戏本身挪下台」与 13.2
 *   「所见即所中」是同一个信任等级的事：玩家零操控，赖不到自己头上。
 *
 * ★ 判据与 `tryStepUp` 的落回检查同族：从**抬高一个台阶**的高度往下扫
 *   两个台阶 —— 于是台阶、路缘、小斜面照走（band 内有面），
 *   而台沿外侧（band 内一个面都没有，最近的地在十几米下）当场判否。
 * ★ 这是**点查询**不是扫掠：每段一个固定目标点，每 tick 复算的是同一个点。
 */
const groundContinuous = (
  targetX: number,
  targetZ: number,
  position: Vec3,
  g: WanderGround,
): boolean =>
  findGroundY(
    vec3(targetX, position.y + GEOMETRY.STEP_HEIGHT, targetZ),
    g.radius,
    g.obstacles,
    GEOMETRY.STEP_HEIGHT * 2,
  ) !== undefined;

/**
 * 算出本 tick 的游走意图。**纯函数**（不改传入的状态）。
 *
 * @param prev  上一 tick 的锚与分段。undefined = 这一刻刚中招，就地下锚
 * @param yaw   当前朝向。站着不动的那几段沿用它 —— 站着还在转圈是抽搐不是发呆
 * @param ground 地面连续性闸的输入。**省略 = 不设闸**（老行为逐位不变）
 */
export const driveWander = (
  prev: WanderState | undefined,
  entityId: EntityId,
  position: Vec3,
  yaw: number,
  now: number,
  ground?: WanderGround,
): WanderDrive => {
  const id = entityId as number;
  // 就地下锚（`keyOf` 只读锚点，所以先摆锚再算第一段的长度）
  const anchored: WanderState = prev
    ?? { anchorX: position.x, anchorZ: position.z, segment: 0, nextTurnAt: 0 };
  const key = keyOf(id, anchored);
  let w: WanderState = prev ?? { ...anchored, nextTurnAt: now + holdOf(key, 0) };

  // 换段。用 while 而不是 if —— 与 tickAuras 的周期跳同一条：低帧率下不漏段。
  // ★ 累加 nextTurnAt 而不是 now + hold：段边界不随 tick 抖动，轨迹可复算
  while (now >= w.nextTurnAt) {
    const segment = w.segment + 1;
    w = { ...w, segment, nextTurnAt: w.nextTurnAt + holdOf(key, segment) };
  }

  const stand: WanderDrive = { wander: w, input: { forward: 0, strafe: 0, jump: false, yaw } };

  // 被外力（软推开、滑墙、击退）挤出圈外 → 这一段改成往锚点走回去。
  // ★ 是**改目标**不是**改位置**：把人拽回圈内会凭空产生一段没有物理的位移
  const offX = position.x - w.anchorX;
  const offZ = position.z - w.anchorZ;
  const outside = offX * offX + offZ * offZ > WANDER.RADIUS * WANDER.RADIUS;

  let dx: number;
  let dz: number;
  if (outside) {
    /**
     * ★ 往回走这一段**不设地面闸**：被击退/软推开挤出圈外的人可能正站在
     *   台下或半空，锚点（中招点）本身是他站得住的地方 —— 这时候把「走回去」
     *   也拦掉，等于让他留在被挤到的任何地方，比走回去更糟。
     */
    dx = -offX;
    dz = -offZ;
  } else {
    // 这一段本来就是「站着发呆」
    if (hash01(key, w.segment, SALT_IDLE) < WANDER.IDLE_CHANCE) return stand;
    const angle = hash01(key, w.segment, SALT_ANGLE) * TAU;
    const reach = WANDER.RADIUS
      * (WANDER.TARGET_MIN
        + (WANDER.TARGET_MAX - WANDER.TARGET_MIN) * hash01(key, w.segment, SALT_RADIUS));
    const targetX = w.anchorX + Math.cos(angle) * reach;
    const targetZ = w.anchorZ + Math.sin(angle) * reach;
    // 目标点脚下没有连续地面（台沿外、坑对面）→ 这一段站着，不往那边走
    if (ground && !groundContinuous(targetX, targetZ, position, ground)) return stand;
    dx = targetX - position.x;
    dz = targetZ - position.z;
    /**
     * ★★ 第二道：**这一步踩下去的地方**也要有地。
     *   只查目标点是不够的 —— 站得住的区域**不一定是凸的**（L 形台面、
     *   两堵墙的拐角、绕柱的环形走道），起点与终点都站得住，中间那条直线
     *   却可能抄近路切出去。实测抓到过一例（熔岩裂谷两堵边界墙的拐角）。
     *   探一小段（`GROUND_PROBE`）而不是探到终点：走到地断的地方就停下，
     *   而不是「这一段整段不走」—— 后者会让台面边缘一圈的小鸡集体发呆。
     */
    if (ground) {
      const len = Math.hypot(dx, dz);
      if (
        len > 0
        && !groundContinuous(
          position.x + (dx / len) * WANDER.GROUND_PROBE,
          position.z + (dz / len) * WANDER.GROUND_PROBE,
          position,
          ground,
        )
      ) return stand;
    }
  }

  // 已经到了 → 站着等下一段（继续走会在目标点附近来回跨越）
  if (Math.hypot(dx, dz) < WANDER.ARRIVE_EPSILON) return stand;

  return {
    wander: w,
    input: {
      forward: WANDER.SPEED_FACTOR,
      strafe: 0,
      jump: false,
      // 小鸡朝着自己走的方向 —— 朝向与位移同源，不需要额外的转身规则
      yaw: dirToYaw(vec3(dx, 0, dz)),
    },
  };
};

/**
 * 结束游走：拔锚 + 抹掉水平动量。
 *
 * ★ 「受伤打断化形」（8.2 breakDamage）之后玩家应当**当场停在原地**：
 *   残余动量是 sim 送的位移，不属于任何人的输入，而它正好落在
 *   「刚被打醒要跑」的时刻，滑出去一截会被读成操作失灵。
 * ⚠️ **这一步在 20Hz 下看不出效果，在 1/60 下看得出** —— 服务器步长里
 *   `GROUND_ACCEL × 0.05 = 3.0` 已经大于游走速度 2.8，地面减速一 tick 就
 *   夹到 0；而试验场按渲染步长推 tick（`60 × 1/60 = 1.0`），不抹的话要滑
 *   三帧。**不能因为「主路径上看不出来」就删掉它**：那是数值巧合，
 *   `SPEED_FACTOR` 调高或 `GROUND_ACCEL` 调低的那天它就复活了
 *   （`wander.test.ts` 有一条专门跑 1/60 的用例钉住这件事）。
 * ★ **位置一个字节都不动**（不回锚点）：打断是停下来，不是被弹回去。
 * ★ 没在游走时返回**同一个对象** —— 默认路径零分配、零行为变化。
 */
export const stopWander = (state: MovementState): MovementState =>
  state.wander === undefined
    ? state
    : { ...state, wander: undefined, velocity: vec3(0, state.velocity.y, 0) };
