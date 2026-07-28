/**
 * 从 packages/shared 的职业数据生成两份检查表文档：
 *   docs/04-class-skill-matrix.md   附录A#2/#3 要求的技能完整检查表
 *   docs/05-equipment-system.md     附录A#4 要求的武器护甲映射表
 *
 * **不要手工编辑这两个文件** —— 它们每次都会被覆盖。
 * 改数据（packages/shared/src/data/classes/*.ts）后跑 `pnpm docs` 重新生成。
 *
 * 这样做的理由：附录A 要求「先输出完整检查表再开始实现」。手写的检查表会在
 * 第一次改动技能数值后立刻过期，而生成的检查表永远等于代码里的真实状态。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_CLASSES, isDedicatedInterrupt } from '../packages/shared/src/data/index.js';
import type { ArmorDef, EffectDef, ShapeDef, SkillDef, WeaponDef } from '../packages/shared/src/data/schema.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BANNER = (source: string) =>
  `<!-- 本文件由 scripts/gen-docs.ts 自动生成，请勿手工编辑。\n` +
  `     数据来源：${source}\n` +
  `     重新生成：pnpm docs -->\n`;

// ── 格式化辅助 ───────────────────────────────────────────────────

const TARGETING_LABEL: Record<string, string> = {
  direct: '直接目标',
  ground: '地面目标',
  line: '方向直线',
  cone: '方向锥形',
  selfCenter: '自身中心',
  projectile: '碰撞投射物',
  self: '自身',
};

const CAST_LABEL: Record<string, string> = {
  instant: '瞬发',
  cast: '读条',
  channel: '引导',
  aimedShot: '瞄准射击',
};

const SCHOOL_LABEL: Record<string, string> = {
  physical: '物理',
  holy: '神圣',
  fire: '火焰',
  frost: '寒冰',
  arcane: '奥术',
  shadow: '暗影',
  nature: '自然',
};

const FILTER_LABEL: Record<string, string> = {
  enemy: '敌方',
  ally: '友方',
  self: '自身',
  any: '任意',
};

const shapeLabel = (s: ShapeDef): string => {
  switch (s.kind) {
    case 'single': return '单体';
    case 'circle': return `圆形 r=${s.radius}${s.maxTargets ? `（最多 ${s.maxTargets} 个）` : ''}`;
    case 'ring': return `环形 ${s.innerRadius}~${s.outerRadius}`;
    case 'cone': return `锥形 ${s.angleDeg}° × ${s.range}m`;
    case 'line': return `直线 ${s.length}m × ${s.width}m`;
    case 'chain': return `链式 跳${s.jumpRange}m × ${s.maxTargets}`;
  }
};

const rangeLabel = (s: SkillDef): string => {
  if (s.range.max === 0) return '自身';
  const base = s.range.min > 0 ? `${s.range.min}–${s.range.max}m` : `${s.range.max}m`;
  return s.rangeFromWeapon ? `${base}（随武器）` : base;
};

const castLabel = (s: SkillDef): string => {
  const kind = CAST_LABEL[s.cast.kind] ?? s.cast.kind;
  if (s.cast.kind === 'instant') return kind;
  if (s.cast.kind === 'channel')
    return `${kind} ${s.cast.time}s+${s.cast.channelDuration ?? 0}s`;
  return `${kind} ${s.cast.time}s`;
};

/** 汇总一个技能的主要效果类别，便于快速扫读 */
const effectKinds = (effects: readonly EffectDef[]): string => {
  const kinds = new Set<string>();
  const walk = (list: readonly EffectDef[]) => {
    for (const e of list) {
      kinds.add(e.kind);
      if (e.kind === 'applyAura' && e.aura.periodic) walk(e.aura.periodic.effects);
      if (e.kind === 'spawnGroundArea' && e.onTick) walk(e.onTick);
      if (e.kind === 'delayedGroundImpact') walk(e.onImpact);
      if (e.kind === 'spawnTrap') walk(e.onTrigger);
      if (e.kind === 'spawnProjectile') walk(e.onHit);
      if (e.kind === 'onNthHit') walk(e.effects);
    }
  };
  walk(effects);
  return [...kinds].join(', ');
};

