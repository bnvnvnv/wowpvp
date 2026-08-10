/**
 * 房间与自由职业选择测试。对应规格书 3.1 / 3.2 / 11.5 与验收 #22。
 *
 * 主线：3.2 是一条**否定式**规则 —— 系统不得因为阵容而阻止开始。
 * 这类规则最容易被后来「顺手加的限制」破坏，所以这里逐条钉死。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ALL_CLASSES, getClass } from '../../data/index.js';
import { MAP_BY_ID, THEMED_ARENA_SPECS, arena3v3, mapsForMode } from '../../data/maps/index.js';
import { ArenaPreset, GameMode } from '../../types/enums.js';
import { asClassId, asMapId, TEAM_BLUE, TEAM_RED } from '../../types/ids.js';
import {
  Slot,
  canStart,
  compositionHints,
  createRoom,
  joinRoom,
  leaveMatch,
  markDisconnected,
  markReconnected,
  playersOn,
  resetForRematch,
  botSeatsNeeded,
  selectClass,
  selectSlot,
  setBossEnabled,
  setBotDifficulty,
  setFillWithBots,
  setMap,
  setMode,
  setPreset,
  setReady,
  startMatch,
  type Room,
} from './room.js';

let room: Room;

const config = (over: Partial<Room['config']> = {}) => ({
  mode: GameMode.Arena3v3,
  mapId: arena3v3.id,
  preset: ArenaPreset.Classic,
  roundsToWin: 1,
  allowUnbalanced: false,
  // ★ 默认关 —— 与 `RoomConfig.fillWithBots` 的默认一致（docs/14 §16b）
  fillWithBots: false,
  ...over,
});

/** 加一个已选职业并准备好的玩家 */
const addReady = (id: string, slot: Slot, classId: string) => {
  joinRoom(room, id, id);
  selectSlot(room, id, slot);
  selectClass(room, id, asClassId(classId));
  setReady(room, id, true);
};

beforeEach(() => {
  room = createRoom('r1', 'host', config());
});

describe('3.1 房间流程', () => {
  it('加入后默认在观战席', () => {
    const p = joinRoom(room, 'a', 'A');
    expect(p.slot).toBe(Slot.Spectator);
  });

  it('可以选择红方、蓝方或观战席', () => {
    joinRoom(room, 'a', 'A');
    expect(selectSlot(room, 'a', Slot.Red).ok).toBe(true);
    expect(playersOn(room, Slot.Red)).toHaveLength(1);
    expect(selectSlot(room, 'a', Slot.Blue).ok).toBe(true);
    expect(playersOn(room, Slot.Red)).toHaveLength(0);
  });

  it('队伍满员后不能再加入', () => {
    for (let i = 0; i < 3; i++) {
      joinRoom(room, `p${i}`, `P${i}`);
      expect(selectSlot(room, `p${i}`, Slot.Red).ok).toBe(true);
    }
    joinRoom(room, 'p3', 'P3');
    const r = selectSlot(room, 'p3', Slot.Red);
    expect(r.ok).toBe(false);
  });

  it('换阵营后需要重新准备', () => {
    addReady('a', Slot.Red, 'mage');
    expect(room.players[0]!.ready).toBe(true);
    selectSlot(room, 'a', Slot.Blue);
    expect(room.players[0]!.ready).toBe(false);
  });

  it('没选职业不能准备', () => {
    joinRoom(room, 'a', 'A');
    selectSlot(room, 'a', Slot.Red);
    expect(setReady(room, 'a', true).ok).toBe(false);
  });

  it('★ 3.1：比赛开始后职业锁定', () => {
    addReady('a', Slot.Red, 'mage');
    addReady('b', Slot.Blue, 'warrior');
    expect(startMatch(room).ok).toBe(true);

    expect(selectClass(room, 'a', asClassId('priest')).ok).toBe(false);
    expect(selectSlot(room, 'a', Slot.Blue).ok).toBe(false);
  });
});

