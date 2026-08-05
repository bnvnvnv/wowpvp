/**
 * G4（技术债总账）第一铲：双场景共享的「壳」。
 *
 * 试验场与联网场景此前是 2779 行平行实现 —— renderer 构造、画质档、
 * 环境光、镜头、输入、resize 接线在两边逐字重复，改一处漏一处
 * （A13「切画质丢昼夜」就是这么来的）。这里收进来的只有**逐字相同**的
 * 基础设施；灯光（两场景数值刻意不同）、GameLoop（试验场带顿帧缩放）、
 * 实体渲染循环（第二铲）都不在此列 —— 判据是行为零变化。
 *
 * ★ 场景侧以 getter 转发（`private get renderer()` …），
 *   既保住既有引用点，也保证壳是唯一持有者，不存在双份状态。
 */

import * as THREE from 'three';
import { CameraController } from '../camera/CameraController.js';
import { ModelLibrary } from '../entity/ModelLibrary.js';
import { InputManager } from '../input/InputManager.js';
import { Environment } from '../render/Environment.js';
import { QualityController } from '../render/QualityController.js';
import { QualityTier } from '../render/quality.js';
import { artEnabled } from '../settings/artMode.js';
import { loadBindings } from '../settings/keybindings.js';
import type { DecorRenderer } from '../render/DecorRenderer.js';

export class SceneShell {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  /** ★ 17.1 三档画质。默认最高，F2 循环 —— 验收 #48 要逐档人工检查 */
  readonly quality: QualityController;
  /** M12：HDR 环境光与天空。★ 纯加法，见 Environment.ts 文件头 */
  readonly env: Environment;
  readonly cam: CameraController;
  readonly input: InputManager;
  /** M12：是否加载外部美术素材（`?art=off` 关闭）。见 settings/artMode.ts */
  readonly art = artEnabled();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // M12：HDR 环境是线性高动态的，不做色调映射会大面积过曝成白板。
    // ★ 与素材同开同关 —— ACES 会整体压暗，`art=off` 时开着就不再是 M11 的画面
    if (this.art) {
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.0;
    }
    this.quality = new QualityController(this.renderer, QualityTier.High);
    // M12：模型库（素材缺失或 ?art=off 时所有角色保留程序化胶囊体）
    if (this.art) ModelLibrary.init(this.renderer);

    this.scene.background = new THREE.Color(0x232a35);
    this.scene.fog = new THREE.Fog(0x232a35, 90, 160);
    // ★ 必须在设完 background 之后构造 —— Environment 捕获当时的背景色
    //   作为素材加载失败时的回落色
    this.env = new Environment(this.renderer, this.scene);

    this.cam = new CameraController(canvas.clientWidth / canvas.clientHeight);
    // W7：开局就套用持久化的键位（坏存档回落默认，见 keybindings.ts）——
    // 此前 InputManager 永远只吃 DEFAULT_BINDINGS，重绑无从谈起
    this.input = new InputManager(canvas, loadBindings(globalThis.localStorage));

    window.addEventListener('resize', this.onResize);
    this.onResize();
  }

  /**
   * 画质应用链 —— F2 与设置面板走**同一条**链（此前四处逐字重复，
   * 漏一环就是「面板改了没生效」；太阳与装饰由场景持有，作参数传入）。
   *
   * M12：低画质卸掉 IBL 与天空（14.4「可以减少非关键光照」），
   * 基础三盏灯不受影响 —— 关键元素在最低画质下仍然清楚可见（#48）；
   * 装饰摆设按「环境叶片」档裁剪（14.4）。这里**没有**任何
   * 「低画质就隐藏 X」的分支 —— 关键元素的可见性根本不经过画质档位。
   */
  setQualityTier(tier: QualityTier, sun: THREE.DirectionalLight, decor?: DecorRenderer): void {
    this.quality.set(tier);
    this.applyTier(tier, sun, decor);
  }

  /** F2 循环档位，走同一条应用链 */
  cycleQualityTier(sun: THREE.DirectionalLight, decor?: DecorRenderer): QualityTier {
    const tier = this.quality.cycle();
    this.applyTier(tier, sun, decor);
    return tier;
  }

  private applyTier(tier: QualityTier, sun: THREE.DirectionalLight, decor?: DecorRenderer): void {
    this.quality.applyToLight(sun);
    if (this.art) this.env.apply(tier);
    decor?.applyQuality(tier);
  }

  /** 鼠标事件 → NDC。射线拾取与地面瞄准共用的换算（此前四处重复）*/
  ndcFromMouse(ev: MouseEvent, out: THREE.Vector2): THREE.Vector2 {
    const rect = this.canvas.getBoundingClientRect();
    return out.set(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  private onResize = (): void => {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.cam.setAspect(w / h);
  };

  /** 只回收壳自己接的线；场景专属的（GameLoop、连接、canvas 点击）由场景收 */
  dispose(): void {
    this.input.dispose();
    window.removeEventListener('resize', this.onResize);
    this.env.dispose();
    this.renderer.dispose();
  }
}
