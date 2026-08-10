/**
 * W23 表现侧：**锁定投射物只画一份，而且在结算那一刻抵达。**
 *
 * ★★ 两条都来自用户实测的同一句抱怨（「法术还没到，伤害就出来了」）：
 *   1. **不双重渲染** —— sim 现在真的会生成 homing 弹体并随快照下发，
 *      而客户端本来就在 `onCastResolved` 里给同一批技能画了一发装饰弹道。
 *      两条路都画就是一发法术两颗球。二选一的收口写在
 *      `syncProjectiles` 的 `p.kind === 'homing' → continue` 上。
 *   2. **抵达时刻对齐** —— 装饰弹道的寿命改成「释放瞬间距离 / 速度」，
 *      与 sim 的 `HomingProjectile.impactAt` 同公式；此前它靠追目标决定
 *      何时抵达，目标狂奔时视觉抵达晚于伤害落账。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SPELL_PROJECTILE, mage, type SkillDef } from '@wowpvp/shared';
import { QualityTier } from '../render/quality.js';
import { SpellVfx } from './SpellVfx.js';

let warn: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  // 贴图在 node 环境里加载不到，SpellVfx 会退回程序化几何并 warn 一次
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterAll(() => {
  warn.mockRestore();
});

const skill = (id: string): SkillDef => mage.skills.find((s) => (s.id as string) === id)!;

const caster = { position: { x: 0, y: 0, z: 0 }, height: 2, yaw: 0, id: 1 };
/** 正前方 20 米处的目标（yaw=0 时 -Z 是「前」）*/
const targetAt = (z: number) => [{ position: { x: 0, y: 0, z }, height: 2 }];

const frameCtx = (
  now: number,
  projectiles: Parameters<SpellVfx['frame']>[1]['projectiles'],
): Parameters<SpellVfx['frame']>[1] => ({
  quality: QualityTier.High, cameraDistance: 8, pointScale: 520, now,
  projectiles, grounds: [],
});

describe('★★ W23：锁定投射物不双重渲染', () => {
  it('★★ 快照里的 homing 弹体不生成 ProjBody（装饰弹道已经在画它了）', () => {
    const vfx = new SpellVfx();
    // 一次施放 → 装饰弹道 1 发
    vfx.onCast('resolved', caster, skill('mage.frostbolt'), targetAt(-20));
    expect(vfx.status().visualBolts, '装饰弹道没画出来').toBe(1);

    // 同一发法术的 sim 弹体经快照下发
    vfx.frame(0.016, frameCtx(0.1, [
      { id: 1, kind: 'homing', skillId: 'mage.frostbolt', position: { x: 0, y: 1, z: -5 } },
    ]));

    expect(
      vfx.status().projectileBodies,
      'homing 也走了快照渲染 —— 一发法术两颗球',
    ).toBe(0);
    // 装饰弹道仍在（它才是视觉载体）
    expect(vfx.status().visualBolts).toBe(1);
    vfx.dispose();
  });

  it('★ 碰撞型（colliding）照旧走快照渲染 —— 跳过的只有 homing', () => {
    /**
     * 猎人的穿透弩箭是**碰撞型**：它能被墙挡、能靠走位躲开，
     * 所以必须画 sim 给的**真实**轨迹，不能用装饰弹道去猜。
     * `flies()` 也正是靠 `spawnProjectile` 把它排除在装饰路径外的。
     */
    const vfx = new SpellVfx();
    vfx.frame(0.016, frameCtx(0.1, [
      { id: 7, kind: 'colliding', skillId: 'hunter.piercing_bolt', position: { x: 0, y: 1, z: -5 } },
    ]));
    expect(vfx.status().projectileBodies, '碰撞型被一起跳过了').toBe(1);
    vfx.dispose();
  });

  it('★ 有装饰弹道时，homing 消失不补命中爆发（那份反馈由弹道抵达时给）', () => {
    /**
     * ★ 初版这条测试是「只喂快照、不调 onCast」——那在**无条件跳过**的
     *   实现下确实不补爆发，但同时也意味着那个客户端一发都看不见（14.4）。
     *   兜底渲染加上之后，「不补双份」这件事只在**装饰弹道确实存在**时成立，
     *   所以夹具补上 onCast：这才是它想守的那个场景。
     */
    const vfx = new SpellVfx();
    vfx.onCast('resolved', caster, skill('mage.frostbolt'), targetAt(-20));
    vfx.frame(0.016, frameCtx(0.1, [
      { id: 1, kind: 'homing', skillId: 'mage.frostbolt', position: { x: 0, y: 1, z: -5 } },
    ]));
    const before = vfx.status().activeBursts;
    vfx.frame(0.016, frameCtx(0.2, [])); // 弹体消失
    expect(vfx.status().activeBursts, '双份命中反馈回来了').toBe(before);
    vfx.dispose();
  });
});

