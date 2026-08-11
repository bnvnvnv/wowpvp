/**
 * 三张竞技场地图。规格书 11.2 / 11.3，验收 #24。
 *
 * 11.2 的尺寸是用**移动时间**描述的，按 8.1 的基础速度 7 米/秒换算成米：
 *
 * | 模式 | 出生点→中央 | 横穿 | 主要掩体 | 换算后半径 | 换算后横向 |
 * |---|---|---|---|---|---|
 * | 2v2 | 5–7 秒  | 12–16 秒 | 2–3 个 | 35–49 m | 84–112 m |
 * | 3v3 | 7–9 秒  | 18–22 秒 | 3–4 个 | 49–63 m | 126–154 m |
 * | 5v5 | 9–12 秒 | 24–30 秒 | 4–6 个 | 63–84 m | 168–210 m |
 *
 * ⚠️ 「横穿」按字面换算会得到 100 米以上的场地，与「出生点到中央 5–7 秒」
 *   自相矛盾（中央到边缘只有 35–49 米，横穿最多 ~100 米但实际走位不是直线）。
 *   本实现取**出生点距离**为准 —— 它是战斗节奏的实际决定因素 ——
 *   并让场地宽度约等于两倍的出生点距离。已登记为 docs/10 的待确认问题。
 *
 * 11.3 公平约束（每张图都必须满足，`maps.test.ts` 逐条断言）：
 *   · 双方出生点到中央的距离一致
 *   · 柱子提供视线博弈，但不能形成永久安全点
 *   · 不设置只有位移职业才能到达的高台
 *   · 玩家不能重新进入准备区
 */

import { GEOMETRY, MOVE } from '../../constants/combat.js';
import { GameMode } from '../../types/enums.js';
import { asMapId, TEAM_BLUE, TEAM_RED, type TeamId } from '../../types/ids.js';
import {
  box, type MapDecorDef, type MapDef, type MapVolume, type PrepRoom, type SpawnPoint,
} from './schema.js';

/** 11.2 的「秒」换算成米 */
const secondsToMeters = (s: number): number => s * MOVE.BASE_SPEED;

interface ArenaSpec {
  id: string;
  name: string;
  mode: GameMode;
  /** 出生点到中央的移动秒数（11.2）*/
  spawnToCenterSeconds: number;
  teamSize: number;
  /** 主要掩体数量（11.2）*/
  pillarCount: number;
  /** W15：环境预设（纯表现，客户端 ENV_PRESETS 的键）。三张图三个时辰，一眼可辨 */
  envPreset: string;
  /**
   * X10 真机轮用户拍板（2026-08-09）：「竞技场要有复杂的地形 —— 视线遮挡、
   * 楼梯和小桥」。先在 3v3 一张图试点（`makePilotTerrain`），实测手感后再
   * 决定铺开 —— P5 的**地形**半边由此开工，贴图/天空盒那半仍待美术方向拍板。
   */
  terrain?: 'pilot';
}

/**
 * P12：1v1–12v12 全梯子（玩家反馈「开房间时可以任意拖动人数」）。
 *
 * ★ 2/3/5 三行是 M 系列的原值**一字不动** —— 那三张图有截图基线与文档引用，
 *   历史数字不回填。新尺寸插进梯子：出生秒数与柱数都**严格递增**
 *   （maps.test 的两条排序断言按整个梯子循环验，不再点名三张）。
 * ★ 柱数 ≈ 人数 + 1：11.2 的立意是「掩体密度跟上交战人数」；
 *   环半径随 spawnToCenterSeconds 缩放（buildArena 内 half*0.55），
 *   柱间通道宽度天然保持 —— 11.3 的「不能无限绕柱」不因加图而破。
 */