describe('★ 3.2 / 验收 #22 自由职业选择', () => {
  it('★ 全队选择相同职业也能开始', () => {
    for (let i = 0; i < 3; i++) addReady(`r${i}`, Slot.Red, 'mage');
    for (let i = 0; i < 3; i++) addReady(`b${i}`, Slot.Blue, 'mage');

    const check = canStart(room);
    expect(check.ok).toBe(true);
    expect(check.reasons).toEqual([]);
  });

  it('★ 全队无治疗也能开始', () => {
    for (const [i, c] of ['warrior', 'rogue', 'hunter'].entries()) addReady(`r${i}`, Slot.Red, c);
    for (const [i, c] of ['warrior', 'rogue', 'hunter'].entries()) addReady(`b${i}`, Slot.Blue, c);
    expect(canStart(room).ok).toBe(true);
  });

  it('★ 全队近战也能开始', () => {
    for (const [i, c] of ['warrior', 'rogue', 'deathknight'].entries()) addReady(`r${i}`, Slot.Red, c);
    for (const [i, c] of ['warrior', 'rogue', 'deathknight'].entries()) addReady(`b${i}`, Slot.Blue, c);
    expect(canStart(room).ok).toBe(true);
  });

  it('★ 阵容提示只是提示，永不阻塞（3.2）', () => {
    for (let i = 0; i < 3; i++) addReady(`r${i}`, Slot.Red, 'warrior');
    for (let i = 0; i < 3; i++) addReady(`b${i}`, Slot.Blue, 'priest');

    const hints = compositionHints(room);
    expect(hints.length).toBeGreaterThan(0); // 确实给了提示
    expect(hints.every((h) => h.blocking === false)).toBe(true);
    expect(canStart(room).ok).toBe(true); // 但不影响开始
  });

  it('提示内容符合 3.2 的举例：缺少治疗 / 近战较多', () => {
    for (let i = 0; i < 3; i++) addReady(`r${i}`, Slot.Red, 'warrior');
    for (let i = 0; i < 3; i++) addReady(`b${i}`, Slot.Blue, 'priest');
    const texts = compositionHints(room).map((h) => h.text);
    expect(texts).toContain('缺少治疗');
    expect(texts.some((t) => t.includes('近战较多') || t.includes('全队同为'))).toBe(true);
  });

  it('八个职业都能被选中', () => {
    joinRoom(room, 'a', 'A');
    selectSlot(room, 'a', Slot.Red);
    for (const c of ALL_CLASSES) {
      expect(selectClass(room, 'a', c.id).ok, `${c.name} 应当可选`).toBe(true);
    }
  });

  it('未知职业会被拒绝', () => {
    joinRoom(room, 'a', 'A');
    selectSlot(room, 'a', Slot.Red);
    expect(selectClass(room, 'a', asClassId('nonexistent')).ok).toBe(false);
  });

  /**
   * ★★ 大 BOSS 的 ClassDef **在注册表里查得到**（sim 要用它建实体、查技能），
   *   所以「`getClass` 查得到就放行」会直接放过 `SelectClass{classId:'boss'}` ——
   *   客户端点不出来不算门，协议是不受信任输入。判据必须是 `isPlayableClass`。
   */
  it('★★ 特殊职业（大 BOSS）玩家选不到 —— 哪怕注册表里查得到', () => {
    joinRoom(room, 'a', 'A');
    selectSlot(room, 'a', Slot.Red);
    expect(getClass(asClassId('boss')), '注册表里必须查得到，否则 sim 建不出 BOSS')
      .toBeDefined();
    expect(selectClass(room, 'a', asClassId('boss')).ok).toBe(false);
    expect(room.players.find((p) => p.id === 'a')?.classId).toBeUndefined();
  });
});

describe('3.2 人数平衡', () => {
  it('标准规则要求双方人数相等', () => {
    addReady('r0', Slot.Red, 'mage');
    addReady('r1', Slot.Red, 'mage');
    addReady('b0', Slot.Blue, 'warrior');

    const check = canStart(room);
    expect(check.ok).toBe(false);
    expect(check.reasons.some((r) => r.includes('人数不等'))).toBe(true);
  });

  it('★ 自定义房间可开启人数不平衡，但必须标记为非标准规则', () => {
    room = createRoom('r2', 'host', config({ allowUnbalanced: true }));
    addReady('r0', Slot.Red, 'mage');
    addReady('r1', Slot.Red, 'mage');
    addReady('b0', Slot.Blue, 'warrior');

    const check = canStart(room);
    expect(check.ok).toBe(true);
    expect(check.nonStandard).toBe(true); // ★ 明确标记
  });

  it('人数相等时不标记为非标准', () => {
    addReady('r0', Slot.Red, 'mage');
    addReady('b0', Slot.Blue, 'warrior');
    expect(canStart(room).nonStandard).toBe(false);
  });
});

