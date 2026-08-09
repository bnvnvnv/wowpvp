/**
 * HUD 测试。规格书 15.1 / 15.3 / 15.4，验收 #5 / #35。
 *
 * 这里重点验两条**否定式**规则，它们靠肉眼看是看不出来的：
 *   · 15.4「竞技场不显示任何旗帜信息」
 *   · 验收 #5「未被发现的潜行目标不能被小地图选中」
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALL_SKILLS,
  CastFailure,
  CastKind,
  FlagState,
  RANGE,
  School,
  TEAM_BLUE,
  TEAM_RED,
  asSkillId,
  getSkill,
  mage,
  type CastState,
  type WeaponDef,
} from '@wowpvp/shared';
import { castBarProgress } from './CombatHud.js';
import {
  isFlagBlip,
  type ArenaBlip,
  type ArenaHudView,
  type CtfHudView,
  type MinimapBlip,
} from './ModeHud.js';
import { MAX_PARTY_MEMBERS, type PartyMemberView } from './PartyFrame.js';
import { CRIT_POP, POP_IN, POP_PEAK, POP_SETTLE, isCritKind, popScale } from './FloatingNumbers.js';
import { SWAP_INTERRUPT_TEXT, compareArmors, compareWeapons } from './LoadoutPanel.js';
import { CONTROL_VISUALS } from '../vfx/status.js';
import {
  BLOCKER_GLYPH,
  blockerCategory,
  blockerText,
  castMethodText,
  cooldownText,
  escHtml,
  pickBlocker,
  rangeText,
  skillTooltipHtml,
} from './skillTooltip.js';
import type { HudSkillSlot } from './CombatView.js';

/** 源码文本。★ 下面几条是**回归锁**：它们锁的是「这一行还在不在」 */
const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const INDEX_HTML = readSrc('../../index.html');
const COMBAT_HUD_SRC = readSrc('./CombatHud.ts');

describe('★ 15.4 竞技场不显示任何旗帜信息', () => {
  it('★★ ArenaHudView 的字段里没有任何旗帜相关项', () => {
    // 类型上不存在，所以这里只能用运行时对象来表达这条约束：
    // 构造一个完整的竞技场视图，断言它的 key 集合里没有旗帜字样
    const v: ArenaHudView = {
      aliveRed: 3,
      aliveBlue: 2,
      round: 1,
      scoreRed: 0,
      scoreBlue: 0,
      dampening: 0.2,
      suddenDeath: false,
    };
    const keys = Object.keys(v).join(' ').toLowerCase();
    expect(keys).not.toContain('flag');
    expect(keys).not.toContain('carrier');
  });

  it('★★ 竞技场小地图的 blip 类型排除了旗手与掉落旗帜', () => {
    // ArenaBlip 是 MinimapBlip 的收窄类型。下面两行如果能通过类型检查就说明收窄失效了 ——
    // 这里用运行时断言把这条约束记下来，同时验证 isFlagBlip 的判定
    const allowed: ArenaBlip['kind'][] = ['self', 'ally', 'enemy', 'supply'];
    for (const kind of allowed) {
      expect(isFlagBlip({ x: 0, z: 0, kind })).toBe(false);
    }
    for (const kind of ['flagCarrier', 'droppedFlag'] as const) {
      expect(isFlagBlip({ x: 0, z: 0, kind })).toBe(true);
    }
  });

  it('夺旗视图**有**旗帜字段 —— 两种模式确实是两张不同的表', () => {
    const v: CtfHudView = {
      scoreRed: 1,
      scoreBlue: 0,
      scoreToWin: 3,
      timeRemaining: 600,
      flags: [
        { team: TEAM_RED, state: FlagState.AtBase, position: { x: 0, y: 0, z: 10 } },
        { team: TEAM_BLUE, state: FlagState.Carried, position: { x: 0, y: 0, z: -5 }, carrierName: '甲' },
      ],
      focusStacks: 0,
    };
    expect(v.flags).toHaveLength(2);
    expect(v.flags[1]!.carrierName).toBe('甲');
  });
});

