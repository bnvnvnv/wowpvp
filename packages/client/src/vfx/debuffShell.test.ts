/**
 * X30：debuff 学派色壳层。用户 2026-08-11 拍板
 * 「中了 debuff 身上要能看见效果 —— 冰系减速身上有一层冰蓝色、
 *   火系击晕身上有一层火焰，其他法术一样」。
 *
 * ★ 两半各自的测法：
 *   · 判据（选哪一枚 / 什么颜色 / 怎么动）—— 纯函数，逐条断言
 *   · 渲染（`StatusMarkers` 的壳）—— three.js 的对象构造是纯数学，
 *     Node 里就能验「材质上真的写了那个颜色」「淡出之后真的收掉」；
 *     观感（像不像一层火）仍然是截图的事
 *
 * ★★ 本文件里分量最重的三条是**红线**而不是功能：
 *   ① S7 掩码只能中性灰 —— 连运动都不许泄露学派
 *   ② 分层不许互相啃 —— 四层壳贴在同一个角色身上
 *   ③ 零粒子 —— 细流池预算是 24 人局的硬约束，壳层一格都不许占
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { HIDDEN_AURA_ID, School } from '@wowpvp/shared';

import { QualityTier } from '../render/quality.js';
import { RIM_RADIUS_SCALE } from './FactionRing.js';
import { StatusMarkers } from './StatusMarkers.js';
import { ATTRIBUTE_VISUALS, VisualAttribute } from './schools.js';
import {
  NEUTRAL_SHELL_COLOR,
  NEUTRAL_SHELL_MOTION,
  SHELL_CATEGORY_RANK,
  SHELL_LAYERS,
  SHELL_MOTIONS,
  ShellCategory,
  debuffShellOf,
  indexedAuraIds,
  shellCategoryOf,
  type ShellAuraLike,
} from './debuffAura.js';

/** 第三人称距离 —— 不触发第一人称收缩 */
const DIST = 5;
const tick = (m: StatusMarkers, dt: number, dist = DIST): void =>
  m.update(new Map(), QualityTier.High, dist, dt, 0);

// ── 真实数据里的样本（全部从索引 dump 出来核对过，不是编的 id）──────
const FROST_SLOW = 'mage.frostbolt.chill'; // 用户例①：冰系减速
const POISON_SLOW = 'rogue.poisoned_blade'; // 学派是物理、视觉是毒
const SHADOW_DOT = 'priest.shadow_word_pain.dot';
const HOLY_OTHER = 'paladin.judgement';
const ICE_BARRIER = 'mage.ice_barrier'; // 增益（吸收盾）
const STEALTH = 'rogue.stealth'; // 增益（持久）

