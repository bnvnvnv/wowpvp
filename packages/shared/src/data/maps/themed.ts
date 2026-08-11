/**
 * 四张主题竞技场（P5 内容批）。
 *
 * 用户拍板（2026-08-10）：「地图美术帮我多做一些地图（各种不同风格的，
 * 各种地势和道具的）」。本文件交付的是「风格」的**四个可编程轴**：
 *
 *   ① **布局地势** —— 中央高地 / 中央高台 / 柱状树阵 / 断墙短桥，四张图四种打法；
 *   ② **装饰主题** —— 哨站营地 / 熔岩火盆 / 林间祭坛 / 废料箱桶，四套 decor 素材；
 *   ③ **昼夜 preset** —— dawn / day / dusk / night，一眼可辨是哪张图；
 *   ④ **地面材质** —— snow / grass / rock / dirt（`groundTexture`，现成贴图直接换）。
 *
 * ⚠️ 剩下的美术半边**不在本文件里**：墙/柱的贴图与材质分化（Q 版高饱和方向）、
 *   装饰 instancing、天空盒 —— 那些要素材侧动工，docs/17 的 P5 行仍挂着。
 *
 * ── 与 `arena.ts` 的关系 ──────────────────────────────────────
 *
 * `arena.ts` 是**参数化试炼环**：一套生成器出 1v1–12v12 十二张同构图，
 * 差别只有尺寸与柱数。本文件反过来 —— **四张手工图，各自一套地形**，
 * 每张覆盖一个**人数档区间**（`modes` 多值）而不是一个档。
 *
 * ★★ **默认路径一字不变**：`mapsForMode(mode)[0]` 仍然是试炼环那张
 *   （本批的图在 `ALL_MAPS` 里排在 `ARENA_MAPS` **之后**），
 *   `setMode` 换图、房间默认 `arena_3v3` 全部照旧。这四张图要玩家
 *   **主动选**才会用上 —— 选图 UI 是下一环的事。
 *
 * ── 三条硬约束（`themed.test.ts` 逐条机检）────────────────────
 *
 *   · **z 镜像公平**：只写 +z 半场，−z 半场由 `mirrorZ` 生成 ——
 *     不对称在语法上无法表达（docs/06 §8.3 的 `mirrorX` 同款思路，轴换成 z）。
 *     跨中线的件必须自己就 z 对称。
 *   · **所见即所中**（docs/06 §8.2）：挡路的一律是 `geometry` 里的真碰撞体；
 *     `decor` 只放不挡路的小件。没有「看着能躲其实穿模」的东西。
 *   · **出生走廊留空**：bot 没有寻路（B1），出生点直走到中央这条线上
 *     不放任何绕不开的件。中央地形件是例外 —— 它朝出生方向有一部
 *     **级高 ≤ 可跨** 的楼梯，直走的 bot 会自动踏上去而不是撞停。
 */

import { GEOMETRY, MOVE } from '../../constants/combat.js';
import { GameMode } from '../../types/enums.js';
import { asMapId, TEAM_BLUE, TEAM_RED, type TeamId } from '../../types/ids.js';
import {
  box, type MapDecorDef, type MapDef, type MapVolume, type PrepRoom, type SpawnPoint,
} from './schema.js';

/** 级高上限 = 可跨高度。楼梯在移动物理上就是坡道（与 3v3 试点同一条） */
const RISE = GEOMETRY.STEP_HEIGHT;

/**
 * ★★ **落地矮件的高度只有一个合法值：`RISE`。**
 *
 * 中间那一段是**死区**。角色能通过一件矮墙只有两条路：
 *   · `tryStepUp` 自动跨越 —— 要求高度 ≤ `STEP_HEIGHT` = 0.45 m；
 *   · 跳过去 —— 22 的重力 + 7.2 起跳初速，理论顶点 1.178 m，
 *     60Hz 离散化后**实测只有 1.12 m**。
 * 所以 (0.45, 1.12] 是「跳得上去」，(1.12, 1.35] 是**谁也过不去**，
 * 而 ≤ 1.35 m（胸口线）的件按 6.4 又必须 `blocksSight:false`
 * ——「显式声明我很矮，其实是一堵绝对墙」，正好是「所见即所中」的反面。
 *
 * 此前 grove 的倒木与 ruins 的矮瓦砾都写 1.2 m，落在死区里：
 * 8–9 米长、只到膝盖以上一点、还能隔着它对射，实测纯直走与按住跳
 * 都停在盒外一个身位。现在统一压到 `RISE`，读数与判定重新一致：
 * **看着能一步迈过去，就真能一步迈过去**（bot 无寻路，这也顺带拆了直线陷阱）。
 *
 * ★ 等号是安全的：`tryStepUp` 抬到 `0 + STEP_HEIGHT`，
 *   而 `cylinderOverlapsAabb` 在 `foot.y >= box.max.y` 时判不相交 ——
 *   两边逐位相同（都是同一个 `GEOMETRY.STEP_HEIGHT` 字面量）。
 */
const LOW_COVER_H = RISE;

// ════════════════════════════════════════════════════════════════
//  镜像与地形构件
// ════════════════════════════════════════════════════════════════

/**
 * 把 +z 半场的一件翻到 −z。**id 必须以 `_s` 结尾**，翻过去变 `_n`。
 *
 * ★ 这不是「顺手写个工具函数」：docs/06 §8.3 的原话是「与其写完两边再测
 *   对称性，不如让不对称在语法上无法表达」。竞技场两队分居 ±Z，所以这里
 *   镜的是 z 轴（夺旗图镜 x）。
 */
const mirrorZ = (v: MapVolume): MapVolume => ({
  ...v,
  id: `${v.id.slice(0, -2)}_n`,
  min: { x: v.min.x, y: v.min.y, z: -v.max.z },
  max: { x: v.max.x, y: v.max.y, z: -v.min.z },
});

/** 写一半，得两半 */
const bothSides = (south: readonly MapVolume[]): MapVolume[] => [...south, ...south.map(mirrorZ)];

/** decor 同款镜像。yaw 取 π−yaw（沿 z 反射后朝向的正确像） */
const mirrorZDecor = (d: MapDecorDef): MapDecorDef => ({
  ...d,
  position: { x: d.position.x, y: d.position.y, z: -d.position.z },
  yaw: Math.PI - (d.yaw ?? 0),
});

const bothSidesDecor = (south: readonly MapDecorDef[]): MapDecorDef[] =>
  [...south, ...south.map(mirrorZDecor)];

