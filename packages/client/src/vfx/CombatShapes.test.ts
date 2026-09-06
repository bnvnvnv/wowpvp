import { describe, expect, it } from 'vitest';
import { CombatShapes, COMBAT_SHAPE_CAPACITY } from './CombatShapes.js';
import { ATTRIBUTE_VISUALS } from './schools.js';

describe('sculpted combat effects', () => {
  it('bounds busy fights and releases every transient effect', () => {
    const effects = new CombatShapes();
    for (let i = 0; i < 80; i++) effects.impact({ x: 0, y: 1, z: 0 }, ATTRIBUTE_VISUALS.fire, 'crit');
    expect(effects.activeCount).toBeLessThanOrEqual(COMBAT_SHAPE_CAPACITY);
    effects.beginFrame(0.016, 'high');
    effects.endFrame();
    expect(effects.renderedCount).toBeGreaterThan(0);
    expect(effects.group.children).toHaveLength(7);
    effects.beginFrame(2, 'high');
    effects.endFrame();
    expect(effects.activeCount).toBe(0);
    expect(effects.renderedCount).toBe(0);
    effects.dispose();
  });

  it('shows a new impact for at least one render, even after a slow frame', () => {
    const effects = new CombatShapes();
    effects.impact({ x: 0, y: 1, z: 0 }, ATTRIBUTE_VISUALS.frost);
    effects.beginFrame(0.7, 'medium');
    effects.endFrame();
    expect(effects.renderedCount).toBeGreaterThan(0);
    effects.dispose();
  });

  it('does not accumulate flight and charge decorations over time', () => {
    const effects = new CombatShapes();
    const point = { x: 0, y: 1, z: 0 };
    for (let i = 0; i < 120; i++) {
      effects.beginFrame(1 / 60, 'medium');
      effects.flight(point, ATTRIBUTE_VISUALS.frost, { x: 0, y: 0, z: 0 });
      effects.charge(point, ATTRIBUTE_VISUALS.frost, 0.5, 0);
      effects.endFrame();
      expect(effects.renderedCount).toBeLessThanOrEqual(8);
    }
    expect(effects.activeCount).toBe(0);
    effects.beginFrame(1 / 60, 'low');
    effects.flight(point, ATTRIBUTE_VISUALS.frost, { x: 0, y: 0, z: 0 });
    effects.charge(point, ATTRIBUTE_VISUALS.frost, 0.5, 0);
    effects.endFrame();
    expect(effects.renderedCount).toBe(0);
    effects.dispose();
  });
});