describe('X30 · 选哪一枚：控制 > 减速 > DoT > 其他 > 掩码', () => {
  it('★★ 类别优先级的秩是唯一裁决 —— 五档两两可比且不并列', () => {
    const ranks = Object.values(SHELL_CATEGORY_RANK);
    expect(new Set(ranks).size, '两个类别同秩 = 没有裁决').toBe(ranks.length);
    expect(SHELL_CATEGORY_RANK.control).toBeGreaterThan(SHELL_CATEGORY_RANK.slow);
    expect(SHELL_CATEGORY_RANK.slow).toBeGreaterThan(SHELL_CATEGORY_RANK.dot);
    expect(SHELL_CATEGORY_RANK.dot).toBeGreaterThan(SHELL_CATEGORY_RANK.other);
    expect(SHELL_CATEGORY_RANK.other).toBeGreaterThan(SHELL_CATEGORY_RANK.masked);
  });

  it('★★ 中了一串：控制那一枚定壳色（哪怕它最先加、最快到期）', () => {
    const pick = debuffShellOf([
      { id: SHADOW_DOT, expiresAt: 100 },
      { id: FROST_SLOW, expiresAt: 90 },
      { id: 'control.stun', expiresAt: 3, school: School.Fire },
    ]);
    expect(pick?.category).toBe(ShellCategory.Control);
    expect(pick?.attribute).toBe(VisualAttribute.Fire);
  });

  it('★ 没有控制时减速盖 DoT', () => {
    expect(debuffShellOf([{ id: SHADOW_DOT }, { id: FROST_SLOW }])?.category)
      .toBe(ShellCategory.Slow);
  });

  it('★ 没有控制/减速时 DoT 盖其他减益', () => {
    expect(debuffShellOf([{ id: HOLY_OTHER }, { id: SHADOW_DOT }])?.category)
      .toBe(ShellCategory.Dot);
  });

  it('★★ 同类别取**剩得最久**的那一枚（不是最先/最后出现的）', () => {
    const auras: ShellAuraLike[] = [
      { id: SHADOW_DOT, expiresAt: 12 },
      { id: 'druid.moonfire.dot', expiresAt: 40 },
      { id: 'rogue.rupture.bleed', expiresAt: 20 },
    ];
    expect(debuffShellOf(auras)?.auraId).toBe('druid.moonfire.dot');
    // 顺序反过来仍然选同一枚 —— 判据是到期时刻，不是数组位置
    expect(debuffShellOf([...auras].reverse())?.auraId).toBe('druid.moonfire.dot');
  });

  it('★ persistent（不带 expiresAt）当作一直在 —— 压过任何有限时长的同类', () => {
    const pick = debuffShellOf([
      { id: SHADOW_DOT, expiresAt: 999 },
      { id: 'druid.moonfire.dot' },
    ]);
    expect(pick?.auraId).toBe('druid.moonfire.dot');
  });

  it('★ 完全并列时取**先出现**的（同一份快照必须选出同一枚）', () => {
    const pick = debuffShellOf([
      { id: SHADOW_DOT, expiresAt: 10 },
      { id: 'druid.moonfire.dot', expiresAt: 10 },
    ]);
    expect(pick?.auraId).toBe(SHADOW_DOT);
  });

  it('★★ 增益一枚都不上壳（用户说的是「中招」）', () => {
    expect(shellCategoryOf({ id: ICE_BARRIER })).toBeUndefined();
    expect(shellCategoryOf({ id: STEALTH })).toBeUndefined();
    expect(debuffShellOf([{ id: ICE_BARRIER }, { id: STEALTH }])).toBeUndefined();
  });

  it('★ 一枚都不认识时不画 —— 编一个壳比不画更糟', () => {
    expect(debuffShellOf([{ id: 'nope.nothing.here' }])).toBeUndefined();
    expect(debuffShellOf([])).toBeUndefined();
  });

  it('★ 认不出定义但调用方说是减益 → 归「其他」，中性灰兜底', () => {
    const pick = debuffShellOf([{ id: 'sim.made.this.up', kind: 'debuff' }]);
    expect(pick?.category).toBe(ShellCategory.Other);
    expect(pick?.color).toBe(NEUTRAL_SHELL_COLOR);
  });
});

describe('X30 · 学派色（14.2 八属性）', () => {
  it('★★ 用户例①：冰系减速 = 一层冰蓝', () => {
    const pick = debuffShellOf([{ id: FROST_SLOW, expiresAt: 10 }]);
    expect(pick?.category).toBe(ShellCategory.Slow);
    expect(pick?.color).toBe(ATTRIBUTE_VISUALS.frost.primary);
    expect(pick?.edge).toBe(ATTRIBUTE_VISUALS.frost.secondary);
  });

  it('★★ 用户例②：火系击晕 = 一层火（控制光环的学派走快照那个字段）', () => {
    const pick = debuffShellOf([{ auraId: 'control.stun', school: School.Fire, expiresAt: 3 }]);
    expect(pick?.color).toBe(ATTRIBUTE_VISUALS.fire.primary);
  });

  it('★★ 联网快照可以**原样**喂进来（字段叫 auraId，不叫 id）', () => {
    // 12v12 每帧 24 个实体 —— 少一次 map 就是少一批短命对象
    const snapshotShaped = [
      { auraId: FROST_SLOW, stacks: 2, expiresAt: 30 },
      { auraId: ICE_BARRIER, absorbRemaining: 100, absorbInitial: 200 },
    ];
    expect(debuffShellOf(snapshotShaped)?.auraId).toBe(FROST_SLOW);
  });

  it('★ 毒按**毒**上色而不是按学派（毒刃学派是物理，玩家该看到黄绿）', () => {
    expect(debuffShellOf([{ id: POISON_SLOW }])?.attribute).toBe(VisualAttribute.Poison);
  });

  it('★★ 控制光环查不到学派时退中性灰 —— 不许编一个颜色', () => {
    const pick = debuffShellOf([{ id: 'control.root' }]);
    expect(pick?.category).toBe(ShellCategory.Control);
    expect(pick?.attribute).toBeUndefined();
    expect(pick?.color).toBe(NEUTRAL_SHELL_COLOR);
  });

  it('★★ 索引里的**每一枚减益**都解析得出学派色 —— 一枚灰的都不许有', () => {
    const grey: string[] = [];
    for (const id of indexedAuraIds()) {
      const category = shellCategoryOf({ id });
      if (category === undefined) continue; // 增益
      const pick = debuffShellOf([{ id }]);
      if (pick?.attribute === undefined) grey.push(id);
    }
    // 灰的那几枚曾经真的存在（光环 id 的前两段不一定是技能 id），
    // 是「记住施加技能」那条索引把它们捞回来的 —— 回归就在这一行
    expect(grey, '这些减益退到了中性灰，玩家看不出中的是什么系').toEqual([]);
  });

  it('★ 索引不许缩水 —— 嵌套遍历漏了一种 effect 只会让某个 debuff 静默没壳', () => {
    expect(indexedAuraIds().length).toBeGreaterThanOrEqual(50);
    for (const id of [FROST_SLOW, POISON_SLOW, SHADOW_DOT, HOLY_OTHER, ICE_BARRIER]) {
      expect(indexedAuraIds(), `${id} 掉出索引了`).toContain(id);
    }
  });
});

