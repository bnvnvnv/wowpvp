/**
 * X30 后半：被击晕的**摇头晃脑**（用户 2026-08-11 拍板
 * 「被击晕应该有摇头晃脑的动作而不是简单停在那里」）。
 *
 * ★★ 前提是核对过的：八个玩家 GLB 的 22 个片段里**没有 Dizzy/Stunned 类片段**
 *   （`weaponAnim.test.ts` 的 `REAL_CLIPS` 是同一份清单），而每个骨架都**有**
 *   一根叫 `head` 的骨骼、**没有** neck。所以这一批断言分两层：
 *     · 纯算术（相位/幅度/权重）—— 晃得对不对
 *     · 真骨架 + 真 mixer —— 拧的是不是那根骨，以及**不许累积**
 *
 * ★ 观感（像不像在晕）仍然是截图的事。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnimState } from './AnimationController.js';
import { CharacterView } from './CharacterView.js';
import { ModelLibrary, type CharacterModel } from './ModelLibrary.js';
import { findHeadBone } from './animLayer.js';
import {
  STUN_WOBBLE,
  stunWobbleActive,
  stunWobbleAt,
  wobbleWeightStep,
} from './stunWobble.js';

describe('X30 · 晃动曲线：头在**画圈**，不是左右摇', () => {
  it('★★ yaw 与 roll 差 90°（两个正交轴上的同频简谐 = 一个圆）', () => {
    const period = (Math.PI * 2) / STUN_WOBBLE.RATE;
    const t0 = stunWobbleAt(0);
    const quarter = stunWobbleAt(period / 4);
    // t=0：yaw 在零点、roll 在峰值；转四分之一圈之后两者互换
    expect(t0.yaw).toBeCloseTo(0, 6);
    expect(t0.roll).toBeCloseTo(STUN_WOBBLE.ROLL, 6);
    expect(quarter.yaw).toBeCloseTo(STUN_WOBBLE.YAW, 6);
    expect(quarter.roll).toBeCloseTo(0, 6);
  });

  it('★★ pitch 恒 ≥ 0 —— 晕的人是低着头的，不会仰头', () => {
    for (let t = 0; t < 20; t += 0.017) {
      expect(stunWobbleAt(t).pitch, `t=${t.toFixed(2)} 时头仰起来了`).toBeGreaterThanOrEqual(0);
    }
  });

  it('★ 三轴幅度都不超过档案里写的上限（不许把脖子拧断）', () => {
    for (let t = 0; t < 20; t += 0.013) {
      const s = stunWobbleAt(t);
      expect(Math.abs(s.yaw)).toBeLessThanOrEqual(STUN_WOBBLE.YAW + 1e-9);
      expect(Math.abs(s.roll)).toBeLessThanOrEqual(STUN_WOBBLE.ROLL + 1e-9);
      expect(Math.abs(s.pitch)).toBeLessThanOrEqual(STUN_WOBBLE.PITCH + 1e-9);
    }
  });

  it('★★ 权重 0 → 三轴全零（解除即停 / 死亡不晃靠的就是这条）', () => {
    const s = stunWobbleAt(1.234, 0);
    // ★ 逐轴 toBeCloseTo 而不是整对象 toEqual：`sin(t)*0*w` 会产出 `-0`，
    //   而 `-0` 与 `0` 在 toEqual 眼里不相等 —— 那是浮点的事，不是缺陷
    expect(s.yaw).toBeCloseTo(0, 12);
    expect(s.roll).toBeCloseTo(0, 12);
    expect(s.pitch).toBeCloseTo(0, 12);
  });

  it('★ 权重钳在 0..1（越界的输入不会放大幅度）', () => {
    expect(stunWobbleAt(0, 5).roll).toBeCloseTo(STUN_WOBBLE.ROLL, 6);
    const under = stunWobbleAt(0, -3);
    expect(under.yaw).toBeCloseTo(0, 12);
    expect(under.roll).toBeCloseTo(0, 12);
    expect(under.pitch).toBeCloseTo(0, 12);
  });

  it('★ 淡入比淡出快 —— 中控那一下要即时，收势可以缓一帧', () => {
    expect(STUN_WOBBLE.FADE_IN).toBeLessThan(STUN_WOBBLE.FADE_OUT);
    expect(wobbleWeightStep(0, 1, STUN_WOBBLE.FADE_IN)).toBe(1);
    expect(wobbleWeightStep(1, 0, STUN_WOBBLE.FADE_OUT)).toBe(0);
    // 半程仍在半路，不会越过目标
    expect(wobbleWeightStep(0, 1, STUN_WOBBLE.FADE_IN / 2)).toBeCloseTo(0.5, 6);
    expect(wobbleWeightStep(1, 0, STUN_WOBBLE.FADE_OUT / 2)).toBeCloseTo(0.5, 6);
  });
});

describe('★★ X30 · 谁该晃：昏迷晃，恐惧不晃（14.3 两者视觉不能混）', () => {
  it('★★ 恐惧的人在**乱跑**，站着晃头是错的表达', () => {
    // 7.3：昏迷/恐惧/变形都置 stunned —— 判据必须把恐惧显式排掉
    expect(stunWobbleActive({ stunned: true, feared: false })).toBe(true);
    expect(stunWobbleActive({ stunned: true, feared: true })).toBe(false);
    expect(stunWobbleActive({ stunned: false, feared: true })).toBe(false);
    expect(stunWobbleActive({ stunned: false, feared: false })).toBe(false);
  });
});

describe('X30 · 找头骨：名字是从八个 GLB 里核对过的', () => {
  const bone = (name: string): THREE.Bone => {
    const b = new THREE.Bone();
    b.name = name;
    return b;
  };

  it('★★ 真骨架名 `head` 精确命中，不会被网格名 `Mage_Head` 抢走', () => {
    const mesh = new THREE.Object3D();
    mesh.name = 'Mage_Head';
    const head = bone('head');
    // 顺序刻意把网格放前面 —— 「找到第一个匹配的就用」会在这里翻车
    expect(findHeadBone([mesh, bone('spine'), head])).toBe(head);
  });

  it('★ 没有 head 时回落 neck（本项目八个模型都没有，留给别的骨架）', () => {
    const neck = bone('Neck_01');
    expect(findHeadBone([bone('spine'), neck])).toBe(neck);
  });

  it('★★ 一根都没有 → undefined（调用方回落整模摇摆，绝不 T-pose）', () => {
    expect(findHeadBone([bone('hips'), bone('spine')])).toBeUndefined();
    expect(findHeadBone([])).toBeUndefined();
  });
});

// ── 真骨架 + 真 mixer ────────────────────────────────────────────

/**
 * 与真骨架同名的合成骨架。★ `head` 是从 GLB 的 JSON 块 dump 出来核对的，
 * 八个玩家模型逐个看过（A14 之鉴：不许写不存在的名字）。
 */