/**
 * ★ 与 sim 的 `spawnHoming` 同公式：
 *   `impactAt = now + max(0.05, distance2D(source, target) / SPEED)`。
 *   两边差一点点，玩家看到的就是「血条先掉 / 特效后到」。
 */
const flightSeconds = (distance: number): number => distance / SPELL_PROJECTILE.SPEED;

describe('★★ W23：装饰弹道的抵达时刻 = 释放瞬间距离 / 速度', () => {
  it('★★ 目标原地不动：在预期时刻前后各推一帧，抵达就在那一刻附近', () => {
    const vfx = new SpellVfx();
    vfx.onCast('resolved', caster, skill('mage.frostbolt'), targetAt(-20));
    const life = flightSeconds(20);

    // 只推到寿命的一半：弹体还在飞
    let t = 0;
    while (t < life * 0.5) {
      vfx.frame(0.016, frameCtx(t, []));
      t += 0.016;
    }
    expect(vfx.status().visualBolts, '还没到点就爆了').toBe(1);

    // 推过寿命：必须已经抵达并回收
    while (t < life + 0.05) {
      vfx.frame(0.016, frameCtx(t, []));
      t += 0.016;
    }
    expect(vfx.status().visualBolts, '到点了还没抵达').toBe(0);
    vfx.dispose();
  });

  it('★★ 目标狂奔时**照样**按时抵达 —— 这就是用户抱怨的那个错拍', () => {
    /**
     * 老实现是 `age < 2` 的兜底上限 + 每帧追目标当前位置：目标反向跑
     * 得比弹体慢一点点时，弹体会一路追到 2 秒才强制抵达 —— 而伤害在
     * 0.36 秒就落账了。现在寿命在释放瞬间就定死。
     */
    const vfx = new SpellVfx();
    let z = -20;
    // ★ `track` 是弹体每帧刷新终点用的那个闭包（VisualBolt.track）——
    //   这条测试的全部意义就在于让它一直往远处指
    const moving = [{
      position: { x: 0, y: 0, z }, height: 2,
      track: () => ({ x: 0, y: 1, z }),
    }];
    vfx.onCast('resolved', caster, skill('mage.frostbolt'), moving);
    const life = flightSeconds(20);
    expect(vfx.status().visualBolts).toBe(1);

    let t = 0;
    while (t < life + 0.05) {
      // 每帧跑 0.8 米 ≈ 50 m/s：只比弹体（55 m/s）慢一点点。
      // 老实现下弹体要追 4 秒才追上，被 age<2 的兜底截到 2 秒才爆 ——
      // 而伤害早在 0.36 秒就落账了，这就是那个错拍。
      z -= 0.8;
      vfx.frame(0.016, frameCtx(t, []));
      t += 0.016;
    }
    expect(vfx.status().visualBolts, '目标一跑，弹体就飞过了结算时刻').toBe(0);
    vfx.dispose();
  });

  it('★ 近距离（贴脸 1.5 米内）仍然不画弹道 —— 没有可看的飞行段', () => {
    const vfx = new SpellVfx();
    vfx.onCast('resolved', caster, skill('mage.frostbolt'), targetAt(-1));
    expect(vfx.status().visualBolts).toBe(0);
    vfx.dispose();
  });

  it('★★ 目标**迎面冲**过来也不得提前抵达 —— 早到是同一个错拍的镜像', () => {
    /**
     * ★★ 初版的抵达判据是「几何追上（d ≤ 本帧步长）**或**到寿命」两者取先 ——
     *   只钳住了「迟到」。目标被拉近/闪现/冲锋时弹体提前追上，视觉就早于
     *   结算最多 8 个 tick：「冰矛已经炸了，血条半秒后才掉」。
     *   sim 的 `impactAt` 在释放瞬间一次定死（目标之后跑多远都不改），
     *   所以客户端的抵达时刻也必须**只看时间**。
     * ★ 改之前这条是红的：目标瞬移到 8 米时弹体在 0.13 秒就爆了。
     */
    const vfx = new SpellVfx();
    let z = -30;
    const rushing = [{
      position: { x: 0, y: 0, z: -30 }, height: 2,
      track: () => ({ x: 0, y: 1, z }),
    }];
    vfx.onCast('resolved', caster, skill('mage.frostbolt'), rushing);
    const life = flightSeconds(30);
    expect(vfx.status().visualBolts).toBe(1);

    let t = 0;
    // 第一帧就瞬移到 8 米（冲锋/暗影步/野性冲锋/死亡之握把人拉近）
    z = -8;
    while (t < life - 0.03) {
      vfx.frame(0.016, frameCtx(t, []));
      t += 0.016;
      z = Math.min(-2, z + 0.12); // 之后继续迎面小跑
    }
    expect(vfx.status().visualBolts, '目标一冲脸，弹体就提前炸了 —— 视觉早于结算').toBe(1);

    while (t < life + 0.05) {
      vfx.frame(0.016, frameCtx(t, []));
      t += 0.016;
    }
    expect(vfx.status().visualBolts, '到点了还没抵达').toBe(0);
    vfx.dispose();
  });

  it('★★ 顿帧只放慢弹体，不推迟抵达 —— 抵达钟必须是真实钟', () => {
    /**
     * ★★ `frame()` 收到的 dt 是**渲染** dt，顿帧（HitStop）只缩放它
     *   （见 render/HitStop.ts 文件头：模拟步与插值时钟一律走真实 dt）。
     *   抵达时刻若按累计 dt 算，一次暴击顿帧就让弹体迟到 88ms ≈ 1.8 个 tick，
     *   而伤害在真实钟上的 impactAt 准时落账。
     *   `ctx.now`（联网 = serverTime，试验场 = world.time）才是与 sim 同源的钟。
     * ★ 改之前这条是红的：喂缩放 dt 时弹体到点还没抵达。
     */
    const vfx = new SpellVfx();
    vfx.onCast('resolved', caster, skill('mage.frostbolt'), targetAt(-30));
    const life = flightSeconds(30);

    let t = 0;
    while (t < life + 0.02) {
      // 真实帧长 16ms，但飞行途中一直在顿帧 → 渲染 dt 只有 6%
      vfx.frame(0.016 * 0.06, frameCtx(t, []));
      t += 0.016;
    }
    expect(
      vfx.status().visualBolts,
      '抵达跟着渲染 dt 走了 —— 顿帧一发生，特效就晚于血条',
    ).toBe(0);
    vfx.dispose();
  });
});