describe('★★ X30 · S7 掩码红线：只能中性灰，连动法都不许泄露', () => {
  it('★★ 掩码光环 = 中性灰 + 中性运动', () => {
    const pick = debuffShellOf([{ auraId: HIDDEN_AURA_ID, expiresAt: 8 }]);
    expect(pick?.category).toBe(ShellCategory.Masked);
    expect(pick?.attribute).toBeUndefined();
    expect(pick?.color).toBe(NEUTRAL_SHELL_COLOR);
    expect(pick?.motion).toEqual(NEUTRAL_SHELL_MOTION);
  });

  it('★★ 就算旁边塞了一个 school 也不看 —— 服务器刚掩掉的不许从这里漏回去', () => {
    const pick = debuffShellOf([
      { auraId: HIDDEN_AURA_ID, school: School.Shadow, expiresAt: 8 },
    ]);
    expect(pick?.attribute, '掩码把学派漏回去了（等于给潜行者报点）').toBeUndefined();
    expect(pick?.color).toBe(NEUTRAL_SHELL_COLOR);
  });

  it('★ 掩码垫底：任何看得懂的减益都比「不知来历」更该被显示', () => {
    const pick = debuffShellOf([
      { auraId: HIDDEN_AURA_ID, expiresAt: 999 },
      { auraId: HOLY_OTHER, expiresAt: 2 },
    ]);
    expect(pick?.category).toBe(ShellCategory.Other);
  });

  it('★★ 中性运动与八套学派运动**都不同** —— 颜色藏住了、动法不许漏', () => {
    const schoolRates = Object.values(VisualAttribute).map((a) => SHELL_MOTIONS[a].rate);
    expect(
      schoolRates,
      '中性壳的动法与某个学派撞上了 —— S7 会从运动这扇门被打穿',
    ).not.toContain(NEUTRAL_SHELL_MOTION.rate);
  });
});

describe('X30 · 17.2 非颜色通道：运动档案', () => {
  it('★★ 八项脉动频率两两不同 —— 相同就等于少了一条辨识通道', () => {
    const rates = Object.values(VisualAttribute).map((a) => SHELL_MOTIONS[a].rate);
    expect(new Set(rates).size).toBe(rates.length);
  });

  it('★★ 灰度下火与霜仍分得开：火往上窜、霜往下沉', () => {
    expect(SHELL_MOTIONS.fire.drift).toBeGreaterThan(0);
    expect(SHELL_MOTIONS.frost.drift).toBeLessThan(0);
    expect(SHELL_MOTIONS.poison.drift).toBeLessThan(0);
  });

  it('★ 幅度都在合理范围内（脉动不许把不透明度推成负数）', () => {
    for (const a of Object.values(VisualAttribute)) {
      expect(SHELL_MOTIONS[a].amp).toBeGreaterThan(0);
      expect(SHELL_MOTIONS[a].amp).toBeLessThan(1);
      expect(SHELL_MOTIONS[a].rate).toBeGreaterThan(0);
    }
  });
});

