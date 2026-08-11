/**
 * M12：环境光照与天空（`assets/art/env/**`、`assets/art/textures/terrain/**`）。
 *
 * ★★ **验收 #48 在这里的落点：环境完全是「加法」。**
 *
 *   场景的**基础照明**（半球光 + 环境光 + 平行光）由各场景自己建，
 *   本模块只**追加** HDR 的 IBL 与天空。所以：素材缺失、加载失败、
 *   或低画质跳过加载，得到的都是 M11 那个「朴素但完整」的画面 ——
 *   没有任何一条路径能让角色、目标、控制状态变暗到看不见。
 *
 *   低画质跳过用的是 `isVisible('ambientLight', tier)`，也就是 quality.ts
 *   那个只接受 `DecorativeRole` 的函数 —— 14.4 原文「可以减少……非关键光照」。
 *   ★ 想在这里跳过任何**关键**元素是类型错误，与 M8 的保证同一把锁。
 *
 * ★ **一律取 1k**（素材库里也有 2k，但那是 8MB 且看不出差别）——
 *   理由写在 `apply()` 里。
 */

import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { isVisible, type QualityTier } from './quality.js';

/** 可用的环境预设 → HDR 文件名（不含 `_1k` / `_2k` 与扩展名）*/
export const ENV_PRESETS = {
  /** 试验场与竞技场：中性白天，阴影方向清楚，最适合看清判定 */
  day: 'vale_day',
  dawn: 'peaks_dawn',
  dusk: 'hollow_dusk',
  overcast: 'marsh_overcast',
  night: 'night',
} as const;
export type EnvPreset = keyof typeof ENV_PRESETS;

/**
 * W15：把 `MapDef.envPreset`（自由字符串，纯表现字段）验成合法预设。
 * 不认识的值回落 day —— 数据拼错不害渲染，也不静默黑屏。
 */
export const presetOf = (envPreset: string | undefined): EnvPreset =>
  envPreset !== undefined && envPreset in ENV_PRESETS ? (envPreset as EnvPreset) : 'day';

/**
 * 地面材质预设。key 与 `MapVolume.tag` 无关 —— 由场景挑，
 * 因为「这张图是雪地还是草地」是美术决定，不是几何决定。
 */
export const GROUND_TEXTURES = {
  grass: 'Grass001',
  dirt: 'Ground048',
  stone: 'PavingStones046',
  rock: 'Rock051',
  snow: 'Snow010A',
} as const;
export type GroundTexture = keyof typeof GROUND_TEXTURES;

/**
 * P5：把 `MapDef.groundTexture`（自由字符串，纯表现字段）验成合法材质。
 * ★ 不填或拼错一律回落 `stone` —— 那正是本字段出现之前**所有**地图的行为，
 *   所以老图逐帧不变，新图拼错也只是「没换成雪地」而不是黑地面。
 *   与 `presetOf` 同一条纪律（拼错由 `envPreset.test.ts` 那一族测试变红灯）。
 */
export const groundOf = (groundTexture: string | undefined): GroundTexture =>
  groundTexture !== undefined && groundTexture in GROUND_TEXTURES
    ? (groundTexture as GroundTexture)
    : 'stone';

export interface EnvironmentOptions {
  preset?: EnvPreset;
  /** 天空是否可见。夺旗/竞技场是室内外混合，室内图可以关掉 */
  sky?: boolean;
}