/**
 * ★★ **台阶顶面高度必须逐级累加出来，不能用 `platH − k*RISE` 倒着算。**
 *
 * `tryStepUp`（movement.ts）先把角色抬到 `from.y + STEP_HEIGHT` 再判碰撞，
 * 而 `cylinderOverlapsAabb` 的出口条件是 `foot.y >= box.max.y`（**严格**）。
 * 于是「上得去」等价于 `上一级顶 + STEP_HEIGHT >= 下一级顶` 在 **IEEE754 实值上**
 * 成立 —— 差 1 个 ulp 就直接 `return undefined`，角色贴着台阶原地站住。
 *
 * 倒着算会踩雷：`3*0.45 = 1.3500000000000000888`，于是 `1.35 − 2*0.45`
 * 得到 `0.45000000000000006661` > `0 + 0.45`，**第一级就上不去**。
 * 逐级累加则由构造保证 `tops[k] === tops[k-1] + RISE` 逐位相等，
 * 抬升后恰好落在顶面上（等号成立 → 不判相交）。
 *
 * ⚠️ 这不是理论洁癖：三张主题图 + `arena.ts` 的 3v3 试点高台都因为这一条
 *   「只有会跳的人才上得去」，而机检比的是数据里的高度差还给了 `+1e-9` 容差，
 *   63 条全绿地骗过了两批人。机检已改成跑真解算器（`themed.test.ts`）。
 */
const stairTops = (steps: number): number[] => {
  const tops: number[] = [];
  let y = 0;
  for (let i = 0; i < steps; i++) {
    y += RISE;
    tops.push(y);
  }
  return tops;
};

/** 台顶高度 = 逐级累加的最后一级（**不要**写成 `steps * RISE`，见 `stairTops`）*/
const platHeight = (steps: number): number => stairTops(steps)[steps - 1]!;

interface StairOpts {
  /** 总升程级数（含台顶那一级）*/
  steps: number;
  /** 踏面进深 */
  tread: number;
  /**
   * 楼梯宽度。★ 一律取**满台面宽**（= 台体在该方向的边长）。
   *
   * 理由是行为而不是美观：bot 没有寻路（B1），直走撞上台体侧壁就永久停住。
   * 只要楼梯窄于台面，就一定存在一条「正对台壁而不是台阶」的直线 ——
   * 熔岩裂谷（宽 10 vs 台 26，出生点铺到 ±10）与密林祭坛（宽 6 vs 台 12，
   * 出生点铺到 ±5）此前正是如此，9 个 / 5 个出生点里各有 4 个 / 2 个
   * 直走到不了中央。满台面宽把这件事变成几何恒真：
   * **能撞上台体正面的直线，必然先踏上台阶**。
   */
  width: number;
  /** 下行方向所在轴 */
  axis: 'x' | 'z';
  /** 下行方向（+1 / −1）*/
  dir: 1 | -1;
  /** 台沿在 axis 上的坐标 */
  edge: number;
  /** 另一轴上的中心坐标 */
  along: number;
}

/**
 * 一段宽楼梯：从台沿向外逐级下行。
 *
 * 只产出**中间级** —— 最高一级就是台顶本身（与 3v3 试点同款算法）。
 * 每级都 `blocksSight:false`：楼梯是坡道不是掩体，站在台下的人应当
 * 看得见台阶上的人（否则「所见即所中」会反过来骗人）。
 */
const stairs = (idOf: (i: number) => string, o: StairOpts): MapVolume[] => {
  const tops = stairTops(o.steps);
  return Array.from({ length: o.steps - 1 }, (_, i) => {
    const off = o.edge + o.dir * (i * o.tread + o.tread / 2);
    // i=0 是紧贴台沿的最高一级，i=steps-2 是最外的第一级
    const h = tops[o.steps - 2 - i]!;
    return box(
      idOf(i),
      'ramp',
      o.axis === 'x' ? { x: off, y: 0, z: o.along } : { x: o.along, y: 0, z: off },
      o.axis === 'x'
        ? { w: o.tread, h, d: o.width }
        : { w: o.width, h, d: o.tread },
      { blocksSight: false },
    );
  });
};

/**
 * **环形阶梯**：把方形台体整个包成一座阶梯金字塔，每一级是一圈「回」字。
 *
 * ★★ 为什么不是「四面各一部楼梯」（本文件最初的写法）：
 *   四条面向的窄梯之间会留下**四个角落凹槽** —— 相邻两部楼梯的侧壁在角上
 *   夹出一个 90° 内角，而 `moveAndSlide` 是逐轴解算：斜着走进去以后
 *   两个轴各被一部楼梯的**侧面**挡住，角色彻底停住（B1 无寻路 = 无恢复手段）。
 *   实测雪原哨站 34% / 熔岩裂谷 50% 的采样落点因此永远走不到中央 ——
 *   比「楼梯太窄」更隐蔽，因为正对四个方向走都是好的，只有斜着走会死。
 *   包成整圈以后，**任意方向**接近台体都是踩着台阶上去。
 *
 * 每级用 4 个盒子拼「回」字（相框式分解，互相只共面不重叠）：
 *   南/北两条横跨整个外沿，东/西两条只补中间那段。
 */
const stairRing = (
  base: string,
  size: number,
  o: { steps: number; tread: number },
): { axial: MapVolume[]; south: MapVolume[] } => {
  const tops = stairTops(o.steps);
  const axial: MapVolume[] = [];
  const south: MapVolume[] = [];
  for (let i = 0; i < o.steps - 1; i++) {
    // i=0 是紧贴台沿的最高一级，i=steps-2 是最外的第一级
    const h = tops[o.steps - 2 - i]!;
    const inner = size / 2 + i * o.tread;
    const outer = inner + o.tread;
    const mid = (inner + outer) / 2;
    // 南条：横跨整个外沿（自带角落），镜像出北条
    south.push(box(`${base}_z_${i}_s`, 'ramp',
      { x: 0, y: 0, z: mid }, { w: outer * 2, h, d: o.tread }, { blocksSight: false }));
    // 东/西条：只补中间那段，自身 z 对称
    for (const [wing, sx] of [['e', 1], ['w', -1]] as const) {
      axial.push(box(`${base}_${wing}_${i}`, 'ramp',
        { x: sx * mid, y: 0, z: 0 }, { w: o.tread, h, d: inner * 2 }, { blocksSight: false }));
    }
  }
  return { axial, south };
};