describe('★★ X30 · 分层表：四层壳贴在同一个角色身上，不许互相啃', () => {
  it('★★ 半径三档递增且都在阵营 rim 以内', () => {
    expect(SHELL_LAYERS.fill.radiusScale).toBeLessThan(SHELL_LAYERS.rim.radiusScale);
    expect(
      SHELL_LAYERS.rim.radiusScale,
      'debuff 壳顶到 X14 阵营 rim 上了 —— 两条信息会读成一条',
    ).toBeLessThan(RIM_RADIUS_SCALE);
  });

  it('★ debuff 壳比阵营 rim 亮一档（中招是前景，阵营是背景）', () => {
    const FACTION_RIM_OPACITY = 0.13; // FactionRing.ts 的 RIM_OPACITY
    expect(SHELL_LAYERS.rim.opacity).toBeGreaterThan(FACTION_RIM_OPACITY);
  });

  it('★ 壳仍然是「贴着身体」的一层：不透明度低到不会糊住模型', () => {
    expect(SHELL_LAYERS.fill.opacity).toBeLessThan(0.35);
    expect(SHELL_LAYERS.rim.opacity).toBeLessThan(0.35);
  });
});

describe('X30 · 渲染：StatusMarkers 的 debuff 壳', () => {
  it('★★ 中招 → 淡入到看得见；解除 → 淡出之后真的收掉', () => {
    const m = new StatusMarkers();
    expect(m.debuffShellVisible).toBe(false);

    m.setDebuffShell(debuffShellOf([{ id: FROST_SLOW, expiresAt: 10 }]));
    tick(m, 0.05);
    expect(m.debuffShellVisible).toBe(true);
    const partial = m.debuffShellOpacity;
    tick(m, 0.2); // 越过淡入
    expect(m.debuffShellOpacity, '壳没有继续淡入').toBeGreaterThan(partial);

    m.setDebuffShell(undefined);
    tick(m, 0.1);
    expect(m.debuffShellVisible, '解除的那一帧壳就没了 —— 应该有淡出').toBe(true);
    tick(m, 0.3);
    expect(m.debuffShellVisible).toBe(false);
    expect(m.debuffShellOpacity).toBe(0);
    m.dispose();
  });

  it('★★ 学派色真的写到材质上（冰系减速 → 冰蓝）', () => {
    const m = new StatusMarkers();
    m.setDebuffShell(debuffShellOf([{ id: FROST_SLOW }]));
    tick(m, 0.2);
    expect(m.debuffShellColor).toBe(ATTRIBUTE_VISUALS.frost.primary);
    expect(m.debuffShellCategory).toBe(ShellCategory.Slow);
    m.dispose();
  });

  it('★★ S7 掩码在渲染侧也是中性灰', () => {
    const m = new StatusMarkers();
    m.setDebuffShell(debuffShellOf([{ auraId: HIDDEN_AURA_ID, school: School.Fire }]));
    tick(m, 0.2);
    expect(m.debuffShellColor).toBe(NEUTRAL_SHELL_COLOR);
    m.dispose();
  });

  it('★★ 火恒在身体中心之上、霜恒在中心之下（灰度下的第二条通道）', () => {
    const fire = new StatusMarkers();
    const frost = new StatusMarkers();
    fire.setDebuffShell(debuffShellOf([{ auraId: 'control.stun', school: School.Fire }]));
    frost.setDebuffShell(debuffShellOf([{ id: FROST_SLOW }]));
    for (let i = 0; i < 60; i += 1) {
      tick(fire, 0.03);
      tick(frost, 0.03);
      expect(fire.debuffShellDrift, `第 ${i} 帧火沉下去了`).toBeGreaterThanOrEqual(0);
      expect(frost.debuffShellDrift, `第 ${i} 帧霜浮上来了`).toBeLessThanOrEqual(0);
    }
    expect(fire.debuffShellDrift).toBeGreaterThan(0);
    expect(frost.debuffShellDrift).toBeLessThan(0);
    fire.dispose();
    frost.dispose();
  });

  it('★ 第一人称压淡但**不关掉**（14.3 第五条 / 14.4 关键信息不许隐藏）', () => {
    const third = new StatusMarkers();
    const first = new StatusMarkers();
    const pick = debuffShellOf([{ id: FROST_SLOW }]);
    third.setDebuffShell(pick);
    first.setDebuffShell(pick);
    tick(third, 0.2, DIST);
    tick(first, 0.2, 0.2); // 第一人称距离
    expect(first.debuffShellOpacity).toBeLessThan(third.debuffShellOpacity);
    expect(first.debuffShellOpacity, '第一人称把壳整个关掉了').toBeGreaterThan(0);
    expect(first.debuffShellVisible).toBe(true);
    third.dispose();
    first.dispose();
  });

  it('★★ 零贴图 —— `?art=off` 下照常构造（与护盾壳同一条硬约束）', () => {
    const m = new StatusMarkers();
    m.setDebuffShell(debuffShellOf([{ id: FROST_SLOW }]));
    tick(m, 0.2);
    const shells: THREE.Mesh[] = [];
    m.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) shells.push(mesh);
    });
    for (const mesh of shells) {
      const mat = mesh.material as THREE.MeshBasicMaterial;
      expect(mat.map, '状态标记引了贴图 —— art=off 下会变成白块').toBeNull();
    }
    m.dispose();
  });

  it('★ 没中招的角色每帧喂 undefined 不会卡在淡出里', () => {
    const m = new StatusMarkers();
    for (let i = 0; i < 10; i += 1) {
      m.setDebuffShell(undefined);
      tick(m, 0.016);
    }
    expect(m.debuffShellVisible).toBe(false);
    expect(m.debuffShellOpacity).toBe(0);
    m.dispose();
  });
});

