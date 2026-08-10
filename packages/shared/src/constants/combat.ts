/**
 * 全局战斗常量。所有数值直接抄自设计文档，改动必须同步 docs/00-design-spec.md。
 * 单位：距离=米，时间=秒，角度=度。
 */

// ── 6.1 战斗距离基准 ─────────────────────────────────────────────
export const RANGE = {
  /** 拾取装备、拔旗、归还、开启军械箱 */
  INTERACT: 2.2,
  /** 盗贼匕首、极短近战技能 */
  DAGGER: 2.4,
  /** 单手剑、锤、盾击 */
  MELEE: 2.8,
  /** 双手剑、双手锤 */
  MELEE_EXTENDED: 3.4,
  /** 长柄武器和少量横扫 */
  MELEE_POLEARM: 3.8,
  /** 短控、近距离支援、部分冲锋 */
  SHORT: 12,
  /** 审判、短距离法术、拉拽 */
  MEDIUM: 25,
  /** 多数法术、治疗和射击 */
  RANGED: 30,
  RANGED_LONG: 32,
  /** 长弓、少量高读条技能 */
  LONG: 35,
  /** Tab、点击与目标框保留上限，不代表技能可释放（5.3 / 6.1）*/
  MAX_SELECT: 45,
} as const;

// ── 8.1 基础属性与节奏 ───────────────────────────────────────────
export const MOVE = {
  /** 人形角色基础前进速度，米/秒 */
  BASE_SPEED: 7,
  /** 后退约为前进的 65% */
  BACKWARD_FACTOR: 0.65,
  /** 侧移与前进相同 */
  STRAFE_FACTOR: 1.0,
  /** 8.3 通用解控不解除普通减速；减速下限保护，避免完全锁死 */
  MIN_SPEED_FACTOR: 0.2,
} as const;

export const GCD = {
  /** 基础公共冷却 */
  BASE: 1.0,
  /** 最低不低于 0.75 秒 */
  MIN: 0.75,
} as const;

// ── 5.3 Tab 切换 ─────────────────────────────────────────────────
export const TARGETING = {
  /** 只在 45 米内循环 */
  TAB_MAX_RANGE: RANGE.MAX_SELECT,
  /** 当前镜头前方约 140 度范围内循环 */
  TAB_FRONT_ARC_DEG: 140,
} as const;

// ── 6.5 朝向 ─────────────────────────────────────────────────────
export const FACING = {
  /** 近战攻击和多数正面攻击要求目标位于角色前方约 180 度 */
  FRONT_ARC_DEG: 180,
  /** 背刺类技能要求攻击者位于目标背后约 120 度区域 */
  BEHIND_ARC_DEG: 120,
} as const;

// ── 6.2 / 6.4 视线与距离计算 ─────────────────────────────────────
export const GEOMETRY = {
  /** 统一战斗碰撞体半径。13.2：不能因模型胖瘦获得命中优势 */
  HITBOX_RADIUS: 0.45,
  /** 统一战斗碰撞体高度 */
  HITBOX_HEIGHT: 2.0,
  /** 视线以「施法者胸口到目标胸口」判断，胸口相对脚底的高度 */
  CHEST_HEIGHT: 1.35,
  /** 6.2：小型台阶和合理高度差不应使攻击频繁失效 */
  VERTICAL_TOLERANCE: 2.5,
  /** 13.5：可自动跨越的低障碍高度 */
  STEP_HEIGHT: 0.45,
  /** 13.5：可行走的最大坡度，超过视为墙 */
  MAX_WALKABLE_SLOPE_DEG: 50,
} as const;

// ── 8.2 控制递减 ─────────────────────────────────────────────────
/** 递减窗口：15 秒内连续同类控制 */
export const DR_WINDOW_SECONDS = 15;

/** 各类别的递减序列。索引 = 该窗口内已施加次数，值 = 持续时间系数，0 表示免疫 */
export const DR_LADDER: Record<string, readonly number[]> = {
  stun: [1, 0.5, 0.25, 0],
  incapacitate: [1, 0.5, 0.25, 0],
  root: [1, 0.5, 0.25, 0],
  /** 沉默只有三段：100% → 50% → 免疫 */
  silence: [1, 0.5, 0],
  /** 击退/拉拽短时间内效果递减，避免连续位移锁死 */
  knockback: [1, 0.5, 0.25, 0],
};

