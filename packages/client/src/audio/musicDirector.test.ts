/**
 * W13：BGM 战斗切换的纯逻辑。播放本体走 AudioManager（浏览器里才有声音），
 * 这里钉的是**选曲判定** —— 它错了表现为「打起来了音乐没变」，无人会报错。
 */

import { describe, expect, it } from 'vitest';

import {
  MAP_AMBIENT_TRACK,
  MusicDirector,
  OUT_OF_COMBAT_SECONDS,
  ambientTrackFor,
} from './MusicDirector.js';

describe('W13 选曲判定', () => {
  it('★ 开局即氛围曲（lastCombatAt = -Infinity，从未战斗）', () => {
    const d = new MusicDirector('vale');
    expect(d.trackFor(0)).toBe('vale');
  });

  it('★ 战斗事件切战斗曲；脱战满 8 秒才淡回氛围曲（滞后防抽搐）', () => {
    const d = new MusicDirector('vale');
    d.noteCombat(10);
    expect(d.trackFor(10)).toBe('combat_1');
    expect(d.trackFor(10 + OUT_OF_COMBAT_SECONDS - 0.1)).toBe('combat_1'); // 差一点不回
    expect(d.trackFor(10 + OUT_OF_COMBAT_SECONDS)).toBe('vale');
  });

  it('noteCombat 时间不回退（乱序事件不会把战斗窗口缩短）', () => {
    const d = new MusicDirector('vale');
    d.noteCombat(20);
    d.noteCombat(5); // 迟到的旧事件
    expect(d.trackFor(20 + OUT_OF_COMBAT_SECONDS - 1)).toBe('combat_1');
  });

  it('★ 每张已配的图给的都是真实存在的曲目名；没配的回落城镇曲不静音', () => {
    // 曲目文件的存在性由磁盘校验类测试管不到（客户端包不读盘），
    // 这里钉住的是「表里没有拼错成不存在的键」—— 值必须非空且不含扩展名
    for (const [map, track] of Object.entries(MAP_AMBIENT_TRACK)) {
      expect(track.length, `${map} 的曲目名为空`).toBeGreaterThan(0);
      expect(track.includes('.'), `${map} 的曲目名带了扩展名`).toBe(false);
    }
    expect(ambientTrackFor('no_such_map')).toBe('town_eastbrook');
    expect(ambientTrackFor(undefined)).toBe('town_eastbrook');
  });
});