describe('★★ X30 · 接线锁：两个场景都真的喂了壳', () => {
  /**
   * ★★ 本仓库最反复出现的缺陷家族是「写完了没人接线」—— 数据齐了、
   *   类齐了、单测全绿，中间那一跳漏了。而场景类要 WebGL 才构造得出来，
   *   任何类型或运行时错误都抓不住这一跳，只能锁源码
   *   （与 `av/signatures/integrity.test.ts` 锁 main.ts 的 import 同一手法）。
   */
  const sceneSrc = (file: string): string =>
    readFileSync(`${fileURLToPath(new URL('.', import.meta.url))}../scenes/${file}`, 'utf8');

  it('★★ 联网场景：把 `snap.auras` 原样喂给 `debuffShellOf`', () => {
    const src = sceneSrc('NetworkScene.ts');
    expect(src, '联网侧没接壳层 —— 12v12 里中招看不出来').toMatch(
      /setDebuffShell\(debuffShellOf\(snap\.auras\)\)/,
    );
  });

  it('★★ 试验场：从 `aurasOf` 投影出 ShellAuraLike 再喂', () => {
    const src = sceneSrc('TestbedScene.ts');
    expect(src, '试验场没接壳层 —— 单机看得见、联机看不见就是最难查的漂移')
      .toMatch(/setDebuffShell\(debuffShellOf\(/);
  });
});

describe('★★ X30 · 池预算红线：壳层一格粒子都不占', () => {
  it('★★ 壳层的两个文件都不碰 BurstPool / FlashPool', () => {
    /**
     * 为什么用源码断言：12v12 是 24 个角色，每人每 0.2 秒撒一小簇就是
     * 每秒 120 次 emit —— 而细流池只有 48 格，0.4 秒被自己刷空
     * （`ParticleBurst` 的 ⚠️ 记的就是这次实测）。壳层的学派微动因此
     * 全部做在**材质脉动 + 竖向漂移**上，一格池子都不申请。
     * 这条约束没有任何类型或运行时错误抓得住，只能锁源码。
     */
    const dir = fileURLToPath(new URL('.', import.meta.url));
    // ★ 锁的是「用了」而不是「提了」：注释里引用 ParticleBurst 的设计取舍是好事
    const uses = /from\s+'\.\/ParticleBurst\.js'|new\s+(BurstPool|FlashPool)\b/;
    for (const f of ['debuffAura.ts', 'StatusMarkers.ts']) {
      const src = readFileSync(`${dir}${f}`, 'utf8');
      expect(src, `${f} 开始用粒子池了 —— 细流池预算会被 24 人局刷空`).not.toMatch(uses);
    }
  });
});