const flags = (s: SkillDef): string => {
  const f: string[] = [];
  if (!s.triggersGcd) f.push('脱离GCD');
  if (s.requiresFacing) f.push('需朝向');
  if (s.requiresLos) f.push('需视线');
  if (s.dropsFlagOnUse) f.push('掉旗');
  if (s.forbiddenWhileCarryingFlag) f.push('持旗禁用');
  if (s.usableWhileStunned) f.push('昏迷可用');
  if (s.requiresComboPoints) f.push('消耗连击点');
  return f.length ? f.join('/') : '—';
};

const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

// ── 04 技能检查表 ────────────────────────────────────────────────

const genSkillMatrix = (): string => {
  const out: string[] = [];
  out.push(BANNER('packages/shared/src/data/classes/*.ts'));
  out.push('# 八职业技能完整检查表\n');
  out.push(
    '> 规格书附录A#2 要求「先输出模式、职业、技能、瞄准类型、范围、施法与打断、装备映射的完整检查表，再开始实现」，',
    '> 附录A#3 要求每个技能标注九项属性。本文件由 `scripts/gen-docs.ts` 从 `packages/shared/src/data/` 直接生成，',
    '> 因此**它永远等于代码里的真实状态**，不会像手写文档那样过期。\n',
  );

  // 总览
  out.push('## 总览\n');
  out.push('| 职业 | 定位 | 生命 | 资源 | 技能数 | 专用打断 | 武器方案 | 护甲方案 |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const c of ALL_CLASSES) {
    const interrupt = c.skills.find(isDedicatedInterrupt);
    const silence = c.skills.find((s) => s.effects.some((e) => e.kind === 'silence'));
    const label = interrupt ? interrupt.name : silence ? `${silence.name}（等价沉默）` : '**缺失**';
    out.push(
      `| ${c.name} | ${esc(c.role)} | ${c.baseHealth} | ${c.resources.map((r) => r.resource).join(' + ')} | ` +
        `${c.skills.length} | ${label} | ${c.weapons.length} | ${c.armors.length} |`,
    );
  }
  out.push('');

  // 瞄准类型分布：验收 #7 要求六类可区分
  out.push('## 瞄准类型分布（验收 #7）\n');
  const byTargeting = new Map<string, string[]>();
  for (const c of ALL_CLASSES)
    for (const s of c.skills) {
      const k = TARGETING_LABEL[s.targeting] ?? s.targeting;
      byTargeting.set(k, [...(byTargeting.get(k) ?? []), `${c.name}·${s.name}`]);
    }
  out.push('| 瞄准类型 | 技能数 | 技能 |');
  out.push('|---|---|---|');
  for (const [k, v] of byTargeting) out.push(`| ${k} | ${v.length} | ${esc(v.join('、'))} |`);
  out.push('');

  // 逐职业
  for (const c of ALL_CLASSES) {
    out.push(`## ${c.name}\n`);
    out.push(`**定位**：${c.role}　**生命**：${c.baseHealth}　**资源**：${c.resources.map((r) => `${r.resource}(${r.max})`).join(' + ')}\n`);
    out.push(`**优势**：${c.strengths}\n`);
    out.push(`**弱点**：${c.weaknesses}\n`);
    out.push('| 技能 | 瞄准 | 目标 | 距离 | 形状 | 施放 | 可移动 | 可打断 | 学派 | 冷却 | 标记 | 效果 |');
    out.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const s of c.skills) {
      out.push(
        `| **${s.name}**<br/>\`${s.id}\` | ${TARGETING_LABEL[s.targeting] ?? s.targeting} | ` +
          `${FILTER_LABEL[s.targetFilter] ?? s.targetFilter} | ${rangeLabel(s)} | ${shapeLabel(s.shape)} | ` +
          `${castLabel(s)} | ${s.cast.movable ? '✓' : '✗'} | ${s.cast.interruptible ? '✓' : '✗（盾牌标记）'} | ` +
          `${SCHOOL_LABEL[s.school] ?? s.school} | ${s.cooldown ? `${s.cooldown}s` : '—'} | ${flags(s)} | ` +
          `${esc(effectKinds(s.effects))} |`,
      );
    }
    out.push('');
    out.push('<details><summary>反制方式（附录A#3 第九项）</summary>\n');
    for (const s of c.skills) out.push(`- **${s.name}**：${s.counters}`);
    out.push('\n</details>\n');
  }

  return out.join('\n');
};