const dec = (
  model: string, x: number, z: number, yaw: number, y = 0, scale?: number,
): MapDecorDef => ({ model, position: { x, y, z }, yaw, ...(scale === undefined ? {} : { scale }) });

/** 两翼对称摆件：同一件在 ±x 各来一个（z 镜像另算） */
const wings = <T>(f: (wing: 'e' | 'w', sx: 1 | -1) => readonly T[]): T[] =>
  ([['e', 1], ['w', -1]] as const).flatMap(([wing, sx]) => [...f(wing, sx)]);

// ════════════════════════════════════════════════════════════════
//  规格
// ════════════════════════════════════════════════════════════════

interface ThemedContext {
  /** 中央到出生点的距离（米）*/
  half: number;
  /** 中央到外墙的距离（米）*/
  arenaHalf: number;
  /** 准备区/大门半宽（米）*/
  prepHalfW: number;
}

/** 一次登顶行为机检：从 (x, z) 起、朝 `yaw` 直走，必须踏上 `top` 的顶面 */
export interface ThemedClimb {
  from: readonly [number, number];
  /** 起始高度（默认 0 = 地面）。桥面之类要先站上台顶才走得到的目标用它 */
  startY?: number;
  yaw: number;
  top: string;
}

interface ThemedSpec {
  id: string;
  name: string;
  /** 一句话风格（docs/06 §10.6 的表格直接引这句）*/
  style: string;
  /** 地势特征 */
  terrain: string;
  /**
   * ★ **适配的人数档区间**（连续，按 11.2 的秒数推尺寸）。
   *   一张图服务多档 = 尺寸取区间中值，`spawnToCenterSeconds` 与区间里
   *   **每一档**的试炼环秒数之差都不超过 `THEMED_TOLERANCE_SECONDS`。
   */
  modes: readonly GameMode[];
  /** 出生点→中央的移动秒数（11.2 换算基准 7 米/秒）*/
  spawnToCenterSeconds: number;
  /** 每队出生点数量 = 区间里**最大**的一档人数（小档只用前 N 个）*/
  maxTeamSize: number;
  /** W15 环境预设（客户端 ENV_PRESETS 的键）*/
  envPreset: string;
  /** P5 地面材质（客户端 GROUND_TEXTURES 的键）—— 雪原就该是雪地 */
  groundTexture: string;
  /**
   * 中央地形件的外接半径（米）。出生走廊只在 `|z| ≥ 这个值` 上要求空 ——
   * 中央件本身允许压在中线上，因为它朝出生方向有可跨楼梯（见文件头第三条）。
   * 没有中央件的图填 0。
   */
  centerRadius: number;
  /**
   * 登顶**行为**机检的输入：从 `from`（x, z，地面）朝 `yaw` 一路直走，
   * 必须踏上 `top` 这件的顶面。
   *
   * ★★ 这里刻意**不是**「逐件 id 的阶梯，比相邻高度差」。那种数据比对
   *   带着 `+1e-9` 容差全绿地放过了「级高恰好 = STEP_HEIGHT 时浮点误差
   *   让 tryStepUp 直接放弃」——三张图的台顶其实只有会跳的人上得去。
   *   现在跑的是真解算器（`createMovementState` + `stepMovement`），
   *   断言最终 y 到达台顶：**数据比对永远抓不到这类误差**。
   * ★ 每处台顶至少给一条**正面**和一条**斜向**：斜向那条是四面窄梯之间
   *   角落凹槽的照妖镜（见 `stairRing`）。
   */
  climbs: (ctx: ThemedContext) => readonly ThemedClimb[];
  /** 桥面件 id。机检：桥下净空 ≥ 角色高度。没有桥就空 */
  bridges: readonly string[];
  geometry: (ctx: ThemedContext) => MapVolume[];
  decor: (ctx: ThemedContext) => MapDecorDef[];
}

/**
 * 适配档位的秒数容差。与 `maps.test.ts` 对试炼环那条「±1.5 秒实现余量」
 * 同一个数 —— 一张图能覆盖几档，取决于它离那几档的**标准节奏**有多远。
 */
export const THEMED_TOLERANCE_SECONDS = 1.5;

// ── ① 雪原哨站 ─────────────────────────────────────────────────

const FROST = { size: 16, steps: 3, tread: 1.6 } as const;
/** 高地台顶 1.35m —— **正好是胸口线**（CHEST_HEIGHT），6.4 意义上不挡视线 */
const FROST_H = platHeight(FROST.steps);

/**
 * 开阔中场 + 两翼冰棱墙群 + 中央缓坡高地。
 *
 * 打法意图：中场故意留空（雪原就该空），博弈发生在**两翼**的冰棱之间 ——
 * 五道错落的短墙把视线切碎，但每道都只有 5–7 米长，绕两端即破，
 * 所以是「视线破碎」不是「迷宫」。中央高地只有 1.35 米（= 胸口线，
 * 不挡视线），给的是**站位优势**而不是掩体：站上去看得更远，也更显眼。
 */
const frostGeometry = ({ half }: ThemedContext): MapVolume[] => {
  const st = stairRing('keep_stair', FROST.size, { steps: FROST.steps, tread: FROST.tread });

  const axial: MapVolume[] = [
    box('keep_plat', 'floor', { x: 0, y: 0, z: 0 },
      { w: FROST.size, h: FROST_H, d: FROST.size }, { blocksSight: false }),
    ...st.axial,
  ];

  /**
   * 冰棱墙群：沿 z 与沿 x 交替，让每一步走位都换一次可见集合。
   * ★ 每翼只三道 —— 这是 1v1/2v2 的场子，掩体密度按 11.2 的「2–3 个」来，
   *   再多就从「视线破碎」变成「迷宫」了。
   */
  const shards = wings((wing, sx) => [
    box(`shard_a_${wing}_s`, 'wall', { x: sx * half * 0.34, y: 0, z: 9 }, { w: 1.2, h: 2.6, d: 6 }),
    box(`shard_b_${wing}_s`, 'wall', { x: sx * half * 0.52, y: 0, z: 17 }, { w: 6, h: 2.6, d: 1.2 }),
    box(`shard_c_${wing}_s`, 'wall', { x: sx * half * 0.70, y: 0, z: 8 }, { w: 1.2, h: 2.6, d: 7 }),
  ]);

  return [...axial, ...bothSides([...st.south, ...shards])];
};

