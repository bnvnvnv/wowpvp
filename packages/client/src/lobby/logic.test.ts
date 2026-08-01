/**
 * 大厅纯逻辑测试。docs/14 §M13。
 *
 * 重点是两条容易悄悄坏掉的：
 *   · 房间码字符表不含易混字形 —— 口头转达是房间码的主用途
 *   · readyBlocker 的文案与服务器 setReady() 的拒绝理由说同一件事
 */

import { describe, expect, it } from 'vitest';
import type { RoomPlayerView } from '@wowpvp/shared';
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  escapeHtml,
  isJoinableCode,
  makeRoomCode,
  normalizeRoomCode,
  readyBlocker,
  sanitizeName,
  shareLink,
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
