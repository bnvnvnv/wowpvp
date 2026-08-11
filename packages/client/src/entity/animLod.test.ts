/**
 * P4 骨骼动画分级。
 *
 * ★★ 这里钉死的是**一条不变量**，不是一组阈值：
 *   「喂给 mixer 的总时长 === 走过的总时长」。
 *   分频的错误写法（`if (frame % 2) return;`）在肉眼上不是「不动」而是
 *   「远处的人在放慢动作」—— 那种缺陷截图看不出、录屏也未必注意到，
 *   只有这条等式看得出来。阈值可以调，这条等式不能破。
 */

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

import { ANIM_LOD, AnimStride, animStrideFor } from './animLod.js';
import { AnimState } from './AnimationController.js';
import { CharacterView } from './CharacterView.js';
import { ModelLibrary, type CharacterModel } from './ModelLibrary.js';
import { EntityLod } from '../render/entityLod.js';

describe('animStrideFor：分级判据', () => {
  it('近处（≤12m）每帧推进 —— 贴身缠斗不许有任何降频', () => {
    expect(animStrideFor(0, true)).toBe(1);
    expect(animStrideFor(5, true)).toBe(1);
    expect(animStrideFor(ANIM_LOD.FULL_RATE_METERS, true)).toBe(1);
  });

  it('中距（12–25m）半频、远距（>25m）三分频', () => {
    expect(animStrideFor(ANIM_LOD.FULL_RATE_METERS + 0.01, true)).toBe(2);
    expect(animStrideFor(ANIM_LOD.HALF_RATE_METERS, true)).toBe(2);
    expect(animStrideFor(ANIM_LOD.HALF_RATE_METERS + 0.01, true)).toBe(3);
    expect(animStrideFor(200, true)).toBe(3);
  });

  it('★ 视锥外一律不推进 —— 哪怕人贴在脸上（背后 0.5 米也是背后）', () => {
    expect(animStrideFor(0.5, false)).toBe(ANIM_LOD.OFFSCREEN_STRIDE);
    expect(animStrideFor(100, false)).toBe(ANIM_LOD.OFFSCREEN_STRIDE);
  });
});

describe('AnimStride：★★ 攒帧不丢帧', () => {
  /** 60fps 的一帧 */
  const DT = 1 / 60;

  it.each([1, 2, 3])('stride=%i：喂进去的总时长 === 走过的总时长', (stride) => {
    const s = new AnimStride();
    let fed = 0;
    let walked = 0;
    // 600 帧 = 10 秒；取 stride 的整数倍帧数，收尾时不该有欠账
    const frames = 600;
    for (let i = 0; i < frames; i++) {
      walked += DT;
      const owed = s.feed(DT, stride);
      if (owed !== undefined) fed += owed;
    }
    expect(frames % stride).toBe(0); // 前提：600 是 1/2/3 的整数倍
    expect(s.owed).toBe(0);
    expect(fed).toBeCloseTo(walked, 10);
  });

  it('★ 不整除时差额恰好是「还攒着的那点」，一秒都没丢', () => {
    const s = new AnimStride();
    let fed = 0;
    let walked = 0;
    for (let i = 0; i < 100; i++) { // 100 不是 3 的倍数
      walked += DT;
      const owed = s.feed(DT, 3);
      if (owed !== undefined) fed += owed;
    }
    expect(fed + s.owed).toBeCloseTo(walked, 10);
    expect(s.owed).toBeGreaterThan(0);
  });

  it('★ 变步长（掉帧）同样成立 —— 攒的是时间不是帧数', () => {
    const s = new AnimStride();
    const dts = [0.016, 0.033, 0.008, 0.120, 0.016, 0.016];
    let fed = 0;
    for (const dt of dts) {
      const owed = s.feed(dt, 2);
      if (owed !== undefined) fed += owed;
    }
    expect(fed + s.owed).toBeCloseTo(dts.reduce((a, b) => a + b, 0), 10);
  });

  it('半频下每两帧才喂一次，且喂的是两帧的和', () => {
    const s = new AnimStride();
    expect(s.feed(DT, 2)).toBeUndefined();
    expect(s.feed(DT, 2)).toBeCloseTo(DT * 2, 10);
  });

  it('★ dt=0 仍然喂 0 而不是「不喂」—— 暂停帧两条路要一致', () => {
    const s = new AnimStride();
    expect(s.feed(0, 1)).toBe(0);
  });

  it('★ 视锥外攒的时长封顶，回到画面里不会一次追赶几十秒', () => {
    const s = new AnimStride();
    for (let i = 0; i < 60 * 40; i++) s.feed(DT, ANIM_LOD.OFFSCREEN_STRIDE); // 40 秒
    expect(s.owed).toBe(ANIM_LOD.OFFSCREEN_CATCHUP_CAP);
    // 回到视野里：第一帧就把攒着的（封顶后的）一次喂出去
    expect(s.feed(DT, 1)).toBeCloseTo(ANIM_LOD.OFFSCREEN_CATCHUP_CAP + DT, 10);
  });
});

