/**
 * 大厅纯逻辑测试。docs/14 §M13。
 *
 * 重点是两条容易悄悄坏掉的：
 *   · 房间码字符表不含易混字形 —— 口头转达是房间码的主用途
 *   · readyBlocker 的文案与服务器 setReady() 的拒绝理由说同一件事
 */

import { describe, expect, it } from 'vitest';
import {
  GameMode, MAP_BY_ID, THEMED_ARENA_SPECS, mapsForMode, type RoomPlayerView,
} from '@wowpvp/shared';
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  escapeHtml,
  isJoinableCode,
  makeRoomCode,
  mapOptionsFor,
  normalizeRoomCode,
  readyBlocker,
  roomRowActions,
  sanitizeName,
  shareLink,
  showMapRow,
  splitRoster,
  teamLabel,
} from './logic.js';

const player = (over: Partial<RoomPlayerView> = {}): RoomPlayerView => ({
  id: 'p1',
  name: '玩家',
  team: 'spectator',
  ready: false,
  connected: true,
  ...over,
});

describe('M13 房间码', () => {
  it('★ 字符表不含易混字形（0/O、1/I/L、8/B）', () => {
    for (const bad of ['0', 'O', '1', 'I', 'L', '8', 'B']) {
      expect(ROOM_CODE_ALPHABET, `字符表混入了 ${bad}`).not.toContain(bad);
    }
  });

  it('生成的码长度固定，且只用字符表里的字符', () => {
    // 确定性随机源：把 [0,1) 均匀扫一遍，覆盖边界（含 rand→1 的钳制）
    let n = 0;
    const rand = () => (n = (n + 0.37) % 1);
    for (let i = 0; i < 50; i++) {
      const code = makeRoomCode(rand);
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      for (const ch of code) expect(ROOM_CODE_ALPHABET).toContain(ch);
    }
    // rand 恒 0.999… 时不越界（Math.floor(rand*len) 可能等于 len 的经典错）
    expect(makeRoomCode(() => 0.9999999)).toHaveLength(ROOM_CODE_LENGTH);
  });

  it('规范化：去空白、大写；★ 不按字符表过滤 —— ?net= 老路的房名（r1）也要能进', () => {
    expect(normalizeRoomCode('  k7xq ')).toBe('K7XQ');
    expect(normalizeRoomCode('r1')).toBe('R1');
  });

  it('可提交判定：非空且 ≤16', () => {
    expect(isJoinableCode('')).toBe(false);
    expect(isJoinableCode('K7XQ')).toBe(true);
    expect(isJoinableCode('A'.repeat(17))).toBe(false);
  });
});

describe('M13 昵称与名单', () => {
  it('昵称去空白并截断到 12 字符', () => {
    expect(sanitizeName('  阿红  ')).toBe('阿红');
    expect(sanitizeName('一二三四五六七八九十好长啊')).toHaveLength(12);
    expect(sanitizeName('   ')).toBe('');
  });

  it('名单按 3.1 的三种席位分组', () => {
    const roster = splitRoster([
      player({ id: 'a', team: 'red' }),
      player({ id: 'b', team: 'blue' }),
      player({ id: 'c', team: 'spectator' }),
      player({ id: 'd', team: 'red' }),
    ]);
    expect(roster.red.map((p) => p.id)).toEqual(['a', 'd']);
    expect(roster.blue.map((p) => p.id)).toEqual(['b']);
    expect(roster.spectators.map((p) => p.id)).toEqual(['c']);
  });

  it('席位显示名', () => {
    expect(teamLabel('red')).toBe('红方');
    expect(teamLabel('blue')).toBe('蓝方');
    expect(teamLabel('spectator')).toBe('观战席');
  });
});

describe('M13 准备门禁文案（与服务器 setReady 拒绝理由一一对应）', () => {
  it('观战席不能准备 —— 与「观战席不需要准备」对应', () => {
    expect(readyBlocker(player({ team: 'spectator' }))).toContain('阵营');
  });

  it('没选职业不能准备 —— 与「请先选择职业」对应', () => {
    expect(readyBlocker(player({ team: 'red' }))).toContain('职业');
  });

  it('选了阵营与职业 → 放行（null）', () => {
    expect(readyBlocker(player({ team: 'red', classId: 'mage' as never }))).toBeNull();
  });

  it('自己还不在名单里（RoomState 未到）→ 不放行', () => {
    expect(readyBlocker(undefined)).not.toBeNull();
  });
});

describe('M13 HTML 转义（玩家名是不受信任的输入）', () => {
  it('★ 五个危险字符全部转义 —— 名单是 innerHTML 拼的，漏一个就是别人在你屏幕上跑脚本', () => {
    expect(escapeHtml(`<img onerror="x">&'`)).toBe('&lt;img onerror=&quot;x&quot;&gt;&amp;&#39;');
  });

  it('正常中文名原样通过', () => {
    expect(escapeHtml('阿红')).toBe('阿红');
  });
});

describe('M13 分享链接', () => {
  it('默认只带 lobby 参数', () => {
    expect(shareLink('http://host:5173', '/', 'K7XQ')).toBe('http://host:5173/?lobby=K7XQ');
  });

  it('显式指定过服务器地址时一并带上（并做 URL 编码）', () => {
    const url = shareLink('http://host:5173', '/', 'K7XQ', 'ws://10.0.0.2:8080');
    expect(url).toContain('lobby=K7XQ');
    expect(url).toContain('server=ws%3A%2F%2F10.0.0.2%3A8080');
  });
});

