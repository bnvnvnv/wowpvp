/**
 * X18①：姓名板的**互相避让**。
 *
 * ★★ 真机 12v12 实测：屏幕上同时有 3 对姓名板叠在一起 —— 血条压在别人
 *   名字上，两个名字糊成一行。姓名板是 5.2 的点击选中面，叠在一起时
 *   「点到的是不是我想选的那个」变成一次赌博。
 *
 * ── 为什么是这个算法，而不是一个更好的算法 ────────────────────
 *
 * ★★ **X10 实测点名过姓名板 DOM 是 CPU 嫌疑人。** 所以避让的第一约束
 *   不是「排得多好看」，而是「几乎不要钱」：
 *     · 只在 20Hz 的内容刷新那一拍算（`renderNameplates` 的 `full` 分支），
 *       中间的帧复用上一次的结果 —— 姓名板的**位置**照常每帧跟镜头，
 *       错位量落后最多 50ms，肉眼看不出来；
 *     · 位置变化没超过 `NAMEPLATE_RELAYOUT_EPSILON_PX` 时**连算都不算**
 *       （`needsRelayout`）—— 站桩对峙时这一整套是零成本的；
 *     · 碰撞判定按横向距离先剪枝，实际比较次数远小于 n²（n ≤ 24）。
 *
 * ★★ **迟滞（hysteresis）不是可选项。** 没有它的话，两块板在「刚好挨着」
 *   的边界上会每一拍换一次高度 —— 玩家看到的是两个名字在互相抽搐，
 *   比原来的重叠更难受。这里的迟滞是**非对称**的：
 *   压住别人是硬伤，往上抬**立刻抬**；往回降则要**能降超过
 *   `HYSTERESIS_PX` 才降**（只差几个像素不值得动）。
 *   进和退用两条不同的线，边界抖动就穿不过去。
 *
 * ★ 排序键先把 y 量化到 `SORT_BUCKET_PX` 再比，然后按 id 兜底 ——
 *   两块板 y 差 0.3px 时不会因为镜头微动就交换名次（那同样是抽搐的来源）。
 */

/** 与 index.html 的 `.nameplate { width: 108px }` 同源。改一处就要改另一处 */
export const NAMEPLATE_WIDTH_PX = 108;

/**
 * 一块姓名板的视觉高度，px。
 * 名字 11px/1.4 ≈ 16 + 血条 4 + 读条常驻位 4 + 两道 margin 4 ≈ 28，取 30 留一点余量。
 * ★ X18② 把读条改成**常驻占位**之后这个数才是稳定的 —— 在那之前
 *   同一块板会在 24 和 30 之间跳，避让算出来的结果也就跟着跳。
 */
export const NAMEPLATE_HEIGHT_PX = 30;

/** 两块板之间留的缝，px。★ 贴着摞会让两行字看起来还是一块板 */
export const NAMEPLATE_GAP_PX = 2;

/**
 * 最多往上抬多少 px（≈3 块板）。
 *
 * ★ 到顶就**让它们重叠**，不再往上摞 —— 抬到角色头顶两米高的板，
 *   「这是谁的板」反而比重叠更难回答，而且会飞出屏幕上沿被剔掉。
 *   避让的目的是让点击命中率回来，不是消灭所有重叠。
 */
export const NAMEPLATE_MAX_LIFT_PX = 96;

/** 退回下一层需要多空出来的余量，px。见文件头「非对称阈值」 */
export const NAMEPLATE_HYSTERESIS_PX = 8;

/** 排序前把 y 量化到这个粒度，避免亚像素抖动换名次 */
export const NAMEPLATE_SORT_BUCKET_PX = 8;

/** 位置变化不超过这个数就不重算避让 */
export const NAMEPLATE_RELAYOUT_EPSILON_PX = 5;

/** 一块姓名板的屏幕落点（投影之后、错位之前）*/
export interface NameplateSpot {
  id: number;
  x: number;
  y: number;
}

/**
 * 要不要重算避让。
 *
 * ★ 三种情况必须重算：板的**集合**变了（有人进出视野/被密度裁掉）、
 *   任何一块**移动超过阈值**、上一次压根没算过。
 * ⚠️ 集合相同 + 全都只挪了两三个像素 ⇒ 返回 false，这一拍白省下来。
 */
export const needsRelayout = (
  prev: readonly NameplateSpot[] | undefined,
  next: readonly NameplateSpot[],
  epsilon = NAMEPLATE_RELAYOUT_EPSILON_PX,
): boolean => {
  if (!prev || prev.length !== next.length) return true;
  const byId = new Map(prev.map((p) => [p.id, p]));
  for (const s of next) {
    const p = byId.get(s.id);
    if (!p) return true;
    if (Math.abs(p.x - s.x) > epsilon || Math.abs(p.y - s.y) > epsilon) return true;
  }
  return false;
};

interface Placed {
  x: number;
  y: number;
}