const frostDecor = ({ half, arenaHalf }: ThemedContext): MapDecorDef[] => bothSidesDecor([
  // 台顶两角的冰晶。★ 原件是 4.4×6.0 m 的巨型晶簇 —— 摆在台面上会被读成掩体，
  //   缩到 ~1 m（低于胸口线）才是「装饰」。见 `MapDecorDef` 的 §8.2 红线。
  dec('props/crystal_amethyst_cluster', 6.8, 6.8, 0.4, FROST_H, 0.22),
  dec('props/crystal_amethyst_cluster', -6.8, 6.8, 2.7, FROST_H, 0.22),
  ...wings((_wing, sx) => [
    // 哨站营地：帐篷 + 火塘 + 路牌，一眼看出「这里有人驻扎」
    dec('biome/camp_tent', sx * half * 0.53, 36, sx * 0.8),
    dec('biome/camp_fire_pit', sx * half * 0.44, 33, 0),
    dec('biome/camp_bedroll', sx * half * 0.48, 38.5, sx * 1.2),
    dec('biome/camp_signpost', sx * half * 0.33, 30, sx * -0.5),
    // 冰棱根部的碎冰：大件，但**贴着冰棱墙**（1 m 内有真碰撞体）才立得住
    dec('props/crystal_amethyst_cluster', sx * half * 0.34, 13, sx * 1.1, 0, 0.8),
    dec('props/crystal_amethyst_cluster', sx * half * 0.70, 12.5, sx * 2.2, 0, 0.9),
    // 空地上的岩块：缩到膝盖高，不再是「看着能躲的 3 米巨石」
    dec('foliage/rock_1', sx * half * 0.72, 25, sx * 0.9, 0, 0.55),
    dec('foliage/rock_2', sx * half * 0.88, 15, sx * 2.4, 0, 0.6),
    // 贴外墙的针叶林。★ 必须真的**贴上墙面**（内表面在 arenaHalf−0.5）：
    //   此前留了 2.5–3.5 m，树干整根站在可行走区里 —— 玩家会绕到树后挨枪。
    dec('foliage/pine_1', sx * (arenaHalf - 0.5), 8, sx * 0.3),
    dec('foliage/pine_3', sx * (arenaHalf - 0.5), 22, sx * 1.6),
    dec('foliage/pine_5', sx * (arenaHalf - 0.5), 40, sx * 2.9),
    dec('foliage/pine_2', sx * half * 0.62, arenaHalf - 0.5, sx * 0.7),
  ]),
]);

// ── ② 熔岩裂谷 ─────────────────────────────────────────────────

const RIFT = { size: 26, steps: 5, tread: 1.6 } as const;
/** 中央台高 2.25m（5 级升程）—— 高于胸口线，整块挡视线 */
const RIFT_H = platHeight(RIFT.steps);

/**
 * 中央大高台 + 环形阶梯 + 环谷视线墙。**高低差主导**的一张图。
 *
 * 打法意图：中央那块 26×26 的台子是全图唯一的制高点，也是全图最大的
 * 视线阻挡 —— 谁占着台子谁就切断了对面两翼的相互支援。四向楼梯意味着
 * 它**永远能被四个方向包抄**（11.3「不能形成永久安全点」的结构保证），
 * 而且每级只有 0.45 米，没有位移技能照样上得去。
 * 环谷的六道 3 米高墙把台下切成一圈壕沟，给读条与治疗留躲身位。
 */
const riftGeometry = ({ half }: ThemedContext): MapVolume[] => {
  const st = stairRing('rift_stair', RIFT.size, { steps: RIFT.steps, tread: RIFT.tread });

  const axial: MapVolume[] = [
    box('rift_plat', 'wall', { x: 0, y: 0, z: 0 },
      { w: RIFT.size, h: RIFT_H, d: RIFT.size }),
    ...st.axial,
    // 东西两道谷墙跨中线（自身 z 对称）
    ...wings((wing, sx) => [
      box(`gorge_${wing}`, 'wall', { x: sx * half * 0.61, y: 0, z: 0 }, { w: 1.2, h: 3, d: 16 }),
    ]),
  ];

  const gorge = wings((wing, sx) => [
    box(`gorge_far_${wing}_s`, 'wall',
      { x: sx * half * 0.32, y: 0, z: half * 0.61 }, { w: 18, h: 3, d: 1.2 }),
    box(`gorge_mid_${wing}_s`, 'wall',
      { x: sx * half * 0.47, y: 0, z: half * 0.39 }, { w: 1.2, h: 3, d: 13 }),
    box(`gorge_near_${wing}_s`, 'wall',
      { x: sx * half * 0.39, y: 0, z: half * 0.17 }, { w: 11, h: 3, d: 1.2 }),
    box(`gorge_out_${wing}_s`, 'wall',
      { x: sx * half * 0.70, y: 0, z: half * 0.30 }, { w: 1.2, h: 2.6, d: 10 }),
  ]);

  return [...axial, ...bothSides([...st.south, ...gorge])];
};

const riftDecor = ({ half, arenaHalf }: ThemedContext): MapDecorDef[] => bothSidesDecor([
  // 台顶四角火盆（y = 台顶高度，坐在台面上）。
  // ★ 原件 1.6 m **高过胸口线**，站在中央高台上会被读成掩体（实际不挡移动也
  //   不挡视线）—— 缩到 1.28 m 就只是个火盆。
  dec('props/infernal_brazier', 11, 11, 0.6, RIFT_H, 0.8),
  dec('props/infernal_brazier', -11, 11, 2.5, RIFT_H, 0.8),
  ...wings((_wing, sx) => [
    // 熔岩只在**打不到的角落**流：脚下那圈是石台，不会出现「看着烫脚却没事」
    dec('props/lava_pool', sx * arenaHalf * 0.82, arenaHalf * 0.78, sx * 0.4),
    dec('props/lava_river_a', sx * arenaHalf * 0.90, arenaHalf * 0.55, sx * 1.5),
    dec('props/lava_river_b', sx * arenaHalf * 0.90, arenaHalf * 0.33, sx * 1.5),
    dec('props/lava_terrace', sx * arenaHalf * 0.86, arenaHalf * 0.66, sx * 2.1),
    // 谷墙脚下的黑曜石与骨堆（黑曜石 1.5 m > 胸口，缩到 1.28 m）
    dec('props/obsidian_fang', sx * half * 0.61, 9, sx * 0.9, 0, 0.85),
    dec('props/obsidian_fang', sx * half * 0.47, half * 0.39 + 8, sx * 2.3, 0, 0.85),
    dec('props/bone_pile', sx * half * 0.39, half * 0.17 + 3, sx * 1.2),
    dec('props/slag_cauldron', sx * half * 0.70, half * 0.30 + 7, sx * -0.6),
    // 枯树收边。★ 这两株是 6.2×9.5 / 6.4×13.3 m 的巨木，此前站在离最近碰撞体
    //   13–15 m 的空地正中 —— 现在贴上外墙，墙就是它们的碰撞体。
    dec('foliage/dead_1', sx * (arenaHalf - 0.5), half * 0.52, sx * 0.5),
    dec('foliage/dead_3', sx * half * 0.55, arenaHalf - 0.5, sx * 2.6),
    // 巨石缩到膝盖/腰以下，不再冒充掩体
    dec('biome/desert_boulder_1', sx * half * 0.90, half * 0.20, sx * 1.8, 0, 0.8),
    dec('biome/desert_boulder_2', sx * half * 0.24, half * 0.75, sx * 0.2, 0, 0.6),
  ]),
]);