// ── 7.2 专用打断 ─────────────────────────────────────────────────
export const INTERRUPT = {
  /** 被打断的是魔法时，同一法术学派锁定 3 秒 */
  SCHOOL_LOCK_DEFAULT: 3,
  /** 法师反制可锁定 4 秒 */
  SCHOOL_LOCK_COUNTERSPELL: 4,
} as const;

// ── 8.3 通用 PVP 解控「战斗意志」 ────────────────────────────────
export const PVP_TRINKET = {
  COOLDOWN: 90,
  /** 解除：昏迷、恐惧、迷惑、变形、定身 */
  CLEARS: ['stun', 'incapacitate', 'root'] as const,
  /** 默认允许在昏迷中使用（8.3）*/
  USABLE_WHILE_STUNNED: true,
} as const;

// ── 8.5 竞技场战斗抑制 ───────────────────────────────────────────
export const DAMPENING = {
  /** 各模式开始抑制的时间点（秒）*/
  START_SECONDS: { arena2v2: 60, arena3v3: 90, arena5v5: 120 } as Record<string, number>,
  /** 初始降低 10% */
  INITIAL: 0.1,
  /** 之后每 30 秒额外降低 5% */
  STEP_INTERVAL: 30,
  STEP_AMOUNT: 0.05,
  /** 治疗与吸收不能被抑制到 0，留一个下限 */
  MAX: 0.9,
} as const;

// ── 2 / 11 竞技场赛制 ────────────────────────────────────────────
export const ARENA = {
  /** 默认时长（秒）*/
  DURATION: { arena2v2: 300, arena3v3: 360, arena5v5: 420 } as Record<string, number>,
  /** 11.1 准备区时间 15~20 秒 */
  PREP_SECONDS: 18,
  /** 2.1 双方最后一名玩家在同一结算窗口内死亡判平局 */
  DRAW_WINDOW_SECONDS: 0.5,
} as const;

// ── 12 夺旗战场 ──────────────────────────────────────────────────
/** P12 大乱斗 */
export const FFA = {
  /** 先到这么多杀获胜。P13 拍板 100 —— 让积分累积/兑换的经济循环转得起来（15 杀太短,商店还没用上局就完了） */
  KILL_TARGET: 100,
  /** 参战人数上限（房间另留观战余量,LIMITS.MAX_FFA_ROOM_MEMBERS） */
  MAX_PLAYERS: 100,
  /** 人机补位把参战人数补到这个数（不是补到上限 —— 100 个 bot 是 DoS 自己） */
  FILL_TARGET: 20,
  /** P13 复活波次间隔（秒）。混战节奏比夺旗快,12 秒罚站太漫长 */
  RESPAWN_SECONDS: 8,
  /**
   * P13 断线宽限（秒）。偏差 #14 的「整局有效」是给**组队**模式的语义
   * （队友等你回来）；大乱斗是单人局 —— bot 接管 90 秒等重连,没回来就
   * 从对局移除（弃权判死、不再复活、bot 下台、积分冻结）。
   * ★★ 关键动机：**bot 不能替第一名夺冠** —— 24 小时宽限下,领先者拔线
   *   后 normal 档 bot 可以一路杀到 100 杀替他赢下整局。
   */
  DISCONNECT_GRACE_SECONDS: 90,
} as const;