const SPECS: readonly ArenaSpec[] = [
  { id: 'arena_1v1', name: '试炼环·单挑', mode: GameMode.Arena1v1, spawnToCenterSeconds: 5, teamSize: 1, pillarCount: 2, envPreset: 'dusk' },
  { id: 'arena_2v2', name: '试炼环·小型', mode: GameMode.Arena2v2, spawnToCenterSeconds: 6, teamSize: 2, pillarCount: 3, envPreset: 'dusk' },
  { id: 'arena_3v3', name: '试炼环·标准', mode: GameMode.Arena3v3, spawnToCenterSeconds: 8, teamSize: 3, pillarCount: 4, envPreset: 'day', terrain: 'pilot' },
  { id: 'arena_4v4', name: '试炼环·进阶', mode: GameMode.Arena4v4, spawnToCenterSeconds: 9, teamSize: 4, pillarCount: 5, envPreset: 'day' },
  { id: 'arena_5v5', name: '试炼环·大型', mode: GameMode.Arena5v5, spawnToCenterSeconds: 10, teamSize: 5, pillarCount: 6, envPreset: 'overcast' },
  { id: 'arena_6v6', name: '试炼环·团战', mode: GameMode.Arena6v6, spawnToCenterSeconds: 11, teamSize: 6, pillarCount: 7, envPreset: 'dusk' },
  { id: 'arena_7v7', name: '试炼环·七雄', mode: GameMode.Arena7v7, spawnToCenterSeconds: 11.5, teamSize: 7, pillarCount: 8, envPreset: 'day' },
  { id: 'arena_8v8', name: '试炼环·八阵', mode: GameMode.Arena8v8, spawnToCenterSeconds: 12, teamSize: 8, pillarCount: 9, envPreset: 'overcast' },
  { id: 'arena_9v9', name: '试炼环·九霄', mode: GameMode.Arena9v9, spawnToCenterSeconds: 12.5, teamSize: 9, pillarCount: 10, envPreset: 'dusk' },
  { id: 'arena_10v10', name: '试炼环·十面', mode: GameMode.Arena10v10, spawnToCenterSeconds: 13, teamSize: 10, pillarCount: 11, envPreset: 'day' },
  { id: 'arena_11v11', name: '试炼环·十一联队', mode: GameMode.Arena11v11, spawnToCenterSeconds: 13.5, teamSize: 11, pillarCount: 12, envPreset: 'overcast' },
  { id: 'arena_12v12', name: '试炼环·全面战争', mode: GameMode.Arena12v12, spawnToCenterSeconds: 14, teamSize: 12, pillarCount: 13, envPreset: 'dusk' },
];

/** 出生点沿 ±Z 对称摆放，队友沿 X 展开 */
const makeSpawns = (team: TeamId, z: number, count: number, yaw: number): SpawnPoint[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `spawn_${team as number}_${i}`,
    team,
    // 以中线为中心左右排开，间距 2.5 米
    position: { x: (i - (count - 1) / 2) * 2.5, y: 0, z },
    yaw,
  }));

/**
 * 柱子布局：绕中心均匀分布在一个圆环上。
 *
 * 11.3「柱子和墙体提供视线博弈，但不能形成无限绕柱或永久安全点」——
 * 保证做法是**柱子之间留出足够宽的通道**（这里是柱心间距远大于柱子直径），
 * 且没有任何柱子紧贴外墙形成死角。绕柱可以拖时间，但对手能从两侧包抄。
 */
const makePillars = (count: number, ringRadius: number): MapVolume[] =>
  Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2 + Math.PI / count;
    return box(
      `pillar_${i}`,
      'pillar',
      { x: Math.cos(a) * ringRadius, y: 0, z: Math.sin(a) * ringRadius },
      { w: 2.4, h: 5, d: 2.4 },
    );
  });

/**
 * 纯装饰摆设（M12 表现层）。★ sim 不读它（docs/06 §8.2），全部小件不挡路：
 * 火盆守四角、酒桶贴柱根、雕像头靠中央矮墙两端、松树紧贴外墙
 * （外墙本来就挡人，树贴着墙种视觉与判定天然一致）。
 * 位置全部是 spec 的确定性函数 —— 同一张图在每个客户端一个样。
 */
