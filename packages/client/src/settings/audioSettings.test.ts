/**
 * 音量持久化的纯函数断言（docs/14 速赢清单第 1 项，M12 已知不足）。
 * 模式与 accessibility 同款：坏数据回落默认，越界夹回区间。
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_VOLUMES } from '../audio/AudioManager.js';
import {
  AUDIO_STORAGE_KEY,
  loadAudioSettings,
  normalizeAudioSettings,
  saveAudioSettings,
} from './audioSettings.js';

const memStorage = (): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
};

describe('audioSettings —— 音量持久化', () => {
  it('越界与非数值逐字段夹回/回落，静音只认 true', () => {
    const s = normalizeAudioSettings({
      volumes: { master: 7, sfx: -1, music: Number.NaN, ui: 0.5 },
      muted: 'yes',
    });
    expect(s.volumes.master).toBe(1);
    expect(s.volumes.sfx).toBe(0);
    expect(s.volumes.music).toBe(DEFAULT_VOLUMES.music);
    expect(s.volumes.ui).toBe(0.5);
    expect(s.muted).toBe(false);
  });

  it('损坏的 JSON / 空存储回落到默认，游戏照常能开', () => {
    const st = memStorage();
    st.data.set(AUDIO_STORAGE_KEY, '{oops');
    expect(loadAudioSettings(st).volumes).toEqual(DEFAULT_VOLUMES);
    expect(loadAudioSettings(undefined).muted).toBe(false);
  });

  it('save → load 往返一致（含静音状态 —— 此前静音每次刷新还原）', () => {
    const st = memStorage();
    saveAudioSettings(st, { volumes: { master: 0.4, sfx: 0.9, music: 0, ui: 1 }, muted: true });
    const back = loadAudioSettings(st);
    expect(back.volumes).toEqual({ master: 0.4, sfx: 0.9, music: 0, ui: 1 });
    expect(back.muted).toBe(true);
  });

  it('默认值本身合法（normalize 幂等）', () => {
    const once = normalizeAudioSettings(undefined);
    expect(normalizeAudioSettings(once)).toEqual(once);
    expect(once.volumes).toEqual(DEFAULT_VOLUMES);
  });
});