/** 这个落点会不会压到已落位的某块板上。横向先剪枝，实际比较次数远小于 n² */
const collidesWith = (x: number, y: number, placed: readonly Placed[]): Placed | undefined => {
  let top: Placed | undefined;
  for (const p of placed) {
    if (Math.abs(p.x - x) >= NAMEPLATE_WIDTH_PX) continue;
    if (Math.abs(p.y - y) >= NAMEPLATE_HEIGHT_PX) continue;
    // 一次抬到**最靠上**那块的上面，省掉中间几轮迭代
    if (!top || p.y < top.y) top = p;
  }
  return top;
};

/**
 * 把一块板往上推到不压人为止，返回需要抬多少 px。
 *
 * ★ **推刚好够的量**，不按固定档位跳 —— 档位化会出现「只差 10px 却抬了
 *   一整格」的大空隙，混战里那种空隙比重叠还让人认不出谁是谁。
 */
const liftFor = (s: NameplateSpot, placed: readonly Placed[]): number => {
  let d = 0;
  // 每轮至少解决掉一块，轮数上限 = 已落位数 + 1，不会打转
  for (let guard = 0; guard <= placed.length; guard++) {
    const hit = collidesWith(s.x, s.y - d, placed);
    if (!hit) return d;
    d = s.y - (hit.y - NAMEPLATE_HEIGHT_PX - NAMEPLATE_GAP_PX);
    if (d >= NAMEPLATE_MAX_LIFT_PX) return NAMEPLATE_MAX_LIFT_PX;
  }
  return Math.min(d, NAMEPLATE_MAX_LIFT_PX);
};

/**
 * 给每块姓名板算一个**向上**的错位量（px，0 = 不动）。
 *
 * @param prev 上一次的结果，用于迟滞。不传 = 冷启动。
 * @returns id → 错位 px。★ 调用方把它从 y 里减掉（姓名板锚在头顶，向上摞）
 */
export const stackNameplates = (
  spots: readonly NameplateSpot[],
  prev?: ReadonlyMap<number, number>,
): Map<number, number> => {
  const out = new Map<number, number>();
  if (spots.length === 0) return out;

  // 稳定顺序：先量化 y（从上到下），再按 id 兜底 —— 与镜头微动解耦
  const ordered = [...spots].sort((a, b) => {
    const ba = Math.round(a.y / NAMEPLATE_SORT_BUCKET_PX);
    const bb = Math.round(b.y / NAMEPLATE_SORT_BUCKET_PX);
    return ba !== bb ? ba - bb : a.id - b.id;
  });

  /** 已经落位的板（y 是**错位之后**的最终值）*/
  const placed: Placed[] = [];

  for (const s of ordered) {
    const natural = liftFor(s, placed);
    const before = prev?.get(s.id) ?? 0;
    /**
     * ★★ 迟滞：**往回降**要够本才降。
     *
     *   上一拍抬了 42px，这一拍算出来只要 38px —— 差 4px 不值得动，
     *   动了玩家看到的就是名字在抽搐（两块板在「刚好挨着」的边界上
     *   会每 50ms 换一次高度）。只有当能降的量超过 `HYSTERESIS_PX`
     *   时才真的降回去。抬高**没有**这道门槛：压住别人是硬伤，立刻修。
     * ⚠️ 沿用旧值前仍要确认它现在也不压人 —— 别的板可能挪到那个高度上了。
     */
    const keepOld =
      before > natural
      && before - natural <= NAMEPLATE_HYSTERESIS_PX
      && collidesWith(s.x, s.y - before, placed) === undefined;
    const chosen = keepOld ? before : natural;
    out.set(s.id, chosen);
    placed.push({ x: s.x, y: s.y - chosen });
  }
  return out;
};

// ── X18③：低血变色 ────────────────────────────────────────────

/**
 * 姓名板血条「低血」的判据。
 *
 * ★ 0.35 与 `shared/ai/botController.ts` 的 `TACTICS.SURVIVAL_HEALTH` **同数**：
 *   bot 在这条线上开保命键，玩家在这条线上该考虑集火或后撤 ——
 *   「谁进了斩杀线」两边说的是同一件事，用两个数会让 HUD 与 AI 各有一套斩杀线。
 * ⚠️ 那个常量没有从 shared 导出（它是 bot 内部的占位调参表），所以这里
 *   是一份**有出处的复制**，由 `hud.test.ts` 的一条源码断言钉住两处同数。
 */
export const NAMEPLATE_LOW_HP = 0.35;

export const isLowHealth = (health: number, maxHealth: number): boolean =>
  maxHealth > 0 && health > 0 && health / maxHealth < NAMEPLATE_LOW_HP;

/**
 * 低血时血条用什么颜色。
 *
 * ★★ **不能用 `palette.danger`。** 四套色板里 `danger` 与 `hostile` 是
 *   **同一个颜色值**（`accessibility.ts` 的 PALETTES 逐条可查）——
 *   而姓名板血条平时就已经按阵营染成 hostile 色了，于是「敌人进斩杀线」
 *   这条最要紧的提示会**一点都看不出来**。
 * ★ 改用 `neutral`（黄 / 三色觉异常下紫）：它在两条阵营色之外，
 *   敌我两侧都能明显变色，且仍在同一份语义色板里（不是新造一个颜色）。
 * ★ 颜色只是第一通道 —— 第二通道是同时出现的百分比小字（17.2）。
 */
export const lowHealthColor = (palette: { neutral: string }): string => palette.neutral;