// ── ③ 密林祭坛 ─────────────────────────────────────────────────

const ALTAR = { size: 12, steps: 2, tread: 1.6 } as const;
/** 祭坛矮台 0.9m —— 低于胸口线，不挡视线，纯粹是个「台」 */
const ALTAR_H = platHeight(ALTAR.steps);

/** 树阵坐标（half 的比例）。x 全部 ≥ 0.24×half，出生走廊天然让开 */
const GROVE_TREES: readonly (readonly [number, number])[] = [
  [0.24, 0.17], [0.38, 0.35], [0.52, 0.14], [0.42, 0.57],
  [0.67, 0.32], [0.30, 0.46], [0.60, 0.52],
];

/**
 * 祭祀大件的坐标（half 的比例）—— **碰撞体与装饰共用同一组数**，不许各写一份。
 *
 * 这三件的模型实测尺寸是 4.0×3.0 m（鹿角神龛）、2.3×2.3 m（面具图腾）、
 * 7.1×7.1 m（先祖废墟）—— 都比同一张图里**有**碰撞的树柱（2.6 m）还大，
 * 却曾经一条 `MapVolume` 都没登记。`MapDecorDef` 的注释原话是
 * 「体量大到『看起来能挡住人』的东西必须同时登记一条 MapVolume」，
 * 这是 §8.2「所见即所中」的红线，不是建议。
 *
 * ★★ **鹿角神龛刻意摆在林深处，不在祭坛边上。**
 *
 *   它此前在 (13.5, 4.5)（离中央 14 米），是直走的 bot 抵达祭坛前撞上的
 *   **最后一件硬阻挡**。而 `moveAndSlide` 是逐轴解算：贴到盒子的**竖棱**上时
 *   两个轴各被同一个角挡住，角色被永久吸住（B1 不做寻路 = 没有恢复手段）。
 *   全图 14 个直线陷阱里 **7 个**出在这四个盒子上；挪进林子后 14 → 8。
 *
 * ★ 规律值得记住：**越靠近中央的硬阻挡越致命**。所有指向中央的直线在那里最密
 *   —— 半径 14 米处相邻采样线只差 0.4 米，比角色直径还小，等于每一根竖棱
 *   都必然被某条线正好蹭到；到了半径 50 米，线间距 1.5 米，多数竖棱蹭不到。
 *   所以「中央前的最后一段只留可跨几何」（这里是祭坛的阶梯环）不是洁癖，
 *   是直线可达率的主要杠杆：6.70% → 3.85%，回到试炼环的量级。
 */
const GROVE_SHRINES = {
  /** 鹿角神龛：林深处（见上方 ★★）*/
  shrine: [0.50, 0.70],
  /** 图腾 / 先祖废墟：half 的比例 */
  totem: [0.20, 0.29],
  ruin: [0.56, 0.41],
} as const;

/**
 * 柱状树阵 + 中央祭坛矮台 + 四角火盆。
 *
 * 打法意图：**28 棵粗树按不规则网格排布**（不是试炼环那种一圈），
 * 于是「绕柱」在这里变成「穿林」—— 走三步换一组可见目标，
 * 近战有连续的接近路径，远程必须不停换位才能维持输出线。
 *
 * ★★ 树是 `pillar` 语义的**真碰撞体**：docs/06 §8.2「所见即所中」的
 *   红线就在这 —— 玩家会本能地躲到树后，那么树就必须真的挡住技能。
 *   林间的低矮倒木反过来是 `blocksSight:false` 的半高掩体（挡脚不挡眼）。
 */
const groveGeometry = ({ half }: ThemedContext): MapVolume[] => {
  const st = stairRing('altar_step', ALTAR.size, { steps: ALTAR.steps, tread: ALTAR.tread });

  const axial: MapVolume[] = [
    box('altar_plat', 'floor', { x: 0, y: 0, z: 0 },
      { w: ALTAR.size, h: ALTAR_H, d: ALTAR.size }, { blocksSight: false }),
    ...st.axial,
  ];

  const trees = wings((wing, sx) =>
    GROVE_TREES.map(([fx, fz], i) => box(
      `tree_${i}_${wing}_s`, 'pillar',
      { x: sx * half * fx, y: 0, z: half * fz },
      { w: 2.6, h: 6, d: 2.6 },
    )));

  // 倒木：**可跨路缘**（高度 = RISE，`tryStepUp` 恰好过得去），不挡视线
  const logs = wings((wing, sx) => [
    box(`log_a_${wing}_s`, 'rail', { x: sx * half * 0.32, y: 0, z: half * 0.66 },
      { w: 8, h: LOW_COVER_H, d: 1.2 }, { blocksSight: false }),
    box(`log_b_${wing}_s`, 'rail', { x: sx * half * 0.71, y: 0, z: half * 0.20 },
      { w: 1.2, h: LOW_COVER_H, d: 8 }, { blocksSight: false }),
  ]);

  // 祭祀大件的碰撞体（见 `GROVE_SHRINES`）。神龛/废墟是石堆走 `wall`，
  // 图腾是一根 7 米高的独柱走 `pillar`
  const shrines = wings((wing, sx) => [
    // ★ 足迹就是模型实测的 4.0 × 3.0 —— 「所见即所中」是逐米对齐，
    //   不是「附近有个盒子就算数」
    box(`shrine_${wing}_s`, 'wall',
      { x: sx * half * GROVE_SHRINES.shrine[0], y: 0, z: half * GROVE_SHRINES.shrine[1] },
      { w: 4, h: 3, d: 3 }),
    box(`totem_${wing}_s`, 'pillar',
      { x: sx * half * GROVE_SHRINES.totem[0], y: 0, z: half * GROVE_SHRINES.totem[1] },
      { w: 2, h: 6, d: 2 }),
    box(`ruin_${wing}_s`, 'wall',
      { x: sx * half * GROVE_SHRINES.ruin[0], y: 0, z: half * GROVE_SHRINES.ruin[1] },
      { w: 6, h: 4, d: 6 }),
  ]);

  return [...axial, ...bothSides([...st.south, ...trees, ...logs, ...shrines])];
};

