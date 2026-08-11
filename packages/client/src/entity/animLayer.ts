/**
 * 上半身动画分层（技术债总账 W14）。规格书 13.x 表现层。
 *
 * ★★ **问题**：`CharacterView.applyClip` 是**单片段全身**模型 —— 一次只播一个
 *   clip。于是「跑动中施法」只能二选一：要么播跑步（腿在动、手不施法），
 *   要么播施法（手在施法、腿定住）。此前的折中是「只在站立时才显示施法姿态」，
 *   跑动施法因此**没有任何上半身表现**（W14 点名的每分钟都在发生的缺失）。
 *
 * ★ **解法**：叠加混合（three.js additive blend）。基础层照播 locomotion
 *   （腿），叠加层把施法姿态**只作用在上半身骨骼**上（`makeClipAdditive` +
 *   骨骼遮罩），按权重叠上去 —— 腿继续跑、手做施法动作。
 *
 * ★ 本文件只放**纯数据**部分（骨骼分类 + clip 遮罩 + 转叠加），不碰 mixer ——
 *   于是它能用合成骨架在**无 GPU** 下单测（three.js 的 AnimationClip/
 *   KeyframeTrack/AnimationUtils 都是纯数学）。真机的观感（Synty 骨架上是否
 *   自然）仍需截图，那是 CharacterView 接线之后的事。
 */

import * as THREE from 'three';

/**
 * KeyframeTrack 名 → 目标骨骼名。
 * ★ 轨道名形如 `<boneName>.<property>`（property ∈ position/quaternion/scale…），
 *   取**最后一个点之前**做骨骼名 —— 骨骼名本身可能带点（本项目的 `handslot.r`
 *   就是），按第一个点切会把它劈成两半。
 */
export const trackBoneName = (trackName: string): string => {
  const i = trackName.lastIndexOf('.');
  return i < 0 ? trackName : trackName.slice(0, i);
};

/**
 * 找「上半身根」骨骼：脊柱最下节（它的子树 = 胸/颈/头/双臂，**不含腿**）。
 *
 * ★★ 关键是选**脊柱**而不是 hips/pelvis：典型人形骨架里脊柱与大腿都是
 *   hips 的**兄弟**分支，取 hips 会把腿也算进上半身，叠加时腿会做两遍动作。
 *   取脊柱最下节，它的子树恰好是上半身。
 * ★ 名字匹配放宽到多种命名习惯；找不到返回 undefined（调用方安全回落到
 *   旧的单片段行为，绝不 T-pose）。
 */
export const findUpperBodyRoot = (bones: readonly THREE.Object3D[]): THREE.Object3D | undefined => {
  const spines = bones.filter((b) => /spine|chest|torso/i.test(b.name));
  if (spines.length === 0) return undefined;
  // 层级最靠上的那个（parent 链最短）—— spine_01 而不是 spine_03
  return spines.reduce((best, b) => (depthOf(b) <= depthOf(best) ? b : best));
};

const depthOf = (o: THREE.Object3D): number => {
  let d = 0;
  for (let p = o.parent; p; p = p.parent) d++;
  return d;
};

/**
 * X30：找**头**骨骼 —— 程序化「摇头晃脑」要拧的那一根。
 *
 * ★★ 名字是**核对过**的，不是猜的（A14 之鉴）：把八个玩家 GLB 的 JSON 块
 *   dump 出来逐个看过，每一个都有且只有一根叫 `head` 的骨骼，**没有 neck**。
 *   `neck` 那条分支留着是给将来别的骨架用的兜底，不是幻想出来的名字。
 * ★ 只在**骨骼**里找（调用方传的就是 `isBone` 过滤过的列表）——
 *   模型里还有叫 `Mage_Head` 的**网格**，按名字模糊匹配会先撞上它，
 *   而拧一个网格既不带动脸也不带动帽子。
 * ★ 优先精确匹配 `head`，其次层级最浅的含 head 名，再次 neck；
 *   都没有返回 undefined —— 调用方回落到「整模小幅摇摆」，绝不 T-pose。
 */
export const findHeadBone = (bones: readonly THREE.Object3D[]): THREE.Object3D | undefined => {
  const exact = bones.find((b) => b.name.toLowerCase() === 'head');
  if (exact) return exact;
  const shallowest = (list: readonly THREE.Object3D[]): THREE.Object3D | undefined =>
    list.length === 0
      ? undefined
      : list.reduce((best, b) => (depthOf(b) <= depthOf(best) ? b : best));
  return (
    shallowest(bones.filter((b) => /head/i.test(b.name))) ??
    shallowest(bones.filter((b) => /neck/i.test(b.name)))
  );
};

/** 一个骨骼子树里的全部骨骼名（含自身）。上半身遮罩集 = 上半身根的子树 */
export const subtreeBoneNames = (root: THREE.Object3D): Set<string> => {
  const names = new Set<string>();
  root.traverse((o) => { if (o.name) names.add(o.name); });
  return names;
};

/**
 * 把 clip 裁到只含 `boneNames` 里骨骼的轨道 —— 上半身遮罩。
 * ★ 返回**新** clip，引用原轨道对象（未克隆）；要 `makeClipAdditive` 的话
 *   调用方先 `.clone()`（那会 mutate 轨道值，不能污染共享模板）。
 */
export const maskClipToBones = (
  clip: THREE.AnimationClip,
  boneNames: ReadonlySet<string>,
): THREE.AnimationClip => {
  const tracks = clip.tracks.filter((t) => boneNames.has(trackBoneName(t.name)));
  return new THREE.AnimationClip(`${clip.name}_upper`, clip.duration, tracks);
};

/**
 * 从一个全身 clip 造「上半身叠加」clip：遮罩到上半身 → 克隆 → 转叠加。
 *
 * @param referenceClip 叠加的**参考姿势**来源（通常是 Idle）。
 *
 *   ★★ 不传的话 `makeClipAdditive` 以 clip **自己的第 0 帧**为参考 ——
 *     对 Spellcasting 这类循环片段，第 0 帧本身就是施法姿态，
 *     减掉自己 ≈ 全程增量为零：叠加层「在播」但**什么都看不见**。
 *     X10 真机轮实测抓出（「近战远程有攻击没动作」的施法侧根因）；
 *     此前单测没抓到是因为合成 clip 恰好第 0 帧是单位四元数。
 *     叠加量应该是「施法姿态相对**站立姿态**的偏移」—— 参考必须是 Idle。
 *
 * @returns 叠加 clip；上半身根找不到、或遮罩后一条轨道都不剩时返回 undefined
 *   （调用方回落旧行为）。
 */
export const buildUpperBodyAdditive = (
  clip: THREE.AnimationClip,
  bones: readonly THREE.Object3D[],
  referenceClip?: THREE.AnimationClip,
): THREE.AnimationClip | undefined => {
  const root = findUpperBodyRoot(bones);
  if (!root) return undefined;
  const names = subtreeBoneNames(root);
  const masked = maskClipToBones(clip, names);
  if (masked.tracks.length === 0) return undefined;
  // ★ 克隆再转叠加：makeClipAdditive 就地改轨道值，共享模板 clip 不能被它污染
  const additive = masked.clone();
  if (referenceClip) {
    // 参考 clip 同样先遮罩（轨道名要对得上）再克隆（不污染共享模板）
    const ref = maskClipToBones(referenceClip, names).clone();
    THREE.AnimationUtils.makeClipAdditive(additive, 0, ref);
  } else {
    THREE.AnimationUtils.makeClipAdditive(additive);
  }
  return additive;
};