// ── 05 装备映射表 ────────────────────────────────────────────────

const weaponRow = (w: WeaponDef): string => {
  const changes: string[] = [];
  if (w.grantsSkills?.length) changes.push(`获得 ${w.grantsSkills.join(', ')}`);
  if (w.removesSkills?.length) changes.push(`禁用 ${w.removesSkills.join(', ')}`);
  for (const [k, v] of Object.entries(w.skillModifiers ?? {})) {
    const parts = Object.entries(v).map(([mk, mv]) => `${mk}=${mv}`);
    changes.push(`${k}: ${parts.join(' ')}`);
  }
  const hands: Record<string, string> = {
    oneHand: '单手', twoHand: '双手', dualWield: '双持', ranged: '远程', staff: '法杖',
  };
  return (
    `| ${w.isDefault ? '**' : ''}${w.name}${w.isDefault ? '**（默认）' : ''} | ${hands[w.handedness] ?? w.handedness} | ` +
    `${(w.swingPercent * 100).toFixed(0)}% | ${w.swingInterval}s | ${w.reach}m | ` +
    `${esc(w.advantage)} | ${esc(w.cost)} | ${esc(changes.join('；') || '—')} |`
  );
};

const armorRow = (a: ArmorDef): string => {
  const mods = Object.entries(a.modifiers)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? v : JSON.stringify(v)}`)
    .join(' ');
  return `| ${a.isDefault ? '**' : ''}${a.name}${a.isDefault ? '**（默认）' : ''} | ${a.archetype} | ${esc(a.advantage)} | ${esc(a.cost)} | ${esc(mods || '—')} |`;
};

const genEquipment = (): string => {
  const out: string[] = [];
  out.push(BANNER('packages/shared/src/data/classes/*.ts、packages/shared/src/data/armors.ts'));
  out.push('# 武器、护甲与装备映射表\n');
  out.push(
    '> 规格书附录A#4：每件武器和护甲必须标注所属职业、攻击间隔、距离、优势、代价和改变的技能。',
    '> 本文件由 `scripts/gen-docs.ts` 自动生成。装备系统的**规则**（拾取、换装、军械箱、职业锁定）',
    '> 见规格书第 10 章与 [01-development-plan.md](01-development-plan.md) 的 M6。\n',
  );

  out.push('## 设计约束（规格书 17.1 / 验收 #32）\n');
  out.push('- 临时装备必须**横向取舍**，不能同时提高伤害、攻速、防御、移动和控制');
  out.push('- 每件装备都必须同时有明确的优势与代价，不存在全面上位装备');
  out.push('- 武器和护甲带职业归属，**不允许跨职业使用**（10.2 / 验收 #29）');
  out.push('- 每个职业始终保留 1 套不可删除的默认武器和默认护甲，默认装备永不掉落（10.6）');
  out.push('- 最多携带 2 套临时武器、2 套临时护甲、2 个主动增益道具（10.6）\n');

  out.push('## 武器方案\n');
  for (const c of ALL_CLASSES) {
    out.push(`### ${c.name}\n`);
    out.push('| 方案 | 类型 | 单击 | 攻击间隔 | 距离 | 优势 | 代价 | 改变的技能 |');
    out.push('|---|---|---|---|---|---|---|---|');
    for (const w of c.weapons) out.push(weaponRow(w));
    out.push('');
  }

  out.push('## 护甲方案（10.8 五种横向原型）\n');
  out.push(
    '所有职业共用同一组原型结构，由 `packages/shared/src/data/armors.ts` 的 `makeArmorSet` 工厂生成，',
    '保证不会出现某个职业的某件护甲意外变成全面上位。\n',
  );
  for (const c of ALL_CLASSES) {
    out.push(`### ${c.name}\n`);
    out.push('| 方案 | 原型 | 优势 | 代价 | 数值修正 |');
    out.push('|---|---|---|---|---|');
    for (const a of c.armors) out.push(armorRow(a));
    out.push('');
  }

  return out.join('\n');
};

// ── 主流程 ───────────────────────────────────────────────────────

const write = (rel: string, content: string) => {
  const path = resolve(ROOT, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  console.log(`generated ${rel} (${content.split('\n').length} 行)`);
};

write('docs/04-class-skill-matrix.md', genSkillMatrix());
write('docs/05-equipment-system.md', genEquipment());