describe('★★ W23：homing 快照的兜底渲染（14.4 不能隐藏投射物主体）', () => {
  /**
   * ★★ 装饰弹道要有一条 **带 casterId 的 CastResolved** 才画得出来，
   *   而服务器在施法者不可见时会把 casterId 抹掉（MatchLoop 的 redact），
   *   重连/中途加入/观战的客户端更是压根收不到那条消息。
   *   无条件跳过 homing 快照 = 这些情形下场上一个像素都没有、0.5 秒后
   *   伤害凭空落账 —— 那正是 `ProjectileSnapshot` 当初存在的理由（14.4）。
   */
  const homing = (id: number, skillId = 'mage.frostbolt') => ([{
    id, kind: 'homing' as const, skillId, position: { x: 0, y: 1, z: -5 },
  }]);

  it('★★ 没有装饰弹道时，homing 快照必须自己画出来（重连/施法者不可见）', () => {
    const vfx = new SpellVfx();
    // 只喂快照，不调 onCast —— 模拟 casterId 被 redact / 中途入场
    vfx.frame(0.016, frameCtx(0.1, homing(1)));
    expect(
      vfx.status().projectileBodies,
      '一发都没画 —— 投射物主体被隐藏了（14.4）',
    ).toBe(1);
    vfx.dispose();
  });

  it('★★ 兜底只管飞行段：它消失时不补命中爆发（那份归 damage 事件）', () => {
    /**
     * 兜底画的球在末位置补爆发的话，命中反馈就成了双份（damage 事件已经在
     * 目标身上放过一发），贴脸施放（<1.5 米、装饰弹道故意不画）时每一发
     * 法术都会多一朵花。damage / auraApplied 与 casterId 无关，重连的
     * 客户端照样收得到 —— 所以这里让掉是安全的。
     */
    const vfx = new SpellVfx();
    vfx.frame(0.016, frameCtx(0.1, homing(1)));
    const before = vfx.status().activeBursts;
    vfx.frame(0.016, frameCtx(0.2, [])); // 弹体抵达消失
    expect(vfx.status().activeBursts, '兜底球自己补了一发命中爆发').toBe(before);
    expect(vfx.status().projectileBodies, '兜底球没回收').toBe(0);
    vfx.dispose();
  });

  it('★ 兜底之后仍然只有一份：装饰弹道在飞时快照照旧不画', () => {
    const vfx = new SpellVfx();
    vfx.onCast('resolved', caster, skill('mage.frostbolt'), targetAt(-20));
    vfx.frame(0.016, frameCtx(0.1, homing(1)));
    expect(vfx.status().projectileBodies, '一发法术两颗球').toBe(0);
    expect(vfx.status().visualBolts).toBe(1);
    vfx.dispose();
  });

  it('★ 一旦认定由装饰弹道承担，后续帧不因它抵达回收而翻脸补画', () => {
    /**
     * 装饰弹道的寿命是「释放瞬间距离 / 速度」，而快照可能多活一两帧
     * （服务器 20Hz、客户端 60Hz）。那一两帧里不该突然冒出一颗球，
     * 更不该在末位置补一发爆发（那是双份命中反馈）。
     */
    const vfx = new SpellVfx();
    vfx.onCast('resolved', caster, skill('mage.frostbolt'), targetAt(-20));
    let t = 0;
    while (t < flightSeconds(20) + 0.05) {
      vfx.frame(0.016, frameCtx(t, homing(1)));
      t += 0.016;
    }
    expect(vfx.status().visualBolts, '装饰弹道该抵达回收了').toBe(0);
    expect(vfx.status().projectileBodies, '装饰弹道一走，快照就翻脸补画').toBe(0);
    vfx.dispose();
  });
});