const makeRig = (): { root: THREE.Group; head: THREE.Bone } => {
  const root = new THREE.Group();
  const hips = new THREE.Bone(); hips.name = 'hips';
  const spine = new THREE.Bone(); spine.name = 'spine';
  const chest = new THREE.Bone(); chest.name = 'chest';
  const head = new THREE.Bone(); head.name = 'head';
  const armR = new THREE.Bone(); armR.name = 'upperarm.r';
  const legL = new THREE.Bone(); legL.name = 'upperleg.l';
  hips.add(spine); spine.add(chest); chest.add(head); chest.add(armR); hips.add(legL);
  root.add(hips);
  root.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 2, 0.5), new THREE.MeshStandardMaterial()));
  return { root, head };
};

/**
 * ★★ 这些片段**一条 head 轨道都没有** —— 与真素材同构（`Hit_A` 动的是手臂），
 *   也正是「不许累积」那条断言要的环境：mixer 不写 head，
 *   如果 `CharacterView` 不逐帧还原，每帧再乘一次偏移就是指数级累积。
 */
const CLIPS = (): THREE.AnimationClip[] => {
  const q1 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.4);
  const track = (bone: string): THREE.QuaternionKeyframeTrack =>
    new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, [0, 1], [0, 0, 0, 1, q1.x, q1.y, q1.z, q1.w]);
  return [
    new THREE.AnimationClip('Idle', 1, [track('upperarm.r')]),
    new THREE.AnimationClip('Hit_A', 0.667, [track('upperarm.r')]),
    new THREE.AnimationClip('Death_A', 0.8, [track('upperarm.r')]),
  ];
};

const mountView = async (): Promise<{ view: CharacterView; head: THREE.Bone }> => {
  const rig = makeRig();
  const model: CharacterModel = {
    root: rig.root, clips: CLIPS(), handR: undefined, handL: undefined,
  };
  vi.spyOn(ModelLibrary, 'instance', 'get').mockReturnValue({
    characterFor: () => Promise.resolve(model),
    weaponFor: () => Promise.resolve({}),
    creatureFor: () => Promise.resolve(null),
  } as unknown as ModelLibrary);
  const view = new CharacterView('mage');
  await vi.waitFor(() => expect(view.hasModel).toBe(true));
  return { view, head: rig.head };
};

/** 四元数相对单位四元数转了多少弧度 */
const angleOf = (q: THREE.Quaternion): number =>
  q.angleTo(new THREE.Quaternion());

afterEach(() => {
  vi.restoreAllMocks();
});

