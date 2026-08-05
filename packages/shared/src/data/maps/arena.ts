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

import { MOVE } from '../../constants/combat.js';
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
}

const SPECS: readonly ArenaSpec[] = [
  { id: 'arena_2v2', name: '试炼环·小型', mode: GameMode.Arena2v2, spawnToCenterSeconds: 6, teamSize: 2, pillarCount: 3, envPreset: 'dusk' },
  { id: 'arena_3v3', name: '试炼环·标准', mode: GameMode.Arena3v3, spawnToCenterSeconds: 8, teamSize: 3, pillarCount: 4, envPreset: 'day' },
  { id: 'arena_5v5', name: '试炼环·大型', mode: GameMode.Arena5v5, spawnToCenterSeconds: 10, teamSize: 5, pillarCount: 6, envPreset: 'overcast' },
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
const makeDecor = (spec: ArenaSpec, half: number, arenaHalf: number): MapDecorDef[] => {
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
    if (Math.abs(x) < 12) continue;
    out.push({ model: `foliage/pine_${(i % 5) + 1}`, position: { x, y: 0, z }, yaw: a * 2 });
  }
  return out;
};

const buildArena = (spec: ArenaSpec): MapDef => {
  const half = secondsToMeters(spec.spawnToCenterSeconds); // 中央到出生点
  const arenaHalf = half + 6; // 出生点后面再留一点空间
  const size = arenaHalf * 2;
  const wallH = 8;

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
        min: { x: -10, y: 0, z: z - prepDepth / 2 },
        max: { x: 10, y: wallH, z: z + prepDepth / 2 },
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
      volume: { min: { x: -10, y: 0, z: z - 0.5 }, max: { x: 10, y: wallH, z: z + 0.5 } },
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
    decor: makeDecor(spec, half, arenaHalf),
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

export const arena2v2 = buildArena(SPECS[0]!);
export const arena3v3 = buildArena(SPECS[1]!);
export const arena5v5 = buildArena(SPECS[2]!);

export const ARENA_MAPS = [arena2v2, arena3v3, arena5v5] as const;

/** 11.2 的规格数据，供测试断言与文档生成 */
export const ARENA_SPECS = SPECS;
