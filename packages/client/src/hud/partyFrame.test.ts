/**
 * P10 队伍框可用性修复的回归锚（真机审计四条）。
 *
 * ★ 为什么和 `partyView.test.ts` 分开：那边验的是**投影**（同一个人从实体
 *   与从快照投出来必须逐字段相等），这边验的是**渲染与排版**。两件事的
 *   断点完全不同 —— 投影分叉是语义 bug，排版溢出是几何 bug。
 *
 * ⚠️ client 包没装 jsdom，所以这里一律测**纯函数**：HTML 串、CSS 串、
 *   排版算术。三条被审计坐实的故障恰好都能这么钉住：
 *     · 资源条没标签没数字  → 断言 `channelHtml` 吐出的串里有「标签 当前 / 上限」
 *     · 连击点完全没有 UI   → 断言第二通道吐出 5 颗圆点、亮灭数目对得上
 *     · 12 人溢出压住日志   → 断言 `partyLayout` 的高度落在日志顶边以上
 */

import { describe, expect, it } from 'vitest';

import { TEAM_RED, asClassId, asEntityId, createEntity, getClass, vec3 } from '@wowpvp/shared';

import {
  PARTY_FRAME_CSS,
  PARTY_GAP_PX,
  PARTY_MAX_DOTS,
  PARTY_MEMBER_HEIGHT_PX,
  channelHtml,
  isPointResource,
  memberHtml,
  memberIdOf,
  partyLayout,
  partyViewOf,
  type PartyMemberView,
} from './PartyFrame.js';
import { CONTROL_VISUALS } from '../vfx/status.js';

/**
 * 真机实测（1600×900，`?testbed&stress=23`）的两个几何事实。
 * ⚠️ 它们是这次修复的**前提**：队伍框顶边固定在 350（index.html，不归本包），
 *   战斗日志**满格**（14 行）时顶边在 577。改了任何一个，下面的算术锚就该红。
 * ⚠️ 用满格值而不是开局的空日志值 —— 见 PartyFrame.COMBAT_LOG_RESERVE_PX 的注释。
 */
const FRAME_TOP = 350;
const COMBAT_LOG_TOP = 577;

const member = (over: Partial<PartyMemberView> = {}): PartyMemberView => ({
  id: 3,
  name: '甲',
  className: '盗贼',
  health: 80,
  maxHealth: 100,
  controls: [],
  dead: false,
  carryingFlag: false,
  ...over,
});

describe('P10 ①：自己的资源条要看得懂（此前无标签无数字）', () => {
  it('★★ 主资源条与 15.2 目标框**逐字同格式**：「标签 当前 / 上限」', () => {
    const html = channelHtml({ current: 5, max: 100, label: '怒气', key: 'rage' });
    // 目标框写的是 `怒气 5 / 100`（CombatHud.renderUnitFrame）——
    // 队伍框写另一种格式就等于让玩家在同一屏上读两套写法
    expect(html).toContain('怒气 5 / 100');
  });

  it('小数按目标框的规矩取整，不把「怒气 4.7331 / 100」怼到玩家脸上', () => {
    expect(channelHtml({ current: 4.7331, max: 100, label: '怒气' })).toContain('怒气 5 / 100');
  });

  it('填充宽度夹在 0~100%：溢出的资源不该把条画出格子外', () => {
    expect(channelHtml({ current: 150, max: 100, label: '怒气' })).toContain('width:100%');
    expect(channelHtml({ current: -5, max: 100, label: '怒气' })).toContain('width:0%');
  });

  it('带 key 时上色类名跟着来 —— 与目标框同一套资源配色', () => {
    expect(channelHtml({ current: 1, max: 2, label: '法力', key: 'mana' })).toContain('res-mana');
    // 没 key 也不能崩，只是退回默认色
    expect(channelHtml({ current: 1, max: 2, label: '法力' })).toContain('class="pf-bar res"');
  });
});

