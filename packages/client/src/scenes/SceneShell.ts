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
import type { MapRenderer } from '../render/MapRenderer.js';
import { loadGraphics, saveGraphics, type GraphicsPreferences } from '../render/graphics.js';

export class SceneShell {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  /** 三档画质，真实美术默认中档并记住选择，F2 循环切换。 */
  readonly quality: QualityController;
  /** M12：HDR 环境光与天空。★ 纯加法，见 Environment.ts 文件头 */
  readonly env: Environment;
  readonly cam: CameraController;
  readonly input: InputManager;
  /** M12：是否加载外部美术素材（`?art=off` 关闭）。见 settings/artMode.ts */
  readonly art = artEnabled();
  graphics = loadGraphics();
  private resolutionRatio = 1;
  private frameAverage = 0;
  private lastRenderAt = 0;
  private lastResolutionChange = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    // X10 真机实测：双显卡笔记本上浏览器默认把 WebGL 分给省电核显，
    // 24 实体同屏 15fps；显式要高性能 GPU 后同机 33fps。不传这个参数
    // 等于把一半帧率白送掉。
    // ⚠️ X10 二轮：hp 提示只在 art 开着（真机档）时请求 —— ?art=off 是
    //   「软件渲染也要能跑」的验收档（m1–m13 全用它 + SwiftShader），那里
    //   没有第二块 GPU 可挑，提示零收益，还会在负载下间歇性建不出上下文
    //   （m13 重连步两页同时重建 renderer 时当场炸出）。真机不受影响。
    this.renderer = SceneShell.createRenderer(canvas, this.art);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // M12：HDR 环境是线性高动态的，不做色调映射会大面积过曝成白板。
    // Neutral 保留亮场景的色彩；调试材质不参与色调映射。
    if (this.art) {
      this.renderer.toneMapping = THREE.NeutralToneMapping;
      this.renderer.toneMappingExposure = 0.95;
    }
    this.quality = new QualityController(this.renderer, this.art ? this.graphics.quality : QualityTier.High);
    this.resolutionRatio = Math.min(devicePixelRatio, this.quality.settings.pixelRatioCap);
    // M12：模型库（素材缺失或 ?art=off 时所有角色保留程序化胶囊体）
    if (this.art) ModelLibrary.init(this.renderer);

    this.scene.background = new THREE.Color(this.art ? 0xbad6ea : 0x232a35);
    this.scene.fog = new THREE.Fog(this.art ? 0xbad6ea : 0x232a35, 90, 180);
    // ★ 必须在设完 background 之后构造 —— Environment 捕获当时的背景色
    //   作为素材加载失败时的回落色
    this.env = new Environment(this.renderer, this.scene);

    this.cam = new CameraController(canvas.clientWidth / canvas.clientHeight);
    this.cam.sensitivity = this.graphics.mouseSensitivity;
    // W7：开局就套用持久化的键位（坏存档回落默认，见 keybindings.ts）——
    // 此前 InputManager 永远只吃 DEFAULT_BINDINGS，重绑无从谈起
    this.input = new InputManager(canvas, loadBindings(globalThis.localStorage));