describe('开始条件', () => {
  it('有人没准备就不能开始', () => {
    addReady('a', Slot.Red, 'mage');
    joinRoom(room, 'b', 'B');
    selectSlot(room, 'b', Slot.Blue);
    selectClass(room, 'b', asClassId('warrior'));
    // b 没点准备
    expect(canStart(room).ok).toBe(false);
  });

  it('一方无人不能开始', () => {
    addReady('a', Slot.Red, 'mage');
    expect(canStart(room).ok).toBe(false);
  });

  it('观战席不参与开始条件', () => {
    addReady('a', Slot.Red, 'mage');
    addReady('b', Slot.Blue, 'warrior');
    joinRoom(room, 'spec', '观众'); // 停在观战席，没准备
    expect(canStart(room).ok).toBe(true);
  });
});

describe('11.5 断线与退出', () => {
  it('断线只标记状态，玩家仍留在房间（不获得无敌）', () => {
    addReady('a', Slot.Red, 'mage');
    addReady('b', Slot.Blue, 'warrior');
    startMatch(room);

    markDisconnected(room, 'a');
    expect(room.players.find((p) => p.id === 'a')!.connected).toBe(false);
    expect(playersOn(room, Slot.Red)).toHaveLength(1); // 角色还在场上
  });

  it('重连后恢复', () => {
    addReady('a', Slot.Red, 'mage');
    markDisconnected(room, 'a');
    expect(markReconnected(room, 'a')).toBe(true);
    expect(room.players.find((p) => p.id === 'a')!.connected).toBe(true);
  });

  it('★ 比赛中主动退出按淘汰处理，不能通过退出规避死亡统计', () => {
    addReady('a', Slot.Red, 'mage');
    addReady('b', Slot.Blue, 'warrior');
    startMatch(room);

    leaveMatch(room, 'a');
    // ★ 玩家**没有**被移出房间 —— 移出去就没法记他的死亡了
    expect(room.players.find((p) => p.id === 'a')).toBeDefined();
    expect(room.players.find((p) => p.id === 'a')!.connected).toBe(false);
  });

  it('比赛开始前退出则直接移出房间', () => {
    joinRoom(room, 'a', 'A');
    leaveMatch(room, 'a');
    expect(room.players.find((p) => p.id === 'a')).toBeUndefined();
  });

  /**
   * ★ A8（技术债总账）：setReady 此前是唯一没有 started 守卫的房间变更函数，
   *   靠「观战席不需要准备」间接兜住 —— 现在显式挡，与选阵营/选职业的锁同规矩。
   */
  it('★ A8：对局进行中不能更改准备状态（setReady 有自己的 started 守卫）', () => {
    addReady('a', Slot.Red, 'mage');
    addReady('b', Slot.Blue, 'warrior');
    startMatch(room);

    const r = setReady(room, 'a', false);
    expect(r.ok).toBe(false);
    // 准备标志没有被偷偷改动
    expect(room.players.find((p) => p.id === 'a')!.ready).toBe(true);
  });
});

