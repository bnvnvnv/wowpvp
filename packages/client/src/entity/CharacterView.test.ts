/**
 * 实体动作的接线（用户 2026-08-10 实测点名的两件）：
 *   ① 近战/远程按**武器类型**选挥砍片段 —— 「没有看到有拿武器攻击」
 *   ② 施法的起手（`Spellcast_Raise`）与释放（`Spellcast_Shoot`）—— 「法系职业施法也是没有任何动作」
 *
 * ★ three.js 的 mixer/action 是纯数学，用**合成骨架 + 合成片段**在 Node 里
 *   就能验「哪个片段真的被送进了 mixer」。观感（劈得像不像）仍是截图的事。
 * ★ 观测点选 `AnimationMixer.prototype.clipAction`：它是「这一拍要播哪个片段」
 *   的唯一出口，不需要为测试在生产代码上开任何口子。
 */

import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnimState } from './AnimationController.js';
import { CharacterView } from './CharacterView.js';
import { ModelLibrary, type CharacterModel } from './ModelLibrary.js';

/** 与真骨架同名（hips/spine/chest/upperarm.r/upperleg.l，见 animLayer.test.ts）*/
const makeRig = (): THREE.Group => {
  const root = new THREE.Group();
  const hips = new THREE.Bone(); hips.name = 'hips';
  const spine = new THREE.Bone(); spine.name = 'spine';
  const chest = new THREE.Bone(); chest.name = 'chest';
  const armR = new THREE.Bone(); armR.name = 'upperarm.r';
  const legL = new THREE.Bone(); legL.name = 'upperleg.l';
  hips.add(spine); spine.add(chest); chest.add(armR); hips.add(legL);
  root.add(hips);
  // 受击闪白要找 MeshStandardMaterial；Box3 量身高也需要有几何体
  root.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 2, 0.5), new THREE.MeshStandardMaterial()));
  return root;
};

/** 一条动某骨骼 quaternion 的片段。`hold` = 全程保持姿态（Spellcasting 的真实形态）*/
const clipOf = (name: string, duration: number, bone: string, angle: number, hold = false): THREE.AnimationClip => {
  const q0 = hold
    ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle)
    : new THREE.Quaternion();
  const q1 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle);
  return new THREE.AnimationClip(name, duration, [
    new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, [0, duration], [
      q0.x, q0.y, q0.z, q0.w, q1.x, q1.y, q1.z, q1.w,
    ]),
  ]);
};

/** 真素材的片段名与时长（从八个 GLB dump 出来的那 22 个里取本测用得到的）*/
const FULL_CLIPS = (): THREE.AnimationClip[] => [
  clipOf('Idle', 1.067, 'upperarm.r', 0),
  clipOf('Running_A', 0.8, 'upperleg.l', 1.2),
  clipOf('Hit_A', 0.667, 'upperarm.r', 0.4),
  clipOf('Death_A', 0.8, 'upperarm.r', 0.9),
  clipOf('Block', 1.067, 'upperarm.r', 0.5),
  clipOf('Cheer', 1.667, 'upperarm.r', 0.7),
  clipOf('1H_Melee_Attack_Slice_Diagonal', 1.0, 'upperarm.r', 1.1),
  clipOf('1H_Melee_Attack_Chop', 1.067, 'upperarm.r', 1.2),
  clipOf('2H_Melee_Attack_Chop', 1.633, 'upperarm.r', 1.3),
  clipOf('Dualwield_Melee_Attack_Chop', 1.267, 'upperarm.r', 1.4),
  clipOf('2H_Ranged_Shoot', 1.067, 'upperarm.r', 1.5),
  clipOf('Spellcast_Raise', 2.1, 'upperarm.r', 1.6),
  clipOf('Spellcast_Shoot', 0.933, 'upperarm.r', 1.7),
  clipOf('Spellcasting', 0.667, 'upperarm.r', 1.0, true),
];

let clipSpy: ReturnType<typeof vi.spyOn>;

/** 挂一个假模型库，返回一个已经挂好模型的视图 */
const mountView = async (clips: THREE.AnimationClip[], classId = 'mage'): Promise<CharacterView> => {
  const model: CharacterModel = {
    root: makeRig(), clips, handR: undefined, handL: undefined,
  };
  vi.spyOn(ModelLibrary, 'instance', 'get').mockReturnValue({
    characterFor: () => Promise.resolve(model),
    weaponFor: () => Promise.resolve({}),
    creatureFor: () => Promise.resolve(null),
  } as unknown as ModelLibrary);
  const view = new CharacterView(classId);
  await vi.waitFor(() => expect(view.hasModel).toBe(true));
  return view;
};