describe('P10 ②：第二资源通道（连击点此前完全没有 UI）', () => {
  it('★★ 连击点 3/5 → 5 颗圆点、亮 3 颗灭 2 颗', () => {
    const html = channelHtml({ current: 3, max: 5, label: '连击点', key: 'comboPoints' }, true);
    const dots = html.match(/<b class="[^"]*"><\/b>/g) ?? [];
    expect(dots).toHaveLength(5);
    expect(dots.filter((d) => d.includes('on'))).toHaveLength(3);
  });

  it('★ 亮/灭的主通道是**形状**不是颜色（17.2）：灭的圆点没有 on 类，CSS 给它空心环', () => {
    expect(PARTY_FRAME_CSS).toMatch(/\.pf-pts b\s*\{[^}]*border:/);
    expect(PARTY_FRAME_CSS).toMatch(/\.pf-pts b\s*\{[^}]*background: transparent/);
    expect(PARTY_FRAME_CSS).toMatch(/\.pf-pts b\.on\s*\{[^}]*background:/);
  });

  it('圆点数目钳在 [0, max]：脏数据不该画出 7 颗连击点', () => {
    const over = channelHtml({ current: 7, max: 5, label: '连击点' }, true);
    expect((over.match(/<b /g) ?? [])).toHaveLength(5);
    expect((over.match(/class="on"/g) ?? [])).toHaveLength(5);
    const under = channelHtml({ current: -2, max: 5, label: '连击点' }, true);
    expect(under).not.toContain('class="on"');
  });

  it('★ 通用判据而不是写死「连击点」—— 符文（6）将来直接复用这条路', () => {
    expect(isPointResource({ current: 6, max: 6, label: '符文' })).toBe(true);
    expect(isPointResource({ current: 0, max: 5, label: '圣能' })).toBe(true);
    expect(isPointResource({ current: 0, max: PARTY_MAX_DOTS, label: '占位' })).toBe(true);
    // 大池画成圆点既排不下也数不清，退回条
    expect(isPointResource({ current: 0, max: PARTY_MAX_DOTS + 1, label: '占位' })).toBe(false);
    expect(isPointResource({ current: 0, max: 100, label: '能量' })).toBe(false);
  });

  it('大池的第二通道退回「条 + 数字」（德鲁伊能量 100、死骑符文能量 100）', () => {
    const html = channelHtml({ current: 40, max: 100, label: '能量', key: 'energy' }, true);
    expect(html).toContain('能量 40 / 100');
    expect(html).not.toContain('pf-pts');
  });

  it('★★ 盗贼投影真的带上了 resources[1] —— 光有渲染没有数据等于没做', () => {
    const rogue = getClass(asClassId('rogue'))!;
    const e = createEntity(asEntityId(1), rogue, TEAM_RED, vec3(0, 0, 0));
    e.resources.set('comboPoints' as never, 2);
    const [v] = partyViewOf([e]);
    expect(v!.secondary).toEqual({ current: 2, max: 5, label: '连击点', key: 'comboPoints' });
    expect(v!.resource?.key).toBe('energy');
  });

  it('单资源职业没有第二通道，也不该凭空长出圆点', () => {
    const mage = getClass(asClassId('mage'))!;
    const [v] = partyViewOf([createEntity(asEntityId(2), mage, TEAM_RED, vec3(0, 0, 0))]);
    expect(v!.secondary).toBeUndefined();
  });
});

describe('P10 ③：卡片可点选（合同 C4）', () => {
  it('★★ 整块 HUD 是 pointer-events:none 的，卡片必须自己把点击要回来', () => {
    // 这一条掉了，onSelectMember 永远收不到事件，而且**没有任何报错**
    expect(PARTY_FRAME_CSS).toMatch(/\.pf-member\s*\{[^}]*pointer-events: auto/);
    expect(PARTY_FRAME_CSS).toMatch(/\.pf-member\s*\{[^}]*cursor: pointer/);
  });

  it('★ 可点选这件事要看得出来 —— 有悬停反馈', () => {
    expect(PARTY_FRAME_CSS).toContain('.pf-member:hover');
  });

  it('委托取 id：正常值解析成数字', () => {
    expect(memberIdOf('7')).toBe(7);
    expect(memberIdOf('0')).toBe(0);
  });

  it('★ 点在空隙上/脏 data-id 时返回 undefined，而不是把目标切成 NaN', () => {
    expect(memberIdOf(undefined)).toBeUndefined();
    expect(memberIdOf(null)).toBeUndefined();
    expect(memberIdOf('')).toBeUndefined();
    expect(memberIdOf('   ')).toBeUndefined();
    expect(memberIdOf('abc')).toBeUndefined();
    expect(memberIdOf('Infinity')).toBeUndefined();
  });
});