describe('M13 赛后复位（docs/14 §M13：MatchEnd 后回房间可再开一局）', () => {
  /** 打完一局的房间：a/b 各一方，已开局 */
  const playedOut = () => {
    addReady('a', Slot.Red, 'mage');
    addReady('b', Slot.Blue, 'warrior');
    expect(startMatch(room).ok).toBe(true);
  };

  it('★ 复位解锁 started —— 选阵营/选职业重新可用（3.1 的锁只锁比赛期间）', () => {
    playedOut();
    expect(selectClass(room, 'a', asClassId('priest')).ok).toBe(false); // 锁着
    resetForRematch(room);
    expect(room.started).toBe(false);
    expect(selectClass(room, 'a', asClassId('priest')).ok).toBe(true);
    expect(selectSlot(room, 'a', Slot.Blue).ok).toBe(true);
  });

  it('★ 全员取消准备 —— 再开一局必须全体重新同意', () => {
    playedOut();
    resetForRematch(room);
    expect(room.players.every((p) => !p.ready)).toBe(true);
    expect(canStart(room).ok).toBe(false); // 没人准备，自然开不了
  });

  it('阵营与职业保留 —— 「再来一局」默认原班人马原阵容', () => {
    playedOut();
    resetForRematch(room);
    const a = room.players.find((p) => p.id === 'a')!;
    expect(a.slot).toBe(Slot.Red);
    expect(a.classId).toBe(asClassId('mage'));
  });

  it('★ 剔除已断线者 —— 留着会永远堵住 canStart（一个永不准备的名额）', () => {
    playedOut();
    leaveMatch(room, 'b'); // 比赛中退出 → 标记断线但留在名单（11.5）
    resetForRematch(room);
    expect(room.players.find((p) => p.id === 'b')).toBeUndefined();
    expect(room.players.find((p) => p.id === 'a')).toBeDefined();
  });

  it('复位后重新全员准备可以再次开始', () => {
    playedOut();
    resetForRematch(room);
    setReady(room, 'a', true);
    setReady(room, 'b', true);
    expect(canStart(room).ok).toBe(true);
    expect(startMatch(room).ok).toBe(true); // 第二局
  });
});

describe('10.1 规则预设', () => {
  it('经典竞技场与武装竞技场都可选', () => {
    const classic = createRoom('c', 'h', config({ preset: ArenaPreset.Classic }));
    const armed = createRoom('a', 'h', config({ preset: ArenaPreset.Armed }));
    expect(classic.config.preset).toBe(ArenaPreset.Classic);
    expect(armed.config.preset).toBe(ArenaPreset.Armed);
  });

  it('2.1 可选单回合、三局两胜或五局三胜', () => {
    for (const n of [1, 2, 3]) {
      expect(createRoom('x', 'h', config({ roundsToWin: n })).config.roundsToWin).toBe(n);
    }
  });
});

describe('队伍 id 映射', () => {
  it('红蓝槽位映射到正确的 TeamId', () => {
    addReady('r', Slot.Red, 'mage');
    addReady('b', Slot.Blue, 'warrior');
    const hints = compositionHints(room);
    const teams = new Set(hints.map((h) => h.team as number));
    for (const t of teams) expect([TEAM_RED as number, TEAM_BLUE as number]).toContain(t);
  });
});

/**
 * 3.1 房间设置的两个开关（10.1 规则预设、docs/14 §16b 人机补位）。
 *
 * ★ 这两条的重点都是**权限与默认值**，不是功能：
 *   · 权限错了 → 任何人都能改别人的房间
 *   · 默认值错了 → 两百多项验收赖以成立的初始条件被悄悄改掉
 */