describe('★ 验收 #5：小地图不能泄露未被发现的潜行者', () => {
  it('★★ Minimap.draw 只接受调用方给的列表，自己拿不到世界状态', () => {
    // 这条约束在类型层面表达为：draw 的入参是 readonly MinimapBlip[]，
    // Minimap 的构造函数只接收一个 HTMLElement —— 没有 World、没有实体表。
    // 所以"画出了未被发现的潜行者"必然是调用方传错了，不可能是小地图自己去查的。
    const blips: MinimapBlip[] = [{ x: 0, z: 0, kind: 'self' }];
    expect(blips.every((b) => 'kind' in b)).toBe(true);
    // 过滤责任在网络层（M9 的 net/visibility.ts），这里显式记录
    expect(isFlagBlip({ x: 0, z: 0, kind: 'enemy' })).toBe(false);
  });
});

describe('15.1 左侧队伍框', () => {
  const member = (over: Partial<PartyMemberView> = {}): PartyMemberView => ({
    id: 1,
    name: '甲',
    className: '战士',
    health: 80,
    maxHealth: 100,
    controls: [],
    dead: false,
    carryingFlag: false,
    ...over,
  });

  it('★ 15.1 要求的六项在类型里全是必填', () => {
    const m = member();
    // 少写任何一项都是编译错误；这里断言六项都在
    for (const k of ['health', 'maxHealth', 'className', 'controls', 'dead', 'carryingFlag']) {
      expect(k in m, k).toBe(true);
    }
  });

  it('★ 最多 12 名（12v12 每边正好 12 人）', () => {
    expect(MAX_PARTY_MEMBERS).toBe(12);
  });

  it('★ 控制状态与 3D 场景共用同一张字形表 —— 玩家不用学两套符号', () => {
    const m = member({ controls: ['silenced'] });
    expect(CONTROL_VISUALS[m.controls[0]!].glyph).toBe(CONTROL_VISUALS.silenced.glyph);
  });

  it('资源可以缺省 —— 有的职业没有主资源', () => {
    expect(member().resource).toBeUndefined();
    expect(member({ resource: { current: 50, max: 100, label: '法力' } }).resource?.max).toBe(100);
  });
});

describe('★ 15.3 战场装备栏（验收 #35）', () => {
  const weapons = mage.weapons;
  const first = weapons[0]!;
  const second = weapons.find((w) => w.id !== first.id)!;

  it('★★ 拾取时直接比较新旧，只列**变了**的项而不是堆全字段表', () => {
    const diff = compareWeapons(first, second);
    expect(diff.length).toBeGreaterThan(0);
    // 每一行都带方向箭头，玩家扫一眼就知道是升还是降
    for (const line of diff) {
      expect(line, line).toMatch(/[↑↓⇄]/);
    }
    // 15.3 第三条的重点是"不只显示复杂数值" —— 所以要短。
    // ★ 上界随 P8 从 4 抬到 6：`compareWeapons` 补了 modifiers 差异行
    //   （法杖 vs 法球在造成伤害/受到伤害/资源获取上都不同），而
    //   `slice(0, 6)` 才是实现里真正的截断点。这里写 4 只是老实现的
    //   巧合值，不是规格 —— 断言应该盯实现的上界，否则加一条合理的
    //   差异行就要红一次。
    expect(diff.length).toBeLessThanOrEqual(6);
  });

  it('同一件装备与自己比较时没有差异行', () => {
    expect(compareWeapons(first, first)).toEqual([]);
  });

  it('没有当前装备时给出「新武器」而不是空列表', () => {
    expect(compareWeapons(undefined, first)[0]).toContain('新武器');
  });

  it('护甲比较基于 modifiers，不依赖不存在的「防御值」字段', () => {
    const armors = mage.armors;
    if (armors.length < 2) return;
    const d = compareArmors(armors[0]!, armors[1]!);
    for (const line of d) expect(line).toMatch(/[↑↓⇄]/);
  });

  it('★ 15.3 第二条：换装中断要有明确原因，五种都有中文文案', () => {
    for (const k of ['damage', 'control', 'movement', 'forcedMove', 'cancelled']) {
      expect(SWAP_INTERRUPT_TEXT[k], k).toBeTruthy();
    }
  });

  it('武器的优势与代价直接来自数据，不是 UI 自己编的（附录A#4）', () => {
    for (const w of weapons as WeaponDef[]) {
      expect(w.advantage.length, w.name).toBeGreaterThan(0);
      expect(w.cost.length, w.name).toBeGreaterThan(0);
    }
  });
});

