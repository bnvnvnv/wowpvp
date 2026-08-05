/**
 * W14 上半身分层的核心算法（无 GPU）。
 *
 * ★ three.js 的骨架/clip/mixer 是纯数学 —— 可以用**合成骨架**在 Node 里
 *   验证「上半身叠加施法、腿只跑步」这条不变量，不需要真机截图。
 *   真机的观感（Synty 骨架上自然不自然）是接线之后的事，那条留给截图。
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  buildUpperBodyAdditive,
  findUpperBodyRoot,
  maskClipToBones,
  subtreeBoneNames,
  trackBoneName,
} from './animLayer.js';

/**
 * 合成人形骨架 —— **骨骼名与真 GLB 一致**（`hips/spine/chest/upperarm.r/
 * upperleg.l`，从 barbarian.glb / druid.glb 逐一核对）。这不只是「代表性」，
 * 是照着生产骨架的**实际结构**建：脊柱与腿都挂在 hips 下、互为兄弟，
 * 于是「取 spine 子树 = 上半身、不含腿」在真模型上同样成立。
 */
const makeSkeleton = () => {
  const hips = new THREE.Bone(); hips.name = 'hips';
  const spine = new THREE.Bone(); spine.name = 'spine';
  const chest = new THREE.Bone(); chest.name = 'chest';
  const armR = new THREE.Bone(); armR.name = 'upperarm.r';
  const thighL = new THREE.Bone(); thighL.name = 'upperleg.l';
  hips.add(spine); spine.add(chest); chest.add(armR);
  hips.add(thighL);
  return { hips, spine, chest, armR, thighL, bones: [hips, spine, chest, armR, thighL] };
};

/** 一条只动某骨骼 quaternion 的 clip（绕 Z 转 angle）*/
const quatClip = (name: string, boneName: string, angle: number): THREE.AnimationClip => {
  const q0 = new THREE.Quaternion();
  const q1 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle);
  const track = new THREE.QuaternionKeyframeTrack(
    `${boneName}.quaternion`, [0, 1],
    [q0.x, q0.y, q0.z, q0.w, q1.x, q1.y, q1.z, q1.w],
  );
  return new THREE.AnimationClip(name, 1, [track]);
};

describe('W14 骨骼名解析', () => {
  it('★ 取最后一个点之前 —— 骨骼名自己带点（handslot.r）也不被劈开', () => {
    expect(trackBoneName('handslot.r.quaternion')).toBe('handslot.r');
    expect(trackBoneName('spine.position')).toBe('spine');
    expect(trackBoneName('upperleg.l.scale')).toBe('upperleg.l');
    expect(trackBoneName('bareName')).toBe('bareName');
  });
});

describe('W14 上半身根与遮罩', () => {
  it('★★ 上半身根取脊柱（不是 hips）—— 子树含手臂、不含腿', () => {
    const sk = makeSkeleton();
    const root = findUpperBodyRoot(sk.bones);
    expect(root?.name).toBe('spine');
    const names = subtreeBoneNames(root!);
    expect(names.has('upperarm.r')).toBe(true);
    expect(names.has('chest')).toBe(true);
    expect(names.has('upperleg.l'), '腿被算进了上半身 —— 叠加时会做两遍').toBe(false);
    expect(names.has('hips'), 'hips 是上半身根的父级，不该在子树里').toBe(false);
  });

  it('★ 找不到脊柱 → undefined（调用方安全回落，不 T-pose）', () => {
    const a = new THREE.Bone(); a.name = 'root';
    const b = new THREE.Bone(); b.name = 'leg'; a.add(b);
    expect(findUpperBodyRoot([a, b])).toBeUndefined();
  });

  it('★★ 遮罩把腿的轨道剔掉、留手臂的轨道', () => {
    const sk = makeSkeleton();
    const cast = new THREE.AnimationClip('cast', 1, [
      quatClip('_', 'upperarm.r', 1).tracks[0]!,
      quatClip('_', 'upperleg.l', 1).tracks[0]!,
    ]);
    const masked = maskClipToBones(cast, subtreeBoneNames(findUpperBodyRoot(sk.bones)!));
    const boneNames = masked.tracks.map((t) => trackBoneName(t.name));
    expect(boneNames).toContain('upperarm.r');
    expect(boneNames).not.toContain('upperleg.l');
  });
});

describe('W14 叠加混合：腿跑步、手施法', () => {
  it('★★ locomotion 驱动腿；叠加的上半身施法只动手臂', () => {
    const sk = makeSkeleton();
    // 让骨架进 mixer 需要一个 root Object3D
    const rig = new THREE.Object3D();
    rig.add(sk.hips);

    const runClip = quatClip('run', 'upperleg.l', 1.2);       // 跑步：动腿
    const castClip = new THREE.AnimationClip('cast', 1, [
      quatClip('_', 'upperarm.r', 1.0).tracks[0]!,           // 施法：动手臂
      quatClip('_', 'upperleg.l', 0.9).tracks[0]!,              // ★ 也动了腿 —— 遮罩要挡掉
    ]);

    const additive = buildUpperBodyAdditive(castClip, sk.bones);
    expect(additive, '没造出叠加 clip').toBeDefined();

    const mixer = new THREE.AnimationMixer(rig);
    const base = mixer.clipAction(runClip);
    base.play();
    const upper = mixer.clipAction(additive!, undefined, THREE.AdditiveAnimationBlendMode);
    upper.play();

    // 推到片段中段，两层都在生效
    mixer.setTime(0.5);

    // 腿：应当只被 run 驱动（≈0.6 rad），不因施法 clip 里那条腿轨道多转 ——
    // 叠加层已把腿轨道遮掉
    const legAngle = 2 * Math.acos(Math.min(1, Math.abs(sk.thighL.quaternion.w)));
    expect(legAngle).toBeGreaterThan(0.4);
    expect(legAngle, '腿被施法 clip 的腿轨道污染了（遮罩没挡住）').toBeLessThan(0.75);

    // 手臂：base(run) 完全没动它，叠加层给了 ≈0.5 rad 的施法姿态
    const armAngle = 2 * Math.acos(Math.min(1, Math.abs(sk.armR.quaternion.w)));
    expect(armAngle, '跑动中手臂没有任何施法姿态（分层没生效）').toBeGreaterThan(0.2);
  });

  it('★ 叠加权重 0 时手臂不动（未施法就没有上半身叠加）', () => {
    const sk = makeSkeleton();
    const rig = new THREE.Object3D(); rig.add(sk.hips);
    const additive = buildUpperBodyAdditive(quatClip('cast', 'upperarm.r', 1), sk.bones)!;
    const mixer = new THREE.AnimationMixer(rig);
    const upper = mixer.clipAction(additive, undefined, THREE.AdditiveAnimationBlendMode);
    upper.setEffectiveWeight(0);
    upper.play();
    mixer.setTime(0.5);
    const armAngle = 2 * Math.acos(Math.min(1, Math.abs(sk.armR.quaternion.w)));
    expect(armAngle).toBeLessThan(0.02);
  });
});