const makeDecor = (spec: ArenaSpec, half: number, arenaHalf: number, prepHalfW: number): MapDecorDef[] => {
  const out: MapDecorDef[] = [];

  // 四角火盆
  const c = arenaHalf - 3;
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    out.push({
      model: 'props/infernal_brazier',
      position: { x: sx * c, y: 0, z: sz * c },
      yaw: sx * 0.6 + sz * 1.7,
    });
  }

  // 每根柱子：外侧一只酒桶、内侧一丛灌木（与 makePillars 同一套角度公式）
  const r = half * 0.55;
  for (let i = 0; i < spec.pillarCount; i++) {
    const a = (i / spec.pillarCount) * Math.PI * 2 + Math.PI / spec.pillarCount;
    const ox = Math.cos(a);
    const oz = Math.sin(a);
    out.push({
      model: 'props/barrel',
      position: { x: ox * (r + 2.1), y: 0, z: oz * (r + 2.1) },
      yaw: a * 1.3,
    });
    out.push({
      model: i % 2 === 0 ? 'foliage/bush' : 'foliage/bush_flowers',
      position: { x: ox * (r - 2.3), y: 0, z: oz * (r - 2.3) },
      yaw: a,
    });
  }

  // 中央矮墙两端各一颗半埋雕像头（趣味观赏点，紧贴矮墙不占走位）
  out.push({ model: 'props/statue_head', position: { x: half * 0.25 + 1.6, y: 0, z: 1.9 }, yaw: -0.7 });
  out.push({ model: 'props/statue_head', position: { x: -(half * 0.25 + 1.6), y: 0, z: -1.9 }, yaw: 2.4 });

  // 外圈松树：贴墙每 45° 一棵，让开 ±Z 出生走廊（准备区门宽 |x|<10）
  const ring = arenaHalf - 2.4;
  for (let i = 0; i < 8; i++) {
    const a = i * (Math.PI / 4) + Math.PI / 8;
    const x = Math.cos(a) * ring;
    const z = Math.sin(a) * ring;
    if (Math.abs(x) < prepHalfW + 2) continue;
    out.push({ model: `foliage/pine_${(i % 5) + 1}`, position: { x, y: 0, z }, yaw: a * 2 });
  }
  return out;
};

/**
 * 3v3 试点地形（X10 用户拍板：视线遮挡/楼梯/小桥）。
 *
 * 结构一句话：**东翼一对高台由小桥相连（桥下可穿行），西翼两段视线矮墙**。
 * 中路（出生走廊 |x| ≤ prepHalfW）刻意一件不放 —— bot 没有寻路（B1），
 * 主通道必须保持直走可达；侧翼才是地形博弈的地方。
 *
 * 11.3 的三条在结构上成立（maps.test 逐件断言）：
 *   · **高台不是永久安全点**：每台各有一部宽楼梯（级高 = STEP_HEIGHT，
 *     谁都走得上去，不是位移职业专属 → fairness.mobilityOnlyPlatforms 仍空），
 *     两台又被桥连通 —— 台上的人可被两个方向包抄，且整个暴露在远程射程里
 *   · **桥下净空 = 台高 2.25m > 角色 2.0m**：桥下是一条带顶盖的视线走廊
 *   · **全部件 z→-z 镜像**：±Z 两队公平（fairness.spawnToCenterDelta 恒 0 不变）
 */
const PILOT = {
  /** 级高顶着可跨上限（tryStepUp）—— 楼梯在移动物理上就是坡道 */
  RISE: GEOMETRY.STEP_HEIGHT,
  STEPS: 5,
  TREAD: 1.1,
  PLAT_SIZE: 7,
  /** 台心离中线的 z 距离。两台内沿间距 = 2×(PLAT_Z − PLAT_SIZE/2) = 8 米 */
  PLAT_Z: 7.5,
  BRIDGE_W: 4,
  DECK_H: 0.35,
} as const;
/**
 * 逐级累加出台阶顶面高度。
 *
 * ★★ **不能写成 `PLAT_H − (i+1)*RISE`。** `tryStepUp` 把角色抬到
 *   `from.y + STEP_HEIGHT` 后判碰撞，而 `cylinderOverlapsAabb` 的出口是
 *   `foot.y >= box.max.y`（**严格**）—— 差一个 ulp 就直接放弃，角色贴着
 *   台阶原地站住。倒着算恰好会差那一个 ulp：`0.9 + 0.45` 在 IEEE754 上是
 *   `1.3499999999999998668`，而 `2.25 − 2*0.45` 是 `1.3500000000000000888`，
 *   于是**第三级永远上不去**（实测直走停在 y=0.90，只有会跳的人到得了台顶）。
 *   逐级累加由构造保证 `tops[k] === tops[k-1] + RISE` 逐位相等。
 * ★ 这条缺陷曾被复制进 P5 的三张主题图（`themed.ts` 有同款注释与同款修法）。
 *   机检已从「比数据里的高度差」换成「跑真解算器走一遍」——
 *   数据比对永远抓不到这类误差，它带着 `+1e-9` 容差骗过了两批人。
 */