describe('★★ W23：命中表现不因载荷下沉而翻倍', () => {
  /**
   * ★★ `onCombatEvent` 的 auraApplied 分支靠「这个技能带伤害吗」决定要不要
   *   补一发到位爆发 —— 带伤害的技能由 damage 事件承担，不再叠一份。
   *   W23 把 damage 挪进了 `lockedProjectile.onHit`，**顶层**扫描于是恒为假：
   *   霜矢/裁决/月火命中时 damage 一次、auraApplied 再一次，同一帧翻倍。
   *   与 `schools.ts` 的 `hasPoisonAura`、`skillIcon.ts` 的 `flattenEffects`
   *   是同一族的坑（那两处 W23 已经下探了，这处漏了）。
   * ★ 改之前这条是红的：activeBursts 0 → 2。
   */
  it('★★ 霜矢的减速光环生效时不得再补一发爆发（damage 事件已经画过了）', () => {
    const vfx = new SpellVfx();
    const posOf = () => ({ x: 0, y: 1, z: -20 });
    const before = vfx.status().activeBursts;
    vfx.onCombatEvent({ t: 'auraApplied', targetId: 2 as never, auraId: 'mage.frostbolt.chill' }, posOf);
    expect(
      vfx.status().activeBursts,
      '带伤害的技能又叠了一份命中爆发 —— 顶层扫描没有下探到 onHit',
    ).toBe(before);
    vfx.dispose();
  });

  it('★ 纯光环技能（寒缚链）照旧补爆发 —— 修的是下探，不是把这条路关掉', () => {
    // 寒缚链的 onHit 里只有减速光环、一点伤害都没有 → 这条路是它唯一的命中表现
    const vfx = new SpellVfx();
    const posOf = () => ({ x: 0, y: 1, z: -20 });
    vfx.onCombatEvent(
      { t: 'auraApplied', targetId: 2 as never, auraId: 'deathknight.chains_of_ice' }, posOf,
    );
    expect(
      vfx.status().activeBursts,
      '纯控制技能的到位爆发被误伤了 —— 被变羊的人身上什么都不亮',
    ).toBeGreaterThan(0);
    vfx.dispose();
  });
});
