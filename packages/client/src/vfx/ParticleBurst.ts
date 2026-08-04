/**
 * M12（14.2）：卡通风格的加法粒子爆发，有界池化。
 *
 * ★★ **可爱卡通的观感全在参数里，不在贴图里：**
 *   · 粒子**先胀后消且带回弹**（`popSize()` 冲过 1 再收回）—— 糖果般的「Q 弹」，
 *     不是写实衰减。不透明度走另一条不带过冲的曲线（`popAlpha()`），理由见那里
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
  /**
   * 生成范围的**水平半径**（米）。默认 0.06（一小簇）。
   *
   * ★★ 天气类填充（暴风雪的雪、毒云的雾）必须给它一个真实的区域半径：
   *   一次 emit 的粒子若全挤在 0.12 米的小盒里，读作「地上有两团东西」
   *   而不是「这一片在下雪」。而把一片区域拆成十几次小 emit 又会把
   *   池槽吃光 —— 用一次大范围 emit 覆盖整片，是唯一同时满足两边的写法。
   */
  originRadius?: number;
}

/**
 * 单个爆发的粒子数上限。
 * ★ 这是**默认值**，不是硬上限：细流池（拖尾/地面填充/蓄力）用更小的每格容量，
 *   同样的显存换更多并发格子 —— 见 `BurstPool` 的 `particleCap`。
 */
const MAX_PARTICLES = 48;

/**
 * 不透明度曲线：先亮后灭，t∈[0,1] → 0→1→0。
 *
 * ★★ **这条曲线不许带 overshoot。** alpha 的物理上限就是 1，冲过头会被
 *   截断成一段平顶 —— 观感上是「亮度卡住了一会儿」，不是「弹了一下」，
 *   反而比原来更糊。回弹只属于尺寸通道，见 `popSize`。
 */
export const popAlpha = (t: number): number =>
  Math.sin(Math.min(1, Math.max(0, t)) * Math.PI);

/** 尺寸曲线的过冲峰值与到达峰值的时刻 */
const POP_PEAK = 1.2;
const POP_ATTACK = 0.22;

/**
 * 尺寸曲线：**猛攻 + 回落**的 Q 弹，t∈[0,1] → 0 →冲到 1.2→ 一路收回 → 0。
 *
 * ★★ Q 版基调（docs/10 偏差 #6）的核心识别特征就是这一下**过冲**：
 *   写实风格里粒子胀到最大就该开始衰减，而卡通里它会先冲过头再收回来 ——
 *   这是「弹性」在二维上唯一的表达方式。
 *
 * ★ 为什么值得单独写一条曲线：它是**零成本**的夸张 ——
 *   不增加任何粒子、任何 drawcall、任何贴图，纯算术，
 *   却让全部爆发（命中/释放/死亡/破盾/拖尾/地面/蓄力）一起有了弹性。
 *
 * ★★ **不要用「在 sin 上叠一个过冲项」的写法**（第一版就是那么写的）：
 *   `sin(πt)` 要到 t=0.5 才够到 1，而过冲项必须在前段就衰减掉，
 *   两者的窗口根本不重叠 —— 实测峰值只有 **1.0095**，
 *   肉眼完全看不出来，等于白写。这里改成显式的两段：
 *     · 前 22%：easeOutCubic 冲到 1.2（起手极快，一眼看见「炸开」）
 *     · 后 78%：按 (1-u)^0.9 收回到 0（比线性慢，粒子不会一闪就没）
 */
export const popSize = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  if (x < POP_ATTACK) {
    const p = x / POP_ATTACK;
    return POP_PEAK * (1 - (1 - p) ** 3); // easeOutCubic
  }
  const u = (x - POP_ATTACK) / (1 - POP_ATTACK);
  return POP_PEAK * (1 - u) ** 0.9;
};

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

    // 水平生成半径：默认一小簇；天气类填充传区域半径，一次覆盖整片
    const originRadius = Math.max(0.06, o.originRadius ?? 0.06);
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      // ★ sqrt 修正：不修正的话粒子会朝圆心堆积，边缘看着比中心稀
      const rr = originRadius * Math.sqrt(Math.random());
      const ra = Math.random() * Math.PI * 2;
      this.posAttr.array[i3] = o.origin.x + Math.cos(ra) * rr;
      // 竖直方向仍只做小抖动 —— 生成**高度**由调用方的 origin.y 决定
      this.posAttr.array[i3 + 1] = o.origin.y + (Math.random() - 0.5) * 0.12;
      this.posAttr.array[i3 + 2] = o.origin.z + Math.sin(ra) * rr;

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
      // ★ 两条曲线：尺寸带回弹（Q 弹），不透明度不带（见 popAlpha 的注释）
      this.sizeAttr.array[i] = this.baseSize[i]! * (0.35 + 0.65 * popSize(t));
      this.alphaAttr.array[i] = popAlpha(t) * this.opacity;
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
      // ★ 这里用 popAlpha（不带回弹）：闪光的 scale 是刻意的单向展开，
      //   给它叠过冲会变成「弹回来一下」，正是上一行注释要避免的观感
      it.mat.opacity = popAlpha(t);
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
 *   事件型（命中/释放/死亡）要**密而少**：48 粒 × 40 格。
 *   持续型（拖尾/地面填充/蓄力）要**稀而多**：32 粒 × 48 格 ——
 *   它们本来就是每隔几十毫秒撒一小簇，密度靠频率而不是靠单簇粒子数。
 *   ★ 数字以 `SpellVfx.ts` 的构造参数为准（三期把事件池 32 → 40 格，
 *     本注释当时没跟上 —— A15）；持续型的 48 格是预算和，有单测钉着。
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