describe('3.1 房间设置：规则预设与人机补位', () => {
  beforeEach(() => {
    room = createRoom('r-cfg', 'host', config());
    joinRoom(room, 'host', '房主');
    joinRoom(room, 'guest', '客人');
  });

  it('★ 房主改得动规则预设，非房主改不动', () => {
    expect(setPreset(room, 'guest', ArenaPreset.Armed).ok).toBe(false);
    expect(room.config.preset).toBe(ArenaPreset.Classic);

    expect(setPreset(room, 'host', ArenaPreset.Armed).ok).toBe(true);
    expect(room.config.preset).toBe(ArenaPreset.Armed);
  });

  it('★ 开赛后不能再改规则预设（与选阵营同一条线）', () => {
    room.started = true;
    expect(setPreset(room, 'host', ArenaPreset.Armed).ok).toBe(false);
  });

  it('★★ 人机补位**默认关** —— 它会改变开局时世界里有几个实体', () => {
    expect(room.config.fillWithBots, '默认开会打掉两百多项验收赖以成立的初始条件').toBe(false);
    expect(botSeatsNeeded(room), '没开就不该产生任何人机席位').toHaveLength(0);
  });

  it('★ 人机补位同样是房主专属、开赛前专属', () => {
    expect(setFillWithBots(room, 'guest', true).ok).toBe(false);
    expect(setFillWithBots(room, 'host', true).ok).toBe(true);
    expect(room.config.fillWithBots).toBe(true);

    room.started = true;
    expect(setFillWithBots(room, 'host', false).ok).toBe(false);
  });

  it('★★ 随机大 BOSS **默认关**，且是房主专属、开赛前专属', () => {
    expect(room.config.bossEnabled, '默认开会改变开局后世界里有几个实体').toBeUndefined();
    expect(setBossEnabled(room, 'guest', true).ok).toBe(false);
    expect(setBossEnabled(room, 'host', true).ok).toBe(true);
    expect(room.config.bossEnabled).toBe(true);

    room.started = true;
    expect(setBossEnabled(room, 'host', false).ok).toBe(false);
    expect(room.config.bossEnabled, '开赛后拒绝的写入不能落库').toBe(true);
  });

  it('★★ BOSS 开关不参与开局条件（它不是名单里的人）', () => {
    addReady('a', Slot.Red, 'mage');
    addReady('b', Slot.Blue, 'priest');
    room.config.mode = GameMode.Arena2v2; // 2v2 才能用两个人开起来
    const before = canStart(room);
    setBossEnabled(room, 'host', true);
    expect(canStart(room)).toEqual(before);
  });

  it('★★ P5 单人 + 人机补位 → 能开局（此前被两条人数规则拦死，补位形同虚设）', () => {
    setFillWithBots(room, 'host', true);
    addReady('solo', Slot.Red, 'mage');
    const check = canStart(room);
    expect(check.ok, check.reasons.join('；')).toBe(true);
    expect(check.nonStandard, '补位保证开局满编，不该标非标准').toBe(false);
    // 3v3：红缺 2、蓝缺 3
    expect(botSeatsNeeded(room).reduce((n, s) => n + s.count, 0)).toBe(5);
  });

  it('★ P5 补位开着也不允许零玩家开局（全观战的纯人机空局没有主体）', () => {
    setFillWithBots(room, 'host', true);
    joinRoom(room, 'watcher', '观众'); // 停在观战席
    expect(canStart(room).ok).toBe(false);
  });

  it('★ P5 人机难度：房主专属、开赛前专属；缺省按 normal 读', () => {
    expect(room.config.botDifficulty, '老房间对象没有该字段 → 读侧按 normal 兜底')
      .toBeUndefined();
    expect(setBotDifficulty(room, 'guest', 'easy').ok).toBe(false);
    expect(setBotDifficulty(room, 'host', 'easy').ok).toBe(true);
    expect(room.config.botDifficulty).toBe('easy');

    room.started = true;
    expect(setBotDifficulty(room, 'host', 'hard').ok).toBe(false);
    expect(room.config.botDifficulty, '开赛后拒绝的写入不能落库').toBe('easy');
  });

  it('★★ 开启后按「每队缺多少补多少」产出席位', () => {
    setFillWithBots(room, 'host', true);
    // 3v3：红队 1 人、蓝队 0 人 → 红缺 2、蓝缺 3
    selectSlot(room, 'host', Slot.Red);

    const seats = botSeatsNeeded(room);
    const red = seats.find((s) => s.slot === Slot.Red);
    const blue = seats.find((s) => s.slot === Slot.Blue);
    expect(red?.count).toBe(2);
    expect(blue?.count).toBe(3);
  });

  it('★ 队伍满了就不再补（不会补出超编的人机）', () => {
    setFillWithBots(room, 'host', true);
    room.config.mode = GameMode.Arena2v2;
    selectSlot(room, 'host', Slot.Red);
    selectSlot(room, 'guest', Slot.Red);

    const seats = botSeatsNeeded(room);
    expect(seats.find((s) => s.slot === Slot.Red), '满员的队伍还在补人机').toBeUndefined();
    expect(seats.find((s) => s.slot === Slot.Blue)?.count).toBe(2);
  });

  it('★ 观战席不参与补位判定（他们不进世界）', () => {
    setFillWithBots(room, 'host', true);
    room.config.mode = GameMode.Arena2v2;
    selectSlot(room, 'host', Slot.Spectator);
    selectSlot(room, 'guest', Slot.Spectator);

    // 两队都是空的 → 各缺 2
    for (const slot of [Slot.Red, Slot.Blue]) {
      expect(botSeatsNeeded(room).find((s) => s.slot === slot)?.count).toBe(2);
    }
  });
});

/**
 * W12：切换游戏模式（竞技场 ↔ 夺旗）。
 *
 * ★ 与 `setPreset` 同一族的房间设置，但多两条自己的规则：
 *   换模式**连带换地图与人数档**、缩档超编时**拒绝而不是悄悄踢人**。
 */
