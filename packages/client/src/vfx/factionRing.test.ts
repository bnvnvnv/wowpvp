/**
 * X14 后半：全体脚下阵营标记 + 便宜路轮廓（`FactionRing.ts`）。
 * 规格 00 §777、14.4、17.2。
 *
 * ★★ 这批断言里最要紧的两条都不是「画对了没有」：
 *   · **共享资源** —— 24 人局逐实体 clone 几何体/材质是 P8 那笔合批账，
 *     而它在肉眼上完全看不出来，只有数一数才发现。
 *   · **双通道** —— 敌我除了颜色还必须有形状差别，否则色盲模式下
 *     `paletteFor()` 换完色相仍然是「两个一样的环」。
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { GEOMETRY } from '@wowpvp/shared';
import { paletteFor, ColorblindMode } from '../settings/accessibility.js';
import { FactionRings, type FactionRingView } from './FactionRing.js';

const at = (x: number, z: number): { x: number; y: number; z: number } => ({ x, y: 0, z });

const views = (): FactionRingView[] => [
  { id: 1, position: at(0, 0), faction: 'friendly' },
  { id: 2, position: at(3, 0), faction: 'hostile' },
  { id: 3, position: at(6, 0), faction: 'hostile' },
];

const palette = (mode: ColorblindMode = ColorblindMode.Off): { friendly: string; hostile: string } => {
  const p = paletteFor(mode);
  return { friendly: p.friendly, hostile: p.hostile };
};

/** 收集组里所有 Mesh（含嵌套）*/
const meshesOf = (o: THREE.Object3D): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  o.traverse((c) => { if (c instanceof THREE.Mesh) out.push(c); });
  return out;
};

describe('FactionRings · 共享资源（P8 合批教训）', () => {
  it('★★ 几何体与材质**按阵营各一份**，逐实体只 new 一个 Mesh', () => {
    const rings = new FactionRings();
    const many: FactionRingView[] = [];
    for (let i = 0; i < 24; i++) {
      many.push({ id: i, position: at(i, 0), faction: i % 2 === 0 ? 'friendly' : 'hostile' });
    }
    rings.update(many, palette());
    expect(rings.count).toBe(24);

    const ms = meshesOf(rings.group);
    expect(ms.length, '每个实体两个 Mesh：脚下环 + rim 壳').toBe(48);
    // 24 人局里几何体最多 3 份（友环 / 敌环 / 共用 rim 壳），材质最多 4 份
    expect(new Set(ms.map((m) => m.geometry)).size).toBeLessThanOrEqual(3);
    expect(new Set(ms.map((m) => m.material as THREE.Material)).size).toBe(4);
    expect(rings.materialCount).toBe(4);
    rings.dispose();
  });

  it('★ 实体离场只摘 Mesh，不 dispose 共享资源（还有别人在用）', () => {
    const rings = new FactionRings();
    rings.update(views(), palette());
    const survivorGeo = meshesOf(rings.group)[0]!.geometry;
    rings.update([views()[0]!], palette());
    expect(rings.count).toBe(1);
    // 还活着的那个仍然拿得到同一份几何体的顶点数据
    expect(survivorGeo.getAttribute('position')).toBeDefined();
    rings.dispose();
  });

  it('★ 换边只换几何体/材质的**引用**，Mesh 对象本身不重建', () => {
    const rings = new FactionRings();
    rings.update([{ id: 1, position: at(0, 0), faction: 'friendly' }], palette());
    const mesh = meshesOf(rings.group).find((m) => m.rotation.x !== 0)!;
    const wasGeo = mesh.geometry;
    const wasMat = mesh.material;

    rings.update([{ id: 1, position: at(0, 0), faction: 'hostile' }], palette());
    const now = meshesOf(rings.group).find((m) => m.rotation.x !== 0)!;
    expect(now, '换边重建了 Mesh').toBe(mesh);
    expect(now.geometry, '换边没换形状 —— 17.2 的形状通道失效').not.toBe(wasGeo);
    expect(now.material, '换边没换材质').not.toBe(wasMat);
    rings.dispose();
  });
});

