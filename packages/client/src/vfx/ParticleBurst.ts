/**
 * M12（14.2）：卡通风格的加法粒子爆发，有界池化。
 *
 * ★★ **可爱卡通的观感全在参数里，不在贴图里：**
 *   · 粒子**先胀后消**（`pop()` 从 0 弹到 1 再回落）—— 糖果般的「Q 弹」，不是写实衰减
 *   · **双色**：一半 `primary` 核 + 一半 `secondary` 边，高饱和
 *   · 大而圆润的软点，加法混合发光
 *   由 `SpellVfx` 按属性喂不同的贴图与运动倾向（火/圣上浮、毒/尘下坠、自然/奥术带旋）。
 *
 * ★★ **为什么池化：** 试验场里技能爆发很密（假人一直在读条命中），
 *   每次 `new Points` + `new BufferGeometry` 会在几秒内制造上百个待 GC 的对象，
 *   造成周期性掉帧。这里预建固定数量的 `Burst`，`emit` 复用、池满回收最旧的 ——
 *   分配只发生一次，稳态零 GC。
 *
 * ★ 逐层兜底：贴图为 null（加载失败或 `?art=off` 之外的缺图）时用程序化软圆点，
 *   属性颜色照旧，只是少了纹样。
 */

import * as THREE from 'three';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** 一次爆发的参数。缺省值在 `Burst.emit` 里补齐 */
export interface BurstOptions {
  origin: Vec3Like;
  /** 粒子数（会被 clamp 到单个 Burst 的容量）*/
  count: number;
  /** 主色 / 辅色（16 进制，如 0xff8a4c）*/
  primary: number;
  secondary: number;
  /** 主贴图；null 时退回程序化软圆点 */
  texture: THREE.Texture | null;
  /** 初速大小（米/秒），实际方向按 spread 分布 */
  speed?: number;
  /** 'sphere' 向四周（命中/释放），'disc' 贴地向外（地面区域）*/
  spread?: 'sphere' | 'disc';
  /** 竖直加速度：正=上浮（火/圣），负=下坠（毒/尘）*/
  gravity?: number;
  /** 速度阻尼系数（每秒衰减比例）*/
  drag?: number;
  /** 切向初速：让粒子绕 origin 旋（自然/奥术）*/
  swirl?: number;
  /** 基础点大小（世界尺度近似）*/
  size?: number;
  /** 大小抖动比例 0..1 */
  sizeJitter?: number;
  /** 寿命（秒）*/
  life?: number;
  /** 整体不透明度上限（近镜头降透明时由 SpellVfx 压低）*/
  opacity?: number;
}

/**
 * 单个爆发的粒子数上限。
 * ★ 这是**默认值**，不是硬上限：细流池（拖尾/地面填充/蓄力）用更小的每格容量，
 *   同样的显存换更多并发格子 —— 见 `BurstPool` 的 `particleCap`。
 */
const MAX_PARTICLES = 48;

/** 先胀后消：t∈[0,1] → 0→1→0，起手略大好让 pop 立刻可见 */
const pop = (t: number): number => Math.sin(Math.min(1, Math.max(0, t)) * Math.PI);

/**
 * 顶点着色器：per-particle 大小 + alpha + 颜色。
 * 手动做 sizeAttenuation（`uScale / -z`），不依赖 PointsMaterial 的单一 size。
 */
const VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aAlpha;
  uniform float uScale;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * uScale / max(0.001, -mv.z), 0.0, 320.0);
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * 片元着色器：有贴图用贴图，无贴图用软圆点。加法混合，alpha 即亮度权重。
 */
const FRAG = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uUseMap;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float mask;
    if (uUseMap > 0.5) {
      mask = texture2D(uTexture, gl_PointCoord).r;
    } else {
      float d = length(gl_PointCoord - vec2(0.5));
      mask = smoothstep(0.5, 0.0, d);
    }
    gl_FragColor = vec4(vColor * mask * vAlpha, mask * vAlpha);
  }