describe('contact feedback', () => {
  it('keeps an attack playing while recoil affects only the visible model', async () => {
    const view = await mountView(FULL_CLIPS(), 'warrior');
    view.setWeapon('warrior.sword_shield');
    view.setTransform({ x: 5, y: 0, z: 8 }, 0);
    view.playMeleeSwing();
    view.playHitReact();
    const internal = view as unknown as { overrideKind: string; impactRig: THREE.Group };
    expect(internal.overrideKind).toBe('swing');
    view.kickImpact({ x: 1, z: 0 }, 0.14);
    view.update(1 / 60);
    expect(view.group.getObjectByProperty('uuid', internal.impactRig.uuid)).toBe(internal.impactRig);
    expect(Math.abs(internal.impactRig.rotation.z)).toBeGreaterThan(0.05);
    expect(view.group.position.toArray()).toEqual([5, 0, 8]);
    view.update(0.4);
    expect(internal.impactRig.rotation.z).toBeCloseTo(0, 10);
  });
});

/** 自上次 `clipSpy.mockClear()` 以来被送进 mixer 的片段名 */
const playedClips = (): string[] =>
  (clipSpy.mock.calls as unknown as THREE.AnimationClip[][]).map((c) => c[0]?.name ?? '');

beforeEach(() => {
  clipSpy = vi.spyOn(THREE.AnimationMixer.prototype, 'clipAction');
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('★★ 近战/远程：按武器类型选挥砍片段', () => {
  const cases: ReadonlyArray<readonly [string, string | undefined, string]> = [
    ['双持匕首 → 双持劈砍', 'rogue.dual_daggers', 'Dualwield_Melee_Attack_Chop'],
    ['大剑 → 双手劈砍', 'warrior.greatsword', '2H_Melee_Attack_Chop'],
    ['长柄 → 双手劈砍', 'druid.polearm', '2H_Melee_Attack_Chop'],
    ['长弓 → 拉弓射击', 'hunter.long_bow', '2H_Ranged_Shoot'],
    ['重弩 → 拉弓射击', 'hunter.heavy_crossbow', '2H_Ranged_Shoot'],
    ['法杖 → 推掌（不是拉弓）', 'mage.staff', 'Spellcast_Shoot'],
    ['魔杖宝珠 → 推掌', 'mage.wand_orb', 'Spellcast_Shoot'],
    ['剑盾 → 单手斜劈', 'warrior.sword_shield', '1H_Melee_Attack_Slice_Diagonal'],
    ['徒手 → 单手斜劈兜底', undefined, '1H_Melee_Attack_Slice_Diagonal'],
  ];

  for (const [label, weaponId, expected] of cases) {
    it(`★ ${label}`, async () => {
      const view = await mountView(FULL_CLIPS());
      view.setWeapon(weaponId);
      clipSpy.mockClear();
      view.playMeleeSwing();
      expect(playedClips()).toContain(expected);
    });
  }

  it('★★ 换武器就换动作（同一个视图先大剑后双持，不是缓存住第一次的）', async () => {
    const view = await mountView(FULL_CLIPS());
    view.setWeapon('warrior.greatsword');
    clipSpy.mockClear();
    view.playMeleeSwing();
    expect(playedClips()).toContain('2H_Melee_Attack_Chop');

    view.setWeapon('warrior.dual_swords');
    clipSpy.mockClear();
    view.playMeleeSwing();
    expect(playedClips()).toContain('Dualwield_Melee_Attack_Chop');
    expect(playedClips()).not.toContain('2H_Melee_Attack_Chop');
  });

  it('★ 单手连挥两刀会换成另一个 1H 片段（同一刀连播读作贴图循环）', async () => {
    const view = await mountView(FULL_CLIPS());
    view.setWeapon('warrior.sword_shield');
    clipSpy.mockClear();
    view.playMeleeSwing();
    view.playMeleeSwing();
    expect(playedClips()).toContain('1H_Melee_Attack_Slice_Diagonal');
    expect(playedClips()).toContain('1H_Melee_Attack_Chop');
  });

  it('★★ 素材里没有攻击片段 → 安静跳过，不抛错也不 T-pose', async () => {
    const view = await mountView([clipOf('Idle', 1, 'upperarm.r', 0)]);
    view.setWeapon('rogue.dual_daggers');
    clipSpy.mockClear();
    expect(() => view.playMeleeSwing()).not.toThrow();
    expect(playedClips()).toEqual([]);
  });

  it('★ 死亡/变形中不挥砍（尸体不该抡刀，小鸡没有人形骨架）', async () => {
    const view = await mountView(FULL_CLIPS());
    view.setWeapon('warrior.greatsword');
    view.setAnimState(AnimState.Death);
    clipSpy.mockClear();
    view.playMeleeSwing();
    expect(playedClips()).not.toContain('2H_Melee_Attack_Chop');
  });

  it('★ 覆盖动作播完会自己收尾（监听器摘干净，不每挥一刀泄漏一个）', async () => {
    const view = await mountView(FULL_CLIPS());
    view.setWeapon('rogue.dual_daggers');
    view.playMeleeSwing();
    const priv = view as unknown as { overrideAction: THREE.AnimationAction | undefined };
    expect(priv.overrideAction, '覆盖动作没挂上').toBeDefined();
    for (let i = 0; i < 40; i++) view.update(0.05); // 2 秒，足够任何挥砍播完
    expect(priv.overrideAction, 'finished 之后没有收尾').toBeUndefined();
  });
});

describe('★★ 施法：起手与释放接活', () => {
  it('★★ 站立读条 → 全身 Spellcasting + 一记 Spellcast_Raise 起手', async () => {
    const view = await mountView(FULL_CLIPS());
    clipSpy.mockClear();
    view.setCasting(true);
    expect(playedClips(), '站立读条没换成全身施法姿态').toContain('Spellcasting');
    expect(playedClips(), '起手片段仍然零调用').toContain('Spellcast_Raise');
  });

  it('★★ 站立读条时上半身叠加层收着 —— 同一段姿态不叠两遍', async () => {
    const view = await mountView(FULL_CLIPS());
    const priv = view as unknown as { castLayerOn: boolean; castUpper: unknown };
    expect(priv.castUpper, '叠加层没造出来，这条测不到点子上').toBeDefined();
    view.setCasting(true);
    expect(priv.castLayerOn, '基础层已经是 Spellcasting 了还叠一层').toBe(false);
  });

  it('★★ 跑动读条 → 腿照跑（基础层不动），施法姿态走上半身叠加层', async () => {
    const view = await mountView(FULL_CLIPS());
    view.setAnimState(AnimState.Run);
    clipSpy.mockClear();
    view.setCasting(true);
    const priv = view as unknown as { castLayerOn: boolean };
    expect(priv.castLayerOn, '跑动读条上半身没有任何表现（W14 的核心）').toBe(true);
    expect(playedClips(), '跑动中不该用全身片段顶掉腿').not.toContain('Spellcasting');
    expect(playedClips(), '跑动中起手会把腿钉住，应当交给叠加层').not.toContain('Spellcast_Raise');
  });

  it('★★ 施法结算 → Spellcast_Shoot 推掌（瞬发技能唯一的施法表现）', async () => {
    const view = await mountView(FULL_CLIPS());
    clipSpy.mockClear();
    view.playCastRelease();
    expect(playedClips()).toContain('Spellcast_Shoot');
  });

  it('★ 读条结束会把没播完的起手收掉（手臂不该在读条条消失后继续举）', async () => {
    const view = await mountView(FULL_CLIPS());
    const priv = view as unknown as { overrideAction: THREE.AnimationAction | undefined };
    view.setCasting(true);
    expect(priv.overrideAction).toBeDefined();
    view.setCasting(false);
    expect(priv.overrideAction, '起手动作在读条结束后还挂着').toBeUndefined();
  });

  it('★★ 同一帧「先释放、再收读条」不会把推掌掐掉（场景的真实调用顺序）', async () => {
    const view = await mountView(FULL_CLIPS());
    const priv = view as unknown as {
      overrideAction: THREE.AnimationAction | undefined;
      overrideKind: string | undefined;
    };
    view.setCasting(true);
    // 场景在结算那一帧先播释放，随后每帧无条件跑的 setCasting 才把读条收掉
    view.playCastRelease();
    view.setCasting(false);
    expect(priv.overrideKind, '释放动作被读条归位那一步掐掉了').toBe('castRelease');
    expect(priv.overrideAction).toBeDefined();
  });

  it('★ 读条结束叠加层淡出（跑动读条那条路径）', async () => {
    const view = await mountView(FULL_CLIPS());
    const priv = view as unknown as { castLayerOn: boolean };
    view.setAnimState(AnimState.Run);
    view.setCasting(true);
    expect(priv.castLayerOn).toBe(true);
    view.setCasting(false);
    expect(priv.castLayerOn).toBe(false);
  });

  it('★★ 素材里没有起手/释放片段 → 安静跳过（只剩持续姿态，不抛错）', async () => {
    const view = await mountView([
      clipOf('Idle', 1, 'upperarm.r', 0),
      clipOf('Spellcasting', 0.667, 'upperarm.r', 1, true),
    ]);
    clipSpy.mockClear();
    expect(() => { view.setCasting(true); view.playCastRelease(); }).not.toThrow();
    expect(playedClips()).not.toContain('Spellcast_Raise');
    expect(playedClips()).not.toContain('Spellcast_Shoot');
    expect(playedClips(), '持续姿态这条路仍要走通').toContain('Spellcasting');
  });

  it('★ 死了不施法（叠加层与起手都不来）', async () => {
    const view = await mountView(FULL_CLIPS());
    view.setAnimState(AnimState.Run);
    view.setCasting(true);
    const priv = view as unknown as { castLayerOn: boolean };
    expect(priv.castLayerOn).toBe(true);
    view.setAnimState(AnimState.Death);
    expect(priv.castLayerOn, '尸体保持着施法姿势').toBe(false);
  });
});

/**
 * W24 收口：**换职业要换模型**。
 *
 * ★★ `setClass` 此前是「幂等首调生效」（`if (this.modelRequested) return`），
 *   而 W24 引入了一次**局内**的职业变化：中途加入顶替人机的人在下一次
 *   复活换成他选的职业。服务器把 statics 整块补发了，画面上却还是被顶替者
 *   那个职业的模型 —— 自己和全场都是。判据因此改成「职业没变才不做」。
 */
describe('★★ 局内换职业：模型跟着换', () => {
  /** 每个职业一份**不同的** root，好断言「换的是哪一具身体」 */
  const mountSwitchable = async (): Promise<{
    view: CharacterView;
    rootOf: Map<string, THREE.Group>;
    handOf: Map<string, THREE.Object3D>;
    asked: string[];
  }> => {
    const rootOf = new Map<string, THREE.Group>();
    const handOf = new Map<string, THREE.Object3D>();
    const asked: string[] = [];
    vi.spyOn(ModelLibrary, 'instance', 'get').mockReturnValue({
      characterFor: (classId: string) => {
        asked.push(classId);
        const root = makeRig();
        const hand = new THREE.Object3D();
        root.add(hand);
        rootOf.set(classId, root);
        handOf.set(classId, hand);
        return Promise.resolve({
          root, clips: FULL_CLIPS(), handR: hand, handL: undefined,
        } as CharacterModel);
      },
      weaponFor: () => Promise.resolve({ right: new THREE.Object3D() }),
      creatureFor: () => Promise.resolve(null),
    } as unknown as ModelLibrary);
    const view = new CharacterView('warrior');
    await vi.waitFor(() => expect(view.hasModel).toBe(true));
    return { view, rootOf, handOf, asked };
  };

  it('★★ setClass 换一个职业 → 旧模型离场、新模型进场（同一个视图）', async () => {
    const { view, rootOf, asked } = await mountSwitchable();
    const oldRoot = rootOf.get('warrior')!;
    expect(view.group.children).toContain(oldRoot);

    view.setClass('priest');
    await vi.waitFor(() => expect(rootOf.has('priest')).toBe(true));
    const newRoot = rootOf.get('priest')!;
    await vi.waitFor(() => expect(view.group.children).toContain(newRoot));

    expect(view.group.children, '旧职业的身体还留在场上（两具叠在一个坐标）')
      .not.toContain(oldRoot);
    expect(asked).toEqual(['warrior', 'priest']);
  });

  it('★ 同一个职业再调一次：一次都不多做（老路径逐字不变）', async () => {
    const { view, asked } = await mountSwitchable();
    view.setClass('warrior');
    view.setClass('warrior');
    expect(asked).toEqual(['warrior']);
  });

  it('★★ 换完职业动画还播得动（新 mixer 造的动作，不是旧表里的死引用）', async () => {
    const { view, rootOf } = await mountSwitchable();
    view.setClass('priest');
    await vi.waitFor(() => expect(rootOf.has('priest')).toBe(true));
    await vi.waitFor(() => expect(view.group.children).toContain(rootOf.get('priest')!));

    clipSpy.mockClear();
    view.setAnimState(AnimState.Run);
    expect(playedClips(), '换完职业之后角色定格在 T-pose').toContain('Running_A');
  });

  it('★★ 手里的武器重新挂到新模型的手骨上（不留在离场的旧手上）', async () => {
    const { view, rootOf, handOf } = await mountSwitchable();
    view.setWeapon('warrior.greatsword');
    await vi.waitFor(() => expect(handOf.get('warrior')!.children.length).toBe(1));

    view.setClass('priest');
    await vi.waitFor(() => expect(rootOf.has('priest')).toBe(true));
    await vi.waitFor(() => expect(handOf.get('priest')!.children.length).toBe(1));
    expect(handOf.get('warrior')!.children, '武器还挂在旧职业那只已经离场的手上')
      .toHaveLength(0);
  });
});
