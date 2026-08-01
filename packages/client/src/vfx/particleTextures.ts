/**
 * M12（14.2 收尾）：把 `assets/art/vfx/*.png` 的 16 张粒子贴图接到八属性特效上。
 *
 * ★★ **这是「素材在手却没用」的补齐点。**
 *   `schools.ts` 早就有八属性的颜色/形状/glyph 表，`phases.ts` 也早就把技能推导成
 *   释放/飞行/命中/持续四个阶段 —— 但在此之前**没有任何 3D 渲染消费它们**，
 *   那 16 张贴图一张都没进过场景。本文件与 `ParticleBurst`/`SpellVfx` 一起把它们用起来。
 *
 * ★ **风格是可爱卡通（Q 版）**：贴图都取圆润、明亮、软边的那几张（fire_01 的圆火球、
 *   star_07 的胖六角、circle_05 的圆水滴…），配合 `ParticleBurst` 的「先胀后消」Q 弹 pop
 *   与高饱和双色，得到糖果色而不是写实的火焰烟雾。
 *
 * ★ **逐层兜底**：加载失败返回 null，`ParticleBurst` 会退回无贴图的纯色加法粒子 ——
 *   属性颜色仍在，只是少了贴图纹样。这与模型/环境/图标每一层「素材可选」同一原则。
 *
 * ★ 贴图 URL 走 `/art/vfx/<name>.png`：vite 中间件已把仓库根 `assets/` 挂到 `/art/`
 *   （见 `packages/client/vite.config.ts`）。
 */

import * as THREE from 'three';
import { type AttributeVisual } from './schools.js';

/** `assets/art/vfx/` 下实际存在的 16 张贴图（不含扩展名）。改动这里要同步磁盘。 */
export const VFX_TEXTURE_FILES = [
  'circle_05', 'dirt_02', 'fire_01', 'flame_03', 'flare_01', 'light_01',
  'light_02', 'magic_01', 'magic_04', 'slash_02', 'smoke_05', 'spark_04',
  'spark_06', 'star_07', 'trace_05', 'twirl_01',
] as const;
export type VfxTextureName = (typeof VFX_TEXTURE_FILES)[number];

/**
 * 八属性各自的**主粒子**贴图（对应 `AttributeVisual.particle` 那 8 个形状键）。
 * 挑选原则：形状要贴合 14.2「形状与运动」列，且偏圆润明亮以合卡通基调。
 */
export const PARTICLE_TEXTURE: Record<AttributeVisual['particle'], VfxTextureName> = {
  ember: 'fire_01',       // 火：圆火球
  snowflake: 'star_07',   // 冰：胖六角星 ≈ 雪花
  rune: 'magic_04',       // 奥术：符文光斑
  smoke: 'smoke_05',      // 暗影：柔烟
  beam: 'light_02',       // 神圣：光柱/光斑
  leaf: 'twirl_01',       // 自然：旋叶/藤蔓
  spark: 'spark_04',      // 物理：火花
  droplet: 'circle_05',   // 毒素：圆液滴
};

/**
 * 点缀贴图：释放辉光 / 命中碎屑 / 拖尾。
 * ★ 刻意用掉**其余 8 张** —— 加上 `PARTICLE_TEXTURE` 的 8 张正好 16 张全覆盖，
 *   由 `particleTextures.test.ts` 钉死「素材在手都用上了」。
 */
export const ACCENT_TEXTURES = {
  /** 释放/命中的通用辉光核 */
  glow: 'flare_01',
  /** 更亮的中心闪 */
  flash: 'light_01',
  /** 火系余烬拖尾 */
  ember: 'flame_03',
  /** 奥术/神圣的星屑 */
  sparkle: 'magic_01',
  /** 物理命中的迸溅火星 */
  spark: 'spark_06',
  /** 物理/近战的刀光 */
  slash: 'slash_02',
  /** 投射物拖尾条 */
  trail: 'trace_05',
  /** 命中地面的尘土碎屑 */
  debris: 'dirt_02',
} as const satisfies Record<string, VfxTextureName>;
export type AccentTexture = keyof typeof ACCENT_TEXTURES;

// ── 惰性加载 + 缓存 ────────────────────────────────────────────────

const cache = new Map<VfxTextureName, Promise<THREE.Texture | null>>();
let loader: THREE.TextureLoader | undefined;

/**
 * 加载一张 vfx 贴图。模块级缓存：同一张只解码一次。
 * 失败返回 null（逐层兜底：调用方退回无贴图纯色粒子）。
 */
export const loadVfxTexture = (name: VfxTextureName): Promise<THREE.Texture | null> => {
  let p = cache.get(name);
  if (!p) {
    loader ??= new THREE.TextureLoader();
    p = loader
      .loadAsync(`/art/vfx/${name}.png`)
      .then((t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        return t;
      })
      .catch((err: unknown) => {
        console.warn(`[特效] /art/vfx/${name}.png 加载失败，退回纯色粒子`, err);
        return null;
      });
    cache.set(name, p);
  }
  return p;
};

/** 属性主粒子贴图的便捷取用 */
export const particleTextureFor = (
  particle: AttributeVisual['particle'],
): Promise<THREE.Texture | null> => loadVfxTexture(PARTICLE_TEXTURE[particle]);

/** 点缀贴图便捷取用 */
export const accentTexture = (which: AccentTexture): Promise<THREE.Texture | null> =>
  loadVfxTexture(ACCENT_TEXTURES[which]);