const PILOT_STAIR_TOPS: readonly number[] = Array.from({ length: PILOT.STEPS }).reduce<number[]>(
  (tops) => [...tops, (tops[tops.length - 1] ?? 0) + PILOT.RISE], [],
);
/** 台高 = 整部楼梯的总升程，同时是桥下净空（2.25 > HITBOX_HEIGHT 2.0） */
const PILOT_PLAT_H = PILOT_STAIR_TOPS[PILOT.STEPS - 1]!;

const makePilotTerrain = (half: number): MapVolume[] => {
  const px = half * 0.4; // 东翼台心（3v3 半径 56m 下 ≈ 22.4，柱环 30.8 之内）
  const out: MapVolume[] = [];

  for (const sign of [1, -1] as const) {
    const side = sign === 1 ? 's' : 'n';
    const pz = sign * PILOT.PLAT_Z;
    // 台体：顶面站得上（standable 默认真）、整块挡视线
    out.push(box(`plat_${side}`, 'wall',
      { x: px, y: 0, z: pz },
      { w: PILOT.PLAT_SIZE, h: PILOT_PLAT_H, d: PILOT.PLAT_SIZE }));
    // 东侧宽楼梯：台沿向外逐级下行（4 个中间级 + 台顶 = 5 段升程）
    for (let i = 0; i < PILOT.STEPS - 1; i++) {
      out.push(box(`plat_${side}_stair_${i}`, 'floor',
        {
          x: px + PILOT.PLAT_SIZE / 2 + i * PILOT.TREAD + PILOT.TREAD / 2,
          y: 0,
          z: pz,
        },
        // i=0 是紧贴台沿的最高一级，i=STEPS-2 是最外的第一级
        { w: PILOT.TREAD, h: PILOT_STAIR_TOPS[PILOT.STEPS - 2 - i]!, d: 4 },
        { blocksSight: false }));
    }
  }

  // 小桥：连接两台顶面（各搭 0.5 米），桥下可穿行
  out.push(box('plat_bridge', 'roof',
    { x: px, y: PILOT_PLAT_H, z: 0 },
    {
      w: PILOT.BRIDGE_W,
      h: PILOT.DECK_H,
      d: (PILOT.PLAT_Z - PILOT.PLAT_SIZE / 2) * 2 + 1,
    }));

  // 西翼：两段视线矮墙（2.8m 高于视线、7m 短于外墙 —— 绕两端即破，
  // 与柱子的区别是「挡一条线而不是一个点」，读条/治疗有了可靠的躲身位）
  for (const sign of [1, -1] as const) {
    out.push(box(`sight_wall_${sign === 1 ? 's' : 'n'}`, 'wall',
      { x: -half * 0.36, y: 0, z: sign * 11 },
      { w: 1, h: 2.8, d: 7 }));
  }
  return out;
};

