/**
 * 音量设置的持久化（M12 已知不足 → docs/14 速赢清单第 1 项）。
 *
 * 模式与 `accessibility.ts` 完全同款：纯函数的 normalize / load / save，
 * 任何损坏或越界的值都回落到默认 —— 一份坏掉的设置不该让游戏打不开。
 *
 * ★ 此前音量**从不保存**：`setVolumes()` 全仓库零调用方、静音每次刷新还原。
 *   持久化接上后，静音状态立即受益；将来任何音量 UI 只要调 `setVolumes()`
 *   就自动落盘，不需要各自记得存。
 */

import { DEFAULT_VOLUMES, type AudioVolumes } from '../audio/AudioManager.js';

export const AUDIO_STORAGE_KEY = 'wowpvp.audio.v1';

export interface AudioSettings {
  volumes: AudioVolumes;
  muted: boolean;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  volumes: { ...DEFAULT_VOLUMES },
  muted: false,
};

const clamp01 = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;

/** 规范化一份（可能来自 localStorage 的）设置。逐字段夹回合法区间 */
export const normalizeAudioSettings = (raw: unknown): AudioSettings => {
  const r = (raw ?? {}) as { volumes?: Partial<AudioVolumes>; muted?: unknown };
  const v: Partial<AudioVolumes> = r.volumes ?? {};
  return {
    volumes: {
      master: clamp01(v.master, DEFAULT_VOLUMES.master),
      sfx: clamp01(v.sfx, DEFAULT_VOLUMES.sfx),
      music: clamp01(v.music, DEFAULT_VOLUMES.music),
      ui: clamp01(v.ui, DEFAULT_VOLUMES.ui),
    },
    muted: r.muted === true,
  };
};

export const loadAudioSettings = (
  storage: Pick<Storage, 'getItem'> | undefined,
): AudioSettings => {
  const raw = storage?.getItem(AUDIO_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_AUDIO_SETTINGS, volumes: { ...DEFAULT_VOLUMES } };
  try {
    return normalizeAudioSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_AUDIO_SETTINGS, volumes: { ...DEFAULT_VOLUMES } };
  }
};

export const saveAudioSettings = (
  storage: Pick<Storage, 'setItem'> | undefined,
  s: AudioSettings,
): void => {
  storage?.setItem(AUDIO_STORAGE_KEY, JSON.stringify(s));
};
