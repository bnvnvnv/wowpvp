/**
 * M12：地图纯装饰摆设的渲染（`MapDef.decor`）。
 *
 * ★★ **它只是画，不是判定。** 碰撞与视线的唯一真相仍是 `MapDef.geometry`
 *   （docs/06 §8.2「所见即所中」），sim 从不读 `decor` —— 所以数据侧的纪律是
 *   只摆「明显不挡路的小件」或「贴着真实碰撞体的大件」（见 MapDecorDef 注释）。
 *
 * ★ 整组按 `DECORATIVE_ROLES.foliage` 走画质裁剪 —— 14.4 原文允许减少的
 *   「环境叶片」档：低画质整组隐藏，中高画质显示。关键元素从不进这一组。
 *
 * ★ 素材缺失/加载失败 = 少摆一件，不报错不占位（M12 逐层兜底）。
 *   `?art=off` 时场景压根不构造本类。
 */

import * as THREE from 'three';
import type { MapDecorDef } from '@wowpvp/shared';
import { ModelLibrary } from '../entity/ModelLibrary.js';
import { isVisible, type QualityTier } from './quality.js';

export interface DecorStatus {
  /** 数据里登记了几件 */
  placed: number;
  /** 实际加载成功几件 */
  loaded: number;
  /** 当前画质下整组是否可见 */
  visible: boolean;
}

export class DecorRenderer {
  readonly group = new THREE.Group();
  private loaded = 0;
  private disposed = false;

  constructor(private readonly decor: readonly MapDecorDef[]) {
    this.group.name = 'map-decor';
    void this.load();
  }

  private async load(): Promise<void> {
    const lib = ModelLibrary.instance;
    if (!lib) return; // ?art=off：ModelLibrary 没 init，一件都不摆
    await Promise.all(this.decor.map(async (d) => {
      const g = await lib.sceneModel(d.model);
      if (!g || this.disposed) return;
      g.position.set(d.position.x, d.position.y, d.position.z);
      g.rotation.y = d.yaw ?? 0;
      if (d.scale !== undefined) g.scale.multiplyScalar(d.scale);
      this.group.add(g);
      this.loaded++;
    }));
  }

  /** 14.4：低画质隐藏整组（环境叶片档）。切档时由场景调一次 */
  applyQuality(tier: QualityTier): void {
    this.group.visible = isVisible('foliage', tier);
  }

  status(): DecorStatus {
    return { placed: this.decor.length, loaded: this.loaded, visible: this.group.visible };
  }

  dispose(): void {
    this.disposed = true;
  }
}