const buildArena = (spec: ArenaSpec): MapDef => {
  const half = secondsToMeters(spec.spawnToCenterSeconds); // 中央到出生点
  const arenaHalf = half + 6; // 出生点后面再留一点空间
  const size = arenaHalf * 2;
  const wallH = 8;
  /**
   * P12：准备区/大门半宽随人数放大 —— 出生点一排 2.5 米间距，12 人排面
   * 27.5 米，塞不进原来 ±10 的准备区（出生在禁入体积外＝开局即被推挤）。
   * ≤5 人取原值 10：2v2/3v3/5v5 三张老图逐字节不变（历史基线不动）。
   */
  const prepHalfW = Math.max(10, ((spec.teamSize - 1) * 2.5) / 2 + 3);

  const geometry: MapVolume[] = [
    box('floor', 'floor', { x: 0, y: -1, z: 0 }, { w: size, h: 1, d: size }, { blocksSight: false }),

    // 四面外墙。11.3：地图边界和观众席不可进入
    box('wall_n', 'wall', { x: 0, y: 0, z: -arenaHalf }, { w: size, h: wallH, d: 1 }),
    box('wall_s', 'wall', { x: 0, y: 0, z: arenaHalf }, { w: size, h: wallH, d: 1 }),
    box('wall_w', 'wall', { x: -arenaHalf, y: 0, z: 0 }, { w: 1, h: wallH, d: size }),
    box('wall_e', 'wall', { x: arenaHalf, y: 0, z: 0 }, { w: 1, h: wallH, d: size }),

    // 主要掩体（11.2）
    ...makePillars(spec.pillarCount, half * 0.55),

    // 中央的一段矮墙：提供正面视线阻挡，但只有半高，
    // 6.4 意义上仍然挡视线（它高于胸口 1.35 米）
    box('center_wall', 'wall', { x: 0, y: 0, z: 0 }, { w: half * 0.5, h: 3, d: 1.2 }),

    // X10 试点地形（现只有 3v3）。★ 尺寸/柱数原值一字不动 —— 加的是侧翼件
    ...(spec.terrain === 'pilot' ? makePilotTerrain(half) : []),
  ];

  // 11.1 准备区。11.3：玩家不能重新进入准备区躲避
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
      // 红方在 +Z 面向 -Z（yaw 0），蓝方在 -Z 面向 +Z（yaw π）
      spawns: makeSpawns(team, z, spec.teamSize, idx === 0 ? 0 : Math.PI),
      gateId: `gate_${team as number}`,
      reentry: 'blocked',
    };
  });

  const gates = prepRooms.map((room) => {
    const sign = room.team === TEAM_RED ? 1 : -1;
    const z = sign * (arenaHalf - prepDepth);
    return {
      id: room.gateId,
      volume: { min: { x: -prepHalfW, y: 0, z: z - 0.5 }, max: { x: prepHalfW, y: wallH, z: z + 0.5 } },
      // 11.1：双方大门**同时**开启
      opensAt: 0,
      openDuration: 1.5,
    };
  });

  return {
    id: asMapId(spec.id),
    name: spec.name,
    family: 'arena',
    modes: [spec.mode],
    bounds: {
      min: { x: -arenaHalf, y: -5, z: -arenaHalf },
      max: { x: arenaHalf, y: 40, z: arenaHalf },
    },
    geometry,
    decor: makeDecor(spec, half, arenaHalf, prepHalfW),
    envPreset: spec.envPreset,
    // 11.3：开门后准备区对所有人禁入
    forbidden: prepRooms.map((r) => ({
      id: `forbid_${r.id}`,
      volume: r.volume,
      scope: 'all' as const,
      onEnter: 'pushBack' as const,
    })),
    prepRooms,
    gates,
    fairness: {
      // 出生点沿 ±Z 完全对称，距离差恒为 0
      spawnToCenterDelta: 0,
      spawnToSupplyDelta: {},
      // 11.3：不设置只有位移职业才能到达的高台。柱子 standable 默认 true，
      // 但柱高 5 米 > 跳跃 1.18 米，谁都上不去 —— 也就谈不上「只有位移职业能到」
      mobilityOnlyPlatforms: [],
      tolerance: 2.0,
    },
  };
};

/** P12：全梯子一次生成。命名导出保留三张老图（既有 import 不动） */
export const ARENA_MAPS = SPECS.map(buildArena);

export const arena2v2 = ARENA_MAPS.find((m) => (m.id as string) === 'arena_2v2')!;
export const arena3v3 = ARENA_MAPS.find((m) => (m.id as string) === 'arena_3v3')!;
export const arena5v5 = ARENA_MAPS.find((m) => (m.id as string) === 'arena_5v5')!;

/** 11.2 的规格数据，供测试断言与文档生成 */
export const ARENA_SPECS = SPECS;
