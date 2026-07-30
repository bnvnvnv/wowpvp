/**
 * 把画质档位应用到渲染器。规格书 17.1 / 14.4，验收 #5 / #48。
 *
 * ★ 这个类**只碰渲染器参数**（阴影、抗锯齿、分辨率、雾），
 *   一行都不碰「什么该画什么不该画」—— 那由 quality.ts 的角色分类决定。
 *
 *   分开的理由很实际：如果画质切换逻辑和可见性判断混在一处，
 *   某次「低画质再省一点」的优化很容易顺手把控制状态标记也关掉，
 *   而那正是验收 #48 禁止的事。这里没有任何可以关掉关键元素的口子。
 *
 * 抗锯齿是 WebGLRenderer 的构造参数，运行时改不了 —— 切到需要不同
 * 抗锯齿的档位时只能重建上下文，代价太大。这里的取舍是：
 * **构造时就按最高档开抗锯齿**，运行时只调阴影和分辨率。
 * 反正抗锯齿开着不影响 14.4 的任何一条（它不隐藏信息）。
 */

import * as THREE from 'three';
import {
  QUALITY_ORDER,
  QUALITY_SETTINGS,
  QualityTier,
  type QualitySettings,
} from './quality.js';

export class QualityController {
  private tier: QualityTier;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    initial: QualityTier = QualityTier.High,
  ) {
    this.tier = initial;
    this.apply();
  }

  get current(): QualityTier {
    return this.tier;
  }

  get settings(): QualitySettings {
    return QUALITY_SETTINGS[this.tier];
  }

  /** F2 循环：high → medium → low → high */
  cycle(): QualityTier {
    const i = QUALITY_ORDER.indexOf(this.tier);
    this.tier = QUALITY_ORDER[(i + 1) % QUALITY_ORDER.length]!;
    this.apply();
    return this.tier;
  }

  set(tier: QualityTier): void {
    this.tier = tier;
    this.apply();
  }

  private apply(): void {
    const s = this.settings;
    this.renderer.shadowMap.enabled = s.shadowMapSize > 0;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, s.pixelRatioCap));
    // 阴影贴图尺寸要在光源上设，调用方拿 settings 自己设；
    // 这里只负责总开关，避免本类持有场景引用
  }

  /**
   * 把阴影贴图尺寸应用到一盏平行光。
   * 调用方在建光时调一次，切档时再调一次。
   */
  applyToLight(light: THREE.DirectionalLight): void {
    const size = this.settings.shadowMapSize;
    light.castShadow = size > 0;
    if (size > 0) {
      light.shadow.mapSize.set(size, size);
      light.shadow.map?.dispose();
      light.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
  }
}