describe('EntityLod：镜头取样', () => {
  const camera = (): THREE.PerspectiveCamera => {
    const c = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
    c.position.set(0, 2, 0);
    c.lookAt(0, 2, -10); // 朝 -Z 看
    return c;
  };

  it('正前方近处 → 每帧；正前方远处 → 三分频', () => {
    const lod = new EntityLod();
    lod.beginFrame(camera());
    expect(lod.strideFor({ x: 0, y: 0, z: -5 })).toBe(1);
    expect(lod.strideFor({ x: 0, y: 0, z: -40 })).toBe(3);
  });

  it('★ 背后的人不推进骨骼（哪怕只有 8 米）', () => {
    const lod = new EntityLod();
    lod.beginFrame(camera());
    expect(lod.strideFor({ x: 0, y: 0, z: 8 })).toBe(ANIM_LOD.OFFSCREEN_STRIDE);
  });

  it('★ 没调 beginFrame 时一律全速 —— 出错的方向永远是「多算」', () => {
    expect(new EntityLod().strideFor({ x: 0, y: 0, z: 999 })).toBe(1);
  });
});

// ── CharacterView 侧：分级真的接到了 mixer 上 ─────────────────────

/** 与 CharacterView.test.ts 同一套合成骨架（那边的注释解释了为什么这样够用）*/
const makeRig = (): THREE.Group => {
  const root = new THREE.Group();
  const hips = new THREE.Bone(); hips.name = 'hips';
  const spine = new THREE.Bone(); spine.name = 'spine';
  const chest = new THREE.Bone(); chest.name = 'chest';
  hips.add(spine); spine.add(chest);
  root.add(hips);
  root.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 2, 0.5), new THREE.MeshStandardMaterial()));
  return root;
};

const clipOf = (name: string, duration: number): THREE.AnimationClip => {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.5);
  return new THREE.AnimationClip(name, duration, [
    new THREE.QuaternionKeyframeTrack('chest.quaternion', [0, duration], [0, 0, 0, 1, q.x, q.y, q.z, q.w]),
  ]);
};

const mountView = async (): Promise<CharacterView> => {
  const model: CharacterModel = {
    root: makeRig(),
    clips: [clipOf('Idle', 1), clipOf('Running_A', 0.8)],
    handR: undefined, handL: undefined,
  } as unknown as CharacterModel;
  const lib = { characterFor: () => Promise.resolve(model) } as unknown as ModelLibrary;
  Object.defineProperty(ModelLibrary, 'instance', { value: lib, configurable: true });
  const view = new CharacterView('mage');
  await Promise.resolve();
  await Promise.resolve();
  return view;
};

describe('CharacterView.update(dt, stride)', () => {
  it('★★ 三分频下 mixer 收到的总时长 === 走过的总时长（不是慢动作）', async () => {
    const view = await mountView();
    const spy = vi.spyOn(THREE.AnimationMixer.prototype, 'update');
    spy.mockClear();

    const DT = 1 / 60;
    const frames = 90; // 1.5 秒，是 3 的倍数
    for (let i = 0; i < frames; i++) view.update(DT, 3);

    const fed = spy.mock.calls.reduce((s, c) => s + (c[0] as number), 0);
    expect(spy).toHaveBeenCalledTimes(frames / 3);
    expect(fed).toBeCloseTo(DT * frames, 10);
    spy.mockRestore();
  });

  it('★ 不传 stride 时逐帧推进 —— 默认路径与分级之前逐字相同', async () => {
    const view = await mountView();
    const spy = vi.spyOn(THREE.AnimationMixer.prototype, 'update');
    spy.mockClear();
    for (let i = 0; i < 10; i++) view.update(0.016);
    expect(spy).toHaveBeenCalledTimes(10);
    spy.mockRestore();
  });

  it('★ 视锥外一次都不推进 mixer（位置仍由 setTransform 负责，与骨骼无关）', async () => {
    const view = await mountView();
    view.setAnimState(AnimState.Run);
    const spy = vi.spyOn(THREE.AnimationMixer.prototype, 'update');
    spy.mockClear();
    for (let i = 0; i < 30; i++) view.update(0.016, ANIM_LOD.OFFSCREEN_STRIDE);
    expect(spy).not.toHaveBeenCalled();
    // 位置通道不受影响
    view.setTransform({ x: 3, y: 0, z: -4 }, 1.2);
    expect(view.group.position.x).toBe(3);
    expect(view.group.position.z).toBe(-4);
    spy.mockRestore();
  });

  it('★ 分级不影响摇头的每帧相位（跳过 mixer 的帧照样在晃）', async () => {
    const view = await mountView();
    view.setStunned(true);
    for (let i = 0; i < 10; i++) view.update(0.016, 3);
    expect(view.stunWobbleWeight).toBeGreaterThan(0);
  });
});