const groveDecor = ({ half, arenaHalf }: ThemedContext): MapDecorDef[] => bothSidesDecor([
  // 祭坛四角火盆（用户点名的「四角火盆」）—— 摆在阶梯环外沿，缩到胸口线以下
  dec('props/infernal_brazier', 8.4, 8.4, 0.5, 0, 0.8),
  dec('props/infernal_brazier', -8.4, 8.4, 2.6, 0, 0.8),
  ...wings((_wing, sx) => [
    // 林间祭祀陈设。★ 三件都在 `groveGeometry` 里配了同坐标的碰撞体
    dec('props/stag_shrine',
      sx * half * GROVE_SHRINES.shrine[0], half * GROVE_SHRINES.shrine[1], sx * 1.4),
    dec('props/wildheart_mask_totem',
      sx * half * GROVE_SHRINES.totem[0], half * GROVE_SHRINES.totem[1], sx * 0.7),
    dec('props/wildheart_ancestor_ruin',
      sx * half * GROVE_SHRINES.ruin[0], half * GROVE_SHRINES.ruin[1], sx * 2.2),
    dec('props/mushroom_glow_cluster', sx * half * 0.34, half * 0.22, sx * 1.9),
    // 树根处的地被
    ...GROVE_TREES.slice(0, 4).map(([fx, fz], i) => dec(
      i % 2 === 0 ? 'foliage/fern' : 'props/wildheart_giant_fern',
      sx * half * fx + sx * 2.4, half * fz + 1.8, sx * (0.4 + i * 0.6),
    )),
    dec('foliage/bush_flowers', sx * half * 0.45, half * 0.62, sx * 0.9, 0, 0.8),
    dec('foliage/mushroom', sx * half * 0.63, half * 0.24, sx * 2.1),
    // 贴外墙的橡树带（同 frost 的针叶林：真的贴上墙面，不留可行走的缝）
    dec('foliage/oak_1', sx * (arenaHalf - 0.5), 12, sx * 0.3),
    dec('foliage/oak_4', sx * (arenaHalf - 0.5), 30, sx * 1.7),
    dec('foliage/oak_2', sx * half * 0.50, arenaHalf - 0.5, sx * 2.8),
  ]),
]);

// ── ④ 废墟角斗场 ───────────────────────────────────────────────

const RUIN = { plat: 8, steps: 5, tread: 1.2, width: 8, deck: 0.35, platZ: 14 } as const;
/** 断塔台顶 2.25m —— 同时是桥下净空（> 角色 2.0m，桥下是通道不是房梁）*/
const RUIN_H = platHeight(RUIN.steps);

/**
 * 断墙 + 半塌楼梯 + 两座短桥，废料箱桶铺满。
 *
 * 打法意图：**中央是空的**——「角斗场」的沙坑本来就该空，也让最大的
 * 12v12 有一块真正能站下二十四个人的开阔地。地形全在两翼：每翼两座
 * 断塔由一座短桥相连，桥下是穿行通道，塔外侧各有一部半塌楼梯。
 * 于是两翼变成「上桥抢高度 / 走桥下抄后路」的二选一，而中央始终是硬碰硬。
 *
 * ★ 楼梯朝**外侧**（远离中线）下行：登塔要先离开中央，付出的是时间。
 */
const ruinGeometry = ({ half }: ThemedContext): MapVolume[] => {
  const px = half * 0.34;

  const axial: MapVolume[] = wings((wing, sx) => [
    // 短桥：连接同翼两塔的顶面（各搭 0.5m），跨中线所以自身 z 对称
    box(`bridge_${wing}`, 'roof', { x: sx * px, y: RUIN_H, z: 0 },
      { w: 4, h: RUIN.deck, d: (RUIN.platZ - RUIN.plat / 2) * 2 + 1 }),
  ]);

  const towers = wings((wing, sx) => [
    box(`tower_${wing}_s`, 'wall', { x: sx * px, y: 0, z: RUIN.platZ },
      { w: RUIN.plat, h: RUIN_H, d: RUIN.plat }),
    ...stairs((i) => `tower_stair_${wing}_${i}_s`, {
      steps: RUIN.steps, tread: RUIN.tread, width: RUIN.width,
      axis: 'x', dir: sx, edge: sx * (px + RUIN.plat / 2), along: RUIN.platZ,
    }),
  ]);

  const rubble = wings((wing, sx) => [
    box(`rubble_a_${wing}_s`, 'wall',
      { x: sx * half * 0.23, y: 0, z: half * 0.27 }, { w: 1.2, h: 2.8, d: 10 }),
    box(`rubble_b_${wing}_s`, 'wall',
      { x: sx * half * 0.56, y: 0, z: half * 0.14 }, { w: 12, h: 2.8, d: 1.2 }),
    box(`rubble_c_${wing}_s`, 'wall',
      { x: sx * half * 0.41, y: 0, z: half * 0.48 }, { w: 1.2, h: 2.2, d: 9 }),
    // 矮瓦砾带：同 grove 的倒木，是**可跨路缘**不是掩体（见 `LOW_COVER_H`）
    box(`rubble_low_a_${wing}_s`, 'rail',
      { x: sx * half * 0.28, y: 0, z: half * 0.55 }, { w: 9, h: LOW_COVER_H, d: 1.2 },
      { blocksSight: false }),
    box(`rubble_low_b_${wing}_s`, 'rail',
      { x: sx * half * 0.64, y: 0, z: half * 0.34 }, { w: 1.2, h: LOW_COVER_H, d: 9 },
      { blocksSight: false }),
  ]);

  return [...axial, ...bothSides([...towers, ...rubble])];
};