`;

/** 单个可复用的爆发。持一个 THREE.Points 与固定容量的属性缓冲 */
class Burst {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;
  private readonly alphaAttr: THREE.BufferAttribute;

  // per-particle 运行时状态（不进 GPU）
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly baseSize: Float32Array;

  /** 本格的粒子容量。emit 的 count 超过它会被静默钳下来 */
  private readonly capacity: number;
  private count = 0;
  private gravity = 0;
  private drag = 0;
  private opacity = 1;
  /** 复用回收用：越大越新 */
  bornAt = 0;
  alive = false;

  constructor(capacity = MAX_PARTICLES) {
    this.capacity = Math.max(1, Math.floor(capacity));
    const cap = this.capacity;
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.baseSize = new Float32Array(cap);

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(cap * 3), 3);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(cap * 3), 3);
    this.sizeAttr = new THREE.BufferAttribute(new Float32Array(cap), 1);
    this.alphaAttr = new THREE.BufferAttribute(new Float32Array(cap), 1);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr.setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aColor', this.colAttr);
    geo.setAttribute('aSize', this.sizeAttr);
    geo.setAttribute('aAlpha', this.alphaAttr);
    geo.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTexture: { value: null },
        uUseMap: { value: 0 },
        uScale: { value: 520 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false; // 爆发短暂且包围盒不更新，别被误剔除
    this.points.renderOrder = 6;
    this.points.visible = false;
  }

  setScale(uScale: number): void {
    this.material.uniforms.uScale!.value = uScale;
  }

  emit(o: BurstOptions, now: number): void {
    const n = Math.min(this.capacity, Math.max(1, Math.floor(o.count)));
    const speed = o.speed ?? 3.2;
    const spread = o.spread ?? 'sphere';
    const swirl = o.swirl ?? 0;
    const size = o.size ?? 0.5;
    const sizeJitter = o.sizeJitter ?? 0.5;
    const life = o.life ?? 0.55;
    const primary = new THREE.Color(o.primary);
    const secondary = new THREE.Color(o.secondary);

    this.count = n;
    this.gravity = o.gravity ?? 0;
    this.drag = o.drag ?? 2.2;
    this.opacity = o.opacity ?? 1;
    this.bornAt = now;
    this.alive = true;

    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      // 从 origin 的一个小球内出发，避免所有粒子叠在一个点
      const jitter = 0.12;
      this.posAttr.array[i3] = o.origin.x + (Math.random() - 0.5) * jitter;
      this.posAttr.array[i3 + 1] = o.origin.y + (Math.random() - 0.5) * jitter;
      this.posAttr.array[i3 + 2] = o.origin.z + (Math.random() - 0.5) * jitter;

      // 方向
      let dx: number, dy: number, dz: number;
      if (spread === 'disc') {
        const a = Math.random() * Math.PI * 2;
        dx = Math.cos(a);
        dy = 0.15 + Math.random() * 0.35; // 略微上飘
        dz = Math.sin(a);
      } else {
        // 单位球面近似
        const a = Math.random() * Math.PI * 2;
        const z = Math.random() * 2 - 1;
        const r = Math.sqrt(1 - z * z);
        dx = Math.cos(a) * r;
        dy = z * 0.7 + 0.3; // 略偏上，爆发更「开」
        dz = Math.sin(a) * r;
      }
      const sp = speed * (0.55 + Math.random() * 0.9);
      // 切向分量（swirl）：绕竖直轴
      const tx = -dz * swirl;
      const tz = dx * swirl;
      this.vel[i3] = dx * sp + tx;
      this.vel[i3 + 1] = dy * sp;
      this.vel[i3 + 2] = dz * sp + tz;

      /**
       * 双色：偶数取主色、奇数取辅色。
       * ★ 颜色**只在这里写一次** —— 它在粒子存活期间不变，
       *   放进 `writeFrame()` 会让整条 color 缓冲每帧重传一次 GPU，白花带宽。
       */
      const c = i % 2 === 0 ? primary : secondary;
      this.colAttr.array[i3] = c.r;
      this.colAttr.array[i3 + 1] = c.g;
      this.colAttr.array[i3 + 2] = c.b;

      this.baseSize[i] = size * (1 - sizeJitter + Math.random() * sizeJitter * 2);
      const lf = life * (0.7 + Math.random() * 0.6);
      this.life[i] = lf;
      this.maxLife[i] = lf;
    }

    const geo = this.points.geometry as THREE.BufferGeometry;
    geo.setDrawRange(0, n);
    this.material.uniforms.uTexture!.value = o.texture;
    this.material.uniforms.uUseMap!.value = o.texture ? 1 : 0;
    this.points.visible = true;
    this.colAttr.needsUpdate = true;
    this.writeFrame();
  }

  /** 推进一帧；返回是否仍存活 */
  update(dt: number): boolean {
    if (!this.alive) return false;
    let anyAlive = false;
    const dragFactor = Math.max(0, 1 - this.drag * dt);
    for (let i = 0; i < this.count; i++) {
      if (this.life[i]! <= 0) continue;
      this.life[i]! -= dt;
      if (this.life[i]! <= 0) continue;
      anyAlive = true;
      const i3 = i * 3;
      this.vel[i3 + 1]! += this.gravity * dt;
      this.vel[i3]! *= dragFactor;
      this.vel[i3 + 1]! *= dragFactor;
      this.vel[i3 + 2]! *= dragFactor;
      this.posAttr.array[i3]! += this.vel[i3]! * dt;
      this.posAttr.array[i3 + 1]! += this.vel[i3 + 1]! * dt;
      this.posAttr.array[i3 + 2]! += this.vel[i3 + 2]! * dt;
    }
    if (!anyAlive) {
      this.alive = false;
      this.points.visible = false;
      return false;
    }
    this.writeFrame();
    return true;
  }

  /** 把当前 life 折算成 size/alpha 并推给 GPU（颜色不在这里，见 emit）*/
  private writeFrame(): void {
    for (let i = 0; i < this.count; i++) {
      const lf = this.life[i]!;
      if (lf <= 0) {
        this.sizeAttr.array[i] = 0;
        this.alphaAttr.array[i] = 0;
        continue;
      }
      const t = 1 - lf / this.maxLife[i]!;
      const p = pop(t);
      this.sizeAttr.array[i] = this.baseSize[i]! * (0.35 + 0.65 * p);
      this.alphaAttr.array[i] = p * this.opacity;
    }
    this.posAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * 单张贴图的一次性闪光（刀光 / 免疫白闪）。
 *
 * ★ 为什么不并进 `Burst`：`gl_PointCoord` 没有旋转 —— Points 粒子的贴图
 *   永远正着贴，而**刀光必须随机角度**，每次都同一个方向立刻穿帮。
 *   Sprite 的 `material.rotation` 正是干这个的，所以刀光走一个小 Sprite 池。
 */
export class FlashPool {
  readonly group = new THREE.Group();
  private readonly items: {
    sprite: THREE.Sprite;
    mat: THREE.SpriteMaterial;
    life: number;
    maxLife: number;
    size: number;
    /** 生命末端的展开倍数（起点恒 0.55）。刀光 1.2；冲击波环给 3+ */
    grow: number;
  }[] = [];

  constructor(capacity = 12) {
    this.group.name = 'spell-vfx-flashes';
    for (let i = 0; i < capacity; i++) {
      const mat = new THREE.SpriteMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 7;
      this.group.add(sprite);
      this.items.push({ sprite, mat, life: 0, maxLife: 1, size: 1, grow: 1.2 });
    }
  }

  emit(o: {
    origin: Vec3Like;
    /** null = 贴图缺失。闪光是点缀，主爆发仍在 —— 直接跳过，不画一个空白方块 */
    texture: THREE.Texture | null;
    color: number;
    size?: number;
    life?: number;
    /** 弧度。刀光每次给随机值 */
    rotation?: number;
    /**
     * 生命末端的展开倍数。默认 1.2 = 原刀光行为（0.55 → 1.2）；
     * 冲击波环给 3.8 —— 同一个池、同一批贴图，只是长得更开
     */
    grow?: number;
  }): void {
    if (!o.texture) return;
    let slot = this.items.find((i) => i.life <= 0);
    if (!slot) slot = this.items.reduce((a, b) => (a.life < b.life ? a : b));
    slot.mat.map = o.texture;
    slot.mat.color.set(o.color);
    slot.mat.rotation = o.rotation ?? 0;
    slot.size = o.size ?? 1;
    slot.grow = o.grow ?? 1.2;
    slot.maxLife = slot.life = o.life ?? 0.22;
    slot.sprite.position.set(o.origin.x, o.origin.y, o.origin.z);
    slot.sprite.scale.setScalar(slot.size * 0.55);
    slot.sprite.visible = true;
  }

  update(dt: number): void {
    for (const it of this.items) {
      if (it.life <= 0) continue;
      it.life -= dt;
      if (it.life <= 0) {
        it.sprite.visible = false;
        it.mat.opacity = 0;
        continue;
      }
      const t = 1 - it.life / it.maxLife;
      // 只展开不回缩：刀光读作「划过」，回缩会读作「吸回去」
      it.mat.opacity = pop(t);
      it.sprite.scale.setScalar(it.size * (0.55 + (it.grow - 0.55) * t));
    }
  }

  /** 当前存活的闪光数（供自检）*/
  get activeCount(): number {
    return this.items.filter((i) => i.life > 0).length;
  }

  dispose(): void {
    for (const it of this.items) it.mat.dispose();
  }
}

/**
 * 有界爆发池。全部 Burst 一次性 add 进 `group`，emit 只是复用其中一个。
 *
 * ★★ **两个参数是两种用法**：
 *   · `capacity` = 并发格子数 —— 同时能有多少发爆发在场
 *   · `particleCap` = 每格粒子上限 —— 一发爆发最多多密
 *
 *   事件型（命中/释放/死亡）要**密而少**：48 粒 × 32 格。
 *   持续型（拖尾/地面填充/蓄力）要**稀而多**：24 粒 × 40 格 ——
 *   它们本来就是每隔几十毫秒撒一小簇，密度靠频率而不是靠单簇粒子数。
 *
 *   ⚠️ 两者混在一个池里的后果实测过：拖尾每帧每弹体各占一格，
 *   24 发在飞时 60fps 下每秒申请 1440 次 emit，32 格的池被自己刷空 ——
 *   玩家看到的是「拖尾很稀」和「命中爆发时有时无」，而参数明明写着不稀。
 */
export class BurstPool {
  readonly group = new THREE.Group();
  private readonly bursts: Burst[] = [];
  private clock = 0;

  constructor(capacity = 24, particleCap = MAX_PARTICLES) {
    this.group.name = 'spell-vfx-bursts';
    for (let i = 0; i < capacity; i++) {
      const b = new Burst(particleCap);
      this.bursts.push(b);
      this.group.add(b.points);
    }
  }

  /** 世界坐标像素尺度（由 SpellVfx 从视口/相机推来），影响点的透视缩放 */
  setScale(uScale: number): void {
    for (const b of this.bursts) b.setScale(uScale);
  }

  emit(o: BurstOptions): void {
    // 找一个空闲的，否则回收最旧的
    let target = this.bursts.find((b) => !b.alive);
    if (!target) {
      target = this.bursts.reduce((oldest, b) => (b.bornAt < oldest.bornAt ? b : oldest));
    }
    target.emit(o, this.clock);
  }

  update(dt: number): void {
    this.clock += dt;
    for (const b of this.bursts) b.update(dt);
  }

  /** 当前存活的爆发数（供自检）*/
  get activeCount(): number {
    return this.bursts.filter((b) => b.alive).length;
  }

  dispose(): void {
    for (const b of this.bursts) b.dispose();
  }
}
