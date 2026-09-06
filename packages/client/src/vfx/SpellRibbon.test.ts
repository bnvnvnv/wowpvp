import { describe, expect, it } from 'vitest';
import { SpellRibbon, RIBBON_LIMIT } from './SpellRibbon.js';
import { ATTRIBUTE_VISUALS } from './schools.js';

describe('projectile flight ribbons', () => {
  it('draws a sampled curve without changing its projectile positions', () => {
    const ribbon = new SpellRibbon();
    const points = [{ x: 0, y: 1, z: 0 }, { x: 1, y: 1.5, z: 0 }, { x: 2, y: 1, z: -1 }];
    const before = structuredClone(points);
    for (const point of points) {
      ribbon.beginFrame(1 / 60, 'medium', { x: 0, y: 4, z: 10 });
      ribbon.follow('frost', point, ATTRIBUTE_VISUALS.frost);
      ribbon.endFrame();
    }
    expect(points).toEqual(before);
    expect(ribbon.activeCount).toBe(1);
    expect(ribbon.mesh.geometry.drawRange.count).toBeGreaterThan(0);
    expect(ribbon.mesh.geometry.getAttribute('position').array.every(Number.isFinite)).toBe(true);
    ribbon.beginFrame(1, 'medium');
    ribbon.endFrame();
    expect(ribbon.activeCount).toBe(0);
    expect(ribbon.mesh.visible).toBe(false);
    ribbon.dispose();
  });

  it('limits a fast projectile trail to its visual length', () => {
    const ribbon = new SpellRibbon();
    ribbon.beginFrame(0, 'medium');
    ribbon.follow('fast', { x: 0, y: 1, z: 0 }, ATTRIBUTE_VISUALS.frost);
    ribbon.follow('fast', { x: 100, y: 1, z: 0 }, ATTRIBUTE_VISUALS.frost);
    ribbon.endFrame();
    const geometry = ribbon.mesh.geometry;
    const points = geometry.getAttribute('position');
    for (let i = 0; i < geometry.drawRange.count; i++) {
      expect(points.getX(geometry.index!.getX(i))).toBeGreaterThanOrEqual(96.5);
    }
    ribbon.dispose();
  });

  it('retains the launch point when the next frame exceeds the tail linger time', () => {
    const ribbon = new SpellRibbon();
    ribbon.follow('frost', { x: 0, y: 1, z: 0 }, ATTRIBUTE_VISUALS.frost);
    ribbon.beginFrame(0.25, 'medium');
    ribbon.follow('frost', { x: 0, y: 1, z: 12 }, ATTRIBUTE_VISUALS.frost);
    ribbon.endFrame();
    expect(ribbon.activeCount).toBe(1);
    expect(ribbon.mesh.geometry.drawRange.count).toBeGreaterThan(0);
    ribbon.beginFrame(0.25, 'medium');
    ribbon.endFrame();
    expect(ribbon.mesh.visible).toBe(false);
    ribbon.dispose();
  });

  it('keeps admission stable when more projectiles exist than the visual budget', () => {
    const ribbon = new SpellRibbon();
    for (let frame = 0; frame < 3; frame++) {
      ribbon.beginFrame(1 / 60, 'medium');
      for (let id = 0; id < 40; id++) ribbon.follow(String(id), { x: frame, y: 1, z: id }, ATTRIBUTE_VISUALS.fire);
      ribbon.endFrame();
    }
    expect(ribbon.activeCount).toBe(RIBBON_LIMIT);
    ribbon.beginFrame(0, 'low');
    ribbon.endFrame();
    expect(ribbon.mesh.visible).toBe(false);
    ribbon.dispose();
  });
});