export const CTF = {
  /** 12.1 默认率先完成 3 次夺旗获胜，房主可调 1~5 */
  DEFAULT_SCORE_TO_WIN: 3,
  MIN_SCORE_TO_WIN: 1,
  MAX_SCORE_TO_WIN: 5,
  DURATION: { ctf6v6: 720, ctf8v8: 900, ctf12v12: 900 } as Record<string, number>,
  /**
   * A17：突然死亡加时的硬上限（秒）。到点仍是平分 → 判平局。
   *
   * ★ 理由与 `arena.ts` 的 `SUDDEN_DEATH_HARD_CAP` 逐字相同：加时靠「有人
   *   得分」结束，而「双方都龟着不碰旗」恰恰是 A17 要消灭的那种局面 ——
   *   不设上限等于把「没有终点」原样搬进加时。取 180 秒与竞技场同数量级。
   */
  OVERTIME_HARD_CAP: 180,
  /** 12.1 拔旗持续 1.2 秒 */
  PICKUP_SECONDS: 1.2,
  /** 12.1 交旗持续 0.8 秒 */
  CAPTURE_SECONDS: 0.8,
  /** 12.2 归还持续 0.6 秒 */
  RETURN_SECONDS: 0.6,
  /** 12.6 默认每 12 秒一次复活波次，加时赛 16 秒 */
  RESPAWN_WAVE_SECONDS: 12,
  RESPAWN_WAVE_SECONDS_OVERTIME: 16,
  /** 12.6 复活后 3 秒保护 */
  SPAWN_PROTECTION_SECONDS: 3,
  /** 12.4 同时持旗超过 60 秒后开始叠加战场聚焦 */
  FOCUS_GRACE_SECONDS: 60,
  /** 每 30 秒叠加一层 */
  FOCUS_STACK_INTERVAL: 30,
  FOCUS_MAX_STACKS: 5,
  /** 每层：受到伤害 +8%，受到治疗 -5% */
  FOCUS_DAMAGE_TAKEN_PER_STACK: 0.08,
  FOCUS_HEALING_TAKEN_PER_STACK: 0.05,
  /** 12.3 旗手移动加成总上限 */
  FLAG_CARRIER_MAX_SPEED_BONUS: 0.1,
} as const;

// ── 10.5 / 10.7 装备争夺与换装 ───────────────────────────────────
export const EQUIP = {
  /** 10.5 拾取持续 0.8 秒 */
  PICKUP_SECONDS: 0.8,
  /** 10.7 切换武器 0.8 秒，可缓慢移动 */
  SWAP_WEAPON_SECONDS: 0.8,
  SWAP_WEAPON_MOVE_FACTOR: 0.4,
  /** 10.7 切换护甲 2 秒，必须原地 */
  SWAP_ARMOR_SECONDS: 2.0,
  /** 10.6 携带上限 */
  MAX_SPARE_WEAPONS: 2,
  MAX_SPARE_ARMORS: 2,
  MAX_CONSUMABLES: 2,
  /** 10.4 刷新前 5 秒预告 */
  SPAWN_TELEGRAPH_SECONDS: 5,
} as const;

// ── 暴击（★ 规格书**没有**这条机制，登记为 docs/10 已知偏差 #7）──
/**
 * ★★ 这是一次**玩法**新增，不是表现调整 —— 与偏差 #6（美术基调）性质不同，
 *   它真的改变了伤害数值分布。三条自我约束：
 *     · 只有一个几率、一个倍率，**不引入暴击等级/属性系统**
 *       （那要动 8 个职业的数据与 AuraModifiers，属于配平工作，不是手感工作。
 *       `rollCrit` 预留了 chance 参数，将来接属性系统不用改签名）
 *     · 倍率取 1.5 而不是传统的 2.0 —— PVP 里 2.0 会让一次运气决定一场对局
 *     · 周期伤害（DoT/HoT/地面 tick）不暴击，理由见 effects/combat.ts 的 rollCrit
 * ⚠️ 接入后 `pnpm balance` 的数字整体上浮约 5%，基线已重出（偏差 #7 登记）。
 */
export const CRIT = {
  /** 基础暴击几率。全职业相同 */
  BASE_CHANCE: 0.1,
  /** 直接伤害的暴击倍率 */
  DAMAGE_MULTIPLIER: 1.5,
  /** 治疗暴击倍率。与伤害同值 —— 不同值等于偷偷给某一侧加强 */
  HEAL_MULTIPLIER: 1.5,
  /**
   * P7：修正叠加后的几率**上限**。⚠️ 占位值 —— 由来：暴击的全部价值在
   * **不确定**，叠到必暴它就退化成一个乘算增伤，还顺带毁掉对手对
   * 「他会不会暴」的风险判断。50% 让最极端的堆叠仍然是一半一半的赌。
   */
  MAX_CHANCE: 0.5,
} as const;