const ruinDecor = ({ half, arenaHalf }: ThemedContext): MapDecorDef[] => bothSidesDecor([
  ...wings((_wing, sx) => [
    // 塔基与桥头的火把（night preset 下这是唯一的暖色光源）
    dec('biome/kcas_torch', sx * half * 0.34 + sx * 5.2, 9, sx * 0.4),
    dec('biome/kcas_torch', sx * half * 0.34 - sx * 5.2, 19, sx * 2.7),
    // 废料箱桶：角斗场的后勤堆场，密而不挡路。
    // ★ 桶/酒桶/料堆的原件是 2.0–2.1 m 高（高过胸口线），空地上一站就是假掩体 ——
    //   一律缩到 1.3 m 以下，读数与「走得过去」重新一致。
    dec('resources/containers_crate_large', sx * half * 0.30, 32, sx * 0.3),
    dec('resources/containers_crate_medium_wood', sx * half * 0.34, 34.5, sx * 1.1),
    dec('resources/containers_pile_medium', sx * half * 0.26, 35.5, sx * 2.0, 0, 0.85),
    dec('biome/kcas_barrel', sx * half * 0.44, 21, sx * 0.8, 0, 0.6),
    dec('biome/kcas_keg', sx * half * 0.47, 23.5, sx * 2.2, 0, 0.6),
    dec('props/barrel', sx * half * 0.20, half * 0.27 + 7, sx * 1.5),
    dec('props/crate_wooden', sx * half * 0.24, half * 0.27 + 9, sx * 0.6),
    dec('biome/city_crate', sx * half * 0.60, half * 0.14 + 4, sx * 2.4),
    // 断柱与瓦砾。大块瓦砾（8.1 m / 4.0 m）**贴着断墙堆**，墙就是它们的碰撞体
    dec('props/column_broken', sx * half * 0.23, half * 0.27 - 8, sx * 0.9),
    dec('biome/kcas_column', sx * half * 0.56, half * 0.14 - 5, sx * 1.3, 0, 0.9),
    dec('biome/kcas_rubble_large', sx * half * 0.41, half * 0.48 + 6.5, sx * 2.5),
    dec('biome/kcas_rubble_half', sx * half * 0.41 + sx * 2, half * 0.48, sx * 0.2),
    dec('biome/kcas_rocks', sx * half * 0.72, half * 0.20, sx * 1.7, 0, 0.65),
    // 贴外墙的断墙残骸（此前离墙面 3 m，人能从缝里走过去并穿过断墙）
    dec('biome/kcas_wall_broken', sx * (arenaHalf - 0.5), 18, sx * 0.1),
    dec('biome/kcas_wall_cracked', sx * (arenaHalf - 0.5), 44, sx * 0.1),
    dec('foliage/dead_2', sx * half * 0.50, arenaHalf - 0.5, sx * 2.9),
  ]),
]);

// ════════════════════════════════════════════════════════════════
//  规格表
// ════════════════════════════════════════════════════════════════

/**
 * ★★ **适配档位是被 11.2 逼出来的，不是随手划的。**
 *
 *   一张图的尺寸固定，而试炼环梯子上每一档都有自己的「出生点→中央」标准秒数
 *   （1v1 是 5 秒、12v12 是 14 秒）。所以一张图能覆盖几档，等于**它的实测秒数
 *   到那几档标准秒数的距离都 ≤ 1.5 秒**（与 maps.test 对试炼环的实现余量同一个数）。
 *   梯子在小人数段间隔 1 秒、大人数段间隔 0.5 秒 —— 于是小图只能盖两档，
 *   大图能盖五档。四张图合起来把 1v1–12v12 盖满，8v8/9v9 两档有两张可选。
 *
 * ⚠️ 实测秒数 ≈ `spawnToCenterSeconds + 0.29`：出生点在准备区中心
 *   （z = arenaHalf − 4 = half + 2），比 `half` 远 2 米。这是试炼环沿用下来的
 *   外壳形状，本批不改它 —— 所以这里的秒数是**倒着填**的，填完由测试正着验。
 *   （`themed.test.ts` 逐档断言，秒数表按 **mode 查找**不按下标 —— m5 #24 之鉴。）
 */
const SPECS: readonly ThemedSpec[] = [
  {
    id: 'arena_frost_outpost',
    name: '雪原哨站',
    style: '雪原 / 破晓',
    terrain: '开阔中场 + 两翼冰棱墙群（每翼 3 道）+ 中央缓坡高地（1.35m，不挡视线）',
    modes: [GameMode.Arena1v1, GameMode.Arena2v2],
    spawnToCenterSeconds: 5.7,
    maxTeamSize: 2,
    envPreset: 'dawn',
    groundTexture: 'snow',
    centerRadius: 12,
    // 正面 + 斜向各一条：斜向那条盯的是阶梯环的外角（见 `stairRing`）
    climbs: () => [
      { from: [0, 20], yaw: 0, top: 'keep_plat' },
      { from: [14, 14], yaw: Math.PI / 4, top: 'keep_plat' },
    ],
    bridges: [],
    geometry: frostGeometry,
    decor: frostDecor,
  },
  {
    id: 'arena_grove_altar',
    name: '密林祭坛',
    style: '密林 / 白昼',
    terrain: '柱状树阵 28 棵（真碰撞体）+ 中央祭坛矮台（0.9m）+ 倒木可跨路缘（0.45m）',
    modes: [GameMode.Arena3v3, GameMode.Arena4v4, GameMode.Arena5v5],
    spawnToCenterSeconds: 8.71,
    maxTeamSize: 5,
    envPreset: 'day',
    groundTexture: 'grass',
    centerRadius: 9,
    climbs: () => [
      { from: [0, 16], yaw: 0, top: 'altar_plat' },
      { from: [12, 12], yaw: Math.PI / 4, top: 'altar_plat' },
    ],
    bridges: [],
    geometry: groveGeometry,
    decor: groveDecor,
  },
  {
    id: 'arena_lava_rift',
    name: '熔岩裂谷',
    style: '熔岩 / 黄昏',
    terrain: '中央大高台 26×26（2.25m，挡视线）+ 环形阶梯（任何方向直走都上得去）+ 环谷视线墙 ×10',
    modes: [
      GameMode.Arena6v6, GameMode.Arena7v7, GameMode.Arena8v8, GameMode.Arena9v9,
    ],
    spawnToCenterSeconds: 11.71,
    maxTeamSize: 9,
    envPreset: 'dusk',
    groundTexture: 'rock',
    centerRadius: 20.5,
    climbs: () => [
      { from: [0, 28], yaw: 0, top: 'rift_plat' },
      { from: [26, 26], yaw: Math.PI / 4, top: 'rift_plat' },
    ],
    bridges: [],
    geometry: riftGeometry,
    decor: riftDecor,
  },
  {
    id: 'arena_ruins_colosseum',
    name: '废墟角斗场',
    style: '废墟 / 夜战',
    terrain: '中央空场 + 两翼各两座断塔（2.25m）+ 短桥 ×2（桥下可穿行）+ 断墙群',
    modes: [
      GameMode.Arena8v8, GameMode.Arena9v9, GameMode.Arena10v10,
      GameMode.Arena11v11, GameMode.Arena12v12,
    ],
    spawnToCenterSeconds: 12.7,
    maxTeamSize: 12,
    envPreset: 'night',
    groundTexture: 'dirt',
    centerRadius: 0,
    // 断塔从外侧楼梯正面登顶；桥面从塔顶朝中线走过去（各搭 0.5 m）
    climbs: ({ half }) => [
      { from: [half * 0.34 + 12, RUIN.platZ], yaw: Math.PI / 2, top: 'tower_e_s' },
      { from: [half * 0.34, RUIN.platZ], startY: RUIN_H, yaw: 0, top: 'bridge_e' },
    ],
    bridges: ['bridge_e', 'bridge_w'],
    geometry: ruinGeometry,
    decor: ruinDecor,
  },
];