describe('★★ P10 技能栏可点击 —— 一行 CSS 决定整条链是不是死代码', () => {
  it('★★ `#skill-bar .slot` 必须有 pointer-events:auto', () => {
    /**
     * ⚠️ 这条锁的是一个**沉默失效**：`#skill-bar` 容器是 pointer-events:none
     *   （正确，它不能挡住 3D 画布），而 `.slot` 从来没改回 auto ——
     *   于是 CombatHud 里那条 mousedown 委托和 `.slot.usable:hover` 动效
     *   全是死代码：代码在，事件永远不会来，没有任何报错。
     *   删掉这一行不会红任何别的测试，所以必须有一条专门盯着它。
     */
    const rule = /#skill-bar\s+\.slot\s*\{[^}]*pointer-events:\s*auto/;
    expect(rule.test(INDEX_HTML), '#skill-bar .slot 的 pointer-events:auto 不见了').toBe(true);
    // 容器必须**保持** none，否则技能栏会挡住它下面的画布点击
    expect(/#skill-bar\s*\{[^}]*pointer-events:\s*none/.test(INDEX_HTML)).toBe(true);
  });

  it('★ 技能栏层级压过战斗日志与装备栏（1280×720 上真的会重叠）', () => {
    expect(/#skill-bar\s*\{[^}]*z-index:\s*\d+/.test(INDEX_HTML)).toBe(true);
  });

  it('★ mousedown 只认左键 —— 右键是转镜头，不该顺手放个技能', () => {
    expect(COMBAT_HUD_SRC).toContain('ev.button !== 0');
    // HUD 区域内拦下浏览器右键菜单（画布上那条在 InputManager，管不到浮层）
    expect(COMBAT_HUD_SRC).toContain("addEventListener('contextmenu'");
  });

  it('★ 帮助面板在 720p 上不再被 calc(100vh - 560px) 压成 158px', () => {
    expect(INDEX_HTML).toContain('min(70vh, calc(100vh - 220px))');
    expect(INDEX_HTML).not.toContain('max-height: calc(100vh - 560px)');
  });

  it('★ 战斗日志有底板且字号 ≥12px —— 死亡/失败只走这一条通道', () => {
    const block = /#combat-log\s*\{[^}]*\}/.exec(INDEX_HTML)?.[0] ?? '';
    expect(block).toMatch(/background:\s*rgba\(12,\s*14,\s*20,\s*\.55\)/);
    expect(block).toMatch(/font-size:\s*12px/);
  });
});

describe('★★ 技能 tooltip —— SkillDef.description / counters 的第一个消费方', () => {
  const smite = getSkill(asSkillId('priest.smite'))!;

  it('★★ 每一个技能的 description 与 counters 都真的出现在 tooltip 里', () => {
    /**
     * schema.ts 的注释写着「反制方式……**也直接用于 HUD tooltip**」，
     * 91 个技能都填了，客户端却零消费。这条按全表断言，
     * 以后加技能忘了填也会在这里红（data.test.ts 保证非空，这里保证被用上）。
     */
    for (const s of ALL_SKILLS) {
      const html = skillTooltipHtml(s);
      expect(html, `${s.id} 的说明没进 tooltip`).toContain(escHtml(s.description));
      expect(html, `${s.id} 的反制没进 tooltip`).toContain(escHtml(s.counters));
      expect(html, `${s.id} 的名称没进 tooltip`).toContain(escHtml(s.name));
    }
  });

  it('★ 规格要求的六项都在：名称/学派/消耗/施法方式/射程/冷却', () => {
    const html = skillTooltipHtml(smite);
    for (const label of ['消耗', '施法', '射程', '冷却', '反制']) {
      expect(html, label).toContain(label);
    }
    expect(html).toContain('神圣'); // 学派用中文，不是 'holy'
  });

  it('★★ 「脱GCD」这个黑话在 tooltip 里必须写全', () => {
    const noGcd = ALL_SKILLS.filter((s) => !s.triggersGcd);
    expect(noGcd.length, '数据里应当存在不触发 GCD 的技能').toBeGreaterThan(0);
    for (const s of noGcd) {
      expect(cooldownText(s), s.id as string).toContain('不占公共冷却');
      expect(skillTooltipHtml(s), s.id as string).not.toContain('脱GCD');
    }
  });

  it('★ 施法方式说的是「怎么被反制」，不是一个光秃秃的秒数', () => {
    for (const s of ALL_SKILLS) {
      const t = castMethodText(s);
      expect(t, s.id as string).toMatch(/瞬发|读条|引导|射击准备/);
      // 不可打断是 7.5 的关键信息，读条类必须说出来
      if (s.cast.kind !== 'instant' && !s.cast.interruptible) {
        expect(t, s.id as string).toContain('不可打断');
      }
    }
  });

  it('★ 射程随武器变化的技能不许写死数字撒谎', () => {
    for (const s of ALL_SKILLS.filter((x) => x.rangeFromWeapon)) {
      expect(rangeText(s), s.id as string).toContain('随当前武器触及变化');
    }
    expect(rangeText({ ...smite, range: { min: 0, max: 0 } })).toBe('自身');
  });

  it('★ 用自绘浮层而不是原生 title —— 技能格上不许再挂 title 属性', () => {
    const bar = /private renderSkillBar[\s\S]*?\n {2}\}/.exec(COMBAT_HUD_SRC)?.[0] ?? '';
    expect(bar.length).toBeGreaterThan(0);
    expect(bar).not.toContain('title=');
    // 无障碍三件套
    expect(bar).toContain('role="button"');
    expect(bar).toContain('tabindex="0"');
    expect(bar).toContain('aria-label=');
  });

  it('★★ 浮层锚点必须现场命中测试，不许回到 `:hover` / mouseout 记账', () => {
    /**
     * ⚠️ 这条是**两次真机复验换来的**，改回去不会红任何别的断言：
     *   · 技能栏每 50ms 重建 innerHTML，刚换完那一帧 `.slot:hover` 恒为 null
     *     ⇒ tooltip 一次都不会出现；
     *   · 鼠标底下的格子被删掉后再移开，mouseout 从已脱离文档的节点发出，
     *     冒泡不到技能栏 ⇒ tooltip 收不回去。
     *   `elementFromPoint` 没有任何跨帧状态，两个坑都绕开了。
     */
    const fn = /private syncSkillTip[\s\S]*?\n {2}\}/.exec(COMBAT_HUD_SRC)?.[0] ?? '';
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toContain('document.elementFromPoint');
    expect(fn).not.toContain(':hover');
  });

  it('★★ 点击技能格之后必须退焦 —— 否则 Space 被格子吃掉，跳跃失灵', () => {
    // mousedown 的 preventDefault 实测压不住聚焦（真机复验：点完
    // activeElement 就是那个 .slot）。退焦必须是显式的一步。
    expect(COMBAT_HUD_SRC).toMatch(/setTimeout\(\(\) => \{[\s\S]{0,160}?a\.blur\(\);/);
  });

  it('转义不漏：说明里出现尖括号也不会把浮层的 HTML 撑破', () => {
    const evil = { ...smite, description: '<img src=x onerror="boom">&' };
    const html = skillTooltipHtml(evil);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('★ 合同 C1：不可用原因的分级显示', () => {
  it('★★ 顺序是「位置→视线→朝向→资源→冷却→状态」', () => {
    // 同时超距 + 没资源 + 冷却中 → 先让玩家去解决站位
    expect(pickBlocker([
      CastFailure.OnCooldown, CastFailure.NotEnoughResource, CastFailure.OutOfRange,
    ])).toBe(CastFailure.OutOfRange);
    expect(pickBlocker([CastFailure.WrongFacing, CastFailure.NoLineOfSight]))
      .toBe(CastFailure.NoLineOfSight);
    expect(pickBlocker([CastFailure.Silenced, CastFailure.OnGlobalCooldown]))
      .toBe(CastFailure.OnGlobalCooldown);
    expect(pickBlocker([CastFailure.NotEnoughResource, CastFailure.WrongFacing]))
      .toBe(CastFailure.WrongFacing);
  });

  it('★ 空数组 / 全是 Ok → Ok，生产方没填时不会被误判成「有阻碍」', () => {
    expect(pickBlocker([])).toBe(CastFailure.Ok);
    expect(pickBlocker([CastFailure.Ok])).toBe(CastFailure.Ok);
  });

  it('★★ 17.2：四类阻碍的字形两两不同 —— 颜色之外还有第二通道', () => {
    const glyphs = Object.values(BLOCKER_GLYPH);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it('★ 分类落点：位置/资源/冷却/状态', () => {
    for (const f of [
      CastFailure.OutOfRange, CastFailure.TooClose,
      CastFailure.NoLineOfSight, CastFailure.WrongFacing,
    ]) {
      expect(blockerCategory(f), f).toBe('position');
    }
    expect(blockerCategory(CastFailure.NotEnoughResource)).toBe('resource');
    expect(blockerCategory(CastFailure.OnCooldown)).toBe('cooldown');
    expect(blockerCategory(CastFailure.OnGlobalCooldown)).toBe('cooldown');
    for (const f of [CastFailure.Silenced, CastFailure.Dead, CastFailure.CarryingFlag]) {
      expect(blockerCategory(f), f).toBe('state');
    }
  });

  it('★ 冷却类把秒数带上：「还剩多久」比「冷却中」有用', () => {
    expect(blockerText(CastFailure.OnGlobalCooldown, 0.8)).toBe('公共冷却 0.8s');
    expect(blockerText(CastFailure.OnGlobalCooldown)).toBe('公共冷却');
    expect(blockerText(CastFailure.OnGlobalCooldown, 0)).toBe('公共冷却');
  });

  it('★ 合同 C1 的三个新字段都是可选的 —— 生产方没跟上也不该编译报错', () => {
    const bare: HudSkillSlot = {
      skill: getSkill(asSkillId('priest.smite'))!,
      cooldownRemaining: 0,
      blocker: CastFailure.Ok,
    };
    expect(bare.gcdRemaining).toBeUndefined();
    expect(bare.gcdTotal).toBeUndefined();
    expect(bare.blockers).toBeUndefined();
  });

  it('★ GCD 扫层只在两个字段都有值时画 —— 不画停在 0 度的假扫层', () => {
    const bar = /private renderSkillBar[\s\S]*?\n {2}\}/.exec(COMBAT_HUD_SRC)?.[0] ?? '';
    expect(bar).toContain('s.gcdRemaining !== undefined && s.gcdRemaining > 0');
    expect(bar).toContain('s.gcdTotal !== undefined && s.gcdTotal > 0');
    expect(INDEX_HTML).toContain('--gcd-deg');
  });
});

describe('★★ 15.2 敌方施法条必须显示技能**名称**，不是内部 id', () => {
  it('★★ 全局技能表能查到别的职业的技能名（玩家自己那 9 格查不到）', () => {
    /**
     * 真机实测：法师看牧师读条，施法条上写的是 `priest.flash_heal`。
     * 根因是 HUD 从 `dir.skills`（**玩家自己的技能**）里查名字。
     * 7.5 的打断博弈全靠这一行 —— 是治疗还是伤害决定要不要交打断。
     */
    for (const id of ['priest.flash_heal', 'priest.smite']) {
      const s = getSkill(asSkillId(id));
      expect(s, id).toBeDefined();
      expect(s!.name, id).not.toBe(id);
      expect(mage.skills.some((m) => String(m.id) === id), '法师栏里不该有牧师技能').toBe(false);
    }
  });

  it('★ 实现确实改成了先查全局表，玩家栏只作兜底', () => {
    const fn = /private castBarHtml[\s\S]*?const skill = [\s\S]*?;\n/.exec(COMBAT_HUD_SRC)?.[0] ?? '';
    expect(fn).toContain('getSkill(cast.skillId)');
    // 兜底仍在，但排在全局表之后
    expect(fn.indexOf('getSkill(cast.skillId)')).toBeLessThan(fn.indexOf('dir.skills.find'));
  });
});

describe('★ 目标框与姓名板的收尾', () => {
  it('★ 隐藏目标框时一并清空内容，不留幽灵数据', () => {
    const fn = /private renderUnitFrame\([\s\S]*?if \(!unit\) \{[\s\S]*?\n {4}\}/.exec(COMBAT_HUD_SRC)?.[0] ?? '';
    expect(fn).toContain("el.innerHTML = ''");
  });

  it('★★ 姓名板剔除距离与服务器侧校验同一个常量（合同 C6 口径）', () => {
    expect(COMBAT_HUD_SRC).toContain('RANGE.MAX_SELECT');
    // 45 米不是这里定的，改了就一起改
    expect(RANGE.MAX_SELECT).toBe(45);
  });

  it('★ 目标框敌我：颜色 + ▲/◆ 字形 + 友方/敌方文字，三条通道', () => {
    expect(COMBAT_HUD_SRC).toContain("classList.toggle('uf-friendly'");
    expect(COMBAT_HUD_SRC).toContain("'友方' : '敌方'");
    expect(INDEX_HTML).toContain(".unit-frame.uf-friendly .uf-name::before");
    expect(INDEX_HTML).toContain(".unit-frame.uf-hostile .uf-name::before");
  });

  it('★ 合同 C2：showCenterNotice 与瞄准透传都在，且默认不改老行为', () => {
    expect(COMBAT_HUD_SRC).toContain('showCenterNotice(text: string): void');
    expect(COMBAT_HUD_SRC).toContain('aimActiveProbe: (() => boolean) | undefined');
    expect(COMBAT_HUD_SRC).toContain('onAimConfirm: (() => void) | undefined');
    // 探针为真时**先 return**，不落到 selectById
    expect(COMBAT_HUD_SRC).toMatch(/if \(this\.aimActiveProbe\?\.\(\)\) \{\s*\n\s*this\.onAimConfirm\?\.\(\);\s*\n\s*return;/);
  });
});

/**
 * X6 老账：引导条曾经走读条口径。
 *
 * ★★ 这一组钉的是**方向**，不是数值好不好看：读条向右涨、引导向左缩
 *   （WoW 口径）。老实现把冰霜风暴（0.8s 读条 + 4s 引导）在第 0.8 秒
 *   涨满，然后顶着 100% 站 4 秒、秒数读数常驻 0.0 —— 玩家读不出引导
 *   还剩多久，7.5 的打断博弈失去唯一信息来源。
 */
describe('★★ X6：引导条向左缩，普通读条向右涨', () => {
  /** 一条读条状态。`sim/casting.ts` 起手时填的就是这些字段 */
  const castState = (over: Partial<CastState> = {}): CastState => ({
    skillId: asSkillId('mage.frostbolt'),
    kind: CastKind.Cast,
    startedAt: 100,
    endsAt: 101.4,
    facing: 0,
    startPosition: { x: 0, y: 0, z: 0 },
    school: School.Frost,
    interruptible: true,
    requiresStationary: true,
    ...over,
  });

  /** 冰霜风暴：0.8 秒读条 + 4 秒引导，`channelEndsAt = endsAt + 4` */
  const blizzard = (): CastState => castState({
    skillId: asSkillId('mage.blizzard'),
    kind: CastKind.Channel,
    startedAt: 100,
    endsAt: 100.8,
    channelEndsAt: 104.8,
  });

  /**
   * 改造**之前**那三行算式，原样抄在这里。
   * ★ 它是普通读条的回归基准 —— 新实现在读条分支上必须逐点等于它。
   */
  const legacyPct = (cast: CastState, now: number): number => {
    const total = Math.max(0.01, cast.endsAt - cast.startedAt);
    const remaining = Math.max(0, cast.endsAt - now);
    return Math.min(100, ((total - remaining) / total) * 100);
  };

  it('★ 数据前提：冰霜风暴确实是 channel，且引导段 4 秒（改了就一起改）', () => {
    const s = getSkill(asSkillId('mage.blizzard'));
    expect(s).toBeDefined();
    expect(s!.cast.kind).toBe(CastKind.Channel);
    expect(s!.cast.time).toBe(0.8);
    expect(s!.cast.channelDuration).toBe(4);
  });

  it('★★ 普通读条不回归：逐点等于改造前的公式，且严格单调上升', () => {
    const c = castState();
    let prev = -1;
    for (let t = 99.5; t <= 102; t += 0.05) {
      const p = castBarProgress(c, t);
      expect(p.channeling, `t=${t}`).toBe(false);
      expect(p.pct, `t=${t}`).toBeCloseTo(legacyPct(c, t), 10);
      // 条上的秒数也不能变：老实现印的是 max(0, endsAt - now)
      expect(p.remaining, `t=${t}`).toBeCloseTo(Math.max(0, c.endsAt - t), 10);
      if (t >= 100 && t <= 101.4) expect(p.pct, `t=${t}`).toBeGreaterThan(prev);
      prev = p.pct;
    }
    expect(castBarProgress(c, 100).pct).toBe(0);
    expect(castBarProgress(c, 101.4).pct).toBe(100);
  });

  it('★ 引导技能的**前摇段**仍是一根正常读条（两条独立时间轴的第一条）', () => {
    const c = blizzard();
    expect(castBarProgress(c, 100).channeling).toBe(false);
    expect(castBarProgress(c, 100.4).channeling).toBe(false);
    // 前摇段逐点等于老公式：0.8 秒那一段的行为没有被这次改动碰过
    for (const t of [100, 100.2, 100.4, 100.6]) {
      expect(castBarProgress(c, t).pct, `t=${t}`).toBeCloseTo(legacyPct(c, t), 10);
    }
    expect(castBarProgress(c, 100.4).pct).toBeCloseTo(50, 6);
  });

  it('★★ 引导段方向与读条**相反**：从 100% 单调下降到 0', () => {
    const c = blizzard();
    expect(castBarProgress(c, 100.8).channeling).toBe(true);
    expect(castBarProgress(c, 100.8).pct).toBeCloseTo(100, 6);
    expect(castBarProgress(c, 102.8).pct).toBeCloseTo(50, 6);
    expect(castBarProgress(c, 104.8).pct).toBeCloseTo(0, 6);

    let prev = 101;
    for (let t = 100.8; t <= 104.8; t += 0.1) {
      const p = castBarProgress(c, t);
      expect(p.channeling, `t=${t}`).toBe(true);
      expect(p.pct, `t=${t}`).toBeLessThan(prev);
      prev = p.pct;
    }
  });

  it('★★ 同一时刻：引导条在缩、读条在涨 —— 两者方向必须是反的', () => {
    const chan = blizzard();
    const bar = castState({ startedAt: 100, endsAt: 104 });
    // 走完各自 25% 的时刻
    const chanPct = castBarProgress(chan, 100.8 + 1).pct; // 引导过了 1/4
    const barPct = castBarProgress(bar, 101).pct;         // 读条过了 1/4
    expect(chanPct).toBeCloseTo(75, 6);
    expect(barPct).toBeCloseTo(25, 6);
    expect(chanPct + barPct).toBeCloseTo(100, 6);
  });

  it('★★ 引导条上的秒数是**引导剩余**，不是老实现里常驻的 0.0', () => {
    const c = blizzard();
    // 老实现：remaining = max(0, endsAt - now)，第 0.8 秒之后恒为 0
    expect(legacyPct(c, 102.8)).toBe(100);
    expect(Math.max(0, c.endsAt - 102.8)).toBe(0);
    // 新实现：还剩 2 秒
    expect(castBarProgress(c, 102.8).remaining).toBeCloseTo(2, 6);
    expect(castBarProgress(c, 102.8).remaining.toFixed(1)).toBe('2.0');
    // 引导段总时长是引导那一段，不是 0.8 也不是 4.8
    expect(castBarProgress(c, 102.8).total).toBeCloseTo(4, 6);
  });

  it('★ 引导结束之后不越界：pct 钳在 0，秒数钳在 0', () => {
    const c = blizzard();
    const p = castBarProgress(c, 106);
    expect(p.pct).toBe(0);
    expect(p.remaining).toBe(0);
  });

  it('⚠️ kind 是 channel 但缺 channelEndsAt：退回读条口径 = 老行为，不假算', () => {
    const c = castState({ kind: CastKind.Channel, startedAt: 100, endsAt: 100.8 });
    const p = castBarProgress(c, 102);
    expect(p.channeling).toBe(false);
    expect(p.pct).toBeCloseTo(legacyPct(c, 102), 10);
  });

  it('⚠️ 判据看的是 kind，不是「有没有 channelEndsAt」—— 读条技能不会被误判成引导', () => {
    // 理论上不该出现的脏状态：读条却带着 channelEndsAt。判据必须以 kind 为准
    const dirty = castState({ channelEndsAt: 110 });
    expect(castBarProgress(dirty, 102).channeling).toBe(false);
    expect(castBarProgress(dirty, 102).pct).toBeCloseTo(legacyPct(dirty, 102), 10);
  });

  it('★★ 三处施法条同口径：玩家条/目标框与姓名板都调同一个函数', () => {
    // 目标框与玩家条共用 castBarHtml，姓名板是另一条渲染路径 —— 两条都要走它
    const barFn = /private castBarHtml[\s\S]*?\n {2}\}/.exec(COMBAT_HUD_SRC)?.[0] ?? '';
    expect(barFn.length).toBeGreaterThan(0);
    expect(barFn).toContain('castBarProgress(cast, dir.now)');
    const plates = /private renderNameplates[\s\S]*?\n {2}\}/.exec(COMBAT_HUD_SRC)?.[0] ?? '';
    expect(plates.length).toBeGreaterThan(0);
    expect(plates).toContain('castBarProgress(cast, dir.now)');
    /**
     * ★★ 「同口径」只有在**只有一个实现**时才是真的。老账正是三处各写一遍
     *   `endsAt - startedAt` 攒出来的，所以这里锁死：这个减法在全文件
     *   只许出现一次，就是 `castBarProgress` 里的读条分支。
     */
    const dup = COMBAT_HUD_SRC.match(/endsAt - cast\.startedAt/g) ?? [];
    expect(dup).toHaveLength(1);
    // 老的姓名板专用算法必须已经消失
    expect(COMBAT_HUD_SRC).not.toContain('castPct(');
  });

  it('★★ 引导条的 CSS 方向真的反了 —— reverse 只在引导段出现', () => {
    const barFn = /private castBarHtml[\s\S]*?\n {2}\}/.exec(COMBAT_HUD_SRC)?.[0] ?? '';
    // 反向播放同一条 cast-fill 关键帧（没有另加 @keyframes，index.html 不归本批改）
    expect(barFn).toContain("animation-direction:reverse");
    expect(barFn).toMatch(/p\.channeling \? ';animation-direction:reverse' : ''/);
    expect(INDEX_HTML).toContain('@keyframes cast-fill');
    // 动画不生效时的回落值也必须是**剩余**比例，方向不会在 reduce-motion 下说谎
    expect(barFn).toContain('width:${p.pct}%');
  });

  it('★ 条上标「引导」二字 + 剩余秒数（15.2：施法条要显示剩余时间）', () => {
    const barFn = /private castBarHtml[\s\S]*?\n {2}\}/.exec(COMBAT_HUD_SRC)?.[0] ?? '';
    expect(barFn).toContain('引导');
    expect(barFn).toContain('${p.remaining.toFixed(1)}s');
    // 引导标记与不可打断盾牌一样是**条上的标记**，不是只写在 tooltip 里
    expect(barFn).toMatch(/p\.channeling \? '<b class="chan"/);
  });
});

describe('浮动数字弹跳（打击感改造）', () => {
  it('★ 曲线形状：起步 < 峰值、POP_IN 时刻 ≈ 峰值、结束后精确回到 1.0', () => {
    const peak = POP_PEAK.crit;
    expect(popScale(0, peak)).toBeLessThan(peak);
    expect(popScale(POP_IN, peak)).toBeCloseTo(peak, 5);
    expect(popScale(POP_IN + POP_SETTLE, peak)).toBeCloseTo(1, 6);
    expect(popScale(1, peak)).toBeCloseTo(1, 6);
  });

  it('★★ 尺寸是暴击的主通道：crit 峰值 > damage 峰值 × 1.4（17.2 不能只靠颜色）', () => {
    expect(POP_PEAK.crit).toBeGreaterThan(POP_PEAK.damage * 1.4);
  });

  it('★ 默认曲线收敛回 1.0 —— 普通数字不能永远比 CSS 字号大（暴击是唯一例外，见下）', () => {
    for (const peak of Object.values(POP_PEAK)) {
      expect(popScale(POP_IN + POP_SETTLE + 0.01, peak)).toBeCloseTo(1, 6);
    }
  });

  /**
   * X10 追加轮用户两轮拍板：暴击是**从小炸大的爆炸字**（「字从小变大，
   * 效果像个爆炸，字的大小跟人差不多大」），且颜色分敌我（打人橙黄/挨打红）。
   */
  it('★★ 暴击弹道：从小炸到 5 倍峰值（≈角色身高量级），回落仍保持 1.5 倍大字', () => {
    expect(popScale(0, POP_PEAK.crit, CRIT_POP), '爆炸要从小开始').toBeLessThan(1);
    expect(popScale(POP_IN, POP_PEAK.crit, CRIT_POP), 'POP_IN 时刻应在峰值')
      .toBeCloseTo(POP_PEAK.crit, 5);
    expect(POP_PEAK.crit, '峰值要够「跟人差不多大」（26px × 5 ≈ 130px）')
      .toBeGreaterThanOrEqual(5);
    expect(popScale(POP_IN + POP_SETTLE + 0.01, POP_PEAK.crit, CRIT_POP))
      .toBeCloseTo(CRIT_POP.settleTo, 6);
    expect(CRIT_POP.settleTo, '回落尺寸必须仍大于普通数字的 1.0').toBeGreaterThan(1);
  });

  it('★ 挨打的暴击（critTaken）与打人的暴击同弹道 —— 只有颜色分敌我', () => {
    expect(POP_PEAK.critTaken).toBe(POP_PEAK.crit);
    expect(isCritKind('crit') && isCritKind('critTaken')).toBe(true);
    expect(isCritKind('damage')).toBe(false);
  });
});