describe('FactionRings · 17.2 双通道：颜色 + 形状', () => {
  it('★★ 友方实环 / 敌对虚线环 —— 灰度下仍然分得出', () => {
    const rings = new FactionRings();
    rings.update(views(), palette());
    // 脚下环是唯一绕 X 摆平的 Mesh（rim 壳竖着）
    const kinds = new Set(meshesOf(rings.group).filter((m) => m.rotation.x !== 0).map((m) => m.geometry));
    expect(kinds.size, '敌我用了同一个几何体 —— 形状通道没了').toBe(2);
    // 敌对那个是八段弧合并出来的，顶点数明显更多
    const counts = [...kinds].map((g) => g.getAttribute('position').count).sort((a, b) => a - b);
    expect(counts[1]!).toBeGreaterThan(counts[0]!);
    rings.dispose();
  });

  it('★★ 颜色跟随 paletteFor —— 色盲模式自动换色', () => {
    const rings = new FactionRings();
    rings.update(views(), palette());
    const off = meshesOf(rings.group).map((m) => (m.material as THREE.MeshBasicMaterial).color.getHex());
    rings.update(views(), palette(ColorblindMode.Deuteranopia));
    const cb = meshesOf(rings.group).map((m) => (m.material as THREE.MeshBasicMaterial).color.getHex());
    expect(cb).not.toEqual(off);
    rings.dispose();
  });

  it('★ 敌对环外沿更大 —— 尺寸是第三条通道', () => {
    const rings = new FactionRings();
    rings.update(views(), palette());
    const ground = meshesOf(rings.group).filter((m) => m.rotation.x !== 0);
    const radius = (m: THREE.Mesh): number => {
      m.geometry.computeBoundingSphere();
      return m.geometry.boundingSphere!.radius;
    };
    const friendly = ground.find((m) => m.parent!.position.x === 0)!;
    const hostile = ground.find((m) => m.parent!.position.x === 3)!;
    expect(radius(hostile)).toBeGreaterThan(radius(friendly));
    rings.dispose();
  });
});

describe('FactionRings · 可读性通道的口径（14.4 / ?art=off）', () => {
  it('★★ 零贴图 —— `?art=off` 下照常构造（与 StatusMarkers 同一条硬约束）', () => {
    const rings = new FactionRings();
    rings.update(views(), palette());
    for (const m of meshesOf(rings.group)) {
      const mat = m.material as THREE.MeshBasicMaterial;
      expect(mat.map, '阵营标记引了贴图 —— art=off 下会变成白块').toBeNull();
    }
    rings.dispose();
  });

  it('★★ 本文件不接受画质参数 —— 没有人能在这里加 `if (low) return`', () => {
    // 与 TargetRing / StatusMarkers 同一把锁：update 的签名里没有 QualityTier
    expect(FactionRings.prototype.update.length).toBe(2);
    const src = FactionRings.prototype.update.toString();
    expect(src).not.toMatch(/quality|Quality/);
  });

  it('★ 远处**放大**而不是等比缩小（14.3 末条）', () => {
    const rings = new FactionRings();
    rings.cameraDistance = 2;
    rings.update(views(), palette());
    const near = meshesOf(rings.group).find((m) => m.rotation.x !== 0)!.scale.x;
    rings.cameraDistance = 18;
    rings.update(views(), palette());
    const far = meshesOf(rings.group).find((m) => m.rotation.x !== 0)!.scale.x;
    expect(far).toBeGreaterThan(near);
    rings.dispose();
  });

  it('★ hidden 的实体不画，但条目还在（下一帧回来不用重建）', () => {
    const rings = new FactionRings();
    const vs = views();
    vs[0]!.hidden = true;
    rings.update(vs, palette());
    expect(rings.count).toBe(3);
    const groups = rings.group.children;
    expect(groups.filter((g) => g.visible).length).toBe(2);
    rings.dispose();
  });
});

describe('FactionRings · 便宜路轮廓（rim）', () => {
  it('★★ 背面壳 + 加法混合 + 保留深度测试 —— 角色挡掉中间，剩下的就是轮廓', () => {
    const rings = new FactionRings();
    rings.update(views(), palette());
    const rim = meshesOf(rings.group).find((m) => m.rotation.x === 0)!;
    const mat = rim.material as THREE.MeshBasicMaterial;
    expect(mat.side).toBe(THREE.BackSide);
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    expect(mat.depthWrite).toBe(false);
    expect(mat.depthTest, '关了深度测试就不是轮廓，是整个人套一层色').toBe(true);
    expect(mat.opacity).toBeLessThan(0.2); // 「轻微」
    rings.dispose();
  });

  it('★ 按身高**等比**缩放（非等比会把胶囊两头压成椭球，接缝很明显）', () => {
    const rings = new FactionRings();
    rings.update([{ id: 1, position: at(0, 0), faction: 'friendly', height: 3 }], palette());
    const rim = meshesOf(rings.group).find((m) => m.rotation.x === 0)!;
    expect(rim.scale.x).toBeCloseTo(3 / GEOMETRY.HITBOX_HEIGHT, 6);
    expect(rim.scale.y).toBe(rim.scale.x);
    expect(rim.scale.z).toBe(rim.scale.x);
    expect(rim.position.y).toBeCloseTo(1.5, 6);
    rings.dispose();
  });

  it('★ 轮廓可单独关掉，脚下环**不受影响**（两条通道互不牵连）', () => {
    const rings = new FactionRings();
    rings.rim = false;
    rings.update(views(), palette());
    const ms = meshesOf(rings.group);
    expect(ms.filter((m) => m.rotation.x === 0).every((m) => !m.visible)).toBe(true);
    expect(rings.group.children.every((g) => g.visible)).toBe(true);
    rings.dispose();
  });
});