// ════════════════════════════════════════════════════════════════
//  装配
// ════════════════════════════════════════════════════════════════

/** 出生点沿 ±Z 对称摆放，队友沿 X 展开（与试炼环同一式，间距 2.5 米）*/
const makeSpawns = (team: TeamId, z: number, count: number, yaw: number): SpawnPoint[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `spawn_${team as number}_${i}`,
    team,
    position: { x: (i - (count - 1) / 2) * 2.5, y: 0, z },
    yaw,
  }));

/**
 * 由规格推出尺寸上下文。★ 只此一份 —— 机检要按同一条式子复算
 * `prepHalfW`（与 `arena.ts` 同式：12 人一排 27.5 米塞不进 ±10），
 * 从数据里反推会让「式子改了但测试没跟上」悄悄溜过去。
 */
export const themedContextOf = (spec: ThemedSpec): ThemedContext => {
  const half = spec.spawnToCenterSeconds * MOVE.BASE_SPEED;
  return {
    half,
    arenaHalf: half + 6,
    prepHalfW: Math.max(10, ((spec.maxTeamSize - 1) * 2.5) / 2 + 3),
  };
};

const buildThemed = (spec: ThemedSpec): MapDef => {
  const ctx = themedContextOf(spec);
  const { arenaHalf, prepHalfW } = ctx;
  const size = arenaHalf * 2;
  const wallH = 8;

  const geometry: MapVolume[] = [
    box('floor', 'floor', { x: 0, y: -1, z: 0 }, { w: size, h: 1, d: size }, { blocksSight: false }),
    // 四面外墙。11.3：地图边界和观众席不可进入
    box('wall_n', 'wall', { x: 0, y: 0, z: -arenaHalf }, { w: size, h: wallH, d: 1 }),
    box('wall_s', 'wall', { x: 0, y: 0, z: arenaHalf }, { w: size, h: wallH, d: 1 }),
    box('wall_w', 'wall', { x: -arenaHalf, y: 0, z: 0 }, { w: 1, h: wallH, d: size }),
    box('wall_e', 'wall', { x: arenaHalf, y: 0, z: 0 }, { w: 1, h: wallH, d: size }),
    ...spec.geometry(ctx),
  ];

  const prepDepth = 8;
  const prepRooms: PrepRoom[] = ([TEAM_RED, TEAM_BLUE] as TeamId[]).map((team, idx) => {
    const sign = idx === 0 ? 1 : -1;
    const z = sign * (arenaHalf - prepDepth / 2);
    return {
      id: `prep_${team as number}`,
      team,
      volume: {
        min: { x: -prepHalfW, y: 0, z: z - prepDepth / 2 },
        max: { x: prepHalfW, y: wallH, z: z + prepDepth / 2 },
      },
      // 红方在 +Z 面向 −Z（yaw 0），蓝方在 −Z 面向 +Z（yaw π）
      spawns: makeSpawns(team, z, spec.maxTeamSize, idx === 0 ? 0 : Math.PI),
      gateId: `gate_${team as number}`,
      reentry: 'blocked',
    };
  });

  const gates = prepRooms.map((room) => {
    const sign = room.team === TEAM_RED ? 1 : -1;
    const z = sign * (arenaHalf - prepDepth);
    return {
      id: room.gateId,
      volume: {
        min: { x: -prepHalfW, y: 0, z: z - 0.5 },
        max: { x: prepHalfW, y: wallH, z: z + 0.5 },
      },
      // 11.1：双方大门**同时**开启
      opensAt: 0,
      openDuration: 1.5,
    };
  });

  return {
    id: asMapId(spec.id),
    name: spec.name,
    family: 'arena',
    modes: spec.modes,
    bounds: {
      min: { x: -arenaHalf, y: -5, z: -arenaHalf },
      max: { x: arenaHalf, y: 40, z: arenaHalf },
    },
    geometry,
    decor: spec.decor(ctx),
    envPreset: spec.envPreset,
    groundTexture: spec.groundTexture,
    forbidden: prepRooms.map((r) => ({
      id: `forbid_${r.id}`,
      volume: r.volume,
      scope: 'all' as const,
      onEnter: 'pushBack' as const,
    })),
    prepRooms,
    gates,
    fairness: {
      // 全部地形件 z 镜像，出生点沿 ±Z 完全对称 —— 距离差恒为 0
      spawnToCenterDelta: 0,
      spawnToSupplyDelta: {},
      /**
       * 11.3：不设置只有位移职业才能到达的高台。每处台顶都有一部
       * 级高 = `STEP_HEIGHT` 的楼梯（`ladders` 逐级机检），谁都走得上去。
       */
      mobilityOnlyPlatforms: [],
      tolerance: 2.0,
    },
  };
};

/** P5：四张主题图。★ 在 `ALL_MAPS` 里排在 `ARENA_MAPS` 之后 —— 默认选图不变 */
export const THEMED_ARENA_MAPS: readonly MapDef[] = SPECS.map(buildThemed);

/** 规格数据，供测试断言与 docs/06 §10.6 的表格 */
export const THEMED_ARENA_SPECS = SPECS;

const byId = (id: string): MapDef =>
  THEMED_ARENA_MAPS.find((m) => (m.id as string) === id)!;

export const arenaFrostOutpost = byId('arena_frost_outpost');
export const arenaGroveAltar = byId('arena_grove_altar');
export const arenaLavaRift = byId('arena_lava_rift');
export const arenaRuinsColosseum = byId('arena_ruins_colosseum');
