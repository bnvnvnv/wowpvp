/**
 * 选职业页的 3D 模型预览（docs/14 §M13：「模型预览（ModelLibrary 现成）」）。
 *
 * 一块小画布 + 慢速转台 + Idle 循环。素材层的老规矩（M12）：
 * 模型加载失败或 `?art=off` 时**如实缺席** —— 调用方把画布藏起来，
 * 卡片上的文字与技能图标照常，不摆一个假轮廓冒充模型。
 *
 * ★ 渲染循环只在选职业页可见时跑（show/stop 由 LobbyShell 调页面切换时机），
 *   大厅其他页面零 GPU 占用。
 */

import * as THREE from 'three';
import { GEOMETRY } from '@wowpvp/shared';
import { ModelLibrary } from '../entity/ModelLibrary.js';

/** 转台角速度，弧度/秒。慢到能看清正反面，快到不用等 */
const TURNTABLE_SPEED = 0.6;

export class ClassPreview {
  private renderer: THREE.WebGLRenderer | undefined;
  private readonly scene = new THREE.Scene();
  private readonly cam = new THREE.PerspectiveCamera(38, 1, 0.1, 30);
  private model: THREE.Group | undefined;
  private mixer: THREE.AnimationMixer | undefined;
  private raf = 0;
  private lastMs = 0;
  /** 在途加载的目标职业 —— 快速切换卡片时只认最后一次 */
  private wanted: string | undefined;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.scene.add(new THREE.HemisphereLight(0xbfd0e8, 0x39404f, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1.6, 3, 2.4);
    this.scene.add(key);
    // 取景框住整个角色：碰撞体高 2 米，镜头看向胸口
    this.cam.position.set(0, GEOMETRY.HITBOX_HEIGHT * 0.62, 3.1);
    this.cam.lookAt(0, GEOMETRY.HITBOX_HEIGHT * 0.52, 0);
  }

  /**
   * 展示某个职业的模型。返回是否**最终**摆上了模型 ——
   * false（素材缺失/加载失败）时调用方隐藏画布。
   */
  async show(classId: string): Promise<boolean> {
    this.wanted = classId;
    const lib = this.ensureRenderer();
    if (!lib) return false;

    const character = await lib.characterFor(classId);
    // 加载期间用户又点了别的卡片 —— 这份结果作废
    if (this.wanted !== classId) return this.model !== undefined;
    if (!character) return false;

    this.clearModel();
    this.model = character.root;
    // ModelLibrary 出厂时把模型转成面向 -Z（游戏里的「前方」）；
    // 预览镜头在 +Z，转回 0 让角色**开场面对镜头**，转台从脸开始转
    this.model.rotation.y = 0;
    this.scene.add(this.model);

    const idle = character.clips.find((c) => c.name === 'Idle') ?? character.clips[0];
    if (idle) {
      this.mixer = new THREE.AnimationMixer(this.model);
      this.mixer.clipAction(idle).play();
    }
    this.startLoop();
    return true;
  }

  /** 离开选职业页：停渲染循环（GPU 归零），模型留着下次直接续 */
  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  dispose(): void {
    this.stop();
    this.clearModel();
    this.renderer?.dispose();
    this.renderer = undefined;
  }

  /** 首次使用时才建 renderer（大厅可能全程用不到 —— art=off 或没进选职业页） */
  private ensureRenderer(): ModelLibrary | undefined {
    if (!this.renderer) {
      try {
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
        this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        this.renderer.setSize(this.canvas.clientWidth || 260, this.canvas.clientHeight || 320, false);
      } catch {
        return undefined; // WebGL 不可用 —— 与素材缺失同一种缺席方式
      }
    }
    return ModelLibrary.init(this.renderer);
  }

  private clearModel(): void {
    if (this.model) this.scene.remove(this.model);
    this.mixer?.stopAllAction();
    this.model = undefined;
    this.mixer = undefined;
  }

  private startLoop(): void {
    if (this.raf) return;
    this.lastMs = performance.now();
    const frame = (now: number): void => {
      this.raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - this.lastMs) / 1000);
      this.lastMs = now;
      if (this.model) this.model.rotation.y += dt * TURNTABLE_SPEED;
      this.mixer?.update(dt);
      this.renderer?.render(this.scene, this.cam);
    };
    this.raf = requestAnimationFrame(frame);
  }
}