export class Environment {
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | undefined;
  private skyTexture: THREE.Texture | undefined;
  /** 场景原本的纯色背景，卸载 HDR 时回落到它 */
  private readonly fallbackBackground: THREE.Color | null;
  private disposed = false;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
  ) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.fallbackBackground =
      scene.background instanceof THREE.Color ? scene.background.clone() : null;
  }

  /**
   * 最近一次显式传入的表现选项。
   * ★ A13（技术债总账）：切画质时两个场景都只调 `apply(tier)` 不带 opts ——
   *   此前这会把昼夜 preset 静默回落到 day。选项是**表现状态**不是每次调用
   *   的参数，记住上一次的值，切档只换画质不换天。
   */
  private lastOpts: EnvironmentOptions = {};

  /**
   * 按当前画质加载环境。切档时再调一次即可（低→高会补加载，高→低会卸载）。
   * ★ 不 await：调用方不该为了一张 2MB 的贴图卡住首帧。
   * ★ 不带 `opts` 的调用沿用上一次的 preset/sky（见 `lastOpts`）。
   */
  apply(tier: QualityTier, opts?: EnvironmentOptions): void {
    if (opts !== undefined) this.lastOpts = opts;
    const effective = this.lastOpts;
    // 14.4「非关键光照」—— 低画质不加载 IBL，基础三盏灯照常工作
    if (!isVisible('ambientLight', tier)) {
      this.unload();
      return;
    }
    /**
     * ★ **一律用 1k**，尽管 2k 也在素材库里。
     *   IBL 要经过 PMREM 卷积，2k 的额外细节在漫反射与粗糙反射里
     *   全部被糊掉；天空又叠了 `backgroundBlurriness`。
     *   实测差别肉眼不可见，代价却是 2MB → **8MB** 与一次明显更长的解码。
     */
    void this.load(`/art/env/${ENV_PRESETS[effective.preset ?? 'day']}_1k.hdr`, effective.sky ?? true);
  }

  private loadingUrl: string | undefined;
  private loadedUrl: string | undefined;

  private async load(url: string, sky: boolean): Promise<void> {
    if (this.loadedUrl === url || this.loadingUrl === url) {
      // 同一张图，只需同步天空开关
      if (this.loadedUrl === url) this.setSky(sky);
      return;
    }
    this.loadingUrl = url;
    try {
      const hdr = await new RGBELoader().loadAsync(url);
      if (this.disposed) { hdr.dispose(); return; }
      // 加载期间画质又降了 → 丢弃，别把低画质的场景又点亮
      if (this.loadingUrl !== url) { hdr.dispose(); return; }

      hdr.mapping = THREE.EquirectangularReflectionMapping;
      const rt = this.pmrem.fromEquirectangular(hdr);

      this.envRT?.dispose();
      this.skyTexture?.dispose();
      this.envRT = rt;
      this.skyTexture = hdr;
      this.loadedUrl = url;

      this.scene.environment = rt.texture;
      // 反射强度压一档：素材是户外实景 HDR，直接用会让金属武器过曝
      this.scene.environmentIntensity = 0.65;
      this.setSky(sky);
    } catch (err) {
      // 素材可选：保留纯色背景与基础三盏灯
      console.warn(`[环境] ${url} 加载失败，保留基础光照`, err);
      this.loadedUrl = undefined;
    } finally {
      if (this.loadingUrl === url) this.loadingUrl = undefined;
    }
  }

  private setSky(on: boolean): void {
    if (on && this.skyTexture) {
      this.scene.background = this.skyTexture;
      // 天空轻微模糊：1k 全景当近景天空会看出接缝，糊一点更像大气
      this.scene.backgroundBlurriness = 0.25;
      this.scene.backgroundIntensity = 0.9;
    } else if (this.fallbackBackground) {
      this.scene.background = this.fallbackBackground;
      this.scene.backgroundBlurriness = 0;
    }
  }

  /** 降到低画质：卸掉 IBL 与天空，回落纯色背景 */
  private unload(): void {
    this.loadingUrl = undefined;
    if (this.loadedUrl === undefined) return;
    this.loadedUrl = undefined;
    this.scene.environment = null;
    this.setSky(false);
    this.envRT?.dispose();
    this.envRT = undefined;
    this.skyTexture?.dispose();
    this.skyTexture = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.unload();
    this.pmrem.dispose();
  }
}

/**
 * 加载一套 PBR 地面贴图。缺文件时返回 undefined —— 调用方保留纯色材质。
 *
 * ★ 只取 Color + Normal + Roughness 三张：AO 对平铺地面收益很小，
 *   而它是第四次 HTTP 请求与第四份显存。
 */
export const loadGroundTextures = async (
  kind: GroundTexture,
  /** 平铺次数。地图是米制，一般取「边长 / 4 米」*/
  repeat: number,
): Promise<{
  map: THREE.Texture;
  normalMap?: THREE.Texture;
  roughnessMap?: THREE.Texture;
} | undefined> => {
  const base = GROUND_TEXTURES[kind];
  const loader = new THREE.TextureLoader();

  const one = async (suffix: string, srgb: boolean): Promise<THREE.Texture | undefined> => {
    try {
      const t = await loader.loadAsync(`/art/textures/terrain/${base}_${suffix}.jpg`);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat, repeat);
      t.anisotropy = 4;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    } catch {
      return undefined;
    }
  };

  const map = await one('Color', true);
  if (!map) return undefined; // 底色都没有就整套放弃，别出现「只有法线的黑地面」
  const [normalMap, roughnessMap] = await Promise.all([
    one('NormalGL', false),
    one('Roughness', false),
  ]);
  return {
    map,
    ...(normalMap ? { normalMap } : {}),
    ...(roughnessMap ? { roughnessMap } : {}),
  };
};
