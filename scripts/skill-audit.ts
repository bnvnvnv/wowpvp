/**
 * 技能的 **PVP 实用性审计**（用户提出：竞技场里长读条高伤害技能放不出来，
 * 瞬发控制与不读条的稳定输出才是常用键）。
 *
 * ★★ **这不是平衡性结论，是可用性画像。** 它只回答一个问题：
 *   「这个技能在**有对手干扰**的对抗里，玩家按得出来吗」——
 *   与 `balance-report` 的胜率是两回事（那个测的是数值，这个测的是**手感前提**）。
 *
 * 判据来自 7.x 的既有规则，不是我发明的标准：
 *   · 读条 + 可打断 → 对手一个打断就废（7.2 还会锁学派 3 秒）
 *   · 要求原地（`movable: false`）→ 被风筝时完全放不出（7.3 移动中止读条）
 *   · 引导 → 同时吃「不能动」与「可被打断」，PVP 里最脆的一类
 *   · 瞬发控制/位移/打断 → 反制链的硬通货，永远按得出来
 *
 * 用法：pnpm skill-audit
 */

import { ALL_CLASSES } from '../packages/shared/src/index.ts';
import { CastKind } from '../packages/shared/src/types/enums.ts';
import type { SkillDef } from '../packages/shared/src/data/schema.ts';

/** 这个技能在 PVP 里属于哪一类 —— 判据全部来自 7.x 的规则 */
type Tier = '硬通货' | '好用' | '有条件' | '难放出';

const CONTROL_KINDS = new Set([
  'stun', 'root', 'silence', 'fear', 'incapacitate', 'interrupt',
]);
const MOBILITY_KINDS = new Set([
  'chargeTo', 'chargeToAlly', 'blinkForward', 'leapBackward',
  'teleportBehindTarget', 'pullTarget',
]);

/**
 * ★ W23：控制与位移的载荷可能住在 `lockedProjectile.onHit` 里
 *   （制裁之锤、扼喉、化形术、纠缠根须都是瞬发控制）。只看顶层的话
 *   这四条会从「★★硬通货」掉到「★好用」，审计结论悄悄失真。
 */
const hasKind = (sk: SkillDef, set: Set<string>): boolean => {
  const scan = (list: readonly SkillDef['effects'][number][]): boolean =>
    list.some((e) => set.has(e.kind) || (e.kind === 'lockedProjectile' && scan(e.onHit)));
  return scan(sk.effects);
};

const classify = (sk: SkillDef): { tier: Tier; why: string } => {
  const t = sk.cast.time;
  const instant = sk.cast.kind === CastKind.Instant || t === 0;
  const channel = sk.cast.kind === CastKind.Channel;
  const control = hasKind(sk, CONTROL_KINDS);
  const mobility = hasKind(sk, MOBILITY_KINDS);
  const stationary = sk.cast.movable === false;

  // 瞬发的控制/位移/打断 = 反制链的硬通货
  if (instant && (control || mobility)) return { tier: '硬通货', why: '瞬发控制/位移' };
  // 其余瞬发：永远按得出来
  if (instant) return { tier: '好用', why: '瞬发' };
  // 引导：不能动 + 可被打断，PVP 最脆
  if (channel) return { tier: '难放出', why: `引导 ${t}s（不能动且可打断）` };
  // 读条：看时长与是否可打断
  if (t >= 1.5) {
    return {
      tier: '难放出',
      why: `读条 ${t}s${sk.cast.interruptible ? '·可打断' : ''}${stationary ? '·须原地' : ''}`,
    };
  }
  if (t >= 1.0) return { tier: '有条件', why: `读条 ${t}s（对手分神时才放得出）` };
  return { tier: '好用', why: `短读条 ${t}s` };
};

const TIER_ORDER: Tier[] = ['硬通货', '好用', '有条件', '难放出'];
const MARK: Record<Tier, string> = {
  硬通货: '★★', 好用: '★ ', 有条件: '△ ', 难放出: '✗ ',
};

console.log('\n技能 PVP 实用性审计 —— 「有对手干扰时按不按得出来」');
console.log('='.repeat(72));
console.log('★★硬通货=瞬发控制/位移  ★好用=瞬发或短读条  △有条件=读条1-1.5s  ✗难放出=读条≥1.5s/引导\n');

const totals: Record<Tier, number> = { 硬通货: 0, 好用: 0, 有条件: 0, 难放出: 0 };
const perClass: { name: string; hard: number; total: number; rows: string[] }[] = [];

for (const cls of ALL_CLASSES) {
  const rows: string[] = [];
  const counts: Record<Tier, number> = { 硬通货: 0, 好用: 0, 有条件: 0, 难放出: 0 };

  for (const sk of cls.skills) {
    const { tier, why } = classify(sk);
    counts[tier]++;
    totals[tier]++;
    rows.push(
      `  ${MARK[tier]} ${sk.name.padEnd(6, '　')} ${String(sk.range.max).padStart(4)}m ` +
      `CD${String(sk.cooldown).padStart(3)}s  ${why}`,
    );
  }
  // 难放出的排在最后，方便一眼看到问题技能
  const hard = counts['难放出'] + counts['有条件'];
  perClass.push({ name: cls.name, hard, total: cls.skills.length, rows });

  console.log(`\n【${cls.name}】${cls.skills.length} 技能　` +
    TIER_ORDER.map((t) => `${t} ${counts[t]}`).join(' · '));
  for (const r of rows) console.log(r);
}

console.log(`\n${'='.repeat(72)}`);
console.log('全局：' + TIER_ORDER.map((t) => `${t} ${totals[t]}`).join(' · ') +
  `（共 ${Object.values(totals).reduce((a, b) => a + b, 0)}）`);
console.log('\n「难放出/有条件」占比最高的职业（PVP 里可用技能最少）：');
for (const c of [...perClass].sort((a, b) => b.hard / b.total - a.hard / a.total).slice(0, 4)) {
  console.log(`  ${c.name}：${c.hard}/${c.total} = ${((c.hard / c.total) * 100).toFixed(0)}% 的技能在对抗中难放出`);
}