describe('P10 ④：12 人不许溢出，也不许压住战斗日志', () => {
  const layout = (count: number, viewportHeight = 900, scale = 1) =>
    partyLayout({ count, frameTop: FRAME_TOP, viewportHeight, scale });

  it('★★ 900p 下 12 人：底边落在日志顶边以上（审计里量到的底边是 1109）', () => {
    const l = layout(12);
    expect(l.wrap).toBe(true);
    expect(FRAME_TOP + l.height).toBeLessThanOrEqual(COMBAT_LOG_TOP);
  });

  it('★★ 12 人一个都不能少：列数 × 每列张数 ≥ 12', () => {
    const l = layout(12);
    // 分列由 flex column-wrap 完成，这里验的是「预算允许分成几列」
    expect(l.rowsPerColumn * Math.ceil(12 / l.rowsPerColumn)).toBeGreaterThanOrEqual(12);
    // 给出的高度必须真的排得下 rowsPerColumn 张
    expect(l.height).toBe(
      l.rowsPerColumn * PARTY_MEMBER_HEIGHT_PX + (l.rowsPerColumn - 1) * PARTY_GAP_PX,
    );
  });

  it('★ 卡片高度预算 = CSS 里真正用的那组数（CSS 由同一组常量拼出）', () => {
    // 38 = 描边 2 + 内边距 4 + 姓名行 12 + 行距 2 + 生命条 6 + 行距 2 + 资源行 10
    expect(PARTY_MEMBER_HEIGHT_PX).toBe(38);
    expect(PARTY_FRAME_CSS).toContain(`gap: ${PARTY_GAP_PX}px`);
    // 控制字形并进姓名行（去掉了 min-height 的占位行）—— 这是省下来的 14px
    expect(PARTY_FRAME_CSS).not.toContain('min-height');
  });

  it('人少时**不**分列：排得下就保持单列的宽卡片（900p 是 5 人）', () => {
    expect(layout(1).wrap).toBe(false);
    expect(layout(5).wrap).toBe(false);
    expect(layout(5).rowsPerColumn).toBe(5);
    expect(FRAME_TOP + layout(5).height).toBeLessThanOrEqual(COMBAT_LOG_TOP);
  });

  it('★ 分列时把人摊平：7 人排 4 + 3，不是难看的 5 + 2', () => {
    const l = layout(7);
    expect(l.wrap).toBe(true);
    expect(l.rowsPerColumn).toBe(4);
  });

  it('★ 1080p 多出来的 180px 直接兑成更少的列：12 人从三列收回两列', () => {
    const l = layout(12, 1080);
    expect(l.rowsPerColumn).toBe(6);
    expect(FRAME_TOP + l.height).toBeLessThanOrEqual(1080 - 323);
    // 900p 下同样 12 人只能排四行三列 —— 排版是算出来的，不是写死的
    expect(layout(12).rowsPerColumn).toBe(4);
  });

  it('⚠️ 界面缩放 2.0：900p 下怎么排都放不下，但列数被夹在 3 列以内', () => {
    const l = layout(12, 900, 2);
    expect(l.rowsPerColumn).toBe(4); // ceil(12 / 3)
    expect(l.height).toBeGreaterThan(0);
  });

  it('scale 传 0 / 负数时按 1 处理，不产生 Infinity 高度', () => {
    expect(Number.isFinite(layout(12, 900, 0).height)).toBe(true);
    expect(layout(12, 900, 0)).toEqual(layout(12, 900, 1));
  });
});

describe('P10 单人卡片：15.1 六项一项不少，且不在 HTML 里出洞', () => {
  it('★ 名字里的尖括号被转义 —— 玩家昵称是不可信输入', () => {
    const html = memberHtml(member({ name: '<img src=x onerror=1>' }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('死亡时血条压到 0%，但投影里的血量不动（压 0 是渲染层的事）', () => {
    const html = memberHtml(member({ dead: true, health: 130 }));
    expect(html).toContain('width:0%');
    expect(html).toContain('pf-member dead');
  });

  it('data-id 带上实体 id —— C4 的点击路径靠它认人', () => {
    expect(memberHtml(member({ id: 42 }))).toContain('data-id="42"');
  });

  it('★★ 15.1 六项都还在：职业名没有为了压行高被砍掉', () => {
    const html = memberHtml(
      member({ className: '死亡骑士', controls: ['silenced'], carryingFlag: true, dead: true }),
    );
    expect(html).toContain('死亡骑士'); // 职业
    expect(html).toContain('pf-bar hp'); // 生命
    expect(html).toContain('pf-ctrl'); // 控制
    expect(html).toContain('pf-flag'); // 旗手
    expect(html).toContain('pf-dead'); // 死亡
  });

  it('★ 控制字形与 3D 场景共用同一张表（17.2：不能只靠颜色）', () => {
    const html = memberHtml(member({ controls: ['silenced'] }));
    expect(html).toContain(CONTROL_VISUALS.silenced.glyph);
  });

  it('两条通道排在**同一行**里 —— 多一行就是 12px × 12 人的溢出', () => {
    const html = memberHtml(
      member({
        resource: { current: 60, max: 100, label: '能量', key: 'energy' },
        secondary: { current: 3, max: 5, label: '连击点', key: 'comboPoints' },
      }),
    );
    expect((html.match(/pf-chans/g) ?? [])).toHaveLength(1);
    expect(html).toContain('能量 60 / 100');
    expect(html).toContain('pf-pts');
  });

  it('没有任何资源的队友不画空的资源行', () => {
    expect(memberHtml(member())).not.toContain('pf-chans');
  });
});
