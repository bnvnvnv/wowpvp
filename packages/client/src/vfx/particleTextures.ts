/**
 * M12（14.2 收尾）：把 `assets/art/vfx/*.png` 的粒子贴图接到八属性特效上。
 * （M12 时 16 张；三期夸张化扩到 22 张，见 `VFX_TEXTURE_FILES`）
 *
 * ★★ **这是「素材在手却没用」的补齐点。**
 *   `schools.ts` 早就有八属性的颜色/形状/glyph 表，`phases.ts` 也早就把技能推导成
 *   释放/飞行/命中/持续四个阶段 —— 但在此之前**没有任何 3D 渲染消费它们**，
 *   那些贴图一张都没进过场景。本文件与 `ParticleBurst`/`SpellVfx` 一起把它们用起来。
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

/**
 * `assets/art/vfx/` 下实际存在的 22 张贴图（不含扩展名）。改动这里要同步磁盘。
 *
 * ★ 16 → 22 是「三期夸张化」补的六张，全部来自**同一个已登记的 CC0 包**
 *   （Kenney Particle Pack，见 assets/CREDITS-world-of-claudecraft.md）——
 *   零新增许可负担，`License.txt` 一并入库。
 */
export const VFX_TEXTURE_FILES = [
  'circle_05', 'dirt_02', 'fire_01', 'flame_03', 'flare_01', 'light_01',
  'light_02', 'magic_01', 'magic_04', 'slash_02', 'smoke_05', 'spark_04',
  'spark_06', 'star_07', 'trace_05', 'twirl_01',
  // ── 三期新增 ──
  'circle_03', 'muzzle_02', 'scorch_02', 'star_04', 'flame_04', 'smoke_02',
  // 刀光变体：给近战职业用，见 SLASH_ACCENTS
  'slash_01', 'slash_03', 'slash_04',
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
 * 点缀贴图：释放辉光 / 命中碎屑 / 拖尾 / 冲击环…
 *
 * ★★ **它们全部是「属性无关」的**：由调用方按技能的学派色染色，
 *   所以八个职业**共用同一批**。这一点很重要 —— 战士 11 个技能**全是物理**、
 *   盗贼 12 个里 9 个物理，这些职业的技能没有元素色可玩，
 *   能拉开表现的只有**形状通道**（环、爆点、星芒、刀光）。
 *   换句话说，新增的这几张对近战职业的收益比对法师更大。
 *
 * ★ `PARTICLE_TEXTURE`（8 张，一属性一张）+ 本表 = 全部 22 张，
 *   由 `particleTextures.test.ts` 钉死「素材在手都用上了」（无孤儿、无断链）。
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

  // ── 三期新增（夸张化）──
  /**
   * ★ 真正的**空心环**。此前「冲击波」用的是 `glow` 光斑 ——
   *   而地面波那一轮的提交信息自己就写过：那是**面向镜头的广告牌光斑**，
   *   不是环，从上往下看只是一团光。这张才让冲击波读作「一圈扩出去」
   */
  ring: 'circle_03',
  /** 定向爆闪：出手瞬间的枪口焰，给「释放」一个方向感 */
  muzzle: 'muzzle_02',
  /** 放射状爆点：命中核心 / 大招落地的灼痕 */
  scorch: 'scorch_02',
  /** 四角星芒：暴击与神圣的高光（形状通道，不抢「白只留给暴击」的颜色通道）*/
  star: 'star_04',
  /** 圆润爆炸云：重击与大招的体积感（火/物理）*/
  puff: 'flame_04',
  /** 浓密烟云：暗影/毒素的弥漫层（比 smoke_05 更细碎）*/
  cloud: 'smoke_02',

  // ── 刀光变体（见 SLASH_ACCENTS）──
  slashB: 'slash_01',
  slashC: 'slash_03',
  slashD: 'slash_04',
} as const satisfies Record<string, VfxTextureName>;
export type AccentTexture = keyof typeof ACCENT_TEXTURES;

/**
 * 四张刀光，**轮流**用。
 *
 * ★★ 为什么值得单独开一张表：战士 11 个技能**全是物理**、盗贼 12 个里 9 个物理，
 *   这些职业没有元素色可玩，刀光几乎是它们唯一的第二视觉通道 ——
 *   而此前全仓库只有一张 `slash_02`，连挥三刀是同一个图案，
 *   读起来像「卡住了」而不是「连击」。
 *
 * ★ 轮流而不是随机：随机会连续抽到同一张，而这里要解决的恰恰是
 *   「连着两下长得一样」。轮流保证相邻两刀必然不同。
 */
export const SLASH_ACCENTS = ['slash', 'slashB', 'slashC', 'slashD'] as const;

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