describe('X30 · 接线：CharacterView 的程序化摇头', () => {
  it('★★ 被击晕 → 头骨真的被拧了（骨骼级，腿和身体照常播动画）', async () => {
    const { view, head } = await mountView();
    view.update(0.016);
    expect(angleOf(head.quaternion), '还没中控头就歪了').toBeCloseTo(0, 6);

    view.setStunned(true);
    for (let i = 0; i < 12; i += 1) view.update(0.016);
    expect(view.stunWobbleWeight).toBeGreaterThan(0);
    expect(angleOf(head.quaternion), '中了昏迷但头一动不动').toBeGreaterThan(0.02);
  });

  it('★★ **不许累积**：片段没有 head 轨道时也不会越拧越歪', async () => {
    const { view, head } = await mountView();
    view.setStunned(true);
    let maxAngle = 0;
    for (let i = 0; i < 400; i += 1) {
      view.update(0.016);
      maxAngle = Math.max(maxAngle, angleOf(head.quaternion));
    }
    // 三轴合成的上限（yaw+roll+pitch 各自的幅度和）——
    // 不还原干净姿势的话 6.4 秒会累积到几十弧度
    const bound = STUN_WOBBLE.YAW + STUN_WOBBLE.ROLL + STUN_WOBBLE.PITCH;
    expect(maxAngle, `头越拧越歪（${maxAngle.toFixed(2)} rad）—— 干净姿势没有被还原`)
      .toBeLessThanOrEqual(bound);
  });

  it('★★ 解除即停：权重归零且头**回到**动画姿势', async () => {
    const { view, head } = await mountView();
    view.setStunned(true);
    for (let i = 0; i < 20; i += 1) view.update(0.016);
    expect(angleOf(head.quaternion)).toBeGreaterThan(0.02);

    view.setStunned(false);
    for (let i = 0; i < 20; i += 1) view.update(0.016);
    expect(view.stunWobbleWeight).toBe(0);
    expect(angleOf(head.quaternion), '解除之后头还歪着').toBeCloseTo(0, 6);
  });

  it('★★ 死亡不晃（尸体不该摇头）', async () => {
    const { view, head } = await mountView();
    view.setStunned(true);
    for (let i = 0; i < 20; i += 1) view.update(0.016);
    expect(view.stunWobbleWeight).toBeGreaterThan(0);

    view.setAnimState(AnimState.Death);
    for (let i = 0; i < 20; i += 1) view.update(0.016);
    expect(view.stunWobbleWeight, '尸体还在晃头').toBe(0);
    expect(angleOf(head.quaternion)).toBeCloseTo(0, 6);
  });

  it('★ 变形中不晃（小鸡没有人形骨架，人形本来就是隐藏的）', async () => {
    const { view } = await mountView();
    view.setMorphed(true);
    view.setStunned(true); // 变形在 sim 里本来就会置 stunned
    for (let i = 0; i < 20; i += 1) view.update(0.016);
    expect(view.stunWobbleWeight).toBe(0);
  });

  it('★ 胶囊兜底（模型没挂上 / `?art=off`）不抛错 —— 头顶星星那条通道仍在', () => {
    const view = new CharacterView();
    view.setStunned(true);
    expect(() => { for (let i = 0; i < 10; i += 1) view.update(0.016); }).not.toThrow();
  });
});

describe('★★ X30 · 接线锁：两个场景都真的调了 setStunned', () => {
  /**
   * ★★ 场景类要 WebGL 才构造得出来 —— 「忘了接线」在这里既不是类型错误
   *   也不是运行时错误，只会表现为「击晕时人还是站着不动」，
   *   而那正是用户这次点名的现象。只能锁源码
   *   （与 `av/signatures/integrity.test.ts` 同一手法）。
   */
  const sceneSrc = (file: string): string =>
    readFileSync(`${fileURLToPath(new URL('.', import.meta.url))}../scenes/${file}`, 'utf8');

  it('★★ 联网场景：远端与自己都接（判据统一走 stunWobbleActive）', () => {
    const src = sceneSrc('NetworkScene.ts');
    const hits = src.match(/setStunned\(stunWobbleActive\(/g) ?? [];
    expect(hits.length, '联网侧只接了一半（自己或远端漏了）').toBeGreaterThanOrEqual(2);
  });

  it('★★ 试验场：玩家与假人都接', () => {
    const src = sceneSrc('TestbedScene.ts');
    const hits = src.match(/setStunned\(stunWobbleActive\(/g) ?? [];
    expect(hits.length, '试验场只接了一半').toBeGreaterThanOrEqual(2);
  });

  it('★★ X29：联网场景把 `dead`/`stunned` 喂给动作状态机', () => {
    /**
     * ★★ 上面那条「死亡不晃」之所以能绿，是因为它**直接** `setAnimState(Death)`
     *   —— 绕过了真实场景里唯一的赋值路径（`AnimationController.update`）。
     *   而联网侧此前那两处 `anim.update({...})` 里既没有 `dead` 也没有
     *   `stunned`：远端角色永远进不了 `AnimState.Death`，于是那条死亡否决
     *   在联网局是**死代码**，被控期间死掉的人尸体一直摇头
     *   （`flags` 不随死亡清空 —— `deriveStatusFlags` 对死人照跑）。
     *   这条锁的就是那一跳。
     */
    const src = sceneSrc('NetworkScene.ts');
    const dead = src.match(/^\s*dead:/gm) ?? [];
    const stunned = src.match(/^\s*stunned:/gm) ?? [];
    expect(dead.length, '联网侧漏了 dead —— 尸体不倒地，摇头的死亡否决形同虚设')
      .toBeGreaterThanOrEqual(2);
    expect(stunned.length, '联网侧漏了 stunned —— 远端被控不播踉跄')
      .toBeGreaterThanOrEqual(2);
  });
});