describe('P5 选图行（mapOptionsFor / showMapRow）', () => {
  /**
   * ★★ 首项恒为试炼环 —— `mapsForMode` 的顺序有语义（`setMode` 换图取 [0]），
   *   UI 若自己排序或自己拼 id，「默认路径行为不变」当场破功。
   */
  it('★★ 顺序照抄 mapsForMode：首项是该档的试炼环，主题图跟在后面', () => {
    const opts = mapOptionsFor(GameMode.Arena3v3);
    expect(opts[0]!.id).toBe(mapsForMode(GameMode.Arena3v3)[0]!.id as string);
    expect(opts[0]!.id).toBe('arena_3v3');
    expect(opts.map((o) => o.id)).toContain('arena_grove_altar');
  });

  it('★ 选项随人数档变（熔岩裂谷只在 6v6–9v9，密林祭坛只在 3v3–5v5）', () => {
    expect(mapOptionsFor(GameMode.Arena3v3).map((o) => o.id)).not.toContain('arena_lava_rift');
    expect(mapOptionsFor(GameMode.Arena6v6).map((o) => o.id)).toContain('arena_lava_rift');
    expect(mapOptionsFor(GameMode.Arena6v6).map((o) => o.id)).not.toContain('arena_grove_altar');
  });

  /**
   * ★★ 副标题/详情直接取地图规格的 style/terrain —— 客户端不另写一份文案。
   *   手写那份的后果是「地图改了、界面还在说老话」，而界面撒的谎没人会红。
   */
  it('★★ 主题图的副标题与详情逐字来自 THEMED_ARENA_SPECS', () => {
    const spec = THEMED_ARENA_SPECS.find((s) => s.id === 'arena_grove_altar')!;
    const opt = mapOptionsFor(GameMode.Arena3v3).find((o) => o.id === 'arena_grove_altar')!;
    expect(opt.name).toBe(spec.name);
    expect(opt.subtitle).toBe(spec.style);
    expect(opt.detail).toBe(spec.terrain);
  });

  it('★ 试炼环没有声明风格 → 如实留空，不编一句', () => {
    const opt = mapOptionsFor(GameMode.Arena3v3)[0]!;
    expect(opt.subtitle).toBe('');
    expect(opt.detail).toBe('');
    expect(opt.name).toBe(MAP_BY_ID.get('arena_3v3')!.name);
  });

  /** ★ 名字一律从注册表按 **id** 查（★ m5 #24：绝不按数组下标）*/
  it('★ 每个选项的名字都与注册表按 id 查出来的一致', () => {
    for (const mode of [GameMode.Arena1v1, GameMode.Arena5v5, GameMode.Arena12v12]) {
      for (const o of mapOptionsFor(mode)) {
        expect(o.name, `${o.id} 的名字对不上注册表`).toBe(MAP_BY_ID.get(o.id)!.name);
      }
    }
  });

  it('★ 大乱斗不画选图行（FFA 固定大图，P13 口径）', () => {
    expect(showMapRow(GameMode.Ffa)).toBe(false);
    expect(showMapRow(undefined)).toBe(false);
  });

  /**
   * ★★ 1v1–12v12 每一档都至少两张可选 —— 这条与 shared 的「不留空档」测试
   *   是同一件事的两端：那边保证数据有，这边保证界面画得出来。
   */
  it('★★ 竞技场 1v1–12v12 每一档都画得出选图行（至少两张可选）', () => {
    for (let n = 1; n <= 12; n++) {
      const mode = `arena${n}v${n}` as GameMode;
      expect(showMapRow(mode), `${n}v${n} 只有一张图可选`).toBe(true);
    }
  });
});

/**
 * W24：房间列表上的进行中房间。
 *
 * ★★ 这一组盯的是**一个具体的退化**：判据一旦从 `joinableSeats` 换回
 *   「capacity - players」，中途加入的按钮就会在所有开局的房间上消失
 *   （开局后队伍被人机补满，差值恒 0），而界面上只会少一颗按钮 ——
 *   不会有任何东西报错。
 */
describe('W24 房间列表：进行中的房间也进得去', () => {
  it('未开局的房间照旧只有一颗「加入」（老行为逐字不变）', () => {
    expect(roomRowActions({ started: false, joinableSeats: 3 }))
      .toEqual({ spectate: false, join: true, joinLabel: '加入' });
    // ⚠️ 未开局时 joinableSeats 为 0（满员）也仍然给加入键：能不能进由服务器判
    expect(roomRowActions({ started: false, joinableSeats: 0 }).join).toBe(true);
  });

  it('★★ 已开局 + 有可坐的席位 → 观战与加入两颗都有，且把数目说出来', () => {
    const a = roomRowActions({ started: true, joinableSeats: 5 });
    expect(a.spectate).toBe(true);
    expect(a.join).toBe(true);
    expect(a.joinLabel).toContain('5');
  });

  it('★★ 已开局 + 一个席位都没有 → 仍然可以观战（观战不占战斗席）', () => {
    const a = roomRowActions({ started: true, joinableSeats: 0 });
    expect(a.spectate).toBe(true);
    expect(a.join).toBe(false);
  });

  it('★★ 判据是 joinableSeats 本身 —— 满员的进行中房间也可能坐得下（人机席位）', () => {
    // 12/12 人「满员」但有 4 个人机席位可顶：差值口径会画成「不可加入」
    expect(roomRowActions({ started: true, joinableSeats: 4 }).join).toBe(true);
  });
});
