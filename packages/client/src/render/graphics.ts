import { QualityTier } from './quality.js';

export const FRAME_RATES = [30, 60, 90, 120] as const;
export interface GraphicsPreferences {
  quality: QualityTier;
  frameRate: number;
  adaptiveResolution: boolean;
  mouseSensitivity: number;
}

const KEY = 'wowpvp.graphics.v1';
export const DEFAULT_GRAPHICS: GraphicsPreferences = {
  quality: QualityTier.Medium,
  frameRate: 60,
  adaptiveResolution: true,
  mouseSensitivity: 1,
};

export function loadGraphics(): GraphicsPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<GraphicsPreferences> | null;
    return {
      quality: value?.quality && Object.values(QualityTier).includes(value.quality)
        ? value.quality : DEFAULT_GRAPHICS.quality,
      frameRate: FRAME_RATES.some((rate) => rate === value?.frameRate)
        ? value!.frameRate! : DEFAULT_GRAPHICS.frameRate,
      adaptiveResolution: typeof value?.adaptiveResolution === 'boolean'
        ? value.adaptiveResolution : DEFAULT_GRAPHICS.adaptiveResolution,
      mouseSensitivity: typeof value?.mouseSensitivity === 'number' && Number.isFinite(value.mouseSensitivity)
        ? Math.min(2.5, Math.max(0.25, value.mouseSensitivity)) : 1,
    };
  } catch {
    return { ...DEFAULT_GRAPHICS };
  }
}

export function saveGraphics(value: GraphicsPreferences): void {
  try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* Storage can be unavailable. */ }
}