    window.addEventListener('resize', this.onResize);
    this.onResize();
  }

  /** 见构造函数头注 —— 真机档带高性能提示，创建失败回退默认参数再试一次 */
  private static createRenderer(canvas: HTMLCanvasElement, art: boolean): THREE.WebGLRenderer {
    if (art) {
      try {
        return new THREE.WebGLRenderer({
          canvas, antialias: true, powerPreference: 'high-performance',
        });
      } catch {
        // 双显卡真机上 hint 拿不到就回退默认 —— 有画面比有提示重要
      }
    }
    return new THREE.WebGLRenderer({ canvas, antialias: true });
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
  setQualityTier(tier: QualityTier, sun: THREE.DirectionalLight, decor?: DecorRenderer, map?: MapRenderer): void {
    this.quality.set(tier);
    this.applyTier(tier, sun, decor, map);
    this.setGraphics({ ...this.graphics, quality: tier });
  }

  /** F2 循环档位，走同一条应用链 */
  cycleQualityTier(sun: THREE.DirectionalLight, decor?: DecorRenderer, map?: MapRenderer): QualityTier {
    const tier = this.quality.cycle();
    this.applyTier(tier, sun, decor, map);
    this.setGraphics({ ...this.graphics, quality: tier });
    return tier;
  }

  private applyTier(tier: QualityTier, sun: THREE.DirectionalLight, decor?: DecorRenderer, map?: MapRenderer): void {
    this.quality.applyToLight(sun);
    if (this.art) this.env.apply(tier);
    decor?.applyQuality(tier);
    map?.applyQuality(tier);
  }

  setGraphics(next: GraphicsPreferences): void {
    this.graphics = next;
    this.cam.sensitivity = next.mouseSensitivity;
    saveGraphics(next);
    this.resolutionRatio = Math.min(devicePixelRatio, this.quality.settings.pixelRatioCap);
    this.frameAverage = this.lastRenderAt = 0;
    this.applyResolution();
  }

  /** Adjust only canvas resolution; HUD and gameplay markers remain intact. */
  render(): void {
    const now = performance.now();
    const ms = now - this.lastRenderAt;
    this.lastRenderAt = now;
    if (this.art && this.graphics.adaptiveResolution && ms > 0 && ms < 1000) {
      const sample = Math.min(ms, 100);
      this.frameAverage = this.frameAverage ? this.frameAverage * 0.95 + sample * 0.05 : sample;
      const budget = 1000 / this.graphics.frameRate;
      const sinceChange = now - this.lastResolutionChange;
      const next = this.frameAverage > budget * 1.25 && sinceChange > 2500
        ? Math.max(Math.min(0.75, devicePixelRatio), this.resolutionRatio - 0.125)
        : this.frameAverage < budget * 1.08 && sinceChange > 12000
          ? Math.min(devicePixelRatio, this.quality.settings.pixelRatioCap, this.resolutionRatio + 0.125) : this.resolutionRatio;
      if (next !== this.resolutionRatio) {
        this.resolutionRatio = next;
        this.lastResolutionChange = now;
        this.applyResolution();
      }
    }
    this.renderer.render(this.scene, this.cam.camera);
  }

  private applyResolution(): void {
    this.renderer.setPixelRatio(
      this.art && this.graphics.adaptiveResolution
        ? this.resolutionRatio : Math.min(devicePixelRatio, this.quality.settings.pixelRatioCap),
    );
  }

  /**
   * P10 / C7：底部常驻操作提示条（两场景共用）。
   *
   * ★ 为什么是**常驻**而不是开局两条日志：真机实测那两条 info 5 秒就被
   *   战斗日志顶掉，之后整局再没有任何地方提到 F10 —— 键位表藏在 F10 里、
   *   F10 只写在键位表里，玩家从这个环里出不来。
   * ★ 只有一条：重复调用改写内容而不追加，所以联网侧把 `#net-hint` 迁进来
   *   之后屏幕上也不会出现两条（C7 的存在意义就是这个）。
   * ⚠️ 收的是 HTML（键名要单独描重），⇒ 调用方负责转义自己拼进去的文本。
   */
  showHintBar(html: string): void {
    this.hintBar ??= this.createHintBar();
    this.hintBar.innerHTML = html;
  }

  private hintBar: HTMLElement | undefined;

  private createHintBar(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'hint-bar';
    // ★ 贴着屏幕最底边：技能栏下边缘在 18px，这一条占 1–14px 的空档，
    //   谁也不压谁；`pointer-events:none` 保证它永远不吃走一次点击
    Object.assign(el.style, {
      position: 'fixed', left: '50%', bottom: '1px', transform: 'translateX(-50%)',
      color: '#c8d2e0', font: '500 11px system-ui, sans-serif', lineHeight: '13px',
      whiteSpace: 'nowrap', textShadow: '0 1px 2px #000, 0 0 6px rgba(0,0,0,.85)',
      pointerEvents: 'none', zIndex: '25', opacity: '.72',
    } as Partial<CSSStyleDeclaration>);
    (this.canvas.parentElement ?? document.body).appendChild(el);
    return el;
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
    this.hintBar?.remove();
    window.removeEventListener('resize', this.onResize);
    this.env.dispose();
    this.renderer.dispose();
  }
}