describe('W12 房间设置：游戏模式', () => {
  beforeEach(() => {
    room = createRoom('r-mode', 'host', config());
    joinRoom(room, 'host', '房主');
    joinRoom(room, 'guest', '客人');
  });

  it('★ 房主改得动模式，非房主改不动', () => {
    expect(setMode(room, 'guest', GameMode.Ctf6v6).ok).toBe(false);
    expect(room.config.mode).toBe(GameMode.Arena3v3);

    expect(setMode(room, 'host', GameMode.Ctf6v6).ok).toBe(true);
    expect(room.config.mode).toBe(GameMode.Ctf6v6);
  });

  it('★ 开赛后不能再改模式（与选阵营同一条线）', () => {
    room.started = true;
    expect(setMode(room, 'host', GameMode.Ctf6v6).ok).toBe(false);
  });

  it('★★ 换模式连带换地图 —— mapId 来自地图注册表，不是拿模式名当地图 id', () => {
    setMode(room, 'host', GameMode.Ctf6v6);
    // DEFAULT_CONFIG 那个「地图 id 写成模式名 → 房间永远开不了局」的坑，
    // 这里从注册表反查钉死：换出去的 mapId 必须真的存在且支持该模式
    expect(room.config.mapId as string).toBe('ctf_twin_bridges');

    setMode(room, 'host', GameMode.Arena2v2);
    expect(room.config.mapId as string).toBe('arena_2v2');
  });

  it('★★ 缩小人数档时超编 → 拒绝并说明，不悄悄把人踢去观战', () => {
    // 3v3 房间里红方坐满 3 人
    for (const id of ['host', 'guest', 'third']) {
      joinRoom(room, id, id);
      selectSlot(room, id, Slot.Red);
    }
    const r = setMode(room, 'host', GameMode.Arena2v2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('观战席');
    // 拒绝 = 什么都没变
    expect(room.config.mode).toBe(GameMode.Arena3v3);
    expect(playersOn(room, Slot.Red)).toHaveLength(3);
  });

  it('★ 换模式后全员取消准备 —— 已按下的准备是对上一个模式的同意', () => {
    selectSlot(room, 'host', Slot.Red);
    selectClass(room, 'host', asClassId('mage'));
    setReady(room, 'host', true);

    setMode(room, 'host', GameMode.Ctf6v6);
    expect(room.players.every((p) => !p.ready)).toBe(true);
    // 职业与阵营保留（与 resetForRematch 同语义：重新同意，不重选人生）
    expect(room.players.find((p) => p.id === 'host')?.classId).toBe(asClassId('mage'));
  });
});

describe('P5 房间设置：选图（SetRoomMap 的规则面）', () => {
  beforeEach(() => {
    room = createRoom('r-map', 'host', config());
    joinRoom(room, 'host', '房主');
    joinRoom(room, 'guest', '客人');
  });

  it('★ 房主能换成一张适配当前模式的图（密林祭坛吃 3v3）', () => {
    const r = setMap(room, 'host', asMapId('arena_grove_altar'));
    expect(r.ok).toBe(true);
    expect(room.config.mapId as string).toBe('arena_grove_altar');
  });

  it('★ 非房主换不动 —— 与预设/模式同一条线', () => {
    expect(setMap(room, 'guest', asMapId('arena_grove_altar')).ok).toBe(false);
    expect(room.config.mapId as string).toBe('arena_3v3');
  });

  it('★ 开赛后换不动（阶段白名单是第一道门，这里是第二道）', () => {
    room.started = true;
    expect(setMap(room, 'host', asMapId('arena_grove_altar')).ok).toBe(false);
    expect(room.config.mapId as string).toBe('arena_3v3');
  });

  it('★ 不存在的地图 id 诚实拒绝（不受信任输入可以是任意字符串）', () => {
    const r = setMap(room, 'host', asMapId('arena_atlantis'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('不存在');
    expect(room.config.mapId as string).toBe('arena_3v3');
  });

  /**
   * ★★ 这一条是本组的主线：**不合法就拒绝，绝不「顺手换成一张能用的」**。
   *   静默改的表现是「我明明选了熔岩裂谷，开局却在试炼环」——
   *   而玩家只会以为是随机的。
   */
  it('★★ 不适配当前人数档 → 拒绝且一个字段都不动（熔岩裂谷最低 6v6）', () => {
    const r = setMap(room, 'host', asMapId('arena_lava_rift'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('不适配');
    expect(room.config.mapId as string).toBe('arena_3v3');
    expect(room.config.mode).toBe(GameMode.Arena3v3);
  });

  it('★ 换到该图支持的档位之后，同一条消息就通过了', () => {
    setMode(room, 'host', GameMode.Arena6v6);
    expect(setMap(room, 'host', asMapId('arena_lava_rift')).ok).toBe(true);
    expect(room.config.mapId as string).toBe('arena_lava_rift');
  });

  it('★ 换图不取消准备 —— 换的是地形，不是「打什么、几个人」', () => {
    selectSlot(room, 'host', Slot.Red);
    selectClass(room, 'host', asClassId('mage'));
    setReady(room, 'host', true);
    expect(setMap(room, 'host', asMapId('arena_grove_altar')).ok).toBe(true);
    expect(room.players.find((p) => p.id === 'host')?.ready).toBe(true);
  });

  /** ★ 每一张主题图都要真的能被选上 —— 否则「做了图玩家进不去」原样复发 */
  it('★★ 四张主题图各自在自己的档位区间里都选得上', () => {
    for (const spec of THEMED_ARENA_SPECS) {
      for (const mode of MAP_BY_ID.get(spec.id)!.modes) {
        const r2 = createRoom('probe', 'host', config({ mode }));
        joinRoom(r2, 'host', '房主');
        expect(setMap(r2, 'host', asMapId(spec.id)).ok, `${spec.name} 在 ${mode} 选不上`)
          .toBe(true);
      }
    }
  });
});

describe('P5 换人数档时的地图回落（setMode 的后半句）', () => {
  beforeEach(() => {
    room = createRoom('r-fall', 'host', config());
    joinRoom(room, 'host', '房主');
  });

  /**
   * ★★ 拖一格滑杆就把房主挑好的图打回试炼环的话，「选图」在 UI 上等于没做完。
   *   密林祭坛声明的是 3v3/4v4/5v5，三档之间来回换都该留着它。
   */
  it('★★ 新档位仍适配 → 保留当前图（不被静默换掉）', () => {
    setMap(room, 'host', asMapId('arena_grove_altar'));
    expect(setMode(room, 'host', GameMode.Arena5v5).ok).toBe(true);
    expect(room.config.mapId as string).toBe('arena_grove_altar');
  });

  /**
   * ★★ 回落不能省：6v6 用一张只支持到 5v5 的图，`beginMatch` 查完地图
   *   会得到一张出生点不够的场地 —— 那是一局打不起来的房间。
   */
  it('★★ 新档位不适配 → 回落到该模式的首张图（mapsForMode 的权威首项）', () => {
    setMap(room, 'host', asMapId('arena_grove_altar'));
    expect(setMode(room, 'host', GameMode.Arena8v8).ok).toBe(true);
    expect(room.config.mapId as string).toBe(mapsForMode(GameMode.Arena8v8)[0]!.id as string);
    expect(room.config.mapId as string).toBe('arena_8v8');
  });

  /** ★ 无参默认路径一字不变：没主动选过图的房间，换档还是老样子 */
  it('★ 没选过图的房间换档 = 老行为（试炼环跟着档位走）', () => {
    expect(setMode(room, 'host', GameMode.Arena5v5).ok).toBe(true);
    expect(room.config.mapId as string).toBe('arena_5v5');
    expect(setMode(room, 'host', GameMode.Ctf6v6).ok).toBe(true);
    expect(room.config.mapId as string).toBe('ctf_twin_bridges');
  });

  /** ★ 跨族切换（竞技场 → 夺旗）永远回落 —— 主题图不声明 ctf 模式 */
  it('★ 主题图上切到夺旗 → 回落夺旗图', () => {
    setMode(room, 'host', GameMode.Arena8v8);
    setMap(room, 'host', asMapId('arena_ruins_colosseum'));
    expect(setMode(room, 'host', GameMode.Ctf8v8).ok).toBe(true);
    expect(room.config.mapId as string).toBe('ctf_twin_bridges');
  });
});
