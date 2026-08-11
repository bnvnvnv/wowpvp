/**
 * M15 端到端验收：新手教学十二环，Playwright 按任务顺序**真实操作**走完。
 * docs/14 §M15 判据：「脚本走完全部教学环节；每环有『不教就过不去』的验证点」。
 *
 * ★ 每一环两类断言：
 *   · 正路 —— 按教学要求操作，断言推进到下一环
 *   · 否定路 —— 不做对（提前做/做错/直接读完），断言**不推进**
 *     （规约级的 28 条用例在 steps.test.ts；这里挑关键环在浏览器里复验接线）
 *
 * 用法：pnpm --filter @wowpvp/client dev（另一个终端，端口 5173）
 *       pnpm verify:m15
 */

import { chromium, type Browser, type Page } from 'playwright';

const BASE = process.env.VERIFY_URL ?? 'http://localhost:5173';
const URL = `${BASE}/?tutorial=on&art=off`;

const results: { id: string; name: string; pass: boolean }[] = [];
/**
 * ★ 每条断言带「本条耗时 / 累计耗时」（G6：去 sleep 要能看见钱花在哪）。
 *   时间戳是**诊断**不是判据 —— 慢不判红，但下次谁想再砍一刀有据可依。
 */
const t0 = Date.now();
let tPrev = t0;
const check = (id: string, name: string, pass: boolean, detail: string): void => {
  const now = Date.now();
  const seg = ((now - tPrev) / 1000).toFixed(1);
  const all = ((now - t0) / 1000).toFixed(1);
  tPrev = now;
  results.push({ id, name, pass });
  console.log(`  ${pass ? '✓' : '✗'} ${id} ${name}  [+${seg}s / ${all}s]\n      ${detail}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * ★★ G6 去 sleep 的主力工具：**条件轮询**取代固定等待。
 *
 *   固定 sleep 有两头都亏的毛病 —— 睡短了在慢机器上抖成偶发红，睡长了
 *   全脚本一起变慢。轮询把「等多久」交给事实：探到就走，探不到才等，
 *   而 `timeoutMs` 只是**上限**（本脚本一律取原固定 sleep 的 3 倍左右）。
 *
 *   不抛错，返回 `{ hit, last }` —— 调用点自己决定「没等到」算失败还是
 *   继续走（否定路的等待就属于后者：等不到动作生效，断言照样成立）。
 *
 * ⚠️ 轮询间隔别低于 ~100ms：实测 SwiftShader 下一次 `page.evaluate` 中位
 *   65ms、尾部 200ms+，间隔太密就变成探测本身在抢 CPU（m4 递减段的教训：
 *   探测是延迟源）。需要精确时序的地方用「盲操作 + 事后验证」，不要轮询。
 */
const pollFor = async <T>(
  probe: () => Promise<T>,
  ok: (v: T) => boolean,
  timeoutMs: number,
  intervalMs = 120,
): Promise<{ hit: boolean; last: T }> => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const last = await probe();
    if (ok(last)) return { hit: true, last };
    if (Date.now() >= end) return { hit: false, last };
    await sleep(intervalMs);
  }
};

interface TutStatus {
  active: boolean; skipped: boolean; current: string | null; done: string[];
  moveGoals: { walk: boolean; jump: boolean };
  cameraGoals: { orbit: boolean; zoom: boolean };
  killedDummies: number;
}

const status = (page: Page): Promise<TutStatus> =>
  page.evaluate('globalThis.__scene.tutorial.status') as Promise<TutStatus>;

const waitCurrent = async (page: Page, step: string | null, ms = 10000): Promise<TutStatus> => {
  const end = Date.now() + ms;
  for (;;) {
    const s = await status(page);
    if (s.current === step) return s;
    if (Date.now() > end) throw new Error(`等步骤 ${step} 超时；当前 ${s.current}，done=${s.done.join(',')}`);
    await sleep(120);
  }
};

/** 从场景里读一个实体（TS 私有字段在 evaluate 的 JS 世界里照读 —— 只读不写）*/
const evalWorld = <T>(page: Page, expr: string): Promise<T> =>
  page.evaluate(`(() => { const scene = globalThis.__scene; const combat = scene.combat; return ${expr}; })()`) as Promise<T>;

const playerPos = (page: Page) =>
  evalWorld<{ x: number; z: number; yaw: number }>(
    page, '{ x: combat.player.position.x, z: combat.player.position.z, yaw: combat.player.yaw }');

const dummyByClass = (page: Page, cls: string) =>
  evalWorld<{ id: number; x: number; z: number; alive: boolean } | null>(
    page,
    `(() => { for (const e of combat.allEntities()) { if (e.id !== combat.player.id && e.classId === '${cls}') return { id: e.id, x: e.position.x, z: e.position.z, alive: e.alive }; } return null; })()`,
  );

/**
 * 一次 evaluate 把「这个技能现在能不能按出去」的三件事全读回来。
 * ★ 合成一次往返而不是三次：SwiftShader 下每次 evaluate 中位 65ms，
 *   拆开读等于把轮询间隔悄悄变成三倍。
 */
interface CastReady {
  /** 该技能自身冷却剩余（秒，0 = 好了）*/ cd: number;
  /** 公共冷却剩余（秒）*/ gcd: number;
  /** 玩家是否正在读条/引导 */ casting: boolean;
}
const castReady = (page: Page, skillId: string): Promise<CastReady> =>
  evalWorld<CastReady>(page, `{
    cd: Math.max(0, (combat.player.cooldowns.get('${skillId}') ?? 0) - combat.world.time),
    gcd: Math.max(0, combat.player.gcdUntil - combat.world.time),
    casting: combat.store.has(combat.player.id),
  }`);

/** 空闲可出手：不在读条 + GCD 走完 + 该技能冷却好了 */
const readyNow = (r: CastReady): boolean => !r.casting && r.gcd <= 0.05 && r.cd <= 0.05;

/**
 * 等场景真的装好（`__scene.tutorial` 可读）。
 * ★ 这是**机器等待**不是游戏内时长：原来 goto/reload 之后固定睡 1200ms 是赌
 *   出来的数（实测冷启动 goto 起算到 tutorial 可读 ~2.0s，热启动 ~0.3s）——
 *   赌输了整脚本崩在第 0 条断言上。上限给得比 3 倍宽，因为 Vite 首次转译
 *   一个模块图确实可能慢，而这里等长了不影响任何判据。
 */
const waitScene = async (page: Page): Promise<void> => {
  const r = await pollFor(
    () => page.evaluate('!!(globalThis.__scene && globalThis.__scene.tutorial)')
      .then((v) => v === true).catch(() => false),
    (v) => v, 15000, 100,
  );
  if (!r.hit) throw new Error('页面 15 秒内没就绪（globalThis.__scene.tutorial 读不到）');
};

const wrap = (a: number): number => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

/**
 * 朝目标点走：小步「转向 → 前进」闭环（A/D 转身 + W 前进 —— 全部真实按键）。
 * 试验场朝向：yaw=0 面向 -Z（yawToDir = (-sin, -cos)）。
 *
 * ★ minDist：贴脸环节（9b/10b 的拳击）要求停在「够得着但没重叠」的带里 ——
 *   跑速 ~7m/s 时一个 200ms 长按 ≈ 1.4m，从远处收尾很容易一步冲进目标
 *   碰撞体（双方半径 0.5+0.5）。而边距为负时近战 `inRange` 判 OutOfRange
 *   （技术债 §8），拳击**永远不会起意** —— 9b/10b 曾因此间歇性挂掉
 *   （面包屑：dist=0.55、连续 12 饵零打断）。传 minDist 后到位时若贴得
 *   太近会背对目标小步倒出来（倒退 65% 速度，正好做精细档）。
 */
const steerTo = async (
  page: Page, target: { x: number; z: number }, stopDist: number,
  timeoutMs = 25000, minDist = 0,
): Promise<void> => {
  const end = Date.now() + timeoutMs;
  const distNow = async (): Promise<number> => {
    const p = await playerPos(page);
    return Math.hypot(target.x - p.x, target.z - p.z);
  };
  for (;;) {
    const p = await playerPos(page);
    const d = Math.hypot(target.x - p.x, target.z - p.z);
    if (d <= stopDist) {
      await page.keyboard.up('w');
      // 冲进重叠带就倒出来，直到回到 [minDist, stopDist] 的安全带
      for (let i = 0; minDist > 0 && i < 12 && (await distNow()) < minDist; i++) {
        await page.keyboard.down('s');
        await sleep(90);
        await page.keyboard.up('s');
      }
      return;
    }
    if (Date.now() > end) { await page.keyboard.up('w'); throw new Error(`走不到目标（剩 ${d.toFixed(1)}m）`); }
    const bearing = Math.atan2(-(target.x - p.x), -(target.z - p.z));
    const diff = wrap(bearing - p.yaw);
    if (Math.abs(diff) > 0.25) {
      await page.keyboard.up('w');
      const key = diff > 0 ? 'a' : 'd';
      await page.keyboard.down(key);
      await sleep(Math.min(300, Math.abs(diff) * 180));
      await page.keyboard.up(key);
    } else if (d - stopDist < 2.5) {
      // 减速带：点按防过冲（键抬起后再采样，位置不漂）
      await page.keyboard.down('w');
      await sleep(Math.max(50, Math.min(180, (d - stopDist) * 70)));
      await page.keyboard.up('w');
    } else {
      await page.keyboard.down('w');
      await sleep(200);
    }
  }
};

/** 硬目标已经是这个职业的假人了吗 */
const isTargeting = (page: Page, cls: string): Promise<boolean> =>
  evalWorld<boolean>(
    page,
    `(() => { const id = combat.player.targets.hard; if (id === undefined) return false; const e = combat.allEntities().find((x) => x.id === id); return !!e && e.classId === '${cls}'; })()`,
  );

/** Tab 循环直到硬目标是指定职业的假人 */
const targetClass = async (page: Page, cls: string): Promise<void> => {
  /**
   * ★ 先看一眼再动手（G6 去 sleep）：目标是**持续**的（5.x：不会自己丢），
   *   毕业环里这个函数每一轮都被调一次，而每轮开头那一下 Home + Tab 会把
   *   已经选对的目标**切走**，然后再花 7 次 Tab（每次 150ms）转回来。
   *   一次 65ms 的探测换掉最坏 1.7 秒的空转，还顺带不再无谓地扰动镜头。
   */
  if (await isTargeting(page, cls)) return;
  // ★ Tab 锥是**镜头**前方 140°（5.3）。steerTo 转的是角色 —— 先 Home
  //   把镜头复位到角色背后，锥口才对着刚才走向的目标。
  //   走位过冲时目标可能落在身后 —— 后续几轮左键把镜头转过去再扫一遍。
  //
  // ⚠️ **扫描面要盖满一圈。** 原来只扫三个方向（复位 + 左右各 300px），
  //   教学场地把三个假人挪近之后这就不够了：走位环结束时玩家的朝向
  //   是不确定的，目标有时落在三个采样锥之外，于是这个**摆位辅助**
  //   随机报「扫了三个镜头方向也没选中 mage」—— 看起来像教学坏了，
  //   实际是脚本没找到目标。★ 它不是断言，是断言的前置动作，
  //   加宽扫描面不会放松任何判据。
  for (let round = 0; round < 6; round++) {
    if (round === 0) {
      await page.keyboard.press('Home');
    } else {
      // 每轮再转一个身位，六轮累计转过一整圈有余
      await page.mouse.move(640, 400);
      await page.mouse.down();
      await page.mouse.move(640 + 320, 400, { steps: 8 });
      await page.mouse.up();
    }
    await sleep(150);
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      // ⚠️ 150ms 是**语义等待**不是懒惰等待：Tab 走 `input.pressed` 由场景
      //   循环逐帧消费，SwiftShader 一帧 50~100ms，按完立刻探会探在换目标之前。
      await sleep(150);
      if (await isTargeting(page, cls)) return;
    }
  }
  throw new Error(`扫了三个镜头方向也没选中 ${cls}`);
};

const playerCasting = (page: Page): Promise<boolean> =>
  page.evaluate(
    "(() => { const s = globalThis.__scene; return s.combat.store.has(s.combat.player.id); })()",
  ) as Promise<boolean>;

/**
 * 按一个技能，并等它**确实出手**（自身冷却被刷新为准）。返回出没出手。
 *
 * ★ 为什么认冷却而不是数毫秒：技能被 GCD / 学派锁 / 冷却静默拒绝是常态，
 *   固定 sleep 之后的断言分不清「放了但没推进」（真判据）和「压根没放出去」
 *   （空转的假绿）。比对**按之前**的冷却余量才算数 —— 直接看 `cd > 0` 会
 *   把「本来就在冷却中」误当成刚放的。
 * ★ 没出手不抛错：否定路要的是「不管出没出手都不该推进」，出没出手写进现场记录。
 */
const pressAndSettle = async (
  page: Page, key: string, skillId: string, capMs: number,
): Promise<boolean> => {
  const before = (await castReady(page, skillId)).cd;
  await page.keyboard.press(key);
  const r = await pollFor(() => castReady(page, skillId), (v) => v.cd > before + 0.5, capMs, 100);
  return r.hit;
};

/**
 * 按一发读条技能并等它读完（起手 → 施法条消失）。
 * ★ 「读完」也可能是「被打断」—— 这里只报事实，是读满还是被打断由调用点
 *   按上下文解释（10a 事前已确认站在拳击射程外，那里就只能是读满）。
 */
const pressAndCastThrough = async (
  page: Page, key: string, capMs: number,
): Promise<{ started: boolean; finished: boolean }> => {
  await page.keyboard.press(key);
  const started = await pollFor(() => playerCasting(page), (v) => v, 900, 80);
  if (!started.hit) return { started: false, finished: false };
  const done = await pollFor(() => playerCasting(page), (v) => !v, capMs, 100);
  return { started: true, finished: done.hit };
};

// ── 启动 ─────────────────────────────────────────────────────────

const browser: Browser = await (async () => {
  try {
    return await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  } catch {
    for (const channel of ['msedge', 'chrome']) {
      try { return await chromium.launch({ channel }); } catch { /* 下一个 */ }
    }
    throw new Error('没有可用浏览器');
  }
})();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors: string[] = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(URL);
await waitScene(page);

try {
  // ── 0：面板在场，教学从第一环开始 ──
  {
    const s = await status(page);
    const panel = await page.textContent('#tutorial-hud');
    check('0', '★ 教学激活：面板可见，从「移动」环开始',
      s.active && s.current === 'move' && (panel ?? '').includes('新手教学'),
      `current=${s.current}，面板含标题=${(panel ?? '').includes('新手教学')}`);
  }

  // ── 1 移动（含否定：只走不跳不算）──
  {
    // 按住 W 直到「走满 5 米」这件事**被教学看见**（moveGoals.walk 翻真）就松手。
    // 原来固定按 1300ms 是照 7m/s 跑速倒推的 —— 一旦掉帧就走不满，1a 的
    // `walk=true` 前提直接塌掉。上限 3.9s（原值 3 倍）。
    await page.keyboard.down('w');
    await pollFor(() => status(page), (s) => s.moveGoals.walk, 3900, 120);
    await page.keyboard.up('w');
    const half = await status(page);
    check('1a', '★ 否定：走满 5 米但没跳 → 环不亮', half.current === 'move' && half.moveGoals.walk,
      `walk=${half.moveGoals.walk}，仍在 ${half.current}`);
    /**
     * ★ 跳一次 —— 按了要**看结果**，没跳成就再按。
     *   跳跃的信号是 `TutorialDirector` 在渲染帧上采的「着地→离地」沿，
     *   而 SwiftShader 一帧要 50~100ms：`press('Space')` 的 down/up 相隔不到
     *   10ms，整个落在同一帧里就被吃掉，教学一个沿也采不到。原来是赌一次
     *   按中（实测会偶发赌输，整脚本崩在第 1b 条）。
     */
    let jumped = false;
    for (let i = 0; i < 6 && !jumped; i++) {
      await page.keyboard.press('Space');
      jumped = (await pollFor(
        () => status(page), (st) => st.moveGoals.jump || st.current !== 'move', 700, 100)).hit;
    }
    const s = await waitCurrent(page, 'camera', 4000);
    check('1b', '走 5 米 + 跳一次 → 过「移动」环', s.done.includes('move'), `done=${s.done.join(',')}`);
  }

  // ── 2 镜头（顺带否定：这时候放技能/选目标都不算数）──
  {
    await page.keyboard.press('Tab');
    /**
     * ★★ 这里放的是**霜甲护盾**（9 号键）而不是火冲 —— 换键是这一批查出来的
     *   bug 修复，不是口味问题：
     *     · 火冲 8 秒冷却。这一环烧掉它之后，4a「用瞬发火冲糊脸」那一按落在
     *       冷却里被静默拒绝 —— 4a 从来没真的糊出去过，是条**空转的假绿**
     *       （面包屑：把「已出手」打进现场记录后，4a 稳定打印 false；而第 5 环
     *       等火冲转好只花 0.4 秒，说明冷却是 2a 起的、不是 4a 起的）。
     *     · 霜甲护盾是自我瞬发、不需要目标、25 秒冷却后面再没人用，
     *       8 秒护盾到第 6 环就过期了，对后续任何一环都没有副作用。
     *   两条否定路各用各的技能，才都是真的。
     *
     * ★ 等待也从「数 600ms」改成「等这一发**确实打出去了**」：技能一旦被接受
     *   就当帧起 GCD/进冷却，探到这个信号说明 sim 已经完整处理过这次施法 ——
     *   教学要错误推进也该在同一拍推进了，此时再断言「还在 camera」比睡满
     *   600ms 更强。
     */
    const fired2 = await pressAndSettle(page, 'Digit9', 'mage.ice_barrier', 1500);
    const noSkip = await status(page);
    check('2a', '★ 否定：镜头环里选目标+放技能 → 不推进（顺序门控）',
      noSkip.current === 'camera' && fired2, `仍在 ${noSkip.current}（护盾已出手=${fired2}）`);

    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.mouse.move(920, 430, { steps: 14 });
    await page.mouse.up();
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -240); await sleep(120); }
    const s = await waitCurrent(page, 'target', 5000);
    check('2b', '环绕 + 缩放 → 过「镜头」环', s.done.includes('camera'), `done=${s.done.join(',')}`);
  }

  // ── 3 选中 / 4 第一发读条 / 5 瞬发 ──
  {
    await page.keyboard.press('Tab');
    const s = await waitCurrent(page, 'firstCast', 4000);
    check('3', '选中目标 → 过「选中」环', s.done.includes('target'), `done=${s.done.join(',')}`);

    // ★ 否定：瞬发火冲过不了「第一发读条」环（等它确实出手再断言，原固定 700ms）
    const fired4 = await pressAndSettle(page, 'Digit2', 'mage.fire_blast', 1500);
    const neg = await status(page);
    check('4a', '★ 否定：用瞬发火冲糊脸 → 「第一发读条」不亮', neg.current === 'firstCast',
      `仍在 ${neg.current}（火冲已出手=${fired4}）`);

    /**
     * ★ 先等 GCD 再读寒冰箭：4a 的火冲刚起了 1.5 秒公共冷却，紧接着按 1 号键
     *   会被静默拒绝。此前这一按之所以「不用等」，是因为 4a 那一发压根没放
     *   出去（见 2a 的注释）—— 把 4a 修真之后，这条隐藏依赖就露出来了。
     */
    let firstDone = false;
    for (let i = 0; i < 3 && !firstDone; i++) {
      await pollFor(() => castReady(page, 'mage.frostbolt'), readyNow, 3000, 100);
      await pressAndCastThrough(page, 'Digit1', 5000); // 寒冰箭 1.4s —— 站着读完
      firstDone = (await pollFor(
        () => status(page), (s) => s.done.includes('firstCast'), 800, 120)).hit;
    }
    const s2 = await waitCurrent(page, 'instant', 4000);
    check('4b', '读完一发寒冰箭 → 过「第一发」环', s2.done.includes('firstCast'), `done=${s2.done.length} 环`);

    /**
     * 火冲还在冷却（上面否定路刚用过，8s）—— 原来固定睡 6500ms，是拿「大概
     * 还剩多少」估的：估多了每跑一次白等一次，估少了这一按直接被拒、后面
     * `waitCurrent` 干等 6 秒再红。改成**盯冷却表**，转好就按。
     * 按完 1.5 秒内没推进就再按一遍（残余 GCD 吞按键是常态，重按不改判据）。
     */
    let instantDone = false;
    for (let i = 0; i < 4 && !instantDone; i++) {
      await pollFor(() => castReady(page, 'mage.fire_blast'), readyNow, 12000, 150);
      await page.keyboard.press('Digit2');
      instantDone = (await pollFor(
        () => status(page), (s) => s.done.includes('instant'), 1500, 120)).hit;
    }
    const s3 = await waitCurrent(page, 'ground', 4000);
    check('5', '瞬发火冲 → 过「瞬发与冷却」环', s3.done.includes('instant'), `done=${s3.done.length} 环`);
  }

  // ── 6 地面技能（落点预览 → 左键确认）──
  {
    // ★ 暴风雪带读条 —— 站在战士假人的拳击射程内会被它打断（这正是它教的
    //   反制链，但现在还没到那一环）。先拉开距离再施放
    const w0 = await dummyByClass(page, 'warrior');
    const p0 = await playerPos(page);
    if (w0) {
      const dx = p0.x - w0.x, dz = p0.z - w0.z;
      const len = Math.hypot(dx, dz) || 1;
      await steerTo(page, { x: w0.x + (dx / len) * 8, z: w0.z + (dz / len) * 8 }, 2, 15000)
        .catch(() => undefined);
    }
    // 等 GCD/上一发读条走完，预览起手才不会被拒（原固定 1600ms）
    await pollFor(() => castReady(page, 'mage.blizzard'), readyNow, 5000, 120);
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Digit6'); // 暴风雪进入预览
      // 等落点预览真的挂上（原固定 300ms）—— 没挂上就点，那一下会被当成普通点击
      await pollFor(
        () => page.evaluate('globalThis.__scene.aim?.pendingSkill?.id ?? null')
          .catch(() => null) as Promise<string | null>,
        (v) => v !== null, 900, 100);
      await page.mouse.move(640, 560); // 靠下的屏幕点 = 脚边的地面（不会指到天上/超距）
      await sleep(200); // 语义等待：落点射线跟着鼠标走，得让它渲染一帧
      await page.mouse.click(640, 560); // 确认落点
      // ★ 暴风雪 = 0.8s 起手 + 4s 引导，而引导在**结束时**才结算 ——
      //   这里必须站着等满（第一版等 2.4s 就按 Esc 重试，等于亲手取消自己的引导）
      const doneBy = Date.now() + 7000;
      while (Date.now() < doneBy && (await status(page)).current === 'ground') await sleep(150);
      if ((await status(page)).current !== 'ground') break;
      const why = await page.evaluate(`(() => {
        const s = globalThis.__scene;
        return {
          aim: s.aim?.pendingSkill?.id ?? null,
          mana: s.combat.player.resources.get('mana'),
          log: s.combat.log.slice(0, 3).map((l) => l.text),
        };
      })()`);
      console.log(`      （第 ${i + 1} 次未过：${JSON.stringify(why)}）`);
      await page.keyboard.press('Escape'); // 退出预览重试
      await sleep(400);
    }
    const s = await waitCurrent(page, 'defense', 4000);
    check('6', '地面技能全流程（预览→确认→落地）→ 过「地面」环', s.done.includes('ground'),
      `done=${s.done.length} 环`);
  }

  // ── 7 自保 ──
  {
    /**
     * X10 追加轮：暴风雪的结算改到**引导开始**（CastResolved 提前到 0.8s，
     * 雪边引导边下），过「地面」环那一刻玩家还在 4 秒引导里 —— 直接按 5
     * 会被「正在施法」拒掉。Esc 主动取消剩余引导（7.5 的合法操作，雪当场
     * 停）再放新星。此前不用等是因为旧时序把 CastResolved 拖到引导结束，
     * 过环即空闲 —— 那是错时序的巧合，不是本脚本的功劳。
     */
    await page.keyboard.press('Escape');
    /**
     * 等引导真的停下、GCD 也转完再按新星（原固定 400ms —— 那是「猜 Esc 多久
     * 生效」）。按完 1.5 秒不亮就重按：这一环此前是单发按键，被拒一次就得
     * 靠下面的 `waitCurrent` 干等 6 秒才红。
     */
    let defenseDone = false;
    for (let i = 0; i < 3 && !defenseDone; i++) {
      await pollFor(() => castReady(page, 'mage.frost_nova'), readyNow, 3000, 100);
      await page.keyboard.press('Digit5'); // 冰霜新星
      defenseDone = (await pollFor(
        () => status(page), (st) => st.done.includes('defense'), 1500, 120)).hit;
    }
    const s = await waitCurrent(page, 'interrupt', 4000);
    check('7', '放出冰霜新星 → 过「自保」环', s.done.includes('defense'), `done=${s.done.length} 环`);
  }

  // ── 8 打断法师（走近 + 等它读条 + 按 3）──
  {
    const mageDummy = await dummyByClass(page, 'mage');
    if (!mageDummy) throw new Error('找不到假人·法师');
    await steerTo(page, mageDummy, 24); // 法术反制射程 30，走到 24 米内
    /**
     * ★ **先选中一次，再等它读条。**
     *   原来把 `targetClass()` 放在等待循环里，每次发现读条都重扫一遍镜头 ——
     *   一次扫描要好几秒，15 秒预算被摆位吃掉，于是「没能在窗口内打断」
     *   变成了偶发失败。目标选中之后是**持续**的（5.x：目标不会自己丢），
     *   所以只需要选一次。这也更像真人的打法：先锁人，再等他起手。
     */
    await targetClass(page, 'mage');
    /**
     * 等它开始读条再按打断。
     *
     * ★★ 三处收紧（G6 这一批实测到的偶发红：`等步骤 locked 超时`）：
     *   · **只在真能按出去的时候按**。法术反制 20 秒冷却 —— 一次被公共冷却
     *     静默拒绝的按键不要紧，但一次「按出去了、法师那一发正好同帧读完」
     *     就白吃 20 秒，原来 15 秒的预算里再没有第二次机会，直接红。
     *     所以按之前先确认 GCD 与自身冷却都是空的。
     *   · **每轮确认目标还在**。丢了就重扫（选中是持续的，正常一轮都不用扫，
     *     `targetClass` 里那句「已经选中就别按」保证这不是白花钱）。
     *   · 预算 15s → 32s：容得下**一整轮**法术反制冷却。这不是放松判据
     *     （判据是「打断法师读条 → 过打断环」，从来不含「必须 15 秒内」），
     *     是把「第一次没赶上就判死」的人为死线拿掉。
     */
    const end = Date.now() + 32000;
    let landed = false;
    while (Date.now() < end && !landed) {
      const st = await evalWorld<{ casting: boolean; gcd: number; cd: number; targeted: boolean }>(
        page, `{
          casting: combat.store.has(${mageDummy.id}),
          gcd: Math.max(0, combat.player.gcdUntil - combat.world.time),
          cd: Math.max(0, (combat.player.cooldowns.get('mage.counterspell') ?? 0) - combat.world.time),
          targeted: combat.player.targets.hard === ${mageDummy.id},
        }`);
      if (!st.targeted) { await targetClass(page, 'mage').catch(() => undefined); continue; }
      if (st.casting && st.gcd <= 0.05 && st.cd <= 0.05) {
        await page.keyboard.press('Digit3');
        // 打断落地是同帧结算的 —— 环一亮就走（原固定 400ms）
        const got = await pollFor(
          () => status(page), (s) => s.done.includes('interrupt'), 600, 100);
        if (got.hit) { landed = true; break; }
      }
      await sleep(120);
    }
    const s = await waitCurrent(page, 'locked', 3000);
    check('8', '★ 打断法师读条 → 过「打断」环', landed && s.done.includes('interrupt'),
      `done=${s.done.length} 环`);
  }

  // ── 9 被打断的代价（走到战士身边故意挨拳，再用火焰还手）──
  {
    /**
     * ★ 否定：还没被打断就放火冲 —— 不算。
     *   2026-08-11 收口：这条否定路此前是**空转的假绿** —— 走到这里时火冲
     *   还在第 5 环烧掉的 8 秒冷却里，那一按被静默拒绝，「代价环不亮」
     *   验的是「什么都没发生」。现在等真冷却（≤8s）再按 —— 多花的这几秒
     *   买的是断言第一次真的成立；9b 自带 CD 等待环（60s 预算），
     *   不为此多付第二轮。
     */
    await pollFor(() => castReady(page, 'mage.fire_blast'),
      (r) => !r.casting && r.gcd <= 0.05 && r.cd <= 0.05, 9000, 150);
    await targetClass(page, 'warrior'); // 火冲要有合法目标 —— 没目标的「没出手」同样是空转
    const fired9 = await pressAndSettle(page, 'Digit2', 'mage.fire_blast', 1200);
    const neg = await status(page);
    // ★ fired9 进判据：火冲没真出手时这条否定路验的是「什么都没发生」——宁红勿假绿
    check('9a', '★ 否定：没被打断直接放火冲 → 「代价」环不亮', neg.current === 'locked' && fired9,
      `仍在 ${neg.current}（火冲已出手=${fired9}）`);

    const w = await dummyByClass(page, 'warrior');
    if (!w) throw new Error('找不到假人·战士');
    await steerTo(page, w, 2.4, 25000, 1.7); // 安全带 [1.7, 2.4]：够得着且不重叠
    // 读寒冰箭当饵让它打断（0.45s 反应 < 1.4s 读条 —— 必被打断）。
    // ★ 三个前置一个都不能省，缺一个这轮就白吃 15s 拳击冷却：
    //   · 火冲必须已转好 —— 学派锁只有 3 秒，锁着时才还手才算数（9a 刚用过它）
    //   · 拳击必须已转好 —— 否则饵读完了它也不咬
    //   · 还手要等饵触发的 GCD（1.5s）走完 —— applyInterrupt 不退还 GCD，
    //     所以锁定窗口的前半段火冲会被公共冷却吞掉，得反复按到它被接受
    const lockNow = () => evalWorld<boolean>(
      page, `(combat.player.schoolLocks.get('frost') ?? 0) > combat.world.time`);
    const cdOf = (expr: string) => evalWorld<number>(
      page, `Math.max(0, (${expr} ?? 0) - combat.world.time)`);
    const diag9 = () => page.evaluate(`(() => {
      const c = globalThis.__scene.combat;
      const w = c.allEntities().find((e) => e.classId === 'warrior' && e.id !== c.player.id);
      return {
        dist: w ? Math.hypot(w.position.x - c.player.position.x, w.position.z - c.player.position.z).toFixed(2) : '?',
        casting: c.store.has(c.player.id),
        hard: c.player.targets.hard,
        log: c.log.slice(0, 3).map((l) => l.text),
      };
    })()`);
    const end = Date.now() + 60000;
    let done9 = false;
    let attempt9 = 0;
    while (Date.now() < end && !done9) {
      const fbCd = await cdOf("combat.player.cooldowns.get('mage.fire_blast')");
      if (fbCd > 0.05) { await sleep(Math.min(fbCd * 1000 + 200, 4000)); continue; }
      const pCd = await cdOf(
        "combat.allEntities().find((e) => e.classId === 'warrior' && e.id !== combat.player.id)?.cooldowns.get('warrior.pummel')");
      if (pCd > 0.05) { await sleep(Math.min(pCd * 1000 + 300, 8000)); continue; }
      attempt9++;
      await targetClass(page, 'warrior');
      await page.keyboard.press('Digit1'); // 下饵
      let locked = false;
      let sawCast = false;
      for (let i = 0; i < 20 && !locked; i++) {
        await sleep(100);
        if (!sawCast) sawCast = await playerCasting(page);
        locked = await lockNow();
      }
      if (!locked) { // 没咬（没起手/落空）—— 打印现场，重来
        console.log(`      （9b 第 ${attempt9} 次没被打断：起手=${sawCast}，${JSON.stringify(await diag9())}）`);
        await sleep(800);
        continue;
      }
      // 锁定的 3 秒内反复按火冲：GCD（饵触发的 1.5s）一走完它就会被接受
      for (let i = 0; i < 40 && !done9; i++) {
        await page.keyboard.press('Digit2');
        await sleep(80);
        done9 = (await status(page)).done.includes('locked');
        if (!done9 && !(await lockNow())) {
          console.log(`      （9b 第 ${attempt9} 次锁过期未还手：${JSON.stringify(await diag9())}）`);
          break;
        }
      }
    }
    check('9b', '★ 被拳击打断（冰锁）→ 锁定期内用火焰还手 → 过「代价」环', done9,
      done9 ? '完成' : '60 秒内未完成');
  }

  // ── 10 假读条（否定：直接读完不算；正路：起手就 Esc，拳击落空）──
  {
    await waitCurrent(page, 'feint', 3000);
    const w = await dummyByClass(page, 'warrior');
    const distToWarrior = async (): Promise<number> => {
      const p = await playerPos(page);
      return Math.hypot(w!.x - p.x, w!.z - p.z);
    };

    // 否定路：确认拉开到拳击够不着（>5m）再把条读完 —— 不推进。
    // ★ 距离必须实测：柱子会把 steerTo 卡在半路，若还在 3 米内，
    //   这发会被拳击打断而不是「读完」，否定路就测歪了（还白烧它的冷却）
    for (let i = 0; i < 5 && (await distToWarrior()) < 5.5; i++) {
      const p = await playerPos(page);
      const dx = p.x - w!.x, dz = p.z - w!.z;
      const len = Math.hypot(dx, dz) || 1;
      await steerTo(page, { x: w!.x + (dx / len) * 8 + (i % 2 ? 3 : -3), z: w!.z + (dz / len) * 8 }, 2.5, 8000)
        .catch(() => undefined);
    }
    /**
     * 等这一发**真的读完**：探到起手 → 等施法条消失（原固定 2000ms ≈ 1.4s
     * 读条 + 余量）。上面已确认站在拳击射程外，所以「消失」只能是读满。
     * ★ 顺带把「到底起没起手」写进现场记录：起手被 GCD/学派锁吃掉时，
     *   这条判据原文级的否定路是空转的假绿 —— 睡 2 秒的写法看不出来。
     */
    let read10 = { started: false, finished: false };
    for (let i = 0; i < 3 && !read10.finished; i++) {
      read10 = await pressAndCastThrough(page, 'Digit1', 6000);
      if (!read10.started) await pollFor(() => castReady(page, 'mage.frostbolt'),
        (r) => !r.casting && r.gcd <= 0.05, 2000, 100);
    }
    const neg = await status(page);
    check('10a', '★★ 否定（判据原文）：不按 Esc 直接读完 → 任务不亮',
      neg.current === 'feint' && read10.finished,
      `仍在 ${neg.current}（读完=${read10.finished}，读完时距战士 ${(await distToWarrior()).toFixed(1)}m）`);

    // 正路：回到战士身边假读条。
    // ★ 时序是本环的全部难点：拳击在它看见读条后 0.45s 落下，Esc 必须落在
    //   这个窗口**内**。固定睡 280ms 再按 Esc 在无头渲染下会抖出窗口外
    //   （慢一帧就变成「被打断」而不是「骗到」，还白吃 15s 冷却）——
    //   所以改成轮询确认「真的起手了」就立刻取消，窗口余量从 ~170ms 放大到
    //   ~350ms；挥没挥出去不猜时间，直接盯它的冷却从 0 跳到 15。
    await steerTo(page, w!, 2.4, 25000, 1.7); // 同 9b：停在「够得着不重叠」带
    const pummelCd = () => evalWorld<number>(
      page, `Math.max(0, (combat.allEntities().find((e) => e.classId === 'warrior' && e.id !== combat.player.id)?.cooldowns.get('warrior.pummel') ?? 0) - combat.world.time)`);
    const end = Date.now() + 60000;
    let feinted = false;
    while (Date.now() < end && !feinted) {
      // 等拳击转好（否则它不会起意）
      const cd = await pummelCd();
      if (cd > 0.05) { await sleep(Math.min(cd * 1000 + 300, 8000)); continue; }
      await targetClass(page, 'warrior'); // 每轮重选 —— 霜矢没目标就压根不起手
      await page.keyboard.press('Digit1');
      // 确认起手（残余 GCD/学派锁会吃掉按键 —— 没起手这轮作废，不浪费 Esc）
      let casting = false;
      for (let i = 0; i < 8 && !casting; i++) { await sleep(60); casting = await playerCasting(page); }
      if (!casting) { await sleep(500); continue; }
      await page.keyboard.press('Escape'); // 起手确认后立刻取消
      // 盯这一拳：冷却跳起 = 挥出去了（落空或命中都算挥出）；随后看环过没过
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        if ((await status(page)).done.includes('feint')) { feinted = true; break; }
        if ((await pummelCd()) > 5) break; // 挥出但没骗到（Esc 晚了，被打断）—— 等冷却再试
      }
      if (!feinted && (await playerCasting(page))) await page.keyboard.press('Escape');
    }
    check('10b', '★★ 起手读条 → 立刻 Esc → 拳击落空 → 过「假读条」环', feinted,
      feinted ? '骗到了' : '60 秒内未骗到');
  }

  // ── 11 走位（否定：站着挨炸不算；正路：进圈再走出去）──
  {
    await waitCurrent(page, 'sidestep', 3000);
    // 教学接管：法师假人往脚下丢陨石（读条 1s + 落地 1.5s）。
    // 否定路：第一颗站着不动挨炸
    const firstImpact = Date.now() + 15000;
    let sawZone = false;
    while (Date.now() < firstImpact) {
      const s = await status(page);
      if (s.current !== 'sidestep') break;
      const pendingId = await evalWorld<number | null>(
        page,
        `(() => { const p = combat.projectiles.items.find((x) => x.kind === 'delayedImpact'); return p ? p.id : null; })()`);
      if (pendingId !== null) {
        sawZone = true;
        /**
         * 站着不动，等**这一颗**结算掉（原固定 3200ms ≈ 1.5s 延迟 + 余量）。
         * ★ 认 id 不认种类：教学是一颗接一颗地丢，认「还有没有 delayedImpact」
         *   会把下一颗当成这一颗还没落地，白等满整个预算。
         */
        await pollFor(
          () => evalWorld<boolean>(page, `combat.projectiles.items.some((p) => p.id === ${pendingId})`),
          (v) => !v, 9600, 150);
        break;
      }
      await sleep(200);
    }
    const negS = await status(page);
    check('11a', '★ 否定：站在圈里挨炸 → 「走位」环不亮',
      sawZone && negS.current === 'sidestep', `见到陨石=${sawZone}，仍在 ${negS.current}`);

    // 正路：下一颗 —— 圈出现后立刻朝反方向跑
    const end = Date.now() + 25000;
    let dodged = false;
    while (Date.now() < end) {
      const imp = await evalWorld<{ id: number; x: number; z: number } | null>(
        page, `(() => { const p = combat.projectiles.items.find((x) => x.kind === 'delayedImpact'); return p ? { id: p.id, x: p.center.x, z: p.center.z } : null; })()`);
      if (imp) {
        const p = await playerPos(page);
        // 单位化外撤方向 —— 陨石就砸在脚下时 p-imp≈0，直接乘系数会算出圈内点
        const dx = p.x - imp.x, dz = p.z - imp.z;
        const len = Math.hypot(dx, dz);
        const dir = len > 0.3 ? { x: dx / len, z: dz / len } : { x: 1, z: 0 };
        const out = { x: imp.x + dir.x * 9, z: imp.z + dir.z * 9 };
        await steerTo(page, out, 2, 4000).catch(() => undefined);
        /**
         * 走出去之后等**这一颗**落地结算（原固定 800ms）。
         * ★ 出口有两个：环亮了（躲开了，立刻走）、或者这颗已经结算但环没亮
         *   （这次没躲干净，立刻去追下一颗）—— 都比睡满 800ms 快。
         *   一颗陨石从出现到落地 1.5 秒，25 秒预算里能试的轮数就是这一环
         *   的全部余量：每轮多花 0.8 秒，少试一轮（实测 25s 预算被吃满而
         *   偶发红，就是这么来的）。
         */
        const r = await pollFor(
          () => page.evaluate(`(() => {
            const s = globalThis.__scene;
            return {
              done: s.tutorial.status.done.includes('sidestep'),
              pending: s.combat.projectiles.items.some((p) => p.id === ${imp.id}),
            };
          })()`) as Promise<{ done: boolean; pending: boolean }>,
          (v) => v.done || !v.pending, 4000, 120);
        // 结算与教学推进可能差一拍 —— 落地后再补看一眼，别把刚躲开的当没躲开
        if (r.last.done
          || (await pollFor(() => status(page), (s) => s.done.includes('sidestep'), 400, 120)).hit) {
          dodged = true; break;
        }
      }
      await sleep(200);
    }
    check('11b', '★ 看倒计时走出圈 → 过「走位」环', dodged, dodged ? '躲开了' : '25 秒内未躲开');
  }

  // ── 12 毕业（低血量三假人）──
  {
    await waitCurrent(page, 'graduate', 3000);
    const killOne = async (cls: string): Promise<void> => {
      const d = await dummyByClass(page, cls);
      if (!d) throw new Error(`找不到 ${cls}`);
      // ★ 战士在 8 米外打：站进 3 米内每发读条都在喂它的拳击（毕业环全员活着）
      await steerTo(page, d, cls === 'warrior' ? 8 : 18);
      const end = Date.now() + 60000;
      for (;;) {
        if (Date.now() > end) throw new Error(`${cls} 打不倒`);
        const s0 = await status(page);
        if (s0.current === null) return;
        await targetClass(page, cls).catch(() => undefined);
        // ★ 牧师 1.1s 一发的自疗会把伤害全奶回去 —— 毕业课的考点就是
        //   先断奶再爆发：等断法转好 → 等它起手 → 断（神圣锁 3 秒）。
        //   锁窗口里两发霜矢（2×200）就穿 360 的小血池；断法没转好时
        //   打了也白打，直接等
        if (cls === 'priest') {
          const cs = await evalWorld<number>(
            page, `Math.max(0, (combat.player.cooldowns.get('mage.counterspell') ?? 0) - combat.world.time)`);
          if (cs > 0.05) { await sleep(Math.min(cs * 1000 + 200, 5000)); continue; }
          for (let t = Date.now() + 6000; Date.now() < t; ) {
            if (await evalWorld<boolean>(page, `combat.store.has(${d.id})`)) break;
            await sleep(120);
          }
          await page.keyboard.press('Digit3');
          await sleep(150);
        }
        // 两发霜矢背靠背，霜矢间隙搭火冲（转好了就接受，没转好被拒不亏）
        for (let i = 0; i < 3; i++) {
          /**
           * ★★ 全脚本最贵的一处固定 sleep（毕业环占全程四分之一，这一句要跑十几遍）。
           *
           *   原来是「按 Digit1 → 睡 1750ms → 按 Digit2 → 睡 120ms」，问题不在
           *   1750 猜得准不准，而在**节拍对不上**：火冲起的 1.5 秒 GCD 要到
           *   t≈3.25s 才走完，可下一圈在 t≈1.87s 就按霜矢 —— 必被静默拒绝，
           *   然后老老实实再睡 1750ms 什么也没干。实测三圈只打得出两发。
           *
           *   改成「等能按了再按 → 等它读完再走下一手」：每一步都由事实驱动，
           *   同样三圈稳打三发（吞吐 ×1.5），慢机器上也不会因为读条超过 1750ms
           *   就把下一发按空。
           */
          await pollFor(() => castReady(page, 'mage.frostbolt'),
            (r) => !r.casting && r.gcd <= 0.05, 2500, 100);
          await pressAndCastThrough(page, 'Digit1', 4000);
          await page.keyboard.press('Digit2'); // 残余 GCD 由 X21 的 0.4 秒施法排队窗接住
          await sleep(120);
          const s = await status(page);
          if (s.killedDummies > s0.killedDummies || s.current === null) return;
        }
      }
    };
    await killOne('mage');    // 先拔炮台 —— 它 200 一发的霜矢是打牧师时最大的干扰
    await killOne('priest');  // 再断奶 —— 神圣锁的 3 秒窗口就是爆发窗口
    await killOne('warrior'); // 最后收拳手 —— 8 米外它只能干瞪眼
    const s = await waitCurrent(page, null, 8000);
    check('12', '★★ 打倒三个假人 → 毕业（教学全部完成）',
      s.done.length === 12 && s.current === null, `done=${s.done.length}/12`);
  }

  // ── 13 持久化（可重进）+ 跳过/重开按钮 ──
  {
    await page.reload();
    await waitScene(page);
    const s = await status(page);
    check('13a', '★ 刷新后进度还在（localStorage 持久化）',
      s.current === null && s.done.length === 12, `done=${s.done.length}，current=${s.current}`);

    // 按钮的效果是同帧生效的，等状态翻过来就走（原两处固定 300ms）
    await page.click('[data-tutorial-action="restart"]');
    const s2 = (await pollFor(
      () => status(page), (v) => v.current === 'move' && v.done.length === 0, 900, 100)).last;
    check('13b', '★ 「重新开始」→ 回到第一环', s2.current === 'move' && s2.done.length === 0,
      `current=${s2.current}`);

    await page.click('[data-tutorial-action="skip"]');
    const s3 = (await pollFor(() => status(page), (v) => v.skipped, 900, 100)).last;
    const collapsed = await page.textContent('#tutorial-hud');
    check('13c', '★ 「跳过教学」→ 面板收起，可再进', s3.skipped && (collapsed ?? '').includes('重新开始'),
      `skipped=${s3.skipped}`);
  }

  check('14', '★ 全程零页面错误', pageErrors.length === 0,
    pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : '无');
} finally {
  await browser.close();
}

console.log(`\n${'─'.repeat(60)}`);
const failed = results.filter((r) => !r.pass);
console.log(`M15 验收：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.id).join(', '));
  process.exit(1);
}
