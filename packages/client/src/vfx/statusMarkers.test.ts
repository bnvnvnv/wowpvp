/**
 * W16：复活保护标记 —— 14.4 essential 八项里**最后一个拿到渲染器**的角色。
 * three 的对象构造在 node 里可跑（不碰 WebGL/DOM），这里钉的是可见性
 * 状态机与「essential 不受画质影响」两条。
 */

import { describe, expect, it } from 'vitest';

import { StatusMarkers } from './StatusMarkers.js';

describe('W16 复活保护标记', () => {
  it('★ 开关状态机：默认隐藏，setSpawnProtected 后可见，关闭即隐藏', () => {
    const m = new StatusMarkers();
    expect(m.spawnProtectionVisible).toBe(false);
    m.setSpawnProtected(true);
    expect(m.spawnProtectionVisible).toBe(true);
    m.setSpawnProtected(false);
    expect(m.spawnProtectionVisible).toBe(false);
  });

  it('★ essential：最低画质下 update 之后仍然可见（14.4 不许被画质隐藏）', () => {
    const m = new StatusMarkers();
    m.setSpawnProtected(true);
    m.update(new Map(), 'low', 18, 0.05, 1);
    expect(m.spawnProtectionVisible).toBe(true);
    // 标记网格本体也真的 visible —— getter 撒谎的话这条会抓到
    const visibleMeshes = m.group.children.filter((c) => c.visible).length;
    expect(visibleMeshes).toBeGreaterThanOrEqual(2); // 地环 + 光柱
  });
});
