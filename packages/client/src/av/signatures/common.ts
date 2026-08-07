/**
 * P3 技能签名：**非职业**的通用动作。
 *
 * ★★ 这个文件收的是「有 skillId、但不在 `ALL_SKILLS` 里」的那几个 id ——
 *   它们由 sim 直接发出，没有 `SkillDef`、没有图标、也没有职业归属，
 *   所以八个职业签名表都不会认领它们，而它们恰恰是**全场响得最多**的音。
 *   目前只有两个（`autoAttack` / `trinket`），少得出乎意料是件好事：
 *   说明 sim 没有到处编造伪技能 id。
 *
 * ⚠️ 本文件**不许**出现任何 `<职业>.<技能>` 形式的 id ——
 *   那八张表由八个并行包各自维护，这里写一行就是一次静默覆盖
 *   （`registerSignatures` 是后写胜出，冲突不会报错，只会让别人的手写签名消失）。
 *   `integrity.test.ts` 的第二条断言正是盯这个。
 */

import { SignatureForm, type SkillSignature } from '../skillSignature.js';

/**
 * 这两个 id 的出处（写死之前逐个核对过，不是猜的）：
 * - `autoAttack` —— `shared/src/sim/tick.ts:567` 的
 *   `resolve(sw.attackerId, 'autoAttack', ...)`，会原样出现在 `Damage.skillId` 里
 *   （X3 起协议带 skillId；`NetworkScene.skillNameFor` 也在特判这个字符串）。
 * - `trinket` —— `shared/src/sim/tick.ts:97` 的 `TRINKET_COOLDOWN_KEY`，
 *   8.3 战斗意志解控。
 *
 * 导出成常量是给 `integrity.test.ts` 用的：第二条断言要区分
 * 「约定键」与「打错字的技能 id」，而这个区分不能靠注释靠自觉。
 */
export const COMMON_SIGNATURE_IDS = ['autoAttack', 'trinket'] as const;

export const commonSignatures: Record<string, SkillSignature> = {
  /**
   * 普通攻击（7.6 挥击）。
   *
   * ★★ **刻意不写 `castSound` / `impactSound`，也刻意把 rate 钉死在 1。**
   *   这与本批「每个技能一个可辨识身份」的方向看似相反，实则同源：
   *   普攻是整局里重复次数最多的一声（近战约每 2.6 秒一次，全程不停）。
   *   1. 单个固定文件顶不住这个重复率 —— 现在走的
   *      `playVariant('swing')`（7 个 blade 文件轮换）与
   *      `playImpact(physical)` → `playVariant('flesh')`（4 个文件轮换）
   *      本来就比任何一个签名文件更耐听，签名系统没有轮换能力，
   *      写死一个文件是**退步**。
   *   2. 推导层给的 ±6% 微音高对一次性的技能是「个性」，
   *      对每 2.6 秒响一次的白字就是「武器坏了」。钉死 1 是让它退到背景里，
   *      把辨识度的预算留给技能。
   *
   * ⚠️ **按武器类型分 blade/heavy/light/bow 这件事在当前结构里做不到**，
   *   如实记下三条根因（不是没做，是做不了）：
   *   a. `resolveSignature` 只吃 skillId 一个键 —— 同一个 `autoAttack` id
   *      解析不出两组值，除非 sim 改成发 `autoAttack.blade` 之类的 id（sim 改动，红线）。
   *   b. 两个调用点都拿不到武器：`CombatDirector.onSwingHit(attackerId)`
   *      只有实体 id；`Damage` 消息里没有任何武器字段。
   *   c. 就算拿得到也分不出来 —— `WeaponDef`（shared/data/schema.ts:460）
   *      只有 `isRanged` / `reach`，**数据里根本没有 blade/heavy/light 这个分类**。
   *   现存的近/远分流在别处已经做了（职业级 `autoAttack.ranged`），
   *   本层不重复造一个半吊子的。
   *
   * ⚠️ 现状如实：本条签名**当前没有运行时读者**。普攻的音在
   *   `feedback/HitFeedback.ts:234` 的 `playImpact(ev.school)`，那个文件不属于本批，
   *   换成 `playImpactFor({ id: msg.skillId ?? 'autoAttack', school })` 是收口的一行。
   */
  autoAttack: {
    castRate: 1,
    impactRate: 1,
    // 粒子规模压到钳位下限：白字是「一直在发生」的底噪，
    // 它的视觉预算应当是全场最低的那一档（SCALE_CLAMP.min = 0.6）
    scale: 0.6,
    form: SignatureForm.None,
  },

  /**
   * 饰品解控（8.3 战斗意志）。
   *
   * ★ 借 `buff_apply` 而不是新素材：盘上没有「挣脱枷锁」这类音，而解控在
   *   语义上确实是**给自己上了一个东西**（免疫窗）。
   * ★ 变速 1.35 是这条签名的全部个性所在 —— 与原速 `buff_apply`（普通上 buff，
   *   `combatAudio.ts` 的 auraApplied 一路）拉开一整个音程，
   *   「被控住的那两秒里突然一声拔高的 buff 音」= 我挣脱了。
   *   占位值：取在钳位上限 1.4 之内、又明显高于任何推导层能产生的
   *   ±6%，真机听感后可调。
   * ★ 上升螺旋：解控是「从地上站起来」，Spiral 是签名地基里唯一向上的形态。
   *
   * ⚠️ 现状如实：本条**当前也没有运行时读者** —— 饰品解控今天是**完全无声**的
   *   （sim 发 `auraRemoved{reason:'trinket'}`，`combatAudio.playCombatEvent`
   *   的 `auraRemoved` 落在 default 空分支）。给它发声是**新增一个音效事件**，
   *   不属于本批「把学派音换成签名音」的穿线范围，故只登记不接线。
   */
  trinket: {
    castSound: 'buff_apply',
    castRate: 1.35,
    form: SignatureForm.Spiral,
  },
};