// ── 网络与模拟 ───────────────────────────────────────────────────
/**
 * 普通攻击（7.6）。
 *
 * ⚠️ **`RAGE_PER_SWING` 是占位值。** 规格书给了攻击间隔与单击百分比，
 *   但**没有给每次挥击产生多少怒气**。这里按「约 6 次挥击攒满一个 30 点
 *   技能的消耗」估，配平时会重调。
 *   ★ 这句话写在数值旁边是有意的 —— PROGRESS 技术债 §2 记着一条教训：
 *     19 处伤害占位值当初都没写说明，于是它们的由来在代码里完全找不到。
 */
export const COMBAT_SWING = {
  // M14 配平定值：盾剑 1.7s 一跳 ≈ 3.5 怒/s，重创斩（20 耗）约 6 秒一发，冲锋 +15 组成开局节奏
  RAGE_PER_SWING: 6,

  /**
   * 7.6 贴脸挥击：**远程武器在这个距离内改成近战挥击**，不再射击。
   *
   * ★ 在此之前，远程武器的 `reach`（弓 28m）是唯一判据 —— 于是战士骑在
   *   猎人脸上时，猎人照样以满额白字**继续开弓**，「被近战贴身」这个本该
   *   要命的处境在数值上毫无代价。自动射击本身没有被删（M14 只去掉了那个
   *   可连点的**按钮**，机制归入本挥击系统）；缺的一直是「近身之后改成挥击」
   *   这一半。
   *
   * ★ 取 `RANGE.MELEE`：与「近战武器够得着我」用同一把尺子，玩家看到近战
   *   贴上来的那一刻，正是射击停摆的那一刻 —— 两件事同时发生才读得懂。
   */
  RANGED_MELEE_RANGE: RANGE.MELEE,
  /**
   * 贴脸挥击的伤害 = 本武器一次挥击的这个比例。
   *
   * ⚠️ **占位值**：规格书没有给「用弓当棍子抡」的伤害。按「明显吃亏但不是
   *   完全无害」取半发，配平时会重调（写在数值旁边的原因同 RAGE_PER_SWING）。
   * ★ 取「本武器的比例」而不是一个全局固定值：重弩比短弓更像钝器，
   *   抡起来更疼是说得通的；代价是长弓/重弩的贴脸挥击会略高于短弓。
   */
  RANGED_MELEE_RATIO: 0.5,
} as const;

export const SIM = {
  /** 权威服务器 tick 频率 */
  TICK_RATE: 20,
  TICK_DT: 1 / 20,
  /**
   * 状态广播频率（可低于 tick，客户端插值）。
   *
   * ★ P11 波2：20 → 10。这个 affordance 从 M1 就声明了但一直零读者 ——
   *   `broadcastSnapshots` 无条件每 tick 跑。现在 MatchLoop 真的按它分频：
   *   快照（含其中的 ackSeq 确认）每 100ms 一份，**模拟仍是 20Hz**，
   *   事件消息（Damage/CastStarted…）仍逐 tick 即时发 —— 打击反馈不变钝。
   * ⚠️ 必须整除 TICK_RATE（MatchLoop 按 tick % divisor 分频）。
   * ⚠️ 与 INTERP_DELAY 联动：插值窗必须 > 快照间隔 + 抖动余量，否则
   *   插值器频繁落进「没有更新的帧」的退化分支（teleported:true 脉冲，
   *   动画会闪）。改这里必须一起看下面那条。
   */
  SNAPSHOT_RATE: 10,
  /**
   * 客户端插值缓冲，秒。
   * ★ P11 波2：0.1 → 0.15 —— 快照间隔 100ms 后，0.1 的窗刚好压在帧边界上，
   *   一点抖动就退化。0.15 = 1.5× 快照间隔，是插值稳定的最小安全余量。
   *   代价如实记：**远端实体**的显示比权威世界晚 150ms（原 100ms）；
   *   自己的移动走预测（Predictor），不受此影响。
   */
  INTERP_DELAY: 0.15,
} as const;
